'use strict';

process.env.NODE_ENV = 'test';

const { createPool, migrate } = require('../src/db');
const { createApp } = require('../src/app');

const DB_URL = process.env.TEST_DATABASE_URL || 'postgres://app:app@localhost/sporty_test';

function fakeMailer(enabled) {
  const sent = [];
  return { enabled, sent, async send(msg) { sent.push(msg); } };
}

// Boots the app on a random port against a freshly wiped database.
async function startApp({ mail = false } = {}) {
  const pool = createPool(DB_URL);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(pool);
  const mailer = fakeMailer(mail);
  const app = createApp({ pool, mailer, sessionSecret: 'test-secret' });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    pool,
    mailer,
    base,
    client: () => new Client(base),
    async stop() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await pool.end();
    },
  };
}

// A tiny browser: keeps cookies, follows redirects and remembers the latest CSRF token.
class Client {
  constructor(base) {
    this.base = base;
    this.cookies = new Map();
    this.csrf = '';
  }

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async request(method, path, form) {
    let url = this.base + path;
    let body;
    if (form) {
      body = new URLSearchParams();
      for (const [k, v] of Object.entries(form)) for (const x of [].concat(v)) body.append(k, x);
    }
    for (let hop = 0; hop < 5; hop++) {
      const res = await fetch(url, {
        method,
        body,
        redirect: 'manual',
        headers: { cookie: this.cookieHeader(), ...(body && { 'content-type': 'application/x-www-form-urlencoded' }) },
      });
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(';');
        const i = pair.indexOf('=');
        this.cookies.set(pair.slice(0, i), pair.slice(i + 1));
      }
      if (res.status >= 300 && res.status < 400) {
        url = new URL(res.headers.get('location'), url).toString();
        method = 'GET';
        body = undefined;
        continue;
      }
      const text = await res.text();
      const m = text.match(/name="_csrf" value="([^"]+)"/);
      if (m) this.csrf = m[1];
      return { status: res.status, url: url.replace(this.base, ''), text, headers: res.headers };
    }
    throw new Error('Too many redirects');
  }

  get(path) {
    return this.request('GET', path);
  }

  async post(path, form = {}) {
    if (!this.csrf) await this.get('/login');
    return this.request('POST', path, { _csrf: this.csrf, ...form });
  }
}

let counter = 0;

function signupForm(overrides = {}) {
  counter += 1;
  return {
    name: `Player ${counter}`,
    email: `player${counter}@cs.iitr.ac.in`,
    enrollment_no: String(26560000 + counter),
    department: 'Computer Science and Engineering',
    year: '2',
    gender: 'male',
    password: 'correct-horse',
    sports: 'badminton',
    ...overrides,
  };
}

async function signUp(app, overrides) {
  const c = app.client();
  await c.get('/signup');
  const res = await c.post('/signup', signupForm(overrides));
  if (res.url !== '/dashboard' && res.url !== '/verify') throw new Error(`Sign-up failed: ${res.status} ${res.url}`);
  return c;
}

// datetime-local value (IST) `hours` from now.
function inHours(hours) {
  const d = new Date(Date.now() + hours * 3600000 + 330 * 60000);
  return d.toISOString().slice(0, 16);
}

function matchForm(overrides = {}) {
  return {
    sport: 'badminton',
    format: 'doubles',
    guests: '0',
    starts_at: inHours(3),
    duration_min: '60',
    venue: 'MAC court 2',
    gender_pref: 'any',
    skill_level: 'any',
    ...overrides,
  };
}

async function hostMatch(client, overrides) {
  const res = await client.post('/matches', { force: '1', ...matchForm(overrides) });
  const m = res.url.match(/^\/matches\/(\d+)$/);
  if (!m) throw new Error(`Hosting failed: ${res.status} ${res.url}`);
  return Number(m[1]);
}

module.exports = { startApp, signUp, signupForm, matchForm, hostMatch, inHours };
