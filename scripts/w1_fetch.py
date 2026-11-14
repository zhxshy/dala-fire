"""World layer, step 1: FIRMS yearly world files -> daily fire cell-days per 0.5 degree cell.

Usage : python w1_fetch.py [--first 2001] [--last 2025] [--tmp DIR] [--base URL] [--keep]
Inputs: https://firms.modaps.eosdis.nasa.gov/data/country/zips/<product>_<year>_all_countries.zip
        (standard-quality data, one CSV per country), products modis, viirs-snpp, viirs-jpss1
Output: data/world/daily/<year>.parquet       date, gi, gj, nM, nT, nA, nV, nJ
        data/world/raw_counts/<year>.parquet  date, sensor, n   (all detections, for outage detection)
        data/world/fetch_log.json

The unit is the same as in the Kazakhstan pipeline: a fire cell-day is a 0.01 degree cell with at least one clean
detection on a day (MODIS confidence >= 30, VIIRS nominal or high, FIRMS type 0). Here the cell-days are counted
inside 0.5 degree cells (gi = floor(lat / 0.5), gj = floor(lon / 0.5)):
  nT, nA  cell-days seen by Terra, by Aqua          nM  seen by Terra or Aqua
  nV      seen by VIIRS on Suomi NPP                nJ  seen by VIIRS on NOAA-20
Static heat sources: 0.01 degree cells with at least 2 detections of FIRMS type 2 or 3 in that country and year
(any sensor), and their eight neighbours, are dropped. (The Kazakhstan pipeline builds this mask from all years.)
A year is processed country by country and the downloads are deleted, so memory and disk stay small. A cell on a
border can be counted once per country; the effect is far below one percent.

AI-assistance note: drafted with an AI coding assistant (Claude) and reviewed by the author.
"""
import argparse
import io
import json
import os
import shutil
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd

from common import ROOT

BASE = "https://firms.modaps.eosdis.nasa.gov/data/country/zips/"
# product -> (first year tried, file-name prefixes tried in turn). The first prefix is the one FIRMS uses today;
# the others are spellings seen elsewhere, tried only if the first is not found.
PRODUCTS = {"modis": (2001, ["modis"]),
            "viirs-snpp": (2012, ["viirs-snpp", "viirs_snpp", "suomi-viirs"]),
            "viirs-jpss1": (2018, ["viirs-jpss1", "viirs_jpss1", "viirs-noaa20", "noaa-20"])}
REQUIRED = {"modis": (2001, 2025), "viirs-snpp": (2012, 2025)}       # a year without these is not written
RES, COARSE = 0.01, 50                     # fine cell in degrees; fine cells per 0.5 degree cell
MODIS_CONF_MIN, MIN_STATIC = 30, 2
EPOCH = np.datetime64("2000-01-01")
OUT = Path(os.environ["DALA_WORLD"]) if os.environ.get("DALA_WORLD") else ROOT / "data" / "world"   # e.g. a Drive folder on Colab
T, A, V, J = 1, 2, 4, 8
COLS = ["latitude", "longitude", "acq_date", "satellite", "confidence", "type"]


def download(url, dest):
    """Fetch url to dest. Returns size in MB, or None when the file does not exist (HTTP 403 or 404)."""
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (dala-fire world layer)"})
            with urllib.request.urlopen(req, timeout=180) as r, open(dest, "wb") as out:
                shutil.copyfileobj(r, out, 1 << 20)
            return dest.stat().st_size / 1e6
        except urllib.error.HTTPError as e:
            if e.code in (403, 404):
                return None
            err = e
        except urllib.error.URLError as e:
            if isinstance(e.reason, FileNotFoundError):                # file:// base used in tests
                return None
            err = e
        except Exception as e:                                         # network hiccup: wait and retry
            err = e
        time.sleep(10 * (attempt + 1))
    raise SystemExit(f"download failed: {url} ({err})")


