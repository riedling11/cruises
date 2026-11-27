/* Cruise Weather — static, client-side. Data: Open-Meteo (no key). */
(function () {
  'use strict';

  const FORECAST_AHEAD = 15;   // days ahead the forecast API covers reliably
  const RECENT_BACK = 60;      // days back the forecast API can serve as "recorded"
  const TYPICAL_YEARS = 10;    // years of history for "typical"
  const TYPICAL_WINDOW = 3;    // ± days around each date for "typical"
  const CACHE_VERSION = 'v4';
  const SST_FIRST_YEAR = 2023;  // first year with sea-surface temperature history
  const UV_FIRST_YEAR = 2022;   // first year with UV history (historical forecast API)
  const PORT_RAIN_IN = 0.02;    // inches during port hours that count as "rained ashore" on a typical day

  const API = {
    forecast: 'https://api.open-meteo.com/v1/forecast',
    archive: 'https://archive-api.open-meteo.com/v1/archive',
    histForecast: 'https://historical-forecast-api.open-meteo.com/v1/forecast',
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

  // Hourly values for one date: [{h: hour 0-23, v}] (times are the location's local time)
  function hourlyFor(loc, field, date) {
    const t = loc?.hourly?.time, v = loc?.hourly?.[field];
    if (!t || !v) return [];
    const out = [];
    for (let k = 0; k < t.length; k++) if (t[k].startsWith(date) && v[k] != null) out.push({ h: +t[k].slice(11, 13), v: v[k] });
    return out;
  }
  const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  // "8:00 AM" -> 8 ; "6:30 PM" -> 18.5
  function parseClock(s) {
    const m = /^(\d{1,2}):(\d{2})\s*([AP])M$/i.exec(String(s || '').trim());
    if (!m) return null;
    let h = +m[1] % 12; if (m[3].toUpperCase() === 'P') h += 12;
    return h + (+m[2]) / 60;
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
  // Daily weather_code reports the worst hour, so one passing shower labels the whole day "Drizzle".
  // When rain is unlikely, describe the day by its mean cloud cover instead.
  function sky(code, cloud, pct, rainIn) {
    const base = cloud == null ? null
      : cloud < 25 ? ['☀️', 'Sunny'] : cloud < 50 ? ['🌤️', 'Mostly sunny'] : cloud < 75 ? ['⛅', 'Partly cloudy'] : ['☁️', 'Mostly cloudy'];
    if (code == null) return base || ['', ''];
    const wet = (code >= 51 && code <= 67) || (code >= 80 && code <= 82);
    const storm = code >= 95;
    if (!wet && !storm) return (code <= 3 && base) ? base : wx(code);
    const likely = pct != null ? pct >= 50 : (rainIn != null ? rainIn >= 0.1 : true);
    if (!likely && base) return [base[0], `${base[1]}, ${storm ? 'isolated storms' : 'passing showers'} possible`];
    return wx(code);
  }
  function wxFromRain(pct) {
    if (pct == null) return ['', ''];
    if (pct < 25) return ['🌤️', 'Usually dry'];
    if (pct < 50) return ['⛅', 'Some showers'];
    return ['🌦️', 'Often showery'];
  }
  const compass = deg => deg == null ? '' : ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(((deg % 360) + 360) % 360 / 45) % 8];
  const toC = f => f == null ? null : Math.round((f - 32) * 5 / 9);
  const clock = iso => { if (!iso) return ''; const [h, mi] = iso.slice(11, 16).split(':').map(Number); return `${((h + 11) % 12) + 1}:${pad(mi)}${h < 12 ? 'am' : 'pm'}`; };

  const uvWord = u => u == null ? '' : u < 3 ? 'low' : u < 6 ? 'moderate' : u < 8 ? 'high' : u < 11 ? 'very high' : 'extreme';

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
    // Port days with both times get a typical "rain while in port" figure; fetch hourly rain only for those spots.
    const portLocs = [...new Set(cruise.days.filter(d => d.type === 'port' && parseClock(d.arrive) != null && parseClock(d.depart) != null).map(d => d._loc))];
    const portIdx = new Map(portLocs.map((l, k) => [l, k]));
    const pcp = coordParams(portLocs.map(l => locs[l]));

    const perYear = await Promise.all(years.map(async y => {
      const s = addDays(withYear(cruise.start, y), -TYPICAL_WINDOW);
      const e = addDays(withYear(cruise.end, y + yearSpan), TYPICAL_WINDOW);
      const wxReq = om(API.archive, {
        ...cp, start_date: s, end_date: e, timezone: 'auto',
        daily: 'temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,apparent_temperature_max,relative_humidity_2m_mean,wind_direction_10m_dominant,sunrise,sunset',
        temperature_unit: 'fahrenheit', wind_speed_unit: 'kn', precipitation_unit: 'inch'
      }).catch(() => null);
      const marineBase = { ...cp, start_date: s, end_date: e, timezone: 'auto', daily: 'wave_height_max' };
      const seaReq = om(API.marine, { ...marineBase, models: 'era5_ocean' })
        .catch(() => om(API.marine, marineBase))
        .catch(() => null);
      // Water-temperature history only exists from SST_FIRST_YEAR, and not in the ERA5-Ocean model.
      const sstReq = y >= SST_FIRST_YEAR
        ? om(API.marine, { ...cp, start_date: s, end_date: e, timezone: 'auto', hourly: 'sea_surface_temperature', temperature_unit: 'fahrenheit' }).catch(() => null)
        : Promise.resolve(null);
      const uvReq = y >= UV_FIRST_YEAR
        ? om(API.histForecast, { ...cp, start_date: s, end_date: e, timezone: 'auto', daily: 'uv_index_max' }).catch(() => null)
        : Promise.resolve(null);
      const rainReq = portLocs.length
        ? om(API.archive, { ...pcp, start_date: s, end_date: e, timezone: 'auto', hourly: 'precipitation', precipitation_unit: 'inch' }).catch(() => null)
        : Promise.resolve(null);
      const [w, m, sst, uv, rain] = await Promise.all([wxReq, seaReq, sstReq, uvReq, rainReq]);
      return { y, w, m, sst, uv, rain };
    }));

    const out = cruise.days.map(day => {
      const acc = { uv: [], portWet: 0, portN: 0, hi: [], lo: [], wind: [], wave: [], sst: [], feels: [], rh: [], dx: 0, dy: 0, sunrise: null, sunset: null, rainDays: 0, n: 0 };
      perYear.forEach(({ y, w, m, sst, uv, rain }) => {
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
              acc.feels.push(pick(wl, wi, 'apparent_temperature_max', dt));
              acc.rh.push(pick(wl, wi, 'relative_humidity_2m_mean', dt));
              const wd = pick(wl, wi, 'wind_direction_10m_dominant', dt);
              if (wd != null) { acc.dx += Math.sin(wd * Math.PI / 180); acc.dy += Math.cos(wd * Math.PI / 180); }
              // Sun times barely move year to year: keep the most recent year's value for the exact date.
              if (k === 0 && !acc.sunrise) { acc.sunrise = pick(wl, wi, 'sunrise', dt); acc.sunset = pick(wl, wi, 'sunset', dt); }
              const p = pick(wl, wi, 'precipitation_sum', dt);
              if (p != null) { acc.n++; if (p >= 0.1) acc.rainDays++; }
            }
          }
          if (ml) acc.wave.push(pick(ml, mi, 'wave_height_max', dt));
          if (uv?.[day._loc]) { const u = uv[day._loc]; acc.uv.push(pick(u, dailyIndex(u), 'uv_index_max', dt)); }
          if (rain && portIdx.has(day._loc)) {
            const hrs = hourlyFor(rain[portIdx.get(day._loc)], 'precipitation', dt);
            const a = parseClock(day.arrive), dp = parseClock(day.depart);
            const inPort = hrs.filter(x => x.h >= Math.floor(a) && x.h < Math.ceil(dp));
            if (inPort.length) { acc.portN++; if (inPort.reduce((t2, x) => t2 + x.v, 0) >= PORT_RAIN_IN) acc.portWet++; }
          }
          if (sst?.[day._loc]) acc.sst.push(mean(hourlyFor(sst[day._loc], 'sea_surface_temperature', dt).map(x => x.v)));
        }
      });
      const waveM = median(acc.wave);
      return {
        hi: round(median(acc.hi)), lo: round(median(acc.lo)),
        wind: round(median(acc.wind)),
        rainPct: acc.n ? Math.round(100 * acc.rainDays / acc.n) : null,
        sst: round(median(acc.sst)),
        uv: round(median(acc.uv)),
        portRain: acc.portN ? Math.round(100 * acc.portWet / acc.portN) : null,
        feels: round(median(acc.feels)), rh: round(median(acc.rh)),
        wdir: (acc.dx || acc.dy) ? (Math.atan2(acc.dx, acc.dy) * 180 / Math.PI + 360) % 360 : null,
        sunrise: acc.sunrise, sunset: acc.sunset,
        waveFt: waveM == null ? null : Math.round(waveM * 3.28084 * 10) / 10
      };
    });

    if (out.some(t => t.hi != null)) cacheSet(cacheKey, out);
    return out;
  }

  /* ---------- live / recorded ---------- */
  // Highest hourly rain chance while the ship is alongside (arrive..depart). Port days with both times only.
  function portRain(day, hours) {
    if (day.type !== 'port' || !hours.length) return null;
    const a = parseClock(day.arrive), d = parseClock(day.depart);
    if (a == null || d == null) return null;
    const inPort = hours.filter(x => x.h >= Math.floor(a) && x.h < Math.ceil(d));
    if (!inPort.length) return null;
    return Math.round(Math.max(...inPort.map(x => x.v)));
  }

  async function loadLive(cruise, locs, dates) {
    if (!dates.length) return {};
    const cp = coordParams(locs);
    const s = dates[0], e = dates[dates.length - 1];
    const [w, m] = await Promise.all([
      om(API.forecast, {
        ...cp, start_date: s, end_date: e, timezone: 'auto',
        daily: 'weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,relative_humidity_2m_mean,precipitation_probability_max,precipitation_sum,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant,sunrise,sunset,cloud_cover_mean,uv_index_max',
        hourly: 'precipitation_probability',
        temperature_unit: 'fahrenheit', wind_speed_unit: 'kn', precipitation_unit: 'inch'
      }).catch(() => null),
      om(API.marine, { ...cp, start_date: s, end_date: e, timezone: 'auto', daily: 'wave_height_max', hourly: 'sea_surface_temperature', temperature_unit: 'fahrenheit' }).catch(() => null)
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
        feels: round(g('apparent_temperature_max')), rh: round(g('relative_humidity_2m_mean')),
        wdir: g('wind_direction_10m_dominant'), sunrise: g('sunrise'), sunset: g('sunset'),
        cloud: g('cloud_cover_mean'), uv: g('uv_index_max'),
        sst: ml ? round(mean(hourlyFor(ml, 'sea_surface_temperature', day.date).map(x => x.v))) : null,
        portRain: portRain(day, wl ? hourlyFor(wl, 'precipitation_probability', day.date) : []),
        waveFt: wave == null ? null : Math.round(wave * 3.28084 * 10) / 10
      };
    });
    return res;
  }

  async function loadArchiveActual(cruise, locs, dates) {
    if (!dates.length) return {};
    const cp = coordParams(locs);
    const s = dates[0], e = dates[dates.length - 1];
    const marineBase = { ...cp, start_date: s, end_date: e, timezone: 'auto', daily: 'wave_height_max', hourly: 'sea_surface_temperature', temperature_unit: 'fahrenheit' };
    const [w, m] = await Promise.all([
      om(API.archive, {
        ...cp, start_date: s, end_date: e, timezone: 'auto',
        daily: 'weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,relative_humidity_2m_mean,precipitation_sum,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant,sunrise,sunset,cloud_cover_mean',
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
        feels: round(g('apparent_temperature_max')), rh: round(g('relative_humidity_2m_mean')),
        wdir: g('wind_direction_10m_dominant'), sunrise: g('sunrise'), sunset: g('sunset'),
        cloud: g('cloud_cover_mean'),
        sst: ml ? round(mean(hourlyFor(ml, 'sea_surface_temperature', day.date).map(x => x.v))) : null,
        waveFt: wave == null ? null : Math.round(wave * 3.28084 * 10) / 10
      };
    });
    return res;
  }

  /* ---------- estimated ship position ---------- */
  // Itinerary times are port-local. Each day's UTC offset comes from Open-Meteo (timezone=auto).
  function waypoints(cruise, offsets) {
    const pts = [];
    cruise.days.forEach((d, i) => {
      const off = offsets[i] ?? -new Date().getTimezoneOffset() * 60;
      const at = h => Date.parse(d.date + 'T00:00:00Z') + h * 3600e3 - off * 1000;
      const base = { lat: d.lat, lon: d.lon, i };
      if (d.type === 'sea') { pts.push({ ...base, t: at(12), kind: 'sea' }); return; }
      const a = parseClock(d.arrive), dep = parseClock(d.depart);
      if (a != null) pts.push({ ...base, t: at(a), kind: 'arrive' });
      if (dep != null) pts.push({ ...base, t: at(dep), kind: 'depart' });
      if (a == null && dep == null) pts.push({ ...base, t: at(12), kind: 'port' });
    });
    return pts.sort((x, y) => x.t - y.t);
  }

  function shipNow(cruise, pts, now) {
    if (!pts.length) return null;
    const first = pts[0], last = pts[pts.length - 1];
    const name = p => cruise.days[p.i].name;
    const wkday = p => toUTC(cruise.days[p.i].date).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
    if (now < first.t) {
      if (now > first.t - 18 * 3600e3) return { lat: first.lat, lon: first.lon, text: `In port at ${name(first)} · departs ${cruise.days[first.i].depart}` };
      return null;
    }
    if (now >= last.t) {
      if (now < last.t + 12 * 3600e3) return { lat: last.lat, lon: last.lon, text: `Arrived in ${name(last)}` };
      return null;
    }
    let k = 0;
    while (k < pts.length - 1 && !(pts[k].t <= now && now < pts[k + 1].t)) k++;
    const A = pts[k], B = pts[k + 1];
    if (A.i === B.i && A.kind === 'arrive' && B.kind === 'depart') {
      return { lat: A.lat, lon: A.lon, text: `In port at ${name(A)} · all aboard before ${cruise.days[A.i].depart}` };
    }
    const f = (now - A.t) / (B.t - A.t);
    const next = pts.slice(k + 1).find(p => p.kind === 'arrive' || p.kind === 'port');
    return {
      lat: A.lat + (B.lat - A.lat) * f, lon: A.lon + (B.lon - A.lon) * f,
      text: next ? `At sea, heading to ${name(next)} · arrives ${wkday(next)} ${cruise.days[next.i].arrive || ''}`.trim() : 'At sea'
    };
  }

  /* ---------- tropical storms (NHC, copied into data/storms.json by a GitHub Action) ---------- */
  const STORM_RADIUS_NM = 600;
  const STORM_LOOKAHEAD_DAYS = 21;
  const STORM_TYPES = { HU: 'Hurricane', TS: 'Tropical Storm', TD: 'Tropical Depression', STS: 'Subtropical Storm', SD: 'Subtropical Depression', PTC: 'Potential Tropical Cyclone', PC: 'Post-Tropical Cyclone', TY: 'Typhoon' };
  function distNm(a, b) {
    const R = 3440.065, r = x => x * Math.PI / 180;
    const dLat = r(b.lat - a.lat), dLon = r(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  async function loadStorms(cruise, today) {
    if (diffDays(cruise.end, today) < 0 || diffDays(cruise.start, today) > STORM_LOOKAHEAD_DAYS) return [];
    const j = await getJSON('data/storms.json').catch(() => null);
    return (j?.storms || []).map(st => {
      let best = null;
      cruise.days.forEach(d => { const dist = distNm(st, d); if (!best || dist < best.dist) best = { dist, d }; });
      return { ...st, dist: Math.round(best.dist), near: best.d.type === 'sea' ? best.d.name : best.d.name.split(',')[0], type: STORM_TYPES[st.classification] || 'Tropical system' };
    }).filter(st => st.dist <= STORM_RADIUS_NM).sort((a, b) => a.dist - b.dist);
  }
  const stormLine = st => `${st.type} ${st.name}${st.intensityKt ? ` (${st.intensityKt} kt winds)` : ''} is about ${st.dist} nm from the route near ${st.near}`;

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

  // One view model per day, shared by the on-page card and the WhatsApp text.
  function dayModel(day, i, cruise, today, live, typ) {
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
    if (src !== 'typical' && (lv.code != null || lv.cloud != null)) [icon, label] = sky(lv.code, lv.cloud, src === 'forecast' ? lv.rainPct : null, lv.rainIn);
    else [icon, label] = wxFromRain(t.rainPct);

    let rain = null;
    if (src === 'forecast' && lv.rainPct != null) rain = `${lv.rainPct}%`;
    else if (src === 'recorded' && lv.rainIn != null) rain = `${lv.rainIn.toFixed(2)} in`;
    else if (t.rainPct != null) rain = `${t.rainPct}%`;
    const rainLbl = src === 'recorded' ? 'Rain' : (src === 'forecast' ? 'Rain chance' : 'Rainy days');

    return {
      i, day, src, isToday: d === 0, hi, lo, wind, waveFt, waveTypical, icon, label, rain, rainLbl,
      mph: wind == null ? null : Math.round(wind * 1.15078),
      gust: src !== 'typical' && lv.gust && lv.gust > (wind ?? 0) + 2 ? lv.gust : null,
      sea: seaState(waveFt),
      feels: lv.feels ?? t.feels ?? null,
      rh: lv.rh ?? t.rh ?? null,
      dir: compass(lv.wdir ?? t.wdir),
      sunrise: clock(lv.sunrise ?? t.sunrise),
      sunset: clock(lv.sunset ?? t.sunset),
      uv: lv.uv != null ? Math.round(lv.uv) : (t.uv ?? null),
      sst: lv.sst ?? t.sst ?? null,
      portRain: src === 'forecast' ? lv.portRain ?? null : (src === 'typical' ? t.portRain ?? null : null),
      portRainTypical: src === 'typical',
      total: cruise.days.length
    };
  }

  function dayCard(m) {
    const { day, src } = m;
    const badge = { forecast: 'Forecast', recorded: 'Recorded', typical: 'Typical' }[src];
    return `
      <article class="day ${src} ${m.isToday ? 'today' : ''}">
        <header>
          <div class="when"><span class="dnum">Day ${m.i + 1}</span> ${esc(fmtDate(day.date))}${m.isToday ? ' <span class="now">Today</span>' : ''}</div>
          <div class="hdr-r">
            <span class="badge ${src}">${badge}</span>
            <button class="copy" type="button" data-copy-day="${m.i}" aria-label="Copy day ${m.i + 1} for WhatsApp" title="Copy for WhatsApp">Copy</button>
          </div>
        </header>
        <div class="where">
          <h3>${day.type === 'sea' ? `At sea <span class="approx">· ${esc(day.name)} (approx.)</span>` : esc(day.name)}</h3>
          <p class="times">${esc(times(day))}${day.note ? ` <span class="note">${esc(day.note)}</span>` : ''}</p>
        </div>
        <div class="stats">
          <div class="stat sky"><span class="icon" aria-hidden="true">${m.icon || '·'}</span><span class="lbl">${esc(m.label || '—')}</span></div>
          <div class="stat"><span class="val">${m.hi ?? '—'}°<small>/${m.lo ?? '—'}°</small></span><span class="lbl">High / low °F</span></div>
          <div class="stat"><span class="val">${m.rain ?? '—'}</span><span class="lbl">${m.rainLbl}</span></div>
          <div class="stat"><span class="val">${m.dir ? m.dir + ' ' : ''}${m.wind ?? '—'} kn${m.mph != null ? ` <small>(${m.mph} mph)</small>` : ''}${m.gust ? ` <small>gusts ${m.gust}</small>` : ''}</span><span class="lbl">Wind</span></div>
          <div class="stat"><span class="val">${m.waveFt ?? '—'}${m.waveFt != null ? ' ft' : ''} ${m.sea ? `<span class="sea ${m.sea[0]}">${m.sea[1]}</span>` : ''}</span><span class="lbl">Seas${m.waveTypical ? ' (typical)' : ''}</span></div>
        </div>
        ${m.portRain != null ? `<p class="ashore">☔ ${m.portRainTypical ? `A shower while in port on ${m.portRain}% of past days` : `${m.portRain}% chance of rain while in port`} (${esc(day.arrive)} – ${esc(day.depart)})</p>` : ''}
        ${(m.feels != null || m.sunrise || m.uv != null || m.sst != null) ? `<p class="extra">${[
          m.feels != null ? `Feels like ${m.feels}°` : '',
          m.rh != null ? `${m.rh}% humidity` : '',
          m.uv != null ? `UV ${m.uv} (${uvWord(m.uv)})` : '',
          m.sst != null ? `Water ${m.sst}°F${m.src === 'typical' ? ' (typical)' : ''}` : '',
          m.sunrise ? `Sunrise ${m.sunrise} · Sunset ${m.sunset}` : ''
        ].filter(Boolean).join(' · ')}</p>` : ''}
      </article>`;
  }

  /* ---------- WhatsApp text ---------- */
  // WhatsApp formatting: *bold*, _italic_. Plain text otherwise.
  const shortPlace = d => d.type === 'sea' ? `At sea (${d.name}, approx.)` : d.name;
  const srcWord = { forecast: 'Forecast', recorded: 'Recorded', typical: 'Typical for this date' };

  function waDay(cruise, m, next, url, storms = []) {
    const d = m.day;
    const dateShort = toUTC(d.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).replace(',', '');
    const lines = [`🚢 *${cruise.ship} – Day ${m.i + 1} (${dateShort})*`];
    if (d.type === 'sea') lines.push(`📍 Sea day 🌊 ${d.name} (approx.)`);
    else lines.push(`📍 ${d.name}${times(d) ? ` · ${times(d)}` : ''}${d.note ? ` · ${d.note}` : ''}`);
    if (m.hi != null) lines.push(`🌡️ High ${m.hi}°F (${toC(m.hi)}°C) / Low ${m.lo}°F (${toC(m.lo)}°C)`);
    if (m.label) lines.push(`${m.icon || '⛅'} Sky: ${m.label}${m.rain != null && m.src === 'forecast' ? ` · ☔ ${m.rain} chance of rain` : ''}`);
    if (m.portRain != null) lines.push(`🏝️ While in port (${d.arrive} – ${d.depart}): ${m.portRainTypical ? `a shower on ${m.portRain}% of past days` : `${m.portRain}% chance of rain`}`);
    if (m.feels != null) lines.push(`😎 Feels like: ${m.feels}°F (${toC(m.feels)}°C)${m.rh != null ? ` · 💧 ${m.rh}% humidity` : ''}`);
    if (m.uv != null || m.sst != null) lines.push([m.uv != null ? `🕶️ UV ${m.uv} (${uvWord(m.uv)})` : '', m.sst != null ? `🏊 Water ${m.sst}°F (${toC(m.sst)}°C)` : ''].filter(Boolean).join(' · '));
    if (m.sunrise) lines.push(`🌅 Sunrise ${m.sunrise} · 🌇 Sunset ${m.sunset}`);
    if (m.wind != null) lines.push(`💨 Wind: ${m.dir ? m.dir + ' ' : ''}${m.wind} kt (${m.mph} mph / ${Math.round(m.wind * 1.852)} km/h)${m.gust ? `, gusts ${m.gust} kt` : ''}`);
    if (m.waveFt != null) lines.push(`🌊 Seas: ${m.waveFt} ft (${(m.waveFt / 3.28084).toFixed(1)} m) · ${m.sea[1]}${m.waveTypical ? ' (typical)' : ''}`);
    if (m.hi == null && m.wind == null && m.waveFt == null) lines.push('Weather not available yet.');
    storms.forEach(st => lines.push(`⚠️ ${stormLine(st)} (NHC)`));
    if (next) {
      const nd = next.day;
      const where = nd.type === 'sea' ? 'Sea day' : nd.name.split(',')[0].toUpperCase();
      const bits = [];
      if (next.icon) bits.push(`${next.icon} ${next.label}`);
      if (next.hi != null) bits.push(`${next.hi}°F (${toC(next.hi)}°C)`);
      if (next.waveFt != null) bits.push(`seas ${next.waveFt} ft`);
      lines.push(`🔜 Tomorrow: ${nd.type === 'sea' ? where : `Arriving in ${where}`}${bits.length ? ' ' + bits.join(', ') : ''}`);
    }
    if (m.src === 'typical') lines.push('_Typical conditions for this date. The live forecast starts about 2 weeks out._');
    else if (m.waveTypical) lines.push('_Seas are typical for this date; the wave forecast reaches about a week out._');
    lines.push(`📅 Full trip forecast: ${url.replace(/^https?:\/\//, '')}`);
    return lines.join('\n');
  }

  function waVoyage(cruise, models, url, storms = []) {
    const short = iso => toUTC(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric', timeZone: 'UTC' });
    const lines = [
      `🚢 *${cruise.ship} · ${cruise.title}*`,
      `${cruise.line} · ${fmtRange(cruise.start, cruise.end)}`,
      ...storms.map(st => `⚠️ ${stormLine(st)} (NHC)`),
      ''
    ];
    let anyTypical = false, anyTypicalSeas = false;
    models.forEach(m => {
      const d = m.day;
      const place = d.type === 'sea' ? 'At sea' : d.name.split(',')[0];
      const parts = [];
      if (m.hi != null) parts.push(`${m.icon || ''} ${m.hi}°/${m.lo}°`.trim());
      if (m.wind != null) parts.push(`💨 ${m.wind} kn`);
      if (m.waveFt != null) parts.push(`🌊 ${m.waveFt} ft ${m.sea[1]}`);
      let tag = '';
      if (m.src === 'typical') { tag = ' _(typical)_'; anyTypical = true; }
      else if (m.waveTypical) { tag = ' _(typical seas)_'; anyTypicalSeas = true; }
      lines.push(`*${short(d.date)} · ${place}*${m.isToday ? ' ⬅️ today' : ''}`);
      lines.push(`${parts.join(' · ') || 'No data yet'}${tag}`);
      const more = [];
      if (m.portRain != null) more.push(m.portRainTypical ? `🏝️ showers in port ${m.portRain}% of days` : `🏝️ ${m.portRain}% rain chance in port`);
      if (m.uv != null) more.push(`🕶️ UV ${m.uv}`);
      if (m.sst != null) more.push(`🏊 ${m.sst}°F water`);
      if (more.length) lines.push(more.join(' · '));
    });
    lines.push('');
    if (anyTypical) lines.push('_Typical = 10-year normal; switches to the live forecast about 2 weeks out._');
    if (anyTypicalSeas) lines.push('_Wave forecasts reach about a week out; later days show typical seas until then._');
    lines.push(url);
    return lines.join('\n');
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      let ok = false; try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove(); return ok;
    }
  }

  function toast(msg) {
    let el = document.getElementById('toast');
    if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
    el.textContent = msg; el.classList.add('show');
    clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('show'), 2200);
  }

  function drawMap(cruise, today) {
    if (typeof L === 'undefined') { document.getElementById('map').remove(); return null; }
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
    return map;
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

      <div id="storms"></div>

      ${tracker ? `<section class="card ship-now">
        <div><h2>Where's the ship right now?</h2><p>Live AIS position from VesselFinder.</p></div>
        <a class="btn" href="${esc(tracker)}" target="_blank" rel="noopener">Track ${esc(cruise.ship)} →</a>
      </section>` : ''}

      <div id="map" class="map" role="img" aria-label="Route map"></div>
      <p class="pos" id="pos" hidden></p>

      <section>
        <div class="sec-head">
          <h2>Voyage weather</h2>
          <button class="refresh" id="refresh" type="button">Refresh</button>
        </div>
        <p class="updated" id="updated">Loading weather…</p>
        <div class="share">
          <span>WhatsApp:</span>
          <button type="button" class="copy" id="copy-today" disabled>Copy today's post</button>
          <button type="button" class="copy" id="copy-voyage" disabled>Copy full voyage</button>
        </div>
        <div class="legend">
          <span><span class="sea slight">Slight</span> under 4 ft</span>
          <span><span class="sea moderate">Moderate</span> 4–8 ft</span>
          <span><span class="sea rough">Rough</span> 8 ft+</span>
        </div>
        <div id="days" class="days">${cruise.days.map((d, i) => dayCard(dayModel(d, i, cruise, today, null, null))).join('')}</div>
        <div class="notes">
          <p><strong>Forecast</strong> days use the live Open-Meteo forecast and switch on automatically about ${FORECAST_AHEAD} days out. <strong>Typical</strong> days show the median for that date and location over the past ${TYPICAL_YEARS} years (±${TYPICAL_WINDOW} days). "Rainy days" is how often that date saw measurable rain. <strong>Recorded</strong> days show what actually happened.</p>
          <p>Wind is the daily maximum sustained wind in knots (mph in brackets). Seas are the daily maximum combined wave height. Sea-day positions are estimated noon positions; the ship's actual track will differ.</p>
        </div>
      </section>`;

    const map = drawMap(cruise, today);
    const locs = buildLocations(cruise.days);
    let storms = [];

    // Estimated position: only around the sailing dates; refreshed every 5 minutes.
    if (diffDays(cruise.start, today) <= 1 && diffDays(today, cruise.end) <= 1) {
      om(API.forecast, { ...coordParams(locs), timezone: 'auto', forecast_days: 1, daily: 'sunrise' }).then(res => {
        const offsets = cruise.days.map(d => res[d._loc]?.utc_offset_seconds);
        const pts = waypoints(cruise, offsets);
        let marker = null;
        const tick = () => {
          const p = shipNow(cruise, pts, Date.now());
          const el = document.getElementById('pos');
          if (!p) { el.hidden = true; if (marker) { marker.remove(); marker = null; } return; }
          el.hidden = false;
          el.innerHTML = `🚢 <strong>Estimated position:</strong> ${esc(p.text)} <small>(from the itinerary, not live tracking)</small>`;
          if (map && typeof L !== 'undefined') {
            if (!marker) marker = L.marker([p.lat, p.lon], { icon: L.divIcon({ className: 'ship-icon', html: '🚢', iconSize: [28, 28], iconAnchor: [14, 14] }), zIndexOffset: 1000 }).addTo(map).bindTooltip('Estimated position');
            else marker.setLatLng([p.lat, p.lon]);
          }
        };
        tick(); setInterval(tick, 5 * 60e3);
      }).catch(() => { /* position is optional */ });
    }

    loadStorms(cruise, today).then(list => {
      storms = list;
      if (!list.length) return;
      document.getElementById('storms').innerHTML = list.map(st => `
        <section class="alert" role="alert">
          <strong>⚠️ ${esc(st.type)} ${esc(st.name)}</strong>
          <p>${esc(stormLine(st))}.${st.lastUpdate ? ` NHC update ${esc(new Date(st.lastUpdate).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}.` : ''}</p>
          <p><a href="${esc(st.advisoryUrl || 'https://www.nhc.noaa.gov/')}" target="_blank" rel="noopener">Read the NHC advisory →</a> Check with your cruise line for itinerary changes.</p>
        </section>`).join('');
    });

    let models = cruise.days.map((d, i) => dayModel(d, i, cruise, today, null, null));
    const shareUrl = `${location.origin}${location.pathname}?c=${encodeURIComponent(slug)}`;
    // "Today" = today's itinerary day during the cruise; day 1 before it; last day after it.
    const todayIndex = () => {
      const k = cruise.days.findIndex(d => d.date === today);
      if (k >= 0) return k;
      return diffDays(cruise.start, today) > 0 ? 0 : cruise.days.length - 1;
    };
    const copyDay = async k => {
      const ok = await copyText(waDay(cruise, models[k], models[k + 1] || null, shareUrl, storms));
      toast(ok ? `Day ${k + 1} copied, paste it into WhatsApp` : 'Copy failed: your browser blocked clipboard access');
    };
    app.addEventListener('click', async e => {
      const btn = e.target.closest('button');
      if (!btn) return;
      if (btn.dataset.copyDay != null) copyDay(+btn.dataset.copyDay);
      else if (btn.id === 'copy-today') copyDay(todayIndex());
      else if (btn.id === 'copy-voyage') {
        const ok = await copyText(waVoyage(cruise, models, shareUrl, storms));
        toast(ok ? 'Voyage copied, paste it into WhatsApp' : 'Copy failed: your browser blocked clipboard access');
      }
    });

    const load = async (force) => {
      const upd = document.getElementById('updated');
      upd.textContent = 'Loading weather…';
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
        models = cruise.days.map((d, i) => dayModel(d, i, cruise, today, merged[i], typ[i]));
        document.getElementById('days').innerHTML = models.map(dayCard).join('');
        document.getElementById('copy-today').disabled = false;
        document.getElementById('copy-voyage').disabled = false;
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
