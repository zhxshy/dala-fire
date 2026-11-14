// The biggest single fire days in the selected area, on the harmonized scale.
// AI-assistance note: drafted with an AI coding assistant (Claude) and reviewed by the author.
import type { TopDay } from '../lib/aggregate'

const SOURCE: Record<string, string> = {
  VNP: 'S-NPP (VIIRS)', VJ1: 'NOAA-20 (VIIRS)', VJ2: 'NOAA-21 (VIIRS)',
  MODIS: 'Terra + Aqua (MODIS, modelled)', TERRA: 'Terra (MODIS, modelled)', AQUA: 'Aqua (MODIS, modelled)',
}

export function TopDays({ days, selected, onSelect }: { days: TopDay[]; selected: string | null; onSelect: (d: string) => void }) {
  if (!days.length) return <p className="small">No fire detected in this area.</p>
  return (
    <table className="topdays">
      <thead><tr><th>#</th><th>Date (UTC)</th><th>Fire cell-days</th><th>Share of its month</th><th>Seen by</th><th /></tr></thead>
      <tbody>
        {days.map((d, i) => (
          <tr key={d.date} className={selected === d.date ? 'on' : ''}>
            <td>{i + 1}</td>
            <td>{fmtDate(d.date)}</td>
            <td>{Math.round(d.value).toLocaleString('en-US')}</td>
            <td>{d.monthTotal > 0 ? `${Math.round((100 * d.value) / d.monthTotal)}%` : '–'}</td>
            <td>{SOURCE[d.source] ?? d.source}</td>
            <td><button onClick={() => onSelect(d.date)}>{selected === d.date ? 'Shown' : 'Show on map'}</button></td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

const fmtDate = (iso: string) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
