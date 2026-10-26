# Dispatch — Email Automation Platform

Single-organization platform for **scheduled campaigns** and **event-triggered transactional email**.
Queue-backed sending, template rendering with `{{variables}}`, delivery/open/click tracking, and
suppression enforcement. See [`docs/technical-design.html`](docs/technical-design.html) for the design.

**MySQL is the only infrastructure.** No Redis, no Docker — the job queue is a table.

## Stack

| Area | Choice |
| --- | --- |
| API | Node 20, TypeScript, Express, Prisma (MySQL 8) |
| Queue | MySQL-backed `Job` table + polling workers — scheduler, campaign fan-out, rate-limited send worker, dead-letter (`status = DEAD`) |
| Email | Provider interface — `mock` (writes to `.mail-outbox/`, default), `smtp` (nodemailer), `ses` (AWS); selected by `EMAIL_PROVIDER` |
| Web | React + Vite, React Query, Tailwind |
| Auth | JWT access token + httpOnly refresh cookie; `ADMIN` / `EDITOR` roles |

## Quick start

Prerequisites: **Node 20+** and a local **MySQL 8** server. Optional: **Python 3.10** for the AI
voice backend (`kagzso-voice-backend-english/`) and **Ollama** for Data Quality AI scores.

### First time

```bash
cp .env.example .env                 # set DB_HOST/PORT/NAME/USER/PASSWORD + SEED_ADMIN_*, edit secrets
npm install
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS dispatch CHARACTER SET utf8mb4;"
npm run prisma:deploy                # apply migrations
npm run db:seed:plan                 # show what the seed would create/skip (read-only)
npm run seed                         # bootstrap admin (idempotent; needs the seed-safety vars below)
```

`DB_PASSWORD` must be the MySQL user's real password (empty only if that user has none). Check it
with `mysql -u root -p` first: the login that works there is the one to put in `.env`.

For AI calls, set up the voice backend once as [its README](kagzso-voice-backend-english/README.md)
describes (its own `.venv`, `.env` and MySQL database), then apply its migrations:

```powershell
cd kagzso-voice-backend-english
.\.venv\Scripts\python -m alembic upgrade head
```

Without that `.venv`, `npm run dev` skips the voice backend and starts everything else.

### Every day

```bash
npm run dev                          # api :4000, worker, web :5173, voice backend :8002
```

Log in at http://localhost:5173 with `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`.
Re-running the seed never overwrites an existing password; see [Users and passwords](#users-and-passwords)
for resetting it and adding more users.

Check that everything reached its database:

```bash
curl http://localhost:4000/health    # {"status":"ok","checks":{"db":"ok"}}
curl http://localhost:8002/ready     # "status":"ready" with "mysql":"ok"
```

Stop with `Ctrl+C`, or from any terminal with `npm run dev:kill`. The processes read `.env` only
when they start, so restart after editing it.

### If it doesn't start

| Symptom | Fix |
| --- | --- |
| `/health` returns 503 `"db":"fail"`; the log says `Authentication failed … credentials for root are not valid` | `DB_PASSWORD` doesn't match MySQL. Find the working login with `mysql -u root -p`, put that password in `.env` (and in the voice backend's `MYSQL_PASSWORD`), restart. |
| Voice `/ready` shows `"mysql":"error"`, or `Could not seed default agent` at startup | The voice backend's `MYSQL_*` settings are wrong, or its database or migrations are missing: create the database and run `alembic upgrade head` there. |
| `Cannot start npm run dev — a dev stack is already running` | `npm run dev:kill`, then `npm run dev` again. |
| `[voice] No .venv in kagzso-voice-backend-english` | Create the `.venv` (voice backend README), or ignore it if you don't need AI calls. |
| Data Quality says `OLLAMA_BASE_URL is not set` | Only the AI score needs it: start Ollama, pull a model, set `OLLAMA_BASE_URL=http://127.0.0.1:11434` and `OLLAMA_MODEL` in `.env`, restart. The standard checks work without it. |

