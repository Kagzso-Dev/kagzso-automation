"""Faster first replies without changing what is said (each part behind its own switch in config).

* Key lines (KEY_LINES_SCRIPTED): the flow's introduction + permission line and its company
  introduction are read word for word from the flow's own blocks and spoken by the system after a
  clear "yes". Anything that is not a clear "yes" still goes to the AI.
* Adaptive end of speech (ADAPTIVE_EOS): what the customer said so far decides how long to wait -
  short for a complete short answer, longer when the sentence trails off.
* Acknowledgements (THINKING_ACK): a rotated pool of short lines played while the AI is slow.
* Natural rhythm (RHYTHM_GAP, RHYTHM_SENTENCE_PAUSES): the gap before a reply, pauses between sentences.
"""
from __future__ import annotations

import random
import re
import unicodedata
from typing import Dict, List, Optional

from app.services import voice_focus as vf

# ------------------------------------------------------------------ key lines
_QUOTED = re.compile(r'^\s*>?\s*"(.+)"\s*$')
_VAR = re.compile(r"\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}")
# Variables a key line may use: the same ones the greeting and identity lines are rendered with.
_LINE_VARIABLES = {"customer_name", "contact_name", "name", "title_to_use", "title", "honorific", "addressed_name",
                   "company_name", "time_greeting", "short_delay", "medium_delay", "long_delay"}


def quoted_line(block_text: str, need_exactly: bool = False) -> Optional[str]:
    """The first line of a block that is only a quoted sentence ('> "..."' or '"..."'), i.e. the line
    the block tells the AI to say. need_exactly: only when the block says to say it "exactly"."""
    if need_exactly and "exactly" not in block_text.lower():
        return None
    for line in block_text.splitlines():
        m = _QUOTED.match(line)
        if m:
            text = m.group(1).strip()
            if all(v in _LINE_VARIABLES for v in _VAR.findall(text)):
                return text
            return None
    return None


def flow_key_lines(flow) -> Dict[str, str]:
    """{"permission": template, "intro": template} from a call flow's blocks "permission" and
    "company_intro" (templates keep {{title_to_use}} etc.). Missing or unclear blocks are left out."""
    out: Dict[str, str] = {}
    for block in flow.blocks:
        text = getattr(block, "text", None)
        if not text:
            continue
        if block.id == "permission" and "permission" not in out:
            line = quoted_line(text)
            if line:
                out["permission"] = line
        elif block.id == "company_intro" and "intro" not in out:
            line = quoted_line(text, need_exactly=True)
            if line:
                out["intro"] = line
    if "permission" not in out:
        out.pop("intro", None)  # the introduction is only scripted right after a scripted permission line
    return out


def flow_dnc_line(flow) -> Optional[str]:
    """The line a flow's block "do_not_call" tells the AI to say (its first quoted line, locked or
    edited block alike), or None. DNC_ENFORCE speaks it word for word."""
    from app.flows.schema import LOCKED_BLOCKS

    for block in flow.blocks:
        if block.id != "do_not_call":
            continue
        text = getattr(block, "text", None) or LOCKED_BLOCKS.get(getattr(block, "locked", "") or "", "")
        return quoted_line(text) if text else None
    return None


# ------------------------------------------------------------------ a clear "yes"
_YES = {
    "yes", "yeah", "yea", "ya", "yep", "yup", "yess", "speaking", "haan", "han",
    # Tamil
    "ஆமா", "ஆமாம்", "ஆம்", "ஆமாங்க", "சொல்லுங்க", "சொல்லுங்கள்", "பேசுறேன்", "பேசறேன்",
    "aama", "aamaa", "amaa", "aamam", "sollunga",
    # Hindi (the Thaara Hindi flow's identity words)
    "हाँ", "हां", "हाँजी", "हांजी", "जी", "बोलिए", "बताइए", "haanji", "ji", "boliye", "bataiye",
    # Telugu (the Thaara Telugu flow's identity words)
    "అవును", "అవునండి", "చెప్పండి", "నేనే", "మాట్లాడుతున్నాను", "avunu", "avunandi", "cheppandi",
}
_PERMISSION_YES = _YES | {
    "ok", "okay", "okey", "sure", "fine", "go", "ahead", "tell", "please",
    "சரி", "சரிங்க", "ஓகே", "ஓக்கே", "பேசுங்க", "sari", "saringa", "pesunga",
    "సరే", "సరేనండి", "మాట్లాడండి", "ఓకే", "sare", "matladandi",
}
_COURTESY = {"sir", "madam", "mam", "maam", "ma", "ji", "சார்", "மேடம்", "ங்க", "me", "ம்", "உம்", "hmm", "hm",
             "सर", "मैडम", "సార్", "మేడం", "అండి"}
