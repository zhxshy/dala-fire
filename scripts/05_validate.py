"""Step 5: validate the harmonization on years the model did not see.

Inputs : data/interim/celldays.parquet, sensor_availability.parquet, national_monthly_harmonized.csv
Outputs: data/interim/validation.json            all numbers quoted in the app, slides and project page
         data/interim/error_by_count.csv         obs/pred spread by predicted size (drives the UI band)
         figures/02_before_after.png

Checks
  1. Leave-one-year-out (LOYO), 2012-2021: refit factors without year y, predict y's S-NPP cell-days
     from MODIS. Error of annual totals for the country and for 3-degree tiles; several models.
  2. Error vs size: obs/pred for every area x period (0.25/0.5/1/3 degree x month/year), binned by the
     predicted count -> p10/p50/p90 used as the uncertainty band for any area in the app.
  3. Backcast across the seam: fit on 2014-2021 only, predict 2012-2013.
  4. Drift: model fitted on 2012-2021, tested on 2022-2025 (MODIS orbit drift years).
  5. Seam control: 2011 -> 2012 change in naive splice vs MODIS alone vs harmonized.
Only days on which Terra, Aqua and S-NPP all delivered data are used.

AI-assistance note: drafted with an AI coding assistant (Claude) and reviewed by the author.
"""
import json

import matplotlib
import numpy as np
import pandas as pd

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

from common import INT, ROOT  # noqa: E402

TILE, LAMBDA = 300, 200.0
SEASON = {12: 0, 1: 0, 2: 0, 3: 1, 4: 1, 5: 1, 6: 2, 7: 2, 8: 2, 9: 3, 10: 3, 11: 3}

cd = pd.read_parquet(INT / "celldays.parquet", columns=["sensor", "date", "ci", "cj"])
cd["sensor"] = cd["sensor"].astype(str)
av = pd.read_parquet(INT / "sensor_availability.parquet")
up = av.pivot(index="date", columns="sensor", values="available").fillna(False).astype(bool)
ok = up[["MODIS_T", "MODIS_A", "VNP"]].all(axis=1)
ok_days = ok[ok & (ok.index >= "2012-01-20") & (ok.index <= "2025-12-31")].index

