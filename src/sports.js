'use strict';

// Every format is one of two shapes:
//   sides — two teams of `perTeam` players; the match needs exactly perTeam * 2.
//   group — no sides (gym, nets, kickabouts); the host picks a size between min and max.
const sides = (key, label, perTeam) => ({ key, label, type: 'sides', perTeam, min: perTeam * 2, max: perTeam * 2 });
const group = (key, label, min, max) => ({ key, label, type: 'group', perTeam: null, min, max });

const singles = sides('singles', 'Singles (1v1)', 1);
const doubles = sides('doubles', 'Doubles (2v2)', 2);

const CATEGORIES = [
  { key: 'field', name: 'Field sports' },
  { key: 'court', name: 'Court & racket' },
  { key: 'table', name: 'Indoor & table games' },
  { key: 'fitness', name: 'Fitness' },
  { key: 'esports', name: 'Esports & gaming' },
];

const SPORTS = [
  {
    key: 'football', name: 'Football', emoji: '⚽', category: 'field',
    formats: [
      sides('5v5', '5-a-side (5v5)', 5),
      sides('7v7', '7-a-side (7v7)', 7),
      sides('11v11', 'Full match (11v11)', 11),
      group('casual', 'Casual kickabout', 4, 22),
    ],
  },
  {
    key: 'cricket', name: 'Cricket', emoji: '🏏', category: 'field',
    formats: [
      sides('box', 'Box cricket (6v6)', 6),
      sides('8v8', 'Tape-ball (8v8)', 8),
      sides('11v11', 'Full match (11v11)', 11),
      group('nets', 'Net practice', 2, 8),
    ],
  },
  {
    key: 'hockey', name: 'Hockey', emoji: '🏑', category: 'field',
    formats: [
      sides('5v5', 'Hockey5s (5v5)', 5),
      sides('7v7', '7-a-side (7v7)', 7),
      sides('11v11', 'Full match (11v11)', 11),
    ],
  },
  { key: 'badminton', name: 'Badminton', emoji: '🏸', category: 'court', formats: [singles, doubles] },
  { key: 'squash', name: 'Squash', emoji: '🟡', category: 'court', formats: [singles, doubles] },
  { key: 'lawn-tennis', name: 'Lawn Tennis', emoji: '🎾', category: 'court', formats: [singles, doubles] },
  { key: 'table-tennis', name: 'Table Tennis', emoji: '🏓', category: 'court', formats: [singles, doubles] },
  {
    key: 'basketball', name: 'Basketball', emoji: '🏀', category: 'court',
    formats: [
      sides('1v1', 'One-on-one (1v1)', 1),
      sides('3v3', 'Half court (3v3)', 3),
      sides('5v5', 'Full court (5v5)', 5),
    ],
  },
  {
    key: 'volleyball', name: 'Volleyball', emoji: '🏐', category: 'court',
    formats: [sides('4v4', 'Casual (4v4)', 4), sides('6v6', 'Standard (6v6)', 6)],
  },
  { key: 'chess', name: 'Chess', emoji: '♟️', category: 'table', formats: [sides('1v1', 'Game (1v1)', 1)] },
  { key: 'carrom', name: 'Carrom', emoji: '🎯', category: 'table', formats: [singles, doubles] },
  { key: 'snooker', name: 'Snooker', emoji: '🔴', category: 'table', formats: [singles, doubles] },
  { key: '8-ball-pool', name: '8-Ball Pool', emoji: '🎱', category: 'table', formats: [singles, doubles] },
  { key: 'air-hockey', name: 'Air Hockey', emoji: '🏒', category: 'table', formats: [singles, doubles] },
  { key: 'foosball', name: 'Foosball (table football)', emoji: '🥅', category: 'table', formats: [singles, doubles] },
  {
    key: 'gym', name: 'Gym', emoji: '🏋️', category: 'fitness',
    formats: [group('buddy', 'Workout buddy', 2, 2), group('group', 'Group workout', 3, 6)],
  },
  {
    key: 'running', name: 'Running', emoji: '🏃', category: 'fitness',
    // Sports with their own spot override the category's venue hints and prefill the venue.
    venues: ['LBS ground', 'Around campus'],
    defaultVenue: 'LBS ground',
    formats: [group('buddy', 'Running buddy', 2, 2), group('group', 'Group run', 3, 20)],
  },
  {
    key: 'bgmi', name: 'BGMI', emoji: '🪂', category: 'esports',
    formats: [
      group('duo', 'Duo (2)', 2, 2),
      group('squad', 'Squad (4)', 4, 4),
      sides('tdm', 'Team Deathmatch (4v4)', 4),
    ],
  },
  {
    key: 'mortal-kombat', name: 'Mortal Kombat', emoji: '🥋', category: 'esports',
    formats: [sides('1v1', 'Fight (1v1)', 1), group('winner-stays', 'Winner stays on', 3, 8)],
  },
  {
    key: 'roblox', name: 'Roblox', emoji: '🧱', category: 'esports',
    formats: [group('party', 'Play together', 2, 10)],
  },
];

const BY_KEY = new Map(SPORTS.map((s) => [s.key, s]));

function getSport(key) {
  return BY_KEY.get(key) || null;
}

function getFormat(sportKey, formatKey) {
  const sport = getSport(sportKey);
  return (sport && sport.formats.find((f) => f.key === formatKey)) || null;
}

// Suggested venues, shown as autocomplete hints; hosts can type anything.
const VENUES = {
  field: ['Main ground', 'Cricket ground', 'Hockey ground', 'Bhawan ground'],
  court: ['MAC (Multi Activity Centre)', 'Badminton hall', 'Squash courts', 'Tennis courts', 'Basketball courts', 'Volleyball courts', 'Bhawan common room'],
  table: ['Bhawan common room', 'SAC (Student Activity Centre)', 'MAC (Multi Activity Centre)'],
  fitness: ['Institute gym', 'Bhawan gym', 'MAC (Multi Activity Centre)'],
  esports: ['Online', 'Online (Discord voice)', 'Bhawan common room', 'Hostel room'],
};

function venuesFor(sportKey) {
  const sport = getSport(sportKey);
  if (!sport) return [];
  return sport.venues || VENUES[sport.category];
}

module.exports = { SPORTS, CATEGORIES, getSport, getFormat, venuesFor };
