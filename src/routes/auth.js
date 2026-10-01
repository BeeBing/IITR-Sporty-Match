'use strict';

const express = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const users = require('../services/users');
const { validateSignup, isInstituteEmail } = require('../validation');
const { codeEmail } = require('../emails');

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

const normEmail = (v) => String(v || '').trim().toLowerCase().slice(0, 120);

const MAIL_FAILED = 'We couldn’t send the email just now. Try again in a minute.';

module.exports = function authRoutes({ pool, mailer }) {
  const r = express.Router();
  // Campus traffic shares a few NAT addresses, so per-IP limits stay generous and
  // login is keyed on IP + email.
  const loginLimit = limiter(10, 15, (req) => `${ipKeyGenerator(req.ip)}|${normEmail(req.body.email)}`);
  const signupLimit = limiter(100, 60);
  const codeLimit = limiter(30, 15);

  // Issues and emails a one-time code. Throws a UserError (status 429) if one was sent
  // under a minute ago; other failures are delivery problems.
  async function sendCode(user, purpose) {
    const code = await users.issueCode(pool, user.id, purpose);
    try {
      await mailer.send({ to: user.email, ...codeEmail({ name: user.name, code, purpose, ttlMin: users.CODE_TTL_MIN }) });
    } catch (err) {
      // The email never arrived, so don't make them wait out the resend timer.
      await users.clearCode(pool, user.id, purpose);
      throw err;
    }
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
      try {
        await sendCode(user, 'verify');
      } catch {
        req.flash('error', `${MAIL_FAILED} Tap “Send a new code”.`);
      }
      return res.redirect('/verify');
    }
    req.flash('success', `Welcome, ${user.name.split(' ')[0]}! Join a game or host your own.`);
    res.redirect('/dashboard');
  });

  // --- Log in: an emailed one-time code (when email is set up) or a password ---

  function renderLogin(res, { email = '', next = '/dashboard', error = null, codeError = null, status = 200 } = {}) {
    res.status(status).render('login', { title: 'Log in', email, next, error, codeError });
  }

  r.get('/login', (req, res) => {
    if (req.user) return res.redirect(safeNext(req.query.next));
    renderLogin(res, { next: safeNext(req.query.next) });
  });

  r.post('/login', loginLimit, async (req, res) => {
    const next = safeNext(req.body.next);
    const user = await users.authenticate(pool, req.body.email, req.body.password);
    if (!user) return renderLogin(res, { email: normEmail(req.body.email), next, error: 'Wrong email or password.', status: 401 });
    await logIn(req, user);
    res.redirect(next);
  });

  const codePage = (email, next) => `/login/code?email=${encodeURIComponent(email)}&next=${encodeURIComponent(next)}`;

  r.post('/login/code', codeLimit, async (req, res) => {
    const email = normEmail(req.body.email);
    const next = safeNext(req.body.next);
    if (!mailer.enabled) return res.redirect('/login');
    if (!isInstituteEmail(email)) {
      return renderLogin(res, { email, next, codeError: 'Enter the IITR email you signed up with.', status: 400 });
    }
    const user = await users.byEmail(pool, email);
    if (user) {
      try {
        await sendCode(user, 'login');
      } catch (err) {
        // A code sent under a minute ago is still valid; say nothing so this page
        // looks the same whether or not the account exists.
        if (!err.expose) return renderLogin(res, { email, next, codeError: `${MAIL_FAILED} Or log in with your password.`, status: 502 });
      }
    }
    res.redirect(codePage(email, next));
  });

  r.get('/login/code', (req, res) => {
    if (req.user) return res.redirect(safeNext(req.query.next));
    if (!mailer.enabled) return res.redirect('/login');
    const email = normEmail(req.query.email);
    if (!email) return res.redirect('/login');
    res.render('login-code', { title: 'Enter your code', email, next: safeNext(req.query.next), error: null });
  });

  r.post('/login/code/verify', codeLimit, async (req, res) => {
    const email = normEmail(req.body.email);
    const next = safeNext(req.body.next);
    const fail = (error) => res.status(400).render('login-code', { title: 'Enter your code', email, next, error });
    const user = await users.byEmail(pool, email);
    if (!user) return fail('That code is not right.');
    try {
      await users.consumeCode(pool, user.id, 'login', req.body.code);
    } catch (err) {
      if (err.field) return fail(err.message);
      throw err;
    }
    // Getting the code proves they own the inbox.
    await users.markVerified(pool, user.id);
    await logIn(req, user);
    res.redirect(next);
  });

  r.post('/logout', (req, res, next) => {
    req.session.destroy((err) => (err ? next(err) : res.redirect('/')));
  });

  // --- Email verification (only when email is set up) ---

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
      req.flash('error', err.expose ? err.message : MAIL_FAILED);
    }
    res.redirect('/verify');
  });

  // --- Password reset (only when email is set up) ---

  r.get('/forgot', (req, res) => {
    res.render('forgot', { title: 'Reset password', email: '' });
  });

  r.post('/forgot', codeLimit, async (req, res) => {
    if (!mailer.enabled) return res.redirect('/forgot');
    const email = normEmail(req.body.email);
    const user = await users.byEmail(pool, email);
    if (user) {
      try {
        await sendCode(user, 'reset');
      } catch {
        // Logged by the mailer; respond the same way so this can't probe for accounts.
      }
    }
    req.flash('success', `If ${email} has an account, a reset code is on its way.`);
    res.redirect(`/reset?email=${encodeURIComponent(email)}`);
  });

  r.get('/reset', (req, res) => {
    res.render('reset', { title: 'Choose a new password', email: String(req.query.email || ''), error: null });
  });

  r.post('/reset', codeLimit, async (req, res) => {
    const email = normEmail(req.body.email);
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
