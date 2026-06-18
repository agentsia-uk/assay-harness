import type { Dataset, RunRecord } from './types.js'
import { computeScenarioSetHash } from './serialiser.js'

export interface ValidationResult {
  valid: boolean
  errors: string[]
}

/**
 * Raised when a scored corpus does not match the scenario-set hash a contract
 * (or a previously-pinned run) declared. This is the Tier-1 #2 integrity gate:
 * a score must be bound to a UNIQUE corpus, so two consumers scoring different
 * scenario sets cannot both publish "the same release's score".
 */
export class ScenarioSetHashMismatchError extends Error {
  readonly expected: string
  readonly actual: string

  constructor(expected: string, actual: string) {
    super(
      `scenario-set hash mismatch: the corpus scored hashes to "${actual}" but ` +
        `the declared contract hash is "${expected}". The harness refuses to ` +
        `score or publish a corpus that does not match its declared identity — ` +
        `two consumers scoring different corpora must not both emit the same ` +
        `release score. Regenerate the contract for this corpus, or score the ` +
        `corpus the contract was cut from.`,
    )
    this.name = 'ScenarioSetHashMismatchError'
    this.expected = expected
    this.actual = actual
  }
}

/**
 * Refuse-on-mismatch guard. Computes the corpus hash for `dataset` and throws
 * {@link ScenarioSetHashMismatchError} unless it equals `expectedHash`. Call
 * this BEFORE scoring or publishing whenever a run is bound to a declared
 * contract hash (e.g. the `scenarioSetHash` of an assay-release-contract).
 *
 * Returns the computed hash so callers can stamp it onto the RunRecord.
 */
export function assertScenarioSetHashMatches(
  dataset: Dataset,
  expectedHash: string,
): string {
  const actual = computeScenarioSetHash(dataset)
  if (actual !== expectedHash) {
    throw new ScenarioSetHashMismatchError(expectedHash, actual)
  }
  return actual
}

/**
 * Raised when a run's outcome-type stratification is too sparse or too
 * imbalanced to publish a composite leaderboard claim from. Mirrors
 * Modelsmith's `ScenarioStratificationPublicationError`: coverage that is
 * merely recorded but never enforced is silent degradation, so this is the
 * fail-closed counterpart for the harness publish path (Tier-1 #4).
 */
export class ScenarioStratificationPublicationError extends Error {
  readonly reasons: string[]

  constructor(reasons: string[]) {
    super(
      `scenario stratification is not publishable: ${reasons.join('; ')}. ` +
        `Outcome-type coverage (tp / tn / fp-guard / fn-guard) must be present ` +
        `and balanced before a composite is leaderboard-eligible.`,
    )
    this.name = 'ScenarioStratificationPublicationError'
    this.reasons = reasons
  }
}

/** The four outcome types every publishable run must cover. */
export const REQUIRED_OUTCOME_TYPES = ['tp', 'tn', 'fp-guard', 'fn-guard'] as const

export interface StratificationGuardOptions {
  /**
   * The smallest allowed share for any required outcome type, as a fraction of
   * the total covered items. An outcome type whose share falls below this is an
   * imbalance failure. Defaults to 0.05 (5%).
   */
  minShare?: number
}

/**
 * Stratification publication guard. Fails closed when any required outcome type
 * (tp / tn / fp-guard / fn-guard) is missing from `outcomeCoverage`, or when a
 * present type is so under-represented it cannot support a balanced composite.
 *
 * `outcomeCoverage` is the per-outcome-type item count produced by
 * `analyseScenarioItems(...).outcomeCoverage`.
 */
