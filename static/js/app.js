/* ===========================================================
   FortiAppSec Traffic Logs UI (Instrumented v2)
   GOALS:
   - Columns dropdown ALWAYS shows a per-field checkbox list
   - Events are bound EVEN IF Tabulator isn't ready yet
   - Massive console debugging via dlog/dwarn/derror
   - Server-side (Python/Flask) logs via /data
   =========================================================== */

/* === GLOBAL DEBUG HELPERS === */
const DEBUG_TAG = "[FAS-UI]";
// Force horizontal scroll: when true, table uses natural widths and shows an X-scrollbar
const FORCE_HSCROLL = true;
function dlog(...args) { try { console.debug(DEBUG_TAG, ...args); } catch (_) { } }
function dwarn(...args) { try { console.warn(DEBUG_TAG, ...args); } catch (_) { } }
function derror(...args) { try { console.error(DEBUG_TAG, ...args); } catch (_) { } }

/* === CONSTANTS === */
const COLVIS_KEY = "forti_col_visibility_v1";

/* Preferred/default column order and initial visible set */
const DEFAULT_ORDER = [
  "log_timestamp", "http_host", "http_url", "http_method", "service",
  "original_src", "original_srccountry", "dst", "http_refer", "http_retcode", "http_agent",
];
const DEFAULT_VISIBLE = new Set(DEFAULT_ORDER);

/* === UTILITIES === */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* Wait for Tabulator to exist on window, but don't block the whole UI */
async function waitForTabulator(maxMs = 5000) {
  const started = Date.now();
  if (window.__TABULATOR_FAILED__ === true) return false;
  while (typeof window.Tabulator === "undefined") {
    if (window.__TABULATOR_FAILED__ === true) return false;
    if (Date.now() - started > maxMs) return false;
    await sleep(100);
  }
  return true;
}

/* localStorage helpers for column visibility */
function loadColPrefs() { try { return JSON.parse(localStorage.getItem(COLVIS_KEY) || "{}"); } catch (e) { derror("loadColPrefs failed:", e); return {}; } }
function saveColPrefs(map) { try { localStorage.setItem(COLVIS_KEY, JSON.stringify(map)); dlog("saveColPrefs", map); } catch (e) { derror("saveColPrefs failed:", e); } }
function clearColPrefs() { try { localStorage.removeItem(COLVIS_KEY); dlog("clearColPrefs"); } catch (e) { derror("clearColPrefs failed:", e); } }

/* Date helper (used for header info) */
function humanizeIso(iso) {
  if (!iso || iso === "n/a") return "-";
  try {
    const d = new Date(iso);
    const fmt = new Intl.DateTimeFormat("en-US", {
      year: "numeric", month: "short", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      timeZone: "UTC", hour12: false
    });
    return fmt.format(d) + " UTC";
  } catch (e) { derror("humanizeIso failed:", e); return iso; }
}

/* Error banner */
function showError(msg) {
  const el = document.getElementById("errorBanner");
  if (!el) return;
  el.textContent = msg;
  el.classList.remove("d-none");
  derror("ERROR:", msg);
}

/* === FETCH DATA (server logs via debug=1) === */
async function fetchData() {
  const url = "/data";
  dlog("[fetchData] GET", url);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    dlog("[fetchData] status", res.status);
    const payload = await res.json();
    dlog("[fetchData] keys", Object.keys(payload));
    if (payload.debug) dlog("[fetchData] server debug:", payload.debug);
    return payload;
  } catch (e) {
    derror("[fetchData] failed:", e);
    showError(`Failed to fetch data from ${url}. See console.`);
    return { total: 0, columns: [], records: [] };
  }
}

/* === COLUMN ORDERING === */
function orderColumns(allKeys) {
  const setAll = new Set(allKeys);
  const first = DEFAULT_ORDER.filter(k => setAll.has(k));
  const rest = allKeys.filter(k => !first.includes(k));
  const ordered = [...first, ...rest];
  dlog("[orderColumns]", { inCount: allKeys.length, outCount: ordered.length, first });
  return ordered;
}

/* === HEADER TITLE FORMATTER WITH CLOSE (×) === */
function colTitleWithClose(cell, formatterParams, onRendered) {
  const column = cell.getColumn();
  const field = column.getField();

  const el = document.createElement("div");
  el.className = "col-title-wrap";

  el.innerHTML = `
      <span class="col-title text-truncate" title="${field}">${field}</span>
      <button type="button" class="btn btn-link p-0 ms-1 col-close" aria-label="Hide column" title="Hide column">
        <i class="bi bi-x"></i>
      </button>
    `;

  onRendered(() => {
    const btn = el.querySelector(".col-close");
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      try {
        column.hide();
        const prefs = loadColPrefs();
        prefs[field] = false;
        saveColPrefs(prefs);
        console.debug("[ColClose] hidden:", field);
        setLayoutForVisibleColumns(table);
      } catch (err) {
        console.error("[ColClose] failed:", field, err);
      }
    });
  });

  return el;
}


