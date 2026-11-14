// Fails when a headline number in README.md no longer matches web/public/data/model.json.
// AI-assistance note: drafted with an AI coding assistant (Claude) and reviewed by the author.
import { readFileSync } from 'node:fs'

const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8')
const model = JSON.parse(readFileSync(new URL('../public/data/model.json', import.meta.url), 'utf8'))
const v = model.validation, f = model.factors
const used = v.loyo_2012_2021['3-deg tiles, shrinkage 200'], naive = v.loyo_2012_2021['naive (no correction)']
const signed = x => `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`

const expected = {
  'national factor': f.modis_to_vnp_national.toFixed(3),
  'calibration days': f.calibration_days.toLocaleString('en-US'),
  'country error': `${used.national_median_abs_pct.toFixed(1)}% median`,
  'naive error': `${naive.national_median_abs_pct.toFixed(1)}%`,
  'tile error': `${used.tile_median_abs_pct.toFixed(1)}% median`,
  'tile error, 90th percentile': `${used.tile_p90_abs_pct.toFixed(1)}% at the 90th percentile`,
  'seam, harmonized': `harmonized ${v.seam_2011_to_2012_ratio.harmonized}x`,
  'seam, MODIS alone': `MODIS alone ${v.seam_2011_to_2012_ratio.modis_only}x`,
  'seam, naive': `naive ${v.seam_2011_to_2012_ratio.naive_splice}x`,
  'backcast': `${signed(v.backcast_2012_2013_pct['2012'])} and ${signed(v.backcast_2012_2013_pct['2013'])}`,
}
if (v.ratio_by_year) {
  const r = Object.values(v.ratio_by_year.ratio)
  expected['ratio by year'] = `${Math.min(...r).toFixed(2)} to ${Math.max(...r).toFixed(2)}`
}
if (v.decline_single_sensor) {
  expected['MODIS-only decline'] = `MODIS ${v.decline_single_sensor.modis_2001_2005_to_2021_2025.toFixed(1)}x`
  expected['VIIRS-only decline'] = `VIIRS ${v.decline_single_sensor.viirs_2012_2014_to_2021_2025.toFixed(1)}x`
}

if (v.check_by_region) {
  const ok = v.check_by_region.map(r => r.median_abs_pct).filter(x => x !== null && x <= 25)
  expected['region check'] = `${ok.length} regions: ${Math.min(...ok).toFixed(1)}% to ${Math.max(...ok).toFixed(1)}% median`
}

const missing = Object.entries(expected).filter(([, text]) => !readme.includes(text))
for (const [name, text] of missing) console.error(`README.md does not contain "${text}" (${name}, from model.json)`)
if (missing.length) process.exit(1)
console.log(`README.md matches model.json on ${Object.keys(expected).length} numbers`)
