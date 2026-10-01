'use strict';

const C = require('./constants');
const { SPORTS, CATEGORIES, getSport, getFormat } = require('./sports');
const time = require('./time');
const { state, describe } = require('./services/matches');

const initials = (name) =>
  String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

const firstName = (name) => String(name || '').trim().split(/\s+/)[0];

// wa.me needs the country code; assume India for bare 10-digit numbers.
function whatsappNumber(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length === 10 ? `91${digits}` : digits;
}

const gcalStamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

function calendarUrl(m, link) {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: `${describe(m)} — IITR Sporty Match`,
    dates: `${gcalStamp(m.starts_at)}/${gcalStamp(m.ends_at)}`,
    location: m.venue,
    details: link,
  });
  return `https://calendar.google.com/calendar/render?${params}`;
}

module.exports = {
  ...C,
  SPORTS,
  CATEGORIES,
  getSport,
  getFormat,
  when: time.when,
  ago: time.ago,
  clock: time.time,
  matchState: state,
  describe,
  initials,
  firstName,
  whatsappNumber,
  calendarUrl,
  yearLabel: (k) => C.label(C.YEARS, k),
  plural: (n, word) => `${n} ${n === 1 ? word : word.replace(/(ch|sh|s|x)$/, '$1e') + 's'}`,
};
