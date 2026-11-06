"""Per-language turn-taking and reply tuning (Dispatch: Settings → Voice response tuning).

Tamil only today. A call in any language without an entry in LANGUAGE_RULES never reaches this logic: for_session
hands back the very Settings object it was given, so the call runs on exactly the values it always had. Adding a
language = one LanguageRules entry here, plus its code in VOICE_TUNING_LANGUAGES (packages/shared/src/aiCallVoiceTuning.ts).

With tuning a call:
  - replies quickly after a clearly finished sentence, waits longer after an unfinished one, and never waits past the cap
  - never starts a reply over the customer: a reply that is ready waits until they stop, and new words join the same turn
  - answers a lone sound ("aaa", "ம்ம்", "a") with one fixed check-in line instead of the LLM
  - keeps replies short (a prompt line and a lower token cap)
The "Current behavior" preset sends no tuning at all, so it is an exact rollback. Timing logs stay on for the language.
"""
from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass
from typing import Any, FrozenSet, List, Mapping, Optional, Tuple

from app.core.config import Settings
from app.core.logging import get_logger
from app.services import voice_focus as vf

log = get_logger("turn_tuning")

VARIABLE = "flow_voice_tuning"  # on the call's variables: the tuning Dispatch sent, as JSON
COMPLETE, NORMAL, TRAILING = "complete", "normal", "trailing"  # how finished the customer's words sound

# ------------------------------------------------------------------ Tamil
# NEEDS NATIVE-SPEAKER REVIEW before relying on them. These lists decide when the AI speaks, so they are kept here,
# small and easy to edit: add or remove a word and nothing else has to change.

# A sound on its own, not an answer. voice_focus.LONE_FILLERS is the main list; only what it lacks goes here.
# A held sound ("aaaa", "ஆஆஆ", "ம்ம்ம்ம்") and any single letter already count, so they need no entry.
TAMIL_EXTRA_SOUNDS = frozenset({
    "ஓஹோ", "ஓஹ்", "ஆஹா", "ஆஹ்", "அஹ்", "ஹா", "ஹ", "aha", "oho",
})
# One or two characters that ARE words: everything else that short counts as a sound.
TAMIL_SHORT_REAL_WORDS = frozenset({"ok", "no", "ya", "hi", "வா", "போ", "நீ", "தா", "யா"})
# Answers that are complete on their own: the AI may reply quickly (up to four of these in a row).
TAMIL_SHORT_ANSWERS = frozenset({
    "ஆமா", "ஆமாம்", "ஆமாங்க", "ஆம்", "சரி", "சரிங்க", "ஓகே", "ok", "okay", "yes", "no", "yeah", "ya",
    "இல்ல", "இல்லை", "இல்லைங்க", "இல்லங்க", "வேண்டாம்", "வேணாம்", "வேண்டாங்க", "வேணாங்க", "வேணும்", "வேண்டும்", "போதும்",
    "சொல்லுங்க", "ஹலோ", "hello", "thanks", "நன்றி", "sir", "madam", "சார்", "மேடம்",
})
# The sentence so far ends on one of these words: the customer is not done, so the AI waits the extra time.
TAMIL_UNFINISHED_WORDS = frozenset({
    # joining words
    "ஆனா", "ஆனால்", "அப்புறம்", "அதனால", "அதனால்", "அதாவது", "என்னன்னா", "ஏன்னா", "மற்றும்", "பிறகு", "அப்போ", "அப்ப", "வந்து", "சோ",
    # words that open what comes next
    "ஒரு", "இந்த", "அந்த", "என்", "என்னோட", "எங்க", "உங்க", "நம்ம", "நான்", "நாங்க", "நீங்க", "அவங்க", "இவங்க",
    # endings said as a word after an English word ("hotel-ல"), and words that need the rest of the sentence
    "ல", "ல்", "க்கு", "கு", "ஓட", "ஐ", "கிட்ட", "பத்தி", "மாதிரி", "கூட", "வரைக்கும்",
    "எனக்கு", "உங்களுக்கு", "எங்களுக்கு", "நமக்கு", "அவங்களுக்கு", "ரொம்ப", "கொஞ்சம்", "நிறைய", "இன்னும்", "வேற",
    # English, on a code-mixed call
    "and", "but", "so", "or", "because", "then", "the", "a", "an", "to", "of", "my", "our", "is", "are", "with", "like",
    "if", "that", "which", "for", "in", "on",
})
TAMIL_UNFINISHED_ENDINGS = ("ன்னா", "னா", "ந்தா", "ந்து", "ட்டு", "ல்", "ல", "ோட", "ோடு")
# The sentence so far ends like a finished one (verb forms, question words): the AI replies quickly.
TAMIL_FINISHED_WORDS = frozenset({
    "இருக்கு", "இருக்கா", "இருக்கும்", "இல்ல", "இல்லை", "இல்லையா", "வேணும்", "வேண்டும்", "முடியும்", "தெரியும்", "போதும்",
    "ஆகும்", "புரியும்", "யாரு", "யார்", "என்ன", "என்னது", "எது", "எப்படி", "எவ்வளவு", "எத்தனை", "எதுக்கு", "ஏன்", "எப்போ", "எங்கே",
    "okay", "ok", "thanks", "sir", "madam",
})
TAMIL_FINISHED_ENDINGS = ("ேன்", "ோம்", "ங்க", "ாம்", "ச்சு", "குது", "ுமா", "ாது", "யல", "க்கல", "ரல")
# The one fixed line said after a lone sound, in turn. Pre-rendered when the call starts, so it plays at once.
TAMIL_CHECKIN_LINES = ("இது ஓகே வா?", "இதுல உங்களுக்கு interest இருக்கா?")
TAMIL_REPLY_RULE = (
    "\n- Reply length: your whole reply is at most two short sentences, about 20 words in all, even when you explain "
    "something. Say one thing, then stop and let the customer speak."
)
# The model all but ignored the line above (real Tamil replies: 3.0 sentences with or without it). Right beside the
# customer's words it listens better (2.5), and the spoken limit below makes sure of the rest.
TAMIL_REPLY_REMINDER = (
    "\n\n(System reminder, not said by the customer: reply in at most two short sentences, about 20 words in all, then stop.)"
)
TAMIL_MAX_REPLY_SENTENCES = 2  # spoken; a one- or two-word acknowledgement ("புரியுது sir.") doesn't use one up
# A safety net above a normal reply, not what shortens it: a reply that reached the cap would stop mid-sentence.
TAMIL_MAX_REPLY_TOKENS = 260


