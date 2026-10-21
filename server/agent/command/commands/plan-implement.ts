// Purpose: Compiles the revision-round bound and the idea into a WorkflowPart.
import { defineCommand } from "@openchart/server/agent/command/definition";
import type { AgentPromptPartInput } from "@openchart/server/agent/contracts/agent-prompt-input";
import { UnsupportedCommandPart } from "@openchart/server/agent/command/errors";
import { formatRestArgument } from "@openchart/server/agent/command/template";
import { Effect, Schema } from "effect";

const planImplementArgs = Schema.Struct({
  maxRounds: Schema.Int.check(Schema.isGreaterThan(0)),
  idea: Schema.String.check(Schema.isMinLength(1)),
});

/** $1 is the round bound; the highest placeholder $2 captures the complete idea. */
export const planImplementCommand = defineCommand({
  name: "plan-implement",
  type: "workflow",
  description:
    "Develop two plans, reconcile, implement and verify. Choose any available model independently for each role",
  argumentHint:
    "Usage: <maxRounds> <idea>. Choose role models interactively after submission. Max rounds must be a positive integer. Example: 2 Add offline support to the editor.",
  template: "$1 $2",
  buildParts: ({ captures }) =>
    Schema.decodeUnknownEffect(planImplementArgs)({
      maxRounds: Number(captures.$1),
      idea: captures.$2,
    }).pipe(
      Effect.map((args) => [
        {
          type: "workflow",
          workflow: "default:workflows/plan-implement.workflow.ts",
          args,
        },
      ]),
    ),
  restoreArgumentsFromParts: Effect.fn("PlanImplementCommand.restore")(
    function* (parts: readonly AgentPromptPartInput[]) {
      const [part] = parts;
      if (
        parts.length !== 1 ||
        part?.type !== "workflow" ||
        part.workflow !== "default:workflows/plan-implement.workflow.ts"
      )
        return undefined;
      const args = yield* Schema.decodeUnknownEffect(planImplementArgs)(
        part.args,
      );
      const idea = formatRestArgument(args.idea);
      if (idea === undefined) return yield* new UnsupportedCommandPart({});
      return `${args.maxRounds} ${idea}`;
    },
  ),
});
