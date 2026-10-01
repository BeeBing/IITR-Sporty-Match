'use strict';

// Everything on campus happens in IST, which has no DST, so a fixed offset is safe.
const TZ = 'Asia/Kolkata';
const OFFSET = '+05:30';

const dateKey = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFmt = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true });
const dayFmt = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });

// "YYYY-MM-DD" of the IST calendar day containing `date`.
function istDate(date = new Date()) {
  return dateKey.format(date);
}

// Start of an IST day, `offsetDays` from the day containing `date`.
function istDayStart(offsetDays = 0, date = new Date()) {
  const start = new Date(`${istDate(date)}T00:00:00${OFFSET}`);
  return new Date(start.getTime() + offsetDays * 86400000);
}

// Parses an <input type="datetime-local"> value as IST.
function parseLocalInput(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(value || ''))) return null;
  const d = new Date(`${value}:00${OFFSET}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Formats a Date as a datetime-local value in IST.
function toLocalInput(date) {
  const ist = new Date(date.getTime() + 330 * 60000);
  return ist.toISOString().slice(0, 16);
}

function time(date) {
  return timeFmt.format(date).replace(/\s?(am|pm)$/i, (m) => ` ${m.trim().toUpperCase()}`);
}

// "Today · 6:00 PM", "Tomorrow · 7:30 AM", "Sat, 4 Oct · 5:00 PM"
function when(date, now = new Date()) {
  const d = istDate(date);
  let day;
  if (d === istDate(now)) day = 'Today';
  else if (d === istDate(istDayStart(1, now))) day = 'Tomorrow';
  else if (d === istDate(istDayStart(-1, now))) day = 'Yesterday';
  else day = dayFmt.format(date);
  return `${day} · ${time(date)}`;
}

function ago(date, now = new Date()) {
  const s = Math.max(0, Math.round((now - date) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return dayFmt.format(date);
}

module.exports = { istDate, istDayStart, parseLocalInput, toLocalInput, when, time, ago };
