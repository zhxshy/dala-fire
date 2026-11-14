"""Step 2: clean detections, mask static sources, snap to a 0.01 deg grid -> fire cell-days.

Input : data/interim/hotspots_all.parquet
Output: data/interim/hotspots_clean.parquet   (detections that pass all filters, with cell ids)
        data/interim/celldays.parquet          (one row per sensor x day x 0.01 deg cell)
        data/interim/static_mask_cells.parquet (0.01 deg cells masked as static/offshore sources)

Cleaning rules
  1. confidence: MODIS >= 30, VIIRS nominal/high (conf_ok from step 1)
  2. FIRMS type: keep type 0 where known (archive rows)
  3. static-source mask, applied to ALL rows incl. NRT (which has no `type`):
     0.01 deg cells with >= MIN_STATIC archive detections of type 2/3, dilated by 1 cell
Fire cell-day: a (sensor, day, 0.01 deg cell) with >= 1 clean detection. Many 375 m VIIRS pixels
from one fire collapse into one cell, which removes most of the pixel-size difference vs 1 km MODIS.

AI-assistance note: drafted with an AI coding assistant (Claude) and reviewed by the author.
"""
import pandas as pd

from common import INT, cell_ids

MIN_STATIC = 3      # archive type-2/3 detections needed to flag a cell as static
DILATE = 1          # neighbour cells added around each static cell

df = pd.read_parquet(INT / "hotspots_all.parquet")
df["ci"], df["cj"] = cell_ids(df["lat"], df["lon"])

# --- static mask from archive type 2 (static land) and 3 (offshore) -----------------------------
static = (df[df["type"].isin([2, 3])].groupby(["ci", "cj"]).size().rename("n").reset_index())
static = static[static["n"] >= MIN_STATIC][["ci", "cj"]]
offs = [(a, b) for a in range(-DILATE, DILATE + 1) for b in range(-DILATE, DILATE + 1)]
mask = pd.concat([static.assign(ci=static.ci + a, cj=static.cj + b) for a, b in offs]).drop_duplicates()
mask["masked"] = True
mask.to_parquet(INT / "static_mask_cells.parquet", index=False)

df = df.merge(mask, on=["ci", "cj"], how="left")
df["masked"] = df["masked"].fillna(False).astype(bool)

n0 = len(df)
step_conf = df["conf_ok"]
step_type = df["type"].isna() | (df["type"] == 0)
step_mask = ~df["masked"]
keep = step_conf & step_type & step_mask
clean = df[keep].drop(columns=["masked"]).reset_index(drop=True)
clean.to_parquet(INT / "hotspots_clean.parquet", index=False)

# leakage check: how many type-0 (vegetation) archive detections fall inside the static mask?
veg = df[df["type"] == 0]
leak = veg["masked"].mean()

# --- fire cell-days ------------------------------------------------------------------------------
cd = clean.groupby(["sensor", "date", "ci", "cj"], observed=True).agg(
    n_det=("frp", "size"), frp_sum=("frp", "sum"), frp_max=("frp", "max")).reset_index()
cd.to_parquet(INT / "celldays.parquet", index=False)

print(f"rows in: {n0:,}")
print(f"  fail confidence      : {(~step_conf).sum():,}")
print(f"  fail type (1/2/3)    : {(~step_type).sum():,}")
print(f"  inside static mask   : {(~step_mask).sum():,}")
print(f"rows kept: {len(clean):,} ({len(clean)/n0:.1%})")
print(f"static mask cells (dilated): {len(mask):,}; type-0 archive detections inside mask: {leak:.2%}")
print(f"NRT rows removed by mask: {(df['src'].eq('NRT') & df['masked']).sum():,} of {df['src'].eq('NRT').sum():,}")
print(f"\nfire cell-days: {len(cd):,}")
summ = clean.groupby("sensor", observed=True).size().to_frame("detections")
summ["cell_days"] = cd.groupby("sensor", observed=True).size()
summ["det_per_cellday"] = (summ.detections / summ.cell_days).round(2)
print(summ.to_string())