# ------------------------------------------------------------------ per-language rules
def _letters(word: str) -> List[str]:
    """The word's letters, each with its vowel signs, with held letters counted once: "aaaa" -> ["a"], "ohhh" -> ["o",
    "h"], "ம்ம்ம்" -> ["ம்"]."""
    letters: List[str] = []
    for c in word:
        if letters and unicodedata.category(c)[0] == "M":
            letters[-1] += c
        else:
            letters.append(c)
    return [x for i, x in enumerate(letters) if i == 0 or x != letters[i - 1]]


@dataclass(frozen=True)
class LanguageRules:
    sounds: FrozenSet[str]
    short_real_words: FrozenSet[str]
    short_answers: FrozenSet[str]
    unfinished_words: FrozenSet[str]
    unfinished_endings: Tuple[str, ...]
    finished_words: FrozenSet[str]
    finished_endings: Tuple[str, ...]
    checkin_lines: Tuple[str, ...]
    reply_rule: str
    reply_reminder: str
    max_reply_sentences: int
    max_reply_tokens: int

    def _is_sound_word(self, word: str) -> bool:
        if word.isdigit():
            return len(word) == 1
        letters = _letters(word)
        held = "".join(letters)  # "okk" -> "ok", "ohhh" -> "oh"
        if word in self.short_real_words or held in self.short_real_words:
            return False
        return word in self.sounds or held in self.sounds or len(letters) == 1

    def is_sound(self, text: str) -> bool:
        """Only a sound or a stray letter, nothing a person says as a word: "aaa", "ஆஆ", "ம்ம்", "mm-hmm", "a", or one or
        two characters that are not a word. "ஆமா", "சரி", "இல்ல", "okay", "no" and "10" never are."""
        words = vf.words(text.replace("-", ""))
        if not words:
            return False
        if all(self._is_sound_word(w) for w in words):
            return True
        joined = "".join(words)
        return len(joined) <= 2 and joined not in self.short_real_words and not joined.isdigit()

    def utterance_kind(self, text: str, min_words: int = 1) -> str:
        """How finished the customer's words sound. Rules only: no second LLM call. When unsure: NORMAL, the usual wait."""
        words = vf.words(text)
        if not words or self.is_sound(text):
            return NORMAL  # a sound may be the start of a thought
        last, stripped = words[-1], text.rstrip()
        if stripped.endswith(("...", "…", ",")):
            return TRAILING
        if len(words) <= 4 and all(w in self.short_answers for w in words):
            return COMPLETE
        if len(words) < min_words:
            return TRAILING
        if last in self.finished_words:
            return COMPLETE
        if last in self.unfinished_words:
            return TRAILING
        if last.endswith(self.finished_endings):
            return COMPLETE
        if last.endswith(self.unfinished_endings):
            return TRAILING
        return COMPLETE if stripped.endswith((".", "?", "!")) else NORMAL


