// World view: the same method on a coarser grid (0.5 degree, monthly), for any country or drawn area.
// AI-assistance note: drafted with an AI coding assistant (Claude) and reviewed by the author.
import { useEffect, useMemo, useRef, useState } from 'react'
import { climatology, meanYearly } from '../lib/aggregate'
import { download, seriesCsv, svgToPng } from '../lib/csv'
import { areaLabel, areaMask, type Area } from '../lib/geo'
import { loadWorld, worldPeriods, type World as WorldData } from '../lib/world'
import { AnnualChart, AnnualLegend } from './AnnualChart'
import { Calendar, CalendarLegend, calendarMax, MODE_LABEL, type Mode } from './Calendar'
import { MapView, MERC_LAT, type DrawMode } from './MapView'
import { fire, FIRE_STOPS } from '../lib/colors'

const WORLD_BOUNDS: [number, number, number, number] = [-170, -55, 180, 75]
const PRESETS: { label: string; area?: Area; countries?: string[] }[] = [
  { label: 'Central Asia', countries: ['Kazakhstan', 'Kyrgyzstan', 'Uzbekistan', 'Tajikistan', 'Turkmenistan'] },
  { label: 'Amazon basin', area: { kind: 'box', west: -75, south: -15, east: -48, north: 3 } },
  { label: 'Southern Africa', area: { kind: 'box', west: 10, south: -28, east: 41, north: -5 } },
  { label: 'Mainland Southeast Asia', area: { kind: 'box', west: 92, south: 9, east: 110, north: 26 } },
]
const times = (v: number) => (Number.isFinite(v) && v > 0 ? `×${v >= 10 ? v.toFixed(0) : v.toFixed(1)}` : '–')
const MODEL_NAME: Record<string, string> = { naive: 'Untreated (MODIS as is)', global: 'One global factor', tile: 'Factor per 3° tile', tile_month: 'Factor per tile and month' }

