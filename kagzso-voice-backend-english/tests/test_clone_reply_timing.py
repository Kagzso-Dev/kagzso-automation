"""SARVAM_TTS_CLONE_TIMING_LOG (default off; set only in .env.ta): one "Clone reply timing" line per cloned reply on the
REST sentence stream, with where the silence at each sentence boundary comes from - the stall (nothing left to play)
and the silence inside Sarvam's own audio - and the two numbers that explain a stall (how early the next sentence's
text was written, and its synthesis time). The audio itself never changes. No real request is made."""
import asyncio
import logging
import math
import struct

import pytest

from app.core.config import settings
from app.services import audio_service as audio
from app.services.sarvam_tts import CloneReplyTiming, CloneSentenceStream, SarvamTTS, _edge_silence_ms
from tests.test_cloned_voice import TA_F, _cfg

LOG = "Clone reply timing"


def _speech(ms: int, lead_ms: int = 20, trail_ms: int = 60) -> bytes:
    """mu-law 8 kHz: `lead_ms` of silence, a tone of `ms`, `trail_ms` of silence (Sarvam's VAD-trimmed shape)."""
    tone = b"".join(struct.pack("<h", int(8000 * math.sin(2 * math.pi * 300 * (i + 0.5) / 8000))) for i in range(8 * ms))
    return audio.pcm16_to_mulaw(b"\x00\x00" * 8 * lead_ms + tone + b"\x00\x00" * 8 * trail_ms)


def _tts(monkeypatch, timing: bool, plan: dict) -> SarvamTTS:
    """A Tamil cloned voice whose synthesize() takes plan[text] = (seconds, audio) instead of calling Sarvam."""
    tts = SarvamTTS(_cfg("ta", SARVAM_TTS_CLONE_TIMING_LOG=timing), voice_id=TA_F, exact_voice=True)

    async def synthesize(text_, pace=None):
        seconds, mulaw = plan[text_]
        await asyncio.sleep(seconds)
        return mulaw

    monkeypatch.setattr(tts, "synthesize", synthesize)
    return tts


async def _reply(tts: SarvamTTS, sentences, gaps=()) -> list:
    """Send the sentences as an agent reply does (a wait before sentence i+1 = gaps[i]) and take the audio as the call
    does: each chunk is handed over at once."""
    stream = await tts.open_stream()
    assert isinstance(stream, CloneSentenceStream)
    heard = []

    async def take():
        async for chunk in stream.audio():
            heard.append(chunk)

    task = asyncio.ensure_future(take())
    for i, sentence in enumerate(sentences):
        if i and i - 1 < len(gaps):
            await asyncio.sleep(gaps[i - 1])
        await stream.send_text(sentence)
        if i == 0:
            await stream.flush()
    await stream.end_input()
    await asyncio.wait_for(task, 5)
    return heard


def _timing_lines(caplog):
    return [r.getMessage() for r in caplog.records if LOG in r.getMessage()]


def _field(line: str, name: str) -> list:
    raw = line.split(f"{name}=", 1)[1].split("]", 1)[0].lstrip("[")
    return [x.strip().strip("'") for x in raw.split(",") if x.strip()]


S1, S2, S3 = "சரி சார்.", "புரியுது.", "எங்க software உங்க WhatsApp-ல நேரடியா வேலை செய்யும்."


def test_the_switch_is_off_by_default():
    assert settings.model_fields["SARVAM_TTS_CLONE_TIMING_LOG"].default is False


async def test_off_logs_nothing_and_on_plays_exactly_the_same_audio(monkeypatch, caplog):
    caplog.set_level(logging.INFO)
    plan = {S1: (0.02, _speech(300)), S2: (0.01, _speech(200)), S3: (0.03, _speech(900))}
    off = await _reply(_tts(monkeypatch, False, plan), [S1, S2, S3])
    assert _timing_lines(caplog) == []
    on = await _reply(_tts(monkeypatch, True, plan), [S1, S2, S3])
    assert on == off == [plan[S1][1], plan[S2][1], plan[S3][1]]  # same bytes, same order, nothing added or lost
    lines = _timing_lines(caplog)
    assert len(lines) == 1
    assert "sentences=3 " in lines[0] and "(stopped)" not in lines[0]
    assert _field(lines[0], "chars") == [str(len(S1)), str(len(S2)), str(len(S3))]
    assert not any(ch in lines[0] for ch in "சரிபுஎங") and "software" not in lines[0]  # numbers only, never the text


async def test_a_sentence_ready_in_time_leaves_only_sarvams_edge_silence(monkeypatch, caplog):
    caplog.set_level(logging.INFO)
    plan = {S1: (0.02, _speech(400)), S2: (0.02, _speech(300))}
    await _reply(_tts(monkeypatch, True, plan), [S1, S2])
    line = _timing_lines(caplog)[0]
    assert _field(line, "stall_ms") == ["0"]
    assert _field(line, "audio_edges_ms") == ["80"]  # 60 ms at the end of the first + 20 ms at the start of the next
    assert _field(line, "silence_ms") == ["80"]
    assert _field(line, "lead/trail_ms") == ["20/60", "20/60"]


async def test_a_next_sentence_written_too_late_for_its_synthesis_is_a_stall(monkeypatch, caplog):
    """The first sentence plays 0.2 s; the next is written 0.15 s in and takes 0.25 s to make: about 0.2 s of nothing."""
    caplog.set_level(logging.INFO)
    plan = {S1: (0.0, _speech(200, 0, 0)), S3: (0.25, _speech(500, 0, 0))}
    await _reply(_tts(monkeypatch, True, plan), [S1, S3], gaps=[0.15])
    line = _timing_lines(caplog)[0]
    stall = int(_field(line, "stall_ms")[0])
    assert 120 <= stall <= 320
    ahead, synth = int(_field(line, "next_text_ahead_ms")[0]), int(_field(line, "next_synth_ms")[0])
    assert 0 <= ahead <= 120 and 230 <= synth <= 350
    assert abs(stall - (synth - ahead)) <= 40  # the stall is the synthesis time the early text did not cover
    assert int(_field(line, "silence_ms")[0]) == stall + int(_field(line, "audio_edges_ms")[0])


async def test_a_reply_cut_off_mid_way_logs_once_as_stopped(monkeypatch, caplog):
    caplog.set_level(logging.INFO)
    plan = {S1: (0.0, _speech(200)), S3: (1.0, _speech(500))}
    stream = await _tts(monkeypatch, True, plan).open_stream()
    await stream.send_text(S1)
    await stream.send_text(S3)
    it = stream.audio().__aiter__()
    assert await it.__anext__() == plan[S1][1]
    await stream.aclose()  # barge-in: the rest is cancelled
    with pytest.raises((StopAsyncIteration, asyncio.CancelledError)):
        await it.__anext__()
    await it.aclose()
    lines = _timing_lines(caplog)
    assert len(lines) == 1 and "sentences=1 (stopped)" in lines[0]


def test_edge_silence_is_measured_on_the_audio():
    assert _edge_silence_ms(_speech(300, 40, 120)) == (40, 120)
    assert _edge_silence_ms(audio.pcm16_to_mulaw(b"\x00\x00" * 800)) == (100, 0)  # all silence: counted once
    timing = CloneReplyTiming()
    timing.log(True)  # nothing was played: no line, no error
