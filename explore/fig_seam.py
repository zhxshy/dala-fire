"""Step 4 (first look): annual national series - raw MODIS, raw VIIRS S-NPP, naive splice, and a
v0 harmonized series (single national ratio k fitted on the 2013-2021 overlap; Terra-only years
bridged with the (Terra u Aqua)/Terra ratio from 2003-2011). v0 is only a baseline; the stratified
model comes next."""
from pathlib import Path
import pandas as pd, numpy as np, matplotlib
matplotlib.use("Agg"); import matplotlib.pyplot as plt
ROOT = Path(__file__).resolve().parents[1]; INT = ROOT/"data"/"interim"
m = pd.read_csv(INT/"national_monthly.csv", index_col=0); m.index = pd.PeriodIndex(m.index, freq="M")
ov = m[(m.index.year>=2013)&(m.index.year<=2021)]
k = ov.VNP.sum()/ov.MODIS.sum()
pre = m[(m.index.year>=2003)&(m.index.year<=2011)]
b = pre.MODIS.sum()/pre.MODIS_T.sum()
terra_only = m.index < pd.Period("2002-07", "M")
mod_eq = np.where(terra_only, m.MODIS_T*b, m.MODIS)
m["harm_v0"] = np.where(m.index < pd.Period("2012-02","M"), mod_eq*k, m.VNP)
m["naive"] = np.where(m.index < pd.Period("2012-02","M"), m.MODIS, m.VNP)
y = m[(m.index.year>=2001)&(m.index.year<=2025)].groupby(m.index.year[(m.index.year>=2001)&(m.index.year<=2025)]).sum()
fig, ax = plt.subplots(figsize=(10,4.8), dpi=150)
ax.plot(y.index, y.MODIS/1e3, color="#8c8c8c", lw=1.2, ls="--", label="MODIS raw (Terra+Aqua)")
ax.plot(y.index[y.index>=2012], y.VNP[y.index>=2012]/1e3, color="#4c78a8", lw=1.2, ls=":", label="VIIRS S-NPP raw")
ax.plot(y.index, y.naive/1e3, color="#d62728", lw=2, label="Naive splice (MODIS → VIIRS in 2012)")
ax.plot(y.index, y.harm_v0/1e3, color="#1a1a1a", lw=2.2, label=f"Harmonized v0 (VIIRS scale, k={k:.2f})")
ax.axvline(2012, color="#999", lw=0.8); ax.text(2012.2, ax.get_ylim()[1]*0.92, "VIIRS starts", fontsize=8, color="#666")
ax.set_ylabel("Fire cell-days per year (thousands)"); ax.set_title("Kazakhstan active fire record, 2001–2025 (NASA FIRMS)")
ax.legend(frameon=False, fontsize=8); ax.spines[["top","right"]].set_visible(False)
fig.tight_layout(); fig.savefig(ROOT/"figures"/"01_seam_annual.png")
print(f"k (VNP/MODIS, 2013-2021) = {k:.3f}; Terra-only bridge b = {b:.3f}")
print("2011 -> 2012 naive change:", round(y.naive[2012]/y.naive[2011],2), "x | harmonized v0:", round(y.harm_v0[2012]/y.harm_v0[2011],2), "x | MODIS-only:", round(y.MODIS[2012]/y.MODIS[2011],2), "x")
