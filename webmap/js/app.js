/* DRC Ebola (Bundibugyo) web map -- one script for all three pages.
 *
 *   index.html    body.view-map     latest day, cumulative confirmed cases
 *   trends.html   body.view-trends  every day, time slider (+ recency colouring)
 *   trend21.html  body.view-trends  data-slider-step="21": one frame every 21 days
 *
 * Data (all static files, no build step in the browser):
 *   data/daily/manifest.csv + daily_<date>_<source>.csv   cases per health zone
 *   data/geo/*.geojson                                    zones, provinces, country, programme areas
 *   data/modals.json                                      text of the Methods / Terms pop-ups
 *
 * The latest manifest row is the "current" day: add a daily file + manifest row
 * (tools/build_daily_data.py) and the maps pick it up on the next load.
 * js/corridors.js adds towns / routes / epicentre once this script fires
 * "dashboard:ready" (window.dashboardMap is the Leaflet map).
 *
 * Needs http(s): browsers block fetch() from file:// (python3 -m http.server).
 */
(function () {
  "use strict";

  var B = document.body;
  var TRENDS = B.classList.contains("view-trends");
  var STEP = parseInt(B.dataset.sliderStep || "1", 10) || 1;
  var PLAY_MS = STEP > 1 ? 1800 : 350;          // ms per frame: 21-day page / daily page
  var NEAR = 14, MID = 42;                       // recency thresholds (days)
  var STROKE = "#54585a", STROKE_HOVER = "#231f20";
  var REC_FILL = { 1: "#b2182b", 2: "#ef8a62", 3: "#fddbc7", 4: "#e0e0e0" };
  var PROGRAMMES = {
    RESET: { color: "#81bc00" },
    IERDC: { color: "#00aed8" },
    SAFER: { color: "#231f20", dash: "6 4" }
  };
  var BOUNDS = [[-2.9, 18.5], [6.1, 33.7]];       // initial view [[south, west], [north, east]]
  var INSP_URL = "https://insp.cd/";
  // Case classes (min..max cumulative confirmed cases) and the "no cases reported" grey
  var CLASSES = [
    { min: 1,  max: 4,    color: "#FFD200", label: "1\u20134" },
    { min: 5,  max: 10,   color: "#F28D07", label: "5\u201310" },
    { min: 11, max: 21,   color: "#E4510B", label: "11\u201321" },
    { min: 22, max: 44,   color: "#D71E0C", label: "22\u201344" },
    { min: 45, max: null, color: "#C8102E", label: "45+" }
  ];
  var NULL_COLOR = "#E1E1E1";
  var LAYER_LABEL = "Confirmed cases", NO_CASES = "No cases reported", NO_DATA = "No data";
  var REC_LABEL = { 1: "Case in last 14 days", 2: "Case 15\u201342 days ago", 3: "No case for >42 days", 4: "No confirmed case" };
  var EN_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  var $ = function (id) { return document.getElementById(id); };

  var D = {};                  // loaded data: zones, provinces, country, programmes, modals
  var map, geoLayer, programmeLayer;
  var dates = [], cum = {}, recCat = {}, recDays = {};   // per-frame series
  var national = {};           // latest day topline {cases, deaths, recovered, date}
  var idx = 0, mode = "cumulative";
  var timer = null;

  // ---- helpers ------------------------------------------------------------
  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function fmtNum(v) { return (v == null ? 0 : v).toLocaleString("en-US"); }
  function fmtDate(iso) {                            // "2026-10-06" -> "6 Oct 2026"
    var p = String(iso).split("-");
    return parseInt(p[2], 10) + " " + EN_MONTHS[parseInt(p[1], 10) - 1] + " " + p[0];
  }
  function num(v) { if (v === undefined || v === null || v === "") return null; var n = Number(v); return isFinite(n) ? n : null; }

  function getJSON(url) {
    return fetch(url).then(function (r) { if (!r.ok) throw new Error(url + " -> HTTP " + r.status); return r.json(); });
  }
  function getText(url) {
    return fetch(url, { cache: "no-store" }).then(function (r) { if (!r.ok) throw new Error(url + " -> HTTP " + r.status); return r.text(); });
  }

  // Small CSV parser: quoted fields, CRLF, BOM. Returns an array of {header: value}.
  function parseCSV(text) {
    text = text.replace(/^﻿/, "");
    var rows = [], row = [], f = "", q = false, i, c;
    for (i = 0; i < text.length; i++) {
      c = text.charAt(i);
      if (q) {
        if (c === '"') { if (text.charAt(i + 1) === '"') { f += '"'; i++; } else q = false; } else f += c;
      } else if (c === '"') q = true;
      else if (c === ",") { row.push(f); f = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text.charAt(i + 1) === "\n") i++;
        row.push(f); f = "";
        if (row.length > 1 || row[0] !== "") rows.push(row);
        row = [];
      } else f += c;
    }
    if (f !== "" || row.length) { row.push(f); rows.push(row); }
    if (!rows.length) return [];
    var head = rows[0].map(function (h) { return h.trim(); });
    return rows.slice(1).map(function (r) {
      var o = {};
      head.forEach(function (h, k) { o[h] = r[k] === undefined ? "" : r[k].trim(); });
      return o;
    });
  }

  // ---- data ---------------------------------------------------------------
  // Manifest rows to show: just the latest day, or (trend pages) every day /
  // every STEP-th day counted from Day 0, always ending on the latest.
  function pickEntries(manifest) {
    var rows = manifest.filter(function (r) { return r.file && r.date; })
      .sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    if (!rows.length) throw new Error("manifest.csv has no usable rows");
    if (!TRENDS) return rows.slice(-1);
    if (STEP > 1) {
      var day0 = num(rows[0].day) || 0, last = rows.length - 1;
      rows = rows.filter(function (r, i) { return i === last || (num(r.day) - day0) % STEP === 0; });
    }
    return rows;
  }

  function loadFrames(entries) {
    return Promise.all(entries.map(function (e) { return getText("data/daily/" + e.file).then(parseCSV); }))
      .then(function (files) {
        var known = {};
        D.zones.features.forEach(function (f) { known[f.properties.nom] = true; });
        dates = entries.map(function (e) { return e.date; });
        cum = {};
        files.forEach(function (rows, i) {
          rows.forEach(function (r) {
            var c = num(r.cases);
            if (!r.zone || c === null || c <= 0) return;
            if (!known[r.zone]) { console.warn("zone not in geometry:", r.zone); return; }
            (cum[r.zone] = cum[r.zone] || new Array(dates.length).fill(0))[i] = c;
          });
        });

        // topline of the latest day (file first row, else manifest, else zone sum)
        var latest = entries[entries.length - 1], first = files[files.length - 1][0] || {};
        var zoneSum = Object.keys(cum).reduce(function (s, z) { return s + cum[z][dates.length - 1]; }, 0);
        var nc = num(first.national_cases); if (nc === null) nc = num(latest.national_cases);
        var nd = num(first.national_deaths); if (nd === null) nd = num(latest.national_deaths);
        national = { date: latest.date, cases: nc === null ? zoneSum : nc, deaths: nd, recovered: num(latest.national_recovered) };

        // Recency: days since a zone's cumulative count last rose (1 <= 14d, 2 <= 42d, 3 older).
        var DAY = 864e5;
        recCat = {}; recDays = {};
        Object.keys(cum).forEach(function (z) {
          var s = cum[z], last = null, cat = [], dd = [];
          for (var i = 0; i < s.length; i++) {
            if (s[i] > (i ? s[i - 1] : 0)) last = Date.parse(dates[i]);
            if (last === null) { cat.push(4); dd.push(-1); continue; }
            var n = Math.round((Date.parse(dates[i]) - last) / DAY);
            dd.push(n); cat.push(n <= NEAR ? 1 : (n <= MID ? 2 : 3));
          }
          recCat[z] = cat; recDays[z] = dd;
        });
        idx = dates.length - 1;
      });
  }

  function valueAt(nom, i) {
    var s = cum[nom];
    if (!s) return TRENDS ? 0 : null;       // map: unaffected = null ("no cases reported"), never 0
    return s[i];
  }
  function recAt(nom, i) { var s = recCat[nom]; return s ? s[i] : 4; }

  // ---- map ----------------------------------------------------------------
  function classColor(v) {
    var cl = CLASSES, k;
    if (v == null || v <= 0) return NULL_COLOR;
    for (k = 0; k < cl.length; k++) if (v >= cl[k].min && (cl[k].max == null || v <= cl[k].max)) return cl[k].color;
    return cl[cl.length - 1].color;
  }
  function zoneWeight(z) { return 1.7 * Math.max(0.6, Math.min(1.15, 0.6 + (z - 5) * 0.1)); }

  function zoneStyle(f) {
    var nom = f.properties.nom, s;
    if (mode === "recency") {
      var c = recAt(nom, idx);
      s = { fillColor: REC_FILL[c] || REC_FILL[4], fillOpacity: c === 4 ? 0.55 : 0.85 };
    } else {
      s = { fillColor: classColor(valueAt(nom, idx)), fillOpacity: 1 };
    }
    s.color = STROKE; s.opacity = 0.85; s.weight = zoneWeight(map.getZoom());
    return s;
  }

  function tooltipHtml(layer) {
    var p = layer.feature.properties, name = "<strong>" + esc(p.name || p.nom) + "</strong><br/>";
    if (mode === "recency") {
      var cat = recAt(p.nom, idx), days = recDays[p.nom] ? recDays[p.nom][idx] : -1;
      return name + REC_LABEL[cat] + "<br/>" +
        (cat === 4 || days < 0 ? "No confirmed case yet" : "Last confirmed case: " + days + " days ago");
    }
    var v = valueAt(p.nom, idx);
    return name + (v == null ? NO_DATA : LAYER_LABEL + ": " + fmtNum(v));
  }

  function pane(name, z) { map.createPane(name); map.getPane(name).style.zIndex = z; }

  function buildMap() {
    map = L.map("map", { zoomControl: false, zoomSnap: 0.25 });
    map.fitBounds(BOUNDS, { animate: false });
    window.dashboardMap = map;
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}", {
      attribution: "Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ", maxZoom: 16
    }).addTo(map);

    geoLayer = L.geoJSON(D.zones, {
      style: zoneStyle,
      onEachFeature: function (f, layer) {
        layer.bindTooltip(function () { return tooltipHtml(layer); }, { sticky: true, direction: "top" });
        layer.on("mouseover", function () {
          layer.setStyle({ color: STROKE_HOVER, opacity: 0.98, weight: zoneWeight(map.getZoom()) * 1.7 });
          layer.bringToFront();
        });
        layer.on("mouseout", function () { geoLayer.resetStyle(layer); });
      }
    }).addTo(map);
    map.on("zoomend", function () { geoLayer.setStyle(zoneStyle); });

    // province lines (trend pages only), country border, programme outlines (map page)
    if (TRENDS) {
      pane("province-outline", 550);
      L.geoJSON(D.provinces, { pane: "province-outline", interactive: false,
        style: { color: "#231f20", weight: 1.4, opacity: 0.88, fillOpacity: 0 } }).addTo(map);
    }
    pane("country-outline", 552);
    L.geoJSON(D.country, { pane: "country-outline", interactive: false,
      style: { color: "#231f20", weight: 2.2, opacity: 1, fillOpacity: 0 } }).addTo(map);

    if (!TRENDS) {
      pane("program-outline", 548);
      programmeLayer = L.geoJSON(D.programmes, { pane: "program-outline", interactive: false,
        style: function (f) {
          var s = PROGRAMMES[f.properties.program] || { color: "#231f20" };
          return { color: s.color, weight: 3, opacity: 1, fillOpacity: 0, dashArray: s.dash || null };
        } });
      var box = $("show-programmes");
      var apply = function () {
        var on = box.checked;
        if (on && !map.hasLayer(programmeLayer)) programmeLayer.addTo(map);
        if (!on && map.hasLayer(programmeLayer)) map.removeLayer(programmeLayer);
        $("legend-programs").style.display = on ? "" : "none";
      };
      box.addEventListener("change", apply);
      apply();
    }
  }

  // ---- text / legends -----------------------------------------------------
  function classRows() {
    return CLASSES.map(function (c) {
      return "<div class='legend-class-row'><span class='swatch' style='background:" + c.color + "'></span>" +
        "<span class='legend-class-label'>" + esc(c.label) + "</span></div>";
    }).join("");
  }
  function nullRow() {
    return "<div class='legend-class-row'><span class='swatch' style='background:" + NULL_COLOR + "'></span>" +
      "<span class='legend-class-label'>" + NO_CASES + "</span></div>";
  }

  function renderLegends() {
    if (!TRENDS) {
      $("legend-title").innerHTML = "<strong>" + LAYER_LABEL + "</strong>";
      $("legend-classes").innerHTML = classRows() + nullRow();
      var present = {};
      D.programmes.features.forEach(function (f) { present[f.properties.program] = true; });
      $("legend-programs").innerHTML = Object.keys(PROGRAMMES).filter(function (k) { return present[k]; }).map(function (k) {
        return "<div class='legend-class-row'><span class='swatch program-swatch' style='border:3px solid " + PROGRAMMES[k].color +
          ";background:transparent'></span><span class='legend-class-label'>" + k + " programme area</span></div>";
      }).join("");
    } else {
      $("trends-class-legend").innerHTML = classRows() + nullRow();
      $("recency-swatches").innerHTML = [1, 2, 3, 4].map(function (c) {
        return "<div class='recency-swatch'><span class='recency-chip' style='background:" + REC_FILL[c] + "'></span><span>" +
          REC_LABEL[c] + "</span></div>";
      }).join("");
    }
  }

  function renderHeader() {
    var asof = fmtDate(national.date);
    var sitrep = "Latest <a href='" + INSP_URL + "' target='_blank' rel='noopener' style='color:#9fcdfb;text-decoration:underline'>" +
      "INSP Sit Rep</a> - " + asof;
    $("title-sub").innerHTML = sitrep;
    $("header-info-popup-body").innerHTML = sitrep;
    $("tracker").innerHTML =
      "<div class='stats-block'><div class='global-title'>confirmed \u00b7 cumulative to " + asof + "</div>" +
      "<div class='global-row'>" +
      ["cases", "deaths", "recovered"].map(function (k) {
        return "<div class='global-cell " + k + "'><div class='num'>" + fmtNum(national[k]) + "</div><div class='sub'>" + k + "</div></div>";
      }).join("") + "</div></div>";
  }

  // ---- trend slider -------------------------------------------------------
  function updateDateLabel() {
    $("trends-date-label").textContent = "As of " + fmtDate(dates[idx]);
  }
  function syncPlayButton() {
    var b = $("trends-play-btn");
    b.textContent = timer ? "⏸" : "▶";
    b.setAttribute("aria-label", timer ? "Pause" : "Play");
  }
  function setIdx(i) {
    idx = Math.max(0, Math.min(i, dates.length - 1));
    $("trends-date-slider").value = idx;
    document.querySelectorAll(".trends-tick").forEach(function (b) {
      b.classList.toggle("active", parseInt(b.dataset.idx, 10) === idx);
    });
    updateDateLabel();
    geoLayer.setStyle(zoneStyle);
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    B.classList.remove("trends-slider-busy");
    syncPlayButton();
  }
  function play() {
    stop();
    if (dates.length < 2) return;
    B.classList.add("trends-slider-busy");
    setIdx(0);
    timer = setInterval(function () {
      if (idx >= dates.length - 1) return stop();
      setIdx(idx + 1);
      if (idx >= dates.length - 1) stop();
    }, PLAY_MS);
    syncPlayButton();
  }

  // Ticks: few frames -> one labelled tick each; many -> a faint tick every
  // Monday and a labelled tick at the first date of each month. Click = jump.
  function buildTicks() {
    var wrap = $("trends-ticks"), n = dates.length, sparse = n <= 12, lastMonth = null;
    var gap = parseFloat(getComputedStyle($("trends-play-row")).columnGap) || 8;
    $("trends-ticks-spacer").style.width = ($("trends-play-btn").offsetWidth + gap) + "px";
    wrap.innerHTML = "";
    dates.forEach(function (iso, i) {
      var dt = new Date(iso + "T00:00:00Z"), month = dt.getUTCMonth(), major = sparse || month !== lastMonth;
      lastMonth = month;
      if (!major && dt.getUTCDay() !== 1) return;
      var b = document.createElement("button");
      b.type = "button";
      b.className = "trends-tick" + (major ? " major" : "");
      b.style.left = (n > 1 ? (i / (n - 1)) * 100 : 0) + "%";
      b.dataset.idx = i;
      b.title = iso; b.setAttribute("aria-label", iso);
      if (major) {
        var lab = document.createElement("span");
        lab.className = "trends-tick-label";
        lab.textContent = dt.toLocaleDateString("en", sparse ? { day: "numeric", month: "short", timeZone: "UTC" } : { month: "short", timeZone: "UTC" });
        b.appendChild(lab);
      }
      wrap.appendChild(b);
    });
  }

  function wireTrends() {
    var slider = $("trends-date-slider");
    slider.max = dates.length - 1;
    buildTicks();
    slider.addEventListener("input", function () { stop(); setIdx(parseInt(slider.value, 10) || 0); });
    $("trends-play-btn").addEventListener("click", function () { if (timer) stop(); else play(); });
    $("trends-ticks").addEventListener("click", function (ev) {
      var b = ev.target.closest(".trends-tick");
      if (b) { stop(); setIdx(parseInt(b.dataset.idx, 10) || 0); }
    });
    document.querySelectorAll(".trends-mode-btn").forEach(function (b) {
      b.addEventListener("click", function () {
        mode = b.dataset.mode;
        document.querySelectorAll(".trends-mode-btn").forEach(function (x) { x.classList.toggle("active", x === b); });
        $("trends-cumulative-legend").style.display = mode === "recency" ? "none" : "";
        $("trends-recency-legend").style.display = mode === "recency" ? "" : "none";
        geoLayer.setStyle(zoneStyle);
      });
    });
  }

  // ---- page chrome --------------------------------------------------------
  function wireChrome() {
    // modals
    function modal(id, openers, closeId) {
      var m = $(id);
      var open = function () { m.classList.add("open"); }, close = function () { m.classList.remove("open"); };
      openers.forEach(function (o) { $(o).addEventListener("click", open); });
      $(closeId).addEventListener("click", close);
      m.addEventListener("click", function (ev) { if (ev.target === m) close(); });
      document.addEventListener("keydown", function (ev) { if (ev.key === "Escape") close(); });
    }
    modal("methods-modal", ["methods-btn", "header-methods-btn"], "methods-close");
    modal("terms-modal", ["terms-btn", "header-terms-btn"], "terms-close");
    // narrow-screen info popup
    var row = $("header-narrow-row"), ib = $("header-info-btn");
    ib.addEventListener("click", function () {
      var open = row.classList.toggle("open");
      ib.setAttribute("aria-expanded", open);
    });
    // collapsible legend card(s); start collapsed on phones
    document.querySelectorAll(".panel-toggle").forEach(function (btn) {
      var panel = $(btn.dataset.target);
      var set = function (c) { panel.classList.toggle("collapsed", c); btn.textContent = c ? "+" : "−"; };
      btn.addEventListener("click", function () { set(!panel.classList.contains("collapsed")); });
      if (window.matchMedia && window.matchMedia("(max-width: 700px)").matches) set(true);
    });
  }

  // ---- start --------------------------------------------------------------
  function fail(err) {
    console.error(err);
    var el = $("map");
    el.innerHTML = "<div class='load-error'>Could not load the map data (" + esc(err.message) +
      ").<br>Serve this folder over HTTP, e.g. <code>python3 -m http.server</code>, then open <code>http://localhost:8000</code>.</div>";
  }

  Promise.all([
    getJSON("data/geo/zones.geojson"), getJSON("data/geo/provinces.geojson"), getJSON("data/geo/country.geojson"),
    getJSON("data/geo/programmes.geojson"), getJSON("data/modals.json"),
    getText("data/daily/manifest.csv").then(parseCSV)
  ]).then(function (r) {
    D = { zones: r[0], provinces: r[1], country: r[2], programmes: r[3], modals: r[4] };
    return loadFrames(pickEntries(r[5]));
  }).then(function () {
    buildMap();
    wireChrome();
    if (TRENDS) wireTrends();
    $("methods-content").innerHTML = D.modals.methods;
    $("terms-content").innerHTML = D.modals.terms;
    $("terms-updated").textContent = D.modals.terms_updated;
    renderHeader();
    renderLegends();
    if (TRENDS) updateDateLabel();
    document.dispatchEvent(new Event("dashboard:ready"));
    if (TRENDS) play();                       // start from the first frame every time the page opens
  }).catch(fail);
})();