/* === BUILD COLUMN DEFINITIONS === */
function makeColumns(keys, colPrefs) {
  return keys.map(k => {
    const col = {
      title: k,
      field: k,
      headerFilter: "input",
      resizable: true,
      visible: colPrefs[k] !== false,
      widthGrow: 1,
      titleFormatter: colTitleWithClose
    };

    if (k === "log_timestamp") {
      const tz = (APP_CONFIG && APP_CONFIG.timezone) ? APP_CONFIG.timezone : "UTC";
      col.title = `log_timestamp (${tz})`;
      col.formatter = epochToEt;
      col.headerTooltip = `Original field is epoch seconds; rendered in ${tz}`;
    }

    // ↓ Add flag formatter for country fields
    if (k === "srccountry" || k === "original_srccountry") {
      if (window.CountryFlags && typeof window.CountryFlags.countryFlagFormatter === "function") {
        col.formatter = window.CountryFlags.countryFlagFormatter(k);
        col.headerTooltip = (k === "srccountry")
          ? "Source country (flag + name)"
          : "Original source country (flag + name)";
      }
    }

    return col;
  });
}



/* === DEFAULT/RESET VIEWS === */
function applyDefaultView(table, allKeys) {
  dlog("[DefaultView] applying");
  const prefs = {};
  allKeys.forEach(k => prefs[k] = DEFAULT_VISIBLE.has(k));
  saveColPrefs(prefs);
  const ordered = orderColumns(allKeys);
  table.setColumns(makeColumns(ordered, prefs));
  try {
    setLayout(table, "fitColumns");
    toggleHScroll(true);

    if (table.getColumn("log_timestamp")) {
      table.setSort([{ column: "log_timestamp", dir: "desc" }]);
    } else if (table.getColumn("_blob_last_modified")) {
      table.setSort([{ column: "_blob_last_modified", dir: "desc" }]);
    }

    safeRedraw("DefaultView");
    setTimeout(() => debugWidths("DefaultView", table), 0);
  } catch (e) {
    dwarn("[DefaultView] post-setup failed:", e);
  }
}


function applyResetColumns(table, allKeys) {
  dlog("[AllColumnsView] applying");
  clearColPrefs();
  const prefs = {};
  const ordered = orderColumns(allKeys);
  table.setColumns(makeColumns(ordered, prefs));
  try {
    setLayout(table, "fitData");
    toggleHScroll(true);

    if (table.getColumn("log_timestamp")) {
      table.setSort([{ column: "log_timestamp", dir: "desc" }]);
    } else if (table.getColumn("_blob_last_modified")) {
      table.setSort([{ column: "_blob_last_modified", dir: "desc" }]);
    }

    safeRedraw("AllColumnsView");
    setTimeout(() => debugWidths("AllColumnsView", table), 0);
  } catch (e) {
    dwarn("[AllColumnsView] post-setup failed:", e);
  }
}


/* === LAYOUT ADAPTATION (safe redraw) === */
function setLayoutForVisibleColumns(table) {
  // Local-safe redraw fallback if global safeRedraw() is missing
  const _safeRedraw = (where) => {
    try {
      if (typeof safeRedraw === "function") {
        safeRedraw(where);
      } else {
        // Fallback: defer to next frame and check DOM visibility
        requestAnimationFrame(() => {
          const holder = document.querySelector("#table .tabulator-tableholder");
          if (holder && holder.offsetWidth > 0) {
            table?.redraw(true);
          } else {
            // Try again once if holder was not ready
            setTimeout(() => table?.redraw(true), 50);
          }
        });
      }
    } catch (e) {
      dwarn(`[Redraw:${where}] failed`, e);
    }
  };

  if (typeof FORCE_HSCROLL !== "undefined" && FORCE_HSCROLL) {
    try {
      setLayout(table, "fitData");
      toggleHScroll(true);
      _safeRedraw("FORCE_HSCROLL");
      dlog("[Layout] FORCE_HSCROLL=on → fitData");
      setTimeout(() => debugWidths("VisibilityChange(FORCE)", table), 0);
    } catch (e) {
      dwarn("[Layout] FORCE_HSCROLL branch failed:", e);
    }
    return;
  }

  try {
    const visibleCols = table.getColumns().filter((c) => c.isVisible());
    let needOverflow = visibleCols.length > DEFAULT_VISIBLE.size;

    const holder = document.querySelector("#table .tabulator-tableholder");
    const inner = document.querySelector("#table .tabulator-table");
    if (holder && inner) {
      const holderW = holder.clientWidth || 0;
      const innerW = inner.scrollWidth || inner.offsetWidth || 0;
      needOverflow = innerW > holderW || needOverflow;
      dlog("[LayoutCheck]", {
        holderW,
        innerW,
        needOverflow,
        visibleCount: visibleCols.length,
      });
    } else {
      dwarn("[LayoutCheck] holder/inner not found, using count heuristic only");
    }

    setLayout(table, needOverflow ? "fitData" : "fitColumns");
    toggleHScroll(needOverflow);
    _safeRedraw("AutoLayout");
    setTimeout(() => debugWidths("VisibilityChange(Auto)", table), 0);
  } catch (e) {
    dwarn("[Layout] cannot compute/apply layout:", e);
  }
}

/* === TIMESTAMP FORMATTER === */
function epochToEt(cell) {
  const v = cell.getValue();
  if (v === null || v === undefined || v === "") return "";
  const num = Number(v);
  if (Number.isNaN(num)) return String(v);
  const ms = num < 1e12 ? num * 1000 : num;
  const d = new Date(ms);
  const fmt = new Intl.DateTimeFormat("en-US", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false, timeZone: "America/New_York"
  });
  const parts = fmt.format(d).split(/[\/, :]/);
  return `${parts[2]}-${parts[0]}-${parts[1]} ${parts[3]}:${parts[4]}:${parts[5]} ET`;
}

