/* Cruise Weather — static, client-side. Data: Open-Meteo (no key). */
(function () {
  'use strict';

  const FORECAST_AHEAD = 15;   // days ahead the forecast API covers reliably
  const RECENT_BACK = 60;      // days back the forecast API can serve as "recorded"
  const TYPICAL_YEARS = 10;    // years of history for "typical"
  const TYPICAL_WINDOW = 3;    // ± days around each date for "typical"
  const CACHE_VERSION = 'v1';

  const API = {
    forecast: 'https://api.open-meteo.com/v1/forecast',
    archive: 'https://archive-api.open-meteo.com/v1/archive',
    marine: 'https://marine-api.open-meteo.com/v1/marine'
  };

  const app = document.getElementById('app');
  const slug = new URLSearchParams(location.search).get('c');

  /* ---------- date helpers (all dates are YYYY-MM-DD strings) ---------- */
  const pad = n => String(n).padStart(2, '0');
  const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const toUTC = iso => new Date(iso + 'T12:00:00Z');
  const addDays = (iso, n) => { const d = toUTC(iso); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const diffDays = (a, b) => Math.round((toUTC(a) - toUTC(b)) / 864e5);
  const withYear = (iso, y) => {
    let md = iso.slice(5);
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    if (md === '02-29' && !leap) md = '02-28';
    return `${y}-${md}`;
  };
  const fmtDate = iso => toUTC(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  const fmtRange = (a, b) => {
    const o = { month: 'short', day: 'numeric', timeZone: 'UTC' };
    return `${toUTC(a).toLocaleDateString('en-US', o)} – ${toUTC(b).toLocaleDateString('en-US', { ...o, year: 'numeric' })}`;
  };

  /* ---------- misc helpers ---------- */
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const median = arr => { const a = arr.filter(v => v != null && !isNaN(v)).sort((x, y) => x - y); if (!a.length) return null; const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
  const round = v => v == null ? null : Math.round(v);
  const cacheGet = k => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch { return null; } };
  const cacheSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } };

  async function getJSON(url) {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return r.json();
  }

  // Open-Meteo returns an object for one location, an array for several. Always return an array.
  async function om(base, params) {
    const q = new URLSearchParams(params);
    const j = await getJSON(`${base}?${q}`);
    if (j && j.error) throw new Error(j.reason || 'Open-Meteo error');
    return Array.isArray(j) ? j : [j];
  }

  // Map date -> index for one location's daily block
  const dailyIndex = loc => { const m = new Map(); (loc?.daily?.time || []).forEach((t, i) => m.set(t, i)); return m; };
  const pick = (loc, idx, field, date) => { const i = idx.get(date); if (i == null) return null; const v = loc.daily[field]?.[i]; return v == null ? null : v; };

  /* ---------- weather codes ---------- */
  function wx(code) {
    if (code == null) return ['', ''];
    if (code === 0) return ['☀️', 'Clear'];
    if (code === 1) return ['🌤️', 'Mostly clear'];
    if (code === 2) return ['⛅', 'Partly cloudy'];
    if (code === 3) return ['☁️', 'Cloudy'];
    if (code === 45 || code === 48) return ['🌫️', 'Fog'];
    if (code >= 51 && code <= 57) return ['🌦️', 'Drizzle'];
    if (code >= 61 && code <= 67) return ['🌧️', 'Rain'];
    if (code >= 71 && code <= 77) return ['🌨️', 'Snow'];
    if (code >= 80 && code <= 82) return ['🌦️', 'Showers'];
    if (code >= 85 && code <= 86) return ['🌨️', 'Snow showers'];
    if (code >= 95) return ['⛈️', 'Thunderstorms'];
    return ['', ''];
  }
  function wxFromRain(pct) {
    if (pct == null) return ['', ''];
    if (pct < 25) return ['🌤️', 'Usually dry'];
    if (pct < 50) return ['⛅', 'Some showers'];
    return ['🌦️', 'Often showery'];
  }
  function seaState(ft) {
    if (ft == null) return null;
    if (ft < 4) return ['slight', 'Slight'];
    if (ft < 8) return ['moderate', 'Moderate'];
    return ['rough', 'Rough'];
  }

  /* ---------- locations ---------- */
  function buildLocations(days) {
    const locs = [];
    const key = d => `${d.lat},${d.lon}`;
    const seen = new Map();
    days.forEach(d => {
      const k = key(d);
      if (!seen.has(k)) { seen.set(k, locs.length); locs.push({ lat: d.lat, lon: d.lon }); }
      d._loc = seen.get(k);
    });
    return locs;
  }
  const coordParams = locs => ({ latitude: locs.map(l => l.lat).join(','), longitude: locs.map(l => l.lon).join(',') });

  /* ---------- typical (climatology) ---------- */
  async function loadTypical(cruise, locs) {
    const cacheKey = `typ:${CACHE_VERSION}:${slug}:${cruise.days.map(d => d.date + d.lat + d.lon).join('|')}`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;

    const startYear = +cruise.start.slice(0, 4);
    const thisYear = new Date().getFullYear();
    const lastFull = Math.min(startYear, thisYear) - 1;
    const yearSpan = +cruise.end.slice(0, 4) - startYear;
    const years = Array.from({ length: TYPICAL_YEARS }, (_, i) => lastFull - i);
    const cp = coordParams(locs);

    const perYear = await Promise.all(years.map(async y => {
      const s = addDays(withYear(cruise.start, y), -TYPICAL_WINDOW);
      const e = addDays(withYear(cruise.end, y + yearSpan), TYPICAL_WINDOW);
      const wxReq = om(API.archive, {
        ...cp, start_date: s, end_date: e, timezone: 'auto',
        daily: 'temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max',
        temperature_unit: 'fahrenheit', wind_speed_unit: 'kn', precipitation_unit: 'inch'
      }).catch(() => null);
      const marineBase = { ...cp, start_date: s, end_date: e, timezone: 'auto', daily: 'wave_height_max' };
      const seaReq = om(API.marine, { ...marineBase, models: 'era5_ocean' })
        .catch(() => om(API.marine, marineBase))
        .catch(() => null);
      const [w, m] = await Promise.all([wxReq, seaReq]);
      return { y, w, m };
    }));

    const out = cruise.days.map(day => {
      const acc = { hi: [], lo: [], wind: [], wave: [], rainDays: 0, n: 0 };
      perYear.forEach(({ y, w, m }) => {
        const offsetYear = y + (+day.date.slice(0, 4) - startYear);
        const center = withYear(day.date, offsetYear);
        const wl = w?.[day._loc], ml = m?.[day._loc];
        const wi = wl ? dailyIndex(wl) : null, mi = ml ? dailyIndex(ml) : null;
        for (let k = -TYPICAL_WINDOW; k <= TYPICAL_WINDOW; k++) {
          const dt = addDays(center, k);
          if (wl) {
            const hi = pick(wl, wi, 'temperature_2m_max', dt);
            if (hi != null) {
              acc.hi.push(hi);
              acc.lo.push(pick(wl, wi, 'temperature_2m_min', dt));
              acc.wind.push(pick(wl, wi, 'wind_speed_10m_max', dt));
              const p = pick(wl, wi, 'precipitation_sum', dt);
              if (p != null) { acc.n++; if (p >= 0.04) acc.rainDays++; }
            }
          }
          if (ml) acc.wave.push(pick(ml, mi, 'wave_height_max', dt));
        }
      });
      const waveM = median(acc.wave);
      return {
        hi: round(median(acc.hi)), lo: round(median(acc.lo)),
        wind: round(median(acc.wind)),
        rainPct: acc.n ? Math.round(100 * acc.rainDays / acc.n) : null,
        waveFt: waveM == null ? null : Math.round(waveM * 3.28084 * 10) / 10
      };
    });

    if (out.some(t => t.hi != null)) cacheSet(cacheKey, out);
    return out;
  }

  /* ---------- live / recorded ---------- */
  async function loadLive(cruise, locs, dates) {
    if (!dates.length) return {};
    const cp = coordParams(locs);
    const s = dates[0], e = dates[dates.length - 1];
    const [w, m] = await Promise.all([
      om(API.forecast, {
        ...cp, start_date: s, end_date: e, timezone: 'auto',
        daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max,wind_gusts_10m_max',
        temperature_unit: 'fahrenheit', wind_speed_unit: 'kn', precipitation_unit: 'inch'
      }).catch(() => null),
      om(API.marine, { ...cp, start_date: s, end_date: e, timezone: 'auto', daily: 'wave_height_max' }).catch(() => null)
    ]);
    const res = {};
    cruise.days.forEach((day, i) => {
      if (!dates.includes(day.date)) return;
      const wl = w?.[day._loc], ml = m?.[day._loc];
      const wi = wl ? dailyIndex(wl) : null, mi = ml ? dailyIndex(ml) : null;
      const g = f => wl ? pick(wl, wi, f, day.date) : null;
      const wave = ml ? pick(ml, mi, 'wave_height_max', day.date) : null;
      res[i] = {
        code: g('weather_code'), hi: round(g('temperature_2m_max')), lo: round(g('temperature_2m_min')),
        rainPct: g('precipitation_probability_max'), rainIn: g('precipitation_sum'),
        wind: round(g('wind_speed_10m_max')), gust: round(g('wind_gusts_10m_max')),
        waveFt: wave == null ? null : Math.round(wave * 3.28084 * 10) / 10
      };
    });
    return res;
  }

  async function loadArchiveActual(cruise, locs, dates) {
    if (!dates.length) return {};
    const cp = coordParams(locs);
    const s = dates[0], e = dates[dates.length - 1];
    const marineBase = { ...cp, start_date: s, end_date: e, timezone: 'auto', daily: 'wave_height_max' };
    const [w, m] = await Promise.all([
      om(API.archive, {
        ...cp, start_date: s, end_date: e, timezone: 'auto',
        daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,wind_gusts_10m_max',
        temperature_unit: 'fahrenheit', wind_speed_unit: 'kn', precipitation_unit: 'inch'
      }).catch(() => null),
      om(API.marine, marineBase).catch(() => om(API.marine, { ...marineBase, models: 'era5_ocean' })).catch(() => null)
    ]);
    const res = {};
    cruise.days.forEach((day, i) => {
      if (!dates.includes(day.date)) return;
      const wl = w?.[day._loc], ml = m?.[day._loc];
      const wi = wl ? dailyIndex(wl) : null, mi = ml ? dailyIndex(ml) : null;
      const g = f => wl ? pick(wl, wi, f, day.date) : null;
      const wave = ml ? pick(ml, mi, 'wave_height_max', day.date) : null;
      res[i] = {
        code: g('weather_code'), hi: round(g('temperature_2m_max')), lo: round(g('temperature_2m_min')),
        rainPct: null, rainIn: g('precipitation_sum'),
        wind: round(g('wind_speed_10m_max')), gust: round(g('wind_gusts_10m_max')),
        waveFt: wave == null ? null : Math.round(wave * 3.28084 * 10) / 10
      };
    });
    return res;
  }

  /* ---------- rendering ---------- */
  function status(cruise, today) {
    const toStart = diffDays(cruise.start, today);
    const fromEnd = diffDays(today, cruise.end);
    const total = diffDays(cruise.end, cruise.start) + 1;
    if (toStart > 1) return { kind: 'upcoming', text: `Sails in ${toStart} days` };
    if (toStart === 1) return { kind: 'upcoming', text: 'Sails tomorrow' };
    if (fromEnd > 0) return { kind: 'past', text: 'Voyage complete' };
    return { kind: 'live', text: `Day ${diffDays(today, cruise.start) + 1} of ${total}` };
  }

  function times(day) {
    if (day.type === 'sea') return '';
    if (day.arrive && day.depart) return `${day.arrive} – ${day.depart}`;
    if (day.depart) return `Departs ${day.depart}`;
    if (day.arrive) return `Arrives ${day.arrive}`;
    return '';
  }

  function dayCard(day, i, cruise, today, live, typ) {
    const d = diffDays(day.date, today);
    let src = 'typical';
    if (live && live.hi != null) src = d >= 0 ? 'forecast' : 'recorded';
    const t = typ || {};
    const lv = live || {};
    // Per-field fallback: live value if present, otherwise typical.
    const hi = lv.hi ?? t.hi, lo = lv.lo ?? t.lo;
    const wind = lv.wind ?? t.wind;
    const waveFt = lv.waveFt ?? t.waveFt;
    const waveTypical = lv.waveFt == null && t.waveFt != null && src !== 'typical';
    let icon, label;
    if (src !== 'typical' && lv.code != null) [icon, label] = wx(lv.code);
    else [icon, label] = wxFromRain(t.rainPct);

    let rain = '—';
    if (src === 'forecast' && lv.rainPct != null) rain = `${lv.rainPct}%`;
    else if (src === 'recorded' && lv.rainIn != null) rain = `${lv.rainIn.toFixed(2)} in`;
    else if (t.rainPct != null) rain = `${t.rainPct}%`;
    const rainLbl = src === 'recorded' ? 'Rain' : (src === 'forecast' ? 'Rain chance' : 'Rainy days');

    const ss = seaState(waveFt);
    const mph = wind == null ? '' : ` <small>(${Math.round(wind * 1.15078)} mph)</small>`;
    const gust = src !== 'typical' && lv.gust ? ` <small>gusts ${lv.gust}</small>` : '';
    const badge = { forecast: 'Forecast', recorded: 'Recorded', typical: 'Typical' }[src];
    const isToday = d === 0;

    return `
      <article class="day ${src} ${isToday ? 'today' : ''}">
        <header>
          <div class="when"><span class="dnum">Day ${i + 1}</span> ${esc(fmtDate(day.date))}${isToday ? ' <span class="now">Today</span>' : ''}</div>
          <span class="badge ${src}">${badge}</span>
        </header>
        <div class="where">
          <h3>${day.type === 'sea' ? `At sea <span class="approx">· ${esc(day.name)} (approx.)</span>` : esc(day.name)}</h3>
          <p class="times">${esc(times(day))}${day.note ? ` <span class="note">${esc(day.note)}</span>` : ''}</p>
        </div>
        <div class="stats">
          <div class="stat sky"><span class="icon" aria-hidden="true">${icon || '·'}</span><span class="lbl">${esc(label || '—')}</span></div>
          <div class="stat"><span class="val">${hi ?? '—'}°<small>/${lo ?? '—'}°</small></span><span class="lbl">High / low °F</span></div>
          <div class="stat"><span class="val">${rain}</span><span class="lbl">${rainLbl}</span></div>
          <div class="stat"><span class="val">${wind ?? '—'} kn${mph}${gust}</span><span class="lbl">Wind</span></div>
          <div class="stat"><span class="val">${waveFt ?? '—'}${waveFt != null ? ' ft' : ''} ${ss ? `<span class="sea ${ss[0]}">${ss[1]}</span>` : ''}</span><span class="lbl">Seas${waveTypical ? ' (typical)' : ''}</span></div>
        </div>
      </article>`;
  }

  function drawMap(cruise, today) {
    if (typeof L === 'undefined') { document.getElementById('map').remove(); return; }
    const map = L.map('map', { scrollWheelZoom: false, attributionControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 12, attribution: '© OpenStreetMap'
    }).addTo(map);
    const pts = cruise.days.map(d => [d.lat, d.lon]);
    L.polyline(pts, { color: '#e8505b', weight: 3, dashArray: '6 6', opacity: 0.85 }).addTo(map);
    const seen = new Set();
    cruise.days.forEach((d, i) => {
      const isToday = diffDays(d.date, today) === 0;
      const k = `${d.lat},${d.lon}`;
      if (d.type === 'port') {
        if (seen.has(k) && !isToday) return;
        seen.add(k);
        L.circleMarker([d.lat, d.lon], { radius: isToday ? 9 : 6, color: '#0b3954', fillColor: isToday ? '#e8505b' : '#fff', fillOpacity: 1, weight: 2 })
          .addTo(map).bindTooltip(`${d.name}`, { direction: 'top' });
      } else {
        L.circleMarker([d.lat, d.lon], { radius: isToday ? 8 : 4, color: '#0b3954', fillColor: isToday ? '#e8505b' : '#0b3954', fillOpacity: isToday ? 1 : 0.5, weight: 1 })
          .addTo(map).bindTooltip(`Day ${i + 1}: at sea (approx.)`, { direction: 'top' });
      }
    });
    map.fitBounds(L.latLngBounds(pts).pad(0.15));
  }

  async function renderCruise(cruise) {
    const today = localToday();
    const st = status(cruise, today);
    document.title = `${cruise.ship} · ${cruise.title}`;
    const tracker = cruise.imo ? `https://www.vesselfinder.com/vessels/details/${encodeURIComponent(cruise.imo)}` : cruise.trackerUrl;

    app.innerHTML = `
      <p class="back"><a href="./">← All cruises</a></p>
      <section class="hero" ${cruise.photo ? `style="background-image:linear-gradient(180deg,rgba(6,30,48,.15),rgba(6,30,48,.85)),url('${esc(cruise.photo)}')"` : ''}>
        <p class="line">${esc(cruise.line)}</p>
        <h1>${esc(cruise.ship)}</h1>
        <p class="title">${esc(cruise.title)}</p>
        <p class="dates">${esc(fmtRange(cruise.start, cruise.end))} <span class="status ${st.kind}">${esc(st.text)}</span></p>
      </section>

      ${tracker ? `<section class="card ship-now">
        <div><h2>Where's the ship right now?</h2><p>Live AIS position from VesselFinder.</p></div>
        <a class="btn" href="${esc(tracker)}" target="_blank" rel="noopener">Track ${esc(cruise.ship)} →</a>
      </section>` : ''}

      <div id="map" class="map" role="img" aria-label="Route map"></div>

      <section>
        <div class="sec-head">
          <h2>Voyage weather</h2>
          <button class="refresh" id="refresh" type="button">Refresh</button>
        </div>
        <p class="updated" id="updated">Loading weather…</p>
        <div class="legend">
          <span><span class="sea slight">Slight</span> under 4 ft</span>
          <span><span class="sea moderate">Moderate</span> 4–8 ft</span>
          <span><span class="sea rough">Rough</span> 8 ft+</span>
        </div>
        <div id="days" class="days">${cruise.days.map((d, i) => dayCard(d, i, cruise, today, null, null)).join('')}</div>
        <div class="notes">
          <p><strong>Forecast</strong> days use the live Open-Meteo forecast and switch on automatically about ${FORECAST_AHEAD} days out. <strong>Typical</strong> days show the median for that date and location over the past ${TYPICAL_YEARS} years (±${TYPICAL_WINDOW} days). "Rainy days" is how often that date saw measurable rain. <strong>Recorded</strong> days show what actually happened.</p>
          <p>Wind is the daily maximum sustained wind in knots (mph in brackets). Seas are the daily maximum combined wave height. Sea-day positions are estimated noon positions; the ship's actual track will differ.</p>
        </div>
      </section>`;

    drawMap(cruise, today);

    const load = async (force) => {
      const upd = document.getElementById('updated');
      upd.textContent = 'Loading weather…';
      const locs = buildLocations(cruise.days);
      const liveDates = [], archDates = [];
      cruise.days.forEach(d => {
        const dd = diffDays(d.date, today);
        if (dd <= FORECAST_AHEAD && dd >= -RECENT_BACK) liveDates.push(d.date);
        else if (dd < -RECENT_BACK) archDates.push(d.date);
      });
      if (force) {
        try { Object.keys(localStorage).filter(k => k.startsWith(`typ:${CACHE_VERSION}:${slug}:`)).forEach(k => localStorage.removeItem(k)); } catch { /* ignore */ }
      }
      try {
        const [typ, live, arch] = await Promise.all([
          loadTypical(cruise, locs).catch(() => []),
          loadLive(cruise, locs, liveDates).catch(() => ({})),
          loadArchiveActual(cruise, locs, archDates).catch(() => ({}))
        ]);
        const merged = { ...arch, ...live };
        document.getElementById('days').innerHTML =
          cruise.days.map((d, i) => dayCard(d, i, cruise, today, merged[i], typ[i])).join('');
        const anyData = typ.some?.(t => t && t.hi != null) || Object.values(merged).some(v => v && v.hi != null);
        upd.textContent = anyData
          ? `Updated ${new Date().toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
          : 'Weather service unavailable — itinerary shown without weather. Try Refresh later.';
      } catch (e) {
        upd.textContent = 'Couldn\'t load weather. Try Refresh.';
      }
    };
    document.getElementById('refresh').addEventListener('click', () => load(true));
    load(false);
  }

  async function renderIndex() {
    const today = localToday();
    let list;
    try { list = (await getJSON('cruises/index.json')).cruises || []; }
    catch { app.innerHTML = '<p class="error">Couldn\'t load the cruise list.</p>'; return; }
    const cruises = (await Promise.all(list.map(s => getJSON(`cruises/${encodeURIComponent(s)}.json`).then(c => ({ ...c, slug: s })).catch(() => null)))).filter(Boolean);
    const upcoming = cruises.filter(c => diffDays(c.end, today) >= 0).sort((a, b) => a.start.localeCompare(b.start));
    const past = cruises.filter(c => diffDays(c.end, today) < 0).sort((a, b) => b.start.localeCompare(a.start));
    const card = c => {
      const st = status(c, today);
      const ports = [...new Set(c.days.filter(d => d.type === 'port').map(d => d.name.split(',')[0]))];
      return `<a class="cruise" href="?c=${encodeURIComponent(c.slug)}">
        <span class="line">${esc(c.line)}</span>
        <strong>${esc(c.ship)} · ${esc(c.title)}</strong>
        <span class="meta">${esc(fmtRange(c.start, c.end))} <span class="status ${st.kind}">${esc(st.text)}</span></span>
        <span class="ports">${esc(ports.join(' → '))}</span>
      </a>`;
    };
    app.innerHTML = `
      <section class="hero small"><h1>Cruise Weather</h1><p class="title">Weather and sea conditions along the route, day by day.</p></section>
      ${upcoming.length ? `<h2>Upcoming</h2><div class="list">${upcoming.map(card).join('')}</div>` : ''}
      ${past.length ? `<h2>Past voyages</h2><div class="list">${past.map(card).join('')}</div>` : ''}
      ${!cruises.length ? '<p>No cruises yet.</p>' : ''}`;
  }

  if (slug) {
    getJSON(`cruises/${encodeURIComponent(slug)}.json`)
      .then(renderCruise)
      .catch(() => { app.innerHTML = '<p class="error">Cruise not found. <a href="./">See all cruises</a>.</p>'; });
  } else {
    renderIndex();
  }
})();
