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

      <h3>Limitations</h3>
      <ul>
        <li>The model cannot create fire where MODIS saw none. In 0.25° cells by month, {v.share_of_viirs_where_modis_zero_pct['0.25']}% of
          VIIRS activity falls where MODIS saw nothing ({v.share_of_viirs_where_modis_zero_pct['1']}% at 1°). Small areas before 2012
          are marked indicative.</li>
        <li>Fire cell-days count detected burning, not burned area or emissions.</li>
        <li>Clouds, smoke and overpass timing hide some fires from both sensors.</li>
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
