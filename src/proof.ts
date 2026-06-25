import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { aggregate, type AggregatorOptions, type BootstrapOptions } from './aggregator.js'
import { loadDataset } from './loader.js'
import { redactCommandLine, redactCommandLineText } from './redact.js'
import { score } from './rubric.js'
import { computeScenarioSetHash, readRunRecord } from './serialiser.js'
import type { ClaimCard, Dataset, ModelAggregate, ModelResponse, RunRecord, Score } from './types.js'
import { ClaimEligibilityError, assertRunClaimEligible, validateRunRecord } from './validate.js'

export const PROOF_BUNDLE_SCHEMA_VERSION = 'assay.proof-bundle.v1'
export const PROOF_HASH_SCHEMA = {
  algorithm: 'sha256',
  digestEncoding: 'hex',
  canonicalization: 'assay-json-canonical-v1',
  checksumFormat: 'sha256:<hex>',
} as const

type JsonPrimitive = string | number | boolean | null
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export interface ProofBundleManifest {
  schemaVersion: typeof PROOF_BUNDLE_SCHEMA_VERSION
  hashSchema: typeof PROOF_HASH_SCHEMA
  releaseContractHash: string
  scenarioSetHash: {
    effective: string | null
    runRecord: string | null
    releaseContract: string | null
    dataset: string | null
    consistent: boolean
  }
  claimGate: {
    status: 'allowed' | 'blocked' | 'unknown'
    leaderboardClaimsAllowed: boolean
    blocker?: string
    gatedDomains: string[]
  }
  run: {
    id: string
    dataset: RunRecord['dataset']
    createdAt: string
    harnessVersion: string
    responseCount: number
    scoreCount: number
    aggregateCount: number
    redactedCommandLine: string | null
  }
  releaseContract: ReleaseContractSummary
  runnerMetadata: RunnerProofMetadata[]
  publicResults: {
    aggregates: ModelAggregate[]
  }
  proofIndex: ProofIndexEntry[]
  checksums: {
    runRecord: string
    releaseContract: string
    runnerMetadata: string
    publicResults: string
    traceBundle?: string
  }
  reproducibilitySelfTest: {
    status: 'passed' | 'failed'
    checks: ProofSelfTestCheck[]
  }
}

export interface ReleaseContractSummary {
  schemaVersion: string | null
  benchmark: string | null
  corpusVersion: string | null
  rubricVersion: string | null
  generatedAt: string | null
  publicBundleHash: string | null
  scenarioCounts: {
    totalInManifest: number | null
    publicExported: number | null
    privateExcluded: number | null
  }
  scenarioSetHashMetadata: {
    shortHash: string | null
    scenarioCount: number | null
    heldOutOnly: boolean | null
  }
  harnessDependencyIds: string[]
  provenance: {
    manifestVersion: string | null
    selectionRuleHash: string | null
  }
}

export interface RunnerProofMetadata {
  runnerId: string
  providers: string[]
  models: string[]
  versions: string[]
  temperatures: number[]
  seeds: number[]
  responseCount: number
  latencyMs: {
    min: number | null
    max: number | null
    mean: number | null
  }
  accessedAt: {
    first: string | null
    last: string | null
  }
}

export interface ProofIndexEntry {
  id: string
  kind: string
  checksum: string
  public: boolean
}

export interface ProofSelfTestCheck {
  name: string
  status: 'passed' | 'failed'
  detail: string
}

export interface BuildProofBundleManifestOptions {
  runRecord: RunRecord
  releaseContract: unknown
  dataset?: Dataset
  commandLine?: string | string[]
  traceBundle?: unknown
}

export interface BuildProofBundleManifestFromFilesOptions {
  runPath: string
  releaseContractPath: string
  datasetPath?: string
  commandLine?: string | string[]
  traceBundlePath?: string
}

export interface ValidateProofBundleInputs {
  runRecord: RunRecord
  releaseContract: unknown
  dataset?: Dataset
  traceBundle?: unknown
}

export interface ProofBundleValidationResult {
  valid: boolean
  errors: string[]
}

export interface ProofVerificationCheck {
  name: string
  status: 'passed' | 'failed'
  detail: string
}

export interface VerifyProofBundleOptions extends ValidateProofBundleInputs {
  manifest: unknown
  claimCard?: ClaimCard
  leaderboardEligible?: boolean
  now?: Date | string
}

export interface ProofVerificationResult {
  valid: boolean
  errors: string[]
  checks: ProofVerificationCheck[]
}

