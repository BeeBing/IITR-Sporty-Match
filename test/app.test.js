'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, signUp, signupForm, hostMatch, matchForm } = require('./helpers');

let app;
test.before(async () => { app = await startApp(); });
test.after(async () => { await app.stop(); });

async function notifications(userEmail) {
  const { rows } = await app.pool.query(
    `SELECT n.kind, n.body FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.email = $1 ORDER BY n.id`,
    [userEmail],
  );
  return rows;
}

test('landing page and health check respond', async () => {
  const c = app.client();
  const home = await c.get('/');
  assert.equal(home.status, 200);
  assert.match(home.text, /Find your game/);
  assert.equal((await c.get('/healthz')).status, 200);
});

test('sign-up only accepts IITR emails and 8-digit enrollment numbers', async () => {
  const c = app.client();
  await c.get('/signup');
  const bad = await c.post('/signup', signupForm({ email: 'me@gmail.com', enrollment_no: '1234' }));
  assert.equal(bad.status, 400);
  assert.match(bad.text, /Use your IITR email/);
  assert.match(bad.text, /Enrollment number is 8 digits/);
  assert.match(bad.text, /value="me@gmail.com"/, 'form keeps what was typed');
});

test('sign-up rejects duplicate email and enrollment number', async () => {
  const form = signupForm();
  await signUp(app, form);
  const c = app.client();
  await c.get('/signup');
  const dupEmail = await c.post('/signup', { ...form, enrollment_no: '10999999' });
  assert.match(dupEmail.text, /already exists/);
  const dupEnroll = await c.post('/signup', { ...signupForm(), enrollment_no: form.enrollment_no });
  assert.match(dupEnroll.text, /already registered/);
});

test('pages need a login and forms need a CSRF token', async () => {
  const c = app.client();
  const res = await c.get('/matches');
  assert.equal(res.url, '/login?next=%2Fmatches');
  const forged = await c.request('POST', '/login', { email: 'x@iitr.ac.in', password: 'whatever' });
  assert.equal(forged.status, 403);
});

