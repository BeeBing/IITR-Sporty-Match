'use strict';

const express = require('express');
const { UserError } = require('../errors');

// The court definitions are an ES module shared with the browser-side tracker.
const shared = Promise.all([import('../../public/stats/court.mjs'), import('../../public/stats/tracker.mjs')])
  .then(([court, tracker]) => ({ ...court, COLORS: tracker.COLORS }));

const int = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

// Only well-formed numbers get stored; anything else is rejected.
function cleanPlayers(court, raw, heatSize) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > court.maxPlayers) throw new UserError('No players to save.');
  const { cols, rows } = heatSize(court);
  const seen = new Set();
  return raw.map((p) => {
    const m = /^P(\d{1,2})$/.exec(p && p.label);
    const n = m ? Number(m[1]) : 0;
    if (n < 1 || n > court.maxPlayers || seen.has(n)) throw new UserError('Bad player label.');
    seen.add(n);
    if (typeof p.distance !== 'number' || !(p.distance >= 0 && p.distance <= 50000)) throw new UserError('Bad distance.');
    const swings = {};
    for (const k of ['overhead', 'drive', 'underarm']) {
      const v = p.swings ? p.swings[k] : 0;
      if (!int(v, 0, 10000)) throw new UserError('Bad swing count.');
      swings[k] = court.swings ? v : 0;
    }
    const heat = p.heat;
    if (!Array.isArray(heat) || heat.length !== rows || !heat.every((r) => Array.isArray(r) && r.length === cols && r.every((v) => int(v, 0, 100)))) {
      throw new UserError('Bad heat map.');
    }
    return { label: `P${n}`, distance: Math.round(p.distance * 10) / 10, swings, heat };
  });
}

module.exports = function statsRoutes({ pool, requireAuth }) {
  const r = express.Router();
  r.use('/stats', requireAuth);

  async function playingIn(userId, matchId) {
    const { rows: [m] } = await pool.query(
      `SELECT m.* FROM matches m JOIN match_players p ON p.match_id = m.id AND p.user_id = $2 WHERE m.id = $1`,
      [matchId, userId],
    );
    return m || null;
  }

  r.get('/stats', async (req, res) => {
    let match = null;
    if (req.query.match) {
      const id = Number(req.query.match);
      match = Number.isInteger(id) && id > 0 && id <= 2147483647 ? await playingIn(req.user.id, id) : null;
      if (!match) throw new UserError('You can only record stats for a match you’re playing in.', 403);
    }
    const { rows: recent } = await pool.query(
      'SELECT id, court, duration_sec, created_at FROM court_stats WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10',
      [req.user.id],
    );
    const { COURTS } = await shared;
    res.render('stats/index', { title: 'Court stats', match, recent, COURTS });
  });

  r.post('/stats', express.json({ limit: '100kb' }), async (req, res) => {
    const { COURTS, heatSize } = await shared;
    const body = req.body || {};
    const court = Object.hasOwn(COURTS, body.court) ? COURTS[body.court] : null;
    if (!court) throw new UserError('Unknown court type.');
    if (!int(body.durationSec, 1, 4 * 3600)) throw new UserError('Sessions can be 1 second to 4 hours long.');
    const players = cleanPlayers(court, body.players, heatSize);
    let matchId = null;
    if (body.matchId !== null && body.matchId !== undefined && body.matchId !== '') {
      matchId = Number(body.matchId);
      if (!Number.isInteger(matchId) || !(await playingIn(req.user.id, matchId))) {
        throw new UserError('You can only save stats to a match you’re playing in.', 403);
      }
    }
    const { rows: [row] } = await pool.query(
      `INSERT INTO court_stats (user_id, match_id, court, duration_sec, players) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [req.user.id, matchId, body.court, body.durationSec, JSON.stringify(players)],
    );
    res.json({ ok: true, id: row.id });
  });

  // Visible to whoever recorded it and, if it belongs to a match, to that match's players.
  r.get('/stats/:id', async (req, res) => {
    const id = Number(req.params.id);
    const notFound = new UserError('Those stats don’t exist.', 404);
    if (!Number.isInteger(id) || id < 1 || id > 2147483647) throw notFound;
    const { rows: [s] } = await pool.query(
      `SELECT s.*, u.name AS recorded_by FROM court_stats s JOIN users u ON u.id = s.user_id WHERE s.id = $1`,
      [id],
    );
    if (!s) throw notFound;
    const match = s.match_id ? await playingIn(req.user.id, s.match_id) : null;
    if (s.user_id !== req.user.id && !match) throw notFound;
    const { COURTS, COLORS } = await shared;
    const court = COURTS[s.court];
    if (!court) throw notFound;
    res.render('stats/show', { title: 'Court stats', s, court, match, COLORS, lines: court.lines() });
  });

  return r;
};
