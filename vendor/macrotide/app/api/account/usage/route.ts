import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { withDb } from "@/lib/api/with-db";
import { getDb, getUserId } from "@/lib/db/context";
import { usage } from "@/lib/db/schema";

/**
 * GET /api/account/usage
 * Returns the current user's input + output token counts for today (UTC date).
 * Returns zeros when there is no session or no usage row for today yet.
 */
export async function GET() {
  return withDb(() => {
    const userId = getUserId();
    if (!userId) {
      return NextResponse.json({ inputTokens: 0, outputTokens: 0 });
    }
    // Stable UTC date string matching the column format in the usage table.
    const today = new Date().toISOString().split("T")[0]; // 'YYYY-MM-DD'
    const row = getDb()
      .select({
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      })
      .from(usage)
      .where(and(eq(usage.userId, userId), eq(usage.date, today)))
      .get();
    return NextResponse.json({
      inputTokens: row?.inputTokens ?? 0,
      outputTokens: row?.outputTokens ?? 0,
    });
  });
}
