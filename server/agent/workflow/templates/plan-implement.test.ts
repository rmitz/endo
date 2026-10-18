// Purpose: Exercises plan-implement debate, adjudication, escalation, implementation and retry paths.

import type { AgentPromptInput } from "@openchart/server/agent/contracts/agent-prompt-input";
import { Effect } from "effect";
import { expect, test } from "vitest";
import type {
  QuestionInput,
  QuestionReply,
} from "@openchart/server/agent/workflow/authoring";
import { defaultWorkflowFixture } from "../defaults.test-utils";
import { run } from "../runtime";
import { Workflow } from "../workflow";

const loadDefaultWorkflow = defaultWorkflowFixture();

const basePrompt: AgentPromptInput = {
  agent: "analyst",
  model: { providerID: "codex", modelID: "tier4" },
  parts: [],
};

const step = {
  title: "Step",
  details: "Do the work",
  files: ["src/feature.ts"],
};
const plan = (marker: string) => ({
  summary: `Plan ${marker}`,
  approach: "Add the feature behind a flag",
  steps: [step],
  touchedPaths: ["src/feature.ts"],
  publicContracts: [],
  assumptions: [],
  risks: [],
});
const emptyCritique = {
  agreements: ["Both plans agree"],
  issues: [] as unknown[],
};
const defect = (id = "defect-1") => ({
  id,
  kind: "technical_defect" as const,
  severity: "blocking" as const,
  summary: "Shared mutable state races",
  rationale: "Two callers can interleave writes",
  options: [] as string[],
});
const fork = (id = "storage") => ({
  id,
  kind: "normative_fork" as const,
  severity: "non_blocking" as const,
  summary: "SQLite vs JSON file",
  rationale: "Both are technically sound; the concept did not choose",
  options: ["SQLite", "JSON file"],
});
const spine = (overrides: Record<string, unknown> = {}) => ({
  summary: "Agreed spine",
  agreedSteps: [step],
  touchedPaths: ["src/feature.ts"],
  publicContracts: [],
  unresolvedDefects: [],
  normativeForks: [],
  ...overrides,
});
const spec = {
  objective: "Implement the feature",
  steps: [step],
  touchedPaths: ["src/feature.ts"],
  invariants: ["No behavior change when the flag is off"],
  verificationCommands: ["npm test"],
};
const report = (attempt: number) => ({
  summary: `Implemented attempt ${attempt}`,
  changedFiles: ["src/feature.ts"],
  notes: [],
});
const verdict = (status: "pass" | "execution_failure" | "plan_failure") => ({
  status,
  summary: `Verification ${status}`,
  failures: status === "pass" ? [] : ["A verification command failed"],
});

type SchemaKind = "plan" | "critique" | "spine" | "spec" | "report" | "verdict";

interface AgentCall {
  readonly input: AgentPromptInput;
  readonly kind: SchemaKind;
  readonly side: "A" | "B";
  readonly index: number;
  readonly sessionId?: string;
}

function requiredFields(outputSchema: unknown): readonly string[] {
  if (outputSchema === null || typeof outputSchema !== "object") return [];
  const required = (outputSchema as { required?: unknown }).required;
  return Array.isArray(required)
    ? required.filter((value): value is string => typeof value === "string")
    : [];
}

function classify(required: readonly string[]): SchemaKind {
  if (required.includes("issues")) return "critique";
  if (required.includes("approach")) return "plan";
  if (required.includes("agreedSteps")) return "spine";
  if (required.includes("objective")) return "spec";
  if (required.includes("changedFiles")) return "report";
  if (required.includes("status")) return "verdict";
  throw new Error(`Unknown output schema: ${required.join(",")}`);
}

