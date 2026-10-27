"""Application settings loaded from environment variables / .env.

Secrets are typed as SecretStr so they never appear in repr(), logs or
tracebacks. Use `.get_secret_value()` only at the point of use.
"""
from __future__ import annotations

import os
from functools import lru_cache
from typing import List

from pydantic import SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy.engine import URL


def _clamped(name: str, value: float, low: float, high: float) -> float:
    """Out-of-range values are pulled into range (with a warning) instead of stopping startup."""
    if low <= value <= high:
        return value
    clamped = min(max(value, low), high)
    import logging

    logging.getLogger("config").warning("%s=%s is outside %s-%s - using %s", name, value, low, high, clamped)
    return clamped

# Language code mapping: CALL_LANGUAGE (short) -> Sarvam BCP-47 code.
SARVAM_LANGUAGE_CODES = {
    "en": "en-IN",
    "hi": "hi-IN",
    "ta": "ta-IN",
    "te": "te-IN",
    "kn": "kn-IN",
    "ml": "ml-IN",
    "mr": "mr-IN",
    "gu": "gu-IN",
    "bn": "bn-IN",
    "pa": "pa-IN",
    "od": "od-IN",
    "auto": "unknown",
}

# Language names for the reply-language rule and the voice labels.
LANGUAGE_NAMES = {
    "en": "English", "ta": "Tamil", "hi": "Hindi", "te": "Telugu", "kn": "Kannada", "ml": "Malayalam",
    "mr": "Marathi", "gu": "Gujarati", "bn": "Bengali", "pa": "Punjabi", "od": "Odia",
}


