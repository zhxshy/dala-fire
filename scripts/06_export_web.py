"""Step 6: export compact files for the static web app (web/public/data/).

Inputs : data/interim/*.parquet|json|csv from steps 1-5
         data/raw/boundaries/osm_kz_admin4.geojson  (OpenStreetMap admin_level=4, exported with Overpass Turbo)
Outputs (web/public/data/):
  celldays.parquet   one row per (day, 0.01-degree cell) with any clean detection:
                     d (days since 2000-11-01), ci, cj (cell row/col, offset), h (harmonized cell-days,
                     VIIRS S-NPP scale), m (bitmask of sensors that saw fire: 1 Terra, 2 Aqua, 4 S-NPP,
                     8 NOAA-20, 16 NOAA-21), r (region index into regions.geojson, 255 = outside)
  days.json          per-day source of the harmonized value (VNP/VJ1/VJ2/MODIS/TERRA/AQUA/NONE)
  regions.geojson    simplified boundaries, names in en/kk/ru, ISO 3166-2 code
  hotspots_YYYY.parquet  clean detections per year, for the CSV download
  static_mask.json   centres of masked static-source cells (gas flares, plants), for a map layer
  model.json         factors, validation numbers, error-by-size band, data-through date
Parquet files use snappy compression, which the browser reader (hyparquet) reads natively.

AI-assistance note: drafted with an AI coding assistant (Claude) and reviewed by the author.
"""
import json

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import shapely
from shapely.geometry import mapping, shape

from common import INT, RAW, RES, ROOT

OUT = ROOT / "web" / "public" / "data"
OUT.mkdir(parents=True, exist_ok=True)
EPOCH = pd.Timestamp("2000-11-01")
SIMPLIFY = 0.005           # degrees (~0.5 km), keeps the shapes, cuts the file size
BIT = {"MODIS_T": 1, "MODIS_A": 2, "VNP": 4, "VJ1": 8, "VJ2": 16}


def write(table: pd.DataFrame, name: str):
    pq.write_table(pa.Table.from_pandas(table, preserve_index=False), OUT / name,
                   compression="snappy", row_group_size=200_000)


# --- regions -------------------------------------------------------------------------------------
osm = json.loads((RAW / "boundaries" / "osm_kz_admin4.geojson").read_text(encoding="utf-8"))
regions = []
for f in osm["features"]:
    if f["geometry"]["type"] not in ("Polygon", "MultiPolygon"):
        continue
    p = f["properties"]
    regions.append({"iso": p.get("ISO3166-2"), "en": p.get("name:en"), "kk": p.get("name"),
                    "ru": p.get("name:ru"), "geom": shape(f["geometry"])})
regions.sort(key=lambda r: r["en"])
feats = [{"type": "Feature", "id": i,
          "properties": {"id": i, "iso": r["iso"], "en": r["en"], "kk": r["kk"], "ru": r["ru"]},
          "geometry": mapping(shapely.set_precision(r["geom"].simplify(SIMPLIFY, preserve_topology=True), 1e-4))}
         for i, r in enumerate(regions)]
(OUT / "regions.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": feats},
                                                 ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

# --- cell-days: raw sensor bitmask + harmonized value + region -------------------------------------
cd = pd.read_parquet(INT / "celldays.parquet", columns=["sensor", "date", "ci", "cj"])
cd["bit"] = cd["sensor"].astype(str).map(BIT).astype("uint8")
raw = cd.groupby(["date", "ci", "cj"])["bit"].agg(lambda b: np.bitwise_or.reduce(b.to_numpy())).rename("m")
H = pd.read_parquet(INT / "harmonized_celldays.parquet").set_index(["date", "ci", "cj"])["h"]
t = pd.concat([raw, H], axis=1).fillna({"h": 0.0, "m": 0}).reset_index()

cells = t[["ci", "cj"]].drop_duplicates()
lat, lon = (cells["ci"].to_numpy() + 0.5) * RES, (cells["cj"].to_numpy() + 0.5) * RES
rid = np.full(len(cells), 255, dtype="uint8")
for i, r in enumerate(regions):
    shapely.prepare(r["geom"])
    rid[shapely.contains_xy(r["geom"], lon, lat) & (rid == 255)] = i
outside = rid == 255
if outside.any():                     # cells just over the border or the coast: nearest region
    tree = shapely.STRtree([r["geom"] for r in regions])
    near = tree.query_nearest(shapely.points(lon[outside], lat[outside]), max_distance=0.1, return_distance=False)
    rid[np.flatnonzero(outside)[near[0]]] = near[1]
