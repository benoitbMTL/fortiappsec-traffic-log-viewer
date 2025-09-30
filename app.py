#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
FortiAppSec Traffic Logs – Unified Flask backend

This file merges:
1) Legacy features:
   - Pull NDJSON from Azure Blob Storage → pandas DataFrame cache
   - /data (JSON), /data.csv, /data.json, /reload
   - Counters (total, last load)
2) New configuration layer:
   - Active config in config.json (single source of truth)
   - First-run bootstrap from .env → config.default.json + config.json
   - /config/state, /config (GET/POST), /config/default, /config/test
   - Client-side controls: fetch_range = {unlimited,last_hour,last_day,custom}
     + custom [start_utc,end_utc] (UTC, "YYYY-MM-DDTHH:MM")
     + max_blobs (0 = unlimited)

Index route:
- Renders index.html from project root (template_folder=".") — fixes GET / 404.

Python logging:
- Set PY_DEBUG = True for verbose server logs. JS console logs remain always on.
"""

from __future__ import annotations

import os
import io
import json
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, Any, List, Optional

from flask import Flask, jsonify, render_template, request, Response, send_from_directory

# Optional deps are imported lazily inside functions:
#   pandas
#   azure.storage.blob

# ------------------------------
# Flask app + Python debug flag
# ------------------------------
app = Flask(
    __name__,
    template_folder="templates",  
    static_folder="static",
    static_url_path="/static",
)


PY_DEBUG = False  # True = DEBUG logs; False = INFO logs
app.logger.setLevel("DEBUG" if PY_DEBUG else "INFO")

BASE_DIR = Path(__file__).resolve().parent
ENV_PATH   = BASE_DIR / ".env"
CFG_PATH   = BASE_DIR / "config.json"
CFG_DEF    = BASE_DIR / "config.default.json"

# ==============================
# CONFIG LAYER (.env → config.*)
# ==============================
DEFAULT_CONFIG: Dict[str, Any] = {
    "timezone": "UTC",
    "AZURE_STORAGE_ACCOUNT": "",
    "AZURE_STORAGE_KEY": "",
    "AZURE_CONTAINER": "",
    "fetch_range": "last_day",      # unlimited | last_hour | last_day | custom
    "start_utc": "",
    "end_utc": "",
    "max_blobs": 5000,              # 0 = unlimited
    # legacy/optional:
    "OUTPUT_DIR": "./out",
    "PORT": 8000,
}

def load_env_dict(path: Path) -> Dict[str, str]:
    env: Dict[str, str] = {}
    if not path.exists():
        return env
    for line in path.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        k, v = s.split("=", 1)
        env[k.strip()] = v.strip()
    return env

def atomic_write_json(path: Path, data: Dict[str, Any]) -> None:
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".", text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        os.replace(tmp, path)
    finally:
        try:
            os.remove(tmp)
        except FileNotFoundError:
            pass

def read_config() -> Dict[str, Any]:
    if CFG_PATH.exists():
        try:
            cfg = json.loads(CFG_PATH.read_text(encoding="utf-8"))
            # merge defaults to keep backward compatibility
            merged = {**DEFAULT_CONFIG, **cfg}
            return merged
        except Exception:
            app.logger.exception("read_config: invalid config.json; using defaults")
    return DEFAULT_CONFIG.copy()

def write_config(new_cfg: Dict[str, Any]) -> None:
    # backup
    if CFG_PATH.exists():
        ts = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
        bkp = CFG_PATH.with_suffix(f".json.bak-{ts}")
        try:
            bkp.write_text(CFG_PATH.read_text(encoding="utf-8"), encoding="utf-8")
        except Exception:
            app.logger.warning("write_config: could not write backup")
    atomic_write_json(CFG_PATH, new_cfg)

def ensure_default_from_env_once() -> None:
    """If config.json is absent and .env exists, create config.default.json + config.json from it."""
    if not CFG_PATH.exists() and ENV_PATH.exists():
        env = load_env_dict(ENV_PATH)
        cfg_def = {
            "timezone": env.get("TIMEZONE", "UTC"),
            "AZURE_STORAGE_ACCOUNT": env.get("AZURE_STORAGE_ACCOUNT", ""),
            "AZURE_STORAGE_KEY": env.get("AZURE_STORAGE_KEY", ""),
            "AZURE_CONTAINER": env.get("AZURE_CONTAINER", ""),
            # <- read FETCH_RANGE from .env and normalize
            "fetch_range": (env.get("FETCH_RANGE", "unlimited") or "unlimited").strip().lower(),
            "start_utc": env.get("START_UTC", ""),
            "end_utc": env.get("END_UTC", ""),
            "max_blobs": int(env.get("MAX_BLOBS", "0") or "0"),
            "OUTPUT_DIR": env.get("OUTPUT_DIR", "./out"),
            "PORT": int(env.get("PORT", "8000")),
        }
        atomic_write_json(CFG_DEF, cfg_def)
        atomic_write_json(CFG_PATH, cfg_def)
        app.logger.info("Initialized config.json from .env")

ensure_default_from_env_once()

# ======================
# LEGACY INGEST (pandas)
# ======================
DF_CACHE = None          # pandas.DataFrame or None
LAST_LOAD_UTC: Optional[datetime] = None

def _load_pandas():
    try:
        import pandas as pd
        return pd
    except Exception as e:
        app.logger.error("pandas import failed: %s", e)
        raise

def _load_azure_sdk():
    try:
        from azure.storage.blob import BlobServiceClient
        return BlobServiceClient
    except Exception as e:
        app.logger.error("azure-storage-blob import failed: %s", e)
        raise

def _account_url(account: str) -> str:
    return f"https://{account}.blob.core.windows.net"

def load_logs_from_blob(cfg: Dict[str, Any]):
    """Download blobs, parse NDJSON, return merged pandas DataFrame."""
    pd = _load_pandas()
    BlobServiceClient = _load_azure_sdk()

    account   = cfg.get("AZURE_STORAGE_ACCOUNT")
    key       = cfg.get("AZURE_STORAGE_KEY")
    container = cfg.get("AZURE_CONTAINER")
    max_blobs = int(cfg.get("max_blobs") or 0)

    if not account or not key or not container:
        raise RuntimeError("Missing AZURE_STORAGE_ACCOUNT / AZURE_STORAGE_KEY / AZURE_CONTAINER configuration")

    account_url = _account_url(account)
    app.logger.info("Loading blobs: account=%s container=%s", account, container)

    bsc = BlobServiceClient(account_url=account_url, credential=key)
    cc  = bsc.get_container_client(container)

    rows: List[Dict[str, Any]] = []
    blobs = list(cc.list_blobs())
    app.logger.info("Found %d blobs", len(blobs))

    if max_blobs > 0:
        blobs = blobs[:max_blobs]
        app.logger.info("Limiting to %d blobs due to max_blobs", len(blobs))

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

    # Best-effort sort by a common time field if present
    if not df.empty:
        for c in ("ts", "timestamp", "@timestamp", "time", "event_time"):
            if c in df.columns:
                try:
                    df["_sort_ts"] = pd.to_datetime(df[c], errors="coerce", utc=True)
                    df = df.sort_values("_sort_ts", na_position="last")
                    break
                except Exception:
                    pass

        # Optional snapshot export to ./out
        out_dir = Path(cfg.get("OUTPUT_DIR") or "./out")
        out_dir.mkdir(parents=True, exist_ok=True)
        tag = datetime.now().strftime("%Y%m%d-%H%M%S")
        df.to_csv(out_dir / f"traffic_logs_{tag}.csv", index=False)
        try:
            df.to_parquet(out_dir / f"traffic_logs_{tag}.parquet", index=False)
        except Exception:
            pass

    return df

def ensure_loaded():
    global DF_CACHE, LAST_LOAD_UTC
    if DF_CACHE is None:
        cfg = read_config()
        if not (cfg.get("AZURE_STORAGE_ACCOUNT") and cfg.get("AZURE_STORAGE_KEY") and cfg.get("AZURE_CONTAINER")):
            app.logger.warning("Config incomplete; skipping initial load")
            return
        DF_CACHE = load_logs_from_blob(cfg)
        LAST_LOAD_UTC = datetime.now(timezone.utc)
        app.logger.info("Initial load complete: rows=%d", 0 if DF_CACHE is None else len(DF_CACHE))

# ==================
# Time/range helpers
# ==================
def parse_custom_utc(ts: str | None) -> Optional[datetime]:
    if not ts:
        return None
    try:
        if len(ts) == 16:
            return datetime.strptime(ts, "%Y-%m-%dT%H:%M").replace(tzinfo=timezone.utc)
        return datetime.fromisoformat(ts).replace(tzinfo=timezone.utc)
    except Exception:
        app.logger.warning("parse_custom_utc: invalid %r", ts)
        return None

def record_in_window(rec: Dict[str, Any], start: Optional[datetime], end: Optional[datetime]) -> bool:
    if not (start or end):
        return True
    ts = rec.get("log_timestamp") or rec.get("_blob_last_modified")
    if ts is None:
        return True
    try:
        num = float(ts)
        ms  = num if num > 1e12 else num * 1000.0
        t   = datetime.fromtimestamp(ms/1000.0, tz=timezone.utc)
    except Exception:
        # try ISO
        try:
            t = datetime.fromisoformat(str(ts)).astimezone(timezone.utc)
        except Exception:
            return True
    if start and t < start:
        return False
    if end and t > end:
        return False
    return True

def apply_window_and_limit_records(records: List[Dict[str, Any]], cfg: Dict[str, Any]) -> List[Dict[str, Any]]:
    rng = (cfg.get("fetch_range") or "unlimited").lower()
    now = datetime.now(timezone.utc)
    start = end = None
    if rng == "last_hour":
        start, end = now - timedelta(hours=1), now
    elif rng == "last_day":
        start, end = now - timedelta(days=1), now
    elif rng == "last_week":
        start, end = now - timedelta(days=7), now
    elif rng == "last_month":
        start, end = now - timedelta(days=30), now
    elif rng == "custom":
        start = parse_custom_utc(cfg.get("start_utc"))
        end   = parse_custom_utc(cfg.get("end_utc"))

    if start or end:
        records = [r for r in records if record_in_window(r, start, end)]

    max_blobs = 0
    try:
        max_blobs = int(cfg.get("max_blobs") or 0)
    except Exception:
        pass
    if max_blobs > 0 and len(records) > max_blobs:
        records = records[:max_blobs]

    return records

def humanize_utc(dt_utc: Optional[datetime]) -> str:
    if not dt_utc:
        return "-"
    return dt_utc.strftime("%b %d, %Y %H:%M:%S UTC")

# =========
# ROUTES
# =========

# --- Index (HTML) ---
@app.route("/")
def index():
    """
    Render index.html from the project root (template_folder=".").
    """
    return render_template("index.html")

# --- Config state (auto-open modal on first run) ---
@app.get("/config/state")
def config_state():
    exists = CFG_PATH.exists()
    cfg = read_config() if exists else DEFAULT_CONFIG.copy()
    return jsonify({"needs_config": not exists, "config": cfg})

# --- Get active config ---
@app.get("/config")
def get_config():
    return jsonify(read_config())

# --- Save active config ---
@app.post("/config")
def post_config():
    current = read_config()
    payload = request.get_json(force=True) or {}

    # merge non-secret fields
    for k in ["timezone","AZURE_STORAGE_ACCOUNT","AZURE_CONTAINER","fetch_range","start_utc","end_utc","OUTPUT_DIR","PORT"]:
        if k in payload and payload[k] is not None:
            current[k] = payload[k]

    # max_blobs numeric
    if "max_blobs" in payload:
        try:
            current["max_blobs"] = max(0, int(payload["max_blobs"]))
        except Exception:
            app.logger.warning("config POST: invalid max_blobs %r", payload.get("max_blobs"))

    # key: only overwrite if non-empty
    if payload.get("AZURE_STORAGE_KEY"):
        current["AZURE_STORAGE_KEY"] = payload["AZURE_STORAGE_KEY"]

    write_config(current)

    # If credentials or container changed, you may want to clear the DF cache to force a reload
    # (kept simple: reload on next /data request)
    global DF_CACHE, LAST_LOAD_UTC
    DF_CACHE = None
    LAST_LOAD_UTC = None

    return jsonify(current)

# --- Restore defaults from config.default.json ---
@app.post("/config/default")
def post_config_default():
    if CFG_DEF.exists():
        try:
            def_cfg = json.loads(CFG_DEF.read_text(encoding="utf-8"))
            write_config({**DEFAULT_CONFIG, **def_cfg})
            # clear cache so next request reloads with defaults
            global DF_CACHE, LAST_LOAD_UTC
            DF_CACHE, LAST_LOAD_UTC = None, None
        except Exception:
            app.logger.exception("default restore failed")
    return jsonify(read_config())

# --- Test Azure access (no save) ---
@app.post("/config/test")
def post_config_test():
    payload = request.get_json(force=True) or {}
    cfg = read_config()
    account   = payload.get("AZURE_STORAGE_ACCOUNT") or cfg.get("AZURE_STORAGE_ACCOUNT")
    key       = payload.get("AZURE_STORAGE_KEY")    or cfg.get("AZURE_STORAGE_KEY")
    container = payload.get("AZURE_CONTAINER")      or cfg.get("AZURE_CONTAINER")

    if not account or not key or not container:
        return ("Missing Storage Account, Access Key or Container Name", 400)

    # Try a lightweight SDK call
    try:
        BlobServiceClient = _load_azure_sdk()
        bsc = BlobServiceClient(account_url=_account_url(account), credential=key)
        cc  = bsc.get_container_client(container)
        # ping: get container properties (fast)
        _ = cc.get_container_properties()
        return (f"Test OK: account={account}, container={container}", 200)
    except Exception as e:
        app.logger.exception("Azure test failed")
        return (f"Azure test failed: {e}", 500)

# --- DATA: JSON payload for table ---
@app.route("/data")
def data():
    """
    Returns:
      - records, columns, total
      - last_load_utc (ISO) and last_load_human
      - optional debug block in server logs (toggle PY_DEBUG)
    Applies fetch_range and max_blobs on the *records* returned to the UI.
    """
    try:
        ensure_loaded()
    except Exception as e:
        app.logger.error(f"Azure connection failed: {e}")
        return jsonify({
            "records": [],
            "columns": [],
            "total": 0,
            "last_load_utc": "n/a",
            "last_load_human": "n/a",
            "error": "Unable to connect to Azure Blob Storage. Please check your configuration."
        }), 200
        
    ensure_loaded()

    cfg = read_config()
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
        return jsonify(payload)

    # preferred first, then the rest (legacy behavior)
    import pandas as pd  # safe: we already checked in ensure_loaded()
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

    for c in dfj.columns:
        dfj[c] = dfj[c].map(_to_jsonable)

    records = json.loads(dfj.to_json(orient="records"))

    # Apply window & limit to what the UI receives
    records = apply_window_and_limit_records(records, cfg)

    payload = {
        "records": records,
        "columns": cols,
        "total": len(records),
        "last_load_utc": last_iso,
        "last_load_human": last_hmn,
    }

    if PY_DEBUG:
        app.logger.debug("[/data] rows=%d cols=%d", len(records), len(cols))

    return jsonify(payload)

# --- CSV download (server-side) ---
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

# --- JSON download (server-side) ---
@app.route("/data.json")
def data_json():
    ensure_loaded()
    if DF_CACHE is None or DF_CACHE.empty:
        return jsonify([])

    import pandas as pd
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

# --- Reload from Azure (rebuild cache) ---
@app.route("/reload", methods=["POST"])
def reload_data():
    app.logger.info("Reload requested")
    global DF_CACHE, LAST_LOAD_UTC
    cfg = read_config()
    DF_CACHE = load_logs_from_blob(cfg)
    LAST_LOAD_UTC = datetime.now(timezone.utc)
    app.logger.info("Reload complete: rows=%d", 0 if DF_CACHE is None else len(DF_CACHE))
    return jsonify({"ok": True, "rows": int(len(DF_CACHE)), "last_load_utc": LAST_LOAD_UTC.isoformat()})

# Serve /favicon.ico -> /static/favicon.ico
@app.route("/favicon.ico")
def favicon():
    return send_from_directory(app.static_folder, "favicon.ico")

# --- Main ---
if __name__ == "__main__":
    cfg = read_config()
    port = int(cfg.get("PORT") or os.getenv("PORT", "8000"))
    app.logger.info("Starting server on http://0.0.0.0:%s", port)
    # Warm cache on boot (optional, must never kill the process)
    try:
        ensure_loaded()
    except BaseException as e:  # catch SystemExit too
        app.logger.warning("Initial load failed (will attempt on first request): %s", e)
    app.run(host="0.0.0.0", port=port, debug=False)

