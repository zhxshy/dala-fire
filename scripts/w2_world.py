"""World layer, step 2: outages, harmonization, validation and export of the monthly world record.

Usage : python w2_world.py
Inputs: data/world/daily/<year>.parquet, data/world/raw_counts/<year>.parquet   (from w1_fetch.py)
Output: web/public/data/world/monthly.parquet   ym, gi, gj, h, m, v, r  (one row per month and 0.5 degree cell)
        web/public/data/world/model.json        grid, months, countries, factors, validation
        web/public/data/world/countries.geojson
        data/world/validation_world.json, data/world/loyo_by_region.csv

Same method and settings as for Kazakhstan, nothing retuned: MODIS fire cell-days are put on the Suomi NPP VIIRS
scale with one factor per 3-degree tile, k = (sum V + 200 k0) / (sum M + 200), fitted on days in 2012-01-20 ..
2021-12-31 when Terra, Aqua and S-NPP all delivered data. A second model with a factor per tile and calendar
month (shrunk toward the tile factor) is tested next to it; it is used only if it lowers the leave-one-year-out
tile error by more than half a percentage point (rule fixed before the first world run).
Outages: a satellite-day counts as missing when it has no detections worldwide, fewer than a quarter of the
31-day median, or is on the FIRMS missing-data list. Regional outages are not detected.
Each day uses the best source: S-NPP, then NOAA-20 (tied to S-NPP per tile), then Terra+Aqua x k, then one
MODIS x bridge x k. Daily values are summed to months.

AI-assistance note: drafted with an AI coding assistant (Claude) and reviewed by the author.
"""
import json
import os
import shutil
from datetime import datetime, timezone

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import shapely
from shapely.geometry import shape

from pathlib import Path

from common import ROOT

IN = Path(os.environ["DALA_WORLD"]) if os.environ.get("DALA_WORLD") else ROOT / "data" / "world"
WEB = ROOT / "web" / "public" / "data" / "world"
RES, TILE, LAM = 0.5, 6, 200.0                      # cell size (deg), cells per 3-degree tile, shrinkage
CAL = ("2012-01-20", "2021-12-31")
BRIDGE = ("2003-01-01", "2011-12-31")
LOW_FRACTION, WINDOW = 0.25, 31
MONTH_MODEL_MIN_GAIN = 0.5                          # percentage points of tile error
EDGES = [3, 10, 30, 100, 300, 1000, 3000, np.inf]
FIRMS_SAT = {"Terra (MODIS)": "MODIS_T", "Aqua (MODIS)": "MODIS_A", "Suomi NPP (VIIRS)": "VNP", "NOAA-20 (VIIRS)": "VJ1"}
REGIONS = [  # name, lon west, lon east, lat south, lat north; first match wins (tile centre)
    ("North America", -170, -50, 15, 75), ("South America", -95, -30, -60, 15), ("Europe", -12, 40, 35, 72),
    ("Africa, north of the equator", -20, 52, 0, 35), ("Africa, south of the equator", 5, 52, -36, 0),
    ("Northern and Central Asia", 40, 180, 40, 78), ("South Asia", 60, 92, 5, 40),
    ("East and Southeast Asia", 92, 155, -11, 40), ("Australia and Oceania", 110, 180, -48, -11),
]

files = sorted((IN / "daily").glob("*.parquet"))
if not files:
    raise SystemExit("No data/world/daily/*.parquet yet: run w1_fetch.py first.")

# --- 1. which satellite delivered data on which day --------------------------------------------------------------
raw = pd.concat([pd.read_parquet(p) for p in sorted((IN / "raw_counts").glob("*.parquet"))])
raw = raw.groupby(["sensor", "date"])["n"].sum()
days = pd.date_range(raw.index.get_level_values("date").min(), raw.index.get_level_values("date").max())
missing = pd.read_csv(ROOT / "scripts" / "ref" / "firms_missing_dates.csv", parse_dates=["date"])
missing["sensor"] = missing["satellite"].map(FIRMS_SAT)
up = pd.DataFrame(False, index=days, columns=["MODIS_T", "MODIS_A", "VNP", "VJ1"])
gaps = {}
for s in up.columns:
    if s not in raw.index.get_level_values("sensor"):
        continue
    c = raw[s]
    c = c.reindex(pd.date_range(c.index.min(), c.index.max()), fill_value=0)
    med = c.rolling(WINDOW, center=True, min_periods=7).median()
    ok = (c > 0) & (c >= LOW_FRACTION * med)
    ok[ok.index.isin(missing.loc[missing["sensor"] == s, "date"])] = False
    up.loc[ok.index, s] = ok.values
    gaps[s] = int((~ok).sum())
