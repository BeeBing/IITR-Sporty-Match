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

test('log in with an emailed code', async () => {
  const form = signupForm();
  const signup = app.client();
  await signup.get('/signup');
  await signup.post('/signup', form);
  await signup.post('/verify', { code: lastCode() });

  const c = app.client();
  const page = await c.get('/login');
  assert.match(page.text, /Email me a login code/);
  const sent = await c.post('/login/code', { email: form.email.toUpperCase(), next: '/me/matches' });
  assert.match(sent.url, /^\/login\/code\?email=/);
  assert.match(sent.text, /Check your inbox/);
  const mail = app.mailer.sent.at(-1);
  assert.equal(mail.to, form.email);
  assert.match(mail.subject, /^\d{6} is your IITR Sporty Match login code$/);
  assert.match(mail.html, new RegExp(lastCode()));

  const wrong = await c.post('/login/code/verify', { email: form.email, code: lastCode() === '000000' ? '111111' : '000000', next: '/me/matches' });
  assert.match(wrong.text, /not right/);
  const ok = await c.post('/login/code/verify', { email: form.email, code: lastCode(), next: '/me/matches' });
  assert.equal(ok.url, '/me/matches', 'lands where they were heading');

  const reuse = app.client();
  await reuse.get('/login');
  const again = await reuse.post('/login/code/verify', { email: form.email, code: lastCode() });
  assert.match(again.text, /expired/, 'a code works only once');
});

test('login codes look the same for unknown emails and reject non-IITR addresses', async () => {
  const c = app.client();
  await c.get('/login');
  const before = app.mailer.sent.length;
  const unknown = await c.post('/login/code', { email: 'nobody-here@iitr.ac.in' });
  assert.match(unknown.text, /If <b>nobody-here@iitr.ac.in<\/b> has an account/);
  assert.equal(app.mailer.sent.length, before, 'nothing is sent');
  const guess = await c.post('/login/code/verify', { email: 'nobody-here@iitr.ac.in', code: '123456' });
  assert.match(guess.text, /not right/);

  const gmail = await c.post('/login/code', { email: 'someone@gmail.com' });
  assert.equal(gmail.status, 400);
  assert.match(gmail.text, /Enter the IITR email/);
});

test('verifying an email by login code marks the account verified', async () => {
  const form = signupForm();
  const signup = app.client();
  await signup.get('/signup');
  await signup.post('/signup', form);
  const { rows: [before] } = await app.pool.query('SELECT email_verified FROM users WHERE email = $1', [form.email]);
  assert.equal(before.email_verified, false);

  // The verify code from sign-up was never used; a login code proves the inbox just as well.
  await app.pool.query("DELETE FROM email_codes WHERE purpose = 'login'");
  const c = app.client();
  await c.get('/login');
  await c.post('/login/code', { email: form.email });
  const ok = await c.post('/login/code/verify', { email: form.email, code: lastCode() });
  assert.equal(ok.url, '/dashboard');
  const { rows: [after] } = await app.pool.query('SELECT email_verified FROM users WHERE email = $1', [form.email]);
  assert.equal(after.email_verified, true);
});

test('a failed email can be retried straight away', async () => {
  const form = signupForm();
  const signup = app.client();
  await signup.get('/signup');
  await signup.post('/signup', form);

  const realSend = app.mailer.send;
  app.mailer.send = async () => { throw new Error('provider down'); };
  const c = app.client();
  await c.get('/login');
  const failed = await c.post('/login/code', { email: form.email });
  app.mailer.send = realSend;
  assert.equal(failed.status, 502);
  assert.match(failed.text, /couldn’t send the email/);

  const retry = await c.post('/login/code', { email: form.email });
  assert.match(retry.url, /^\/login\/code/);
  assert.match(app.mailer.sent.at(-1).subject, /login code/);
});
