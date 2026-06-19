import type {
  HumanAnnotation,
  HumanAnnotationValidation,
  LLMJudgeExecutor,
  MechanismRubric,
  ModelResponse,
  PreferencePair,
  Rubric,
  Scenario,
  Score,
} from './types.js'
import { ANTI_BINGO_CAP, coerceCriteria, scoreMechanism } from './mechanism.js'
import { containsUnnegatedMatch } from './matchers.js'

type Checker = (
  response: ModelResponse,
  scenario: Scenario,
  params?: Record<string, unknown>,
) => { value: number; rationale?: string }

/**
 * Built-in programmatic checkers.
 *
 * Register new checkers here keyed by a stable identifier that scenario
 * authors reference in scenario.rubric.checker. Changes to existing checker
 * semantics are breaking and require a dataset major-version bump.
 */
const checkers: Record<string, Checker> = {
  /**
   * exact-match: response text must equal params.expected verbatim after
   * trimming whitespace and normalising case.
   */
  'exact-match': (response, _scenario, params = {}) => {
    const expected = typeof params['expected'] === 'string' ? params['expected'] : ''
    const caseInsensitive = params['caseInsensitive'] !== false
    const a = response.output.trim()
    const b = expected.trim()
    const match = caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b
    return {
      value: match ? 1 : 0,
      rationale: match ? 'exact-match' : `expected "${b}", got "${a.slice(0, 120)}"`,
    }
  },

  /**
   * contains (SMOKE-TEST ONLY): naive substring presence. Kept for end-to-end
   * harness smoke tests, NOT for headline scoring. It is sign-blind — it credits
   * "this is NOT invalid traffic" for an "invalid traffic" term — so anything
   * graded against a leaderboard MUST use the negation-aware `keyword` checker
   * or a `mechanism` rubric. See assay-harness#54 / council
   * `assay-harness-review-2026-06-18` Tier-1 #1.
   */
  contains: (response, _scenario, params = {}) => {
    const expected = Array.isArray(params['expected'])
      ? (params['expected'] as string[])
      : []
    const haystack = response.output.toLowerCase()
    const missing = expected.filter((s) => !haystack.includes(s.toLowerCase()))
    const rawValue = expected.length === 0 ? 1 : 1 - missing.length / expected.length
    const smokeTestOnly = params['smokeTestOnly'] === true
    const value = smokeTestOnly ? rawValue : Math.min(rawValue, ANTI_BINGO_CAP)
    return {
      value,
      rationale:
        (missing.length === 0 ? 'all terms present' : `missing: ${missing.join(', ')}`) +
        (smokeTestOnly
          ? ' [smoke-test-only: not negation-aware]'
          : ` [contains capped at ${ANTI_BINGO_CAP}; use keyword/mechanism for benchmark scoring]`),
    }
  },

  /**
   * keyword: negation-aware, word-edge replacement for `contains`. A term only
   * counts if it appears in a clause that is NOT locally negated, so
   * "do NOT flag" does not satisfy a `flag` term. Score is the fraction of
   * required terms with at least one un-negated, word-edge match.
   */
  keyword: (response, _scenario, params = {}) => {
    const expected = Array.isArray(params['expected'])
      ? (params['expected'] as string[])
      : []
    if (expected.length === 0) return { value: 1, rationale: 'no terms required' }
    const missing = expected.filter(
      (term) => !containsUnnegatedMatch(response.output, [term]),
    )
    return {
      value: 1 - missing.length / expected.length,
      rationale:
        missing.length === 0
          ? 'all terms present (un-negated)'
          : `missing or negated: ${missing.join(', ')}`,
    }
  },

  /**
   * non-empty: response must contain at least params.minChars characters.
   */
  'non-empty': (response, _scenario, params = {}) => {
    const minChars = typeof params['minChars'] === 'number' ? params['minChars'] : 1
    const len = response.output.trim().length
    return {
      value: len >= minChars ? 1 : 0,
      rationale: `length=${len}, min=${minChars}`,
    }
  },
}

