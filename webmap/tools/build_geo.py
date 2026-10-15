#!/usr/bin/env python3
"""GRID3 GeoPackages in data/vector -> the GeoJSON files the map loads from data/geo/.

  zones.geojson       519 health zones: nom (map key), name, province, program
  provinces.geojson   26 provinces (admin1)
  country.geojson     DRC border (admin0)
  programmes.geojson  zones carrying a Program (RESET / IERDC / SAFER)
  south_sudan.geojson South Sudan border (SSD_Admin_Boundaries_Counties_Payams.gpkg, admin0)
  south_sudan_counties.geojson  South Sudan counties (same file, admin2)
  roads.geojson       DRC national road network (osm_rdc_reseau_routier_national_230205.gpkg)

data/geo/zone_names.csv ties each GRID3 zone (zs_uid) to the `nom` used in the
daily CSVs; edit it if a zone is renamed. Needs geopandas + shapely>=2.1.

    python tools/build_geo.py
"""
import csv, json
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
                                       ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def main():
    with open(GEO / "zone_names.csv", encoding="utf-8", newline="") as f:
        names = {r["grid3_zs_uid"]: r for r in csv.DictReader(f)}

    zones = gpd.read_file(VEC / "GRID3_COD_health_zones_v9_0_with_programs.gpkg").to_crs(4326)
    simp = shapely.coverage_simplify(zones.geometry.make_valid().values, TOL)
    feats, prog = [], []
    for (_, r), g in zip(zones.iterrows(), simp):
        n = names[r.zs_uid]
        program = None if r.Program is None or str(r.Program) in ("None", "nan") else str(r.Program)
        feats.append({"type": "Feature", "geometry": geom_json(g),
                      "properties": {"nom": n["nom"], "name": n["name"], "province": n["province"], "program": program}})
        if program:
            prog.append({"type": "Feature", "geometry": geom_json(g),
                         "properties": {"nom": n["nom"], "program": program}})
    write("zones.geojson", feats)
    write("programmes.geojson", prog)

    prov = gpd.read_file(VEC / "GRID3_COD_provinces_admin1_dissolved.gpkg").to_crs(4326)
    ps = shapely.coverage_simplify(prov.geometry.make_valid().values, TOL)
    write("provinces.geojson", [{"type": "Feature", "properties": {"province": n}, "geometry": geom_json(g)}
                                for n, g in zip(prov.admin1_name, ps)])

    ctry = gpd.read_file(VEC / "GRID3_COD_country_admin0_dissolved.gpkg").to_crs(4326)
    cs = shapely.simplify(ctry.geometry.make_valid().values, TOL, preserve_topology=True)
    write("country.geojson", [{"type": "Feature", "properties": {"name": "Democratic Republic of the Congo"},
                               "geometry": geom_json(g)} for g in cs])
    ssd = gpd.read_file(VEC / "SSD_Admin_Boundaries_Counties_Payams.gpkg", layer="country_admin0").to_crs(4326)
    ss = shapely.simplify(ssd.geometry.make_valid().values, TOL, preserve_topology=True)
    write("south_sudan.geojson", [{"type": "Feature", "properties": {"name": "South Sudan"}, "geometry": geom_json(g)}
                                  for g in ss])
    cty = gpd.read_file(VEC / "SSD_Admin_Boundaries_Counties_Payams.gpkg", layer="counties_admin2").to_crs(4326)
    cs2 = shapely.coverage_simplify(cty.geometry.make_valid().values, TOL)
    write("south_sudan_counties.geojson", [
        {"type": "Feature", "properties": {"county": n, "state": st}, "geometry": geom_json(g)}
        for n, st, g in zip(cty.adm2_name, cty.adm1_name, cs2)])
    rd = gpd.read_file(VEC / "osm_rdc_reseau_routier_national_230205.gpkg").to_crs(4326)
    rs = shapely.simplify(rd.geometry.make_valid().values, TOL / 2, preserve_topology=True)
    write("roads.geojson", [{"type": "Feature", "properties": {"ref": r.ref or "", "name": r["name"] or ""}, "geometry": geom_json(g)}
                            for (_, r), g in zip(rd.iterrows(), rs)])
    print(f"zones {len(feats)}, programmes {len(prog)}, provinces {len(prov)}")


if __name__ == "__main__":
    main()
