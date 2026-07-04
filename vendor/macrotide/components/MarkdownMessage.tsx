"use client";

import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// Renders an Advisor (assistant) reply as sanitized Markdown. The model returns
// Markdown — bold, lists, headings, tables, code — and this turns the raw markup
// into styled elements. Used for AI bubbles only; user bubbles stay plain text.
//
// Security: react-markdown does NOT pass raw HTML through by default (no
// rehype-raw is added, no dangerouslySetInnerHTML), so embedded `<script>` /
// `<img onerror=…>` etc. render as inert text. Its built-in `urlTransform` also
// strips dangerous link protocols (javascript:, data:, vbscript:). remark-gfm
// adds GitHub-flavored tables / strikethrough / task lists / autolinks. All
// typography is scoped to the `.md` class in globals.css against the design
// tokens — see the in-chat proposal cards + holdings table for the shared look.

// Open links in a new tab without leaking the opener (and without window.opener
// rewrite attacks). External targets only — the Advisor never links in-app.
const components: Components = {
  a({ children, href, ...props }) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer nofollow" {...props}>
        {children}
      </a>
    );
  },
};

const remarkPlugins = [remarkGfm];

function MarkdownMessageImpl({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

// Memoize on `text` so unrelated parent re-renders don't re-parse. During
// streaming the text changes every delta, so it re-parses then — fine for the
// short replies the Advisor produces (re-parsing per delta is cheap here).
export const MarkdownMessage = memo(MarkdownMessageImpl);