export interface ReplayProofBundleOptions {
  runRecord: RunRecord
  releaseContract: unknown
  dataset: Dataset
  traceBundle?: unknown
  proofManifest?: unknown
}

export interface ProofReplayResult extends ProofVerificationResult {
  replayed: boolean
  scoreCount: number
  aggregateCount: number
}

export async function buildProofBundleManifestFromFiles(
  options: BuildProofBundleManifestFromFilesOptions,
): Promise<ProofBundleManifest> {
  const runRecord = await readRunRecord(options.runPath)
  const releaseContract = JSON.parse(await readFile(options.releaseContractPath, 'utf8')) as unknown
  const dataset = options.datasetPath ? await loadDataset(options.datasetPath) : undefined
  const traceBundle = options.traceBundlePath
    ? JSON.parse(await readFile(options.traceBundlePath, 'utf8')) as unknown
    : undefined
  return buildProofBundleManifest({
    runRecord,
    releaseContract,
    ...(dataset ? { dataset } : {}),
    ...(options.commandLine ? { commandLine: options.commandLine } : {}),
    ...(traceBundle !== undefined ? { traceBundle } : {}),
  })
}

export function buildProofBundleManifest(
  options: BuildProofBundleManifestOptions,
): ProofBundleManifest {
  const releaseContractSummary = summarizeReleaseContract(options.releaseContract)
  const claimGate = summarizeClaimGate(options.releaseContract)
  const runnerMetadata = summarizeRunnerMetadata(options.runRecord)
  const publicResults = {
    aggregates: [...options.runRecord.aggregates].sort((a, b) => a.runnerId.localeCompare(b.runnerId)),
  }
  const runRecordForChecksum = redactRunRecord(options.runRecord)
  const runRecordHash = checksumObject(runRecordForChecksum)
  const releaseContractHash = checksumObject(options.releaseContract)
  const runnerMetadataHash = checksumObject(runnerMetadata)
  const publicResultsHash = checksumObject(publicResults)
  const traceBundleHash = options.traceBundle !== undefined ? checksumObject(options.traceBundle) : undefined
  const runScenarioSetHash = options.runRecord.scenarioSetHash ?? null
  const releaseScenarioSetHash = extractReleaseContractScenarioSetHash(options.releaseContract)
  const datasetScenarioSetHash = options.dataset ? computeScenarioSetHash(options.dataset) : null
  const allScenarioHashes = [
    runScenarioSetHash,
    releaseScenarioSetHash,
    datasetScenarioSetHash,
  ].filter((value): value is string => Boolean(value))
  const effectiveScenarioSetHash = runScenarioSetHash ?? releaseScenarioSetHash ?? datasetScenarioSetHash
  const scenarioSetHashConsistent =
    allScenarioHashes.length > 0 && allScenarioHashes.every((value) => value === allScenarioHashes[0])
  const redactedCommandLine = resolveRedactedCommandLine(options.runRecord, options.commandLine)

  const proofIndex: ProofIndexEntry[] = [
    {
      id: 'run-record',
      kind: 'redacted-run-record-canonical-json',
      checksum: runRecordHash,
      public: false,
    },
    {
      id: 'release-contract',
      kind: 'release-contract-canonical-json',
      checksum: releaseContractHash,
      public: true,
    },
    {
      id: 'runner-metadata',
      kind: 'runner-metadata-summary',
      checksum: runnerMetadataHash,
      public: true,
    },
    {
      id: 'public-results',
      kind: 'aggregate-results-summary',
      checksum: publicResultsHash,
      public: true,
    },
  ]
  if (traceBundleHash) {
    proofIndex.push({
      id: 'trace-bundle',
      kind: 'environment-trace-bundle-canonical-json',
      checksum: traceBundleHash,
      public: false,
    })
  }

  const manifestCore: Omit<ProofBundleManifest, 'reproducibilitySelfTest'> = {
    schemaVersion: PROOF_BUNDLE_SCHEMA_VERSION,
    hashSchema: PROOF_HASH_SCHEMA,
    releaseContractHash,
    scenarioSetHash: {
      effective: effectiveScenarioSetHash,
      runRecord: runScenarioSetHash,
      releaseContract: releaseScenarioSetHash,
      dataset: datasetScenarioSetHash,
      consistent: scenarioSetHashConsistent,
    },
    claimGate,
    run: {
      id: options.runRecord.id,
      dataset: options.runRecord.dataset,
      createdAt: options.runRecord.createdAt,
      harnessVersion: options.runRecord.meta.harnessVersion,
      responseCount: options.runRecord.responses.length,
      scoreCount: options.runRecord.scores.length,
      aggregateCount: options.runRecord.aggregates.length,
      redactedCommandLine,
    },
    releaseContract: releaseContractSummary,
    runnerMetadata,
    publicResults,
    proofIndex,
    checksums: {
      runRecord: runRecordHash,
      releaseContract: releaseContractHash,
      runnerMetadata: runnerMetadataHash,
      publicResults: publicResultsHash,
      ...(traceBundleHash ? { traceBundle: traceBundleHash } : {}),
    },
  }

  const checks = selfTestChecks(manifestCore, options, scenarioSetHashConsistent)
  const status = checks.every((check) => check.status === 'passed') ? 'passed' : 'failed'

  return {
    ...manifestCore,
    reproducibilitySelfTest: {
      status,
      checks,
    },
  }
}

