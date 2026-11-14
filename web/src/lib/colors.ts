// Colour scales readable with common colour-vision deficiencies (no red-green pairs).
// AI-assistance note: drafted with an AI coding assistant (Claude) and reviewed by the author.

// one warm hue, light -> dark: little fire fades into the page, much fire stands out. Lightness falls steadily,
// so it also reads in greyscale and with colour-vision deficiencies.
const WARM = ['#f4eee4', '#fde6c4', '#f6b97a', '#e8873f', '#c75a1a', '#8f3405', '#5a1e00']
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

/** Sequential colour for a count, on a square-root scale relative to `max`: a year with a quarter of the fire is
 *  half as dark, so a decline is visible, which a log scale would flatten. */
export const sequential = (value: number, max: number) =>
  interpolate(WARM, max > 0 ? Math.sqrt(Math.max(0, value) / max) : 0)

/** Diverging colour for an anomaly in units of the p10-p90 spread, clipped to +-1. */
export const diverging = (a: number) => interpolate(DIVERGING, (Math.max(-1, Math.min(1, a)) + 1) / 2)

// one warm hue, light -> dark, for fire amounts drawn on a light map
const FIRE = ['#fde6c4', '#f6b97a', '#e8873f', '#c75a1a', '#8f3405', '#5a1e00']

/** Fire colour for a map cell, on a log scale relative to `max`. */
export const fire = (value: number, max: number) => interpolate(FIRE, max > 0 ? Math.log1p(value) / Math.log1p(max) : 0)
export const FIRE_STOPS = FIRE

export const NO_DATA = '#cfcfcf'
export const SENSOR_COLORS = { MODIS: '#dc7a35', VIIRS: '#2d4f8f' }
