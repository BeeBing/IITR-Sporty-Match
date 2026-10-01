'use strict';

const express = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const users = require('../services/users');
const { validateSignup } = require('../validation');

function limiter(limit, windowMin, keyGenerator) {
  return rateLimit({
    windowMs: windowMin * 60000,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    ...(keyGenerator && { keyGenerator }),
    handler: (req, res) => res.status(429).render('error', {
      title: 'Slow down',
      message: 'Too many attempts from this network. Wait a few minutes and try again.',
    }),
  });
}

// Only allow redirects to local paths.
function safeNext(next) {
  const n = String(next || '');
  return n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/\\') ? n : '/dashboard';
}

function logIn(req, user) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.userId = user.id;
      resolve();
    });
  });
}

module.exports = function authRoutes({ pool, mailer }) {
  const r = express.Router();
  // Campus traffic shares a few NAT addresses, so per-IP limits stay generous and
  // login is keyed on IP + email.
  const loginLimit = limiter(10, 15, (req) => `${ipKeyGenerator(req.ip)}|${String(req.body.email || '').toLowerCase()}`);
  const signupLimit = limiter(100, 60);
  const codeLimit = limiter(30, 15);

  async function sendCode(user, purpose) {
    const code = await users.issueCode(pool, user.id, purpose);
    const what = purpose === 'verify' ? 'verify your email' : 'reset your password';
    await mailer.send({
      to: user.email,
      subject: `${code} is your IITR Sporty Match code`,
      text: `Hi ${user.name},\n\nUse ${code} to ${what}. It expires in ${users.CODE_TTL_MIN} minutes.\n\nIf this wasn't you, ignore this email.`,
    });
  }

  r.get('/signup', (req, res) => {
    if (req.user) return res.redirect('/dashboard');
    res.render('signup', { title: 'Sign up', values: { sports: [] }, errors: {} });
  });

  r.post('/signup', signupLimit, async (req, res) => {
    const { values, password, errors } = validateSignup(req.body);
    const rerender = (errs) => res.status(400).render('signup', { title: 'Sign up', values, errors: errs });
    if (Object.keys(errors).length) return rerender(errors);
    let user;
    try {
      user = await users.create(pool, values, password, { verified: !mailer.enabled });
    } catch (err) {
      if (err.field) return rerender({ [err.field]: err.message });
      throw err;
    }
    await logIn(req, user);
    if (mailer.enabled) {
      await sendCode(user, 'verify');
      return res.redirect('/verify');
    }
    req.flash('success', `Welcome, ${user.name.split(' ')[0]}! Join a game or host your own.`);
    res.redirect('/dashboard');
  });

  r.get('/login', (req, res) => {
    if (req.user) return res.redirect(safeNext(req.query.next));
    res.render('login', { title: 'Log in', email: '', next: safeNext(req.query.next), error: null });
  });

  r.post('/login', loginLimit, async (req, res) => {
    const next = safeNext(req.body.next);
    const user = await users.authenticate(pool, req.body.email, req.body.password);
    if (!user) {
      return res.status(401).render('login', { title: 'Log in', email: req.body.email || '', next, error: 'Wrong email or password.' });
    }
    await logIn(req, user);
    res.redirect(next);
  });

  r.post('/logout', (req, res, next) => {
    req.session.destroy((err) => (err ? next(err) : res.redirect('/')));
  });

  // --- Email verification (only when SMTP is configured) ---

  r.get('/verify', (req, res) => {
    if (!req.user) return res.redirect('/login');
    if (req.user.email_verified || !mailer.enabled) return res.redirect('/dashboard');
    res.render('verify', { title: 'Verify your email', error: null });
  });

  r.post('/verify', codeLimit, async (req, res) => {
    if (!req.user) return res.redirect('/login');
    try {
      await users.consumeCode(pool, req.user.id, 'verify', req.body.code);
    } catch (err) {
      if (err.field) return res.status(400).render('verify', { title: 'Verify your email', error: err.message });
      throw err;
    }
    await users.markVerified(pool, req.user.id);
    req.flash('success', 'Email verified — you\'re all set!');
    res.redirect('/dashboard');
  });

  r.post('/verify/resend', codeLimit, async (req, res) => {
    if (!req.user) return res.redirect('/login');
    try {
      await sendCode(req.user, 'verify');
      req.flash('success', `New code sent to ${req.user.email}.`);
    } catch (err) {
      if (!err.expose) throw err;
      req.flash('error', err.message);
    }
    res.redirect('/verify');
  });

  // --- Password reset (only when SMTP is configured) ---

  r.get('/forgot', (req, res) => {
    res.render('forgot', { title: 'Reset password', email: '' });
  });

  r.post('/forgot', codeLimit, async (req, res) => {
    if (!mailer.enabled) return res.redirect('/forgot');
    const email = String(req.body.email || '').trim().toLowerCase();
    const user = await users.byEmail(pool, email);
    if (user) {
      try {
        await sendCode(user, 'reset');
      } catch (err) {
        if (!err.expose) throw err;
      }
    }
    // Same response either way, so this can't be used to probe for accounts.
    req.flash('success', `If ${email} has an account, a reset code is on its way.`);
    res.redirect(`/reset?email=${encodeURIComponent(email)}`);
  });

  r.get('/reset', (req, res) => {
    res.render('reset', { title: 'Choose a new password', email: String(req.query.email || ''), error: null });
  });

  r.post('/reset', codeLimit, async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const fail = (error) => res.status(400).render('reset', { title: 'Choose a new password', email, error });
    const user = await users.byEmail(pool, email);
    if (!user) return fail('That code is not right.');
    try {
      await users.consumeCode(pool, user.id, 'reset', req.body.code);
      await users.setPassword(pool, user.id, req.body.password);
    } catch (err) {
      if (err.field) return fail(err.message);
      throw err;
    }
    // Owning the inbox proves the address too.
    await users.markVerified(pool, user.id);
    await logIn(req, user);
    req.flash('success', 'Password updated.');
    res.redirect('/dashboard');
  });

  return r;
};
