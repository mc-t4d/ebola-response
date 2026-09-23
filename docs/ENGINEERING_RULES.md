# Engineering Rules — Mercy Corps DRC Ebola Web Dashboard

Standing rules for anyone working in this repository. The full architecture,
the decisions already taken and the file-level plan live in
[PROJECT_BRIEF.md](PROJECT_BRIEF.md) — read it before making changes. This file
is only the rules that must hold across every change.

## What this project is

Mercy Corps–branded fork of the INSP/INRB epidemic dashboard, integrated with
ArcGIS Online (and later ArcGIS Enterprise) via **esri-leaflet**.

- A **fork of `INRB-UMIE/BDBV2026-Epidemic_Dashboard`** (MIT). Keep the original
  MIT notice; add MC copyright for new work.
- A **Python static-site build**: `Scripts/build_dashboard.py` orchestrates
  per-page modules in `Scripts/pages/` and writes self-contained HTML.
- Map is **Leaflet** (`Scripts/assets/engine.js`), not the ArcGIS JS SDK.
- **Bilingual (en/fr)** via `locales/en.yaml` and `locales/fr.yaml` — every new
  user-facing string goes in BOTH.

## Standing rules

- **Data integration = esri-leaflet** serving Mercy Corps' own AGOL feature
  layers. Do NOT swap the base map to the ArcGIS JS SDK.
- **Externalize all portal config** (portal URL, item IDs, service URLs, field
  names, class breaks) into one config module so the AGOL→AGE migration is a
  config swap, never a code change. See `config/portal.*.yaml` and
  `Scripts/common/portal_config.py`.
- **Never commit secrets.** The portal profiles carry only the *names* of
  environment variables; keys and any internal endpoint values stay in `.env`
  or in `MC_*` env overrides.
- **Join upstream case data on province-disambiguated `nom`**, never on
  `zscode` (it is not unique — Lubunga/Bili both = `HZ00154`). Use the
  `NAME_CROSSWALK` from `ebola_data.py` as the bridge.
- **Colors and class breaks are house style, not INSP's.** Use the MC YlOrRd
  ramp and breaks in [PROJECT_BRIEF.md](PROJECT_BRIEF.md); do not fall back to
  the INSP single-hue `reds` default in `layer_config.yaml`.
- **Unaffected zones render as light grey with NULL (not 0)** so "no cases yet"
  stays distinct from a confirmed zero.
- **Preserve the bilingual system and the MIT license header.**
- Fonts: **Merriweather** (serif) + **League Spartan** (display), Google Fonts.

## Where things live

- Portal / layer / cartography config: `config/portal.agol.yaml`
  (+ `config/portal.enterprise.yaml`, which inherits from it)
- Config loader and field-role API: `Scripts/common/portal_config.py`
- Branding hook: `common/theme.py` → `Data/Branding/dashboard-theme.css`
- Layer palettes / scale / breaks / exclusions: `layer_config.yaml`
- Page registration (add/remove tabs): `PAGE_MODULES` in `Scripts/build_dashboard.py`
- Health-zone geometry (upstream): `BDBV2026-Data/build/drc_health_zones.geojson`
- MC canonical geometry (to publish to AGOL): `zones_de_sante_update_2.gpkg`
- MC corridors (transmission tab): `DRC_Ebola_Corridors.gpkg`
