"""Step 8 (optional): does the method transfer to other countries?

Usage : python 08_transfer.py Kazakhstan Ukraine Portugal Mongolia
Inputs: FIRMS yearly country files, 2012-2021, MODIS and VIIRS S-NPP (standard data), downloaded on first use to
        data/transfer/<Country>/ from https://firms.modaps.eosdis.nasa.gov/data/country/
Output: data/interim/transfer.csv

For each country the same steps as for Kazakhstan are run with the same settings, nothing retuned:
cleaning and static-source mask (02), outage detection (03), fire cell-days on a 0.01 degree grid, MODIS -> S-NPP
factors per 3-degree tile with shrinkage 200, and the leave-one-year-out test on 2012-2021 (05). "Kazakhstan" is a
control: it must come out close to the main pipeline (3.0% national, 7.6% per tile), although it uses a different
download and no NOAA satellites.

AI-assistance note: drafted with an AI coding assistant (Claude) and reviewed by the author.
"""
import os
import subprocess
import sys
import urllib.request

import numpy as np
import pandas as pd

from common import ROOT

YEARS = range(2012, 2022)
PRODUCTS = {"modis": "MODIS", "viirs-snpp": "VNP"}
URL = "https://firms.modaps.eosdis.nasa.gov/data/country/{prod}/{year}/{prod}_{year}_{country}.csv"
RES, TILE_DEG, LAM, MIN_STATIC, DILATE, MODIS_CONF_MIN = 0.01, 3.0, 200.0, 3, 1, 30
HERE = ROOT / "scripts"


def fetch(country):
    folder = ROOT / "data" / "transfer" / country
    folder.mkdir(parents=True, exist_ok=True)
    for prod in PRODUCTS:
        for y in YEARS:
            f = folder / f"{prod}_{y}_{country}.csv"
            if f.exists() and f.stat().st_size > 0:
                continue
            url = URL.format(prod=prod, year=y, country=country)
            print("  downloading", url, flush=True)
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (dala-fire transfer test)"})
            try:
                with urllib.request.urlopen(req, timeout=300) as r, open(f, "wb") as out:
                    out.write(r.read())
            except Exception as e:                      # leave no half-written file behind
                f.unlink(missing_ok=True)
                raise SystemExit(f"Could not download {url}: {e}\nDownload it in a browser and save it as {f}")
    return folder


def load(folder, country):
    frames = []
    for prod, family in PRODUCTS.items():
        for y in YEARS:
            df = pd.read_csv(folder / f"{prod}_{y}_{country}.csv", dtype={"acq_time": str, "confidence": str, "version": str})
            out = pd.DataFrame({"lat": df["latitude"].astype("float32"), "lon": df["longitude"].astype("float32"),
                                "date": pd.to_datetime(df["acq_date"]), "daynight": df["daynight"].astype(str),
                                "conf_raw": df["confidence"].astype(str), "src": "SP"})
            if family == "MODIS":
                out["sensor"] = df["satellite"].map({"Terra": "MODIS_T", "Aqua": "MODIS_A"})
                out["conf_ok"] = pd.to_numeric(df["confidence"], errors="coerce") >= MODIS_CONF_MIN
            else:
                out["sensor"] = family
                out["conf_ok"] = df["confidence"].str.lower().isin(["n", "h", "nominal", "high"])
            out["type"] = df["type"].astype("Int8") if "type" in df.columns else pd.array([pd.NA] * len(df), dtype="Int8")
            frames.append(out)
    return pd.concat(frames, ignore_index=True).sort_values(["date", "sensor"]).reset_index(drop=True)