/* === SAFE LAYOUT SWITCHER (with guarded redraw) === */
function setLayout(table, layout) {
  try {
    // Normalize layout to a supported value
    const target = (layout === "fitData" || layout === "fitColumns") ? layout : "fitColumns";
    const needOverflow = (target === "fitData");

    // Toggle horizontal scroll helper class
    toggleHScroll(needOverflow);

    // Apply option using whichever API Tabulator exposes
    if (typeof table.updateOption === "function") {
      table.updateOption("layout", target);          // v6+
    } else if (typeof table.setOptions === "function") {
      table.setOptions({ layout: target });          // v5
    } else {
      table.options = table.options || {};
      table.options.layout = target;                 // last-resort fallback
    }

    // Guarded redraw: only redraw if the holder is measurable/visible
    const guardedRedraw = (where) => {
      try {
        if (typeof safeRedraw === "function") {
          safeRedraw(where);
          return;
        }
      } catch (_) { /* ignore */ }

      requestAnimationFrame(() => {
        const holder = document.querySelector("#table .tabulator-tableholder");
        if (holder && holder.offsetWidth > 0) {
          table?.redraw(true);
        } else {
          // Try once more shortly after if first attempt couldn’t measure
          setTimeout(() => {
            const holder2 = document.querySelector("#table .tabulator-tableholder");
            if (holder2 && holder2.offsetWidth > 0) table?.redraw(true);
          }, 60);
        }
      });
    };

    guardedRedraw(`setLayout:${target}`);
    dlog("[Layout] set to:", target);

    // Widths debug after paint
    setTimeout(() => debugWidths(`setLayout:${target}`, table), 0);
    setTimeout(() => debugWidths(`setLayout:${target}:late`, table), 80);
  } catch (e) {
    dwarn("[Layout] could not set layout:", e);
  }
}


/* === H-SCROLL TOGGLER === */
function toggleHScroll(forceOn) {
  const el = document.getElementById("table");
  if (!el) return;
  if (forceOn) el.classList.add("force-hscroll");
  else el.classList.remove("force-hscroll");
  dlog("[toggleHScroll]", { forceOn, classList: el.className });
}

/* === WIDTHS DEBUG === */
function debugWidths(where, tableInstance) {
  const holder = document.querySelector("#table .tabulator-tableholder");
  const inner = document.querySelector("#table .tabulator-table");
  if (!holder || !inner) { dlog(`[Widths:${where}] holder/inner not found`); return; }
  dlog(`[Widths:${where}] layout=${tableInstance?.options?.layout} | holder.client=${holder.clientWidth} inner.offset=${inner.offsetWidth}`);
}

/* ===========================================================
   COLUMNS DROPDOWN (works even if table isn't ready yet)
   - Binds Bootstrap dropdown events early
   - Rebuilds the checkbox list on show/shown and on init
   - Buttons All / None / Default wired early (no-op logged if table not ready)
   =========================================================== */
let table = null;           // will be set later
let allColumnKeys = [];     // filled after fetch
let bootstrapDropdown = null;

function rebuildColumnsList(reason = "manual") {
  const listEl = document.getElementById("colList");
  if (!listEl) { dwarn("[Columns]", reason, "no #colList in DOM"); return; }
  if (!table) { dwarn("[Columns]", reason, "table not ready; building empty list"); listEl.innerHTML = ""; return; }

  const cols = table.getColumns();
  dlog("[Columns] rebuild", reason, "columns:", cols.length);
  listEl.innerHTML = "";

  cols.forEach(col => {
    const field = col.getField();
    if (!field) return;
    const id = "ck_" + field.replace(/[^a-zA-Z0-9_-]/g, "_");
    const row = document.createElement("label");
    row.className = "form-check d-flex align-items-center gap-2 m-0";
    row.innerHTML = `
      <input class="form-check-input" type="checkbox" id="${id}" ${col.isVisible() ? "checked" : ""}>
      <span class="form-check-label" for="${id}">${field}</span>
    `;
    row.querySelector("input").addEventListener("change", (e) => {
      const on = e.target.checked;
      dlog("[Columns] toggle", field, "→", on);
      if (on) { table.showColumn(field); updateColPref(field, true); }
      else { table.hideColumn(field); updateColPref(field, false); }
      setLayoutForVisibleColumns(table);
    });
    listEl.appendChild(row);
  });

  dlog("[Columns] rebuild done. list children:", listEl.childElementCount);
}

function updateColPref(field, visible) {
  const prefs = loadColPrefs();
  prefs[field] = !!visible;
  saveColPrefs(prefs);
}

