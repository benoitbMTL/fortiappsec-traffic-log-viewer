/* ===========================================================
   FortiAppSec Traffic Logs UI
   SECTIONS (JS):
   - CONSTANTS & UTILS
   - FETCH
   - COLUMN LAYOUT & VISIBILITY (order, default view, reset)
   - COLUMN PICKER (Bootstrap modal)
   - TABULATOR TABLE (init, sort newest first, full-height)
   - BUTTONS: reload, downloads, filters, default/reset
   =========================================================== */

/* === SECTION: CONSTANTS & UTILS === */
const COLVIS_KEY = "forti_col_visibility_v1";

const DEFAULT_ORDER = [
    "log_timestamp",
    "http_host",
    "http_url",
    "http_method",
    "service",
    "original_src",
    "original_srccountry",
    "dst",
    "http_agent",
    "http_refer",
    "http_retcode",
];

const DEFAULT_VISIBLE = new Set([
    "log_timestamp",
    "http_host",
    "http_url",
    "http_method",
    "service",
    "original_src",
    "original_srccountry",
    "dst",
    "http_agent",
    "http_refer",
    "http_retcode",
]);

// --- Robust loader: wait for Tabulator to be available ---
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForTabulator(maxMs = 5000) {
    const started = Date.now();
    // Fail fast if script tag already reported an error
    if (window.__TABULATOR_FAILED__ === true) return false;

    while (typeof window.Tabulator === "undefined") {
        if (window.__TABULATOR_FAILED__ === true) return false;
        if (Date.now() - started > maxMs) return false;
        await sleep(100);
    }
    return true;
}

function loadColPrefs() {
    try { return JSON.parse(localStorage.getItem(COLVIS_KEY) || "{}"); }
    catch { return {}; }
}
function saveColPrefs(map) {
    try { localStorage.setItem(COLVIS_KEY, JSON.stringify(map)); } catch { }
}
function clearColPrefs() { try { localStorage.removeItem(COLVIS_KEY); } catch { } }

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
    } catch { return iso; }
}
function showError(msg) {
    const el = document.getElementById("errorBanner");
    if (!el) return;
    el.textContent = msg;
    el.classList.remove("d-none");
}

/* === SECTION: FETCH === */
async function fetchData() {
    const url = "/data?debug=1";
    console.debug("[fetchData] GET", url);
    const res = await fetch(url);
    console.debug("[fetchData] status", res.status);
    const payload = await res.json();
    console.debug("[fetchData] payload keys:", Object.keys(payload));
    if (payload.debug) console.debug("[fetchData] server debug:", payload.debug);
    return payload;
}

/* === SECTION: COLUMN LAYOUT & VISIBILITY (order, default view, reset) === */
function orderColumns(allKeys) {
    const setAll = new Set(allKeys);
    const first = DEFAULT_ORDER.filter(k => setAll.has(k));
    const rest = allKeys.filter(k => !first.includes(k));
    return [...first, ...rest];
}


/* Small close button in each column header to hide the column */
function colTitleWithClose(cell, formatterParams, onRendered) {
    // Column object & field
    const column = cell.getColumn();
    const field = column.getField();

    // Wrapper
    const el = document.createElement("div");
    el.className = "col-title-wrap";

    // Title + close button (Bootstrap's btn-close for small cross)
    el.innerHTML = `
    <span class="col-title text-truncate" title="${field}">${field}</span>
    <button type="button" class="btn-close btn-close-white col-close" aria-label="Hide column"></button>
  `;

    onRendered(() => {
        const btn = el.querySelector(".col-close");
        btn.addEventListener("click", (e) => {
            e.stopPropagation(); // don't trigger sort/filter focus
            try {
                // Hide column in table
                column.hide();

                // Persist preference: set visible=false
                const prefs = loadColPrefs();
                prefs[field] = false;
                saveColPrefs(prefs);
                console.debug("[ColClose] hidden:", field);
            } catch (err) {
                console.error("[ColClose] failed to hide column:", field, err);
            }
        });
    });

    return el;
}

// --- REPLACE the two makeColumns() with this single version ---

function makeColumns(keys, colPrefs) {
    return keys.map(k => {
        const col = {
            title: k,
            field: k,
            headerFilter: "input",
            resizable: true,
            visible: colPrefs[k] !== false,
            widthGrow: 1,
            // keep the small “×” in header to hide a column
            titleFormatter: colTitleWithClose,
        };

        // Render Unix epoch (sec or ms) as Eastern Time
        if (k === "log_timestamp") {
            col.title = "log_timestamp (ET)";
            col.formatter = epochToEt;
            col.headerTooltip = "Original field is epoch seconds; rendered as Eastern Time";
        }
        return col;
    });
}


