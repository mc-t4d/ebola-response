# Building the dashboard locally

Everything here was discovered getting a first build running on Windows; none
of it is inferable from the code. See [PROJECT_BRIEF.md](PROJECT_BRIEF.md) for
what the project is and [ENGINEERING_RULES.md](ENGINEERING_RULES.md) for the
standing rules.

## 1. Python environment

Requires Python 3.10+. Dependencies are `numpy`, `pandas`, `PyYAML`,
`python-docx`, `shapely` — note there is **no geopandas**: the province dissolve
uses shapely directly.

```bash
conda create -n ebola-webmap python=3.13 -y
conda activate ebola-webmap
pip install -r requirements.txt
pip install pytest          # not in requirements.txt, but the suite needs it
```

Do not install into conda `base`. It underpins every other environment, and
pip-installing into it is a reliable way to end up with a conda that cannot
solve its own dependencies.

`pip install -r requirements.txt` may warn that `packaging` and `certifi` are
missing for a geopandas that conda pulled in incidentally. Installing those two
silences it; nothing in this build imports geopandas.

## 2. Sibling data repo

`Scripts/common/paths.py` defaults `BUILD_DIR` to `../BDBV2026-Data/build`, so
the data repo must sit **beside** this one:

```
dev/
├── ebola_webmap/        <- this repo
└── BDBV2026-Data/       <- clone here
```

```bash
cd ..
GIT_LFS_SKIP_SMUDGE=1 git clone --filter=blob:none \
    https://github.com/INRB-UMIE/BDBV2026-Data.git
```

~338 MB. LFS there is scoped to `data/*/raw/**`, so skipping the smudge still
leaves `build/` complete — `build/drc_health_zones.geojson` comes down as real
GeoJSON, not a pointer. Override the location with `BUILD_DIR` if you put it
elsewhere.

## 3. Build

```bash
PYTHONUTF8=1 python Scripts/build_dashboard.py
```

**`PYTHONUTF8=1` is required on Windows.** The build prints progress containing
`≥` and `×`; on a cp1252 console that raises `UnicodeEncodeError` partway
through and kills the run. It is a console-encoding failure, not a data one.

Output lands in `output/` — 7 self-contained pages, ~14 MB each, ~98 MB total.
`output/` is gitignored.

### CARTO basemap key

As of 2026 CARTO's raster tiles need a key. Without one the build still
succeeds but warns:

```
warning: CARTO_BASEMAP_KEY not set -- basemap tiles will carry CARTO's 'API key required' watermark
```

Set `CARTO_BASEMAP_KEY` to get clean tiles. `build_dashboard.py` validates the
value and substitutes it into `engine.js` at build time. The key is a public
client-side credential — it ships to every visitor either way — so the
indirection buys rotation and repo hygiene, not secrecy.

## 4. Tests

```bash
PYTHONUTF8=1 pytest
```

`pytest.ini` puts `Scripts/` on the path; without it collection fails with
`ModuleNotFoundError: No module named 'common'`. Upstream's CI only builds and
never runs the suite, so nothing upstream configured this.

**Expected result: 1 failed, 146 passed.**
`test_phylo_tree.py::test_resolve_latest_phylogeny_tree_prefers_newest_egc`
fails on Windows with `FileExistsError` in a tmpdir fixture. It is pre-existing,
unrelated to any MC change, and sits in genomic code MC is dropping. Anything
beyond that one failure is a real regression.

## 5. Editing the theme

`Data/Branding/dashboard-theme.css` is upstream's 608-line layer kept verbatim,
wrapped by an MC header and an `MERCY CORPS OVERRIDES` section at the end. Read
the file header before editing — two rules there will otherwise fail the suite:

- no `--zone-*` / `--province-*` tokens in the MC section (they are locked to
  `engine.js` `themeVar()` fallbacks by `tests/test_zone_state_styling.py`)
- no `#tracker` rules there (`tests/test_tracker_headline.py` counts hue usages
  exactly)

To see the MC delta alone:

```bash
git diff upstream/main -- Data/Branding/dashboard-theme.css
```

## 6. Portal configuration

`config/portal.agol.yaml` holds portal URL, item IDs, service URLs, field maps,
class breaks and the time model; `portal.enterprise.yaml` inherits from it via
`extends:`. Switch with `MC_PORTAL_PROFILE=enterprise`. Per-value overrides —
`MC_PORTAL_URL`, `MC_LAYER_<KEY>_URL` — keep real endpoints out of the repo.

Check what is still unconfigured:

```bash
python Scripts/common/portal_config.py
```

## Upstream

`upstream` is a read-only remote for diffing, not for merging:

```bash
git remote add upstream https://github.com/INRB-UMIE/BDBV2026-Epidemic_Dashboard.git
git fetch upstream
git diff upstream/main -- <path>
```
