'use strict';

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const HOURLY = [
  'temperature_2m', 'apparent_temperature', 'dew_point_2m', 'precipitation_probability',
  'precipitation', 'weather_code', 'wind_speed_10m', 'uv_index', 'is_day', 'cloud_cover',
];
const DAILY = [
  'weather_code', 'temperature_2m_max', 'temperature_2m_min', 'precipitation_probability_max',
  'precipitation_sum', 'wind_speed_10m_max', 'uv_index_max', 'sunrise', 'sunset',
];
const STALE_MS = 5 * 60 * 1000; // refresh the forecast this often while the page is visible
// Run hours: earliest and latest start hour for "best time to run". Each is an hour (0–23)
// or 'sunrise' / 'sunset' for that day. preferSun turns on the run score's cloud deduction.
const DEFAULT_PREFS = { from: 'sunrise', to: 'sunset', preferSun: false };

// Shown to first-time visitors when the IP-based guess isn't available.
const FALLBACK_PLACE = { name: 'Portland, Oregon', lat: 45.523, lon: -122.676 };

// WMO weather codes -> [label, day icon, night icon]
const WMO = {
  0: ['Clear', '☀️', '🌙'],
  1: ['Mostly clear', '🌤️', '🌙'],
  2: ['Partly cloudy', '⛅', '☁️'],
  3: ['Overcast', '☁️'],
  45: ['Fog', '🌫️'],
  48: ['Freezing fog', '🌫️'],
  51: ['Light drizzle', '🌦️', '🌧️'],
  53: ['Drizzle', '🌦️', '🌧️'],
  55: ['Heavy drizzle', '🌧️'],
  56: ['Freezing drizzle', '🌧️'],
  57: ['Freezing drizzle', '🌧️'],
  61: ['Light rain', '🌦️', '🌧️'],
  63: ['Rain', '🌧️'],
  65: ['Heavy rain', '🌧️'],
  66: ['Freezing rain', '🌧️'],
  67: ['Freezing rain', '🌧️'],
  71: ['Light snow', '🌨️'],
  73: ['Snow', '🌨️'],
  75: ['Heavy snow', '❄️'],
  77: ['Snow grains', '🌨️'],
  80: ['Light showers', '🌦️', '🌧️'],
  81: ['Showers', '🌧️'],
  82: ['Heavy showers', '⛈️'],
  85: ['Snow showers', '🌨️'],
  86: ['Heavy snow showers', '❄️'],
  95: ['Thunderstorm', '⛈️'],
  96: ['Thunderstorm with hail', '⛈️'],
  99: ['Thunderstorm with hail', '⛈️'],
};

const SCORE_LABEL = { great: 'Great', good: 'Good', fair: 'Fair', poor: 'Poor' };

const state = {
  home: load('home'), // home city, opened on startup: { name, lat, lon }
  place: load('home') || load('place') || FALLBACK_PLACE, // { name, lat, lon }
  units: load('units') || (navigator.language === 'en-US' ? 'imperial' : 'metric'),
  prefs: { ...DEFAULT_PREFS, ...load('prefs') },
  data: null,
  fetchedAt: 0,
  selected: 0,
};

const $ = (sel) => document.querySelector(sel);

function load(key) {
  try { return JSON.parse(localStorage.getItem(`runweather.${key}`)); } catch { return null; }
}

