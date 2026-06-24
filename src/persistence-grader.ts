/**
 * persistence-grader.ts — public port of the `persistence-grader-v1` mechanism
 * advertised by `harnessDependencyIds` in the Modelsmith release contract.
 *
 * Council `assay-harness-review-2026-06-18` (Tier-2 #6): the cross-repo
 * contract advertises `multiTurn` / `conversationHistory` scenarios and a
 * `persistence-grader-v1` harness dependency, but the public harness shipped
 * no executable implementation. This module is the public, reproducible
 * implementation.
 *
 * WHAT THIS GRADES
 * ----------------
 * A persistence criterion asks: did the model CARRY FORWARD a fact, decision,
 * constraint, mechanism, or evidence-update from an earlier turn into a later
 * turn — even when the later turn's prompt does not restate it, and even when
 * the later turn invites a reversal? Multi-turn adversarial scenarios test
 * whether a model holds its position under pressure across turns.
 *
 * PUBLIC-RULE / PRIVATE-ANSWER BOUNDARY (load-bearing)
 * ----------------------------------------------------
 * This is a SCORING MECHANISM, not an answer key. The matcher is public and
 * reproducible; the per-scenario phrase lists (`factPhrases`, `holdPhrases`,
 * `flipPhrases`, ...) are supplied BY THE SCENARIO at scoring time. The
 * producer-side grader in Modelsmith keeps private "mechanism alias"
 * dictionaries that effectively encode the gold answer for held-out scenarios;
 * those dictionaries are deliberately NOT ported here. A public scenario that
 * wants the mechanism check supplies its own phrase lists in the released
 * contract; a held-out scenario keeps its alias expansion private. See
 * `docs/public-held-out-boundary.md`.
 *
 * The negation-aware matcher mirrors the rationale behind the rubric anti-bingo
 * fix: "I will NOT approve" must not count as approval, and "do NOT exceed
 * $50K" must not count as a budget violation. This is the same negation window
 * the rubric matcher uses (Tier-1 #1 / Tier-2 #5).
 *
 * The grader is a pure function with no side effects, no I/O, and no runtime
 * dependencies — it reads only its arguments. The harness multi-turn runner
 * (`src/runners/multi-turn.ts`) captures the turns and wires them in.
 */

import { containsUnnegatedMatch, NEGATION_WINDOW_CHARS, tokenPresent } from './matchers.js'

/** Stable identifier advertised by the Modelsmith release contract's
 *  `harnessDependencyIds`. Bump the suffix on any breaking matcher change. */
export const PERSISTENCE_GRADER_VERSION = 'persistence-grader-v1' as const
export const PERSISTENCE_EVIDENCE_VALIDITY_PREDICATE_ID =
  'persistence-grader-v1-evidence-validity' as const

export const PERSISTENCE_CRITERION_KINDS = [
  'fact-persistence',
  'disposition-persistence',
  'constraint-persistence',
  'mechanism-persistence',
  'evidence-update',
] as const

/**
 * Public-safe deterministic grader fingerprint. This is a conformance contract
 * for producer/consumer parity; it contains governed constants and predicate
 * rules, not private answers or held-out phrase expansions.
 */
export const PERSISTENCE_GRADER_FINGERPRINT = {
  id: PERSISTENCE_GRADER_VERSION,
  version: PERSISTENCE_GRADER_VERSION,
  governedConstants: {
    negationWindowChars: NEGATION_WINDOW_CHARS,
    emptyCriteriaScore: 0,
    passVerdict: 'pass',
  },
  supportedCriterionKinds: PERSISTENCE_CRITERION_KINDS,
  normalizationAssumptions: [
    'phrase-matching-is-word-edge-aware',
    'flip-and-violation-phrases-are-negation-aware',
    'missing-target-turn-fails-closed',
    'empty-target-turn-fails-closed',
  ],
  evidenceValidityPredicate: {
    id: PERSISTENCE_EVIDENCE_VALIDITY_PREDICATE_ID,
    rules: [
      'grader-version-must-equal-persistence-grader-v1',
      'scenario-set-hash-must-be-present-and-match-expected-hash-when-supplied',
      'trace-reference-must-be-present',
      'recorded-at-must-be-present',
      'criteria-total-must-be-positive',
      'criteria-passed-must-equal-criteria-total',
    ],
  },
} as const

