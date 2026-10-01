'use strict';

const nodemailer = require('nodemailer');

// "IITR Sporty Match <hello@example.com>" → { name, email }
function parseAddress(value) {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(String(value || ''));
  if (m) return { ...(m[1] && { name: m[1] }), email: m[2].trim() };
  return { email: String(value || '').trim() };
}

// Brevo's HTTPS API. Render's free plan blocks outbound SMTP ports, so this is the way
// to send email from a free instance.
function brevoTransport(apiKey, from) {
  const sender = parseAddress(from);
  return async ({ to, subject, text, html }) => {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sender, to: [{ email: to }], subject, textContent: text, ...(html && { htmlContent: html }) }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Brevo responded ${res.status}: ${(await res.text()).slice(0, 300)}`);
  };
}

function smtpTransport(url, from) {
  const transport = nodemailer.createTransport(url);
  return ({ to, subject, text, html }) => transport.sendMail({ from, to, subject, text, html });
}

// Email is optional. With BREVO_API_KEY (or SMTP_URL) set, sign-ups must verify their IITR
// email, people can log in with an emailed code, and password reset works. Without it,
// accounts are trusted on sign-up and only password login is offered.
function createMailer(env = process.env) {
  const from = env.MAIL_FROM;
  let transport = null;
  let provider = null;
  if (env.BREVO_API_KEY) {
    if (from) {
      transport = brevoTransport(env.BREVO_API_KEY, from);
      provider = 'brevo';
    } else {
      console.error('BREVO_API_KEY is set but MAIL_FROM is not; set MAIL_FROM to a sender verified in Brevo. Email is off.');
    }
  } else if (env.SMTP_URL) {
    transport = smtpTransport(env.SMTP_URL, from || 'IITR Sporty Match <no-reply@iitr-sporty-match>');
    provider = 'smtp';
  }

  if (!transport) {
    return {
      enabled: false,
      provider: null,
      async send({ to, subject, text }) {
        if (env.NODE_ENV !== 'test') console.log(`[mail disabled] to=${to} subject="${subject}"\n${text}`);
      },
    };
  }
  return {
    enabled: true,
    provider,
    async send(message) {
      try {
        await transport(message);
      } catch (err) {
        console.error(`Failed to send email via ${provider}:`, err.message);
        throw err;
      }
    },
  };
}

module.exports = { createMailer, parseAddress };
