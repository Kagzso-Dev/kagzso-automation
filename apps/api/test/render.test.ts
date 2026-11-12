import { describe, expect, it } from "vitest";
import { render, RenderError, substitute } from "../src/render/render.js";

describe("substitute", () => {
  it("replaces known variables", () => {
    expect(
      substitute("Hi {{name}}", { name: "Ada" }, { htmlContext: false, declared: [] }),
    ).toBe("Hi Ada");
  });

  it("html-escapes in html context", () => {
    expect(
      substitute("{{x}}", { x: "<script>" }, { htmlContext: true, declared: [] }),
    ).toBe("&lt;script&gt;");
  });

  it("does not escape in text context", () => {
    expect(substitute("{{x}}", { x: "a & b" }, { htmlContext: false, declared: [] })).toBe("a & b");
  });

  it("throws for a missing declared variable", () => {
    expect(() =>
      substitute("{{first_name}}", {}, { htmlContext: false, declared: ["first_name"] }),
    ).toThrow(RenderError);
  });

  it("blanks an undeclared missing variable", () => {
    expect(substitute("x{{y}}z", {}, { htmlContext: false, declared: [] })).toBe("xz");
  });
});

describe("render", () => {
  const base = {
    subject: "Hello {{first_name}}",
    htmlBody: '<p>Hi {{first_name}}</p><a href="https://example.com/a">link</a>',
    declaredVariables: ["first_name"],
    vars: { first_name: "Ada" },
  };

  it("strips script tags via sanitiser", () => {
    const out = render({
      ...base,
      htmlBody: '<p>ok</p><script>alert(1)</script>',
    });
    expect(out.html).not.toContain("<script>");
  });

  it("rewrites links and injects a pixel only for real sends", () => {
    const preview = render(base);
    expect(preview.html).toContain("https://example.com/a");
    expect(preview.html).not.toContain("/api/track/open/");

    const real = render({ ...base, emailLogId: "log_1" });
    expect(real.html).toContain("/api/track/click/log_1");
    expect(real.html).toContain("/api/track/open/log_1.png");
  });

  it("skips link rewriting and the pixel when tracking is disabled", () => {
    const out = render({ ...base, emailLogId: "log_1", tracking: false });
    expect(out.html).toContain("https://example.com/a");
    expect(out.html).not.toContain("/api/track/click/");
    expect(out.html).not.toContain("/api/track/open/");
  });

  it("appends an unsubscribe footer when a url is supplied", () => {
    const out = render({ ...base, unsubscribeUrl: "https://x/u/abc" });
    expect(out.html).toContain("https://x/u/abc");
    expect(out.text).toContain("Unsubscribe: https://x/u/abc");
  });

  it("omits the compliance footer when includeComplianceFooter is false", () => {
    const out = render({
      ...base,
      unsubscribeUrl: "https://x/u/abc",
      includeComplianceFooter: false,
    });
    expect(out.html).not.toContain("https://x/u/abc");
    expect(out.html).not.toContain("Unsubscribe");
    expect(out.text).not.toContain("Unsubscribe");
  });

  it("renders the link panel with variable-substituted URLs", () => {
    const out = render({
      ...base,
      declaredVariables: ["first_name", "portal"],
      vars: { first_name: "Ada", portal: "https://portal.example.com/ada" },
      links: [{ label: "Open your portal", url: "{{portal}}" }],
    });
    expect(out.html).toContain('href="https://portal.example.com/ada"');
    expect(out.html).toContain("Open your portal");
    expect(out.text).toContain("Open your portal: https://portal.example.com/ada");
  });

  it("renders a meeting card and an invite.ics attachment for MEETING templates", () => {
    const out = render({
      ...base,
      kind: "MEETING",
      meeting: {
        title: "Kickoff call",
        startAt: "2026-09-15T14:00:00Z",
        joinUrl: "https://meet.example.com/xyz",
      },
    });
    expect(out.html).toContain("Kickoff call");
    expect(out.html).toContain("calendar.google.com/calendar/render");
    expect(out.html).toContain("Join the meeting");
    const ics = out.attachments?.find((a) => a.filename === "invite.ics");
    expect(ics).toBeTruthy();
    expect(ics!.content).toContain("BEGIN:VEVENT");
    expect(ics!.content).toContain("DTSTART:20260915T140000Z");
    expect(ics!.content).toContain("SUMMARY:Kickoff call");
  });

  it("substitutes variables in meeting fields, resolved per recipient", () => {
    const out = render({
      ...base,
      kind: "MEETING",
      declaredVariables: ["first_name", "slot"],
      vars: { first_name: "Ada", slot: "2026-10-01T09:30:00Z" },
      meeting: { title: "1:1 with {{first_name}}", startAt: "{{slot}}" },
    });
    expect(out.html).toContain("1:1 with Ada");
    const ics = out.attachments?.find((a) => a.filename === "invite.ics");
    expect(ics!.content).toContain("DTSTART:20261001T093000Z");
  });

  it("embeds the image after the body by default", () => {
    const out = render({ ...base, imageUrl: "https://cdn.example.com/hero.jpg" });
    expect(out.html).toContain('<img src="https://cdn.example.com/hero.jpg"');
    // after the body paragraph
    expect(out.html.indexOf("Hi Ada")).toBeLessThan(out.html.indexOf("hero.jpg"));
    expect(out.text).toContain("Image: https://cdn.example.com/hero.jpg");
  });

  it("orders an email as content, URL, video, image", () => {
    const out = render({
      ...base,
      links: [{ label: "Visit site", url: "https://example.com/site" }],
      videoUrl: "https://youtu.be/abc123",
      imageUrl: "https://cdn.example.com/hero.jpg",
    });
    const at = (s: string) => out.html.indexOf(s);
    expect(at("Hi Ada")).toBeLessThan(at("Visit site"));
    expect(at("Visit site")).toBeLessThan(at("Watch video"));
    expect(at("Watch video")).toBeLessThan(at("hero.jpg"));
    const t = (s: string) => out.text.indexOf(s);
    expect(t("Hi Ada")).toBeLessThan(t("Visit site:"));
    expect(t("Visit site:")).toBeLessThan(t("Watch video:"));
    expect(t("Watch video:")).toBeLessThan(t("Image:"));
  });

  it("places the image at a {{image}} placeholder when the body has one", () => {
    const out = render({
      ...base,
      htmlBody: "<p>intro</p><p>{{image}}</p><p>outro</p>",
      imageUrl: "https://cdn.example.com/mid.png",
    });
    expect(out.html.indexOf("intro")).toBeLessThan(out.html.indexOf("mid.png"));
    expect(out.html.indexOf("mid.png")).toBeLessThan(out.html.indexOf("outro"));
    // not also prepended
    expect(out.html.match(/mid\.png/g)).toHaveLength(1);
  });

  it("drops a {{image}} placeholder when no image URL is set", () => {
    const out = render({ ...base, htmlBody: "<p>a{{image}}b</p>" });
    expect(out.html).toContain("ab");
    expect(out.html).not.toContain("{{image}}");
  });

  it("renders the video link as a button after the body by default", () => {
    const out = render({ ...base, videoUrl: "https://youtu.be/abc123" });
    expect(out.html).toContain('href="https://youtu.be/abc123"');
    expect(out.html).toContain("Watch video");
    expect(out.html.indexOf("Hi Ada")).toBeLessThan(out.html.indexOf("Watch video"));
    expect(out.text).toContain("Watch video: https://youtu.be/abc123");
  });

  it("places the video button at a {{video_link}} placeholder when present", () => {
    const out = render({
      ...base,
      htmlBody: "<p>watch this: {{video_link}}</p><p>thanks</p>",
      videoUrl: "https://vimeo.com/999",
    });
    expect(out.html.indexOf("watch this")).toBeLessThan(out.html.indexOf("Watch video"));
    expect(out.html.indexOf("Watch video")).toBeLessThan(out.html.indexOf("thanks"));
  });

  it("ignores an image/video URL with a disallowed scheme", () => {
    const out = render({
      ...base,
      imageUrl: "javascript:alert(1)",
      videoUrl: "javascript:alert(2)",
    });
    expect(out.html).not.toContain("javascript:");
    expect(out.html).not.toContain("<img");
    expect(out.html).not.toContain("Watch video");
  });

  it("stacks multiple images after the body in order", () => {
    const out = render({
      ...base,
      images: ["https://cdn.example.com/a.jpg", "https://cdn.example.com/b.jpg"],
    });
    expect(out.html.indexOf("Hi Ada")).toBeLessThan(out.html.indexOf("a.jpg"));
    expect(out.html.indexOf("a.jpg")).toBeLessThan(out.html.indexOf("b.jpg"));
    expect(out.text).toContain("Image: https://cdn.example.com/a.jpg");
    expect(out.text).toContain("Image: https://cdn.example.com/b.jpg");
  });

  it("routes extra images/videos to their numbered placeholders", () => {
    const out = render({
      ...base,
      htmlBody: "<p>{{image_2}}</p><p>body</p><p>{{video_link_2}}</p>",
      imageUrl: "https://cdn.example.com/first.jpg",
      images: ["https://cdn.example.com/second.jpg"],
      videoUrl: "https://youtu.be/one",
      videos: [{ url: "https://youtu.be/two", label: "Watch part two" }],
    });
    // second lands at {{image_2}}; first has no placeholder -> after the videos
    expect(out.html.indexOf("second.jpg")).toBeLessThan(out.html.indexOf("body"));
    expect(out.html.lastIndexOf("Watch video")).toBeLessThan(out.html.indexOf("first.jpg"));
    expect(out.html).toContain("Watch part two");
    expect(out.html.indexOf("body")).toBeLessThan(out.html.indexOf("Watch part two"));
    // first video (no placeholder) trails the body
    expect(out.html.indexOf("Watch part two")).toBeLessThan(out.html.lastIndexOf("Watch video"));
    expect(out.html.match(/second\.jpg/g)).toHaveLength(1);
  });

  it("uses a custom label for a video button", () => {
    const out = render({ ...base, videos: [{ url: "https://vimeo.com/7", label: "See the demo" }] });
    expect(out.html).toContain("See the demo");
    expect(out.text).toContain("See the demo: https://vimeo.com/7");
  });

  it("leaves the body untouched when no image or video is set", () => {
    const out = render(base);
    expect(out.html).not.toContain("<img");
    expect(out.html).not.toContain("Watch video");
  });

  it("skips the meeting card for LETTER templates even if meeting data is present", () => {
    const out = render({ ...base, kind: "LETTER", meeting: { title: "Hidden", startAt: "2026-09-15T14:00:00Z" } });
    expect(out.html).not.toContain("Hidden");
    expect(out.attachments).toBeUndefined();
  });

  it("renders the meeting card without an attachment when the start time can't be parsed", () => {
    const out = render({
      ...base,
      kind: "MEETING",
      meeting: { title: "TBD sync", startAt: "next tuesday" },
    });
    expect(out.html).toContain("TBD sync");
    expect(out.attachments).toBeUndefined();
  });
});
