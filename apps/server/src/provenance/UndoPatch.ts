/** Context anchors deleted lines and distinguishes repeated statements. */
export function undoDiffArgs(before: string, after: string): string[] {
  return [
    "diff",
    "--patch",
    "--unified=3",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    `${before}^{commit}`,
    `${after}^{commit}`,
    "--",
  ];
}

export function undoApplyArgs(preview = false): string[] {
  return ["apply", "--reverse", ...(preview ? ["--check"] : []), "--whitespace=nowarn"];
}
