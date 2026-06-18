/**
 * Executable mechanism scorer.
 *
 * Ported from Modelsmith's `src/lib/eval/scenarios/adtech/_mechanism-rubric.ts`
 * for agentsia-uk/assay-harness#54 (council `assay-harness-review-2026-06-18`,
 * Tier-2 #5). This is the executable enforcement of the anti-bingo claim the
 * README makes: prose `passCriteria` were exposed but no scoring path could
 * actually enforce them.
 *
 * A mechanism answer is scored on three gates:
 *
 *   1. QUANTITATIVE — the load-bearing magnitude / id from the scenario must be
 *      surfaced (a number, a percentage split, an id). Echoing topic vocabulary
 *      is not enough; the answer has to cite the figure the decision turns on.
 *
 *   2. DISAMBIGUATION — the answer must show it distinguished the correct
 *      mechanism from a plausible-but-wrong alternative ("distinct from
 *      last-click", "not the same device", etc.).
 *
 *   3. ACTION — the answer must propose a concrete, signal-derived action
 *      (suppress, raise floor by N, run a lift study), not a vague "investigate".
 *
 * ANTI-BINGO HARD CAP: if the only support the answer offers is scenario
 * vocabulary (a bingo token echoed) with NO quantitative anchor and NO
 * disambiguation, the score is capped at {@link ANTI_BINGO_CAP} (0.2)
 * regardless of how many topical keywords were echoed.
 *
 * All matching is negation-aware and word-edge anchored (see `matchers.ts`), so
 * "this is NOT invalid traffic" no longer satisfies an "invalid traffic" gate.
 *
 * Exposing this RULE is not exposing an answer key — the gates describe the
 * *shape* of a correct mechanism, not the per-scenario answer. The
 * public-rule / private-field split is enforced at scenario load
 * (`rejectUnexpectedKeys` in loader/validate); a scenario's private grading
 * fields never ride in the public scorer rule.
 */

import { containsUnnegatedMatch, tokenPresent } from './matchers.js'

/**
 * GOVERNED CONSTANT (Rule-28). Hard cap applied when an answer's only support is
 * echoed scenario vocabulary (a bingo token) with no quantitative anchor and no
 * disambiguation.
 *
 * Derivation: the cap has to sit strictly below the 0.5 pass threshold (a
 * pure-vocabulary answer must FAIL) and strictly above 0.0 (a non-zero floor
 * keeps GRPO-style reward signals off a hard cliff, so a model that at least
 * named the right domain is not indistinguishable from one that produced
 * garbage). 0.2 is the midpoint of the (0, 0.45] band below the lowest single
 * graded gate weight (quantitative = 0.45), which keeps a bingo echo provably
 * worse than landing even one real gate. Inherited verbatim from the Modelsmith
 * rubric that this scorer is ported from. Verified by
 * `tests/scoring-constants.test.ts`.
 *
 * If you change this value you MUST update `docs/scoring-constants.md` and the
 * governance assertion in `tests/scoring-constants.test.ts`.
 */
export const ANTI_BINGO_CAP = 0.2

/** Pass threshold for a mechanism gate. */
export const MECHANISM_PASS_THRESHOLD = 0.5

/**
 * GOVERNED CONSTANTS (Rule-28). Frontier-corroboration quorum required before a
 * composite scored by this harness is publishable as a headline claim: at least
 * {@link FRONTIER_QUORUM_REQUIRED} of {@link FRONTIER_QUORUM_TOTAL} independent
 * frontier reference graders must corroborate the corpus's intended outcome
 * labels (≥2/3).
 *
 * Derivation: one grader gives no cross-check; 3/3 unanimity is too brittle and
 * would discard a corpus on a single grader's outlier. 2/3 is the smallest
 * majority that survives one grader disagreeing, matching the council's own
 * 3-reviewer 2/3 quorum convention. See `docs/scoring-constants.md`. The values
 * are asserted in `tests/scoring-constants.test.ts` so the gate cannot quietly
 * relax to "any one grader agrees". The publication gate that consumes these is
 * wired in cli.ts (Tier-1 #4, separate change); the constants live with the
 * scorer they govern.
 */
export const FRONTIER_QUORUM_REQUIRED = 2
export const FRONTIER_QUORUM_TOTAL = 3

/** Gate weights. Quantitative is the load-bearing mechanism. */
const QUANT_WEIGHT = 0.45
const DISAMBIG_WEIGHT = 0.35
const ACTION_WEIGHT = 0.2

export interface MechanismGate {
  /** Friendly label surfaced in the rationale when the gate is missed. */
  label: string
  /** Regex source strings or literal phrases; ANY match satisfies the gate. */
  matchers: Array<RegExp | string>
}

