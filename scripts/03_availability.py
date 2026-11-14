"""Step 3: per-day sensor availability (data gaps) inferred from the detections themselves.

Why: a day on which a satellite delivered nothing looks like "no fire" in the raw counts. Such days
must be excluded from calibration and shown as "no data" (not zero) in the calendar.

Input : data/interim/hotspots_all.parquet   (ALL raw detections, before any filtering)
Output: data/interim/sensor_availability.parquet  (sensor, date, n_raw, available)
        data/interim/sensor_gaps.csv               (one row per gap run, with the rule that flagged it)

Method. Static heat sources (gas flares, plants) are detected almost every day, so a nationwide day
with zero raw detections is suspicious. A run of consecutive zero days is flagged as a gap when
  rule "expected": the detections expected during the run (centred 61-day rolling median of the
                   sensor's own daily counts, summed over the run) >= EXPECTED_MIN, and the other
                   operating sensors did see fire (>= OTHERS_MIN_SHARE of that expectation), so the
                   zero is not a real country-wide lull; or
  rule "sibling" : the run lasts >= SIBLING_MIN_DAYS and the other satellites carrying the same
                   instrument averaged >= SIBLING_MIN_RATE detections per day during it.
Limits: only full-day, country-wide gaps are found (partial swath losses are not); winter runs with
few expected detections stay "available".

Cross-check with FIRMS. scripts/ref/firms_missing_dates.csv is a snapshot of the FIRMS API
`missing_data` table (retrieved 2026-11-14). A day it lists is also marked unavailable (rule "firms")
when our archive has zero raw detections for that sensor on that day. A listed day on which the
archive does hold detections is kept: the table describes the FIRMS database, and our archive
download was checked to be complete on those days (e.g. S-NPP, May 2026: S-NPP/NOAA-20 = 0.99).
Every listed day and its outcome is written to data/interim/firms_crosscheck.csv.

AI-assistance note: drafted with an AI coding assistant (Claude) and reviewed by the author.
"""
import pandas as pd

from common import FAMILY, INT, SENSORS, ROOT

FIRMS_SAT = {"Terra (MODIS)": "MODIS_T", "Aqua (MODIS)": "MODIS_A", "Suomi NPP (VIIRS)": "VNP",
             "NOAA-20 (VIIRS)": "VJ1", "NOAA-21 (VIIRS)": "VJ2"}

EXPECTED_MIN = 50       # expected detections during a zero run to call it a gap
OTHERS_MIN_SHARE = 0.1  # other sensors must have seen at least this share of the expectation
SIBLING_MIN_DAYS = 3
SIBLING_MIN_RATE = 20   # same-instrument detections per day during the run
WINDOW = 61             # days, centred rolling median

raw = pd.read_parquet(INT / "hotspots_all.parquet", columns=["date", "sensor"])
raw["sensor"] = raw["sensor"].astype(str)
counts = raw.groupby(["sensor", "date"]).size()
SENSORS = [s for s in SENSORS if s in counts.index.get_level_values("sensor")]   # a subset in 08_transfer.py

daily = {}
for s in SENSORS:
    c = counts[s]
    daily[s] = c.reindex(pd.date_range(c.index.min(), c.index.max()), fill_value=0)

avail_frames, gap_rows = [], []
for s in SENSORS:
    c = daily[s]
    expected = c.rolling(WINDOW, center=True, min_periods=15).median()
    siblings = [daily[o] for o in SENSORS if o != s and FAMILY[o] == FAMILY[s]]
    sib = sum(o.reindex(c.index, fill_value=0) for o in siblings) if siblings else c * 0
    others = [daily[o] for o in SENSORS if o != s]
    oth = sum(o.reindex(c.index, fill_value=0) for o in others)
    oth_on = sum(pd.Series(1, index=o.index).reindex(c.index, fill_value=0) for o in others)

    zero = c.eq(0)
    run_id = (zero != zero.shift()).cumsum()
    available = pd.Series(True, index=c.index)
    for _, run in c[zero].groupby(run_id[zero]):
        days = run.index
        exp_sum, sib_sum, oth_sum = float(expected[days].sum()), int(sib[days].sum()), int(oth[days].sum())
        alone = oth_on[days].sum() == 0                      # no other sensor was flying yet
        seen_by_others = alone or oth_sum >= OTHERS_MIN_SHARE * exp_sum
        rule = ("expected" if exp_sum >= EXPECTED_MIN and seen_by_others else
                "sibling" if len(days) >= SIBLING_MIN_DAYS and sib_sum >= SIBLING_MIN_RATE * len(days) else None)
        if rule:
            available[days] = False
            gap_rows.append({"sensor": s, "start": days[0].date(), "end": days[-1].date(), "days": len(days),
                             "expected_det": round(exp_sum), "others_det": oth_sum, "rule": rule})
    avail_frames.append(pd.DataFrame({"sensor": s, "date": c.index, "n_raw": c.values.astype("int32"),
                                      "available": available.values}))

avail = pd.concat(avail_frames, ignore_index=True)

# --- cross-check with the FIRMS missing_data table ---------------------------------------------
fm = pd.read_csv(ROOT / "scripts" / "ref" / "firms_missing_dates.csv", parse_dates=["date"])
fm["sensor"] = fm["satellite"].map(FIRMS_SAT)
x = fm.merge(avail, on=["sensor", "date"], how="left")
x["outcome"] = "outside_record"
x.loc[x["available"].eq(False), "outcome"] = "already_flagged"
add = x["available"].eq(True) & x["n_raw"].eq(0)
x.loc[add, "outcome"] = "added_from_firms"
x.loc[x["available"].eq(True) & x["n_raw"].gt(0), "outcome"] = "data_present_kept"
x[["sensor", "date", "product", "n_raw", "outcome"]].to_csv(INT / "firms_crosscheck.csv", index=False)
added = x.loc[add, ["sensor", "date"]].assign(firms=True)
avail = avail.merge(added, on=["sensor", "date"], how="left")
avail.loc[avail["firms"].eq(True), "available"] = False
avail = avail.drop(columns="firms")
for s_, d in added.groupby("sensor")["date"]:
    d = d.sort_values().reset_index(drop=True)
    for _, run in d.groupby((d.diff().dt.days != 1).cumsum()):
        gap_rows.append({"sensor": s_, "start": run.iloc[0].date(), "end": run.iloc[-1].date(), "days": len(run),
                         "expected_det": None, "others_det": None, "rule": "firms"})
print("FIRMS cross-check:", x["outcome"].value_counts().to_dict())

gaps = pd.DataFrame(gap_rows).sort_values(["sensor", "start"]).reset_index(drop=True)
avail.to_parquet(INT / "sensor_availability.parquet", index=False)
gaps.to_csv(INT / "sensor_gaps.csv", index=False)

summary = avail.groupby("sensor").agg(first=("date", "min"), last=("date", "max"), days=("date", "size"),
                                      zero_days=("n_raw", lambda x: int((x == 0).sum())),
                                      gap_days=("available", lambda x: int((~x).sum())))
fire_season = avail[avail["date"].dt.month.between(4, 10) & ~avail["available"]].groupby("sensor").size()
summary["gap_days_apr_oct"] = fire_season.reindex(summary.index, fill_value=0)
print(summary.to_string())
print(f"\nGap runs: {len(gaps)}")
print(gaps.to_string(index=False))
