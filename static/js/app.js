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
    "_blob_last_modified",
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
    "_blob_last_modified",
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



function makeColumns(keys, colPrefs) {
    return keys.map(k => ({
        title: k,
        field: k,
        headerFilter: "input",
        resizable: true,
        visible: colPrefs[k] !== false,
        widthGrow: 1,

        // NEW: show an “×” to hide the column
        titleFormatter: colTitleWithClose,
    }));
}



function applyDefaultView(table, allKeys) {
    console.debug("[DefaultView] applying");
    const prefs = {};
    allKeys.forEach(k => prefs[k] = DEFAULT_VISIBLE.has(k));
    saveColPrefs(prefs);
    const ordered = orderColumns(allKeys);
    table.setColumns(makeColumns(ordered, prefs));
    table.setOptions({ layout: "fitColumns" });  // keep no H-scroll
    table.redraw(true);
}




function applyResetColumns(table, allKeys) {
    console.debug("[ResetColumns] applying");
    clearColPrefs();
    const prefs = {};
    const ordered = orderColumns(allKeys);
    table.setColumns(makeColumns(ordered, prefs));

    table.setOptions({ layout: "fitData" });     // allow natural width -> H-scroll appears
    table.redraw(true);
}



// === helper: choose layout based on visible columns
function setLayoutForVisibleColumns(table) {
    try {
        const visibleCols = table.getColumns().filter(c => c.isVisible());
        // heuristic: if more columns than your default set, allow overflow (H-scroll)
        const needOverflow = visibleCols.length > DEFAULT_VISIBLE.size;
        table.setOptions({ layout: needOverflow ? "fitData" : "fitColumns" });
        table.redraw(true);
        console.debug("[Layout]", needOverflow ? "fitData (H-scroll enabled)" : "fitColumns (no H-scroll)", "visible:", visibleCols.length);
    } catch (e) {
        console.warn("[Layout] cannot compute visible columns:", e);
    }
}


function makeColumns(keys, colPrefs) {
    return keys.map(k => ({
        title: k,
        field: k,
        headerFilter: "input",
        resizable: true,
        visible: colPrefs[k] !== false,
        minWidth: 130,                // NEW: avoids micro-shrinking; helps trigger H-scroll
        widthGrow: 1,
        titleFormatter: colTitleWithClose,
    }));
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

    // counters
    const countEl = document.getElementById("count");
    const lastEl = document.getElementById("last");
    if (countEl) countEl.innerText = payload.total;
    if (lastEl) lastEl.innerText = payload.last_load_human || humanizeIso(payload.last_load_utc);

    allColumnKeys = payload.columns.slice();

    const ordered = orderColumns(allColumnKeys);
    const stored = loadColPrefs();
    const usePrefs = Object.keys(stored).length > 0 ? stored : (() => {
        const m = {}; allColumnKeys.forEach(k => m[k] = DEFAULT_VISIBLE.has(k)); return m;
    })();



    table = new Tabulator("#table", {
        data: payload.records,
        columns: makeColumns(ordered, usePrefs),
        layout: "fitColumns",     // default: clean, no H-scroll
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


    // One guaranteed layout pass after everything is painted
    table.on("tableBuilt", () => table.redraw(true));
    window.addEventListener("load", () => { if (table) table.redraw(true); });

    // Adjust height on window resize
    window.addEventListener("resize", () => { if (table) table.redraw(true); });



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
