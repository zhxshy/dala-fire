// Turn the cell-day table into daily, monthly and yearly series for one area.
// The model is additive, so an area's harmonized value is just the sum over its cells.
// AI-assistance note: drafted with an AI coding assistant (Claude) and reviewed by the author.
import type { CellDays, Days, SizeBand } from './data'

export const REF_FIRST = 2001
export const MODEL_SOURCES = new Set(['MODIS', 'TERRA', 'AQUA'])
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export interface Calendar {
  epoch: number                 // ms, UTC
  nDays: number
  year: Int16Array; month: Int8Array; dom: Int8Array   // per day (month 0-11)
  source: string[]              // per day
  hasData: Uint8Array; modelled: Uint8Array
  lastYear: number; lastMonth: number; lastDom: number
}

export function buildCalendar(days: Days): Calendar {
  const epoch = Date.parse(days.epoch + 'T00:00:00Z')
  const n = days.source.length
  const year = new Int16Array(n), month = new Int8Array(n), dom = new Int8Array(n)
  const hasData = new Uint8Array(n), modelled = new Uint8Array(n)
  const source = days.source.map(i => days.codes[i])
  for (let k = 0; k < n; k++) {
    const dt = new Date(epoch + k * 86400000)
    year[k] = dt.getUTCFullYear(); month[k] = dt.getUTCMonth(); dom[k] = dt.getUTCDate()
    hasData[k] = source[k] === 'NONE' ? 0 : 1
    modelled[k] = MODEL_SOURCES.has(source[k]) ? 1 : 0
  }
  return { epoch, nDays: n, year, month, dom, source, hasData, modelled,
           lastYear: year[n - 1], lastMonth: month[n - 1], lastDom: dom[n - 1] }
}

export interface Daily { harm: Float64Array; modis: Float64Array; vnp: Float64Array }

/** Sum the area's cells per day. modis = Terra or Aqua saw fire; vnp = S-NPP saw fire. */
export function dailySeries(cells: CellDays, mask: Uint8Array, nDays: number): Daily {
  const harm = new Float64Array(nDays), modis = new Float64Array(nDays), vnp = new Float64Array(nDays)
  const { d, h, m } = cells
  for (let i = 0; i < cells.n; i++) {
    if (!mask[i]) continue
    const k = d[i]
    harm[k] += h[i]
    if (m[i] & 3) modis[k] += 1
    if (m[i] & 4) vnp[k] += 1
  }
  return { harm, modis, vnp }
}

export interface Period {
  key: string; year: number; month: number | null   // month 0-11, null for a year
  harm: number; modis: number; vnp: number; naive: number
  days: number; daysWithData: number; modelledShare: number
  partial: boolean            // period not finished at the data-through date
  band: [number, number] | null
  indicative: boolean         // too small for the model to be reliable
}

export function bandFor(p: number, bands: SizeBand[]): { band: [number, number]; indicative: boolean } {
  const edges = [3, 10, 30, 100, 300, 1000, 3000, Infinity]
  let i = edges.findIndex((e, j) => p >= e && p < edges[j + 1])
  if (i < 0) i = 0
  const b = bands[Math.min(i, bands.length - 1)]
  return { band: [p * b.p10, p * b.p90], indicative: p < 30 }
}

function summarize(key: string, year: number, month: number | null, idx: number[], s: Daily, cal: Calendar,
                   bands: SizeBand[], partial: boolean): Period {
  let harm = 0, modis = 0, vnp = 0, withData = 0, modelled = 0, harmModelled = 0
  for (const k of idx) {
    harm += s.harm[k]; modis += s.modis[k]; vnp += s.vnp[k]
    if (cal.hasData[k]) withData++
    if (cal.modelled[k]) { modelled++; harmModelled += s.harm[k] }
  }
  const naive = year < 2012 ? modis : vnp
  const modelledShare = withData ? modelled / withData : 0
  let band: [number, number] | null = null, indicative = false
  if (modelledShare > 0 && harmModelled > 0) {
    const b = bandFor(harmModelled, bands)
    band = [harm - harmModelled + b.band[0], harm - harmModelled + b.band[1]]
    indicative = modelledShare > 0.5 && b.indicative
  }
  return { key, year, month, harm, modis, vnp, naive, days: idx.length, daysWithData: withData,
           modelledShare, partial, band, indicative }
}