### Processes

- `npm run dev:api` — REST API + webhook ingestion (`apps/api/src/index.ts`)
- `npm run dev:worker` — polling job workers + the scheduler (`apps/api/src/worker.ts`)
- `npm run dev:web` — dashboard
- `npm run dev:voice` — the voice backend from `kagzso-voice-backend-english/.venv`, auto-reloading, on
  the port in `VOICE_BACKEND_URL` (default `8002`); skipped with a message when its folder or `.venv`
  is missing or the port is taken

Run **one** worker process. The queue engine is safe under concurrent workers (jobs are
claimed with a conditional `UPDATE`), but the scheduler assumes a single instance.

`npm run dev` runs a preflight check (`scripts/predev.mjs`): if `:4000` or `:5173` is
already listening it stops with a message instead of half-starting a second stack (Vite
drifting to `:5174`, the API crashing with `EADDRINUSE`). Free the ports and retry:

```powershell
npm run dev:kill   # Windows: stops only this repo's dev processes + frees 4000/5173/5174/8002
```

The API port (`4000`) and web port (`5173`, `strictPort`) are fixed on purpose — don't
change them to dodge a conflict; kill the stale process instead.

## Try the pipeline

**Scheduled campaign** — create a template + list in the UI, then a campaign with a send time a
minute out. Watch `.mail-outbox/` fill at the configured rate (1/sec in sandbox).

**Triggered email** — create an API key in Settings and a trigger, then:

```bash
curl -X POST http://localhost:4000/api/webhooks/trigger/user.signup \
  -H 'Content-Type: application/json' -H 'X-Api-Key: sk_...' \
  -d '{"contactEmail":"new@example.com","payload":{"plan":"pro"}}'
```

Calling it twice with the same body produces exactly one send (idempotency key).

**Simulate delivery events** (dev only, mock provider):

```bash
curl -X POST http://localhost:4000/api/webhooks/dev/simulate/<emailLogId>/delivered
curl -X POST http://localhost:4000/api/webhooks/dev/simulate/<emailLogId>/bounced   # auto-suppresses
```

## Tests

```bash
npm test        # unit + HTTP-gate tests (no database needed)
```

Covers rendering, conditions, idempotency, WhatsApp, AI calls, call flows, the dashboard channel
numbers and the Send Queue file tools. `npm run typecheck` and `npm run build` should also pass.

Integration tests against a real MySQL are stubbed for milestone M9 (see design doc §11).

## Ops

- `GET /health` — MySQL reachability (200 / 503)
- `GET /api/jobs` — queue state (pending / active / dead counts + recent rows), requires an `ADMIN` JWT;
  `POST /api/jobs/:id/retry` requeues one
- Structured logs via pino; set `SENTRY_DSN` to enable error tracking

## Users and passwords

`npm run seed` creates the `SEED_ADMIN_EMAIL` admin only if that email doesn't exist yet. It never
changes an existing user's password unless `SEED_ADMIN_RESET=true` — to recover a forgotten admin
password, set it in `.env`, run `npm run seed` once, then set it back to `false`. A reset changes the
password only; the role is kept.

The seed refuses to run unless `SEED_EXPECTED_DATABASE` equals the database it actually connected to
(`SELECT DATABASE()`), and it writes only when `ALLOW_DATABASE_SEED=true` is also set. Run
`npm run db:seed:plan` first: it prints each record as create/skip and writes nothing. Sample data
(template, list, three contacts, trigger) is added only with `SEED_SAMPLE_DATA=true` — never in production.

Everything else is done by admins under **Settings**:

- **Users** — list users, add one (email, password, `ADMIN` or `EDITOR` role; a **Generate strong
  password** button fills a random one), and disable / re-enable accounts. You can't disable
  yourself or the last active admin. A disabled user can't log in, and an open session ends at its
  next token refresh; re-enabling restores the old password.
- **Change password** — change your own password (current password required).

