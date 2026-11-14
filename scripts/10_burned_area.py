"""Step 10: check the harmonized record against an independent product, MODIS burned area (MCD64CMQ, Collection 6.1).

Usage : python 10_burned_area.py                 downloads MCD64CMQ from the University of Maryland SFTP server
        python 10_burned_area.py --from-dir DIR  reads MCD64CMQ*.hdf files already on disk
Needs : pip install pyhdf paramiko   (plus the usual pandas, numpy, pyarrow, shapely, matplotlib)
Input : MCD64CMQ monthly burned area, 0.25 degree, 2001-2025 (fuoco.geog.umd.edu, user "fire", password "burnt",
        the public account given in the MCD64 User Guide); web/public/data/celldays.parquet, regions.geojson and
        web/public/data/world/monthly.parquet, model.json (the published records)
Output: results/burned_area_check.json, results/burned_area_annual.csv, figures/03_burned_area.png

Burned area is mapped from changes in surface reflectance (the burn scar), not from the heat of the fire, so it is
a different measurement of the same burning. It does use MODIS active fires as a hint, and it is a MODIS product
throughout, so it has no 2012 seam of its own. Three questions, for Kazakhstan, its regions, the world and nine
world regions:
  1. Decline. Burning in 2021-2025 against 2001-2005: does burned area agree with the harmonized record or with
     the naive splice?
  2. Seam. Fire cell-days per km2 burned, 2013-2021 against 2003-2011: a record without a seam keeps this ratio
     about where MODIS alone keeps it; the naive splice roughly doubles it.
  3. Year to year. Correlation of log yearly totals with burned area, 2001-2025.
Nothing here was used to fit or tune the method.

AI-assistance note: drafted with an AI coding assistant (Claude) and reviewed by the author.
"""
import argparse
import json
import re
import tempfile
from datetime import date, timedelta
from pathlib import Path

import matplotlib
import numpy as np
import pandas as pd
import shapely
from shapely.geometry import shape

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

from common import ROOT  # noqa: E402

WEB = ROOT / "web" / "public" / "data"
OUT = ROOT / "results"
HOST, USER, PASSWORD = "fuoco.geog.umd.edu", "fire", "burnt"     # public account, MCD64 User Guide section 4
DIRS = ["data/MODIS/C61/MCD64CMQ", "data/MODIS/C6/MCD64CMQ"]
YEARS = (2001, 2025)
EARLY, LATE = (2001, 2005), (2021, 2025)
BEFORE, AFTER = (2003, 2011), (2013, 2021)
REGIONS = [  # the same boxes as scripts/w2_world.py; first match wins (cell centre)
    ("North America", -170, -50, 15, 75), ("South America", -95, -30, -60, 15), ("Europe", -12, 40, 35, 72),
    ("Africa, north of the equator", -20, 52, 0, 35), ("Africa, south of the equator", 5, 52, -36, 0),
    ("Northern and Central Asia", 40, 180, 40, 78), ("South Asia", 60, 92, 5, 40),
    ("East and Southeast Asia", 92, 155, -11, 40), ("Australia and Oceania", 110, 180, -48, -11),
]
NAME = re.compile(r"MCD64CMQ\.A(\d{4})(\d{3})\..*\.hdf$")


def month_of(name):
    m = NAME.search(name)
    if not m:
        return None
    d = date(int(m.group(1)), 1, 1) + timedelta(days=int(m.group(2)) - 1)
    return (d.year, d.month) if YEARS[0] <= d.year <= YEARS[1] else None


def download(cache):
    """Every MCD64CMQ file of 2001-2025 into `cache`, newest production of each month. Returns {(y, m): path}."""
    import paramiko
    t = paramiko.Transport((HOST, 22))
    t.connect(username=USER, password=PASSWORD)
    sftp = paramiko.SFTPClient.from_transport(t)
    files = {}
    for root in DIRS:
        try:
            stack = [root]
            while stack:
                d = stack.pop()
                for e in sftp.listdir_attr(d):
                    p = f"{d}/{e.filename}"
                    if e.st_mode is not None and (e.st_mode & 0o170000) == 0o040000:
                        stack.append(p)
                    elif (ym := month_of(e.filename)) and ym not in files:
                        files[ym] = p
        except IOError:
            continue
        if files:
            print(f"{len(files)} monthly files under {root}")
            break
    if not files:
        raise SystemExit(f"No MCD64CMQ files found under {DIRS} on {HOST}.")
    out = {}
    for ym, p in sorted(files.items()):
        local = cache / Path(p).name
        if not local.exists():
            sftp.get(p, str(local))
        out[ym] = local
    sftp.close(); t.close()
    return out


