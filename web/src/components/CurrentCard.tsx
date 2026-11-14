// "This month vs history" cards.
// AI-assistance note: drafted with an AI coding assistant (Claude) and reviewed by the author.
import type { Comparison } from '../lib/aggregate'

const fmt = (v: number) => (isFinite(v) ? Math.round(v).toLocaleString('en-US') : '–')

function verdict(c: Comparison) {
  if (!isFinite(c.percentile) || c.nRef < 5) return 'Not enough history in this area to compare.'
  if (c.value === 0 && c.median === 0) return 'No fire activity, as usual for this time of year.'
  const level = c.percentile >= 90 ? 'Unusually high' : c.percentile >= 66 ? 'Above normal' : c.percentile > 33 ? 'Near normal'
    : c.percentile > 10 ? 'Below normal' : 'Unusually low'
  const rank = `higher than ${Math.round(c.percentile)}% of ${c.refYears[0]}–${c.refYears[1]}`
  if (c.median < 20) return `${level}: ${rank}. Counts this small vary a lot from year to year.`
  const ratio = c.value / c.median
  return `${level}: ${ratio >= 1 ? `${ratio.toFixed(1)}× the median` : `${Math.round(ratio * 100)}% of the median`}, ${rank}.`
}

export function CurrentCards({ items }: { items: Comparison[] }) {
  return (
    <div className="cards">
      {items.map(c => (
        <div className="card" key={c.label}>
          <div className="card-label">{c.label}</div>
          <div className="card-value">{fmt(c.value)} <small>fire cell-days</small></div>
          <div className="card-ref">
            Median of the same days {c.refYears[0]}–{c.refYears[1]}: <b>{fmt(c.median)}</b>
            {isFinite(c.p10) && <> (usual range {fmt(c.p10)}–{fmt(c.p90)})</>}
          </div>
          <div className="card-verdict">{verdict(c)}</div>
        </div>
      ))}
    </div>
  )
}