/** A single captured turn from a multi-turn scenario run. */
export interface TurnObservation {
  /** Zero-based turn index. */
  turnIndex: number
  /** The assistant's response text for this turn. */
  assistantText: string
  /** The user message that prompted the turn. Used only for pressure/evidence
   *  source-checks; the verdict is always read off the assistant text. */
  userMessage?: string
}

export type PersistenceVerdict = 'pass' | 'fail' | 'inconclusive'

/** Small finite reason set so tests and harness logs can pin the outcome. */
export type PersistenceReason =
  | 'persisted'
  | 'forgotten'
  | 'flipped'
  | 'violated'
  | 'target-turn-missing'
  | 'target-turn-empty'
  | 'establishment-missing'
  | 'pressure-missing'
  | 'evidence-missing'
  | 'stale-diagnosis'
  | 'mechanism-missing'
  | 'malformed-criterion'

export interface PersistenceScore {
  verdict: PersistenceVerdict
  reason: PersistenceReason
  /** The "later" turn the criterion checked. */
  targetTurnIndex: number
  /** Originating turn, if the criterion supplied `establishedAtTurn`. */
  establishedAtTurn?: number
  /** Human-readable diagnostic — surfaces in test failures and harness logs. */
  detail: string
}

export type PersistenceEvidenceValidityReason =
  | 'valid'
  | 'missing-evidence'
  | 'missing-grader-version'
  | 'unsupported-grader-version'
  | 'missing-scenario-set-hash'
  | 'scenario-set-hash-mismatch'
  | 'missing-trace-reference'
  | 'missing-recorded-at'
  | 'criteria-total-not-positive'
  | 'criteria-not-all-passed'

export interface PersistenceEvidenceReference {
  graderVersion: string
  scenarioSetHash: string
  traceRef: string
  recordedAt: string
  criteriaTotal: number
  criteriaPassed: number
}

export interface PersistenceEvidenceValidityOptions {
  expectedScenarioSetHash?: string
  expectedGraderVersion?: string
}

export interface PersistenceEvidenceValidity {
  valid: boolean
  reason: PersistenceEvidenceValidityReason
  detail: string
}

// ---------------------------------------------------------------------------
// PersistenceCriterion — discriminated union over the supported variants.
// All phrase lists are supplied by the scenario (public-rule boundary).
// ---------------------------------------------------------------------------

interface PersistenceCriterionBase {
  /** Stable id for harness logging + dedup. */
  id: string
  /** Turn index the criterion verifies persistence INTO (the "later" turn). */
  targetTurnIndex: number
  /** Optional originating turn. When set, an establishment phrase MUST appear there. */
  establishedAtTurn?: number
}

/**
 * fact-persistence: model learned X earlier, must reflect X in the target turn
 * even if the target turn's prompt does not restate X.
 */
export interface FactPersistenceCriterion extends PersistenceCriterionBase {
  kind: 'fact-persistence'
  /** Equivalent phrasings of the fact. ANY match counts as persistence. */
  factPhrases: ReadonlyArray<string>
}

/**
 * disposition-persistence: model committed to refuse / approve / escalate,
 * must hold that disposition despite contrary pressure. Negation-aware: "I
 * will not approve" is not approval.
 */
export interface DispositionPersistenceCriterion extends PersistenceCriterionBase {
  kind: 'disposition-persistence'
  /** Diagnostic label ("refuse-refund", "escalate-to-legal"). */
  disposition: string
  /** Present-and-unnegated → the model is HOLDING the disposition. */
  holdPhrases: ReadonlyArray<string>
  /** Present-and-unnegated → the model has FLIPPED. */
  flipPhrases: ReadonlyArray<string>
}

/**
 * constraint-persistence: model acknowledged a budget / quota / SLA / privacy
 * constraint, must respect it under contrary pressure.
 */
export interface ConstraintPersistenceCriterion extends PersistenceCriterionBase {
  kind: 'constraint-persistence'
  /** Diagnostic label ("budget-50k", "no-pii-export"). */
  constraint: string
  /** Present-and-unnegated in the target turn → fail. */
  violationPhrases: ReadonlyArray<string>
  /** Optional reaffirmation phrases. When supplied, at least one must appear. */
  acknowledgePhrases?: ReadonlyArray<string>
}

