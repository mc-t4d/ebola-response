# DRC Ebola (Bundibugyo) web map

Four static pages — `index.html` (Current Cumulative), `trends.html` (Daily / Weekly Trend), `weekly.html` (Weekly Case Growth: new cases per completed Mon–Sun week), `trend21.html` (21-Day Trend).
Serve the folder over HTTP (browsers block `fetch` from `file://`):

    python3 -m http.server      # then open http://localhost:8000

| Path | What |
|---|---|
| `js/app.js` | the map, legends, tracker, slider, modals |
| `js/config.js` | where the time series is read from (`data/series/` by default; a blob URL later) |
| `js/corridors.js` | towns, epicentre icons, animated routes (`data-overlays` on `<body>`) |
| `css/style.css` | all styling |
| `data/series/` | `national_daily.csv` + `zone_daily.csv`: the time series every page reads (one fetch). Compiled by the daily-map automation (`ebola_timeseries_export.py`) and published here by its publish step |
| `data/daily/` | the same data as one CSV per day + `manifest.csv`; fallback if `data/series/` cannot be loaded, or add `?data=legacy` to a page URL; see its README |
| `data/geo/` | zones / provinces / country / programme / South Sudan / Uganda (districts, response areas, border) / lakes GeoJSON + `zone_names.csv` |
| `data/corridors.geojson`, `data/modals.json` | overlays, pop-up text |
| `data/vector/` | source GeoPackages |
| `tools/` | `build_daily_data.py`, `build_geo.py`, `build_corridors_geojson.py` regenerate the data files |
