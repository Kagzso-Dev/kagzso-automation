import type { TemplateKind, TemplateLink, TemplateMeeting } from "@dispatch/shared";
import { env } from "../env.js";
import { sanitizeEmailHtml } from "./sanitize.js";
import { sign } from "./signing.js";
import {
  buildIcs,
  escapeHtml,
  meetingUid,
  renderImageHtml,
  renderImageText,
  renderLinkPanelHtml,
  renderLinkPanelText,
  renderMeetingHtml,
  renderMeetingText,
  renderVideoButtonHtml,
  renderVideoText,
  toStamps,
} from "./meeting.js";

/** Permanent failure — a job that hits this must not be retried. */
export class RenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenderError";
  }
}

export type RenderVars = Record<string, string | number | boolean | null | undefined>;

const VAR_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

/**
 * Turns a plain-letter message into simple email HTML: blank lines become
 * paragraphs, single newlines become <br>. `{{variables}}` pass through
 * untouched for the renderer to substitute later. An optional signature is
 * appended as its own block.
 */
export function letterToHtml(bodyText: string, signature?: string | null): string {
  const toParas = (text: string) =>
    text
      .replace(/\r\n/g, "\n")
      .trim()
      .split(/\n{2,}/)
      .map((para) => `<p>${escapeHtml(para).replace(/\n/g, "<br>\n")}</p>`)
      .join("\n");

  let html = toParas(bodyText);
  if (signature && signature.trim()) {
    html += `\n<div style="margin-top:24px">${toParas(signature)}</div>`;
  }
  return html;
}

/**
 * Logic-less {{variable}} substitution. No partials, no helpers, nothing
 * executable. `htmlContext` decides whether values are HTML-escaped.
 */
export function substitute(
  template: string,
  vars: RenderVars,
  opts: { htmlContext: boolean; declared: string[] },
): string {
  const declaredSet = new Set(opts.declared);
  return template.replace(VAR_RE, (_match, name: string) => {
    const has = Object.prototype.hasOwnProperty.call(vars, name);
    if (!has) {
      if (declaredSet.has(name)) {
        throw new RenderError(`Missing value for declared variable "${name}"`);
      }
      return "";
    }
    const raw = vars[name];
    const str = raw == null ? "" : String(raw);
    return opts.htmlContext ? escapeHtml(str) : str;
  });
}

export interface RenderInput {
  subject: string;
  htmlBody: string;
  textBody?: string | null;
  declaredVariables: string[];
  vars: RenderVars;
  /** Present for real sends; absent for previews. Enables link/open tracking. */
  emailLogId?: string;
  unsubscribeUrl?: string;
  /** "MEETING" appends the meeting card and an invite.ics attachment. */
  kind?: TemplateKind;
  /** Call-to-action links; rendered as a button panel after the body. */
  links?: TemplateLink[] | null;
  /** Meeting details; rendered as a card when `kind` is "MEETING". */
  meeting?: TemplateMeeting | null;
  /**
   * Optional image URL embedded in the body. Rendered at a `{{image}}`
   * placeholder if the message contains one, otherwise after the video buttons.
   * Legacy single field — merged ahead of `images`.
   */
  imageUrl?: string | null;
  /**
   * Optional video link, rendered as a "▶ Watch video" button. Placed at a
   * `{{video_link}}` placeholder if present, otherwise after the URL buttons.
   * Legacy single field — merged ahead of `videos`.
   */
  videoUrl?: string | null;
  /**
   * Additional embedded images. Each is placed at its own placeholder —
   * `{{image}}` for the first, `{{image_2}}`, `{{image_3}}` … for the rest —
   * or stacked after the video buttons when no placeholder is present.
   */
  images?: string[] | null;
  /**
   * Additional "▶ Watch video" buttons. Placeholders `{{video_link}}`,
   * `{{video_link_2}}` … mirror the images; unplaced buttons follow the URL buttons.
   */
  videos?: Array<{ url: string; label?: string }> | null;
  /**
   * Append the CAN-SPAM footer (physical address + Unsubscribe link) and the
   * text-part unsubscribe block. Required for bulk marketing; omitted for
   * transactional / personal sends (manual, trigger) so they read as 1:1 mail.
   * Defaults to true.
   */
  includeComplianceFooter?: boolean;
  /**
   * Rewrite links through the click tracker and inject the open pixel.
   * Defaults to `env.EMAIL_TRACKING`. Set false for clean, untracked mail
   * (better inbox placement, no open/click stats).
   */
  tracking?: boolean;
}