export function validateProofBundleManifest(
  manifest: ProofBundleManifest,
  inputs: ValidateProofBundleInputs,
): ProofBundleValidationResult {
  const errors: string[] = []
  const manifestObject = asRecord(manifest)
  const checksums = asRecord(manifestObject['checksums'])

  if (manifestObject['schemaVersion'] !== PROOF_BUNDLE_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${PROOF_BUNDLE_SCHEMA_VERSION}`)
  }
  errors.push(...validateProofHashSchema(manifestObject['hashSchema']))
  errors.push(...validateProofIndex(manifestObject['proofIndex'], checksums))

  const expectedRunRecord = checksumObject(redactRunRecord(inputs.runRecord))
  if (checksums['runRecord'] !== expectedRunRecord) {
    errors.push('runRecord checksum does not match the supplied RunRecord')
  }

  const expectedReleaseContract = checksumObject(inputs.releaseContract)
  if (checksums['releaseContract'] !== expectedReleaseContract) {
    errors.push('releaseContract checksum does not match the supplied release contract')
  }
  if (manifestObject['releaseContractHash'] !== expectedReleaseContract) {
    errors.push('releaseContractHash does not match the supplied release contract')
  }

  const expectedRunnerMetadata = checksumObject(summarizeRunnerMetadata(inputs.runRecord))
  if (checksums['runnerMetadata'] !== expectedRunnerMetadata) {
    errors.push('runnerMetadata checksum does not match the supplied RunRecord')
  }
  if (manifestObject['runnerMetadata'] !== undefined) {
    const actualRunnerMetadata = checksumObject(manifestObject['runnerMetadata'])
    if (checksums['runnerMetadata'] !== actualRunnerMetadata) {
      errors.push('runnerMetadata checksum does not match the embedded proof metadata')
    }
  }

  const expectedPublicResults = checksumObject({
    aggregates: [...inputs.runRecord.aggregates].sort((a, b) => a.runnerId.localeCompare(b.runnerId)),
  })
  if (checksums['publicResults'] !== expectedPublicResults) {
    errors.push('publicResults checksum does not match the supplied RunRecord')
  }
  if (manifestObject['publicResults'] !== undefined) {
    const actualPublicResults = checksumObject(manifestObject['publicResults'])
    if (checksums['publicResults'] !== actualPublicResults) {
      errors.push('publicResults checksum does not match the embedded proof results')
    }
  }

  const manifestTraceChecksum = typeof checksums['traceBundle'] === 'string'
    ? checksums['traceBundle']
    : null
  if (manifestTraceChecksum) {
    if (inputs.traceBundle === undefined) {
      errors.push('traceBundle input is required because the proof manifest declares a traceBundle checksum')
    } else {
      errors.push(...validateTraceBundle(inputs.traceBundle))
      const expectedTraceBundle = checksumObject(inputs.traceBundle)
      if (manifestTraceChecksum !== expectedTraceBundle) {
        errors.push('traceBundle checksum does not match the supplied trace bundle')
      }
    }
  } else if (inputs.traceBundle !== undefined) {
    errors.push('traceBundle was supplied but the proof manifest does not declare a traceBundle checksum')
  }
  if (inputs.runRecord.meta.environment && !manifestTraceChecksum) {
    errors.push('RunRecord.meta.environment is present but proof manifest does not declare a traceBundle checksum')
  }

  const contractHash = extractReleaseContractScenarioSetHash(inputs.releaseContract)
  const hashes = [
    inputs.runRecord.scenarioSetHash ?? null,
    contractHash,
    inputs.dataset ? computeScenarioSetHash(inputs.dataset) : null,
  ].filter((value): value is string => Boolean(value))
  if (hashes.length === 0) {
    errors.push('scenario-set hash is missing from RunRecord, release contract, and dataset')
  } else if (!hashes.every((value) => value === hashes[0])) {
    errors.push('scenario-set hash mismatch between supplied proof inputs')
  }

  const selfTest = asRecord(manifestObject['reproducibilitySelfTest'])
  if (selfTest['status'] !== 'passed') {
    errors.push('reproducibilitySelfTest.status must be "passed"')
  }

  return { valid: errors.length === 0, errors }
}

export function formatProofBundleManifest(manifest: ProofBundleManifest): string {
  return `${canonicalJson(manifest, true)}\n`
}

export async function writeProofBundleManifest(
  path: string,
  manifest: ProofBundleManifest,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, formatProofBundleManifest(manifest), 'utf8')
}

export function verifyProofBundle(options: VerifyProofBundleOptions): ProofVerificationResult {
  const checks: ProofVerificationCheck[] = []
  const errors: string[] = []
  const manifest = options.manifest as ProofBundleManifest
  const manifestValidation = validateProofBundleManifest(manifest, options)
  checks.push({
    name: 'proof-manifest',
    status: manifestValidation.valid ? 'passed' : 'failed',
    detail: manifestValidation.valid
      ? 'Proof manifest checksums and supplied inputs match'
      : manifestValidation.errors.join('; '),
  })
  errors.push(...manifestValidation.errors)

  if (options.leaderboardEligible) {
    const leaderboardInputErrors: string[] = []
    if (!options.dataset) {
      leaderboardInputErrors.push('leaderboard-eligible proof verification requires --dataset')
    }
    if (!options.claimCard) {
      leaderboardInputErrors.push('leaderboard-eligible proof verification requires --claim-card')
    }
    const releaseClaimGate = summarizeClaimGate(options.releaseContract)
    if (releaseClaimGate.status !== 'allowed' || releaseClaimGate.leaderboardClaimsAllowed !== true) {
      leaderboardInputErrors.push(
        `release contract claimGate blocks leaderboard claims: status=${releaseClaimGate.status}, ` +
          `leaderboardClaimsAllowed=${String(releaseClaimGate.leaderboardClaimsAllowed)}` +
          (releaseClaimGate.blocker ? `; blocker=${releaseClaimGate.blocker}` : ''),
      )
    }
    if (leaderboardInputErrors.length > 0) {
      checks.push({
        name: 'claim-eligibility',
        status: 'failed',
        detail: leaderboardInputErrors.join('; '),
      })
      errors.push(...leaderboardInputErrors)
    } else {
      const claimErrors = claimEligibilityErrors(options)
      checks.push({
        name: 'claim-eligibility',
        status: claimErrors.length === 0 ? 'passed' : 'failed',
        detail: claimErrors.length === 0
          ? 'RunRecord satisfies the shared claim-card eligibility gate'
          : claimErrors.join('; '),
      })
      errors.push(...claimErrors)
    }
  } else if (options.claimCard) {
    const claimErrors = claimEligibilityErrors(options)
    checks.push({
      name: 'claim-card',
      status: claimErrors.length === 0 ? 'passed' : 'failed',
      detail: claimErrors.length === 0
        ? 'Claim card matches the supplied RunRecord'
        : claimErrors.join('; '),
    })
    errors.push(...claimErrors)
  }

  return { valid: errors.length === 0, errors: unique(errors), checks }
}

export function replayProofBundle(options: ReplayProofBundleOptions): ProofReplayResult {
  const checks: ProofVerificationCheck[] = []
  const errors: string[] = []
  const replayedScores = replayScores(options.runRecord, options.dataset, errors)
  checks.push({
    name: 'score-replay',
    status: errors.length === 0 && canonicalJson(replayedScores) === canonicalJson(options.runRecord.scores)
      ? 'passed'
      : 'failed',
    detail: canonicalJson(replayedScores) === canonicalJson(options.runRecord.scores)
      ? 'Scores replay from pinned outputs'
      : 'score replay mismatch: regenerated scores differ from RunRecord.scores',
  })

  if (canonicalJson(replayedScores) !== canonicalJson(options.runRecord.scores)) {
    errors.push('score replay mismatch: regenerated scores differ from RunRecord.scores')
  }

  const aggregateOptions = replayAggregateOptions(options.runRecord, options.dataset, errors)
  const replayedAggregates = aggregate(replayedScores, aggregateOptions)
  const aggregateMatches = canonicalJson(replayedAggregates) === canonicalJson(options.runRecord.aggregates)
  checks.push({
    name: 'aggregate-replay',
    status: aggregateMatches ? 'passed' : 'failed',
    detail: aggregateMatches
      ? 'Aggregates replay from regenerated scores'
      : 'aggregate replay mismatch: regenerated aggregates differ from RunRecord.aggregates',
  })
  if (!aggregateMatches) {
    errors.push('aggregate replay mismatch: regenerated aggregates differ from RunRecord.aggregates')
  }

  if (options.proofManifest !== undefined) {
    const replayRecord: RunRecord = {
      ...options.runRecord,
      scores: replayedScores,
      aggregates: replayedAggregates,
    }
    const replayedManifest = buildProofBundleManifest({
      runRecord: replayRecord,
      releaseContract: options.releaseContract,
      dataset: options.dataset,
      ...(options.traceBundle !== undefined ? { traceBundle: options.traceBundle } : {}),
    })
    const verification = verifyProofBundle({
      manifest: options.proofManifest,
      runRecord: options.runRecord,
      releaseContract: options.releaseContract,
      dataset: options.dataset,
      ...(options.traceBundle !== undefined ? { traceBundle: options.traceBundle } : {}),
    })
    errors.push(...verification.errors)
    const proofMatches = canonicalJson(normalizeProofManifestForReplay(options.proofManifest)) ===
      canonicalJson(normalizeProofManifestForReplay(replayedManifest))
    checks.push({
      name: 'proof-replay',
      status: verification.valid && proofMatches ? 'passed' : 'failed',
      detail: verification.valid && proofMatches
        ? 'Proof manifest replays from regenerated scores and aggregates'
        : 'proof manifest replay mismatch: regenerated proof manifest differs from supplied proof',
    })
    if (!proofMatches) {
      errors.push('proof manifest replay mismatch: regenerated proof manifest differs from supplied proof')
    }
  }

  return {
    valid: errors.length === 0,
    errors: unique(errors),
    checks,
    replayed: true,
    scoreCount: replayedScores.length,
    aggregateCount: replayedAggregates.length,
  }
}

export function formatProofVerificationResult(result: ProofVerificationResult): string {
  if (result.valid) {
    return [
      `Proof verification passed: ${result.checks.filter((check) => check.status === 'passed').length}/${result.checks.length} check(s) passed`,
      ...result.checks.map((check) => `  - ${check.name}: ${check.status}`),
    ].join('\n')
  }
  return [
    'Proof verification failed:',
    ...result.errors.map((error) => `  - ${error}`),
  ].join('\n')
}

export function formatProofReplayResult(result: ProofReplayResult): string {
  if (result.valid) {
    return [
      `Proof replay passed: ${result.scoreCount} score(s), ${result.aggregateCount} aggregate(s) regenerated`,
      ...result.checks.map((check) => `  - ${check.name}: ${check.status}`),
    ].join('\n')
  }
  return [
    'Proof replay failed:',
    ...result.errors.map((error) => `  - ${error}`),
  ].join('\n')
}

export function canonicalJson(value: unknown, pretty = false): string {
  return JSON.stringify(canonicalize(value), null, pretty ? 2 : 0)
}

export function checksumObject(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`
}

function validateProofHashSchema(value: unknown): string[] {
  const errors: string[] = []
  const obj = asRecord(value)
  for (const [key, expected] of Object.entries(PROOF_HASH_SCHEMA)) {
    if (obj[key] !== expected) {
      errors.push(`hashSchema.${key} must be ${expected}`)
    }
  }
  return errors
}

function validateProofIndex(value: unknown, checksums: Record<string, unknown>): string[] {
  const errors: string[] = []
  if (!Array.isArray(value)) {
    errors.push('proofIndex must be an array')
    return errors
  }
  const indexChecksumById = new Map<string, string>()
  for (const [index, entry] of value.entries()) {
    const obj = asRecord(entry)
    const id = extractString(obj, 'id')
    const checksum = extractString(obj, 'checksum')
    if (!id) errors.push(`proofIndex[${index}].id must be a non-empty string`)
    if (!checksum) errors.push(`proofIndex[${index}].checksum must be a non-empty string`)
    if (id && checksum) indexChecksumById.set(id, checksum)
  }
  const expectedIds = [
    ['run-record', 'runRecord'],
    ['release-contract', 'releaseContract'],
    ['runner-metadata', 'runnerMetadata'],
    ['public-results', 'publicResults'],
    ['trace-bundle', 'traceBundle'],
  ] as const
  for (const [entryId, checksumKey] of expectedIds) {
    const checksum = checksums[checksumKey]
    if (typeof checksum !== 'string') continue
    if (!indexChecksumById.has(entryId)) {
      errors.push(`proofIndex is missing entry "${entryId}" for checksums.${checksumKey}`)
    } else if (indexChecksumById.get(entryId) !== checksum) {
      errors.push(`proofIndex entry "${entryId}" checksum does not match checksums.${checksumKey}`)
    }
  }
  return errors
}

function validateTraceBundle(value: unknown): string[] {
  const errors: string[] = []
  const obj = asRecord(value)
  if (obj['schemaVersion'] !== 'assay.environment-run-metadata.v1') {
    errors.push('traceBundle.schemaVersion must be "assay.environment-run-metadata.v1"')
  }
  const results = obj['results']
  if (!Array.isArray(results)) {
    errors.push('traceBundle.results must be an array')
    return errors
  }
  for (const [index, trace] of results.entries()) {
    const item = asRecord(trace)
    const path = `traceBundle.results[${index}]`
    if (item['schemaVersion'] !== 'assay.environment-trace.v1') {
      errors.push(`${path}.schemaVersion must be "assay.environment-trace.v1"`)
    }
    for (const key of ['scenarioId', 'runnerId', 'environmentId']) {
      if (!extractString(item, key)) errors.push(`${path}.${key} must be a non-empty string`)
    }
    if (!Array.isArray(item['steps'])) errors.push(`${path}.steps must be an array`)
    if (!Array.isArray(item['validators'])) errors.push(`${path}.validators must be an array`)
    const redaction = asRecord(item['redaction'])
    if (typeof redaction['applied'] !== 'boolean') {
      errors.push(`${path}.redaction.applied must be a boolean`)
    }
    if (!Array.isArray(redaction['redactedPaths'])) {
      errors.push(`${path}.redaction.redactedPaths must be an array`)
    }
  }
  return errors
}

function claimEligibilityErrors(options: VerifyProofBundleOptions): string[] {
  try {
    assertRunClaimEligible(options.runRecord, {
      ...(options.dataset ? { dataset: options.dataset } : {}),
      ...(options.claimCard ? { claimCard: options.claimCard } : {}),
      ...(options.now ? { now: options.now } : {}),
    })
    return []
  } catch (err) {
    if (err instanceof ClaimEligibilityError) return err.errors
    throw err
  }
}

function replayScores(record: RunRecord, dataset: Dataset, errors: string[]): Score[] {
  const scenarioById = new Map(dataset.scenarios.map((scenario) => [scenario.id, scenario]))
  const out: Score[] = []
  for (const response of record.responses) {
    const scenario = scenarioById.get(response.scenarioId)
    if (!scenario) {
      errors.push(`response for scenario "${response.scenarioId}" has no matching dataset scenario`)
      continue
    }
    const result = score(response, scenario)
    if (isPromiseLike(result)) {
      errors.push(`scenario "${scenario.id}" uses an async rubric and cannot be replayed without a pinned judge result`)
      continue
    }
    out.push(...result)
  }
  return out
}

function replayAggregateOptions(
  record: RunRecord,
  dataset: Dataset,
  errors: string[],
): AggregatorOptions {
  const confidence = inferBootstrapOptions(record, errors)
  const weights = record.aggregates[0]?.weights
  return {
    ...(weights ? { weights } : {}),
    ...(confidence ? { confidence } : {}),
    responses: record.responses,
    sliceMetadataByScenario: sliceMetadataByScenario(dataset),
  }
}

function inferBootstrapOptions(record: RunRecord, errors: string[]): BootstrapOptions | undefined {
  const claims = record.aggregates
    .map((item) => item.statisticalClaims)
    .filter((claim): claim is NonNullable<ModelAggregate['statisticalClaims']> => Boolean(claim))
  if (claims.length === 0) return undefined
  if (claims.length !== record.aggregates.length) {
    errors.push('aggregate replay cannot infer confidence settings because only some aggregates carry statisticalClaims')
  }
  const first = claims[0]!
  for (const claim of claims.slice(1)) {
    if (
      claim.method !== first.method ||
      claim.iterations !== first.iterations ||
      claim.confidenceLevel !== first.confidenceLevel ||
      claim.seed !== first.seed
    ) {
      errors.push('aggregate replay cannot infer one deterministic bootstrap configuration from mixed statisticalClaims')
      break
    }
  }
  return {
    method: first.method,
    iterations: first.iterations,
    confidenceLevel: first.confidenceLevel,
    seed: first.seed,
  }
}

function sliceMetadataByScenario(dataset: Dataset): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    dataset.scenarios.map((scenario) => [
      scenario.id,
      isRecord(scenario.meta?.['slices']) ? scenario.meta['slices'] : {},
    ]),
  )
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof value === 'object' && value !== null && 'then' in value &&
    typeof (value as { then?: unknown }).then === 'function'
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function normalizeProofManifestForReplay(value: unknown): unknown {
  const parsed = JSON.parse(canonicalJson(value)) as unknown
  const obj = asRecord(parsed)
  const run = asRecord(obj['run'])
  if (Object.keys(run).length > 0) {
    obj['run'] = { ...run, redactedCommandLine: null }
  }
  return obj
}

