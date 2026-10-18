// Purpose: Retains child-session identity when expected prompt execution fails.

import { Schema } from "effect";

/** The supplied output schema could not be projected to JSON Schema. */
export class InvalidOutputSchema extends Schema.TaggedError<InvalidOutputSchema>()(
  "Workflow.InvalidOutputSchema",
  { message: Schema.String, cause: Schema.Defect() },
) {}

/** Final output failed decoding; callers may repair it in the same child Session. */
export class InvalidOutput extends Schema.TaggedError<InvalidOutput>()(
  "Workflow.InvalidOutput",
  { sessionId: Schema.String, message: Schema.String, cause: Schema.Defect() },
) {}

/** Expected child failure, returned as an item outcome by workflow parallel(). */
export class ChildFailed extends Schema.TaggedError<ChildFailed>()(
  "Workflow.ChildFailed",
  {
    sessionId: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/** A continuation may only target a child created by this invocation's host. */
export class SessionNotOwned extends Schema.TaggedError<SessionNotOwned>()(
  "Workflow.SessionNotOwned",
  { sessionId: Schema.String },
) {}

/** A workspace module could not be compiled or did not export a workflow. */
export class LoadFailed extends Schema.TaggedError<LoadFailed>()(
  "Workflow.LoadFailed",
  { workflow: Schema.String, message: Schema.String, cause: Schema.Defect() },
) {}

/**
 * An authored program requested a host capability outside a running invocation
 * or the host could not complete it.
 *
 * @example
 * ```ts
 * const error = new ExecutionError({ message: "Workflow.question must run inside Workflow.run" });
 * ```
 */
export class ExecutionError extends Schema.TaggedError<ExecutionError>()(
  "Workflow.ExecutionError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}