function makeService(config: {
  readonly respond: (call: AgentCall) => unknown;
  readonly sessionFor?: (call: AgentCall) => string | undefined;
  readonly question?: (input: QuestionInput) => QuestionReply;
}) {
  const calls: AgentCall[] = [];
  const questionCalls: QuestionInput[] = [];
  let counter = 0;
  const service = {
    getResource: () => Effect.die("Unexpected Resource read"),
    parentPrompt: basePrompt,
    settings: { concurrency: 5 },
    question: (input: QuestionInput) =>
      Effect.sync(() => {
        questionCalls.push(input);
        if (!config.question) throw new Error("Unexpected question");
        return config.question(input);
      }),
    agent: (
      input: AgentPromptInput,
      onSession: (sessionId: string) => Effect.Effect<void, unknown>,
      options?: Parameters<Workflow.Service["Service"]["agent"]>[2],
    ) =>
      Effect.gen(function* () {
        const required = requiredFields(options?.outputSchema);
        const kind = classify(required);
        const side = input.model.providerID === "codex" ? "A" : "B";
        const call: AgentCall = {
          input,
          kind,
          side,
          index: counter++,
          sessionId: options?.sessionId,
        };
        calls.push(call);
        const sessionId =
          options?.sessionId ??
          config.sessionFor?.(call) ??
          `child-${call.index}`;
        yield* onSession(sessionId);
        return { sessionId, output: JSON.stringify(config.respond(call)) };
      }),
  } satisfies Workflow.Service["Service"];
  return { service, calls, questionCalls };
}

const plannerSessions = (call: AgentCall) =>
  call.kind === "plan" && call.sessionId === undefined
    ? call.side === "A"
      ? "plan-a"
      : "plan-b"
    : undefined;

async function runWith(
  service: Workflow.Service["Service"],
  args: { idea: string; maxRounds: number },
) {
  const definition = await Effect.runPromise(
    loadDefaultWorkflow("default:workflows/plan-implement.workflow.ts"),
  );
  return (await Effect.runPromise(
    run(definition, args).pipe(
      Effect.provideService(Workflow.Service, service),
    ),
  )) as unknown;
}

interface Escalated {
  readonly status: "escalated";
  readonly reason: string;
  readonly roundsCompleted: number;
  readonly triggers: {
    readonly normativeForks: boolean;
    readonly unresolvedBlockingDefects: boolean;
    readonly irreversibleSurfaces: boolean;
  };
  readonly adjudication: {
    readonly blockingDefects: readonly unknown[];
    readonly normativeForks: readonly unknown[];
    readonly irreversibleSurfaces: readonly string[];
  };
  readonly sessions: Readonly<Record<string, string | null>>;
}

interface Implemented {
  readonly status: "implemented";
  readonly roundsCompleted: number;
  readonly implementationAttempts: number;
  readonly adjudicationResolution: {
    readonly forkDecisions: readonly {
      readonly id: string;
      readonly chosen: readonly string[];
    }[];
    readonly irreversibleConfirmed: boolean;
  } | null;
  readonly verification: { readonly status: string };
  readonly sessions: Readonly<Record<string, string | null>>;
}

test("fast path skips debate, adjudication, and questions", async () => {
  const { service, calls, questionCalls } = makeService({
    respond: (call) => {
      switch (call.kind) {
        case "plan":
          return plan(call.side);
        case "critique":
          return emptyCritique;
        case "spine":
          return spine();
        case "spec":
          return spec;
        case "report":
          return report(1);
        case "verdict":
          return verdict("pass");
      }
    },
    sessionFor: plannerSessions,
  });
  const result = (await runWith(service, {
    idea: "Add offline sync for notes",
    maxRounds: 2,
  })) as Implemented;

  expect(questionCalls).toHaveLength(0);
  expect(result).toMatchObject({
    status: "implemented",
    roundsCompleted: 0,
    implementationAttempts: 1,
    adjudicationResolution: null,
    verification: { status: "pass" },
  });
  expect(result.sessions).toMatchObject({
    plannerA: "plan-a",
    plannerB: "plan-b",
  });
  const distilled = calls.find((call) => call.kind === "spine")!;
  expect(calls.find((call) => call.kind === "spec")?.sessionId).toBe(
    `child-${distilled.index}`,
  );
  for (const call of calls)
    expect(call.input.model.modelID).toBe(
      call.kind === "report" ? "tier3" : "tier4",
    );
});