Passwords must be 10–72 bytes (bcrypt reads only the first 72). The API is `/api/users`
(`GET`, `POST`, `PATCH /:id` with `{ disabled }`, `POST /me/password`), `ADMIN` JWT only; responses
never include password hashes.

## Deployment

Plain Node processes plus a managed MySQL. Run `apps/api` twice (one `start:api`, one
`start:worker`), set `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` for the
database, run `npm run prisma:deploy` on release. No broker to operate.

## Environment

See [`.env.example`](.env.example). The database is configured with discrete variables
(`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`); [`scripts/db-url.mjs`](scripts/db-url.mjs)
assembles the connection string Prisma needs, and the `prisma:*` npm scripts pass it to the CLI —
run those rather than bare `npx prisma`. Setting `DATABASE_URL` directly still works and overrides
the parts. Other key knobs: `EMAIL_PROVIDER`, `SEND_RATE_PER_SEC`, `SEND_DAILY_CAP`,
`SEND_MAX_ATTEMPTS`, `SCHEDULER_TIMEZONE`.

## WhatsApp (Meta WhatsApp Cloud API)

WhatsApp is isolated from email — its own tables, config (`apps/api/src/config/whatsapp.ts`) and
`META_WHATSAPP_*` variables; leaving them blank only disables WhatsApp. To go live:

1. In Meta Business: a WhatsApp Business Account with a phone number registered on the Cloud API,
   and a system-user **permanent** access token with `whatsapp_business_messaging`.
2. Set `META_WHATSAPP_ACCESS_TOKEN`, `META_WHATSAPP_PHONE_NUMBER_ID`, `META_WHATSAPP_WABA_ID`,
   `META_WHATSAPP_APP_SECRET` and a random `META_WHATSAPP_WEBHOOK_VERIFY_TOKEN` (or enter them under
   Settings → WhatsApp and press **Test connection**).
3. In the Meta app → WhatsApp → Configuration, set the callback URL to
   `https://<public API host>/api/webhooks/whatsapp` with the same verify token, and subscribe to
   the `messages` field. The webhook rejects any request without a valid `X-Hub-Signature-256`.
4. Register each approved template on the WhatsApp Templates page by its exact Meta name and
   language. Template variables map to the positional body parameters `{{1}}`, `{{2}}`, ….

Smoke test from the repo root: `npx tsx apps/api/scripts/whatsapp-test-send.ts --check`, then
`--to 91XXXXXXXXXX --template <name> --lang <code>`. Delivery/read/failed statuses and replies arrive
on the webhook; replies are listed at `GET /api/whatsapp/inbound`.

## AI voice calls (kagzso-voice-backend)

The **AI Call** button on the Contacts page (next to *Send WhatsApp*) places outbound AI voice
calls through [`kagzso-voice-backend-english`](kagzso-voice-backend-english/README.md), with the
customers read from an Excel / CSV file. It is isolated like WhatsApp: its own tables
(`ai_call_runs`, `ai_call_logs`), config (`apps/api/src/config/aiCalls.ts`), routes
(`/api/ai-calls`), queue (`ai-call-run`) and env vars. With `ENABLE_AI_CALLS=false` (the default)
the button is hidden and the routes return 404.

**How it works.** Upload a sheet with `customer_name`, `gender`, `follow_up_detail`, `phone`
(variants such as *name / full name*, *sex*, *follow up / notes*, *mobile / phone number* are
auto-detected and can be remapped). The preview flags missing/invalid phones (red, not called),
unknown genders and duplicate numbers (amber). Pick **Random N**, **Selected rows** or **All rows**,
set the gap and max calls, confirm, and watch each call's status (queued → dialing → ringing → in
progress → completed / no answer / busy / failed), refreshed every 3 seconds.

