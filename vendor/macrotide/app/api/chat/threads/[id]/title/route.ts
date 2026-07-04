import { generateText } from "ai";
import { NextResponse } from "next/server";
import { resolveTitleProvider } from "@/lib/ai/provider";
import { withDb } from "@/lib/api/with-db";
import { getThread, listMessages, renameThread } from "@/lib/db/queries/chat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SYSTEM_PROMPT = `You title chat conversations.

Given the user's opening question and the assistant's reply, return a 3-5 word title that captures the topic. Plain English. No quotes, no trailing punctuation, no emojis, no leading articles ("The", "A", "An"). Return ONLY the title text — no preamble, no explanation.`;

const MAX_TITLE_CHARS = 80;

function cleanTitle(raw: string): string {
  return raw
    .trim()
    .replace(/^["'`“”‘’]+|["'`“”‘’.!?\s]+$/g, "")
    .replace(/\s+/g, " ")
    .slice(0, MAX_TITLE_CHARS)
    .trim();
}

/**
 * Auto-title a chat after its first turn pair. Idempotent: if the thread
 * already has a non-empty title, returns it unchanged. Falls back to the
 * first ~60 chars of the user message when AI is unavailable so the row
 * never stays "Untitled chat" indefinitely.
 *
 * No request body — the server reads the first user + assistant messages
 * itself. That keeps the trigger contract simple (the client just POSTs
 * after the response completes) and avoids re-sending message text the
 * server already has.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return await withDb(async () => {
    const thread = getThread(id);
    if (!thread) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (thread.title?.trim()) {
      // Idempotent — don't re-title an already-titled chat.
      return NextResponse.json({ title: thread.title, regenerated: false });
    }

    const messages = listMessages(id);
    const firstUser = messages.find((m) => m.role === "user");
    const firstAssistant = messages.find((m) => m.role === "assistant");
    if (!firstUser) {
      return NextResponse.json({ error: "no_user_message" }, { status: 409 });
    }

    // Heuristic fallback when AI is unavailable or returns nothing usable.
    const fallback =
      cleanTitle(firstUser.content).slice(0, 60) || `Chat ${thread.createdAt.slice(0, 10)}`;

    let title = fallback;
    const provider = resolveTitleProvider();
    if (provider.ready && provider.model && firstAssistant) {
      const userContent = `User asked: ${firstUser.content.slice(0, 800)}\n\nAdvisor replied: ${firstAssistant.content.slice(0, 800)}\n\nTitle:`;
      // Two attempts: a title runs on every first turn and the cost is ~zero
      // (free tier), so a light retry re-rolls a transient error or an empty/garbage
      // title — bumping temperature so the retry differs even on a pinned model.
      // A miss is only cosmetic, so we keep the heuristic fallback and never block.
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const result = await generateText({
            model: provider.model,
            temperature: attempt === 1 ? 0.2 : 0.5,
            maxOutputTokens: 32,
            system: SYSTEM_PROMPT,
            messages: [{ role: "user", content: userContent }],
          });
          const cleaned = cleanTitle(result.text ?? "");
          if (cleaned) {
            title = cleaned;
            break; // usable title — done
          }
          // empty/garbage — retry once, then keep the heuristic fallback.
        } catch {
          // AI failed — retry, then keep the heuristic fallback. The chat doesn't
          // need a perfect title to function, and the user can always rename it.
        }
      }
    }

    const row = renameThread(id, title);
    return NextResponse.json({
      title: row?.title ?? title,
      regenerated: true,
      provider: provider.label,
    });
  });
}
