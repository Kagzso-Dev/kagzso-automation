# Kagzso Voice Backend

> **English edition.** Copy of `kagzso-voice-backend` running Nila's script in Indian business English
> (`app/flows/builtin/nila.json`). Differences: `CALL_LANGUAGE=en`, `SARVAM_STT_MODE=transcribe`,
> Sarvam Bulbul v3 voices (default `priya`, rotated per call), own MySQL DB `kagzso_voice_en`, port **8002**
> (the Tamil backend uses 8001). Point a separate ngrok tunnel at 8002 and set `PUBLIC_BASE_URL` to it.

> **More languages, same code.** Run this folder once per language, each with its own `.env.<code>`
> (`KAGZSO_ENV_FILE=.env.ta`): its own `CALL_LANGUAGE`, port and `MYSQL_DATABASE`; its `PUBLIC_BASE_URL`
> is the English address plus its key (`https://…/ta`; nginx or the dev gateway strips the `/ta`);
> everything else (Sarvam key, phone number, LLM) as in `.env`. A backend only accepts call flows in its
> `CALL_LANGUAGE` and keeps every call in it; its built-in scripts add the spoken lines in
> `app/flows/builtin/<code>/`; its voices come from `SARVAM_TTS_VOICES`. `/ready` and
> `GET /api/flows/builtin` report its `language`. Setup: the main README → *AI calls in more languages*.

The real-time AI voice-calling backend for **Kagzso**. You send one API request, and Kagzso:

1. Calls the customer through **Plivo**.
2. Streams the customer's audio over a WebSocket to **FastAPI**.
3. Transcribes it with **Sarvam STT** (`saaras:v3`).
4. Generates a reply with the **Sarvam LLM** (`sarvam-105b-conversations`, backup `sarvam-105b`; Gemini, OpenAI, Groq and Ollama are also built in).
5. Speaks the reply with **Sarvam TTS** (`bulbul:v3`), streamed back through Plivo.
6. Lets the customer **interrupt** (barge-in) at any time.
7. Saves the call, transcript, events, latency metrics and outcome in **MySQL**.

MySQL is the source of truth. Short-lived per-call state (stream ID, listening/speaking state, history) is kept in process memory, so there's no Redis or other cache to install.

> Backend only. There is no frontend yet and no Docker. Built and tested for Windows with Python 3.10.11.

---

## Contents

