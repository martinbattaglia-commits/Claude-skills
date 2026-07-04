import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownMessage } from "@/components/MarkdownMessage";

// Renders the actual Advisor markdown bubble to static HTML (no jsdom needed —
// react-dom/server runs in the node test env) and asserts the contract the chat
// depends on: real Markdown becomes styled elements, and untrusted model output
// can't inject active content. If someone later adds rehype-raw or otherwise
// loosens sanitization, these break.
const html = (text: string) => renderToStaticMarkup(createElement(MarkdownMessage, { text }));

describe("MarkdownMessage rendering", () => {
  it("renders bold, inline code, and lists", () => {
    const out = html("**bold** and `code`\n\n- one\n- two");
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<code>code</code>");
    expect(out).toContain("<ul>");
    expect(out).toContain("<li>one</li>");
  });

  it("renders GFM tables (remark-gfm)", () => {
    const out = html("| Fund | % |\n|---|---|\n| EXAMPLE-FUND-A | 60 |");
    expect(out).toContain("<table>");
    expect(out).toContain("<th>Fund</th>");
    expect(out).toContain("<td>EXAMPLE-FUND-A</td>");
  });

  it("wraps content in the .md scope class", () => {
    expect(html("hello")).toContain('class="md"');
  });
});

describe("MarkdownMessage sanitization", () => {
  it("escapes raw HTML instead of passing it through", () => {
    const out = html("<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>");
    // No live elements — the markup survives only as escaped, inert text.
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("&lt;img");
  });

  it("strips dangerous link protocols", () => {
    const out = html("[click](javascript:alert(1))");
    // react-markdown's urlTransform blanks unsafe hrefs.
    expect(out).not.toContain("javascript:");
    expect(out).toContain('href=""');
  });

  it("keeps safe links and opens them in a new tab without leaking the opener", () => {
    const out = html("[docs](https://example.com)");
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain("noopener");
    expect(out).toContain("noreferrer");
  });
});
