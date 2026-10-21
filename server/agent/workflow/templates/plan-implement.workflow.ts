// Purpose: Plans a concept with two independent models, debates defects, adjudicates forks, then implements and verifies.

import {
  agent,
  AgentPromptModel,
  CLAUDE_CODE,
  CODEX,
  defineWorkflow,
  Effect,
  phase,
  question,
  Schema,
  textPrompt,
  TIER3,
  TIER4,
  type ProviderQuestion,
  type QuestionInput,
} from "@openchart/workflow";

/** Arguments validated by this file before execution. */
const planImplementArgs = Schema.Struct({
  idea: Schema.String.check(Schema.isMinLength(1)),
  maxRounds: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});

/** Repo paths whose modification is high-impact and needs explicit approval. */
const IRREVERSIBLE_PATH_PATTERNS = [
  {
    pattern: /(^|\/)(migrations?|drizzle)(\/|$)/i,
    reason: "database migration directory",
  },
  { pattern: /\.(sql|prisma)$/i, reason: "database definition" },
  { pattern: /(^|\/)schema\.ts$/i, reason: "persistence schema" },
  { pattern: /(^|\/)contracts(\/|$)/i, reason: "shared contract" },
  { pattern: /(^|\/)common\/models(\/|$)/i, reason: "shared model protocol" },
  { pattern: /(^|\/)package\.json$/i, reason: "package manifest" },
];

const Text = Schema.String.check(Schema.isMinLength(1));
const Step = Schema.Struct({
  title: Text,
  details: Text,
  files: Schema.Array(Schema.String),
});
const Plan = Schema.Struct({
  summary: Text,
  approach: Text,
  steps: Schema.Array(Step).check(Schema.isMinLength(1)),
  touchedPaths: Schema.Array(Schema.String),
  publicContracts: Schema.Array(Schema.String),
  assumptions: Schema.Array(Schema.String),
  risks: Schema.Array(Schema.String),
});
const CritiqueIssue = Schema.Struct({
  id: Text,
  kind: Schema.Literals(["technical_defect", "normative_fork"]),
  severity: Schema.Literals(["blocking", "non_blocking"]),
  summary: Text,
  rationale: Text,
  options: Schema.Array(Schema.String),
});
const Critique = Schema.Struct({
  agreements: Schema.Array(Schema.String),
  issues: Schema.Array(CritiqueIssue),
});
const DistilledSpine = Schema.Struct({
  summary: Text,
  agreedSteps: Schema.Array(Step).check(Schema.isMinLength(1)),
  touchedPaths: Schema.Array(Schema.String),
  publicContracts: Schema.Array(Schema.String),
  unresolvedDefects: Schema.Array(CritiqueIssue),
  normativeForks: Schema.Array(CritiqueIssue),
});
const ExecutionSpec = Schema.Struct({
  objective: Text,
  steps: Schema.Array(Step).check(Schema.isMinLength(1)),
  touchedPaths: Schema.Array(Schema.String),
  invariants: Schema.Array(Schema.String),
  verificationCommands: Schema.Array(Text).check(Schema.isMinLength(1)),
});
const ImplementationReport = Schema.Struct({
  summary: Text,
  changedFiles: Schema.Array(Schema.String),
  notes: Schema.Array(Schema.String),
});
const VerificationVerdict = Schema.Struct({
  status: Schema.Literals(["pass", "execution_failure", "plan_failure"]),
  summary: Text,
  failures: Schema.Array(Schema.String),
});

type Plan = typeof Plan.Type;
type Critique = typeof Critique.Type;
type CritiqueIssue = typeof CritiqueIssue.Type;
type DistilledSpine = typeof DistilledSpine.Type;
type ExecutionSpec = typeof ExecutionSpec.Type;
type ImplementationReport = typeof ImplementationReport.Type;
type VerificationVerdict = typeof VerificationVerdict.Type;