def read_ba(path):
    """Burned area per 0.25 degree cell in km2 (the file stores units of 0.01 ha); row 0 is the northern edge."""
    from pyhdf.SD import SD, SDC
    f = SD(str(path), SDC.READ)
    a = f.select("BurnedArea").get().astype("float64")
    f.end()
    return np.where(a > 0, a, 0.0) * 1e-4          # 0.01 ha -> km2


# --- units: masks on the 0.25 degree grid ---------------------------------------------------------------------
NY, NX, RES = 720, 1440, 0.25
lat = 89.875 - np.arange(NY) * RES
lon = -179.875 + np.arange(NX) * RES
LON, LAT = np.meshgrid(lon, lat)
regions = json.loads((WEB / "regions.geojson").read_text(encoding="utf-8"))["features"]
kz_id = np.full((NY, NX), -1, dtype="int16")
box = (LON > 45) & (LON < 89) & (LAT > 39) & (LAT < 57)
for f in regions:
    g = shape(f["geometry"])
    inside = np.zeros_like(box)
    inside[box] = shapely.contains_xy(g, LON[box], LAT[box])
    kz_id[inside & (kz_id < 0)] = f["id"]
world_id = np.full((NY, NX), -1, dtype="int16")
for i, (_, w, e, s, n) in enumerate(REGIONS):
    world_id[(world_id < 0) & (LON >= w) & (LON < e) & (LAT >= s) & (LAT < n)] = i
region_name = {f["id"]: f["properties"]["en"] for f in regions}


def units_of_ba(ba):
    out = {"Kazakhstan": ba[kz_id >= 0].sum(), "World": ba.sum()}
    for rid in np.unique(kz_id[kz_id >= 0]):
        out[f"KZ: {region_name[int(rid)]}"] = ba[kz_id == rid].sum()
    for i, r in enumerate(REGIONS):
        out[f"World: {r[0]}"] = ba[world_id == i].sum()
    return out


ap = argparse.ArgumentParser()
ap.add_argument("--from-dir", default=None)
ap.add_argument("--cache", default=None, help="folder for the downloaded files (default: system temp)")
a = ap.parse_args()
if a.from_dir:
    files = {ym: p for p in Path(a.from_dir).glob("MCD64CMQ*.hdf") if (ym := month_of(p.name))}
else:
    cache = Path(a.cache or tempfile.mkdtemp(prefix="mcd64cmq_")); cache.mkdir(parents=True, exist_ok=True)
    files = download(cache)
if not files:
    raise SystemExit("No MCD64CMQ files to read.")
print(f"burned-area months: {len(files)} ({min(files)} .. {max(files)})")
rows = []
for (y, m), p in sorted(files.items()):
    for unit, v in units_of_ba(read_ba(p)).items():
        rows.append({"unit": unit, "year": y, "month": m, "ba_km2": v})
ba = pd.DataFrame(rows)
months_per_year = ba.groupby("year")["month"].nunique()
full_years = set(months_per_year[months_per_year == 12].index)
ba = ba[ba["year"].isin(full_years)].groupby(["unit", "year"])["ba_km2"].sum()

# --- the fire records, yearly, for the same units ---------------------------------------------------------------
kz = pd.read_parquet(WEB / "celldays.parquet")
model = json.loads((WEB / "model.json").read_text(encoding="utf-8"))
epoch = pd.Timestamp(model["grid"]["epoch"])
kz["year"] = (epoch + pd.to_timedelta(kz["d"].astype("int64"), unit="D")).dt.year
kz["modis"] = (kz["m"] & 3 > 0).astype(int)
kz["viirs"] = (kz["m"] & 4 > 0).astype(int)
kz["region"] = kz["r"].map(lambda r: f"KZ: {region_name[int(r)]}" if int(r) in region_name else None)
fire = [kz.groupby("year")[["h", "modis", "viirs"]].sum().assign(unit="Kazakhstan").reset_index()]
fire.append(kz.dropna(subset=["region"]).groupby(["region", "year"])[["h", "modis", "viirs"]].sum().reset_index()
            .rename(columns={"region": "unit"}))
wm = json.loads((WEB / "world" / "model.json").read_text(encoding="utf-8"))
w = pd.read_parquet(WEB / "world" / "monthly.parquet")
keys = [x["key"] for x in wm["months"]]
w["year"] = w["ym"].map(lambda k: int(keys[k][:4]))
g = wm["grid"]
w_lat = (w["gi"].astype("int64") + g["gi0"] + 0.5) * g["res_deg"]
w_lon = (w["gj"].astype("int64") + g["gj0"] + 0.5) * g["res_deg"]
w["unit"] = None
for r in REGIONS[::-1]:                                    # reversed so that the first match wins
    w.loc[(w_lon >= r[1]) & (w_lon < r[2]) & (w_lat >= r[3]) & (w_lat < r[4]), "unit"] = f"World: {r[0]}"
