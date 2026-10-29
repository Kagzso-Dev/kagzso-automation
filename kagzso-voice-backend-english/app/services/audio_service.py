"""Audio format conversion and voice-activity / turn detection.

Telephony leg (Plivo stream, contentType audio/x-mulaw;rate=8000):
    inbound  : base64 mu-law 8 kHz mono, ~20 ms (160 bytes) per media event
    outbound : base64 mu-law 8 kHz mono in `playAudio` events

Sarvam STT prefers 16 kHz, so customer utterances are converted
mu-law 8k -> PCM16 8k -> PCM16 16k -> WAV.
Sarvam TTS audio is converted to mu-law @ 8000 Hz, which Plivo plays directly.

`audioop` is in the Python 3.10 standard library (deprecated from 3.11,
removed in 3.13 - install `audioop-lts` there).
"""
from __future__ import annotations

import audioop  # stdlib on Python 3.10
import base64
import enum
import io
import wave
from collections import deque
from dataclasses import dataclass
from typing import Callable, Deque, Iterator, List, Optional

TELEPHONY_SAMPLE_RATE = 8000
STT_SAMPLE_RATE = 16000
SAMPLE_WIDTH = 2  # 16-bit PCM
FRAME_MS = 20
PCM_FRAME_BYTES = TELEPHONY_SAMPLE_RATE * SAMPLE_WIDTH * FRAME_MS // 1000  # 320
MULAW_BYTES_PER_SECOND = TELEPHONY_SAMPLE_RATE  # 1 byte per sample


# ------------------------------ codecs ------------------------------
def decode_base64(payload: str) -> bytes:
    return base64.b64decode(payload)


def encode_base64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def mulaw_to_pcm16(data: bytes) -> bytes:
    return audioop.ulaw2lin(data, SAMPLE_WIDTH)


def pcm16_to_mulaw(data: bytes) -> bytes:
    return audioop.lin2ulaw(data, SAMPLE_WIDTH)


def resample_pcm16(data: bytes, from_rate: int, to_rate: int) -> bytes:
    if from_rate == to_rate or not data:
        return data
    converted, _ = audioop.ratecv(data, SAMPLE_WIDTH, 1, from_rate, to_rate, None)
    return converted


def pcm16_to_wav(data: bytes, sample_rate: int) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(SAMPLE_WIDTH)
        wf.setframerate(sample_rate)
        wf.writeframes(data)
    return buf.getvalue()


def telephony_pcm_to_stt_wav(pcm8k: bytes) -> bytes:
    """PCM16 @ 8 kHz (decoded call audio) -> 16 kHz WAV for Sarvam."""
    return pcm16_to_wav(resample_pcm16(pcm8k, TELEPHONY_SAMPLE_RATE, STT_SAMPLE_RATE), STT_SAMPLE_RATE)


def normalize_for_stt(pcm8k: bytes, target_rms: int = 3000, max_gain_db: float = 12.0) -> bytes:
    """A copy of the utterance at a steady speech level, for STT only. The speech level is measured
    on its louder 20 ms frames (silence doesn't count); quiet speech is lifted towards `target_rms`
    by at most `max_gain_db`; audio is never made quieter; a soft limiter keeps every sample below
    full scale, so a loud voice never clips."""
    if not pcm8k:
        return pcm8k
    import numpy as np

    x = np.frombuffer(pcm8k[: len(pcm8k) - len(pcm8k) % SAMPLE_WIDTH], dtype="<i2").astype(np.float32)
    frame = PCM_FRAME_BYTES // SAMPLE_WIDTH
    usable = len(x) - len(x) % frame
    if usable < frame:
        return pcm8k
    levels = np.sqrt(np.mean(x[:usable].reshape(-1, frame) ** 2, axis=1))
    speech = levels[levels >= max(100.0, 0.25 * float(levels.max()))]
    level = float(np.sqrt(np.mean(speech ** 2))) if speech.size else 0.0
    if level <= 0:
        return pcm8k
    gain = min(10 ** (max_gain_db / 20), target_rms / level)
    if gain <= 1.0:
        return pcm8k  # already loud enough: unchanged
    y = x * gain
    knee, ceiling = 0.7 * 32767, 0.98 * 32767
    over = np.abs(y) > knee
    y[over] = np.sign(y[over]) * (knee + (ceiling - knee) * np.tanh((np.abs(y[over]) - knee) / (ceiling - knee)))
    return y.astype("<i2").tobytes()


PITCH_MIN_LAG, PITCH_MAX_LAG = 20, 114  # 400 Hz down to 70 Hz at 8 kHz: the range of a speaking voice
PITCH_MIN_CORRELATION = 0.6  # a voiced vowel repeats; breath, coughs, hiss and clatter do not


