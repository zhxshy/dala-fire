// Burning calendar: years x months heatmap.
// AI-assistance note: drafted with an AI coding assistant (Claude) and reviewed by the author.
import { forwardRef, type KeyboardEvent } from 'react'
import { anomaly, MONTHS, type Climatology, type Period } from '../lib/aggregate'
import { diverging, NO_DATA, sequential } from '../lib/colors'

export type Mode = 'harm' | 'naive' | 'modis' | 'vnp' | 'anomaly'

export const MODE_LABEL: Record<Mode, string> = {
  harm: 'Harmonized (VIIRS scale)',
  naive: 'Naive splice (MODIS → VIIRS in 2012)',
  modis: 'MODIS raw',
  vnp: 'VIIRS S-NPP raw',
  anomaly: 'Anomaly vs median',
}

const CW = 46, CH = 17, LEFT = 40, TOP = 22

interface Props {
  months: Period[]; clim: Climatology; mode: Mode; selected: string | null
  onSelect: (key: string) => void
}

function value(p: Period, mode: Mode): number {
  return mode === 'harm' || mode === 'anomaly' ? p.harm : mode === 'naive' ? p.naive : mode === 'modis' ? p.modis : p.vnp
}

const fmt = (v: number) => (v >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(1))

export const Calendar = forwardRef<SVGSVGElement, Props>(function Calendar({ months, clim, mode, selected, onSelect }, ref) {
  const years = [...new Set(months.map(p => p.year))]
  const max = Math.max(1, ...months.filter(p => !p.partial).map(p => Math.max(p.harm, p.naive)))
  const width = LEFT + 12 * CW + 4, height = TOP + years.length * CH + 4
  // arrow keys move the selection: left/right one month, up/down one year
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    const step = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -12, ArrowDown: 12 } as Record<string, number>)[e.key]
    if (!step) return
    e.preventDefault()
    const i = selected ? months.findIndex(p => p.key === selected.slice(0, 7)) : -1
    const j = i < 0 ? months.length - 1 : Math.min(months.length - 1, Math.max(0, i + step))
    if (months[j].key !== selected) onSelect(months[j].key)
  }
  return (
    <svg ref={ref} width={width} height={height} role="group" tabIndex={0} onKeyDown={onKey} className="calendar"
         aria-label="Monthly burning calendar. Arrow keys move between months and show that month's fires on the map.">
      <defs>
        <pattern id="hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="5" stroke="#ffffff" strokeWidth="1.3" strokeOpacity="0.55" />
        </pattern>
      </defs>
      {MONTHS.map((m, i) => (
        <text key={m} x={LEFT + i * CW + CW / 2} y={TOP - 7} textAnchor="middle" className="axis">{m}</text>
      ))}
      {years.map((y, row) => (
        <text key={y} x={LEFT - 6} y={TOP + row * CH + CH / 2 + 4} textAnchor="end" className="axis">{y}</text>
      ))}
      {months.map(p => {
        const row = years.indexOf(p.year), col = p.month!
        const x = LEFT + col * CW, yy = TOP + row * CH
        const covered = p.daysWithData / p.days >= 0.5
        const v = value(p, mode)
        let fill: string
        if (!covered || (mode === 'vnp' && p.year < 2012)) fill = NO_DATA
        else if (mode === 'anomaly') fill = p.partial ? '#ffffff' : diverging(anomaly(p, clim))
        else fill = sequential(v, max)
        const hatch = mode === 'harm' && covered && p.modelledShare > 0.5
        const a = anomaly(p, clim)
        const tip = [
          `${MONTHS[col]} ${p.year}${p.partial ? ' (in progress)' : ''}`,
          `Harmonized: ${fmt(p.harm)} fire cell-days` + (p.band ? ` (likely ${fmt(p.band[0])}–${fmt(p.band[1])})` : ''),
          `MODIS raw: ${p.modis}  ·  VIIRS S-NPP raw: ${p.year >= 2012 ? p.vnp : '–'}`,
          p.partial ? 'Month in progress: compare in the card above' : `vs median ${MONTHS[col]}: ${fmt(clim.median[col])} (anomaly ${isFinite(a) ? a.toFixed(2) : '–'})`,
          p.modelledShare > 0.5 ? 'Modelled from MODIS (before VIIRS)' : 'Observed by VIIRS',
          covered ? '' : 'No satellite data for most of this month',
          p.indicative ? 'Small count: indicative only' : '',
        ].filter(Boolean).join('\n')
        return (
          <g key={p.key} onClick={() => onSelect(p.key)} className="cell">
            <rect x={x + 1} y={yy + 1} width={CW - 2} height={CH - 2} fill={fill} />
            {hatch && <rect x={x + 1} y={yy + 1} width={CW - 2} height={CH - 2} fill="url(#hatch)" />}
            {p.partial && <rect x={x + 1.5} y={yy + 1.5} width={CW - 3} height={CH - 3} fill="none" stroke="#333" strokeDasharray="2 2" />}
            {selected === p.key && <rect x={x} y={yy} width={CW} height={CH} fill="none" stroke="#c4561a" strokeWidth={2.5} />}
            <title>{tip}</title>
          </g>
        )
      })}
    </svg>
  )
})

export function CalendarLegend({ mode, max }: { mode: Mode; max: number }) {
  const stops = Array.from({ length: 11 }, (_, i) => i / 10)
  return (
    <div className="legend">
      {mode === 'anomaly' ? (
        <span className="ramp">
          <span>below median</span>
          {stops.map(t => <i key={t} style={{ background: diverging(t * 2 - 1) }} />)}
          <span>above</span>
        </span>
      ) : (
        <span className="ramp">
          <span>0</span>
          {stops.map(t => <i key={t} style={{ background: sequential(Math.expm1(t * Math.log1p(max)), max) }} />)}
          <span>{Math.round(max).toLocaleString('en-US')} fire cell-days / month</span>
        </span>
      )}
      {mode === 'harm' && <span><i className="swatch hatch" /> modelled from MODIS</span>}
      <span><i className="swatch" style={{ background: NO_DATA }} /> no data</span>
      <span><i className="swatch dashed" /> month in progress</span>
    </div>
  )
}

export const calendarMax = (months: Period[]) =>
  Math.max(1, ...months.filter(p => !p.partial).map(p => Math.max(p.harm, p.naive)))