_PHRASES = {"நான் தான்", "நான்தான்", "naan dhaan", "naan than", "naan thaan", "that s me", "it s me", "this is me",
            "मैं ही हूँ", "मैं ही हूं", "मैं बोल रहा हूँ", "मैं बोल रही हूँ", "main hi hoon", "నేనే మాట్లాడుతున్నాను"}
_PERMISSION_PHRASES = {"ठीक है", "ठीक हैं", "theek hai", "thik hai"}
# INDIC_WORD_SPLIT: Tamil / Hindi / Telugu / Kannada backchannels said over the agent ("ஆமா", "சரிங்க",
# "ம்", "हाँ जी") - the non-English words of the yes / courtesy / hum lists above and in voice focus.
INDIC_BACKCHANNELS = frozenset(w for w in _PERMISSION_YES | _COURTESY | vf.LONE_FILLERS if not w.isascii())


def clear_yes(text: str, kind: str) -> bool:
    """A short reply that is nothing but "yes" (kind "identity") or "yes / okay / go ahead" (kind
    "permission"): at most four words, every word a yes word or a courtesy word ("sir"). A question,
    a "but", a "no" or any other word makes it not clear - the AI answers it."""
    words = vf.words(text)
    if not 0 < len(words) <= 4:
        return False
    rest = [w for w in words if w not in _COURTESY]
    if not rest:
        return False
    if " ".join(rest) in _PHRASES or (kind == "permission" and " ".join(rest) in _PERMISSION_PHRASES):
        return True
    return all(w in (_YES if kind == "identity" else _PERMISSION_YES) for w in rest)


# ------------------------------------------------------------------ adaptive end of speech
_SHORT_ANSWER = _PERMISSION_YES | _COURTESY | {
    "no", "nope", "nah", "not", "now", "interested", "busy", "thanks", "thank", "you",
    "இல்ல", "இல்லை", "இல்லங்க", "வேண்டாம்", "வேணாம்", "வேண்டாங்க", "இப்போ",
    "illa", "illai", "venam", "vendam", "nahi", "nahin", "नहीं", "नही", "अभी", "ठीक", "है", "theek", "hai",
    "లేదు", "వద్దు", "లేదండి", "ledu", "vaddu",
}
_TRAILING = {
    "and", "but", "so", "or", "because", "cause", "then", "the", "a", "an", "to", "of", "my", "our", "is", "are",
    "with", "like", "if", "that", "which", "for", "in", "on", "uh", "um", "er",
    "அப்புறம்", "வந்து", "அதாவது", "ஆனா", "அதனால", "அதனால்", "என்னன்னா", "அப்படின்னா", "மற்றும்",
    "apram", "appuram", "vandhu", "vanthu", "aana", "athavathu", "adhanala",
    "और", "लेकिन", "तो", "क्योंकि", "मतलब", "फिर",
    "మరియు", "కానీ", "అంటే", "అందుకే", "తర్వాత", "ఇంకా",
}


def utterance_kind(text: str, after_question: bool) -> str:
    """How finished the customer's words sound: "trailing" (ends on "and", "அப்புறம்", "...", a comma),
    "complete" (a short answer of at most four yes / no words right after the agent asked something),
    otherwise "normal"."""
    words = vf.words(text)
    if not words:
        return "normal"
    stripped = text.rstrip()
    if stripped.endswith(("...", "…", ",")) or words[-1] in _TRAILING:
        return "trailing"
    if (after_question and len(words) <= 4 and all(w in _SHORT_ANSWER for w in words)
            and any(w not in _COURTESY for w in words)):  # a lone "ம்" / "hmm" may be the start of a thought
        return "complete"
    return "normal"


