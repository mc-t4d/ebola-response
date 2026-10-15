/* Map overlays built from DRC_Ebola_Corridors_Updated_10_8_v2.gpkg
 * (converted by tools/build_corridors_geojson.py -> data/corridors.geojson).
 *
 * Which overlays a page draws is set on <body data-overlays="...">:
 *   corridors  animated transmission routes + border crossings + route legend
 *   towns      main towns and cities (dots with labels)
 *   epicentre  asterisk icons on Bunia and Rwampara, "Outbreak Epicenter"
 *   roads      DRC national roads as a red line (data/geo/roads.geojson, from the OSM road gpkg)
 *   southsudan South Sudan border + counties (data/geo/south_sudan*.geojson), under the zones
 *
 * Routes keep the gpkg colour (color_hex). Cross-border / transit routes are
 * dashed and the dashes flow toward the destination; domestic roads are solid
 * with pulses running along them. Arrowheads come from Leaflet.PolylineDecorator
 * when that plugin is loaded (optional). Motion is switched off by the
 * prefers-reduced-motion media query (css/style.css).
 *
 * Waits for js/app.js ("dashboard:ready") and draws onto window.dashboardMap.
 */
(function () {
  "use strict";

  var DASH = "9 7";            // sum 16 -> keyframes in style.css animate by 16
  var PULSE = "2 22";          // sum 24
  var EPICENTRE_TOWNS = ["Bunia", "Rwampara"];

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function pane(map, name, z) { map.createPane(name); map.getPane(name).style.zIndex = z; }

  // 8-ray asterisk, black with a white halo so it survives a dark choropleth.
  function asteriskSVG(px) {
    var rays = [0, 45, 90, 135].map(function (a) {
      return "<line x1='16' y1='3' x2='16' y2='29' transform='rotate(" + a + " 16 16)'/>";
    }).join("");
    return "<svg width='" + px + "' height='" + px + "' viewBox='0 0 32 32' aria-hidden='true'>" +
      "<g stroke='#fff' stroke-width='8' stroke-linecap='round'>" + rays + "</g>" +
      "<g stroke='#231f20' stroke-width='3.6' stroke-linecap='round'>" + rays + "</g></svg>";
  }

  function epicentreRow() {
    return "<div class='epicentre-row'>" + asteriskSVG(18) + "<span>Outbreak Epicenter</span></div>";
  }

  // ---- legends ------------------------------------------------------------
  function mapLegendRow() {                       // Current Cumulative: add to the existing legend card
    var body = document.querySelector("#legend .panel-body");
    var d = document.createElement("div");
    d.id = "legend-epicentre";
    d.className = "legend-classes";
    d.innerHTML = epicentreRow();
    if (body) { body.insertBefore(d, body.firstChild); return; }     // top of the list
    // trend pages: under the class / recency legend, above the road row
    var anchor = document.getElementById("trends-recency-legend") || document.getElementById("trends-class-legend");
    if (anchor) anchor.parentNode.insertBefore(d, anchor.nextSibling);
  }

  function routeLegend(routes, withEpicentre) {
    // routes grouped by destination so the list reads as three short blocks
    var groups = [
      { title: "To South Sudan", test: /^south sudan/i },
      { title: "To Uganda",      test: /^uganda/i },
      { title: "Domestic spread", test: /^domestic/i }
    ];
    var used = {};
    function row(f) {
      var p = f.properties, dashed = p.kind === "cross_border";
      return "<div class='corridor-row'>" +
        "<svg width='34' height='10' aria-hidden='true'><line x1='1' y1='5' x2='33' y2='5' stroke='" + esc(p.color_hex) +
        "' stroke-width='3.5' " + (dashed ? "stroke-dasharray='7 5'" : "") + "/></svg>" +
        "<span>" + esc(p.route_name) + "</span></div>";
    }
    var rows = groups.map(function (g) {
      var fs = routes.filter(function (f) {
        var hit = g.test.test(String(f.properties.category || "")); if (hit) used[f.properties.route_name] = 1; return hit;
      });
      return fs.length ? "<div class='corridor-group'>" + g.title + "</div>" + fs.map(row).join("") : "";
    }).join("");
    var rest = routes.filter(function (f) { return !used[f.properties.route_name]; });
    if (rest.length) rows += "<div class='corridor-group'>Other</div>" + rest.map(row).join("");

    var box = document.createElement("div");
    box.id = "corridor-legend";
    box.className = "panel";
    box.innerHTML =
      "<button type='button' class='corridor-toggle' aria-expanded='true' aria-label='Collapse or expand corridor legend'>&minus;</button>" +
      "<div class='corridor-title'>Transmission corridors</div>" +
      "<div class='corridor-body'>" +
        "<div class='corridor-key'>Dashed = cross-border / transit &middot; solid = domestic road</div>" +
        (withEpicentre ? "<div class='corridor-epi'>" + epicentreRow() + "</div>" : "") + rows +
      "</div>";
    box.querySelector(".corridor-toggle").addEventListener("click", function () {
      var collapsed = box.classList.toggle("collapsed");
      this.setAttribute("aria-expanded", collapsed ? "false" : "true");
      this.innerHTML = collapsed ? "+" : "&minus;";
    });
    // Inside #viewport-area (the map region under the header), like every other
    // map card -- appended to <body> it was positioned from the top of the page
    // and slid under the header.
    (document.getElementById("viewport-area") || document.body).appendChild(box);
  }

  // ---- overlays -----------------------------------------------------------
  function drawRoutes(map, routes) {
    pane(map, "corridors", 565);
    routes.forEach(function (f) {
      var p = f.properties, color = p.color_hex || "#231f20", cross = p.kind === "cross_border";
      var base = L.geoJSON(f, {
        pane: "corridors",
        style: function () {
          return cross
            ? { color: color, weight: 3.5, opacity: 0.95, lineCap: "butt", lineJoin: "round", dashArray: DASH, className: "route-flow" }
            : { color: color, weight: 3.5, opacity: 0.95, lineCap: "round", lineJoin: "round" };
        }
      }).addTo(map);
      base.bindTooltip(esc(p.route_name), { sticky: true });
      base.bindPopup(
        "<strong>" + esc(p.route_name) + "</strong><br><em>" + esc(p.category) + "</em><br>" +
        esc(p.description) + "<br><small>Evidence: " + esc(p.evidence_tier) + "</small>", { maxWidth: 320 });
      if (!cross) {
        // pulses running along the solid road, in drawing order (origin -> destination)
        L.geoJSON(f, {
          pane: "corridors", interactive: false,
          style: function () {
            return { color: "#ffffff", weight: 2.2, opacity: 0.9, lineCap: "round", dashArray: PULSE, className: "route-pulse" };
          }
        }).addTo(map);
      }
      if (L.polylineDecorator && L.Symbol && L.Symbol.arrowHead) {
        // geometry is [lon, lat]; Leaflet wants [lat, lon]
        var latlngs = f.geometry.coordinates.map(function (c) { return [c[1], c[0]]; });
        L.polylineDecorator(latlngs, {
          patterns: [{ offset: "100%", repeat: 0, symbol: L.Symbol.arrowHead({
            pixelSize: 13, polygon: false, pathOptions: { color: color, weight: 3.5, opacity: 1, pane: "corridors" } }) }]
        }).addTo(map);
      }
    });
  }

  function drawCrossings(map, crossings) {
    crossings.forEach(function (f) {
      var c = f.geometry.coordinates, p = f.properties;
      L.circleMarker([c[1], c[0]], {
        pane: "corridor-nodes", radius: 6, weight: 2.5, color: "#231f20", fillColor: "#ffffff", fillOpacity: 1
      }).bindTooltip("Border crossing: " + esc(p.crossing), { direction: "top" })
        .bindPopup("<strong>" + esc(p.crossing) + "</strong><br>" + esc(p.notes)).addTo(map);
    });
  }

  function drawTowns(map, towns) {
    towns.forEach(function (f) {
      var c = f.geometry.coordinates, p = f.properties, ll = [c[1], c[0]];
      var foreign = p.country && p.country !== "DRC";
      // visible dot: hoverable (enlarges, shows name / country / notes)
      var dot = L.circleMarker(ll, {
        pane: "corridor-nodes", className: "town-dot", radius: 4.5, weight: 1.5,
        color: "#ffffff", fillColor: "#231f20", fillOpacity: 1
      }).addTo(map);
      dot.bindTooltip(
        "<div class='town-hover-tip'><strong>" + esc(p.name) + "</strong>" + (p.country ? " (" + esc(p.country) + ")" : "") +
        (p.notes ? "<div class='town-notes'>" + esc(p.notes) + "</div>" : "") + "</div>",
        { direction: "top", offset: [0, -6], opacity: 1 });
      dot.on("mouseover", function () { dot.setStyle({ radius: 7, fillColor: "#c8102e" }); dot.bringToFront(); });
      dot.on("mouseout", function () { dot.setStyle({ radius: 4.5, fillColor: "#231f20" }); });
      // permanent label: separate, non-interactive marker so it never steals the hover
      L.marker(ll, {
        pane: "corridor-nodes", interactive: false, keyboard: false,
        icon: L.divIcon({ className: "town-label-marker" + (foreign ? " foreign" : ""),
                          html: "<span>" + esc(p.name) + "</span>", iconSize: [0, 0] })
      }).addTo(map);
    });
    // labels only from zoom 7 up, so the national view is not cluttered
    function sync() { map.getContainer().classList.toggle("towns-zoomed-out", map.getZoom() < 7); }
    map.on("zoomend", sync); sync();
  }

  function drawEpicentre(map, towns) {
    pane(map, "epicentre", 585);
    EPICENTRE_TOWNS.forEach(function (name) {
      var f = towns.filter(function (t) { return t.properties.name === name; })[0];
      if (!f) return;
      var c = f.geometry.coordinates;
      L.marker([c[1], c[0]], {
        pane: "epicentre", keyboard: false,
        icon: L.divIcon({ className: "epicentre-icon", html: asteriskSVG(26), iconSize: [26, 26], iconAnchor: [13, 13] })
      }).bindTooltip("Outbreak Epicenter: " + name, { direction: "top", offset: [0, -10] }).addTo(map);
    });
  }

  function draw(map, fc, want) {
    var by = function (k) { return fc.features.filter(function (f) { return f.properties.layer === k; }); };
    var routes = by("route"), towns = by("town"), crossings = by("crossing");
    pane(map, "corridor-nodes", 575);
    if (want.corridors) { drawRoutes(map, routes); drawCrossings(map, crossings); }
    if (want.towns) drawTowns(map, towns);
    if (want.epicentre) drawEpicentre(map, towns);
    if (want.corridors) routeLegend(routes, want.epicentre);
    else if (want.epicentre) mapLegendRow();
  }

  function getJSON(url) {
    return fetch(url).then(function (r) { if (!r.ok) throw new Error(url + " HTTP " + r.status); return r.json(); });
  }
  // South Sudan counties (admin 2) outlined on the map; the rest of the country is plain grey.
  var SS_COUNTIES = ["Tambura", "Ezo", "Nzara", "Yambio", "Ibba", "Maridi", "Juba", "Yei", "Morobo", "Kajo-keji",
    "Magwi", "Torit", "Ikotos", "Budi", "Kapoeta East", "Kapoeta South"];
  function drawSouthSudan(map) {
    map.createPane("south-sudan"); map.getPane("south-sudan").style.zIndex = 380;   // above tiles, below zones
    return Promise.all([getJSON("data/geo/south_sudan.geojson"), getJSON("data/geo/south_sudan_counties.geojson")])
      .then(function (r) {
        L.geoJSON(r[0], { pane: "south-sudan", interactive: false,
          style: { color: "#231f20", weight: 2.2, opacity: 1, fillColor: "#d6d6d6", fillOpacity: 1 } }).addTo(map);   // same grey as the DRC provinces without zones
        L.geoJSON(r[1], { pane: "south-sudan",
          filter: function (f) { return SS_COUNTIES.indexOf(f.properties.county) >= 0; },
          style: { color: "#54585a", weight: 1.2, opacity: 0.85, fillColor: "#e1e1e1", fillOpacity: 1 },   // same look as DRC zones without cases
          onEachFeature: function (f, layer) {
            layer.bindTooltip(esc(f.properties.county) + " (" + esc(f.properties.state) + ")", { sticky: true });
            layer.on("mouseover", function () { layer.setStyle({ color: "#231f20", opacity: 0.98, weight: 2 }); layer.bringToFront(); });
            layer.on("mouseout", function () { layer.setStyle({ color: "#54585a", opacity: 0.85, weight: 1.2 }); });
          } }).addTo(map);
        L.marker([4.6, 31.2], { pane: "south-sudan", interactive: false, keyboard: false,
          icon: L.divIcon({ className: "country-label", html: "<span>South Sudan</span>", iconSize: [0, 0] }) }).addTo(map);
      });
  }

  // National road network: red line with a white casing so it reads on every case colour.
  function drawRoads(map) {
    pane(map, "roads", 560);
    return getJSON("data/geo/roads.geojson").then(function (gj) {
      L.geoJSON(gj, { pane: "roads", interactive: false,
        style: { color: "#ffffff", weight: 4, opacity: 0.85, lineCap: "round", lineJoin: "round" } }).addTo(map);
      L.geoJSON(gj, { pane: "roads", style: { color: "#c8102e", weight: 2, opacity: 1, lineCap: "round", lineJoin: "round" },
        onEachFeature: function (f, layer) {
          layer.bindTooltip(esc(f.properties.ref) + (f.properties.name ? " \u2013 " + esc(f.properties.name) : ""), { sticky: true });
        } }).addTo(map);
      var host = document.querySelector("#legend .panel-body") || document.getElementById("trends-legend");
      if (host) {
        var row = document.createElement("div");
        row.className = "legend-classes road-legend";
        row.innerHTML = "<div class='epicentre-row'><svg width='26' height='10' aria-hidden='true'>" +
          "<line x1='1' y1='5' x2='25' y2='5' stroke='#fff' stroke-width='5' stroke-linecap='round'/>" +
          "<line x1='1' y1='5' x2='25' y2='5' stroke='#c8102e' stroke-width='2.5' stroke-linecap='round'/></svg><span>National road</span></div>";
        var epi = document.getElementById("legend-epicentre");        // map page: road row goes under the epicentre row
        if (host.id !== "trends-legend") host.insertBefore(row, epi ? epi.nextSibling : host.firstChild);
        else host.appendChild(row);
      }
    });
  }

  function init() {
    var map = window.dashboardMap;
    var want = {};
    (document.body.dataset.overlays || "corridors towns").split(/\s+/).forEach(function (k) { if (k) want[k] = true; });
    if (!map) { console.warn("overlays: map not available"); return; }
    if (want.southsudan) drawSouthSudan(map).catch(function (err) { console.warn("South Sudan not drawn (" + err.message + ")"); });
    if (want.roads) drawRoads(map).catch(function (err) { console.warn("roads not drawn (" + err.message + ")"); });
    fetch("data/corridors.geojson", { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (fc) { draw(map, fc, want); })
      .catch(function (err) { console.warn("overlays not drawn (" + err.message + ")"); });
  }

  document.addEventListener("dashboard:ready", init);
})();
