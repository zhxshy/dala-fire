// Loading the files produced by scripts/06_export_web.py.
// AI-assistance note: drafted with an AI coding assistant (Claude) and reviewed by the author.
import { parquetMetadata, parquetRead, parquetReadObjects } from 'hyparquet'

export const DATA_URL = `${import.meta.env.BASE_URL}data/`

export interface Region { id: number; iso: string; en: string; kk: string; ru: string }

export interface SizeBand { size: string; n: number; p10: number; p50: number; p90: number }

export interface Model {
  data_through: string
  generated: string
  grid: { res_deg: number; ci0: number; cj0: number; epoch: string }
  regions: Region[]
  factors: {
    modis_to_vnp_national: number; terra_bridge: number; aqua_bridge: number
    vj1_to_vnp: number; vj2_to_vnp: number; calibration_window: [string, string]; calibration_days: number; tile_deg: number
    tiles?: Record<string, number>   // tile id -> MODIS-to-VIIRS factor; tile = floor(lat / 3) * 1000 + floor(lon / 3)
  }
  validation: {
    days_used: number
    loyo_2012_2021: Record<string, { national_median_abs_pct: number; national_max_abs_pct: number; tile_median_abs_pct: number; tile_p90_abs_pct: number }>
    error_vs_size: SizeBand[]
    share_of_viirs_where_modis_zero_pct: Record<string, number>
    backcast_2012_2013_pct: Record<string, number>
    drift_2022_2025_pct: Record<string, number>
    seam_2011_to_2012_ratio: { naive_splice: number; modis_only: number; harmonized: number }
    check_by_region?: { region: string; viirs_celldays: number; years: number; median_abs_pct: number | null; worst_abs_pct: number | null; bias_pct: number }[]
    ratio_by_year?: { ratio: Record<string, number>; fire_max_over_min: number }
    decline_single_sensor?: { modis_2001_2005_to_2021_2025: number; viirs_2012_2014_to_2021_2025: number; harmonized_2001_2005_to_2021_2025: number }
  }
}

export interface Days { epoch: string; first: string; last: string; codes: string[]; source: number[]; cal?: number[] }

/** Column arrays, one entry per (day, 0.01-degree cell) with a clean detection. */
export interface CellDays {
  n: number
  d: Uint16Array      // days since epoch
  lat: Float32Array   // cell centre
  lon: Float32Array
  h: Float32Array     // harmonized fire cell-days (VIIRS S-NPP scale)
  m: Uint8Array       // sensors that saw fire: 1 Terra, 2 Aqua, 4 S-NPP, 8 NOAA-20, 16 NOAA-21
  r: Uint8Array       // region id, 255 = outside
}

export interface Hotspot {
  date: string; time_utc: string; lat: number; lon: number; sensor: string
  src: string; confidence: string; frp_mw: number; daynight: string; r: number
}

async function json<T>(name: string): Promise<T> {
  const res = await fetch(DATA_URL + name)
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`)
  return res.json() as Promise<T>
}

async function buffer(name: string): Promise<ArrayBuffer> {
  const res = await fetch(DATA_URL + name)
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`)
  return res.arrayBuffer()
}

export const loadModel = () => json<Model>('model.json')
export const loadDays = () => json<Days>('days.json')
export const loadRegions = () => json<GeoJSON.FeatureCollection>('regions.geojson')
export const loadStaticMask = () => json<[number, number][]>('static_mask.json')

export async function loadCellDays(model: Model): Promise<CellDays> {
  const file = await buffer('celldays.parquet')
  const n = Number(parquetMetadata(file).num_rows)
  const out = { d: new Uint16Array(n), ci: new Uint16Array(n), cj: new Uint16Array(n),
                h: new Float32Array(n), m: new Uint8Array(n), r: new Uint8Array(n) }
  await parquetRead({
    file,
    columns: ['d', 'ci', 'cj', 'h', 'm', 'r'],
    onChunk: ({ columnName, columnData, rowStart }) => {
      const target = out[columnName as keyof typeof out]
      target.set(columnData as ArrayLike<number>, rowStart)
    },
  })
  const { res_deg: res, ci0, cj0 } = model.grid
  const lat = new Float32Array(n), lon = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    lat[i] = (out.ci[i] + ci0 + 0.5) * res
    lon[i] = (out.cj[i] + cj0 + 0.5) * res
  }
  return { n, d: out.d, lat, lon, h: out.h, m: out.m, r: out.r }
}

const hotspotCache = new Map<number, Promise<Hotspot[]>>()

export function loadHotspots(year: number): Promise<Hotspot[]> {
  if (!hotspotCache.has(year)) {
    hotspotCache.set(year, buffer(`hotspots_${year}.parquet`)
      .then(file => parquetReadObjects({ file }) as Promise<Hotspot[]>)
      .catch(err => { hotspotCache.delete(year); throw err }))
  }
  return hotspotCache.get(year)!
}
