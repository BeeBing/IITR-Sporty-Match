'use strict';

const { withTransaction } = require('../db');
const { UserError } = require('../errors');
const { getSport, getFormat } = require('../sports');
const time = require('../time');
const { notify, emailUsers } = require('./notify');

const MAX_HOSTED_UPCOMING = 5;

// $1 is always the viewer's user id.
const BASE = `
  SELECT m.*, h.name AS host_name, h.avatar_token AS host_avatar_token,
         pc.n AS player_count,
         (m.capacity - m.guests - pc.n)::int AS spots_left,
         m.starts_at + make_interval(mins => m.duration_min) AS ends_at,
         EXISTS (SELECT 1 FROM match_players me WHERE me.match_id = m.id AND me.user_id = $1) AS joined
  FROM matches m
  JOIN users h ON h.id = m.host_id
  CROSS JOIN LATERAL (SELECT count(*)::int AS n FROM match_players p WHERE p.match_id = m.id) pc`;

function describe(m) {
  const sport = getSport(m.sport);
  const format = getFormat(m.sport, m.format);
  return `${sport ? sport.name : m.sport} ${format ? format.label : m.format}`;
}

const spotsText = (n) => `${n} spot${n === 1 ? '' : 's'}`;

function state(m, now = new Date()) {
  if (m.status === 'cancelled') return { key: 'cancelled', label: 'Cancelled' };
  if (m.ends_at <= now) return { key: 'finished', label: 'Finished' };
  if (m.starts_at <= now) {
    return m.spots_left > 0
      ? { key: 'live', label: `Happening now · ${spotsText(m.spots_left)} left` }
      : { key: 'live', label: 'Happening now' };
  }
  if (m.spots_left <= 0) return { key: 'full', label: 'Full — game on!' };
  return { key: 'open', label: `Need ${m.spots_left} more` };
}

// Splits the roster into sides. The host's guests fill side A first, overflowing into B.
function layout(m, players) {
  const open = m.capacity - m.guests - players.length;
  if (!m.team_size) return { open, teams: null };
  const guestsA = Math.min(m.guests, m.team_size - 1);
  const teams = {};
  for (const [key, guests] of [['A', guestsA], ['B', m.guests - guestsA]]) {
    const members = players.filter((p) => p.team === key);
    teams[key] = { key, guests, members, open: m.team_size - guests - members.length };
  }
  return { open, teams };
}

function pickTeam(lay, pref) {
  const { A, B } = lay.teams;
  if (pref === 'A' || pref === 'B') {
    if (lay.teams[pref].open <= 0) throw new UserError(`Team ${pref} is already full — try the other side.`);
    return pref;
  }
  return B.open > A.open ? 'B' : 'A';
}

async function list(pool, viewer, { sport, day, includeFull = false, eligibleOnly = true, limit = 60 } = {}) {
  const where = [`m.status = 'open'`, 'm.ends_at > now()'];
  const params = [viewer.id];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (sport) add('m.sport = ?', sport);
  if (!includeFull) where.push('m.spots_left > 0');
  if (eligibleOnly) add(`(m.gender_pref = 'any' OR m.gender_pref = ?)`, viewer.gender);
  const ranges = { today: [0, 1], tomorrow: [1, 2], week: [0, 7] };
  if (ranges[day]) {
    add('m.starts_at >= ?', time.istDayStart(ranges[day][0]));
    add('m.starts_at < ?', time.istDayStart(ranges[day][1]));
  }
  params.push(limit);
  const { rows } = await pool.query(
    `SELECT * FROM (${BASE}) m WHERE ${where.join(' AND ')} ORDER BY m.starts_at LIMIT $${params.length}`,
    params,
  );
  return rows;
}

// Open matches in the viewer's sports that they could join.
async function recommended(pool, viewer, sports, limit = 6) {
  const params = [viewer.id, viewer.gender, limit];
  let sportFilter = '';
  if (sports.length) {
    params.push(sports);
    sportFilter = 'AND m.sport = ANY($4)';
  }
  const { rows } = await pool.query(
    `SELECT * FROM (${BASE}) m
     WHERE m.status = 'open' AND m.ends_at > now() AND m.spots_left > 0 AND NOT m.joined
       AND (m.gender_pref = 'any' OR m.gender_pref = $2) ${sportFilter}
     ORDER BY m.starts_at LIMIT $3`,
    params,
  );
  return rows;
}

async function mine(pool, viewer) {
  const { rows } = await pool.query(
    `SELECT * FROM (${BASE}) m WHERE m.joined ORDER BY m.starts_at DESC LIMIT 100`,
    [viewer.id],
  );
  const now = new Date();
  const upcoming = rows.filter((m) => m.ends_at > now).reverse();
  const past = rows.filter((m) => m.ends_at <= now).slice(0, 20);
  return { upcoming, past };
}

