// Area-of-interest geometry: regions, boxes, polygons, circles.
// AI-assistance note: drafted with an AI coding assistant (Claude) and reviewed by the author.

export type Ring = [number, number][] // [lon, lat], first point not repeated

export type Area =
  | { kind: 'country' }
  | { kind: 'regions'; ids: number[] }
  | { kind: 'box'; west: number; south: number; east: number; north: number }
  | { kind: 'polygon'; ring: Ring }
  | { kind: 'circle'; lat: number; lon: number; km: number }

export function circleRing(lat: number, lon: number, km: number, steps = 72): Ring {
  const ring: Ring = []
  const dLat = km / 111.32
  const dLon = km / (111.32 * Math.cos((lat * Math.PI) / 180))
  for (let i = 0; i < steps; i++) {
    const a = (2 * Math.PI * i) / steps
    ring.push([lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)])
  }
  return ring
}

export function boxRing(b: { west: number; south: number; east: number; north: number }): Ring {
  return [[b.west, b.south], [b.east, b.south], [b.east, b.north], [b.west, b.north]]
}

/** Ring of a drawable area (box, polygon, circle); null for country and regions. */
export function areaRing(a: Area): Ring | null {
  if (a.kind === 'box') return boxRing(a)
  if (a.kind === 'polygon') return a.ring
  if (a.kind === 'circle') return circleRing(a.lat, a.lon, a.km)
  return null
}

function pointInRing(lon: number, lat: number, ring: Ring): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j]
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** 1 where row i lies in the area (cell centre test). */
export function areaMask(a: Area, lat: Float32Array, lon: Float32Array, r: Uint8Array): Uint8Array {
  const n = lat.length
  const mask = new Uint8Array(n)
  if (a.kind === 'country') return mask.fill(1)
  if (a.kind === 'regions') {
    const set = new Uint8Array(256)
    for (const id of a.ids) set[id] = 1
    for (let i = 0; i < n; i++) mask[i] = set[r[i]]
    return mask
  }
  if (a.kind === 'box') {
    for (let i = 0; i < n; i++) mask[i] = lon[i] >= a.west && lon[i] <= a.east && lat[i] >= a.south && lat[i] <= a.north ? 1 : 0
    return mask
  }
  const ring = areaRing(a)!
  let w = Infinity, e = -Infinity, s = Infinity, nn = -Infinity
  for (const [x, y] of ring) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); nn = Math.max(nn, y) }
  for (let i = 0; i < n; i++) {
    if (lon[i] < w || lon[i] > e || lat[i] < s || lat[i] > nn) continue
    mask[i] = pointInRing(lon[i], lat[i], ring) ? 1 : 0
  }
  return mask
}

/** Same test for a single point (used for hotspot rows). */
export function inArea(a: Area, lat: number, lon: number, region: number): boolean {
  if (a.kind === 'country') return region !== 255
  if (a.kind === 'regions') return a.ids.includes(region)
  if (a.kind === 'box') return lon >= a.west && lon <= a.east && lat >= a.south && lat <= a.north
  return pointInRing(lon, lat, areaRing(a)!)
}

export function areaLabel(a: Area, regionName: (id: number) => string): string {
  switch (a.kind) {
    case 'country': return 'Kazakhstan (whole country)'
    case 'regions': return a.ids.map(regionName).join(' + ')
    case 'box': return `Box ${a.south.toFixed(2)}–${a.north.toFixed(2)}°N, ${a.west.toFixed(2)}–${a.east.toFixed(2)}°E`
    case 'polygon': return `Drawn polygon (${a.ring.length} points)`
    case 'circle': return `${a.km} km around ${a.lat.toFixed(3)}°N, ${a.lon.toFixed(3)}°E`
  }
}