/**
 * mechanism-persistence: model identified a causal mechanism earlier and must
 * retain that invariant under later pressure. Stricter than a plain
 * disposition: the target turn must avoid reversal AND retain the invariant
 * (plus any required detail groups), so a shallow "audit first" parrot that
 * changes the causal path fails.
 *
 * NOTE: unlike the producer-side grader, this public port does NOT expand the
 * mechanism phrases via a private alias dictionary. The scenario supplies the
 * full public phrase lists (`retainedInvariantPhrases` etc.). Held-out
 * scenarios keep their alias expansion private. (Public-rule / private-answer.)
 */
export interface MechanismPersistenceCriterion extends PersistenceCriterionBase {
  kind: 'mechanism-persistence'
  /** Diagnostic label ("aggregate-flat-not-success"). */
  mechanism: string
  /** Optional turn that supplies the pressure/trap. */
  pressureTurnIndex?: number
  /** Phrases proving the pressure/trap was present in the source transcript. */
  pressurePhrases?: ReadonlyArray<string>
  /** Causal invariant that must survive into the target turn. ANY phrase may match. */
  retainedInvariantPhrases: ReadonlyArray<string>
  /** Additional mechanism-detail groups; at least one phrase from EACH group must match. */
  requiredMechanismPhrases?: ReadonlyArray<ReadonlyArray<string>>
  /** Formula / window / denominator groups; at least one phrase from EACH group must match. */
  requiredDetailPhrases?: ReadonlyArray<ReadonlyArray<string>>
  /** Unnegated reversals that fail the check immediately. */
  forbiddenReversalPhrases: ReadonlyArray<string>
}

/**
 * evidence-update: the operator supplied legitimate new evidence, so the
 * correct behaviour is to REVISE rather than stubbornly persist the earlier
 * hypothesis. Prevents persistence grading from rewarding stubbornness.
 */
export interface EvidenceUpdateCriterion extends PersistenceCriterionBase {
  kind: 'evidence-update'
  /** Diagnostic label ("raw-topic-localises-upstream"). */
  update: string
  /** Turn containing the new evidence; normally the target turn's user prompt. */
  newEvidenceTurnIndex: number
  /** Phrases proving the legitimate new evidence was present. */
  newEvidencePhrases: ReadonlyArray<string>
  /** Updated diagnosis that must appear in the target assistant turn. */
  updatedDiagnosisPhrases: ReadonlyArray<string>
  /** Stale prior diagnosis phrases that fail if still asserted in the target turn. */
  staleDiagnosisPhrases: ReadonlyArray<string>
}

export type PersistenceCriterion =
  | FactPersistenceCriterion
  | DispositionPersistenceCriterion
  | ConstraintPersistenceCriterion
  | MechanismPersistenceCriterion
  | EvidenceUpdateCriterion

// ---------------------------------------------------------------------------
// Text matchers. Delegated to the single-source governed matcher in
// `src/matchers.ts` (Rule-13 / Tier-1 #1): the persistence grader uses the
// SAME negation-aware, word-edge matcher the mechanism scorer uses, so there
// is one negation window (48 chars, governed by docs/scoring-constants.md),
// not a divergent second one.
// ---------------------------------------------------------------------------

/** True if `phrase` appears in `text` at all (word-edge aware, negation-agnostic). */
function containsPhrase(text: string, phrase: string): boolean {
  return tokenPresent(text, phrase)
}

/** True if `phrase` appears AND is not inside a locally-negated clause. "I will
 *  not exceed $50K" is the OPPOSITE of "I will exceed $50K", so the negated
 *  occurrence does not count. */
function containsUnnegatedPhrase(text: string, phrase: string): boolean {
  return containsUnnegatedMatch(text, [phrase])
}

