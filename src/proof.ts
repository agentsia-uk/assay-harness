import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { loadDataset } from './loader.js'
import { redactCommandLine, redactCommandLineText } from './redact.js'
import { computeScenarioSetHash, readRunRecord } from './serialiser.js'
import type { Dataset, ModelAggregate, ModelResponse, RunRecord } from './types.js'
import { validateRunRecord } from './validate.js'

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
}

export interface BuildProofBundleManifestFromFilesOptions {
  runPath: string
  releaseContractPath: string
  datasetPath?: string
  commandLine?: string | string[]
}

export interface ValidateProofBundleInputs {
  runRecord: RunRecord
  releaseContract: unknown
  dataset?: Dataset
}

export interface ProofBundleValidationResult {
  valid: boolean
  errors: string[]
}

export async function buildProofBundleManifestFromFiles(
  options: BuildProofBundleManifestFromFilesOptions,
): Promise<ProofBundleManifest> {
  const runRecord = await readRunRecord(options.runPath)
  const releaseContract = JSON.parse(await readFile(options.releaseContractPath, 'utf8')) as unknown
  const dataset = options.datasetPath ? await loadDataset(options.datasetPath) : undefined
  return buildProofBundleManifest({
    runRecord,
    releaseContract,
    ...(dataset ? { dataset } : {}),
    ...(options.commandLine ? { commandLine: options.commandLine } : {}),
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
    proofIndex: [
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
    ],
    checksums: {
      runRecord: runRecordHash,
      releaseContract: releaseContractHash,
      runnerMetadata: runnerMetadataHash,
      publicResults: publicResultsHash,
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

  if (manifest.schemaVersion !== PROOF_BUNDLE_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${PROOF_BUNDLE_SCHEMA_VERSION}`)
  }
  if (manifest.hashSchema.algorithm !== PROOF_HASH_SCHEMA.algorithm) {
    errors.push(`hashSchema.algorithm must be ${PROOF_HASH_SCHEMA.algorithm}`)
  }

  const expectedRunRecord = checksumObject(redactRunRecord(inputs.runRecord))
  if (manifest.checksums.runRecord !== expectedRunRecord) {
    errors.push('runRecord checksum does not match the supplied RunRecord')
  }

  const expectedReleaseContract = checksumObject(inputs.releaseContract)
  if (manifest.checksums.releaseContract !== expectedReleaseContract) {
    errors.push('releaseContract checksum does not match the supplied release contract')
  }
  if (manifest.releaseContractHash !== expectedReleaseContract) {
    errors.push('releaseContractHash does not match the supplied release contract')
  }

  const expectedRunnerMetadata = checksumObject(summarizeRunnerMetadata(inputs.runRecord))
  if (manifest.checksums.runnerMetadata !== expectedRunnerMetadata) {
    errors.push('runnerMetadata checksum does not match the supplied RunRecord')
  }

  const expectedPublicResults = checksumObject({
    aggregates: [...inputs.runRecord.aggregates].sort((a, b) => a.runnerId.localeCompare(b.runnerId)),
  })
  if (manifest.checksums.publicResults !== expectedPublicResults) {
    errors.push('publicResults checksum does not match the supplied RunRecord')
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

export function canonicalJson(value: unknown, pretty = false): string {
  return JSON.stringify(canonicalize(value), null, pretty ? 2 : 0)
}

export function checksumObject(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`
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
