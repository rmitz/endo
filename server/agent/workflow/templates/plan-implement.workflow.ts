// Purpose: Races two frontier planners on one idea, reconciles their plans, and hands a distilled spec to a lower-tier implementer with verification and escalation gates.

import {
  agent,
  CLAUDE_CODE,
  CODEX,
  defineWorkflow,
  Effect,
  parallel,
  phase,
  Schema,
  textPrompt,
  TIER3,
  TIER5,
  type AgentResult,
} from "@openchart/workflow";

const Text = Schema.String.check(Schema.isPattern(/\S/));

/** Arguments validated by this file before execution. */
const planImplementArgs = Schema.Struct({
  idea: Text,
  maxRounds: Schema.Int.check(Schema.isGreaterThan(0)),
});

const Fork = Schema.Struct({
  question: Text,
  options: Schema.Array(Text).check(Schema.isMinLength(2)),
  recommendation: Text,
});

const Plan = Schema.Struct({
  approach: Text,
  touchedPaths: Schema.Array(Text),
  publicContracts: Schema.Array(Text),
  acceptanceTests: Schema.Array(Text),
  forks: Schema.Array(Fork),
});

const Critique = Schema.Struct({
  defects: Schema.Array(
    Schema.Struct({
      description: Text,
      evidence: Schema.Array(Text),
      blocking: Schema.Boolean,
    }),
  ),
});

const Defect = Schema.Struct({
  description: Text,
  evidence: Schema.Array(Text),
});

const Reconciliation = Schema.Struct({
  spine: Text,
  adopted: Schema.Literals(["A", "B", "blend"]),
  blockingDefects: Schema.Array(Defect),
  forks: Schema.Array(Fork),
  touchedPaths: Schema.Array(Text),
  publicContracts: Schema.Array(Text),
});

const Spec = Schema.Struct({
  instructions: Text,
  touchedPaths: Schema.Array(Text),
  tests: Schema.Array(Text),
});

const Implementation = Schema.Struct({
  summary: Text,
  filesChanged: Schema.Array(Text),
  testsPassed: Schema.Boolean,
  failures: Schema.Array(Text),
});

const Verdict = Schema.Struct({
  verdict: Schema.Literals(["pass", "execution_failure", "plan_failure"]),
  notes: Text,
});

/** Deterministic screen for surfaces whose change is hard to reverse; public contracts always escalate regardless. */
const IRREVERSIBLE_PATH =
  /(^|\/)(schema|migration|contract)|(^|\/)resources\/|\.sql$/i;

/** Implementation attempts before verification failures escalate back to the user. */
const IMPLEMENTATION_ATTEMPTS = 2;

