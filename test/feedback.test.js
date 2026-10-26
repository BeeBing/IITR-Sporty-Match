'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, signUp, signupForm } = require('./helpers');
const feedback = require('../src/services/feedback');

const OWNER = 'owner-inbox@feedback.test';
let app;
test.before(async () => { app = await startApp({ mail: true, feedbackEmail: OWNER }); });
test.after(async () => { await app.stop(); });

const rows = async () => (await app.pool.query('SELECT * FROM feedback ORDER BY id')).rows;

test('the feedback page never reveals where feedback goes', async () => {
  const c = app.client();
  for (const path of ['/', '/feedback', '/login', '/signup', '/feedback?topic=code']) {
    const page = await c.get(path);
    assert.ok(!page.text.includes(OWNER), `${path} leaks the address`);
  }
  const page = await c.get('/feedback?topic=performance&from=%2Fmatches');
  assert.match(page.text, /Send us feedback/);
  for (const t of ['Code issue', 'Feature issue', 'Performance issue', 'Other']) assert.match(page.text, new RegExp(t));
  assert.match(page.text, /value="performance" checked/);
});

test('logged-in feedback is saved and emailed with a reply-to', async () => {
  const form = signupForm({ name: 'Kavya Iyer' });
  const c = await signUp(app, form);
  await c.post('/verify', { code: app.mailer.sent.at(-1).subject.slice(0, 6) });
  await c.get('/feedback?from=/matches');
  const res = await c.post('/feedback', { topic: 'performance', message: 'The match list takes a while to load on mobile data.', from: '/matches' });
  assert.equal(res.url, '/matches', 'goes back where they were');
  assert.match(res.text, /Thanks! Your feedback was sent/);

  const mail = app.mailer.sent.at(-1);
  assert.equal(mail.to, OWNER);
  assert.equal(mail.replyTo, form.email);
  assert.match(mail.subject, /^\[Feedback\] Performance issue: The match list takes a while/);
  assert.match(mail.text, /From: Kavya Iyer </);
  assert.match(mail.text, /Page: \/matches/);
  const [row] = await rows();
  assert.equal(row.topic, 'performance');
  assert.ok(row.emailed_at);
});

test('logged-out feedback works, with an optional reply address', async () => {
  const c = app.client();
  await c.get('/feedback');
  const bad = await c.post('/feedback', { topic: 'nope', message: 'hi' });
  assert.equal(bad.status, 400);
  assert.match(bad.text, /Pick a topic/);
  assert.match(bad.text, /Tell us a little more/);

  const ok = await c.post('/feedback', { topic: 'code', message: 'Login code email never arrived.', reply_email: 'friend@example.com' });
  assert.equal(ok.url, '/');
  const mail = app.mailer.sent.at(-1);
  assert.equal(mail.replyTo, 'friend@example.com');
  assert.match(mail.subject, /Code issue/);
  assert.match(mail.text, /Not logged in, reply to friend@example.com/);
});

test('bots filling the hidden field are ignored', async () => {
  const before = (await rows()).length;
  const sentBefore = app.mailer.sent.length;
  const c = app.client();
  await c.get('/feedback');
  const res = await c.post('/feedback', { topic: 'other', message: 'Buy cheap stuff now!!!', website: 'http://spam.example' });
  assert.match(res.text, /Thanks!/);
  assert.equal((await rows()).length, before);
  assert.equal(app.mailer.sent.length, sentBefore);
});

test('feedback saved while email was down is sent later', async () => {
  const realSend = app.mailer.send;
  app.mailer.send = async () => { throw new Error('provider down'); };
  const c = app.client();
  await c.get('/feedback');
  const res = await c.post('/feedback', { topic: 'feature', message: 'Please add volleyball 2v2 beach format.' });
  app.mailer.send = realSend;
  assert.match(res.text, /Thanks!/, 'the student still sees success');
  const pending = (await rows()).filter((r) => !r.emailed_at);
  assert.equal(pending.length, 1);

  const sent = await feedback.deliverPending(app.pool, app.mailer, OWNER);
  assert.equal(sent, 1);
  assert.match(app.mailer.sent.at(-1).subject, /Feature issue/);
  assert.equal((await rows()).filter((r) => !r.emailed_at).length, 0);
});
