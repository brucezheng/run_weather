'use strict';

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const HOURLY = [
  'temperature_2m', 'apparent_temperature', 'dew_point_2m', 'precipitation_probability',
  'precipitation', 'weather_code', 'wind_speed_10m', 'uv_index', 'is_day',
];
const DAILY = [
  'weather_code', 'temperature_2m_max', 'temperature_2m_min', 'precipitation_probability_max',
  'precipitation_sum', 'wind_speed_10m_max', 'uv_index_max', 'sunrise', 'sunset',
];
const STALE_MS = 30 * 60 * 1000;
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
  data: null,
  fetchedAt: 0,
  selected: 0,
  results: [],
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
    };
    return Object.assign(hour, runScore(hour));
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
      best: bestHour(upcoming, d.sunrise[i], d.sunset[i]),
    };
  });

  return { days };
}

// Run score terms. Each deducts rate × (how far the input is past its limit), optionally capped.
// Values are metric (°C, mm/h, km/h); the explainer converts them to display units, so this
// table is the single source for both the score and the formula shown to the user.
const TERMS = {
  cold: { input: 'feels', dim: 'temp', limit: 7, below: true, rate: 3 }, // feels under ~45°F
  wind: { input: 'wind', dim: 'speed', limit: 20, rate: 1.2 }, // over ~12 mph
  uv: { input: 'uv', dim: 'uv', limit: 6, rate: 3 },
};
const STORM = { minCode: 95, pts: 40 }; // flat deduction for any thunderstorm code

// Heat and humidity are one problem for a runner (shedding heat), so they share a single
// deduction: the worse of humid heat (10 points per 1% of expected slowdown from the temp + dew
// point chart) and dry heat (2.5 points per °F of air temp over 75°F), which the chart underrates.
// Uses air temp, not feels-like, since feels-like already folds in humidity.
const HEAT = { ptsPerPct: 10, dryLimit: (75 - 32) / 1.8, dryRate: 2.5 * 1.8 };

// Runners' rule of thumb: air temp + dew point (°F) -> expected pace slowdown (%), using the top
// of each band of the popular chart. Linear between points, extended past 180 at the last slope.
const SLOWDOWN_CURVE = [[100, 0], [110, 0.5], [120, 1], [130, 2], [140, 3], [150, 4.5], [160, 6], [170, 8], [180, 10]];

// Chance and amount describe the same rain, so they share one deduction and the worse counts.
// Any chance at all costs at least chanceFloor (a truly dry 0% hour stands out), growing with the
// chance. Forecast rain costs amountBase for a trace, rising per mm/h up to amountCap: about −16
// for 0.06 in/h, −40 for a 0.3 in/h downpour.
const RAIN = { chanceFloor: 10, chanceRate: 0.15, amountBase: 10, amountRate: 4, amountCap: 40 };

function rainPenalty(h) {
  const pop = h.pop ?? 0;
  const mm = h.precip ?? 0;
  const chance = pop > 0 ? RAIN.chanceFloor + RAIN.chanceRate * pop : 0;
  const amt = mm > 0 ? Math.min(RAIN.amountCap, RAIN.amountBase + RAIN.amountRate * mm) : 0;
  const raw = Math.max(chance, amt);
  return { kind: 'rain', value: pop, mm, chance, amt, raw, pts: roundPts(raw) };
}

const toF = (c) => (c * 9) / 5 + 32;

// Round to whole points, ignoring float noise so 9.4999999 (really 9.5) rounds up like it displays.
const roundPts = (x) => Math.round(Number(x.toFixed(6)));

function slowdownPct(sumF) {
  if (sumF <= SLOWDOWN_CURVE[0][0]) return 0;
  const i = SLOWDOWN_CURVE.findIndex(([x]) => x >= sumF);
  const [[x0, y0], [x1, y1]] = i === -1 ? SLOWDOWN_CURVE.slice(-2) : [SLOWDOWN_CURVE[i - 1], SLOWDOWN_CURVE[i]];
  return y0 + ((sumF - x0) * (y1 - y0)) / (x1 - x0);
}