def is_pitched(pcm: bytes) -> bool:
    """The audio (40 ms works best) repeats at a voice's pitch - a vowel, not breath or noise.
    Normalised autocorrelation over lags 70-400 Hz; about 30 us for 40 ms."""
    import numpy as np

    x = np.frombuffer(pcm[: len(pcm) - len(pcm) % SAMPLE_WIDTH], dtype="<i2").astype(np.float64)
    n = len(x)
    if n <= PITCH_MAX_LAG:
        return False
    x -= x.mean()
    ac = np.correlate(x, x, "full")[n - 1:]
    energy = np.concatenate(([0.0], np.cumsum(x * x)))
    lags = np.arange(PITCH_MIN_LAG, PITCH_MAX_LAG + 1)
    norm = np.sqrt(energy[n - lags] * (energy[n] - energy[lags])) + 1e-9
    return bool(np.max(ac[lags] / norm) > PITCH_MIN_CORRELATION)


def mulaw_to_stt_wav(mulaw8k: bytes) -> bytes:
    return telephony_pcm_to_stt_wav(mulaw_to_pcm16(mulaw8k))


def rms(pcm: bytes) -> int:
    return audioop.rms(pcm, SAMPLE_WIDTH) if pcm else 0


def mulaw_duration_seconds(nbytes: int) -> float:
    return nbytes / MULAW_BYTES_PER_SECOND


def chunk_bytes(data: bytes, size: int) -> Iterator[bytes]:
    for i in range(0, len(data), size):
        yield data[i : i + size]


# ------------------------------ VAD ------------------------------
SpeechClassifier = Callable[[bytes], bool]  # 20 ms PCM16 8 kHz frame -> is speech


def make_webrtc_classifier(aggressiveness: int, min_rms: int) -> SpeechClassifier:
    """webrtcvad (via the `webrtcvad-wheels` package) gated by an energy floor."""
    import webrtcvad

    vad = webrtcvad.Vad(max(0, min(3, aggressiveness)))

    def classify(frame: bytes) -> bool:
        if len(frame) != PCM_FRAME_BYTES:
            return False
        if rms(frame) < min_rms:
            return False
        return vad.is_speech(frame, TELEPHONY_SAMPLE_RATE)

    return classify


class NoiseFloorGate:
    """Adaptive energy gate: learns the line's background level from frames heard while the
    customer is NOT speaking, and treats frames below floor x multiplier as silence.

    The threshold never drops below `min_rms` and never rises above `max_rms`, so a quiet
    customer in a noisy room is still heard. Adds no delay (one RMS per 20 ms frame)."""

    WINDOW_FRAMES = 150  # last 3 s of non-speech audio
    MIN_FRAMES = 5  # need 100 ms of observations before raising the gate
    PERCENTILE = 0.2  # the quiet part of the noise, so short bumps don't raise the floor

    def __init__(self, min_rms: int, multiplier: float, max_rms: int):
        self.min_rms = max(0, min_rms)
        self.multiplier = max(1.0, multiplier)
        self.max_rms = max(self.min_rms, max_rms)
        self._levels: Deque[int] = deque(maxlen=self.WINDOW_FRAMES)
        self.threshold = self.min_rms
        self.floor: Optional[int] = None  # the learned background level (None until observed)
        # Gain applied to the audio by noise reduction (auto-gain); levels are compared with it
        # divided out, so a boosted voice - and the boosted noise after it - are judged on the
        # same scale the floor was learned on.
        self.scale = 1.0

    def observe(self, level: int) -> None:
        self._levels.append(int(level / self.scale))
        self._update()

    def set_min_rms(self, min_rms: int) -> None:
        """Change the lowest threshold while the call runs (e.g. stricter while the agent speaks)."""
        if min_rms != self.min_rms:
            self.min_rms = max(0, min_rms)
            self._update()

    def _update(self) -> None:
        if len(self._levels) < self.MIN_FRAMES:
            self.threshold = self.min_rms  # not enough observations yet
            return
        ordered = sorted(self._levels)
        floor = self.floor = ordered[int(len(ordered) * self.PERCENTILE)]
        self.threshold = int(min(self.max_rms, max(self.min_rms, floor * self.multiplier)))

    def passes(self, level: int) -> bool:
        return level / self.scale >= self.threshold


class VadEvent(enum.Enum):
    SPEECH_START = "speech_start"
    SPEECH_END = "speech_end"