export interface EmailAttachment {
  filename: string;
  content: string;
  contentType: string;
  /** Base64-encode `content` (used for binary attachments like inlined images). */
  encoding?: "base64";
  /** Content-ID for an inline attachment referenced as `<img src="cid:...">`. */
  cid?: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  attachments?: EmailAttachment[];
}

function rewriteLinks(html: string, emailLogId: string): string {
  return html.replace(/(<a\b[^>]*\bhref=")([^"]+)(")/gi, (full, pre: string, url: string, post) => {
    if (!/^https?:\/\//i.test(url)) return full; // leave mailto:, anchors, unsubscribe as-is
    const signed = sign(url);
    const tracked = `${env.PUBLIC_API_URL}/api/track/click/${emailLogId}?u=${encodeURIComponent(
      url,
    )}&s=${signed}`;
    return `${pre}${tracked}${post}`;
  });
}

function injectPixel(html: string, emailLogId: string): string {
  const pixel = `<img src="${env.PUBLIC_API_URL}/api/track/open/${emailLogId}.png" width="1" height="1" alt="" style="display:none" />`;
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${pixel}</body>`) : html + pixel;
}

function footer(unsubscribeUrl?: string): string {
  const addr = escapeHtml(env.EMAIL_SENDER_ADDRESS);
  const unsub = unsubscribeUrl
    ? ` &middot; <a href="${unsubscribeUrl}">Unsubscribe</a>`
    : "";
  return `<div style="margin-top:32px;font-size:12px;color:#8a92a0">${addr}${unsub}</div>`;
}

export function render(input: RenderInput): RenderedEmail {
  const allVars: RenderVars = {
    ...input.vars,
    unsubscribe_url: input.unsubscribeUrl ?? input.vars.unsubscribe_url ?? "",
    sender_address: env.EMAIL_SENDER_ADDRESS,
  };
  const declared = input.declaredVariables;

  const subject = substitute(input.subject, allVars, { htmlContext: false, declared });

  const withFooter = input.includeComplianceFooter ?? true;

  // Resolve {{variables}} inside the link panel / meeting fields. These are
  // composed at render time (not baked into htmlBody on save) so per-recipient
  // values — a meeting time from a trigger payload, say — take effect.
  const sub = (s: string | null | undefined): string | undefined =>
    s == null ? undefined : substitute(s, allVars, { htmlContext: false, declared });

  const links: TemplateLink[] = (input.links ?? [])
    .map((l) => ({ label: sub(l.label) ?? "", url: sub(l.url) ?? "" }))
    .filter((l) => l.label && l.url);

  const rawMeeting = input.kind === "MEETING" ? input.meeting : null;
  const meeting: TemplateMeeting | null = rawMeeting
    ? {
        title: sub(rawMeeting.title),
        location: sub(rawMeeting.location),
        joinUrl: sub(rawMeeting.joinUrl),
        startAt: sub(rawMeeting.startAt),
        endAt: sub(rawMeeting.endAt),
        timezone: rawMeeting.timezone,
        description: sub(rawMeeting.description),
      }
    : null;
  const hasMeeting = !!meeting && Object.values(meeting).some((v) => v && String(v).trim());

  // Optional images / videos. URLs may hold {{variables}}, resolved like the
  // panels. Legacy single fields (imageUrl / videoUrl) merge ahead of the arrays.
  // Rendered blocks are spliced in after sanitisation (same as the link/meeting
  // panels): each gets an indexed placeholder — {{image}} / {{image_2}} … and
  // {{video_link}} / {{video_link_2}} … — otherwise they follow the content and
  // the URL buttons: videos first, then images, both in order.
  const imageUrls = [...(input.imageUrl ? [input.imageUrl] : []), ...(input.images ?? [])]
    .map((u) => sub(u)?.trim() ?? "")
    .filter(Boolean);
  const videos = [
    ...(input.videoUrl ? [{ url: input.videoUrl }] : []),
    ...(input.videos ?? []),
  ]
    .map((v) => ({ url: sub(v.url)?.trim() ?? "", label: sub(v.label)?.trim() || undefined }))
    .filter((v) => v.url);

  const imageBlocks = imageUrls.map((u) => renderImageHtml(u));
  const videoBlocks = videos.map((v) => renderVideoButtonHtml(v.url, v.label));

  const slot = (kind: "IMG" | "VID", i: number) => `@@DISPATCH_${kind}_SLOT_${i}@@`;
  const stripSlots = (s: string) => {
    let out = s;
    imageBlocks.forEach((_, i) => (out = out.split(slot("IMG", i)).join("")));
    videoBlocks.forEach((_, i) => (out = out.split(slot("VID", i)).join("")));
    return out;
  };
  const varKey = (base: string, i: number) => (i === 0 ? base : `${base}_${i + 1}`);

  // A placeholder present but no matching URL → resolves to "" (slot disappears).
  allVars.image = "";
  allVars.video_link = "";
  imageBlocks.forEach((b, i) => (allVars[varKey("image", i)] = b ? slot("IMG", i) : ""));
  videoBlocks.forEach((b, i) => (allVars[varKey("video_link", i)] = b ? slot("VID", i) : ""));

  let bodyHtml = substitute(input.htmlBody, allVars, { htmlContext: true, declared });
  bodyHtml = sanitizeEmailHtml(bodyHtml);

  const imgInBody = imageBlocks.map((_, i) => bodyHtml.includes(slot("IMG", i)));
  const vidInBody = videoBlocks.map((_, i) => bodyHtml.includes(slot("VID", i)));
  const bodyForText = stripSlots(bodyHtml);
  imageBlocks.forEach((b, i) => (bodyHtml = bodyHtml.split(slot("IMG", i)).join(b)));
  videoBlocks.forEach((b, i) => (bodyHtml = bodyHtml.split(slot("VID", i)).join(b)));

  // Email layout: content → URL buttons → video buttons → images. Items placed
  // via a {{image}} / {{video_link}} placeholder stay where the body puts them.
  let html = bodyHtml;
  html += renderLinkPanelHtml(links);
  const trailingVideos = videoBlocks.filter((b, i) => b && !vidInBody[i]).join("\n");
  const trailingImages = imageBlocks.filter((b, i) => b && !imgInBody[i]).join("\n");
  if (trailingVideos) html += "\n" + trailingVideos;
  if (trailingImages) html += "\n" + trailingImages;
  if (hasMeeting) html += "\n" + renderMeetingHtml(meeting!);
  if (withFooter) html += footer(input.unsubscribeUrl);

  if (input.emailLogId && (input.tracking ?? env.EMAIL_TRACKING)) {
    html = rewriteLinks(html, input.emailLogId);
    html = injectPixel(html, input.emailLogId);
  }

  const textSource = stripSlots(
    // A {{image}} / {{video_link}} placeholder in the plain-text part has no
    // visual form — drop the internal marker, the URL is appended below.
    input.textBody && input.textBody.trim().length > 0
      ? substitute(input.textBody, allVars, { htmlContext: false, declared })
      : htmlToText(bodyForText),
  );
  const text =
    textSource +
    renderLinkPanelText(links) +
    videos.map((v) => renderVideoText(v.url, v.label)).join("") +
    imageUrls.map((u) => renderImageText(u)).join("") +
    (hasMeeting ? "\n" + renderMeetingText(meeting!) : "") +
    (withFooter && input.unsubscribeUrl
      ? `\n\n---\n${env.EMAIL_SENDER_ADDRESS}\nUnsubscribe: ${input.unsubscribeUrl}`
      : "");

  let attachments: EmailAttachment[] | undefined;
  if (hasMeeting) {
    const stamps = toStamps(meeting!);
    if (stamps) {
      attachments = [
        {
          filename: "invite.ics",
          content: buildIcs(meeting!, stamps, meetingUid(input.emailLogId ?? "preview")),
          contentType: 'text/calendar; charset="utf-8"; method=PUBLISH',
        },
      ];
    }
  }

  return { subject, html, text, attachments };
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
