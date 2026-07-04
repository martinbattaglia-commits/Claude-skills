import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { isDemoVisionEnabled } from "@/lib/advisor/image-turn";
import { resolveVisionProvider } from "@/lib/ai/provider";
import { DEMO_COOKIE } from "@/lib/api/with-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Surfaces whether the chat composer should offer image upload for THIS session.
// The chat route is the source of truth (it stubs unavailable image turns); this
// is purely so the UI can hide the attach button when vision is off or — in a
// demo session — when DEMO_VISION isn't enabled. Computed server-side because
// the relevant config (VISION_CHAT_MODELS, DEMO_VISION, the demo cookie) isn't
// visible to the client.
export async function GET() {
  const store = await cookies();
  const isDemo = !!store.get(DEMO_COOKIE)?.value;
  const visionReady = resolveVisionProvider({ demo: isDemo }).ready;
  const imageUpload = visionReady && (!isDemo || isDemoVisionEnabled());
  return NextResponse.json({ imageUpload });
}
