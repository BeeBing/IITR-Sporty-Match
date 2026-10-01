'use strict';

// Render sets RENDER_EXTERNAL_URL automatically; APP_URL overrides it (e.g. for a custom domain).
function appUrl(path = '/') {
  const base = process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
  return base.replace(/\/$/, '') + path;
}

// In-app notifications. With `collapse`, an unread notification of the same kind for the
// same match is replaced rather than stacked (used for chat messages).
async function notify(client, userIds, { matchId = null, kind, body, collapse = false }) {
  const ids = [...new Set(userIds)];
  if (!ids.length) return;
  if (collapse) {
    await client.query(
      'DELETE FROM notifications WHERE user_id = ANY($1) AND match_id = $2 AND kind = $3 AND read_at IS NULL',
      [ids, matchId, kind],
    );
  }
  await client.query(
    'INSERT INTO notifications (user_id, match_id, kind, body) SELECT unnest($1::int[]), $2, $3, $4',
    [ids, matchId, kind, body],
  );
}

// Fire-and-forget email to users who haven't opted out.
function emailUsers(pool, mailer, userIds, subject, text, path) {
  if (!mailer || !mailer.enabled || !userIds.length) return;
  const fullText = path ? `${text}\n\n${appUrl(path)}` : text;
  pool
    .query('SELECT email FROM users WHERE id = ANY($1) AND email_notifications', [userIds])
    .then(({ rows }) => Promise.all(rows.map((r) => mailer.send({ to: r.email, subject, text: fullText }))))
    .catch((err) => console.error('Notification email failed:', err.message));
}

async function unreadCount(pool, userId) {
  const { rows: [{ n }] } = await pool.query(
    'SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL',
    [userId],
  );
  return n;
}

module.exports = { notify, emailUsers, unreadCount, appUrl };