export function monthlyPeriods(s: Daily, cal: Calendar, bands: SizeBand[]): Period[] {
  const groups = new Map<string, number[]>()
  for (let k = 0; k < cal.nDays; k++) {
    const key = `${cal.year[k]}-${String(cal.month[k] + 1).padStart(2, '0')}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(k)
  }
  const last = `${cal.lastYear}-${String(cal.lastMonth + 1).padStart(2, '0')}`
  const lastDayOfMonth = new Date(Date.UTC(cal.lastYear, cal.lastMonth + 1, 0)).getUTCDate()
  return [...groups].map(([key, idx]) => summarize(key, cal.year[idx[0]], cal.month[idx[0]], idx, s, cal, bands,
    key === last && cal.lastDom < lastDayOfMonth))
}

export function yearlyPeriods(s: Daily, cal: Calendar, bands: SizeBand[]): Period[] {
  const groups = new Map<number, number[]>()
  for (let k = 0; k < cal.nDays; k++) {
    const y = cal.year[k]
    if (!groups.has(y)) groups.set(y, [])
    groups.get(y)!.push(k)
  }
  const first = cal.year[0]
  return [...groups].map(([y, idx]) => summarize(String(y), y, null, idx, s, cal, bands,
    y === cal.lastYear || y === first))
}

export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

export interface Climatology { median: number[]; p10: number[]; p90: number[] }

/** Per calendar month: median and p10/p90 of complete, well-covered months REF_FIRST..lastYear-1. */
export function climatology(months: Period[], lastYear: number): Climatology {
  const by: number[][] = Array.from({ length: 12 }, () => [])
  for (const p of months) {
    if (p.month === null || p.partial || p.year < REF_FIRST || p.year >= lastYear) continue
    if (p.daysWithData / p.days < 0.8) continue
    by[p.month].push(p.harm)
  }
  const sorted = by.map(v => [...v].sort((a, b) => a - b))
  return { median: sorted.map(v => quantile(v, 0.5)), p10: sorted.map(v => quantile(v, 0.1)),
           p90: sorted.map(v => quantile(v, 0.9)) }
}

/** Robust anomaly: distance from the median in units of the p10-p90 spread. */
export function anomaly(p: Period, c: Climatology): number {
  if (p.month === null) return NaN
  const spread = Math.max(c.p90[p.month] - c.p10[p.month], 1)
  return (p.harm - c.median[p.month]) / spread
}

export interface Comparison {
  label: string; value: number; median: number; p10: number; p90: number
  percentile: number; nRef: number; refYears: [number, number]
}

/** Value of days dayFrom..dayTo of (year, month) vs the same days in earlier years. */
function compareDays(s: Daily, cal: Calendar, year: number, month: number, dayFrom: number, dayTo: number, label: string): Comparison {
  const sums = new Map<number, number>(), cover = new Map<number, number>()
  for (let k = 0; k < cal.nDays; k++) {
    if (cal.month[k] !== month || cal.dom[k] < dayFrom || cal.dom[k] > dayTo) continue
    const y = cal.year[k]
    sums.set(y, (sums.get(y) ?? 0) + s.harm[k])
    cover.set(y, (cover.get(y) ?? 0) + cal.hasData[k])
  }
  const span = dayTo - dayFrom + 1
  const ref: number[] = []
  for (const [y, v] of sums) if (y >= REF_FIRST && y < year && (cover.get(y) ?? 0) / span >= 0.8) ref.push(v)
  ref.sort((a, b) => a - b)
  const value = sums.get(year) ?? 0
  const below = ref.filter(v => v < value).length, equal = ref.filter(v => v === value).length
  return { label, value, median: quantile(ref, 0.5), p10: quantile(ref, 0.1), p90: quantile(ref, 0.9),
           percentile: ref.length ? (100 * (below + equal / 2)) / ref.length : NaN, nRef: ref.length,
           refYears: [REF_FIRST, year - 1] }
}

export function currentComparisons(s: Daily, cal: Calendar): Comparison[] {
  const { lastYear: y, lastMonth: m, lastDom: d } = cal
  const out = [compareDays(s, cal, y, m, 1, d, `${MONTHS[m]} 1–${d}, ${y}`)]
  const py = m === 0 ? y - 1 : y, pm = m === 0 ? 11 : m - 1
  const pdays = new Date(Date.UTC(py, pm + 1, 0)).getUTCDate()
  out.push(compareDays(s, cal, py, pm, 1, pdays, `${MONTHS[pm]} ${py} (full month)`))
  return out
}

// --- seasonal profile: weekly fire cell-days, median and p10-p90 of earlier years, current year on top ---
export const WEEKS = 52

export interface Season {
  median: number[]; p10: number[]; p90: number[]   // per week of year
  current: (number | null)[]                        // current year, complete weeks only
  year: number; refYears: [number, number]; nRefMin: number
}

/** Week of year 0..51 (days 365-366 fold into week 51). */
export function weekOfYear(y: number, m: number, d: number): number {
  const doy = (Date.UTC(y, m, d) - Date.UTC(y, 0, 1)) / 86400000
  return Math.min(WEEKS - 1, Math.floor(doy / 7))
}

export function seasonalProfile(s: Daily, cal: Calendar, refFirst = REF_FIRST): Season {
  const sum = new Map<number, Float64Array>(), cover = new Map<number, Float64Array>(), len = new Map<number, Float64Array>()
  const get = (m: Map<number, Float64Array>, y: number) => {
    let a = m.get(y); if (!a) { a = new Float64Array(WEEKS); m.set(y, a) } return a
  }
  for (let k = 0; k < cal.nDays; k++) {
    const y = cal.year[k], w = weekOfYear(y, cal.month[k], cal.dom[k])
    get(sum, y)[w] += s.harm[k]; get(cover, y)[w] += cal.hasData[k]; get(len, y)[w] += 1
  }
  const fullLen = (y: number, w: number) => (w < WEEKS - 1 ? 7 : (Date.UTC(y + 1, 0, 1) - Date.UTC(y, 0, 1)) / 86400000 - 7 * (WEEKS - 1))
  const year = cal.lastYear
  const by: number[][] = Array.from({ length: WEEKS }, () => [])
  for (const [y, a] of sum) {
    if (y < refFirst || y >= year) continue
    const c = cover.get(y)!, n = len.get(y)!
    for (let w = 0; w < WEEKS; w++) {
      if (n[w] < fullLen(y, w) || c[w] / n[w] < 0.8) continue
      by[w].push((a[w] * 7) / n[w])
    }
  }
  const sorted = by.map(v => [...v].sort((p, q) => p - q))
  const cs = sum.get(year), cc = cover.get(year), cn = len.get(year)
  const current = Array.from({ length: WEEKS }, (_, w) =>
    cs && cn && cc && cn[w] >= fullLen(year, w) && cc[w] / cn[w] >= 0.8 ? (cs[w] * 7) / cn[w] : null)
  return { median: sorted.map(v => quantile(v, 0.5)), p10: sorted.map(v => quantile(v, 0.1)),
           p90: sorted.map(v => quantile(v, 0.9)), current, year, refYears: [refFirst, year - 1],
           nRefMin: Math.min(...by.map(v => v.length)) }
}

// --- biggest single days in the area ---
export interface TopDay { date: string; value: number; source: string; modelled: boolean; monthTotal: number }

export function topDays(s: Daily, cal: Calendar, n = 10, fromYear = 0): TopDay[] {
  const idx = Array.from({ length: cal.nDays }, (_, k) => k).filter(k => s.harm[k] > 0 && cal.year[k] >= fromYear)
  idx.sort((a, b) => s.harm[b] - s.harm[a])
  const iso = (k: number) => `${cal.year[k]}-${String(cal.month[k] + 1).padStart(2, '0')}-${String(cal.dom[k]).padStart(2, '0')}`
  return idx.slice(0, n).map(k => {
    // how big the day was against its own month: share of the month total
    let total = 0
    for (let j = k - cal.dom[k] + 1; j < cal.nDays && j >= 0 && cal.month[j] === cal.month[k] && cal.year[j] === cal.year[k]; j++) total += s.harm[j]
    return { date: iso(k), value: s.harm[k], source: cal.source[k], modelled: !!cal.modelled[k], monthTotal: total }
  })
}

// --- critical periods: the fewest weeks that hold 75% of the area's usual burning, merged into date runs ---
export interface CriticalPeriods { runs: [number, number][]; share: number; weeks: number }

export function criticalPeriods(s: Daily, cal: Calendar, refFirst = REF_FIRST, target = 0.75): CriticalPeriods {
  // mean weekly burning over complete reference years (a share of all burning, so the mean, not the median)
  const tot = new Float64Array(WEEKS), yrs = new Set<number>()
  for (let k = 0; k < cal.nDays; k++) {
    const y = cal.year[k]
    if (y < refFirst || y >= cal.lastYear) continue
    tot[weekOfYear(y, cal.month[k], cal.dom[k])] += s.harm[k]; yrs.add(y)
  }
  const all = tot.reduce((a, b) => a + b, 0)
  if (all <= 0) return { runs: [], share: 0, weeks: 0 }
  const order = Array.from({ length: WEEKS }, (_, w) => w).sort((a, b) => tot[b] - tot[a])
  const pick = new Uint8Array(WEEKS)
  let acc = 0
  for (const w of order) { if (acc / all >= target) break; pick[w] = 1; acc += tot[w] }
  // close single-week gaps so a season reads as one period
  for (let w = 1; w < WEEKS - 1; w++) if (!pick[w] && pick[w - 1] && pick[w + 1]) { pick[w] = 1; acc += tot[w] }
  const runs: [number, number][] = []
  for (let w = 0; w < WEEKS; w++) {
    if (!pick[w]) continue
    if (runs.length && runs[runs.length - 1][1] === w - 1) runs[runs.length - 1][1] = w
    else runs.push([w, w])
  }
  return { runs, share: acc / all, weeks: pick.reduce((a, b) => a + b, 0) }
}

/** First and last day of a week of year, as "5 Apr". */
export function weekLabel(w: number, end = false): string {
  const day = end ? (w === WEEKS - 1 ? 364 : w * 7 + 6) : w * 7
  const dt = new Date(Date.UTC(2001, 0, 1) + day * 86400000)
  return `${dt.getUTCDate()} ${MONTHS[dt.getUTCMonth()]}`
}

// --- outlook: what the next 28 days usually bring, from the same 28 days of earlier years ---
export interface Outlook {
  from: string; to: string; median: number; p10: number; p90: number; nRef: number
  shareOfYear: number   // median share of the year's burning that falls in these 28 days
}

export function outlook(s: Daily, cal: Calendar, refFirst = REF_FIRST, days = 28): Outlook {
  const last = cal.nDays - 1, m = cal.month[last], d = cal.dom[last]
  const sums: number[] = [], shares: number[] = []
  const yearTotal = new Map<number, number>()
  for (let k = 0; k < cal.nDays; k++) yearTotal.set(cal.year[k], (yearTotal.get(cal.year[k]) ?? 0) + s.harm[k])
  for (let k = 0; k < last; k++) {
    const y = cal.year[k]
    if (cal.month[k] !== m || cal.dom[k] !== d || y < refFirst || y >= cal.lastYear) continue
    if (k + days >= cal.nDays) continue
    let sum = 0, cover = 0
    for (let j = k + 1; j <= k + days; j++) { sum += s.harm[j]; cover += cal.hasData[j] }
    if (cover / days < 0.8) continue
    sums.push(sum)
    const yt = yearTotal.get(y) ?? 0
    if (yt > 0) shares.push(sum / yt)
  }
  sums.sort((a, b) => a - b); shares.sort((a, b) => a - b)
  const fmt = (ms: number) => { const dt = new Date(ms); return `${dt.getUTCDate()} ${MONTHS[dt.getUTCMonth()]}` }
  const t0 = cal.epoch + last * 86400000
  return { from: fmt(t0 + 86400000), to: fmt(t0 + days * 86400000), median: quantile(sums, 0.5),
           p10: quantile(sums, 0.1), p90: quantile(sums, 0.9), nRef: sums.length, shareOfYear: quantile(shares, 0.5) }
}

// --- every year week by week (a weekly burning calendar) ---
export interface WeekGrid { years: number[]; values: (number | null)[][]; max: number }

export function weeklyGrid(s: Daily, cal: Calendar): WeekGrid {
  const sum = new Map<number, Float64Array>(), cover = new Map<number, Float64Array>(), len = new Map<number, Float64Array>()
  const get = (m: Map<number, Float64Array>, y: number) => {
    let a = m.get(y); if (!a) { a = new Float64Array(WEEKS); m.set(y, a) } return a
  }
  for (let k = 0; k < cal.nDays; k++) {
    const y = cal.year[k], w = weekOfYear(y, cal.month[k], cal.dom[k])
    get(sum, y)[w] += s.harm[k]; get(cover, y)[w] += cal.hasData[k]; get(len, y)[w] += 1
  }
  const years = [...sum.keys()].sort((a, b) => a - b)
  let max = 1
  const values = years.map(y => Array.from({ length: WEEKS }, (_, w) => {
    const n = len.get(y)![w], c = cover.get(y)![w]
    if (n < 4 || c / n < 0.5) return null     // week not in the record yet, or mostly without satellite data
    const v = (sum.get(y)![w] * 7) / n
    if (v > max) max = v
    return v
  }))
  return { years, values, max }
}

// --- season shift: which part of the year burns, first five full years against the last five ---
export interface SeasonShift { early: [number, number]; late: [number, number]; spring: [number, number]; autumn: [number, number] }

export function seasonShift(months: Period[], lastYear: number): SeasonShift | null {
  const share = (y0: number, y1: number, ms: number[]) => {
    let part = 0, all = 0
    for (const p of months) if (p.year >= y0 && p.year <= y1) { all += p.harm; if (ms.includes(p.month!)) part += p.harm }
    return all > 0 ? part / all : NaN
  }
  const early: [number, number] = [REF_FIRST, REF_FIRST + 4], late: [number, number] = [lastYear - 5, lastYear - 1]
  const spring: [number, number] = [share(...early, [2, 3, 4]), share(...late, [2, 3, 4])]
  const autumn: [number, number] = [share(...early, [7, 8, 9]), share(...late, [7, 8, 9])]
  return [...spring, ...autumn].every(Number.isFinite) ? { early, late, spring, autumn } : null
}

/** Mean yearly total over a run of years, for the harmonized and the naive record. */
export function meanYearly(years: Period[], y0: number, y1: number): { harm: number; naive: number } {
  const sel = years.filter(p => p.year >= y0 && p.year <= y1)
  const n = Math.max(1, sel.length)
  return { harm: sel.reduce((a, p) => a + p.harm, 0) / n, naive: sel.reduce((a, p) => a + p.naive, 0) / n }
}
