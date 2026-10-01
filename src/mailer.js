'use strict';

const nodemailer = require('nodemailer');

// Email is optional. With SMTP_URL set, sign-ups must verify their IITR email and
// password reset works; without it, accounts are trusted on sign-up.
function createMailer(env = process.env) {
  if (!env.SMTP_URL) {
    return {
      enabled: false,
      async send({ to, subject, text }) {
        if (env.NODE_ENV !== 'test') console.log(`[mail disabled] to=${to} subject="${subject}"\n${text}`);
      },
    };
  }
  const transport = nodemailer.createTransport(env.SMTP_URL);
  const from = env.MAIL_FROM || 'IITR Sporty Match <no-reply@iitr-sporty-match>';
  return {
    enabled: true,
    async send({ to, subject, text }) {
      try {
        await transport.sendMail({ from, to, subject, text });
      } catch (err) {
        console.error('Failed to send email', err.message);
        throw err;
      }
    },
  };
}

module.exports = { createMailer };