/* Bind dropdown events EARLY (before Tabulator) */
document.addEventListener("DOMContentLoaded", () => {
  const toggleBtn = document.getElementById("openColDropdown");
  const listEl = document.getElementById("colList");
  const btnAll = document.getElementById("colAll");
  const btnNone = document.getElementById("colNone");
  const btnDefault = document.getElementById("colDefault");

  if (!toggleBtn || !listEl) {
    dwarn("[Columns] DOMContentLoaded: required elements missing", { toggleBtn: !!toggleBtn, listEl: !!listEl });
    return;
  }

  // Force Bootstrap dropdown init to ensure events fire
  try {
    bootstrapDropdown = bootstrap.Dropdown.getOrCreateInstance(toggleBtn);
    dlog("[Columns] Bootstrap Dropdown initialized");
  } catch (e) {
    derror("[Columns] Bootstrap initialization failed:", e);
  }

  // Listen to Bootstrap dropdown lifecycle events on the toggle button
  toggleBtn.addEventListener("show.bs.dropdown", () => dlog("[Columns] show.bs.dropdown"));
  toggleBtn.addEventListener("shown.bs.dropdown", () => { dlog("[Columns] shown.bs.dropdown → rebuildColumnsList"); rebuildColumnsList("shown.bs.dropdown"); });

  // Extra click to log user interaction
  toggleBtn.addEventListener("click", () => dlog("[Columns] toggle button clicked"));

  // Wire All/None/Default buttons (they work even if table not ready; we log and no-op)
  btnAll?.addEventListener("click", () => {
    dlog("[Columns] All clicked");
    if (!table) { dwarn("[Columns] All clicked but table not ready"); return; }
    table.getColumns().forEach(c => { c.show(); updateColPref(c.getField(), true); });
    rebuildColumnsList("All");
    setLayoutForVisibleColumns(table);
  });
  btnNone?.addEventListener("click", () => {
    dlog("[Columns] None clicked");
    if (!table) { dwarn("[Columns] None clicked but table not ready"); return; }
    table.getColumns().forEach(c => { c.hide(); updateColPref(c.getField(), false); });
    rebuildColumnsList("None");
    setLayoutForVisibleColumns(table);
  });
  btnDefault?.addEventListener("click", () => {
    dlog("[Columns] Default clicked");
    if (!table) { dwarn("[Columns] Default clicked but table not ready"); return; }
    applyDefaultView(table, allColumnKeys);
    rebuildColumnsList("Default");
  });

  // Build an initial (possibly empty) list so you see immediate feedback
  rebuildColumnsList("DOMContentLoaded");
});

/* ===========================================================
   TABULATOR INIT
   =========================================================== */
function setFullHeight() {
  const tableHost = document.getElementById("table");
  if (!tableHost) { dlog("[setFullHeight] #table missing"); return; }

  // compute available height (optional debug)
  const header = document.querySelector(".navbar");
  const topH = (header?.offsetHeight || 0) + 24;
  const h = Math.max(240, window.innerHeight - topH);
  dlog("[setFullHeight] viewportH=", window.innerHeight, "topH=", topH, "calcH=", h);

  // Defer redraw until the next frame + only if the host is visible
  if (!window.requestAnimationFrame) {
    safeRedraw("setFullHeight(norf)");
  } else {
    requestAnimationFrame(() => safeRedraw("setFullHeight"));
  }
}

function elementIsVisible(el) {
  // visible if in DOM and has layout box
  return !!(el && el.offsetParent !== null);
}

function safeRedraw(where = "unknown") {
  try {
    const host = document.getElementById("table");
    if (!host) { dwarn("[safeRedraw]", where, "no #table"); return; }
    if (!elementIsVisible(host)) {
      dwarn("[safeRedraw]", where, "#table not visible yet → skip");
      return;
    }
    if (table && typeof table.redraw === "function") {
      table.redraw(true);
      dlog("[safeRedraw]", where, "OK");
    }
  } catch (e) {
    dwarn("[safeRedraw] failed at", where, e);
  }
}


async function init() {
  dlog("init() start");
  const payload = await fetchData();
  if (!payload.records || payload.records.length === 0) {
    dwarn("[init] No records found. Stopping initialization.", payload);
    if (payload.total > 0) showError("Data loaded, but no records were provided for the table.");
    else showError("No data records available to display.");
    return;
  }

  // Header counters
  const countEl = document.getElementById("count");
  const lastEl = document.getElementById("last");
  if (countEl) countEl.innerText = payload.total;
  if (lastEl) lastEl.innerText = payload.last_load_human || humanizeIso(payload.last_load_utc);
  dlog(`[init] Total records: ${payload.total}, Columns: ${payload.columns.length}`);

  // Ensure Tabulator is loaded
  const ok = await waitForTabulator(5000);
  if (!ok) {
    derror("[init] Tabulator not available.");
    showError("Unable to load the table UI (Tabulator). Check CDN/network.");
    return;
  }

  allColumnKeys = payload.columns.slice();
  const ordered = orderColumns(allColumnKeys);
  const stored = loadColPrefs();
  const usePrefs = Object.keys(stored).length > 0 ? stored : (() => {
    const m = {}; allColumnKeys.forEach(k => m[k] = DEFAULT_VISIBLE.has(k)); return m;
  })();

  dlog("[init] columns to use:", ordered.length, "visible count:", Object.values(usePrefs).filter(v => v !== false).length);

  // Create the Tabulator table
  table = new Tabulator("#table", {
    data: payload.records,
    columns: makeColumns(ordered, usePrefs),
    layout: "fitData",
    height: "100%",
    resizableColumns: true,
    movableColumns: true,
    selectable: true,
    pagination: true,
    paginationSize: 15,
    paginationSizeSelector: [15, 25, 50, 100, 250, 300],
    initialSort: [{ column: (allColumnKeys.includes("log_timestamp") ? "log_timestamp" : "_blob_last_modified"), dir: "desc" }],
    theme: "bootstrap5",
  });

  // Expose for manual debugging
  window.table = table;
  dlog("Tabulator instance created and exposed as window.table");

  // Initial layout
  toggleHScroll(true);

  // Bind table events (verbose)
  table.on("tableBuilt", () => {
    dlog("[Tabulator] tableBuilt");
    safeRedraw("tableBuilt");
    debugWidths("tableBuilt", table);
  });
  table.on("renderComplete", () => dlog("[Tabulator] renderComplete"));
  table.on("dataProcessed", () => dlog("[Tabulator] dataProcessed"));
  table.on("columnResized", (col) =>
    dlog("[Tabulator] columnResized", col.getField())
  );
  table.on("columnMoved", (col) =>
    dlog("[Tabulator] columnMoved", col.getField())
  );
  table.on("columnVisibilityChanged", (col, visible) => {
    dlog(
      "[Tabulator] columnVisibilityChanged",
      col.getField(),
      "→",
      visible
    );
    rebuildColumnsList("columnVisibilityChanged");
  });

  // Layout & size handling
  document.addEventListener("DOMContentLoaded", () => {
    if (table) {
      safeRedraw("DOMContentLoaded");
      debugWidths("windowLoad", table);
      dlog("DOMContentLoaded redraw");
    }
  });

  window.addEventListener("resize", () => {
    if (table) {
      setFullHeight();
      safeRedraw("resize");
      debugWidths("resize", table);
    }
  });


  // Buttons & filters
  wireButtons();

  // First sizing
  setFullHeight();

  dlog("[init] Tabulator initialized");
}

