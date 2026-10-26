"""PUBLIC_BASE_URL must really reach this server, and a call Plivo / Twilio never reports on is failed
with the reason instead of staying "initiating" (Dispatch then waited 15 minutes for it)."""
from __future__ import annotations

import time
from datetime import timedelta

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.core.config import settings
from app.db.models import utcnow
from app.services import call_service, public_url

PHONE = "+919876543210"
SELF_URL = f"https://test.example.com/health/self/{public_url.INSTANCE_TOKEN}"


@pytest.fixture(autouse=True)
def fresh_check():
    public_url.reset_public_url_cache()
    yield
    public_url.reset_public_url_cache()


@pytest.fixture
def probe(monkeypatch):
    """Fake self-check: answers `probe.reason` (None = reachable) and records each URL it was asked."""

    class Probe:
        reason = None
        urls: list = []

    p = Probe()
    p.urls = []

    async def fake(url, transport=None):
        p.urls.append(url)
        return p.reason

    monkeypatch.setattr(settings, "PUBLIC_URL_CHECK", True)
    monkeypatch.setattr(public_url, "_probe", fake)
    return p


def _outbound(client, auth):
    agent = next(a["id"] for a in client.get("/api/agents", headers=auth).json() if a["name"] == "Nila")
    r = client.post("/api/calls/outbound", headers=auth,
                    json={"phone_number": PHONE, "customer_name": "Ragul", "gender": "male", "agent_id": agent})
    assert r.status_code == 200, r.text
    return r.json()["call_id"]


def _row(sync_engine, call_id):
    with sync_engine.connect() as c:
        return c.execute(text("select status, outcome, hangup_cause from calls where id = :id"), {"id": call_id}).one()


def _wait_for(check, seconds=5.0):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if check():
            return True
        time.sleep(0.05)
    return False


# ------------------------------------------------------------------ the self-check
def test_only_this_process_answers_its_own_token(client):
    r = client.get(f"/health/self/{public_url.INSTANCE_TOKEN}")
    assert r.status_code == 200 and r.json() == {"status": "ok", "self": True}
    assert client.get("/health/self/someone-elses-token").status_code == 404


def test_ready_reports_an_unreachable_public_url_and_is_not_ready(client, probe):
    probe.reason = "ngrok tunnel offline"
    r = client.get("/ready")
    assert r.status_code == 503
    body = r.json()
    assert body["status"] == "not_ready" and body["providers"]["public_base_url"] == "unreachable"
    assert body["public_base_url_check"] == {"url": "https://test.example.com", "reachable": False, "reason": "ngrok tunnel offline"}
    assert probe.urls == [SELF_URL]


def test_ready_when_the_public_url_reaches_this_server_and_the_check_is_cached(client, probe):
    r = client.get("/ready")
    assert r.status_code == 200
    assert r.json()["providers"]["public_base_url"] == "configured"
    assert r.json()["public_base_url_check"] == {"url": "https://test.example.com", "reachable": True, "reason": None}
    client.get("/ready")
    assert len(probe.urls) == 1  # once a minute at most


def test_check_off_only_looks_at_the_setting(client):
    body = client.get("/ready").json()  # PUBLIC_URL_CHECK=false in the test settings
    assert body["providers"]["public_base_url"] == "configured"
    assert body["public_base_url_check"]["reachable"] is None


async def test_a_failure_is_checked_again_sooner_than_a_success(probe, monkeypatch):
    probe.reason = "HTTP 404"
    assert (await public_url.check_public_url()).reachable is False
    assert (await public_url.check_public_url()).reachable is False
    assert len(probe.urls) == 1
    monkeypatch.setattr(public_url, "FAIL_TTL_SECONDS", 0.0)
    probe.reason = None
    assert (await public_url.check_public_url()).reachable is True  # ngrok started again
    assert (await public_url.check_public_url(force=True)).reachable is True
    assert len(probe.urls) == 3


@pytest.mark.parametrize("respond, reason", [
    (lambda req: httpx.Response(200, json={"status": "ok", "self": True}), None),
    (lambda req: httpx.Response(200, json={"status": "ok"}), "answered by another server"),
    (lambda req: httpx.Response(404, headers={"ngrok-error-code": "ERR_NGROK_3200"}, text="offline"), "ngrok tunnel offline"),
    (lambda req: httpx.Response(502, headers={"ngrok-error-code": "ERR_NGROK_8012"}), "ngrok ERR_NGROK_8012"),
    (lambda req: httpx.Response(502), "HTTP 502"),
])
async def test_probe_reasons(respond, reason):
    seen = []

    def handler(request):
        seen.append(request)
        return respond(request)

    assert await public_url._probe(SELF_URL, transport=httpx.MockTransport(handler)) == reason
    assert seen[0].headers.get("ngrok-skip-browser-warning") == "1"  # past ngrok's browser warning page


