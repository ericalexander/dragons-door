/**
 * One small door to the Claude API, for the few things the realm writes in prose (the chronicle,
 * townsfolk letters). Returns null on any trouble so callers can fall back to templates.
 */
/**
 * `trim`: for short pieces, a reply that ran out of room keeps its complete sentences instead of being thrown
 * away (only if at least one whole sentence came back).
 */
export async function write(opts: { system: string; content: string; maxTokens?: number; model?: string; trim?: boolean; quick?: boolean }): Promise<string | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const model = opts.model ?? "claude-sonnet-5-5";
  try {
    const send = (extra: Record<string, unknown>) => fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model,
        max_tokens: opts.maxTokens ?? 4000,
        system: opts.system,
        messages: [{ role: "user", content: opts.content }],
        ...extra,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    // Short pieces don't need the model to think first, and its thinking counts against max_tokens.
    const quick = opts.quick ? noThinking(model) : {};
    let res = await send(quick);
    // If this model won't take that setting, ask again the ordinary way rather than write nothing.
    if (res.status === 400 && Object.keys(quick).length) res = await send({});
    if (!res.ok) { console.error("llm:", res.status, (await res.text()).slice(0, 300)); return null; }
    const j = (await res.json()) as { content?: { type: string; text?: string }[]; stop_reason?: string };
    // A cut-off piece is worse than a plain one.
    const text = (j.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    if (j.stop_reason && j.stop_reason !== "end_turn") {
      const whole = opts.trim && j.stop_reason === "max_tokens" ? wholeSentences(text) : "";
      if (whole) return whole;
      console.error("llm: stopped early,", j.stop_reason, opts.maxTokens ?? 4000);
      return null;
    }
    return text || null;
  } catch (e) {
    console.error("llm: failed", (e as Error).message);
    return null;
  }
}

/**
 * How to ask a model not to think before answering, for short pieces. Claude 5.x models think by default.
 * Sonnet 5.5 refuses "disabled" but takes "between_tools", which without tools means no thinking up front;
 * Sonnet 5 and Haiku 5.5 take "disabled"; the rest can't turn it off, so they get low effort instead.
 */
export function noThinking(model: string): Record<string, unknown> {
  if (/sonnet-5-5/.test(model)) return { thinking: { type: "between_tools" } };
  if (/sonnet-5(?!-\d)|haiku-5-5/.test(model)) return { thinking: { type: "disabled" } };
  if (/(opus|fable|mythos)-5/.test(model)) return { output_config: { effort: "low" } };
  return {};
}

/** The text up to its last complete sentence, or "" if there isn't one. */
export function wholeSentences(t: string): string {
  const m = t.match(/^[\s\S]*[.!?…]["”’)]?(?=\s|$)/);
  return m ? m[0].trim() : "";
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
