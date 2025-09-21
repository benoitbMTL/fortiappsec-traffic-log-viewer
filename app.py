#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
FortiAppSec Traffic Logs Viewer
================================
Backend service that:
- pulls NDJSON lines from Azure Blob Storage
- caches them in memory as a pandas DataFrame
- exposes routes for a web UI and server-side CSV/JSON exports

SECTIONS (Python):
- CONFIG & GLOBALS
- AZURE INGEST (load_logs_from_blob)
- UTIL (ensure_loaded, humanize_utc)
- ROUTES: index (HTML)
- ROUTES: /data (table JSON + debug)
- ROUTES: /data.csv and /data.json (server downloads)
- ROUTES: /reload (refresh cache)

If you ask me later “change X”, just tell me the SECTION name above.
"""

# ===== SECTION: IMPORTS =====
import io
import json
import os
from datetime import datetime, timezone

from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request, Response
import pandas as pd
from azure.storage.blob import BlobServiceClient

# ===== SECTION: CONFIG & GLOBALS =====
load_dotenv()
ACCOUNT   = os.getenv("AZURE_STORAGE_ACCOUNT")
KEY       = os.getenv("AZURE_STORAGE_KEY")
CONTAINER = os.getenv("AZURE_CONTAINER")
PORT      = int(os.getenv("PORT", "8000"))
MAX_BLOBS = int(os.getenv("MAX_BLOBS", "0"))   # 0 = fetch all blobs
OUTPUT_DIR = os.getenv("OUTPUT_DIR", "./out")

if not ACCOUNT or not KEY or not CONTAINER:
    raise SystemExit("Missing AZURE_STORAGE_ACCOUNT / AZURE_STORAGE_KEY / AZURE_CONTAINER in .env")

os.makedirs(OUTPUT_DIR, exist_ok=True)
ACCOUNT_URL = f"https://{ACCOUNT}.blob.core.windows.net"

DF_CACHE = None
LAST_LOAD_UTC = None

app = Flask(__name__)
app.logger.setLevel("DEBUG")


# ===== SECTION: AZURE INGEST =====
def load_logs_from_blob() -> pd.DataFrame:
    """Download all blobs, parse NDJSON (one JSON per line), return merged DataFrame."""
    app.logger.info("Loading blobs: account=%s container=%s", ACCOUNT, CONTAINER)

    bsc = BlobServiceClient(account_url=ACCOUNT_URL, credential=KEY)
    cc  = bsc.get_container_client(CONTAINER)

    rows = []
    blobs = list(cc.list_blobs())
    app.logger.info("Found %d blobs", len(blobs))

    if MAX_BLOBS > 0:
        blobs = blobs[:MAX_BLOBS]
        app.logger.info("Limiting to %d blobs due to MAX_BLOBS", len(blobs))

    for blob in blobs:
        data = cc.download_blob(blob.name).readall()
        with io.StringIO(data.decode("utf-8", errors="ignore")) as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                if line.endswith(","):
                    line = line[:-1]
                try:
                    rec = json.loads(line)
                except Exception:
                    continue
                rec["_blob_name"] = blob.name
                rec["_blob_last_modified"] = (
                    blob.last_modified.astimezone(timezone.utc).isoformat()
                    if getattr(blob, "last_modified", None) else None
                )
                rows.append(rec)

    df = pd.DataFrame(rows)
    app.logger.info("Merged rows: %d", len(df))

    if not df.empty:
        # Best-effort time sort
        for c in ("ts", "timestamp", "@timestamp", "time", "event_time"):
            if c in df.columns:
                try:
                    df["_sort_ts"] = pd.to_datetime(df[c], errors="coerce", utc=True)
                    df = df.sort_values("_sort_ts", na_position="last")
                    break
                except Exception:
                    pass

        # snapshot export (optional)
        tag = datetime.now().strftime("%Y%m%d-%H%M%S")
        df.to_csv(os.path.join(OUTPUT_DIR, f"traffic_logs_{tag}.csv"), index=False)
        try:
            df.to_parquet(os.path.join(OUTPUT_DIR, f"traffic_logs_{tag}.parquet"), index=False)
        except Exception:
            pass

    return df


# ===== SECTION: UTIL =====
def ensure_loaded():
    """Load DF cache and timestamp on first access."""
    global DF_CACHE, LAST_LOAD_UTC
    if DF_CACHE is None:
        DF_CACHE = load_logs_from_blob()
        LAST_LOAD_UTC = datetime.now(timezone.utc)
        app.logger.info("Initial load: rows=%d", 0 if DF_CACHE is None else len(DF_CACHE))

def humanize_utc(dt_utc: datetime) -> str:
    """Return a human-friendly UTC string, e.g., 'Sep 20, 2025 03:35:58 UTC'."""
    if not dt_utc:
        return "-"
    return dt_utc.strftime("%b %d, %Y %H:%M:%S UTC")


# ===== SECTION: ROUTES: index (HTML) =====
@app.route("/")
def index():
    ensure_loaded()
    # We render a template; UI will fetch /data to fill counters and table.
    return render_template("index.html")


# ===== SECTION: ROUTES: /data =====
@app.route("/data")
def data():
    """
    Return JSON payload for the table.
    Includes:
      - columns, records
      - total rows
      - last_load_utc (ISO)
      - last_load_human (friendly format)
      - optional debug block if ?debug=1
    """
    ensure_loaded()

    debug_mode = request.args.get("debug", default="0") == "1"
    total = int(len(DF_CACHE)) if DF_CACHE is not None else 0
    last_iso = LAST_LOAD_UTC.isoformat() if LAST_LOAD_UTC else "n/a"
    last_hmn = humanize_utc(LAST_LOAD_UTC)

    if DF_CACHE is None or DF_CACHE.empty:
        payload = {
            "records": [],
            "columns": [],
            "total": total,
            "last_load_utc": last_iso,
            "last_load_human": last_hmn,
        }
        if debug_mode:
            app.logger.debug("[/data] empty dataframe")
            payload["debug"] = {"df_empty": True}
        return jsonify(payload)

    # column ordering: preferred first, then the rest
    preferred = [
        "http_host", "status", "srccountry", "user_name", "http_agent",
        "_blob_last_modified", "_blob_name"
    ]
    pref_present = [c for c in preferred if c in DF_CACHE.columns]
    cols = pref_present + [c for c in DF_CACHE.columns if c not in pref_present]
    cols = cols[:200]  # cap

    dfj = DF_CACHE[cols].copy()
    dfj = dfj.where(dfj.notnull(), None)

    def _to_jsonable(x):
        if isinstance(x, (pd.Timestamp, datetime)):
            try:
                return x.isoformat()
            except Exception:
                return str(x)
        return x

    # NOTE: applymap is deprecated in pandas 2.2+; map over each col instead:
    for c in dfj.columns:
        dfj[c] = dfj[c].map(_to_jsonable)

    records = json.loads(dfj.to_json(orient="records"))

    payload = {
        "records": records,
        "columns": cols,
        "total": total,
        "last_load_utc": last_iso,
        "last_load_human": last_hmn,
    }

    if debug_mode:
        app.logger.debug("[/data] rows=%d cols=%d", len(dfj), len(cols))
        payload["debug"] = {
            "df_shape": [int(DF_CACHE.shape[0]), int(DF_CACHE.shape[1])],
            "returned_rows": len(dfj),
            "returned_cols": len(cols),
            "preferred_present": pref_present,
            "all_columns_count": len(DF_CACHE.columns),
        }

    return jsonify(payload)


# ===== SECTION: ROUTES: /data.csv and /data.json =====
@app.route("/data.csv")
def data_csv():
    ensure_loaded()
    if DF_CACHE is None or DF_CACHE.empty:
        return Response("", mimetype="text/csv")

    preferred = [
        "http_host", "status", "srccountry", "user_name", "http_agent",
        "_blob_last_modified", "_blob_name"
    ]
    pref_present = [c for c in preferred if c in DF_CACHE.columns]
    cols = pref_present + [c for c in DF_CACHE.columns if c not in pref_present]
    csv = DF_CACHE[cols].to_csv(index=False)
    return Response(
        csv,
        mimetype="text/csv",
        headers={"Content-Disposition": "attachment; filename=traffic_logs_current.csv"}
    )

@app.route("/data.json")
def data_json():
    ensure_loaded()
    if DF_CACHE is None or DF_CACHE.empty:
        return jsonify([])

    preferred = [
        "http_host", "status", "srccountry", "user_name", "http_agent",
        "_blob_last_modified", "_blob_name"
    ]
    pref_present = [c for c in preferred if c in DF_CACHE.columns]
    cols = pref_present + [c for c in DF_CACHE.columns if c not in pref_present]

    dfj = DF_CACHE[cols].copy()
    dfj = dfj.where(dfj.notnull(), None)

    def _to_jsonable(x):
        if isinstance(x, (pd.Timestamp, datetime)):
            try:
                return x.isoformat()
            except Exception:
                return str(x)
        return x

    for c in dfj.columns:
        dfj[c] = dfj[c].map(_to_jsonable)

    payload = json.loads(dfj.to_json(orient="records"))
    return jsonify(payload)


# ===== SECTION: ROUTES: /reload =====
@app.route("/reload", methods=["POST"])
def reload_data():
    """Re-read Azure blobs and refresh the cache."""
    app.logger.info("Reload requested")
    global DF_CACHE, LAST_LOAD_UTC
    DF_CACHE = load_logs_from_blob()
    LAST_LOAD_UTC = datetime.now(timezone.utc)
    app.logger.info("Reload complete: rows=%d", 0 if DF_CACHE is None else len(DF_CACHE))
    return jsonify({"ok": True, "rows": int(len(DF_CACHE)), "last_load_utc": LAST_LOAD_UTC.isoformat()})


if __name__ == "__main__":
    print(f"Starting server on http://0.0.0.0:{PORT}")
    ensure_loaded()
    app.run(host="0.0.0.0", port=PORT, debug=False)
