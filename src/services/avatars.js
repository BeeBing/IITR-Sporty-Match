'use strict';

const crypto = require('node:crypto');
const sharp = require('sharp');
const { withTransaction } = require('../db');
const { UserError } = require('../errors');

// Small instances: don't let libvips hold decoded images in memory between requests.
sharp.cache(false);

const SIZE = 320;
const ACCEPTED = new Set(['jpeg', 'png', 'webp', 'gif', 'heif']);
const MAX_PIXELS = 40_000_000;

// Re-encodes any upload as a square WebP. Re-encoding drops all metadata (EXIF, including
// GPS location from phone cameras) and guarantees we only ever serve a real image.
async function normalize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new UserError('Choose a photo first.');
  let meta;
  try {
    meta = await sharp(buffer, { limitInputPixels: MAX_PIXELS }).metadata();
  } catch {
    throw new UserError('That file isn’t a photo we can read. Try a JPG or PNG.');
  }
  if (!ACCEPTED.has(meta.format)) throw new UserError('Use a JPG, PNG or WebP photo.');
  try {
    return await sharp(buffer, { limitInputPixels: MAX_PIXELS, animated: false })
      .rotate()
      .resize(SIZE, SIZE, { fit: 'cover', position: 'attention' })
      .webp({ quality: 82 })
      .toBuffer();
  } catch {
    throw new UserError('That photo couldn’t be processed. Try a different one.');
  }
}

async function save(pool, userId, buffer) {
  const image = await normalize(buffer);
  const token = crypto.randomBytes(6).toString('hex');
  await withTransaction(pool, async (c) => {
    await c.query(
      `INSERT INTO avatars (user_id, image) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET image = EXCLUDED.image, updated_at = now()`,
      [userId, image],
    );
    await c.query('UPDATE users SET avatar_token = $2 WHERE id = $1', [userId, token]);
  });
  return token;
}

async function remove(pool, userId) {
  await withTransaction(pool, async (c) => {
    await c.query('DELETE FROM avatars WHERE user_id = $1', [userId]);
    await c.query('UPDATE users SET avatar_token = NULL WHERE id = $1', [userId]);
  });
}

async function get(pool, userId) {
  const { rows: [row] } = await pool.query('SELECT image FROM avatars WHERE user_id = $1', [userId]);
  return row ? row.image : null;
}

module.exports = { normalize, save, remove, get, SIZE };
