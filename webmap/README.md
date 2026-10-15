# DRC Ebola (Bundibugyo) web map

Three static pages — `index.html` (Current Cumulative), `trends.html` (Daily Trend), `trend21.html` (21-Day Trend).
Serve the folder over HTTP (browsers block `fetch` from `file://`):

    python3 -m http.server      # then open http://localhost:8000

| Path | What |
|---|---|
| `js/app.js` | the map, legends, tracker, slider, modals |
| `js/corridors.js` | towns, epicentre icons, animated routes (`data-overlays` on `<body>`) |
| `css/style.css` | all styling |
| `data/daily/` | one CSV per day + `manifest.csv` (latest row = current map); see its README |
| `data/geo/` | zones / provinces / country / programme GeoJSON + `zone_names.csv` |
| `data/corridors.geojson`, `data/modals.json` | overlays, pop-up text |
| `data/vector/` | source GeoPackages |
| `tools/` | `build_daily_data.py`, `build_geo.py`, `build_corridors_geojson.py` regenerate the data files |
