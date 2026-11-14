// Every year week by week: a weekly burning calendar that shows when each fire season started, peaked and ended.
// AI-assistance note: drafted with an AI coding assistant (Claude) and reviewed by the author.
import { MONTHS, WEEKS, weekLabel, weekOfYear, type WeekGrid as Grid } from '../lib/aggregate'
import { NO_DATA, sequential } from '../lib/colors'

const CW = 12, CH = 13, LEFT = 40, TOP = 20

export function WeekGrid({ grid }: { grid: Grid }) {
  const width = LEFT + WEEKS * CW + 4, height = TOP + grid.years.length * CH + 4
  return (
    <svg width={width} height={height} role="img" className="calendar"
         aria-label="Harmonized fire cell-days for every week of every year">
      {MONTHS.map((m, i) => <text key={m} x={LEFT + weekOfYear(2001, i, 1) * CW + 2} y={TOP - 6} className="axis">{m}</text>)}
      {grid.years.map((y, row) => (
        <g key={y}>
          <text x={LEFT - 6} y={TOP + row * CH + CH / 2 + 4} textAnchor="end" className="axis">{y}</text>
          {grid.values[row].map((v, w) => (
            <rect key={w} x={LEFT + w * CW + 0.5} y={TOP + row * CH + 0.5} width={CW - 1} height={CH - 1}
                  fill={v === null ? NO_DATA : sequential(v, grid.max)}>
              <title>{`${weekLabel(w)} – ${weekLabel(w, true)} ${y}: ${v === null ? 'no data' : `${Math.round(v).toLocaleString('en-US')} fire cell-days`}${y < 2012 && v !== null ? ' (modelled from MODIS)' : ''}`}</title>
            </rect>
          ))}
        </g>
      ))}
      <line x1={LEFT} x2={LEFT + WEEKS * CW} y1={TOP + (grid.years.indexOf(2012)) * CH} y2={TOP + (grid.years.indexOf(2012)) * CH}
            stroke="#c4561a" strokeWidth={grid.years.includes(2012) ? 1.5 : 0} strokeDasharray="4 3" />
    </svg>
  )
}
