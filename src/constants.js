'use strict';

const DEPARTMENTS = [
  'Architecture and Planning',
  'Biosciences and Bioengineering',
  'Chemical Engineering',
  'Chemistry',
  'Civil Engineering',
  'Computer Science and Engineering',
  'Design',
  'Earth Sciences',
  'Earthquake Engineering',
  'Electrical Engineering',
  'Electronics and Communication Engineering',
  'Humanities and Social Sciences',
  'Hydro and Renewable Energy',
  'Hydrology',
  'Management Studies',
  'Mathematics',
  'Mechanical and Industrial Engineering',
  'Metallurgical and Materials Engineering',
  'Physics',
  'Water Resources Development and Management',
  'Applied Science and Engineering (Saharanpur)',
  'Paper Technology (Saharanpur)',
  'Polymer and Process Engineering (Saharanpur)',
  'Mehta Family School of Data Science and AI',
  'Centre for Nanotechnology',
  'Centre of Excellence in Disaster Mitigation and Management',
  'Centre for Transportation Systems (CTRANS)',
];

const YEARS = [
  { key: '1', label: '1st year' },
  { key: '2', label: '2nd year' },
  { key: '3', label: '3rd year' },
  { key: '4', label: '4th year' },
  { key: '5', label: '5th year (dual / integrated)' },
  { key: 'mtech', label: 'M.Tech' },
  { key: 'msc', label: 'M.Sc' },
  { key: 'mba', label: 'MBA' },
  { key: 'phd', label: 'PhD' },
];

const GENDERS = [
  { key: 'male', label: 'Male' },
  { key: 'female', label: 'Female' },
  { key: 'other', label: 'Other / prefer not to say' },
];

// Who may join a match. Hosts can only restrict to their own gender.
const GENDER_PREFS = [
  { key: 'any', label: 'Open to everyone' },
  { key: 'male', label: 'Men only' },
  { key: 'female', label: 'Women only' },
];

const SKILLS = [
  { key: 'beginner', label: 'Beginner' },
  { key: 'intermediate', label: 'Intermediate' },
  { key: 'advanced', label: 'Advanced' },
];

const MATCH_SKILLS = [{ key: 'any', label: 'All levels welcome' }, ...SKILLS];

const DURATIONS = [30, 45, 60, 90, 120, 180];

const label = (list, key) => (list.find((x) => x.key === key) || { label: key }).label;

module.exports = { DEPARTMENTS, YEARS, GENDERS, GENDER_PREFS, SKILLS, MATCH_SKILLS, DURATIONS, label };