# ------------------------------------------------------------------ acknowledgements
# NEEDS NATIVE-SPEAKER REVIEW (Tamil, Hindi, Telugu, Kannada) before THINKING_ACK is switched on for real calls.
# One or two words each, said at the reply's own speed; {{title_to_use}} = sir / madam as given, never guessed.
ACKS: Dict[str, List[str]] = {
    "en": ["Okay {{title_to_use}}.", "I see.", "Right, {{title_to_use}}.", "Sure."],
    "ta": ["சரிங்க {{title_to_use}}.", "ஓ, புரியுது.", "நல்லது {{title_to_use}}.", "Okay {{title_to_use}}."],
    "hi": ["जी {{title_to_use}}.", "अच्छा.", "ठीक है {{title_to_use}}.", "Okay {{title_to_use}}."],
    "te": ["సరేనండి {{title_to_use}}.", "ఓ, అర్థమైంది.", "మంచిది {{title_to_use}}.", "Okay {{title_to_use}}."],
    "kn": ["ಸರಿ {{title_to_use}}.", "ಓಹ್, ಅರ್ಥ ಆಯ್ತು.", "Okay {{title_to_use}}."],
}


def ack_templates(language: Optional[str], override: str = "") -> List[str]:
    """The acknowledgement pool for CALL_LANGUAGE, or THINKING_ACK_TEXT (lines separated by "|")."""
    if override.strip():
        return [line.strip() for line in override.split("|") if line.strip()]
    code = (language or "en").split("-")[0].lower()
    return list(ACKS.get(code, ACKS["en"]))


def next_ack(available: List[int], last: Optional[int]) -> Optional[int]:
    """The pool index to play: the next one after the last played, in order (never the same twice)."""
    choices = [i for i in available if i != last]
    if not choices:
        return None
    return next((i for i in choices if last is None or i > last), choices[0])


def strip_leading(text: str, lead: str) -> str:
    """`text` without `lead` at its start (same words, any punctuation), e.g. the AI's "சரிங்க sir, ..."
    right after the acknowledgement "சரிங்க sir." was played. Unchanged when it does not start so."""
    want = vf.words(lead)
    if not want or vf.words(text)[:len(want)] != want:
        return text
    count, in_word = 0, False
    for i, c in enumerate(text):
        sep = c.isspace() or unicodedata.category(c)[0] in "PSZC"
        if not sep:
            in_word = True
        elif in_word:
            in_word, count = False, count + 1
            if count == len(want):
                return text[i:].lstrip(" ,.!?।;:-")
    return ""


# ------------------------------------------------------------------ rhythm
def reply_gap_ms(words: int, long_words: int, short_ms: int, long_ms: int, jitter: float, min_ms: int,
                 rng: Optional[random.Random] = None) -> int:
    """Gap between the customer's last word and the reply (RHYTHM_GAP): short after a short answer,
    long after an answer of `long_words`+ words, varied by +/- jitter, never under min_ms."""
    base = long_ms if words >= long_words else short_ms
    j = max(0.0, min(jitter, 0.9))
    return max(min_ms, int(round(base * (1 + (rng or random).uniform(-j, j)))))


_SENTENCE_GAP = re.compile(r"(?<=[.!?।])\s+(?=\S)")


def with_sentence_pauses(line: str) -> str:
    """A system-spoken line with the flow's short pause between its sentences (RHYTHM_SENTENCE_PAUSES)."""
    return _SENTENCE_GAP.sub(" {{short_delay}} ", line)


def same_line(a: Optional[str], b: Optional[str]) -> bool:
    """Two spoken lines are the same apart from spacing."""
    return bool(a) and bool(b) and " ".join(a.split()) == " ".join(b.split())  # type: ignore[union-attr]

