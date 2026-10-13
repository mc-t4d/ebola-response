#!/usr/bin/env python3
"""Build per-day cumulative case/death files for the webmap.

Output: webmap/data/daily/daily_<YYYY-MM-DD>_<INRB|Sitrep>.csv
        webmap/data/daily/manifest.csv   (one row per calendar day, incl. gaps)

File format = the daily pipeline's 5-column override format:
    zone,cases,deaths,national_cases,national_deaths
(national topline on the FIRST data row only; zone = webmap `nom`, i.e. the key
used by data/geo/zones.geojson; only zones with >=1 confirmed case.)

Sources
-------
INRB   : INRB-UMIE/BDBV2026-Data build/long/ (raw.githubusercontent.com):
         insp_sitrep__cumulative_confirmed_{cases,deaths}.csv (per zone) and
         insp_sitrep__national_cumulative_confirmed_{cases,deaths}.csv,
         insp_sitrep__national_cumulative_recovered_cases.csv.
         Used for a date only when the long file has zone rows ON that date and
         zone-sum (+ the 'NA' bucket row of that date) == national cases exactly.
Sitrep : INSP SitRep PDFs (insp.cd), zone tables transcribed into
         data/daily/_raw/sitrep_raw_<date>.csv + sitrep_meta_<date>.json.
         Used for every other date that has a zone table which reconciles with
         the report's own national topline (|diff| <= SITREP_TOL, source typos).
Dates with neither are listed in manifest.csv with the reason; nothing is
interpolated or carried forward.

Conventions (see ebola-weekly-caseload skill): per-zone as-of join; spelling
variants collapsed to one canonical key (stale + live rows); Lubunga -> the
Tshopo zone; aggregate buckets (NA / A ventiler / Autres / sans fiche /
non identifiees) excluded from zone rows and reported in the manifest.

    python tools/build_daily_data.py [--long-dir DIR]   # default: raw URL
"""
import argparse, csv, io, json, re, sys, unicodedata, urllib.request
from pathlib import Path
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent      # the webmap/ folder
OUT = ROOT / "data" / "daily"
RAW = OUT / "_raw"
ZONES = ROOT / "data" / "geo" / "zone_names.csv"
RAW_URL = "https://raw.githubusercontent.com/INRB-UMIE/BDBV2026-Data/main/build/long/"
START = pd.Timestamp("2026-05-14")
SITREP_TOL = 5

def norm(x):
    x = unicodedata.normalize("NFKD", str(x)).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]", "", x)

BUCKETS = ("na", "aventiler", "autres", "echantillonssansfiche", "sansfiche",
           "zsnonidentifiee", "nonidentifiees", "autreszones", "autreszs")
def is_bucket(name):
    n = norm(name)
    return n == "na" or any(n.startswith(b) for b in BUCKETS[1:])

# spelling variants not covered by punctuation-insensitive matching
EXTRA = {"Mongbalu": "Mongbwalu", "Gethy": "Gety", "Rwmapara": "Rwampara",
         "Manguripa": "Manguredjipa", "Rumba": "Rimba", "Tchomai": "Tchomia",
         "Kilo Mission": "Kilo", "Karissibi": "Karisimbi"}

def load_noms():
    with open(ZONES, encoding="utf-8", newline="") as f:
        return [(r["nom"], r["province"]) for r in csv.DictReader(f)]

NOMS = load_noms()
IDX = {}
for nom, prov in NOMS:
    for label in {nom, re.sub(r"\s*\(.*\)$", "", nom)}:
        IDX.setdefault(norm(label), []).append((nom, prov))

def resolve(raw, province=None):
    """upstream / SitRep zone name -> webmap nom (None for buckets, '?x' if unknown)."""
    if is_bucket(raw):
        return None
    if raw in ("Lubunga", "Lubunga (Tshopo)"):
        return "Lubunga (Tshopo)"
    c = IDX.get(norm(EXTRA.get(raw, raw)))
    if not c:
        return "?" + raw
    c = list(dict.fromkeys(c))
    if len(c) > 1 and province:
        pc = [x for x in c if norm(x[1]) == norm(province)]
        c = pc or c
    if len(c) > 1:
        c = [x for x in c if "(" not in x[0]] or c
    return c[0][0]

def read_long(name, long_dir):
    if long_dir:
        text = (Path(long_dir) / name).read_text(encoding="utf-8-sig")
    else:
        with urllib.request.urlopen(RAW_URL + name, timeout=90) as r:
            text = r.read().decode("utf-8-sig")
    rows = []
    for r in csv.reader(io.StringIO(text)):
        if len(r) == 3 and re.fullmatch(r"\d{4}-\d{2}-\d{2}\]?", r[1].strip()):   # one row has a stray ']'
            rows.append((r[0].strip(), r[1].strip().rstrip("]"), r[2].strip()))
    df = pd.DataFrame(rows, columns=["nom", "date", "val"])
    df["date"] = pd.to_datetime(df["date"])
    df["val"] = pd.to_numeric(df["val"], errors="coerce")        # 'ND' -> NaN
    return df.dropna(subset=["val"])

