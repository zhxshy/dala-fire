"""Step 7: sensitivity of the harmonization to the choices we made.

Inputs : data/interim/hotspots_all.parquet, data/interim/sensor_availability.parquet
Outputs: data/interim/sensitivity.csv, data/interim/sensitivity.json

Each variant changes ONE choice against the baseline and reruns the parts that depend on it:
cleaning (confidence filter, static-source mask), cell size, tile size and shrinkage. For every
variant we report
  k_national       MODIS -> S-NPP factor fitted on 2012-2021
  loyo_nat_med     median |error| of national annual totals, leave-one-year-out 2012-2021 (%)
  loyo_tile_med    median |error| of 3-degree-tile annual totals (tiles with >= 200 S-NPP cell-days) (%)
  loyo_tile_p90    90th percentile of the same (%)
  backcast_2012/13 error when 2012 and 2013 are predicted from factors fitted on 2014-2021 (%)
  decline          harmonized MODIS 2003-2005 / S-NPP 2021-2025, mean annual national cell-days:
                   a quick check of the headline decline (the app uses the full pipeline)
Only days on which Terra, Aqua and S-NPP all delivered data are used for fitting and testing.
The baseline reproduces 05_validate.py.

AI-assistance note: drafted with an AI coding assistant (Claude) and reviewed by the author.
"""
import json

import numpy as np
import pandas as pd

from common import INT

BASE = dict(conf="default", dilate=1, min_static=3, mask=True, res=0.01, tile_deg=3.0, lam=200.0)
VARIANTS = [
    ("baseline", {}),
    ("no confidence filter", {"conf": "none"}),
    ("stricter MODIS confidence (>= 50)", {"conf": "strict"}),
    ("static mask without dilation", {"dilate": 0}),
    ("no static mask", {"mask": False}),
    ("cell size 0.005 deg", {"res": 0.005}),
    ("cell size 0.02 deg", {"res": 0.02}),
    ("tiles 2 deg", {"tile_deg": 2.0}),
    ("tiles 5 deg", {"tile_deg": 5.0}),
    ("shrinkage 0", {"lam": 0.0}),
    ("shrinkage 50", {"lam": 50.0}),
    ("shrinkage 1000", {"lam": 1000.0}),
]

raw = pd.read_parquet(INT / "hotspots_all.parquet",
                      columns=["lat", "lon", "date", "sensor", "conf_raw", "conf_ok", "type"])
raw["sensor"] = raw["sensor"].astype(str)
# the static mask is built from all five sensors, as in 02_grid.py; the fits use Terra, Aqua and S-NPP
static_pts = raw.loc[raw["type"].isin([2, 3]).fillna(False), ["lat", "lon"]].reset_index(drop=True)
raw = raw[raw["sensor"].isin(["MODIS_T", "MODIS_A", "VNP"])].reset_index(drop=True)
is_modis = raw["sensor"].str.startswith("MODIS")
modis_conf = pd.to_numeric(raw["conf_raw"].where(is_modis), errors="coerce")

av = pd.read_parquet(INT / "sensor_availability.parquet")
up = av.pivot(index="date", columns="sensor", values="available").fillna(False).astype(bool)
both = up[["MODIS_T", "MODIS_A", "VNP"]].all(axis=1)
cal_days = set(both[both & (both.index >= "2012-01-20") & (both.index <= "2021-12-31")].index)
modis_both = up[["MODIS_T", "MODIS_A"]].all(axis=1)
early_days = set(modis_both[modis_both & (modis_both.index >= "2003-01-01")
                            & (modis_both.index <= "2005-12-31")].index)
late_days = set(up.index[up["VNP"] & (up.index >= "2021-01-01") & (up.index <= "2025-12-31")])


