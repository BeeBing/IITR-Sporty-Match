'use strict';

const express = require('express');
const matches = require('../services/matches');
const { UserError } = require('../errors');
const { getSport, SPORTS, venuesFor } = require('../sports');
const { validateMatch } = require('../validation');
const time = require('../time');

function matchId(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1 || id > 2147483647) throw new UserError('That match does not exist.', 404);
  return id;
}

// Default start: the next half hour, plus an hour.
function defaultStart(now = new Date()) {
  const t = new Date(now.getTime() + 60 * 60000);
  t.setUTCMinutes(t.getUTCMinutes() < 30 ? 30 : 60, 0, 0);
  return t;
}

// Signature of what's visible in the live region, so polling can skip unchanged pages.
function liveVersion({ match, players, messages }) {
  const roster = players.map((p) => `${p.user_id}${p.team || ''}`).join(',');
  const lastMessage = messages.length ? messages[messages.length - 1].id : 0;
  return `${match.status}|${match.joined ? 1 : 0}|${roster}|${lastMessage}`;
}

const wantsJson = (req) => req.get('x-requested-with') === 'fetch';

module.exports = function matchRoutes({ pool, mailer, requireAuth }) {
  const r = express.Router();
  r.use('/matches', requireAuth);

  // Runs a match action, then returns to the match page with the outcome flashed.
  const action = (fn) => async (req, res) => {
    const id = matchId(req);
    try {
      const msg = await fn(id, req);
      if (wantsJson(req)) return res.json({ ok: true });
      if (msg) req.flash('success', msg);
    } catch (err) {
      if (!err.expose) throw err;
      if (wantsJson(req)) return res.status(err.status).json({ ok: false, error: err.message });
      req.flash('error', err.message);
    }
    res.redirect(`/matches/${id}`);
  };

  r.get('/matches', async (req, res) => {
    const filters = {
      sport: getSport(req.query.sport) ? req.query.sport : '',
      day: ['today', 'tomorrow', 'week'].includes(req.query.day) ? req.query.day : '',
      includeFull: req.query.full === '1',
    };
    const list = await matches.list(pool, req.user, filters);
    res.render('matches/index', { title: 'Find a game', list, filters });
  });

  function renderForm(res, values, errors, status = 200) {
    const sportsData = SPORTS.map((s) => ({ ...s, venues: venuesFor(s.key) }));
    res.status(status).render('matches/new', { title: 'Host a match', values, errors, sportsData });
  }

  r.get('/matches/new', (req, res) => {
    const sport = getSport(req.query.sport);
    renderForm(res, {
      sport: sport ? sport.key : '',
      format: sport && sport.formats.length === 1 ? sport.formats[0].key : '',
      venue: (sport && sport.defaultVenue) || '',
      guests: 0,
      starts_at_input: time.toLocalInput(defaultStart()),
      duration_min: 60,
      gender_pref: 'any',
      skill_level: 'any',
    }, {});
  });

  r.post('/matches', async (req, res) => {
    const { values, errors } = validateMatch(req.body, req.user);
    if (Object.keys(errors).length) return renderForm(res, values, errors, 400);
    if (req.body.force !== '1') {
      const similar = await matches.similar(pool, req.user, values);
      if (similar.length) return res.render('matches/similar', { title: 'Join one of these?', similar, body: req.body });
    }
    let match;
    try {
      match = await matches.create(pool, req.user, values);
    } catch (err) {
      if (!err.expose) throw err;
      return renderForm(res, values, { form: err.message }, 400);
    }
    req.flash('success', 'Match posted! We\'ll notify you as players join.');
    res.redirect(`/matches/${match.id}`);
  });

  r.get('/matches/:id', async (req, res) => {
    const data = await matches.get(pool, matchId(req), req.user);
    res.render('matches/show', { title: `${getSport(data.match.sport)?.name || 'Match'}`, ...data, version: liveVersion(data) });
  });

  // Polled by the match page; 204 when nothing changed.
  r.get('/matches/:id/live', async (req, res) => {
    const data = await matches.get(pool, matchId(req), req.user);
    const version = liveVersion(data);
    res.set('Cache-Control', 'no-store');
    if (req.query.v === version) return res.status(204).end();
    res.set('X-Live-Version', encodeURIComponent(version));
    res.render('matches/live', { ...data, version });
  });

  r.post('/matches/:id/join', action(async (id, req) => {
    const { full, team } = await matches.join(pool, id, req.user, req.body.team, mailer);
    if (full) return 'You\'re in — and that fills the match. Game on!';
    return team ? `You're in, on Team ${team}!` : 'You\'re in!';
  }));

  r.post('/matches/:id/leave', action(async (id, req) => {
    await matches.leave(pool, id, req.user);
    return 'You left the match.';
  }));

  r.post('/matches/:id/switch', action(async (id, req) => {
    const team = await matches.switchTeam(pool, id, req.user);
    return `Switched to Team ${team}.`;
  }));

  r.post('/matches/:id/cancel', action(async (id, req) => {
    await matches.cancel(pool, id, req.user);
    return 'Match cancelled. Players have been notified.';
  }));

  r.post('/matches/:id/remove', action(async (id, req) => {
    await matches.removePlayer(pool, id, req.user, Number(req.body.user_id));
    return 'Player removed.';
  }));

  r.post('/matches/:id/messages', action(async (id, req) => {
    await matches.postMessage(pool, id, req.user, req.body.body);
    return null;
  }));

  return r;
};
