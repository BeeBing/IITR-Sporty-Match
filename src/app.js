'use strict';

const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { loadUser, csrf, flash, requireAuth } = require('./middleware');
const helpers = require('./view-helpers');
const { appUrl } = require('./services/notify');

function createApp({ pool, mailer, sessionSecret, production = false }) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.set('trust proxy', 1); // Render terminates TLS in front of us
  app.disable('x-powered-by');

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        upgradeInsecureRequests: production ? [] : null,
        // blob: lets the photo cropper preview a picked image before uploading it.
        imgSrc: ["'self'", 'data:', 'blob:'],
      },
    },
  }));
  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: production ? '1h' : 0 }));

  app.get('/healthz', async (req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  });

  // Defaults first, so any page (even an early error page) renders with every local defined.
  app.use((req, res, next) => {
    Object.assign(res.locals, helpers, {
      path: req.path,
      mailEnabled: mailer.enabled,
      emailDomain: process.env.ALLOWED_EMAIL_DOMAIN || 'iitr.ac.in',
      appUrl,
      currentUser: null,
      unread: 0,
      flash: null,
      csrfToken: () => '',
    });
    next();
  });

  const sessionStore = new PgSession({ pool, createTableIfMissing: true, pruneSessionInterval: production ? 900 : false });
  app.locals.sessionStore = sessionStore;
  app.use(express.urlencoded({ extended: false, limit: '20kb' }));
  app.use(session({
    store: sessionStore,
    secret: sessionSecret,
    name: 'sid',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: production, maxAge: 30 * 86400000 },
  }));
  // express-session flushes redirect headers before its save completes, so a quick client
  // can follow the redirect and miss the login or flash. Save first on form posts.
  app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    const redirect = res.redirect.bind(res);
    res.redirect = (...args) => {
      if (!req.session) return redirect(...args);
      req.session.save((err) => (err ? next(err) : redirect(...args)));
    };
    next();
  });
  app.use(flash);
  app.use(loadUser(pool));
  app.use(csrf);
  const auth = requireAuth(mailer);
  app.use(require('./routes/auth')({ pool, mailer }));
  app.use(require('./routes/account')({ pool, requireAuth: auth }));
  app.use(require('./routes/matches')({ pool, mailer, requireAuth: auth }));

  app.use((req, res) => {
    res.status(404).render('error', { title: 'Not found', message: 'That page does not exist.' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.expose ? err.status || 400 : 500;
    if (status >= 500) console.error(err);
    let message = err.expose ? err.message : 'Something broke on our side. Try again in a moment.';
    if (err.type === 'entity.too.large') message = 'That file is too large.';
    if (req.get('x-requested-with') === 'fetch') return res.status(status).json({ ok: false, error: message });
    res.status(status).render('error', {
      title: status === 404 ? 'Not found' : 'Something went wrong',
      message,
    });
  });

  return app;
}

module.exports = { createApp };