cells["r"] = rid
t = t.merge(cells, on=["ci", "cj"])

CI0, CJ0 = int(t["ci"].min()), int(t["cj"].min())
web = pd.DataFrame({"d": (t["date"] - EPOCH).dt.days.astype("uint16"),
                    "ci": (t["ci"] - CI0).astype("uint16"), "cj": (t["cj"] - CJ0).astype("uint16"),
                    "h": t["h"].astype("float32"), "m": t["m"].astype("uint8"), "r": t["r"].astype("uint8")})
write(web.sort_values(["d", "ci", "cj"]), "celldays.parquet")

# --- day sources ----------------------------------------------------------------------------------
ds = pd.read_parquet(INT / "day_source.parquet")
ds = ds[ds["date"] >= EPOCH]
codes = ["NONE", "VNP", "VJ1", "VJ2", "MODIS", "TERRA", "AQUA"]
(OUT / "days.json").write_text(json.dumps({
    "epoch": str(EPOCH.date()), "first": str(ds["date"].min().date()), "last": str(ds["date"].max().date()),
    "codes": codes, "source": [codes.index(s) for s in ds["source"]]}, separators=(",", ":")))

# --- hotspots per year (CSV download) ------------------------------------------------------------
hs = pd.read_parquet(INT / "hotspots_clean.parquet",
                     columns=["lat", "lon", "date", "time", "sensor", "src", "conf_raw", "frp", "daynight"])
hs["sensor"] = hs["sensor"].astype(str)
hs["ci"], hs["cj"] = np.floor(hs["lat"] / RES).astype("int32"), np.floor(hs["lon"] / RES).astype("int32")
hs = hs.merge(cells, on=["ci", "cj"], how="left")
for y, g in hs.groupby(hs["date"].dt.year):
    out = pd.DataFrame({"date": g["date"].dt.strftime("%Y-%m-%d"), "time_utc": g["time"].astype(str),
                        "lat": g["lat"].round(4), "lon": g["lon"].round(4), "sensor": g["sensor"],
                        "src": g["src"].astype(str), "confidence": g["conf_raw"].astype(str),
                        "frp_mw": g["frp"].round(1), "daynight": g["daynight"].astype(str),
                        "r": g["r"].fillna(255).astype("uint8")})
    write(out, f"hotspots_{y}.parquet")

# --- static mask layer ----------------------------------------------------------------------------
mk = pd.read_parquet(INT / "static_mask_cells.parquet")
(OUT / "static_mask.json").write_text(json.dumps(
    np.round(np.c_[(mk["cj"] + 0.5) * RES, (mk["ci"] + 0.5) * RES], 3).tolist(), separators=(",", ":")))

# --- model + validation ---------------------------------------------------------------------------
strata = json.loads((INT / "strata.json").read_text())
val = json.loads((INT / "validation.json").read_text())
model = {"data_through": str(ds["date"].max().date()), "generated": pd.Timestamp.now(tz="UTC").isoformat(timespec="minutes"),
         "grid": {"res_deg": RES, "ci0": CI0, "cj0": CJ0, "epoch": str(EPOCH.date())},
         "regions": [{"id": i, "iso": r["iso"], "en": r["en"], "kk": r["kk"], "ru": r["ru"]} for i, r in enumerate(regions)],
         "factors": {"modis_to_vnp_national": strata["modis_to_vnp"]["k_national"],
                     "terra_bridge": strata["terra_bridge"]["b_national"], "aqua_bridge": strata["aqua_bridge"]["b_national"],
                     "vj1_to_vnp": strata["vj1_to_vnp"]["r"], "vj2_to_vnp": strata["vj2_to_vnp"]["r"],
                     "calibration_window": strata["modis_to_vnp"]["window"], "tile_deg": strata["tile_deg"]},
         "validation": val}
(OUT / "model.json").write_text(json.dumps(model, ensure_ascii=False, indent=1, default=str), encoding="utf-8")

sizes = {p.name: round(p.stat().st_size / 1e6, 2) for p in sorted(OUT.iterdir())}
print(f"regions: {len(regions)}; cells: {len(cells):,}, outside before nearest-match: {int(outside.sum())}")
print(f"celldays rows: {len(web):,}; harmonized total {web['h'].sum():,.0f}")
print("rows by region:\n", t.groupby("r").size().rename(lambda i: regions[i]["en"] if i < 255 else "outside").to_string())
print("\nfile sizes (MB):", json.dumps(sizes, indent=0))
print(f"total MB: {sum(sizes.values()):.1f}; largest: {max(sizes.values())}")
