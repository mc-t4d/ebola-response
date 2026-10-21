/* DRC Ebola (Bundibugyo) web map -- one script for all three pages.
 *
 *   index.html    body.view-map     latest day, cumulative confirmed cases
 *   trends.html   body.view-trends  every day, time slider (+ recency colouring)
 *   weekly.html   body.view-trends.view-weekly  new cases per completed Mon-Sun week
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
  var WEEKLYPAGE = B.classList.contains("view-weekly");   // weekly new-case growth page
  var STEP = parseInt(B.dataset.sliderStep || "1", 10) || 1;
  var PLAY_MS = STEP > 1 ? 1800 : 250;           // ms per frame: 21-day page / daily page
  var WEEKLY_MS = 800;                           // ms per frame in the Daily Trend page's Weekly mode
  var WEEKPAGE_MS = 1500;                        // ms per frame on the Weekly Case Growth page
  var NEAR = 14, MID = 42;                       // recency thresholds (days)
  var STROKE = "#54585a", STROKE_HOVER = "#231f20";
  var REC_FILL = { 1: "#b2182b", 2: "#ef8a62", 3: "#fddbc7", 4: "#e0e0e0" };
  var PROGRAMMES = {
    RESET: { color: "#81bc00" },
    IERDC: { color: "#00aed8" }                  // includes the former SAFER zone
  };
  // DRC provinces whose health zones (admin 2) are drawn; the other provinces are plain grey.
  var PROVINCES_SHOWN = ["Haut-Uele", "Ituri", "Sud-Kivu", "Nord-Kivu", "Tshopo", "Bas-Uele", "Sud-Ubangi"];
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
  var EXIST_COLOR = "#DCE6EC";                   // weekly page: zone has had cases, none this week
  var EXIST_LABEL = "Zone with existing case but no new case this week";
  var LAYER_LABEL = "Confirmed cases", NO_CASES = "No cases reported", NO_DATA = "No data";
  var REC_LABEL = { 1: "Case in last 14 days", 2: "Case 15\u201342 days ago", 3: "No case for >42 days", 4: "No confirmed case" };
  var EN_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var EN_MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  var $ = function (id) { return document.getElementById(id); };

  var D = {};                  // loaded data: zones, provinces, country, programmes, modals
  var map, geoLayer, programmeLayer;
  var dates = [], cum = {}, recCat = {}, recDays = {};   // per-frame series
  var dayNums = [], natC = [], natD = [], zoneCount = [], firstSeen = {};   // national totals, affected-zone count, first frame each zone appears (incl. zones without a polygon)
  var national = {};           // latest day topline {cases, deaths, recovered, date}
  var idx = 0, mode = "cumulative";
  var timer = null, manifestRows = null, fullHistory = false;

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
  function pickEntries(manifest, all) {
    var rows = manifest.filter(function (r) { return r.file && r.date; })
      .sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    if (!rows.length) throw new Error("manifest.csv has no usable rows");
    if (!TRENDS && !all) {          // latest day, plus 1 and 7 days earlier for the "as of" card's changes
      var n = rows.length, pick = [rows[Math.max(0, n - 8)], rows[Math.max(0, n - 2)], rows[n - 1]];
      return pick.filter(function (r, i) { return pick.indexOf(r) === i; });
    }
    if (WEEKLYPAGE) {       // one frame per Sunday = end of each completed Monday-Sunday week
      return rows.filter(function (r) { return new Date(r.date + "T00:00:00Z").getUTCDay() === 0; });
    }
    if (STEP > 1) {
      var day0 = num(rows[0].day) || 0, last = rows.length - 1;
      rows = rows.filter(function (r, i) { return i === last || (num(r.day) - day0) % STEP === 0; });
    }
    return rows;
  }

  function loadFrames(entries) {
    return Promise.all(entries.map(function (e) { return getText("data/daily/" + e.file).then(parseCSV); }))
      .then(function (files) {
        var known = {}, undrawn = 0;
        D.zones.features.forEach(function (f) { known[f.properties.nom] = true; });
        dates = entries.map(function (e) { return e.date; });
        dayNums = entries.map(function (e) { return num(e.day); });     // outbreak day number of each frame (Day 0 = 14 May)
        cum = {}; natC = []; natD = []; zoneCount = []; firstSeen = {};
        files.forEach(function (rows, i) {
          var first0 = rows[0] || {}, e = entries[i], zc = 0;
          var nc0 = num(first0.national_cases); if (nc0 === null) nc0 = num(e.national_cases);
          var nd0 = num(first0.national_deaths); if (nd0 === null) nd0 = num(e.national_deaths);
          natC.push(nc0 === null && i ? natC[i - 1] : nc0);              // days without an official figure repeat the last one
          natD.push(nd0 === null && i ? natD[i - 1] : nd0);
          rows.forEach(function (r) {
            var c = num(r.cases);
            if (!r.zone || c === null || c <= 0) return;
            zc++;
            if (firstSeen[r.zone] === undefined) firstSeen[r.zone] = i;
            if (!known[r.zone]) { if (i === files.length - 1) undrawn += c; return; }       // reported zone without a polygon (e.g. Dakwa): not drawn, still in the totals
            (cum[r.zone] = cum[r.zone] || new Array(dates.length).fill(0))[i] = c;
          });
          zoneCount.push(zc);
        });

        // topline of the latest day (file first row, else manifest, else zone sum)
        var latest = entries[entries.length - 1], first = files[files.length - 1][0] || {};
        var zoneSum = Object.keys(cum).reduce(function (s, z) { return s + cum[z][dates.length - 1]; }, undrawn);
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
    if (WEEKLYPAGE) {                       // new cases in the week ending at frame i; null = never had a case
      if (!s || s[i] <= 0) return null;
      return Math.max(0, s[i] - (i ? s[i - 1] : 0));
    }
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
    } else if (WEEKLYPAGE) {
      var w = valueAt(nom, idx);
      s = w == null ? { fillColor: NULL_COLOR, fillOpacity: 0 }
        : { fillColor: w > 0 ? classColor(w) : EXIST_COLOR, fillOpacity: 1 };
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
    if (WEEKLYPAGE) {
      return name + (v == null ? NO_CASES : "New cases this week: " + fmtNum(v) + "<br/>Cumulative: " + fmtNum(cum[p.nom][idx]));
    }
    return name + (v == null ? NO_DATA : LAYER_LABEL + ": " + fmtNum(v));
  }

  // Zone name labels (not on the 21-Day page): shown for health zones with reported cases at the current frame.
  var labelGroup, labelMarkers = {};
  function ringCentroid(ring) {                       // [area, [lng, lat]] of a polygon ring
    var a = 0, cx = 0, cy = 0, i, p, q, f;
    for (i = 0; i < ring.length - 1; i++) {
      p = ring[i]; q = ring[i + 1]; f = p[0] * q[1] - q[0] * p[1];
      a += f; cx += (p[0] + q[0]) * f; cy += (p[1] + q[1]) * f;
    }
    return a ? [Math.abs(a) / 2, [cx / (3 * a), cy / (3 * a)]] : [0, ring[0]];
  }
  function labelPoint(geom) {                         // centroid of the largest polygon
    var polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates, best = null;
    polys.forEach(function (poly) { var c = ringCentroid(poly[0]); if (!best || c[0] > best[0]) best = c; });
    return [best[1][1], best[1][0]];
  }
  function buildZoneLabels() {
    pane("zone-labels", 600);
    labelGroup = L.layerGroup().addTo(map);
    D.zones.features.forEach(function (f) {
      labelMarkers[f.properties.nom] = L.marker(labelPoint(f.geometry), { pane: "zone-labels", interactive: false, keyboard: false,
        icon: L.divIcon({ className: "zone-label", html: "<span>" + esc(f.properties.name || f.properties.nom) + "</span>", iconSize: [0, 0] }) });
    });
  }
  function updateZoneLabels() {
    if (!labelGroup) return;
    Object.keys(labelMarkers).forEach(function (nom) {
      var s = cum[nom], on = !!s && s[idx] > 0, m = labelMarkers[nom];
      if (on && !labelGroup.hasLayer(m)) labelGroup.addLayer(m);
      if (!on && labelGroup.hasLayer(m)) labelGroup.removeLayer(m);
    });
  }

  function pane(name, z) { map.createPane(name); map.getPane(name).style.zIndex = z; }

  function buildMap() {
    map = L.map("map", { zoomControl: false, zoomSnap: 0.25 });
    map.fitBounds(BOUNDS, { animate: false });
    window.dashboardMap = map;
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}", {
      attribution: "Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ", maxZoom: 16
    }).addTo(map);

    // other provinces: flat grey, no internal lines (below the zones)
    pane("other-provinces", 390);
    L.geoJSON(D.provinces, { pane: "other-provinces", interactive: false,
      filter: function (f) { return PROVINCES_SHOWN.indexOf(f.properties.province) < 0; },
      style: { stroke: false, fillColor: "#d6d6d6", fillOpacity: 1 } }).addTo(map);

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
    if (STEP === 1) { buildZoneLabels(); updateZoneLabels(); }

    // province lines (trend pages only), country border, programme outlines (checkbox on every page)
    if (TRENDS) {
      pane("province-outline", 550);
      L.geoJSON(D.provinces, { pane: "province-outline", interactive: false,
        filter: function (f) { return PROVINCES_SHOWN.indexOf(f.properties.province) >= 0; },
        style: { color: "#231f20", weight: 1.4, opacity: 0.88, fillOpacity: 0 } }).addTo(map);
    }
    pane("country-outline", 552);
    L.geoJSON(D.country, { pane: "country-outline", interactive: false,
      style: { color: "#231f20", weight: 2.2, opacity: 1, fillOpacity: 0 } }).addTo(map);

    if ($("show-programmes")) {              // every page: programme outlines, on by default only on Current Cumulative
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

  function recencyRows() {
    return [1, 2, 3, 4].map(function (c) {
      return "<div class='recency-swatch'><span class='recency-chip' style='background:" + REC_FILL[c] + "'></span><span>" +
        REC_LABEL[c] + "</span></div>";
    }).join("");
  }

  function renderLegends() {
    var present = {};
    D.programmes.features.forEach(function (f) { present[f.properties.program] = true; });
    $("legend-programs").innerHTML = Object.keys(PROGRAMMES).filter(function (k) { return present[k]; }).map(function (k) {
      return "<div class='legend-class-row'><span class='swatch program-swatch' style='border:3px solid " + PROGRAMMES[k].color +
        ";background:transparent'></span><span class='legend-class-label'>" + k + " program health zones</span></div>";
    }).join("");
    if (!TRENDS) {
      $("legend-title").innerHTML = "<strong>" + LAYER_LABEL + "</strong>";
      $("legend-classes").innerHTML = classRows() + nullRow();
      $("recency-swatches").innerHTML = recencyRows();
    } else if (WEEKLYPAGE) {
      $("trends-class-legend").innerHTML =
        "<div class='legend-class-row exist-row'><span class='swatch' style='background:" + EXIST_COLOR + "'></span>" +
        "<span class='legend-class-label'>" + EXIST_LABEL + "</span></div>" + classRows();
    } else {
      $("trends-class-legend").innerHTML = classRows() + nullRow();
      $("recency-swatches").innerHTML = recencyRows();
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

  // ---- "as of" dynamics card (Daily Trend) ---------------------------------
  function signed(n) { return (n >= 0 ? "+" : "\u2212") + fmtNum(Math.abs(n)); }
  function longDate(iso) {                           // "2026-10-04" -> {d: 4, m: "October"}
    var p = iso.split("-");
    return parseInt(p[2], 10) + " " + EN_MONTHS_LONG[parseInt(p[1], 10) - 1];
  }
  // Weekly page: title card for the week ending on the current frame (a Sunday)
  function renderWeekTitle() {
    var el = $("week-title");
    var end = dates[idx], start = new Date(Date.parse(end) - 6 * 864e5).toISOString().slice(0, 10);
    var dc = natC[idx] - (idx ? natC[idx - 1] : 0), dd = natD[idx] - (idx ? natD[idx - 1] : 0);
    el.innerHTML = "<div class='dyn-title'>Weekly New Case Growth</div><div><i>" + longDate(start) + " to " + longDate(end) + "</i></div>" +
      "<div><b>" + fmtNum(natC[idx]) + "</b> <i>total cases,</i> <b>" + signed(dc) + "</b> <i>new confirmed cases,</i> <b>" + signed(dd) + "</b> <i>new deaths</i></div>";
  }
  function renderDynamics() {
    if (WEEKLYPAGE) return renderWeekTitle();
    var el = $("dynamics");
    if (!el) return;
    if (STEP > 1) {                                   // 21-Day page: day number, totals, affected zones
      var zn = zoneCount[idx] || 0;
      el.innerHTML = "<div class='dyn-title'>Day " + (dayNums[idx] === null ? "" : dayNums[idx]) + "</div>" +
        "<div><b>" + fmtNum(natC[idx]) + "</b> <i>total cases,</i> <b>" + fmtNum(natD[idx]) + "</b> <i>deaths</i></div>" +
        "<div><b>" + fmtNum(zn) + "</b> <i>affected health zone" + (zn === 1 ? "" : "s") + "</i></div>";
      return;
    }
    var at = function (arr, i) { return i < 0 ? 0 : (arr[i] == null ? 0 : arr[i]); };   // before Day 0 everything is 0
    // frame index of the date n days before the current one (-1 = before the first day)
    var back = function (n) {
      var t = new Date(Date.parse(dates[idx]) - n * 864e5).toISOString().slice(0, 10);
      return dates.indexOf(t);
    };
    var dayI = back(1), weekI = back(7);
    var line = function (arr, noun) {
      var v = at(arr, idx);
      return "<div><b>" + fmtNum(v) + "</b> <i>" + noun + ",</i> <b>" + signed(v - at(arr, dayI)) +
        "</b> <i>over the last day,</i> <b>" + signed(v - at(arr, weekI)) + "</b> <i>over the last week</i></div>";
    };
    var nz = Object.keys(firstSeen).filter(function (z) { return firstSeen[z] > weekI && firstSeen[z] <= idx; })
      .sort(function (a, b) { return firstSeen[a] - firstSeen[b] || (a < b ? -1 : 1); })
      .map(function (z) { var f = D.zones.features.filter(function (x) { return x.properties.nom === z; })[0]; return f ? f.properties.name : z; });
    var d = new Date(dates[idx] + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
    el.innerHTML = "<div class='dyn-title'>As of " + d + (weekly && dayNums[idx] !== null ? " (Week " + Math.floor(dayNums[idx] / 7) + ")" : "") + "</div>" +
      line(natC, "total cases") + line(natD, "total deaths") + line(zoneCount, "affected health zone" + (at(zoneCount, idx) === 1 ? "" : "s")) +
      "<div><i>New health zones: " + (nz.length ? esc(nz.join(", ")) : "none this period") + "</i></div>";
  }

  // ---- trend slider -------------------------------------------------------
  // `shown` = the day indices the slider steps through: every day, or (Daily Trend's
  // Weekly toggle) every 7th day from Day 0 plus the latest day. All days stay loaded,
  // so the "as of" card can still compare against 1 and 7 days earlier.
  var shown = [], weekly = !!document.querySelector(".step-btn.active[data-step='7']");   // trends.html ships with Weekly active
  function buildShown() {
    var n = dates.length;
    shown = [];
    for (var i = 0; i < n; i++) {
      if (!weekly || (dayNums[i] - dayNums[0]) % 7 === 0 || i === n - 1) shown.push(i);
    }
  }
  function syncPlayButton() {
    var b = $("trends-play-btn");
    b.textContent = timer ? "⏸" : "▶";
    b.setAttribute("aria-label", timer ? "Pause" : "Play");
  }
  function setIdx(i) {
    idx = Math.max(0, Math.min(i, dates.length - 1));
    $("trends-date-slider").value = Math.max(0, shown.indexOf(idx));
    document.querySelectorAll(".trends-tick").forEach(function (b) {
      b.classList.toggle("active", parseInt(b.dataset.idx, 10) === idx);
    });
    renderDynamics();
    geoLayer.setStyle(zoneStyle);
    updateZoneLabels();
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    B.classList.remove("trends-slider-busy");
    syncPlayButton();
  }
  function play() {
    stop();
    if (shown.length < 2) return;
    B.classList.add("trends-slider-busy");
    setIdx(shown[0]);
    timer = setInterval(function () {
      var p = shown.indexOf(idx);
      if (p >= shown.length - 1) return stop();
      setIdx(shown[p + 1]);
      if (p + 1 >= shown.length - 1) stop();
    }, WEEKLYPAGE ? WEEKPAGE_MS : (weekly ? WEEKLY_MS : PLAY_MS));
    syncPlayButton();
  }

  // Ticks. Few frames (21-Day page): every tick labelled "date (Day N)". Weekly: a tick per
  // week, every 4th labelled. Daily: a faint tick every Monday and a labelled tick at the first
  // date of each month. Click = jump.
  function buildTicks() {
    var wrap = $("trends-ticks"), n = shown.length, framed = n <= 12 || weekly || WEEKLYPAGE, lastMonth = null;
    var gap = parseFloat(getComputedStyle($("trends-play-row")).columnGap) || 8;
    $("trends-ticks-spacer").style.width = ($("trends-play-btn").offsetWidth + gap) + "px";
    wrap.innerHTML = "";
    shown.forEach(function (di, p) {
      var iso = dates[di], dt = new Date(iso + "T00:00:00Z"), month = dt.getUTCMonth(), major;
      if (framed) major = n <= 12 || (p % 4 === 0 && n - 1 - p >= 2) || p === n - 1;
      else major = month !== lastMonth;
      lastMonth = month;
      if (!framed && !major && dt.getUTCDay() !== 1) return;
      var b = document.createElement("button");
      b.type = "button";
      b.className = "trends-tick" + (major || framed ? " major" : "");
      b.style.left = (n > 1 ? (p / (n - 1)) * 100 : 0) + "%";
      b.dataset.idx = di;
      b.title = iso; b.setAttribute("aria-label", iso);
      if (major) {
        var lab = document.createElement("span");
        lab.className = "trends-tick-label";
        lab.textContent = dt.toLocaleDateString("en", framed ? { day: "numeric", month: "short", timeZone: "UTC" } : { month: "short", timeZone: "UTC" });
        if (framed && dayNums[di] !== null) {
          var dn = document.createElement("span");
          dn.className = "trends-tick-day";
          dn.textContent = weekly || WEEKLYPAGE ? "(W" + Math.floor(dayNums[di] / 7) + ")" : "(Day " + dayNums[di] + ")";
          lab.appendChild(dn);
        }
        b.appendChild(lab);
      }
      wrap.appendChild(b);
    });
  }

  function wireTrends() {
    var slider = $("trends-date-slider");
    buildShown();
    slider.max = shown.length - 1;
    buildTicks();
    slider.addEventListener("input", function () { stop(); setIdx(shown[parseInt(slider.value, 10) || 0]); });
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
    // Daily | Weekly slider step (Daily Trend page only)
    document.querySelectorAll(".step-btn").forEach(function (b) {
      b.addEventListener("click", function () {
        var w = b.dataset.step === "7";
        if (w === weekly) return;
        stop();
        weekly = w;
        document.querySelectorAll(".step-btn").forEach(function (x) { x.classList.toggle("active", x === b); });
        buildShown();
        var snap = shown.filter(function (d) { return d <= idx; }).pop();     // stay on (or just before) the current date
        slider.max = shown.length - 1;
        buildTicks();
        setIdx(snap === undefined ? shown[0] : snap);
      });
    });
  }

  // Current Cumulative page: Cumulative | Recency toggle. Recency needs every day's file,
  // so the full history is fetched the first time it is chosen.
  function wireMapMode() {
    var btns = document.querySelectorAll(".trends-mode-btn");
    var apply = function (m) {
      mode = m;
      btns.forEach(function (x) { x.classList.toggle("active", x.dataset.mode === m); });
      $("legend-classes").style.display = m === "recency" ? "none" : "";
      $("recency-swatches").style.display = m === "recency" ? "" : "none";
      $("legend-title").innerHTML = "<strong>" + (m === "recency" ? "Confirmed cases by recency" : LAYER_LABEL) + "</strong>";
      geoLayer.setStyle(zoneStyle);
    };
    btns.forEach(function (b) {
      b.addEventListener("click", function () {
        var m = b.dataset.mode;
        if (m === mode) return;
        if (m === "cumulative" || fullHistory) return apply(m);
        var label = b.textContent;
        b.textContent = "Loading\u2026";
        loadFrames(pickEntries(manifestRows, true)).then(function () {
          fullHistory = true;
          b.textContent = label;
          updateZoneLabels(); renderDynamics();
          apply(m);
        }).catch(function (err) { console.error(err); b.textContent = label; });
      });
    });
  }

  // ---- page chrome --------------------------------------------------------
  function wireChrome() {
    // modals
    function modal(id, openers, closeId) {
      var m = $(id);
      var open = function () { m.classList.add("open"); }, close = function () { m.classList.remove("open"); };
      openers.forEach(function (o) { if ($(o)) $(o).addEventListener("click", open); });
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
    D.zones = { type: "FeatureCollection", features: D.zones.features.filter(function (f) { return PROVINCES_SHOWN.indexOf(f.properties.province) >= 0; }) };
    manifestRows = r[5];
    return loadFrames(pickEntries(manifestRows));
  }).then(function () {
    buildMap();
    wireChrome();
    if (TRENDS) wireTrends(); else wireMapMode();
    $("methods-content").innerHTML = D.modals.methods;
    $("terms-content").innerHTML = D.modals.terms;
    $("terms-updated").textContent = D.modals.terms_updated;
    renderHeader();
    renderLegends();
    renderDynamics();
    document.dispatchEvent(new Event("dashboard:ready"));
    if (WEEKLYPAGE || weekly) setIdx(dates.length - 1);   // open static on the latest week; the slider / play button step through the rest
    else if (TRENDS) play();                  // 21-Day page: start from the first frame every time the page opens
  }).catch(fail);
})();