LANGUAGE_RULES = {
    "ta": LanguageRules(
        sounds=vf.LONE_FILLERS | TAMIL_EXTRA_SOUNDS,
        short_real_words=TAMIL_SHORT_REAL_WORDS,
        short_answers=TAMIL_SHORT_ANSWERS,
        unfinished_words=TAMIL_UNFINISHED_WORDS,
        unfinished_endings=TAMIL_UNFINISHED_ENDINGS,
        finished_words=TAMIL_FINISHED_WORDS,
        finished_endings=TAMIL_FINISHED_ENDINGS,
        checkin_lines=TAMIL_CHECKIN_LINES,
        reply_rule=TAMIL_REPLY_RULE,
        reply_reminder=TAMIL_REPLY_REMINDER,
        max_reply_sentences=TAMIL_MAX_REPLY_SENTENCES,
        max_reply_tokens=TAMIL_MAX_REPLY_TOKENS,
    ),
}


def rules_for(language: Optional[str]) -> Optional[LanguageRules]:
    """The language's rules, or None: every language without an entry."""
    return LANGUAGE_RULES.get((language or "").split("-")[0].strip().lower())


# ------------------------------------------------------------------ one call
@dataclass(frozen=True)
class CallTuning:
    rules: LanguageRules
    preset: str
    min_words: int

    def utterance_kind(self, text: str) -> str:
        return self.rules.utterance_kind(text, self.min_words)

    def reply_is_full(self, spoken: List[str]) -> bool:
        """The reply has said all it may. It always ends on a whole sentence, and what follows is read but not spoken."""
        return sum(len(vf.words(s)) > 2 for s in spoken) >= self.rules.max_reply_sentences


def call_variable(tuning: Optional[Mapping[str, Any]], cfg: Settings) -> Optional[str]:
    """What to keep on the call, or None: nothing was sent, or this backend's language has no rules (ignored)."""
    if tuning is None or rules_for(cfg.call_language) is None:
        return None
    return json.dumps(dict(tuning), separators=(",", ":"))


def for_session(cfg: Settings, variables: Mapping[str, Optional[str]]) -> Tuple[Settings, Optional[CallTuning]]:
    """This call's settings. Without tuning: the same `cfg` object and None. With it: a private copy (model_copy), so
    the backend's own settings and every other call stay as they are."""
    rules = rules_for(cfg.call_language)
    raw = variables.get(VARIABLE)
    if rules is None or not raw:
        return cfg, None
    try:
        data = json.loads(raw)
        finished = int(data["finished_silence_ms"])
        normal = int(data["end_of_speech_silence_ms"])
        extra = int(data["extra_wait_if_incomplete_ms"])
        cap = int(data["hard_cap_ms"])  # 0 = no cap
        tuning = CallTuning(rules=rules, preset=str(data.get("preset") or "custom"),
                            min_words=int(data.get("min_words_before_reply") or 1))
    except (ValueError, TypeError, KeyError) as exc:
        log.warning("Voice tuning not used (%s) - the call uses the backend's own settings", type(exc).__name__)
        return cfg, None

    def capped(ms: int) -> int:
        return min(ms, cap) if cap else ms

    return cfg.model_copy(update={
        "VAD_SPEECH_END_SILENCE_MS": capped(normal),
        "ADAPTIVE_EOS": True,  # the early transcript that tells a finished sentence from an unfinished one
        "ADAPTIVE_EOS_SHORT_MS": capped(finished),
        "ADAPTIVE_EOS_LONG_MS": capped(normal + extra),
        "STT_STREAMING": False,  # the early transcript needs the REST request
        "SLOW_SPEAKER_END_SILENCE_MS": 0,  # replaced by the unfinished-sentence wait, which lasts one turn, not the call
        "TTS_WARM_STREAM": True,  # the early transcript leaves no STT time to hide the TTS connection behind
        "TTS_FLUSH_FIRST_SENTENCE": True,
        "PRERENDER_FIXED_LINES": True,  # the check-in lines play at once
    }), tuning


def reply_rule(variables: Mapping[str, Optional[str]], language: Optional[str]) -> str:
    """The prompt line for short replies, or "" (no tuning on this call, or no rules for the language)."""
    rules = rules_for(language)
    return rules.reply_rule if rules is not None and variables.get(VARIABLE) else ""


_SENTENCE_MARK = re.compile(r"[.?!]+")


def sentence_count(reply: str) -> int:
    """How many sentences a reply has (timing logs only)."""
    return len(_SENTENCE_MARK.findall(reply)) or (1 if reply.strip() else 0)
