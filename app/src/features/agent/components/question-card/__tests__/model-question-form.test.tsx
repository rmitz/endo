// Purpose: Verifies dependent harness/model/effort menus and safe draft submission.
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { QuestionCard } from "../question-card";
import type { QuestionRequest } from "@openchart/app/lib/agent/client";
const pointerEvent = Object.getOwnPropertyDescriptor(window, "PointerEvent");
beforeEach(() => {
  // Base UI dispatches native click events; jsdom does not implement PointerEvent.
  Object.defineProperty(window, "PointerEvent", {
    configurable: true,
    value: MouseEvent,
  });
  // Radix scrolls focused menu items; jsdom has no layout.
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(() => {
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  if (pointerEvent) Object.defineProperty(window, "PointerEvent", pointerEvent);
  else Reflect.deleteProperty(window, "PointerEvent");
});

const providers = [
  {
    id: "codex" as const,
    name: "Codex",
    models: [
      { id: "planner", name: "Planner", availableVariants: ["low", "high"] },
      { id: "fast", name: "Fast", availableVariants: ["low"] },
    ],
  },
  {
    id: "opencode" as const,
    name: "OpenCode",
    models: [{ id: "private/no-effort", name: "Local model" }],
  },
];
const request: QuestionRequest = {
  id: "que_models" as QuestionRequest["id"],
  sessionID: "session",
  questions: [
    {
      id: "plannerA",
      header: "Planner A",
      question: "Draft a plan",
      options: [],
      multiple: false,
      allowFreeform: false,
      secret: false,
      modelSelection: {
        defaultModel: {
          providerID: "codex",
          modelID: "planner",
          selectedVariant: "high",
        },
        providers,
      },
    },
  ],
};

function picker(role: string) {
  return within(screen.getByRole("region", { name: role })).getByRole(
    "combobox",
  );
}

async function selectModel(
  user: ReturnType<typeof userEvent.setup>,
  role: string,
  modelName: string,
) {
  await user.click(picker(role));
  await user.click(screen.getByRole("option", { name: modelName }));
}
async function selectEffort(
  user: ReturnType<typeof userEvent.setup>,
  role: string,
  effort: string,
) {
  await user.click(picker(role));
  await user.click(screen.getByRole("radio", { name: effort }));
  await user.keyboard("{Escape}");
}
test("uses the chat picker for models and efforts with no model-name text entry", async () => {
  const user = userEvent.setup();
  const onReply = vi.fn().mockResolvedValue(undefined);
  render(<QuestionCard request={request} disabled={false} onReply={onReply} />);
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  await selectEffort(user, "Planner A", "low");
  await user.click(screen.getByRole("button", { name: "Start workflow" }));
  expect(onReply).toHaveBeenCalledExactlyOnceWith("que_models", {
    type: "answered",
    answers: {
      plannerA: [
        JSON.stringify({
          providerID: "codex",
          modelID: "planner",
          selectedVariant: "low",
        }),
      ],
    },
  });
});
test("switching models or harnesses uses the shared picker and clears incompatible effort", async () => {
  const user = userEvent.setup();
  const onReply = vi.fn().mockResolvedValue(undefined);
  render(<QuestionCard request={request} disabled={false} onReply={onReply} />);
  await selectModel(user, "Planner A", "Fast Codex");
  expect(picker("Planner A")).not.toHaveTextContent("high");
  await selectModel(user, "Planner A", "Local model OpenCode");
  await user.click(picker("Planner A"));
  expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  await user.keyboard("{Escape}");
  await user.click(screen.getByRole("button", { name: "Start workflow" }));
  expect(onReply).toHaveBeenLastCalledWith("que_models", {
    type: "answered",
    answers: {
      plannerA: [
        JSON.stringify({
          providerID: "opencode",
          modelID: "private/no-effort",
        }),
      ],
    },
  });
});
test("an empty catalog blocks execution and can be skipped", async () => {
  const user = userEvent.setup();
  const onReply = vi.fn().mockResolvedValue(undefined);
  const empty = {
    ...request,
    questions: request.questions.map((question) => ({
      ...question,
      modelSelection: { ...question.modelSelection!, providers: [] },
    })),
  };
  render(<QuestionCard request={empty} disabled={false} onReply={onReply} />);
  expect(screen.getByRole("button", { name: "Start workflow" })).toBeDisabled();
  expect(picker("Planner A")).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Skip questions" }));
  expect(onReply).toHaveBeenCalledExactlyOnceWith("que_models", {
    type: "skipped",
  });
});
test("failed submission preserves the model draft and prevents duplicate submissions", async () => {
  const user = userEvent.setup();
  let reject!: (error: Error) => void;
  const onReply = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, rejection) => {
          reject = rejection;
        }),
    )
    .mockResolvedValue(undefined);
  render(<QuestionCard request={request} disabled={false} onReply={onReply} />);
  await selectModel(user, "Planner A", "Fast Codex");
  await user.dblClick(screen.getByRole("button", { name: "Start workflow" }));
  expect(onReply).toHaveBeenCalledTimes(1);
  await act(async () => reject(new Error("Connection lost")));
  expect(await screen.findByRole("alert")).toHaveTextContent("Connection lost");
  expect(picker("Planner A")).toHaveTextContent("Fast");
  await user.click(screen.getByRole("button", { name: "Start workflow" }));
  expect(onReply).toHaveBeenCalledTimes(2);
});
test("unavailable defaults require an explicit choice from the shared picker", async () => {
  const user = userEvent.setup();
  const onReply = vi.fn().mockResolvedValue(undefined);
  const unavailable = {
    ...request,
    questions: request.questions.map((question) => ({
      ...question,
      modelSelection: {
        ...question.modelSelection!,
        defaultModel: { providerID: "codex" as const, modelID: "missing" },
      },
    })),
  };
  render(
    <QuestionCard request={unavailable} disabled={false} onReply={onReply} />,
  );
  expect(screen.getByRole("button", { name: "Start workflow" })).toBeDisabled();
  await selectModel(user, "Planner A", "Planner Codex");
  expect(screen.getByRole("button", { name: "Start workflow" })).toBeEnabled();
});
test("each role retains its independently selected reasoning effort", async () => {
  const user = userEvent.setup();
  const onReply = vi.fn().mockResolvedValue(undefined);
  render(
    <QuestionCard
      request={{
        ...request,
        questions: [
          request.questions[0]!,
          { ...request.questions[0]!, id: "verifier", header: "Verifier" },
        ],
      }}
      disabled={false}
      onReply={onReply}
    />,
  );
  await selectEffort(user, "Verifier", "low");
  await user.click(screen.getByRole("button", { name: "Start workflow" }));
  expect(onReply).toHaveBeenCalledExactlyOnceWith("que_models", {
    type: "answered",
    answers: {
      plannerA: [
        JSON.stringify({
          providerID: "codex",
          modelID: "planner",
          selectedVariant: "high",
        }),
      ],
      verifier: [
        JSON.stringify({
          providerID: "codex",
          modelID: "planner",
          selectedVariant: "low",
        }),
      ],
    },
  });
});
