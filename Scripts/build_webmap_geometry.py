#!/usr/bin/env python3
"""Swap the webmap's geometry for the GRID3 GeoPackages in webmap/data/vector.

Reads webmap/js/payload.js, replaces
  geometry             <- GRID3 health zones (519), joined to the existing
                          zone_data on province-disambiguated `nom`
  province_boundaries  <- GRID3 admin1 provinces (26)
  country_boundary     <- GRID3 admin0 (new)
  program_areas        <- zones carrying a Program (RESET / IERDC / SAFER)
and writes payload.js back. Idempotent. Needs geopandas + shapely>=2.1.

    python Scripts/build_webmap_geometry.py
"""
import json, re, sys, unicodedata
from pathlib import Path
import geopandas as gpd
import shapely
from shapely.geometry import mapping

ROOT = Path(__file__).resolve().parent.parent / "webmap"
VEC = ROOT / "data" / "vector"
PAYLOAD = ROOT / "js" / "payload.js"
TOL = 0.002          # degrees (~220 m) for coverage simplification
DECIMALS = 4         # ~11 m

# GRID3 spelling -> dashboard nom, where normalisation alone does not bridge it.
MANUAL = {("Wamba Luadi", "Kwango"): "Wamba Lwadi"}


def norm(x):
    x = unicodedata.normalize("NFKD", str(x)).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]", "", x)


def geom_json(g):
    g = shapely.set_precision(g, 10 ** -DECIMALS)
    return mapping(g)


def main():
    raw = PAYLOAD.read_text(encoding="utf-8")
    prefix = "window.__PAYLOAD__ = "
    d = json.loads(raw[len(prefix):].rstrip().rstrip(";"))
    old = d["geometry"]["features"]
    props = {f["properties"]["nom"]: f["properties"] for f in old}

    # lookup: (normalised name, normalised province) -> nom, by nom, name and
    # nom-without-"(Province)" suffix
    look = {}
    for nom, p in props.items():
        for label in {nom, p.get("name", nom), re.sub(r"\s*\(.*\)$", "", nom)}:
            look.setdefault((norm(label), norm(p["province"])), set()).add(nom)

    zones = gpd.read_file(VEC / "GRID3_COD_health_zones_v9_0_with_programs.gpkg").to_crs(4326)
    matched = {}
    for i, r in zones.iterrows():
        nom = MANUAL.get((r.zonesante, r.province))
        if nom is None:
            c = look.get((norm(r.zonesante), norm(r.province)), set())
            # disambiguated duplicates: prefer the nom that carries the province
            if len(c) > 1:
                c = {n for n in c if "(" in n} or c
            if len(c) != 1:
                sys.exit(f"cannot match {r.zonesante!r} / {r.province!r}: {c}")
            nom = next(iter(c))
        if nom in matched:
            sys.exit(f"duplicate match for {nom}")
        matched[nom] = i
    missing = set(props) - set(matched)
    if missing:
        sys.exit(f"dashboard zones without GRID3 geometry: {sorted(missing)}")

    geoms = zones.geometry.make_valid()
    simp = shapely.coverage_simplify(geoms.values, TOL)
    feats, prog = [], []
    for f in old:                                  # keep upstream order
        nom = f["properties"]["nom"]
        i = matched[nom]
        g = simp[zones.index.get_loc(i)]
        program = zones.loc[i, "Program"]
        program = None if program is None or str(program) in ("None", "nan") else str(program)
        p = dict(f["properties"]); p["program"] = program
        feats.append({"type": "Feature", "properties": p, "geometry": geom_json(g)})
        if program:
            prog.append({"type": "Feature", "properties": {"nom": nom, "program": program},
                         "geometry": geom_json(g)})
    d["geometry"] = {"type": "FeatureCollection", "features": feats}
    d["program_areas"] = {"type": "FeatureCollection", "features": prog}

    prov = gpd.read_file(VEC / "GRID3_COD_provinces_admin1_dissolved.gpkg").to_crs(4326)
    known = {p["province"] for p in props.values()}
    got = set(prov.admin1_name)
    if known != got:
        print("  note: province name mismatch", known ^ got)
    ps = shapely.coverage_simplify(prov.geometry.make_valid().values, TOL)
    d["province_boundaries"] = {"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {"province": n}, "geometry": geom_json(g)}
        for n, g in zip(prov.admin1_name, ps)]}

    ctry = gpd.read_file(VEC / "GRID3_COD_country_admin0_dissolved.gpkg").to_crs(4326)
    cs = shapely.simplify(ctry.geometry.make_valid().values, TOL, preserve_topology=True)
    d["country_boundary"] = {"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {"name": "Democratic Republic of the Congo"},
         "geometry": geom_json(g)} for g in cs]}

    PAYLOAD.write_text(prefix + json.dumps(d, ensure_ascii=False, separators=(",", ":")) + ";\n",
                       encoding="utf-8")
    print(f"zones {len(feats)}, programs {len(prog)}, provinces {len(prov)}, "
          f"payload {PAYLOAD.stat().st_size/1e6:.1f} MB")


if __name__ == "__main__":
    main()
