# Review and undo agent changes

In web and desktop, open **Provenance** from the right panel to inspect recorded
file-changing turns. Open a turn's diff to review the changes or jump to the
assistant response that produced them. You can also export the turn as a patch.

When another thread edits a previously changed region in the same checkout, an
overlap alert offers **Compare changes**. An unrelated edit elsewhere in that
file does not hide the earlier recorded overlap. Alerts describe recorded
checkpoint changes, not live conflicts or proof that two changes are compatible.

Preview a turn's undo before applying it. Preview checks the current files
without changing them. Undo checks again when you apply it, because another
edit may have arrived since the preview. A successful undo removes that turn's
patch while preserving compatible later edits and the conversation history.
If any file conflicts, the operation leaves every file in the patch unchanged.
Binary changes and renames require manual review.

Line ranges describe the recorded diffs; later insertions and deletions can
move code. Review the actual patch and the workspace check rather than treating
an overlap label as a guarantee. Provenance currently has no native mobile panel.
