'use strict';

const { YEARS, GENDERS, GENDER_PREFS, MATCH_SKILLS, SKILLS, DURATIONS } = require('./constants');
const { getSport, getFormat } = require('./sports');
const { parseLocalInput } = require('./time');

const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const inList = (list, key) => list.some((x) => x.key === key);

function emailDomain() {
  return (process.env.ALLOWED_EMAIL_DOMAIN || 'iitr.ac.in').toLowerCase();
}

// Accepts name@iitr.ac.in and departmental addresses like name@cs.iitr.ac.in.
function isInstituteEmail(email) {
  const domain = emailDomain().replace(/\./g, '\\.');
  return new RegExp(`^[a-z0-9._%+-]+@([a-z0-9-]+\\.)*${domain}$`).test(email);
}

function asArray(v) {
  if (v === undefined || v === null || v === '') return [];
  return Array.isArray(v) ? v : [v];
}

function validSports(raw) {
  return [...new Set(asArray(raw).filter((k) => getSport(k)))];
}

// Shared by sign-up and profile edit.
function validateProfile(body) {
  const errors = {};
  const values = {
    name: str(body.name, 80),
    department: str(body.department === '__other' ? body.department_other : body.department, 100),
    year: str(body.year, 10),
    gender: str(body.gender, 10),
    phone: str(body.phone, 20).replace(/[\s-]/g, ''),
    sports: validSports(body.sports),
  };
  if (values.name.length < 2) errors.name = 'Enter your name.';
  if (!values.department) errors.department = 'Choose your department or centre.';
  if (!inList(YEARS, values.year)) errors.year = 'Choose your year or programme.';
  if (!inList(GENDERS, values.gender)) errors.gender = 'Choose an option.';
  if (values.phone && !/^\+?\d{10,13}$/.test(values.phone)) errors.phone = 'Enter a 10-digit mobile number (optional).';
  return { values, errors };
}

function validateSignup(body) {
  const { values, errors } = validateProfile(body);
  values.email = str(body.email, 120).toLowerCase();
  values.enrollment_no = str(body.enrollment_no, 20);
  const password = String(body.password || '');
  if (!isInstituteEmail(values.email)) errors.email = `Use your IITR email, e.g. name@xx.${emailDomain()}`;
  if (!/^\d{8}$/.test(values.enrollment_no)) errors.enrollment_no = 'Enrollment number is 8 digits, e.g. 26563021.';
  if (password.length < 8) errors.password = 'Use at least 8 characters.';
  return { values, password, errors };
}

function validateSkills(body, sports) {
  const skills = {};
  for (const key of sports) {
    const skill = body[`skill_${key}`];
    skills[key] = SKILLS.some((s) => s.key === skill) ? skill : null;
  }
  return skills;
}

const MAX_DAYS_AHEAD = 30;

function validateMatch(body, host, now = new Date()) {
  const errors = {};
  const values = {
    sport: str(body.sport, 30),
    format: str(body.format, 30),
    capacity: parseInt(body.capacity, 10),
    guests: parseInt(body.guests || '0', 10),
    venue: str(body.venue, 80),
    starts_at_input: str(body.starts_at, 20),
    duration_min: parseInt(body.duration_min, 10),
    gender_pref: str(body.gender_pref || 'any', 10),
    skill_level: str(body.skill_level || 'any', 20),
    notes: str(body.notes, 500),
  };

  const sport = getSport(values.sport);
  const format = sport && getFormat(values.sport, values.format);
  if (!sport) errors.sport = 'Pick a sport.';
  else if (!format) errors.format = 'Pick a format.';

  if (format) {
    if (format.type === 'sides') values.capacity = format.max;
    if (!Number.isInteger(values.capacity) || values.capacity < format.min || values.capacity > format.max) {
      errors.capacity = `Choose between ${format.min} and ${format.max} players.`;
    }
    values.team_size = format.type === 'sides' ? format.perTeam : null;
  }
  if (!Number.isInteger(values.guests) || values.guests < 0) values.guests = 0;
  if (Number.isInteger(values.capacity) && values.guests > values.capacity - 2) {
    errors.guests = 'Leave at least one spot open for someone to join.';
  }

  if (values.venue.length < 2) errors.venue = 'Where are you playing?';

  values.starts_at = parseLocalInput(values.starts_at_input);
  if (!values.starts_at) errors.starts_at = 'Pick a date and time.';
  else if (values.starts_at < new Date(now.getTime() - 5 * 60000)) errors.starts_at = 'That time has already passed.';
  else if (values.starts_at > new Date(now.getTime() + MAX_DAYS_AHEAD * 86400000)) {
    errors.starts_at = `Matches can be planned up to ${MAX_DAYS_AHEAD} days ahead.`;
  }

  if (!DURATIONS.includes(values.duration_min)) values.duration_min = 60;
  if (!inList(GENDER_PREFS, values.gender_pref)) values.gender_pref = 'any';
  if (values.gender_pref !== 'any' && values.gender_pref !== host.gender) {
    errors.gender_pref = 'You can only restrict a match to your own gender.';
  }
  if (!inList(MATCH_SKILLS, values.skill_level)) values.skill_level = 'any';

  return { values, errors, sport, format };
}

module.exports = { isInstituteEmail, validateSignup, validateProfile, validateSkills, validateMatch };