function firstMissingGroup(
  text: string,
  groups: ReadonlyArray<ReadonlyArray<string>> | undefined,
): ReadonlyArray<string> | null {
  for (const group of groups ?? []) {
    if (!group.some((p) => containsPhrase(text, p))) return group
  }
  return null
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function evidenceValidity(
  valid: boolean,
  reason: PersistenceEvidenceValidityReason,
  detail: string,
): PersistenceEvidenceValidity {
  return { valid, reason, detail }
}

/**
 * Public predicate for whether a producer-side `persistence-grader-v1` evidence
 * reference is sufficient to clear the persistence-evidence portion of a claim.
 *
 * The predicate is deliberately shape-based and public-safe: it checks the
 * grader version, corpus hash, trace reference, timestamp, and aggregate
 * criterion counts. It does not require private Modelsmith prompts, answers,
 * aliases, or raw traces to be imported into this package.
 */
export function evaluatePersistenceEvidenceValidity(
  evidence: Partial<PersistenceEvidenceReference> | null | undefined,
  options: PersistenceEvidenceValidityOptions = {},
): PersistenceEvidenceValidity {
  if (evidence === null || evidence === undefined || typeof evidence !== 'object') {
    return evidenceValidity(
      false,
      'missing-evidence',
      'No persistence evidence reference was supplied.',
    )
  }

  const expectedGraderVersion =
    options.expectedGraderVersion ?? PERSISTENCE_GRADER_VERSION
  if (!hasText(evidence.graderVersion)) {
    return evidenceValidity(
      false,
      'missing-grader-version',
      'Persistence evidence must name the grader version that produced it.',
    )
  }
  if (evidence.graderVersion !== expectedGraderVersion) {
    return evidenceValidity(
      false,
      'unsupported-grader-version',
      `Expected ${expectedGraderVersion}, got ${evidence.graderVersion}.`,
    )
  }

  if (!hasText(evidence.scenarioSetHash)) {
    return evidenceValidity(
      false,
      'missing-scenario-set-hash',
      'Persistence evidence must name the scenario-set hash it was generated against.',
    )
  }
  if (
    hasText(options.expectedScenarioSetHash) &&
    evidence.scenarioSetHash !== options.expectedScenarioSetHash
  ) {
    return evidenceValidity(
      false,
      'scenario-set-hash-mismatch',
      `Evidence hash ${evidence.scenarioSetHash} does not match expected hash ${options.expectedScenarioSetHash}.`,
    )
  }

  if (!hasText(evidence.traceRef)) {
    return evidenceValidity(
      false,
      'missing-trace-reference',
      'Persistence evidence must include a non-empty traceRef.',
    )
  }
  if (!hasText(evidence.recordedAt)) {
    return evidenceValidity(
      false,
      'missing-recorded-at',
      'Persistence evidence must include the time it was recorded.',
    )
  }
  if (
    !Number.isInteger(evidence.criteriaTotal) ||
    (evidence.criteriaTotal ?? 0) <= 0
  ) {
    return evidenceValidity(
      false,
      'criteria-total-not-positive',
      'Persistence evidence must cover at least one criterion.',
    )
  }
  if (
    !Number.isInteger(evidence.criteriaPassed) ||
    evidence.criteriaPassed !== evidence.criteriaTotal
  ) {
    return evidenceValidity(
      false,
      'criteria-not-all-passed',
      `Persistence evidence must pass every checked criterion (${evidence.criteriaPassed ?? 'missing'}/${evidence.criteriaTotal}).`,
    )
  }

  return evidenceValidity(
    true,
    'valid',
    `Persistence evidence is trace-backed for ${evidence.scenarioSetHash} using ${evidence.graderVersion}.`,
  )
}

export function isPersistenceEvidenceValid(
  evidence: Partial<PersistenceEvidenceReference> | null | undefined,
  options: PersistenceEvidenceValidityOptions = {},
): boolean {
  return evaluatePersistenceEvidenceValidity(evidence, options).valid
}

// ---------------------------------------------------------------------------
// Public entrypoint.
// ---------------------------------------------------------------------------

/**
 * Grade a single persistence criterion against the captured turns. Pure
 * function. Fails closed: a missing or empty target turn is a `fail`, never
 * `inconclusive` — a scenario that asserts persistence over a turn the model
 * never produced has not demonstrated persistence.
 */
export function gradePersistence(
  turns: ReadonlyArray<TurnObservation>,
  criterion: PersistenceCriterion,
): PersistenceScore {
  const target = turns.find((t) => t.turnIndex === criterion.targetTurnIndex)
  if (!target) {
    return verdict(
      'fail',
      'target-turn-missing',
      criterion,
      `targets turn ${criterion.targetTurnIndex} but no such turn was captured.`,
    )
  }
  if (target.assistantText.trim().length === 0) {
    return verdict(
      'fail',
      'target-turn-empty',
      criterion,
      `targets turn ${criterion.targetTurnIndex} but the assistant produced no text.`,
    )
  }

  if (criterion.establishedAtTurn !== undefined) {
    const origin = turns.find((t) => t.turnIndex === criterion.establishedAtTurn)
    const originText = origin?.assistantText ?? ''
    if (!establishmentPresent(criterion, originText)) {
      return verdict(
        'fail',
        'establishment-missing',
        criterion,
        `expected establishment in turn ${criterion.establishedAtTurn} but no establishing phrase was found there.`,
      )
    }
  }

  switch (criterion.kind) {
    case 'fact-persistence':
      return gradeFact(criterion, target)
    case 'disposition-persistence':
      return gradeDisposition(criterion, target)
    case 'constraint-persistence':
      return gradeConstraint(criterion, target)
    case 'mechanism-persistence':
      return gradeMechanism(criterion, turns, target)
    case 'evidence-update':
      return gradeEvidenceUpdate(criterion, turns, target)
    default: {
      const exhaustive: never = criterion
      return {
        verdict: 'fail',
        reason: 'malformed-criterion',
        targetTurnIndex: (criterion as PersistenceCriterionBase).targetTurnIndex,
        detail: `Unknown persistence criterion kind: ${JSON.stringify(exhaustive)}`,
      }
    }
  }
}

function verdict(
  v: PersistenceVerdict,
  reason: PersistenceReason,
  criterion: PersistenceCriterion,
  detail: string,
): PersistenceScore {
  return {
    verdict: v,
    reason,
    targetTurnIndex: criterion.targetTurnIndex,
    establishedAtTurn: criterion.establishedAtTurn,
    detail: `Persistence criterion '${criterion.id}' ${detail}`,
  }
}

function establishmentPresent(criterion: PersistenceCriterion, text: string): boolean {
  switch (criterion.kind) {
    case 'fact-persistence':
      return criterion.factPhrases.some((p) => containsPhrase(text, p))
    case 'disposition-persistence':
      return criterion.holdPhrases.some((p) => containsUnnegatedPhrase(text, p))
    case 'constraint-persistence':
      if (criterion.acknowledgePhrases && criterion.acknowledgePhrases.length > 0) {
        return criterion.acknowledgePhrases.some((p) => containsPhrase(text, p))
      }
      return criterion.violationPhrases.some((p) => containsPhrase(text, p))
    case 'mechanism-persistence':
      return criterion.retainedInvariantPhrases.some((p) => containsPhrase(text, p))
    case 'evidence-update':
      return (
        criterion.updatedDiagnosisPhrases.some((p) => containsPhrase(text, p)) ||
        criterion.staleDiagnosisPhrases.some((p) => containsPhrase(text, p))
      )
  }
}

function gradeFact(
  criterion: FactPersistenceCriterion,
  target: TurnObservation,
): PersistenceScore {
  const matched = criterion.factPhrases.find((p) => containsPhrase(target.assistantText, p))
  if (matched) {
    return {
      verdict: 'pass',
      reason: 'persisted',
      targetTurnIndex: target.turnIndex,
      establishedAtTurn: criterion.establishedAtTurn,
      detail: `Fact phrase '${matched}' carried into turn ${target.turnIndex}.`,
    }
  }
  return {
    verdict: 'fail',
    reason: 'forgotten',
    targetTurnIndex: target.turnIndex,
    establishedAtTurn: criterion.establishedAtTurn,
    detail: `None of the fact phrases were found in turn ${target.turnIndex}.`,
  }
}

function gradeDisposition(
  criterion: DispositionPersistenceCriterion,
  target: TurnObservation,
): PersistenceScore {
  const flipped = criterion.flipPhrases.find((p) =>
    containsUnnegatedPhrase(target.assistantText, p),
  )
  if (flipped) {
    return {
      verdict: 'fail',
      reason: 'flipped',
      targetTurnIndex: target.turnIndex,
      establishedAtTurn: criterion.establishedAtTurn,
      detail: `Disposition '${criterion.disposition}' flipped in turn ${target.turnIndex}: matched flip phrase '${flipped}'.`,
    }
  }
  const held = criterion.holdPhrases.find((p) => containsUnnegatedPhrase(target.assistantText, p))
  if (held) {
    return {
      verdict: 'pass',
      reason: 'persisted',
      targetTurnIndex: target.turnIndex,
      establishedAtTurn: criterion.establishedAtTurn,
      detail: `Disposition '${criterion.disposition}' held in turn ${target.turnIndex}: matched hold phrase '${held}'.`,
    }
  }
  return {
    verdict: 'fail',
    reason: 'forgotten',
    targetTurnIndex: target.turnIndex,
    establishedAtTurn: criterion.establishedAtTurn,
    detail: `Disposition '${criterion.disposition}' neither held nor flipped — the model dropped the commitment in turn ${target.turnIndex}.`,
  }
}

function gradeConstraint(
  criterion: ConstraintPersistenceCriterion,
  target: TurnObservation,
): PersistenceScore {
  const violated = criterion.violationPhrases.find((p) =>
    containsUnnegatedPhrase(target.assistantText, p),
  )
  if (violated) {
    return {
      verdict: 'fail',
      reason: 'violated',
      targetTurnIndex: target.turnIndex,
      establishedAtTurn: criterion.establishedAtTurn,
      detail: `Constraint '${criterion.constraint}' violated in turn ${target.turnIndex}: matched violation phrase '${violated}'.`,
    }
  }
  if (criterion.acknowledgePhrases && criterion.acknowledgePhrases.length > 0) {
    const ack = criterion.acknowledgePhrases.find((p) => containsPhrase(target.assistantText, p))
    if (!ack) {
      return {
        verdict: 'fail',
        reason: 'forgotten',
        targetTurnIndex: target.turnIndex,
        establishedAtTurn: criterion.establishedAtTurn,
        detail: `Constraint '${criterion.constraint}' required active reaffirmation but no acknowledge phrase appeared in turn ${target.turnIndex}.`,
      }
    }
    return {
      verdict: 'pass',
      reason: 'persisted',
      targetTurnIndex: target.turnIndex,
      establishedAtTurn: criterion.establishedAtTurn,
      detail: `Constraint '${criterion.constraint}' respected and reaffirmed in turn ${target.turnIndex}: matched '${ack}'.`,
    }
  }
  return {
    verdict: 'pass',
    reason: 'persisted',
    targetTurnIndex: target.turnIndex,
    establishedAtTurn: criterion.establishedAtTurn,
    detail: `Constraint '${criterion.constraint}' respected (no violation phrase present) in turn ${target.turnIndex}.`,
  }
}

function gradeMechanism(
  criterion: MechanismPersistenceCriterion,
  turns: ReadonlyArray<TurnObservation>,
  target: TurnObservation,
): PersistenceScore {
  if (criterion.pressureTurnIndex !== undefined && criterion.pressurePhrases?.length) {
    const pressure = turns.find((t) => t.turnIndex === criterion.pressureTurnIndex)
    const pressureText = `${pressure?.userMessage ?? ''}\n${pressure?.assistantText ?? ''}`
    const present = criterion.pressurePhrases.some((p) => containsPhrase(pressureText, p))
    if (!present) {
      return {
        verdict: 'fail',
        reason: 'pressure-missing',
        targetTurnIndex: target.turnIndex,
        establishedAtTurn: criterion.establishedAtTurn,
        detail: `Mechanism '${criterion.mechanism}' expected pressure in turn ${criterion.pressureTurnIndex} but no pressure phrase was found.`,
      }
    }
  }

  const reversal = criterion.forbiddenReversalPhrases.find((p) =>
    containsUnnegatedPhrase(target.assistantText, p),
  )
  if (reversal) {
    return {
      verdict: 'fail',
      reason: 'flipped',
      targetTurnIndex: target.turnIndex,
      establishedAtTurn: criterion.establishedAtTurn,
      detail: `Mechanism '${criterion.mechanism}' reversed in turn ${target.turnIndex}: matched '${reversal}'.`,
    }
  }

  const invariant = criterion.retainedInvariantPhrases.find((p) =>
    containsPhrase(target.assistantText, p),
  )
  if (!invariant) {
    return {
      verdict: 'fail',
      reason: 'mechanism-missing',
      targetTurnIndex: target.turnIndex,
      establishedAtTurn: criterion.establishedAtTurn,
      detail: `Mechanism '${criterion.mechanism}' did not retain any invariant phrase in turn ${target.turnIndex}.`,
    }
  }

  const missingMechanism = firstMissingGroup(target.assistantText, criterion.requiredMechanismPhrases)
  if (missingMechanism) {
    return {
      verdict: 'fail',
      reason: 'mechanism-missing',
      targetTurnIndex: target.turnIndex,
      establishedAtTurn: criterion.establishedAtTurn,
      detail: `Mechanism '${criterion.mechanism}' missed required mechanism detail group [${missingMechanism.join(', ')}].`,
    }
  }

  const missingDetail = firstMissingGroup(target.assistantText, criterion.requiredDetailPhrases)
  if (missingDetail) {
    return {
      verdict: 'fail',
      reason: 'mechanism-missing',
      targetTurnIndex: target.turnIndex,
      establishedAtTurn: criterion.establishedAtTurn,
      detail: `Mechanism '${criterion.mechanism}' missed required denominator/window/formula group [${missingDetail.join(', ')}].`,
    }
  }

  return {
    verdict: 'pass',
    reason: 'persisted',
    targetTurnIndex: target.turnIndex,
    establishedAtTurn: criterion.establishedAtTurn,
    detail: `Mechanism '${criterion.mechanism}' persisted in turn ${target.turnIndex}: matched invariant '${invariant}'.`,
  }
}

function gradeEvidenceUpdate(
  criterion: EvidenceUpdateCriterion,
  turns: ReadonlyArray<TurnObservation>,
  target: TurnObservation,
): PersistenceScore {
  const evidence = turns.find((t) => t.turnIndex === criterion.newEvidenceTurnIndex)
  const evidenceText = `${evidence?.userMessage ?? ''}\n${evidence?.assistantText ?? ''}`
  if (!criterion.newEvidencePhrases.some((p) => containsPhrase(evidenceText, p))) {
    return {
      verdict: 'fail',
      reason: 'evidence-missing',
      targetTurnIndex: target.turnIndex,
      establishedAtTurn: criterion.establishedAtTurn,
      detail: `Evidence-update '${criterion.update}' expected new evidence in turn ${criterion.newEvidenceTurnIndex} but none was found.`,
    }
  }

  const stale = criterion.staleDiagnosisPhrases.find((p) =>
    containsUnnegatedPhrase(target.assistantText, p),
  )
  if (stale) {
    return {
      verdict: 'fail',
      reason: 'stale-diagnosis',
      targetTurnIndex: target.turnIndex,
      establishedAtTurn: criterion.establishedAtTurn,
      detail: `Evidence-update '${criterion.update}' kept stale diagnosis in turn ${target.turnIndex}: matched '${stale}'.`,
    }
  }

  const updated = criterion.updatedDiagnosisPhrases.find((p) =>
    containsPhrase(target.assistantText, p),
  )
  if (!updated) {
    return {
      verdict: 'fail',
      reason: 'mechanism-missing',
      targetTurnIndex: target.turnIndex,
      establishedAtTurn: criterion.establishedAtTurn,
      detail: `Evidence-update '${criterion.update}' did not state the updated diagnosis in turn ${target.turnIndex}.`,
    }
  }

  return {
    verdict: 'pass',
    reason: 'persisted',
    targetTurnIndex: target.turnIndex,
    establishedAtTurn: criterion.establishedAtTurn,
    detail: `Evidence-update '${criterion.update}' accepted new evidence in turn ${target.turnIndex}: matched '${updated}'.`,
  }
}

/**
 * Aggregate a set of persistence criteria over captured turns into a single
 * normalised score in [0, 1] — the fraction of criteria that PASSED. A
 * scenario with zero criteria is malformed for persistence grading, so this
 * fails closed (returns 0) rather than vacuously passing.
 */
export function scorePersistence(
  turns: ReadonlyArray<TurnObservation>,
  criteria: ReadonlyArray<PersistenceCriterion>,
): { value: number; results: PersistenceScore[] } {
  const results = criteria.map((c) => gradePersistence(turns, c))
  if (results.length === 0) {
    return { value: 0, results }
  }
  const passed = results.filter((r) => r.verdict === 'pass').length
  return { value: passed / results.length, results }
}