type AdjudicationResolution = {
  readonly forkDecisions: readonly {
    readonly id: string;
    readonly summary: string;
    readonly chosen: readonly string[];
  }[];
  readonly irreversibleConfirmed: boolean;
};

/** One implementation attempt plus at most one retry after an execution failure. */
const MAX_IMPLEMENTATION_ATTEMPTS = 2;

const RoleModels = Schema.Struct({
  plannerA: AgentPromptModel,
  plannerB: AgentPromptModel,
  coordinator: AgentPromptModel,
  implementer: AgentPromptModel,
  verifier: AgentPromptModel,
});
type Role = keyof typeof RoleModels.Type;

const roleQuestions = [
  {
    id: "plannerA",
    header: "Planner A",
    model: { providerID: CODEX, modelID: TIER4 },
    task: "Draft, critique and revise the first plan.",
  },
  {
    id: "plannerB",
    header: "Planner B",
    model: { providerID: CLAUDE_CODE, modelID: TIER4 },
    task: "Independently draft, critique and revise the second plan.",
  },
  {
    id: "coordinator",
    header: "Coordinator",
    model: { providerID: CODEX, modelID: TIER4 },
    task: "Reconcile the plans and compile the execution specification.",
  },
  {
    id: "implementer",
    header: "Implementer",
    model: { providerID: CODEX, modelID: TIER3 },
    task: "Implement the specification, including any retry.",
  },
  {
    id: "verifier",
    header: "Verifier",
    model: { providerID: CLAUDE_CODE, modelID: TIER4 },
    task: "Independently verify the implementation, including any retry.",
  },
] as const;

/** Collects explicit model and effort choices before any child starts; skip cancels. */
const chooseRoleModels = Effect.fn("PlanImplement.chooseRoleModels")(
  function* () {
    const selected: Partial<Record<Role, AgentPromptModel>> = {};
    let pending: QuestionInput["questions"] = roleQuestions.map((role) => ({
      id: role.id,
      header: role.header,
      question: role.task,
      modelSelection: role.model,
      options: [],
      multiple: false,
      allowFreeform: false,
      secret: false,
    }));
    while (pending.length > 0) {
      const reply = yield* question({ questions: pending });
      if (reply.type === "skipped") return undefined;
      const retry: QuestionInput["questions"][number][] = [];
      for (const request of pending) {
        const role = roleQuestions.find((role) => role.id === request.id)!;
        const answers = reply.answers[request.id];
        const result = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(AgentPromptModel),
        )(answers?.length === 1 ? answers[0] : undefined).pipe(Effect.result);
        if (result._tag === "Success") selected[role.id] = result.success;
        else retry.push(request);
      }
      pending = retry;
    }
    return yield* Schema.decodeUnknownEffect(RoleModels)(selected);
  },
);

function issueKey(issue: CritiqueIssue): string {
  return `${issue.id.trim().toLowerCase()}\u0000${issue.summary.trim().toLowerCase()}`;
}

function dedupeIssues(issues: readonly CritiqueIssue[]): CritiqueIssue[] {
  const seen = new Set<string>();
  const unique: CritiqueIssue[] = [];
  for (const issue of issues) {
    const key = issueKey(issue);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(issue);
  }
  return unique;
}

/** Blocking technical defects that survived critique; never settled by a choice. */
function blockingDefects(critiques: readonly Critique[]): CritiqueIssue[] {
  return dedupeIssues(
    critiques.flatMap((critique) =>
      critique.issues.filter(
        (issue) =>
          issue.kind === "technical_defect" && issue.severity === "blocking",
      ),
    ),
  );
}

/** Product/design forks that need a human decision, from critiques and the spine. */
function normativeForks(
  critiques: readonly Critique[],
  spine?: DistilledSpine,
): CritiqueIssue[] {
  return dedupeIssues([
    ...critiques.flatMap((critique) =>
      critique.issues.filter((issue) => issue.kind === "normative_fork"),
    ),
    ...(spine?.normativeForks ?? []),
  ]);
}

