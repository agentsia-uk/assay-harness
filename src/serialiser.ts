import { createHash } from 'node:crypto'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type {
  Dataset,
  EnvironmentScenario,
  Rubric,
  RunRecord,
  Scenario,
  ScenarioMultiTurnShape,
  ScenarioSetFingerprint,
  ScenarioSetHashComputation,
  ScenarioSetHashV2Options,
  ScenarioSetHashMetadataV2,
  ScenarioSetMultiTurnSummary,
  ScenarioSetPluginIdentity,
} from './types.js'
import { assertValidRunRecord } from './validate.js'
import { isMultiTurnScenario } from './runners/multi-turn.js'
import { isEnvironmentScenario } from './environment.js'

export const SCENARIO_SET_HASH_SCHEMA_V1 = 'v1' as const
export const SCENARIO_SET_HASH_SCHEMA_V2 = 'v2' as const

export const SCENARIO_SET_HASH_V2_HASHED_FIELDS = [
  'hashSchemaVersion',
  'dataset.name',
  'dataset.version',
  'domain',
  'plugin',
  'scenario.id',
  'scenario.runnerVisibleInput',
  'scenario.axes',
  'scenario.rubricDescriptor',
  'scenario.scoringDescriptor',
  'scenario.multiTurnShape',
  'scenario.multiTurnRunnerVisibleInput',
  'scenario.environmentShape',
  'scenario.environmentRunnerVisibleInput',
  'implementationFingerprints',
  'scorerFingerprints',
] as const

export const SCENARIO_SET_HASH_V2_EXCLUDED_PRIVATE_FIELDS = [
  'privateAnswerKey',
  'privateAnswerKeys',
  'heldOutAnswerKey',
  'heldOutAnswerKeys',
  'goldAnswer',
  'goldAnswers',
  'goldLabel',
  'privateScoringData',
  'mechanismAliases',
  'mechanismAliasDictionary',
  'rubric.reference',
] as const

const PRIVATE_FIELD_NAMES = new Set<string>(SCENARIO_SET_HASH_V2_EXCLUDED_PRIVATE_FIELDS)

export class UnknownScenarioSetHashSchemaError extends Error {
  readonly hashSchemaVersion: string

  constructor(hashSchemaVersion: string) {
    super(
      `unknown scenario-set hash schema version "${hashSchemaVersion}". ` +
        'The harness fails closed rather than computing or accepting an identity ' +
        'whose canonical fields are not understood.',
    )
    this.name = 'UnknownScenarioSetHashSchemaError'
    this.hashSchemaVersion = hashSchemaVersion
  }
}

/**
 * Write a RunRecord to disk as JSON. Creates parent directories as needed.
 * The file format is stable: fields may be added but not renamed or typed
 * differently without a major harness version bump.
 */
export async function writeRunRecord(path: string, record: RunRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(record, null, 2), 'utf8')
}

export async function readRunRecord(path: string): Promise<RunRecord> {
  const raw = await readFile(path, 'utf8')
  const parsed: unknown = JSON.parse(raw)
  assertValidRunRecord(parsed)
  return parsed
}

/**
 * Stable serialisation of a single scenario's runner-visible identity: the
 * prompt messages, the axes it contributes to, and the rubric. Deliberately
 * excludes free-form `meta` (notes, source labels) so cosmetic metadata edits
 * do not move the corpus hash, mirroring Modelsmith's scenario-set-hash intent.
 */
function scenarioHashContribution(scenario: Scenario): unknown {
  if (isEnvironmentScenario(scenario)) {
    return {
      id: scenario.id,
      axes: [...scenario.axes].sort(),
      input: scenario.input,
      rubric: scenario.rubric,
      environment: scenario.environment,
    }
  }

  if (isMultiTurnScenario(scenario)) {
    return {
      id: scenario.id,
      axes: [...scenario.axes].sort(),
      multiTurn: true,
      ...(scenario.systemPrompt ? { systemPrompt: scenario.systemPrompt } : {}),
      conversationHistory: scenario.conversationHistory ?? scenario.seedHistory ?? [],
      userTurns: scenario.userTurns,
      persistenceCriteria: scenario.persistenceCriteria,
    }
  }

  return {
    id: scenario.id,
    axes: [...scenario.axes].sort(),
    input: scenario.input,
    rubric: scenario.rubric,
  }
}

/**
 * Compute a deterministic content hash over a dataset's scenario set. The hash
 * is stable across hosts (no timestamps, paths, or run-specific data) and is
 * order-independent: the same scenarios always produce the same hash, whatever
 * order the loader returned them in.
 *
 * This is the harness-side corpus identity. It binds a RunRecord to a UNIQUE
 * scenario set so a score cannot be silently attributed to a different corpus
 * carrying the same dataset version tag.
 */
