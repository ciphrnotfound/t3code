export function isProvenanceEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return environment.T3_PROVENANCE_ENABLED !== "0";
}

/** Canonicalizes workspace paths without requiring the path to exist. */
export function normalizeWorkspacePath(value: string): string {
  const trimmed = value.trim();
  const windowsStyle = /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith("\\\\");
  const normalized = windowsStyle
    ? trimmed.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase()
    : trimmed.replace(/\/+$/, "");
  return normalized.length > 0 ? normalized : trimmed;
}

export function workspacePathsEqual(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return left === right;
  }
  return normalizeWorkspacePath(left) === normalizeWorkspacePath(right);
}

/** Strict check used immediately before sending work to a provider. */
export function providerWorkspaceMismatch(
  expectedPath: string | null | undefined,
  actualCwd: string | undefined,
): boolean {
  return (
    expectedPath !== null &&
    expectedPath !== undefined &&
    !workspacePathsEqual(expectedPath, actualCwd)
  );
}

export function worktreeMismatch(
  expectedPath: string | null,
  actualCwd: string | undefined,
): boolean {
  return (
    expectedPath !== null &&
    actualCwd !== undefined &&
    !workspacePathsEqual(expectedPath, actualCwd)
  );
}
