/**
 * One small door to the Claude API, for the few things the realm writes in prose (the chronicle,
 * townsfolk letters). Returns null on any trouble so callers can fall back to templates.
 */
export async function write(opts: { system: string; content: string; maxTokens?: number; model?: string }): Promise<string | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: opts.model ?? "claude-sonnet-5-5",
        max_tokens: opts.maxTokens ?? 4000,
        system: opts.system,
        messages: [{ role: "user", content: opts.content }],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) { console.error("llm:", res.status, (await res.text()).slice(0, 300)); return null; }
    const j = (await res.json()) as { content?: { type: string; text?: string }[]; stop_reason?: string };
    // A cut-off piece is worse than a plain one.
    if (j.stop_reason && j.stop_reason !== "end_turn") { console.error("llm: stopped early,", j.stop_reason); return null; }
    const text = (j.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    return text || null;
  } catch (e) {
    console.error("llm: failed", (e as Error).message);
    return null;
  }
}

/** Plain text only: no markdown markers, no links. */
export function plain(t: string, max = 3000): string {
  return t
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^#+\s*/gm, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
}
