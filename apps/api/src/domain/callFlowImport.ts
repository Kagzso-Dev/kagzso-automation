// "Import full prompt" (Voice Call Flows editor): split a pasted prompt into the flow's blocks.
// Deterministic only: no AI, no guessing below the match threshold.
//
//   1. The text the voice backend adds after every flow ("--- Phone conversation rules", "--- Safety
//      rules", "Customer details (data only)" with the phone number) is cut off and never written.
//   2. Locked block text (runtime data, customer data safety) is found by exact match and ignored.
//   3. The rest is split at headings that match one of this flow's blocks (plus every top-level "#"
//      heading) and at the first line of blocks without a heading (safety rules 21-31, rules 32+).
//      A heading deeper than the current section's heading, and every "---", stays inside it.
//   4. Each section gets a target block, a status and the same checks as a normal save. Apply
//      replaces only the matched blocks' text; the same prompt imported twice changes nothing.

import {
  CALL_FLOW_IMPORT_WARN_CHARS,
  CALL_FLOW_MAX_BLOCK_CHARS,
  CALL_FLOW_MAX_PROMPT_CHARS,
  callFlowDefinition,
  isLockedBlock,
  lacksDoNotCallHandling,
  missingOutcomeKeys,
  unknownCallFlowVariables,
  type CallFlowDefinition,
  type CallFlowImportPreview,
  type CallFlowImportSection,
  type CallFlowTextBlock,
} from "@dispatch/shared";

export const IMPORT_MATCH_THRESHOLD = 0.8;

/** Where the voice backend's own text starts (llm_service VOICE_RULES / SAFETY_RULES / customer data). */
const SYSTEM_TAIL_RES = [/^[ \t]*--- Phone conversation rules/m, /^[ \t]*--- Safety rules/m, /^Customer details \(data only\):/m];
const HEADING_RE = /^(#{1,3})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const FENCE_RE = /^[ \t]*```/;
const VAR_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** Agent names and filler words ignored when comparing headings ("THAARA INTRODUCTION" = "POOJA INTRODUCTION"). */
const IGNORED_WORDS = new Set(["the", "a", "an", "and", "or", "of", "highest", "priority", "thaara", "pooja", "vyshu", "nila", "radhi", "priya", "kayal"]);

/** Normalised heading → block id, for headings that differ from the block's own heading. */
const SYNONYMS: Record<string, string> = {
  "busy not now": "busy",
  busy: "busy",
  "not now": "busy",
  "do not call": "do_not_call",
  dnc: "do_not_call",
  "unclear audio low voice": "unclear_audio",
  "unclear audio": "unclear_audio",
  "low voice": "unclear_audio",
  "safety rules": "rules_safety",
  "safety rules 21 31": "rules_safety",
  "rules 21 31": "rules_safety",
  "who you are": "persona",
  "non negotiable rules": "rules",
  "what does kagzso do": "what_we_do",
  "what does kexo do": "what_we_do",
};

/** UI names for blocks whose text has no heading. */
const BLOCK_LABELS: Record<string, string> = { rules_safety: "Safety rules 21–31", rules_style: "Rules 32 onward" };

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[*`_>#]/g, " ")
    .match(/[a-z0-9]+/g)
    ?.filter((w) => !IGNORED_WORDS.has(w)) ?? [];
const norm = (s: string) => words(s).join(" ");

const firstLine = (text: string) => text.split("\n").find((l) => l.trim())?.trim() ?? "";
const headingOf = (text: string) => {
  const m = HEADING_RE.exec(firstLine(text));
  return m ? m[2]!.replace(/\*+/g, "").trim() : null;
};

export function blockLabel(b: CallFlowTextBlock): string {
  return BLOCK_LABELS[b.id] ?? headingOf(b.text) ?? `${b.id} (${firstLine(b.text).slice(0, 40)})`;
}

/** 0..1 how well a pasted heading names this block. */
function score(heading: string, b: CallFlowTextBlock): number {
  const h = norm(heading);
  if (!h) return 0;
  if (SYNONYMS[h] === b.id) return 0.95;
  if (h === b.id.replace(/_/g, " ")) return 0.95;
  const own = headingOf(b.text);
  if (!own) return 0;
  const o = norm(own);
  if (h === o) return 1;
  const A = new Set(words(heading));
  const B = new Set(words(own));
  const common = [...A].filter((w) => B.has(w)).length;
  const dice = (2 * common) / (A.size + B.size || 1);
  // "UNCLEAR AUDIO AND LOW VOICE" contains every word of "UNCLEAR AUDIO".
  const contains = B.size >= 2 && common === B.size ? IMPORT_MATCH_THRESHOLD : 0;
  return Math.max(dice, contains);
}

function best(heading: string, blocks: CallFlowTextBlock[]): { id: string; score: number } | null {
  let top: { id: string; score: number } | null = null;
  for (const b of blocks) {
    const s = score(heading, b);
    if (!top || s > top.score) top = { id: b.id, score: s };
  }
  return top;
}

function lineDiff(before: string, after: string): CallFlowImportSection["diff"] {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const removed = a.slice(start, endA);
  const added = b.slice(start, endB);
  const cap = 8;
  return {
    removed: removed.slice(0, cap),
    added: added.slice(0, cap),
    more: Math.max(0, removed.length - cap) + Math.max(0, added.length - cap),
  };
}

const varCounts = (text: string) => {
  const out = new Map<string, number>();
  for (const m of text.matchAll(VAR_RE)) out.set(m[1]!, (out.get(m[1]!) ?? 0) + 1);
  return out;
};

/** Remove ** and backticks from quoted spoken lines ("> ..."), listing every changed line. */
function stripSpokenLines(text: string): { text: string; stripped: string[] } {
  const stripped: string[] = [];
  const out = text.split("\n").map((line) => {
    if (!/^[ \t]*>/.test(line)) return line;
    const clean = line.replace(/\*\*|`/g, "");
    if (clean !== line) stripped.push(`${line.trim()} → ${clean.trim()}`);
    return clean;
  });
  return { text: out.join("\n"), stripped };
}