export function World({ area, onArea }: { area: Area; onArea: (a: Area) => void }) {
  const [data, setData] = useState<WorldData | null>(null)
  const [error, setError] = useState('')
  const [mode, setMode] = useState<Mode>('harm')
  const [drawMode, setDrawMode] = useState<DrawMode>('none')
  const [bbox, setBbox] = useState({ west: '10', south: '-28', east: '41', north: '-5' })
  const [month, setMonth] = useState<string | null>(null)   // calendar month shown on the map; none = recent yearly mean
  const calRef = useRef<SVGSVGElement>(null), annRef = useRef<SVGSVGElement>(null)

  useEffect(() => { loadWorld().then(setData).catch(e => setError(String(e))) }, [])

  const view = useMemo(() => {
    if (!data) return null
    const { months, years, cellsUsed } = worldPeriods(data, areaMask(area, data.cells.lat, data.cells.lon, data.cells.r))
    const last = years[years.length - 1].year
    const full = years.filter(y => !y.partial)
    const y = (yr: number) => full.find(p => p.year === yr)
    const a = y(2011), b = y(2012)
    const early = meanYearly(full, 2003, 2007), late = meanYearly(full, last - 4, last)
    return { months, years, cellsUsed, clim: climatology(months, last + 1), max: calendarMax(months), last,
             jump: a && b && a.modis > 0 && a.harm > 0 ? { naive: b.vnp / a.modis, modis: b.modis / a.modis, harm: b.harm / a.harm } : null,
             change: late.harm > 0 && late.naive > 0 ? { harm: early.harm / late.harm, naive: early.naive / late.naive, late: [last - 4, last] } : null,
             small: late.harm < 1000 }
  }, [data, area])

  // the map shows where it burns: harmonized fire cell-days per 0.5-degree cell, either one month or the
  // yearly mean of the last five full years, drawn as one Web Mercator image (fast, and it sits under the labels)
  const lastYear = view?.last
  const fireMap = useMemo(() => {
    if (!data || lastYear === undefined) return null
    const { cells, model } = data
    const res = model.grid.res_deg, nx = Math.round(360 / res), ny = Math.round(180 / res)
    const k = month ? model.months.findIndex(mm => mm.key === month) : -1
    const first = model.months.findIndex(mm => mm.key === `${lastYear - 4}-01`)
    const grid = new Float32Array(nx * ny)
    for (let i = 0; i < cells.n; i++) {
      const ok = k >= 0 ? cells.ym[i] === k : cells.ym[i] >= first
      if (!ok || cells.h[i] <= 0) continue
      const gi = Math.floor((cells.lat[i] + 90) / res), gj = Math.floor((((cells.lon[i] + 180) % 360) + 360) % 360 / res)
      if (gi >= 0 && gi < ny && gj >= 0 && gj < nx) grid[gi * nx + gj] += cells.h[i] / (k >= 0 ? 1 : 5)
    }
    const vals = Array.from(grid.filter(v => v > 0)).sort((a, b) => a - b)
    const top = vals.length ? vals[Math.floor(0.99 * (vals.length - 1))] : 1
    // colour lookup table, 256 steps on the same log scale as the legend
    const lut = Array.from({ length: 256 }, (_, t) => fire(Math.expm1((t / 255) * Math.log1p(top)), top).match(/\d+/g)!.map(Number))
    const H = 2048, ymax = Math.log(Math.tan(Math.PI / 4 + (MERC_LAT * Math.PI) / 360))
    const canvas = document.createElement('canvas'); canvas.width = nx; canvas.height = H
    const ctx = canvas.getContext('2d')!, img = ctx.createImageData(nx, H)
    for (let row = 0; row < H; row++) {
      const y = ymax - ((row + 0.5) / H) * 2 * ymax
      const lat = (Math.atan(Math.sinh(y)) * 180) / Math.PI
      const gi = Math.floor((lat + 90) / res)
      for (let col = 0; col < nx; col++) {
        const v = grid[gi * nx + col]
        if (v <= 0) continue
        const c = lut[Math.min(255, Math.round((Math.log1p(Math.min(v, top)) / Math.log1p(top)) * 255))], o = (row * nx + col) * 4
        img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255
      }
    }
    ctx.putImageData(img, 0, 0)
    return { image: canvas.toDataURL('image/png'), top, label: month ?? `${lastYear - 4}–${lastYear}, yearly mean`, per: month ? 'month' : 'year' }
  }, [data, lastYear, month])

  if (error) return <p className="warn">Could not load the world layer: {error}</p>
  if (!data || !view) return <p className="status">Loading the world layer: 25 years of fire for every country (about 25 MB, a few seconds on a fast connection)…</p>

  const { model } = data
  const val = model.validation
  const byName = (name: string) => model.countries.find(c => c.en === name)?.id
  const label = area.kind === 'country' ? 'The whole world' : areaLabel(area, id => model.countries[id]?.en ?? '?')
  const sorted = [...model.countries].sort((p, q) => p.en.localeCompare(q.en))
  const pick = (id: number, add: boolean) => {
    if (add && area.kind === 'regions') {
      const ids = area.ids.includes(id) ? area.ids.filter(i => i !== id) : [...area.ids, id]
      onArea(ids.length ? { kind: 'regions', ids } : { kind: 'country' })
    } else onArea({ kind: 'regions', ids: [id] })
  }
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const chosen = val.loyo[val.chosen_model], naive = val.loyo.naive

  return (
    <>
    <section className="panel intro-world">
        <b>World view.</b> The same method, nothing retuned, run on NASA FIRMS standard data for every country,
        {' '}{model.source.years[0]}–{model.source.years[1]}: months on a {model.grid.res_deg}° grid. Tested by leaving each year of
        {' '}{val.years_tested[0]}–{val.years_tested[1]} out: yearly world totals within <b>{chosen.global_median_abs_pct}%</b>,
        a 3° tile within <b>{chosen.tile_median_abs_pct}%</b> (untreated: {naive.global_median_abs_pct}% and {naive.tile_median_abs_pct}%).
        Days, weeks, regions and the current season are in the Kazakhstan view.
    </section>
    <main>

      <section className="panel area">
        <h2>1. Choose an area</h2>
        <label>Country
          <select value={area.kind === 'regions' && area.ids.length === 1 ? String(area.ids[0]) : area.kind === 'country' ? 'world' : ''}
                  onChange={e => onArea(e.target.value === 'world' ? { kind: 'country' } : { kind: 'regions', ids: [Number(e.target.value)] })}>
            <option value="world">The whole world</option>
            {area.kind !== 'country' && !(area.kind === 'regions' && area.ids.length === 1) && <option value="">{label}</option>}
            {sorted.map(c => <option key={c.id} value={c.id}>{c.en}</option>)}
          </select>
        </label>
        <div className="row">
          {PRESETS.map(p => (
            <button key={p.label} onClick={() => onArea(p.area ?? { kind: 'regions', ids: p.countries!.map(byName).filter((i): i is number => i !== undefined) })}>{p.label}</button>
          ))}
        </div>
        <div className="row">
          <button className={drawMode === 'box' ? 'on' : ''} onClick={() => setDrawMode(drawMode === 'box' ? 'none' : 'box')}>Draw a box</button>
          <button className={drawMode === 'polygon' ? 'on' : ''} onClick={() => setDrawMode(drawMode === 'polygon' ? 'none' : 'polygon')}>Draw a polygon</button>
          <button onClick={() => { onArea({ kind: 'country' }); setDrawMode('none') }}>Reset</button>
        </div>
        {drawMode !== 'none' && <p className="hint">{drawMode === 'box' ? 'Click two opposite corners on the map.' : 'Click to add points, double-click to finish.'}</p>}
        <details>
          <summary>Enter coordinates</summary>
          <form className="coords" onSubmit={e => { e.preventDefault(); onArea({ kind: 'box', west: +bbox.west, south: +bbox.south, east: +bbox.east, north: +bbox.north }) }}>
            <span>Box:</span>
            {(['west', 'south', 'east', 'north'] as const).map(k => (
              <input key={k} aria-label={k} title={k} value={bbox[k]} onChange={e => setBbox({ ...bbox, [k]: e.target.value })} />
            ))}
            <button type="submit">Apply</button>
          </form>
        </details>
        <p className="selected">Selected: <b>{label}</b>. Shift-click countries on the map to combine them.</p>
        {view.small && <p className="warn">Little fire in this area: values, especially before 2012, are indicative only. Areas smaller than a few grid cells ({model.grid.res_deg}° is about {Math.round(model.grid.res_deg * 111)} km) are too small for this view.</p>}
      </section>

      <section className="panel mapbox">
        <MapView regions={data.countries} area={area} hotspots={[]} staticMask={null} drawMode={drawMode} bounds={WORLD_BOUNDS}
                 image={fireMap?.image}
                 attribution="Fire data: NASA FIRMS · Countries: Natural Earth"
                 onDrawDone={a => { onArea(a); setDrawMode('none') }} onRegionClick={pick} />
        <div className="legend">
          <span className="ramp"><span>Harmonized fire cell-days per {model.grid.res_deg}° cell and {fireMap?.per}, {fireMap?.label}: few</span>
            {FIRE_STOPS.map(c => <i key={c} style={{ background: c }} />)}<span>{Math.round(fireMap?.top ?? 0).toLocaleString('en-US')}+</span></span>
          {month && <button onClick={() => setMonth(null)}>Back to the yearly mean</button>}
        </div>
        <div className="row small"><span>Click a country, or draw an area. Click a month in the calendar to map it.</span></div>
      </section>

      <section className="panel">
        <h2>2. What harmonizing changes here</h2>
        <div className="cards">
          <div className="card">
            <div className="card-label">The 2012 jump (2012 against 2011)</div>
            {view.jump ? <>
              <div className="card-value">{times(view.jump.naive)} <small>untreated</small> → {times(view.jump.harm)} <small>harmonized</small></div>
              <div className="card-ref">MODIS alone, which flew both years, saw {times(view.jump.modis)}.</div>
            </> : <div className="card-ref">Not enough fire in 2011 to say.</div>}
          </div>
          <div className="card">
            <div className="card-label">Fire in 2003–2007 against {view.change ? `${view.change.late[0]}–${view.change.late[1]}` : 'recent years'}</div>
            {view.change ? <>
              <div className="card-value">{times(view.change.harm)} <small>harmonized</small></div>
              <div className="card-ref">The untreated record says {times(view.change.naive)}. Above ×1 means less fire now.</div>
            </> : <div className="card-ref">Not enough fire to say.</div>}
          </div>
        </div>
      </section>

      <section className="panel">
        <h2>3. Burning calendar, {model.source.years[0]}–{model.source.years[1]}</h2>
        <div className="row modes" role="radiogroup" aria-label="Calendar values">
          {(Object.keys(MODE_LABEL) as Mode[]).map(k => (
            <button key={k} role="radio" aria-checked={mode === k} className={mode === k ? 'on' : ''} onClick={() => setMode(k)}>{MODE_LABEL[k]}</button>
          ))}
        </div>
        <div className="scroll"><Calendar ref={calRef} months={view.months} clim={view.clim} mode={mode} selected={month} onSelect={k => setMonth(k === month ? null : k)} /></div>
        <CalendarLegend mode={mode} max={view.max} />
        <details className="help"><summary>What am I looking at?</summary>
          One cell per month, in fire cell-days: 0.01° cells with at least one clean detection on a day, summed over the area.
          "Harmonized" puts the MODIS years on the VIIRS (Suomi NPP) scale; months above the dashed line are modelled from MODIS.
          "Naive splice" shows the record as it comes: MODIS until 2011, VIIRS from 2012. "Anomaly" compares each month with the
          median of the same calendar month in all years.
        </details>
      </section>

      <section className="panel">
        <h2>4. Fire activity per year</h2>
        <AnnualChart ref={annRef} years={view.years} />
        <AnnualLegend />
      </section>

      <section className="panel">
        <h2>5. How well the method works around the world</h2>
        <p>Each year of {val.years_tested[0]}–{val.years_tested[1]} was predicted from MODIS with factors fitted on the other years, then
          compared with what Suomi NPP saw. Median error of yearly totals, in percent; {val.tiles_tested.toLocaleString('en-US')} tiles tested.</p>
        <div className="tablewrap">
          <table className="topdays">
            <thead><tr><th>Region</th><th>Untreated</th><th>One global factor</th><th>Factor per 3° tile</th><th>Per tile and month</th><th>Bias of the model used</th></tr></thead>
            <tbody>
              {val.by_region.map(r => (
                <tr key={r.region}><td>{r.region}</td><td>{r.naive}%</td><td>{r.global}%</td><td>{r.tile}%</td><td>{r.tile_month}%</td>
                  <td>{r.bias_chosen_pct > 0 ? '+' : ''}{r.bias_chosen_pct}%</td></tr>
              ))}
              <tr className="on"><td>World total</td>{['naive', 'global', 'tile', 'tile_month'].map(k => <td key={k}>{val.loyo[k].global_median_abs_pct}%</td>)}<td /></tr>
              <tr className="on"><td>A single 3° tile, one year</td>{['naive', 'global', 'tile', 'tile_month'].map(k => <td key={k}>{val.loyo[k].tile_median_abs_pct}%</td>)}<td /></tr>
              <tr className="on"><td>A single 3° tile, one month</td>{['naive', 'global', 'tile', 'tile_month'].map(k => <td key={k}>{val.loyo[k].tile_month_median_abs_pct}%</td>)}<td /></tr>
            </tbody>
          </table>
        </div>
        <p className="small">Model used for the record: <b>{MODEL_NAME[val.chosen_model]}</b>. Global MODIS-to-VIIRS factor {model.factors.modis_to_vnp_global};
          tile factors from {model.factors.tile_p10} to {model.factors.tile_p90} (10th–90th percentile of {model.factors.tiles.toLocaleString('en-US')} tiles).
          Limits of this view: whole-day satellite outages only; no regional outages; no near-real-time data; a cell on a border can be counted twice;
          before 2012 the factors are an assumption that cannot be checked.</p>
      </section>

      <section className="panel">
        <h2>6. Download</h2>
        <div className="row">
          <button onClick={() => download(`dala-fire_world_${slug}_monthly.csv`, seriesCsv(view.months, label, model.data_through))}>Monthly series (CSV)</button>
          <button onClick={() => download(`dala-fire_world_${slug}_yearly.csv`, seriesCsv(view.years, label, model.data_through))}>Yearly series (CSV)</button>
          <button onClick={() => calRef.current && svgToPng(calRef.current, `dala-fire_world_${slug}_calendar.png`)}>Calendar (PNG)</button>
          <button onClick={() => annRef.current && svgToPng(annRef.current, `dala-fire_world_${slug}_yearly.png`)}>Yearly chart (PNG)</button>
        </div>
      </section>
    </main>
    </>
  )
}
