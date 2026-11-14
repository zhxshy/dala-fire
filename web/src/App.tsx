// Dala Fire web app: pick an area, see its harmonized burning calendar since 2000.
// AI-assistance note: drafted with an AI coding assistant (Claude) and reviewed by the author.
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  buildCalendar, climatology, criticalPeriods, currentComparisons, dailySeries, monthlyPeriods, MONTHS, outlook, seasonalProfile,
  topDays, weekLabel, yearlyPeriods,
} from './lib/aggregate'
import { download, hotspotsCsv, seriesCsv, svgToPng } from './lib/csv'
import {
  loadCellDays, loadDays, loadHotspots, loadModel, loadRegions, loadStaticMask,
  type CellDays, type Days, type Hotspot, type Model,
} from './lib/data'
import { areaLabel, areaMask, inArea, type Area } from './lib/geo'
import { AnnualChart, AnnualLegend } from './components/AnnualChart'
import { Calendar, CalendarLegend, calendarMax, MODE_LABEL, type Mode } from './components/Calendar'
import { CurrentCards } from './components/CurrentCard'
import { MapView, type DrawMode } from './components/MapView'
import { Methods } from './components/Methods'
import { SeasonChart, SeasonLegend } from './components/SeasonChart'
import { TopDays } from './components/TopDays'

interface Loaded { model: Model; days: Days; regions: GeoJSON.FeatureCollection; cells: CellDays }

const PRESETS: { label: string; regions: string[] }[] = [
  { label: 'Northern grain belt', regions: ['Kostanay Region', 'North Kazakhstan Region', 'Akmola Region'] },
  { label: 'Western oil and gas regions', regions: ['West Kazakhstan Region', 'Atyrau Region', 'Mangystau Region', 'Aqtöbe Region'] },
]
const MAX_DOWNLOAD_YEARS = 5
const fmtN = (v: number) => (Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : '–')