function wireButtons() {
  const qf = document.getElementById("quickFilter");
  const clearBtn = document.getElementById("clearFilter");

  if (clearBtn) {
    clearBtn.onclick = () => {
      dlog("[Button] Clear Filter");
      if (table) { qf.value = ""; table.clearFilter(true); }
    };
  }
  if (qf) {
    qf.addEventListener("input", (e) => {
      const val = e.target.value.toLowerCase();
      dlog("[QuickFilter] input:", val);
      if (!table) return;
      if (!val) { table.clearFilter(true); return; }
      table.setFilter(function (rowData) {
        for (const k in rowData) {
          const v = rowData[k];
          if (v && String(v).toLowerCase().includes(val)) return true;
        }
        return false;
      });
    });
  }

  const btnDefault = document.getElementById("btnDefaultView");
  const btnReset = document.getElementById("btnAllColumns");
  if (btnDefault) btnDefault.onclick = () => { dlog("[Button] Default View"); if (table) applyDefaultView(table, allColumnKeys); };
  if (btnReset) btnReset.onclick = () => { dlog("[Button] All Columns View"); if (table) applyResetColumns(table, allColumnKeys); };

  const btnCsv = document.getElementById("btnDownloadCsv");
  const btnJson = document.getElementById("btnDownloadJson");
  if (btnCsv) btnCsv.onclick = () => { if (!table) { showError("CSV download unavailable"); return; } try { dlog("[Button] Download CSV"); table.download("csv", "traffic_logs.csv"); } catch (e) { derror(e); showError("CSV download failed"); } };
  if (btnJson) btnJson.onclick = () => { if (!table) { showError("JSON download unavailable"); return; } try { dlog("[Button] Download JSON"); table.download("json", "traffic_logs.json"); } catch (e) { derror(e); showError("JSON download failed"); } };

  const reloadBtn = document.getElementById("reloadBtn");
  if (reloadBtn) {
    reloadBtn.onclick = async () => {
      const btn = reloadBtn;
      btn.disabled = true; btn.textContent = "Reloading…";
      dlog("[Button] Reload from Azure");
      try {
        const r = await fetch("/reload", { method: "POST" });
        dlog("[Reload] status:", r.status);
        if (r.ok) location.reload();
        else throw new Error(`Server returned status ${r.status}: ${await r.text()}`);
      } catch (e) {
        derror("[Reload] failed:", e);
        showError("Reload failed. See console.");
      } finally {
        btn.disabled = false; btn.textContent = "Reload from Azure";
      }
    };
  }
}





/* ============================================================
   CONFIG FRONTEND (with heavy console debugging)
   - Loads active config (config.json) from backend
   - Auto-opens modal if config is missing (first run, no .env & no config.json)
   - Save writes config.json (active); Default restores from config.default.json
   - Test validates Azure access without saving
   - Timezone is used by epochToEt for log rendering
   ============================================================ */

let APP_CONFIG = {
  timezone: "UTC",
  AZURE_STORAGE_ACCOUNT: "",
  AZURE_STORAGE_KEY: "",
  AZURE_CONTAINER: "",
  fetch_range: "unlimited", // unlimited | last_hour | last_day | custom
  start_utc: "",            // when fetch_range = custom (ISO-like: "YYYY-MM-DDTHH:mm")
  end_utc: "",
  max_blobs: 0              // 0 = unlimited
};

// ---------- Utilities ----------
function dbg(...args) { try { console.debug("[CONFIG]", ...args); } catch { } }
function dgw(...args) { try { console.warn("[CONFIG]", ...args); } catch { } }
function dge(...args) { try { console.error("[CONFIG]", ...args); } catch { } }

