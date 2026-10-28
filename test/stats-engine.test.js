'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const load = async () => ({
  ...(await import('../public/stats/court.mjs')),
  ...(await import('../public/stats/tracker.mjs')),
});

// A camera behind the near baseline, looking down the court: the far end looks narrower.
const TAPS = [[100, 900], [700, 900], [520, 300], [280, 300]];

test('calibration maps court corners onto the taps and back', async () => {
  const { COURTS, calibrate, apply, cornersOf } = await load();
  const court = COURTS['badminton-doubles'];
  const cal = calibrate(court, TAPS);
  assert.ok(cal);
  cornersOf(court).forEach((corner, i) => {
    const img = apply(cal.toImage, corner);
    assert.ok(Math.hypot(img[0] - TAPS[i][0], img[1] - TAPS[i][1]) < 1e-6);
    const back = apply(cal.toCourt, img);
    assert.ok(Math.hypot(back[0] - corner[0], back[1] - corner[1]) < 1e-6);
  });
  // The net line is closer to the far end on screen, as perspective should make it.
  const net = apply(cal.toImage, [court.width / 2, court.length / 2]);
  assert.ok(net[1] < 600 && net[1] > 300);
});

test('taps that cannot be a court are rejected', async () => {
  const { COURTS, calibrate } = await load();
  const court = COURTS['badminton-doubles'];
  assert.equal(calibrate(court, [[100, 900], [520, 300], [700, 900], [280, 300]]), null, 'crossed order');
  assert.equal(calibrate(court, [[0, 0], [1, 0], [2, 0], [3, 0]]), null, 'all in a line');
  assert.equal(calibrate(court, [[1, 1], [2, 2]]), null);
});

test('players are labelled by side and their distance adds up', async () => {
  const { COURTS, Tracker } = await load();
  const tr = new Tracker(COURTS['badminton-doubles'], { smoothing: 1 });
  // Two near-side players and one far-side player appear.
  tr.update([{ pos: [1.5, 3] }, { pos: [4.5, 3] }, { pos: [3, 10] }], 0);
  assert.deepEqual(tr.tracks.map((t) => t.label), ['P1', 'P2', 'P3']);
  // P1 runs 3 m sideways over 1.5 s in steps; others stand still.
  for (let i = 1; i <= 10; i++) tr.update([{ pos: [1.5 + 0.3 * i, 3] }, { pos: [4.5, 3] }, { pos: [3, 10] }], i * 0.15);
  const [p1, p2, p3] = tr.tracks;
  assert.ok(Math.abs(p1.distance - 3) < 0.01, `P1 ran ${p1.distance}`);
  assert.equal(p2.distance, 0);
  assert.equal(p3.distance, 0);
  assert.equal(tr.summary().durationSec, 2);
});

test('jitter and teleports are not counted as running', async () => {
  const { COURTS, Tracker } = await load();
  const tr = new Tracker(COURTS['badminton-doubles'], { smoothing: 1 });
  tr.update([{ pos: [2, 2] }], 0);
  for (let i = 1; i <= 20; i++) tr.update([{ pos: [2 + (i % 2) * 0.02, 2] }], i * 0.1); // 2 cm wobble
  assert.equal(tr.tracks[0].distance, 0);
  tr.update([{ pos: [2.5, 3.9] }], 2.2); // 2 m in 0.2 s = 10 m/s: a mis-detection
  assert.equal(tr.tracks[0].distance, 0);
});

test('people off the court are ignored and the player cap holds', async () => {
  const { COURTS, Tracker } = await load();
  const tr = new Tracker(COURTS['badminton-singles']);
  tr.update([{ pos: [-3, 5] }, { pos: [2, 2] }, { pos: [2.5, 11] }, { pos: [3, 6] }], 0);
  assert.equal(tr.tracks.length, 2, 'singles: two players, bystander at x=-3 ignored');
  assert.deepEqual(tr.tracks.map((t) => t.label), ['P1', 'P2']);
});

// A pose in image pixels: shoulders at y=100, hips at y=200 (torso 100 px).
function pose(wrist) {
  const p = Array.from({ length: 33 }, () => ({ x: 0, y: 0, v: 0 }));
  p[11] = { x: 90, y: 100, v: 1 }; p[12] = { x: 110, y: 100, v: 1 };
  p[23] = { x: 92, y: 200, v: 1 }; p[24] = { x: 108, y: 200, v: 1 };
  p[16] = { x: wrist[0], y: wrist[1], v: 1 };
  return p;
}

test('fast wrist movements count as swings, typed by height', async () => {
  const { COURTS, Tracker } = await load();
  const tr = new Tracker(COURTS['badminton-doubles']);
  const at = (t, wrist) => tr.update([{ pos: [2, 3], pose: pose(wrist) }], t);
  at(0, [150, 150]);
  at(0.1, [150, 150]); // still
  at(0.2, [150, 40]); // wrist flies up above the head: 110 px in 0.1 s = 11 torso/s
  assert.deepEqual(tr.tracks[0].swings, { overhead: 1, drive: 0, underarm: 0 });
  at(0.3, [150, 150]); // coming back down fast, but within the 0.6 s gap
  assert.equal(tr.swingCount, 1);
  at(1.0, [150, 150]);
  at(1.1, [40, 240]); // fast and low: an underarm lift
  assert.equal(tr.tracks[0].swings.underarm, 1);
  at(1.8, [150, 150]);
  at(1.9, [260, 150]); // fast at waist height: a drive
  assert.equal(tr.tracks[0].swings.drive, 1);
  assert.equal(tr.lastSwing.type, 'drive');
  at(2.6, [150, 150]);
  at(2.7, [170, 150]); // slow: 2 torso/s
  assert.equal(tr.swingCount, 3);
});

test('summary scales heat maps to 0–100', async () => {
  const { COURTS, Tracker } = await load();
  const tr = new Tracker(COURTS['badminton-doubles'], { smoothing: 1 });
  for (let i = 0; i <= 10; i++) tr.update([{ pos: [0.5, 0.5] }], i * 0.5);
  const { players } = tr.summary();
  assert.equal(players[0].heat.length, 14);
  assert.equal(players[0].heat[0].length, 7);
  assert.equal(players[0].heat[0][0], 100);
  assert.equal(players[0].heat[5][3], 0);
});
