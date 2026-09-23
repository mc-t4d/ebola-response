# Project Brief — Mercy Corps DRC Ebola Web Dashboard

Handoff from the scoping conversation. This is the reference that
`docs/ENGINEERING_RULES.md` points to. Keep it current as decisions change.

---

## 1. Goal

Take the official INSP/INRB epidemic dashboard, reflavor it as a Mercy Corps
product, reduce it to the tabs MC needs, add a Transmission tab, and drive its
data from Mercy Corps' ArcGIS Online (AGOL) now / ArcGIS Enterprise (AGE) later.

**Tabs (target):** Current Snapshot · Epidemiological Trends · **Transmission** (new).
Everything else in the upstream dashboard is dropped.

---

## 2. What the upstream repo actually is

Fork of **`INRB-UMIE/BDBV2026-Epidemic_Dashboard`** — license **MIT**
(INRB/INOHA/INSP 2026), in-repo, so fork-and-modify is clean if the notice stays.

- **Python static-site build.** `Scripts/build_dashboard.py` is the orchestrator;
  per-page modules live in `Scripts/pages/` (snapshot, trends, spatial_risk,
  context, surveillance_testing, clinical_symptoms, genomic_epidemiology). Each
  page is written as a self-contained ~19 MB HTML file (data baked in), served
  via GitHub Pages/Jekyll (`_config.yml` excludes `output/` from publish).
- **Map = Leaflet** (`Scripts/assets/engine.js`). Charts/phylogeny use D3 +
  `peartree.bundle.min.js` (genomic page only — drops out when that tab is removed).
- **Basemap = CARTO Positron** (`light_all` raster tiles, OSM+CARTO attribution).
- **Branding hook already exists:** `common/theme.py` → `load_theme_css()` reads
  `Data/Branding/dashboard-theme.css` and layers it over the map. MC styling
  plugs in through this one CSS file.
- **Layers are config-driven:** `layer_config.yaml` sets palette / scale (log) /
  legend rounding / exclusions / ordering. Layers are **attribute columns on one
  geometry**, styled per config.
- **Bilingual:** `locales/en.yaml`, `locales/fr.yaml`. Preserve; add Transmission
  strings to both.
- **Data comes from sibling repos** via env-overridable paths in
  `Scripts/common/paths.py` (`BUILD_DIR` defaults to `../BDBV2026-Data/build`,
  Flowminder/OSRM under `../BDBV2026-Data/data/...`).

### Geometry facts (important)
- Health zones: `BDBV2026-Data/build/drc_health_zones.geojson` — WGS84,
  **519 features**, properties `nom`, `zscode`, `province` + thematic columns
  (`insp_sitrep`, `flowminder_short_trips`, `worldpop`, `ccvi`, etc.).
- **Provinces are derived**, not a separate file — `build_province_boundaries()`
  dissolves the health zones (unary_union + polygonize + sliver cleanup). This is
  why their layers nest perfectly. **No admin-2 (territoire) layer exists.**
- `zscode` is **not unique** (Lubunga/Bili both `HZ00154`). Join on
  province-disambiguated `nom`.
- MC's canonical boundary is a **different file**: `zones_de_sante_update_2.gpkg`
  (519 zones, EPSG:3857, field `Nom`). Same zone count/vintage as upstream, but
  different label spellings (upstream uses `Mongbwalu`/`Nyankunde`; MC's file uses
  `Mongbalu`/`Nyakunde`, per the crosswalk). The `NAME_CROSSWALK` in
  `ebola_data.py` bridges them.

---

## 3. Decisions locked

### Integration
- **esri-leaflet (MIT)** adds AGOL/AGE feature layers as ordinary Leaflet layers,
  mixed with the CARTO basemap and GeoJSON. MC brings its own geometry; not locked
  into Esri basemaps or Esri-hosted data.
- **Config-externalize** portal URL + item IDs + service URLs + field mappings +
  class breaks in one module. AGOL→AGE = config swap. (Auth differs: AGOL
  named-user/API-key vs AGE portal/web-tier — handle in config, not code.)

### Canonical web geometry
- **Publish MC's `zones_de_sante_update_2.gpkg` to AGOL**, plus a **dissolved
  province layer** (mirror `build_province_boundaries()` on the MC gpkg so
  provinces nest with the zones).
- Upstream case/attribute data joins onto MC geometry via `NAME_CROSSWALK` on
  province-disambiguated `nom`. Pin Lubunga → Tshopo.

### Tabs
- **Keep** snapshot + trends: edit the `PAGE_MODULES` list in
  `Scripts/build_dashboard.py` to remove context, spatial_risk,
  surveillance_testing, clinical_symptoms, genomic_epidemiology (the peartree
  bundle then drops out).
- **Add** `Scripts/pages/transmission.py` on the same page-module contract;
  register it in `PAGE_MODULES`; add its strings to `locales/en.yaml` + `fr.yaml`.

