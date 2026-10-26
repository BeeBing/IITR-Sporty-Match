'use strict';

const express = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const feedback = require('../services/feedback');
const { FEEDBACK_TOPICS } = require('../constants');

const MAX_LENGTH = 2000;

// Only local paths, and never the feedback page itself.
function localPath(value) {
  const p = String(value || '').slice(0, 200);
  return p.startsWith('/') && !p.startsWith('//') && !p.startsWith('/\\') && !p.startsWith('/feedback') ? p : '';
}

const looksLikeEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

// The destination address comes from the server's settings only; it never reaches a page.
module.exports = function feedbackRoutes({ pool, mailer, feedbackEmail }) {
  const r = express.Router();
  const limit = rateLimit({
    windowMs: 60 * 60000,
    limit: 8,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => (req.user ? `u${req.user.id}` : ipKeyGenerator(req.ip)),
    handler: (req, res) => res.status(429).render('error', {
      title: 'Slow down',
      message: 'You’ve sent a lot of feedback in the last hour. Please try again later.',
    }),
  });

  function render(res, values, errors = {}, status = 200) {
    res.status(status).render('feedback', { title: 'Send feedback', topics: FEEDBACK_TOPICS, values, errors });
  }

  r.get('/feedback', (req, res) => {
    const topic = FEEDBACK_TOPICS.some((t) => t.key === req.query.topic) ? req.query.topic : '';
    render(res, { topic, message: '', reply_email: '', from: localPath(req.query.from) });
  });

  r.post('/feedback', limit, async (req, res) => {
    const values = {
      topic: String(req.body.topic || ''),
      message: String(req.body.message || '').trim().slice(0, MAX_LENGTH),
      reply_email: String(req.body.reply_email || '').trim().toLowerCase().slice(0, 120),
      from: localPath(req.body.from),
    };
    const done = () => {
      req.flash('success', 'Thanks! Your feedback was sent.');
      res.redirect(values.from || '/');
    };
    // Hidden field only bots fill in: pretend it worked.
    if (req.body.website) return done();

    const errors = {};
    if (!FEEDBACK_TOPICS.some((t) => t.key === values.topic)) errors.topic = 'Pick a topic.';
    if (values.message.length < 5) errors.message = 'Tell us a little more.';
    if (!req.user && values.reply_email && !looksLikeEmail(values.reply_email)) errors.reply_email = 'That email doesn’t look right.';
    if (Object.keys(errors).length) return render(res, values, errors, 400);

    const row = await feedback.save(pool, {
      userId: req.user && req.user.id,
      topic: values.topic,
      message: values.message,
      replyEmail: req.user ? req.user.email : values.reply_email,
      page: values.from,
      userAgent: String(req.get('user-agent') || '').slice(0, 300),
    });
    try {
      await feedback.deliver(pool, mailer, feedbackEmail, row);
    } catch {
      // Saved already; it'll be emailed on the next start.
    }
    done();
  });

  return r;
};
