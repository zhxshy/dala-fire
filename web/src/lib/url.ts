// Shareable links: the selected area, month or day and view options live in the URL hash.
// AI-assistance note: drafted with an AI coding assistant (Claude) and reviewed by the author.
import type { Region } from './data'
import type { Area } from './geo'

export interface ViewState {
  area: Area; selected: string | null; mode: string; tab: 'explore' | 'world' | 'methods'
  seasonRecent: boolean; topObserved: boolean; worldArea: Area
}

// the world view names countries by their number in the boundary file
const WORLD_IDS: Region[] = Array.from({ length: 255 }, (_, id) => ({ id, iso: String(id), en: '', kk: '', ru: '' }))

const num = (s: string) => { const v = Number(s); return Number.isFinite(v) ? v : null }
const r3 = (v: number) => String(Math.round(v * 1000) / 1000)

function areaToString(a: Area, regions: Region[]): string {
  if (a.kind === 'regions') return a.ids.map(i => regions[i]?.iso).filter(Boolean).join('.')
  if (a.kind === 'box') return `box:${[a.west, a.south, a.east, a.north].map(r3).join(',')}`
  if (a.kind === 'circle') return `circle:${[a.lat, a.lon, a.km].map(r3).join(',')}`
  if (a.kind === 'polygon') return `poly:${a.ring.map(p => p.map(r3).join(',')).join(';')}`
  return ''
}

function areaFromString(s: string, regions: Region[]): Area {
  if (!s) return { kind: 'country' }
  const [kind, rest] = s.includes(':') ? [s.slice(0, s.indexOf(':')), s.slice(s.indexOf(':') + 1)] : ['regions', s]
  if (kind === 'regions') {
    const ids = rest.split('.').map(iso => regions.find(r => r.iso === iso)?.id).filter((i): i is number => i !== undefined)
    return ids.length ? { kind: 'regions', ids } : { kind: 'country' }
  }
  if (kind === 'box') {
    const v = rest.split(',').map(num)
    if (v.length === 4 && v.every(x => x !== null) && v[0]! < v[2]! && v[1]! < v[3]!) return { kind: 'box', west: v[0]!, south: v[1]!, east: v[2]!, north: v[3]! }
  }
  if (kind === 'circle') {
    const v = rest.split(',').map(num)
    if (v.length === 3 && v.every(x => x !== null) && v[2]! > 0 && v[2]! <= 2000) return { kind: 'circle', lat: v[0]!, lon: v[1]!, km: v[2]! }
  }
  if (kind === 'poly') {
    const ring = rest.split(';').map(p => p.split(',').map(num))
    if (ring.length >= 3 && ring.length <= 200 && ring.every(p => p.length === 2 && p[0] !== null && p[1] !== null)) return { kind: 'polygon', ring: ring as [number, number][] }
  }
  return { kind: 'country' }
}

export function readHash(regions: Region[], modes: string[]): Partial<ViewState> {
  const q = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  const out: Partial<ViewState> = {}
  if (q.has('a')) out.area = areaFromString(q.get('a')!, regions)
  const d = q.get('d')
  if (d && /^\d{4}-\d{2}(-\d{2})?$/.test(d)) out.selected = d
  const m = q.get('m')
  if (m && modes.includes(m)) out.mode = m
  if (q.get('tab') === 'methods') out.tab = 'methods'
  if (q.get('tab') === 'world') out.tab = 'world'
  if (q.has('w')) out.worldArea = areaFromString(q.get('w')!, WORLD_IDS)
  if (q.get('ref') === '10') out.seasonRecent = true
  if (q.get('top') === 'viirs') out.topObserved = true
  return out
}

export function writeHash(s: ViewState, regions: Region[]): string {
  const q: string[] = []
  const a = areaToString(s.area, regions)
  if (a) q.push(`a=${a}`)
  if (s.selected) q.push(`d=${s.selected}`)
  if (s.mode !== 'harm') q.push(`m=${s.mode}`)
  if (s.tab !== 'explore') q.push(`tab=${s.tab}`)
  const w = areaToString(s.worldArea, WORLD_IDS)
  if (w) q.push(`w=${w}`)
  if (s.seasonRecent) q.push('ref=10')
  if (s.topObserved) q.push('top=viirs')
  const hash = q.length ? `#${q.join('&')}` : ''
  try { history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`) } catch { /* sandboxed frames */ }
  return `${window.location.origin}${window.location.pathname}${hash}`
}
