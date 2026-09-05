type ProvenancePatchFilenameInput = {
  readonly providerName?: string;
  readonly turnCount?: number;
  readonly turnId: string;
};

function sanitizePatchFilenameSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function buildProvenancePatchFilename({ providerName, turnCount, turnId }: ProvenancePatchFilenameInput): string {
  const provider = sanitizePatchFilenameSegment(providerName ?? "agent") || "agent";
  const turn = typeof turnCount === "number" ? `turn-${turnCount}` : `turn-${turnId.slice(0, 8)}`;
  return `t3-${provider}-${turn}.patch`;
}

export function normalizeProvenancePatchForExport(patch: string): string {
  return `${patch.trimEnd()}\n`;
}

export function downloadProvenancePatch(filename: string, patch: string): void {
  const blob = new Blob([normalizeProvenancePatchForExport(patch)], { type: "text/x-diff;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
