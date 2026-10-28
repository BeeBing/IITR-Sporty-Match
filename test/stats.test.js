'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, signUp, hostMatch } = require('./helpers');

let app;
test.before(async () => { app = await startApp(); });
test.after(async () => { await app.stop(); });

const grid = (rows, cols, hot = [0, 0]) => Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (__, c) => (r === hot[0] && c === hot[1] ? 100 : 0)));
const player = (label, extra = {}) => ({ label, distance: 123.456, swings: { overhead: 4, drive: 2, underarm: 7 }, heat: grid(14, 7, [2, 3]), ...extra });
const session = (extra = {}) => ({ court: 'badminton-doubles', durationSec: 905, players: [player('P1'), player('P3', { distance: 80 })], ...extra });

async function save(c, body) {
  await c.get('/stats');
  return c.upload('/stats', JSON.stringify(body), 'application/json');
}

test('the stats page needs a login and loads the on-device tracker', async () => {
  const anon = app.client();
  assert.match((await anon.get('/stats')).url, /^\/login/);
  const c = await signUp(app);
  const page = await c.get('/stats');
  assert.equal(page.status, 200);
  assert.match(page.text, /Court stats/);
  assert.match(page.text, /<script type="module" src="\/stats\/app.mjs">/);
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'/);
  assert.match(csp, /media-src 'self' blob:/);
});

test('the MediaPipe runtime and models are served', async () => {
  const c = app.client();
  const bundle = await c.getBuffer('/vendor/mediapipe/vision_bundle.mjs');
  assert.equal(bundle.status, 200);
  assert.match(bundle.headers.get('content-type'), /javascript/);
  const wasm = await c.getBuffer('/vendor/mediapipe/wasm/vision_wasm_internal.wasm');
  assert.equal(wasm.status, 200);
  assert.equal(wasm.headers.get('content-type'), 'application/wasm');
  for (const m of ['/models/efficientdet_lite0.tflite', '/models/pose_landmarker_lite.task']) {
    const r = await c.getBuffer(m);
    assert.equal(r.status, 200, m);
    assert.ok(r.body.length > 1_000_000, `${m} looks truncated`);
  }
  for (const m of ['court.mjs', 'tracker.mjs', 'vision.mjs', 'app.mjs']) assert.equal((await c.getBuffer(`/stats/${m}`)).status, 200);
});

test('a session saves and shows distances, swings and heat maps', async () => {
  const c = await signUp(app, { name: 'Meera Joshi' });
  const res = await save(c, session());
  assert.equal(res.status, 200);
  assert.ok(Number.isInteger(res.json.id));
  const page = await c.get(`/stats/${res.json.id}`);
  assert.match(page.text, /123\.5 <small>m covered/);
  assert.match(page.text, /80\.0 <small>m covered/);
  assert.match(page.text, /15:05 tracked/);
  assert.match(page.text, /recorded by Meera Joshi/);
  assert.match(page.text, /<dt>Lift \/ net<\/dt><dd>7<\/dd>/);
  assert.match(page.text, /fill-opacity="0.90"/, 'the hot cell is drawn');
  assert.match((await c.get('/stats')).text, new RegExp(`/stats/${res.json.id}`), 'listed under saved sessions');
});

test('bad payloads are rejected', async () => {
  const c = await signUp(app);
  const cases = [
    session({ court: 'quidditch' }),
    session({ durationSec: 0 }),
    session({ players: [] }),
    session({ players: [player('P1'), player('P2'), player('P3'), player('P4'), player('P5')] }),
    session({ players: [player('P1'), player('P1')] }),
    session({ players: [player('P1', { distance: -5 })] }),
    session({ players: [player('P1', { heat: grid(3, 3) })] }),
    session({ players: [player('P1', { swings: { overhead: 1.5, drive: 0, underarm: 0 } })] }),
    session({ players: [player('<script>')] }),
  ];
  for (const body of cases) {
    const res = await save(c, body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
    assert.ok(res.json.error);
  }
  await c.get('/stats');
  const forged = await c.upload('/stats', JSON.stringify(session()), 'application/json', { csrf: null });
  assert.equal(forged.status, 403);
});

test('stats are private to the recorder and the match players', async () => {
  const host = await signUp(app);
  const matchId = await hostMatch(host, { sport: 'badminton', format: 'doubles' });
  const mate = await signUp(app);
  await mate.post(`/matches/${matchId}/join`);
  const outsider = await signUp(app);

  assert.equal((await outsider.get(`/stats?match=${matchId}`)).status, 403);
  const linked = await save(host, session({ matchId }));
  assert.equal(linked.status, 200);
  const page = await mate.get(`/stats/${linked.json.id}`);
  assert.equal(page.status, 200, 'teammates can see it');
  assert.match(page.text, /Back to the match/);
  assert.equal((await outsider.get(`/stats/${linked.json.id}`)).status, 404);

  const matchPage = await mate.get(`/matches/${matchId}`);
  assert.match(matchPage.text, new RegExp(`/stats/${linked.json.id}`), 'listed on the match');
  assert.match(matchPage.text, new RegExp(`/stats\\?match=${matchId}`));

  const own = await save(outsider, session());
  assert.equal((await host.get(`/stats/${own.json.id}`)).status, 404, 'unlinked sessions stay private');
  const sneaky = await save(outsider, session({ matchId }));
  assert.equal(sneaky.status, 403, "can't attach stats to someone else's match");
});

test('team-sport courts have no swing counts', async () => {
  const c = await signUp(app);
  const heat = grid(18, 9);
  const res = await save(c, { court: 'volleyball', durationSec: 60, players: [{ label: 'P1', distance: 40, swings: { overhead: 3, drive: 0, underarm: 0 }, heat }] });
  assert.equal(res.status, 200);
  const page = await c.get(`/stats/${res.json.id}`);
  assert.doesNotMatch(page.text, /Overhead/);
});
