'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { startApp, signUp, hostMatch } = require('./helpers');

let app;
test.before(async () => { app = await startApp(); });
test.after(async () => { await app.stop(); });

// A phone-style photo: landscape JPEG with EXIF (including GPS) attached.
function phonePhoto() {
  return sharp({ create: { width: 1200, height: 800, channels: 3, background: '#2a9d8f' } })
    .jpeg()
    .withExif({ IFD0: { Make: 'TestPhone', Copyright: 'secret' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '29/1 52/1 0/1' } })
    .toBuffer();
}

async function userId(email) {
  const { rows: [u] } = await app.pool.query('SELECT id, avatar_token FROM users WHERE email = $1', [email]);
  return u;
}

test('uploading a photo stores a square, metadata-free WebP', async () => {
  const c = await signUp(app, { email: 'photo1@cs.iitr.ac.in' });
  await c.get('/profile');
  const res = await c.upload('/profile/photo', await phonePhoto(), 'image/jpeg');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { ok: true });

  const { id, avatar_token: token } = await userId('photo1@cs.iitr.ac.in');
  assert.ok(token);
  const img = await c.getBuffer(`/avatars/${id}?v=${token}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/webp');
  assert.match(img.headers.get('cache-control'), /immutable/);
  const meta = await sharp(img.body).metadata();
  assert.equal(meta.format, 'webp');
  assert.equal(meta.width, 320);
  assert.equal(meta.height, 320);
  assert.equal(meta.exif, undefined, 'EXIF (incl. GPS) is stripped');

  const profile = await c.get('/profile');
  assert.match(profile.text, /Profile photo updated/);
  assert.ok(profile.text.includes(`/avatars/${id}?v=${token}`));
});

test('a new upload changes the photo URL', async () => {
  const c = await signUp(app, { email: 'photo2@cs.iitr.ac.in' });
  await c.get('/profile');
  await c.upload('/profile/photo', await phonePhoto(), 'image/jpeg');
  const first = (await userId('photo2@cs.iitr.ac.in')).avatar_token;
  const png = await sharp({ create: { width: 300, height: 500, channels: 4, background: '#e76f51' } }).png().toBuffer();
  assert.equal((await c.upload('/profile/photo', png, 'image/png')).status, 200);
  assert.notEqual((await userId('photo2@cs.iitr.ac.in')).avatar_token, first);
});

test('non-images and forged requests are rejected', async () => {
  const c = await signUp(app, { email: 'photo3@cs.iitr.ac.in' });
  await c.get('/profile');
  const junk = await c.upload('/profile/photo', Buffer.from('definitely not a photo'), 'image/jpeg');
  assert.equal(junk.status, 400);
  assert.match(junk.json.error, /isn’t a photo we can read/);

  const svg = await c.upload('/profile/photo', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'), 'image/svg+xml');
  assert.equal(svg.status, 400);

  const forged = await c.upload('/profile/photo', await phonePhoto(), 'image/jpeg', { csrf: null });
  assert.equal(forged.status, 403);
  assert.equal((await userId('photo3@cs.iitr.ac.in')).avatar_token, null);

  const huge = await c.upload('/profile/photo', Buffer.alloc(7 * 1024 * 1024), 'image/jpeg');
  assert.equal(huge.status, 413);
  assert.match(huge.json.error, /too large/);
});

test('photos are only served to signed-in users and can be removed', async () => {
  const c = await signUp(app, { email: 'photo4@cs.iitr.ac.in' });
  await c.get('/profile');
  await c.upload('/profile/photo', await phonePhoto(), 'image/jpeg');
  const { id, avatar_token: token } = await userId('photo4@cs.iitr.ac.in');

  const anon = app.client();
  const blocked = await anon.getBuffer(`/avatars/${id}?v=${token}`);
  assert.equal(blocked.status, 302);

  const removed = await c.post('/profile/photo/delete');
  assert.match(removed.text, /Profile photo removed/);
  assert.equal((await userId('photo4@cs.iitr.ac.in')).avatar_token, null);
  assert.equal((await c.getBuffer(`/avatars/${id}`)).status, 404);
});

test('players and hosts show their photos in matches', async () => {
  const host = await signUp(app, { email: 'photo5@cs.iitr.ac.in' });
  await host.get('/profile');
  await host.upload('/profile/photo', await phonePhoto(), 'image/jpeg');
  const { id, avatar_token: token } = await userId('photo5@cs.iitr.ac.in');
  const matchId = await hostMatch(host, { sport: 'squash', format: 'singles' });

  const other = await signUp(app);
  const page = await other.get(`/matches/${matchId}`);
  assert.ok(page.text.includes(`<img class="avatar" src="/avatars/${id}?v=${token}"`), 'roster shows the photo');
  const board = await other.get('/matches');
  assert.ok(board.text.includes(`src="/avatars/${id}?v=${token}"`), 'match card shows the host photo');
});