function heatPenalty(h) {
  if (h.temp == null) return null;
  const sumF = h.dew == null ? null : toF(h.temp) + toF(h.dew);
  const slowdown = sumF == null ? 0 : slowdownPct(sumF);
  const humid = HEAT.ptsPerPct * slowdown;
  const dry = Math.max(0, HEAT.dryRate * (h.temp - HEAT.dryLimit));
  const raw = Math.max(humid, dry);
  return { kind: 'heat', value: h.temp, dew: h.dew, sumF, slowdown, humid, dry, raw, pts: roundPts(raw) };
}

// 0–100 rating of how pleasant an hour is for a run: starts at 100 and loses points for each
// factor outside ideal conditions. Returns the deductions too so the UI can explain the score.
function runScore(h) {
  if (h.feels == null) return { score: null, penalties: [] };
  const penalties = [];
  const heat = heatPenalty(h);
  if (heat?.pts > 0) penalties.push(heat);
  const rain = rainPenalty(h);
  if (rain.pts > 0) penalties.push(rain);
  for (const [kind, t] of Object.entries(TERMS)) {
    const value = h[t.input] ?? 0;
    const excess = t.below ? t.limit - value : value - t.limit;
    const raw = Math.min(t.rate * excess, t.cap ?? Infinity);
    const pts = roundPts(raw);
    if (pts > 0) penalties.push({ kind, value, raw, pts });
  }
  if (h.code >= STORM.minCode) penalties.push({ kind: 'storm', value: h.code, raw: STORM.pts, pts: STORM.pts });
  const total = penalties.reduce((sum, p) => sum + p.pts, 0);
  return { score: Math.max(0, 100 - total), penalties };
}