async function get(pool, id, viewer) {
  const { rows: [match] } = await pool.query(`SELECT * FROM (${BASE}) m WHERE m.id = $2`, [viewer.id, id]);
  if (!match) throw new UserError('That match does not exist.', 404);
  const { rows: players } = await pool.query(
    `SELECT p.user_id, p.team, p.joined_at, u.name, u.department, u.year, u.gender, u.email, u.phone, u.avatar_token, us.skill
     FROM match_players p
     JOIN users u ON u.id = p.user_id
     LEFT JOIN user_sports us ON us.user_id = p.user_id AND us.sport = $2
     WHERE p.match_id = $1
     ORDER BY p.joined_at`,
    [id, match.sport],
  );
  let messages = [];
  if (match.joined) {
    const res = await pool.query(
      `SELECT mm.id, mm.body, mm.created_at, mm.user_id, u.name
       FROM match_messages mm JOIN users u ON u.id = mm.user_id
       WHERE mm.match_id = $1 ORDER BY mm.id DESC LIMIT 100`,
      [id],
    );
    messages = res.rows.reverse();
  }
  return { match, players, messages, layout: layout(match, players), state: state(match) };
}

// Open matches close to what the host is about to create, so they can join one instead.
async function similar(pool, host, v) {
  const window = 90 * 60000;
  const { rows } = await pool.query(
    `SELECT * FROM (${BASE}) m
     WHERE m.status = 'open' AND m.sport = $2 AND m.format = $3 AND NOT m.joined AND m.spots_left > 0
       AND m.starts_at BETWEEN $4 AND $5 AND m.ends_at > now()
       AND (m.gender_pref = 'any' OR m.gender_pref = $6)
     ORDER BY abs(extract(epoch FROM m.starts_at - $7::timestamptz)) LIMIT 5`,
    [host.id, v.sport, v.format, new Date(v.starts_at.getTime() - window), new Date(v.starts_at.getTime() + window), host.gender, v.starts_at],
  );
  return rows;
}