def read_country(zf, member, product):
    """One country's detections of one product as (day, ci, cj, bit, ok, static) arrays."""
    with zf.open(member) as fh:
        head = pd.read_csv(io.TextIOWrapper(fh, "utf-8"), nrows=0).columns
    use = [c for c in COLS if c in head]
    with zf.open(member) as fh:      # categories keep the big country files small in memory
        df = pd.read_csv(fh, usecols=use, dtype={"confidence": "category", "satellite": "category", "acq_date": "category"})
    if df.empty:
        return None
    dates = pd.to_datetime(pd.Series(df["acq_date"].cat.categories)).to_numpy("datetime64[D]")
    day = (dates[df["acq_date"].cat.codes.to_numpy()] - EPOCH).astype("int32")
    conf = pd.Series(df["confidence"].cat.categories.astype(str)).str.strip().str.lower()
    code = df["confidence"].cat.codes.to_numpy()                       # -1 = empty field
    ci = np.floor(df["latitude"].to_numpy("float64") / RES).astype("int32")
    cj = np.floor(df["longitude"].to_numpy("float64") / RES).astype("int32")
    if product == "modis":
        terra = pd.Series(df["satellite"].cat.categories.astype(str)).str.strip().str.lower().str.startswith("t").to_numpy()
        bit = np.where(terra[df["satellite"].cat.codes.to_numpy()], T, A).astype("uint8")
        good = (pd.to_numeric(conf, errors="coerce") >= MODIS_CONF_MIN).to_numpy()
    else:
        bit = np.full(len(df), V if product == "viirs-snpp" else J, "uint8")
        good = conf.isin(["n", "h", "nominal", "high"]).to_numpy()
    ok = np.where(code >= 0, good[code], False) if len(good) else np.zeros(len(df), bool)
    if "type" in df:
        typ = pd.to_numeric(df["type"], errors="coerce")
        static = typ.isin([2, 3]).to_numpy()
        ok = ok & (typ.isna() | (typ == 0)).to_numpy()
    else:
        static = np.zeros(len(df), bool)
    return pd.DataFrame({"day": day, "ci": ci, "cj": cj, "bit": bit, "ok": ok, "static": static})