Server side, `POST /api/ai-calls/start` normalizes phones to E.164 (default +91), drops duplicates
and do-not-call numbers (unsubscribed / bounced / complained email contacts, unsubscribed / blocked
WhatsApp contacts, and anyone who said "don't call me" on an earlier AI call), picks random rows
with a crypto Fisher–Yates shuffle (never the same number twice), and enforces the per-run and
daily caps. The `ai-call-run` worker then calls **one customer at a time**: it dials, waits for that
call to end, waits the gap, and dials the next. Status arrives two ways: signed callbacks from
the voice backend (`POST /api/webhooks/ai-calls`) and a poll of the voice backend every 5 s while a
call is in flight, so a lost callback never stalls a run. Only `ADMIN` users can start calls; only
one run can be active at a time; phone numbers are masked in logs.

Calls run the voice backend's standard **Nila** flow (`VOICE_AGENT_NAME=Nila`, the default; the names
`Radhi` and `Kayal` also still work): *"Hi sir, Good afternoon."* → after a 1-second pause, or as soon as the customer
says anything, *"Am I speaking with Raagul, sir?"* → *"Thank you, sir. This is Nila from Kexo AI and
Automation… one minute?"* → short intro → the repetitive-work question → *"useful for your business?"* →
close (sir / madam from the given gender, otherwise `CALL_DEFAULT_TITLE`; do-not-call always wins). Nila
needs a `customer_name` — rows without one fail with a clear error. Set `VOICE_AGENT_NAME=Follow-up`
instead to use the follow-up agent, which greets *"Hello Mr. Ragul, this is Nila from Kagzso AI and
Automation…"* and opens with
*"I'm calling regarding: <follow_up_detail>"*.

### Setup

1. Run the voice backend (see its README): fill in its `.env`, run `alembic upgrade head`, and start
   it on port 8002 with a public `PUBLIC_BASE_URL` (ngrok) so Plivo/Twilio can reach it. In its
   `.env` also set the callback target:

   ```env
   STATUS_CALLBACK_URL=http://localhost:4000/api/webhooks/ai-calls
   STATUS_CALLBACK_SECRET=<random string, 16+ chars>
   ```

2. In this repo's `.env`:

   ```env
   ENABLE_AI_CALLS=true
   VOICE_BACKEND_URL=http://localhost:8002
   VOICE_BACKEND_API_KEY=<the voice backend's ADMIN_API_KEY>
   AI_CALL_WEBHOOK_SECRET=<same value as STATUS_CALLBACK_SECRET>
   ```

   Optional: `VOICE_AGENT_ID` / `VOICE_AGENT_NAME` (default `Nila`),
   `AI_CALLS_DEFAULT_COUNTRY_CODE` (91), `AI_CALLS_MAX_PER_RUN` (10, max 100),
   `AI_CALLS_DAILY_CAP` (100 per 24 h), `AI_CALLS_MIN_GAP_SEC` (10), `AI_CALLS_CALL_TIMEOUT_SEC` (900).

3. Apply the migration (adds two new tables, changes no existing ones) and restart:

   ```bash
   npm run prisma:deploy     # applies prisma/migrations/0017_ai_calls
   npm run prisma:generate
   npm run dev
   ```

### Test with one random call

> The sample file's numbers (`+91 90000 0000x`) are placeholders and may belong to real people.
> Before testing, **replace every phone in the file with your own number** (on a trial
> Plivo/Twilio account it must be a verified number). Duplicates of your number are dialled once.

1. Open [`scripts/sample-ai-calls.xlsx`](scripts/sample-ai-calls.xlsx), put your own mobile number
   in the `phone` column, save.
2. Sign in as an admin → **Contacts** → **AI Call** → *Choose file*.
3. Leave **Random = 1**, gap 30 s, max 10 → **Review & start** → **Start 1 call**.
4. Answer your phone. The status table moves through dialing → ringing → in progress → completed,
   then shows the outcome, summary and transcript.

Unit tests: `npm test` (parsing, E.164, random selection, planning, signatures, route gates) and,
in the voice backend, `pytest` (Follow-up agent, prompt variables, endpoint, callbacks).

