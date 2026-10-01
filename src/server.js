'use strict';

const { createPool, migrate } = require('./db');
const { createMailer } = require('./mailer');
const { createApp } = require('./app');

async function main() {
  const production = process.env.NODE_ENV === 'production';
  const sessionSecret = process.env.SESSION_SECRET;
  if (production && !sessionSecret) throw new Error('SESSION_SECRET must be set in production');

  const pool = createPool();
  await migrate(pool);
  const mailer = createMailer();
  if (!mailer.enabled) console.warn('SMTP_URL not set: email verification and password reset are off.');

  const app = createApp({ pool, mailer, sessionSecret: sessionSecret || 'dev-only-secret', production });
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => console.log(`IITR Sporty Match listening on :${port}`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