/**
 * Evaluate a model response against a scenario's rubric. Returns one Score
 * per axis in the scenario (every score for a single rubric uses the same
 * value).
 */
export function score(response: ModelResponse, scenario: Scenario): Score[]
export function score(
  response: ModelResponse,
  scenario: Scenario,
  options: RubricEvaluationOptions,
): Score[] | Promise<Score[]>
export function score(
  response: ModelResponse,
  scenario: Scenario,
  options: RubricEvaluationOptions = {},
): Score[] | Promise<Score[]> {
  const value = applyRubric(scenario.rubric, response, scenario, options)
  if (value instanceof Promise) {
    return value.then((resolved) => scoresFromRubricResult(response, scenario, resolved))
  }
  return scoresFromRubricResult(response, scenario, value)
}

export interface RubricEvaluationOptions {
  llmJudge?: LLMJudgeExecutor
}

function scoresFromRubricResult(
  response: ModelResponse,
  scenario: Scenario,
  value: {
    value: number
    rationale?: string
    judgeProvenance?: Score['judgeProvenance']
    claimStatus?: Score['claimStatus']
  },
): Score[] {
  return scenario.axes.map((axis) => ({
    runnerId: response.runnerId,
    scenarioId: scenario.id,
    axis,
    value: value.value,
    ...(value.rationale ? { rationale: value.rationale } : {}),
    ...(scenario.rubric.kind === 'llm-judge' ? { judge: scenario.rubric.judge } : {}),
    ...(value.judgeProvenance ? { judgeProvenance: value.judgeProvenance } : {}),
    ...(value.claimStatus ? { claimStatus: value.claimStatus } : {}),
  }))
}

function applyRubric(
  rubric: Rubric,
  response: ModelResponse,
  scenario: Scenario,
  options: RubricEvaluationOptions = {},
): {
  value: number
  rationale?: string
  judgeProvenance?: Score['judgeProvenance']
  claimStatus?: Score['claimStatus']
} | Promise<{
  value: number
  rationale?: string
  judgeProvenance?: Score['judgeProvenance']
  claimStatus?: Score['claimStatus']
}> {
  switch (rubric.kind) {
    case 'programmatic': {
      const fn = checkers[rubric.checker]
      if (!fn) {
        throw new Error(
          `rubric: unknown programmatic checker "${rubric.checker}". ` +
            `Registered: ${Object.keys(checkers).join(', ')}`,
        )
      }
      return {
        ...fn(response, scenario, rubric.params),
        claimStatus: 'programmatic',
      }
    }
    case 'mechanism': {
      return {
        ...scoreMechanismRubric(rubric, response),
        claimStatus: 'programmatic',
      }
    }
    case 'llm-judge': {
      if (!options.llmJudge) {
        throw new Error(
          `rubric: llm-judge evaluation requires an explicit LLMJudgeExecutor.`,
        )
      }
      const calibration = rubric.calibration
      if (!calibration) {
        throw new Error('rubric: llm-judge calibration evidence is required')
      }
      if (calibration.observedAgreement < calibration.minimumAgreement) {
        throw new Error(
          `rubric: llm-judge calibration below threshold ` +
            `${calibration.observedAgreement} < ${calibration.minimumAgreement}`,
        )
      }
      const failedBias = rubric.biasChecks?.find((check) => !check.passed)
      if (failedBias) {
        throw new Error(`rubric: llm-judge bias check failed: ${failedBias.kind}`)
      }
      const renderedPrompt = rubric.prompt
        .replaceAll('{response}', response.output)
        .replaceAll('{reference}', rubric.reference ?? '')
      return Promise.resolve(options.llmJudge({
        response,
        scenario,
        rubric,
        renderedPrompt,
      })).then((result) => ({
        value: clampScore(result.value),
        ...(result.rationale ? { rationale: result.rationale } : {}),
        ...(result.provenance ? { judgeProvenance: result.provenance } : {}),
        claimStatus: rubric.claimPolicy ?? 'analysis-only',
      }))
    }
    case 'human':
      throw new Error(
        `rubric: human evaluation requires the panel annotation interface (not in v0).`,
      )
  }
}