test("a bounded debate round resolves a blocking technical defect", async () => {
  const critiquesBySession = new Map<string, number>();
  const { service, calls } = makeService({
    respond: (call) => {
      switch (call.kind) {
        case "plan":
          return plan(call.side);
        case "critique": {
          const key = call.sessionId ?? "none";
          const sequence = critiquesBySession.get(key) ?? 0;
          critiquesBySession.set(key, sequence + 1);
          return sequence === 0
            ? {
                agreements: [],
                issues: [
                  defect(key === "plan-a" ? "against-b" : "against-a"),
                  { ...defect("nonblocking"), severity: "non_blocking" },
                  fork("not-a-defect"),
                ],
              }
            : emptyCritique;
        }
        case "spine":
          return spine();
        case "spec":
          return spec;
        case "report":
          return report(1);
        case "verdict":
          return verdict("pass");
      }
    },
    sessionFor: plannerSessions,
  });
  const result = (await runWith(service, {
    idea: "Add offline sync for notes",
    maxRounds: 1,
  })) as Implemented;

  expect(result).toMatchObject({
    status: "implemented",
    roundsCompleted: 1,
    implementationAttempts: 1,
  });
  const revisedSessions = calls
    .filter((call) => call.kind === "plan" && call.sessionId !== undefined)
    .map((call) => call.sessionId);
  expect(revisedSessions).toEqual(["plan-a", "plan-b"]);
  const recritiques = calls.filter(
    (call) => call.kind === "critique" && call.sessionId !== undefined,
  );
  expect(recritiques).toHaveLength(4);
  expect(new Set(recritiques.map((call) => call.sessionId))).toEqual(
    new Set(["plan-a", "plan-b"]),
  );
  const revisions = calls.filter(
    (call) => call.kind === "plan" && call.sessionId,
  );
  for (const [index, own, other] of [
    [0, "against-a", "against-b"],
    [1, "against-b", "against-a"],
  ] as const) {
    expect(revisions[index]?.input.parts[0]).toMatchObject({
      text: expect.stringContaining(own),
    });
    for (const excluded of [other, "nonblocking", "not-a-defect"])
      expect(revisions[index]?.input.parts[0]).toMatchObject({
        text: expect.not.stringContaining(excluded),
      });
  }
});

test("discrete adjudication resolves a fork and an irreversible surface in-run", async () => {
  const forkIssue = fork();
  const { service, calls, questionCalls } = makeService({
    respond: (call) => {
      switch (call.kind) {
        case "plan":
          return plan(call.side);
        case "critique":
          return emptyCritique;
        case "spine":
          return spine({
            normativeForks: [forkIssue],
            touchedPaths: ["server/db/schema.ts"],
          });
        case "spec":
          return spec;
        case "report":
          return report(1);
        case "verdict":
          return verdict("pass");
      }
    },
    sessionFor: plannerSessions,
    question: () => ({
      type: "answered",
      answers: {
        "fork:0:storage": ["SQLite"],
        "confirm:irreversible": ["Approve"],
      },
    }),
  });
  const result = (await runWith(service, {
    idea: "Add offline sync for notes",
    maxRounds: 2,
  })) as Implemented;

  expect(questionCalls).toHaveLength(1);
  const asked = questionCalls[0]!;
  expect(asked.questions.map((item) => item.id)).toEqual([
    "fork:0:storage",
    "confirm:irreversible",
  ]);
  expect(asked.questions[0]?.options.map((option) => option.label)).toEqual([
    "SQLite",
    "JSON file",
  ]);
  expect(result).toMatchObject({ status: "implemented" });
  expect(result.adjudicationResolution).toMatchObject({
    irreversibleConfirmed: true,
    forkDecisions: [{ id: "storage", chosen: ["SQLite"] }],
  });
  const specCall = calls.find((call) => call.kind === "spec");
  expect(asked.questions[1]?.question).toContain(
    "server/db/schema.ts (persistence schema)",
  );
  expect(specCall?.input.parts[0]).toMatchObject({
    type: "text",
    text: expect.stringContaining("SQLite"),
  });
});