function selfTestChecks(
  manifestCore: Omit<ProofBundleManifest, 'reproducibilitySelfTest'>,
  options: BuildProofBundleManifestOptions,
  scenarioSetHashConsistent: boolean,
): ProofSelfTestCheck[] {
  const validation = validateRunRecord(options.runRecord)
  const checksumValidation = validateProofBundleManifest(
    { ...manifestCore, reproducibilitySelfTest: { status: 'passed', checks: [] } },
    {
      runRecord: options.runRecord,
      releaseContract: options.releaseContract,
      ...(options.dataset ? { dataset: options.dataset } : {}),
    },
  )
  const canonicalOnce = checksumObject(manifestCore)
  const canonicalTwice = checksumObject(JSON.parse(canonicalJson(manifestCore)) as unknown)
  const analysisOnlyScores = options.runRecord.scores.filter(
    (score) => score.claimStatus === 'analysis-only',
  )
  const analysisOnlyClaimBlocked =
    manifestCore.claimGate.leaderboardClaimsAllowed && analysisOnlyScores.length > 0

  return [
    {
      name: 'run-record-schema',
      status: validation.valid ? 'passed' : 'failed',
      detail: validation.valid ? 'RunRecord schema validated' : validation.errors.join('; '),
    },
    {
      name: 'checksum-validation',
      status: checksumValidation.valid ? 'passed' : 'failed',
      detail: checksumValidation.valid
        ? 'Input checksums recomputed successfully'
        : checksumValidation.errors.join('; '),
    },
    {
      name: 'scenario-set-hash-consistency',
      status: scenarioSetHashConsistent ? 'passed' : 'failed',
      detail: scenarioSetHashConsistent
        ? 'RunRecord, release contract, and optional dataset scenario-set hashes agree'
        : 'Scenario-set hash is missing or inconsistent across supplied inputs',
    },
    {
      name: 'canonical-output-deterministic',
      status: canonicalOnce === canonicalTwice ? 'passed' : 'failed',
      detail: canonicalOnce === canonicalTwice
        ? 'Canonical proof payload is stable across parse/stringify'
        : 'Canonical proof payload changed after parse/stringify',
    },
    {
      name: 'analysis-only-claim-gate',
      status: analysisOnlyClaimBlocked ? 'failed' : 'passed',
      detail: analysisOnlyClaimBlocked
        ? `${analysisOnlyScores.length} analysis-only score(s) cannot support claim-allowed proof material`
        : manifestCore.claimGate.leaderboardClaimsAllowed
          ? 'No analysis-only scores are present in claim-allowed proof material'
          : 'Claim gate is blocked or unknown; analysis-only scores are non-claim material',
    },
  ]
}

