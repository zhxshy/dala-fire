// Colour scales readable with common colour-vision deficiencies (no red-green pairs).
// AI-assistance note: drafted with an AI coding assistant (Claude) and reviewed by the author.

// cividis (Nuñez et al. 2018), 9 stops, dark blue -> yellow
const CIVIDIS = ['#00224e', '#123570', '#3b496c', '#575d6d', '#707173', '#8a8678', '#a59c74', '#c3b369', '#e1cc55', '#fee838']
// diverging blue <- light grey -> orange (PuOr-like), for anomalies
const DIVERGING = ['#2d4f8f', '#5b7fbf', '#9db5dd', '#e8e8e8', '#f2b47c', '#dc7a35', '#a84300']

function hexToRgb(h: string): [number, number, number] {
  const v = parseInt(h.slice(1), 16)
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255]
}

function interpolate(stops: string[], t: number): string {
  const x = Math.min(1, Math.max(0, t)) * (stops.length - 1)
  const i = Math.min(stops.length - 2, Math.floor(x)), f = x - i
  const a = hexToRgb(stops[i]), b = hexToRgb(stops[i + 1])
  const c = a.map((v, j) => Math.round(v + (b[j] - v) * f))
  return `rgb(${c[0]},${c[1]},${c[2]})`
}

/** Sequential colour for a count, on a log scale relative to `max`. */
export const sequential = (value: number, max: number) =>
  interpolate(CIVIDIS, max > 0 ? Math.log1p(value) / Math.log1p(max) : 0)

/** Diverging colour for an anomaly in units of the p10-p90 spread, clipped to +-1. */
export const diverging = (a: number) => interpolate(DIVERGING, (Math.max(-1, Math.min(1, a)) + 1) / 2)

export const NO_DATA = '#cfcfcf'
export const SENSOR_COLORS = { MODIS: '#dc7a35', VIIRS: '#2d4f8f' }
