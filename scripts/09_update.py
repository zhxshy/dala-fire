"""Step 9 (optional, scheduled): add the latest complete days to the published record from FIRMS near-real-time data.

Usage : FIRMS_MAP_KEY=... python 09_update.py            (GitHub Actions runs this every 3 hours)
        python 09_update.py --from-dir DIR --through DATE  (offline test: DIR/<SOURCE>_<start>_<days>.csv)
Input : web/public/data/  (celldays.parquet, days.json, model.json, hotspots_<year>.parquet, static_mask.json,
        regions.geojson)  and the FIRMS area API, sources MODIS_NRT, VIIRS_NOAA20_NRT, VIIRS_NOAA21_NRT
Output: the same files, with the days from (data_through - 2) to yesterday (UTC) replaced or added

It works on the published files only, so it needs no raw archive. The rules are those of steps 2 and 4:
MODIS confidence >= 30, VIIRS nominal or high, the static-source mask, 0.01 degree cells, and the same factors
(NOAA-20 and NOAA-21 tied to Suomi NPP; MODIS x tile factor only on a day without VIIRS). Differences from the
full pipeline, all small: detections are clipped to the region polygons instead of the FIRMS country file, and a
Terra-only or Aqua-only day uses the national bridge factor. Only complete UTC days are added. The last two
published days are fetched again because near-real-time data keeps arriving for a while.

The MAP_KEY is read from the environment and is never written to a file, a log line or the site.
Nothing is written if the API returns no rows at all, an error page, or implausible counts.

AI-assistance note: drafted with an AI coding assistant (Claude) and reviewed by the author.
"""
import argparse
import io
import json
import os
import sys
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import shapely
from shapely.geometry import shape

from common import RES, ROOT

WEB = Path(os.environ["DALA_WEB"]) if os.environ.get("DALA_WEB") else ROOT / "web" / "public" / "data"   # DALA_WEB: tests
API = "https://firms.modaps.eosdis.nasa.gov/api/area/csv"
BBOX = "46,40,88,56"                                   # west,south,east,north around Kazakhstan
SOURCES = {"MODIS_NRT": "MODIS", "VIIRS_NOAA20_NRT": "VJ1", "VIIRS_NOAA21_NRT": "VJ2"}
BIT = {"MODIS_T": 1, "MODIS_A": 2, "VNP": 4, "VJ1": 8, "VJ2": 16}
MODIS_CONF_MIN, REFETCH_DAYS, API_MAX_DAYS, MAX_ROWS_PER_DAY = 30, 2, 5, 200_000


def fetch(source, start, days, key, from_dir):
    """CSV text of `days` days from `start` for one source. The key never appears in an error message."""
    if from_dir:
        p = Path(from_dir) / f"{source}_{start}_{days}.csv"
        return p.read_text() if p.exists() else ""
    url = f"{API}/{key}/{source}/{BBOX}/{days}/{start}"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "dala-fire updater"}), timeout=120) as r:
            return r.read().decode("utf-8", "replace")
    except Exception as e:                                      # the URL holds the key: report the kind of error only
        raise SystemExit(f"FIRMS API request failed for {source} {start} (+{days} d): {type(e).__name__}")


def parse(text, family):
    if not text.strip():
        return pd.DataFrame()
    head = text.splitlines()[0].lower()
    if "latitude" not in head:                                   # an error page such as "Invalid MAP_KEY."
        raise SystemExit(f"FIRMS API did not return a table for {family}: {text.strip()[:60]!r}")
    df = pd.read_csv(io.StringIO(text), dtype={"acq_time": str, "confidence": str, "satellite": str})
    if df.empty:
        return df
    out = pd.DataFrame({"lat": df["latitude"].astype("float64"), "lon": df["longitude"].astype("float64"),
                        "date": pd.to_datetime(df["acq_date"]), "time_utc": df["acq_time"].str.zfill(4),
                        "confidence": df["confidence"].astype(str), "frp_mw": df["frp"].astype("float32").round(1),
                        "daynight": df["daynight"].astype(str)})
    if family == "MODIS":
        out["sensor"] = np.where(df["satellite"].str.strip().str.lower().str.startswith("t"), "MODIS_T", "MODIS_A")
        out["ok"] = pd.to_numeric(df["confidence"], errors="coerce") >= MODIS_CONF_MIN
    else:
        out["sensor"] = family
        out["ok"] = df["confidence"].str.strip().str.lower().isin(["n", "h", "nominal", "high"])
    return out


def write(table, name):
    pq.write_table(pa.Table.from_pandas(table, preserve_index=False), WEB / name, compression="snappy", row_group_size=200_000)


ap = argparse.ArgumentParser()
ap.add_argument("--from-dir", default=None, help="read API responses from files instead of the network (tests)")
ap.add_argument("--through", default=None, help="last day to add, YYYY-MM-DD (default: yesterday, UTC)")
a = ap.parse_args()
key = os.environ.get("FIRMS_MAP_KEY", "").strip()
if not key and not a.from_dir:
    print("FIRMS_MAP_KEY is not set: nothing to do.")
    sys.exit(0)