test('badminton doubles: host brings a partner, two others fill side B', async () => {
  const hostForm = signupForm({ name: 'Asha Host' });
  const host = await signUp(app, hostForm);
  const id = await hostMatch(host, { guests: '1' });

  const page = await host.get(`/matches/${id}`);
  assert.match(page.text, /Waiting for 2 more players/);
  assert.match(page.text, /Friend of Asha/);

  const bForm = signupForm({ name: 'Bala B' });
  const b = await signUp(app, bForm);
  const joinA = await b.post(`/matches/${id}/join`, { team: 'A' });
  assert.match(joinA.text, /Team A is already full/);
  const joined = await b.post(`/matches/${id}/join`);
  assert.match(joined.text, /You’re in, on Team B|You&#39;re in, on Team B/);

  const cForm = signupForm({ name: 'Chitra C', gender: 'female' });
  const c = await signUp(app, cForm);
  const full = await c.post(`/matches/${id}/join`);
  assert.match(full.text, /fills the match/);
  assert.match(full.text, /Full — game on!/);

  const late = await signUp(app);
  const tooLate = await late.post(`/matches/${id}/join`);
  assert.match(tooLate.text, /just filled up/);

  const hostNotes = await notifications(hostForm.email);
  assert.deepEqual(hostNotes.map((n) => n.kind), ['joined', 'full']);
  assert.match(hostNotes[0].body, /Bala B is in .* need 1 more/);
  assert.deepEqual((await notifications(cForm.email)).map((n) => n.kind), ['full']);

  // Players can see each other's contact details once they're in.
  const asB = await b.get(`/matches/${id}`);
  assert.ok(asB.text.includes(cForm.email));
  const outsider = await late.get(`/matches/${id}`);
  assert.ok(!outsider.text.includes(cForm.email));
});

test('women-only matches turn away other players', async () => {
  const host = await signUp(app, { gender: 'female' });
  const id = await hostMatch(host, { sport: 'squash', format: 'singles', gender_pref: 'female' });
  const guy = await signUp(app, { gender: 'male' });
  const res = await guy.post(`/matches/${id}/join`);
  assert.match(res.text, /women only/);

  const browse = await guy.get('/matches?sport=squash');
  assert.ok(!browse.text.includes(`/matches/${id}"`), 'hidden from people who cannot join');

  const cannotHost = await guy.post('/matches', { force: '1', ...matchForm({ gender_pref: 'female' }) });
  assert.equal(cannotHost.status, 400);
  assert.match(cannotHost.text, /only restrict a match to your own gender/);
});

test('leaving, switching sides and cancelling', async () => {
  const hostForm = signupForm();
  const host = await signUp(app, hostForm);
  const id = await hostMatch(host, { sport: 'football', format: '5v5' });
  const pForm = signupForm({ name: 'Dev D' });
  const p = await signUp(app, pForm);
  await p.post(`/matches/${id}/join`, { team: 'B' });

  const sw = await p.post(`/matches/${id}/switch`);
  assert.match(sw.text, /Switched to Team A/);

  const hostLeave = await host.post(`/matches/${id}/leave`);
  assert.match(hostLeave.text, /cancel it instead/);

  const left = await p.post(`/matches/${id}/leave`);
  assert.match(left.text, /You left the match/);
  assert.match((await notifications(hostForm.email)).at(-1).body, /Dev D dropped out .* 9 spots open/);

  await p.post(`/matches/${id}/join`);
  const notHost = await p.post(`/matches/${id}/cancel`);
  assert.match(notHost.text, /Only the host/);
  const cancelled = await host.post(`/matches/${id}/cancel`);
  assert.match(cancelled.text, /Match cancelled/);
  assert.equal((await notifications(pForm.email)).at(-1).kind, 'cancelled');
  const again = await signUp(app);
  assert.match((await again.post(`/matches/${id}/join`)).text, /was cancelled/);
});

test('hosts are offered similar open matches before posting a duplicate', async () => {
  const first = await signUp(app);
  const id = await hostMatch(first, { sport: 'table-tennis', format: 'singles' });
  const second = await signUp(app);
  const res = await second.post('/matches', matchForm({ sport: 'table-tennis', format: 'singles' }));
  assert.match(res.text, /Join one of these instead/);
  assert.ok(res.text.includes(`/matches/${id}/join`));
  const forced = await second.post('/matches', { ...matchForm({ sport: 'table-tennis', format: 'singles' }), force: '1' });
  assert.match(forced.url, /^\/matches\/\d+$/);
});

test('players get notified about new matches in their sports', async () => {
  const fanForm = signupForm({ sports: ['chess', 'carrom'] });
  await signUp(app, fanForm);
  const host = await signUp(app);
  await hostMatch(host, { sport: 'chess', format: '1v1' });
  const notes = await notifications(fanForm.email);
  assert.equal(notes.at(-1).kind, 'new_match');
  assert.match(notes.at(-1).body, /New Chess Game \(1v1\)/);
});

test('match chat is only for players in the match', async () => {
  const host = await signUp(app);
  const id = await hostMatch(host, { sport: 'carrom', format: 'doubles' });
  const outsider = await signUp(app);
  const denied = await outsider.post(`/matches/${id}/messages`, { body: 'hi' });
  assert.match(denied.text, /Join the match to chat/);

  const pForm = signupForm();
  const p = await signUp(app, pForm);
  await p.post(`/matches/${id}/join`);
  await host.post(`/matches/${id}/messages`, { body: 'I have the striker' });
  await host.post(`/matches/${id}/messages`, { body: 'See you at 6' });
  const view = await p.get(`/matches/${id}`);
  assert.match(view.text, /I have the striker/);
  const msgs = (await notifications(pForm.email)).filter((n) => n.kind === 'message');
  assert.equal(msgs.length, 1, 'unread chat notifications collapse into one');
});

test('live endpoint returns 204 when nothing changed', async () => {
  const host = await signUp(app);
  const id = await hostMatch(host, { sport: '8-ball-pool', format: 'singles' });
  const first = await host.get(`/matches/${id}/live`);
  assert.equal(first.status, 200);
  const version = decodeURIComponent(first.headers.get('x-live-version'));
  const same = await host.get(`/matches/${id}/live?v=${encodeURIComponent(version)}`);
  assert.equal(same.status, 204);
});

test('group formats let the host choose the size', async () => {
  const host = await signUp(app);
  const id = await hostMatch(host, { sport: 'gym', format: 'group', capacity: '4', guests: '1' });
  const page = await host.get(`/matches/${id}`);
  assert.match(page.text, /Waiting for 2 more players/);
});

test('without email set up, login is password-only', async () => {
  const c = app.client();
  const page = await c.get('/login');
  assert.doesNotMatch(page.text, /Email me a login code/);
  const res = await c.post('/login/code', { email: 'someone@iitr.ac.in' });
  assert.equal(res.url, '/login');
});

test('esports: BGMI squads, TDM sides and Roblox parties', async () => {
  const host = await signUp(app, { sports: ['bgmi', 'roblox'] });
  const squad = await hostMatch(host, { sport: 'bgmi', format: 'squad', venue: 'Online' });
  assert.match((await host.get(`/matches/${squad}`)).text, /Waiting for 3 more players/);

  const tdm = await hostMatch(host, { sport: 'bgmi', format: 'tdm', venue: 'Online (Discord voice)' });
  const tdmPage = await host.get(`/matches/${tdm}`);
  assert.match(tdmPage.text, /Team A/);
  assert.match(tdmPage.text, /Waiting for 7 more players/);

  const party = await hostMatch(host, { sport: 'roblox', format: 'party', capacity: '6', venue: 'Online' });
  assert.match((await host.get(`/matches/${party}`)).text, /Waiting for 5 more players/);

  const mk = await hostMatch(host, { sport: 'mortal-kombat', format: '1v1', venue: 'Bhawan common room' });
  assert.match((await host.get(`/matches/${mk}`)).text, /Mortal Kombat/);
  const board = await host.get('/matches/new');
  assert.match(board.text, /Esports &amp; gaming/);
});

test('running defaults to LBS ground and supports group runs', async () => {
  const host = await signUp(app, { sports: 'running' });
  const form = await host.get('/matches/new?sport=running');
  assert.match(form.text, /id="venue"[^>]*value="LBS ground"/);
  assert.match(form.text, /<option value="LBS ground">/);
  const id = await hostMatch(host, { sport: 'running', format: 'group', capacity: '6', venue: 'LBS ground' });
  const page = await host.get(`/matches/${id}`);
  assert.match(page.text, /Running/);
  assert.match(page.text, /LBS ground/);
  assert.match(page.text, /Waiting for 5 more players/);
});