export function assertScenarioStratificationPublishable(
  outcomeCoverage: Record<string, number>,
  options: StratificationGuardOptions = {},
): void {
  const minShare = options.minShare ?? 0.05
  const reasons: string[] = []

  const total = REQUIRED_OUTCOME_TYPES.reduce(
    (sum, type) => sum + (outcomeCoverage[type] ?? 0),
    0,
  )

  for (const type of REQUIRED_OUTCOME_TYPES) {
    const count = outcomeCoverage[type] ?? 0
    if (count === 0) {
      reasons.push(`outcome type "${type}" has no covered scenarios`)
    }
  }

  if (total === 0) {
    reasons.push('no scenarios carry a recognised outcome type')
  } else {
    for (const type of REQUIRED_OUTCOME_TYPES) {
      const count = outcomeCoverage[type] ?? 0
      if (count > 0 && count / total < minShare) {
        reasons.push(
          `outcome type "${type}" is only ${count}/${total} ` +
            `(${(100 * count / total).toFixed(1)}%) of covered items, ` +
            `below the ${(100 * minShare).toFixed(0)}% balance floor`,
        )
      }
    }
  }

  if (reasons.length > 0) {
    throw new ScenarioStratificationPublicationError(reasons)
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function requireString(obj: Record<string, unknown>, key: string, path: string, errors: string[]): boolean {
  if (typeof obj[key] !== 'string' || (obj[key] as string).length === 0) {
    errors.push(`${path}.${key} must be a non-empty string`)
    return false
  }
  return true
}

function requireNumber(obj: Record<string, unknown>, key: string, path: string, errors: string[]): boolean {
  if (typeof obj[key] !== 'number' || !Number.isFinite(obj[key] as number)) {
    errors.push(`${path}.${key} must be a finite number`)
    return false
  }
  return true
}

function requireArray(obj: Record<string, unknown>, key: string, path: string, errors: string[]): boolean {
  if (!Array.isArray(obj[key])) {
    errors.push(`${path}.${key} must be an array`)
    return false
  }
  return true
}

function validateModelResponse(v: unknown, path: string, errors: string[]): boolean {
  if (!isRecord(v)) { errors.push(`${path} must be an object`); return false }
  let ok = true
  ok = requireString(v, 'runnerId', path, errors) && ok
  ok = requireString(v, 'scenarioId', path, errors) && ok
  if (typeof v['output'] !== 'string') { errors.push(`${path}.output must be a string`); ok = false }
  const meta = v['meta']
  if (!isRecord(meta)) {
    errors.push(`${path}.meta must be an object`)
    ok = false
  } else {
    ok = requireString(meta, 'provider', `${path}.meta`, errors) && ok
    ok = requireString(meta, 'model', `${path}.meta`, errors) && ok
    ok = requireString(meta, 'accessedAt', `${path}.meta`, errors) && ok
    ok = requireNumber(meta, 'latencyMs', `${path}.meta`, errors) && ok
  }
  return ok
}

function validateScore(v: unknown, path: string, errors: string[]): boolean {
  if (!isRecord(v)) { errors.push(`${path} must be an object`); return false }
  let ok = true
  ok = requireString(v, 'runnerId', path, errors) && ok
  ok = requireString(v, 'scenarioId', path, errors) && ok
  ok = requireString(v, 'axis', path, errors) && ok
  if (typeof v['value'] !== 'number' || !Number.isFinite(v['value'] as number) || (v['value'] as number) < 0 || (v['value'] as number) > 1) {
    errors.push(`${path}.value must be a finite number in [0, 1]`)
    ok = false
  }
  return ok
}

function validateAxisAggregate(v: unknown, path: string, errors: string[]): boolean {
  if (!isRecord(v)) { errors.push(`${path} must be an object`); return false }
  let ok = true
  ok = requireNumber(v, 'mean', path, errors) && ok
  ok = requireNumber(v, 'variance', path, errors) && ok
  if (typeof v['n'] !== 'number' || !Number.isInteger(v['n']) || (v['n'] as number) < 0) {
    errors.push(`${path}.n must be a non-negative integer`)
    ok = false
  }
  return ok
}

function validateModelAggregate(v: unknown, path: string, errors: string[]): boolean {
  if (!isRecord(v)) { errors.push(`${path} must be an object`); return false }
  let ok = true
  ok = requireString(v, 'runnerId', path, errors) && ok
  ok = requireNumber(v, 'composite', path, errors) && ok
  const axes = v['axes']
  if (!isRecord(axes)) {
    errors.push(`${path}.axes must be an object`)
    ok = false
  } else {
    for (const [axis, agg] of Object.entries(axes)) {
      ok = validateAxisAggregate(agg, `${path}.axes.${axis}`, errors) && ok
    }
  }
  const weights = v['weights']
  if (!isRecord(weights)) {
    errors.push(`${path}.weights must be an object`)
    ok = false
  }
  return ok
}

export function validateRunRecord(value: unknown): ValidationResult {
  const errors: string[] = []

  if (!isRecord(value)) {
    return { valid: false, errors: ['RunRecord must be a plain object'] }
  }

  requireString(value, 'id', 'RunRecord', errors)
  requireString(value, 'createdAt', 'RunRecord', errors)

  const dataset = value['dataset']
  if (!isRecord(dataset)) {
    errors.push('RunRecord.dataset must be an object')
  } else {
    requireString(dataset, 'name', 'RunRecord.dataset', errors)
    requireString(dataset, 'version', 'RunRecord.dataset', errors)
  }

  // scenarioSetHash is optional for backwards compatibility, but when present
  // it must be a non-empty string (it binds the run to a unique corpus).
  if (value['scenarioSetHash'] !== undefined) {
    requireString(value, 'scenarioSetHash', 'RunRecord', errors)
  }

  if (!Array.isArray(value['runners'])) {
    errors.push('RunRecord.runners must be an array')
  } else {
    for (const r of value['runners'] as unknown[]) {
      if (typeof r !== 'string') errors.push('RunRecord.runners must contain only strings')
    }
  }

  if (requireArray(value, 'responses', 'RunRecord', errors)) {
    ;(value['responses'] as unknown[]).forEach((r, i) =>
      validateModelResponse(r, `RunRecord.responses[${i}]`, errors),
    )
  }

  if (requireArray(value, 'scores', 'RunRecord', errors)) {
    ;(value['scores'] as unknown[]).forEach((s, i) =>
      validateScore(s, `RunRecord.scores[${i}]`, errors),
    )
  }

  if (requireArray(value, 'aggregates', 'RunRecord', errors)) {
    ;(value['aggregates'] as unknown[]).forEach((a, i) =>
      validateModelAggregate(a, `RunRecord.aggregates[${i}]`, errors),
    )
  }

  const meta = value['meta']
  if (!isRecord(meta)) {
    errors.push('RunRecord.meta must be an object')
  } else {
    requireString(meta, 'harnessVersion', 'RunRecord.meta', errors)
  }

  return { valid: errors.length === 0, errors }
}

export function assertValidRunRecord(value: unknown): asserts value is RunRecord {
  const result = validateRunRecord(value)
  if (!result.valid) {
    throw new Error(`RunRecord validation failed:\n${result.errors.map((e) => `  - ${e}`).join('\n')}`)
  }
}
