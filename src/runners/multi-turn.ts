/**
 * multi-turn.ts — the multi-turn / persistence execution path.
 *
 * Council `assay-harness-review-2026-06-18` (Tier-2 #6): the cross-repo
 * contract advertises `multiTurn` / `conversationHistory` scenarios and a
 * `persistence-grader-v1` harness dependency, but `runner.run(scenario)` only
 * submits `scenario.input.messages` single-shot, so a multi-turn scenario was
 * silently flattened to its first prompt and the persistence grader was never
 * implemented. That is a silent-degradation hazard: an adversarial scenario
 * that tests whether a model holds its position across turns would have been
 * graded on a single turn.
 *
 * This module wires the real path WITHOUT touching the base `Runner` interface
 * (so every existing provider runner works unchanged):
 *
 *   1. A multi-turn scenario carries a list of `turns` — adversarial user
 *      messages, optionally seeded with prior `conversationHistory`.
 *   2. For each turn we hand the underlying runner a synthetic single-turn
 *      scenario whose `input.messages` is the accumulated conversation so far
 *      plus the next user turn. The runner submits the full history; we
 *      capture the assistant reply, append it, and move on.
 *   3. The captured turns are graded by `persistence-grader-v1`
 *      (`src/persistence-grader.ts`) — does the model carry its position /
 *      fact / constraint / mechanism forward under adversarial pressure?
 *
 * FAIL-CLOSED. If a scenario declares `multiTurn: true` but supplies no turns,
 * we throw rather than silently single-shotting it. Equally, the single-shot
 * `cli.ts` path should refuse a multi-turn scenario rather than flatten it;
 * `assertSingleTurn` is exported for that guard.
 */

import type { Message, ModelResponse, Runner, RunnerOptions, Scenario } from '../types.js'
import {
  scorePersistence,
  type PersistenceCriterion,
  type PersistenceScore,
  type TurnObservation,
  PERSISTENCE_GRADER_VERSION,
} from '../persistence-grader.js'

/** Raised when a multi-turn scenario is malformed or is fed to a single-shot path. */
export class MultiTurnError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MultiTurnError'
  }
}

/** A turn in the adversarial conversation. `user` turns are submitted to the
 *  model; `assistant` turns are pre-seeded transcript (rare — usually the
 *  model produces every assistant turn). */
export interface ConversationTurn {
  role: 'user' | 'assistant'
  content: string
}

/**
 * A multi-turn scenario. This is intentionally a SEPARATE shape from the
 * single-shot `Scenario` so the public `Runner` interface and `src/types.ts`
 * stay untouched. The contract's `conversationHistory` (typed `unknown` in the
 * release contract) maps onto `seedHistory`; the adversarial prompts map onto
 * `userTurns`.
 */
export interface MultiTurnScenario {
  id: string
  axes: string[]
  /** Optional system prompt prepended to every turn. */
  systemPrompt?: string
  /** Pre-seeded conversation (the contract's `conversationHistory`). */
  seedHistory?: ConversationTurn[]
  /** Adversarial user prompts, submitted in order. MUST be non-empty. */
  userTurns: string[]
  /** Persistence criteria scored over the captured turns. MUST be non-empty. */
  persistenceCriteria: PersistenceCriterion[]
  meta?: Record<string, unknown>
}

export interface MultiTurnResult {
  scenarioId: string
  runnerId: string
  /** One captured turn per submitted user turn (assistant text indexed by turn). */
  turns: TurnObservation[]
  /** Raw provider responses, one per submitted user turn, for audit. */
  responses: ModelResponse[]
  /** Per-criterion persistence verdicts. */
  persistence: PersistenceScore[]
  /** Normalised [0,1] persistence score (fraction of criteria that passed). */
  value: number
  /** The grader version that produced `persistence` (provenance). */
  graderVersion: typeof PERSISTENCE_GRADER_VERSION
}