function save(key, value) {
  try { localStorage.setItem(`runweather.${key}`, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Data ----------

async function fetchForecast({ lat, lon }) {
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    timezone: 'auto',
    forecast_days: 16,
    hourly: HOURLY.join(','),
    daily: DAILY.join(','),
  });
  const res = await fetch(`${FORECAST_URL}?${params}`);
  if (!res.ok) throw new Error(`forecast request failed (${res.status})`);
  return shape(await res.json());
}

// Everything is kept in metric (°C, mm, km/h) and converted only for display.
function shape(raw) {
  const h = raw.hourly;
  const d = raw.daily;
  const sun = Object.fromEntries(d.time.map((date, i) => [date, { rise: d.sunrise[i], set: d.sunset[i] }]));
  const hours = h.time.map((time, i) => {
    const hour = {
      time,
      date: time.slice(0, 10),
      hour: Number(time.slice(11, 13)),
      temp: h.temperature_2m[i],
      feels: h.apparent_temperature[i],
      dew: h.dew_point_2m[i],
      pop: h.precipitation_probability[i],
      precip: h.precipitation[i],
      code: h.weather_code[i],
      wind: h.wind_speed_10m[i],
      uv: h.uv_index[i],
      isDay: h.is_day[i],
      cloud: h.cloud_cover[i],
    };
    hour.light = daylight(hour, sun[hour.date]) ?? hour.isDay;
    return Object.assign(hour, runScore(hour, state.prefs));
  });

  // Times come back in the location's local time, so compare against "now" in that zone too.
  const nowKey = new Date(Date.now() + raw.utc_offset_seconds * 1000).toISOString().slice(0, 13);

  const days = d.time.map((date, i) => {
    const upcoming = hours.filter((x) => x.date === date && x.time.slice(0, 13) >= nowKey);
    return {
      date,
      code: d.weather_code[i],
      max: d.temperature_2m_max[i],
      min: d.temperature_2m_min[i],
      pop: d.precipitation_probability_max[i],
      precip: d.precipitation_sum[i],
      wind: d.wind_speed_10m_max[i],
      uv: d.uv_index_max[i],
      sunrise: d.sunrise[i],
      sunset: d.sunset[i],
      hours: upcoming,
    };
  });

  return { days };
}

// The user's run window for a day as start hours, resolving 'sunrise'/'sunset' from the forecast.
function runWindow(d) {
  const { from, to } = state.prefs;
  return {
    from: from === 'sunrise' ? (d.sunrise ? Number(d.sunrise.slice(11, 13)) : 6) : from,
    to: to === 'sunset' ? (d.sunset ? Number(d.sunset.slice(11, 13)) : 20) : to,
  };
}

function describeWindow() {
  const { from, to } = state.prefs;
  return `${from === 'sunrise' ? 'sunrise' : fmtHour(from)} to ${to === 'sunset' ? 'sunset' : fmtHour(to)}`;
}

function inRunWindow(hour, d) {
  const { from, to } = runWindow(d);
  return from <= to ? hour >= from && hour <= to : hour >= from || hour <= to; // from > to wraps past midnight
}

// Best-scoring hour inside the run window (earliest wins ties).
function bestHour(d) {
  return d.hours
    .filter((h) => h.score != null && inRunWindow(h.hour, d))
    .reduce((best, h) => (!best || h.score > best.score ? h : best), null);
}

// ---------- Formatting ----------

const imperial = () => state.units === 'imperial';

function temp(c) {
  if (c == null) return '–';
  return `${Math.round(imperial() ? (c * 9) / 5 + 32 : c)}°`;
}

function amount(mm, withUnit = true) {
  if (!mm) return '';
  const unit = imperial() ? 'in' : 'mm';
  const v = imperial() ? mm / 25.4 : mm;
  const s = imperial() ? (v < 0.01 ? '<0.01' : v.toFixed(2)) : (v < 0.1 ? '<0.1' : v.toFixed(1));
  return withUnit ? `${s} ${unit}` : s;
}

function speed(kmh, withUnit = true) {
  if (kmh == null) return '–';
  const v = Math.round(imperial() ? kmh / 1.609344 : kmh);
  return withUnit ? `${v} ${speedUnit()}` : String(v);
}

const speedUnit = () => (imperial() ? 'mph' : 'km/h');
const pct = (p) => (p == null ? '–' : `${p}%`);

function fmtHour(h) {
  if (!imperial()) return `${String(h).padStart(2, '0')}:00`;
  return `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;
}

function fmtClock(iso) {
  if (!iso) return '–';
  const h = Number(iso.slice(11, 13));
  if (!imperial()) return iso.slice(11, 16);
  return `${h % 12 || 12}:${iso.slice(14, 16)} ${h < 12 ? 'AM' : 'PM'}`;
}

function dateObj(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function wx(code, isDay = 1) {
  const [label, day, night] = WMO[code] || ['Unknown', '❔'];
  return { label, icon: !isDay && night ? night : day };
}

function scoreClass(s) {
  if (s == null) return '';
  return s >= 80 ? 'great' : s >= 60 ? 'good' : s >= 40 ? 'fair' : 'poor';
}

// ---------- Rendering ----------

const samePlace = (a, b) => !!a && !!b && a.lat === b.lat && a.lon === b.lon;

function render() {
  const homeBtn = $('#home');
  homeBtn.disabled = !state.home;
  const atHome = samePlace(state.home, state.place);
  homeBtn.classList.toggle('on', atHome);
  homeBtn.title = !state.home ? 'No home yet. Tap "Set as home" on a city.'
    : atHome ? `You're viewing home: ${state.home.name}`
    : `Go to home: ${state.home.name}`;
  if (!state.data) return;

  const { days } = state.data;
  for (const d of days) d.best = bestHour(d); // depends on the run-hours preference, so computed per render
  const lo = Math.min(...days.map((d) => d.min ?? Infinity));
  const hi = Math.max(...days.map((d) => d.max ?? -Infinity));

  $('#days').innerHTML = days.map((d, i) => dayRow(d, i, lo, hi)).join('');
  $('#detail').innerHTML = detail(days[state.selected], state.selected);
  $('#content').hidden = false;
}

function dayRow(d, i, lo, hi) {
  const w = wx(d.code);
  const span = hi - lo || 1;
  const left = ((d.min - lo) / span) * 100;
  const width = ((d.max - d.min) / span) * 100;
  const date = dateObj(d.date);
  const name = i === 0 ? 'Today' : date.toLocaleDateString(undefined, { weekday: 'short' });
  const best = d.best
    ? `<span class="chip ${scoreClass(d.best.score)}" title="Best time to run · score ${d.best.score}">${fmtHour(d.best.hour)}</span>`
    : '<span></span>';

  return `<li><button class="day${i === state.selected ? ' selected' : ''}" data-i="${i}">
    <span class="d-name">${name}<small>${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</small></span>
    <span class="d-icon" title="${w.label}">${w.icon}</span>
    <span class="d-rain${(d.pop ?? 0) < 20 ? ' dry' : ''}">${pct(d.pop)}<small>${amount(d.precip)}</small></span>
    <span class="d-lo">${temp(d.min)}</span>
    <span class="d-bar"><span style="left:${left}%;width:${width}%"></span></span>
    <span class="d-hi">${temp(d.max)}</span>
    ${best}
  </button></li>`;
}

function detail(d, index) {
  const w = wx(d.code);
  const when = dateObj(d.date).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const rows = d.hours.map((h) => hourRow(h, h === d.best, inRunWindow(h.hour, d))).join('');
  const isHome = samePlace(state.home, state.place);

  return `
    <div class="place-row">
      <div class="place">${isHome ? '<span title="Your home">🏠</span> ' : ''}${esc(state.place.name)}</div>
      <button class="btn home-btn" data-action="toggle-home"
        title="${isHome ? 'Stop opening this city when the app starts' : 'Open this city when the app starts'}">
        ${isHome ? 'Remove as home' : 'Set as home'}
      </button>
    </div>
    <div class="date">${when}</div>
    <div class="summary">
      <div class="big-icon">${w.icon}</div>
      <div>
        <div class="big-temp">${temp(d.max)} <span class="lo">/ ${temp(d.min)}</span></div>
        <div>${w.label}</div>
      </div>
    </div>
    <div class="facts">
      <span>Rain chance <b>${pct(d.pop)}</b></span>
      <span>Total <b>${amount(d.precip) || 'none'}</b></span>
      <span>Max wind <b>${speed(d.wind)}</b></span>
      <span>UV <b>${d.uv == null ? '–' : Math.round(d.uv)}</b></span>
      <span>Sunrise <b>${fmtClock(d.sunrise)}</b></span>
      <span>Sunset <b>${fmtClock(d.sunset)}</b></span>
    </div>
    ${bestBlock(d, index)}
    <h3>Hourly</h3>
    <div class="hours">
      <div class="hour hdr">
        <span>Time</span><span></span><span>Temp</span><span>Feels</span><span>Rain</span>
        <span>Amt<small>${imperial() ? 'in' : 'mm'}</small></span>
        <span class="c-wind">Wind<small>${speedUnit()}</small></span>
        <span class="c-dew">Dew</span>
        <span class="run"><button class="link-btn" data-action="score-help" aria-label="What's the run score?">Run ⓘ</button></span>
      </div>
      ${rows}
    </div>`;
}

function bestBlock(d, index) {
  if (!d.best) {
    const msg = index === 0 ? 'No hours left in your run window today. Check tomorrow.' : 'No hours in your run window this day.';
    return `<div class="best">🏃 ${msg}
      <button class="link-btn" data-action="score-help">What's the run score?</button></div>`;
  }
  const b = d.best;
  const c = scoreClass(b.score);
  return `<div class="best">
    <span>🏃 Best time to run: <strong>${fmtHour(b.hour)}</strong></span>
    <span class="muted">${temp(b.temp)}, feels ${temp(b.feels)} · ${pct(b.pop)} rain</span>
    <span class="chip ${c}">${SCORE_LABEL[c]} · ${b.score}</span>
    <button class="link-btn" data-action="score-help" data-time="${b.time}">What's the run score?</button>
  </div>`;
}

function hourRow(h, isBest, inWindow) {
  const w = wx(h.code, h.isDay);
  const c = scoreClass(h.score);
  const score = h.score == null ? '' : `<button class="score-btn" data-action="score-help" data-time="${h.time}"
    aria-label="Run score ${h.score}, show breakdown"><span class="dot ${c}"></span>${h.score}</button>`;
  return `<div class="hour${inWindow ? '' : ' outside'}${isBest ? ' best-hour' : ''}">
    <span>${fmtHour(h.hour)}</span>
    <span title="${w.label}">${w.icon}</span>
    <span>${temp(h.temp)}</span>
    <span class="muted">${temp(h.feels)}</span>
    <span class="pop"><span class="bar"><i style="width:${h.pop ?? 0}%"></i></span><span>${pct(h.pop)}</span></span>
    <span class="muted">${amount(h.precip, false)}</span>
    <span class="c-wind">${speed(h.wind, false)}</span>
    <span class="c-dew muted">${temp(h.dew)}</span>
    <span class="run" title="${SCORE_LABEL[c] || ''}">${score}</span>
  </div>`;
}

const PENALTY_LABEL = {
  cold: (v) => `Cold: feels like ${temp(v)}`,
  heat: (v, p) => (p.dry > p.humid
    ? `Dry heat: ${temp(v)}`
    : `Heat + humidity: ${temp(v)}, dew point ${temp(p.dew)}`),
  rain: (v, p) => `Rain: ${v}% chance${p.mm ? `, ${amount(p.mm)} expected` : ''}`,
  wind: (v) => `Windy: ${speed(v)}`,
  uv: (v) => `High UV index: ${Math.round(v)}`,
  cloud: (v) => `Not sunny: ${v}% cloud cover`,
  dark: (v) => (v > 0 ? `Partly dark: ${Math.round((1 - v) * 60)} min of the hour before sunrise or after sunset` : 'Dark: sun is down'),
  storm: () => 'Thunderstorms',
};

function scoreHelp(hour) {
  return `
    ${hour ? breakdown(hour) : ''}
    <p>A 0–100 rating of how comfortable an hour should be for a run. Every hour starts at 100
      and loses points for weather outside ideal running conditions. The further outside, the bigger the deduction.</p>
    <ul class="factors">
      <li><b>Cold</b>: feels-like temperature below ${temp(TERMS.cold.limit)} (feels-like includes wind chill).</li>
      <li><b>Heat &amp; humidity</b>: one combined deduction based on the runners' temp + dew point rule,
        so muggy weather isn't penalized twice. It starts once the expected slowdown passes ${HEAT.deadZone}%,
        since less than that isn't noticeable. Very hot, dry air (above ${temp(HEAT.dryLimit)}) has its
        own check, and whichever is worse counts.</li>
      <li><b>Rain</b>: one combined deduction. Chances up to ${RAIN.chanceLimit}% are free; above that it grows
        with the chance, to about ${roundPts(RAIN.chanceRate * (100 - RAIN.chanceLimit))} points at 100%. If rain is actually forecast, the amount
        counts instead when it's worse: from ${RAIN.amountBase} points for a trace up to ${RAIN.amountCap}
        for a downpour. Chance and amount never stack.</li>
      <li><b>Wind</b> above ${speed(TERMS.wind.limit)}.</li>
      <li><b>UV index</b> above ${TERMS.uv.limit}.</li>
      <li><b>Clouds</b> (only with "Prefer sun" on in ⚙️ Preferences, currently ${state.prefs.preferSun ? 'on' : 'off'}):
        a mild deduction for not being sunny, up to ${LIGHT.cloudPts} points for full overcast. Only counts while the sun is up.</li>
      <li><b>Darkness</b>: a mild ${LIGHT.darkPts} points when the sun is down, partial for the hour of sunrise or sunset.</li>
      <li><b>Thunderstorms</b>: a large deduction, because lightning is a safety risk.</li>
    </ul>
    <div class="bands">
      <span class="chip great">Great · 80–100</span>
      <span class="chip good">Good · 60–79</span>
      <span class="chip fair">Fair · 40–59</span>
      <span class="chip poor">Poor · 0–39</span>
    </div>
    <p class="muted">"Best time to run" is the highest-scoring hour in your run hours, currently ${describeWindow()}
      (the earliest wins a tie). Change them in ⚙️ Preferences.
      Tap any hour's score to see its breakdown.</p>
    ${formula()}`;
}

// ----- Score math, rendered in display units -----

const SYMBOL = { feels: 'T<sub>feels</sub>', pop: 'P<sub>rain</sub>', precip: 'R', wind: 'W', uv: 'UV' };

// Linear conversion from metric to display units: display = metric × k + offset.
function unitsFor(dim) {
  const imp = imperial();
  return {
    temp: imp ? { k: 1.8, offset: 32, unit: '°F', digits: 1 } : { k: 1, offset: 0, unit: '°C', digits: 1 },
    precip: imp ? { k: 1 / 25.4, offset: 0, unit: 'in/h', digits: 3 } : { k: 1, offset: 0, unit: 'mm/h', digits: 2 },
    speed: imp ? { k: 1 / 1.609344, offset: 0, unit: 'mph', digits: 1 } : { k: 1, offset: 0, unit: 'km/h', digits: 1 },
    pct: { k: 1, offset: 0, unit: '%', digits: 0 },
    uv: { k: 1, offset: 0, unit: '', digits: 1 },
  }[dim];
}

const num = (n, digits = 2) => String(Number(n.toFixed(digits)));

// A term as math in display units. `x` is the variable symbol, or a value for worked examples.
function termExpr(kind, x) {
  const t = TERMS[kind];
  const u = unitsFor(t.dim);
  const rate = num(t.rate / u.k);
  const limit = num(t.limit * u.k + u.offset, 1);
  const diff = t.below ? `${limit} − ${x}` : `${x} − ${limit}`;
  const e = t.limit === 0 ? `${rate} · ${x}` : `${rate} · max(0, ${diff})`;
  return t.cap ? `min(${t.cap}, ${e})` : e;
}

// The dry-heat expression in display units, with `x` as the symbol or a value.
function dryHeatExpr(x) {
  const u = unitsFor('temp');
  return `${num(HEAT.dryRate / u.k)} · max(0, ${x} − ${num(HEAT.dryLimit * u.k + u.offset, 1)})`;
}

// Rain expressions in display units, with `p` (chance) and `r` (amount) as symbols or values.
const rainChanceExpr = (p) => `${RAIN.chanceRate} · max(0, ${p} − ${RAIN.chanceLimit})`;
function rainAmountExpr(r) {
  const u = unitsFor('precip');
  return `min(${RAIN.amountCap}, ${RAIN.amountBase} + ${num(RAIN.amountRate / u.k)} · ${r})`;
}

// Light expressions, with `l` (daylight share) and `n` (cloud cover) as symbols or values.
const cloudExpr = (l, n) => `${LIGHT.cloudPts} · ${l} · ${n} / 100`;
const darkExpr = (l) => `${LIGHT.darkPts} · (1 − ${l})`;

function formula() {
  const row = (name, expr) => `<tr><td>${name}</td><td>= ${expr}</td></tr>`;
  const termRows = (kinds) => kinds.map((k) => row(`D<sub>${k}</sub>`, termExpr(k, SYMBOL[TERMS[k].input]))).join('');
  const t = unitsFor('temp');
  return `<div class="nerd">
    <h3>🤓 The formula</h3>
    <div class="formula">S = max(0, 100 − Σ<sub>i</sub> round(D<sub>i</sub>))</div>
    <div class="scroll-x"><table class="terms">
      ${termRows(['cold'])}
      ${row('D<sub>heat</sub>', 'max(H<sub>humid</sub>, H<sub>dry</sub>)')}
      ${row('H<sub>humid</sub>', `${HEAT.ptsPerPct} · max(0, slowdown(T<sub>air</sub> + T<sub>dew</sub>) − ${HEAT.deadZone})${imperial() ? '' : '  <span class="muted">sum in °F</span>'}`)}
      ${row('H<sub>dry</sub>', dryHeatExpr('T<sub>air</sub>'))}
      ${row('D<sub>rain</sub>', 'max(C<sub>rain</sub>, A<sub>rain</sub>)')}
      ${row('C<sub>rain</sub>', rainChanceExpr('P<sub>rain</sub>'))}
      ${row('A<sub>rain</sub>', `[R &gt; 0] · ${rainAmountExpr('R')}`)}
      ${termRows(['wind', 'uv'])}
      ${row('D<sub>cloud</sub>', `[prefer sun] · ${cloudExpr('L', 'N')}`)}
      ${row('D<sub>dark</sub>', darkExpr('L'))}
      ${row('D<sub>storm</sub>', `${STORM.pts} · [WMO code ≥ ${STORM.minCode}]`)}
    </table></div>
    <p class="muted small">Why add temperature and dew point? Air temperature limits how much heat you can shed
      to the air, and dew point limits how well sweat evaporates, so their sum (in °F) is a rough single measure
      of how hard it is to stay cool. slowdown(x) maps that sum to an expected pace slowdown using running coach
      Mark Hadley's chart<sup>1</sup>, linear between these points and continuing at the last slope past 180:</p>
    <div class="scroll-x"><table class="curve">
      <tr><th>T<sub>air</sub> + T<sub>dew</sub></th>${SLOWDOWN_CURVE.map(([x]) => `<td>${x}</td>`).join('')}</tr>
      <tr><th>slowdown</th>${SLOWDOWN_CURVE.map(([, y]) => `<td>${y}%</td>`).join('')}</tr>
    </table></div>
    <p class="muted small">
      T<sub>air</sub> = air temperature, T<sub>feels</sub> = apparent temperature, T<sub>dew</sub> = dew point (${t.unit}) ·
      P<sub>rain</sub> = precipitation probability (%) · R = precipitation (${unitsFor('precip').unit}) ·
      W = wind speed at 10 m (${unitsFor('speed').unit}) · UV = UV index · N = cloud cover (%) ·
      L = share of the hour between sunrise and sunset (0–1) · [prefer sun] = the Preferences setting
      (currently ${state.prefs.preferSun ? 'on' : 'off'}) · [x] = 1 if true, else 0.
      ${imperial() ? 'The model runs in metric, so some coefficients above are conversions, which is why they aren\'t round numbers.' : ''}
    </p>
    <p class="muted small">
      Design notes: most terms are linear "hinge" functions, zero inside the comfort zone and growing with
      distance outside it. Heat and rain chance have small free zones too (slowdown under ${HEAT.deadZone}%,
      chance up to ${RAIN.chanceLimit}%), so tiny forecast blips don't cost points. Heat is the exception: heat and humidity are one physiological problem (shedding
      heat), so they share one term and the worse of humid or dry heat counts, rather than stacking two
      penalties for the same thing. Marathon results show times slowing steadily as combined heat stress
      rises<sup>2</sup>. Heat uses air temperature, not feels-like, because feels-like already folds
      in humidity. Clouds and darkness are deliberately mild preferences rather than hazards, and clouds
      are weighted by L so they only count when there's sun to hide. Rain works the same way: chance (the share of forecast-model runs showing rain) and amount
      (the single best-guess forecast) describe the same rain, so the worse of the two counts. Each term is
      rounded before summing so the breakdown adds up exactly.
    </p>
    <ol class="sources muted small">
      <li>Mark Hadley, <a href="https://maximumperformancerunning.blogspot.com" target="_blank" rel="noopener">Maximum
        Performance Running</a>. Temperature + dew point pace adjustment chart; bands as commonly reproduced
        (the chart is part of his training guides rather than a public post).</li>
      <li>Ely, Cheuvront, Roberts &amp; Montain (2007).
        <a href="https://doi.org/10.1249/mss.0b013e31802d3aba" target="_blank" rel="noopener">Impact of weather on
        marathon-running performance</a>. <i>Medicine &amp; Science in Sports &amp; Exercise</i> 39(3), 487–493.
        Across seven marathons, finishing times slowed progressively as wet-bulb globe temperature rose from 5 to 25°C.</li>
    </ol>
  </div>`;
}

function heatMath(p) {
  const u = unitsFor('temp');
  const t = num(p.value * u.k + u.offset, 1);
  const lines = [];
  if (p.sumF != null) {
    const d = num(p.dew * u.k + u.offset, 1);
    const sum = imperial() ? `${t} + ${d} = ${num(p.sumF, 0)}` : `${t}°C + ${d}°C = ${num(p.sumF, 0)}°F`;
    const excess = Math.max(0, p.slowdown - HEAT.deadZone);
    lines.push(`H<sub>humid</sub> = ${HEAT.ptsPerPct} · max(0, slowdown(${sum}) − ${HEAT.deadZone})`
      + ` = ${HEAT.ptsPerPct} · max(0, ${num(p.slowdown)} − ${HEAT.deadZone}) = ${HEAT.ptsPerPct} · ${num(excess)} = ${num(p.humid)}`);
  }
  lines.push(`H<sub>dry</sub> = ${dryHeatExpr(t)} = ${num(p.dry)}`);
  const rounded = num(p.raw) === String(p.pts) ? '' : ` → ${p.pts}`;
  lines.push(`D<sub>heat</sub> = max(${num(p.humid)}, ${num(p.dry)}) = ${num(p.raw)}${rounded}`);
  return lines.join('<br>');
}

function rainMath(p) {
  const u = unitsFor('precip');
  const r = num(p.mm * u.k, u.digits);
  const rounded = num(p.raw) === String(p.pts) ? '' : ` → ${p.pts}`;
  return [
    `C<sub>rain</sub> = ${rainChanceExpr(p.value)} = ${RAIN.chanceRate} · ${Math.max(0, p.value - RAIN.chanceLimit)} = ${num(p.chance)}`,
    `A<sub>rain</sub> = ${p.mm > 0 ? `${rainAmountExpr(r)} = ${num(p.amt)}` : '0 (no rain expected)'}`,
    `D<sub>rain</sub> = max(${num(p.chance)}, ${num(p.amt)}) = ${num(p.raw)}${rounded}`,
  ].join('<br>');
}

function workedMath(p) {
  if (p.kind === 'storm') return `D<sub>storm</sub> = ${STORM.pts} · [WMO ${p.value ?? '–'} ≥ ${STORM.minCode}] = ${p.pts}`;
  if (p.kind === 'heat') return heatMath(p);
  if (p.kind === 'rain') return rainMath(p);
  const rounded = num(p.raw) === String(p.pts) ? '' : ` → ${p.pts}`;
  if (p.kind === 'cloud') return `D<sub>cloud</sub> = ${cloudExpr(num(p.light), p.value)} = ${num(p.raw)}${rounded}`;
  if (p.kind === 'dark') return `D<sub>dark</sub> = ${darkExpr(num(p.value))} = ${num(p.raw)}${rounded}`;
  const t = TERMS[p.kind];
  const u = unitsFor(t.dim);
  const x = num(p.value * u.k + u.offset, u.digits);
  // Show the clamped distance past the limit as its own step, so a zero reads as "inside the comfort zone".
  const step = t.cap || t.limit === 0 ? '' : ` = ${num(t.rate / u.k)} · ${num(p.excess * u.k, u.digits)}`;
  return `D<sub>${p.kind}</sub> = ${termExpr(p.kind, x)}${step} = ${num(p.raw)}${rounded}`;
}

function tempDewRule(h) {
  if (h.temp == null || h.dew == null) return '';
  const sum = toF(h.temp) + toF(h.dew);
  const pct = slowdownPct(sum);
  const effect = pct === 0
    ? 'little to no pace impact'
    : `about ${num(pct, 1)}% slower pace${sum > 180 ? ', hard running not recommended' : ''}`;
  return `<div class="rule">
    Temp + dew point = <b>${Math.round(sum)}</b> (°F) → <b>${effect}</b>
    <span class="muted">· Mark Hadley's runners' rule of thumb, used in the heat term (sources below)</span>
  </div>`;
}

function breakdown(h) {
  const c = scoreClass(h.score);
  const when = `${dateObj(h.date).toLocaleDateString(undefined, { weekday: 'long' })}, ${fmtHour(h.hour)}`;
  const deductions = h.penalties.filter((p) => p.pts > 0);
  const items = deductions.length
    ? deductions.map((p) => `<li><span>${PENALTY_LABEL[p.kind](p.value, p)}</span><span class="pts">−${p.pts}</span></li>`).join('')
    : '<li class="muted">Ideal conditions, no deductions</li>';
  const sum = h.penalties.map((p) => p.pts).join(' + ') || '0';
  // Worked math stays available but collapsed, so the summary reads at a glance.
  return `<div class="breakdown">
    <div class="bd-head"><strong>${when}</strong><span class="chip ${c}">${SCORE_LABEL[c]} · ${h.score}</span></div>
    <div class="muted">${temp(h.temp)}, feels like ${temp(h.feels)} · ${wx(h.code, h.isDay).label}</div>
    <ul>${items}</ul>
    <details class="bd-math">
      <summary>Show the math</summary>
      ${h.penalties.map((p) => `<div class="math">${workedMath(p)}</div>`).join('')}
      <div class="math total">S = max(0, 100 − (${sum})) = ${h.score}</div>
      ${tempDewRule(h)}
    </details>
  </div>`;
}

function openScoreHelp(time) {
  const hour = time && state.data.days[state.selected].hours.find((h) => h.time === time);
  $('#score-help-body').innerHTML = scoreHelp(hour);
  $('#score-help').showModal();
  $('#score-help').scrollTop = 0; // always start at the top, even if last opened scrolled down
}

function showStatus(msg) {
  const el = $('#status');
  el.textContent = msg;
  el.hidden = !msg;
}

// ---------- Actions ----------

let refreshSeq = 0;

// Loads the forecast for state.place. A quiet refresh (the periodic background update) shows no
// loading message, keeps the selected day by date, and leaves the current data up if it fails.
async function refresh({ quiet = false } = {}) {
  const seq = ++refreshSeq;
  if (!quiet) showStatus('Loading forecast…');
  try {
    const data = await fetchForecast(state.place);
    if (seq !== refreshSeq) return; // superseded, e.g. the user switched cities meanwhile
    if (quiet) {
      const selectedDate = state.data?.days[state.selected]?.date;
      state.selected = Math.max(0, data.days.findIndex((d) => d.date === selectedDate));
    }
    state.data = data;
    state.fetchedAt = Date.now();
    $('#updated').textContent = `Updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · `;
    showStatus('');
    render();
  } catch (err) {
    if (seq !== refreshSeq) return;
    if (!quiet) showStatus(`Couldn't load the forecast: ${err.message}`);
    else $('#updated').textContent = $('#updated').textContent.replace(/( \(couldn't refresh\))? · $/, " (couldn't refresh) · ");
  }
}

function refreshIfStale() {
  if (document.visibilityState === 'visible' && state.fetchedAt && Date.now() - state.fetchedAt >= STALE_MS) {
    refresh({ quiet: true });
  }
}

function setPlace(place) {
  state.place = place;
  state.selected = 0;
  save('place', place);
  $('#loc-prompt').hidden = true; // a chosen place answers the first-visit prompt
  refresh();
}

// First visit: guess the city from the visitor's IP via the Netlify edge function
// (netlify/edge-functions/geo.js). Returns null when unavailable, e.g. on localhost.
async function guessPlace() {
  try {
    const res = await fetch('/api/geo', { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const g = await res.json();
    if (g.lat == null || g.lon == null) return null;
    return {
      name: [g.city, g.region].filter(Boolean).join(', ') || 'Near you',
      lat: Number(Number(g.lat).toFixed(3)),
      lon: Number(Number(g.lon).toFixed(3)),
      approx: true,
    };
  } catch {
    return null;
  }
}

// First visit (nothing saved): use location right away if the browser already allows it,
// otherwise offer it in a banner. The banner's tap is what triggers the browser's own prompt.
async function offerLocation() {
  if (load('home') || load('place') || load('locPromptDismissed') || !navigator.geolocation) return;
  try {
    const perm = await navigator.permissions?.query({ name: 'geolocation' });
    if (perm?.state === 'granted') return locate();
    if (perm?.state === 'denied') return;
  } catch { /* Permissions API unsupported; fall through to the banner */ }
  const city = esc(state.place.name.split(',')[0]);
  $('#loc-msg').innerHTML = state.place.approx
    ? `📍 Showing <b>${city}</b>, a guess based on your network. Use your precise location?`
    : `📍 Showing <b>${city}</b>. Use your location for a local forecast?`;
  $('#loc-prompt').hidden = false;
}

// Fills the Preferences dialog from state. Safe to call while it's closed.
function renderPrefs() {
  for (const radio of document.querySelectorAll('input[name="units"]')) radio.checked = radio.value === state.units;

  const elsewhere = !samePlace(state.home, state.place);
  const useHere = elsewhere
    ? `<button type="button" class="link-btn" data-action="home-here">Use ${esc(state.place.name)}</button>`
    : '';
  $('#home-current').innerHTML = state.home
    ? `<span>🏠 <b>${esc(state.home.name)}</b></span>
       <button type="button" class="link-btn" data-action="home-remove">Remove</button>${useHere}`
    : `<span class="muted">No home set.</span>${useHere}`;

  // Hour labels follow the unit system (12h for °F, 24h for °C), so rebuild them.
  const hours = Array.from({ length: 24 }, (_, h) => `<option value="${h}">${fmtHour(h)}</option>`).join('');
  $('#pref-from').innerHTML = `<option value="sunrise">Sunrise</option>${hours}`;
  $('#pref-to').innerHTML = `<option value="sunset">Sunset</option>${hours}`;
  $('#pref-from').value = String(state.prefs.from);
  $('#pref-to').value = String(state.prefs.to);
  $('#pref-sun').checked = !!state.prefs.preferSun;
}

function openPrefs() {
  renderPrefs();
  $('#prefs').showModal();
}

function setPrefs(prefs) {
  state.prefs = prefs;
  save('prefs', prefs);
  // Scores depend on preferSun, so rescore the loaded forecast rather than waiting for a refetch.
  for (const h of state.data?.days.flatMap((d) => d.hours) ?? []) Object.assign(h, runScore(h, prefs));
  render();
  renderPrefs();
}

function setUnits(units) {
  state.units = units;
  save('units', units);
  render();
  renderPrefs();
}

function setHome(place) {
  state.home = place;
  save('home', place);
  render();
  renderPrefs();
}

const parseHour = (v) => (/^\d+$/.test(v) ? Number(v) : v);

function toggleHome() {
  setHome(samePlace(state.home, state.place) ? null : state.place);
}

function locate() {
  if (!navigator.geolocation) {
    showStatus("Location isn't available in this browser. Search for a city instead.");
    return;
  }
  showStatus('Finding your location…');
  navigator.geolocation.getCurrentPosition(
    (pos) => setPlace({
      name: 'My location',
      lat: Number(pos.coords.latitude.toFixed(3)),
      lon: Number(pos.coords.longitude.toFixed(3)),
    }),
    (err) => showStatus(`Couldn't get your location (${err.message}). Search for a city instead.`),
    { timeout: 10000, maximumAge: 10 * 60 * 1000 },
  );
}

// Wires up a city search box. `root` holds an input and a .results list; `onPick` receives the
// chosen { name, lat, lon }. Used by the top bar and by the home setting in Preferences.
function citySearch(root, onPick) {
  const input = root.querySelector('input');
  const list = root.querySelector('.results');
  let timer;
  let seq = 0;
  let results = [];

  const hide = () => {
    seq++; // drop any search still in flight
    list.hidden = true;
  };

  async function search(q) {
    const mine = ++seq;
    try {
      const params = new URLSearchParams({ name: q, count: 6, language: 'en', format: 'json' });
      const data = await (await fetch(`${GEOCODE_URL}?${params}`)).json();
      if (mine !== seq) return; // a newer search is in flight
      results = data.results ?? [];
      list.innerHTML = results.length
        ? results.map((r, i) => `<li><button type="button" data-i="${i}">${esc(r.name)}
            <small>${esc([r.admin1, r.country].filter(Boolean).join(', '))}</small></button></li>`).join('')
        : '<li class="empty">No matches</li>';
      list.hidden = false;
    } catch {
      // Network hiccup while typing; the next keystroke will retry.
    }
  }

  function pick(i) {
    const r = results[i];
    if (!r) return;
    onPick({ name: [r.name, r.admin1].filter(Boolean).join(', '), lat: r.latitude, lon: r.longitude });
    input.value = '';
    hide();
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) return hide();
    timer = setTimeout(() => search(q), 250);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !list.hidden) {
      e.preventDefault(); // inside a dialog, close the list rather than the dialog
      hide();
    }
    if (e.key === 'Enter' && !list.hidden) {
      e.preventDefault();
      pick(0);
    }
  });
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (btn) pick(Number(btn.dataset.i));
  });
  document.addEventListener('click', (e) => {
    if (!root.contains(e.target)) hide();
  });
}