### Call Flows (edit the voice script in the UI)

Off by default. With `ENABLE_AI_CALLS=true` **and** `ENABLE_CALL_FLOW_EDITOR=true`, admins get a
**Call Flows** page in the sidebar and a *Call flow* picker in the AI Call window. With the editor
flag off (or the picker left on *Default flow*), calls go out exactly as before.

- **A flow is a copy of a built-in script**: *Nila screening* or *Customer follow-up*. The built-ins
  live in the voice backend (`kagzso-voice-backend-english/app/flows/builtin/*.json`) and rebuild
  the old `nila.md` / `followup.md` prompts byte for byte (a regression test checks this).
- **Editable:** name, voice id, greeting line, the script blocks (greeting, main script, questions,
  objection handling, closing, tone & style, rules), the two no-response lines, and the max duration
  (capped by the voice backend's `MAX_CALL_DURATION_SECONDS`). The transfer number is saved but not
  used yet (live transfer isn't implemented).
- **Fixed in code:** the locked safety blocks (do-not-call, wrong person, customer-data rules,
  outcome / callback rules), the safety rules every prompt gets (honest AI disclosure if asked,
  do-not-call ends the call, no false claims, never ask for OTPs / card details), unanswered /
  busy / voicemail handling, do-not-call lists, caps, auth and webhook signatures.
- **Variables:** `{{customer_name}}` (or `{{name}}`), `{{honorific}}` (Mr./Ms.), `{{title}}`
  (sir/madam), `{{gender}}`, `{{addressed_name}}`, `{{follow_up_detail}}`, `{{company_name}}`,
  `{{business_type}}`. Anything else, including `{{phone_number}}`, is rejected.
- **Versions:** saving creates or updates the flow's single draft; **Publish** freezes it as
  version *n* (published versions are never edited; *Restore into draft* copies an old one back).
  A run pins the published version it started with, so later edits never change queued calls.
- **Preview** renders the greeting, no-response lines and full AI prompt with sample customer data
  through the voice backend (the same code a real call uses).
- **Test call to my number** places one real call with the draft or any version, only to a
  **trial number**. Admins add trial numbers in the popup itself (+91 is preselected; up to 5;
  shown masked, e.g. `+91 98XXX XXX10`) and remove them with the trash button. The call request
  carries only the id of a listed number, never a typed-in number. `AI_CALL_FLOW_TEST_NUMBERS`
  is **optional**: numbers listed there are allowed too, as a fallback. A test call counts toward
  the daily cap, is refused while another run is in progress or if the number is on the
  do-not-call list, and is limited to 3 per minute and 3 per hour per admin. Trial numbers need
  `npm run prisma:deploy` (`0023_ai_call_test_numbers`: one new table, `ai_call_test_numbers`);
  until then the popup says so and only the env numbers work. Rollback: run
  `prisma/migrations/0023_ai_call_test_numbers/down.sql`, then
  `npx prisma migrate resolve --rolled-back 0023_ai_call_test_numbers`.
- **Fallback:** if a flow sent to the voice backend is missing or invalid, or a published version
  arrives with different content, the call still goes out with the default agent and the call log
  records `flow_fallback` (`missing` / `invalid` / `version_conflict`).

Setup: `npm run prisma:deploy` (applies `0018_call_flows`: three new tables, `call_flows`,
`call_flow_versions`, `ai_call_run_flows`; no existing table changes), then set the two flags.

**Rollback:** set `ENABLE_CALL_FLOW_EDITOR=false` (calls use the default agent at once). To remove
the tables, run `prisma/migrations/0018_call_flows/down.sql` against the database, then
`npx prisma migrate resolve --rolled-back 0018_call_flows`.

### AI Call Customers and follow-ups

With `ENABLE_AI_CALLS=true`, admins get an **AI Call Customers** page in the sidebar
(`/ai-call-customers`, next to Call Flows). It is separate from the email **Contacts** page and the
**WhatsApp Contacts** page, which are unchanged. Editors don't see it.

- **Customers:** name, gender, phone, business, follow-up detail, optional email and a WhatsApp
  opt-in flag. They are stored in their own table (`ai_call_customers`), never in the email
  `Contact` table or in WhatsApp contacts. *Add customer* adds one; *Import file* takes a
  `.xlsx` / `.csv` (columns auto-detected, preview with errors highlighted, only valid rows are
  imported, then a summary of imported / skipped / duplicates). *Download sample file* gives
  `scripts/sample-ai-call-customers.xlsx`. *Delete* is a soft delete: the row leaves the list, but its
  call history and do-not-call status are kept.
- **Phone numbers (+91 default):** every customer phone goes through the shared
  `normalizePhoneE164`. A 10-digit number, `91XXXXXXXXXX`, `0XXXXXXXXXX` and `+91 XXXXX XXXXX` all
  become `+91XXXXXXXXXX`. A number with another explicit country code (`+44 …`) is kept. Customers
  are deduped on the normalized number and shown as `+91 XXXXX XXXXX`. The email and WhatsApp
  contact forms and their stored numbers are not changed.
- **Calling:** tick customers and press *Call selected*, or use *AI Call* and pick *Saved
  customers* (random N / selected / all) or *Upload file* (as before). The same planner, limits,
  do-not-call list, call flows and voice backend are used.
- **Call stages:** Not called → Queued → Calling → a suggested stage from the result. *No answer*
  and *Failed* come from the call status. *Interested*, *Not interested*, *Follow-up needed* and
  *Callback requested* come from the voice backend's AI outcome. The call's transcript and summary
  are on the customer's *call detail*, where an admin can **Approve**, **Reject** or change the
  stage. **Do not call** is applied at once, is permanent, and blocks every future call to that
  number (also for soft-deleted customers).
- **Follow-ups → Send Queue → AI Call follow-ups:** *Interested*, *Follow-up needed* and
  *Approved* create a WhatsApp follow-up if the customer opted in, otherwise a scheduled
  call-again. *Callback requested* creates a call-again. *No answer* creates a call-again only up to
  `AI_CALL_FOLLOWUP_MAX_RETRIES` times. *Not interested*, *Do not call* and *Failed* create nothing.
  Admins can also add a follow-up from the call detail. Every follow-up starts as **Pending
  approval**, and **nothing is sent until an admin approves it** (with *Edit* to pick the Meta
  template or change the call time first, and *Reject* to drop it). On approval, WhatsApp goes
  through the existing WhatsApp batch sender (it appears on the WhatsApp tab), and a call-again
  becomes a one-call AI call run at the chosen time (the existing call worker, daily cap and
  do-not-call checks apply). There are no email follow-ups: email can only go to rows of the email
  `Contact` table, which this feature does not touch.
- **Timeline:** each customer shows call → outcome → follow-up created → approved → sent →
  replied. "Sent" and "replied" come from the WhatsApp ledger and inbound WhatsApp messages.
  Email replies are not tracked.

Setup: `npm run prisma:deploy` applies `0019_ai_call_customers`. It creates four new tables
(`ai_call_customers`, `ai_call_customer_calls`, `ai_call_customer_events`,
`ai_call_followups`) and changes no existing table.

**Rollback:** set `ENABLE_AI_CALLS=false` to hide the page and the follow-up queue. To remove the
tables, run `prisma/migrations/0019_ai_call_customers/down.sql`, then
`npx prisma migrate resolve --rolled-back 0019_ai_call_customers`.

### WhatsApp media (header media, received files, Inbox)

WhatsApp only, following Meta's Cloud API media rules:

| Type | Formats | Max size |
|---|---|---|
| Image | JPG, PNG | 5 MB |
| Video | MP4, 3GP (H.264 + AAC) | 16 MB |
| Audio | AAC, AMR, MP3, M4A, OGG (Opus) | 16 MB |
| Document | PDF, DOC/DOCX, XLS/XLSX, PPT/PPTX, TXT | 100 MB |
| Sticker | WebP | 500 KB animated / 100 KB static |

- **Template header media.** If a Meta template has an image, video or document header,
  set the file on **WhatsApp Templates → Header**. Every send of that template then includes it.
  The file is uploaded to Meta when first sent, and that media ID is reused until Meta's 30-day
  expiry. Templates without header media send exactly as before. The Send dialog only offers a
  media-header template once its header file is set. Header *variables* (text) and location headers
  aren't supported yet.
- **Files customers send.** Images, videos, voice notes, documents and stickers that arrive through
  the webhook are recorded at once and downloaded in the background (`whatsapp-media-download`
  queue). Each download gets a fresh Meta URL, is authenticated, size-capped, checked against Meta's
  sha256 and against its real content type, then stored once. Webhook redeliveries never download
  twice. Media older than Meta's 7-day limit is marked *expired*.
- **WhatsApp Inbox** (admins). Conversations with image, video and audio previews, document
  downloads, captions and delivery status. You can reply with text or one attachment, but only
  within **24 hours of the customer's last message** (Meta's customer-service window). After that,
  send an approved template.
- **Storage and security.** Files live in `WHATSAPP_MEDIA_DIR` (default `.whatsapp-media`, which
  git ignores) under random names. They are never served statically: the only way to get them is
  `GET /api/whatsapp/media/:id/file`, and customer files are ADMIN-only. The type is detected from
  the file's bytes, not its name. Media is only downloaded from Meta's own HTTPS hosts. API
  responses never contain paths, tokens or Meta media IDs.

Setup: run `npm run prisma:deploy`. It applies `0020_whatsapp_media`, which adds three new tables
(`whatsapp_media`, `whatsapp_template_header_media`, `whatsapp_send_media`) and changes no existing
table. Until it's applied, sends and the templates page work as before, without header media.
Receiving media needs the Meta webhook connected (a public HTTPS callback to
`/api/webhooks/whatsapp`, subscribed to `messages`).

**Rollback:** run `prisma/migrations/0020_whatsapp_media/down.sql`, then
`npx prisma migrate resolve --rolled-back 0020_whatsapp_media`. Stored files stay in the folder
until you delete them.

## Dashboard (Email, WhatsApp and AI Calls)

The Dashboard (`/`) shows real usage for all three channels. A switch at the top picks **All**,
**Email**, **WhatsApp** or **Calls** (remembered for the browser session), and one **7d / 14d / 30d**
toggle drives every section. Numbers refresh every 45 seconds while the tab is visible. Days are UTC,
like the email engagement chart. Nothing is invented: with no data you see zeros and empty states.

- **All:** one card per channel (emails sent, WhatsApp sent, calls made) with the change against the
  previous period of the same length, then the three sections below.
- **Email:** the existing daily send cap, active contacts, active campaigns and engagement chart,
  unchanged, plus open rate, click rate, bounced and failed for the range.
- **WhatsApp:** sent, delivered, read, failed (with success rate), incoming messages and replies,
  unread (admins only), a daily chart, the last 5 Send Queue batches, top templates, and a link to the
  Inbox when there are unread messages.
- **Calls** (admins, when `ENABLE_AI_CALLS=true`): total calls, answered rate, average and total
  duration, pending follow-ups, a daily chart, the outcomes breakdown and calls by flow.

Each section loads on its own, so one failing section doesn't break the others. Links to pages
hidden in **Settings → Sidebar** are hidden here too; the numbers still show.

The data comes from read-only endpoints next to the existing ones (whose responses are unchanged):
`GET /api/dashboard/email`, `/api/dashboard/whatsapp` and `/api/dashboard/calls`, each with
`?days=7|14|30`. They only read existing tables; no migration is needed.

## Send Queue tools

Both tools are read-only (they never change contacts, batches or history) and sit in the toolbar
above each Send Queue tab, next to the Status filter.

**Upload new file (filter new data).** Upload a `.csv` or `.xlsx` of people you plan to contact. It's
compared with that tab's history only: Email with email, WhatsApp with WhatsApp, AI Call with AI calls.
The email or phone column is detected (you can change it). Emails are compared trimmed and lowercased.
Phones are normalized with the channel's default country code (91 unless configured), so
`98765 43210`, `09876543210` and `+919876543210` match. You get a summary (total, invalid, duplicates in
the file, already used, failed before, new) and two downloads in your file's own format: **new only**
and an **already-used report** (with a *Previous status* column). Sent, done and still-sending entries
count as used; failed ones stay in the new file so they can be retried. Up to 20 MB and 100,000 rows.
Endpoints: `POST /api/send-queue/filter/:channel/analyze` and `/download` (`email`, `whatsapp`,
`ai-call`).

**Download all history.** Exports the complete history of the active tab as one CSV, whatever the
Status filter, page or page size: `send-history-{channel}-{YYYY-MM-DD}.csv`. Email and WhatsApp give one
row per recipient (batch ID, template, name, email or phone, status, result, sent / delivered / opened /
failed times, error, batch started / completed) using the per-batch download's column names. AI Call
follow-ups give one row per follow-up. The file is streamed from
`GET /api/send-queue/history/:channel/export` (`email`, `whatsapp`, `ai-followups`); the button is
disabled when there's no history.

AI call data in both tools is admin-only and returns 404 while `ENABLE_AI_CALLS=false`, like the AI Call
follow-ups tab.

## Look and feel

- **Theme:** soft blue-lavender background, white cards, a cyan-to-green accent gradient and navy text.
  All colors are CSS variables in `apps/web/src/index.css` (`:root`) that the Tailwind config reads, so
  changing one value updates the whole app. Primary buttons use navy text on the gradient for contrast,
  and animations are switched off for users who prefer reduced motion.
- **Logo:** `apps/web/src/components/Logo.tsx` shows the hexagon logo on the login card, in the sidebar
  (expanded and collapsed) and in the mobile top bar. The files live in `apps/web/public/`
  (`logo-512.png`, `logo-128.png`, `logo-64.png`, `favicon.ico`, `favicon-16.png`, `favicon-32.png`,
  `apple-touch-icon.png`). To change the logo, replace those files with the same names and bump the
  `?v=` number in `Logo.tsx` and `apps/web/index.html` so browsers fetch the new ones.
- **App name (Settings → Branding, admins only):** changes the app name everywhere it is shown on
  screen, for everyone: sidebar header, mobile top bar, browser tab, login page and the in-app
  sentences that mention the app. 1–24 characters: letters, numbers, spaces and `. , - _ & ' ( ) ! ?`
  (HTML is stripped in the form and rejected by the API). The panel has a live preview and an
  unsaved-changes warning. Each browser remembers the last name it saw, so a refresh shows the new name
  immediately (no "Dispatch" flash). It is display text only: the email sender name (`EMAIL_FROM`),
  calendar invites, WhatsApp, call scripts, routes and code keep "Dispatch". API:
  `GET /api/branding` (public, read-only, app name only, used by the login page),
  `GET /api/settings/branding` (any signed-in user), and `PUT` with `{ "labels": { "appName": "…" } }`
  or `DELETE` (optionally `?key=appName`) on `/api/settings/branding` for admins only (403 otherwise).
  Saves are logged with the admin's user id and the key name. Setup: stop the dev servers with
  `npm run dev:kill`, then `npm run prisma:deploy` (`0024_branding_settings`: one new table,
  `branding_settings`) and `npm run prisma:generate`. Until then the app shows "Dispatch" and saving
  says a database update is needed (never a 500). Rollback: run
  `prisma/migrations/0024_branding_settings/down.sql`, then
  `npx prisma migrate resolve --rolled-back 0024_branding_settings`.