class Settings(BaseSettings):
    # KAGZSO_ENV_FILE lets tests run without reading the real .env.
    model_config = SettingsConfigDict(
        env_file=os.getenv("KAGZSO_ENV_FILE", ".env"), env_file_encoding="utf-8", extra="ignore"
    )

    # --- App ---
    APP_NAME: str = "Kagzso Voice Backend"
    APP_ENV: str = "development"  # development | staging | production | test
    APP_HOST: str = "0.0.0.0"
    APP_PORT: int = 8000
    LOG_LEVEL: str = "INFO"
    # Protects /api/calls/*, /api/agents/* and /api/test/* (header X-API-Key).
    ADMIN_API_KEY: SecretStr = SecretStr("")
    # Used to sign the media WebSocket URL token.
    APP_SECRET_KEY: SecretStr = SecretStr("")
    CORS_ORIGINS: str = ""  # comma-separated list; empty = no browser origins allowed
    RATE_LIMIT_PER_MINUTE: int = 30
    # Dispatch status callbacks: calls placed with run_id/log_id POST their status,
    # outcome, summary and transcript here, signed with HMAC-SHA256 (empty = off).
    STATUS_CALLBACK_URL: str = ""  # e.g. http://localhost:4000/api/webhooks/ai-calls
    STATUS_CALLBACK_SECRET: SecretStr = SecretStr("")  # same value as Dispatch's AI_CALL_WEBHOOK_SECRET

    # --- Plivo ---
    PLIVO_AUTH_ID: str = ""
    PLIVO_AUTH_TOKEN: SecretStr = SecretStr("")
    PLIVO_FROM_NUMBER: str = ""
    PLIVO_VALIDATE_SIGNATURE: bool = True

    # --- Twilio ---
    TWILIO_ACCOUNT_SID: str = ""
    TWILIO_AUTH_TOKEN: SecretStr = SecretStr("")
    TWILIO_FROM_NUMBER: str = ""
    TWILIO_VALIDATE_SIGNATURE: bool = True
    TWILIO_MACHINE_DETECTION: bool = True

    # Which phone provider places new calls: plivo | twilio
    TELEPHONY_PROVIDER: str = "plivo"

    PUBLIC_BASE_URL: str = ""  # e.g. https://abcd.ngrok-free.app (no trailing slash)
    # /ready calls this server through PUBLIC_BASE_URL (at most once a minute) to prove Plivo / Twilio can
    # reach it: a stopped ngrok tunnel or a stale URL shows as "unreachable". false = only check it is set.
    PUBLIC_URL_CHECK: bool = True

    # --- Sarvam STT ---
    SARVAM_API_KEY: SecretStr = SecretStr("")
    SARVAM_STT_MODEL: str = "saaras:v3"
    SARVAM_STT_MODE: str = "transcribe"  # only used by saaras:v3
    # STT mode for calls with a flow in "Pure" language style (saaras:v3, e.g. "transcribe").
    # Empty (default) = SARVAM_STT_MODE for every call, whatever the flow's style.
    SARVAM_STT_MODE_PURE: str = ""
    # Words Sarvam should expect (saaras:v4 REST only, up to 50, 64 chars each), comma-separated,
    # e.g. "Kexo,Kagzso,UiPath,automation,WhatsApp". Empty = none (today's behaviour).
    STT_KEYTERMS: str = ""
    # If a request with SARVAM_STT_MODEL fails (after its own retry), try once with this model.
    # Only used when it differs from SARVAM_STT_MODEL; empty = no second model.
    STT_FALLBACK_MODEL: str = "saaras:v3"
    # Send STT a level-normalised copy of the customer's audio (soft voices lifted, loud ones never
    # clipped). Live call audio, speech detection, barge-in and recordings are unchanged. Off = as before.
    STT_NORMALIZE_AUDIO: bool = False
    STT_NORMALIZE_TARGET_RMS: int = 3000  # speech level to aim for (16-bit PCM RMS)
    STT_NORMALIZE_MAX_GAIN_DB: float = 12.0  # never lift more than this
    # Log the time of each STT request (model and ms; never audio, numbers or keys).
    STT_TIMING_LOG: bool = True
    SARVAM_BASE_URL: str = "https://api.sarvam.ai"
    SARVAM_TIMEOUT_SECONDS: float = 10.0

    # --- Sarvam TTS (Bulbul; uses SARVAM_API_KEY and CALL_LANGUAGE) ---
    SARVAM_TTS_MODEL: str = "bulbul:v3"
    SARVAM_TTS_SPEAKER: str = "roopa"  # lowercase Bulbul v3 speaker id; must be an offered voice (app/core/voices.py)
    # The voices this backend offers (Call Flows voice picker, rotation, previews): comma-separated
    # Bulbul speaker ids, each optionally id:gender, e.g. "kavitha:female,mani:male". Empty = Roopa,
    # Ritu, Simran and Ishita (today's English list; Bulbul speakers speak every language).
    SARVAM_TTS_VOICES: str = ""
    SARVAM_TTS_PACE: float = 1.0  # 0.5-2.0
    SARVAM_TTS_TEMPERATURE: float = 0.6  # 0.01-1.0
    # Streamed calls: characters Sarvam collects before it starts speaking (its min_buffer_size).
    # 30 = today's value (fastest first audio). Higher joins sentences more smoothly but the
    # first audio starts a little later. Clamped to 30-200.
    SARVAM_TTS_MIN_BUFFER_CHARS: int = 30
    SARVAM_TTS_WS_URL: str = "wss://api.sarvam.ai/text-to-speech/ws"
    # Comma-separated speaker ids: each new call uses the next one in turn (empty = SARVAM_TTS_SPEAKER)
    SARVAM_TTS_VOICE_ROTATION: str = ""
    # How the rotation is used: "concurrent" = every call uses SARVAM_TTS_SPEAKER unless another
    # live call already has it; then the first rotation voice not in use. "round_robin" = each
    # new call takes the next voice in the list.
    VOICE_ROTATION_MODE: str = "concurrent"

    # --- LLM ---
    LLM_PROVIDER: str = "gemini"  # gemini | openai | groq | sarvam | ollama | openai_compatible
    LLM_API_KEY: SecretStr = SecretStr("")
    LLM_MODEL: str = ""
    LLM_BASE_URL: str = ""  # optional override (OpenAI-compatible providers)
    LLM_TEMPERATURE: float = 0.6
    LLM_MAX_OUTPUT_TOKENS: int = 1024
    LLM_TIMEOUT_SECONDS: float = 8.0
    # Used once per reply if LLM_MODEL hits quota / overload / timeout before speaking.
    LLM_FALLBACK_MODEL: str = ""
    # After LLM_MODEL hits quota / overload, try LLM_FALLBACK_MODEL first for this long (0 = always try LLM_MODEL first).
    LLM_PRIMARY_COOLDOWN_SECONDS: float = 120.0
    # Fail over if LLM_MODEL has not produced any reply text within this time (0 = off).
    # Only applies when LLM_FALLBACK_MODEL is set; the fallback itself keeps LLM_TIMEOUT_SECONDS.
    LLM_PRIMARY_FIRST_TOKEN_TIMEOUT_SECONDS: float = 2.5
    # Gemini thinking depth: minimal | low | medium | high, or empty for the model default.
    # "minimal" roughly halves time-to-first-word on phone calls.
    LLM_THINKING_LEVEL: str = "minimal"
    # Model for live call replies only (empty = LLM_MODEL). When set, LLM_MODEL becomes its
    # fallback for replies; outcome classification keeps LLM_MODEL / LLM_FALLBACK_MODEL.
    LLM_TURN_MODEL: str = ""
    # Hedged failover (0 = off): if the first model has sent no text after this many seconds,
    # also start the second model WITHOUT cancelling the first, and speak whichever answers
    # first. Replaces LLM_PRIMARY_FIRST_TOKEN_TIMEOUT_SECONDS while on. Costs extra tokens on slow turns.
    LLM_HEDGE_AFTER_SECONDS: float = 0.0
    # Start the LLM while the TTS websocket is still connecting (first sentence waits for it).
    LLM_START_BEFORE_TTS: bool = True
    # Extra per-turn timing in call_latency_metrics (end-of-speech wait, TTS wait, full reply
    # delay, reply source) and a per-call summary log line. Numbers only, written off the
    # audio path like the existing metrics. false = only the original five columns.
    LATENCY_DETAIL_METRICS: bool = True
    # Don't speak a question the agent already asked earlier in this call (e.g. the same
    # interest or permission question tacked onto every answer). Only drops a repeated
    # question after something else was said in the same reply, so a reply is never empty.
    # false = speak the model's reply exactly as before.
    REPEAT_QUESTION_GUARD: bool = True

    # --- Call recording (app/services/recording.py) - off unless switched on ---
    # Stereo WAV per answered call: left = the customer as heard on the line (before noise
    # suppression), right = only the agent audio that actually played (cut at barge-in / hang-up).
    CALL_RECORDING_ENABLED: bool = False
    # Private directory outside the source tree (created 0700, files 0600). Required to record.
    RECORDINGS_DIR: str = ""
    # Completed recordings older than this are deleted (file removed, row marked deleted). 0 = keep.
    RECORDING_RETENTION_DAYS: int = 90
    # Recording stops (the call doesn't) after this long; bounds memory per call.
    RECORDING_MAX_SECONDS: int = 900
    # Optional AES-256-GCM encryption at rest: base64 of 32 random bytes. Empty = plain WAV files.
    RECORDING_ENCRYPTION_KEY: SecretStr = SecretStr("")

    # --- Provider connections ---
    # Keep idle HTTPS connections to Sarvam / the LLM open this long between turns
    # (httpx default is 5 s, so most turns paid a fresh TLS handshake).
    PROVIDER_KEEPALIVE_SECONDS: float = 60.0
    # Open the STT / LLM connections when the call connects and when the customer starts
    # speaking (cheap request, no API key sent), so a turn never waits for a handshake.
    PROVIDER_PREWARM: bool = True

    # --- Streaming STT (Sarvam websocket) ---
    # false = one REST request after the customer stops (default). true = audio is streamed
    # while the customer speaks and only flushed at end of speech; turn-taking is unchanged
    # (our VAD still decides the end of the turn). Any failure falls back to the REST request.
    STT_STREAMING: bool = False
    SARVAM_STT_WS_URL: str = "wss://api.sarvam.ai/speech-to-text/ws"
    # Wait at most this long for the final transcript after end of speech before using REST.
    STT_STREAM_FINAL_TIMEOUT_MS: int = 1500

    # --- MySQL ---
    MYSQL_HOST: str = "localhost"
    MYSQL_PORT: int = 3306
    MYSQL_DATABASE: str = "kagzso_voice"
    MYSQL_USER: str = "root"
    MYSQL_PASSWORD: SecretStr = SecretStr("")
    # Optional full override (used by tests, e.g. sqlite+aiosqlite:///./test.db)
    DATABASE_URL: str = ""

    # --- In-process call session state ---
    SESSION_TTL_SECONDS: int = 7200

    # --- Call behaviour ---
    CALL_LANGUAGE: str = "en"
    MAX_CALL_DURATION_SECONDS: int = 180
    # A placed call that hears nothing at all from Plivo / Twilio (not even "ringing") within this many
    # seconds is marked failed: the provider can't reach PUBLIC_BASE_URL. 0 = off (wait for the hang-up).
    NO_PROVIDER_CALLBACK_SECONDS: int = 120
    # Time zone for the opening "Good morning / afternoon / evening" ({{time_greeting}}).
    CALL_GREETING_TIMEZONE: str = "Asia/Kolkata"
    # {{title_to_use}} when the contact's gender is missing or not male/female (never guessed).
    CALL_DEFAULT_TITLE: str = "sir"
    # After a time-of-day opening ("Hi sir, Good morning."), wait this long after it finishes
    # playing before asking "Am I speaking with ...?". Any reply from the customer asks it at once.
    GREETING_WAIT_SECONDS: float = 1.0
    # Silence after that identity question (counted from the end of its audio): repeat it once
    # after this long, then play the silence re-prompt after this long again; then the normal
    # SILENCE_REPROMPT_SECONDS flow closes the call.
    IDENTITY_SILENCE_WAIT_SECONDS: float = 2.0
    # Time-of-day openings: after answer, listen this long for the customer to speak first;
    # any words play the greeting at once, silence plays it when the wait ends. 2.0-4.0.
    FIRST_SPEECH_WAIT_SECONDS: float = 3.0
    # Speaking speed of that greeting only (Sarvam pace, 0.5-2.0); every other line keeps SARVAM_TTS_PACE.
    GREETING_TTS_SPEED: float = 0.95
    # Wait this long after the media stream starts for the customer to speak
    # ("Hello?"); if they stay silent, the agent greets first.
    GREETING_DELAY_MS: int = 2500
    # Render the fixed first sentence while the phone rings, so it plays the instant the
    # call is answered (no TTS round-trip = no dead air). Falls back to live TTS on failure.
    GREETING_PRERENDER: bool = True
    # Wait before a pre-rendered greeting when the customer hasn't spoken yet.
    GREETING_PRERENDERED_DELAY_MS: int = 300
    # Also synthesize the fixed lines (couldn't-hear-you, silence re-prompt / closing, identity
    # re-ask) once when the call connects, so they play without a TTS round-trip. Same voice
    # and settings; ~4 short extra TTS requests per answered call.
    PRERENDER_FIXED_LINES: bool = True
    # Silence after the agent finishes speaking: re-prompt once ("Hello, hear panreengala?"),
    # then close politely and hang up if there is still no response.
    SILENCE_REPROMPT_SECONDS: float = 7.0
    # True only if your team really follows up interested leads (rows are written to
    # `followups`). Controls whether the agent may say "our team will contact you".
    TEAM_FOLLOWUP_ENABLED: bool = False
    # Plivo answering-machine detection (async); voicemail -> hang up, outcome=voicemail.
    PLIVO_MACHINE_DETECTION: bool = True
    # Plivo's "machine" verdict sometimes fires on a person saying "Hello? Hello?". Before hanging up,
    # check what STT heard: a short human reply keeps the call; a voicemail phrase or a long monologue
    # hangs up at once; with no words yet, wait up to MACHINE_VERIFY_SECONDS, then trust Plivo.
    MACHINE_DETECTION_VERIFY: bool = True
    MACHINE_VERIFY_SECONDS: float = 3.0

    # --- Voice activity detection / turn taking ---
    VAD_AGGRESSIVENESS: int = 2  # webrtcvad 0-3
    VAD_SPEECH_START_MS: int = 200  # voiced audio needed to declare speech (and barge-in)
    # Silence that ends a customer turn. Every ms here is added to every reply. Lower (500-550)
    # = faster replies but customers who pause mid-sentence ("my number is... 98") get cut off.
    VAD_SPEECH_END_SILENCE_MS: int = 700
    VAD_MIN_UTTERANCE_MS: int = 250  # shorter utterances are treated as noise
    VAD_MIN_RMS: int = 300  # energy gate on 16-bit PCM to ignore line hiss
    # Barge-in while the agent is talking: echo / noise must not cut the agent off.
    BARGE_IN_GRACE_MS: int = 800  # ignore speech-start for this long after agent audio begins (echo window)
    BARGE_IN_MIN_SPEECH_MS: int = 1200  # loud speech needed to interrupt immediately (a real sentence)
    BARGE_IN_MIN_RMS: int = 600  # "loud" threshold for the above (16-bit PCM RMS)
    # Shorter / quieter speech interrupts only if STT finds real words in it.
    MAX_UTTERANCE_SECONDS: int = 25

    # --- Background noise (each can be switched off) ---
    # Noise must not change the call: the greeting still plays after a noise burst, and the
    # silence re-prompt / end-of-call state change only when STT hears real words.
    NOISE_SAFE_STATE: bool = True
    # Ignore the agent's own voice coming back (speakerphone echo): a transcript heard over the
    # agent, or within ECHO_TAIL_MS after it stops, of 3+ words all taken in order from the
    # agent's line. Short answers ("yes", "okay") are never treated as echo.
    ECHO_TEXT_FILTER: bool = True
    ECHO_TAIL_MS: int = 1500
    # The immediate (no-STT) interruption needs BARGE_IN_MIN_SPEECH_MS of loud speech in one
    # run (gaps up to BARGE_IN_MAX_GAP_MS), not loud noise added up across the agent's sentence.
    BARGE_IN_CONSECUTIVE: bool = True
    BARGE_IN_MAX_GAP_MS: int = 100
    # Raise the energy gate above the line's own noise: threshold = quiet level of recent
    # non-speech audio x VAD_FLOOR_MULTIPLIER, never below VAD_MIN_RMS or above VAD_FLOOR_MAX_RMS
    # (the cap keeps quiet speakers audible). Learned only while the customer is not speaking.
    VAD_ADAPTIVE_FLOOR: bool = True
    VAD_FLOOR_MULTIPLIER: float = 2.5
    VAD_FLOOR_MAX_RMS: int = 1000
    # Drop transcripts that are only punctuation or "uh" / "um" / "er" / "ah". Never drops
    # yes / no / okay / hello / hmm / mm.
    STT_DROP_NOISE_TEXT: bool = True

    # --- Input noise reduction (customer audio only; app/services/noise_suppression.py) ---
    # High-pass + mild spectral noise suppression + gentle auto-gain + limiter before speech
    # detection. Any error or slow processing bypasses it for the call (original audio).
    NOISE_SUPPRESSION_ENABLED: bool = True
    NOISE_SUPPRESSION_STRENGTH: float = 0.5  # 0 (lightest) - 1; max reduction 6-18 dB
    # What STT hears: "original" (cleaned audio is used only to detect speech) or "cleaned".
    NOISE_SUPPRESSION_STT_AUDIO: str = "original"
    # A caller who resumes within this long after a pause (before the agent answered) is a
    # slow speaker: wait this long for their silence for the rest of the call. 0 = off.
    SLOW_SPEAKER_END_SILENCE_MS: int = 1600

    @field_validator("PUBLIC_BASE_URL")
    @classmethod
    def _strip_slash(cls, v: str) -> str:
        return v.rstrip("/")

    @field_validator("FIRST_SPEECH_WAIT_SECONDS")
    @classmethod
    def _first_speech_range(cls, v: float) -> float:
        return _clamped("FIRST_SPEECH_WAIT_SECONDS", v, 2.0, 4.0)

    @field_validator("NOISE_SUPPRESSION_STRENGTH")
    @classmethod
    def _ns_strength_range(cls, v: float) -> float:
        return _clamped("NOISE_SUPPRESSION_STRENGTH", v, 0.0, 1.0)

    @field_validator("NOISE_SUPPRESSION_STT_AUDIO")
    @classmethod
    def _ns_stt_audio(cls, v: str) -> str:
        v = (v or "").strip().lower()
        return v if v in ("original", "cleaned") else "original"

    @field_validator("GREETING_TTS_SPEED")
    @classmethod
    def _greeting_speed_range(cls, v: float) -> float:
        return _clamped("GREETING_TTS_SPEED", v, 0.5, 2.0)

    # ---------- derived helpers ----------
    @property
    def is_production(self) -> bool:
        return self.APP_ENV.lower() == "production"

    @property
    def cors_origins(self) -> List[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]

    @property
    def stt_keyterms(self) -> List[str]:
        """STT_KEYTERMS as Sarvam accepts them: unique, non-empty, at most 50 of up to 64 characters."""
        out: List[str] = []
        for term in (self.STT_KEYTERMS or "").split(","):
            term = term.strip()[:64]
            if term and term.lower() not in {t.lower() for t in out}:
                out.append(term)
        return out[:50]

    @property
    def sarvam_language_code(self) -> str:
        lang = self.CALL_LANGUAGE.strip()
        if "-" in lang or lang == "unknown":
            return lang
        return SARVAM_LANGUAGE_CODES.get(lang.lower(), "unknown")

    @property
    def call_language(self) -> str:
        """CALL_LANGUAGE as a flow language code ("ta-IN" -> "ta"). Auto-detect or unknown = "en".
        Every call flow this backend accepts must have this language (one backend per language)."""
        code = (self.CALL_LANGUAGE or "").strip().split("-")[0].lower()
        return code if code in LANGUAGE_NAMES else "en"

    @property
    def public_ws_base_url(self) -> str:
        if self.PUBLIC_BASE_URL.startswith("https://"):
            return "wss://" + self.PUBLIC_BASE_URL[len("https://"):]
        if self.PUBLIC_BASE_URL.startswith("http://"):
            return "ws://" + self.PUBLIC_BASE_URL[len("http://"):]
        return self.PUBLIC_BASE_URL

    def database_url(self, sync: bool = False) -> URL | str:
        if self.DATABASE_URL:
            url = self.DATABASE_URL
            if sync:
                url = url.replace("+aiosqlite", "").replace("+aiomysql", "+pymysql")
            return url
        return URL.create(
            drivername="mysql+pymysql" if sync else "mysql+aiomysql",
            username=self.MYSQL_USER,
            password=self.MYSQL_PASSWORD.get_secret_value() or None,
            host=self.MYSQL_HOST,
            port=self.MYSQL_PORT,
            database=self.MYSQL_DATABASE,
            query={"charset": "utf8mb4"},
        )

    # ---------- provider configuration checks (never return values) ----------
    def plivo_configured(self) -> bool:
        return bool(self.PLIVO_AUTH_ID and self.PLIVO_AUTH_TOKEN.get_secret_value() and self.PLIVO_FROM_NUMBER)

    def twilio_configured(self) -> bool:
        return bool(self.TWILIO_ACCOUNT_SID and self.TWILIO_AUTH_TOKEN.get_secret_value() and self.TWILIO_FROM_NUMBER)

    @property
    def tts_speaker(self) -> str:
        """The main voice: SARVAM_TTS_SPEAKER when this backend offers it, else DEFAULT_VOICE (app/core/voices.py)."""
        from app.core.voices import voice_or_default

        return voice_or_default(self.SARVAM_TTS_SPEAKER)

    @property
    def voice_rotation(self) -> list:
        """SARVAM_TTS_VOICE_ROTATION limited to the offered voices (app/core/voices.py), in that order."""
        from app.core.voices import VOICE_IDS

        listed = {v.strip().lower() for v in self.SARVAM_TTS_VOICE_ROTATION.split(",") if v.strip()}
        return [v for v in VOICE_IDS if v in listed]

    @property
    def voice_rotation_mode(self) -> str:
        mode = (self.VOICE_ROTATION_MODE or "").strip().lower()
        return mode if mode in ("concurrent", "round_robin") else "concurrent"

    @property
    def telephony_provider(self) -> str:
        return (self.TELEPHONY_PROVIDER or "plivo").strip().lower()

    def telephony_configured(self) -> bool:
        return self.twilio_configured() if self.telephony_provider == "twilio" else self.plivo_configured()

    @property
    def telephony_from_number(self) -> str:
        return self.TWILIO_FROM_NUMBER if self.telephony_provider == "twilio" else self.PLIVO_FROM_NUMBER

    def http_limits(self):
        """Connection pool for provider HTTP clients (keeps connections warm between turns)."""
        import httpx

        return httpx.Limits(keepalive_expiry=max(0.0, self.PROVIDER_KEEPALIVE_SECONDS))

    def sarvam_configured(self) -> bool:
        return bool(self.SARVAM_API_KEY.get_secret_value() and self.SARVAM_STT_MODEL)

    def sarvam_tts_configured(self) -> bool:
        return bool(self.SARVAM_API_KEY.get_secret_value() and self.SARVAM_TTS_MODEL and self.SARVAM_TTS_SPEAKER)

    def tts_configured(self) -> bool:
        return self.sarvam_tts_configured()

    def llm_configured(self) -> bool:
        needs_key = self.LLM_PROVIDER.lower() not in ("ollama",)
        return bool(self.LLM_PROVIDER and self.LLM_MODEL and (self.LLM_API_KEY.get_secret_value() or not needs_key))

    def secret_values(self) -> List[str]:
        """All secret values, used by the log redaction filter."""
        vals = [
            self.PLIVO_AUTH_TOKEN, self.SARVAM_API_KEY, self.LLM_API_KEY,
            self.MYSQL_PASSWORD, self.ADMIN_API_KEY, self.APP_SECRET_KEY, self.TWILIO_AUTH_TOKEN,
            self.STATUS_CALLBACK_SECRET, self.RECORDING_ENCRYPTION_KEY,
        ]
        return [v.get_secret_value() for v in vals if v.get_secret_value() and len(v.get_secret_value()) >= 4]

    def validate_secrets(self) -> List[str]:
        """Return a list of configuration problems. Fatal in production, warnings otherwise."""
        problems: List[str] = []
        if len(self.ADMIN_API_KEY.get_secret_value()) < 16:
            problems.append("ADMIN_API_KEY must be set (min 16 chars) - protected APIs are disabled without it")
        if len(self.APP_SECRET_KEY.get_secret_value()) < 32:
            problems.append("APP_SECRET_KEY must be set (min 32 chars) - used to sign media-stream URLs")
        if not self.PUBLIC_BASE_URL.startswith("https://"):
            problems.append("PUBLIC_BASE_URL must be a public https:// URL (e.g. your ngrok URL)")
        if self.telephony_provider not in ("plivo", "twilio"):
            problems.append("TELEPHONY_PROVIDER must be 'plivo' or 'twilio'")
        elif self.telephony_provider == "twilio" and not self.twilio_configured():
            problems.append("Twilio is not fully configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER)")
        elif self.telephony_provider == "plivo" and not self.plivo_configured():
            problems.append("Plivo is not fully configured (PLIVO_AUTH_ID / PLIVO_AUTH_TOKEN / PLIVO_FROM_NUMBER)")
        if not self.sarvam_configured():
            problems.append("Sarvam STT is not configured (SARVAM_API_KEY)")
        if not self.sarvam_tts_configured():
            problems.append("Sarvam TTS is not configured (SARVAM_API_KEY / SARVAM_TTS_SPEAKER)")
        if not self.llm_configured():
            problems.append("LLM is not configured (LLM_PROVIDER / LLM_MODEL / LLM_API_KEY)")
        return problems


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
