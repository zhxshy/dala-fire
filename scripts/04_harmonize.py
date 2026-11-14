"""Step 4: harmonize MODIS and VIIRS into one daily fire cell-day record on the VIIRS S-NPP scale.

Inputs : data/interim/celldays.parquet, data/interim/sensor_availability.parquet
Outputs: data/interim/harmonized_celldays.parquet  (date, ci, cj, h): harmonized fire cell-days, float
         data/interim/day_source.parquet           (date, source): which sensor fed each day
         data/interim/strata.json                  all fitted factors + counts behind them
         data/interim/national_monthly_harmonized.csv

Model (additive, so any area = sum of its cells):
  * Reference scale: VIIRS S-NPP fire cell-days.
  * MODIS (Terra u Aqua) -> S-NPP: factor k_s per 3-degree tile s, fitted on 2012-01-20..2021-12-31
    using only days on which Terra, Aqua and S-NPP all delivered data, shrunk toward the national factor:
        k_s = (sum V_s + LAMBDA * k) / (sum M_s + LAMBDA)
  * One MODIS satellite missing (incl. Terra-only years 2000-2002): Terra -> (Terra u Aqua) factor b_T,
    or Aqua -> (Terra u Aqua) factor b_A, fitted on 2003-2011 days with both satellites; same shrinkage.
  * VIIRS days without S-NPP: NOAA-20 (or NOAA-21) x national ratio to S-NPP from the overlap.
Day source priority: VNP > VJ1 > VJ2 > MODIS (Terra u Aqua) > TERRA > AQUA > NONE (no data).
2022-2025 MODIS is not used for fitting (orbit drift of Terra and Aqua); it is used only on days with
no VIIRS data.

AI-assistance note: drafted with an AI coding assistant (Claude) and reviewed by the author.
"""
import json

import numpy as np
import pandas as pd

from common import INT

TILE = 300                      # 3 degrees in 0.01-degree cells
LAMBDA = 200.0                  # shrinkage strength, in cell-days
CAL_START, CAL_END = "2012-01-20", "2021-12-31"   # MODIS -> S-NPP calibration window
BRIDGE_START, BRIDGE_END = "2003-01-01", "2011-12-31"
VIIRS_CAL_END = "2025-12-31"   # NOAA-20/21 -> S-NPP windows end here

cd = pd.read_parquet(INT / "celldays.parquet", columns=["sensor", "date", "ci", "cj"])
cd["sensor"] = cd["sensor"].astype(str)
av = pd.read_parquet(INT / "sensor_availability.parquet")
up = av.pivot(index="date", columns="sensor", values="available").fillna(False).astype(bool)
up = up.reindex(pd.date_range(up.index.min(), up.index.max()), fill_value=False)