@dataclass
class EndpointResult:
    event: VadEvent
    audio: bytes = b""  # PCM16 8 kHz utterance (only on SPEECH_END)
    duration_ms: int = 0
    silence_ms: int = 0  # silence waited before SPEECH_END (the customer stopped this long ago)
    # What the utterance was made of (SPEECH_END with audio): voiced frames, their level with the
    # noise reduction's gain divided out, the noise floor learned before it began, peak sample and
    # the highest gain the noise reduction applied while it lasted.
    voiced_ms: int = 0
    speech_rms: int = 0
    floor_rms: Optional[int] = None
    peak: int = 0
    max_gain: float = 1.0
    pitched_ms: Optional[int] = None  # speech frames with a voice's pitch (measure_pitch only)


class SpeechEndpointer:
    """Turns a stream of 20 ms frames into speech start / end events.

    * SPEECH_START fires once `start_ms` of voiced audio has accumulated within
      a short sliding window - this is also the barge-in trigger.
    * SPEECH_END fires after `end_silence_ms` of continuous non-speech, with
      the full utterance (incl. pre-roll) attached.
    """

    def __init__(
        self,
        classifier: SpeechClassifier,
        start_ms: int = 200,
        end_silence_ms: int = 700,
        min_utterance_ms: int = 250,
        max_utterance_ms: int = 25000,
        preroll_ms: int = 300,
        noise_gate: Optional[NoiseFloorGate] = None,
        loud_rms: int = 0,
        max_gap_ms: int = 100,
        measure_pitch: bool = False,
    ):
        self.classify = classifier
        # Count speech frames that carry a voice's pitch (customer voice focus); off = no extra work.
        self.measure_pitch = measure_pitch
        self._prev_raw = b""
        self.noise_gate = noise_gate
        # Run of consecutive loud speech in the current utterance (gaps up to max_gap_ms),
        # used for the immediate barge-in decision.
        self.loud_rms = loud_rms
        self.max_gap_frames = max(0, max_gap_ms // FRAME_MS)
        self.start_frames = max(1, start_ms // FRAME_MS)
        self.window_frames = self.start_frames + max(2, self.start_frames // 2)
        self.end_frames = max(1, end_silence_ms // FRAME_MS)
        self.min_frames = max(1, min_utterance_ms // FRAME_MS)
        self.max_frames = max(self.min_frames + 1, max_utterance_ms // FRAME_MS)
        self._preroll: Deque[bytes] = deque(maxlen=max(1, preroll_ms // FRAME_MS))
        self._window: Deque[bool] = deque(maxlen=self.window_frames)
        self._window_power: Deque[float] = deque(maxlen=self.window_frames)  # level^2 of speech frames, else 0
        self._window_pitched: Deque[bool] = deque(maxlen=self.window_frames)
        self._quiet_floor: Optional[int] = None  # noise floor while the window held no speech
        self._pending = b""
        self._pending_raw = b""
        # Optional: receives each frame of the current utterance as it arrives (pre-roll
        # included), e.g. for streaming STT. Never changes when SPEECH_START / SPEECH_END fire.
        self.frame_sink: Optional[Callable[[bytes], None]] = None
        self.reset()

    def reset(self) -> None:
        self.in_speech = False
        self._frames: List[bytes] = []
        self._voiced = 0
        self._silence = 0
        self._window.clear()
        self._window_power.clear()
        self._window_pitched.clear()
        self.loud_run_ms = 0
        self._loud_gap = 0
        self._speech_power = 0.0
        self._pitched = 0
        self._start_floor: Optional[int] = None
        self._max_gain = 1.0
        self.hold_frames = 0  # this utterance only: wait at least this much silence (ADAPTIVE_EOS)

    @property
    def silence_ms(self) -> int:
        """Silence since the customer's last voiced frame in the utterance in progress (0 when not in speech)."""
        return self._silence * FRAME_MS if self.in_speech else 0

    @property
    def voiced_frames(self) -> int:
        return self._voiced if self.in_speech else 0

    def measure_so_far(self) -> Optional[EndpointResult]:
        """The utterance in progress as measured so far, without ending it (BARGE_EARLY_STOP)."""
        if not self.in_speech:
            return None
        voiced = self._voiced
        return EndpointResult(VadEvent.SPEECH_START, b"", len(self._frames) * FRAME_MS, self._silence * FRAME_MS,
                              voiced_ms=voiced * FRAME_MS,
                              speech_rms=int((self._speech_power / voiced) ** 0.5) if voiced else 0,
                              floor_rms=self._start_floor, max_gain=self._max_gain,
                              pitched_ms=self._pitched * FRAME_MS if self.measure_pitch else None)

    def finish_now(self) -> Optional[EndpointResult]:
        """End the utterance in progress now, exactly as enough silence would (ADAPTIVE_EOS)."""
        return self._finish() if self.in_speech else None

    def utterance_so_far(self) -> bytes:
        """PCM of the utterance in progress (pre-roll included); empty when not in speech."""
        return b"".join(self._frames) if self.in_speech else b""

    def process(self, pcm: bytes, raw: Optional[bytes] = None) -> List[EndpointResult]:
        """Feed arbitrary-length PCM16 8 kHz audio; returns events in order.

        raw: the same audio before noise reduction (equal length). When given, speech is
        detected on `pcm` (cleaned) while the utterance, the frame sink and the loud-speech
        (barge-in) measure use `raw` - so STT and the barge-in rules see the original audio."""
        events: List[EndpointResult] = []
        data = self._pending + pcm
        n = len(data) - len(data) % PCM_FRAME_BYTES
        self._pending = data[n:]
        if raw is not None:
            raw_data = self._pending_raw + raw
            self._pending_raw = raw_data[n:]
        else:
            raw_data = data
        for i in range(0, n, PCM_FRAME_BYTES):
            ev = self._process_frame(data[i : i + PCM_FRAME_BYTES], raw_data[i : i + PCM_FRAME_BYTES])
            if ev:
                events.append(ev)
        return events

    def _process_frame(self, frame: bytes, raw: Optional[bytes] = None) -> Optional[EndpointResult]:
        raw = frame if raw is None else raw
        speech = self.classify(frame)
        level = rms(frame)
        scale = 1.0
        if self.noise_gate is not None:
            scale = self.noise_gate.scale
            if not self.in_speech:
                self.noise_gate.observe(level)  # learned only while the customer is silent
            speech = speech and self.noise_gate.passes(level)
        power = (level / scale) ** 2 if speech else 0.0  # on the scale the floor was learned on
        pitched = self.measure_pitch and speech and is_pitched(self._prev_raw + raw)  # the last 40 ms
        self._prev_raw = raw
        if not self.in_speech:
            self._preroll.append(raw)
            self._window.append(speech)
            self._window_power.append(power)
            self._window_pitched.append(pitched)
            if self.noise_gate is not None and not any(self._window):
                # The floor before this utterance's first frames, which the gate also observes.
                self._quiet_floor = self.noise_gate.floor
            if sum(self._window) >= self.start_frames:
                self.in_speech = True
                self._frames = list(self._preroll)
                self._voiced = sum(self._window)
                self._speech_power = sum(self._window_power)
                self._pitched = sum(self._window_pitched)
                self._start_floor = self._quiet_floor
                self._max_gain = scale
                self._silence = 0
                self._preroll.clear()
                self._window.clear()
                self._window_power.clear()
                self._window_pitched.clear()
                return EndpointResult(VadEvent.SPEECH_START)
            return None

        self._frames.append(raw)
        if self.frame_sink is not None:
            self.frame_sink(raw)
        self._max_gain = max(self._max_gain, scale)
        if speech:
            self._voiced += 1
            self._speech_power += power
            self._pitched += pitched
            self._silence = 0
        else:
            self._silence += 1
        if speech and rms(raw) >= self.loud_rms:
            self.loud_run_ms += FRAME_MS
            self._loud_gap = 0
        else:
            self._loud_gap += 1
            if self._loud_gap > self.max_gap_frames:
                self.loud_run_ms = 0

        if self._silence >= max(self.end_frames, self.hold_frames) or len(self._frames) >= self.max_frames:
            return self._finish()
        return None

    def _finish(self) -> EndpointResult:
        voiced, frames, trailing = self._voiced, self._frames, self._silence
        speech_rms = int((self._speech_power / voiced) ** 0.5) if voiced else 0
        floor, gain = self._start_floor, self._max_gain
        pitched_ms = self._pitched * FRAME_MS if self.measure_pitch else None
        self.reset()
        if voiced < self.min_frames:
            return EndpointResult(VadEvent.SPEECH_END, b"", 0, trailing * FRAME_MS)  # noise burst, ignore
        # Trim most of the trailing silence (keep ~200 ms).
        keep = len(frames) - max(0, trailing - 10)
        audio = b"".join(frames[:keep])
        return EndpointResult(VadEvent.SPEECH_END, audio, len(audio) * 1000 // (TELEPHONY_SAMPLE_RATE * SAMPLE_WIDTH),
                              trailing * FRAME_MS, voiced_ms=voiced * FRAME_MS, speech_rms=speech_rms,
                              floor_rms=floor, peak=audioop.max(audio, SAMPLE_WIDTH) if audio else 0, max_gain=gain,
                              pitched_ms=pitched_ms)
