// Methods, validation and limitations, with numbers read from model.json.
// AI-assistance note: drafted with an AI coding assistant (Claude) and reviewed by the author.
import type { Model } from '../lib/data'

const pct = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)}%`

export function Methods({ model }: { model: Model }) {
  const v = model.validation, f = model.factors
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
          unchanged on NOAA-20 and NOAA-21 after MODIS ends. The cost: years before 2012 are modelled from MODIS. They are hatched,
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
        <li><b>No independent ground truth.</b> Every test compares what MODIS predicts with what VIIRS saw. The record has not
          been compared with burned-area maps or ground reports.</li>
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