export function computeScenarioSetHash(dataset: Dataset): string {
  const members = dataset.scenarios
    .map(scenarioHashContribution)
    .sort((a, b) =>
      ((a as { id: string }).id).localeCompare((b as { id: string }).id),
    )
  const canonical = JSON.stringify({
    name: dataset.name,
    version: dataset.version,
    scenarios: members,
  })
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

export interface ComputeScenarioSetHashBySchemaOptions
  extends Partial<ScenarioSetHashV2Options> {
  hashSchemaVersion?: string
}

export function computeScenarioSetHashBySchema(
  dataset: Dataset,
  options: ComputeScenarioSetHashBySchemaOptions = {},
): ScenarioSetHashComputation {
  const version = options.hashSchemaVersion ?? SCENARIO_SET_HASH_SCHEMA_V1
  if (version === SCENARIO_SET_HASH_SCHEMA_V1) {
    return {
      hashSchemaVersion: SCENARIO_SET_HASH_SCHEMA_V1,
      scenarioSetHash: computeScenarioSetHash(dataset),
    }
  }
  if (version === SCENARIO_SET_HASH_SCHEMA_V2) {
    const metadata = computeScenarioSetHashV2(dataset, requireV2Options(options))
    return {
      hashSchemaVersion: SCENARIO_SET_HASH_SCHEMA_V2,
      scenarioSetHash: metadata.scenarioSetHash,
      metadata,
    }
  }
  throw new UnknownScenarioSetHashSchemaError(version)
}

export function computeScenarioSetHashV2(
  dataset: Dataset,
  options: ScenarioSetHashV2Options,
): ScenarioSetHashMetadataV2 {
  const checked = requireV2Options(options)
  const implementationFingerprints = normaliseFingerprints(
    checked.implementationFingerprints ?? [],
  )
  const scorerFingerprints = normaliseFingerprints(checked.scorerFingerprints ?? [])
  const scenarioContributions = dataset.scenarios
    .map(scenarioHashContributionV2)
    .sort((a, b) => a.id.localeCompare(b.id))
  const multiTurn = summariseMultiTurn(scenarioContributions.map((s) => s.multiTurnShape))
  const axes = uniqueSorted(scenarioContributions.flatMap((s) => s.axes))
  const rubricDescriptors = uniqueSorted(
    scenarioContributions.map((s) => s.rubricDescriptor.id),
  )
  const scoringDescriptors = uniqueSorted([
    ...scenarioContributions.map((s) => s.scoringDescriptor.id),
    ...scorerFingerprints.map((s) => s.id),
  ])

  const canonicalInput = {
    hashSchemaVersion: SCENARIO_SET_HASH_SCHEMA_V2,
    dataset: { name: dataset.name, version: dataset.version },
    domain: checked.domain,
    plugin: checked.plugin,
    implementationFingerprints,
    scorerFingerprints,
    scenarios: scenarioContributions,
  }
  const scenarioSetHash = hashCanonical(canonicalInput)

  return {
    hashSchemaVersion: SCENARIO_SET_HASH_SCHEMA_V2,
    scenarioSetHash,
    shortHash: scenarioSetHash.slice(0, 12),
    dataset: { name: dataset.name, version: dataset.version },
    domain: checked.domain,
    plugin: checked.plugin,
    scenarioCount: scenarioContributions.length,
    axes,
    rubricDescriptors,
    scoringDescriptors,
    multiTurn,
    implementationFingerprints,
    scorerFingerprints,
    hashedFields: [...SCENARIO_SET_HASH_V2_HASHED_FIELDS],
    excludedPrivateFields: [...SCENARIO_SET_HASH_V2_EXCLUDED_PRIVATE_FIELDS],
  }
}

function requireV2Options(
  options: Partial<ScenarioSetHashV2Options>,
): ScenarioSetHashV2Options {
  if (typeof options.domain !== 'string' || options.domain.length === 0) {
    throw new Error('scenario-set hash v2 requires a non-empty domain identity')
  }
  return {
    domain: options.domain,
    plugin: normalisePluginIdentity(options.plugin),
    implementationFingerprints: options.implementationFingerprints,
    scorerFingerprints: options.scorerFingerprints,
  }
}

function scenarioHashContributionV2(scenario: Scenario): {
  id: string
  axes: string[]
  runnerVisibleInput: unknown
  rubricDescriptor: { id: string, value: unknown }
  scoringDescriptor: { id: string, value: unknown }
  multiTurnShape: ScenarioMultiTurnShape
  multiTurnRunnerVisibleInput: unknown
  environmentShape: ScenarioEnvironmentShape
  environmentRunnerVisibleInput: unknown
} {
  const rubricDescriptor = publicRubricDescriptor(scenario.rubric)
  const scoringDescriptor = publicScoringDescriptor(scenario.rubric)
  return {
    id: scenario.id,
    axes: [...scenario.axes].sort(),
    runnerVisibleInput: redactPrivateFields(scenario.input),
    rubricDescriptor: {
      id: `${scenario.rubric.kind}:${hashCanonical(rubricDescriptor).slice(0, 12)}`,
      value: rubricDescriptor,
    },
    scoringDescriptor: {
      id: scoringDescriptor.id,
      value: scoringDescriptor,
    },
    multiTurnShape: multiTurnShape(scenario),
    multiTurnRunnerVisibleInput: multiTurnRunnerVisibleInput(scenario),
    environmentShape: environmentShape(scenario),
    environmentRunnerVisibleInput: environmentRunnerVisibleInput(scenario),
  }
}

interface ScenarioEnvironmentShape {
  id: string
  environment: boolean
  environmentId?: string
  maxSteps: number
  validatorCount: number
  allowedToolCount: number
  maxCalls?: number
}

function publicRubricDescriptor(rubric: Rubric): unknown {
  if (rubric.kind === 'programmatic') {
    return {
      kind: rubric.kind,
      checker: rubric.checker,
      ...(rubric.params ? { params: redactPrivateFields(rubric.params) } : {}),
    }
  }
  if (rubric.kind === 'mechanism') {
    return {
      kind: rubric.kind,
      quantitative: rubric.quantitative.map(gateDescriptor),
      disambiguation: rubric.disambiguation.map(gateDescriptor),
      actions: rubric.actions.map(gateDescriptor),
      bingoTokens: [...rubric.bingoTokens].sort(),
    }
  }
  if (rubric.kind === 'llm-judge') {
    return {
      kind: rubric.kind,
      judge: rubric.judge,
      promptHash: hashCanonical(rubric.prompt),
      referencePresent: rubric.reference !== undefined,
      calibrationPromptHash: rubric.calibration?.promptHash,
      biasCheckKinds: (rubric.biasChecks ?? []).map((check) => check.kind).sort(),
      claimPolicy: rubric.claimPolicy ?? 'analysis-only',
    }
  }
  return {
    kind: rubric.kind,
    instructionsHash: hashCanonical(rubric.instructions),
  }
}

function publicScoringDescriptor(rubric: Rubric): { id: string, kind: string } {
  if (rubric.kind === 'programmatic') {
    return { id: `programmatic:${rubric.checker}`, kind: rubric.kind }
  }
  if (rubric.kind === 'mechanism') {
    return { id: 'mechanism:mechanism-scorer-v1', kind: rubric.kind }
  }
  if (rubric.kind === 'llm-judge') {
    return { id: `llm-judge:${rubric.judge}`, kind: rubric.kind }
  }
  return { id: 'human:instructions', kind: rubric.kind }
}

function gateDescriptor(gate: { label: string, matchers: string[] }): unknown {
  return {
    label: gate.label,
    matchers: [...gate.matchers].sort(),
  }
}

function multiTurnRunnerVisibleInput(scenario: Scenario): unknown {
  const { seedHistory, userTurns, persistenceCriteria } = multiTurnParts(scenario)
  return redactPrivateFields({
    seedHistory: seedHistory ?? [],
    userTurns: userTurns ?? [],
    persistenceCriteria: persistenceCriteria ?? [],
  })
}

function environmentRunnerVisibleInput(scenario: Scenario): unknown {
  if (!isEnvironmentScenario(scenario)) return {}
  return redactPrivateFields({
    environmentId: scenario.environment.environmentId,
    setup: scenario.environment.setup,
    maxSteps: scenario.environment.maxSteps,
    toolPolicy: scenario.environment.toolPolicy,
    validators: scenario.environment.validators,
  })
}

function environmentShape(scenario: Scenario): ScenarioEnvironmentShape {
  if (!isEnvironmentScenario(scenario)) {
    return {
      id: scenario.id,
      environment: false,
      maxSteps: 0,
      validatorCount: 0,
      allowedToolCount: 0,
    }
  }
  const environment = (scenario as EnvironmentScenario).environment
  return {
    id: scenario.id,
    environment: true,
    environmentId: environment.environmentId,
    maxSteps: environment.maxSteps ?? 1,
    validatorCount: environment.validators.length,
    allowedToolCount: environment.toolPolicy?.allowedToolNames?.length ?? 0,
    ...(environment.toolPolicy?.maxCalls !== undefined
      ? { maxCalls: environment.toolPolicy.maxCalls }
      : {}),
  }
}

function multiTurnShape(scenario: Scenario): ScenarioMultiTurnShape {
  const { seedHistory, userTurns, persistenceCriteria } = multiTurnParts(scenario)
  const inputMeta = isRecord(scenario.input.meta) ? scenario.input.meta : {}
  const meta = isRecord(scenario.meta) ? scenario.meta : {}
  const multiTurn =
    meta['multiTurn'] === true ||
    inputMeta['multiTurn'] === true ||
    seedHistory !== undefined ||
    userTurns !== undefined ||
    persistenceCriteria !== undefined
  const runnerVisibleTurnCount = Math.max(
    scenario.input.messages.length,
    (seedHistory?.length ?? 0) + (userTurns?.length ?? 0),
  )

  return {
    id: scenario.id,
    multiTurn,
    runnerVisibleTurnCount,
    seedHistoryTurnCount: seedHistory?.length ?? 0,
    userTurnCount: userTurns?.length ?? 0,
    persistenceCriteriaCount: persistenceCriteria?.length ?? 0,
  }
}

function multiTurnParts(scenario: Scenario): {
  seedHistory?: unknown[]
  userTurns?: unknown[]
  persistenceCriteria?: unknown[]
} {
  const scenarioRecord = scenario as unknown as Record<string, unknown>
  const inputMeta = isRecord(scenario.input.meta) ? scenario.input.meta : {}
  const meta = isRecord(scenario.meta) ? scenario.meta : {}
  return {
    seedHistory: firstArray(
      scenarioRecord['seedHistory'],
      scenarioRecord['conversationHistory'],
      inputMeta['seedHistory'],
      inputMeta['conversationHistory'],
      meta['seedHistory'],
      meta['conversationHistory'],
    ),
    userTurns: firstArray(
      scenarioRecord['userTurns'],
      inputMeta['userTurns'],
      meta['userTurns'],
    ),
    persistenceCriteria: firstArray(
      scenarioRecord['persistenceCriteria'],
      inputMeta['persistenceCriteria'],
      meta['persistenceCriteria'],
    ),
  }
}

function summariseMultiTurn(shapes: ScenarioMultiTurnShape[]): ScenarioSetMultiTurnSummary {
  const scenarioCount = shapes.length
  const multiTurnScenarioCount = shapes.filter((shape) => shape.multiTurn).length
  return {
    scenarioCount,
    singleTurnScenarioCount: scenarioCount - multiTurnScenarioCount,
    multiTurnScenarioCount,
    maxRunnerVisibleTurns: Math.max(0, ...shapes.map((shape) => shape.runnerVisibleTurnCount)),
    scenarios: shapes.slice().sort((a, b) => a.id.localeCompare(b.id)),
  }
}

function firstArray(...values: unknown[]): unknown[] | undefined {
  return values.find((value): value is unknown[] => Array.isArray(value))
}

function normaliseFingerprints(
  fingerprints: readonly ScenarioSetFingerprint[],
): ScenarioSetFingerprint[] {
  return fingerprints
    .map(normaliseFingerprint)
    .sort((a, b) => a.id.localeCompare(b.id))
}

function normalisePluginIdentity(value: unknown): ScenarioSetPluginIdentity {
  if (!isRecord(value) || typeof value['id'] !== 'string' || value['id'].length === 0) {
    throw new Error('scenario-set hash v2 requires a plugin identity with a non-empty id')
  }
  const plugin: ScenarioSetPluginIdentity = { id: value['id'] }
  if (typeof value['version'] === 'string') plugin.version = value['version']
  if (typeof value['uri'] === 'string') plugin.uri = value['uri']
  return plugin
}

function normaliseFingerprint(value: unknown): ScenarioSetFingerprint {
  if (!isRecord(value) || typeof value['id'] !== 'string' || value['id'].length === 0) {
    throw new Error('scenario-set hash v2 fingerprints require a non-empty id')
  }
  const fingerprint: ScenarioSetFingerprint = { id: value['id'] }
  if (typeof value['version'] === 'string') fingerprint.version = value['version']
  if (typeof value['digest'] === 'string') fingerprint.digest = value['digest']
  if (typeof value['uri'] === 'string') fingerprint.uri = value['uri']
  return fingerprint
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort()
}

function hashCanonical(value: unknown): string {
  return createHash('sha256').update(stableStringify(value), 'utf8').digest('hex')
}

function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item))
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      const child = value[key]
      if (child !== undefined) {
        out[key] = canonicalize(child)
      }
    }
    return out
  }
  return value
}

function redactPrivateFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactPrivateFields(item))
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      if (PRIVATE_FIELD_NAMES.has(key)) continue
      const child = value[key]
      if (child !== undefined) {
        const redacted = redactPrivateFields(child)
        if (redacted !== undefined) out[key] = redacted
      }
    }
    return Object.keys(out).length > 0 ? out : undefined
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Generate a short run id. Not cryptographic; just a collision-resistant
 * timestamp-plus-random tag used inside RunRecord.id.
 */
export function newRunId(): string {
  const ts = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)
  const rand = Math.random().toString(36).slice(2, 8)
  return `${ts}-${rand}`
}
