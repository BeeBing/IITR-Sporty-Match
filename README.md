# IITR Sporty Match

Matchmaking for sports at IIT Roorkee. Post a match, wait for people to tap **“I’m in”**, and play.

## What it does

- **IITR-only sign-up.** Email must end in `iitr.ac.in` (department subdomains like `name@cs.iitr.ac.in` work), plus an 8-digit enrollment number, department or centre, year/programme (1st–5th year, M.Tech, M.Sc, MBA, PhD) and gender.
- **20 sports and games**, each with the right player counts:

  | Sport | Formats |
  | --- | --- |
  | Football | 5v5, 7v7, 11v11, casual kickabout (4–22) |
  | Cricket | Box 6v6, tape-ball 8v8, 11v11, net practice (2–8) |
  | Hockey | 5v5, 7v7, 11v11 |
  | Badminton, Squash, Lawn Tennis, Table Tennis | Singles 1v1, Doubles 2v2 |
  | Basketball | 1v1, 3v3, 5v5 |
  | Volleyball | 4v4, 6v6 |
  | Chess | 1v1 |
  | Carrom, Snooker, 8-Ball Pool, Air Hockey, Foosball | Singles 1v1, Doubles 2v2 |
  | Gym | Workout buddy (2), group workout (3–6) |
  | BGMI | Duo (2), Squad (4), Team Deathmatch 4v4 |
  | Mortal Kombat | 1v1, winner stays on (3–8) |
  | Roblox | Play together (2–10) |

- **Host a match.** The host picks sport, format, time, venue, level and who can join (everyone, or their own gender only). They can say how many friends are already with them. For example, doubles with your partner means the app looks for 2 more. The match then waits until other players join.
- **Teams.** Two-sided formats show Team A and Team B. The host's friends fill Team A first. Joiners can pick a side or be placed automatically, and can switch sides later.
- **Fewer duplicate matches.** If similar open matches exist around the same time, the host is offered those to join first.
- **Live match page.** The roster refreshes on its own. Players in the match can see each other's email and WhatsApp, and get a private match chat, WhatsApp share, and add-to-calendar.
- **Notifications** when someone joins or leaves your match, when it fills ("Game on!"), when it's cancelled, on new chat messages, and when someone posts a match in a sport you play.
- **Profile** with sports and a self-rated level for each, which teammates see on the match page.
- **Profile photo** picked from the phone's gallery or camera, cropped to a circle in the browser (drag, pinch or slider to zoom). The server re-encodes it to a small WebP, which strips hidden metadata such as GPS location. Photos are stored in Postgres and only shown to signed-in students.
- **Email login codes** (needs email set up). Students log in with a 6-digit code sent to their IITR inbox; password login stays as a fallback. Email also turns on verification at sign-up, password reset, and a "your match is full" email.

## Running locally

Needs Node 22+ and PostgreSQL.

```sh
npm install
cp .env.example .env          # point DATABASE_URL at a local database
npm run dev                   # http://localhost:3000
```

The schema in `src/schema.sql` is applied automatically on boot.

### Tests

```sh
createdb sporty_test
TEST_DATABASE_URL=postgres://user:pass@localhost/sporty_test npm test
```

The test suite wipes the test database on every run.

## Deploying on Render

`render.yaml` is a Blueprint for a free web service (`iitrSportyMatch`) and a free Postgres database in Singapore. Set these environment variables on the web service:

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | Use the database's **internal** URL |
| `SESSION_SECRET` | yes | Any long random string |
| `NODE_ENV` | yes | `production` |
| `BREVO_API_KEY` | no | Brevo API key. Turns on login codes, email verification and password reset |
| `MAIL_FROM` | with Brevo | Sender, e.g. `IITR Sporty Match <hello@yourdomain.in>`; must be a sender verified in Brevo |
| `SMTP_URL` | no | Alternative to Brevo on paid plans or locally. Render's free plan blocks outbound SMTP |
| `ALLOWED_EMAIL_DOMAIN` | no | Defaults to `iitr.ac.in` |

Without email set up, accounts are trusted at sign-up: the email format is checked, but nobody proves they own the inbox, and login is password-only. Set up email before sharing the app widely. For reliable delivery to IITR inboxes, send from your own domain authenticated in Brevo; Gmail addresses can't be authenticated as senders.

## Customising

- Sports, formats and player counts: `src/sports.js`
- Venue suggestions per sport type: `VENUES` in `src/sports.js`
- Departments, years and skill levels: `src/constants.js`

## Stack

Express 5, EJS (server-rendered, works without a build step), PostgreSQL via `pg`, and sessions stored in Postgres. bcrypt for passwords, Helmet for security headers, CSRF tokens on every form, and rate-limited auth endpoints.
