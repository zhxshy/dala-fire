// Yearly totals: naive splice vs harmonized record, with the model's uncertainty band.
// AI-assistance note: drafted with an AI coding assistant (Claude) and reviewed by the author.
import { forwardRef } from 'react'
import type { Period } from '../lib/aggregate'
import { SENSOR_COLORS } from '../lib/colors'

const W = 640, H = 260, L = 56, R = 12, T = 14, B = 28

export const AnnualChart = forwardRef<SVGSVGElement, { years: Period[] }>(function AnnualChart({ years }, ref) {
  const ys = years.filter(y => !y.partial)
  if (ys.length < 2) return null
  const x0 = ys[0].year, x1 = ys[ys.length - 1].year
  const max = Math.max(1, ...ys.map(y => Math.max(y.harm, y.naive, y.band?.[1] ?? 0)))
  const { nice, ticks } = axis(max)
  const sx = (yr: number) => L + ((yr - x0) / (x1 - x0)) * (W - L - R)
  const sy = (v: number) => T + (1 - v / nice) * (H - T - B)
  const line = (pts: [number, number][]) => pts.map(([a, b], i) => `${i ? 'L' : 'M'}${sx(a).toFixed(1)},${sy(b).toFixed(1)}`).join('')
  const banded = ys.filter(y => y.band)
  const area = banded.length > 1
    ? `${line(banded.map(y => [y.year, y.band![1]]))}L${[...banded].reverse().map(y => `${sx(y.year).toFixed(1)},${sy(y.band![0]).toFixed(1)}`).join('L')}Z`
    : ''
  const yearTicks = ys.map(y => y.year).filter(y => y % 5 === 0)
  return (
    <svg ref={ref} viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Fire cell-days per year" className="annual">
      {ticks.map(t => (
        <g key={t}>
          <line x1={L} x2={W - R} y1={sy(t)} y2={sy(t)} stroke="#e4e4e4" />
          <text x={L - 6} y={sy(t) + 4} textAnchor="end" className="axis">{fmtK(t)}</text>
        </g>
      ))}
      {yearTicks.map(y => <text key={y} x={sx(y)} y={H - 8} textAnchor="middle" className="axis">{y}</text>)}
      {x0 < 2012 && x1 > 2012 && (
        <g>
          <line x1={sx(2011.5)} x2={sx(2011.5)} y1={T} y2={H - B} stroke="#999" strokeDasharray="3 3" />
          <text x={sx(2011.5) + 4} y={T + 10} className="axis">VIIRS starts</text>
        </g>
      )}
      {area && <path d={area} fill="#1a1a1a" opacity={0.12} />}
      <path d={line(ys.map(y => [y.year, y.modis]))} fill="none" stroke={SENSOR_COLORS.MODIS} strokeWidth={1.3} strokeDasharray="4 3" />
      <path d={line(ys.filter(y => y.year >= 2012).map(y => [y.year, y.vnp]))} fill="none" stroke={SENSOR_COLORS.VIIRS} strokeWidth={1.3} strokeDasharray="1.5 2.5" />
      <path d={line(ys.map(y => [y.year, y.naive]))} fill="none" stroke="#b03a2e" strokeWidth={1.8} />
      <path d={line(ys.map(y => [y.year, y.harm]))} fill="none" stroke="#1a1a1a" strokeWidth={2.4} />
      {ys.map(y => <circle key={y.year} cx={sx(y.year)} cy={sy(y.harm)} r={2.2} fill="#1a1a1a"><title>{`${y.year}: ${Math.round(y.harm).toLocaleString('en-US')} harmonized fire cell-days`}</title></circle>)}
    </svg>
  )
})

export function AnnualLegend() {
  return (
    <div className="legend">
      <span><i className="line" style={{ borderColor: '#1a1a1a', borderTopWidth: 3 }} /> Harmonized (shaded: 10–90% range of the model)</span>
      <span><i className="line" style={{ borderColor: '#b03a2e' }} /> Naive splice</span>
      <span><i className="line dashed" style={{ borderColor: SENSOR_COLORS.MODIS }} /> MODIS raw</span>
      <span><i className="line dotted" style={{ borderColor: SENSOR_COLORS.VIIRS }} /> VIIRS S-NPP raw</span>
    </div>
  )
}


const fmtK = (v: number) => (v >= 1000 ? `${(v / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })}k` : String(Math.round(v)))

/** Round axis: a step of 1, 2, 2.5 or 5 x 10^k giving four to six intervals. */
function axis(v: number): { nice: number; ticks: number[] } {
  const raw = v / 5, p = Math.pow(10, Math.floor(Math.log10(raw)))
  const step = [1, 2, 2.5, 5, 10].map(m => m * p).find(s => s >= raw) ?? 10 * p
  const nice = Math.ceil(v / step) * step
  return { nice, ticks: Array.from({ length: Math.round(nice / step) + 1 }, (_, i) => i * step) }
}