export function App() {
  const [data, setData] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'explore' | 'methods'>('explore')
  const [area, setArea] = useState<Area>({ kind: 'country' })
  const [mode, setMode] = useState<Mode>('harm')
  const [drawMode, setDrawMode] = useState<DrawMode>('none')
  const [selected, setSelected] = useState<string | null>(null)
  const [hotspots, setHotspots] = useState<Hotspot[]>([])
  const [hotspotNote, setHotspotNote] = useState('')
  const [mask, setMask] = useState<[number, number][] | null>(null)
  const [circle, setCircle] = useState({ lat: '53.20', lon: '63.60', km: '50' })
  const [bbox, setBbox] = useState({ west: '62', south: '50', east: '66', north: '54' })
  const [range, setRange] = useState({ from: 2024, to: 2026 })
  const [busy, setBusy] = useState('')
  const [seasonRecent, setSeasonRecent] = useState(false)
  const [topObserved, setTopObserved] = useState(false)
  const calRef = useRef<SVGSVGElement>(null), annRef = useRef<SVGSVGElement>(null), seasonRef = useRef<SVGSVGElement>(null)
  const mapRef = useRef<HTMLElement>(null)

  useEffect(() => {
    (async () => {
      const [model, days, regions] = await Promise.all([loadModel(), loadDays(), loadRegions()])
      const cells = await loadCellDays(model)
      setData({ model, days, regions, cells })
    })().catch(e => setError(String(e)))
  }, [])

  const cal = useMemo(() => (data ? buildCalendar(data.days) : null), [data])
  const regionName = (id: number) => data?.model.regions[id]?.en ?? `#${id}`
  const label = data ? areaLabel(area, regionName) : ''

  const view = useMemo(() => {
    if (!data || !cal) return null
    const m = areaMask(area, data.cells.lat, data.cells.lon, data.cells.r)
    const daily = dailySeries(data.cells, m, cal.nDays)
    const bands = data.model.validation.error_vs_size
    const months = monthlyPeriods(daily, cal, bands)
    const years = yearlyPeriods(daily, cal, bands)
    const ref = years.filter(y => y.year >= 2012 && y.year <= 2021).reduce((a, y) => a + y.harm, 0)
    return { months, years, clim: climatology(months, cal.lastYear), cmp: currentComparisons(daily, cal),
             small: ref < 3000, max: calendarMax(months), season: seasonalProfile(daily, cal, seasonRecent ? cal.lastYear - 10 : 2001),
             critical: criticalPeriods(daily, cal, seasonRecent ? cal.lastYear - 10 : 2001),
             ahead: outlook(daily, cal, seasonRecent ? cal.lastYear - 10 : 2001),
             top: topDays(daily, cal, 10, topObserved ? 2012 : 0) }
  }, [data, cal, area, seasonRecent, topObserved])

  // hotspots of the selected month (YYYY-MM) or day (YYYY-MM-DD), inside the area
  useEffect(() => {
    if (!selected) { setHotspots([]); setHotspotNote(''); return }
    const [y, mo, d] = selected.split('-').map(Number)
    const isDay = selected.length === 10
    let live = true
    setHotspotNote('Loading hotspots…')
    loadHotspots(y).then(rows => {
      if (!live) return
      const hit = rows.filter(h => (isDay ? h.date === selected : h.date.startsWith(`${selected}-`)) && inArea(area, h.lat, h.lon, h.r))
      setHotspots(hit)
      const when = isDay ? `on ${d} ${MONTHS[mo - 1]} ${y}` : `in ${MONTHS[mo - 1]} ${y}`
      setHotspotNote(`${hit.length.toLocaleString('en-US')} clean detections ${when} (orange MODIS, blue VIIRS)`)
    }).catch(e => live && setHotspotNote(`Could not load hotspots: ${e}`))
    return () => { live = false }
  }, [selected, area])

  const pickRegion = (id: number, add: boolean) => {
    setArea(prev => {
      if (add && prev.kind === 'regions') {
        const ids = prev.ids.includes(id) ? prev.ids.filter(i => i !== id) : [...prev.ids, id]
        return ids.length ? { kind: 'regions', ids } : { kind: 'country' }
      }
      return { kind: 'regions', ids: [id] }
    })
  }

  const toggleMask = async () => setMask(mask ? null : await loadStaticMask())

  async function downloadHotspots() {
    if (!data) return
    const from = Math.min(range.from, range.to), to = Math.max(range.from, range.to)
    if (to - from + 1 > MAX_DOWNLOAD_YEARS) { alert(`Pick at most ${MAX_DOWNLOAD_YEARS} years at a time.`); return }
    setBusy('Preparing hotspot CSV…')
    try {
      const rows: Hotspot[] = []
      for (let y = from; y <= to; y++) {
        for (const h of await loadHotspots(y)) if (inArea(area, h.lat, h.lon, h.r)) rows.push(h)
      }
      download(`dala-fire_hotspots_${from}-${to}.csv`, hotspotsCsv(rows, label))
    } finally { setBusy('') }
  }

  if (error) return <div className="status error">Could not load the data: {error}</div>
  if (!data || !cal || !view) return <div className="status">Loading 26 years of NASA fire data for Kazakhstan…</div>

  const firstYear = cal.year[0], lastYear = cal.lastYear
  const yearOptions = Array.from({ length: lastYear - firstYear + 1 }, (_, i) => firstYear + i)

  return (
    <div className="app">
      <header>
        <div>
          <h1>Dala Fire</h1>
          <p className="tagline">One satellite fire record for Kazakhstan, 2000 to today: NASA MODIS and VIIRS harmonized onto one scale.</p>
        </div>
        <nav>
          <button className={tab === 'explore' ? 'on' : ''} onClick={() => setTab('explore')}>Explore</button>
          <button className={tab === 'methods' ? 'on' : ''} onClick={() => setTab('methods')}>Methods &amp; validation</button>
          <span className="through">Data through {data.model.data_through}</span>
        </nav>
      </header>

      {tab === 'methods' ? <Methods model={data.model} /> : (
        <main>
          <section className="panel area">
            <h2>1. Choose an area</h2>
            <label>Region
              <select value={area.kind === 'regions' && area.ids.length === 1 ? String(area.ids[0]) : area.kind === 'country' ? 'country' : ''}
                      onChange={e => setArea(e.target.value === 'country' ? { kind: 'country' } : { kind: 'regions', ids: [Number(e.target.value)] })}>
                <option value="country">Whole Kazakhstan</option>
                {area.kind !== 'country' && !(area.kind === 'regions' && area.ids.length === 1) && <option value="">{label}</option>}
                {data.model.regions.map(r => <option key={r.id} value={r.id}>{r.en} · {r.kk}</option>)}
              </select>
            </label>
            <div className="row">
              {PRESETS.map(p => (
                <button key={p.label} onClick={() => setArea({ kind: 'regions', ids: data.model.regions.filter(r => p.regions.includes(r.en)).map(r => r.id) })}>{p.label}</button>
              ))}
            </div>
            <div className="row">
              <button className={drawMode === 'box' ? 'on' : ''} onClick={() => setDrawMode(drawMode === 'box' ? 'none' : 'box')}>Draw a box</button>
              <button className={drawMode === 'polygon' ? 'on' : ''} onClick={() => setDrawMode(drawMode === 'polygon' ? 'none' : 'polygon')}>Draw a polygon</button>
              <button onClick={() => { setArea({ kind: 'country' }); setDrawMode('none') }}>Reset</button>
            </div>
            {drawMode !== 'none' && <p className="hint">{drawMode === 'box' ? 'Click two opposite corners on the map.' : 'Click to add points, double-click to finish.'}</p>}
            <details>
              <summary>Enter coordinates</summary>
              <form className="coords" onSubmit={e => { e.preventDefault(); setArea({ kind: 'circle', lat: +circle.lat, lon: +circle.lon, km: +circle.km }) }}>
                <span>Circle:</span>
                <input aria-label="Latitude" value={circle.lat} onChange={e => setCircle({ ...circle, lat: e.target.value })} />°N
                <input aria-label="Longitude" value={circle.lon} onChange={e => setCircle({ ...circle, lon: e.target.value })} />°E
                <input aria-label="Radius in km" value={circle.km} onChange={e => setCircle({ ...circle, km: e.target.value })} />km
                <button type="submit">Apply</button>
              </form>
              <form className="coords" onSubmit={e => { e.preventDefault(); setArea({ kind: 'box', west: +bbox.west, south: +bbox.south, east: +bbox.east, north: +bbox.north }) }}>
                <span>Box:</span>
                {(['west', 'south', 'east', 'north'] as const).map(k => (
                  <input key={k} aria-label={k} title={k} value={bbox[k]} onChange={e => setBbox({ ...bbox, [k]: e.target.value })} />
                ))}
                <button type="submit">Apply</button>
              </form>
            </details>
            <p className="selected">Selected: <b>{label}</b>. Shift-click regions on the map to combine them.</p>
            {view.small && <p className="warn">Few fires in this area: monthly values, especially before 2012, are indicative only.</p>}
          </section>

          <section className="panel mapbox" ref={mapRef}>
            <MapView regions={data.regions} area={area} hotspots={hotspots} staticMask={mask} drawMode={drawMode}
                     onDrawDone={a => { setArea(a); setDrawMode('none') }} onRegionClick={pickRegion} />
            <div className="row small">
              <span>{hotspotNote || 'Click a month in the calendar to see its hotspots on the map.'}</span>
              <label><input type="checkbox" checked={!!mask} onChange={toggleMask} /> Show masked gas flares and industry</label>
            </div>
          </section>

          <section className="panel">
            <h2>2. This month compared with history</h2>
            <CurrentCards items={view.cmp} />
            <details className="help"><summary>What am I looking at?</summary>
              Harmonized fire cell-days in the selected area for the latest days with data, compared with the same calendar
              days in every earlier year since 2001. A fire cell-day is a ~1 km cell with at least one satellite fire detection
              on a day, on the VIIRS S-NPP scale. "Usual range" is the 10th–90th percentile of earlier years.
            </details>
          </section>

          <section className="panel">
            <h2>3. Fire season, week by week</h2>
            <div className="row modes" role="radiogroup" aria-label="Reference years">
              <span className="small">Compare with:</span>
              <button role="radio" aria-checked={!seasonRecent} className={!seasonRecent ? 'on' : ''} onClick={() => setSeasonRecent(false)}>All years since 2001</button>
              <button role="radio" aria-checked={seasonRecent} className={seasonRecent ? 'on' : ''} onClick={() => setSeasonRecent(true)}>Last 10 years</button>
            </div>
            <div className="cards season-cards">
              <div className="card">
                <div className="card-label">Critical periods</div>
                {view.critical.runs.length ? <>
                  <div className="card-value small-value">{view.critical.runs.map(([a, b]) => `${weekLabel(a)} – ${weekLabel(b, true)}`).join(' · ')}</div>
                  <div className="card-ref">{view.critical.weeks} weeks hold {Math.round(100 * view.critical.share)}% of the usual burning ({view.season.refYears[0]}–{view.season.refYears[1]}).</div>
                </> : <div className="card-ref">No fire detected here in the reference years.</div>}
              </div>
              <div className="card">
                <div className="card-label">Next 4 weeks ({view.ahead.from} – {view.ahead.to}) usually bring</div>
                {view.ahead.nRef >= 5 ? <>
                  <div className="card-value">{fmtN(view.ahead.median)} <small>fire cell-days (median)</small></div>
                  <div className="card-ref">Usual range {fmtN(view.ahead.p10)}–{fmtN(view.ahead.p90)}; {(view.ahead.shareOfYear || 0) < 0.005 ? 'under 1%' : `about ${Math.round(100 * view.ahead.shareOfYear)}%`} of a year’s burning.</div>
                </> : <div className="card-ref">Not enough history here to say.</div>}
              </div>
            </div>
            <SeasonChart ref={seasonRef} season={view.season} critical={view.critical} />
            <SeasonLegend season={view.season} />
            <details className="help"><summary>What am I looking at?</summary>
              Harmonized fire cell-days per week in the selected area. The black line is the median week of
              {' '}{view.season.refYears[0]}–{view.season.refYears[1]} and the grey band the 10th–90th percentile of those years: the
              usual fire season. Shaded in orange are the critical periods: the fewest weeks that together hold 75% of the
              usual burning. "Next 4 weeks" is what the same 28 days brought in the reference years: a seasonal expectation,
              not a forecast. Fire in Kazakhstan fell sharply after the 2000s, so "Last 10 years" gives a fairer picture of
              what is usual today. The orange line is {view.season.year}, complete weeks only. Kazakhstan usually burns in two waves:
              spring (field and pasture burning before sowing) and late summer to autumn (after the harvest). Weeks with satellite
              outages are left out.
            </details>
          </section>

          <section className="panel">
            <h2>4. Burning calendar, {firstYear}–{lastYear}</h2>
            <div className="row modes" role="radiogroup" aria-label="What the calendar shows">
              {(Object.keys(MODE_LABEL) as Mode[]).map(k => (
                <button key={k} role="radio" aria-checked={mode === k} className={mode === k ? 'on' : ''} onClick={() => setMode(k)}>{MODE_LABEL[k]}</button>
              ))}
            </div>
            <div className="scroll"><Calendar ref={calRef} months={view.months} clim={view.clim} mode={mode} selected={selected} onSelect={k => setSelected(k === selected ? null : k)} /></div>
            <CalendarLegend mode={mode} max={view.max} />
            <details className="help"><summary>What am I looking at?</summary>
              Each square is one month; darker blue means less fire, yellow means more (log scale). Switch to "Naive splice" to
              see the false jump in 2012 when VIIRS replaced MODIS, and back to "Harmonized" to see it removed. Hatched months
              before 2012 are modelled from MODIS; hover for the likely range. "Anomaly" compares each month with the median of
              the same month in {2001}–{lastYear - 1}. Click a month to show its fires on the map.
            </details>
          </section>

          <section className="panel">
            <h2>5. Fire activity per year</h2>
            <AnnualChart ref={annRef} years={view.years} />
            <AnnualLegend />
            <details className="help"><summary>What am I looking at?</summary>
              Yearly totals for the selected area. The red line is what you get by joining the raw records; the black line is
              the harmonized record. Before 2012 the shaded band is the model's 10th–90th percentile range. The current year
              is left out until it ends.
            </details>
          </section>

          <section className="panel">
            <h2>6. Biggest fire days</h2>
            <div className="row modes" role="radiogroup" aria-label="Which years">
              <button role="radio" aria-checked={!topObserved} className={!topObserved ? 'on' : ''} onClick={() => setTopObserved(false)}>All years</button>
              <button role="radio" aria-checked={topObserved} className={topObserved ? 'on' : ''} onClick={() => setTopObserved(true)}>Since 2012 (observed by VIIRS)</button>
            </div>
            <div className="tablewrap">
              <TopDays days={view.top} selected={selected} onSelect={d => {
                setSelected(d === selected ? null : d)
                mapRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
              }} />
            </div>
            <details className="help"><summary>What am I looking at?</summary>
              The ten days with the most harmonized fire cell-days in the selected area. A single extreme day can
              hide inside an ordinary month: "Share of its month" shows how much of the month's burning happened that day.
              Days before 2012 are modelled from MODIS and less certain than VIIRS days. "Show on map" draws that day's detections.
            </details>
          </section>

          <section className="panel">
            <h2>7. Download</h2>
            <div className="row">
              <button onClick={() => download('dala-fire_monthly.csv', seriesCsv(view.months, label, data.model.data_through))}>Monthly series (CSV)</button>
              <button onClick={() => download('dala-fire_yearly.csv', seriesCsv(view.years, label, data.model.data_through))}>Yearly series (CSV)</button>
              <button onClick={() => calRef.current && svgToPng(calRef.current, 'dala-fire_calendar.png')}>Calendar (PNG)</button>
              <button onClick={() => annRef.current && svgToPng(annRef.current, 'dala-fire_yearly.png')}>Yearly chart (PNG)</button>
              <button onClick={() => seasonRef.current && svgToPng(seasonRef.current, 'dala-fire_season.png')}>Fire season (PNG)</button>
            </div>
            <div className="row">
              <span>Hotspots in this area from</span>
              <select value={range.from} onChange={e => setRange({ ...range, from: +e.target.value })}>{yearOptions.map(y => <option key={y}>{y}</option>)}</select>
              <span>to</span>
              <select value={range.to} onChange={e => setRange({ ...range, to: +e.target.value })}>{yearOptions.map(y => <option key={y}>{y}</option>)}</select>
              <button onClick={downloadHotspots} disabled={!!busy}>{busy || 'Hotspots (CSV)'}</button>
            </div>
          </section>
        </main>
      )}

      <footer>
        Fire data: NASA FIRMS (MODIS C6.1, VIIRS 375 m C2). Regions © OpenStreetMap contributors. Built for the NASA Space Apps
        Challenge 2026 by team Thermal Fusion. Open source; AI tools were used in development (see Methods).
      </footer>
    </div>
  )
}
