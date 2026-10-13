#!/usr/bin/env python3
"""webmap/data/vector/DRC_Ebola_Corridors_Updated_10_8_v2.gpkg -> webmap/data/corridors.geojson

One FeatureCollection; each feature carries layer=route|town|crossing so the
browser needs a single fetch. Routes keep their original colour (color_hex)
and are classed as `kind`: cross_border (Uganda-/South Sudan-bound, drawn
dashed) or domestic (solid). Coordinates rounded to 5 decimals.
"""
import json, math
from pathlib import Path
import geopandas as gpd

ROOT = Path(__file__).resolve().parent.parent      # the webmap/ folder
SRC = ROOT / "data" / "vector" / "DRC_Ebola_Corridors_Updated_10_8_v2.gpkg"
OUT = ROOT / "data" / "corridors.geojson"

def clean(v):
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return None
    return v

def clean_note(n):
    """Drop OSM provenance fragments ("OSM place/town node ...") from town notes."""
    if not n:
        return n
    n = n.replace("(OSM place node, ", "(")
    parts = [x.strip() for x in n.split(";") if "OSM place" not in x]
    return "; ".join(x for x in parts if x) or None

def feats(layer, name, props, kind=None):
    g = gpd.read_file(SRC, layer=layer).to_crs(4326)
    out = []
    for _, r in g.iterrows():
        p = {k: clean(r[k]) for k in props}
        if name == "town":
            p["notes"] = clean_note(p.get("notes"))
        p["layer"] = name
        if kind:
            p["kind"] = kind(r)
        geom = json.loads(gpd.GeoSeries([r.geometry]).to_json())["features"][0]["geometry"]
        out.append({"type": "Feature", "properties": p, "geometry": geom})
    return out

def kind(r):
    return "domestic" if str(r["category"]).lower().startswith("domestic") else "cross_border"

fc = {"type": "FeatureCollection", "features":
      feats("corridor_routes_10_8", "route",
            ["route_name", "category", "description", "evidence_tier", "color_hex", "map_number"], kind)
      + feats("towns_and_cities_10_8", "town", ["name", "country", "notes"])
      + feats("border_crossings_10_8", "crossing", ["crossing", "map_number", "notes"])}
txt = json.dumps(fc, ensure_ascii=False, separators=(",", ":"))
# round coordinates
import re
txt = re.sub(r"(\d+\.\d{5})\d+", r"\1", txt)
OUT.write_text(txt, encoding="utf-8")
print(len(fc["features"]), "features,", round(OUT.stat().st_size / 1e3), "KB")
