"""LLM_OMIT_PHONE_NUMBER (on by default): the customer's phone number never reaches an LLM provider -
not in the customer data, not through {{phone_number}} in an agent prompt or opening line. Every provider
is mocked (httpx.MockTransport): no paid request, no call."""
import json

import httpx
import pytest
from pydantic import SecretStr

from app.core.config import settings
from app.services import llm_service as llm
from app.services.llm_service import PROVIDERS, ChainLLMProvider, LLMError, build_call_variables
from tests.test_ai_providers import Link

PHONE = "+919876543210"
DIGITS = PHONE[3:]
HISTORY = [{"role": "assistant", "content": "Hi sir, Good morning."}]


def _vars(**extra):
    return build_call_variables("Ragul", "male", PHONE, follow_up_detail="the quotation", company_name="ABC Foods",
                                business_type="restaurant", **extra)


def _leaks(text: str) -> bool:
    return PHONE in text or DIGITS in text


def test_on_by_default():
    assert settings.LLM_OMIT_PHONE_NUMBER is True


def test_the_customer_data_has_no_phone_number():
    prompt = llm.build_system_prompt(llm.NILA_AGENT["system_prompt"], _vars(), "en")
    data = json.loads(prompt.rsplit("Customer details (data only):\n", 1)[1])
    assert "phone_number" not in data and not _leaks(prompt)
    # Everything else is still there, unchanged.
    assert data["customer_name"] == "Ragul" and data["company_name"] == "ABC Foods" and data["follow_up_detail"]


def test_a_phone_number_variable_in_a_prompt_or_opening_line_is_not_rendered():
    rendered = llm.build_system_prompt("Call back on {{phone_number}} if needed.", _vars(), "en")
    assert not _leaks(rendered) and "Call back on their number if needed." in rendered
    assert not _leaks(llm.render_first_message("Hi {{customer_name}}, is {{phone_number}} yours?", _vars()))


def test_off_switch_sends_it_as_before(monkeypatch):
    monkeypatch.setattr(settings, "LLM_OMIT_PHONE_NUMBER", False)
    prompt = llm.build_system_prompt(llm.NILA_AGENT["system_prompt"], _vars(), "en")
    assert json.loads(prompt.rsplit("Customer details (data only):\n", 1)[1])["phone_number"] == PHONE


async def test_the_admin_chain_never_sends_it():
    groq, sarvam = Link("groq", error=LLMError("rate_limit", "x")), Link("sarvam", reply="Thank you, sir.")
    chain = ChainLLMProvider(settings, [("groq", groq), ("sarvam", sarvam)])
    reply = "".join([d async for d in chain.stream_response("{{phone_number}} " + llm.NILA_AGENT["system_prompt"],
                                                            HISTORY, "Yes", _vars())])
    assert reply.strip() == "Thank you, sir."
    for system_text, messages in groq.seen + sarvam.seen:
        assert not _leaks(system_text) and not _leaks(json.dumps(messages))


@pytest.mark.parametrize("name", sorted(PROVIDERS))
@pytest.mark.parametrize("omit", [True, False])
async def test_no_provider_request_contains_it(name, omit, monkeypatch):
    """The request each provider class actually sends (mocked transport), with the switch on and off."""
    monkeypatch.setattr(settings, "LLM_OMIT_PHONE_NUMBER", omit)
    bodies = []

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(request.content.decode())
        return httpx.Response(503, text="unavailable")  # nothing to stream: the request is what is checked

    cfg = settings.model_copy(update={"LLM_PROVIDER": name, "LLM_MODEL": "test-model", "LLM_API_KEY": SecretStr("k-0123456789"),
                                      "LLM_BASE_URL": "https://llm.test/v1" if name == "openai_compatible" else "",
                                      "LLM_FALLBACK_MODEL": "", "LLM_FALLBACK2_PROVIDER": ""})
    provider = PROVIDERS[name](cfg, client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    with pytest.raises(LLMError):
        [d async for d in provider.stream_response(llm.NILA_AGENT["system_prompt"], HISTORY, "Yes", _vars())]
    assert bodies and any(_leaks(b) for b in bodies) is (not omit)