def celldays(raw):
    """Fire cell-days per (family, date, cell) after the same cleaning as 02_grid.py."""
    ci = np.floor(raw["lat"] / RES).astype("int64")
    cj = np.floor(raw["lon"] / RES).astype("int64")
    static = raw["type"].isin([2, 3]).fillna(False).to_numpy()
    st = pd.DataFrame({"ci": ci[static], "cj": cj[static]}).value_counts().rename("n").reset_index()
    st = st[st["n"] >= MIN_STATIC]
    cells = set()
    for a in range(-DILATE, DILATE + 1):
        for b in range(-DILATE, DILATE + 1):
            cells.update(zip(st["ci"] + a, st["cj"] + b))
    masked = (ci * 100000 + cj).isin({i * 100000 + j for i, j in cells})
    keep = raw["conf_ok"] & (raw["type"].isna() | (raw["type"] == 0)) & ~masked
    fam = np.where(raw["sensor"].astype(str).str.startswith("MODIS"), "M", "V")
    df = pd.DataFrame({"fam": fam, "date": raw["date"], "ci": ci, "cj": cj})[keep].drop_duplicates()
    tc = int(round(TILE_DEG / RES))
    df["tile"] = (df["ci"] // tc) * 100000 + (df["cj"] // tc)
    df["year"] = df["date"].dt.year
    return df, float(keep.mean())


def fit(tr, lam):
    k = tr["V"].sum() / tr["M"].sum()
    s = tr.groupby("tile")[["V", "M"]].sum()
    s = s[s["M"] + lam > 0]
    return k, ((s["V"] + lam * k) / (s["M"] + lam)).rename("k")


def evaluate(country):
    folder = fetch(country)
    interim = folder / "interim"
    interim.mkdir(exist_ok=True)
    raw = load(folder, country)
    raw.to_parquet(interim / "hotspots_all.parquet", index=False)
    env = {**os.environ, "DALA_INT": str(interim)}
    subprocess.run([sys.executable, str(HERE / "03_availability.py")], check=True, env=env, cwd=HERE, stdout=subprocess.DEVNULL)
    av = pd.read_parquet(interim / "sensor_availability.parquet")
    up = av.pivot(index="date", columns="sensor", values="available").fillna(False).astype(bool)
    days = set(up.index[up[["MODIS_T", "MODIS_A", "VNP"]].all(axis=1) & (up.index >= "2012-01-20")])

    df, kept = celldays(raw)
    cnt = df[df["date"].isin(days)].groupby(["tile", "year", "fam"]).size().unstack("fam", fill_value=0).reset_index()
    for col in ("M", "V"):
        if col not in cnt:
            cnt[col] = 0
    err = {"naive": [], "national": [], "tiles": []}
    tile_err = {"national": [], "tiles": []}
    for y in YEARS:
        tr, te = cnt[cnt["year"] != y], cnt[cnt["year"] == y].copy()
        k, table = fit(tr, LAM)
        te["national"] = te["M"] * k
        te["tiles"] = te["M"] * te.merge(table, left_on="tile", right_index=True, how="left")["k"].fillna(k).to_numpy()
        err["naive"].append(te["M"].sum() / te["V"].sum() - 1)
        t = te[te["V"] >= 200]
        for m in ("national", "tiles"):
            err[m].append(te[m].sum() / te["V"].sum() - 1)
            tile_err[m] += list((t[m] / t["V"] - 1).abs())
    k_all, table = fit(cnt, LAM)
    med = lambda v: round(100 * float(np.median(np.abs(v))), 1) if len(v) else float("nan")
    return {"country": country, "detections": len(raw), "kept_pct": round(100 * kept, 1),
            "viirs_celldays_per_year": int(cnt["V"].sum() / len(YEARS)), "calibration_days": len(days),
            "k_national": round(float(k_all), 2), "k_tile_min": round(float(table.min()), 2), "k_tile_max": round(float(table.max()), 2),
            "naive_nat_err": med(err["naive"]), "national_factor_nat_err": med(err["national"]), "tiles_nat_err": med(err["tiles"]),
            "tiles_nat_err_max": round(100 * float(np.max(np.abs(err["tiles"]))), 1),
            "national_factor_tile_err": med(tile_err["national"]), "tiles_tile_err": med(tile_err["tiles"]),
            "tiles_tested": len(tile_err["tiles"])}


if __name__ == "__main__":
    countries = sys.argv[1:] or ["Kazakhstan", "Ukraine", "Portugal", "Mongolia"]
    rows = []
    for c in countries:
        print(c, flush=True)
        rows.append(evaluate(c))
        print("  ", rows[-1], flush=True)
    res = pd.DataFrame(rows)
    out = ROOT / "data" / "interim" / "transfer.csv"
    res.to_csv(out, index=False)
    print("\n" + res.T.to_string(header=False))
    print(f"\nSaved {out}")