/** Union of plan and spine paths matching high-impact surfaces, plus public contracts. */
function detectIrreversibleSurfaces(
  plans: readonly Plan[],
  spine: DistilledSpine,
): string[] {
  const paths = new Set<string>();
  for (const plan of plans)
    for (const path of plan.touchedPaths) paths.add(path);
  for (const path of spine.touchedPaths) paths.add(path);
  const surfaces = new Set<string>();
  for (const path of paths) {
    const surface = IRREVERSIBLE_PATH_PATTERNS.find((candidate) =>
      candidate.pattern.test(path),
    );
    if (surface) surfaces.add(`${path} (${surface.reason})`);
  }
  for (const contract of [
    ...plans.flatMap((plan) => plan.publicContracts),
    ...spine.publicContracts,
  ])
    surfaces.add(`public contract: ${contract}`);
  return [...surfaces].sort();
}

/** One structured question per fork plus a single irreversible-surface confirmation. */
function buildAdjudicationQuestions(
  forks: readonly CritiqueIssue[],
  irreversible: readonly string[],
): QuestionInput {
  const questions: ProviderQuestion[] = forks.map((fork, index) => ({
    id: `fork:${index}:${fork.id}`,
    header: "Design fork",
    question: `${fork.summary}\n\n${fork.rationale}`,
    options:
      fork.options.length >= 2
        ? fork.options.map((option) => ({
            label: option,
            description: "Select this design direction",
          }))
        : [
            {
              label: "Planner A approach",
              description: "Follow Planner A's design for this fork",
            },
            {
              label: "Planner B approach",
              description: "Follow Planner B's design for this fork",
            },
          ],
    multiple: false,
    allowFreeform: true,
    secret: false,
  }));
  if (irreversible.length > 0)
    questions.push({
      id: "confirm:irreversible",
      header: "Irreversible changes",
      question: `Approve touching high-impact / irreversible surfaces?\n${irreversible
        .map((surface) => `- ${surface}`)
        .join("\n")}`,
      options: [
        {
          label: "Approve",
          description: "Proceed with implementation touching these surfaces",
        },
        {
          label: "Escalate",
          description: "Stop and return the adjudication packet for discussion",
        },
      ],
      multiple: false,
      allowFreeform: false,
      secret: false,
    });
  return { questions };
}

function planPrompt(side: string, idea: string): string {
  return [
    `You are Planner ${side}. Produce one independent implementation plan for the following concept.`,
    "Do not assume the other planner's work; reason from the concept and the repository's conventions.",
    "Call out the exact repo-relative paths you will create, modify, or delete, the public APIs/schemas/migrations/wire contracts you would change, and the assumptions and risks you cannot resolve from the concept alone.",
    `Concept:\n${idea}`,
  ].join("\n\n");
}

function critiquePrompt(plan: Plan): string {
  return [
    "Critique this plan rigorously. Classify every disagreement:",
    '- "technical_defect": an objective bug, race condition, broken invariant, missing edge case, or architecture violation. Set severity "blocking" only when it must be fixed before implementation.',
    '- "normative_fork": an underspecified product/design trade-off where both options are technically sound but the concept did not choose. List the concrete options.',
    "List genuine points of agreement separately. Do not invent defects or restyle the same point.",
    `Plan under review:\n${JSON.stringify(plan)}`,
  ].join("\n\n");
}

function revisePrompt(
  side: string,
  plan: Plan,
  defects: readonly CritiqueIssue[],
): string {
  return [
    `You are Planner ${side}. Revise only the blocking technical defects below.`,
    "Do not spend effort arguing normative forks: record each fork's options clearly and move on.",
    `Blocking technical defects:\n${JSON.stringify(defects)}`,
    `Your current plan:\n${JSON.stringify(plan)}`,
  ].join("\n\n");
}