test("skipping discrete adjudication escalates before implementation", async () => {
  const { service, calls, questionCalls } = makeService({
    respond: (call) => {
      switch (call.kind) {
        case "plan":
          return plan(call.side);
        case "critique":
          return emptyCritique;
        case "spine":
          return spine({
            normativeForks: [fork()],
            touchedPaths: ["server/db/schema.ts"],
          });
        default:
          throw new Error(`Unexpected ${call.kind}`);
      }
    },
    sessionFor: plannerSessions,
    question: () => ({ type: "skipped" }),
  });
  const result = (await runWith(service, {
    idea: "Add offline sync for notes",
    maxRounds: 2,
  })) as Escalated;

  expect(questionCalls).toHaveLength(1);
  expect(result).toMatchObject({
    status: "escalated",
    reason: "adjudication_required",
    triggers: { irreversibleSurfaces: true, normativeForks: true },
  });
  expect(
    calls.some(
      (call) =>
        call.kind === "spec" ||
        call.kind === "report" ||
        call.kind === "verdict",
    ),
  ).toBe(false);
});

test("declining the irreversible confirmation escalates cleanly", async () => {
  const { service, calls } = makeService({
    respond: (call) => {
      switch (call.kind) {
        case "plan":
          return plan(call.side);
        case "critique":
          return emptyCritique;
        case "spine":
          return spine({ touchedPaths: ["server/db/schema.ts"] });
        default:
          throw new Error(`Unexpected ${call.kind}`);
      }
    },
    sessionFor: plannerSessions,
    question: () => ({
      type: "answered",
      answers: { "confirm:irreversible": ["Escalate"] },
    }),
  });
  const result = (await runWith(service, {
    idea: "Add offline sync for notes",
    maxRounds: 2,
  })) as Escalated;

  expect(result).toMatchObject({
    status: "escalated",
    reason: "adjudication_required",
    triggers: { irreversibleSurfaces: true },
  });
  expect(calls.some((call) => call.kind === "spec")).toBe(false);
});

test("unresolved blocking defects after maxRounds escalate without a question", async () => {
  const { service, calls, questionCalls } = makeService({
    respond: (call) => {
      switch (call.kind) {
        case "plan":
          return plan(call.side);
        case "critique":
          return { agreements: [], issues: [defect()] };
        case "spine":
          return spine();
        default:
          throw new Error(`Unexpected ${call.kind}`);
      }
    },
    sessionFor: plannerSessions,
    question: () => ({ type: "skipped" }),
  });
  const result = (await runWith(service, {
    idea: "Add offline sync for notes",
    maxRounds: 1,
  })) as Escalated;

  expect(questionCalls).toHaveLength(0);
  expect(result).toMatchObject({
    status: "escalated",
    reason: "adjudication_required",
    roundsCompleted: 1,
    triggers: { unresolvedBlockingDefects: true },
  });
  expect(result.adjudication.blockingDefects).toHaveLength(1);
  expect(calls.some((call) => call.kind === "spec")).toBe(false);
});