def country_celldays(parts):
    """Clean, mask, and count one country's fire cell-days per (day, 0.5 degree cell)."""
    df = pd.concat(parts, ignore_index=True)
    raw = df.groupby(["day", "bit"], sort=False).size().rename("n").reset_index()
    st = df.loc[df["static"], ["ci", "cj"]].value_counts()
    st = st[st >= MIN_STATIC].reset_index()[["ci", "cj"]]
    df = df[df["ok"]]
    if len(st) and len(df):
        key = lambda a, b: a.astype("int64") * 100000 + b
        masked = np.unique(np.concatenate([key(st["ci"].to_numpy() + da, st["cj"].to_numpy() + db)
                                           for da in (-1, 0, 1) for db in (-1, 0, 1)]))
        df = df[~np.isin(key(df["ci"].to_numpy(), df["cj"].to_numpy()), masked)]
    if df.empty:
        return None, raw
    cd = df.groupby(["day", "ci", "cj", "bit"], sort=False).size().reset_index()[["day", "ci", "cj", "bit"]]
    cd = cd.groupby(["day", "ci", "cj"], sort=False)["bit"].sum().reset_index()      # bits are distinct, so sum = OR
    b = cd["bit"].to_numpy()
    out = pd.DataFrame({"day": cd["day"], "gi": (cd["ci"] // COARSE).astype("int16"), "gj": (cd["cj"] // COARSE).astype("int16"),
                        "nM": (b & (T | A) > 0).astype("int32"), "nT": (b & T > 0).astype("int32"), "nA": (b & A > 0).astype("int32"),
                        "nV": (b & V > 0).astype("int32"), "nJ": (b & J > 0).astype("int32")})
    return out.groupby(["day", "gi", "gj"], sort=False).sum().reset_index(), raw


def country_of(member, product, year):
    """Country name from 'viirs-snpp_2019_Afghanistan.csv' (any folder, any product spelling)."""
    stem = Path(member).stem
    tag = f"_{year}_"
    return stem.split(tag, 1)[1] if tag in stem else stem


def process_year(year, base, tmp, keep):
    zips, info = {}, {}
    for product, (first, prefixes) in PRODUCTS.items():
        if year < first:
            continue
        dest = tmp / f"{product}_{year}.zip"
        t0 = time.time()
        mb, url = (dest.stat().st_size / 1e6, "kept from an earlier run") if dest.exists() else (None, None)
        for prefix in ([] if mb else prefixes):
            url = f"{base.rstrip('/')}/{prefix}_{year}_all_countries.zip"
            mb = download(url, dest)
            if mb is not None:
                break
        if mb is None:
            lo, hi = REQUIRED.get(product, (1, 0))
            if lo <= year <= hi:
                raise SystemExit(f"  {product} {year}: not found under any of {prefixes} at {base}. "
                                 f"This year is not written. Send this message back before running again.")
            print(f"  {product} {year}: not published", flush=True)
            continue
        zips[product] = zipfile.ZipFile(dest)
        info[product] = {"url": url, "zip_mb": round(mb, 1), "download_s": round(time.time() - t0)}
        print(f"  {product} {year}: {mb:,.0f} MB in {time.time() - t0:,.0f} s", flush=True)
    if "modis" not in zips and "viirs-snpp" not in zips:
        return None
    members = {p: {country_of(m, p, year): m for m in z.namelist()
                   if m.lower().endswith(".csv") and not Path(m).name.startswith(".") and "__MACOSX" not in m}
               for p, z in zips.items()}
    countries = sorted(set().union(*[set(m) for m in members.values()]))
    cells, raws, n_det, failed = [], [], 0, []
    for c in countries:
        try:
            parts = [x for x in (read_country(zips[p], members[p][c], p) for p in zips if c in members[p]) if x is not None]
        except Exception as e:                       # one unreadable file must not stop a two-hour run; it is reported
            failed.append(f"{c}: {type(e).__name__}: {e}")
            print(f"  could not read {c}: {e}", flush=True)
            continue
        if not parts:
            continue
        n_det += sum(len(x) for x in parts)
        cd, raw = country_celldays(parts)
        raws.append(raw)
        if cd is not None:
            cells.append(cd)
    daily = pd.concat(cells, ignore_index=True).groupby(["day", "gi", "gj"], sort=True).sum().reset_index()
    daily.insert(0, "date", EPOCH + daily.pop("day").to_numpy().astype("timedelta64[D]"))
    raw = pd.concat(raws, ignore_index=True).groupby(["day", "bit"]).sum().reset_index()
    raw["sensor"] = raw["bit"].map({T: "MODIS_T", A: "MODIS_A", V: "VNP", J: "VJ1"})
    raw.insert(0, "date", EPOCH + raw.pop("day").to_numpy().astype("timedelta64[D]"))
    (OUT / "daily").mkdir(parents=True, exist_ok=True)
    (OUT / "raw_counts").mkdir(parents=True, exist_ok=True)
    daily.to_parquet(OUT / "daily" / f"{year}.parquet", index=False)
    raw[["date", "sensor", "n"]].to_parquet(OUT / "raw_counts" / f"{year}.parquet", index=False)
    for p, z in zips.items():
        z.close()
        if not keep:
            (tmp / f"{p}_{year}.zip").unlink(missing_ok=True)
    return {"year": year, "countries": len(countries), "failed": failed, "detections": int(n_det), "rows": len(daily),
            "celldays": {k: int(daily[k].sum()) for k in ("nM", "nT", "nA", "nV", "nJ")}, "products": info}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--first", type=int, default=2001)
    ap.add_argument("--last", type=int, default=2025)
    ap.add_argument("--base", default=BASE)
    ap.add_argument("--tmp", default=None, help="folder for downloads (default: system temp)")
    ap.add_argument("--keep", action="store_true", help="keep the downloaded zips")
    a = ap.parse_args()
    tmp = Path(a.tmp or tempfile.mkdtemp(prefix="dala_world_"))
    tmp.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
    log_path = OUT / "fetch_log.json"
    log = json.loads(log_path.read_text()) if log_path.exists() else {}
    for year in range(a.last, a.first - 1, -1):          # newest first: the VIIRS years are the big ones
        if (OUT / "daily" / f"{year}.parquet").exists():
            print(f"{year}: already done", flush=True)
            continue
        print(f"{year}:", flush=True)
        t0 = time.time()
        res = process_year(year, a.base, tmp, a.keep)
        if res is None:
            print(f"  nothing published for {year}", flush=True)
            continue
        res["seconds"] = round(time.time() - t0)
        log[str(year)] = res
        log_path.write_text(json.dumps(log, indent=1))
        print(f"  {res['detections']:,} detections, {res['countries']} countries -> {res['rows']:,} rows; "
              f"cell-days MODIS {res['celldays']['nM']:,}, S-NPP {res['celldays']['nV']:,}, NOAA-20 {res['celldays']['nJ']:,} "
              f"({res['seconds']} s)", flush=True)
    done = sorted(int(p.stem) for p in (OUT / "daily").glob("*.parquet"))
    print(f"\nYears ready: {done[0]}-{done[-1]} ({len(done)})" if done else "\nNo years ready", file=sys.stderr if not done else sys.stdout)