// Populate timezone <select> OR <datalist> (auto-detect)
function populateTimezoneSelect() {
  const el = document.getElementById("cfgTimezone");
  if (!el) { dgw("populateTimezoneSelect() no element"); return; }

  // Build the list of timezones
  let tzList = [];
  if (typeof Intl !== "undefined" && Intl.supportedValuesOf) {
    try { tzList = Intl.supportedValuesOf("timeZone"); } catch { }
  }
  if (tzList.length === 0) {
    tzList = ["UTC", "America/Toronto", "America/New_York", "Europe/Paris", "Europe/London", "Asia/Tokyo", "Australia/Sydney"];
    dgw("Intl.supportedValuesOf not available; using short fallback list");
  }

  // If it’s a <select>, fill <option>; if it’s an <input list>, fill <datalist>
  if (el.tagName === "SELECT") {
    el.innerHTML = "";
    tzList.forEach(tz => {
      const opt = document.createElement("option");
      opt.value = tz;
      opt.textContent = tz;
      el.appendChild(opt);
    });
  } else {
    // input[list]: find the datalist
    const dl = document.getElementById(el.getAttribute("list"));
    if (!dl) { dgw("populateTimezoneSelect(): datalist not found"); return; }
    dl.innerHTML = "";
    tzList.forEach(tz => {
      const opt = document.createElement("option");
      opt.value = tz;       // text is optional for datalist
      dl.appendChild(opt);
    });

    // Optional: validate the value on blur and warn if not an exact match
    el.addEventListener("blur", () => {
      const val = el.value.trim();
      if (!val) return;
      if (!tzList.includes(val)) {
        showAlert("warning", `Unknown timezone "${val}". Please pick a value from the list.`);
      }
    });
  }

  dbg("populateTimezoneSelect done:", tzList.length, "items");
}


// sentinel used to show dots but avoid overwriting unless user changes it
const KEY_SENTINEL = "***************************************************************************";

// Apply config values to modal inputs
function fillModalFromConfig(cfg) {
  dbg("fillModalFromConfig", cfg);
  document.getElementById("cfgTimezone").value = cfg.timezone || "UTC";
  document.getElementById("cfgAccount").value = cfg.AZURE_STORAGE_ACCOUNT || "";
  document.getElementById("cfgContainer").value = cfg.AZURE_CONTAINER || "";
  document.getElementById("cfgFetchRange").value = cfg.fetch_range || "last_day";
  document.getElementById("cfgMaxBlobs").value = Number.isFinite(cfg.max_blobs) ? cfg.max_blobs : 5000;

  // show dots if a key is present server-side (we don't fetch it)
  const hasKey = !!cfg.AZURE_STORAGE_KEY; // backend can optionally include boolean or omit; safe fallback
  document.getElementById("cfgKey").value = hasKey ? KEY_SENTINEL : "";

  const isCustom = (cfg.fetch_range === "custom");
  document.getElementById("customRangeRow").style.display = isCustom ? "" : "none";
  document.getElementById("cfgStartUtc").value = cfg.start_utc || "";
  document.getElementById("cfgEndUtc").value = cfg.end_utc || "";
}


// Read modal inputs into an object (keeping empty key = “no change”)
function readModalToPayload() {
  const keyInput = document.getElementById("cfgKey").value;
  const payload = {
    timezone: document.getElementById("cfgTimezone").value,
    AZURE_STORAGE_ACCOUNT: document.getElementById("cfgAccount").value,
    // Only send the key if user typed a new value (not sentinel, not empty)
    AZURE_STORAGE_KEY: (keyInput && keyInput !== KEY_SENTINEL) ? keyInput : "",
    AZURE_CONTAINER: document.getElementById("cfgContainer").value,
    fetch_range: document.getElementById("cfgFetchRange").value,
    max_blobs: parseInt(document.getElementById("cfgMaxBlobs").value || "0", 10),
    start_utc: document.getElementById("cfgStartUtc").value,
    end_utc: document.getElementById("cfgEndUtc").value
  };
  dbg("readModalToPayload", payload);
  return payload;
}

// ---------- Backend calls ----------
async function fetchConfigState() {
  try {
    const res = await fetch("/config/state");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const state = await res.json(); // { needs_config: bool, config: {...} }
    dbg("fetchConfigState", state);
    if (state.config) APP_CONFIG = state.config;
    return state;
  } catch (e) {
    dge("fetchConfigState failed:", e);
    return { needs_config: false, config: APP_CONFIG };
  }
}

async function getConfig() {
  try {
    const res = await fetch("/config");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const cfg = await res.json();
    dbg("getConfig", cfg);
    APP_CONFIG = cfg;
    return cfg;
  } catch (e) {
    dge("getConfig failed:", e);
    return APP_CONFIG;
  }
}

/* ============================================================
   CONFIG: save + reload + refresh (all logs in English)
   ============================================================ */

/* Run the backend reload, manage the navbar button state, and log verbosely */
async function doBackendReload() {
  const btn = document.getElementById("reloadBtn");
  if (btn) { btn.disabled = true; btn.textContent = "Reloading…"; }
  dlog("[Config] Calling POST /reload");

  try {
    const res = await fetch("/reload", { method: "POST" });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const json = await res.json();
    dlog("[Config] Reload OK:", json);
    return true;
  } catch (e) {
    derror("[Config] Reload failed:", e);
    showAlert("danger", "Reload failed. See console for details.");
    return false;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Reload from Azure"; }
  }
}

