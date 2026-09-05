import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const RevertFailurePayload = Schema.Struct({
  turnCount: Schema.Number,
  detail: Schema.String,
});

const decodeRevertFailure = Schema.decodeUnknownOption(RevertFailurePayload);

/** Keeps retries functional while preventing identical durable error rows. */
export function shouldAppendRevertFailure(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  input: { readonly turnCount: number; readonly detail: string },
): boolean {
  const latestFailure = activities
    .toReversed()
    .find((activity) => activity.kind === "checkpoint.revert.failed");
  if (!latestFailure) return true;
  const decoded = decodeRevertFailure(latestFailure.payload);
  return (
    Option.isNone(decoded) ||
    decoded.value.turnCount !== input.turnCount ||
    decoded.value.detail !== input.detail
  );
}
