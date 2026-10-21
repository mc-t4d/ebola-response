#!/usr/bin/env python3
"""GRID3 GeoPackages in data/vector -> the GeoJSON files the map loads from data/geo/.

  zones.geojson       519 health zones: nom (map key), name, province, program
  provinces.geojson   26 provinces (admin1)
  country.geojson     DRC border (admin0)
  programmes.geojson  zones carrying a Program (RESET / IERDC; SAFER is merged into IERDC)
  south_sudan.geojson South Sudan border (SSD_Admin_Boundaries_Counties_Payams.gpkg, admin0)
  south_sudan_counties.geojson  South Sudan counties (same file, admin2)
  roads.geojson       DRC national road network (osm_rdc_reseau_routier_national_230205.gpkg)
  uganda_districts.geojson       166 Uganda admin-2 units (uganda/UGA_UG.parquet; needs pyarrow)
  uganda_response_areas.geojson  7 Uganda response districts (uga_response_areas.gpkg)

data/geo/zone_names.csv ties each GRID3 zone (zs_uid) to the `nom` used in the
daily CSVs; edit it if a zone is renamed. Needs geopandas + shapely>=2.1.

    python tools/build_geo.py
    python tools/build_geo.py --uganda-only [--vector-dir DIR]   # just the two Uganda files
"""
import argparse, csv, json
from pathlib import Path
import geopandas as gpd
import shapely
from shapely.geometry import mapping

ROOT = Path(__file__).resolve().parent.parent          # the webmap/ folder
VEC, GEO = ROOT / "data" / "vector", ROOT / "data" / "geo"
TOL = 0.002          # degrees (~220 m) for coverage simplification
DECIMALS = 4         # ~11 m


def geom_json(g):
    return mapping(shapely.set_precision(g, 10 ** -DECIMALS))


def write(name, features):
    (GEO / name).write_text(json.dumps({"type": "FeatureCollection", "features": features},
                                       ensure_ascii=False, separators=(",", ":"), allow_nan=False), encoding="utf-8")   # NaN is not valid JSON


def build_uganda(vec):
    ug = gpd.read_parquet(vec / "uganda" / "UGA_UG.parquet").to_crs(4326)
    sg = shapely.coverage_simplify(ug.geometry.make_valid().values, TOL)
    write("uganda_districts.geojson", [
        {"type": "Feature", "geometry": geom_json(g),
         "properties": {"admin1": r.admin1, "admin2": r.admin2, "hasc_2": r.hasc_2 if isinstance(r.hasc_2, str) else None, "mc_operates": bool(r.mc_operates),
                        "mc_pg_country": bool(r.mc_pg_country), "mc_border_country": bool(r.mc_border_country)}}
        for (_, r), g in zip(ug.iterrows(), sg)])
    ra = gpd.read_file(vec / "uga_response_areas.gpkg").to_crs(4326)
    sr = shapely.coverage_simplify(ra.geometry.make_valid().values, TOL)
    write("uganda_response_areas.geojson", [
        {"type": "Feature", "geometry": geom_json(g),
         "properties": {"district": r.ADM2_EN, "region": r.ADM1_EN, "pcode": r.ADM2_PCODE}}
        for (_, r), g in zip(ra.iterrows(), sr)])
    print(f"uganda districts {len(ug)}, response areas {len(ra)}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vector-dir", type=Path, default=VEC, help="folder holding the source GeoPackages (default data/vector)")
    ap.add_argument("--uganda-only", action="store_true", help="only rebuild the two Uganda files")
    a = ap.parse_args()
    if a.uganda_only:
        return build_uganda(a.vector_dir)
    build_uganda(a.vector_dir)
    with open(GEO / "zone_names.csv", encoding="utf-8", newline="") as f:
        names = {r["grid3_zs_uid"]: r for r in csv.DictReader(f)}

    zones = gpd.read_file(a.vector_dir / "GRID3_COD_health_zones_v9_0_with_programs.gpkg").to_crs(4326)
    simp = shapely.coverage_simplify(zones.geometry.make_valid().values, TOL)
    feats, prog = [], []
    for (_, r), g in zip(zones.iterrows(), simp):
        n = names[r.zs_uid]
        program = None if r.Program is None or str(r.Program) in ("None", "nan") else str(r.Program)
        if program == "SAFER": program = "IERDC"       # SAFER zone is shown as part of IERDC
        feats.append({"type": "Feature", "geometry": geom_json(g),
                      "properties": {"nom": n["nom"], "name": n["name"], "province": n["province"], "program": program}})
        if program:
            prog.append({"type": "Feature", "geometry": geom_json(g),
                         "properties": {"nom": n["nom"], "program": program}})
    write("zones.geojson", feats)
    write("programmes.geojson", prog)

    prov = gpd.read_file(a.vector_dir / "GRID3_COD_provinces_admin1_dissolved.gpkg").to_crs(4326)
    ps = shapely.coverage_simplify(prov.geometry.make_valid().values, TOL)
    write("provinces.geojson", [{"type": "Feature", "properties": {"province": n}, "geometry": geom_json(g)}
                                for n, g in zip(prov.admin1_name, ps)])

    ctry = gpd.read_file(a.vector_dir / "GRID3_COD_country_admin0_dissolved.gpkg").to_crs(4326)
    cs = shapely.simplify(ctry.geometry.make_valid().values, TOL, preserve_topology=True)
    write("country.geojson", [{"type": "Feature", "properties": {"name": "Democratic Republic of the Congo"},
                               "geometry": geom_json(g)} for g in cs])
    ssd = gpd.read_file(a.vector_dir / "SSD_Admin_Boundaries_Counties_Payams.gpkg", layer="country_admin0").to_crs(4326)
    ss = shapely.simplify(ssd.geometry.make_valid().values, TOL, preserve_topology=True)
    write("south_sudan.geojson", [{"type": "Feature", "properties": {"name": "South Sudan"}, "geometry": geom_json(g)}
                                  for g in ss])
    cty = gpd.read_file(a.vector_dir / "SSD_Admin_Boundaries_Counties_Payams.gpkg", layer="counties_admin2").to_crs(4326)
    cs2 = shapely.coverage_simplify(cty.geometry.make_valid().values, TOL)
    write("south_sudan_counties.geojson", [
        {"type": "Feature", "properties": {"county": n, "state": st}, "geometry": geom_json(g)}
        for n, st, g in zip(cty.adm2_name, cty.adm1_name, cs2)])
    rd = gpd.read_file(a.vector_dir / "osm_rdc_reseau_routier_national_230205.gpkg").to_crs(4326)
    rs = shapely.simplify(rd.geometry.make_valid().values, TOL / 2, preserve_topology=True)
    write("roads.geojson", [{"type": "Feature", "properties": {"ref": r.ref or "", "name": r["name"] or ""}, "geometry": geom_json(g)}
                            for (_, r), g in zip(rd.iterrows(), rs)])
    print(f"zones {len(feats)}, programmes {len(prog)}, provinces {len(prov)}")


if __name__ == "__main__":
    main()
