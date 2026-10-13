# Daily cumulative confirmed cases / deaths by health zone

`daily_<YYYY-MM-DD>_<INRB|Sitrep>.csv` — one file per day, 14 May → 6 Oct 2026 (146 files).
`manifest.csv` has one row per day: source, SitRep no., zone/national totals, QA diff, `provisional`, notes.

Columns: `zone,cases,deaths,national_cases,national_deaths` (daily-pipeline 5-column format).
`zone` = webmap `nom` (key of `data/geo/zones.geojson`). Cumulative values; only zones with
>= 1 confirmed case. National topline on the first data row only. Blank = not reported.

## Sources
- **INRB** — `INRB-UMIE/BDBV2026-Data/main/build/long/` (`insp_sitrep__cumulative_confirmed_{cases,deaths}.csv`,
  `insp_sitrep__national_cumulative_confirmed_{cases,deaths}.csv`). Used when zone rows exist on that date and
  zone sum (+ that date's `NA` bucket) equals the national total exactly (89 days; 15 May has no national total to check).
- **Sitrep** — INSP SitRep PDFs (insp.cd). Zone tables transcribed into `_raw/` (`sitrep_raw_<date>.csv`,
  `sitrep_meta_<date>.json`: SitRep no., PDF URL, notes) and normalised by `tools/build_daily_data.py`. Used when the
  PDF's zone table reconciles with its own national total (|diff| <= 5; non-zero diffs are inconsistencies printed in the PDF).

## Provisional days (`provisional=True` in the manifest, 18 days)
No source has zone-level data for these dates, so the zone columns are **carried forward** from the latest earlier
file (`carried_from`); the file carries the source label of that earlier file. National columns are the official
figure for that date where one exists, so zone sum and national total differ (see `qa_cases_diff`).
14 May (header only: national 8, no zone split), 16 May, 26 / 28 / 30 / 31 May, 3 Jun, 12 Jun, 26 Jun, 28 Jun,
12 Jul (SitRep zone table is the 10 Jul distribution), 28–29 Jul, 6–9 Aug (SitReps carry only province tables and maps),
3 Oct. Filter on `provisional` to drop them.

## Rules and caveats
- Per-zone as-of join; spelling variants collapsed (Mongbalu/Mongbwalu, Gethy/Gety, Nia Nia/Nia-Nia, Makiso-Kisangani,
  Kilo Mission/Kilo, ...); `Lubunga` = Lubunga (Tshopo). Aggregate buckets (NA, A ventiler, Autres, sans fiche,
  non identifiées) are not zone rows; their cases are in the manifest (`unattributed_cases`).
- Per-zone **deaths** are attributed-only and under-count the national total; May SitReps print no per-zone deaths.
- Zone values can fall between days where INSP reclassified cases (e.g. 22 Jul); values are as reported.

Rebuild: `python tools/build_daily_data.py [--long-dir <local clone of build/long>]`
