// World layer: monthly harmonized record on a 0.5-degree grid, produced by scripts/w1_fetch.py and w2_world.py.
// AI-assistance note: drafted with an AI coding assistant (Claude) and reviewed by the author.
import { parquetMetadata, parquetRead } from 'hyparquet'
import { bandFor, type Period } from './aggregate'
import { DATA_URL, type SizeBand } from './data'

export interface WorldCountry { id: number; iso: string; en: string }
export interface WorldLoyo { global_median_abs_pct: number; global_max_abs_pct: number; tile_median_abs_pct: number; tile_p90_abs_pct: number; tile_month_median_abs_pct: number }
export interface WorldRegionRow { region: string; tiles: number; viirs_celldays_per_year: number; naive: number; global: number; tile: number; tile_month: number; bias_chosen_pct: number }

export interface WorldModel {
  data_through: string
  grid: { res_deg: number; gi0: number; gj0: number; ym0: number }
  months: { key: string; days: number; with_data: number; modelled: number }[]
  countries: WorldCountry[]
  factors: { modis_to_vnp_global: number; tiles: number; tile_p10: number; tile_p50: number; tile_p90: number; terra_bridge: number; aqua_bridge: number; vj1_to_vnp: number; tile_deg: number }
  source: { years: [number, number]; detections: number }
  validation: {
    years_tested: [number, number]; calibration_days: number; chosen_model: string; tiles_tested: number
    loyo: Record<string, WorldLoyo>; by_region: WorldRegionRow[]; error_vs_size: SizeBand[]
    backcast_pct: Record<string, number>; seam_2011_to_2012_ratio: { naive_splice: number; modis_only: number; harmonized: number } | null
  }
}

/** One entry per (month, 0.5-degree cell) with fire. */
export interface WorldCells {
  n: number; ym: Uint16Array; lat: Float32Array; lon: Float32Array
  h: Float32Array; m: Int32Array; v: Int32Array; r: Uint8Array
}

export interface World { model: WorldModel; cells: WorldCells; countries: GeoJSON.FeatureCollection }

/** The world layer is optional: the tab appears only when its files are published. */
export async function worldAvailable(): Promise<boolean> {
  // read the file itself: a dev or preview server answers 200 with the app page for files that do not exist
  try {
    const res = await fetch(`${DATA_URL}world/model.json`)
    return res.ok && Array.isArray((await res.json()).months)
  } catch { return false }
}

export async function loadWorld(): Promise<World> {
  const get = async (name: string) => {
    const res = await fetch(`${DATA_URL}world/${name}`)
    if (!res.ok) throw new Error(`world/${name}: HTTP ${res.status}`)
    return res
  }
  const [model, countries, file] = await Promise.all([
    get('model.json').then(r => r.json() as Promise<WorldModel>),
    get('countries.geojson').then(r => r.json() as Promise<GeoJSON.FeatureCollection>),
    get('monthly.parquet').then(r => r.arrayBuffer()),
  ])
  const n = Number(parquetMetadata(file).num_rows)
  const out = { ym: new Uint16Array(n), gi: new Uint16Array(n), gj: new Uint16Array(n), h: new Float32Array(n),
                m: new Int32Array(n), v: new Int32Array(n), r: new Uint8Array(n) }
  await parquetRead({
    file, columns: ['ym', 'gi', 'gj', 'h', 'm', 'v', 'r'],
    onChunk: ({ columnName, columnData, rowStart }) => { out[columnName as keyof typeof out].set(columnData as ArrayLike<number>, rowStart) },
  })
  const { res_deg: res, gi0, gj0 } = model.grid
  const lat = new Float32Array(n), lon = new Float32Array(n)
  for (let i = 0; i < n; i++) { lat[i] = (out.gi[i] + gi0 + 0.5) * res; lon[i] = (out.gj[i] + gj0 + 0.5) * res }
  return { model, countries, cells: { n, ym: out.ym, lat, lon, h: out.h, m: out.m, v: out.v, r: out.r } }
}

/** Monthly and yearly totals of the masked cells, in the same shape the Kazakhstan charts use. */
export function worldPeriods(w: World, mask: Uint8Array): { months: Period[]; years: Period[]; cellsUsed: number } {
  const { cells, model } = w
  const nm = model.months.length
  const h = new Float64Array(nm), m = new Float64Array(nm), v = new Float64Array(nm)
  let used = 0
  for (let i = 0; i < cells.n; i++) {
    if (!mask[i]) continue
    const k = cells.ym[i]
    h[k] += cells.h[i]; m[k] += cells.m[i]; v[k] += cells.v[i]; used++
  }
  const bands = model.validation.error_vs_size
  const months: Period[] = model.months.map((mm, k) => {
    const year = Number(mm.key.slice(0, 4)), month = Number(mm.key.slice(5, 7)) - 1
    const modelledShare = mm.with_data ? mm.modelled / mm.with_data : 0
    const b = modelledShare > 0.5 && h[k] > 0 ? bandFor(h[k], bands) : null
    return { key: mm.key, year, month, harm: h[k], modis: m[k], vnp: v[k], naive: year < 2012 ? m[k] : v[k],
             days: mm.days, daysWithData: mm.with_data, modelledShare, partial: false,
             band: b ? b.band : null, indicative: b ? b.indicative : false }
  })
  const byYear = new Map<number, Period[]>()
  for (const p of months) { if (!byYear.has(p.year)) byYear.set(p.year, []); byYear.get(p.year)!.push(p) }
  const years: Period[] = [...byYear].map(([year, ps]) => {
    const sum = (f: (p: Period) => number) => ps.reduce((a, p) => a + f(p), 0)
    const harm = sum(p => p.harm), hm = sum(p => (p.modelledShare > 0.5 ? p.harm : 0))
    const days = sum(p => p.days), withData = sum(p => p.daysWithData)
    const b = hm > 0 ? bandFor(hm, bands) : null
    return { key: String(year), year, month: null, harm, modis: sum(p => p.modis), vnp: sum(p => p.vnp),
             naive: year < 2012 ? sum(p => p.modis) : sum(p => p.vnp), days, daysWithData: withData,
             modelledShare: harm > 0 ? hm / harm : 0, partial: ps.length < 12,
             band: b ? [harm - hm + b.band[0], harm - hm + b.band[1]] : null, indicative: b ? b.indicative && hm > harm / 2 : false }
  })
  return { months, years, cellsUsed: used }
}
