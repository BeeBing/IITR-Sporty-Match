'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, signupForm } = require('./helpers');

let app;
test.before(async () => { app = await startApp({ mail: true }); });
test.after(async () => { await app.stop(); });

const lastCode = () => app.mailer.sent.at(-1).subject.match(/^(\d{6})/)[1];

test('with email on, new accounts must verify before using the app', async () => {
  const form = signupForm();
  const c = app.client();
  await c.get('/signup');
  const res = await c.post('/signup', form);
  assert.equal(res.url, '/verify');
  assert.equal(app.mailer.sent.at(-1).to, form.email);

  assert.equal((await c.get('/matches')).url, '/verify');
  const wrong = await c.post('/verify', { code: lastCode() === '000000' ? '111111' : '000000' });
  assert.match(wrong.text, /not right/);
  const ok = await c.post('/verify', { code: lastCode() });
  assert.equal(ok.url, '/dashboard');
  assert.equal((await c.get('/matches')).status, 200);
});

test('password reset by emailed code', async () => {
  const form = signupForm();
  const c = app.client();
  await c.get('/signup');
  await c.post('/signup', form);

  const other = app.client();
  await other.get('/forgot');
  const res = await other.post('/forgot', { email: form.email });
  assert.match(res.url, /^\/reset\?email=/);
  const done = await other.post('/reset', { email: form.email, code: lastCode(), password: 'brand-new-pass' });
  assert.equal(done.url, '/dashboard');

  const login = app.client();
  await login.get('/login');
  const ok = await login.post('/login', { email: form.email, password: 'brand-new-pass' });
  assert.equal(ok.url, '/dashboard');
});

test('reset does not reveal whether an account exists', async () => {
  const c = app.client();
  await c.get('/forgot');
  const res = await c.post('/forgot', { email: 'nobody@iitr.ac.in' });
  assert.match(res.text, /If nobody@iitr.ac.in has an account/);
});
