// Map: regions to click, box/polygon drawing, the selected area, hotspots of the selected month.
// AI-assistance note: drafted with an AI coding assistant (Claude) and reviewed by the author.
import * as maplibregl from 'maplibre-gl'
import type { GeoJSONSource, ImageSource, MapMouseEvent, StyleSpecification } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import { useEffect, useRef, useState } from 'react'
import { SENSOR_COLORS } from '../lib/colors'
import type { Hotspot } from '../lib/data'
import { areaRing, type Area, type Ring } from '../lib/geo'

maplibregl.setWorkerUrl(workerUrl) // bundlers do not copy MapLibre's worker by themselves

const BASEMAP = 'https://tiles.openfreemap.org/styles/positron'
const KZ_BOUNDS: [number, number, number, number] = [46.4, 40.5, 87.4, 55.5]
const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }
const FALLBACK: StyleSpecification = {
  version: 8, sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#eef0f2' } }],
}

export type DrawMode = 'none' | 'box' | 'polygon'

interface Props {
  regions: GeoJSON.FeatureCollection; area: Area; hotspots: Hotspot[]; staticMask: [number, number][] | null
  drawMode: DrawMode; onDrawDone: (a: Area) => void; onRegionClick: (id: number, add: boolean) => void
  bounds?: [number, number, number, number]; attribution?: string
  image?: string   // optional world raster (data URL, Web Mercator rows, see MERC_CORNERS) drawn under the labels
}

// corners of a full-world Web Mercator image; its rows must be evenly spaced in Mercator y, not in latitude
export const MERC_LAT = 85.0511
const MERC_CORNERS: [[number, number], [number, number], [number, number], [number, number]] =
  [[-180, MERC_LAT], [180, MERC_LAT], [180, -MERC_LAT], [-180, -MERC_LAT]]
const BLANK = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

const ringFeature = (ring: Ring): GeoJSON.Feature => ({
  type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] },
})

async function pickStyle(): Promise<string | StyleSpecification> {
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 4000)
    const res = await fetch(BASEMAP, { signal: ctl.signal }); clearTimeout(t)
    return res.ok ? BASEMAP : FALLBACK
  } catch { return FALLBACK }
}

