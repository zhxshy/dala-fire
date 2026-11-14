"""Step 1: load FIRMS archive (SP) + NRT CSVs for Kazakhstan into one clean Parquet.

Input : data/raw/fire_archive_*.csv, data/raw/fire_nrt_*.csv  (FIRMS Archive Download, country = Kazakhstan)
Output: data/interim/hotspots_all.parquet  (one row per detection, all sensors, unified schema)

Unified schema
  lat, lon, date, time, sensor, src, conf_raw, conf_ok, frp, daynight, type, bright, scan, track
  sensor: MODIS_T (Terra), MODIS_A (Aqua), VNP (VIIRS S-NPP), VJ1 (VIIRS NOAA-20), VJ2 (VIIRS NOAA-21)
  src   : SP (standard/science archive) or NRT (near-real-time, only after the archive ends)
  conf_ok: MODIS confidence >= 30, VIIRS confidence in {n, h}
  type  : FIRMS type (0 vegetation fire, 1 volcano, 2 other static land source, 3 offshore); NaN for NRT rows

AI-assistance note: drafted with an AI coding assistant (Claude) and reviewed by the author.
"""
import zipfile

import pandas as pd

from common import INT as OUT, RAW

OUT.mkdir(parents=True, exist_ok=True)
if not list(RAW.glob("fire_archive_*.csv")):          # first run: unpack the FIRMS zip files
    for z in RAW.glob("*.zip"):
        zipfile.ZipFile(z).extractall(RAW)

SOURCES = {  # file tag -> family
    "M-C61": "MODIS",
    "SV-C2": "VNP",
    "J1V-C2": "VJ1",
    "J2V-C2": "VJ2",
}
MODIS_CONF_MIN = 30


def load_one(path, family: str, src: str) -> pd.DataFrame:
    df = pd.read_csv(path, dtype={"acq_time": str, "confidence": str, "version": str})
    out = pd.DataFrame({
        "lat": df["latitude"].astype("float32"),
        "lon": df["longitude"].astype("float32"),
        "date": pd.to_datetime(df["acq_date"]),
        "time": df["acq_time"].str.zfill(4),
        "frp": df["frp"].astype("float32"),
        "daynight": df["daynight"].astype("category"),
        "bright": df["brightness"].astype("float32"),
        "scan": df["scan"].astype("float32"),
        "track": df["track"].astype("float32"),
        "conf_raw": df["confidence"].astype(str),
        "src": src,
    })
    if family == "MODIS":
        out["sensor"] = df["satellite"].map({"Terra": "MODIS_T", "Aqua": "MODIS_A"})
        out["conf_ok"] = pd.to_numeric(df["confidence"], errors="coerce") >= MODIS_CONF_MIN
    else:
        out["sensor"] = family
        out["conf_ok"] = df["confidence"].str.lower().isin(["n", "h", "nominal", "high"])
    out["type"] = df["type"].astype("Int8") if "type" in df.columns else pd.array([pd.NA] * len(df), dtype="Int8")
    return out


frames, log = [], []
for tag, family in SOURCES.items():
    arch = load_one(next(RAW.glob(f"fire_archive_{tag}_*.csv")), family, "SP")
    nrt = load_one(next(RAW.glob(f"fire_nrt_{tag}_*.csv")), family, "NRT")
    # NRT only after the last archive day of the same sensor (avoid double counting at the seam)
    keep = []
    for sensor, g in nrt.groupby("sensor"):
        last_sp = arch.loc[arch["sensor"] == sensor, "date"].max()
        keep.append(g[g["date"] > last_sp] if pd.notna(last_sp) else g)
    nrt_kept = pd.concat(keep) if keep else nrt.iloc[:0]
    frames += [arch, nrt_kept]
    log.append((tag, len(arch), len(nrt), len(nrt_kept), arch["date"].min().date(), arch["date"].max().date(),
                nrt_kept["date"].min().date() if len(nrt_kept) else None,
                nrt_kept["date"].max().date() if len(nrt_kept) else None))

df = pd.concat(frames, ignore_index=True)
df["sensor"] = df["sensor"].astype("category")
df["src"] = df["src"].astype("category")
df = df.sort_values(["date", "sensor"]).reset_index(drop=True)
df.to_parquet(OUT / "hotspots_all.parquet", index=False)

print("source | SP rows | NRT rows | NRT kept | SP from | SP to | NRT from | NRT to")
for row in log:
    print(" | ".join(str(x) for x in row))
print(f"\nTotal rows: {len(df):,}")
print("\nRows by sensor:\n", df["sensor"].value_counts().sort_index().to_string())
print("\nFIRMS type (archive rows):\n", df["type"].value_counts(dropna=False).sort_index().to_string())
print("\nconf_ok share by sensor:\n", df.groupby("sensor", observed=True)["conf_ok"].mean().round(3).to_string())