export interface MechanismCriteria {
  /** Quantitative gates — at least one must be satisfied for a non-zero base. */
  quantitative: MechanismGate[]
  /** Disambiguation gates — answer must distinguish correct from plausible-wrong. */
  disambiguation: MechanismGate[]
  /** Concrete signal-derived action gates. */
  actions: MechanismGate[]
  /**
   * Vocabulary tokens that on their own indicate keyword-bingo. Present without
   * ANY quantitative AND ANY disambiguation gate => anti-bingo cap.
   */
  bingoTokens: Array<RegExp | string>
}

export interface MechanismScore {
  /** Normalised 0..1. */
  value: number
  /** Human-readable breakdown. */
  rationale: string
  passed: boolean
  bingoGuardTripped: boolean
}

function gateSatisfied(text: string, gate: MechanismGate): boolean {
  return containsUnnegatedMatch(text, gate.matchers)
}

/**
 * Score a response against a scenario's mechanism criteria. Pure and
 * deterministic — the same (text, criteria) always produces the same score.
 */
export function scoreMechanism(text: string, criteria: MechanismCriteria): MechanismScore {
  const quantHits = criteria.quantitative.filter((g) => gateSatisfied(text, g))
  const disambigHits = criteria.disambiguation.filter((g) => gateSatisfied(text, g))
  const actionHits = criteria.actions.filter((g) => gateSatisfied(text, g))

  const bingoEcho = criteria.bingoTokens.some((t) => tokenPresent(text, t))
  const anyQuant = quantHits.length > 0
  const anyDisambig = disambigHits.length > 0
  const tripsBingoGuard = bingoEcho && !anyQuant && !anyDisambig

  const quantFraction =
    criteria.quantitative.length === 0 ? 1 : quantHits.length / criteria.quantitative.length
  const disambigFraction =
    criteria.disambiguation.length === 0 ? 1 : disambigHits.length / criteria.disambiguation.length
  const actionFraction =
    criteria.actions.length === 0 ? 1 : actionHits.length / criteria.actions.length

  let value: number
  if (tripsBingoGuard) {
    value = ANTI_BINGO_CAP
  } else if (!anyQuant && !anyDisambig) {
    value = 0
  } else {
    value =
      QUANT_WEIGHT * quantFraction +
      DISAMBIG_WEIGHT * disambigFraction +
      ACTION_WEIGHT * actionFraction
  }

  const passed = value >= MECHANISM_PASS_THRESHOLD

  const missing: string[] = []
  for (const g of criteria.quantitative) if (!gateSatisfied(text, g)) missing.push(`quant[${g.label}]`)
  for (const g of criteria.disambiguation) if (!gateSatisfied(text, g)) missing.push(`disambig[${g.label}]`)
  for (const g of criteria.actions) if (!gateSatisfied(text, g)) missing.push(`action[${g.label}]`)
  if (tripsBingoGuard) missing.push('ANTI-BINGO: vocabulary echoed without any quantitative or disambiguation anchor')

  const rationale =
    `quant=${quantHits.length}/${criteria.quantitative.length}, ` +
    `disambig=${disambigHits.length}/${criteria.disambiguation.length}, ` +
    `action=${actionHits.length}/${criteria.actions.length}, ` +
    `bingo_guard=${tripsBingoGuard}, score=${value.toFixed(2)}` +
    (missing.length > 0 ? ` | missing: ${missing.join('; ')}` : '')

  return { value, rationale, passed, bingoGuardTripped: tripsBingoGuard }
}

/**
 * Coerce a JSON-authored gate (matchers are plain strings, optionally
 * `/.../flags` regex literals) into the runtime {@link MechanismGate} shape.
 * Scenario JSON cannot carry live RegExp objects, so a leading-and-trailing `/`
 * marks a value as a regex source; everything else is a literal phrase.
 */
export function coerceMatcher(raw: string): RegExp | string {
  const m = /^\/(.+)\/([a-z]*)$/i.exec(raw)
  if (m) return new RegExp(m[1], m[2])
  return raw
}

export function coerceGate(raw: { label: string; matchers: string[] }): MechanismGate {
  return { label: raw.label, matchers: raw.matchers.map(coerceMatcher) }
}

export function coerceCriteria(raw: {
  quantitative: Array<{ label: string; matchers: string[] }>
  disambiguation: Array<{ label: string; matchers: string[] }>
  actions: Array<{ label: string; matchers: string[] }>
  bingoTokens: string[]
}): MechanismCriteria {
  return {
    quantitative: raw.quantitative.map(coerceGate),
    disambiguation: raw.disambiguation.map(coerceGate),
    actions: raw.actions.map(coerceGate),
    bingoTokens: raw.bingoTokens.map(coerceMatcher),
  }
}