1. [Install Python](#1-install-python-31011)
2. [Create a virtual environment](#2-create-a-virtual-environment)
3. [Install requirements](#3-install-requirements)
4. [Create the MySQL database](#4-create-the-mysql-database)
5. [Configure .env](#5-configure-env)
6. [Plivo setup](#6-plivo-setup)
7. [Sarvam setup](#7-sarvam-setup)
8. [Sarvam TTS setup](#8-sarvam-tts-setup)
9. [LLM setup](#9-llm-setup)
10. [Public HTTPS with ngrok](#10-public-https-with-ngrok-local-testing)
11. [Run database migrations](#11-run-database-migrations)
12. [Start FastAPI](#12-start-fastapi)
13. [Test /health](#13-test-health)
14. [Test /ready](#14-test-ready)
15. [Make the first outbound call](#15-make-the-first-outbound-call)
16. [Troubleshooting](#16-troubleshooting)

Further sections: [How a call works](#how-a-call-works), [API reference](#api-reference), [Project layout](#project-layout), [Running tests](#running-tests).

---

## 1. Install Python 3.10.11

Download the **Windows installer (64-bit)** from <https://www.python.org/downloads/release/python-31011/>. Tick **"Add python.exe to PATH"** during setup.

Then check that it worked:

```powershell
py -3.10 --version
# Python 3.10.11
```

## 2. Create a virtual environment

```powershell
cd C:\projects\kagzso-voice-backend
py -3.10 -m venv .venv
.\.venv\Scripts\Activate.ps1
```

If PowerShell blocks the activate script, run this once and then activate again:

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

## 3. Install requirements

```powershell
python -m pip install --upgrade pip
pip install -r requirements.txt
```

`webrtcvad-wheels` ships prebuilt wheels, so you don't need a C++ compiler.

## 4. Create the MySQL database

The backend needs MySQL 8.x. Open the MySQL client. Adjust the path if you installed MySQL somewhere else.

```powershell
& "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe" -u root -p
```

At the `mysql>` prompt, create a database and a dedicated user. Use your own strong password.

```sql
CREATE DATABASE kagzso_voice CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'kagzso'@'localhost' IDENTIFIED BY 'choose-a-strong-password';
GRANT ALL PRIVILEGES ON kagzso_voice.* TO 'kagzso'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```

## 5. Configure .env

```powershell
Copy-Item .env.example .env
notepad .env
```

Generate the two app secrets and paste them into `.env`:

```powershell
python -c "import secrets; print('ADMIN_API_KEY=' + secrets.token_urlsafe(32)); print('APP_SECRET_KEY=' + secrets.token_urlsafe(48))"
```

| Variable | What it is |
|---|---|
| `ADMIN_API_KEY` | Sent as the `X-API-Key` header to `/api/calls`, `/api/agents` and `/api/test`. |
| `APP_SECRET_KEY` | Signs the media-stream WebSocket URL handed to Plivo. |
| `MYSQL_*` | The user and database from step 4. |
| Provider keys | Steps 6–9. |
| `PUBLIC_BASE_URL` | Your ngrok `https://` URL (step 10). |

`.env` is in `.gitignore`. **Never commit it.** The app keeps secrets out of logs and API responses.

To verify the database settings:

```powershell
python scripts\check_connections.py
```

## 6. Plivo setup

1. Sign in at <https://console.plivo.com>. Copy the **Auth ID** and **Auth Token** from the dashboard into `PLIVO_AUTH_ID` and `PLIVO_AUTH_TOKEN`.
2. Buy or rent a voice-enabled number under **Phone Numbers**. Put it in E.164 format in `PLIVO_FROM_NUMBER`, for example `+918035xxxxxx`.
3. **Trial accounts** can only call numbers you have verified in the console (Sandbox Numbers). Verify your own mobile number first.
4. For calls to **India**, check the caller-ID and KYC requirements Plivo applies to your account before going live.
5. You don't need a Plivo Application or console webhook configuration for outbound calls. Every call passes its own `answer_url`, `ring_url` and `hangup_url`, all built from `PUBLIC_BASE_URL`.

Webhook signatures (`X-Plivo-Signature-V3`) are validated by default (`PLIVO_VALIDATE_SIGNATURE=true`).

### 6b. Twilio setup (alternative to Plivo)

`TELEPHONY_PROVIDER` in `.env` chooses who places **new** calls: `plivo` or `twilio`. Each call remembers its provider, so hangups and webhooks always go to the right one.

1. In the [Twilio Console](https://console.twilio.com), copy the **Account SID** and **Auth Token** into `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN`.
2. Buy a voice-capable number (Phone Numbers → Buy a number) and put it in `TWILIO_FROM_NUMBER` (E.164).
3. **Trial accounts:**
   - you can only call **Verified Caller IDs**, so verify your own mobile under Phone Numbers → Verified Caller IDs;
   - calls start with a short Twilio trial message;
   - Twilio may ask the callee to press a key before the call connects.
4. **Calling India:** enable India under Voice → Settings → Geo Permissions, or the call is rejected (error 21215).
5. Set `TELEPHONY_PROVIDER=twilio`, restart FastAPI, and run `POST /api/test/twilio` to check the credentials.

You don't need any console webhook configuration. Each call passes its own answer URL (`/api/webhooks/twilio/voice`), status callback (`/api/webhooks/twilio/status`) and answering-machine callback (`/api/webhooks/twilio/amd`). The audio streams over `wss://…/ws/twilio/media` using `<Connect><Stream>`, with the call ID and a signed token sent as `<Parameter>` values, because Twilio forbids query strings in stream URLs. Webhooks are checked with `X-Twilio-Signature` (`TWILIO_VALIDATE_SIGNATURE=true`).

## 7. Sarvam setup

1. Create an API key at <https://dashboard.sarvam.ai>.
2. Set `SARVAM_API_KEY`. Keep `SARVAM_STT_MODEL=saaras:v3` and `SARVAM_STT_MODE=transcribe`.
3. `CALL_LANGUAGE=en` maps to Sarvam `en-IN`. Other codes work too: `hi`, `ta`, `te`, `kn`, `ml`, `mr`, `gu`, `bn`, `pa`. Use `auto` for auto-detect.

## 8. Sarvam TTS setup

Text to speech uses the same `SARVAM_API_KEY` as STT.

1. Keep `SARVAM_TTS_MODEL=bulbul:v3`.
2. Set `SARVAM_TTS_SPEAKER` to a lowercase Bulbul v3 speaker (default `priya`).
3. Optional: list speakers in `SARVAM_TTS_VOICE_ROTATION` (comma-separated); each new call uses the next one in turn.
   Check them first with `python -m scripts.voice_check`.

The backend asks Sarvam for 16-bit PCM at 8000 Hz and converts it to μ-law, which is what the Plivo stream plays.

## 9. LLM setup

**Gemini (default):**

1. Create a key at <https://aistudio.google.com/apikey>.
2. Set `LLM_PROVIDER=gemini` and `LLM_API_KEY=<key>`.
3. Set `LLM_MODEL` to a current **Flash** model ID from <https://ai.google.dev/gemini-api/docs/models>. Flash models give the lowest latency.

**Other providers** (no code changes needed):

| `LLM_PROVIDER` | `LLM_API_KEY` | `LLM_MODEL` example | Notes |
|---|---|---|---|
| `openai` | OpenAI key | a current GPT model | |
| `groq` | Groq key | a Llama model on Groq | Very low latency |
| `ollama` | (empty) | `llama3.1:8b` | Local; set `LLM_BASE_URL=http://localhost:11434/v1` if it isn't the default |
| `openai_compatible` | key | model | Requires `LLM_BASE_URL` |

To add a new provider, subclass `LLMProvider` in [app/services/llm_service.py](app/services/llm_service.py) and register it in `PROVIDERS`.

## 10. Public HTTPS with ngrok (local testing)

Plivo has to reach your laptop over public HTTPS (webhooks) and WSS (media stream).

```powershell
ngrok config add-authtoken <your-ngrok-token>   # one time, from https://dashboard.ngrok.com
ngrok http 8000
```

ngrok prints a forwarding URL such as `https://a1b2-203-0-113-5.ngrok-free.app`.

1. Put it in `.env` as `PUBLIC_BASE_URL=https://a1b2-203-0-113-5.ngrok-free.app`, with no trailing slash.
2. **Restart FastAPI.**
3. Free ngrok URLs change every time ngrok restarts. Update `.env` and restart FastAPI whenever that happens.

The media WebSocket URL is derived automatically: `wss://<same host>/ws/plivo/media`.

## 11. Run database migrations

```powershell
alembic upgrade head
```

This creates `agents`, `contacts`, `calls`, `call_events`, `transcripts`, `call_latency_metrics` and `followups`. On first start, the app seeds the default agent **Priya** (`agent_id = 1`).

Other migration commands:

```powershell
alembic current                                       # show the applied revision
alembic revision --autogenerate -m "describe change"  # after editing app/db/models.py
alembic downgrade -1                                  # roll back one step
```

## 12. Start FastAPI

```powershell
.\.venv\Scripts\Activate.ps1
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Use **one worker**. Live call sessions are held in-process, and the WebSocket and its webhooks must reach the same process. Interactive API docs are at <http://localhost:8000/docs>; they're disabled when `APP_ENV=production`.

## 13. Test /health

```powershell
Invoke-RestMethod http://localhost:8000/health
# status
# ------
# ok
```

## 14. Test /ready

```powershell
Invoke-RestMethod http://localhost:8000/ready | ConvertTo-Json
```

Expected output when everything is set up:

```json
{
  "status": "ready",
  "mysql": "ok",
  "active_calls": 0,
  "providers": { "plivo": "configured", "public_base_url": "configured", "sarvam": "configured",
                 "tts": "configured", "llm": "configured" },
  "tts_provider": "sarvam",
  "llm_provider": "sarvam"
}
```

It returns HTTP 503 with `"status": "not_ready"` and names what's missing. It never returns secret values.

**Check each provider's credentials** before placing a real call. These endpoints are development-only and need the API key.

```powershell
$h = @{ "X-API-Key" = "<your ADMIN_API_KEY>" }
Invoke-RestMethod -Method Post http://localhost:8000/api/test/llm      -Headers $h -ContentType "application/json" -Body '{"text":"Hello?"}'
Invoke-RestMethod -Method Post http://localhost:8000/api/test/tts      -Headers $h -ContentType "application/json" -Body '{"text":"Hello from Kagzso."}'
Invoke-RestMethod -Method Post http://localhost:8000/api/test/sarvam   -Headers $h -ContentType "application/json" -Body '{"text":"Hello from Kagzso."}'
Invoke-RestMethod -Method Post http://localhost:8000/api/test/plivo    -Headers $h
```

- `/api/test/sarvam` does a round trip: Sarvam TTS speaks the text, the audio goes through the same telephony conversion as a real call, and Sarvam transcribes it.
- `/api/test/plivo` fetches your account details. It does **not** place a call.

## 15. Make the first outbound call

Make sure ngrok is running, `PUBLIC_BASE_URL` is set, FastAPI has been restarted, and `/ready` says `ready`. Then:

```powershell
$h = @{ "X-API-Key" = "<your ADMIN_API_KEY>" }
$body = @{
  phone_number  = "+919876543210"    # your own verified number, E.164
  customer_name = "Ragul"            # required: first sentence is "Hi, is this Ragul?"
  gender        = "male"             # male | female | unknown  -> sir / madam / no title
  company_name  = "ABC Restaurant"   # optional
  business_type = "Restaurant"       # optional
  agent_id      = 2                  # 2 = Nila (check GET /api/agents)
} | ConvertTo-Json

$r = Invoke-RestMethod -Method Post http://localhost:8000/api/calls/outbound -Headers $h -ContentType "application/json" -Body $body
$r
# success call_id                          provider_call_id
# ------- -------                          ----------------
#    True 3f2a9c...                        9834029e-58b6-11e1-...
```

Answer your phone and say "Hello?". Priya should reply within a second or two. Try interrupting her while she's talking.

Afterwards, look at the call, its transcript, latency metrics and events:

```powershell
Invoke-RestMethod "http://localhost:8000/api/calls/$($r.call_id)" -Headers $h | ConvertTo-Json -Depth 5
```

To hang up from the API:

```powershell
Invoke-RestMethod -Method Post "http://localhost:8000/api/calls/$($r.call_id)/hangup" -Headers $h
```

## 16. Troubleshooting

| Symptom | Fix |
|---|---|
| `/ready` → `"mysql": "error"` | Check the `MYSQL_*` values, then run `python scripts\check_connections.py`. |
| `Could not seed default agent` at startup | Migrations haven't been run. Run `alembic upgrade head` and restart. |
| `RuntimeError: cryptography package is required` | Run `pip install -r requirements.txt` again. MySQL 8 authentication needs `cryptography`. |
| Outbound returns 503 "Plivo is not configured" | Set `PLIVO_*` and `PUBLIC_BASE_URL`, then restart. |
| Outbound returns 502 | Plivo rejected the call. Run `/api/test/plivo`. On a trial account the destination must be a verified Sandbox Number. |
| Outbound returns 409 | The contact is marked DND. That's intentional. |
| Phone rings, then silence or the call drops | Plivo can't reach your webhooks. Check that ngrok is running, that `PUBLIC_BASE_URL` matches the current ngrok URL, and that you restarted FastAPI. Check `http://127.0.0.1:4040` (ngrok inspector) for the `/answer` request. |
| Webhooks return 403 `Invalid signature` | `PUBLIC_BASE_URL` must be exactly the URL Plivo calls (same scheme and host). Temporarily setting `PLIVO_VALIDATE_SIGNATURE=false` confirms whether this is the cause. Never use `false` in production. |
| Logs show `Rejected media stream` | `APP_SECRET_KEY` changed between answering and streaming, or the URL was altered. Restart and call again. |
| Priya never answers | Look in the logs for `STT failed` / `LLM failed` / `TTS failed` and the error kind (`auth`, `rate_limit`, `timeout` …), then run the matching `/api/test/*` endpoint. |
| Priya replies to background noise | Raise `VAD_MIN_RMS` (e.g. 600) and/or `VAD_AGGRESSIVENESS=3`. |
| Priya cuts in before the customer finishes | Raise `VAD_SPEECH_END_SILENCE_MS` (e.g. 900). |
| Barge-in is too sensitive or not sensitive enough | Tune `VAD_SPEECH_START_MS` (higher = harder to interrupt). |
| Replies feel slow | Check the `STT completed / LLM completed / TTS first audio` log lines (see below). Use a Flash or Groq model. |
| `UnicodeEncodeError` in the console | Run `$env:PYTHONIOENCODING="utf-8"` before starting. |

---

## How a call works

```
POST /api/calls/outbound
   │  validate phone (E.164) → agent active → contact not DND → calls row (created)
   ▼
Plivo calls.create(answer_url, ring_url, hangup_url, time_limit)         status: initiating
   │
   ├─ ring_url   → POST /api/webhooks/plivo/status   (Event=Ring)        status: ringing
   ├─ answer_url → POST /api/webhooks/plivo/answer                       status: answered
   │       returns <Stream bidirectional="true" keepCallAlive="true"
   │                       contentType="audio/x-mulaw;rate=8000">wss://…/ws/plivo/media?call_id=…&token=…</Stream>
   ▼
WS /ws/plivo/media   "start" event (callId, streamId)                    status: connected
   │
   │  media (μ-law 8 kHz, 20 ms) → VAD endpointer ──speech end──┐
   │                                                            ▼
   │      Sarvam STT (16 kHz WAV) → LLM (streamed) → sentence chunker → Sarvam TTS WS (μ-law 8 kHz)
   │                                                            │
   │  ◀────────────── playAudio … checkpoint ───────────────────┘
   │
   │  customer speaks while the agent is generating or playing → cancel LLM/TTS + clearAudio (barge-in)
   │  LLM appends [[END_CALL]] (never spoken) → agent finishes the sentence → Plivo hangup
   ▼
"stop" / hangup_url → outcome classified (interested / callback / dnd …) → status: completed
```

- **Nila agent (id 2; `agent_name` "Radhi" or "Kayal" also finds it):** Kagzso outbound screening + handoff, then a 1-minute Tamil/Tanglish conversation. The script lives in [app/flows/builtin/nila.json](app/flows/builtin/nila.json) as blocks that join into the prompt; edit a block's text and restart (it is synced into MySQL on startup). Admins can also edit copies in Dispatch's **Call Flows** page.
- **Screening flow:** `Hi sir, Good afternoon.` (spoken verbatim by the system, never via the LLM; time of day from `CALL_GREETING_TIMEZONE`, title from the `gender` field, otherwise `CALL_DEFAULT_TITLE`) → after `GREETING_WAIT_SECONDS` (1.0), or at once when the customer says anything, `Am I speaking with Ragul, sir?` (also scripted; a do-not-call request or an "are you a bot?" question goes to the script instead) → identity confirmed → `Thank you, sir. This is Nila from Kexo AI and Automation… Is that okay?` → permission → business conversation. Busy / not interested / do-not-call / wrong person end the call immediately. `customer_name` is required for Nila (422 otherwise). The first sentence is spoken ~`GREETING_DELAY_MS` after answer, or right after the customer's "Hello?".
- **Start of the call (time-of-day openings):** after answer the agent listens for `FIRST_SPEECH_WAIT_SECONDS` (3.0, range 2.0-4.0). The customer's first words play the greeting at once - they are not answered or carried into the conversation, except do-not-call / "are you a bot?", which the script answers and the greeting is skipped. Silence plays it when the wait ends; it never starts while the customer is talking (waits up to 2 s for them to stop). Only the greeting is spoken at `GREETING_TTS_SPEED` (0.95, Sarvam pace 0.5-2.0); the pre-rendered greeting is cached per text and speed. A `greeting_started` event logs the time from answer to greeting.
- **Silence:** after the agent speaks, `SILENCE_REPROMPT_SECONDS` of silence triggers "Hello, கேக்குதா? Hear பண்றீங்களா?" (once); more silence gets "No problem. Thank you for your time. Have a nice day." and a hangup.
- **Silence after the identity question** (`Am I speaking with …?`): `IDENTITY_SILENCE_WAIT_SECONDS` (2.0, counted from the end of its audio) → the question is asked once more → the same wait → the silence re-prompt → the normal silence flow above closes the call. Any words from the customer cancel this, and words spoken over the repeat or the re-prompt stop it at once.
- **Noise reduction on the customer's audio** (`app/services/noise_suppression.py`, `NOISE_SUPPRESSION_ENABLED`, on by default): high-pass, mild spectral noise suppression (`NOISE_SUPPRESSION_STRENGTH` 0-1, at most 6-18 dB), gentle auto-gain (+12 dB max, only from frames that are clearly voice, held at 1x while the agent speaks) and a limiter, before speech detection. Speech is detected with the adaptive floor and a low minimum instead of the fixed `VAD_MIN_RMS` gate (which still applies while the agent speaks); anything that starts like speech goes to STT. STT hears the original audio by default (`NOISE_SUPPRESSION_STT_AUDIO=original|cleaned`). Adds one 20 ms frame of delay and ~0.1 ms of CPU per 20 ms chunk (logged every 5 s and per call); any error or slow processing switches it off for that call. A caller who resumes within `SLOW_SPEAKER_END_SILENCE_MS` (1600) of a pause, before the agent answered, gets that end-of-speech wait for the rest of the call.
- **Voicemail:** with `PLIVO_MACHINE_DETECTION=true`, Plivo reports answering machines to `/api/webhooks/plivo/machine`; the call is hung up and the outcome is locked to `voicemail`.
- **Voicemail check (`MACHINE_DETECTION_VERIFY`, on):** Plivo's "machine" verdict sometimes fires on a person saying "Hello? Hello?". Before hanging up, what STT heard is checked: a short human reply keeps the call (`machine_detection_overruled`); a voicemail / carrier phrase or a long monologue hangs up at once; with no words yet it waits up to `MACHINE_VERIFY_SECONDS` (3.0) and then trusts Plivo (`machine_detection_confirmed`). `false` = hang up on Plivo's verdict at once, as before.
- **"Our team will contact you":** the agent only says this when `TEAM_FOLLOWUP_ENABLED=true`. Then interested leads are also written to the `followups` table for your team. Keep it `false` unless someone really follows up.
- **Pronunciation:** "Kagzso" and "kagzso.com" are always spoken as "Kexo" / "Kexo dot com".
- **Call states:**
  - `created`, `initiating`, `ringing`, `answered`, `connected` and `completed` / `failed` / `busy` / `no_answer` / `cancelled` are stored in `calls.status` and in `call_events`.
  - The conversational states (`listening`, `processing`, `speaking`) change several times a second, so they're kept in process memory (`app/services/session_store.py`) and dropped when the call ends. Barge-ins are recorded as `call_events`.
  - Because live call state is per-process, run a **single** uvicorn worker.
- **Outcomes:**
  - Values: `interested`, `not_interested`, `callback_requested`, `do_not_call`, `wrong_person`, `busy`, `voicemail`, `no_answer`, `call_failed`, `completed`, `unknown`.
  - Busy, no-answer and failed calls get their outcome from Plivo's hangup callback; voicemail from machine detection.
  - Answered calls are classified by the LLM from the transcript (Tamil, English or Tanglish).
  - `do_not_call` marks the contact DND, so it's never called again. `callback_requested` creates a `followups` row (no call is auto-scheduled, and the agent never claims one is).
- **Prompt safety:**
  - Only `{{customer_name}}`, `{{contact_name}}`, `{{gender}}`, `{{title}}`, `{{company_name}}`, `{{business_type}}` and `{{phone_number}}` are substituted.
  - Values are stripped of newlines, braces and markup, then length-capped.
  - They're also passed as a JSON data block that the model is told to treat as data, not instructions.

### Latency logs

Every line carries the call's correlation ID:

```
INFO  [CALL 3f2a9c…] plivo.stream: Plivo connected (stream …, format audio/x-mulaw@8000)
INFO  [CALL 3f2a9c…] voice.pipeline: Customer audio received (820ms)
INFO  [CALL 3f2a9c…] voice.pipeline: STT completed: 420ms
INFO  [CALL 3f2a9c…] voice.pipeline: TTS first audio: 180ms
INFO  [CALL 3f2a9c…] voice.pipeline: LLM completed: 650ms
INFO  [CALL 3f2a9c…] voice.pipeline: Total response latency: 1150ms
```

| Metric (in `call_latency_metrics`, one row per turn) | Definition |
|---|---|
| `stt_ms` | T2 − T1: end of customer speech → transcript |
| `llm_ms` | T4 − T3: full LLM generation |
| `llm_first_token_ms` | LLM start → first token |
| `tts_first_byte_ms` | T6 − T5: first sentence sent to Sarvam TTS → first audio back |
| `total_response_ms` | T1 → T6: customer stops talking → agent audio starts |

Because the LLM output is streamed sentence by sentence into Sarvam TTS, `total_response_ms` is usually lower than `stt_ms + llm_ms`. On top of it, add roughly 700 ms of end-of-speech silence detection (`VAD_SPEECH_END_SILENCE_MS`).

Each turn also logs one summary line (log only, no transcript text, numbers or secrets):

```
INFO  [CALL 3f2a9c…] voice.pipeline: Turn 4 timing (ms): eos_wait=700 stt=420 tts_wait=0 llm_first_token=900 first_token_to_audio=350 tts_first_audio=180 total=1690 reply_delay=2390
```

| Field | Definition |
|---|---|
| `eos_wait` | T0 → T1: customer stopped speaking → end of speech detected (the VAD silence) |
| `stt` | T1 → T2: transcript ready |
| `tts_wait` | time the first sentence waited for the TTS websocket |
| `llm_first_token` | LLM start → first token |
| `first_token_to_audio` | first token → first agent audio |
| `tts_first_audio` | first sentence sent → first audio back |
| `total` | T1 → T6 (same as `total_response_ms`) |
| `reply_delay` | T0 → T6: what the customer hears as the pause before the agent replies |

### Latency settings

| Setting | Default | Effect |
|---|---|---|
| `PROVIDER_KEEPALIVE_SECONDS` | `60` | Keeps HTTPS connections to Sarvam / the LLM open between turns (no TLS handshake per turn). |
| `PROVIDER_PREWARM` | `true` | Opens those connections when the call connects and when the customer starts speaking (a request without the API key). |
| `LLM_START_BEFORE_TTS` | `true` | The LLM starts while the TTS websocket is still connecting; the first sentence waits for it. |
| `PRERENDER_FIXED_LINES` | `true` | Synthesizes the fixed lines (couldn't-hear-you, silence re-prompt / closing, identity re-ask) once per answered call so they play instantly. Same voice and settings. |
| `LLM_TURN_MODEL` | empty | A faster model for live replies; `LLM_MODEL` becomes its fallback. Check the golden prompts before using it. |
| `LLM_HEDGE_AFTER_SECONDS` | `0` (off) | If the first model has sent nothing after this long, also start the second one and speak whichever answers first. Extra tokens on slow turns. |
| `STT_STREAMING` | `false` | Streams audio to Sarvam STT while the customer speaks; only the flush is left at end of speech. Falls back to the REST request on any problem (after up to `STT_STREAM_FINAL_TIMEOUT_MS`). Turns heard over the agent's audio still use REST. |
| `VAD_SPEECH_END_SILENCE_MS` | `700` | Lower (500–550) answers faster, but customers who pause mid-sentence get cut off. |

### Background noise settings

None of these add delay; each can be switched off.

| Setting | Default | Effect |
|---|---|---|
| `NOISE_SAFE_STATE` | `true` | Noise can't change the call. The greeting still plays after a noise burst (no dead air), and the silence re-prompt timer and the end-of-call flag change only once STT hears real words. Noise during a do-not-call goodbye no longer cancels the hang-up. |
| `ECHO_TEXT_FILTER`, `ECHO_TAIL_MS` | `true`, `1500` | Speech heard over the agent, or within 1.5 s after it stops, is ignored when it is 3+ words all taken, in order, from the agent's own line (speakerphone echo). Logged as event `echo_ignored`. |
| `BARGE_IN_CONSECUTIVE`, `BARGE_IN_MAX_GAP_MS` | `true`, `100` | The immediate (no-STT) interruption needs one unbroken run of loud speech, not clatter added up across the agent's sentence. Shorter interruptions still go through the STT word check. |
| `VAD_ADAPTIVE_FLOOR`, `VAD_FLOOR_MULTIPLIER`, `VAD_FLOOR_MAX_RMS` | `true`, `2.5`, `1000` | The energy gate rises with the line's steady noise (learned only while the customer is silent), and is capped so quiet speakers are still heard. |
| `STT_DROP_NOISE_TEXT` | `true` | Transcripts of only punctuation or "uh / um / er / ah" make no turn (event `noise_ignored`). "Yes", "no", "okay", "hello", "hmm" are never dropped. |

Other people talking near the customer can't be told apart from the customer by voice; these settings only reduce it (distant voices are quieter and rarely sustained at the mouthpiece).

---

## API reference

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | none | Liveness |
| GET | `/ready` | none | MySQL and provider configuration (no secrets) |
| POST | `/api/calls/outbound` | `X-API-Key` | Start a call (rate-limited to 10/min) |
| GET | `/api/calls/{call_id}` | `X-API-Key` | Call, transcripts, latency and events |
| POST | `/api/calls/{call_id}/hangup` | `X-API-Key` | Hang up a live call |
| GET/POST | `/api/agents` | `X-API-Key` | List or create agents |
| POST | `/api/webhooks/plivo/answer` | Plivo signature | Returns the Stream XML |
| POST | `/api/webhooks/plivo/status` | Plivo signature | Ring and hangup callbacks |
| POST | `/api/webhooks/plivo/stream-status` | Plivo signature | Stream status callbacks |
| WS | `/ws/plivo/media` | HMAC token | Bidirectional audio |
| POST | `/api/test/{llm,sarvam,tts,plivo}` | `X-API-Key`, non-production only | Provider credential checks |

### Follow-up calls from Dispatch

Dispatch (the email-automation-platform in the parent folder) places calls through the same
`POST /api/calls/outbound`, using some extra optional fields:

```json
{
  "phone_number": "+919876543210",
  "customer_name": "Ragul",
  "gender": "male",
  "agent_name": "Follow-up",
  "follow_up_detail": "the quotation for 20 laptops",
  "run_id": "cm…",
  "log_id": "cm…"
}
```

- `agent_name` can be sent instead of `agent_id`. One of the two is required.
- The built-in **Follow-up** agent (`app/flows/builtin/followup.json`) opens with
  *"Hello {{addressed_name}}, this is Nila calling…"*. `addressed_name` is "Mr. Ragul" or "Ms. Priya",
  or just "Ragul" when gender is unknown; gender is never guessed. The agent then uses
  `follow_up_detail` as the call context: *"I'm calling regarding: …"*.
- `follow_up_detail` is sanitized like every other customer field and capped at 300 characters.
- **Status callbacks:** when `STATUS_CALLBACK_URL` and `STATUS_CALLBACK_SECRET` are set, any call
  that has a `log_id` POSTs `{event, call_id, run_id, log_id, provider_call_id, status, outcome,
  summary, hangup_cause, duration_seconds, ended_at}` on every status change. A final
  `event: "finalized"` POST adds the `transcript`.
- Each callback is signed: `X-Kagzso-Timestamp` and
  `X-Kagzso-Signature: sha256=HMAC(secret, "<timestamp>.<body>")`.
- Callbacks retry on errors, are fire-and-forget (they never delay a live call) and never include
  the phone number.

### Call flows (Dispatch "Call Flows" page)

A call flow is the editable form of an agent's prompt (`app/flows/`): an ordered list of blocks
joined end to end into the system prompt, plus the greeting line, the two silence lines and a max
duration. `app/flows/schema.py` validates it (unknown fields, unknown `{{variables}}`,
`{{phone_number}}`, `[[END_CALL]]`, lengths, missing or extra locked blocks are all rejected).

- **Locked blocks** carry only a key; their text comes from `app/flows/builtin/locked_blocks.json`
  (do-not-call, wrong person, customer data, outcome and callback rules), so no edit can change them.
- **Safety rules** (`SAFETY_RULES` in `llm_service.py`) are appended to every prompt, built-in or
  edited: honest AI disclosure if asked, do-not-call ends the call, no false claims, never ask for
  OTPs or card details. The built-in prompts are otherwise unchanged
  (`tests/fixtures/golden_prompts.json` pins them).
- **Request fields** on `POST /api/calls/outbound`: `flow_id`, `flow_version`, `flow_draft` (test
  calls of unpublished drafts) and `flow` (the definition). `agent_id` / `agent_name` is still
  required: it is the **fallback** when the flow is missing or invalid.
- **One agent row per version:** `flow:<id>@v<n>` (drafts: `…-draft-<hash>`). Sending different
  content for a version that already exists is refused (published versions are immutable) and the
  call falls back to the default agent.
- **Stored on the call:** `calls.variables` gets `flow_id`, `flow_version`, `flow_draft`,
  `flow_hash` (or `flow_fallback` = `missing` / `invalid` / `version_conflict`), plus a
  `flow:selected` or `flow:fallback` call event. Status callbacks echo `flow_id` / `flow_version`.
- `max_duration_sec` becomes the Plivo `time_limit` / Twilio `TimeLimit`, capped at
  `MAX_CALL_DURATION_SECONDS`.
- `GET /api/flows/builtin` lists the built-in flows and locked text. `POST /api/flows/preview`
  validates a flow and renders the greeting, silence lines and full prompt for sample customer data.
  Both need `X-API-Key`. No database migration is needed on this side.

## Project layout

```
kagzso-voice-backend/
├── app/
│   ├── main.py                 FastAPI app, lifespan, CORS, routers
│   ├── api/                    health, calls, agents, webhooks, dev_tests
│   ├── services/
│   │   ├── plivo_service.py    Plivo SDK: calls, hangup, Stream XML
│   │   ├── sarvam_stt.py       STTProvider + Sarvam REST
│   │   ├── tts.py              TTSProvider interface + "Kexo" pronunciation
│   │   ├── sarvam_tts.py       Sarvam Bulbul TTS (WebSocket/REST)
│   │   ├── llm_service.py      LLMProvider (Gemini, OpenAI, Groq, Ollama) + prompt engine
│   │   ├── call_service.py     outbound flow, webhooks, conversation engine, barge-in
│   │   ├── audio_service.py    μ-law/PCM/WAV conversion, VAD endpointer
│   │   └── session_store.py    in-process hot call state
│   ├── websocket/plivo_stream.py
│   ├── db/                     database.py, models.py, repositories.py
│   ├── core/                   config.py, logging.py, security.py
│   └── schemas/                calls.py, agents.py
├── migrations/                 Alembic (0001_initial)
├── scripts/check_connections.py
├── tests/                      fake providers + SQLite (no credentials needed)
├── .env.example  .gitignore  requirements.txt  alembic.ini  pytest.ini
```

## Running tests

```powershell
python -m pytest -q
```

The tests need no credentials and never read your `.env`. They use SQLite and in-process fake providers. They cover:

- the real FastAPI WebSocket route, end to end: answer XML → stream → STT → LLM → TTS → barge-in (`clearAudio`) → END_CALL hangup → MySQL rows;
- Plivo V3 signature validation, using the SDK's own signing code;
- the Sarvam TTS WebSocket client against a local WebSocket server;
- the Sarvam, Gemini and OpenAI-format request and response shapes;
- prompt-injection sanitising;
- the DND flow.

The live-provider checks are the `/api/test/*` endpoints.
