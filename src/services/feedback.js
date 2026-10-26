'use strict';

const { FEEDBACK_TOPICS, label } = require('../constants');
const time = require('../time');

async function save(pool, { userId, topic, message, replyEmail, page, userAgent }) {
  const { rows: [row] } = await pool.query(
    `INSERT INTO feedback (user_id, topic, message, reply_email, page, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [userId || null, topic, message, replyEmail || null, page || null, userAgent || null],
  );
  return row;
}

function emailFor(row, user) {
  const topic = label(FEEDBACK_TOPICS, row.topic);
  const oneLine = row.message.replace(/\s+/g, ' ').trim();
  const from = user
    ? `${user.name} <${user.email}> (user #${user.id})`
    : row.reply_email ? `Not logged in, reply to ${row.reply_email}` : 'Not logged in, no reply address';
  return {
    subject: `[Feedback] ${topic}: ${oneLine.length > 60 ? `${oneLine.slice(0, 57)}…` : oneLine}`,
    text: [
      `Topic: ${topic}`,
      `From: ${from}`,
      `Page: ${row.page || 'unknown'}`,
      `Browser: ${row.user_agent || 'unknown'}`,
      `Sent: ${time.when(row.created_at)} (IST)`,
      '',
      row.message,
    ].join('\n'),
    ...(row.reply_email && { replyTo: row.reply_email }),
  };
}

// Emails one feedback row to the private feedback address and marks it sent.
async function deliver(pool, mailer, to, row) {
  if (!mailer.enabled || !to) return false;
  const { rows: [user] } = row.user_id
    ? await pool.query('SELECT id, name, email FROM users WHERE id = $1', [row.user_id])
    : { rows: [] };
  await mailer.send({ to, ...emailFor(row, user) });
  await pool.query('UPDATE feedback SET emailed_at = now() WHERE id = $1', [row.id]);
  return true;
}

// Sends feedback that arrived while email was off or failing. Returns how many went out.
async function deliverPending(pool, mailer, to, limit = 50) {
  if (!mailer.enabled || !to) return 0;
  const { rows } = await pool.query('SELECT * FROM feedback WHERE emailed_at IS NULL ORDER BY id LIMIT $1', [limit]);
  let sent = 0;
  for (const row of rows) {
    try {
      if (await deliver(pool, mailer, to, row)) sent += 1;
    } catch {
      break; // provider trouble; try again on the next start
    }
  }
  return sent;
}

module.exports = { save, deliver, deliverPending, emailFor };