/**
 * Score a `mechanism` rubric against a response. Deterministic and code-based,
 * so it carries claimStatus 'programmatic'. See src/mechanism.ts for the gate
 * semantics and the anti-bingo cap.
 */
function scoreMechanismRubric(
  rubric: MechanismRubric,
  response: ModelResponse,
): { value: number; rationale: string } {
  const criteria = coerceCriteria({
    quantitative: rubric.quantitative,
    disambiguation: rubric.disambiguation,
    actions: rubric.actions,
    bingoTokens: rubric.bingoTokens,
  })
  const result = scoreMechanism(response.output, criteria)
  return { value: result.value, rationale: result.rationale }
}

/**
 * Register an additional programmatic checker. Useful for release-specific
 * checkers that live alongside a dataset.
 */
export function registerChecker(name: string, fn: Checker): void {
  if (checkers[name]) {
    throw new Error(`rubric: checker "${name}" already registered`)
  }
  checkers[name] = fn
}

export function validateHumanAnnotations(
  annotations: HumanAnnotation[],
): HumanAnnotationValidation {
  const errors: string[] = []
  const labelsByItem = new Map<string, Map<string, Set<string>>>()

  for (const [index, annotation] of annotations.entries()) {
    const prefix = `annotation[${index}]`
    if (!annotation.itemId) errors.push(`${prefix}: missing itemId`)
    if (!annotation.scenarioHash) errors.push(`${prefix}: missing scenarioHash`)
    if (!annotation.responseId) errors.push(`${prefix}: missing responseId`)
    if (!annotation.reviewer) errors.push(`${prefix}: missing reviewer`)
    if (!annotation.rubricVersion) errors.push(`${prefix}: missing rubricVersion`)
    if (Number.isNaN(Date.parse(annotation.annotatedAt))) {
      errors.push(`${prefix}: annotatedAt must be an ISO timestamp`)
    }
    if (annotation.score < 0 || annotation.score > 1) {
      errors.push(`${prefix}: score must be normalised 0..1`)
    }

    const item = labelsByItem.get(annotation.itemId) ?? new Map<string, Set<string>>()
    const labels = item.get(annotation.responseId) ?? new Set<string>()
    labels.add(annotation.label)
    item.set(annotation.responseId, labels)
    labelsByItem.set(annotation.itemId, item)
  }

  const conflicts: HumanAnnotationValidation['conflicts'] = []
  for (const [itemId, byResponse] of labelsByItem) {
    for (const [responseId, labels] of byResponse) {
      if (labels.size > 1) {
        conflicts.push({ itemId, responseId, labels: [...labels].sort() })
      }
    }
  }

  return { valid: errors.length === 0 && conflicts.length === 0, errors, conflicts }
}

export function annotationsToPreferencePairs(
  annotations: HumanAnnotation[],
): PreferencePair[] {
  const byItem = new Map<string, HumanAnnotation[]>()
  for (const annotation of annotations) {
    if (!['agreed', 'adjudicated'].includes(annotation.status)) continue
    const bucket = byItem.get(annotation.itemId) ?? []
    bucket.push(annotation)
    byItem.set(annotation.itemId, bucket)
  }

  const pairs: PreferencePair[] = []
  for (const [itemId, itemAnnotations] of byItem) {
    const passed = itemAnnotations
      .filter((annotation) => annotation.label === 'pass')
      .sort((a, b) => b.score - a.score)
    const failed = itemAnnotations
      .filter((annotation) => annotation.label === 'fail')
      .sort((a, b) => a.score - b.score)
    if (passed.length === 0 || failed.length === 0) continue
    pairs.push({
      itemId,
      scenarioHash: passed[0].scenarioHash,
      chosenResponseId: passed[0].responseId,
      rejectedResponseId: failed[0].responseId,
      source: 'human-annotation',
      rubricVersion: passed[0].rubricVersion,
    })
  }
  return pairs
}

function clampScore(value: number): number {
  return Math.min(1, Math.max(0, value))
}
