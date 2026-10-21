// Purpose: Defines pending questions and user replies independently of execution.
import { Schema } from "effect";
import { AgentPromptModel } from "@openchart/server/agent/contracts/agent-prompt-input";
import type {
  ProviderQuestion,
  ProviderQuestionReply,
} from "@openchart/models/provider-question";

/** Identifies one pending native question invocation. */
export const ID = Schema.String.check(Schema.isStartsWith("que_")).pipe(
  Schema.brand("Question.ID"),
);
export type ID = typeof ID.Type;

/** Frozen discovered choices for a harness, native model and reasoning-effort form.
 * The workflow host supplies this catalog; replies must match it. No resources are allocated.
 * @example const view = ModelSelection.make({defaultModel, providers});
 */
export const ModelSelection = Schema.Struct({
  defaultModel: AgentPromptModel,
  providers: Schema.Array(
    Schema.Struct({
      id: AgentPromptModel.fields.providerID,
      name: Schema.String,
      models: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          name: Schema.String,
          availableVariants: Schema.optional(Schema.Array(Schema.String)),
        }),
      ),
    }),
  ),
});

/** Provider-neutral display data plus optional host-owned model selection. */
export const Question = Schema.Struct({
  id: Schema.String,
  header: Schema.String,
  question: Schema.String,
  options: Schema.Array(
    Schema.Struct({ label: Schema.String, description: Schema.String }),
  ),
  multiple: Schema.Boolean,
  allowFreeform: Schema.Boolean,
  secret: Schema.Boolean,
  modelSelection: Schema.optional(ModelSelection),
}) satisfies Schema.Schema<ProviderQuestion>;

/** Complete pending view; requests belong to the prompt's existing Session. */
export const Request = Schema.Struct({
  id: ID,
  sessionID: Schema.String,
  questions: Schema.Array(Question),
});
export type Request = typeof Request.Type;

/** Submitted answers are checked against the pending questions by the owner. */
export const Reply = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("answered"),
    answers: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  }),
  Schema.Struct({ type: Schema.Literal("skipped") }),
]) satisfies Schema.Schema<ProviderQuestionReply>;
export type Reply = typeof Reply.Type;

/** Reply to one invocation, without creating another prompt or Run. */
export const ReplyInput = Schema.Struct({ requestID: ID, reply: Reply });
export type ReplyInput = typeof ReplyInput.Type;
