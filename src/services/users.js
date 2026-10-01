'use strict';

const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { withTransaction } = require('../db');
const { UserError } = require('../errors');

const CODE_TTL_MIN = 15;
const CODE_RESEND_SEC = 60;
const CODE_MAX_ATTEMPTS = 5;
// Compared against when the email is unknown so login timing doesn't reveal which accounts exist.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

function fieldError(field, message) {
  const err = new UserError(message);
  err.field = field;
  return err;
}

async function setSports(client, userId, sports, skills = {}) {
  await client.query('DELETE FROM user_sports WHERE user_id = $1 AND NOT (sport = ANY($2))', [userId, sports]);
  for (const sport of sports) {
    await client.query(
      `INSERT INTO user_sports (user_id, sport, skill) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, sport) DO UPDATE SET skill = EXCLUDED.skill`,
      [userId, sport, skills[sport] || null],
    );
  }
}

async function create(pool, v, password, { verified }) {
  const hash = await bcrypt.hash(password, 10);
  return withTransaction(pool, async (c) => {
    let user;
    try {
      ({ rows: [user] } = await c.query(
        `INSERT INTO users (email, password_hash, name, enrollment_no, department, year, gender, phone, email_verified)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [v.email, hash, v.name, v.enrollment_no, v.department, v.year, v.gender, v.phone || null, verified],
      ));
    } catch (err) {
      if (err.code === '23505' && err.constraint === 'users_email_key') {
        throw fieldError('email', 'An account with this email already exists — log in instead.');
      }
      if (err.code === '23505' && err.constraint === 'users_enrollment_no_key') {
        throw fieldError('enrollment_no', 'This enrollment number is already registered.');
      }
      throw err;
    }
    await setSports(c, user.id, v.sports);
    return user;
  });
}

async function authenticate(pool, email, password) {
  const { rows: [user] } = await pool.query('SELECT * FROM users WHERE email = $1', [String(email || '').trim().toLowerCase()]);
  const ok = await bcrypt.compare(String(password || ''), user ? user.password_hash : DUMMY_HASH);
  return user && ok ? user : null;
}

async function byId(pool, id) {
  const { rows: [user] } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return user || null;
}

async function byEmail(pool, email) {
  const { rows: [user] } = await pool.query('SELECT * FROM users WHERE email = $1', [String(email || '').trim().toLowerCase()]);
  return user || null;
}

async function sports(pool, userId) {
  const { rows } = await pool.query('SELECT sport, skill FROM user_sports WHERE user_id = $1', [userId]);
  return rows;
}

async function updateProfile(pool, userId, v, skills, prefs) {
  return withTransaction(pool, async (c) => {
    await c.query(
      `UPDATE users SET name = $2, department = $3, year = $4, gender = $5, phone = $6,
              notify_new_matches = $7, email_notifications = $8
       WHERE id = $1`,
      [userId, v.name, v.department, v.year, v.gender, v.phone || null, prefs.notify_new_matches, prefs.email_notifications],
    );
    await setSports(c, userId, v.sports, skills);
  });
}

async function setPassword(pool, userId, password) {
  if (String(password || '').length < 8) throw fieldError('password', 'Use at least 8 characters.');
  await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, await bcrypt.hash(password, 10)]);
}

async function markVerified(pool, userId) {
  await pool.query('UPDATE users SET email_verified = TRUE WHERE id = $1', [userId]);
}

const hashCode = (userId, purpose, code) =>
  crypto.createHash('sha256').update(`${userId}:${purpose}:${code}`).digest('hex');

// Issues a 6-digit one-time code; callers email it.
async function issueCode(pool, userId, purpose) {
  const { rows: [existing] } = await pool.query(
    'SELECT created_at FROM email_codes WHERE user_id = $1 AND purpose = $2',
    [userId, purpose],
  );
  if (existing && Date.now() - existing.created_at.getTime() < CODE_RESEND_SEC * 1000) {
    throw new UserError('A code was just sent — wait a minute before asking for another.', 429);
  }
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await pool.query(
    `INSERT INTO email_codes (user_id, purpose, code_hash, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(mins => $4))
     ON CONFLICT (user_id, purpose) DO UPDATE
       SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0, created_at = now()`,
    [userId, purpose, hashCode(userId, purpose, code), CODE_TTL_MIN],
  );
  return code;
}

async function consumeCode(pool, userId, purpose, code) {
  const { rows: [row] } = await pool.query(
    'SELECT * FROM email_codes WHERE user_id = $1 AND purpose = $2',
    [userId, purpose],
  );
  if (!row || row.expires_at < new Date()) throw fieldError('code', 'That code has expired — request a new one.');
  if (row.attempts >= CODE_MAX_ATTEMPTS) throw fieldError('code', 'Too many wrong tries — request a new code.');
  const given = Buffer.from(hashCode(userId, purpose, String(code || '').trim()));
  if (!crypto.timingSafeEqual(given, Buffer.from(row.code_hash))) {
    await pool.query('UPDATE email_codes SET attempts = attempts + 1 WHERE user_id = $1 AND purpose = $2', [userId, purpose]);
    throw fieldError('code', 'That code is not right.');
  }
  await pool.query('DELETE FROM email_codes WHERE user_id = $1 AND purpose = $2', [userId, purpose]);
}

module.exports = {
  create, authenticate, byId, byEmail, sports, updateProfile, setPassword, markVerified, issueCode, consumeCode, CODE_TTL_MIN,
};