function distillPrompt(
  idea: string,
  planA: Plan,
  planB: Plan,
  critiques: readonly Critique[],
): string {
  return [
    "Distill the two plans and their critiques into one agreed spine.",
    "agreedSteps must contain only steps both plans can accept. Move still-disagreed design choices into normativeForks, and any unresolved blocking technical defect into unresolvedDefects.",
    `Concept:\n${idea}`,
    `Planner A:\n${JSON.stringify(planA)}`,
    `Planner B:\n${JSON.stringify(planB)}`,
    `Critiques:\n${JSON.stringify(critiques)}`,
  ].join("\n\n");
}

function specPrompt(
  idea: string,
  spine: DistilledSpine,
  planA: Plan,
  planB: Plan,
  resolution: AdjudicationResolution | null,
): string {
  return [
    "Compile a concrete execution spec from the agreed spine. Include the exact steps, touched paths, invariants, and the shell verification commands a reviewer will run.",
    resolution
      ? `Honor these human adjudication decisions and bake them into steps and invariants:\n${JSON.stringify(resolution)}`
      : "No human forks remain; follow the agreed spine directly.",
    `Concept:\n${idea}`,
    `Spine:\n${JSON.stringify(spine)}`,
    `Planner A:\n${JSON.stringify(planA)}`,
    `Planner B:\n${JSON.stringify(planB)}`,
  ].join("\n\n");
}

function implementPrompt(
  spec: ExecutionSpec,
  attempt: number,
  feedback: string,
): string {
  return [
    `Implement the execution spec. This is attempt ${attempt}.`,
    feedback
      ? `The previous attempt failed verification; address every failure:\n${feedback}`
      : "Make the changes and report what you changed.",
    `Execution spec:\n${JSON.stringify(spec)}`,
  ].join("\n\n");
}

function verifyPrompt(
  spec: ExecutionSpec,
  report: ImplementationReport,
): string {
  return [
    "Independently verify the implementation against the spec and invariants. Run the verification commands and inspect the changed files.",
    'Return "pass" only when the spec is satisfied. Use "execution_failure" when the implementation is incomplete or a command fails. Use "plan_failure" when the spec itself cannot work.',
    `Execution spec:\n${JSON.stringify(spec)}`,
    `Implementation report:\n${JSON.stringify(report)}`,
  ].join("\n\n");
}