export function MapView({ regions, area, hotspots, staticMask, drawMode, onDrawDone, onRegionClick, bounds = KZ_BOUNDS, image,
                          attribution = 'Fire data: NASA FIRMS · Regions: © OpenStreetMap contributors' }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const map = useRef<maplibregl.Map | null>(null)
  const [ready, setReady] = useState(false)
  const draft = useRef<[number, number][]>([])
  const cb = useRef({ drawMode, onDrawDone, onRegionClick })
  cb.current = { drawMode, onDrawDone, onRegionClick }

  useEffect(() => {
    let cancelled = false
    pickStyle().then(style => {
      if (cancelled || !box.current) return
      const m = new maplibregl.Map({ container: box.current, style, bounds, attributionControl: { compact: true },
                                     doubleClickZoom: false })
      map.current = m
      const ro = new ResizeObserver(() => m.resize())
      ro.observe(box.current)
      m.once('remove', () => ro.disconnect())
      m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
      m.addControl(new maplibregl.AttributionControl({ customAttribution: attribution }))
      m.on('load', () => {
        m.addSource('regions', { type: 'geojson', data: regions, promoteId: 'id' })
        m.addSource('area', { type: 'geojson', data: EMPTY })
        m.addSource('draft', { type: 'geojson', data: EMPTY })
        m.addSource('mask', { type: 'geojson', data: EMPTY })
        m.addSource('hotspots', { type: 'geojson', data: EMPTY })
        m.addLayer({ id: 'regions-fill', type: 'fill', source: 'regions',
          paint: { 'fill-color': '#c4561a', 'fill-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 0.18, 0.02] } })
        m.addLayer({ id: 'regions-line', type: 'line', source: 'regions', paint: { 'line-color': '#55606e', 'line-width': 0.8 } })
        m.addLayer({ id: 'area-fill', type: 'fill', source: 'area', paint: { 'fill-color': '#c4561a', 'fill-opacity': 0.12 } })
        m.addLayer({ id: 'area-line', type: 'line', source: 'area', paint: { 'line-color': '#c4561a', 'line-width': 2 } })
        m.addLayer({ id: 'draft-line', type: 'line', source: 'draft', paint: { 'line-color': '#c4561a', 'line-width': 2, 'line-dasharray': [2, 2] } })
        m.addLayer({ id: 'draft-pts', type: 'circle', source: 'draft', filter: ['==', '$type', 'Point'],
          paint: { 'circle-radius': 4, 'circle-color': '#c4561a' } })
        m.addLayer({ id: 'mask', type: 'circle', source: 'mask',
          paint: { 'circle-radius': 2.2, 'circle-color': '#6b6b6b', 'circle-opacity': 0.7 } })
        m.addLayer({ id: 'hotspots', type: 'circle', source: 'hotspots',
          paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 1.8, 8, 3.5], 'circle-stroke-width': 0.4, 'circle-stroke-color': '#fff',
                   'circle-color': ['match', ['get', 'family'], 'MODIS', SENSOR_COLORS.MODIS, SENSOR_COLORS.VIIRS] } })
        // the fire raster goes under the basemap's labels, so place and country names stay readable
        const firstLabel = m.getStyle().layers.find(l => l.type === 'symbol')?.id ?? 'regions-fill'   // no labels: under the borders
        m.addSource('cells', { type: 'image', url: BLANK, coordinates: MERC_CORNERS })
        m.addLayer({ id: 'cells', type: 'raster', source: 'cells', layout: { visibility: 'none' },
                     paint: { 'raster-opacity': 0.85, 'raster-resampling': 'nearest', 'raster-fade-duration': 0 } }, firstLabel)
        setReady(true)
      })
      m.on('click', (e: MapMouseEvent) => {
        const { drawMode: mode, onDrawDone: done, onRegionClick: pick } = cb.current
        const p: [number, number] = [e.lngLat.lng, e.lngLat.lat]
        if (mode === 'box') {
          draft.current.push(p)
          if (draft.current.length === 2) {
            const [[a, b], [c, d]] = draft.current
            draft.current = []
            done({ kind: 'box', west: Math.min(a, c), east: Math.max(a, c), south: Math.min(b, d), north: Math.max(b, d) })
          }
        } else if (mode === 'polygon') {
          draft.current.push(p)
        } else {
          const f = m.queryRenderedFeatures(e.point, { layers: ['regions-fill'] })[0]
          if (f) pick(Number(f.id), e.originalEvent.shiftKey)
        }
        drawDraft()
      })
      m.on('dblclick', () => {
        if (cb.current.drawMode === 'polygon' && draft.current.length >= 3) {
          const ring = draft.current
          draft.current = []
          cb.current.onDrawDone({ kind: 'polygon', ring })
          drawDraft()
        }
      })
      m.on('mousemove', (e: MapMouseEvent) => {
        if (cb.current.drawMode === 'none') {
          const hit = m.queryRenderedFeatures(e.point, { layers: ['regions-fill'] }).length > 0
          m.getCanvas().style.cursor = hit ? 'pointer' : ''
        } else {
          m.getCanvas().style.cursor = 'crosshair'
          drawDraft([e.lngLat.lng, e.lngLat.lat])
        }
      })
      function drawDraft(cursor?: [number, number]) {
        const src = m.getSource('draft') as GeoJSONSource | undefined
        if (!src) return
        const pts = cursor && draft.current.length ? [...draft.current, cursor] : draft.current
        const feats: GeoJSON.Feature[] = pts.map(c => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: c } }))
        if (cb.current.drawMode === 'box' && pts.length === 2) {
          const [[a, b], [c, d]] = pts
          feats.push(ringFeature([[a, b], [c, b], [c, d], [a, d]]))
        } else if (pts.length >= 2) {
          feats.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: pts } })
        }
        src.setData({ type: 'FeatureCollection', features: feats })
      }
    })
    return () => { cancelled = true; map.current?.remove(); map.current = null; setReady(false) }
  }, [regions])

  // keep layers in sync with props once the map has loaded
  useEffect(() => {
    const m = map.current
    if (!m || !ready) return
    const ids = area.kind === 'regions' ? new Set(area.ids) : new Set<number>()
    for (const f of regions.features) m.setFeatureState({ source: 'regions', id: f.id as number }, { selected: ids.has(f.id as number) })
    const ring = areaRing(area)
    ;(m.getSource('area') as GeoJSONSource).setData(ring ? { type: 'FeatureCollection', features: [ringFeature(ring)] } : EMPTY)
    ;(m.getSource('mask') as GeoJSONSource).setData(staticMask ? {
      type: 'FeatureCollection', features: staticMask.map(c => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: c } })),
    } : EMPTY)
    ;(m.getSource('hotspots') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: hotspots.map(h => ({ type: 'Feature', properties: { family: h.sensor.startsWith('MODIS') ? 'MODIS' : 'VIIRS', date: h.date, frp: h.frp_mw },
                                     geometry: { type: 'Point', coordinates: [h.lon, h.lat] } })),
    })
  }, [ready, area, hotspots, staticMask, regions])

  useEffect(() => {
    const m = map.current
    if (!m || !ready) return
    const src = m.getSource('cells') as ImageSource | undefined
    if (src && image) src.updateImage({ url: image, coordinates: MERC_CORNERS })
    m.setLayoutProperty('cells', 'visibility', image ? 'visible' : 'none')
  }, [ready, image])

  useEffect(() => { if (drawMode === 'none') draft.current = [] }, [drawMode])

  return <div ref={box} className="map" />
}
