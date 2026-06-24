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
  /**
   * Public dataset marker. Scenario authors should set this at the top level
   * in bundles/directories so the loader can dispatch to the multi-turn path.
   */
  multiTurn?: true
  id: string
  axes: string[]
  /** Optional system prompt prepended to every turn. */
  systemPrompt?: string
  /** Public pre-seeded conversation (the contract's `conversationHistory`). */
  conversationHistory?: ConversationTurn[]
  /** Backwards-compatible library alias. Public datasets should use `conversationHistory`. */
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
  return v['multiTurn'] === true ||
    Array.isArray(v['userTurns']) ||
    Array.isArray(v['persistenceCriteria'])
}

const PUBLIC_MULTI_TURN_KEYS = new Set([
  'multiTurn',
  'id',
  'axes',
  'systemPrompt',
  'conversationHistory',
  'userTurns',
  'persistenceCriteria',
  'meta',
])

const PERSISTENCE_KINDS = new Set([
  'fact-persistence',
  'disposition-persistence',
  'constraint-persistence',
  'mechanism-persistence',
  'evidence-update',
])

export interface MultiTurnValidationOptions {
  /** Require the public top-level `multiTurn: true` marker. */
  requirePublicMarker?: boolean
  /** Reject fields outside the public bundle shape. */
  rejectUnknownKeys?: boolean
  /** Error-location label used by the loader. */
  hint?: string
}

/**
 * Validate a public multi-turn dataset item. This is intentionally stricter
 * than the programmatic `runMultiTurn()` input so public bundles fail closed
 * on private-answer-key leaks and ambiguous legacy marker-only shapes.
 */
export function validateMultiTurnScenario(
  value: unknown,
  options: MultiTurnValidationOptions = {},
): asserts value is MultiTurnScenario {
  const hint = options.hint ?? 'multi-turn scenario'
  const scenario = asRecord(value, hint)

  if (options.rejectUnknownKeys) {
    for (const key of Object.keys(scenario)) {
      if (!PUBLIC_MULTI_TURN_KEYS.has(key)) {
        throw new MultiTurnError(
          `${hint} has unsupported field '${key}'. Public multi-turn scenarios ` +
            `must use top-level multiTurn, id, axes, optional systemPrompt, ` +
            `optional conversationHistory, userTurns, persistenceCriteria, and meta only.`,
        )
      }
    }
  }

  if (options.requirePublicMarker && scenario['multiTurn'] !== true) {
    throw new MultiTurnError(
      `${hint} must set top-level multiTurn: true. The legacy meta.multiTurn ` +
        `marker is only a fail-closed guard and is not an executable public shape.`,
    )
  }
  if (scenario['multiTurn'] !== undefined && scenario['multiTurn'] !== true) {
    throw new MultiTurnError(`${hint}.multiTurn must be true when present.`)
  }

  requireStringField(scenario, 'id', hint)
  requireStringArrayField(scenario, 'axes', hint, { nonEmpty: true })
  optionalStringField(scenario, 'systemPrompt', hint)
  validateConversationHistory(scenario['conversationHistory'], `${hint}.conversationHistory`)
  validateConversationHistory(scenario['seedHistory'], `${hint}.seedHistory`)

  const userTurns = requireStringArrayField(scenario, 'userTurns', hint, {
    nonEmpty: true,
    nonBlankItems: true,
  })
  if (userTurns.length === 0) {
    throw new MultiTurnError(
      `multi-turn scenario '${String(scenario['id'])}' has no userTurns — refusing to run a ` +
        `multi-turn scenario with nothing to submit (fail-closed).`,
    )
  }

  const criteria = scenario['persistenceCriteria']
  if (!Array.isArray(criteria) || criteria.length === 0) {
    throw new MultiTurnError(
      `multi-turn scenario '${String(scenario['id'])}' has no persistenceCriteria — a ` +
        `multi-turn scenario with no persistence check cannot be graded; refusing rather ` +
        `than scoring it vacuously.`,
    )
  }
  criteria.forEach((criterion, index) =>
    validatePersistenceCriterion(criterion, `${hint}.persistenceCriteria[${index}]`),
  )

  if (scenario['meta'] !== undefined && !isRecord(scenario['meta'])) {
    throw new MultiTurnError(`${hint}.meta must be an object when present.`)
  }
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
  validateMultiTurnScenario(scenario)

  const history: Message[] = []
  if (scenario.systemPrompt) {
    history.push({ role: 'system', content: scenario.systemPrompt })
  }
  const seedHistory = scenario.conversationHistory ?? scenario.seedHistory ?? []
  for (const seed of seedHistory) {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown, hint: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new MultiTurnError(`${hint} must be an object.`)
  }
  return value
}

function requireStringField(
  obj: Record<string, unknown>,
  key: string,
  hint: string,
): string {
  const value = obj[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new MultiTurnError(`${hint}.${key} must be a non-empty string.`)
  }
  return value
}

function optionalStringField(
  obj: Record<string, unknown>,
  key: string,
  hint: string,
): void {
  if (obj[key] !== undefined && typeof obj[key] !== 'string') {
    throw new MultiTurnError(`${hint}.${key} must be a string when present.`)
  }
}