/** Two planners race, cross-critique, and converge; unresolved decisions escalate instead of implementing. */
export default defineWorkflow({
  description:
    "Accepts {idea: string, maxRounds: positive integer}. Two planners draft independent, repository-grounded plans using the parent prompt model and one other frontier provider, cross-critique each other, and a neutral arbiter reconciles them through at most maxRounds revision rounds. Unsettled decisions, unresolved blocking defects, or irreversible surfaces escalate back to the user instead of implementing. Otherwise the arbiter compiles a self-contained execution spec, a tier-3 implementer builds and tests it, and verification classifies each failure as an execution or plan error before retrying or escalating.",
  args: planImplementArgs,
  run: ({ idea, maxRounds }, { parentPrompt }) =>
    Effect.gen(function* () {
      // Vendor-diverse second planner; same provider as the parent when it is codex.
      const secondPlannerModel =
        parentPrompt.model.providerID === CODEX
          ? { providerID: CLAUDE_CODE, modelID: TIER5 }
          : { providerID: CODEX, modelID: TIER5 };
      const implementerModel = {
        providerID: parentPrompt.model.providerID,
        modelID: TIER3,
      };

      const context = [
        `Idea: ${idea}`,
        "This idea was already refined with the user; treat it as settled intent and do not relitigate its goals. Ground every claim in this repository: inspect the relevant code before proposing changes, and distinguish facts about the codebase from assumptions.",
        "Identify concretely what would change: list the file paths that would be touched and every public API, schema, or persisted format whose shape would change (leave publicContracts empty when none). Express verification as concrete, runnable acceptance tests.",
        "List as forks only decisions the idea does not settle that change the product or architecture, each with at least two options and your recommended default. Do not pad: choices an implementer can make alone are not forks.",
      ].join("\n\n");

      const planPrompt = (planner: string) =>
        `You are planner ${planner} in an independent two-planner design race. Produce a complete, grounded implementation plan for the idea. Do not ask questions; record open decisions as forks instead.\n\n${context}`;
      const planOutcomes = yield* phase(
        "Plan",
        parallel([
          agent(
            textPrompt(planPrompt("A"), parentPrompt.model, parentPrompt.agent),
            { schema: Plan, label: "Planner A" },
          ),
          agent(
            textPrompt(planPrompt("B"), secondPlannerModel, parentPrompt.agent),
            { schema: Plan, label: "Planner B" },
          ),
        ]),
      );
      const plannerAOutcome = planOutcomes[0]!;
      if (plannerAOutcome.status === "error")
        return yield* Effect.fail(plannerAOutcome.error);
      const plannerBOutcome = planOutcomes[1]!;
      let planA: AgentResult<typeof Plan.Type> = plannerAOutcome.value;
      let planB: AgentResult<typeof Plan.Type> | null =
        plannerBOutcome.status === "success" ? plannerBOutcome.value : null;
      const solo = planB === null;
      const notes: string[] = solo
        ? [
            "Planner B (the second provider) failed before producing a plan; planning continued with planner A alone under adversarial arbiter review.",
          ]
        : [];

      const plansJson = () =>
        JSON.stringify({ A: planA.output, B: planB ? planB.output : null });

      const critiques: string[] = [];
      if (planB) {
        const critiquePrompt = (mine: string, other: string) =>
          `You drafted plan ${mine}. Review plan ${other} from the competing planner. Find defects that matter: incorrect assumptions about this codebase, missed constraints, broken boundaries, or designs that would not compile or integrate. Inspect the code wherever a claim depends on it. Mark a defect blocking only when implementing plan ${other} as written would fail or violate the idea. Report defects about the other plan only, never about your own, do not pad the list, and report zero defects when the plan is sound.`;
        const critiqueOutcomes = yield* phase(
          "Cross-critique",
          parallel([
            agent(
              textPrompt(
                `${critiquePrompt("A", "B")}\n\nPlan B:\n${JSON.stringify(planB.output)}`,
                parentPrompt.model,
                parentPrompt.agent,
              ),
              {
                schema: Critique,
                sessionId: planA.sessionId,
                label: "Planner A critiques plan B",
              },
            ),
            agent(
              textPrompt(
                `${critiquePrompt("B", "A")}\n\nPlan A:\n${JSON.stringify(planA.output)}`,
                secondPlannerModel,
                parentPrompt.agent,
              ),
              {
                schema: Critique,
                sessionId: planB.sessionId,
                label: "Planner B critiques plan A",
              },
            ),
          ]),
        );
        for (const outcome of critiqueOutcomes) {
          if (outcome.status === "success")
            critiques.push(JSON.stringify(outcome.value.output));
        }
      }

      const reconcilePrompt = [
        "You are a neutral arbiter reconciling independently drafted plans for the same idea. Identify the agreed spine: the approach the plans share. Choose adopted as A, B, or blend, and justify the choice in the spine.",
        "Classify every substantive disagreement. A technical defect — a plan is wrong about this codebase or would fail — belongs in blockingDefects with concrete evidence. A decision the idea does not settle and that changes the product or architecture is a fork: record it under forks with at least two options and your recommended default. Never decide a fork yourself, and never let one planner's preference settle it silently.",
        "Do not force convergence. If a defect cannot be resolved from the available evidence, keep it blocking rather than hiding it or splitting the difference. In touchedPaths and publicContracts, describe the surfaces of the adopted approach: union the paths that would change and list every public API, schema, or persisted format whose shape would change, empty when none.",
        solo
          ? "The second planner failed to produce a plan, so you are reviewing one plan alone. Act as its adversarial reviewer: identify blocking defects and forks yourself under the same rules."
          : "Both plans and the planners' mutual critiques follow.",
        `Idea context:\n${context}`,
        `Plans: ${plansJson()}`,
        critiques.length > 0 ? `Critiques:\n${critiques.join("\n\n")}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      const initialReconciliation = yield* phase(
        "Reconcile plans",
        agent(
          textPrompt(reconcilePrompt, parentPrompt.model, parentPrompt.agent),
          { schema: Reconciliation, label: "Reconcile plans" },
        ),
      );
      let reconciliation: AgentResult<typeof Reconciliation.Type> =
        initialReconciliation;
      const arbiterSessionId = initialReconciliation.sessionId;

      for (
        let round = 1;
        round <= maxRounds && reconciliation.output.blockingDefects.length > 0;
        round++
      ) {
        const defects = JSON.stringify(reconciliation.output.blockingDefects);
        const revisionPrompt = (label: string, competitor: string | null) =>
          `The arbiter found blocking defects in plan ${label}. Revise your plan to resolve each defect while preserving the idea's intent; adopt the competing plan's approach where its evidence is stronger, and keep forks unchanged. Inspect the code wherever a defect disputes your assumptions, and return the complete updated plan.${competitor ? `\n\nCompeting plan:\n${competitor}` : ""}\n\nBlocking defects:\n${defects}`;
        const revisionOutcomes = yield* phase(
          `Revise plans ${round}`,
          parallel([
            agent(
              textPrompt(
                revisionPrompt(
                  "A",
                  planB ? JSON.stringify(planB.output) : null,
                ),
                parentPrompt.model,
                parentPrompt.agent,
              ),
              {
                schema: Plan,
                sessionId: planA.sessionId,
                label: `Planner A revises ${round}`,
              },
            ),
            ...(planB
              ? [
                  agent(
                    textPrompt(
                      revisionPrompt("B", JSON.stringify(planA.output)),
                      secondPlannerModel,
                      parentPrompt.agent,
                    ),
                    {
                      schema: Plan,
                      sessionId: planB.sessionId,
                      label: `Planner B revises ${round}`,
                    },
                  ),
                ]
              : []),
          ]),
        );
        const revisedA = revisionOutcomes[0]!;
        if (revisedA.status === "success") planA = revisedA.value;
        if (planB) {
          const revisedB = revisionOutcomes[1]!;
          if (revisedB.status === "success") planB = revisedB.value;
        }
        reconciliation = yield* phase(
          `Reconcile plans ${round}`,
          agent(
            textPrompt(
              [
                `Re-reconcile after revision round ${round}. The planners updated their plans to resolve the blocking defects. Apply the same rules as before: record only defects that remain unresolved as blocking, never decide forks, and do not force convergence when the evidence does not support it.`,
                `Updated plans: ${plansJson()}`,
              ].join("\n\n"),
              parentPrompt.model,
              parentPrompt.agent,
            ),
            {
              schema: Reconciliation,
              sessionId: arbiterSessionId,
              label: `Reconcile plans ${round}`,
            },
          ),
        );
      }

      const reasons: string[] = [];
      if (reconciliation.output.forks.length > 0)
        reasons.push(
          `The idea does not settle ${reconciliation.output.forks.length} decision(s) that change the product or architecture; the planners and arbiter must not decide them for you.`,
        );
      if (reconciliation.output.blockingDefects.length > 0)
        reasons.push(
          `Blocking defects remained after ${maxRounds} revision round(s); the plans may not be implementable as proposed.`,
        );
      const irreversible =
        reconciliation.output.publicContracts.length > 0 ||
        reconciliation.output.touchedPaths.some((path) =>
          IRREVERSIBLE_PATH.test(path),
        );
      if (irreversible)
        reasons.push(
          "The plan changes public contracts, schemas, migrations, or other irreversible surfaces; confirm the approach before implementation.",
        );
      const plans = { A: planA, B: planB };
      // Every branch returns the same keys so the union stays JSON-shaped.
      if (reasons.length > 0)
        return {
          status: "escalated",
          idea,
          notes,
          reasons,
          plans,
          reconciliation,
          spec: null,
          implementation: null,
          verdict: null,
        };

      const spec = yield* phase(
        "Execution spec",
        agent(
          textPrompt(
            [
              "Compile the reconciled plan into an execution spec for an implementer who receives nothing else: no idea discussion, no alternatives, no critique narrative. The spec must be complete and self-contained — what to build, which files to change and how, the interfaces and constraints observed in this codebase, and the acceptance tests as concrete runnable checks. Exclude all deliberation.",
              `Idea: ${idea}`,
              `Reconciliation: ${JSON.stringify(reconciliation.output)}`,
              `Plan A: ${JSON.stringify(planA.output)}`,
              planB ? `Plan B: ${JSON.stringify(planB.output)}` : "",
            ]
              .filter(Boolean)
              .join("\n\n"),
            parentPrompt.model,
            parentPrompt.agent,
          ),
          {
            schema: Spec,
            sessionId: arbiterSessionId,
            label: "Compile execution spec",
          },
        ),
      );
      const specJson = JSON.stringify(spec.output);
      const verifyPrompt = (report: string) =>
        [
          "Verify the implementation against the execution spec. Inspect the changed code and run the spec's acceptance tests where they are runnable. Do not modify code.",
          "Classify: pass when the implementation follows the spec and its tests succeed; execution_failure when the spec is sound but the implementation does not follow it or the failures are implementer mistakes; plan_failure when the spec itself is wrong, infeasible in this codebase, or its acceptance tests are unrunnable as written. Explain in notes with concrete file references.",
          `Execution spec: ${specJson}`,
          `Implementer report: ${report}`,
        ].join("\n\n");

      let implementation = yield* phase(
        "Implement",
        agent(
          textPrompt(
            [
              "Implement the attached execution spec exactly. Make only the changes the spec describes, follow the codebase's existing patterns, and run the spec's acceptance tests plus the project's own build and test commands for the affected areas. Report testsPassed honestly and list every failure verbatim in failures; never mark testsPassed true while failures remain.",
              `Execution spec: ${specJson}`,
            ].join("\n\n"),
            implementerModel,
            parentPrompt.agent,
          ),
          { schema: Implementation, label: "Implement" },
        ),
      );
      let verdict = yield* phase(
        "Verify",
        agent(
          textPrompt(
            verifyPrompt(JSON.stringify(implementation.output)),
            parentPrompt.model,
            parentPrompt.agent,
          ),
          { schema: Verdict, label: "Verify" },
        ),
      );
      for (
        let attempt = 2;
        attempt <= IMPLEMENTATION_ATTEMPTS &&
        verdict.output.verdict === "execution_failure";
        attempt++
      ) {
        implementation = yield* phase(
          `Implement ${attempt}`,
          agent(
            textPrompt(
              [
                "Your previous attempt failed verification. Repair the implementation without changing the spec's intent, then rerun the relevant tests and report again. Report testsPassed honestly and list every failure verbatim in failures.",
                `Execution spec: ${specJson}`,
                `Verification notes: ${verdict.output.notes}`,
                `Previous result: ${JSON.stringify(implementation.output)}`,
              ].join("\n\n"),
              implementerModel,
              parentPrompt.agent,
            ),
            {
              schema: Implementation,
              sessionId: implementation.sessionId,
              label: `Implement ${attempt}`,
            },
          ),
        );
        verdict = yield* phase(
          `Verify ${attempt}`,
          agent(
            textPrompt(
              verifyPrompt(JSON.stringify(implementation.output)),
              parentPrompt.model,
              parentPrompt.agent,
            ),
            { schema: Verdict, label: `Verify ${attempt}` },
          ),
        );
      }

      if (verdict.output.verdict === "pass")
        return {
          status: "implemented",
          idea,
          notes,
          reasons: [],
          plans,
          reconciliation,
          spec,
          implementation,
          verdict,
        };
      return {
        status: "escalated",
        idea,
        notes,
        reasons: [
          verdict.output.verdict === "plan_failure"
            ? "Verification judged the plan itself flawed rather than the implementation; the approach needs a human decision."
            : `Implementation failed verification after ${IMPLEMENTATION_ATTEMPTS} attempt(s); see the verifier notes.`,
        ],
        plans,
        reconciliation,
        spec,
        implementation,
        verdict,
      };
    }),
});
