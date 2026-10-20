"""Call recording (CALL_RECORDING_ENABLED): one stereo WAV per answered call, left = the customer
(raw inbound frames), right = only the agent audio that actually played. Fakes only: no real
calls, audio files go to a temporary directory."""
import asyncio
import base64
import io
import json
import logging
import os
import time
import wave
from datetime import datetime, timedelta

import numpy as np
import pytest
from sqlalchemy import text

from app.core.config import settings
from app.services import recording
from tests.conftest import silence_mulaw, tone_mulaw
from tests.test_flows import nila_copy
from tests.test_media_stream import _send_audio, _setup_call, _start_msg
from tests.test_nila_flow import PHONE, _call, _send, _start

RATE = 8000
TOL = 160  # one 20 ms frame, in samples


@pytest.fixture
def rec_dir(tmp_path, monkeypatch):
    d = tmp_path / "recordings"
    monkeypatch.setattr(settings, "CALL_RECORDING_ENABLED", True)
    monkeypatch.setattr(settings, "RECORDINGS_DIR", str(d))
    monkeypatch.setattr(settings, "RECORDING_ENCRYPTION_KEY", type(settings.RECORDING_ENCRYPTION_KEY)(""))
    return d


def _until(ws, event, limit=400):
    for _ in range(limit):
        m = ws.receive_json()
        if m["event"] == event:
            return m
    raise AssertionError(event)


def _row(sync_engine, call_id, want=("completed", "failed"), timeout=5.0):
    end = time.time() + timeout
    row = None
    while time.time() < end:
        with sync_engine.connect() as c:
            row = c.execute(text("select status, storage_key, duration_ms, size_bytes, error, format "
                                 "from call_recordings where call_id = :id"), {"id": call_id}).mappings().first()
        if row is not None and (want is None or row["status"] in want):
            return dict(row)
        time.sleep(0.05)
    return dict(row) if row else None


def _channels(path):
    with wave.open(str(path), "rb") as w:
        assert (w.getnchannels(), w.getsampwidth(), w.getframerate()) == (2, 2, RATE)
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2")
    return pcm[0::2], pcm[1::2]


def _sound(ch, floor=8):
    """Indexes of samples that aren't silence."""
    return np.nonzero(np.abs(ch.astype(np.int32)) > floor)[0]


def _greet(ws):
    """Customer says hello (400 ms of speech, 900 ms of silence) -> the greeting is played."""
    _start(ws)
    _send(ws, tone_mulaw(400) + silence_mulaw(900))
    _until(ws, "checkpoint")


