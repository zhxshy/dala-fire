// First-screen story: why the record needs harmonizing, what Dala Fire does, and what the result shows.
// AI-assistance note: drafted with an AI coding assistant (Claude) and reviewed by the author.
import type { Model } from '../lib/data'

interface Props {
  model: Model
  decline: { harm: number; naive: number } | null   // 2001-2005 mean / last five full years, whole country
  onShowJump: () => void; onShowFixed: () => void; onShowExample: () => void; onMethods: () => void; onHide: () => void
}

export function Intro({ model, decline, onShowJump, onShowFixed, onShowExample, onMethods, onHide }: Props) {
  const seam = model.validation.seam_2011_to_2012_ratio
  const loyo = model.validation.loyo_2012_2021
  const ours = loyo['3-deg tiles, shrinkage 200'].national_median_abs_pct, naive = loyo['naive (no correction)'].national_median_abs_pct
  return (
    <section className="intro" aria-label="Why this record exists">
      <button className="intro-hide" onClick={onHide} aria-label="Hide the introduction">Hide</button>
      <div className="intro-steps">
        <div className="intro-step">
          <div className="intro-num">1 · The problem</div>
          <p><b>The satellite record breaks in 2012.</b> VIIRS (375 m) reports about twice as much fire as MODIS (1 km) for the
            same burning. Joined as they are, Kazakhstan’s record jumps <b>×{seam.naive_splice.toFixed(1)}</b> from 2011 to 2012;
            MODIS alone saw ×{seam.modis_only.toFixed(1)}.</p>
          <button onClick={onShowJump}>Show the jump</button>
        </div>
        <div className="intro-step">
          <div className="intro-num">2 · The fix</div>
          <p><b>Every year on one scale.</b> MODIS years are converted to the VIIRS scale with factors learned on 3,619 days when
            both flew. The jump becomes ×{seam.harmonized.toFixed(1)}, and yearly totals test within <b>{ours.toFixed(1)}%</b>
            {' '}(untreated: {naive.toFixed(1)}%).</p>
          <button onClick={onShowFixed}>Show it fixed</button> <button onClick={onMethods}>How it was tested</button>
        </div>
        <div className="intro-step">
          <div className="intro-num">3 · What it shows</div>
          <p><b>{decline ? `Fire fell ${decline.harm.toFixed(1)}× since 2001–2005` : 'Fire fell sharply since 2001–2005'}</b>
            {decline ? `; the untreated record shows only ${decline.naive.toFixed(1)}×.` : '.'} Pick any area below to see its
            fire seasons, critical periods and whether this month is unusual.</p>
          <button onClick={onShowExample}>Example: Kostanay, 3 Sept 2022</button>
        </div>
      </div>
    </section>
  )
}
