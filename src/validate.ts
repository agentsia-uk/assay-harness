import { auditScenarioSet } from './diagnostics.js'
import type { ClaimCard, Dataset, RunRecord, Score } from './types.js'
import {
  SCENARIO_SET_HASH_SCHEMA_V1,
  SCENARIO_SET_HASH_SCHEMA_V2,
  computeScenarioSetHash,
} from './serialiser.js'

export interface ValidationResult {
  valid: boolean
  errors: string[]
}

export interface ClaimEligibilityOptions {
  dataset?: Dataset
  claimCard?: ClaimCard
  now?: Date | string
}

export class ClaimEligibilityError extends Error {
  readonly errors: string[]

  constructor(errors: string[]) {
    super(`leaderboard claim eligibility failed:\n${errors.map((e) => `  - ${e}`).join('\n')}`)
    this.name = 'ClaimEligibilityError'
    this.errors = errors
  }
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

export function validateClaimCard(value: unknown, now: Date | string = new Date()): ValidationResult {
  const errors: string[] = []
  if (!isRecord(value)) return { valid: false, errors: ['ClaimCard must be a plain object'] }

  if (value['schemaVersion'] !== 'assay.claim-card.v1') {
    errors.push('ClaimCard.schemaVersion must be "assay.claim-card.v1"')
  }
  const dataset = requireObject(value, 'dataset', 'ClaimCard', errors)
  if (dataset) {
    requireString(dataset, 'name', 'ClaimCard.dataset', errors)
    requireString(dataset, 'version', 'ClaimCard.dataset', errors)
  }
  requireString(value, 'scenarioSetHash', 'ClaimCard', errors)
  validateKnownHashSchemaVersion(value['hashSchemaVersion'], 'ClaimCard.hashSchemaVersion', errors)
  if (value['status'] !== 'allowed' && value['status'] !== 'blocked') {
    errors.push('ClaimCard.status must be "allowed" or "blocked"')
  }
  if (typeof value['leaderboardClaimsAllowed'] !== 'boolean') {
    errors.push('ClaimCard.leaderboardClaimsAllowed must be a boolean')
  }
  if (value['generatedAt'] !== undefined && !isValidDateString(value['generatedAt'])) {
    errors.push('ClaimCard.generatedAt must be an ISO-like date string when present')
  }
  if (value['expiresAt'] !== undefined) {
    if (!isValidDateString(value['expiresAt'])) {
      errors.push('ClaimCard.expiresAt must be an ISO-like date string when present')
    } else if (new Date(value['expiresAt'] as string).getTime() <= normaliseNow(now).getTime()) {
      errors.push('ClaimCard has expired')
    }
  }
  if (value['allowedClaimText'] !== undefined && typeof value['allowedClaimText'] !== 'string') {
    errors.push('ClaimCard.allowedClaimText must be a string when present')
  }
  if (value['blocker'] !== undefined && typeof value['blocker'] !== 'string') {
    errors.push('ClaimCard.blocker must be a string when present')
  }
  for (const key of ['implementationFingerprints', 'scorerFingerprints']) {
    if (value[key] !== undefined) {
      if (!Array.isArray(value[key])) {
        errors.push(`ClaimCard.${key} must be an array when present`)
      } else {
        ;(value[key] as unknown[]).forEach((fingerprint, i) => {
          validateFingerprint(fingerprint, `ClaimCard.${key}[${i}]`, errors)
        })
      }
    }
  }
  if (value['quorum'] !== undefined) validateClaimQuorum(value['quorum'], errors)
  if (value['providerCells'] !== undefined) {
    if (!Array.isArray(value['providerCells'])) {
      errors.push('ClaimCard.providerCells must be an array when present')
    } else {
      ;(value['providerCells'] as unknown[]).forEach((cell, i) =>
        validateClaimProviderCell(cell, `ClaimCard.providerCells[${i}]`, errors),
      )
    }
  }

  return { valid: errors.length === 0, errors }
}

export function assertRunClaimEligible(
  record: RunRecord,
  options: ClaimEligibilityOptions = {},
): void {
  const errors: string[] = []
  errors.push(...aggregateConfidenceErrors(record))
  errors.push(...scoreClaimStatusErrors(record.scores))

  if (options.dataset) {
    errors.push(...datasetIdentityErrors(record, options.dataset))
    const diagnostics = auditScenarioSet(options.dataset, {
      record,
      requiredOutcomeTypes: [...REQUIRED_OUTCOME_TYPES],
    })
    for (const finding of diagnostics.findings.filter((f) => f.severity === 'claim-blocking')) {
      errors.push(`${finding.kind}: ${finding.detail}`)
    }
    try {
      assertScenarioStratificationPublishable(diagnostics.coverage.outcomes.counts)
    } catch (err) {
      if (err instanceof ScenarioStratificationPublicationError) {
        errors.push(...err.reasons)
      } else {
        throw err
      }
    }
  }

  if (options.claimCard) {
    const validation = validateClaimCard(options.claimCard, options.now)
    errors.push(...validation.errors)
    if (validation.valid) {
      errors.push(...claimCardRunErrors(record, options.claimCard, options.dataset, options.now))
    }
  }

  if (errors.length > 0) throw new ClaimEligibilityError(errors)
}

export function aggregateConfidenceErrors(record: RunRecord): string[] {
  const errors: string[] = []
  if (record.aggregates.length === 0) {
    errors.push('RunRecord.aggregates must contain at least one aggregate with confidence intervals')
    return errors
  }
  for (const aggregateRecord of record.aggregates) {
    if (!aggregateRecord.statisticalClaims) {
      errors.push(
        `aggregate for runner "${aggregateRecord.runnerId}" is missing statisticalClaims; ` +
          'leaderboard-eligible publish requires bootstrap confidence intervals',
      )
    }
    const axes = Object.entries(aggregateRecord.axes)
    if (axes.length === 0) errors.push(`aggregate for runner "${aggregateRecord.runnerId}" has no axes`)
    for (const [axis, axisAggregate] of axes) {
      if (!axisAggregate.confidenceInterval) {
        errors.push(
          `aggregate for runner "${aggregateRecord.runnerId}" axis "${axis}" is missing a confidence interval`,
        )
      }
    }
  }
  return errors
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

function requireStringArray(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
): boolean {
  if (!Array.isArray(obj[key])) {
    errors.push(`${path}.${key} must be an array`)
    return false
  }
  let ok = true
  for (const value of obj[key] as unknown[]) {
    if (typeof value !== 'string') {
      errors.push(`${path}.${key} must contain only strings`)
      ok = false
      break
    }
  }
  return ok
}

function requireObject(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
): Record<string, unknown> | null {
  const value = obj[key]
  if (!isRecord(value)) {
    errors.push(`${path}.${key} must be an object`)
    return null
  }
  return value
}

function validateClaimQuorum(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push('ClaimCard.quorum must be an object when present')
    return
  }
  if (typeof value['required'] !== 'number' || !Number.isInteger(value['required']) || value['required'] < 1) {
    errors.push('ClaimCard.quorum.required must be a positive integer')
  }
  requireStringArray(value, 'providers', 'ClaimCard.quorum', errors)
}

function validateClaimProviderCell(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`)
    return
  }
  requireString(value, 'provider', path, errors)
  if (
    value['status'] !== 'verified' &&
    value['status'] !== 'failed' &&
    value['status'] !== 'blocked' &&
    value['status'] !== 'stale'
  ) {
    errors.push(`${path}.status must be verified, failed, blocked, or stale`)
  }
  for (const key of ['model', 'generatedAt', 'expiresAt', 'proofUrl']) {
    if (value[key] !== undefined && typeof value[key] !== 'string') {
      errors.push(`${path}.${key} must be a string when present`)
    }
  }
  if (value['generatedAt'] !== undefined && !isValidDateString(value['generatedAt'])) {
    errors.push(`${path}.generatedAt must be an ISO-like date string when present`)
  }
  if (value['expiresAt'] !== undefined && !isValidDateString(value['expiresAt'])) {
    errors.push(`${path}.expiresAt must be an ISO-like date string when present`)
  }
}

function datasetIdentityErrors(record: RunRecord, dataset: Dataset): string[] {
  const errors: string[] = []
  if (record.dataset.name !== dataset.name) {
    errors.push(`RunRecord.dataset.name "${record.dataset.name}" does not match dataset name "${dataset.name}"`)
  }
  if (record.dataset.version !== dataset.version) {
    errors.push(
      `RunRecord.dataset.version "${record.dataset.version}" does not match dataset version "${dataset.version}"`,
    )
  }
  if (record.scenarioSetHashSchemaVersion === SCENARIO_SET_HASH_SCHEMA_V2) {
    const metadata = record.scenarioSetHashMetadata
    if (!metadata || metadata.hashSchemaVersion !== SCENARIO_SET_HASH_SCHEMA_V2) {
      errors.push('RunRecord.scenarioSetHashMetadata v2 is required for v2 claim eligibility')
    } else {
      if (metadata.dataset.name !== dataset.name) {
        errors.push('RunRecord.scenarioSetHashMetadata.dataset.name must match the supplied dataset')
      }
      if (metadata.dataset.version !== dataset.version) {
        errors.push('RunRecord.scenarioSetHashMetadata.dataset.version must match the supplied dataset')
      }
      if (metadata.scenarioCount !== dataset.scenarios.length) {
        errors.push('RunRecord.scenarioSetHashMetadata.scenarioCount must match the supplied dataset')
      }
    }
  } else if (record.scenarioSetHash) {
    const datasetHash = computeScenarioSetHash(dataset)
    if (record.scenarioSetHash !== datasetHash) {
      errors.push(`RunRecord.scenarioSetHash "${record.scenarioSetHash}" does not match supplied dataset hash "${datasetHash}"`)
    }
  } else {
    errors.push('RunRecord.scenarioSetHash is required for claim eligibility')
  }
  return errors
}

function scoreClaimStatusErrors(scores: Score[]): string[] {
  return scores
    .filter((score) => score.claimStatus === 'analysis-only')
    .map((score) =>
      `score for runner "${score.runnerId}" scenario "${score.scenarioId}" axis "${score.axis}" is analysis-only`,
    )
}

function claimCardRunErrors(
  record: RunRecord,
  card: ClaimCard,
  dataset: Dataset | undefined,
  nowInput: Date | string = new Date(),
): string[] {
  const errors: string[] = []
  const now = normaliseNow(nowInput)
  if (card.status !== 'allowed' || card.leaderboardClaimsAllowed !== true) {
    errors.push(
      `ClaimCard blocks leaderboard claims: status=${card.status}, ` +
        `leaderboardClaimsAllowed=${String(card.leaderboardClaimsAllowed)}` +
        (card.blocker ? `; blocker=${card.blocker}` : ''),
    )
  }
  if (card.dataset.name !== record.dataset.name) {
    errors.push(`ClaimCard.dataset.name "${card.dataset.name}" does not match RunRecord.dataset.name "${record.dataset.name}"`)
  }
  if (card.dataset.version !== record.dataset.version) {
    errors.push(
      `ClaimCard.dataset.version "${card.dataset.version}" does not match RunRecord.dataset.version "${record.dataset.version}"`,
    )
  }
  if (dataset) {
    if (card.dataset.name !== dataset.name) errors.push('ClaimCard.dataset.name must match the supplied dataset')
    if (card.dataset.version !== dataset.version) errors.push('ClaimCard.dataset.version must match the supplied dataset')
  }
  if (record.scenarioSetHash !== card.scenarioSetHash) {
    errors.push(`ClaimCard.scenarioSetHash "${card.scenarioSetHash}" does not match RunRecord.scenarioSetHash "${record.scenarioSetHash ?? 'missing'}"`)
  }
  const recordHashSchema = record.scenarioSetHashSchemaVersion ?? SCENARIO_SET_HASH_SCHEMA_V1
  if (recordHashSchema !== card.hashSchemaVersion) {
    errors.push(`ClaimCard.hashSchemaVersion "${card.hashSchemaVersion}" does not match RunRecord schema "${recordHashSchema}"`)
  }
  if (card.expiresAt && new Date(card.expiresAt).getTime() <= now.getTime()) {
    errors.push('ClaimCard has expired')
  }
  if (card.quorum) {
    const cells = card.providerCells ?? []
    const verifiedProviders = new Set(
      cells
        .filter((cell) =>
          card.quorum?.providers.includes(cell.provider) &&
          cell.status === 'verified' &&
          !isExpired(cell.expiresAt, now),
        )
        .map((cell) => cell.provider),
    )
    if (verifiedProviders.size < card.quorum.required) {
      errors.push(
        `ClaimCard quorum requires ${card.quorum.required} verified provider cells; ` +
          `only ${verifiedProviders.size} are verified and fresh`,
      )
    }
  }
  return errors
}

function isExpired(value: string | undefined, now: Date): boolean {
  return value !== undefined && new Date(value).getTime() <= now.getTime()
}

function isValidDateString(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(new Date(value).getTime())
}

function normaliseNow(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}

function validateKnownHashSchemaVersion(
  version: unknown,
  path: string,
  errors: string[],
): version is 'v1' | 'v2' {
  if (typeof version !== 'string' || version.length === 0) {
    errors.push(`${path} must be a non-empty string`)
    return false
  }
  if (version !== SCENARIO_SET_HASH_SCHEMA_V1 && version !== SCENARIO_SET_HASH_SCHEMA_V2) {
    errors.push(`${path} has unknown scenario-set hash schema version "${version}"`)
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

function validateFingerprint(v: unknown, path: string, errors: string[]): boolean {
  if (!isRecord(v)) { errors.push(`${path} must be an object`); return false }
  let ok = true
  ok = requireString(v, 'id', path, errors) && ok
  if (v['version'] !== undefined && typeof v['version'] !== 'string') {
    errors.push(`${path}.version must be a string`)
    ok = false
  }
  if (v['digest'] !== undefined && typeof v['digest'] !== 'string') {
    errors.push(`${path}.digest must be a string`)
    ok = false
  }
  if (v['uri'] !== undefined && typeof v['uri'] !== 'string') {
    errors.push(`${path}.uri must be a string`)
    ok = false
  }
  return ok
}

function validatePluginIdentity(v: unknown, path: string, errors: string[]): boolean {
  if (!isRecord(v)) { errors.push(`${path} must be an object`); return false }
  let ok = true
  ok = requireString(v, 'id', path, errors) && ok
  if (v['version'] !== undefined && typeof v['version'] !== 'string') {
    errors.push(`${path}.version must be a string`)
    ok = false
  }
  if (v['uri'] !== undefined && typeof v['uri'] !== 'string') {
    errors.push(`${path}.uri must be a string`)
    ok = false
  }
  return ok
}

function validateMultiTurnShape(v: unknown, path: string, errors: string[]): boolean {
  if (!isRecord(v)) { errors.push(`${path} must be an object`); return false }
  let ok = true
  ok = requireString(v, 'id', path, errors) && ok
  if (typeof v['multiTurn'] !== 'boolean') {
    errors.push(`${path}.multiTurn must be a boolean`)
    ok = false
  }
  for (const key of [
    'runnerVisibleTurnCount',
    'seedHistoryTurnCount',
    'userTurnCount',
    'persistenceCriteriaCount',
  ]) {
    if (typeof v[key] !== 'number' || !Number.isInteger(v[key]) || (v[key] as number) < 0) {
      errors.push(`${path}.${key} must be a non-negative integer`)
      ok = false
    }
  }
  return ok
}

function validateMultiTurnSummary(v: unknown, path: string, errors: string[]): boolean {
  if (!isRecord(v)) { errors.push(`${path} must be an object`); return false }
  let ok = true
  for (const key of [
    'scenarioCount',
    'singleTurnScenarioCount',
    'multiTurnScenarioCount',
    'maxRunnerVisibleTurns',
  ]) {
    if (typeof v[key] !== 'number' || !Number.isInteger(v[key]) || (v[key] as number) < 0) {
      errors.push(`${path}.${key} must be a non-negative integer`)
      ok = false
    }
  }
  if (!Array.isArray(v['scenarios'])) {
    errors.push(`${path}.scenarios must be an array`)
    ok = false
  } else {
    ;(v['scenarios'] as unknown[]).forEach((shape, i) => {
      ok = validateMultiTurnShape(shape, `${path}.scenarios[${i}]`, errors) && ok
    })
  }
  return ok
}

function validateScenarioSetHashMetadata(
  value: Record<string, unknown>,
  errors: string[],
): void {
  const metadata = value['scenarioSetHashMetadata']
  const topLevelSchema = value['scenarioSetHashSchemaVersion']

  if (topLevelSchema !== undefined) {
    validateKnownHashSchemaVersion(
      topLevelSchema,
      'RunRecord.scenarioSetHashSchemaVersion',
      errors,
    )
  }

  if (metadata === undefined) {
    if (topLevelSchema === SCENARIO_SET_HASH_SCHEMA_V2) {
      errors.push(
        'RunRecord.scenarioSetHashMetadata is required when ' +
          'RunRecord.scenarioSetHashSchemaVersion is v2',
      )
    }
    return
  }

  if (!isRecord(metadata)) {
    errors.push('RunRecord.scenarioSetHashMetadata must be an object')
    return
  }

  const metadataSchema = metadata['hashSchemaVersion'] ?? SCENARIO_SET_HASH_SCHEMA_V1
  if (!validateKnownHashSchemaVersion(
    metadataSchema,
    'RunRecord.scenarioSetHashMetadata.hashSchemaVersion',
    errors,
  )) {
    return
  }

  if (topLevelSchema !== undefined && topLevelSchema !== metadataSchema) {
    errors.push(
      `RunRecord.scenarioSetHashSchemaVersion "${String(topLevelSchema)}" must match ` +
        `RunRecord.scenarioSetHashMetadata.hashSchemaVersion "${String(metadataSchema)}"`,
    )
  }

  if (metadataSchema === SCENARIO_SET_HASH_SCHEMA_V1) {
    requireString(metadata, 'scenarioSetHash', 'RunRecord.scenarioSetHashMetadata', errors)
    return
  }

  validateScenarioSetHashMetadataV2(metadata, value, errors)
}

function validateScenarioSetHashMetadataV2(
  metadata: Record<string, unknown>,
  record: Record<string, unknown>,
  errors: string[],
): void {
  requireString(metadata, 'scenarioSetHash', 'RunRecord.scenarioSetHashMetadata', errors)
  if (record['scenarioSetHash'] === undefined) {
    errors.push('RunRecord.scenarioSetHash is required when scenarioSetHashMetadata is v2')
  } else if (metadata['scenarioSetHash'] !== record['scenarioSetHash']) {
    errors.push(
      'RunRecord.scenarioSetHashMetadata.scenarioSetHash must match RunRecord.scenarioSetHash',
    )
  }
  requireString(metadata, 'shortHash', 'RunRecord.scenarioSetHashMetadata', errors)
  if (
    typeof metadata['scenarioSetHash'] === 'string' &&
    typeof metadata['shortHash'] === 'string' &&
    metadata['shortHash'] !== metadata['scenarioSetHash'].slice(0, 12)
  ) {
    errors.push('RunRecord.scenarioSetHashMetadata.shortHash must match the hash prefix')
  }

  const dataset = requireObject(metadata, 'dataset', 'RunRecord.scenarioSetHashMetadata', errors)
  if (dataset) {
    requireString(dataset, 'name', 'RunRecord.scenarioSetHashMetadata.dataset', errors)
    requireString(dataset, 'version', 'RunRecord.scenarioSetHashMetadata.dataset', errors)
  }
  requireString(metadata, 'domain', 'RunRecord.scenarioSetHashMetadata', errors)
  validatePluginIdentity(
    metadata['plugin'],
    'RunRecord.scenarioSetHashMetadata.plugin',
    errors,
  )
  if (typeof metadata['scenarioCount'] !== 'number' || !Number.isInteger(metadata['scenarioCount']) || metadata['scenarioCount'] < 0) {
    errors.push('RunRecord.scenarioSetHashMetadata.scenarioCount must be a non-negative integer')
  }
  requireStringArray(metadata, 'axes', 'RunRecord.scenarioSetHashMetadata', errors)
  requireStringArray(metadata, 'rubricDescriptors', 'RunRecord.scenarioSetHashMetadata', errors)
  requireStringArray(metadata, 'scoringDescriptors', 'RunRecord.scenarioSetHashMetadata', errors)
  validateMultiTurnSummary(
    metadata['multiTurn'],
    'RunRecord.scenarioSetHashMetadata.multiTurn',
    errors,
  )

  for (const key of ['implementationFingerprints', 'scorerFingerprints']) {
    if (!Array.isArray(metadata[key])) {
      errors.push(`RunRecord.scenarioSetHashMetadata.${key} must be an array`)
    } else {
      ;(metadata[key] as unknown[]).forEach((fingerprint, i) => {
        validateFingerprint(
          fingerprint,
          `RunRecord.scenarioSetHashMetadata.${key}[${i}]`,
          errors,
        )
      })
    }
  }
  requireStringArray(metadata, 'hashedFields', 'RunRecord.scenarioSetHashMetadata', errors)
  requireStringArray(metadata, 'excludedPrivateFields', 'RunRecord.scenarioSetHashMetadata', errors)
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
  validateScenarioSetHashMetadata(value, errors)

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
