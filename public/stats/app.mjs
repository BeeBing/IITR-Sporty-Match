// Court stats: camera or video in, live overlay out. Everything runs on the phone; only the
// final numbers are sent to the server, and only if the player taps "Save".
import { COURTS, CORNER_NAMES, calibrate, apply, inside } from './court.mjs';
import { Tracker } from './tracker.mjs';

const root = document.getElementById('stats-app');
if (root) main(root);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const once = (el, ev) => new Promise((r) => el.addEventListener(ev, r, { once: true }));
const clock = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const SWING_NAMES = { overhead: 'Overhead', drive: 'Drive', underarm: 'Lift / net' };
const FILE_STEP = 1 / 8; // analyse uploaded videos at 8 frames per second of video

function main(root) {
  const $ = (id) => document.getElementById(id);
  const els = {
    court: $('st-court'), camera: $('st-camera'), file: $('st-file'), setup: $('st-setup'), live: $('st-live'),
    stage: $('st-stage'), video: $('st-video'), hud: $('st-hud'), status: $('st-status'), progress: $('st-progress'),
    redo: $('st-redo'), start: $('st-start'), pause: $('st-pause'), finish: $('st-finish'),
    summary: $('st-summary'), summaryBody: $('st-summary-body'), save: $('st-save'), discard: $('st-discard'),
  };
  const ctx = els.hud.getContext('2d');
  const state = {
    mode: null, stream: null, vision: null, visionPromise: null, taps: [], cal: null, tracker: null,
    running: false, paused: false, fileT: 0, lastT: 0, fps: 0, wakeLock: null, result: null,
  };

  for (const [key, c] of Object.entries(COURTS)) els.court.add(new Option(c.name, key));
  const preferred = Object.keys(COURTS).find((k) => COURTS[k].sport === root.dataset.sport);
  if (preferred) els.court.value = preferred;
  const court = () => COURTS[els.court.value];
  const setStatus = (msg) => { els.status.textContent = msg; };

  function loadModels() {
    if (!state.visionPromise) {
      const delegate = new URLSearchParams(window.location.search).get('delegate') === 'cpu' ? 'CPU' : 'GPU';
      state.visionPromise = import('./vision.mjs')
        .then((m) => m.loadVision({ delegate }))
        .then((v) => { state.vision = v; prompt(); return v; })
        .catch((err) => {
          state.visionPromise = null;
          setStatus(`Couldn’t load the tracking models (${err.message}). Check your connection and try again.`);
          throw err;
        });
    }
    return state.visionPromise;
  }

  // --- Source: live camera or a video from the gallery ---

  els.camera.addEventListener('click', async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      state.mode = 'camera';
      state.stream = stream;
      els.video.srcObject = stream;
      await els.video.play();
      enterLive();
    } catch {
      window.alert('Couldn’t open the camera. Allow camera access for this site in your browser settings and try again.');
    }
  });

  els.file.addEventListener('change', async () => {
    const file = els.file.files[0];
    if (!file) return;
    state.mode = 'file';
    els.video.src = URL.createObjectURL(file);
    try {
      await Promise.race([once(els.video, 'loadedmetadata'), once(els.video, 'error').then(() => { throw new Error('unreadable'); })]);
    } catch {
      window.alert('This browser can’t play that video. Try an MP4 recorded on your phone.');
      return;
    }
    els.video.currentTime = Math.min(0.5, els.video.duration / 2);
    await once(els.video, 'seeked');
    enterLive();
  });

  function fitStage() {
    const w = els.video.videoWidth;
    const h = els.video.videoHeight;
    if (!w || !h) return;
    if (els.hud.width !== w || els.hud.height !== h) {
      const changed = els.hud.width > 0 && state.taps.length > 0;
      els.hud.width = w;
      els.hud.height = h;
      if (changed && !state.running) {
        state.taps = [];
        state.cal = null;
        setStatus('The camera view changed. Tap the corners again.');
      }
    }
    const maxW = els.live.clientWidth || window.innerWidth;
    const maxH = window.innerHeight * 0.75;
    const scale = Math.min(maxW / w, maxH / h);
    els.stage.style.width = `${Math.floor(w * scale)}px`;
    els.stage.style.height = `${Math.floor(h * scale)}px`;
  }

  function enterLive() {
    els.setup.hidden = true;
    els.live.hidden = false;
    els.court.disabled = true;
    fitStage();
    window.addEventListener('resize', fitStage);
    state.taps = [];
    state.cal = null;
    loadModels().catch(() => {});
    prompt();
    requestAnimationFrame(drawLoop);
  }

  // --- Calibration: tap the four court corners ---

  function prompt() {
    if (state.running) return;
    if (state.taps.length < 4) setStatus(`Tap the ${CORNER_NAMES[state.taps.length]} corner of the court (${state.taps.length + 1} of 4).`);
    else if (!state.vision) setStatus('Corners set. Loading the tracking models (about 25 MB the first time)…');
    else setStatus(state.mode === 'file' ? 'Corners set. Press Start to analyse the video.' : 'Corners set. Keep the phone still and press Start when play begins.');
    els.start.disabled = !(state.cal && state.vision);
  }

  els.hud.addEventListener('click', (e) => {
    if (state.running || state.tracker || state.taps.length >= 4) return;
    const r = els.hud.getBoundingClientRect();
    state.taps.push([((e.clientX - r.left) * els.hud.width) / r.width, ((e.clientY - r.top) * els.hud.height) / r.height]);
    if (state.taps.length === 4) {
      state.cal = calibrate(court(), state.taps);
      if (!state.cal) {
        state.taps = [];
        setStatus('Those taps don’t make a court shape. Tap again in order: near-left, near-right, far-right, far-left.');
        els.start.disabled = true;
        return;
      }
    }
    prompt();
  });

  els.redo.addEventListener('click', () => {
    state.taps = [];
    state.cal = null;
    prompt();
  });

  // --- Tracking ---

  function processFrame(t) {
    const c = court();
    const t0 = performance.now();
    const dets = [];
    for (const p of state.vision.people(els.video)) {
      const [x, y, w, h] = p.box;
      const foot = [x + w / 2, y + h];
      const pos = apply(state.cal.toCourt, foot);
      if (Number.isFinite(pos[0]) && Number.isFinite(pos[1]) && inside(c, pos, 1.5)) dets.push({ pos, box: p.box, foot, score: p.score, pose: null });
    }
    dets.sort((a, b) => b.score - a.score);
    const keep = dets.slice(0, c.maxPlayers + 2);
    if (c.swings) {
      for (const d of keep.slice(0, c.maxPlayers)) {
        d.pose = state.vision.pose(els.video, d.box);
        const la = d.pose && d.pose[27];
        const ra = d.pose && d.pose[28];
        if (la && ra && la.v > 0.5 && ra.v > 0.5) {
          d.foot = [(la.x + ra.x) / 2, (la.y + ra.y) / 2];
          d.pos = apply(state.cal.toCourt, d.foot);
        }
      }
    }
    state.tracker.update(keep, t);
    state.lastT = t;
    const ms = performance.now() - t0;
    state.fps = state.fps ? state.fps * 0.9 + (1000 / Math.max(ms, 1)) * 0.1 : 1000 / Math.max(ms, 1);
  }

  const nextFrame = () => new Promise((r) => (els.video.requestVideoFrameCallback
    ? els.video.requestVideoFrameCallback(() => r())
    : requestAnimationFrame(() => r())));

  async function runCamera() {
    while (state.running) {
      if (state.paused) {
        await sleep(200);
        continue;
      }
      await nextFrame();
      if (!state.running || state.paused) continue;
      processFrame(performance.now() / 1000);
    }
  }

  async function runFile() {
    const v = els.video;
    v.pause();
    els.progress.hidden = false;
    els.progress.max = v.duration;
    while (state.running && state.fileT < v.duration) {
      if (state.paused) {
        await sleep(200);
        continue;
      }
      v.currentTime = state.fileT;
      await once(v, 'seeked');
      processFrame(state.fileT);
      els.progress.value = state.fileT;
      setStatus(`Analysing ${clock(state.fileT)} of ${clock(v.duration)}…`);
      state.fileT += FILE_STEP;
      await sleep(0);
    }
    if (state.running) finish();
  }

  async function guard(run) {
    try {
      await run();
    } catch (err) {
      state.running = false;
      setStatus(`Tracking stopped: ${err.message}`);
    }
  }

  els.start.addEventListener('click', async () => {
    if (!state.cal || !state.vision) return;
    state.tracker = new Tracker(court());
    state.running = true;
    state.paused = false;
    state.fileT = 0;
    els.start.hidden = true;
    els.redo.hidden = true;
    els.pause.hidden = false;
    els.finish.hidden = false;
    try { state.wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
    if (state.mode === 'camera') {
      setStatus('Tracking. Keep the phone still; press Finish when you’re done.');
      guard(runCamera);
    } else {
      guard(runFile);
    }
  });

  els.pause.addEventListener('click', () => {
    state.paused = !state.paused;
    els.pause.textContent = state.paused ? 'Resume' : 'Pause';
    if (!state.paused && state.tracker) state.tracker.lastT = null; // don't count the pause as playing time
    if (state.mode === 'camera') setStatus(state.paused ? 'Paused.' : 'Tracking. Keep the phone still; press Finish when you’re done.');
  });

  els.finish.addEventListener('click', finish);

  function finish() {
    state.running = false;
    state.wakeLock?.release?.().catch(() => {});
    if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
    els.live.hidden = true;
    showSummary(state.tracker.summary());
  }

  // --- Summary and saving ---

  function cell(tag, text, cls) {
    const el = document.createElement(tag);
    el.textContent = text;
    if (cls) el.className = cls;
    return el;
  }

  function showSummary(result) {
    state.result = result;
    els.summary.hidden = false;
    els.summaryBody.replaceChildren();
    if (!result.players.length) {
      els.summaryBody.append(cell('p', 'No players were tracked. Make sure the whole court is in view and the corners are right, then try again.', 'muted'));
      els.save.disabled = true;
      return;
    }
    els.summaryBody.append(cell('p', `${clock(result.durationSec)} tracked on a ${court().name.toLowerCase()}.`, 'muted'));
    const table = document.createElement('table');
    table.className = 'st-table';
    const head = document.createElement('tr');
    const cols = ['Player', 'Distance', ...(court().swings ? ['Overhead', 'Drive', 'Lift / net'] : [])];
    cols.forEach((c) => head.append(cell('th', c)));
    table.append(head);
    result.players.forEach((p, i) => {
      const row = document.createElement('tr');
      const name = cell('td', p.label);
      name.style.color = state.tracker.tracks[i].color;
      row.append(name, cell('td', `${p.distance.toFixed(1)} m`));
      if (court().swings) ['overhead', 'drive', 'underarm'].forEach((k) => row.append(cell('td', String(p.swings[k]))));
      table.append(row);
    });
    els.summaryBody.append(table);
  }

  els.save.addEventListener('click', async () => {
    if (!state.result) return;
    els.save.disabled = true;
    els.save.textContent = 'Saving…';
    try {
      const res = await fetch('/stats', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': root.dataset.csrf, 'x-requested-with': 'fetch' },
        body: JSON.stringify({ court: els.court.value, matchId: root.dataset.match || null, ...state.result }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Couldn’t save. Check your connection and try again.');
      window.location.assign(`/stats/${data.id}`);
    } catch (err) {
      window.alert(err.message);
      els.save.disabled = false;
      els.save.textContent = 'Save stats';
    }
  });

  els.discard.addEventListener('click', () => window.location.reload());

  // --- Drawing the overlay ---

  function drawLoop() {
    if (!els.live.hidden) {
      fitStage();
      draw();
    }
    if (!els.summary.hidden) return;
    requestAnimationFrame(drawLoop);
  }

  function rounded(x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
    else ctx.rect(x, y, w, h);
  }

  function panel(x, y, w, h, u) {
    ctx.fillStyle = 'rgba(10, 16, 13, 0.8)';
    rounded(x, y, w, h, u * 0.45);
    ctx.fill();
  }

  function text(str, x, y, size, color, weight = 700, align = 'left') {
    ctx.font = `${weight} ${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(str, x, y);
  }

  function draw() {
    const W = els.hud.width;
    const H = els.hud.height;
    if (!W || !H) return;
    ctx.clearRect(0, 0, W, H);
    const u = Math.min(W, H) / 34;
    if (state.cal) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
      ctx.lineWidth = Math.max(1, u * 0.12);
      for (const [a, b] of state.cal.court.lines()) {
        const pa = apply(state.cal.toImage, a);
        const pb = apply(state.cal.toImage, b);
        ctx.beginPath();
        ctx.moveTo(pa[0], pa[1]);
        ctx.lineTo(pb[0], pb[1]);
        ctx.stroke();
      }
    }
    if (!state.tracker) {
      drawTaps(u);
      return;
    }
    drawPlayers(u);
    drawPanels(u, W, H);
  }

  function drawTaps(u) {
    ctx.lineWidth = Math.max(2, u * 0.15);
    ctx.strokeStyle = '#f59e0b';
    if (state.taps.length > 1 && !state.cal) {
      ctx.beginPath();
      state.taps.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
    }
    state.taps.forEach(([x, y], i) => {
      ctx.fillStyle = '#f59e0b';
      ctx.beginPath();
      ctx.arc(x, y, u * 0.7, 0, Math.PI * 2);
      ctx.fill();
      text(String(i + 1), x, y + u * 0.35, u, '#111', 800, 'center');
    });
  }

  function drawPlayers(u) {
    const now = state.lastT;
    for (const tr of state.tracker.tracks) {
      if (now - tr.seenAt > 1) continue;
      // A ring on the floor around the player's feet, drawn in court space so it has perspective.
      ctx.strokeStyle = tr.color;
      ctx.lineWidth = Math.max(2, u * 0.2);
      ctx.beginPath();
      for (let i = 0; i <= 24; i++) {
        const a = (i / 24) * Math.PI * 2;
        const [x, y] = apply(state.cal.toImage, [tr.pos[0] + 0.4 * Math.cos(a), tr.pos[1] + 0.4 * Math.sin(a)]);
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      }
      ctx.stroke();
      // Name tag above the head.
      const [bx, by, bw] = tr.box;
      const tw = u * 3;
      const th = u * 1.6;
      const tx = bx + bw / 2 - tw / 2;
      const ty = Math.max(0, by - th - u * 0.4);
      panel(tx, ty, tw, th, u);
      ctx.fillStyle = tr.color;
      ctx.fillRect(tx + u * 0.35, ty + u * 0.3, u * 0.22, th - u * 0.6);
      text(tr.label, tx + u * 0.85, ty + th * 0.72, u * 1.05, '#fff', 800);
    }
  }

  function drawPanels(u, W, H) {
    const m = u * 0.6;
    const pw = u * 9;
    const tr = state.tracker;
    // Time
    panel(m, m, pw, u * 4.4, u);
    text('TIME', m + u * 0.7, m + u * 1.2, u * 0.75, '#cbd5c9');
    text(clock(tr.elapsed), m + u * 0.7, m + u * 3.1, u * 2.2, '#fff', 800);
    text(state.paused ? 'PAUSED' : `TRACKING · ${Math.round(state.fps)} FPS`, m + u * 0.7, m + u * 3.95, u * 0.6, '#cbd5c9', 600);
    // Swings and the latest swing
    if (tr.court.swings) {
      panel(W - m - pw, m, pw, u * 4.4, u);
      text('SWINGS', W - m - pw + u * 0.7, m + u * 1.2, u * 0.75, '#cbd5c9');
      text(String(tr.swingCount), W - m - pw + u * 0.7, m + u * 3.1, u * 2.2, '#fff', 800);
      text('ESTIMATED FROM ARM SPEED', W - m - pw + u * 0.7, m + u * 3.95, u * 0.55, '#cbd5c9', 600);
      const s = tr.lastSwing;
      if (s && state.lastT - s.at < 2.5) {
        panel(m, m + u * 5, pw, u * 3.6, u);
        text(SWING_NAMES[s.type].toUpperCase(), m + u * 0.7, m + u * 7.1, u * 1.7, '#c6f432', 800);
        text(`${s.label} · SWING ${s.n}`, m + u * 0.7, m + u * 8, u * 0.65, '#cbd5c9', 600);
      }
    }
    // Distance per player
    const rows = [...tr.tracks].sort((a, b) => a.index - b.index).slice(0, 6);
    if (rows.length) {
      const ph = u * (2.2 + rows.length * 1.35);
      const py = H - m - ph;
      panel(m, py, pw, ph, u);
      text('DISTANCE COVERED', m + u * 0.7, py + u * 1.2, u * 0.75, '#cbd5c9');
      rows.forEach((r, i) => {
        const y = py + u * (2.5 + i * 1.35);
        ctx.fillStyle = r.color;
        ctx.beginPath();
        ctx.arc(m + u * 0.95, y - u * 0.35, u * 0.3, 0, Math.PI * 2);
        ctx.fill();
        text(r.label, m + u * 1.6, y, u * 0.9, '#e6ede8', 600);
        text(`${r.distance.toFixed(1)} m`, m + pw - u * 0.7, y, u * 1, r.color, 800, 'right');
      });
    }
    // Court map: far end at the top.
    const c = tr.court;
    const mapH = u * 9.5;
    const mapW = Math.min(u * 6, (mapH * c.width) / c.length);
    const boxW = mapW + u * 1.4;
    const boxH = mapH + u * 2.6;
    const bx = W - m - boxW;
    const by = H - m - boxH;
    panel(bx, by, boxW, boxH, u);
    text('COURT MAP', bx + u * 0.7, by + u * 1.2, u * 0.7, '#cbd5c9');
    const ox = bx + u * 0.7;
    const oy = by + u * 1.9;
    const map = ([x, y]) => [ox + (x / c.width) * mapW, oy + (1 - y / c.length) * mapH];
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.lineWidth = Math.max(1, u * 0.08);
    for (const [a, b] of c.lines()) {
      const pa = map(a);
      const pb = map(b);
      ctx.beginPath();
      ctx.moveTo(pa[0], pa[1]);
      ctx.lineTo(pb[0], pb[1]);
      ctx.stroke();
    }
    for (const r of tr.tracks) {
      if (state.lastT - r.seenAt > 3) continue;
      const [x, y] = map([Math.max(0, Math.min(c.width, r.pos[0])), Math.max(0, Math.min(c.length, r.pos[1]))]);
      ctx.fillStyle = r.color;
      ctx.beginPath();
      ctx.arc(x, y, u * 0.35, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
