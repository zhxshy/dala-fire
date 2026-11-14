// Methods, validation and limitations, with numbers read from model.json.
// AI-assistance note: drafted with an AI coding assistant (Claude) and reviewed by the author.
import { useEffect, useState } from 'react'
import { DATA_URL, type Model } from '../lib/data'

interface BaUnit {
  unit: string; burned_km2_per_year: number; decline_burned_area: number; decline_harmonized: number; decline_naive: number
  seam_step_harmonized: number | null; seam_step_naive: number | null; seam_step_modis_alone: number | null
  corr_harmonized: number | null; corr_naive: number | null
}
interface BaCheck { years: number[]; early: [number, number]; late: [number, number]; before: [number, number]; after: [number, number]; units: BaUnit[] }
const x2 = (v: number | null) => (v === null ? '–' : `${v.toFixed(2)}×`)
const r2 = (v: number | null) => (v === null ? '–' : v.toFixed(2))

const pct = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)}%`

export function Methods({ model }: { model: Model }) {
  const v = model.validation, f = model.factors
  const [ba, setBa] = useState<BaCheck | null>(null)
  useEffect(() => {
    fetch(`${DATA_URL}burned_area_check.json`).then(r => (r.ok ? r.json() : null)).then(d => setBa(d?.units ? d : null)).catch(() => setBa(null))
  }, [])
  const baShown = ba ? ['Kazakhstan', 'World', ...ba.units.map(u => u.unit).filter(u => u.startsWith('World: ')),
                        ...ba.units.map(u => u.unit).filter(u => u.startsWith('KZ: '))]
    .map(n => ba.units.find(u => u.unit === n)!).filter(Boolean) : []
  return (
    <article className="methods">
      <h2>How Dala Fire builds one fire record from two sensors</h2>
      <p>
        MODIS (Terra and Aqua, 1 km pixels, since 2000) and VIIRS (S-NPP since 2012, NOAA-20, NOAA-21; 375 m pixels) both
        detect active fires, but VIIRS sees many more small fires. Splicing the two records naively creates a false jump in
        2012: in Kazakhstan fire activity appears to grow {v.seam_2011_to_2012_ratio.naive_splice}× from 2011 to 2012, while MODIS
        alone grows {v.seam_2011_to_2012_ratio.modis_only}×. Dala Fire puts both sensors on one scale so that the sensor no longer
        matters.
      </p>

      <h3>Method</h3>
      <ol>
        <li><b>Clean.</b> MODIS confidence ≥ 30; VIIRS nominal or high confidence; FIRMS type 0 (vegetation fire). Cells with
          repeated static-source detections (gas flares, industry, offshore platforms) are masked for all rows, including
          near-real-time rows that carry no type.</li>
        <li><b>Count fire cell-days.</b> A 0.01° cell (about 1 km) with at least one detection on a day counts once. Several
          375 m VIIRS pixels of one fire fall in the same cell, which removes most of the pixel-size difference.</li>
        <li><b>Find days without data.</b> Days on which a satellite delivered nothing are flagged per sensor and shown as
          "no data", never as zero.</li>
        <li><b>Calibrate.</b> On {f.calibration_days.toLocaleString('en-US')} days when Terra, Aqua and S-NPP all delivered data
          ({f.calibration_window[0]} to {f.calibration_window[1]}), the ratio of VIIRS to MODIS fire cell-days is fitted per
          {' '}{f.tile_deg}° tile and shrunk toward the national ratio ({f.modis_to_vnp_national.toFixed(3)}) where data is thin.</li>
        <li><b>Bridge gaps.</b> Days with one MODIS satellite only (including Terra-only years 2000–2002) use bridge factors
          fitted on 2003–2011 (Terra ×{f.terra_bridge.toFixed(3)}, Aqua ×{f.aqua_bridge.toFixed(3)}). Days without S-NPP use NOAA-20
          (×{f.vj1_to_vnp.toFixed(3)}) or NOAA-21 (×{f.vj2_to_vnp.toFixed(3)}); S-NPP stopped delivering data on 2 November 2026.</li>
        <li><b>Add up.</b> The model is a sum over cells, so the value for any region, box or drawn polygon is exact and
          computed in your browser.</li>
      </ol>

      <h3>Validation</h3>
      <p>Each year 2012–2021 was left out in turn: factors were refitted without it, and the year's VIIRS record was predicted
        from MODIS alone. Error of annual totals:</p>
      <table>
        <thead><tr><th>Model</th><th>Country, median</th><th>Country, max</th><th>3° tile, median</th><th>3° tile, 90th pct</th></tr></thead>
        <tbody>
          {Object.entries(v.loyo_2012_2021).map(([name, r]) => (
            <tr key={name} className={name.includes('shrinkage 200') && !name.includes('season') ? 'chosen' : ''}>
              <td>{name[0].toUpperCase() + name.slice(1)}{name.includes('shrinkage 200') && !name.includes('season') ? ' (used)' : ''}</td>
              <td>{r.national_median_abs_pct.toFixed(1)}%</td><td>{r.national_max_abs_pct.toFixed(1)}%</td>
              <td>{r.tile_median_abs_pct.toFixed(1)}%</td><td>{r.tile_p90_abs_pct.toFixed(1)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul>
        {v.ratio_by_year && (
          <li><b>The ratio does not depend on how much burns:</b> fitted on each calibration year separately, the national
            VIIRS-to-MODIS ratio stays between {Math.min(...Object.values(v.ratio_by_year.ratio)).toFixed(2)} and
            {' '}{Math.max(...Object.values(v.ratio_by_year.ratio)).toFixed(2)} ({Object.entries(v.ratio_by_year.ratio).map(([y, r]) => `${y}: ${r.toFixed(2)}`).join(', ')}),
            while fire activity itself differed {v.ratio_by_year.fire_max_over_min}× between those years. This is the main reason to
            trust one set of factors for years with much more fire, such as the 2000s.</li>
        )}
        {v.decline_single_sensor && (
          <li><b>The decline is in each sensor on its own:</b> MODIS alone, never rescaled, shows
            {' '}{v.decline_single_sensor.modis_2001_2005_to_2021_2025.toFixed(1)}× less fire in 2021–2025 than in 2001–2005 (harmonized record:
            {' '}{v.decline_single_sensor.harmonized_2001_2005_to_2021_2025.toFixed(1)}×). VIIRS alone shows {v.decline_single_sensor.viirs_2012_2014_to_2021_2025.toFixed(1)}× less
            in 2021–2025 than in 2012–2014. Harmonization does not create the decline; it lets the two periods be read on one scale.</li>
        )}
        <li><b>Across the seam:</b> fitted on 2014–2021 only, the model predicts 2012 at {pct(v.backcast_2012_2013_pct['2012'])} and
          2013 at {pct(v.backcast_2012_2013_pct['2013'])}.</li>
        <li><b>Orbit drift:</b> Terra and Aqua drifted in their last years. Fitted on 2012–2021, the model errs by
          {' '}{Object.entries(v.drift_2022_2025_pct).map(([y, e]) => `${pct(e)} (${y})`).join(', ')}, so after 2021 MODIS is used
          only on days without VIIRS.</li>
        <li><b>Seasons</b> did not improve the model and are not used.</li>
        <li><b>Sensitivity:</b> changing one choice at a time (no confidence filter, stricter MODIS confidence, mask without
          dilation or no mask, 0.005° or 0.02° cells, 2° or 5° tiles, shrinkage 0 to 1000, separate day and night factors) keeps
          the country error between 2.1% and 3.9% and the 2000s-to-2020s decline between 4.9× and 5.3×. The static-source mask matters most: without it the
          tile error rises from 7.6% to 8.8%. Separate day and night factors made every measure worse, so they are not used. Full table: <code>scripts/07_sensitivity.py</code> and the README.</li>
      </ul>

      {v.check_by_region && <>
        <h3>Region by region</h3>
        <p>The same question for every region: on calibration days in 2012–2021, how close is MODIS × factors to what VIIRS saw,
          year by year? The app shows this check for any area you select. The factors were fitted on these years for whole
          3° tiles, so this is a fit check, not a blind test like the table above.</p>
        <div className="tablewrap"><table>
          <thead><tr><th>Region</th><th>VIIRS fire cell-days</th><th>Yearly totals, median difference</th><th>Worst year</th><th>All years together</th></tr></thead>
          <tbody>
            {v.check_by_region.map(r => (
              <tr key={r.region}>
                <td>{r.region}</td><td>{r.viirs_celldays.toLocaleString('en-US')}</td>
                <td>{r.median_abs_pct === null ? 'too little fire' : `${r.median_abs_pct.toFixed(1)}%`}</td>
                <td>{r.worst_abs_pct === null ? '–' : `${r.worst_abs_pct.toFixed(1)}%`}</td>
                <td>{pct(r.bias_pct)}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
        <p>The method fails where fire is rare and comes from small steady heat sources: in Mangystau (oil and gas fields) and
          in the cities MODIS sees about a third of what VIIRS sees, and one factor per tile cannot repair that. Values before
          2012 are too low there.</p>
      </>}

      {ba && <>
        <h3>Against an independent product: burned area</h3>
        <p>MODIS burned area (MCD64, Collection 6.1) maps the burn scar from surface reflectance, not the heat of the fire.
          It is one MODIS product throughout, so it has no 2012 seam. Three questions: does burning fall as much as the
          harmonized record says ({ba.early[0]}–{ba.early[1]} against {ba.late[0]}–{ba.late[1]}, the last full years of burned
          area)? Does fire per km² burned stay level across the 2012 switch ({ba.after[0]}–{ba.after[1]} against
          {' '}{ba.before[0]}–{ba.before[1]})? Do the yearly totals rise and fall together? Nothing here was used to fit the method.</p>
        <div className="tablewrap"><table>
          <thead><tr><th>Area</th><th>Burned area: times less now</th><th>Harmonized</th><th>Naive splice</th>
            <th>2012 step, harmonized</th><th>2012 step, naive</th><th>Correlation, harmonized</th><th>Correlation, naive</th></tr></thead>
          <tbody>
            {baShown.map(u => (
              <tr key={u.unit} className={u.unit === 'Kazakhstan' || u.unit === 'World' ? 'chosen' : ''}>
                <td>{u.unit.replace(/^KZ: /, 'Kazakhstan: ').replace(/^World: /, 'World: ')}</td>
                <td>{x2(u.decline_burned_area)}</td><td>{x2(u.decline_harmonized)}</td><td>{x2(u.decline_naive)}</td>
                <td>{x2(u.seam_step_harmonized)}</td><td>{x2(u.seam_step_naive)}</td>
                <td>{r2(u.corr_harmonized)}</td><td>{r2(u.corr_naive)}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
        <p>In 27 of 28 areas the harmonized decline is closer to the burned-area decline than the naive one; in every area the
          harmonized 2012 step stays within 0.11 of the step MODIS alone shows, while the naive step is 1.8 to 4.7 times that. The
          exception is Kyzylorda, where burned area grew while hot spots fell. Limits: burned area uses MODIS active fires as
          one of its inputs, so before 2012 the check is not fully independent; after 2012 the harmonized record is VIIRS
          alone. Burned area and hot spots measure different things, so their ratio can drift for real reasons.</p>
      </>}

      <h3>Uncertainty for any area</h3>
      <p>Modelled values (before VIIRS) carry a band: the 10th–90th percentile of observed / predicted in the left-out years,
        for areas and periods of the same predicted size.</p>
      <table>
        <thead><tr><th>Predicted fire cell-days</th><th>Cases</th><th>p10</th><th>median</th><th>p90</th></tr></thead>
        <tbody>
          {v.error_vs_size.map(b => (
            <tr key={b.size}><td>{b.size}</td><td>{b.n.toLocaleString('en-US')}</td><td>{b.p10.toFixed(2)}</td><td>{b.p50.toFixed(2)}</td><td>{b.p90.toFixed(2)}</td></tr>
          ))}
        </tbody>
      </table>

      <h3>Design questions</h3>
      <p>Questions raised by participants in the challenge discussion (<a href="https://github.com/nasa/spaceapps/discussions/1879" target="_blank" rel="noreferrer">nasa/spaceapps #1879</a>), and how Dala Fire answers them.</p>
      <ul>
        <li><b>MODIS or VIIRS scale?</b> VIIRS (Suomi NPP). It is the scale of today’s and future fire data, so the record continues
          unchanged on NOAA-20 and NOAA-21 after MODIS ends. The cost: years before 2012 are modelled from MODIS. They are marked,
          carry an uncertainty band, and cannot show small fires MODIS never saw.</li>
        <li><b>FIRMS archive or swath products?</b> The FIRMS Archive Download (standard data, near-real-time only after the last
          standard date), with the filters listed above. Cloud cover and view angle are not modelled (see Limitations).</li>
        <li><b>Continuity after Suomi NPP?</b> Built in. Suomi NPP’s last day in our data is 2 November 2026. NOAA-20 (×0.998) and
          NOAA-21 (×1.035) are tied to its scale on the days all flew; they share its afternoon orbit, so no overpass-time trend is
          introduced.</li>
        <li><b>Users and time step?</b> Values are stored per day and shown by month (calendar), by week (fire season, critical
          periods) and by day (biggest fire days). Emergency services get “this month vs history” and the next four weeks;
          land and agriculture managers get the burning seasons of their region; scientists get the method, validation and CSV.</li>
        <li><b>Earth Engine?</b> Not used. Everything is built from FIRMS files by open Python scripts anyone can rerun.</li>
      </ul>

      <h3>What we cannot claim</h3>
      <ul>
        <li><b>Before 2012 there is no VIIRS to check against.</b> The factors assume that each tile’s VIIRS-to-MODIS ratio of
          2012–2021 also held in 2000–2011. That cannot be measured. The backcast tests it on two years only (2012 and 2013).
          If small fires were more common in the 2000s, the true ratio then was higher and our early values are too low.</li>
        <li><b>These are satellite hot spots, not registered fires.</b> A fire cell-day is a ~1 km cell where a satellite saw
          heat on a day. Official counts of fire incidents follow reporting rules, include fires too small or too short for a
          satellite, and can rise while hot spots fall.</li>
        <li><b>No ground truth.</b> Most tests compare what MODIS predicts with what VIIRS saw. The one independent product,
          MODIS burned area, agrees with the harmonized decline but is partly built from MODIS active fires. The record has not
          been compared with ground reports.</li>
        <li><b>The record shows when and where burning changed, not why.</b> The explanations for the decline (grazing, farming,
          wetter years) come from published studies, not from this data.</li>
        <li><b>Single days and weeks before 2012 are less certain than months and years.</b> The uncertainty bands were measured
          on monthly and yearly totals. Before July 2002 only Terra flew, with a morning overpass only.</li>
        <li><b>“Next 4 weeks” is a seasonal expectation, not a forecast.</b> It uses no weather.</li>
        <li><b>Fire power (FRP) is not harmonized.</b> Only the amount of detected burning is.</li>
      </ul>

      <h3>Limitations</h3>
      <ul>
        <li>The model cannot create fire where MODIS saw none. In 0.25° cells by month, {v.share_of_viirs_where_modis_zero_pct['0.25']}% of
          VIIRS activity falls where MODIS saw nothing ({v.share_of_viirs_where_modis_zero_pct['1']}% at 1°). Small areas before 2012
          are marked indicative.</li>
        <li>Fire cell-days count detected burning, not burned area or emissions.</li>
        <li>Clouds, smoke and overpass timing hide some fires from both sensors; view-angle (off-nadir) effects are absorbed by
          the tile factors, not modelled separately.</li>
        <li>Data gaps are inferred from the detections themselves (whole-day, country-wide outages only) and cross-checked with the FIRMS <code>missing_data</code> list: 127 of its 178 days were already flagged, 13 more were added, and 38 were kept because our archive holds complete data for them.</li>
        <li>The static-source mask also removes about 3.8% of vegetation-fire detections that fall next to flares.</li>
      </ul>

      <h3>Data and credits</h3>
      <ul>
        <li>Active fires: NASA Fire Information for Resource Management System (FIRMS), MODIS Collection 6.1 and VIIRS 375 m
          Collection 2 (S-NPP, NOAA-20, NOAA-21), Archive Download for Kazakhstan, data through {model.data_through}.{' '}
          <a href="https://firms.modaps.eosdis.nasa.gov" target="_blank" rel="noreferrer">firms.modaps.eosdis.nasa.gov</a></li>
        <li>Region boundaries: © OpenStreetMap contributors, ODbL. Basemap: OpenFreeMap, © OpenMapTiles.</li>
        <li>Code: open source, MIT licence. AI tools (Claude) were used for research, planning and drafting code; every
          AI-drafted file says so.</li>
      </ul>
    </article>
  )
}