function applyDefaultView(table, allKeys) {
    console.debug("[DefaultView] applying");
    // 1) Persist visibility prefs = only DEFAULT_VISIBLE shown
    const prefs = {};
    allKeys.forEach(k => { prefs[k] = DEFAULT_VISIBLE.has(k); });
    saveColPrefs(prefs);

    // 2) Order columns (put your priority ones first) and rebuild
    const ordered = orderColumns(allKeys);
    table.setColumns(makeColumns(ordered, prefs));

    // 3) Default view should be compact (no H-scroll)
    try {
        // Prefer the safe layout switcher if present
        if (typeof setLayout === "function") setLayout(table, "fitColumns");
        else if (typeof table.updateOption === "function") table.updateOption("layout", "fitColumns");
        else if (typeof table.setOptions === "function") table.setOptions({ layout: "fitColumns" });

        // Ensure the “force-hscroll” class is off
        if (typeof toggleHScroll === "function") toggleHScroll(false);

        // Keep newest first (if your data has that column)
        if (table.getColumn("_blob_last_modified")) {
            table.setSort([{ column: "_blob_last_modified", dir: "desc" }]);
        }

        table.redraw(true);
        if (typeof debugWidths === "function") setTimeout(() => debugWidths("DefaultView", table), 0);
    } catch (e) {
        console.warn("[DefaultView] post-setup failed:", e);
    }
}


function applyResetColumns(table, allKeys) {
    console.debug("[AllColumnsView] applying");
    // 1) Drop all saved visibility so EVERYTHING shows
    clearColPrefs();

    // 2) Rebuild with all columns visible (prefs = empty → visible by default)
    const prefs = {};
    const ordered = orderColumns(allKeys);
    table.setColumns(makeColumns(ordered, prefs));

    // 3) “All Columns” should allow natural widths → H-scroll
    try {
        if (typeof setLayout === "function") setLayout(table, "fitData");
        else if (typeof table.updateOption === "function") table.updateOption("layout", "fitData");
        else if (typeof table.setOptions === "function") table.setOptions({ layout: "fitData" });

        // Ensure the “force-hscroll” class is ON to guarantee overflow
        if (typeof toggleHScroll === "function") toggleHScroll(true);

        // Keep newest first if present
        if (table.getColumn("_blob_last_modified")) {
            table.setSort([{ column: "_blob_last_modified", dir: "desc" }]);
        }

        table.redraw(true);
        if (typeof debugWidths === "function") setTimeout(() => debugWidths("AllColumnsView", table), 0);
    } catch (e) {
        console.warn("[AllColumnsView] post-setup failed:", e);
    }
}


/**
 * Pick the right layout automatically when user shows/hides columns
 * - If the inner table will overflow or the visible count exceeds your default set,
 *   switch to fitData (H-scroll). Otherwise keep fitColumns (no H-scroll).
 */
function setLayoutForVisibleColumns(table) {
    try {
        const visibleCols = table.getColumns().filter(c => c.isVisible());

        // Heuristic #1: count-based threshold
        let needOverflow = visibleCols.length > DEFAULT_VISIBLE.size;

        // Heuristic #2: real DOM measurement (authoritative if available)
        const holder = document.querySelector("#table .tabulator-tableholder");
        const inner = document.querySelector("#table .tabulator-table");
        if (holder && inner) {
            const holderW = holder.clientWidth;
            const innerW = inner.scrollWidth || inner.offsetWidth;
            // If the inner content is wider than the holder, we *must* allow H-scroll
            needOverflow = innerW > holderW || needOverflow;
            console.debug("[LayoutCheck] holderW=", holderW, "innerW=", innerW, "needOverflow=", needOverflow);
        }

        // Apply chosen layout + toggle the force-hscroll class
        if (typeof setLayout === "function") setLayout(table, needOverflow ? "fitData" : "fitColumns");
        else if (typeof table.updateOption === "function") table.updateOption("layout", needOverflow ? "fitData" : "fitColumns");
        else if (typeof table.setOptions === "function") table.setOptions({ layout: needOverflow ? "fitData" : "fitColumns" });

        if (typeof toggleHScroll === "function") toggleHScroll(needOverflow);

        table.redraw(true);
        if (typeof debugWidths === "function") setTimeout(() => debugWidths("VisibilityChange", table), 0);

        console.debug("[Layout]",
            needOverflow ? "fitData (H-scroll enabled)" : "fitColumns (no H-scroll)",
            "| visible cols:", visibleCols.length);
    } catch (e) {
        console.warn("[Layout] cannot compute/apply layout:", e);
    }
}


