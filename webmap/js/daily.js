/* Latest-day loader for the Current Snapshot map.
 *
 * Reads data/daily/manifest.csv, picks the most recent day that has a file,
 * fetches data/daily/daily_<date>_<source>.csv and patches window.__PAYLOAD__
 * (zone counts, national totals, as-of date, active-case markers) BEFORE
 * js/engine.js runs. Drop a new daily file + manifest row in the folder (or
 * re-run Scripts/build_daily_data.py) and the map shows it on next load; no
 * code change.
 *
 * If the files cannot be fetched (e.g. page opened from file:// -- browsers
 * block fetch there -- or the folder is missing) the baked-in payload is used
 * unchanged and a warning is logged.
 *
 * Daily file format: zone,cases,deaths,national_cases,national_deaths
 * (national topline on the first data row only; zone = payload zone `nom`).
 */
(function () {
  "use strict";

  var DAILY_DIR = "data/daily/";
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // --- tiny CSV parser (quoted fields, CRLF, BOM) -------------------------
  function parseCSV(text) {
    text = text.replace(/^﻿/, "");
    var rows = [], row = [], field = "", inQ = false, i, ch;
    for (i = 0; i < text.length; i++) {
      ch = text.charAt(i);
      if (inQ) {
        if (ch === '"') {
          if (text.charAt(i + 1) === '"') { field += '"'; i++; } else { inQ = false; }
        } else { field += ch; }
      } else if (ch === '"') { inQ = true; }
      else if (ch === ",") { row.push(field); field = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text.charAt(i + 1) === "\n") i++;
        row.push(field); field = "";
        if (row.length > 1 || row[0] !== "") rows.push(row);
        row = [];
      } else { field += ch; }
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    if (!rows.length) return [];
    var head = rows[0].map(function (h) { return h.trim(); });
    return rows.slice(1).map(function (r) {
      var o = {};
      head.forEach(function (h, k) { o[h] = r[k] === undefined ? "" : r[k].trim(); });
      return o;
    });
  }

  function fetchText(url) {
    return fetch(url, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error(url + " -> HTTP " + r.status);
      return r.text();
    });
  }

  function num(v) {
    if (v === undefined || v === null || v === "") return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  // "2026-10-06" -> "6 Oct 2026" (same style as the baked PAYLOAD.asof)
  function fmtAsof(iso) {
    var p = iso.split("-");
    return parseInt(p[2], 10) + " " + MONTHS[parseInt(p[1], 10) - 1] + " " + p[0];
  }

  /** Latest manifest row that points at a file. */
  function latestEntry(manifest) {
    var best = null;
    manifest.forEach(function (r) {
      if (!r.file || !r.date) return;
      if (!best || r.date > best.date) best = r;
    });
    return best;
  }

  function patchPayload(P, entry, rows) {
    var Z = P.zone_data || {};
    var feats = (P.geometry && P.geometry.features) || [];
    var names = {};
    feats.forEach(function (f) { names[f.properties.nom] = f.properties.name || f.properties.nom; });

    var cases = {}, deaths = {}, nationalCases = null, nationalDeaths = null;
    rows.forEach(function (r, i) {
      if (!r.zone) return;
      var c = num(r.cases);
      if (c !== null) cases[r.zone] = c;
      var d = num(r.deaths);
      if (d !== null) deaths[r.zone] = d;
      if (i === 0 || nationalCases === null) {
        if (num(r.national_cases) !== null) nationalCases = num(r.national_cases);
        if (num(r.national_deaths) !== null) nationalDeaths = num(r.national_deaths);
      }
    });
    // manifest carries the national figures too (needed when a file is header-only)
    if (nationalCases === null) nationalCases = num(entry.national_cases);
    if (nationalDeaths === null) nationalDeaths = num(entry.national_deaths);
    var recovered = num(entry.national_recovered);

    var unknown = Object.keys(cases).filter(function (z) { return !Z[z]; });
    if (unknown.length) console.warn("daily.js: zones not in payload geometry:", unknown);

    // Per-zone values. Unaffected zones are null (never 0): "no cases yet"
    // must stay distinct from a confirmed zero.
    var zoneSum = 0, markers = [];
    Object.keys(Z).forEach(function (nom) {
      var z = Z[nom], c = cases.hasOwnProperty(nom) ? cases[nom] : null;
      var d = deaths.hasOwnProperty(nom) ? deaths[nom] : null;
      z.confirmed_cases = c;
      z.effective_confirmed_cases = c;
      z.confirmed_deaths = c === null ? null : d;
      // The daily files carry confirmed counts only: "total" = confirmed.
      z.suspected_cases = null;
      z.suspected_deaths = null;
      z.total_cases = c;
      if (c !== null && c > 0) {
        zoneSum += c;
        markers.push({
          nom: nom, name: names[nom] || z.name || nom,
          lat: z.centroid_lat, lon: z.centroid_lon,
          confirmed: c, suspected: 0, confirmed_deaths: d === null ? 0 : d,
          suspected_deaths: 0, total: c
        });
      }
    });
    P.active_case_markers = markers;

    var T = P.totals || (P.totals = {});
    var natC = nationalCases === null ? zoneSum : nationalCases;
    T.confirmed_cases = natC;
    T.global_confirmed_cases = natC;
    T.global_total_cases = natC;
    T.suspected_cases = 0;
    T.global_suspected_cases = 0;
    T.suspected_deaths = 0;
    T.global_suspected_deaths = 0;
    if (nationalDeaths !== null) {
      T.confirmed_deaths = nationalDeaths;
      T.global_confirmed_deaths = nationalDeaths;
    }
    if (recovered !== null) T.global_recovered_cases = recovered;
    T.affected_zones = markers.length;
    if (T.per_country && T.per_country[0]) {
      var pc = T.per_country[0];
      pc.confirmed_cases = natC; pc.suspected_cases = 0; pc.suspected_deaths = 0; pc.total = natC;
      if (nationalDeaths !== null) pc.confirmed_deaths = nationalDeaths;
      if (recovered !== null) pc.recovered_cases = recovered;
    }

    P.asof = fmtAsof(entry.date);
    P.daily = {
      date: entry.date, day: num(entry.day), source: entry.source,
      file: entry.file, provisional: String(entry.provisional).toLowerCase() === "true",
      carried_from: entry.carried_from || ""
    };

    // Confirmed cases is the headline layer on this map: list it first so it
    // is the default selection (the layer picker itself is hidden).
    function confirmedFirst(list) {
      if (!Array.isArray(list)) return list;
      var i = list.findIndex(function (L) { return L.id === "obs::confirmed"; });
      if (i > 0) list.unshift(list.splice(i, 1)[0]);
      return list;
    }
    confirmedFirst(P.layers);
    if (P.i18n && P.i18n.layers) Object.keys(P.i18n.layers).forEach(function (k) { confirmedFirst(P.i18n.layers[k]); });
  }

  /** Fetch + apply the latest daily file. Resolves with the patched entry (or null). */
  function loadLatestDaily(P) {
    return fetchText(DAILY_DIR + "manifest.csv").then(function (txt) {
      var manifest = parseCSV(txt);
      var entry = latestEntry(manifest);
      if (!entry) throw new Error("manifest.csv has no usable rows");
      return fetchText(DAILY_DIR + entry.file).then(function (csvText) {
        patchPayload(P, entry, parseCSV(csvText));
        return { entry: entry, manifest: manifest };
      });
    });
  }

  // --- trend pages: cumulative series built from every daily file ----------
  // Replaces PAYLOAD.confirmed_timeseries / confirmed_recency so the slider
  // runs over the daily files. `step` > 1 keeps Day 0, step, 2*step, ... and
  // always the latest day (21-Day Trend page: Day 0/21/42/.../latest).
  function buildSeries(P, manifest, step) {
    var rows = manifest.filter(function (r) { return r.file && r.date; })
      .sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    if (step > 1 && rows.length) {
      var day0 = num(rows[0].day) || 0, lastIdx = rows.length - 1;
      rows = rows.filter(function (r, i) {
        return i === lastIdx || ((num(r.day) - day0) % step === 0);
      });
    }
    return Promise.all(rows.map(function (r) {
      return fetchText(DAILY_DIR + r.file).then(parseCSV);
    })).then(function (all) {
      var Z = P.zone_data || {}, dates = rows.map(function (r) { return r.date; });
      var byNom = {};
      all.forEach(function (day, i) {
        day.forEach(function (r) {
          var c = num(r.cases);
          if (!r.zone || c === null || c <= 0) return;
          if (!Z[r.zone]) return;
          if (!byNom[r.zone]) byNom[r.zone] = new Array(dates.length).fill(0);
          byNom[r.zone][i] = c;
        });
      });
      var labels = {}, maxC = 1;
      dates.forEach(function (d) { labels[d] = d; });
      Object.keys(byNom).forEach(function (z) { maxC = Math.max(maxC, Math.max.apply(null, byNom[z])); });
      P.confirmed_timeseries = { dates: dates, date_labels: labels, by_nom: byNom, max_confirmed: maxC, min_positive: 1 };

      // Recency: days since the zone's cumulative count last rose (or first appeared).
      var near = 14, mid = 42;
      if (P.confirmed_recency && P.confirmed_recency.thresholds) {
        near = P.confirmed_recency.thresholds.near || near; mid = P.confirmed_recency.thresholds.mid || mid;
      }
      var DAY = 86400000, rec = {}, days = {};
      Object.keys(byNom).forEach(function (z) {
        var s = byNom[z], last = null, cat = [], dd = [];
        for (var i = 0; i < s.length; i++) {
          if (s[i] > (i ? s[i - 1] : 0)) last = Date.parse(dates[i]);
          if (last === null) { cat.push(4); dd.push(-1); continue; }
          var n = Math.round((Date.parse(dates[i]) - last) / DAY);
          dd.push(n); cat.push(n <= near ? 1 : (n <= mid ? 2 : 3));
        }
        rec[z] = cat; days[z] = dd;
      });
      P.confirmed_recency = {
        dates: dates, by_nom: rec, days_by_nom: days, thresholds: { near: near, mid: mid },
        labels: (P.confirmed_recency && P.confirmed_recency.labels) || { "1": "active", "2": "recent", "3": "dormant", "4": "never" }
      };
    });
  }

  function loadEngine() {
    var s = document.createElement("script");
    s.src = "js/engine.js";
    document.body.appendChild(s);
  }

  window.loadLatestDaily = loadLatestDaily;
  window.__dailyReady = loadLatestDaily(window.__PAYLOAD__)
    .then(function (r) {
      console.info("daily.js: showing " + r.entry.date + " (" + r.entry.source + ")");
      var view = document.body.dataset.initialView || "map";
      if (view !== "trends") return;
      var step = parseInt(document.body.dataset.sliderStep || "1", 10) || 1;
      return buildSeries(window.__PAYLOAD__, r.manifest, step);
    })
    .catch(function (err) { console.warn("daily.js: using baked-in payload (" + err.message + ")"); })
    .then(loadEngine);
})();
