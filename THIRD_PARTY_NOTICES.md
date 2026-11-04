# Third-Party Notices

This project (see [`LICENSE.md`](LICENSE.md)) is built on third-party software and services that are **not**
owned by Kagzso Technology Services. Each remains under its own licence or terms; nothing in `LICENSE.md`
changes them. The licence file shipped inside each package is the authoritative text: this list is a summary
(checked 2026-11-04 against the installed versions) and is not a substitute for it.

## Direct dependencies

### Dispatch API (`apps/api`)

| Package | Licence |
| --- | --- |
| @prisma/client, prisma | Apache-2.0 |
| @sentry/node | MIT |
| bcryptjs | MIT |
| cookie-parser | MIT |
| cors | MIT |
| cron-parser | MIT |
| csv-parse | MIT |
| dotenv | BSD-2-Clause |
| exceljs | MIT |
| express | MIT |
| express-rate-limit | MIT |
| jsonwebtoken | MIT |
| jszip | MIT OR GPL-3.0-or-later (dual licence; used under MIT) |
| multer | MIT |
| nodemailer | MIT-0 |
| pdf-parse | MIT |
| pino, pino-http, pino-pretty | MIT |
| sanitize-html | MIT |
| zod | MIT |

### Web app (`apps/web`) and shared package (`packages/shared`)

| Package | Licence |
| --- | --- |
| react, react-dom | MIT |
| react-router-dom | MIT |
| @tanstack/react-query | MIT |
| zod | MIT |

Build and test tools (not shipped to users): Vite (MIT), TypeScript (Apache-2.0), Tailwind CSS (MIT), Vitest (MIT).

### Voice backend (`kagzso-voice-backend-english`, `requirements.txt`)

| Package | Licence |
| --- | --- |
| fastapi | MIT |
| uvicorn | BSD-3-Clause |
| pydantic, pydantic-settings | MIT |
| email-validator | Unlicense |
| python-multipart | Apache-2.0 |
| SQLAlchemy, alembic | MIT |
| aiomysql, PyMySQL | MIT |
| cryptography | Apache-2.0 OR BSD-3-Clause |
| httpx | BSD-3-Clause |
| websockets | BSD-3-Clause |
| plivo, twilio (SDKs) | MIT |
| webrtcvad-wheels | MIT |
| numpy | BSD-3-Clause (its wheels bundle components under other permissive licences, listed in its own licence file) |
| phonenumbers | Apache-2.0 |
| pytest, pytest-asyncio, aiosqlite (tests only) | MIT |

## Transitive dependencies

The npm packages installed for this project (654 at the time of writing) are almost all MIT, Apache-2.0, ISC or
BSD licensed. Others found: MIT-0, MIT/X11, Unlicense, CC0-1.0, (MIT AND Zlib) (pako), and build-time data packages
under Creative Commons (caniuse-lite CC-BY-4.0, spdx-exceptions CC-BY-3.0). One package, `buffers@0.1.1` (pulled in
by exceljs → unzipper → binary), declares no licence in its metadata.

The voice backend's Python environment (71 packages) is likewise permissive, except `certifi` (the CA certificate
bundle used by httpx and the SDKs), which is **MPL-2.0**: a file-level copyleft licence. Using it unmodified, as
here, adds no obligation beyond keeping its notice; a changed copy of its files would have to be shared under MPL-2.0.

To list them again: `npx license-checker --summary` (npm) and `pip-licenses` (Python environment).

## Obligations when distributing

- MIT, BSD, ISC and Apache-2.0 require their copyright and licence notices to be kept in copies or substantial
  portions of the software. Apache-2.0 also requires keeping any `NOTICE` file. When a build (for example the web
  app bundle) is delivered to someone outside the company, include these notices with it.
- No dependency found requires releasing this project's own source code: there is no GPL-only, LGPL or AGPL
  component (jszip's GPL option is not the one used; certifi's MPL-2.0 covers only its own files).

## Third-party services and models

AI models, speech models, telephony and messaging services used through their providers - Sarvam AI (speech-to-text,
text-to-speech, LLM), Groq, Anthropic, Google Gemini, Plivo, Twilio, Meta (WhatsApp Cloud API) and the configured
e-mail provider - are owned by those providers and used under their terms of service. Kagzso Technology Services
claims no ownership of these models, APIs or services.