@pytest.mark.parametrize("error, reason", [
    (httpx.ConnectError("refused"), "can't connect (ConnectError)"),
    (httpx.ReadTimeout("slow"), "no answer within 5s"),
])
async def test_probe_network_errors(error, reason):
    def handler(request):
        raise error

    assert await public_url._probe(SELF_URL, transport=httpx.MockTransport(handler)) == reason


def test_the_reason_always_fits_hangup_cause():
    for why in ("ngrok tunnel offline", "HTTP 404", "answered by another server", "can't connect (ConnectError)",
                "no answer within 5s", "ngrok " + "E" * 30, None):
        for provider in ("Plivo", "Twilio"):
            assert len(call_service.no_callback_cause(provider, why, 120)) <= 100
    assert call_service.no_callback_cause("Plivo", "ngrok tunnel offline", 120) == (
        "No word from Plivo: PUBLIC_BASE_URL unreachable (ngrok tunnel offline). Start ngrok or fix it")
    assert call_service.no_callback_cause("Plivo", None, 120) == (
        "No word from Plivo within 120s of dialling. Check the Plivo console")


# ------------------------------------------------------------------ a call nobody reports on
def test_a_call_plivo_never_reports_on_fails_with_the_reason(client, auth, sync_engine, probe, monkeypatch):
    monkeypatch.setattr(settings, "NO_PROVIDER_CALLBACK_SECONDS", 0.3)
    probe.reason = "ngrok tunnel offline"
    call_id = _outbound(client, auth)
    assert _row(sync_engine, call_id)[0] == "initiating"
    assert _wait_for(lambda: _row(sync_engine, call_id)[0] == "failed")
    assert _row(sync_engine, call_id) == (
        "failed", "call_failed", "No word from Plivo: PUBLIC_BASE_URL unreachable (ngrok tunnel offline). Start ngrok or fix it")
    with sync_engine.connect() as c:
        payload = c.execute(text("select payload from call_events where call_id = :id and event_type = 'status:failed'"),
                            {"id": call_id}).scalar()
    assert '"no_provider_callback"' in payload and "ngrok tunnel offline" in payload
    assert probe.urls == [SELF_URL]  # checked again at that moment, not from an old result
    assert client.get("/ready").json()["active_calls"] == 0  # a call that never connected is not "active"


def test_a_call_plivo_reports_on_is_left_alone(client, auth, sync_engine, probe, monkeypatch):
    monkeypatch.setattr(settings, "NO_PROVIDER_CALLBACK_SECONDS", 0.3)
    call_id = _outbound(client, auth)
    client.post(f"/api/webhooks/plivo/status?call_id={call_id}", data={"Event": "Ring", "CallStatus": "ringing", "CallUUID": "u1"})
    time.sleep(0.8)
    assert _row(sync_engine, call_id) == ("ringing", None, None)
    assert probe.urls == []


def test_watchdog_off_waits_as_before(client, auth, sync_engine):
    call_id = _outbound(client, auth)  # NO_PROVIDER_CALLBACK_SECONDS=0 in the test settings
    time.sleep(0.4)
    assert _row(sync_engine, call_id)[0] == "initiating"


# ------------------------------------------------------------------ after a restart
def test_restart_closes_calls_that_waited_too_long_and_keeps_watching_the_rest(auth, sync_engine, monkeypatch):
    from app.main import app

    with TestClient(app) as c:  # place two calls while the watch is off
        old, young = _outbound(c, auth), _outbound(c, auth)
    limit = 120
    with sync_engine.begin() as conn:
        conn.execute(text("update calls set started_at = :t where id = :id"), {"t": utcnow() - timedelta(minutes=10), "id": old})
        conn.execute(text("update calls set started_at = :t where id = :id"),
                     {"t": utcnow() - timedelta(seconds=limit - 0.4), "id": young})
    monkeypatch.setattr(settings, "NO_PROVIDER_CALLBACK_SECONDS", limit)

    with TestClient(app) as c:  # start-up: the overdue call is closed at once, the other one ~0.4 s later
        assert _row(sync_engine, old) == ("failed", "call_failed", "No word from Plivo before the voice backend restarted")
        assert _wait_for(lambda: _row(sync_engine, young)[0] == "failed")
        assert c.get("/ready").json()["active_calls"] == 0
    assert _row(sync_engine, young) == ("failed", "call_failed", "No word from Plivo within 120s of dialling. Check the Plivo console")


def test_restart_with_the_watch_off_touches_nothing(auth, sync_engine):
    from app.main import app

    with TestClient(app) as c:
        call_id = _outbound(c, auth)
    with sync_engine.begin() as conn:
        conn.execute(text("update calls set started_at = :t where id = :id"), {"t": utcnow() - timedelta(hours=1), "id": call_id})
    with TestClient(app):
        pass
    assert _row(sync_engine, call_id)[0] == "initiating"
