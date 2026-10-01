-- Applied on every boot; every statement must be idempotent.

CREATE TABLE IF NOT EXISTS users (
  id                  SERIAL PRIMARY KEY,
  email               TEXT NOT NULL UNIQUE,
  password_hash       TEXT NOT NULL,
  name                TEXT NOT NULL,
  enrollment_no       TEXT NOT NULL UNIQUE,
  department          TEXT NOT NULL,
  year                TEXT NOT NULL,
  gender              TEXT NOT NULL CHECK (gender IN ('male', 'female', 'other')),
  phone               TEXT,
  email_verified      BOOLEAN NOT NULL DEFAULT FALSE,
  notify_new_matches  BOOLEAN NOT NULL DEFAULT TRUE,
  email_notifications BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_sports (
  user_id INT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sport   TEXT NOT NULL,
  skill   TEXT CHECK (skill IN ('beginner', 'intermediate', 'advanced')),
  PRIMARY KEY (user_id, sport)
);
CREATE INDEX IF NOT EXISTS user_sports_sport_idx ON user_sports (sport);

-- One-time codes for email verification and password reset.
CREATE TABLE IF NOT EXISTS email_codes (
  user_id    INT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    TEXT NOT NULL CHECK (purpose IN ('verify', 'reset')),
  code_hash  TEXT NOT NULL,
  attempts   INT  NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, purpose)
);

CREATE TABLE IF NOT EXISTS matches (
  id           SERIAL PRIMARY KEY,
  host_id      INT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sport        TEXT NOT NULL,
  format       TEXT NOT NULL,
  capacity     INT  NOT NULL CHECK (capacity BETWEEN 2 AND 30),
  -- Friends the host brings who are not on the app; they fill the host's side first.
  guests       INT  NOT NULL DEFAULT 0 CHECK (guests >= 0 AND guests <= capacity - 2),
  -- Players per side for two-team formats, NULL for group formats.
  team_size    INT,
  venue        TEXT NOT NULL,
  starts_at    TIMESTAMPTZ NOT NULL,
  duration_min INT  NOT NULL DEFAULT 60,
  gender_pref  TEXT NOT NULL DEFAULT 'any' CHECK (gender_pref IN ('any', 'male', 'female')),
  skill_level  TEXT NOT NULL DEFAULT 'any' CHECK (skill_level IN ('any', 'beginner', 'intermediate', 'advanced')),
  notes        TEXT,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'cancelled')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS matches_open_starts_idx ON matches (starts_at) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS matches_host_idx ON matches (host_id);

CREATE TABLE IF NOT EXISTS match_players (
  match_id  INT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  user_id   INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team      CHAR(1) CHECK (team IN ('A', 'B')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, user_id)
);
CREATE INDEX IF NOT EXISTS match_players_user_idx ON match_players (user_id);

CREATE TABLE IF NOT EXISTS match_messages (
  id         SERIAL PRIMARY KEY,
  match_id   INT  NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  user_id    INT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS match_messages_match_idx ON match_messages (match_id, id);

CREATE TABLE IF NOT EXISTS notifications (
  id         SERIAL PRIMARY KEY,
  user_id    INT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  match_id   INT  REFERENCES matches(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  body       TEXT NOT NULL,
  read_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, created_at DESC);