// Format a Unix epoch (seconds or milliseconds) into a readable ET string
function epochToEt(cell) {
    const v = cell.getValue();
    if (v === null || v === undefined || v === "") return "";
    const num = Number(v);
    if (Number.isNaN(num)) return String(v);

    // seconds → ms si nécessaire
    const ms = num < 1e12 ? num * 1000 : num;
    const d = new Date(ms);

    // Format en Eastern Time (NY)
    const fmt = new Intl.DateTimeFormat("en-US", {
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
        hour12: false, timeZone: "America/New_York"
    });

    const parts = fmt.format(d).split(/[\/, :]/);  // [mm, dd, yyyy, hh, mm, ss]
    return `${parts[2]}-${parts[0]}-${parts[1]} ${parts[3]}:${parts[4]}:${parts[5]} ET`;
}

// --- SAFE layout switcher for Tabulator v5/v6 ---
function setLayout(table, layout) {
    try {
        const needOverflow = (layout === "fitData");
        toggleHScroll(needOverflow);

        if (typeof table.updateOption === "function") {
            table.updateOption("layout", layout);     // v6+
        } else if (typeof table.setOptions === "function") {
            table.setOptions({ layout });             // v5
        } else {
            table.options = table.options || {};
            table.options.layout = layout;
        }
        table.redraw(true);
        console.debug("[Layout] set to:", layout);
        // log sizes after painting
        setTimeout(() => debugWidths(`setLayout:${layout}`, table), 0);
    } catch (e) {
        console.warn("[Layout] could not set layout:", e);
    }
}



// --- Toggle a class on #table to force natural width (and thus H-scroll in the holder)
function toggleHScroll(forceOn) {
    const el = document.getElementById("table");
    if (!el) return;
    if (forceOn) el.classList.add("force-hscroll");
    else el.classList.remove("force-hscroll");
}

// --- Debug current widths to see why scroll is/isn't appearing
function debugWidths(where, tableInstance) {
    const holder = document.querySelector("#table .tabulator-tableholder");
    const inner = document.querySelector("#table .tabulator-table");
    if (!holder || !inner) {
        console.debug(`[Widths:${where}] holder/inner not found`);
        return;
    }
    console.debug(
        `[Widths:${where}] layout=${tableInstance?.options?.layout} | ` +
        `holder: client=${holder.clientWidth}, scroll=${holder.scrollWidth} | ` +
        `inner: offset=${inner.offsetWidth}`
    );
}




/* === SECTION: COLUMN PICKER (Bootstrap modal) === */
let colModal = null;
function buildColumnPicker(table, columns, colPrefs) {
    const modalEl = document.getElementById("colPickerModal");
    const listEl = document.getElementById("colList");
    const searchEl = document.getElementById("colSearch");
    if (!modalEl) {
        console.warn("[Columns] modal element #colPickerModal not found.");
        return;
    }
    colModal = new bootstrap.Modal(modalEl);

    const rebuild = (filterText = "") => {
        listEl.innerHTML = "";
        columns.forEach(colDef => {
            const field = colDef.field;
            if (filterText && !field.toLowerCase().includes(filterText.toLowerCase())) return;

            const colObj = table.getColumn(field);
            const checked = colObj ? colObj.isVisible() : (colPrefs[field] !== false);

            // Bootstrap form-check row
            const row = document.createElement("div");
            row.className = "form-check";
            row.innerHTML = `
        <input class="form-check-input" type="checkbox" ${checked ? "checked" : ""} id="ck_${field}">
        <label class="form-check-label" for="ck_${field}">${field}</label>
      `;
            row.querySelector("input").addEventListener("change", (e) => {
                const on = e.target.checked;
                console.debug("[Columns] toggle", field, "→", on);
                if (on) { table.showColumn(field); colPrefs[field] = true; }
                else { table.hideColumn(field); colPrefs[field] = false; }
                saveColPrefs(colPrefs);

                // NEW: choose layout based on how many columns are now visible
                setLayoutForVisibleColumns(table);
            });
            listEl.appendChild(row);
        });
    };

    searchEl.oninput = () => rebuild(searchEl.value);

    document.getElementById("openColPicker").onclick = () => {
        console.debug("[Columns] open clicked; table ready?", !!table);
        if (!table) {
            showError("Columns panel unavailable: Tabulator did not load.");
            return;
        }
        // Rebuild from current columns
        const liveCols = table.getColumns().map(c => ({ field: c.getField() }));
        columns.length = 0;
        columns.push(...liveCols);
        rebuild("");
        searchEl.value = "";
        colModal.show();
    };
}

/* === SECTION: TABULATOR TABLE (init, sort newest first, full-height) === */
let table = null;
let allColumnKeys = [];