function summarizeRunnerMetadata(record: RunRecord): RunnerProofMetadata[] {
  const runnerIds = new Set([...record.runners, ...record.responses.map((response) => response.runnerId)])
  return [...runnerIds].sort().map((runnerId) => summarizeRunner(record.responses, runnerId))
}

function summarizeRunner(responses: ModelResponse[], runnerId: string): RunnerProofMetadata {
  const runnerResponses = responses.filter((response) => response.runnerId === runnerId)
  const latencies = runnerResponses.map((response) => response.meta.latencyMs)
  const accessedAt = runnerResponses
    .map((response) => response.meta.accessedAt)
    .filter((value) => value.length > 0)
    .sort()

  return {
    runnerId,
    providers: sortedUnique(runnerResponses.map((response) => response.meta.provider)),
    models: sortedUnique(runnerResponses.map((response) => response.meta.model)),
    versions: sortedUnique(runnerResponses.map((response) => response.meta.version).filter(isString)),
    temperatures: sortedUniqueNumbers(
      runnerResponses.map((response) => response.meta.temperature).filter(isNumber),
    ),
    seeds: sortedUniqueNumbers(
      runnerResponses.map((response) => response.meta.seed).filter(isNumber),
    ),
    responseCount: runnerResponses.length,
    latencyMs: {
      min: latencies.length > 0 ? Math.min(...latencies) : null,
      max: latencies.length > 0 ? Math.max(...latencies) : null,
      mean: latencies.length > 0
        ? Number((latencies.reduce((sum, value) => sum + value, 0) / latencies.length).toFixed(3))
        : null,
    },
    accessedAt: {
      first: accessedAt[0] ?? null,
      last: accessedAt.at(-1) ?? null,
    },
  }
}