// ---------- Events ----------

citySearch($('#place-search'), setPlace);
citySearch($('#home-search'), setHome);

$('#days').addEventListener('click', (e) => {
  const btn = e.target.closest('.day');
  if (!btn) return;
  state.selected = Number(btn.dataset.i);
  render();
  if (matchMedia('(max-width: 800px)').matches) $('#detail').scrollIntoView({ behavior: 'smooth' });
});


$('#detail').addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  if (el.dataset.action === 'toggle-home') toggleHome();
  if (el.dataset.action === 'score-help') openScoreHelp(el.dataset.time);
});

// Close dialogs when clicking the backdrop.
for (const dialog of document.querySelectorAll('.sheet')) {
  dialog.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.close();
  });
}

$('#prefs-btn').addEventListener('click', openPrefs);
$('#pref-from').addEventListener('change', (e) => setPrefs({ ...state.prefs, from: parseHour(e.target.value) }));
$('#pref-to').addEventListener('change', (e) => setPrefs({ ...state.prefs, to: parseHour(e.target.value) }));
$('#pref-reset').addEventListener('click', () => setPrefs({ ...state.prefs, from: DEFAULT_PREFS.from, to: DEFAULT_PREFS.to }));
$('#pref-sun').addEventListener('change', (e) => setPrefs({ ...state.prefs, preferSun: e.target.checked }));

for (const radio of document.querySelectorAll('input[name="units"]')) {
  radio.addEventListener('change', () => setUnits(radio.value));
}

$('#home-current').addEventListener('click', (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'home-here') setHome(state.place);
  if (action === 'home-remove') setHome(null);
});

$('#home').addEventListener('click', () => setPlace(state.home));

$('#locate').addEventListener('click', locate);

// Keep the forecast current: check every minute, and as soon as a hidden tab comes back.
// Hidden tabs don't refresh, so a forgotten background tab costs nothing.
setInterval(refreshIfStale, 60 * 1000);
document.addEventListener('visibilitychange', refreshIfStale);

$('#loc-yes').addEventListener('click', () => {
  $('#loc-prompt').hidden = true;
  locate();
});

$('#loc-no').addEventListener('click', () => {
  $('#loc-prompt').hidden = true;
  save('locPromptDismissed', true);
});

render();
(async () => {
  if (!load('home') && !load('place')) state.place = (await guessPlace()) || FALLBACK_PLACE;
  refresh();
  offerLocation();
})();
