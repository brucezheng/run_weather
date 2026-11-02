// Run with: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const { runScore, daylight, slowdownPct } = require('../score.js');

const fToC = (f) => ((f - 32) * 5) / 9;

// A calm, dry, fully daylit hour; each test overrides what it cares about. Inputs are metric like
// the app's data (°C, %, mm/h, km/h), so °F cases go through fToC.
function hour(overrides = {}) {
  return {
    date: '2026-11-02', hour: 12,
    temp: fToC(60), feels: fToC(60), dew: fToC(40),
    pop: 0, precip: 0, code: 1, wind: 5, uv: 2, cloud: 0, light: 1,
    ...overrides,
  };
}

const pts = (result, kind) => result.penalties.find((p) => p.kind === kind)?.pts;

test('mild hour: 58°F, dew 51°F, 4% rain, 9% cloud, 6 min of dark → 99', () => {
  const sun = { rise: '2026-11-02T06:06', set: '2026-11-02T16:56' };
  const light = daylight({ date: '2026-11-02', hour: 6 }, sun);
  assert.equal(light, 0.9);

  const r = runScore(hour({ hour: 6, temp: fToC(58), feels: fToC(58), dew: fToC(51), pop: 4, cloud: 9, light }));
  assert.equal(pts(r, 'heat'), 0);
  assert.equal(pts(r, 'rain'), 0);
  assert.equal(pts(r, 'cloud'), undefined, 'cloud term is off by default');
  assert.equal(pts(r, 'dark'), 1);
  assert.equal(r.score, 99);
});

test('zero-point terms are still returned, for "Show the math"', () => {
  const r = runScore(hour());
  assert.deepEqual(r.penalties.map((p) => p.kind), ['heat', 'rain', 'cold', 'wind', 'uv', 'dark', 'storm']);
  assert.ok(r.penalties.every((p) => p.pts === 0));
  assert.equal(r.score, 100);
});

test('hot and humid: T 85°F, dew 70°F → humid heat 47.5 → 48 off', () => {
  const r = runScore(hour({ temp: fToC(85), feels: fToC(90), dew: fToC(70) }));
  const heat = r.penalties.find((p) => p.kind === 'heat');
  assert.ok(Math.abs(heat.slowdown - 5.25) < 1e-9);
  assert.ok(Math.abs(heat.humid - 47.5) < 1e-9);
  assert.ok(Math.abs(heat.dry - 25) < 1e-9);
  assert.equal(heat.pts, 48);
  assert.equal(r.score, 52);
});

test('heat dead zone: temp + dew point → humid heat points', () => {
  // [sum °F, expected H_humid]. Temp is kept under 75°F so dry heat stays at 0.
  for (const [sum, expected] of [[109, 0], [110, 0], [120, 5], [140, 25], [160, 55], [180, 95]]) {
    const r = runScore(hour({ temp: fToC(70), dew: fToC(sum - 70) }));
    const heat = r.penalties.find((p) => p.kind === 'heat');
    assert.ok(Math.abs(heat.humid - expected) < 1e-6, `sum ${sum}: got ${heat.humid}`);
    assert.equal(heat.pts, expected);
  }
  assert.equal(slowdownPct(109), 0.45);
});

test('rainy: 60% chance → 11 off; with 1 mm/h forecast the amount (14) counts instead', () => {
  const chanceOnly = runScore(hour({ pop: 60 }));
  assert.equal(pts(chanceOnly, 'rain'), 11);
  assert.equal(chanceOnly.score, 89);

  const withAmount = runScore(hour({ pop: 60, precip: 1 }));
  const rain = withAmount.penalties.find((p) => p.kind === 'rain');
  assert.equal(rain.chance, 11.25);
  assert.equal(rain.amt, 14);
  assert.equal(rain.pts, 14, 'chance and amount never stack');
  assert.equal(withAmount.score, 86);
});

test('rain chance threshold: chance → points', () => {
  for (const [pop, expected] of [[0, 0], [4, 0], [15, 0], [16, 0], [50, 9], [100, 21]]) {
    assert.equal(pts(runScore(hour({ pop })), 'rain'), expected, `${pop}%`);
  }
});

test('prefer sun turns on the cloud term, weighted by daylight', () => {
  assert.equal(pts(runScore(hour({ cloud: 100 }), { preferSun: true }), 'cloud'), 10);
  assert.equal(pts(runScore(hour({ cloud: 100, light: 0.5 }), { preferSun: true }), 'cloud'), 5);
  assert.equal(pts(runScore(hour({ cloud: 100, light: 0 }), { preferSun: true }), 'cloud'), 0);
  assert.equal(pts(runScore(hour({ cloud: 100 })), 'cloud'), undefined);
});

test('dark, storm, and missing data', () => {
  assert.equal(pts(runScore(hour({ light: 0 })), 'dark'), 10);
  assert.equal(pts(runScore(hour({ code: 95 })), 'storm'), 40);
  assert.deepEqual(runScore(hour({ feels: null })), { score: null, penalties: [] });
});

test('daylight: partial hours and polar fallback', () => {
  const sun = { rise: '2026-11-02T06:52', set: '2026-11-02T16:56' };
  const at = (h) => daylight({ date: '2026-11-02', hour: h }, sun);
  assert.equal(at(5), 0);
  assert.ok(Math.abs(at(6) - 8 / 60) < 1e-9);
  assert.equal(at(12), 1);
  assert.ok(Math.abs(at(16) - 56 / 60) < 1e-9);
  assert.equal(at(17), 0);
  assert.equal(daylight({ date: '2026-11-02', hour: 12 }, { rise: null, set: null }), null);
});