def asof(df, D):
    s = df[df["date"] <= D]
    if s.empty:
        return pd.Series(dtype=float)
    return s.loc[s.groupby("key")["date"].idxmax()].set_index("key")["val"]

def write_daily(path, cases, deaths, nat_c, nat_d):
    zones = sorted(z for z, v in cases.items() if v and v > 0)
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["zone", "cases", "deaths", "national_cases", "national_deaths"])
        for i, z in enumerate(zones):
            d = deaths.get(z)
            w.writerow([z, int(cases[z]), "" if d is None or pd.isna(d) else int(d),
                        "" if i or nat_c is None else int(nat_c),
                        "" if i or nat_d is None else int(nat_d)])
    return len(zones)

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--long-dir"); a = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)

    c = read_long("insp_sitrep__cumulative_confirmed_cases.csv", a.long_dir)
    d = read_long("insp_sitrep__cumulative_confirmed_deaths.csv", a.long_dir)
    nc = read_long("insp_sitrep__national_cumulative_confirmed_cases.csv", a.long_dir).set_index("date")["val"]
    nd = read_long("insp_sitrep__national_cumulative_confirmed_deaths.csv", a.long_dir).set_index("date")["val"]
    nr = read_long("insp_sitrep__national_cumulative_recovered_cases.csv", a.long_dir).set_index("date")["val"]
    for df in (c, d):
        df["key"] = df["nom"].map(resolve)
    bad = sorted(set(c.loc[c.key.fillna("").str.startswith("?"), "nom"]) | set(d.loc[d.key.fillna("").str.startswith("?"), "nom"]))
    if bad:
        sys.exit(f"unresolved INRB zone names: {bad}")
    na = c[c.key.isna()].set_index("date")["val"]
    c, d = c.dropna(subset=["key"]), d.dropna(subset=["key"])
    zdates = set(c["date"])
    last = max(nc.index.max(), c["date"].max())

    for old in OUT.glob("daily_*.csv"):      # only after every download above succeeded
        old.unlink()

    # ---- SitRep raw
    sit = {}
    for mp in sorted(RAW.glob("sitrep_meta_*.json")):
        m = json.loads(mp.read_text(encoding="utf-8"))
        rows = list(csv.DictReader(open(RAW / f"sitrep_raw_{m['date']}.csv", encoding="utf-8")))
        sit[pd.Timestamp(m["date"])] = (m, rows)
    last = max([last] + list(sit))

    manifest, problems = [], []
    for D in pd.date_range(START, last):
        ds = D.strftime("%Y-%m-%d")
        row = {"date": ds, "day": (D - START).days, "source": "", "file": "", "sitrep_no": "",
               "zones": "", "zone_cases_sum": "", "unattributed_cases": "", "national_cases": "",
               "national_deaths": "", "national_recovered": "", "qa_cases_diff": "", "notes": ""}
        # ---- INRB?
        inrb_ok = False
        if D in zdates and D in nc.index:
            z = asof(c, D); zs = int(z.sum()); nav = int(na.get(D, 0))
            if zs + nav == int(nc[D]):
                inrb_ok = True
                dz = asof(d, D)
                cases = {k: v for k, v in z.items()}
                fn = f"daily_{ds}_INRB.csv"
                n = write_daily(OUT / fn, cases, dz.to_dict(), nc[D], nd.get(D))
                row.update(source="INRB", file=fn, zones=n, zone_cases_sum=zs, unattributed_cases=nav,
                           national_cases=int(nc[D]), national_deaths="" if D not in nd.index else int(nd[D]),
                           national_recovered="" if D not in nr.index else int(nr[D]), qa_cases_diff=0)
        elif D in zdates and D not in nc.index and not (D in sit and sit[D][0]["found"]):
            # zone rows exist on this date but there is no national total to check
            # them against (15 May): accept, flagged in the notes.
            z = asof(c, D); zs = int(z.sum())
            if zs > 0:
                inrb_ok = True
                fn = f"daily_{ds}_INRB.csv"
                n = write_daily(OUT / fn, z.to_dict(), asof(d, D).to_dict(), None, None)
                row.update(source="INRB", file=fn, zones=n, zone_cases_sum=zs,
                           notes="no national total for this date; zone sum unchecked")
        if inrb_ok:
            manifest.append(row); continue
        # ---- Sitrep?
        m_rows = sit.get(D)
        why = []
        if D in zdates and D in nc.index:
            z = asof(c, D); why.append(f"INRB zone sum {int(z.sum())}+NA {int(na.get(D,0))} != national {int(nc[D])}")
        elif D in nc.index:
            why.append("INRB has national total but no zone rows")
        else:
            why.append("not in INRB")
        if not m_rows or not m_rows[0]["found"]:
            row["notes"] = "; ".join(why + ["no SitRep published for this date"]); manifest.append(row); continue
        m, rows = m_rows
        row.update(sitrep_no=m["sitrep_no"] or "", national_cases=m["national_cases"] or "",
                   national_deaths="" if m["national_deaths"] is None else m["national_deaths"],
                   national_recovered="" if m["national_recovered"] is None else m["national_recovered"])
        cases, deaths, unattr = {}, {}, 0
        for r in rows:
            nm = resolve(r["zone"], r["province"])
            cv = int(r["cases"]) if r["cases"].strip() else None
            dv = int(r["deaths"]) if r["deaths"].strip() else None
            if nm is None:
                unattr += cv or 0; continue
            if nm.startswith("?"):
                problems.append((ds, r["zone"], r["province"])); continue
            if cv is not None:
                cases[nm] = cases.get(nm, 0) + cv
            if dv is not None:
                deaths[nm] = deaths.get(nm, 0) + dv
        zs = sum(cases.values())
        if not rows or m["national_cases"] is None:
            row["notes"] = "; ".join(why + ["SitRep found (#%s) but has no zone-level table" % m["sitrep_no"]])
            manifest.append(row); continue
        diff = m["national_cases"] - zs - unattr
        row.update(zone_cases_sum=zs, unattributed_cases=unattr, qa_cases_diff=diff)
        if abs(diff) > SITREP_TOL:
            row["notes"] = "; ".join(why + [f"SitRep #{m['sitrep_no']} zone table does not reconcile with national (diff {diff}); withheld. " + m["notes"][:200]])
            manifest.append(row); continue
        fn = f"daily_{ds}_Sitrep.csv"
        n = write_daily(OUT / fn, cases, deaths, m["national_cases"], m["national_deaths"])
        row.update(source="Sitrep", file=fn, zones=n)
        row["notes"] = "; ".join(why + ([f"source inconsistency, diff {diff}"] if diff else []))
        manifest.append(row)

    # ---- provisional carry-forward for dates with no usable zone-level source.
    # The zone columns are the latest earlier file's values (as-of join); the
    # national topline is the official figure for that date when one exists.
    # These files are labelled with the source of the data they carry and are
    # flagged provisional=True (with carried_from) in manifest.csv.
    last_row = None
    for row in manifest:
        row.setdefault("provisional", False); row.setdefault("carried_from", "")
        if row["file"]:
            last_row = row; continue
        D = pd.Timestamp(row["date"])
        if D in nc.index:
            row["national_cases"] = int(nc[D])
            row["national_deaths"] = int(nd[D]) if D in nd.index else row["national_deaths"]
            row["national_recovered"] = int(nr[D]) if D in nr.index else row["national_recovered"]
        nat_c = row["national_cases"] if row["national_cases"] != "" else None
        nat_d = row["national_deaths"] if row["national_deaths"] != "" else None
        if last_row is None:
            src, cases, deaths, frm = "INRB", {}, {}, ""
        else:
            prev = pd.read_csv(OUT / last_row["file"])
            src, frm = last_row["source"], last_row["date"]
            cases = dict(zip(prev.zone, prev.cases)); deaths = dict(zip(prev.zone, prev.deaths))
        fn = f"daily_{row['date']}_{src}.csv"
        n = write_daily(OUT / fn, cases, deaths, nat_c, nat_d)
        zs = int(sum(cases.values()))
        row.update(source=src, file=fn, zones=n, zone_cases_sum=zs, provisional=True, carried_from=frm,
                   qa_cases_diff="" if nat_c is None else int(nat_c) - zs,
                   notes=(row["notes"] + "; " if row["notes"] else "") +
                         (f"PROVISIONAL: zone values carried forward from {frm}" if frm else
                          "PROVISIONAL: no zone-level data exists yet (header only)"))
        # a carried file is never itself the origin for the next gap day
        last_row = {"file": last_row["file"] if last_row else fn, "source": src, "date": frm or row["date"]}

    mf = pd.DataFrame(manifest)
    for col in ("sitrep_no", "zones", "zone_cases_sum", "unattributed_cases", "national_cases", "national_deaths", "national_recovered", "qa_cases_diff"):
        mf[col] = pd.to_numeric(mf[col], errors="coerce").astype("Int64")
    mf.to_csv(OUT / "manifest.csv", index=False)
    print(mf.source.replace("", "NONE").value_counts().to_string())
    if problems:
        print("UNRESOLVED SitRep names:", problems)

if __name__ == "__main__":
    main()