function setFullHeight() {
    // compute available height for the table inside the viewport
    const header = document.querySelector("h2");
    // pick the first flex toolbar on the page
    const toolbar = document.querySelector(".d-flex.flex-wrap, .toolbar");
    const topH = (header?.offsetHeight || 0) + (toolbar?.offsetHeight || 0) + 32; // + margins
    const h = Math.max(240, window.innerHeight - topH - 24);
    const tableDiv = document.getElementById("table");
    tableDiv.style.height = `${h}px`;
    if (table) table.redraw(true);
}

async function init() {
    const payload = await fetchData();

    // Counters
    const countEl = document.getElementById("count");
    const lastEl = document.getElementById("last");
    if (countEl) countEl.innerText = payload.total;
    if (lastEl) lastEl.innerText = payload.last_load_human || humanizeIso(payload.last_load_utc);

    // Wait for Tabulator script (CDN)
    const ok = await waitForTabulator(5000);
    if (!ok) {
        console.error("[init] Tabulator not available (CDN blocked or slow).");
        showError("Unable to load the table UI (Tabulator). Please allow access to the CDN or try again. " +
            "Tip: switch to jsDelivr in index.html if your network blocks unpkg.com.");
        return; // stop here instead of crashing
    }

    // From here Tabulator is defined
    allColumnKeys = payload.columns.slice();

    const ordered = orderColumns(allColumnKeys);
    const stored = loadColPrefs();
    const usePrefs = Object.keys(stored).length > 0
        ? stored
        : (() => { const m = {}; allColumnKeys.forEach(k => m[k] = DEFAULT_VISIBLE.has(k)); return m; })();

    // Create the table
    table = new Tabulator("#table", {
        data: payload.records,
        columns: makeColumns(ordered, usePrefs),
        layout: "fitColumns",          // default: no H-scroll
        height: "100%",
        resizableColumns: true,
        movableColumns: true,
        selectable: true,
        pagination: true,
        paginationSize: 15,
        paginationSizeSelector: [15, 25, 50, 100, 250, 300],
        initialSort: [{ column: "_blob_last_modified", dir: "desc" }],
        theme: "bootstrap5",
    });

    table = new Tabulator("#table", { /* ... */ });

    // initial: default view no H-scroll
    toggleHScroll(false);
    table.on("tableBuilt", () => {
        table.redraw(true);
        debugWidths("tableBuilt", table);
    });
    window.addEventListener("load", () => { if (table) { table.redraw(true); debugWidths("windowLoad", table); } });
    window.addEventListener("resize", () => { if (table) { table.redraw(true); debugWidths("resize", table); } });

    table.on("columnVisibilityChanged", () => setLayoutForVisibleColumns(table));

    buildColumnPicker(table, makeColumns(ordered, usePrefs), usePrefs);
    wireButtons();
}

/* === SECTION: BUTTONS: reload, downloads, filters, default/reset === */
function wireButtons() {
    const qf = document.getElementById("quickFilter");
    const clearBtn = document.getElementById("clearFilter");

    if (clearBtn) {
        clearBtn.onclick = () => { if (table) { qf.value = ""; table.clearFilter(true); } };
    }
    if (qf) {
        qf.addEventListener("input", (e) => {
            const val = e.target.value.toLowerCase();
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

    const btnCsv = document.getElementById("btnDownloadCsv");
    const btnJson = document.getElementById("btnDownloadJson");
    if (btnCsv) btnCsv.onclick = () => {
        if (!table) { showError("CSV download unavailable: Tabulator did not load."); return; }
        try { table.download("csv", "traffic_logs.csv"); }
        catch (e) { console.error(e); showError("CSV download failed. See console."); }
    };
    if (btnJson) btnJson.onclick = () => {
        if (!table) { showError("JSON download unavailable: Tabulator did not load."); return; }
        try { table.download("json", "traffic_logs.json"); }
        catch (e) { console.error(e); showError("JSON download failed. See console."); }
    };

    const btnDefault = document.getElementById("btnDefaultView");
    const btnReset = document.getElementById("btnAllColumns");
    if (btnDefault) btnDefault.onclick = () => {
        if (!table) { showError("Cannot apply default view: table not ready."); return; }
        applyDefaultView(table, allColumnKeys);
    };
    if (btnReset) btnReset.onclick = () => {
        if (!table) { showError("Cannot reset: table not ready."); return; }
        applyResetColumns(table, allColumnKeys);
    };

    const reloadBtn = document.getElementById("reloadBtn");
    if (reloadBtn) {
        reloadBtn.onclick = async () => {
            const btn = reloadBtn;
            btn.disabled = true; btn.textContent = "Reloading…";
            try {
                const r = await fetch("/reload", { method: "POST" });
                console.debug("[Reload] status:", r.status);
                location.reload();
            } catch (e) {
                console.error("[Reload] failed:", e);
                showError("Reload failed. Check console.");
            } finally {
                btn.disabled = false; btn.textContent = "Reload from Azure";
            }
        };
    }
}

// Boot
init();