async function create(pool, host, v) {
  return withTransaction(pool, async (c) => {
    const { rows: [{ n }] } = await c.query(
      `SELECT count(*)::int AS n FROM matches
       WHERE host_id = $1 AND status = 'open' AND starts_at + make_interval(mins => duration_min) > now()`,
      [host.id],
    );
    if (n >= MAX_HOSTED_UPCOMING) {
      throw new UserError(`You're already hosting ${n} upcoming matches. Cancel one or wait for them to finish.`);
    }
    const { rows: [match] } = await c.query(
      `INSERT INTO matches (host_id, sport, format, capacity, guests, team_size, venue, starts_at, duration_min, gender_pref, skill_level, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [host.id, v.sport, v.format, v.capacity, v.guests, v.team_size, v.venue, v.starts_at, v.duration_min, v.gender_pref, v.skill_level, v.notes || null],
    );
    await c.query('INSERT INTO match_players (match_id, user_id, team) VALUES ($1, $2, $3)', [match.id, host.id, match.team_size ? 'A' : null]);
    const open = match.capacity - match.guests - 1;
    await c.query(
      `INSERT INTO notifications (user_id, match_id, kind, body)
       SELECT u.id, $1, 'new_match', $2
       FROM users u JOIN user_sports us ON us.user_id = u.id AND us.sport = $3
       WHERE u.id <> $4 AND u.notify_new_matches AND ($5 = 'any' OR u.gender = $5)
       LIMIT 500`,
      [match.id, `New ${describe(match)} at ${match.venue}, ${time.when(match.starts_at)} — needs ${open} more.`, match.sport, host.id, match.gender_pref],
    );
    return match;
  });
}

// Locks the match row so two people can't take the last spot at the same time.
async function lockForChange(c, id) {
  const { rows: [m] } = await c.query(
    `SELECT *, starts_at + make_interval(mins => duration_min) AS ends_at FROM matches WHERE id = $1 FOR UPDATE`,
    [id],
  );
  if (!m) throw new UserError('That match does not exist.', 404);
  if (m.status === 'cancelled') throw new UserError('This match was cancelled.');
  if (m.ends_at <= new Date()) throw new UserError('This match is already over.');
  const { rows: players } = await c.query('SELECT user_id, team FROM match_players WHERE match_id = $1', [id]);
  return { m, players };
}

async function join(pool, id, user, teamPref, mailer) {
  const result = await withTransaction(pool, async (c) => {
    const { m, players } = await lockForChange(c, id);
    if (players.some((p) => p.user_id === user.id)) throw new UserError("You're already in this match.");
    if (m.gender_pref !== 'any' && m.gender_pref !== user.gender) {
      throw new UserError(`This match is for ${m.gender_pref === 'male' ? 'men' : 'women'} only.`, 403);
    }
    const lay = layout(m, players);
    if (lay.open <= 0) throw new UserError('Sorry — this match just filled up.');
    const team = lay.teams ? pickTeam(lay, teamPref) : null;
    await c.query('INSERT INTO match_players (match_id, user_id, team) VALUES ($1, $2, $3)', [id, user.id, team]);

    const left = lay.open - 1;
    const ids = players.map((p) => p.user_id);
    if (left === 0) {
      const body = `Game on! Your ${describe(m)} at ${m.venue}, ${time.when(m.starts_at)} is full.`;
      await notify(c, [...ids, user.id], { matchId: id, kind: 'full', body });
      return { m, team, full: true, playerIds: [...ids, user.id], body };
    }
    await notify(c, [m.host_id], { matchId: id, kind: 'joined', body: `${user.name} is in for your ${describe(m)} — need ${left} more.` });
    return { m, team, full: false };
  });
  if (result.full) {
    emailUsers(pool, mailer, result.playerIds, `Game on: ${describe(result.m)}`, `${result.body}\n\nSee who's playing:`, `/matches/${id}`);
  }
  return result;
}

async function leave(pool, id, user) {
  return withTransaction(pool, async (c) => {
    const { m, players } = await lockForChange(c, id);
    if (m.host_id === user.id) throw new UserError("Hosts can't leave their own match — cancel it instead.");
    if (!players.some((p) => p.user_id === user.id)) throw new UserError("You're not in this match.");
    await c.query('DELETE FROM match_players WHERE match_id = $1 AND user_id = $2', [id, user.id]);
    const open = layout(m, players).open + 1;
    await notify(c, [m.host_id], { matchId: id, kind: 'left', body: `${user.name} dropped out of your ${describe(m)} — ${spotsText(open)} open.` });
  });
}

async function switchTeam(pool, id, user) {
  return withTransaction(pool, async (c) => {
    const { m, players } = await lockForChange(c, id);
    const me = players.find((p) => p.user_id === user.id);
    if (!me) throw new UserError("You're not in this match.");
    if (!m.team_size) throw new UserError('This match has no sides.');
    const other = me.team === 'A' ? 'B' : 'A';
    if (layout(m, players).teams[other].open <= 0) throw new UserError(`Team ${other} is full.`);
    await c.query('UPDATE match_players SET team = $3 WHERE match_id = $1 AND user_id = $2', [id, user.id, other]);
    return other;
  });
}

async function cancel(pool, id, host) {
  return withTransaction(pool, async (c) => {
    const { m, players } = await lockForChange(c, id);
    if (m.host_id !== host.id) throw new UserError('Only the host can cancel this match.', 403);
    await c.query(`UPDATE matches SET status = 'cancelled' WHERE id = $1`, [id]);
    const others = players.map((p) => p.user_id).filter((uid) => uid !== host.id);
    await notify(c, others, { matchId: id, kind: 'cancelled', body: `${host.name} cancelled the ${describe(m)} at ${m.venue}, ${time.when(m.starts_at)}.` });
  });
}

async function removePlayer(pool, id, host, userId) {
  return withTransaction(pool, async (c) => {
    const { m, players } = await lockForChange(c, id);
    if (m.host_id !== host.id) throw new UserError('Only the host can remove players.', 403);
    if (userId === host.id) throw new UserError("You can't remove yourself.");
    if (!players.some((p) => p.user_id === userId)) throw new UserError('That player is not in this match.');
    await c.query('DELETE FROM match_players WHERE match_id = $1 AND user_id = $2', [id, userId]);
    await notify(c, [userId], { matchId: id, kind: 'removed', body: `The host removed you from the ${describe(m)} on ${time.when(m.starts_at)}.` });
  });
}

async function postMessage(pool, id, user, body) {
  const text = String(body || '').trim().slice(0, 500);
  if (!text) throw new UserError('Type a message first.');
  return withTransaction(pool, async (c) => {
    const { rows: [m] } = await c.query('SELECT * FROM matches WHERE id = $1', [id]);
    if (!m) throw new UserError('That match does not exist.', 404);
    const { rows: players } = await c.query('SELECT user_id FROM match_players WHERE match_id = $1', [id]);
    if (!players.some((p) => p.user_id === user.id)) throw new UserError('Join the match to chat with the players.', 403);
    await c.query('INSERT INTO match_messages (match_id, user_id, body) VALUES ($1, $2, $3)', [id, user.id, text]);
    const others = players.map((p) => p.user_id).filter((uid) => uid !== user.id);
    const snippet = text.length > 60 ? `${text.slice(0, 57)}…` : text;
    await notify(c, others, { matchId: id, kind: 'message', body: `${user.name} in ${describe(m)}: “${snippet}”`, collapse: true });
  });
}

module.exports = {
  describe, state, layout, list, recommended, mine, get, similar, create, join, leave, switchTeam, cancel, removePlayer, postMessage,
};
