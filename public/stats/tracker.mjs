// Turns per-frame person detections (already mapped onto the court) into tracked players with
// distance covered, a position heat map and estimated swings. Pure logic: no DOM, no models.
import { heatSize, inside } from './court.mjs';

export const COLORS = ['#c6f432', '#2dd4bf', '#a78bfa', '#f472b6', '#fbbf24', '#60a5fa', '#f87171', '#34d399', '#e879f9', '#fb923c', '#94a3b8', '#facc15'];
export const SWING_TYPES = ['overhead', 'drive', 'underarm'];

// MediaPipe pose landmark indices.
const LS = 11; const RS = 12; const LW = 15; const RW = 16; const LH = 23; const RH = 24;

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export const TUNING = {
  smoothing: 0.4, // weight of a new position against the smoothed one
  minStep: 0.03, // metres; smaller moves are detection jitter
  maxSpeed: 8, // m/s; faster jumps are mis-detections, not sprinting
  gate: 1.5, // metres a matched detection may be from its player, plus drift while unseen
  newPlayerMargin: 0.5, // only start tracking people within this far outside the lines
  swingSpeed: 8, // wrist speed relative to the hips, in torso lengths per second
  swingGap: 0.6, // seconds between two swings by the same player
};

export class Tracker {
  constructor(court, tuning = {}) {
    this.court = court;
    this.tune = { ...TUNING, ...tuning };
    this.tracks = [];
    this.elapsed = 0;
    this.lastT = null;
    this.swingCount = 0;
    this.lastSwing = null;
    const { cols, rows } = heatSize(court);
    this.cols = cols;
    this.rows = rows;
  }

  // Players are labelled by the half they first appear in: near side first (P1, P2), then far.
  _label(pos) {
    const n = this.court.maxPlayers;
    const half = Math.ceil(n / 2);
    const used = new Set(this.tracks.map((t) => t.index));
    const near = [...Array(half).keys()];
    const far = [...Array(n - half).keys()].map((i) => i + half);
    const order = pos[1] < this.court.length / 2 ? [...near, ...far] : [...far, ...near];
    return order.find((i) => !used.has(i));
  }

  // dets: [{ pos: [x, y] in metres, box, foot, pose: [{x, y, v}] in image px or null }]; t in seconds.
  update(dets, t) {
    if (this.lastT !== null) this.elapsed += Math.max(0, Math.min(t - this.lastT, 1));
    this.lastT = t;

    const pairs = [];
    for (const track of this.tracks) {
      const gate = this.tune.gate + 3 * Math.min(t - track.seenAt, 2);
      dets.forEach((det, i) => {
        const d = dist(track.pos, det.pos);
        if (d <= gate) pairs.push({ track, i, d });
      });
    }
    pairs.sort((a, b) => a.d - b.d);
    const usedTracks = new Set();
    const usedDets = new Set();
    for (const { track, i } of pairs) {
      if (usedTracks.has(track) || usedDets.has(i)) continue;
      usedTracks.add(track);
      usedDets.add(i);
      this._move(track, dets[i], t);
    }
    dets.forEach((det, i) => {
      if (usedDets.has(i) || this.tracks.length >= this.court.maxPlayers) return;
      if (!inside(this.court, det.pos, this.tune.newPlayerMargin)) return;
      const index = this._label(det.pos);
      this.tracks.push({
        index,
        label: `P${index + 1}`,
        color: COLORS[index % COLORS.length],
        pos: det.pos,
        seenAt: t,
        box: det.box,
        foot: det.foot,
        distance: 0,
        swings: { overhead: 0, drive: 0, underarm: 0 },
        heat: Array.from({ length: this.rows }, () => new Array(this.cols).fill(0)),
        prevPose: null,
        lastSwingAt: -Infinity,
      });
      this.tracks.sort((a, b) => a.index - b.index);
    });
  }

  _move(track, det, t) {
    const dt = t - track.seenAt;
    const a = this.tune.smoothing;
    const next = dt > 1.5 ? det.pos : [track.pos[0] + a * (det.pos[0] - track.pos[0]), track.pos[1] + a * (det.pos[1] - track.pos[1])];
    const step = dist(track.pos, next);
    if (dt > 0 && dt <= 1.5 && step >= this.tune.minStep && step / dt <= this.tune.maxSpeed) track.distance += step;
    if (dt > 0) {
      const col = Math.min(this.cols - 1, Math.max(0, Math.floor(next[0])));
      const row = Math.min(this.rows - 1, Math.max(0, Math.floor(next[1])));
      track.heat[row][col] += Math.min(dt, 1);
    }
    track.pos = next;
    track.seenAt = t;
    track.box = det.box;
    track.foot = det.foot;
    if (this.court.swings) this._swing(track, det.pose, t);
  }

  // A swing is a fast wrist movement relative to the hips; its height says what kind.
  _swing(track, pose, t) {
    const seen = (i) => pose && pose[i] && (pose[i].v ?? 1) > 0.3;
    if (![LS, RS, LH, RH].every(seen)) {
      track.prevPose = null;
      return;
    }
    const sh = mid(pose[LS], pose[RS]);
    const hip = mid(pose[LH], pose[RH]);
    const torso = Math.hypot(sh.x - hip.x, sh.y - hip.y);
    const now = { t, hip, wrists: [seen(LW) ? pose[LW] : null, seen(RW) ? pose[RW] : null] };
    const prev = track.prevPose;
    track.prevPose = now;
    if (!prev || torso < 8) return;
    const dt = t - prev.t;
    if (dt <= 0 || dt > 0.5) return;
    let best = null;
    for (const i of [0, 1]) {
      const w = now.wrists[i];
      const w0 = prev.wrists[i];
      if (!w || !w0) continue;
      const dx = (w.x - hip.x) - (w0.x - prev.hip.x);
      const dy = (w.y - hip.y) - (w0.y - prev.hip.y);
      const speed = Math.hypot(dx, dy) / dt / torso;
      if (!best || speed > best.speed) best = { speed, w };
    }
    if (!best || best.speed < this.tune.swingSpeed || t - track.lastSwingAt < this.tune.swingGap) return;
    track.lastSwingAt = t;
    // Image y grows downwards.
    const type = best.w.y < sh.y - 0.15 * torso ? 'overhead' : best.w.y > hip.y - 0.1 * torso ? 'underarm' : 'drive';
    track.swings[type] += 1;
    this.swingCount += 1;
    this.lastSwing = { label: track.label, color: track.color, type, n: this.swingCount, at: t };
  }

  // What gets saved: numbers only, heat maps scaled to 0–100.
  summary() {
    return {
      durationSec: Math.round(this.elapsed),
      players: this.tracks.map((tr) => {
        const max = Math.max(1e-9, ...tr.heat.flat());
        return {
          label: tr.label,
          distance: Math.round(tr.distance * 10) / 10,
          swings: { ...tr.swings },
          heat: tr.heat.map((row) => row.map((v) => Math.round((v / max) * 100))),
        };
      }),
    };
  }
}
