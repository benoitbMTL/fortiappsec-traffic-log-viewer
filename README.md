# FortiAppSec Traffic Logs Viewer (Azure Blob → Flask + Tabulator)

A compact web UI to browse **FortiAppSec traffic logs** exported to **Azure Blob Storage**.  
The backend (Flask) **downloads NDJSON log lines directly from Azure using values in `.env`**, merges them in-memory with **pandas**, and serves a fast table UI with **Tabulator + Bootstrap 5**. 

---

## ✨ Features
- Pulls **NDJSON** traffic logs from an **Azure Blob** container (all `.txt` blobs).
- In-memory merge (pandas) with optional CSV/Parquet snapshots in `./out/`.
- Blue Bootstrap 5 theme, compact UI, small header filters.
- **Default View** (no horizontal scroll), **All Columns View** (auto horizontal scroll).
- Column picker modal (show/hide), reorder, resize, quick global filter.
- Download CSV/JSON, and **Reload from Azure** on demand.

---

## 📋 Prerequisites
- Azure Storage account & container where **FortiAppSec Traffic Logs** are exported (see step-by-step below).
- Docker (recommended), or Python 3.11+ locally.
- Outbound network allowed to: `unpkg.com` (Tabulator), `cdn.jsdelivr.net` (Bootstrap). If blocked, the app still serves CSV/JSON, but the rich UI won’t load.

---

## 🧭 Step-by-step Setup

### 1) Configure Azure Storage (one-time)
1. In the **Azure Portal**: create or pick a **Storage Account**.
2. Go to **Access keys** and copy an **Account Access Key** (or generate a **SAS** with read/write for blobs and a short expiry).
3. Under **Containers**, create (or reuse) a container (e.g., `traffic-log`). Note the **container name**.

> References:  
> - Azure Blob Storage overview: https://learn.microsoft.com/azure/storage/blobs/storage-blobs-overview  
> - Python SDK quickstart: https://learn.microsoft.com/azure/storage/blobs/storage-quickstart-blobs-python

### 2) Configure FortiAppSec Cloud to export Traffic Logs → Azure Blob
1. In the FortiAppSec Cloud Portal, open **Log Settings**.
2. Enable **Traffic Log Export**.
3. For **Server Type**, select **Azure Blob**.
4. Fill the fields:
   - **Storage Account Name** → your storage account (e.g., `mystorageacct`)
   - **Account Access Key** → the key copied in step 1 (or use a SAS)
   - **Container Name** → the target container (e.g., `traffic-log`)
5. Save.
6. Notes from the product docs:
   - Traffic log timestamps are **recorded in UTC**. The portal may show local time while the exported files remain UTC.
   - Export is **near real time**; this app reads NDJSON lines as they land in the container.

*(Add your screenshots here.)*

### 3) Clone this repository
```bash
git clone https://github.com/<your-org-or-user>/fortiappsec-traffic-log-viewer.git
cd fortiappsec-traffic-log-viewer
```

### 4) Create & fill `.env`
We provide `.env.example`. Copy and edit it:

```bash
cp .env.example .env
```

Fill the values (minimal set):
```ini
# --- Azure Storage ---
AZURE_STORAGE_ACCOUNT=your_storage_account_name
AZURE_STORAGE_KEY=your_access_key_or_sas     # if SAS, include the leading '?'
AZURE_CONTAINER=traffic-log                  # your container name

# --- App settings ---
PORT=8000
MAX_BLOBS=0          # 0 = fetch all blobs (use small number to test)
OUTPUT_DIR=./out     # snapshots will be written here
```

> The app fetches logs **directly from Azure** using these values; **no local log mount** is needed.

### 5) Run the application

#### Option A — Local (with `run.sh`)
A helper script is included to create a venv, install deps, and start the app:

```bash
chmod +x run.sh
./run.sh
```

Open: http://localhost:8000

#### Option B — Docker
**Build** the image:
```bash
docker build -t fortiappsec-traffic-log:latest .
```

**Run** the container (reads `.env` for Azure credentials):
```bash
docker run -d --restart unless-stopped \
  --name fortiappsec-traffic-log \
  --env-file .env \
  -p 6000:8000 \
  fortiappsec-traffic-log:latest
```

Open: http://localhost:6000

(Optional) Persist CSV/Parquet snapshots across restarts:
```bash
docker volume create fortiappsec_out
docker run -d --restart unless-stopped \
  --name fortiappsec-traffic-log \
  --env-file .env \
  -v fortiappsec_out:/app/out \
  -p 6000:8000 \
  fortiappsec-traffic-log:latest
```

---

## 🧱 Files of Interest
- `app.py` – Flask backend that downloads NDJSON from Azure, merges in-memory, exposes `/data`, `/data.csv`, `/data.json`, `/reload`. fileciteturn2file0
- `templates/index.html` – Bootstrap 5 layout; Tabulator & modal UI.
- `static/js/app.js` – Column picker, default/all-columns views, dynamic layout (`fitColumns` vs `fitData`), exports.
- `static/css/style.css` – Blue theme overrides, compact filters, pagination “select” visibility fix, alternating rows.
- `run.sh` – Local runner (venv + pip install + start).
- `requirements.txt` – Python deps (you can pin versions or allow latest).

---

## 🔐 Security Notes
- **Do not commit secrets**: `.env` is ignored by `.gitignore` (keep a public `.env.example` only).
- Prefer **SAS** with tight scope/expiry over full account keys; rotate credentials regularly.
- Restrict storage access with firewall/private endpoints when possible.

---

## 🛠 Troubleshooting
- **Empty table** but `/data?debug=1` shows rows:
  - Likely the Tabulator CDN is blocked. CSV/JSON endpoints still work.
- **No logs appear**:
  - Check `.env` values; verify FortiAppSec export is enabled & writing into the container.
- **Horizontal scroll**:
  - Default view uses `fitColumns` (no H-scroll); “All Columns View” uses `fitData` (H-scroll for wide sets).

---

## 📦 Requirements (Python)
- flask
- azure-storage-blob
- pandas
- pyarrow (optional but recommended for Parquet)
- python-dotenv
- gunicorn

---

## 📚 References
- Azure Blob Storage (docs): https://learn.microsoft.com/azure/storage/blobs/storage-blobs-overview
- Azure Blob Python SDK: https://learn.microsoft.com/azure/storage/blobs/storage-quickstart-blobs-python
- Tabulator docs: http://tabulator.info/docs/6.3
- Bootstrap 5: https://getbootstrap.com/docs/5.3/getting-started/introduction/

---

## 📝 License
MIT
