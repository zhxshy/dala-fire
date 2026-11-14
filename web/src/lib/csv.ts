// CSV and PNG downloads, built in the browser.
// AI-assistance note: drafted with an AI coding assistant (Claude) and reviewed by the author.
import type { Period } from './aggregate'
import type { Hotspot } from './data'

const cell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(header: string[], rows: unknown[][], comments: string[] = []): string {
  return [...comments.map(c => `# ${c}`), header.join(','), ...rows.map(r => r.map(cell).join(','))].join('\n') + '\n'
}

export function download(name: string, content: BlobPart, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const a = Object.assign(document.createElement('a'), { href: url, download: name })
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function seriesCsv(periods: Period[], area: string, dataThrough: string): string {
  return toCsv(
    ['period', 'harmonized_cell_days', 'band_p10', 'band_p90', 'modis_raw_cell_days', 'viirs_snpp_raw_cell_days',
     'naive_splice', 'days', 'days_with_data', 'modelled_share', 'partial', 'indicative'],
    periods.map(p => [p.key, p.harm.toFixed(1), p.band?.[0].toFixed(1) ?? '', p.band?.[1].toFixed(1) ?? '', p.modis, p.vnp,
                      p.naive, p.days, p.daysWithData, p.modelledShare.toFixed(2), p.partial, p.indicative]),
    [`Dala Fire harmonized fire record: ${area}`, `Data through ${dataThrough}. Source: NASA FIRMS (MODIS C6.1, VIIRS 375 m C2).`,
     'Unit: fire cell-days on the VIIRS S-NPP scale (0.01-degree cells with >=1 detection per day).',
     'band_p10/band_p90: 10th-90th percentile range for modelled (pre-VIIRS) values, from leave-one-year-out validation.'])
}

export function hotspotsCsv(rows: Hotspot[], area: string): string {
  return toCsv(['date', 'time_utc', 'latitude', 'longitude', 'sensor', 'source', 'confidence', 'frp_mw', 'daynight'],
    rows.map(h => [h.date, h.time_utc, h.lat.toFixed(4), h.lon.toFixed(4), h.sensor, h.src, h.confidence, h.frp_mw.toFixed(1), h.daynight]),
    [`Dala Fire: clean NASA FIRMS hotspots in ${area}`,
     'Sensors: MODIS_T Terra, MODIS_A Aqua, VNP VIIRS S-NPP, VJ1 VIIRS NOAA-20, VJ2 VIIRS NOAA-21. source SP = science archive, NRT = near real time.'])
}

/** Render an <svg> element to PNG and download it. */
export async function svgToPng(svg: SVGSVGElement, name: string, scale = 2) {
  const clone = svg.cloneNode(true) as SVGSVGElement
  const { width, height } = svg.getBoundingClientRect()
  clone.setAttribute('width', String(width)); clone.setAttribute('height', String(height))
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  const style = document.createElementNS('http://www.w3.org/2000/svg', 'style')
  style.textContent = 'text{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}'
  clone.prepend(style)
  const src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(clone))
  const img = new Image()
  await new Promise((ok, fail) => { img.onload = ok; img.onerror = fail; img.src = src })
  const canvas = Object.assign(document.createElement('canvas'), { width: width * scale, height: height * scale })
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  canvas.toBlob(b => b && download(name, b, 'image/png'), 'image/png')
}