src = np.select([up["VNP"], up["VJ1"], up["MODIS_T"] & up["MODIS_A"], up["MODIS_T"], up["MODIS_A"]], ["V", "J", "M", "T", "A"], "N")
src = pd.Series(src, index=days)
both = up["MODIS_T"] & up["MODIS_A"]
cal_days = days[(both & up["VNP"]).to_numpy() & (days >= CAL[0]) & (days <= CAL[1])]
bridge_days = days[both.to_numpy() & (days >= BRIDGE[0]) & (days <= BRIDGE[1])]
vj_days = days[(up["VNP"] & up["VJ1"]).to_numpy()]
print(f"days {days[0].date()} .. {days[-1].date()}; missing satellite-days {gaps}")
print(f"calibration days {len(cal_days)}, bridge days {len(bridge_days)}, S-NPP + NOAA-20 days {len(vj_days)}")
print("days by source:", src.value_counts().to_dict())


def with_keys(df):
    df["tile"] = ((df["gi"] // TILE + 100).astype("int32") * 1000 + (df["gj"] // TILE + 200)).astype("int32")
    return df


# --- 2. sums for the fits (one pass over the yearly files) -------------------------------------------------------
cal, bridge, vj = [], [], []
for p in files:
    df = with_keys(pd.read_parquet(p))
    d = df[df["date"].isin(cal_days)]
    if len(d):
        cal.append(d.assign(year=d["date"].dt.year, month=d["date"].dt.month)
                    .groupby(["tile", "year", "month"])[["nM", "nV"]].sum().reset_index())
    d = df[df["date"].isin(bridge_days)]
    if len(d):
        bridge.append(d.groupby("tile")[["nM", "nT", "nA"]].sum().reset_index())
    d = df[df["date"].isin(vj_days)]
    if len(d):
        vj.append(d.groupby("tile")[["nV", "nJ"]].sum().reset_index())
cal = pd.concat(cal, ignore_index=True).rename(columns={"nM": "M", "nV": "V"})
bridge = pd.concat(bridge).groupby("tile").sum() if bridge else pd.DataFrame(columns=["nM", "nT", "nA"])
vj = pd.concat(vj).groupby("tile").sum() if vj else pd.DataFrame(columns=["nV", "nJ"])


def region_of(tile):
    lat = ((tile // 1000 - 100) * TILE + TILE / 2) * RES
    lon = ((tile % 1000 - 200) * TILE + TILE / 2) * RES
    out = np.full(len(tile), "Other", dtype=object)
    for name, w, e, s, n in reversed(REGIONS):
        out[(lon >= w) & (lon < e) & (lat >= s) & (lat < n)] = name
    return out


def fit(tr):
    """Global factor, tile factors and tile x month factors from a table of (tile, month, M, V) sums."""
    k0 = tr["V"].sum() / tr["M"].sum()
    t = tr.groupby("tile")[["V", "M"]].sum()
    k_t = ((t["V"] + LAM * k0) / (t["M"] + LAM)).rename("k_t")
    tm = tr.groupby(["tile", "month"])[["V", "M"]].sum().join(k_t, on="tile")
    k_tm = ((tm["V"] + LAM * tm["k_t"]) / (tm["M"] + LAM)).rename("k_tm")
    return k0, k_t, k_tm


def predict(te, k0, k_t, k_tm):
    te = te.join(k_t, on="tile").join(k_tm, on=["tile", "month"])
    te["k_t"] = te["k_t"].fillna(k0)
    te["k_tm"] = te["k_tm"].fillna(te["k_t"])
    return te.assign(p_naive=te["M"], p_global=te["M"] * k0, p_tile=te["M"] * te["k_t"], p_tile_month=te["M"] * te["k_tm"])


# --- 3. leave-one-year-out test ----------------------------------------------------------------------------------
MODELS = ["naive", "global", "tile", "tile_month"]
years = sorted(cal["year"].unique())
pred = pd.concat([predict(cal[cal["year"] == y].copy(), *fit(cal[cal["year"] != y])) for y in years], ignore_index=True)
pred["region"] = region_of(pred["tile"].to_numpy())
mape = lambda p, v: 100 * float(np.median(np.abs(p / v - 1)))
COLS = ["p_" + m for m in MODELS] + ["V"]
g = pred.groupby("year")[COLS].sum()
ty = pred.groupby(["tile", "year"])[COLS].sum()
ty = ty[ty["V"] >= 200]
tmn = pred[pred["V"] >= 200]
loyo = {m: {"global_median_abs_pct": round(mape(g["p_" + m], g["V"]), 1),
            "global_max_abs_pct": round(100 * float(np.abs(g["p_" + m] / g["V"] - 1).max()), 1),
            "tile_median_abs_pct": round(mape(ty["p_" + m], ty["V"]), 1),
            "tile_p90_abs_pct": round(100 * float(np.percentile(np.abs(ty["p_" + m] / ty["V"] - 1), 90)), 1),
            "tile_month_median_abs_pct": round(mape(tmn["p_" + m], tmn["V"]), 1)} for m in MODELS}
gain = loyo["tile"]["tile_median_abs_pct"] - loyo["tile_month"]["tile_median_abs_pct"]
CHOSEN = "tile_month" if gain > MONTH_MODEL_MIN_GAIN else "tile"
PC = "p_" + CHOSEN

ry = pred.groupby(["region", "year"])[COLS].sum()
by_region = []
for name, d in ry.groupby(level="region"):
    row = {"region": name, "tiles": int(pred.loc[pred["region"] == name, "tile"].nunique()),
           "viirs_celldays_per_year": int(d["V"].sum() / len(years))}
    for m in MODELS:
        row[m] = round(mape(d["p_" + m], d["V"]), 1)
    row["bias_chosen_pct"] = round(100 * float(d[PC].sum() / d["V"].sum() - 1), 1)
    by_region.append(row)
by_region = sorted(by_region, key=lambda r: -r["viirs_celldays_per_year"])

units = pd.concat([pred.groupby(["tile", "year"])[[PC, "V"]].sum(), pred[[PC, "V"]]], ignore_index=True)   # tile-years and tile-months
units = units[units[PC] >= EDGES[0]].copy()
units["bin"] = pd.cut(units[PC], EDGES, right=False, labels=[f"{a}-{b}" if np.isfinite(b) else f"{a}+" for a, b in zip(EDGES, EDGES[1:])])
ratio = (units["V"] / units[PC])
bands = [{"size": str(b), "n": int(len(r)), "p10": round(float(r.quantile(0.1)), 3), "p50": round(float(r.quantile(0.5)), 3),
          "p90": round(float(r.quantile(0.9)), 3)} for b, r in ratio.groupby(units["bin"], observed=True)]

back = {}
k0b, ktb, ktmb = fit(cal[cal["year"].between(2014, 2021)])
for y in (2012, 2013):
    if y in years:
        te = predict(cal[cal["year"] == y].copy(), k0b, ktb, ktmb)
        back[str(y)] = round(100 * float(te[PC].sum() / te["V"].sum() - 1), 1)

# --- 4. production factors and the record ------------------------------------------------------------------------
k0, k_t, k_tm = fit(cal)
bT0, bA0 = bridge["nM"].sum() / max(bridge["nT"].sum(), 1), bridge["nM"].sum() / max(bridge["nA"].sum(), 1)
bT = ((bridge["nM"] + LAM * bT0) / (bridge["nT"] + LAM)).rename("bT")
bA = ((bridge["nM"] + LAM * bA0) / (bridge["nA"] + LAM)).rename("bA")
r0 = vj["nV"].sum() / max(vj["nJ"].sum(), 1)
rJ = ((vj["nV"] + LAM * r0) / (vj["nJ"] + LAM)).rename("rJ")

monthly = []
for p in files:
    df = with_keys(pd.read_parquet(p))
    df["month"] = df["date"].dt.month
    df = df.join(k_t, on="tile").join(bT, on="tile").join(bA, on="tile").join(rJ, on="tile")
    if CHOSEN == "tile_month":
        df = df.join(k_tm, on=["tile", "month"])
        df["k"] = df["k_tm"].fillna(df["k_t"]).fillna(k0)
    else:
        df["k"] = df["k_t"].fillna(k0)
    s = src.reindex(df["date"]).to_numpy()
    df["h"] = np.select([s == "V", s == "J", s == "M", s == "T", s == "A"],
                        [df["nV"], df["nJ"] * df["rJ"].fillna(r0), df["nM"] * df["k"],
                         df["nT"] * df["bT"].fillna(bT0) * df["k"], df["nA"] * df["bA"].fillna(bA0) * df["k"]], 0.0)
    df["ym"] = df["date"].dt.year * 12 + df["date"].dt.month - 1
    monthly.append(df.groupby(["ym", "gi", "gj"]).agg(h=("h", "sum"), m=("nM", "sum"), v=("nV", "sum")).reset_index())
rec = pd.concat(monthly, ignore_index=True)
rec = rec[(rec["h"] > 0) | (rec["m"] > 0) | (rec["v"] > 0)]

meta = pd.DataFrame({"ym": days.year * 12 + days.month - 1, "with_data": (src != "N").to_numpy(),
                     "modelled": src.isin(["M", "T", "A"]).to_numpy()})
meta = meta.groupby("ym").agg(days=("with_data", "size"), with_data=("with_data", "sum"), modelled=("modelled", "sum")).reset_index()
ym0 = int(meta["ym"].min())
months = [{"key": f"{ym // 12}-{ym % 12 + 1:02d}", "days": int(d), "with_data": int(w), "modelled": int(m)}
          for ym, d, w, m in meta.itertuples(index=False)]

yr = rec.assign(year=rec["ym"] // 12).groupby("year")[["h", "m", "v"]].sum()
seam = ({"naive_splice": round(float(yr.at[2012, "v"] / yr.at[2011, "m"]), 2), "modis_only": round(float(yr.at[2012, "m"] / yr.at[2011, "m"]), 2),
         "harmonized": round(float(yr.at[2012, "h"] / yr.at[2011, "h"]), 2)} if 2011 in yr.index and 2012 in yr.index else None)

# --- 5. countries and export -------------------------------------------------------------------------------------
world = json.loads((ROOT / "scripts" / "ref" / "countries_110m.geojson").read_text())
geoms = np.array([shape(f["geometry"]) for f in world["features"]])
tree = shapely.STRtree(geoms)
MAX_SITE_MB = 45          # the browser loads this file whole; above this the grid is coarsened to 1 degree
WEB.mkdir(parents=True, exist_ok=True)


def export(rec, coarsen):
    """Write the monthly table on a grid of RES * coarsen degrees; returns (rows, grid origin, cell size, MB)."""
    res = RES * coarsen
    if coarsen > 1:
        rec = rec.assign(gi=rec["gi"] // coarsen, gj=rec["gj"] // coarsen).groupby(["ym", "gi", "gj"])[["h", "m", "v"]].sum().reset_index()
    cells = rec[["gi", "gj"]].drop_duplicates().reset_index(drop=True)
    lat, lon = (cells["gi"] + 0.5) * res, (cells["gj"] + 0.5) * res
    cells["r"] = 255
    for shift in (360, 0):                                         # polygons that cross the date line run past 180 degrees
        inside = tree.query(shapely.points(lon + shift, lat), predicate="within")
        cells.loc[inside[0], "r"] = inside[1]                      # pairs (point index, polygon index)
    out = cells["r"].eq(255).to_numpy()
    if out.any():                                                  # coastal cells: nearest country within 0.75 degree
        near = tree.query_nearest(shapely.points(lon[out], lat[out]), max_distance=0.75, all_matches=False)
        cells.loc[np.flatnonzero(out)[near[0]], "r"] = near[1]
    rec = rec.merge(cells, on=["gi", "gj"]).sort_values(["ym", "gi", "gj"]).reset_index(drop=True)
    gi0, gj0 = int(rec["gi"].min()), int(rec["gj"].min())
    table = pa.table({"ym": (rec["ym"] - ym0).to_numpy("uint16"), "gi": (rec["gi"] - gi0).to_numpy("uint16"),
                      "gj": (rec["gj"] - gj0).to_numpy("uint16"), "h": rec["h"].to_numpy("float32"),
                      "m": rec["m"].to_numpy("int32"), "v": rec["v"].to_numpy("int32"), "r": rec["r"].to_numpy("uint8")})
    pq.write_table(table, WEB / "monthly.parquet", compression="snappy", row_group_size=200_000)
    return rec, gi0, gj0, res, (WEB / "monthly.parquet").stat().st_size / 1e6


rec05 = rec
rec, gi0, gj0, SITE_RES, size = export(rec05, 1)
if size > MAX_SITE_MB:
    print(f"monthly.parquet is {size:.0f} MB at {RES} degrees: writing it at {2 * RES} degrees instead")
    rec, gi0, gj0, SITE_RES, size = export(rec05, 2)
shutil.copyfile(ROOT / "scripts" / "ref" / "countries_110m.geojson", WEB / "countries.geojson")

validation = {"years_tested": [int(years[0]), int(years[-1])], "calibration_days": int(len(cal_days)), "chosen_model": CHOSEN,
              "month_model_gain_pct_points": round(gain, 1), "loyo": loyo, "by_region": by_region, "error_vs_size": bands,
              "backcast_pct": back, "seam_2011_to_2012_ratio": seam, "tiles_tested": int(ty.index.get_level_values("tile").nunique())}
log = json.loads((IN / "fetch_log.json").read_text()) if (IN / "fetch_log.json").exists() else {}
model = {"data_through": str(days[-1].date()), "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
         "grid": {"res_deg": SITE_RES, "gi0": gi0, "gj0": gj0, "ym0": ym0}, "months": months,
         "countries": [{"id": f["properties"]["id"], "iso": f["properties"]["iso"], "en": f["properties"]["en"]} for f in world["features"]],
         "factors": {"modis_to_vnp_global": round(float(k0), 3), "tiles": int(len(k_t)),
                     "tile_p10": round(float(k_t.quantile(0.1)), 2), "tile_p50": round(float(k_t.quantile(0.5)), 2),
                     "tile_p90": round(float(k_t.quantile(0.9)), 2), "terra_bridge": round(float(bT0), 3),
                     "aqua_bridge": round(float(bA0), 3), "vj1_to_vnp": round(float(r0), 3), "tile_deg": TILE * RES},
         "source": {"years": [int(files[0].stem), int(files[-1].stem)], "detections": int(sum(v["detections"] for v in log.values())),
                    "missing_satellite_days": gaps},
         "validation": validation}
(WEB / "model.json").write_text(json.dumps(model, separators=(",", ":")))
(IN / "validation_world.json").write_text(json.dumps(validation, indent=1))
pd.DataFrame(by_region).to_csv(IN / "loyo_by_region.csv", index=False)

print(f"\nglobal MODIS -> S-NPP factor {k0:.3f}; tile factors p10/p50/p90 {model['factors']['tile_p10']}/{model['factors']['tile_p50']}/"
      f"{model['factors']['tile_p90']} over {len(k_t)} tiles; bridges Terra {bT0:.3f}, Aqua {bA0:.3f}; NOAA-20 -> S-NPP {r0:.3f}")
print("\nLOYO", years[0], "-", years[-1], "(median abs error of annual totals, %)")
print(pd.DataFrame(loyo).T.to_string())
print(f"\nmodel used: {CHOSEN} (tile x month changes the tile error by {-gain:+.1f} points)")
print("\nby region (median abs error of annual totals, %):")
print(pd.DataFrame(by_region).to_string(index=False))
print("\nobs/pred by predicted size:\n", pd.DataFrame(bands).to_string(index=False))
print(f"\nbackcast (fit 2014-2021): {back}; 2011->2012: {seam}")
print(f"\nrecord: {len(rec):,} month-cells, {rec['r'].ne(255).mean():.1%} inside a country; harmonized total {rec['h'].sum():,.0f}")
print(f"monthly.parquet {size:.1f} MB on a {SITE_RES} degree grid -> {WEB}")