/** Type guard: does this object look like a multi-turn scenario? */
export function isMultiTurnScenario(value: unknown): value is MultiTurnScenario {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return Array.isArray(v['userTurns']) || Array.isArray(v['persistenceCriteria'])
}

/**
 * Refuse to single-shot a multi-turn scenario. Call this from the single-shot
 * run path (cli.ts) on every scenario: a scenario whose `meta.multiTurn` is
 * `true` MUST go through `runMultiTurn`, never `runner.run`. Fail-closed.
 */
export function assertSingleTurn(scenario: Scenario): void {
  const multiTurn = scenario.meta?.['multiTurn']
  if (multiTurn === true) {
    throw new MultiTurnError(
      `scenario '${scenario.id}' is marked multiTurn but reached the single-shot run path. ` +
        `Multi-turn scenarios must be executed via runMultiTurn() so the persistence grader ` +
        `(${PERSISTENCE_GRADER_VERSION}) can score cross-turn behaviour. Single-shotting it would ` +
        `silently grade only the first turn — refused.`,
    )
  }
}

function validate(scenario: MultiTurnScenario): void {
  if (!Array.isArray(scenario.userTurns) || scenario.userTurns.length === 0) {
    throw new MultiTurnError(
      `multi-turn scenario '${scenario.id}' has no userTurns — refusing to run a multi-turn ` +
        `scenario with nothing to submit (fail-closed).`,
    )
  }
  if (
    !Array.isArray(scenario.persistenceCriteria) ||
    scenario.persistenceCriteria.length === 0
  ) {
    throw new MultiTurnError(
      `multi-turn scenario '${scenario.id}' has no persistenceCriteria — a multi-turn scenario ` +
        `with no persistence check cannot be graded; refusing rather than scoring it vacuously.`,
    )
  }
}

/**
 * Execute a multi-turn scenario against a runner and grade persistence.
 *
 * The underlying `runner` is used as-is: per turn we synthesise a single-shot
 * `Scenario` whose `input.messages` is the full conversation so far. The
 * runner submits all of it (every provider runner already forwards
 * `input.messages` verbatim), so the model sees real conversation context.
 */
export async function runMultiTurn(
  runner: Runner,
  scenario: MultiTurnScenario,
  opts: RunnerOptions = {},
): Promise<MultiTurnResult> {
  validate(scenario)

  const history: Message[] = []
  if (scenario.systemPrompt) {
    history.push({ role: 'system', content: scenario.systemPrompt })
  }
  for (const seed of scenario.seedHistory ?? []) {
    history.push({ role: seed.role, content: seed.content })
  }

  const turns: TurnObservation[] = []
  const responses: ModelResponse[] = []

  for (let i = 0; i < scenario.userTurns.length; i++) {
    const userMessage = scenario.userTurns[i] as string
    history.push({ role: 'user', content: userMessage })

    const turnScenario: Scenario = {
      id: `${scenario.id}#turn${i}`,
      axes: scenario.axes,
      // Send a COPY so a runner that mutates its input can't corrupt history.
      input: { messages: history.map((m) => ({ ...m })) },
      // Reuse the most permissive built-in rubric; the multi-turn path does
      // not use the per-turn rubric — persistence is scored separately below.
      rubric: { kind: 'programmatic', checker: 'non-empty' },
      ...(scenario.meta ? { meta: scenario.meta } : {}),
    }

    const response = await runner.run(turnScenario, opts)
    responses.push(response)
    const assistantText = response.output
    history.push({ role: 'assistant', content: assistantText })
    turns.push({ turnIndex: i, assistantText, userMessage })
  }

  const { value, results } = scorePersistence(turns, scenario.persistenceCriteria)

  return {
    scenarioId: scenario.id,
    runnerId: runner.id,
    turns,
    responses,
    persistence: results,
    value,
    graderVersion: PERSISTENCE_GRADER_VERSION,
  }
}
