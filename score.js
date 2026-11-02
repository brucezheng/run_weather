// Run score: pure functions and constants, shared by the page (loaded before app.js) and the tests.

// Share (0–1) of the hour starting at h.hour that falls between sunrise and sunset, so the hour
// the sun comes up counts as partly dark. Null when there's no usable sunrise/sunset that day
// (polar day or night), and the caller falls back to is_day.
function daylight(h, sun) {
  const mins = (t) => (t?.slice(0, 10) === h.date ? Number(t.slice(11, 13)) * 60 + Number(t.slice(14, 16)) : null);
  const rise = mins(sun?.rise);
  const set = mins(sun?.set);
  if (rise == null || set == null || set <= rise) return null;
  const start = h.hour * 60;
  return Math.max(0, Math.min(start + 60, set) - Math.max(start, rise)) / 60;
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

// Mild preferences for daylight and sun. Both scale with the share of the hour in daylight (L):
// darkness costs up to darkPts, and cloud cover costs up to cloudPts but only while the sun is up,
// so a night hour isn't also docked for clouds nobody would see. The cloud term is opt-in
// ("Prefer sun" in Preferences), since plenty of runners like overcast.
const LIGHT = { darkPts: 10, cloudPts: 10 };

// Heat and humidity are one problem for a runner (shedding heat), so they share a single
// deduction: the worse of humid heat (10 points per 1% of expected slowdown from the temp + dew
// point chart, past a dead zone of slowdown too small to notice) and dry heat (2.5 points per °F
// of air temp over 75°F), which the chart underrates. Uses air temp, not feels-like, since
// feels-like already folds in humidity.
const HEAT = { ptsPerPct: 10, deadZone: 0.5, dryLimit: (75 - 32) / 1.8, dryRate: 2.5 * 1.8 };

// Runners' rule of thumb: air temp + dew point (°F) -> expected pace slowdown (%), using the top
// of each band of the popular chart. Linear between points, extended past 180 at the last slope.
const SLOWDOWN_CURVE = [[100, 0], [110, 0.5], [120, 1], [130, 2], [140, 3], [150, 4.5], [160, 6], [170, 8], [180, 10]];

// Chance and amount describe the same rain, so they share one deduction and the worse counts.
// Chance costs chanceRate per point above chanceLimit, so low "maybe" chances are free: about −9
// at 50%, −21 at 100%. Forecast rain costs amountBase for a trace, rising per mm/h up to
// amountCap: about −16 for 0.06 in/h, −40 for a 0.3 in/h downpour.
const RAIN = { chanceLimit: 15, chanceRate: 0.25, amountBase: 10, amountRate: 4, amountCap: 40 };

function rainPenalty(h) {
  const pop = h.pop ?? 0;
  const mm = h.precip ?? 0;
  const chance = RAIN.chanceRate * Math.max(0, pop - RAIN.chanceLimit);
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
  const humid = HEAT.ptsPerPct * Math.max(0, slowdown - HEAT.deadZone);
  const dry = Math.max(0, HEAT.dryRate * (h.temp - HEAT.dryLimit));
  const raw = Math.max(humid, dry);
  return { kind: 'heat', value: h.temp, dew: h.dew, sumF, slowdown, humid, dry, raw, pts: roundPts(raw) };
}

// 0–100 rating of how pleasant an hour is for a run: starts at 100 and loses points for each
// factor outside ideal conditions. Returns every term, including ones worth 0 points, so the UI
// can show all the math; the summary hides the zeros. `opts.preferSun` turns on the cloud term.
function runScore(h, opts = {}) {
  if (h.feels == null) return { score: null, penalties: [] };
  const penalties = [];
  const heat = heatPenalty(h);
  if (heat) penalties.push(heat);
  penalties.push(rainPenalty(h));
  for (const [kind, t] of Object.entries(TERMS)) {
    const value = h[t.input] ?? 0;
    const excess = Math.max(0, t.below ? t.limit - value : value - t.limit);
    const raw = Math.min(t.rate * excess, t.cap ?? Infinity);
    penalties.push({ kind, value, excess, raw, pts: roundPts(raw) });
  }
  const light = h.light ?? 1;
  if (opts.preferSun) {
    const cloud = LIGHT.cloudPts * light * ((h.cloud ?? 0) / 100);
    penalties.push({ kind: 'cloud', value: h.cloud ?? 0, light, raw: cloud, pts: roundPts(cloud) });
  }
  const dark = LIGHT.darkPts * (1 - light);
  penalties.push({ kind: 'dark', value: light, raw: dark, pts: roundPts(dark) });
  const storm = h.code >= STORM.minCode ? STORM.pts : 0;
  penalties.push({ kind: 'storm', value: h.code, raw: storm, pts: storm });
  const total = penalties.reduce((sum, p) => sum + p.pts, 0);
  return { score: Math.max(0, 100 - total), penalties };
}

if (typeof module !== 'undefined') {
  module.exports = { runScore, daylight, slowdownPct, roundPts, TERMS, HEAT, RAIN, LIGHT, STORM };
}
