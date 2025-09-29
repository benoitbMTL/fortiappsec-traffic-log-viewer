// static/js/country-flags.js
/* ===========================================================
   Country → Flag helpers (Tabulator-agnostic)
   Exports on window.CountryFlags:
     - countryFlagFormatter(fieldName)
   Requires: flag-icons CSS
   =========================================================== */
(function () {
  const CDEBUG = "[CountryFlags]";
  function clog(...a){ try{ console.debug(CDEBUG, ...a);}catch{} }
  function cwarn(...a){ try{ console.warn(CDEBUG, ...a);}catch{} }
  function cerr(...a){ try{ console.error(CDEBUG, ...a);}catch{} }

  const COUNTRY_ALIASES = {
    "usa": "United States",
    "u.s.": "United States",
    "united states of america": "United States",
    "uk": "United Kingdom",
    "russian federation": "Russia",
    "korea, republic of": "South Korea",
    "republic of korea": "South Korea",
    "cote d'ivoire": "Côte d’Ivoire",
    "ivory coast": "Côte d’Ivoire",
    "palestine": "Palestine, State of",
    "macedonia": "North Macedonia",
  };

  const ALL_A2 = [
    "AD","AE","AF","AG","AI","AL","AM","AO","AQ","AR","AS","AT","AU","AW","AX","AZ",
    "BA","BB","BD","BE","BF","BG","BH","BI","BJ","BL","BM","BN","BO","BQ","BR","BS","BT","BV","BW","BY","BZ",
    "CA","CC","CD","CF","CG","CH","CI","CK","CL","CM","CN","CO","CR","CU","CV","CW","CX","CY","CZ",
    "DE","DJ","DK","DM","DO","DZ",
    "EC","EE","EG","EH","ER","ES","ET",
    "FI","FJ","FK","FM","FO","FR",
    "GA","GB","GD","GE","GF","GG","GH","GI","GL","GM","GN","GP","GQ","GR","GS","GT","GU","GW","GY",
    "HK","HM","HN","HR","HT","HU",
    "ID","IE","IL","IM","IN","IO","IQ","IR","IS","IT",
    "JE","JM","JO","JP",
    "KE","KG","KH","KI","KM","KN","KP","KR","KW","KY","KZ",
    "LA","LB","LC","LI","LK","LR","LS","LT","LU","LV","LY",
    "MA","MC","MD","ME","MF","MG","MH","MK","ML","MM","MN","MO","MP","MQ","MR","MS","MT","MU","MV","MW","MX","MY","MZ",
    "NA","NC","NE","NF","NG","NI","NL","NO","NP","NR","NU","NZ",
    "OM",
    "PA","PE","PF","PG","PH","PK","PL","PM","PN","PR","PS","PT","PW","PY",
    "QA",
    "RE","RO","RS","RU","RW",
    "SA","SB","SC","SD","SE","SG","SH","SI","SJ","SK","SL","SM","SN","SO","SR","SS","ST","SV","SX","SY","SZ",
    "TC","TD","TF","TG","TH","TJ","TK","TL","TM","TN","TO","TR","TT","TV","TW","TZ",
    "UA","UG","UM","US","UY","UZ",
    "VA","VC","VE","VG","VI","VN","VU",
    "WF","WS",
    "YE","YT",
    "ZA","ZM","ZW"
  ];

  let NAME_TO_A2 = {};
  (function buildReverseMap(){
    try {
      const dn = new Intl.DisplayNames(["en"], { type: "region" });
      for (const code of ALL_A2) {
        const name = dn.of(code);
        if (name) NAME_TO_A2[ normalizeName(name) ] = code;
      }
      clog("Reverse map built. Entries:", Object.keys(NAME_TO_A2).length);
    } catch (e) {
      cerr("Intl.DisplayNames not available; flags may not resolve automatically.", e);
      NAME_TO_A2 = {};
    }
  })();

  function normalizeName(s){
    return String(s || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/[.’]/g, "'");
  }

  function canonicalCountryName(input){
    const raw = String(input || "").trim();
    if (!raw) return "";
    const n = normalizeName(raw);
    if (COUNTRY_ALIASES[n]) {
      clog("Alias matched:", raw, "→", COUNTRY_ALIASES[n]);
      return COUNTRY_ALIASES[n];
    }
    return raw;
  }

  function countryNameToA2(name){
    if (!name) return null;
    let key = normalizeName(name);
    if (NAME_TO_A2[key]) return NAME_TO_A2[key];

    const canon = canonicalCountryName(name);
    key = normalizeName(canon);
    if (NAME_TO_A2[key]) return NAME_TO_A2[key];

    const stripped = canon.replace(/,?\s*(republic|state)\s+of\s+/ig, " ")
                          .replace(/the\s+/ig, "")
                          .trim();
    key = normalizeName(stripped);
    if (NAME_TO_A2[key]) {
      clog("Heuristic matched:", name, "→", stripped, "→", NAME_TO_A2[key]);
      return NAME_TO_A2[key];
    }

    cwarn("Could not resolve country to A2:", name);
    return null;
  }

  function escapeHtml(s){
    return String(s)
      .replace(/&/g,"&amp;")
      .replace(/</g,"&lt;")
      .replace(/>/g,"&gt;")
      .replace(/"/g,"&quot;")
      .replace(/'/g,"&#39;");
  }

  function renderFlagWithName(country){
    if (!country) return "";
    const a2 = countryNameToA2(country);
    if (!a2) {
      return `<span class="country-text">${escapeHtml(country)}</span>`;
    }
    const code = a2.toLowerCase();
    return `
      <span class="d-inline-flex align-items-center gap-1">
        <span class="fi fi-${code}" style="font-size:1em; line-height:1"></span>
        <span class="country-text">${escapeHtml(country)}</span>
      </span>
    `;
  }

  // Public: Tabulator formatter factory
  function countryFlagFormatter(fieldName){
    return function(cell){
      try{
        const v = cell.getValue();
        const row = cell.getRow()?.getData?.() || {};
        const other = (fieldName === "srccountry")
          ? row["original_srccountry"]
          : row["srccountry"];
        const country = v || other || "";
        const html = renderFlagWithName(country);
        clog("Render country cell:", { field: fieldName, in: v, fallback: other, out: country, a2: countryNameToA2(country) });
        return html;
      }catch(e){
        cerr("countryFlagFormatter error:", e);
        return cell.getValue() || "";
      }
    };
  }

  // Expose
  window.CountryFlags = {
    countryFlagFormatter,
  };
})();