// Best-scoring hour between sunrise and sunset (earliest wins ties).
function bestHour(hours, sunrise, sunset) {
  const from = sunrise ? Number(sunrise.slice(11, 13)) : 6;
  const to = sunset ? Number(sunset.slice(11, 13)) : 20;
  return hours
    .filter((h) => h.score != null && h.hour >= from && h.hour <= to)
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
  $('#units').textContent = imperial() ? '°F' : '°C';
  const homeBtn = $('#home');
  homeBtn.disabled = !state.home;
  const atHome = samePlace(state.home, state.place);
  homeBtn.classList.toggle('on', atHome);
  homeBtn.title = !state.home ? 'No home yet. Tap "Set as home" on a city.'
    : atHome ? `You're viewing home: ${state.home.name}`
    : `Go to home: ${state.home.name}`;
  if (!state.data) return;

  const { days } = state.data;
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
  const rows = d.hours.map((h) => hourRow(h, h === d.best)).join('');
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
    const msg = index === 0 ? 'No daylight hours left today. Check tomorrow.' : 'No run score available for this day.';
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

function hourRow(h, isBest) {
  const w = wx(h.code, h.isDay);
  const c = scoreClass(h.score);
  const score = h.score == null ? '' : `<button class="score-btn" data-action="score-help" data-time="${h.time}"
    aria-label="Run score ${h.score}, show breakdown"><span class="dot ${c}"></span>${h.score}</button>`;
  return `<div class="hour${h.isDay ? '' : ' night'}${isBest ? ' best-hour' : ''}">
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
        so muggy weather isn't penalized twice. Very hot, dry air (above ${temp(HEAT.dryLimit)}) has its
        own check, and whichever is worse counts.</li>
      <li><b>Rain</b>: one combined deduction. Any chance of rain costs at least ${RAIN.chanceFloor} points,
        growing with the chance, so a truly dry 0% hour stands out. If rain is actually forecast, the amount
        counts instead when it's worse: from ${RAIN.amountBase} points for a trace up to ${RAIN.amountCap}
        for a downpour. Chance and amount never stack.</li>
      <li><b>Wind</b> above ${speed(TERMS.wind.limit)}.</li>
      <li><b>UV index</b> above ${TERMS.uv.limit}.</li>
      <li><b>Thunderstorms</b>: a large deduction, because lightning is a safety risk.</li>
    </ul>
    <div class="bands">
      <span class="chip great">Great · 80–100</span>
      <span class="chip good">Good · 60–79</span>
      <span class="chip fair">Fair · 40–59</span>
      <span class="chip poor">Poor · 0–39</span>
    </div>
    <p class="muted">"Best time to run" is the highest-scoring hour between sunrise and sunset (the earliest wins a tie).
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
function termExpr(kind, x, worked = false) {
  const t = TERMS[kind];
  const u = unitsFor(t.dim);
  const rate = num(t.rate / u.k);
  const limit = num(t.limit * u.k + u.offset, 1);
  const diff = t.below ? `${limit} − ${x}` : `${x} − ${limit}`;
  const e = t.limit === 0 ? `${rate} · ${x}` : `${rate} · ${worked ? `(${diff})` : `max(0, ${diff})`}`;
  return t.cap ? `min(${t.cap}, ${e})` : e;
}

// The dry-heat expression in display units, with `x` as the symbol or a value.
function dryHeatExpr(x) {
  const u = unitsFor('temp');
  return `${num(HEAT.dryRate / u.k)} · max(0, ${x} − ${num(HEAT.dryLimit * u.k + u.offset, 1)})`;
}

// Rain expressions in display units, with `p` (chance) and `r` (amount) as symbols or values.
const rainChanceExpr = (p) => `${RAIN.chanceFloor} + ${RAIN.chanceRate} · ${p}`;
function rainAmountExpr(r) {
  const u = unitsFor('precip');
  return `min(${RAIN.amountCap}, ${RAIN.amountBase} + ${num(RAIN.amountRate / u.k)} · ${r})`;
}

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
      ${row('H<sub>humid</sub>', `${HEAT.ptsPerPct} · slowdown(T<sub>air</sub> + T<sub>dew</sub>)${imperial() ? '' : '  <span class="muted">sum in °F</span>'}`)}
      ${row('H<sub>dry</sub>', dryHeatExpr('T<sub>air</sub>'))}
      ${row('D<sub>rain</sub>', 'max(C<sub>rain</sub>, A<sub>rain</sub>)')}
      ${row('C<sub>rain</sub>', `[P<sub>rain</sub> &gt; 0] · (${rainChanceExpr('P<sub>rain</sub>')})`)}
      ${row('A<sub>rain</sub>', `[R &gt; 0] · ${rainAmountExpr('R')}`)}
      ${termRows(['wind', 'uv'])}
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
      W = wind speed at 10 m (${unitsFor('speed').unit}) · UV = UV index · [x] = 1 if true, else 0.
      ${imperial() ? 'The model runs in metric, so some coefficients above are conversions, which is why they aren\'t round numbers.' : ''}
    </p>
    <p class="muted small">
      Design notes: most terms are linear "hinge" functions, zero inside the comfort zone and growing with
      distance outside it. Heat is the exception: heat and humidity are one physiological problem (shedding
      heat), so they share one term and the worse of humid or dry heat counts, rather than stacking two
      penalties for the same thing. Marathon results show times slowing steadily as combined heat stress
      rises<sup>2</sup>. Heat uses air temperature, not feels-like, because feels-like already folds
      in humidity. Rain works the same way: chance (the share of forecast-model runs showing rain) and amount
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
    lines.push(`H<sub>humid</sub> = ${HEAT.ptsPerPct} · slowdown(${sum}) = ${HEAT.ptsPerPct} · ${num(p.slowdown)}% = ${num(p.humid, 1)}`);
  }
  lines.push(`H<sub>dry</sub> = ${dryHeatExpr(t)} = ${num(p.dry, 1)}`);
  const rounded = num(p.raw, 1) === String(p.pts) ? '' : ` → ${p.pts}`;
  lines.push(`max(${num(p.humid, 1)}, ${num(p.dry, 1)}) = ${num(p.raw, 1)}${rounded}`);
  return lines.join('<br>');
}

function rainMath(p) {
  const u = unitsFor('precip');
  const r = num(p.mm * u.k, u.digits);
  const rounded = num(p.raw, 1) === String(p.pts) ? '' : ` → ${p.pts}`;
  return [
    `C<sub>rain</sub> = ${p.value > 0 ? `${rainChanceExpr(p.value)} = ${num(p.chance, 1)}` : '0 (0% chance)'}`,
    `A<sub>rain</sub> = ${p.mm > 0 ? `${rainAmountExpr(r)} = ${num(p.amt, 1)}` : '0 (no rain expected)'}`,
    `max(${num(p.chance, 1)}, ${num(p.amt, 1)}) = ${num(p.raw, 1)}${rounded}`,
  ].join('<br>');
}

function workedMath(p) {
  if (p.kind === 'storm') return `${STORM.pts} · [${p.value} ≥ ${STORM.minCode}] = ${p.pts}`;
  if (p.kind === 'heat') return heatMath(p);
  if (p.kind === 'rain') return rainMath(p);
  const u = unitsFor(TERMS[p.kind].dim);
  const x = num(p.value * u.k + u.offset, u.digits);
  const rounded = num(p.raw, 1) === String(p.pts) ? '' : ` → ${p.pts}`;
  return `${termExpr(p.kind, x, true)} = ${num(p.raw, 1)}${rounded}`;
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
  const items = h.penalties.length
    ? h.penalties.map((p) => `<li>
        <span>${PENALTY_LABEL[p.kind](p.value, p)}<span class="math">${workedMath(p)}</span></span>
        <span class="pts">−${p.pts}</span>
      </li>`).join('')
    : '<li class="muted">Ideal conditions, no deductions</li>';
  const sum = h.penalties.map((p) => p.pts).join(' + ') || '0';
  return `<div class="breakdown">
    <div class="bd-head"><strong>${when}</strong><span class="chip ${c}">${SCORE_LABEL[c]} · ${h.score}</span></div>
    <div class="muted">${temp(h.temp)}, feels like ${temp(h.feels)} · ${wx(h.code, h.isDay).label}</div>
    <ul>${items}</ul>
    <div class="math total">S = max(0, 100 − (${sum})) = ${h.score}</div>
    ${tempDewRule(h)}
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

async function refresh() {
  showStatus('Loading forecast…');
  try {
    state.data = await fetchForecast(state.place);
    state.fetchedAt = Date.now();
    showStatus('');
    render();
  } catch (err) {
    showStatus(`Couldn't load the forecast: ${err.message}`);
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

function toggleHome() {
  state.home = samePlace(state.home, state.place) ? null : state.place;
  save('home', state.home);
  render();
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

let searchTimer;
let searchSeq = 0;

async function search(q) {
  const seq = ++searchSeq;
  try {
    const params = new URLSearchParams({ name: q, count: 6, language: 'en', format: 'json' });
    const res = await fetch(`${GEOCODE_URL}?${params}`);
    const { results = [] } = await res.json();
    if (seq !== searchSeq) return; // a newer search is in flight
    state.results = results;
    const ul = $('#results');
    ul.innerHTML = results.length
      ? results.map((r, i) => `<li><button data-i="${i}">${esc(r.name)}
          <small>${esc([r.admin1, r.country].filter(Boolean).join(', '))}</small></button></li>`).join('')
      : '<li class="empty">No matches</li>';
    ul.hidden = false;
  } catch {
    // Network hiccup while typing; the next keystroke will retry.
  }
}

function pickResult(i) {
  const r = state.results[i];
  if (!r) return;
  setPlace({ name: [r.name, r.admin1].filter(Boolean).join(', '), lat: r.latitude, lon: r.longitude });
  $('#search').value = '';
  hideResults();
}

function hideResults() {
  searchSeq++;
  $('#results').hidden = true;
}

// ---------- Events ----------

$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (q.length < 2) return hideResults();
  searchTimer = setTimeout(() => search(q), 250);
});

$('#search').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideResults();
  if (e.key === 'Enter' && !$('#results').hidden) pickResult(0);
});

$('#results').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (btn) pickResult(Number(btn.dataset.i));
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.search')) hideResults();
});

$('#days').addEventListener('click', (e) => {
  const btn = e.target.closest('.day');
  if (!btn) return;
  state.selected = Number(btn.dataset.i);
  render();
  if (matchMedia('(max-width: 800px)').matches) $('#detail').scrollIntoView({ behavior: 'smooth' });
});

$('#units').addEventListener('click', () => {
  state.units = imperial() ? 'metric' : 'imperial';
  save('units', state.units);
  render();
});

$('#detail').addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  if (el.dataset.action === 'toggle-home') toggleHome();
  if (el.dataset.action === 'score-help') openScoreHelp(el.dataset.time);
});

// Close the score dialog when clicking the backdrop.
$('#score-help').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.currentTarget.close();
});

$('#home').addEventListener('click', () => setPlace(state.home));

$('#locate').addEventListener('click', locate);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.place && Date.now() - state.fetchedAt > STALE_MS) refresh();
});

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
