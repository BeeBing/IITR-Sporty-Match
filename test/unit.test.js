'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { layout } = require('../src/services/matches');
const { isInstituteEmail, validateMatch } = require('../src/validation');
const { parseLocalInput, toLocalInput, when } = require('../src/time');
const { SPORTS, getFormat } = require('../src/sports');

test('IITR email check accepts departmental subdomains only', () => {
  assert.ok(isInstituteEmail('rahul_k@cs.iitr.ac.in'));
  assert.ok(isInstituteEmail('someone@iitr.ac.in'));
  assert.ok(isInstituteEmail('a.b@me.iitr.ac.in'));
  assert.ok(!isInstituteEmail('someone@gmail.com'));
  assert.ok(!isInstituteEmail('someone@iitr.ac.in.evil.com'));
  assert.ok(!isInstituteEmail('someone@fakeiitr.ac.in'));
});

test('every sport has at least one format and sane player counts', () => {
  for (const s of SPORTS) {
    assert.ok(s.formats.length > 0, s.key);
    for (const f of s.formats) {
      assert.ok(f.min >= 2 && f.max <= 30 && f.min <= f.max, `${s.key}/${f.key}`);
    }
  }
  assert.equal(getFormat('badminton', 'doubles').max, 4);
  assert.equal(getFormat('football', '11v11').max, 22);
});

test('layout puts the host\'s guests on side A first', () => {
  const m = { capacity: 4, guests: 1, team_size: 2 };
  const lay = layout(m, [{ user_id: 1, team: 'A' }]);
  assert.equal(lay.open, 2);
  assert.equal(lay.teams.A.open, 0);
  assert.equal(lay.teams.B.open, 2);

  // 5-a-side host bringing 7 friends: 4 fill side A, 3 spill into B.
  const big = layout({ capacity: 10, guests: 7, team_size: 5 }, [{ user_id: 1, team: 'A' }]);
  assert.equal(big.teams.A.open, 0);
  assert.equal(big.teams.B.guests, 3);
  assert.equal(big.teams.B.open, 2);
  assert.equal(big.open, 2);
});

test('layout for group formats has no sides', () => {
  const lay = layout({ capacity: 5, guests: 0, team_size: null }, [{ user_id: 1 }, { user_id: 2 }]);
  assert.equal(lay.teams, null);
  assert.equal(lay.open, 3);
});

test('datetime-local values are read as IST', () => {
  const d = parseLocalInput('2026-10-05T18:30');
  assert.equal(d.toISOString(), '2026-10-05T13:00:00.000Z');
  assert.equal(toLocalInput(d), '2026-10-05T18:30');
  assert.equal(parseLocalInput('nope'), null);
  assert.match(when(d, new Date('2026-10-05T03:00:00Z')), /^Today · 6:30 PM$/);
  assert.match(when(d, new Date('2026-10-04T03:00:00Z')), /^Tomorrow · 6:30 PM$/);
});

test('match validation enforces format sizes and host gender rules', () => {
  const host = { gender: 'male' };
  const base = { sport: 'gym', format: 'group', capacity: '9', starts_at: toLocalInput(new Date(Date.now() + 3600000)), venue: 'Gym' };
  assert.ok(validateMatch(base, host).errors.capacity, 'gym group is 3–6');
  assert.ok(!validateMatch({ ...base, capacity: '4' }, host).errors.capacity);
  assert.ok(validateMatch({ ...base, capacity: '4', gender_pref: 'female' }, host).errors.gender_pref);
  assert.ok(validateMatch({ ...base, capacity: '4', guests: '3' }, host).errors.guests, 'must leave a spot open');
  const sides = validateMatch({ ...base, sport: 'football', format: '5v5', capacity: '3' }, host);
  assert.equal(sides.values.capacity, 10, 'sides formats ignore the submitted capacity');
  assert.equal(sides.values.team_size, 5);
});

test('Brevo mailer sends through the HTTPS API with the configured sender', async () => {
  const { createMailer, parseAddress } = require('../src/mailer');
  assert.deepEqual(parseAddress('IITR Sporty Match <hello@example.com>'), { name: 'IITR Sporty Match', email: 'hello@example.com' });
  assert.deepEqual(parseAddress('hello@example.com'), { email: 'hello@example.com' });

  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return new Response('{"messageId":"x"}', { status: 201 });
  };
  try {
    const mailer = createMailer({ BREVO_API_KEY: 'xkeysib-test', MAIL_FROM: 'IITR Sporty Match <hello@example.com>' });
    assert.equal(mailer.enabled, true);
    assert.equal(mailer.provider, 'brevo');
    await mailer.send({ to: 'a@iitr.ac.in', subject: 'Hi', text: 'plain', html: '<b>hi</b>' });
    assert.equal(calls[0].url, 'https://api.brevo.com/v3/smtp/email');
    assert.equal(calls[0].opts.headers['api-key'], 'xkeysib-test');
    assert.deepEqual(JSON.parse(calls[0].opts.body), {
      sender: { name: 'IITR Sporty Match', email: 'hello@example.com' },
      to: [{ email: 'a@iitr.ac.in' }],
      subject: 'Hi',
      textContent: 'plain',
      htmlContent: '<b>hi</b>',
    });

    global.fetch = async () => new Response('{"message":"unauthorized"}', { status: 401 });
    await assert.rejects(mailer.send({ to: 'a@iitr.ac.in', subject: 'Hi', text: 'x' }), /Brevo responded 401/);
  } finally {
    global.fetch = realFetch;
  }
  assert.equal(createMailer({ BREVO_API_KEY: 'k' }).enabled, false, 'needs MAIL_FROM too');
  assert.equal(createMailer({}).enabled, false);
});