### Cartography (house style — replicate, don't use INSP defaults)
- **Case-count ramp: MC 5-class YlOrRd**, breaks
  `1–4 / 5–10 / 11–21 / 22–44 / 45+` (daily static map may print the true max,
  e.g. `45–1654`; web uses open-ended `45+`).
  Placeholder hexes (REPLACE with exact values from the Pro `.stylx`/CIM):
  `#FDD835 → #FDAE61 → #F16913 → #D7301F → #B10026`.
- **Unaffected = light grey; water = pale blue; NULL not 0.**
- **Program overlays = colored outlines, not fills:** RESET = green outline,
  IERDC = cyan outline.
- Put the ramp hexes + neutral/water tokens + outline colors + fonts in
  `Data/Branding/dashboard-theme.css`; put the class breaks in `layer_config.yaml`.
- **Typography: Merriweather (serif) + League Spartan (display).** Google Fonts.
  Titles in MC red; italic serif source line. (Supersedes any earlier Lora/Poppins.)

### Transmission tab
- **MC's `DRC_Ebola_Corridors.gpkg`** served via esri-leaflet as a **static styled
  line layer**: dashed = cross-border/transit routes; solid = national roads
  (RN4, RN25); categorical color per corridor; **epicentre = black asterisk marker**.
- Arrowheads via **Leaflet-PolylineDecorator (MIT)** + `dashArray` for dashed/solid
  (Leaflet polylines have no native arrowheads — plugin approved).
- **Case choropleth is the time-enabled layer** driven by the slider; corridors
  stay static. Only one layer varies with time.
- **Time slider default = 21-day steps** (weekly as an option), matching the MC
  small-multiples series (Day 0/21/42/63/84/105/121; Day 84 has a known data gap
  → nearest = Aug 4 / day 82).
- Scope reaches the **Uganda / South Sudan adjacency ring** (consistent with the
  corridors and the requirements doc's three-ring extent).

### Layer stack (bottom → top)
1. Stock basemap (CARTO Positron for now)
2. Case choropleth (time-enabled)
3. *[MC roads overlay — deferred]* — the salmon roads are an MC overlay that sits
   **over** transmission data, NOT part of the basemap. Left out of the first build.
4. **Province boundaries on top** (for clarity)
5. Corridors + epicentre marker + labels

A custom basemap is a later consideration; stock is fine to start.

### Flowminder — deferred
- Real, **weekly** short-trips series exists (Apr 30–May 24; D+7…D+31), already
  wired as the `flowminder_short_trips` attribute — BUT it is **cohort-aggregate
  (Bunia/Mongbwalu/Rwampara pooled), not pairwise OD** (every origin row is
  identical). Only honest as a destination-intensity choropleth or pooled-epicentre
  flows — never per-community arrows.
- True pairwise OD exists only at **province** resolution, single **March** snapshot
  (`data/flowminder/`). OSRM matrices = road connectivity, not movement volume.
- **Decision: leave out of the first build; keep a toggle hook for later.**

### Snapshot / Trends data mode
- Recommendation: these can stay **build-time baked** (they update on SitRep
  cadence). The **Transmission tab is the live/time-enabled** one. Revisit if MC
  wants everything live.

---

## 4. Open items (do not block the theme scaffold)
- Exact YlOrRd ramp hexes from the Pro CIM / `.stylx`.
- AGOL portal URL + item IDs to populate the config module.
- Whether Flowminder gets exposed at all.
- Confirm snapshot/trends baked vs. live.
- Validate whether the AGOL **join view supports server-side time filtering**
  (`test_joinview_timeslider.py`). If not: denormalize to a zone×date feature
  class, OR client-side filter (fine at 519 zones × weekly bins), OR
  pre-materialized per-timestep layers (avoid).

---

## 5. First steps
1. `git init`; add `.gitignore` (Python + node + large data); keep the MIT
   `LICENSE` with the original INRB/INOHA/INSP notice and add an MC copyright line
   / `NOTICE` for new work.
2. Decide vendoring: fork the upstream repo vs. fresh repo seeded with `Scripts/`.
3. Create the **config module** (portal URL, item IDs, service URLs, field map,
   class breaks) — the AGOL↔AGE seam.
4. Scaffold the theme: `Data/Branding/dashboard-theme.css` tokens (YlOrRd ramp,
   grey/water tokens, RESET-green + IERDC-cyan outlines, Merriweather + League
   Spartan) and a small Leaflet style spec (class-break function, corridor
   categorical palette, PolylineDecorator config, epicentre marker).
5. **esri-leaflet proof-of-life:** Positron + one MC AGOL feature layer styled by
   one field, config-externalized.
6. Validate the join-view time filter before committing the transmission time model.
7. Build the Transmission tab (corridors static + case choropleth time-enabled).
8. Trim tabs (`PAGE_MODULES`) and wire the bilingual strings.

### Suggested init commands
```bash
git init
git branch -M main
# .gitignore essentials: __pycache__/  *.pyc  .venv/  node_modules/  *.gpkg (if large)  output/ (optional)
git add .
git commit -m "Initial: MC fork of INRB-UMIE/BDBV2026-Epidemic_Dashboard (MIT)"
# then: git remote add origin <your-repo-url> && git push -u origin main
```