model = json.loads((WEB / "model.json").read_text(encoding="utf-8"))
days = json.loads((WEB / "days.json").read_text())
epoch = date.fromisoformat(days["epoch"])
published = date.fromisoformat(model["data_through"])
through = date.fromisoformat(a.through) if a.through else datetime.now(timezone.utc).date() - timedelta(days=1)
start = published - timedelta(days=REFETCH_DAYS - 1)
if through < start:
    print(f"Published through {published}; nothing newer than {through}.")
    sys.exit(0)
window = pd.date_range(start, through)
print(f"published through {published}; updating {start} .. {through} ({len(window)} days)")

# --- fetch -----------------------------------------------------------------------------------------------------
frames = []
for source, family in SOURCES.items():
    d = start
    while d <= through:
        n = min(API_MAX_DAYS, (through - d).days + 1)
        frames.append(parse(fetch(source, d.isoformat(), n, key, a.from_dir), family))
        d += timedelta(days=n)
raw = pd.concat([f for f in frames if len(f)], ignore_index=True) if any(len(f) for f in frames) else pd.DataFrame()
if raw.empty:
    raise SystemExit("The API returned no detections for any source: nothing written (an outage or a wrong key?).")
raw = raw[raw["date"].isin(window)].drop_duplicates(["sensor", "date", "time_utc", "lat", "lon"]).reset_index(drop=True)

# --- clip to Kazakhstan, assign regions --------------------------------------------------------------------------
raw["ci"] = np.floor(raw["lat"] / RES).astype("int32")
raw["cj"] = np.floor(raw["lon"] / RES).astype("int32")
regions = json.loads((WEB / "regions.geojson").read_text(encoding="utf-8"))["features"]
geoms = [shape(f["geometry"]) for f in regions]
ids = np.array([f["id"] for f in regions], dtype="int64")
cells = raw[["ci", "cj"]].drop_duplicates().reset_index(drop=True)
lon, lat = (cells["cj"].to_numpy() + 0.5) * RES, (cells["ci"].to_numpy() + 0.5) * RES
pts = shapely.points(lon, lat)
tree = shapely.STRtree(geoms)
rid = np.full(len(cells), 255, dtype="int64")
hit = tree.query(pts, predicate="within")                       # (point index, polygon index)
rid[hit[0]] = ids[hit[1]]
out = np.flatnonzero(rid == 255)
if len(out):                                                    # the published borders are simplified: allow ~2 km
    near = tree.query_nearest(pts[out], max_distance=0.02, return_distance=False)
    rid[out[near[0]]] = ids[near[1]]
cells["r"] = rid
raw = raw.merge(cells, on=["ci", "cj"])
raw = raw[raw["r"] != 255].reset_index(drop=True)
per_day = raw.groupby("date").size()
if len(per_day) and per_day.max() > MAX_ROWS_PER_DAY:
    raise SystemExit(f"Implausible: {per_day.max():,} detections in one day. Nothing written.")

# --- which satellite feeds each day ------------------------------------------------------------------------------
n = raw.groupby(["date", "sensor"]).size().unstack("sensor", fill_value=0).reindex(window, fill_value=0)
for s in BIT:
    if s not in n:
        n[s] = 0
# NOAA-20 feeds the day unless it has no rows at all while NOAA-21 has some. A day on which neither VIIRS has a row
# but MODIS has is fed by MODIS; a day with no rows from anyone is "no data", not zero fire.
j1 = n["VJ1"] > 0
j2 = n["VJ2"] > 0
src = np.select([j1, j2, (n["MODIS_T"] > 0) & (n["MODIS_A"] > 0), n["MODIS_T"] > 0, n["MODIS_A"] > 0],
                ["VJ1", "VJ2", "MODIS", "TERRA", "AQUA"], default="NONE")
source = pd.Series(src, index=window)