M = cd[cd["sensor"].isin(["MODIS_T", "MODIS_A"])].drop_duplicates(["date", "ci", "cj"]).assign(fam="M")
V = cd[cd["sensor"] == "VNP"].assign(fam="V")
x = pd.concat([M, V])
x = x[x["date"].isin(ok_days)]
x["year"], x["month"] = x["date"].dt.year, x["date"].dt.month
x["tile"] = (x["ci"] // TILE) * 1000 + (x["cj"] // TILE)
x["season"] = x["month"].map(SEASON)
for g, step in [("g025", 25), ("g05", 50), ("g1", 100)]:
    x[g] = (x["ci"] // step) * 10000 + (x["cj"] // step)

# monthly counts per 0.25-degree cell (finest unit used below), with tile and season keys
cnt = (x.groupby(["g025", "g05", "g1", "tile", "season", "year", "month", "fam"]).size()
       .unstack("fam", fill_value=0).reset_index())


def fit(train, keys, lam):
    """Factor table: national ratio, or per-key ratios shrunk toward it."""
    k = train["V"].sum() / train["M"].sum()
    if not keys:
        return k, None
    s = train.groupby(keys)[["V", "M"]].sum()
    s = s[s["M"] + lam > 0]                       # no MODIS at all and no shrinkage -> national factor
    return k, ((s["V"] + lam * k) / (s["M"] + lam)).rename("k")


def predict(test, k, table, keys):
    if table is None:
        return test["M"] * k
    f = test.merge(table, left_on=keys, right_index=True, how="left")["k"].fillna(k).to_numpy()
    return test["M"].to_numpy() * f


MODELS = {
    "naive (no correction)": ([], None),
    "one national factor": ([], 0),
    "3-deg tiles, no shrinkage": (["tile"], 0.0),
    "3-deg tiles, shrinkage 200": (["tile"], LAMBDA),
    "3-deg tiles x season, shrinkage 200": (["tile", "season"], LAMBDA),
}

# --- 1. LOYO 2012-2021 ---------------------------------------------------------------------------
cal = cnt[cnt["year"] <= 2021]
loyo, preds = {}, []
for name, (keys, lam) in MODELS.items():
    nat_err, tile_err = [], []
    for y in range(2012, 2022):
        tr, te = cal[cal["year"] != y], cal[cal["year"] == y].copy()
        if lam is None:
            te["p"] = te["M"].astype(float)
        else:
            k, table = fit(tr, keys, lam)
            te["p"] = predict(te, k, table, keys)
        nat_err.append(te["p"].sum() / te["V"].sum() - 1)
        t = te.groupby("tile")[["p", "V"]].sum()
        t = t[t["V"] >= 200]
        tile_err += list((t["p"] / t["V"] - 1).abs())
        if name == "3-deg tiles, shrinkage 200":
            preds.append(te)
    loyo[name] = {"national_median_abs_pct": round(100 * float(np.median(np.abs(nat_err))), 1),
                  "national_max_abs_pct": round(100 * float(np.max(np.abs(nat_err))), 1),
                  "tile_median_abs_pct": round(100 * float(np.median(tile_err)), 1),
                  "tile_p90_abs_pct": round(100 * float(np.percentile(tile_err, 90)), 1)}
pred = pd.concat(preds)

# --- 2. error vs predicted size (from the chosen model's out-of-sample predictions) ---------------
rows = []
for g in ["g025", "g05", "g1", "tile"]:
    for per in [["year", "month"], ["year"]]:
        a = pred.groupby([g] + per)[["p", "V"]].sum()
        a = a[a["p"] >= 3]
        rows.append(pd.DataFrame({"grid": g, "period": per[-1], "p": a["p"], "obs": a["V"]}))
err = pd.concat(rows, ignore_index=True)
err["ratio"] = err["obs"] / err["p"]
bins = [3, 10, 30, 100, 300, 1000, 3000, np.inf]
labels = ["3-10", "10-30", "30-100", "100-300", "300-1000", "1000-3000", "3000+"]
err["size"] = pd.cut(err["p"], bins, labels=labels, right=False)
band = err.groupby("size", observed=True)["ratio"].agg(
    n="size", p10=lambda r: r.quantile(0.1), p50="median", p90=lambda r: r.quantile(0.9)).round(3)
band.to_csv(INT / "error_by_count.csv")

# zero-inflation: share of S-NPP activity in area-months where MODIS saw nothing
zero = {}
for g, label in [("g025", "0.25"), ("g05", "0.5"), ("g1", "1")]:
    a = cal.groupby([g, "year", "month"])[["M", "V"]].sum()
    zero[label] = round(100 * float(a.loc[a["M"] == 0, "V"].sum() / a["V"].sum()), 1)

# --- 3. backcast across the seam, 4. drift years ---------------------------------------------------
def holdout(train_years, test_years):
    tr = cnt[cnt["year"].isin(train_years)]
    k, table = fit(tr, ["tile"], LAMBDA)
    out = {}
    for y in test_years:
        te = cnt[cnt["year"] == y]
        out[str(y)] = round(100 * float(predict(te, k, table, ["tile"]).sum() / te["V"].sum() - 1), 1)
    return out


backcast = holdout(range(2014, 2022), [2012, 2013])
drift = holdout(range(2012, 2022), [2022, 2023, 2024, 2025])

# --- 5. seam control -------------------------------------------------------------------------------
nat = pd.read_csv(INT / "national_monthly_harmonized.csv", index_col=0)
nat.index = pd.PeriodIndex(nat.index, freq="M")
yr = nat.groupby(nat.index.year)[["modis_raw", "vnp_raw", "harmonized"]].sum()
naive = np.where(yr.index < 2012, yr["modis_raw"], yr["vnp_raw"])
seam = {"naive_splice": round(float(naive[yr.index == 2012][0] / naive[yr.index == 2011][0]), 2),
        "modis_only": round(float(yr.loc[2012, "modis_raw"] / yr.loc[2011, "modis_raw"]), 2),
        "harmonized": round(float(yr.loc[2012, "harmonized"] / yr.loc[2011, "harmonized"]), 2)}

# --- 6. is the ratio the same in every year, and is the decline there in each sensor on its own? ----
by_year = cnt[cnt["year"] <= 2021].groupby("year")[["V", "M"]].sum()
ratio_by_year = {"ratio": {str(y): round(float(r["V"] / r["M"]), 3) for y, r in by_year.iterrows()},
                 "fire_max_over_min": round(float(by_year["V"].max() / by_year["V"].min()), 1)}
single = {"modis_2001_2005_to_2021_2025": round(float(yr.loc[2001:2005, "modis_raw"].mean() / yr.loc[2021:2025, "modis_raw"].mean()), 1),
          "viirs_2012_2014_to_2021_2025": round(float(yr.loc[2012:2014, "vnp_raw"].mean() / yr.loc[2021:2025, "vnp_raw"].mean()), 1),
          "harmonized_2001_2005_to_2021_2025": round(float(yr.loc[2001:2005, "harmonized"].mean() / yr.loc[2021:2025, "harmonized"].mean()), 1)}

result = {"days_used": len(ok_days), "loyo_2012_2021": loyo, "ratio_by_year": ratio_by_year, "decline_single_sensor": single, "error_vs_size": band.reset_index().to_dict("records"),
          "share_of_viirs_where_modis_zero_pct": zero, "backcast_2012_2013_pct": backcast,
          "drift_2022_2025_pct": drift, "seam_2011_to_2012_ratio": seam}
(INT / "validation.json").write_text(json.dumps(result, indent=1, default=str))

# --- figure ----------------------------------------------------------------------------------------
y = yr[(yr.index >= 2001) & (yr.index <= 2025)]
nv = pd.Series(naive, index=yr.index).loc[y.index]
fig, ax = plt.subplots(figsize=(10, 4.8), dpi=150)
ax.plot(y.index, nv / 1e3, color="#d62728", lw=2, label="Naive splice (MODIS until 2011, VIIRS after)")
ax.plot(y.index, y["harmonized"] / 1e3, color="#1a1a1a", lw=2.4, label="Harmonized (VIIRS S-NPP scale)")
ax.plot(y.index[y.index <= 2011], y["modis_raw"][y.index <= 2011] / 1e3, color="#8c8c8c", lw=1.2, ls="--",
        label="MODIS raw")
ax.axvline(2011.5, color="#999", lw=0.8)
ax.text(2011.7, ax.get_ylim()[1] * 0.93, "MODIS → VIIRS", fontsize=8, color="#555")
ax.set_ylabel("Fire cell-days per year (thousands)")
ax.set_title("Kazakhstan fire record 2001–2025: naive splice vs harmonized (NASA FIRMS)")
ax.legend(frameon=False, fontsize=8)
ax.spines[["top", "right"]].set_visible(False)
fig.tight_layout()
(ROOT / "figures").mkdir(exist_ok=True)
fig.savefig(ROOT / "figures" / "02_before_after.png")

print(f"days used: {len(ok_days)}\n\nLOYO 2012-2021 (abs error of annual totals):")
print(pd.DataFrame(loyo).T.to_string())
print("\nobs/pred by predicted size (any area, month or year):\n", band.to_string())
print("\nS-NPP activity where MODIS saw nothing (% , by area-month size):", zero)
print("backcast 2012-2013 (fit 2014-2021), % error:", backcast)
print("drift years 2022-2025 (fit 2012-2021), % error:", drift)
print("seam 2011->2012:", seam)
print("S-NPP / MODIS by calibration year:", ratio_by_year)
print("decline in one sensor alone:", single)
