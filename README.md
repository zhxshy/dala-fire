# Dala Fire

One consistent fire record for Kazakhstan from two satellite sensors: MODIS (2000 onward) and
VIIRS (2012 onward). Built for the NASA Space Apps Challenge 2026, challenge
*Harmonization of MODIS and VIIRS Hot Spots*, by team Thermal Fusion.

Status: pipeline (steps 1-6) and a first version of the web app are done.

## Data

NASA FIRMS Archive Download, country = Kazakhstan, 2000-11-01 to 2026-11-13, CSV:

| File | Product | Period |
| --- | --- | --- |
| `DL_FIRE_M-C61_*.zip` | MODIS Collection 6.1 (Terra, Aqua), 1 km | 2000-11 onward |
| `DL_FIRE_SV-C2_*.zip` | VIIRS S-NPP Collection 2, 375 m | 2012-01 to 2026-11-02 |
| `DL_FIRE_J1V-C2_*.zip` | VIIRS NOAA-20 Collection 2, 375 m | 2018-04 onward |
| `DL_FIRE_J2V-C2_*.zip` | VIIRS NOAA-21 Collection 2, 375 m | 2023-03 onward |

Each zip holds a science-quality archive file and a near-real-time file for the most recent months.
Raw data is not stored in git. Put the four zip files in `data/raw/`.

Region boundaries: OpenStreetMap, `boundary=administrative`, `admin_level=4` inside Kazakhstan
(17 regions incl. Abay, Jetisu and Ulytau, plus Astana, Almaty and Shymkent), exported with Overpass
Turbo as GeoJSON. Save it as `data/raw/boundaries/osm_kz_admin4.geojson`. © OpenStreetMap contributors, ODbL.

## Run

```
pip install -r requirements.txt   # includes shapely for step 6
python run_all.py
```

| Step | Script | Output in `data/interim/` |
| --- | --- | --- |
| 1 | `scripts/01_ingest.py` | `hotspots_all.parquet`: every detection, one schema, archive + NRT without overlap |
| 2 | `scripts/02_grid.py` | `hotspots_clean.parquet`, `celldays.parquet`, `static_mask_cells.parquet` |
| 3 | `scripts/03_availability.py` | `sensor_availability.parquet`, `sensor_gaps.csv` |
| 4 | `scripts/04_harmonize.py` | `harmonized_celldays.parquet`, `day_source.parquet`, `strata.json`, `national_monthly_harmonized.csv` |
| 5 | `scripts/05_validate.py` | `validation.json`, `error_by_count.csv`, `figures/02_before_after.png` |
| 6 | `scripts/06_export_web.py` | `web/public/data/`: files the web app loads (about 45 MB, committed to git) |

Numbers to expect with the download above:

| Check | Value |
| --- | --- |
| Detections loaded | 4,152,447 |
| Detections kept after cleaning | 3,200,835 (77.1%) |
| Fire cell-days | 2,268,202 |
| Gap days found: Terra / Aqua / S-NPP / NOAA-20 / NOAA-21 | 53 / 33 / 53 / 5 / 0 |
| MODIS -> S-NPP national factor | 2.005 (3,619 calibration days) |
| Harmonized total, all years | 2,118,602 cell-days |

## Web app

`web/` is a static React + MapLibre site. It loads `web/public/data/` and computes every chart in the
browser, so it needs no server and no API key.

```
cd web
npm install
npm run dev            # http://localhost:5173/dala-fire/
```

Every push to `main` builds the site and publishes it on GitHub Pages
(`.github/workflows/deploy.yml`). One-time setup: Settings -> Pages -> Source: GitHub Actions.

## Method so far

- **Cleaning.** MODIS confidence >= 30; VIIRS nominal or high; FIRMS type 0 (vegetation fire) where
  the type is known; a static-source mask (cells with repeated type 2/3 detections, plus neighbours)
  applied to all rows, including near-real-time rows that carry no type.
- **Fire cell-day.** A 0.01 degree cell with at least one clean detection from a sensor on a day.
  Many 375 m VIIRS pixels from one fire fall into one cell, which removes most of the pixel-size
  difference from 1 km MODIS.
- **Sensor gaps.** Days on which a satellite delivered nothing are inferred from the detections
  (see the docstring of `03_availability.py`) and will be treated as "no data", not as zero.

- **Harmonization.** Everything is put on the VIIRS S-NPP scale. MODIS (Terra or Aqua) counts are
  multiplied by a factor per 3-degree tile, fitted on 2012-2021 days when Terra, Aqua and S-NPP all
  delivered data and shrunk toward the national factor (2.005) where data is thin. Terra-only and
  Aqua-only days use a bridge factor fitted on 2003-2011. Days without S-NPP use NOAA-20 (x0.998) or
  NOAA-21 (x1.036). The model is a sum over cells, so any area's value is exact in the browser.

## Validation (leave-one-year-out, 2012-2021)

| Model | Country, median error | Country, max error | 3-degree tile, median error |
| --- | --- | --- | --- |
| Naive splice (no correction) | 50.8% | 53.0% | 51.1% |
| One national factor | 2.9% | 6.3% | 10.6% |
| Tile factors, shrinkage 200 (used) | 3.0% | 7.0% | 7.6% |
| Tile x season factors | 3.2% | 7.1% | 7.6% |

Other checks: backcast of 2012 / 2013 from a model fitted on 2014-2021: +3.2% / -6.3%. Drift years
2022-2025 (fitted on 2012-2021): +3.0% to -9.5%, so MODIS after 2021 is used only on days without VIIRS.
At the 2011 -> 2012 seam the naive splice jumps 4.53x, MODIS alone 2.31x, the harmonized record 2.28x.

Limits: the model cannot create fire where MODIS saw none. In 0.25-degree cells by month, 8.3% of
VIIRS activity falls where MODIS saw nothing (2.1% at 1 degree), so small areas are marked indicative.
`error_by_count.csv` gives the observed/predicted spread by the size of the prediction; the app uses it
as the uncertainty band.

`explore/` holds quick looks (national series, the 2012 seam figure). They are not part of the pipeline.

## Use of AI

AI tools (Claude) were used for research, planning and drafting code. Each AI-drafted script says so
in its docstring. Method choices and checks are the author's.

## Data citation

NASA FIRMS: MODIS Collection 6.1 and VIIRS 375 m Collection 2 active fire products
(https://firms.modaps.eosdis.nasa.gov). Add product DOIs before submission.
