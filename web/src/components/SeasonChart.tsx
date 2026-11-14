// Seasonal profile: weekly fire cell-days, median and 10-90% range of earlier years, current year on top.
// AI-assistance note: drafted with an AI coding assistant (Claude) and reviewed by the author.
import { forwardRef } from 'react'
import { MONTHS, WEEKS, weekOfYear, type CriticalPeriods, type Season } from '../lib/aggregate'

const W = 640, H = 240, L = 56, R = 12, T = 14, B = 28
const CURRENT = '#c4561a', REF = '#1a1a1a'

export const SeasonChart = forwardRef<SVGSVGElement, { season: Season; critical?: CriticalPeriods }>(function SeasonChart({ season, critical }, ref) {
  const vals = [...season.p90, ...season.current.map(v => v ?? 0)].filter(v => Number.isFinite(v))
  const { nice, ticks } = axis(Math.max(1, ...vals))
  const sx = (w: number) => L + (w / (WEEKS - 1)) * (W - L - R)
  const sy = (v: number) => T + (1 - v / nice) * (H - T - B)
  const path = (pts: [number, number][]) => pts.map(([a, b], i) => `${i ? 'L' : 'M'}${sx(a).toFixed(1)},${sy(b).toFixed(1)}`).join('')
  const ws = Array.from({ length: WEEKS }, (_, w) => w)
  const band = `${path(ws.map(w => [w, season.p90[w]]))}L${[...ws].reverse().map(w => `${sx(w).toFixed(1)},${sy(season.p10[w]).toFixed(1)}`).join('L')}Z`
  // current year: break the line where a week is missing
  const segs: [number, number][][] = []
  season.current.forEach((v, w) => {
    if (v === null) return
    if (!segs.length || season.current[w - 1] === null || w === 0) segs.push([])
    segs[segs.length - 1].push([w, v])
  })
  const monthTicks = MONTHS.map((m, i) => ({ m, w: weekOfYear(2001, i, 1) }))
  return (
    <svg ref={ref} viewBox={`0 0 ${W} ${H}`} width="100%" role="img" className="annual"
         aria-label={`Weekly fire cell-days: median and 10–90% range of ${season.refYears[0]}–${season.refYears[1]}, and ${season.year}`}>
      {ticks.map(t => (
        <g key={t}>
          <line x1={L} x2={W - R} y1={sy(t)} y2={sy(t)} stroke="#e4e4e4" />
          <text x={L - 6} y={sy(t) + 4} textAnchor="end" className="axis">{fmtK(t)}</text>
        </g>
      ))}
      {monthTicks.map(({ m, w }) => <text key={m} x={sx(w + 2)} y={H - 8} textAnchor="middle" className="axis">{m}</text>)}
      {critical?.runs.map(([a, b]) => (
        <rect key={a} x={sx(Math.max(0, a - 0.5))} y={T} width={sx(Math.min(WEEKS - 1, b + 0.5)) - sx(Math.max(0, a - 0.5))}
              height={H - T - B} fill={CURRENT} opacity={0.08} />
      ))}
      <path d={band} fill={REF} opacity={0.12} />
      <path d={path(ws.map(w => [w, season.median[w]]))} fill="none" stroke={REF} strokeWidth={1.8} />
      {segs.map((s, i) => s.length > 1
        ? <path key={i} d={path(s)} fill="none" stroke={CURRENT} strokeWidth={2.4} />
        : <circle key={i} cx={sx(s[0][0])} cy={sy(s[0][1])} r={2.5} fill={CURRENT} />)}
      {season.current.map((v, w) => v === null ? null : (
        <circle key={w} cx={sx(w)} cy={sy(v)} r={6} fill="transparent">
          <title>{`${season.year}, week ${w + 1}: ${Math.round(v).toLocaleString('en-US')} (median ${Math.round(season.median[w]).toLocaleString('en-US')}, usual ${Math.round(season.p10[w]).toLocaleString('en-US')}–${Math.round(season.p90[w]).toLocaleString('en-US')})`}</title>
        </circle>
      ))}
    </svg>
  )
})

export function SeasonLegend({ season }: { season: Season }) {
  return (
    <div className="legend">
      <span><i className="line" style={{ borderColor: CURRENT, borderTopWidth: 3 }} /> {season.year}</span>
      <span><i className="line" style={{ borderColor: REF }} /> Median {season.refYears[0]}–{season.refYears[1]}</span>
      <span><i className="swatch" style={{ background: 'rgba(26,26,26,0.12)', borderColor: 'transparent' }} /> Usual range (10–90%)</span>
      <span><i className="swatch" style={{ background: 'rgba(196,86,26,0.15)', borderColor: 'transparent' }} /> Critical periods</span>
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