test("an execution failure retries once on the same implementer session", async () => {
  const { service, calls } = makeService({
    respond: (call) => {
      switch (call.kind) {
        case "plan":
          return plan(call.side);
        case "critique":
          return emptyCritique;
        case "spine":
          return spine();
        case "spec":
          return spec;
        case "report":
          return report(1);
        case "verdict":
          return calls.filter((item) => item.kind === "verdict").length === 1
            ? verdict("execution_failure")
            : verdict("pass");
      }
    },
    sessionFor: plannerSessions,
  });
  const result = (await runWith(service, {
    idea: "Add offline sync for notes",
    maxRounds: 2,
  })) as Implemented;

  expect(result).toMatchObject({
    status: "implemented",
    implementationAttempts: 2,
  });
  const reports = calls.filter((call) => call.kind === "report");
  expect(reports).toHaveLength(2);
  const firstSession = `child-${reports[0]!.index}`;
  expect(reports[1]?.sessionId).toBe(firstSession);
  const verifies = calls.filter((call) => call.kind === "verdict");
  expect(verifies).toHaveLength(2);
  expect(verifies[1]?.sessionId).toBe(`child-${verifies[0]!.index}`);
});

test("a plan failure escalates immediately without a retry", async () => {
  const { service, calls } = makeService({
    respond: (call) => {
      switch (call.kind) {
        case "plan":
          return plan(call.side);
        case "critique":
          return emptyCritique;
        case "spine":
          return spine();
        case "spec":
          return spec;
        case "report":
          return report(1);
        case "verdict":
          return verdict("plan_failure");
      }
    },
    sessionFor: plannerSessions,
  });
  const result = (await runWith(service, {
    idea: "Add offline sync for notes",
    maxRounds: 2,
  })) as Escalated & { implementationAttempts: number };

  expect(result).toMatchObject({
    status: "escalated",
    reason: "verification_failed",
    implementationAttempts: 1,
  });
  expect(calls.filter((call) => call.kind === "report")).toHaveLength(1);
});

test.each([true, false])(
  "fork-only adjudication preserves IDs and records no irreversible confirmation (answered=%s)",
  async (answered) => {
    const { service, calls, questionCalls } = makeService({
      respond: (call) => {
        switch (call.kind) {
          case "plan":
            return plan(call.side);
          case "critique":
            return emptyCritique;
          case "spine":
            return spine({ normativeForks: [fork()] });
          case "spec":
            return spec;
          case "report":
            return report(1);
          case "verdict":
            return verdict("pass");
        }
      },
      sessionFor: plannerSessions,
      question: (): QuestionReply =>
        answered
          ? { type: "answered", answers: { "fork:0:storage": ["SQLite"] } }
          : { type: "answered", answers: {} },
    });
    const result = await runWith(service, {
      idea: "Choose note storage",
      maxRounds: 1,
    });
    expect(questionCalls[0]?.questions.map(({ id }) => id)).toEqual([
      "fork:0:storage",
    ]);
    if (answered) {
      expect(result).toMatchObject({
        status: "implemented",
        adjudicationResolution: {
          forkDecisions: [{ id: "storage", chosen: ["SQLite"] }],
          irreversibleConfirmed: false,
        },
      });
      expect(
        calls.find((call) => call.kind === "spec")?.input.parts[0],
      ).toMatchObject({
        text: expect.stringContaining('"irreversibleConfirmed":false'),
      });
    } else {
      expect(result).toMatchObject({
        status: "escalated",
        reason: "adjudication_required",
      });
      expect(calls.some((call) => call.kind === "spec")).toBe(false);
    }
  },
);

test("a public contract in either plan requires confirmation even if the distiller omits it", async () => {
  const { service, questionCalls } = makeService({
    respond: (call) => {
      switch (call.kind) {
        case "plan":
          return {
            ...plan(call.side),
            publicContracts: call.side === "B" ? ["Workflow.question"] : [],
          };
        case "critique":
          return emptyCritique;
        case "spine":
          return spine();
        default:
          throw new Error(`Unexpected ${call.kind}`);
      }
    },
    sessionFor: plannerSessions,
    question: () => ({ type: "skipped" }),
  });
  expect(
    await runWith(service, { idea: "Add workflow questions", maxRounds: 1 }),
  ).toMatchObject({
    status: "escalated",
    triggers: { irreversibleSurfaces: true },
  });
  expect(questionCalls[0]?.questions[0]?.question).toContain(
    "public contract: Workflow.question",
  );
});