function summarizeReleaseContract(value: unknown): ReleaseContractSummary {
  const obj = asRecord(value)
  const metadata = asRecord(obj['scenarioSetHashMetadata'])
  const counts = asRecord(obj['scenarioCounts'])
  const provenance = asRecord(obj['provenance'])

  return {
    schemaVersion: extractString(obj, 'schemaVersion'),
    benchmark: extractString(obj, 'benchmark'),
    corpusVersion: extractString(obj, 'corpusVersion'),
    rubricVersion: extractString(obj, 'rubricVersion'),
    generatedAt: extractString(obj, 'generatedAt'),
    publicBundleHash: extractString(obj, 'publicBundleHash'),
    scenarioCounts: {
      totalInManifest: extractNumber(counts, 'totalInManifest'),
      publicExported: extractNumber(counts, 'publicExported'),
      privateExcluded: extractNumber(counts, 'privateExcluded'),
    },
    scenarioSetHashMetadata: {
      shortHash: extractString(metadata, 'shortHash'),
      scenarioCount: extractNumber(metadata, 'scenarioCount'),
      heldOutOnly: extractBoolean(metadata, 'heldOutOnly'),
    },
    harnessDependencyIds: extractStringArray(obj, 'harnessDependencyIds'),
    provenance: {
      manifestVersion: extractString(provenance, 'manifestVersion'),
      selectionRuleHash: extractString(provenance, 'selectionRuleHash'),
    },
  }
}

