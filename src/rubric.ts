import type {
  HumanAnnotation,
  HumanAnnotationValidation,
  LLMJudgeExecutor,
  LLMJudgeResult,
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
      if (rubric.claimPolicy === 'benchmark-eligible' && !rubric.biasChecks?.length) {
        throw new Error(
          'rubric: benchmark-eligible llm-judge bias check evidence is required',
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
      })).then((result) => {
        validateJudgeResult(result, calibration.promptHash)
        return {
          value: clampScore(result.value),
          ...(result.rationale ? { rationale: result.rationale } : {}),
          judgeProvenance: result.provenance,
          claimStatus: rubric.claimPolicy ?? 'analysis-only',
        }
      })
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
  const annotationsByResponse = new Map<string, HumanAnnotation[]>()

  for (const [index, annotation] of annotations.entries()) {
    const prefix = `annotation[${index}]`
    if (!annotation.itemId) errors.push(`${prefix}: missing itemId`)
    if (!annotation.scenarioHash) errors.push(`${prefix}: missing scenarioHash`)
    if (!annotation.responseId) errors.push(`${prefix}: missing responseId`)
    if (!annotation.reviewer) errors.push(`${prefix}: missing reviewer`)
    if (!annotation.rubricVersion) errors.push(`${prefix}: missing rubricVersion`)
    if (!isHumanLabel(annotation.label)) {
      errors.push(`${prefix}: label must be pass, fail, tie, or invalid`)
    }
    if (!isHumanStatus(annotation.status)) {
      errors.push(`${prefix}: status must be pending, agreed, conflicted, adjudicated, or rejected`)
    }
    if (typeof annotation.annotatedAt !== 'string' || Number.isNaN(Date.parse(annotation.annotatedAt))) {
      errors.push(`${prefix}: annotatedAt must be an ISO timestamp`)
    }
    if (typeof annotation.score !== 'number' || !Number.isFinite(annotation.score) || annotation.score < 0 || annotation.score > 1) {
      errors.push(`${prefix}: score must be normalised 0..1`)
    }
    if (annotation.status === 'adjudicated') {
      if (!annotation.adjudicator) {
        errors.push(`${prefix}: adjudicated annotations require adjudicator`)
      }
      if (!annotation.adjudicatedAt || Number.isNaN(Date.parse(annotation.adjudicatedAt))) {
        errors.push(`${prefix}: adjudicated annotations require ISO adjudicatedAt`)
      }
    }

    const key = annotationResponseKey(annotation.itemId, annotation.responseId)
    const bucket = annotationsByResponse.get(key) ?? []
    bucket.push(annotation)
    annotationsByResponse.set(key, bucket)
  }

  const conflicts: HumanAnnotationValidation['conflicts'] = []
  for (const annotationsForResponse of annotationsByResponse.values()) {
    const first = annotationsForResponse[0]
    if (!first) continue
    const adjudicated = annotationsForResponse.filter((annotation) => annotation.status === 'adjudicated')
    if (annotationsForResponse.some((annotation) => annotation.status === 'conflicted') && adjudicated.length === 0) {
      errors.push(
        `annotation group itemId=${first.itemId} responseId=${first.responseId}: ` +
          'conflicted status requires an adjudicated annotation',
      )
    }
    const terminal = adjudicated.length > 0
      ? adjudicated
      : annotationsForResponse.filter((annotation) => annotation.status !== 'rejected')
    const labels = new Set(terminal.map((annotation) => annotation.label))
    if (labels.size > 1) {
      conflicts.push({
        itemId: first.itemId,
        responseId: first.responseId,
        labels: [...labels].sort(),
      })
    }
  }

  return { valid: errors.length === 0 && conflicts.length === 0, errors, conflicts }
}

export function annotationsToPreferencePairs(
  annotations: HumanAnnotation[],
): PreferencePair[] {
  const byItem = new Map<string, HumanAnnotation[]>()
  for (const annotation of terminalHumanAnnotations(annotations)) {
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

function validateJudgeResult(result: LLMJudgeResult, expectedPromptHash: string): void {
  if (!result.provenance) {
    throw new Error('rubric: llm-judge provenance is required')
  }
  const provenance = result.provenance
  if (provenance.promptHash !== expectedPromptHash) {
    throw new Error(
      `rubric: llm-judge provenance prompt hash "${provenance.promptHash}" ` +
        `does not match calibration prompt hash "${expectedPromptHash}"`,
    )
  }
  if (!provenance.provider) throw new Error('rubric: llm-judge provenance provider is required')
  if (!provenance.model) throw new Error('rubric: llm-judge provenance model is required')
  if (!provenance.rubricVersion) {
    throw new Error('rubric: llm-judge provenance rubricVersion is required')
  }
  if (!provenance.parserVersion) {
    throw new Error('rubric: llm-judge provenance parserVersion is required')
  }
  if (!provenance.judgedAt || Number.isNaN(Date.parse(provenance.judgedAt))) {
    throw new Error('rubric: llm-judge provenance judgedAt must be an ISO timestamp')
  }
}

function terminalHumanAnnotations(annotations: HumanAnnotation[]): HumanAnnotation[] {
  const byResponse = new Map<string, HumanAnnotation[]>()
  for (const annotation of annotations) {
    if (!['agreed', 'adjudicated'].includes(annotation.status)) continue
    const key = annotationResponseKey(annotation.itemId, annotation.responseId)
    const bucket = byResponse.get(key) ?? []
    bucket.push(annotation)
    byResponse.set(key, bucket)
  }

  const terminal: HumanAnnotation[] = []
  for (const annotationsForResponse of byResponse.values()) {
    const adjudicated = annotationsForResponse
      .filter((annotation) => annotation.status === 'adjudicated')
      .sort((a, b) => annotationTime(b) - annotationTime(a))
    if (adjudicated[0]) {
      terminal.push(adjudicated[0])
      continue
    }
    const agreed = annotationsForResponse
      .filter((annotation) => annotation.status === 'agreed')
      .sort((a, b) => b.score - a.score)
    if (agreed[0]) terminal.push(agreed[0])
  }
  return terminal
}

function annotationTime(annotation: HumanAnnotation): number {
  const value = annotation.adjudicatedAt ?? annotation.annotatedAt
  const time = Date.parse(value)
  return Number.isNaN(time) ? 0 : time
}

function annotationResponseKey(itemId: string, responseId: string): string {
  return `${itemId}\x00${responseId}`
}

function isHumanLabel(value: unknown): value is HumanAnnotation['label'] {
  return value === 'pass' || value === 'fail' || value === 'tie' || value === 'invalid'
}

function isHumanStatus(value: unknown): value is HumanAnnotation['status'] {
  return (
    value === 'pending' ||
    value === 'agreed' ||
    value === 'conflicted' ||
    value === 'adjudicated' ||
    value === 'rejected'
  )
}

function clampScore(value: number): number {
  return Math.min(1, Math.max(0, value))
}
