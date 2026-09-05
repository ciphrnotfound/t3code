import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";

export interface TurnDiffFileSummary {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

/** Reads Git's NUL-delimited numstat output without decoding display paths. */
export function parseTurnDiffFilesFromNumstat(numstat: string): ReadonlyArray<TurnDiffFileSummary> {
  const records = numstat.split("\0");
  const files: TurnDiffFileSummary[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const counts = /^(\d+|-)\t(\d+|-)\t/.exec(record);
    if (!counts) continue;

    let path = record.slice(counts[0].length);
    if (path.length === 0) {
      // Renames and copies use two more records: the source and destination.
      path = records[index + 2] ?? "";
      index += 2;
    }
    if (path.length === 0) continue;

    files.push({
      path,
      additions: counts[1] === "-" ? 0 : Number(counts[1]),
      deletions: counts[2] === "-" ? 0 : Number(counts[2]),
    });
  }

  return files.toSorted((left, right) => left.path.localeCompare(right.path));
}

export type TurnDiffFileOperation = "created" | "modified" | "deleted" | "renamed";

export type TurnDiffFileRange = { readonly start: number; readonly end: number };

export function parseTurnDiffFilesFromUnifiedDiff(diff: string): ReadonlyArray<TurnDiffFileSummary> {
  const normalized = diff.replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) return [];
  return parsePatchFiles(normalized)
    .flatMap((patch) =>
      patch.files.map((file) => ({
        path: file.name,
        additions: file.hunks.reduce((total, hunk) => total + hunk.additionLines, 0),
        deletions: file.hunks.reduce((total, hunk) => total + hunk.deletionLines, 0),
      })),
    )
    .toSorted((left, right) => left.path.localeCompare(right.path));
}

export function classifyTurnDiffFileOperations(diff: string): ReadonlyMap<string, TurnDiffFileOperation> {
  const operations = new Map<string, TurnDiffFileOperation>();
  let currentPath: string | null = null;
  let currentOperation: TurnDiffFileOperation = "modified";
  const flush = () => currentPath !== null && operations.set(currentPath, currentOperation);
  for (const line of diff.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      currentPath = null;
      currentOperation = "modified";
    } else if (line.startsWith("+++ b/")) currentPath = line.slice("+++ b/".length);
    else if (line.startsWith("--- a/") && currentPath === null) currentPath = line.slice("--- a/".length);
    else if (line.startsWith("new file mode ")) currentOperation = "created";
    else if (line.startsWith("deleted file mode ")) currentOperation = "deleted";
    else if (line.startsWith("rename from ")) currentOperation = "renamed";
    else if (line.startsWith("rename to ")) {
      currentOperation = "renamed";
      currentPath = line.slice("rename to ".length);
    }
  }
  flush();
  return operations;
}

export function parseTurnDiffRenameSources(diff: string): ReadonlyMap<string, string> {
  const sources = new Map<string, string>();
  let renameFrom: string | null = null;
  for (const line of diff.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("diff --git ")) renameFrom = null;
    else if (line.startsWith("rename from ")) renameFrom = line.slice("rename from ".length);
    else if (line.startsWith("rename to ") && renameFrom !== null) {
      sources.set(line.slice("rename to ".length), renameFrom);
      renameFrom = null;
    }
  }
  return sources;
}

export function parseTurnDiffFileRanges(
  diff: string,
): ReadonlyMap<string, ReadonlyArray<TurnDiffFileRange>> {
  const ranges = new Map<string, Array<TurnDiffFileRange>>();
  let currentPath: string | null = null;
  let newLine: number | null = null;
  let deletionAnchor: number | null = null;
  const flushDeletionAnchor = () => {
    if (currentPath === null || deletionAnchor === null) return;
    const fileRanges = ranges.get(currentPath) ?? [];
    fileRanges.push({ start: deletionAnchor, end: deletionAnchor });
    ranges.set(currentPath, fileRanges);
    deletionAnchor = null;
  };
  const addRange = (start: number, end: number) => {
    if (currentPath === null) return;
    const fileRanges = ranges.get(currentPath) ?? [];
    const previous = fileRanges.at(-1);
    if (previous && previous.end + 1 === start) fileRanges[fileRanges.length - 1] = { start: previous.start, end };
    else fileRanges.push({ start, end });
    ranges.set(currentPath, fileRanges);
  };
  for (const line of diff.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("+++ b/")) {
      currentPath = line.slice("+++ b/".length);
      newLine = null;
      deletionAnchor = null;
      continue;
    }
    if (line.startsWith("diff --git ")) {
      flushDeletionAnchor();
      currentPath = null;
      newLine = null;
      continue;
    }
    if (currentPath === null) continue;
    const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (match) {
      flushDeletionAnchor();
      newLine = Number(match[1]);
      continue;
    }
    if (newLine === null || line.startsWith("\\ No newline")) continue;
    if (line.startsWith("+")) {
      addRange(newLine, newLine);
      newLine += 1;
      deletionAnchor = null;
    } else if (line.startsWith("-")) deletionAnchor ??= newLine;
    else if (line.startsWith(" ")) {
      flushDeletionAnchor();
      newLine += 1;
    }
  }
  flushDeletionAnchor();
  return ranges;
}

export function parseTurnDiffUnsupportedPaths(diff: string): ReadonlyArray<string> {
  const paths = new Set<string>();
  for (const line of diff.replace(/\r\n/g, "\n").split("\n")) {
    const match = line.match(/^Binary files a\/(.+) and b\/(.+) differ$/);
    if (match) paths.add(match[2]!);
  }
  return [...paths].toSorted((left, right) => left.localeCompare(right));
}