/* Fetch /data and push it into the table (or build the table on first run) */
async function refreshUiAfterReload() {
  dlog("[Config] Refreshing UI after reload: fetching /data");
  const payload = await fetchData();

  // Backend surfaced a friendly error (e.g., Azure connectivity)
  if (payload?.error) {
    showError(payload.error);
    return false;
  }

  // Normalize & validate payload
  const records = Array.isArray(payload?.records) ? payload.records : [];
  const columns = Array.isArray(payload?.columns) ? payload.columns.slice() : [];
  const total = Number.isFinite(payload?.total) ? payload.total : records.length;

  // Hide error banner if records exist
  const banner = document.getElementById("errorBanner");
  if (banner && records.length > 0) banner.classList.add("d-none");

  // Header counters
  const countEl = document.getElementById("count");
  const lastEl = document.getElementById("last");
  if (countEl) countEl.innerText = total;
  if (lastEl) lastEl.innerText = payload?.last_load_human || payload?.last_load_utc || "-";

  // Ensure Tabulator library is here before touching the table
  const tabOk = await waitForTabulator(5000);
  if (!tabOk) {
    derror("[Config] Tabulator not available after reload");
    showError("Unable to build the table UI (Tabulator). Check CDN/network.");
    return false;
  }

  // Destroy any existing instance to avoid header/DOM inconsistencies
  try {
    if (window.table && typeof table.destroy === "function") {
      dlog("[Config] Destroying existing Tabulator before rebuild");
      table.destroy(true);
      window.table = null;
    }
  } catch (e) {
    dwarn("[Config] table.destroy failed (continuing with rebuild):", e);
  }

  // Prepare columns + prefs
  allColumnKeys = columns;
  const ordered = orderColumns(allColumnKeys);
  const stored = loadColPrefs();
  const usePrefs =
    Object.keys(stored).length > 0
      ? stored
      : (() => {
          const m = {};
          allColumnKeys.forEach((k) => (m[k] = DEFAULT_VISIBLE.has(k)));
          return m;
        })();

  // Build fresh table
  try {
    table = new Tabulator("#table", {
      data: records,
      columns: makeColumns(ordered, usePrefs),
      layout: "fitData",
      height: "100%",
      resizableColumns: true,
      movableColumns: true,
      selectable: true,
      pagination: true,
      paginationSize: 15,
      paginationSizeSelector: [15, 25, 50, 100, 250, 300],
      initialSort: [
        {
          column: allColumnKeys.includes("log_timestamp")
            ? "log_timestamp"
            : "_blob_last_modified",
          dir: "desc",
        },
      ],
      theme: "bootstrap5",
    });
    window.table = table;

    // Update Columns dropdown to reflect current headers
    rebuildColumnsList("afterReload(rebuild)");

    // Layout & final redraw
    toggleHScroll(true);
    safeRedraw("afterReload(rebuild)");
    setTimeout(() => debugWidths("afterReload(rebuild)", table), 0);

    // If still no data, show a friendly banner (keeps UX consistent)
    if (records.length === 0) {
      showError("No data records available to display.");
    }

    dlog("[Config] Rebuild OK after reload, rows:", records.length);
    return true;
  } catch (e) {
    derror("[Config] Rebuild failed after reload:", e);
    showError("Failed to rebuild table after reload. See console.");
    return false;
  }
}

/* Save config, show success alert, reload backend, refresh table, close modal */
async function saveConfig() {
  const body = readModalToPayload();
  const btn = document.getElementById("btnCfgSave");
  try {
    // Optimistic UI on the Save button
    if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }

    const res = await fetch("/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const saved = await res.json();
    dbg("saveConfig OK:", saved);
    APP_CONFIG = saved;

    // Keep timestamp column title in sync with chosen timezone
    try {
      const tz = APP_CONFIG?.timezone || "UTC";
      const tsCol = table?.getColumn("log_timestamp");
      if (tsCol) tsCol.updateDefinition({ title: `log_timestamp (${tz})` });
      table?.redraw(true);
      dlog("[Config] Updated timestamp column title to", tz);
    } catch (e) {
      dwarn("Could not update timestamp column title after save:", e);
    }

    // 1) Success toast inside the modal
    showAlert("success", "Configuration saved. Reloading data…");

    // 2) Ask backend to reload cache
    const reloaded = await doBackendReload();
    if (!reloaded) return; // doBackendReload already surfaced an alert

    // 3) Pull fresh data into UI (full rebuild path)
    const ok = await refreshUiAfterReload();
    if (!ok) return;

    // Ensure modal reflects the just-saved config (prevents empty fields feeling)
    fillModalFromConfig(APP_CONFIG);

    // 4) Close the modal safely after successful save+reload
    closeConfigModalSafely();
    dlog("[Config] Modal closed after successful save+reload");

    // Final redraw for good measure
    safeRedraw("saveConfig OK");
  } catch (e) {
    dge("saveConfig failed:", e);
    showAlert("danger", "Save failed. See console for details.");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Save"; }
  }
}


