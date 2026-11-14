"""Step 3 (EDA): national monthly/annual fire cell-day series per sensor; the naive-splice step at 2012."""
from pathlib import Path
import pandas as pd, numpy as np
ROOT = Path(__file__).resolve().parents[1]; INT = ROOT/"data"/"interim"
cd = pd.read_parquet(INT/"celldays.parquet")
# MODIS = union of Terra + Aqua cells on a day
mod = cd[cd.sensor.isin(["MODIS_T","MODIS_A"])].drop_duplicates(["date","ci","cj"]).assign(sensor="MODIS")
allc = pd.concat([cd, mod], ignore_index=True)
allc["sensor"] = allc["sensor"].astype(str)
allc["month"] = allc["date"].dt.to_period("M")
m = allc.groupby(["month","sensor"]).size().unstack(fill_value=0)
m.to_csv(INT/"national_monthly.csv")
y = allc.groupby([allc.date.dt.year,"sensor"]).size().unstack(fill_value=0)
y.index.name="year"
y["VNP/MODIS"] = (y["VNP"]/y["MODIS"]).round(2)
y["VJ1/VNP"] = (y["VJ1"]/y["VNP"]).round(2)
y["naive"] = np.where(y.index<2012, y["MODIS"], y["VNP"])
print(y[["MODIS_T","MODIS_A","MODIS","VNP","VJ1","VJ2","VNP/MODIS","VJ1/VNP","naive"]].to_string())
# seasonality: share by calendar month (overlap 2013-2025)
ov = m[(m.index.year>=2013)&(m.index.year<=2025)]
sea = ov.groupby(ov.index.month)[["MODIS","VNP"]].sum()
sea["ratio"] = (sea.VNP/sea.MODIS).round(2)
print("\nOverlap 2013-2025 by calendar month:\n", sea.to_string())