/** Plans, debates, adjudicates, implements, and verifies one concept. */
export default defineWorkflow({
  description:
    "Accepts {idea: non-empty string, maxRounds: positive integer}. Before starting any child, asks the user to choose models or tiers for plannerA, plannerB, coordinator, implementer and verifier. Skip cancels without running agents. Defaults are Codex tier4 and Claude Code tier4 planners, a Codex tier4 coordinator, a Codex tier3 implementer, and a Claude Code tier4 verifier. Two independent planners cross-critique, run a bounded technical-defect debate, distill an agreed spine, adjudicate design forks or irreversible surfaces with the user in-process, then compile a spec, implement it, and independently verify it using the selected roles.",
  args: planImplementArgs,
  run: ({ idea, maxRounds }, { parentPrompt }) =>
    Effect.gen(function* () {
      const profile = parentPrompt.agent;
      const models = yield* phase("Choose role models", chooseRoleModels());
      if (!models) {
        const cancelled: Schema.JsonObject = {
          status: "cancelled",
          reason: "model_selection_skipped",
        };
        return cancelled;
      }
      const { plannerA, plannerB, coordinator, implementer, verifier } = models;

      const planPhase = yield* phase(
        "plan",
        Effect.all(
          [
            agent(textPrompt(planPrompt("A", idea), plannerA, profile), {
              schema: Plan,
              label: "Planner A",
            }),
            agent(textPrompt(planPrompt("B", idea), plannerB, profile), {
              schema: Plan,
              label: "Planner B",
            }),
          ],
          { concurrency: "unbounded" },
        ),
      );
      const [planAResult, planBResult] = planPhase;
      let planA: Plan = planAResult.output;
      let planB: Plan = planBResult.output;

      const critiquePhase = yield* phase(
        "critique",
        Effect.all(
          [
            agent(textPrompt(critiquePrompt(planB), plannerA, profile), {
              schema: Critique,
              sessionId: planAResult.sessionId,
              label: "Critique B",
            }),
            agent(textPrompt(critiquePrompt(planA), plannerB, profile), {
              schema: Critique,
              sessionId: planBResult.sessionId,
              label: "Critique A",
            }),
          ],
          { concurrency: "unbounded" },
        ),
      );
      let critiques: Critique[] = critiquePhase.map((result) => result.output);

      let roundsCompleted = 0;
      while (
        blockingDefects(critiques).length > 0 &&
        roundsCompleted < maxRounds
      ) {
        const round = roundsCompleted + 1;
        // A critiques B first; B critiques A second. Each planner receives only
        // the blocking technical defects raised against its own plan.
        const defectsA = blockingDefects([critiques[1]!]);
        const defectsB = blockingDefects([critiques[0]!]);
        critiques = yield* phase(
          `debate-round-${round}`,
          Effect.gen(function* () {
            const revised = yield* Effect.all(
              [
                agent(
                  textPrompt(
                    revisePrompt("A", planA, defectsA),
                    plannerA,
                    profile,
                  ),
                  {
                    schema: Plan,
                    sessionId: planAResult.sessionId,
                    label: `Revise A round ${round}`,
                  },
                ),
                agent(
                  textPrompt(
                    revisePrompt("B", planB, defectsB),
                    plannerB,
                    profile,
                  ),
                  {
                    schema: Plan,
                    sessionId: planBResult.sessionId,
                    label: `Revise B round ${round}`,
                  },
                ),
              ],
              { concurrency: "unbounded" },
            );
            planA = revised[0].output;
            planB = revised[1].output;
            const recritiques = yield* Effect.all(
              [
                agent(textPrompt(critiquePrompt(planB), plannerA, profile), {
                  schema: Critique,
                  sessionId: planAResult.sessionId,
                  label: `Re-critique B round ${round}`,
                }),
                agent(textPrompt(critiquePrompt(planA), plannerB, profile), {
                  schema: Critique,
                  sessionId: planBResult.sessionId,
                  label: `Re-critique A round ${round}`,
                }),
              ],
              { concurrency: "unbounded" },
            );
            return recritiques.map((result) => result.output);
          }),
        );
        roundsCompleted++;
      }

      const distilled = yield* phase(
        "distill",
        agent(
          textPrompt(
            distillPrompt(idea, planA, planB, critiques),
            coordinator,
            profile,
          ),
          { schema: DistilledSpine, label: "Distill spine" },
        ),
      );
      const spine = distilled.output;
      const unresolved = dedupeIssues([
        ...blockingDefects(critiques),
        ...spine.unresolvedDefects.filter(
          (issue) =>
            issue.kind === "technical_defect" && issue.severity === "blocking",
        ),
      ]);
      const forks = normativeForks(critiques, spine);
      const irreversible = detectIrreversibleSurfaces([planA, planB], spine);

      const escalate = (
        reason: "adjudication_required" | "verification_failed",
      ) => ({
        status: "escalated" as const,
        models,
        reason,
        roundsCompleted,
        triggers: {
          normativeForks: forks.length > 0,
          unresolvedBlockingDefects: unresolved.length > 0,
          irreversibleSurfaces: irreversible.length > 0,
        },
        adjudication: {
          spine,
          plans: { plannerA: planA, plannerB: planB },
          blockingDefects: unresolved,
          normativeForks: forks,
          irreversibleSurfaces: irreversible,
        },
        sessions: {
          plannerA: planAResult.sessionId,
          plannerB: planBResult.sessionId,
          distiller: distilled.sessionId,
        },
      });

      if (unresolved.length > 0) return escalate("adjudication_required");

      let adjudicationResolution: AdjudicationResolution | null = null;
      if (forks.length > 0 || irreversible.length > 0) {
        const questionInput = buildAdjudicationQuestions(forks, irreversible);
        const reply = yield* phase("adjudicate", question(questionInput));
        if (reply.type !== "answered") return escalate("adjudication_required");
        const answers = reply.answers;
        const forkDecisions = forks.map((fork, index) => ({
          id: fork.id,
          summary: fork.summary,
          chosen: answers[`fork:${index}:${fork.id}`] ?? [],
        }));
        const declined =
          irreversible.length > 0 &&
          answers["confirm:irreversible"]?.[0] !== "Approve";
        const unanswered = forkDecisions.some(
          (decision) => decision.chosen.length === 0,
        );
        if (declined || unanswered) return escalate("adjudication_required");
        adjudicationResolution = {
          forkDecisions,
          irreversibleConfirmed: irreversible.length > 0,
        };
      }

      const specResult = yield* phase(
        "compile-spec",
        agent(
          textPrompt(
            specPrompt(idea, spine, planA, planB, adjudicationResolution),
            coordinator,
            profile,
          ),
          {
            schema: ExecutionSpec,
            sessionId: distilled.sessionId,
            label: "Compile execution spec",
          },
        ),
      );
      const spec = specResult.output;

      let implementerSessionId: string | undefined;
      let verifierSessionId: string | undefined;
      let verificationFeedback = "";
      for (let attempt = 1; attempt <= MAX_IMPLEMENTATION_ATTEMPTS; attempt++) {
        const suffix = attempt === 1 ? "" : `-retry-${attempt - 1}`;
        const implementationResult = yield* phase(
          `implement${suffix}`,
          agent(
            textPrompt(
              implementPrompt(spec, attempt, verificationFeedback),
              implementer,
              profile,
            ),
            {
              schema: ImplementationReport,
              sessionId: implementerSessionId,
              label:
                attempt === 1 ? "Implement" : `Implement retry ${attempt - 1}`,
            },
          ),
        );
        implementerSessionId = implementationResult.sessionId;
        const implementation = implementationResult.output;

        const verificationResult = yield* phase(
          `verify${suffix}`,
          agent(
            textPrompt(verifyPrompt(spec, implementation), verifier, profile),
            {
              schema: VerificationVerdict,
              sessionId: verifierSessionId,
              label: attempt === 1 ? "Verify" : `Verify retry ${attempt - 1}`,
            },
          ),
        );
        verifierSessionId = verificationResult.sessionId;
        const verdict: VerificationVerdict = verificationResult.output;

        if (verdict.status === "pass")
          return {
            status: "implemented" as const,
            models,
            roundsCompleted,
            implementationAttempts: attempt,
            adjudicationResolution,
            spec,
            implementation,
            verification: verdict,
            sessions: {
              plannerA: planAResult.sessionId,
              plannerB: planBResult.sessionId,
              distiller: distilled.sessionId,
              specCompiler: specResult.sessionId,
              implementer: implementerSessionId,
              verifier: verifierSessionId,
            },
          };
        if (
          verdict.status === "plan_failure" ||
          attempt === MAX_IMPLEMENTATION_ATTEMPTS
        ) {
          const escalated = escalate("verification_failed");
          return {
            ...escalated,
            implementationAttempts: attempt,
            adjudicationResolution,
            spec,
            implementation,
            verification: verdict,
            sessions: {
              ...escalated.sessions,
              specCompiler: specResult.sessionId,
              implementer: implementerSessionId,
              verifier: verifierSessionId,
            },
          };
        }
        verificationFeedback = verdict.failures.join("\n");
      }
      return yield* Effect.die("Unreachable implementation attempt loop");
    }),
});