w = w.rename(columns={"m": "modis", "v": "viirs"})
fire.append(w.groupby("year")[["h", "modis", "viirs"]].sum().assign(unit="World").reset_index())
fire.append(w.dropna(subset=["unit"]).groupby(["unit", "year"])[["h", "modis", "viirs"]].sum().reset_index())
fire = pd.concat(fire, ignore_index=True).set_index(["unit", "year"])
fire["naive"] = np.where(fire.index.get_level_values("year") < 2012, fire["modis"], fire["viirs"])
t = fire.join(ba, how="inner").reset_index()
t = t[(t["year"] >= YEARS[0]) & (t["year"] <= YEARS[1])]
OUT.mkdir(exist_ok=True)
t.round(1).to_csv(OUT / "burned_area_annual.csv", index=False)


def mean(s, span):
    x = s[(s.index >= span[0]) & (s.index <= span[1])]
    return float(x.mean()) if len(x) == span[1] - span[0] + 1 else np.nan


def logcorr(x, y):
    ok = (x > 0) & (y > 0)
    return float(np.corrcoef(np.log(x[ok]), np.log(y[ok]))[0, 1]) if ok.sum() >= 10 else np.nan


result = []
for unit, d in t.groupby("unit"):
    d = d.set_index("year")
    if np.isnan(mean(d["ba_km2"], LATE)) or d["ba_km2"].sum() < 500:       # too little burned area to compare
        continue
    dec = {k: mean(d[k], EARLY) / mean(d[k], LATE) for k in ("ba_km2", "h", "naive", "modis")}
    step = {k: mean(d[k] / d["ba_km2"], AFTER) / mean(d[k] / d["ba_km2"], BEFORE) for k in ("h", "naive", "modis")}
    result.append({"unit": unit, "burned_km2_per_year": round(float(d["ba_km2"].mean())),
                   "decline_burned_area": round(dec["ba_km2"], 2), "decline_harmonized": round(dec["h"], 2),
                   "decline_naive": round(dec["naive"], 2), "decline_modis_alone": round(dec["modis"], 2),
                   "seam_step_harmonized": round(step["h"], 2), "seam_step_naive": round(step["naive"], 2),
                   "seam_step_modis_alone": round(step["modis"], 2),
                   "corr_harmonized": round(logcorr(d["h"], d["ba_km2"]), 2), "corr_naive": round(logcorr(d["naive"], d["ba_km2"]), 2)})
res = pd.DataFrame(result).sort_values("burned_km2_per_year", ascending=False)
summary = {"source": "MCD64CMQ Collection 6.1 (MODIS burned area, 0.25 degree, monthly), University of Maryland",
           "years": sorted(full_years), "early": EARLY, "late": LATE, "before": BEFORE, "after": AFTER,
           "units": res.to_dict("records")}
(OUT / "burned_area_check.json").write_text(json.dumps(summary, indent=1))

# --- figure: Kazakhstan, each record scaled to its own 2013-2021 mean ------------------------------------------
k = t[t["unit"] == "Kazakhstan"].set_index("year")
if len(k):
    fig, ax = plt.subplots(figsize=(10, 4.8), dpi=150)
    for col, label, style in [("ba_km2", "Burned area (MCD64, independent)", dict(color="#2d4f8f", lw=2.2)),
                              ("h", "Harmonized fire cell-days", dict(color="#1a1a1a", lw=2.4)),
                              ("naive", "Naive splice", dict(color="#d62728", lw=1.8))]:
        ax.plot(k.index, k[col] / mean(k[col], AFTER), label=label, **style)
    ax.axvline(2011.5, color="#999", lw=0.8)
    ax.text(2011.7, ax.get_ylim()[1] * 0.93, "MODIS → VIIRS", fontsize=8, color="#555")
    ax.set_ylabel(f"Relative to the {AFTER[0]}–{AFTER[1]} mean")
    ax.set_title("Kazakhstan: burned area against the harmonized and the naive fire record")
    ax.legend(frameon=False, fontsize=8)
    ax.spines[["top", "right"]].set_visible(False)
    fig.tight_layout()
    (ROOT / "figures").mkdir(exist_ok=True)
    fig.savefig(ROOT / "figures" / "03_burned_area.png")

pd.set_option("display.width", 220)
print("\nDecline 2001-2005 -> 2021-2025 (times less now), seam step (fire per km2 burned, 2013-2021 / 2003-2011),"
      "\nand correlation of log yearly totals with burned area:\n")
print(res.to_string(index=False))
print(f"\nwritten: {OUT / 'burned_area_check.json'}, {OUT / 'burned_area_annual.csv'}, figures/03_burned_area.png")