cd["tile"] = (cd["ci"] // TILE).astype("int16") * 1000 + (cd["cj"] // TILE).astype("int16")


def cells(sensor):
    return cd.loc[cd["sensor"] == sensor, ["date", "ci", "cj", "tile"]]


T, A, V, J1, J2 = (cells(s) for s in ["MODIS_T", "MODIS_A", "VNP", "VJ1", "VJ2"])
M = pd.concat([T, A]).drop_duplicates(["date", "ci", "cj"])          # Terra u Aqua


def on_days(df, days):
    return df[df["date"].isin(days)]


def shrunk_factors(num, den, lam=LAMBDA):
    """Per-tile ratio sum(num)/sum(den), shrunk toward the national ratio."""
    n = num.groupby("tile").size()
    d = den.groupby("tile").size()
    tiles = n.index.union(d.index)
    n, d = n.reindex(tiles, fill_value=0), d.reindex(tiles, fill_value=0)
    k = n.sum() / d.sum()
    ks = (n + lam * k) / (d + lam)
    return float(k), ks.to_dict(), {int(t): (int(n[t]), int(d[t])) for t in tiles}


def window(start, end, *sensors):
    w = up.loc[start:end, list(sensors)].all(axis=1)
    return w[w].index


# --- fit -----------------------------------------------------------------------------------------
cal_days = window(CAL_START, CAL_END, "MODIS_T", "MODIS_A", "VNP")
k, k_tile, k_counts = shrunk_factors(on_days(V, cal_days), on_days(M, cal_days))

br_days = window(BRIDGE_START, BRIDGE_END, "MODIS_T", "MODIS_A")
bT, bT_tile, _ = shrunk_factors(on_days(M, br_days), on_days(T, br_days))
bA, bA_tile, _ = shrunk_factors(on_days(M, br_days), on_days(A, br_days))

j1_days = window("2018-04-01", VIIRS_CAL_END, "VNP", "VJ1")
r1 = len(on_days(V, j1_days)) / len(on_days(J1, j1_days))
j2_days = window("2023-03-01", VIIRS_CAL_END, "VNP", "VJ2")
r2 = len(on_days(V, j2_days)) / len(on_days(J2, j2_days))

# --- day source ----------------------------------------------------------------------------------
both_modis = up["MODIS_T"] & up["MODIS_A"]
src = np.select(
    [up["VNP"], up["VJ1"], up["VJ2"], both_modis, up["MODIS_T"], up["MODIS_A"]],
    ["VNP", "VJ1", "VJ2", "MODIS", "TERRA", "AQUA"], default="NONE")
day_source = pd.DataFrame({"date": up.index, "source": src})
day_source.to_parquet(INT / "day_source.parquet", index=False)
by_src = {s: set(day_source.loc[day_source["source"] == s, "date"]) for s in day_source["source"].unique()}


def pick(df, source):
    return df[df["date"].isin(by_src.get(source, set()))]


def tile_factor(df, table, default):
    return df["tile"].map(table).fillna(default).astype("float32")


parts = [pick(V, "VNP").assign(h=np.float32(1.0)),
         pick(J1, "VJ1").assign(h=np.float32(r1)),
         pick(J2, "VJ2").assign(h=np.float32(r2))]
m = pick(M, "MODIS"); parts.append(m.assign(h=tile_factor(m, k_tile, k)))
t = pick(T, "TERRA"); parts.append(t.assign(h=tile_factor(t, bT_tile, bT) * tile_factor(t, k_tile, k)))
a = pick(A, "AQUA"); parts.append(a.assign(h=tile_factor(a, bA_tile, bA) * tile_factor(a, k_tile, k)))
H = pd.concat(parts, ignore_index=True)[["date", "ci", "cj", "h"]].sort_values(["date", "ci", "cj"])
H.to_parquet(INT / "harmonized_celldays.parquet", index=False)

# --- record ---------------------------------------------------------------------------------------
strata = {
    "reference": "VIIRS S-NPP fire cell-days, 0.01 degree cells",
    "tile_deg": TILE / 100, "lambda": LAMBDA,
    "modis_to_vnp": {"window": [CAL_START, CAL_END], "days": len(cal_days), "k_national": k,
                     "k_tile": {int(s): v for s, v in k_tile.items()},
                     "counts_vnp_modis": k_counts},
    "terra_bridge": {"window": [BRIDGE_START, BRIDGE_END], "days": len(br_days), "b_national": bT},
    "aqua_bridge": {"window": [BRIDGE_START, BRIDGE_END], "days": len(br_days), "b_national": bA},
    "vj1_to_vnp": {"days": len(j1_days), "r": r1},
    "vj2_to_vnp": {"days": len(j2_days), "r": r2},
    "tile_key": "tile = (ci // 300) * 1000 + (cj // 300); tile south-west corner = (tile//1000*3, tile%1000*3) deg",
}
(INT / "strata.json").write_text(json.dumps(strata, indent=1))

mon = lambda df: df.groupby(df["date"].dt.to_period("M")).size()
nat = pd.DataFrame({"modis_raw": mon(M), "vnp_raw": mon(V),
                    "harmonized": H.groupby(H["date"].dt.to_period("M"))["h"].sum()}).fillna(0)
nat["source_days"] = day_source.groupby(day_source["date"].dt.to_period("M"))["source"].agg(
    lambda s: ",".join(f"{x}:{n}" for x, n in s.value_counts().items()))
nat.to_csv(INT / "national_monthly_harmonized.csv")

print(f"MODIS -> S-NPP: k = {k:.3f} on {len(cal_days)} days; tile k range "
      f"{min(k_tile.values()):.2f}..{max(k_tile.values()):.2f} over {len(k_tile)} tiles")
print(f"Terra bridge b_T = {bT:.3f}, Aqua bridge b_A = {bA:.3f} on {len(br_days)} days")
print(f"NOAA-20 -> S-NPP r = {r1:.3f} ({len(j1_days)} days); NOAA-21 -> S-NPP r = {r2:.3f} ({len(j2_days)} days)")
print("\nDays by source:\n", day_source["source"].value_counts().to_string())
print(f"\nHarmonized rows: {len(H):,}; total = {H['h'].sum():,.0f} cell-days")
yr = nat.groupby(nat.index.year)[["modis_raw", "vnp_raw", "harmonized"]].sum().round(0).astype(int)
print("\n", yr.to_string())
