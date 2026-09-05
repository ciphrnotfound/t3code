const MAX_TURN_SUMMARY_CHARS = 240;

/** Reuses the provider's existing final response; this never invokes a model. */
export function summarizeProvenanceTurn(text: string | undefined): string | undefined {
  if (!text) return undefined;

  const normalized = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/[*_`~>|]/g, "")
    .replace(/^\s*[-+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return undefined;
  if (normalized.length <= MAX_TURN_SUMMARY_CHARS) return normalized;

  const clipped = normalized.slice(0, MAX_TURN_SUMMARY_CHARS + 1);
  const wordBoundary = clipped.lastIndexOf(" ");
  const end = wordBoundary >= MAX_TURN_SUMMARY_CHARS * 0.7 ? wordBoundary : MAX_TURN_SUMMARY_CHARS;
  return `${normalized.slice(0, end).trimEnd()}…`;
}
