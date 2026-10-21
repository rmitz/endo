// Purpose: Collects workflow role models using the same model-and-effort picker as chat.
import { useState } from "react";
import { Button } from "@openchart/app/components/ui/button";
import { ModelPicker } from "@openchart/app/features/agent/components/model-picker/model-picker";
import type {
  ModelSelection,
  QuestionRequest,
} from "@openchart/app/lib/agent/client";

type ModelQuestion = QuestionRequest["questions"][number];
type Catalog = NonNullable<ModelQuestion["modelSelection"]>;

function availableSelection(catalog: Catalog, selection?: ModelSelection) {
  const model = catalog.providers
    .find((provider) => provider.id === selection?.providerID)
    ?.models.find((model) => model.id === selection?.modelID);
  return model && selection
    ? {
        providerID: selection.providerID,
        modelID: model.id,
        ...(selection.selectedVariant &&
        model.availableVariants?.includes(selection.selectedVariant)
          ? { selectedVariant: selection.selectedVariant }
          : {}),
      }
    : undefined;
}

/** Keeps model drafts local across failed replies. The server validates each exact catalog choice.
 * @example <ModelQuestionForm request={request} disabled={false} pending={false} onSubmit={submit} onSkip={skip} />
 */
export function ModelQuestionForm({
  request,
  disabled,
  pending,
  error,
  onSubmit,
  onSkip,
}: {
  request: QuestionRequest;
  disabled: boolean;
  pending: boolean;
  error?: string;
  onSubmit: (answers: Record<string, string[]>) => void;
  onSkip: () => void;
}) {
  const [selections, setSelections] = useState<
    Record<string, ModelSelection | undefined>
  >(() =>
    Object.fromEntries(
      request.questions.map((question) => [
        question.id,
        question.modelSelection
          ? availableSelection(
              question.modelSelection,
              question.modelSelection.defaultModel,
            )
          : undefined,
      ]),
    ),
  );
  const complete = request.questions.every(
    (question) =>
      question.modelSelection &&
      availableSelection(question.modelSelection, selections[question.id]),
  );
  return (
    <form
      aria-label="Workflow role models"
      aria-busy={pending}
      className="mb-3 w-full max-w-sm rounded-2xl border border-border/60 bg-background p-3.5 dark:bg-popover"
      onSubmit={(event) => {
        event.preventDefault();
        if (complete && !disabled && !pending)
          onSubmit(
            Object.fromEntries(
              request.questions.map((question) => [
                question.id,
                [
                  JSON.stringify(
                    availableSelection(
                      question.modelSelection!,
                      selections[question.id],
                    ),
                  ),
                ],
              ]),
            ),
          );
      }}
    >
      <fieldset disabled={disabled || pending} className="grid min-w-0 gap-4">
        <legend className="mb-3 text-sm font-medium">
          Choose workflow models
        </legend>
        {request.questions.map(
          (question) =>
            question.modelSelection && (
              <section
                key={question.id}
                className="grid gap-2 border-b border-border/60 pb-4"
                aria-label={question.header}
              >
                <h3 className="text-sm font-medium">{question.header}</h3>
                <p className="text-xs text-muted-foreground">
                  {question.question}
                </p>
                <ModelPicker
                  providers={question.modelSelection.providers}
                  model={selections[question.id]}
                  onChange={(value) =>
                    setSelections((current) => ({
                      ...current,
                      [question.id]: value,
                    }))
                  }
                  disabled={
                    disabled ||
                    pending ||
                    !question.modelSelection.providers.length
                  }
                />
                {!question.modelSelection.providers.length && (
                  <p className="text-xs text-muted-foreground">
                    No harnesses are available. Configure a provider in Settings
                    → Models, then restart this workflow.
                  </p>
                )}
              </section>
            ),
        )}
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" size="xs" variant="ghost" onClick={onSkip}>
            Skip questions
          </Button>
          <Button type="submit" size="xs" disabled={!complete}>
            {pending ? "Sending…" : "Start workflow"}
          </Button>
        </div>
      </fieldset>
    </form>
  );
}
