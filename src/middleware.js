'use strict';

const crypto = require('node:crypto');
const users = require('./services/users');
const { unreadCount } = require('./services/notify');

function loadUser(pool) {
  return async (req, res, next) => {
    res.locals.currentUser = null;
    res.locals.unread = 0;
    if (req.session.userId) {
      const user = await users.byId(pool, req.session.userId);
      if (user) {
        req.user = user;
        res.locals.currentUser = user;
        if (req.method === 'GET') res.locals.unread = await unreadCount(pool, user.id);
      } else {
        delete req.session.userId;
      }
    }
    next();
  };
}

// Synchronizer-token CSRF protection. The token is created lazily, so anonymous visitors
// only get a session once they see a form.
function csrf(req, res, next) {
  res.locals.csrfToken = () => {
    if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
    return req.session.csrf;
  };
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const sent = Buffer.from(String((req.body && req.body._csrf) || req.get('x-csrf-token') || ''));
  const expected = Buffer.from(String(req.session.csrf || ''));
  if (!expected.length || sent.length !== expected.length || !crypto.timingSafeEqual(sent, expected)) {
    const message = 'Your session expired. Refresh the page and try again.';
    if (req.get('x-requested-with') === 'fetch') return res.status(403).json({ ok: false, error: message });
    return res.status(403).render('error', { title: 'Session expired', message });
  }
  next();
}

// One-time messages shown on the next full page. They're taken when a page renders, so
// image loads and background polling can't swallow them first.
function flash(req, res, next) {
  req.flash = (type, msg) => {
    req.session.flash = { type, msg };
  };
  const render = res.render.bind(res);
  res.render = (...args) => {
    if (req.session.flash && req.get('x-requested-with') !== 'fetch') {
      res.locals.flash = req.session.flash;
      delete req.session.flash;
    }
    return render(...args);
  };
  next();
}

function requireAuth(mailer) {
  return (req, res, next) => {
    if (!req.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    if (mailer.enabled && !req.user.email_verified) return res.redirect('/verify');
    next();
  };
}

module.exports = { loadUser, csrf, flash, requireAuth };
