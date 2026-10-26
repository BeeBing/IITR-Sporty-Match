'use strict';

const { createPool, migrate } = require('./db');
const { createMailer } = require('./mailer');
const { createApp } = require('./app');
const feedback = require('./services/feedback');

async function main() {
  const production = process.env.NODE_ENV === 'production';
  const sessionSecret = process.env.SESSION_SECRET;
  if (production && !sessionSecret) throw new Error('SESSION_SECRET must be set in production');

  const pool = createPool();
  await migrate(pool);
  const mailer = createMailer();
  if (mailer.enabled) console.log(`Email on (${mailer.provider}): verification, login codes and password reset.`);
  if (mailer.check) {
    mailer.check()
      .then((r) => (r.ok ? console.log(r.message) : console.warn(`Email setup problem: ${r.message}`)))
      .catch((err) => console.warn(`Couldn't reach Brevo to check the email setup: ${err.message}`));
  }
  else console.warn('Email is off (set BREVO_API_KEY and MAIL_FROM): no verification, login codes or password reset.');

  // Private address for the "Send feedback" form; set on the server only, never in code.
  const feedbackEmail = process.env.FEEDBACK_EMAIL || null;
  if (!feedbackEmail) console.warn('FEEDBACK_EMAIL not set: feedback is saved but not emailed.');
  else if (mailer.enabled) {
    feedback.deliverPending(pool, mailer, feedbackEmail)
      .then((n) => n && console.log(`Emailed ${n} saved feedback message(s).`))
      .catch((err) => console.warn(`Couldn't send saved feedback: ${err.message}`));
  }

  const app = createApp({ pool, mailer, sessionSecret: sessionSecret || 'dev-only-secret', production, feedbackEmail });
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => console.log(`IITR Sporty Match listening on :${port}`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
