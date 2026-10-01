'use strict';

const express = require('express');
const users = require('../services/users');
const matches = require('../services/matches');
const { unreadCount } = require('../services/notify');
const { validateProfile, validateSkills } = require('../validation');

module.exports = function accountRoutes({ pool, requireAuth }) {
  const r = express.Router();

  r.get('/', async (req, res) => {
    if (req.user) return res.redirect('/dashboard');
    const { rows: [{ n }] } = await pool.query(
      `SELECT count(*)::int AS n FROM matches
       WHERE status = 'open' AND starts_at + make_interval(mins => duration_min) > now()`,
    );
    res.render('home', { openCount: n });
  });

  r.get('/dashboard', requireAuth, async (req, res) => {
    const mySports = await users.sports(pool, req.user.id);
    const [{ upcoming }, forYou] = await Promise.all([
      matches.mine(pool, req.user),
      matches.recommended(pool, req.user, mySports.map((s) => s.sport)),
    ]);
    res.render('dashboard', { title: 'Home', upcoming, forYou, mySports });
  });

  r.get('/me/matches', requireAuth, async (req, res) => {
    const { upcoming, past } = await matches.mine(pool, req.user);
    res.render('mine', { title: 'My games', upcoming, past });
  });

  async function renderProfile(res, user, overrides = {}, status = 200) {
    const rows = await users.sports(pool, user.id);
    const skills = Object.fromEntries(rows.map((s) => [s.sport, s.skill]));
    res.status(status).render('profile', {
      title: 'Profile',
      values: { ...user, sports: rows.map((s) => s.sport), skills },
      errors: {},
      pwError: null,
      ...overrides,
    });
  }

  r.get('/profile', requireAuth, (req, res) => renderProfile(res, req.user));

  r.post('/profile', requireAuth, async (req, res) => {
    const { values, errors } = validateProfile(req.body);
    const skills = validateSkills(req.body, values.sports);
    const prefs = {
      notify_new_matches: req.body.notify_new_matches === '1',
      email_notifications: req.body.email_notifications === '1',
    };
    if (Object.keys(errors).length) {
      return renderProfile(res, req.user, {
        values: { ...req.user, ...values, ...prefs, skills }, errors,
      }, 400);
    }
    await users.updateProfile(pool, req.user.id, values, skills, prefs);
    req.flash('success', 'Profile saved.');
    res.redirect('/profile');
  });

  r.post('/profile/password', requireAuth, async (req, res) => {
    const ok = await users.authenticate(pool, req.user.email, req.body.current_password);
    if (!ok) return renderProfile(res, req.user, { pwError: 'Your current password is not right.' }, 400);
    try {
      await users.setPassword(pool, req.user.id, req.body.new_password);
    } catch (err) {
      if (!err.field) throw err;
      return renderProfile(res, req.user, { pwError: err.message }, 400);
    }
    req.flash('success', 'Password changed.');
    res.redirect('/profile');
  });

  r.get('/notifications', requireAuth, async (req, res) => {
    const { rows } = await pool.query(
      'SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
      [req.user.id],
    );
    await pool.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [req.user.id]);
    res.locals.unread = 0;
    res.render('notifications', { title: 'Notifications', items: rows });
  });

  r.get('/notifications/count', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ unread: await unreadCount(pool, req.user.id) });
  });

  return r;
};