def celldays(p):
    """(fam, date, tile, ci, cj) rows: one per fire cell-day, MODIS = Terra or Aqua."""
    ci = np.floor(raw["lat"] / p["res"]).astype("int64")
    cj = np.floor(raw["lon"] / p["res"]).astype("int64")
    if p["conf"] == "none":
        keep = pd.Series(True, index=raw.index)
    elif p["conf"] == "strict":
        keep = raw["conf_ok"] & (~is_modis | (modis_conf >= 50))
    else:
        keep = raw["conf_ok"].copy()
    keep &= raw["type"].isna() | (raw["type"] == 0)
    if p["mask"]:
        st = pd.DataFrame({"ci": np.floor(static_pts["lat"] / p["res"]).astype("int64"),
                           "cj": np.floor(static_pts["lon"] / p["res"]).astype("int64")})
        st = st.value_counts().rename("n").reset_index()
        st = st[st["n"] >= p["min_static"]]
        d = p["dilate"]
        cells = set()
        for a in range(-d, d + 1):
            for b in range(-d, d + 1):
                cells.update(zip(st["ci"] + a, st["cj"] + b))
        key = ci * 100000 + cj
        masked = key.isin({i * 100000 + j for i, j in cells})
        keep &= ~masked
    df = pd.DataFrame({"fam": np.where(is_modis, "M", "V"), "date": raw["date"], "ci": ci, "cj": cj})[keep]
    df = df.drop_duplicates(["fam", "date", "ci", "cj"])
    tile_cells = int(round(p["tile_deg"] / p["res"]))
    df["tile"] = (df["ci"] // tile_cells) * 100000 + (df["cj"] // tile_cells)
    df["year"] = df["date"].dt.year
    return df


def fit(tr, lam):
    k = tr["V"].sum() / tr["M"].sum()
    s = tr.groupby("tile")[["V", "M"]].sum()
    s = s[s["M"] + lam > 0]
    return k, ((s["V"] + lam * k) / (s["M"] + lam)).rename("k")


def predict(te, k, table):
    f = te.merge(table, left_on="tile", right_index=True, how="left")["k"].fillna(k).to_numpy()
    return te["M"].to_numpy() * f


cache, rows = {}, []
for name, change in VARIANTS:
    p = {**BASE, **change}
    ckey = (p["conf"], p["dilate"], p["min_static"], p["mask"], p["res"], p["tile_deg"])
    if ckey not in cache:
        cache[ckey] = celldays(p)
    df = cache[ckey]
    cal = df[df["date"].isin(cal_days)]
    cnt = cal.groupby(["tile", "year", "fam"]).size().unstack("fam", fill_value=0).reset_index()

    nat, tile_err = [], []
    for y in range(2012, 2022):
        tr, te = cnt[cnt["year"] != y], cnt[cnt["year"] == y].copy()
        k, table = fit(tr, p["lam"])
        te["p"] = predict(te, k, table)
        nat.append(te["p"].sum() / te["V"].sum() - 1)
        t = te[te["V"] >= 200]
        tile_err += list((t["p"] / t["V"] - 1).abs())

    back = {}
    k14, t14 = fit(cnt[cnt["year"].between(2014, 2021)], p["lam"])
    for y in (2012, 2013):
        te = cnt[cnt["year"] == y]
        back[y] = 100 * (predict(te, k14, t14).sum() / te["V"].sum() - 1)

    k_all, t_all = fit(cnt, p["lam"])
    early = df[(df["fam"] == "M") & df["date"].isin(early_days)].groupby("tile").size().rename("M").reset_index()
    early_h = predict(early, k_all, t_all).sum() / 3
    late = (df["fam"].eq("V") & df["date"].isin(late_days)).sum() / 5

    rows.append({"variant": name, "k_national": round(float(k_all), 3),
                 "loyo_nat_med": round(100 * float(np.median(np.abs(nat))), 1),
                 "loyo_tile_med": round(100 * float(np.median(tile_err)), 1),
                 "loyo_tile_p90": round(100 * float(np.percentile(tile_err, 90)), 1),
                 "backcast_2012": round(back[2012], 1), "backcast_2013": round(back[2013], 1),
                 "decline": round(float(early_h / late), 2)})
    print(rows[-1], flush=True)

res = pd.DataFrame(rows)
res.to_csv(INT / "sensitivity.csv", index=False)
(INT / "sensitivity.json").write_text(json.dumps(rows, indent=1))
print("\n" + res.to_string(index=False))