async function resetConfigToDefault() {
  try {
    const res = await fetch("/config/default", { method: "POST" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const def = await res.json();
    dbg("resetConfigToDefault OK:", def);
    APP_CONFIG = def;
    fillModalFromConfig(APP_CONFIG);
    if (window.table) safeRedraw("resetConfigToDefault");
  } catch (e) {
    dge("resetConfigToDefault failed:", e);
  }
}


async function testConfig() {
  const body = readModalToPayload(); // do not save
  try {
    const res = await fetch("/config/test", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    });

    const text = await res.text();
    dbg("testConfig response:", res.status, text);

    if (res.ok) {
      showAlert("success", text || "Test OK.");
    } else {
      showAlert("danger", text || `Test failed with HTTP ${res.status}.`);
    }
  } catch (e) {
    dge("testConfig failed:", e);
    showAlert("danger", "Test failed. See console for details.");
  }
}

// ---------- UI wiring ----------
document.addEventListener("DOMContentLoaded", async () => {
  dbg("DOMContentLoaded → config init");
  populateTimezoneSelect();

  // Fetch state (auto-open modal if needed)
  try {
    const state = await fetchConfigState();
    if (state.needs_config) {
      dbg("No config detected → auto-open Config modal");
      const modal = getConfigModal();
      modal?.show();
      fillModalFromConfig(state.config || APP_CONFIG);
    } else {
      fillModalFromConfig(state.config || APP_CONFIG);
    }
  } catch (e) {
    dge("Initial config state failed:", e);
  }

  // Toggle custom range row visibility
  const fetchRangeSel = document.getElementById("cfgFetchRange");
  fetchRangeSel?.addEventListener("change", () => {
    const show = (fetchRangeSel.value === "custom");
    document.getElementById("customRangeRow").style.display = show ? "" : "none";
    dbg("Fetch range changed:", fetchRangeSel.value);
  });

  // Buttons
  document.getElementById("btnCfgSave")?.addEventListener("click", saveConfig);
  document.getElementById("btnCfgDefault")?.addEventListener("click", resetConfigToDefault);
  document.getElementById("btnCfgTest")?.addEventListener("click", testConfig);
  document.getElementById("btnCfgClose")?.addEventListener("click", () => dbg("Config modal closed via footer"));
  document.getElementById("btnCfgXClose")?.addEventListener("click", () => dbg("Config modal closed via X"));
});

// ---------- Time formatter with French style (DD-MM-YYYY HH:mm:ss TZ) ----------
function epochToEt(cell) {
  const v = cell.getValue();
  if (v === null || v === undefined || v === "") return "";
  const num = Number(v);
  if (Number.isNaN(num)) return String(v);

  const ms = num < 1e12 ? num * 1000 : num; // detect seconds vs ms
  const d = new Date(ms);

  const tz = (APP_CONFIG && APP_CONFIG.timezone) ? APP_CONFIG.timezone : "UTC";

  // French locale with seconds
  const fmt = new Intl.DateTimeFormat("fr-FR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: tz,
  });

  // Example: "29/09/2025 00:42:36"
  const formatted = fmt.format(d);

  // Replace slashes by dashes: "29-09-2025 00:42:36"
  const out = `${formatted.replace(/\//g, "-")} ${tz}`;

  console.debug("[epochToEt]", { in: v, ms, tz, out });
  return out;
}





function showAlert(kind /* 'success' | 'danger' | 'warning' | 'info' */, message) {
  const host = document.getElementById("cfgAlert");
  if (!host) { console.warn("[Alert] #cfgAlert missing"); return; }
  host.innerHTML = "";

  // NOTE: pas de 'alert-dismissible' ici
  const div = document.createElement("div");
  div.className = `alert alert-${kind} fade show py-2 mb-0`;
  div.setAttribute("role", "alert");
  div.innerHTML = `
    <div class="d-flex align-items-center">
      <div class="small flex-grow-1">${message}</div>
      <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
    </div>
  `;
  host.appendChild(div);
}




// Boot sequence: get config first, then build table
async function bootstrapApp() {
  try {
    dlog("bootstrapApp() → loading config first");
    // Charge l'état + remplit APP_CONFIG
    const state = await fetchConfigState(); // met APP_CONFIG = state.config si présent
    if (state.needs_config) {
      dlog("No active config → auto-open modal");
      const modal = getConfigModal();
      modal?.show();
      fillModalFromConfig(state.config || APP_CONFIG);
    } else {
      fillModalFromConfig(state.config || APP_CONFIG);
    }

    // ⚠️ Important: init table only after config is ready
    await init();
  } catch (e) {
    derror("bootstrapApp failed:", e);
    showError("Failed to initialize app. See console for details.");
  }
}

/* ---------------------------
   Modal helpers (safe open/close)
   --------------------------- */
function getConfigModal() {
  const el = document.getElementById("configModal");
  return el ? bootstrap.Modal.getOrCreateInstance(el) : null;
}

function closeConfigModalSafely() {
  const el = document.getElementById("configModal");
  if (!el) return;

  // Hide the existing instance (do NOT create a new one here)
  const inst = bootstrap.Modal.getInstance(el) || bootstrap.Modal.getOrCreateInstance(el);
  try { inst.hide(); } catch (_) { }

  // Safety cleanup in case a ghost backdrop/body class remains
  // (can happen if multiple instances were created elsewhere)
  setTimeout(() => {
    document.querySelectorAll(".modal-backdrop").forEach(b => b.remove());
    document.body.classList.remove("modal-open");
    document.body.style.removeProperty("overflow");
    document.body.style.removeProperty("paddingRight");
  }, 50);
}


bootstrapApp();

