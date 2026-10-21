// Purpose: Exposes the host-backed human question primitive to workflow authors.

import { Workflow } from "@openchart/server/agent/workflow";
import { PublishTrace } from "@openchart/server/agent/workflow/tracing";
import { Cause, Effect, Exit, Option } from "effect";

export type QuestionInput = Workflow.QuestionInput;
export type QuestionReply = Workflow.QuestionReply;

/**
 * Pauses the workflow to ask the human user one or more structured
 * multiple-choice or freeform questions in the calling session.
 *
 * Behavior: publishes the question batch to the parent session's question
 * store and suspends the calling fiber until the user submits answers or
 * skips the prompt. Does not acquire a child-agent concurrency permit.
 * A batch of model questions may supply modelSelection defaults. The host snapshots
 * discovered harness/model/effort choices; the app renders dependent menus and
 * replies with JSON-encoded AgentPromptModel values in the ordinary answer strings.
 * Model-selection batches cannot mix with ordinary text or choice questions.
 * Ownership: requires the host-provided {@link Workflow.Service} inside a
 * running workflow invocation; fails immediately with
 * {@link Workflow.ExecutionError} when called outside `Workflow.run`.
 * Cleanup: fiber interruption removes the pending question from the session
 * store and notifies observers.
 * Failures: returns {@link Workflow.ExecutionError} when called outside a
 * workflow run or when the host session cannot accept questions.
 *
 * @example
 * ```ts
 * import { defineWorkflow, Effect, question, Schema } from "@openchart/workflow";
 *
 * export default defineWorkflow({
 *   description: "Confirm before proceeding",
 *   args: Schema.Struct({ topic: Schema.String }),
 *   run: ({ topic }) =>
 *     Effect.gen(function* () {
 *       const reply = yield* question({
 *         questions: [
 *           {
 *             id: "confirm",
 *             header: "Confirm",
 *             question: `Proceed with ${topic}?`,
 *             options: [{ label: "Yes", description: "Continue execution" }],
 *             multiple: false,
 *             allowFreeform: false,
 *             secret: false,
 *           },
 *         ],
 *       });
 *       return reply.type === "answered" ? "confirmed" : "skipped";
 *     }),
 * });
 * ```
 */
export const question = (
  input: QuestionInput,
): Effect.Effect<QuestionReply, Workflow.ExecutionError> =>
  Effect.gen(function* () {
    const service = yield* Effect.serviceOption(Workflow.Service);
    if (Option.isNone(service)) {
      return yield* new Workflow.ExecutionError({
        message: "Workflow.question must run inside Workflow.run",
      });
    }
    const publish = yield* PublishTrace;
    return yield* Effect.useSpan(
      "Workflow.question",
      {
        attributes: {
          "openchart.label": "question",
          "openchart.questions": input.questions.length,
        },
      },
      (span) =>
        Effect.gen(function* () {
          // Publish after opening the span so the pending question is visible.
          // Trace sink failures are host defects, not authored execution errors.
          yield* publish.pipe(Effect.orDie);
          return yield* service.value.question(input);
        }).pipe(
          Effect.withParentSpan(span),
          Effect.onExit((exit) =>
            Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
              ? Effect.sync(() => span.attribute("openchart.cancelled", true))
              : Effect.void,
          ),
        ),
    ).pipe(Effect.onExit(() => publish.pipe(Effect.orDie)));
  });