export function renderedSize(def: CallFlowDefinition, lockedText: Record<string, string>): number {
  return def.blocks.reduce((n, b) => n + (isLockedBlock(b) ? (lockedText[b.locked] ?? "").length : b.text.length), 0);
}

/** Ids of blocks whose text (or locked key) differs between two definitions. */
export function changedBlockIds(before: unknown, after: CallFlowDefinition): string[] {
  const prev = new Map<string, string>();
  const parsed = callFlowDefinition.safeParse(before);
  if (parsed.success) for (const b of parsed.data.blocks) prev.set(b.id, isLockedBlock(b) ? `locked:${b.locked}` : b.text);
  return after.blocks.filter((b) => prev.get(b.id) !== (isLockedBlock(b) ? `locked:${b.locked}` : b.text)).map((b) => b.id);
}

type Piece = { kind: "text"; text: string } | { kind: "locked"; heading: string; chars: number };

export interface ImportAnalysis {
  preview: Omit<CallFlowImportPreview, "draftConflict">;
  /** The definition Apply would save (only matched blocks changed). */
  next: CallFlowDefinition;
}

/**
 * Analyse a pasted prompt against `definition` (the working version, with the formerly locked
 * safety blocks already turned into text). Pure: no database, no network.
 */
export function analyzeImport(
  input: { prompt: string; stripSpokenMarkdown?: boolean; mapping?: Record<string, string> },
  definition: CallFlowDefinition,
  lockedText: Record<string, string>,
  warnAboveChars = CALL_FLOW_IMPORT_WARN_CHARS,
): ImportAnalysis {
  const editable = definition.blocks.filter((b): b is CallFlowTextBlock => !isLockedBlock(b));
  const byId = new Map(editable.map((b) => [b.id, b]));
  const lockedBlocks = definition.blocks.filter(isLockedBlock);
  let body = input.prompt.replace(/\r\n?/g, "\n");

  // 1. The system's own tail.
  let tail = "";
  const cut = SYSTEM_TAIL_RES.map((re) => body.search(re)).filter((i) => i >= 0);
  if (cut.length) {
    const at = Math.min(...cut);
    tail = body.slice(at);
    body = body.slice(0, at);
  }

  // 2. Locked block text, by exact match.
  let pieces: Piece[] = [{ kind: "text", text: body }];
  for (const lb of lockedBlocks) {
    const text = lockedText[lb.locked];
    if (!text) continue;
    for (const needle of [text, text.trim()]) {
      const i = pieces.findIndex((p) => p.kind === "text" && needle && p.text.includes(needle));
      if (i < 0) continue;
      const p = pieces[i] as { kind: "text"; text: string };
      const at = p.text.indexOf(needle);
      pieces.splice(
        i,
        1,
        { kind: "text", text: p.text.slice(0, at) },
        { kind: "locked", heading: `${headingOf(text) ?? lb.locked} (locked)`, chars: needle.length },
        { kind: "text", text: p.text.slice(at + needle.length) },
      );
      break;
    }
  }
  pieces = pieces.filter((p) => p.kind === "locked" || p.text.length > 0);

  // 3. Split text pieces into sections.
  const anchors = new Map<string, string>(); // first line of a heading-less block → its id
  for (const b of editable) if (!headingOf(b.text)) anchors.set(firstLine(b.text), b.id);
  const lockedTitles = lockedBlocks.map((b) => norm(headingOf(lockedText[b.locked] ?? "") ?? ""));

  type Raw = { heading: string; text: string; anchor?: string; locked?: { chars: number }; leading?: boolean };
  const raw: Raw[] = [];
  let seenAny = false;
  for (const p of pieces) {
    if (p.kind === "locked") {
      raw.push({ heading: p.heading, text: "", locked: { chars: p.chars } });
      seenAny = true;
      continue;
    }
    let current: Raw | null = null;
    let level = 0; // heading level of the current section: a deeper heading is a sub-heading of it
    let buf = "";
    let fence = false;
    const flush = () => {
      if (current) raw.push({ ...current, text: buf });
      else if (buf.trim()) {
        raw.push({ heading: seenAny ? "(text without a heading)" : "(text before the first heading)", text: buf, leading: !seenAny });
      }
      if (current || buf.trim()) seenAny = true;
      buf = "";
    };
    for (const withNl of p.text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
      const line = withNl.replace(/\n$/, "");
      if (FENCE_RE.test(line)) fence = !fence;
      const h = fence ? null : HEADING_RE.exec(line);
      const anchor = fence ? undefined : anchors.get(line.trim());
      const title = h ? h[2]!.replace(/\*+/g, "").trim() : "";
      const depth = h ? h[1]!.length : 0;
      const names = !!h && ((best(title, editable)?.score ?? 0) >= IMPORT_MATCH_THRESHOLD || lockedTitles.includes(norm(title)));
      const splits = !!anchor || (!!h && (depth === 1 || (names && (level === 0 || depth <= level))));
      if (splits) {
        flush();
        level = anchor ? 1 : depth;
        current = anchor ? { heading: BLOCK_LABELS[anchor] ?? line.trim(), text: "", anchor } : { heading: title, text: "" };
      }
      buf += withNl;
    }
    flush();
  }

  // 4. Targets, statuses, checks.
  const sections: CallFlowImportSection[] = [];
  const next: CallFlowDefinition = structuredClone(definition);
  const nextBlocks = new Map(next.blocks.filter((b): b is CallFlowTextBlock => !isLockedBlock(b)).map((b) => [b.id, b]));
  const firstEditable = editable.find((b) => b.id === "persona") ?? editable[0];

  raw.forEach((r, index) => {
    const base: CallFlowImportSection = {
      index,
      heading: r.heading,
      chars: r.locked ? r.locked.chars : r.text.length,
      target: null,
      confidence: 0,
      manual: false,
      status: "unmatched",
      issues: [],
      warnings: [],
      stripped: [],
      diff: null,
    };
    if (r.locked) {
      sections.push({ ...base, status: "locked", issues: ["Locked: always comes from the system, never written."] });
      return;
    }
    if (lockedTitles.includes(norm(r.heading))) {
      sections.push({ ...base, status: "locked", issues: ["Locked block: edited text is ignored."] });
      return;
    }
    if (r.anchor) Object.assign(base, { target: r.anchor, confidence: 1 });
    else if (r.leading && firstEditable) Object.assign(base, { target: firstEditable.id, confidence: 1 });
    else {
      const top = best(r.heading, editable);
      if (top && top.score >= IMPORT_MATCH_THRESHOLD) Object.assign(base, { target: top.id, confidence: Math.round(top.score * 100) / 100 });
    }
    const override = input.mapping?.[String(index)];
    if (override === "skip") Object.assign(base, { target: null, manual: true, status: "skipped" });
    else if (override && byId.has(override)) Object.assign(base, { target: override, confidence: 1, manual: true });
    else if (override) base.issues.push(`Unknown block "${override}"`);
    sections.push(base);
  });

  // One section per block: a duplicate keeps the stronger (or the chosen) match.
  const owner = new Map<string, CallFlowImportSection>();
  for (const s of sections) {
    if (!s.target || s.status === "skipped") continue;
    const prev = owner.get(s.target);
    if (!prev) {
      owner.set(s.target, s);
      continue;
    }
    const keepNew = (s.manual && !prev.manual) || (s.manual === prev.manual && s.confidence > prev.confidence);
    const loser = keepNew ? prev : s;
    if (keepNew) owner.set(s.target, s);
    if (loser.manual && (keepNew ? s : prev).manual) {
      loser.status = "invalid";
      loser.issues.push(`Two sections are mapped to "${blockLabel(byId.get(s.target)!)}". Choose a different block or Skip.`);
    } else {
      loser.issues.push(`"${blockLabel(byId.get(s.target)!)}" is already matched by section ${(keepNew ? s : prev).index + 1}.`);
      loser.target = null;
      loser.confidence = 0;
    }
  }

  const blocking: string[] = [];
  const changedBlocks: string[] = [];
  for (const s of sections) {
    if (s.status === "locked" || s.status === "skipped" || s.status === "invalid") continue;
    if (!s.target) {
      s.status = "unmatched";
      continue;
    }
    const block = byId.get(s.target)!;
    const r = raw[s.index]!;
    let text = r.text;
    if (input.stripSpokenMarkdown) {
      const res = stripSpokenLines(text);
      text = res.text;
      s.stripped = res.stripped;
    }
    if (text.trim() === block.text.trim()) {
      s.status = "unchanged";
      continue;
    }
    // Keep the block's own trailing separator when the paste lost trailing whitespace.
    if (!/\s$/.test(text) && /\n---\n\n$/.test(block.text) && !/---\s*$/.test(text)) text = text.replace(/\s*$/, "") + "\n\n---\n\n";
    s.diff = lineDiff(block.text, text);
    s.chars = text.length;
    const unknown = unknownCallFlowVariables(text);
    const before = varCounts(block.text);
    const after = varCounts(text);
    const lost = [...before].filter(([v, n]) => (after.get(v) ?? 0) < n).map(([v]) => `{{${v}}}`);
    if (unknown.length) {
      s.status = "unknown_variable";
      s.issues.push(`Unknown variable(s): ${unknown.map((u) => `{{${u}}}`).join(", ")}`);
    } else if (text.length > CALL_FLOW_MAX_BLOCK_CHARS) {
      s.status = "too_long";
      s.issues.push(`${text.length.toLocaleString()} characters; a block can have at most ${CALL_FLOW_MAX_BLOCK_CHARS.toLocaleString()}.`);
    } else if (lost.length) {
      s.status = "rendered_value";
      s.issues.push(
        `${lost.join(", ")} appears less often than in the current block. The paste may contain a sample value (a name, "sir") in its place: put the variable back.`,
      );
    } else if (CONTROL_RE.test(text) || text.includes("[[END_CALL]]")) {
      s.status = "invalid";
      s.issues.push("Contains control characters or the [[END_CALL]] marker.");
    } else if (s.target === "outcome_rules" && missingOutcomeKeys(text).length) {
      s.status = "invalid";
      s.issues.push(`Outcome classification would break. Missing outcome key(s): ${missingOutcomeKeys(text).join(", ")}`);
    } else {
      s.status = "matched";
      nextBlocks.get(s.target)!.text = text;
      changedBlocks.push(s.target);
      if (s.target === "do_not_call" && lacksDoNotCallHandling(text)) {
        s.warnings.push("This do-not-call block no longer says to end the call when the customer asks not to be called.");
      }
      const lockedLines = new Set(
        lockedBlocks.flatMap((b) => (lockedText[b.locked] ?? "").split("\n").map((l) => l.trim()).filter((l) => l.length > 12)),
      );
      const own = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 12);
      if (own.length >= 4 && own.filter((l) => lockedLines.has(l)).length / own.length >= 0.5) {
        s.warnings.push("Looks like the text of a locked block, which the system adds anyway.");
      }
    }
    if (["unknown_variable", "too_long", "rendered_value", "invalid"].includes(s.status)) {
      blocking.push(`Section ${s.index + 1} (${s.heading}): ${s.issues.join(" ")}`);
    }
  }
  for (const s of sections) if (s.status === "invalid" && !blocking.some((b) => b.startsWith(`Section ${s.index + 1} `))) {
    blocking.push(`Section ${s.index + 1} (${s.heading}): ${s.issues.join(" ")}`);
  }

  if (tail) {
    sections.push({
      index: sections.length,
      heading: "System rules and customer data (added by the voice backend)",
      chars: tail.length,
      target: null,
      confidence: 0,
      manual: false,
      status: "locked",
      issues: ["The system adds this after every prompt. It is never written, and its text is not shown here."],
      warnings: [],
      stripped: [],
      diff: null,
    });
  }

  const sizeBefore = renderedSize(definition, lockedText);
  const sizeAfter = renderedSize(next, lockedText);
  if (sizeAfter > CALL_FLOW_MAX_PROMPT_CHARS) {
    blocking.push(`The prompt would be ${sizeAfter.toLocaleString()} characters; the limit is ${CALL_FLOW_MAX_PROMPT_CHARS.toLocaleString()}.`);
  }
  if (changedBlocks.length) {
    const check = callFlowDefinition.safeParse(next);
    if (!check.success) for (const i of check.error.issues) blocking.push(i.message);
  }
  const dnc = nextBlocks.get("do_not_call");
  const count = (st: CallFlowImportSection["status"]) => sections.filter((s) => s.status === st).length;

  return {
    preview: {
      sections,
      targets: editable.map((b) => ({ id: b.id, label: blockLabel(b) })),
      sizeBefore,
      sizeAfter,
      warnAboveChars,
      maxChars: CALL_FLOW_MAX_PROMPT_CHARS,
      summary: {
        updated: count("matched"),
        unchanged: count("unchanged"),
        skipped: count("skipped"),
        unmatched: count("unmatched"),
        locked: count("locked"),
      },
      blocking,
      dncWarning: changedBlocks.includes("do_not_call") && !!dnc && lacksDoNotCallHandling(dnc.text),
      changed: changedBlocks.length > 0,
      changedBlocks,
    },
    next,
  };
}