# ------------------------------------------------------------------ off by default
def test_recording_disabled_creates_nothing(client, auth, fakes, sync_engine, tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "RECORDINGS_DIR", str(tmp_path / "rec"))
    assert settings.CALL_RECORDING_ENABLED is False  # the default
    call_id, token = _call(client, auth)
    fakes.stt.replies = ["Hello?"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _greet(ws)
    time.sleep(0.5)
    assert _row(sync_engine, call_id, want=None, timeout=0.3) is None
    assert not (tmp_path / "rec").exists()


# ------------------------------------------------------------------ a connected call
def test_connected_call_produces_a_stereo_recording_with_both_voices(client, auth, fakes, sync_engine, rec_dir, caplog):
    caplog.set_level(logging.INFO)
    call_id, token = _call(client, auth)
    fakes.stt.replies = ["Hello?"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _greet(ws)
        # Not complete (and no file) while the call is still going.
        assert _row(sync_engine, call_id, want=None)["status"] == "processing"
        assert not rec_dir.exists() or not any(rec_dir.iterdir())
        _send(ws, silence_mulaw(1000))  # Plivo keeps sending frames while the greeting plays
    row = _row(sync_engine, call_id)
    assert row["status"] == "completed" and row["format"] == "wav" and row["error"] is None
    path = rec_dir / row["storage_key"]
    assert path.is_file() and row["size_bytes"] == path.stat().st_size
    left, right = _channels(path)
    assert len(left) == len(right) == (400 + 900 + 1000) * 8 and row["duration_ms"] == 2300
    # Left: the customer's 400 ms of speech at the start, silence afterwards.
    talk = _sound(left)
    assert talk.min() < TOL and abs(talk.max() - 400 * 8) <= TOL
    # Right: the greeting (FakeTTS: 2 chunks of 100 ms), after the customer stopped, nowhere else.
    agent = _sound(right)
    assert len(agent) == 200 * 8
    assert agent.min() >= 400 * 8 and agent.max() - agent.min() == 200 * 8 - 1  # one block, in time order
    assert not any(PHONE[3:] in r.getMessage() for r in caplog.records)  # no phone number in any log


def test_an_interruption_cuts_the_agent_channel_where_playback_was_cleared(client, auth, fakes, sync_engine,
                                                                           rec_dir, monkeypatch):
    monkeypatch.setattr(settings, "BARGE_IN_GRACE_MS", 0)
    call_id, token = _setup_call(client, auth)  # the default agent: its first reply can be interrupted
    fakes.stt.replies = ["Hello?", "Wait, who is this?"]
    fakes.tts.chunks_per_sentence = 30  # the first reply is 3 s long
    fakes.llm.reply = "This is Thaara."
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        ws.send_text(json.dumps(_start_msg()))
        _send_audio(ws, tone_mulaw(400) + silence_mulaw(900))
        _until(ws, "checkpoint")
        fakes.tts.chunks_per_sentence = 2  # the reply after the interruption is 200 ms
        _send_audio(ws, tone_mulaw(800) + silence_mulaw(900))  # talks over the first reply
        msgs = []
        for _ in range(400):
            m = ws.receive_json()
            msgs.append(m["event"])
            if m["event"] == "checkpoint":
                break
        assert "clearAudio" in msgs
        _send_audio(ws, silence_mulaw(1000))
    row = _row(sync_engine, call_id)
    left, right = _channels(rec_dir / row["storage_key"])
    agent = _sound(right)
    start = agent.min()
    # Two pieces in time order: the interrupted first reply, then the answer - no stale or repeated audio.
    pieces = np.split(agent, np.nonzero(np.diff(agent) > 1)[0] + 1)
    assert len(pieces) == 2 and pieces[0].max() < pieces[1].min()
    greeting = len(pieces[0])
    assert len(pieces[1]) == 200 * 8  # the answer, whole
    # The 3 s reply stopped where Plivo's queue was cleared: within the customer's 1.7 s of audio.
    assert greeting <= 1700 * 8 + TOL and greeting < 3000 * 8
    # The customer's interruption is on the left channel, while that reply was playing.
    talk = _sound(left)
    assert any(start <= i < start + greeting for i in talk)


def test_an_early_hang_up_keeps_only_what_played(client, auth, fakes, sync_engine, rec_dir):
    call_id, token = _call(client, auth)
    fakes.stt.replies = ["Hello?"]
    fakes.tts.chunks_per_sentence = 30  # 3 s queued at Plivo
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _greet(ws)
        _send(ws, silence_mulaw(500))  # the customer hangs up 0.5 s after the greeting was queued
    row = _row(sync_engine, call_id)
    assert row["status"] == "completed" and row["duration_ms"] == 1800
    left, right = _channels(rec_dir / row["storage_key"])
    agent = _sound(right)
    assert len(left) == len(right)
    # The greeting played from its start until the hang-up and no further (not the full 3 s).
    assert agent.max() == len(right) - 1 and len(agent) == len(right) - agent.min() < 3000 * 8


# ------------------------------------------------------------------ failures never touch the call
def test_storage_failure_marks_the_recording_failed_and_the_call_goes_on(client, auth, fakes, sync_engine,
                                                                         tmp_path, monkeypatch):
    blocker = tmp_path / "not-a-dir"
    blocker.write_text("x")
    monkeypatch.setattr(settings, "CALL_RECORDING_ENABLED", True)
    monkeypatch.setattr(settings, "RECORDINGS_DIR", str(blocker / "sub"))
    call_id, token = _call(client, auth)
    fakes.stt.replies = ["Hello?"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _greet(ws)
        _send(ws, silence_mulaw(300))
    row = _row(sync_engine, call_id)
    assert row["status"] == "failed" and row["error"] == "storage_error"
    with sync_engine.connect() as c:
        said = c.execute(text("select text from transcripts where call_id = :id and speaker = 'agent'"),
                         {"id": call_id}).scalars().all()
    assert said  # the greeting was spoken and recorded in the transcript as usual


def test_recording_errors_are_swallowed_and_never_delay_the_reply(client, auth, fakes, sync_engine, rec_dir,
                                                                  monkeypatch):
    def boom(self):
        raise RuntimeError("merge failed")

    monkeypatch.setattr(recording.CallRecorder, "to_wav", boom)
    call_id, token = _call(client, auth)
    fakes.stt.replies = ["Hello?"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        t = time.monotonic()
        _greet(ws)
        assert time.monotonic() - t < 5
    assert _row(sync_engine, call_id)["status"] == "failed"
    assert not any(rec_dir.glob("*.wav")) if rec_dir.exists() else True


def test_a_restart_marks_unfinished_recordings_failed(client, sync_engine, rec_dir):
    with sync_engine.begin() as c:
        c.execute(text("insert into call_recordings (id, call_id, storage_key, format, status, created_at) "
                       "values ('r1', 'callx', 'callx.wav', 'wav', 'processing', :t)"), {"t": datetime.utcnow()})
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app):
        pass
    assert _row(sync_engine, "callx", want=None) ["status"] == "failed"
    assert _row(sync_engine, "callx", want=None)["error"] == "interrupted"


# ------------------------------------------------------------------ encryption, API, retention
def _recorded_call(client, auth, fakes, sync_engine):
    call_id, token = _call(client, auth)
    fakes.stt.replies = ["Hello?"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _greet(ws)
        _send(ws, silence_mulaw(500))
    return call_id, _row(sync_engine, call_id)


def test_encrypted_at_rest_and_decrypted_for_playback(client, auth, fakes, sync_engine, rec_dir, monkeypatch):
    key = base64.b64encode(os.urandom(32)).decode()
    monkeypatch.setattr(settings, "RECORDING_ENCRYPTION_KEY", type(settings.RECORDING_ENCRYPTION_KEY)(key))
    call_id, row = _recorded_call(client, auth, fakes, sync_engine)
    assert row["status"] == "completed" and row["format"] == "wav+aesgcm" and row["storage_key"].endswith(".enc")
    blob = (rec_dir / row["storage_key"]).read_bytes()
    assert blob.startswith(recording.MAGIC) and b"RIFF" not in blob[:64]
    r = client.get(f"/api/recordings/{call_id}/audio", headers=auth)
    assert r.status_code == 200 and r.content.startswith(b"RIFF")
    with wave.open(io.BytesIO(r.content)) as w:
        assert w.getnchannels() == 2


def test_api_metadata_playback_range_and_delete(client, auth, fakes, sync_engine, rec_dir):
    call_id, row = _recorded_call(client, auth, fakes, sync_engine)
    meta = client.get(f"/api/recordings/{call_id}", headers=auth).json()
    assert meta["enabled"] is True and meta["recording"]["status"] == "completed"
    assert "storage_key" not in meta["recording"] and str(rec_dir) not in json.dumps(meta)  # no paths exposed
    listed = client.get(f"/api/recordings?call_ids={call_id},nope", headers=auth).json()
    assert [i["call_id"] for i in listed["items"]] == [call_id]

    full = client.get(f"/api/recordings/{call_id}/audio", headers=auth)
    assert full.status_code == 200 and full.headers["accept-ranges"] == "bytes"
    size = len(full.content)
    part = client.get(f"/api/recordings/{call_id}/audio", headers={**auth, "Range": "bytes=100-199"})
    assert part.status_code == 206 and part.content == full.content[100:200]
    assert part.headers["content-range"] == f"bytes 100-199/{size}"
    tail = client.get(f"/api/recordings/{call_id}/audio", headers={**auth, "Range": "bytes=-10"})
    assert tail.status_code == 206 and tail.content == full.content[-10:]
    assert client.get(f"/api/recordings/{call_id}/audio", headers={**auth, "Range": f"bytes={size}-"}).status_code == 416

    # Only with the API key; ids are validated (no path traversal).
    assert client.get(f"/api/recordings/{call_id}/audio").status_code in (401, 403)
    assert client.get("/api/recordings/..%2F..%2Fetc/audio", headers=auth).status_code in (404, 422)
    assert client.get("/api/recordings/nope/audio", headers=auth).status_code == 404

    path = rec_dir / row["storage_key"]
    assert client.delete(f"/api/recordings/{call_id}", headers=auth).json()["recording"]["status"] == "deleted"
    assert not path.exists()
    assert client.get(f"/api/recordings/{call_id}/audio", headers=auth).status_code == 404
    assert client.delete(f"/api/recordings/{call_id}", headers=auth).status_code == 200  # safe to repeat


def test_storage_keys_can_never_leave_the_recordings_dir(rec_dir):
    for bad in ("../x.wav", "/etc/passwd", "a/b.wav", "x.txt", ""):
        with pytest.raises(recording.RecordingError):
            recording.storage_path(settings, bad)
    assert recording.storage_path(settings, "abc.wav").parent == rec_dir.resolve()


def test_retention_deletes_only_expired_completed_recordings(client, sync_engine, rec_dir, tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "RECORDING_RETENTION_DAYS", 90)
    rec_dir.mkdir(parents=True)
    outside = tmp_path / "keep.wav"
    outside.write_bytes(b"x")
    now = datetime(2026, 10, 20)
    rows = [("old", "completed", now - timedelta(days=91)), ("new", "completed", now - timedelta(days=10)),
            ("oldfail", "failed", now - timedelta(days=200))]
    with sync_engine.begin() as c:
        for cid, status, created in rows:
            (rec_dir / f"{cid}.wav").write_bytes(b"x")
            c.execute(text("insert into call_recordings (id, call_id, storage_key, format, status, created_at) "
                           "values (:i, :c, :k, 'wav', :s, :t)"), {"i": cid, "c": cid, "k": f"{cid}.wav", "s": status, "t": created})
    assert asyncio.run(recording.purge_expired(settings, now)) == 1
    assert asyncio.run(recording.purge_expired(settings, now)) == 0  # idempotent
    assert not (rec_dir / "old.wav").exists() and (rec_dir / "new.wav").exists() and (rec_dir / "oldfail.wav").exists()
    assert outside.exists()
    assert _row(sync_engine, "old", want=None)["status"] == "deleted"
    assert _row(sync_engine, "new", want=None)["status"] == "completed"


# ------------------------------------------------------------------ recording notice
NOTICE = "This call may be recorded for quality purposes."


def _flow_call(client, auth, notice=NOTICE):
    flow = nila_copy(greeting={"text": "Hello, am I speaking with {{customer_name}}?"}, recording_notice=notice)
    return _call(client, auth, flow_id="flow_rec", flow_version=1, flow_draft=True, flow=flow)


def _agent_lines(sync_engine, call_id):
    time.sleep(0.4)
    with sync_engine.connect() as c:
        return c.execute(text("select text from transcripts where call_id = :id and speaker = 'agent' order by id"),
                         {"id": call_id}).scalars().all()


def test_the_recording_notice_is_spoken_after_the_greeting_while_recording(client, auth, fakes, sync_engine, rec_dir):
    call_id, token = _flow_call(client, auth)
    fakes.stt.replies = ["Hello?"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _greet(ws)
    assert _agent_lines(sync_engine, call_id) == [f"Hello, am I speaking with Ragul? {NOTICE}"]
    assert NOTICE in [t for t, _ in fakes.tts.synthesized]


def test_no_notice_while_recording_is_off(client, auth, fakes, sync_engine):
    call_id, token = _flow_call(client, auth)
    fakes.stt.replies = ["Hello?"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _greet(ws)
    assert _agent_lines(sync_engine, call_id) == ["Hello, am I speaking with Ragul?"]


def test_the_catalog_reports_recording_and_keeps_optional_fields_out(client, auth, rec_dir):
    cat = client.get("/api/flows/builtin", headers=auth).json()
    assert cat["recording_enabled"] is True
    for flow in cat["flows"].values():
        assert "pauses" not in flow and "recording_notice" not in flow  # absent, never null
