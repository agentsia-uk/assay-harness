import type { ModelResponse, Rubric, Scenario, Score } from './types.js'

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
   * contains: response must contain every string in params.expected (array).
   */
  contains: (response, _scenario, params = {}) => {
    const expected = Array.isArray(params['expected'])
      ? (params['expected'] as string[])
      : []
    const haystack = response.output.toLowerCase()
    const missing = expected.filter((s) => !haystack.includes(s.toLowerCase()))
    return {
      value: expected.length === 0 ? 1 : 1 - missing.length / expected.length,
      rationale: missing.length === 0 ? 'all terms present' : `missing: ${missing.join(', ')}`,
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
export function score(response: ModelResponse, scenario: Scenario): Score[] {
  const value = applyRubric(scenario.rubric, response, scenario)
  return scenario.axes.map((axis) => ({
    runnerId: response.runnerId,
    scenarioId: scenario.id,
    axis,
    value: value.value,
    ...(value.rationale ? { rationale: value.rationale } : {}),
    ...(scenario.rubric.kind === 'llm-judge' ? { judge: scenario.rubric.judge } : {}),
  }))
}

function applyRubric(
  rubric: Rubric,
  response: ModelResponse,
  scenario: Scenario,
): { value: number; rationale?: string } {
  switch (rubric.kind) {
    case 'programmatic': {
      const fn = checkers[rubric.checker]
      if (!fn) {
        throw new Error(
          `rubric: unknown programmatic checker "${rubric.checker}". ` +
            `Registered: ${Object.keys(checkers).join(', ')}`,
        )
      }
      return fn(response, scenario, rubric.params)
    }
    case 'llm-judge':
      throw new Error(
        `rubric: llm-judge evaluation not yet implemented. Ships with Assay-Adtech v1.`,
      )
    case 'human':
      throw new Error(
        `rubric: human evaluation requires the panel annotation interface (not in v0).`,
      )
  }
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