function requireStringArrayField(
  obj: Record<string, unknown>,
  key: string,
  hint: string,
  options: { nonEmpty?: boolean, nonBlankItems?: boolean } = {},
): string[] {
  const value = obj[key]
  if (!Array.isArray(value)) {
    throw new MultiTurnError(`${hint}.${key} must be an array.`)
  }
  if (options.nonEmpty && value.length === 0) {
    throw new MultiTurnError(`${hint}.${key} must contain at least one item.`)
  }
  value.forEach((item, index) => {
    if (typeof item !== 'string') {
      throw new MultiTurnError(`${hint}.${key}[${index}] must be a string.`)
    }
    if (options.nonBlankItems && item.trim().length === 0) {
      throw new MultiTurnError(`${hint}.${key}[${index}] must be non-empty.`)
    }
  })
  return value as string[]
}

function optionalStringArrayField(
  obj: Record<string, unknown>,
  key: string,
  hint: string,
  options: { nonEmpty?: boolean, nonBlankItems?: boolean } = {},
): void {
  if (obj[key] === undefined) return
  requireStringArrayField(obj, key, hint, options)
}

function requireIntegerField(
  obj: Record<string, unknown>,
  key: string,
  hint: string,
): number {
  const value = obj[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new MultiTurnError(`${hint}.${key} must be a non-negative integer.`)
  }
  return value
}

function optionalIntegerField(
  obj: Record<string, unknown>,
  key: string,
  hint: string,
): void {
  if (obj[key] === undefined) return
  requireIntegerField(obj, key, hint)
}

function validateConversationHistory(value: unknown, hint: string): void {
  if (value === undefined) return
  if (!Array.isArray(value)) {
    throw new MultiTurnError(`${hint} must be an array when present.`)
  }
  value.forEach((turn, index) => {
    const obj = asRecord(turn, `${hint}[${index}]`)
    const role = obj['role']
    if (role !== 'user' && role !== 'assistant') {
      throw new MultiTurnError(`${hint}[${index}].role must be "user" or "assistant".`)
    }
    requireStringField(obj, 'content', `${hint}[${index}]`)
  })
}

function validatePersistenceCriterion(value: unknown, hint: string): void {
  const criterion = asRecord(value, hint)
  requireStringField(criterion, 'id', hint)
  const kind = requireStringField(criterion, 'kind', hint)
  if (!PERSISTENCE_KINDS.has(kind)) {
    throw new MultiTurnError(
      `${hint}.kind must be one of ${[...PERSISTENCE_KINDS].join(', ')}.`,
    )
  }
  requireIntegerField(criterion, 'targetTurnIndex', hint)
  optionalIntegerField(criterion, 'establishedAtTurn', hint)

  switch (kind) {
    case 'fact-persistence':
      requireStringArrayField(criterion, 'factPhrases', hint, { nonEmpty: true })
      return
    case 'disposition-persistence':
      requireStringField(criterion, 'disposition', hint)
      requireStringArrayField(criterion, 'holdPhrases', hint, { nonEmpty: true })
      requireStringArrayField(criterion, 'flipPhrases', hint, { nonEmpty: true })
      return
    case 'constraint-persistence':
      requireStringField(criterion, 'constraint', hint)
      requireStringArrayField(criterion, 'violationPhrases', hint, { nonEmpty: true })
      optionalStringArrayField(criterion, 'acknowledgePhrases', hint, { nonEmpty: true })
      return
    case 'mechanism-persistence':
      requireStringField(criterion, 'mechanism', hint)
      optionalIntegerField(criterion, 'pressureTurnIndex', hint)
      optionalStringArrayField(criterion, 'pressurePhrases', hint, { nonEmpty: true })
      requireStringArrayField(criterion, 'retainedInvariantPhrases', hint, { nonEmpty: true })
      requireStringArrayField(criterion, 'forbiddenReversalPhrases', hint)
      optionalStringArrayGroups(criterion, 'requiredMechanismPhrases', hint)
      optionalStringArrayGroups(criterion, 'requiredDetailPhrases', hint)
      return
    case 'evidence-update':
      requireStringField(criterion, 'update', hint)
      requireIntegerField(criterion, 'newEvidenceTurnIndex', hint)
      requireStringArrayField(criterion, 'newEvidencePhrases', hint, { nonEmpty: true })
      requireStringArrayField(criterion, 'updatedDiagnosisPhrases', hint, { nonEmpty: true })
      requireStringArrayField(criterion, 'staleDiagnosisPhrases', hint, { nonEmpty: true })
      return
  }
}

function optionalStringArrayGroups(
  obj: Record<string, unknown>,
  key: string,
  hint: string,
): void {
  const value = obj[key]
  if (value === undefined) return
  if (!Array.isArray(value)) {
    throw new MultiTurnError(`${hint}.${key} must be an array when present.`)
  }
  value.forEach((group, index) => {
    if (!Array.isArray(group) || group.length === 0) {
      throw new MultiTurnError(`${hint}.${key}[${index}] must be a non-empty string array.`)
    }
    group.forEach((item, itemIndex) => {
      if (typeof item !== 'string' || item.length === 0) {
        throw new MultiTurnError(`${hint}.${key}[${index}][${itemIndex}] must be a non-empty string.`)
      }
    })
  })
}