# --- clean, cell-days, harmonized value --------------------------------------------------------------------------
mask = np.array(json.loads((WEB / "static_mask.json").read_text()))
mkey = set((np.round((mask[:, 1] - RES / 2) / RES).astype("int64") * 100_000 + np.round((mask[:, 0] - RES / 2) / RES).astype("int64")).tolist()) if len(mask) else set()
raw["masked"] = (raw["ci"].astype("int64") * 100_000 + raw["cj"]).isin(mkey)
clean = raw[raw["ok"] & ~raw["masked"]].copy()
f = model["factors"]
tiles, k0 = f.get("tiles", {}), f["modis_to_vnp_national"]
step = int(round(float(f["tile_deg"]) / RES))
cd = clean.groupby(["date", "ci", "cj", "r", "sensor"]).size().reset_index()[["date", "ci", "cj", "r", "sensor"]]
cd["bit"] = cd["sensor"].map(BIT)
cd["src"] = cd["date"].map(source)
k_tile = ((cd["ci"] // step) * 1000 + cd["cj"] // step).astype(str).map(tiles).fillna(k0)
use = {"VJ1": (cd["sensor"] == "VJ1", f["vj1_to_vnp"]), "VJ2": (cd["sensor"] == "VJ2", f["vj2_to_vnp"]),
       "TERRA": (cd["sensor"] == "MODIS_T", f["terra_bridge"] * k_tile), "AQUA": (cd["sensor"] == "MODIS_A", f["aqua_bridge"] * k_tile)}
cd["h"] = 0.0
for name, (rows, value) in use.items():
    sel = rows & (cd["src"] == name)
    cd.loc[sel, "h"] = value[sel] if isinstance(value, pd.Series) else value
agg = cd.groupby(["date", "ci", "cj", "r"]).agg(m=("bit", "sum"), h=("h", "sum")).reset_index()
both = (agg["date"].map(source) == "MODIS") & (agg["m"] & 3 > 0)          # Terra or Aqua saw it: one MODIS cell-day
agg.loc[both, "h"] = ((agg.loc[both, "ci"] // step) * 1000 + agg.loc[both, "cj"] // step).astype(str).map(tiles).fillna(k0)

# --- write back --------------------------------------------------------------------------------------------------
g = model["grid"]
old = pq.read_table(WEB / "celldays.parquet").to_pandas()
d0 = (start - epoch).days
new = pd.DataFrame({"d": (agg["date"].dt.date.map(lambda x: (x - epoch).days)).astype("int64"),
                    "ci": agg["ci"] - g["ci0"], "cj": agg["cj"] - g["cj0"], "h": agg["h"].astype("float32"),
                    "m": agg["m"].astype("uint8"), "r": agg["r"].astype("uint8")})
bad = (new["ci"] < 0) | (new["cj"] < 0) | (new["ci"] > 65535) | (new["cj"] > 65535)
if bad.any():
    print(f"dropped {int(bad.sum())} cell-days outside the published grid")
    new = new[~bad]
merged = (pd.concat([old[old["d"] < d0], new.astype(old.dtypes.to_dict())], ignore_index=True)
          .sort_values(["d", "ci", "cj"]).reset_index(drop=True))

codes = days["codes"]
n_days = (through - epoch).days + 1
src_list = (days["source"] + [0] * n_days)[:n_days]
cal = (days.get("cal", [0] * len(days["source"])) + [0] * n_days)[:n_days]
for day, s in source.items():
    src_list[(day.date() - epoch).days] = codes.index(s)

clean["date_s"] = clean["date"].dt.strftime("%Y-%m-%d")
hot = {}
for year in sorted({d.year for d in window}):
    name = f"hotspots_{year}.parquet"
    prev = pq.read_table(WEB / name).to_pandas() if (WEB / name).exists() else None
    add = clean[clean["date"].dt.year == year]
    rows = pd.DataFrame({"date": add["date_s"], "time_utc": add["time_utc"], "lat": add["lat"].round(4), "lon": add["lon"].round(4),
                         "sensor": add["sensor"], "src": "NRT", "confidence": add["confidence"], "frp_mw": add["frp_mw"],
                         "daynight": add["daynight"], "r": add["r"].astype("uint8")})
    if prev is not None:
        rows = pd.concat([prev[prev["date"] < start.isoformat()], rows.astype(prev.dtypes.to_dict())], ignore_index=True)
    rows = rows.sort_values(["date", "time_utc", "sensor", "lat", "lon"]).reset_index(drop=True)
    same = prev is not None and len(prev) == len(rows) and prev.sort_values(["date", "time_utc", "sensor", "lat", "lon"]).reset_index(drop=True).equals(rows)
    hot[name] = (rows, same)

# nothing new since the last run: leave every file as it is, so a scheduled run makes no commit
if (through == published and src_list == days["source"] and all(same for _, same in hot.values())
        and merged.equals(old.sort_values(["d", "ci", "cj"]).reset_index(drop=True))):
    print("No change since the last update.")
    sys.exit(0)

write(merged, "celldays.parquet")
days.update({"last": through.isoformat(), "source": src_list, "cal": cal})
(WEB / "days.json").write_text(json.dumps(days, separators=(",", ":")))
for name, (rows, same) in hot.items():
    if not same:
        write(rows, name)
model["data_through"] = through.isoformat()
model["generated"] = datetime.now(timezone.utc).isoformat(timespec="minutes")
model["updated_by"] = "scripts/09_update.py from FIRMS near-real-time data"
(WEB / "model.json").write_text(json.dumps(model, ensure_ascii=False, indent=1), encoding="utf-8")

print(f"days by source: {source.value_counts().to_dict()}")
print(f"clean detections: {len(clean):,}; fire cell-days: {len(new):,}; harmonized total {new['h'].sum():,.1f}")
print(f"published through {through}")