function summarizeClaimGate(value: unknown): ProofBundleManifest['claimGate'] {
  const claimGate = asRecord(asRecord(value)['claimGate'])
  const rawStatus = extractString(claimGate, 'status')
  const status = rawStatus === 'allowed' || rawStatus === 'blocked' ? rawStatus : 'unknown'
  const leaderboardClaimsAllowed = extractBoolean(claimGate, 'leaderboardClaimsAllowed') ?? status === 'allowed'
  const blocker = extractString(claimGate, 'blocker')

  return {
    status,
    leaderboardClaimsAllowed,
    ...(blocker ? { blocker } : {}),
    gatedDomains: extractStringArray(claimGate, 'gatedDomains'),
  }
}

function extractReleaseContractScenarioSetHash(value: unknown): string | null {
  const obj = asRecord(value)
  return extractString(obj, 'scenarioSetHash') ??
    extractString(asRecord(obj['scenarioSetHashMetadata']), 'scenarioSetHash')
}

function redactRunRecord(record: RunRecord): RunRecord {
  return {
    ...record,
    meta: {
      ...record.meta,
      ...(record.meta.commandLine
        ? { commandLine: redactCommandLineText(record.meta.commandLine) }
        : {}),
    },
  }
}

function resolveRedactedCommandLine(
  record: RunRecord,
  fallback?: string | string[],
): string | null {
  if (record.meta.commandLine) {
    return redactCommandLineText(record.meta.commandLine)
  }
  if (Array.isArray(fallback)) {
    return redactCommandLine(fallback)
  }
  if (typeof fallback === 'string') {
    return redactCommandLineText(fallback)
  }
  return null
}

function canonicalize(value: unknown): JsonValue {
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item))
  }
  if (typeof value === 'object') {
    const out: Record<string, JsonValue> = {}
    const input = value as Record<string, unknown>
    for (const key of Object.keys(input).sort()) {
      if (input[key] !== undefined) {
        out[key] = canonicalize(input[key])
      }
    }
    return out
  }
  return null
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function extractString(obj: Record<string, unknown>, key: string): string | null {
  return typeof obj[key] === 'string' ? obj[key] : null
}

function extractNumber(obj: Record<string, unknown>, key: string): number | null {
  return typeof obj[key] === 'number' && Number.isFinite(obj[key]) ? obj[key] : null
}

function extractBoolean(obj: Record<string, unknown>, key: string): boolean | null {
  return typeof obj[key] === 'boolean' ? obj[key] : null
}

function extractStringArray(obj: Record<string, unknown>, key: string): string[] {
  const value = obj[key]
  return Array.isArray(value) ? value.filter(isString).sort() : []
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort()
}

function sortedUniqueNumbers(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b)
}
