/**
 * Core types for the assay-harness public surface.
 *
 * These types are the contract between scenario authors, rubric authors,
 * runners, and downstream consumers of RunRecord output. Changes here are
 * breaking changes for the benchmark series.
 */

export type Role = 'system' | 'user' | 'assistant'

export interface Message {
  role: Role
  content: string
}

export interface ScenarioInput {
  messages: Message[]
  meta?: Record<string, unknown>
}

export type Rubric =
  | ProgrammaticRubric
  | MechanismRubric
  | LLMJudgeRubric
  | HumanRubric

export interface ProgrammaticRubric {
  kind: 'programmatic'
  /** Identifier of a checker registered in src/rubric.ts */
  checker: string
  /** Arbitrary params consumed by the checker (e.g. expected value). */
  params?: Record<string, unknown>
}

/**
 * A single mechanism gate as authored in scenario JSON. `matchers` are plain
 * strings; a value wrapped in `/.../flags` is treated as a regex source, any
 * other value is a literal phrase (negation-aware, word-edge anchored).
 */
export interface MechanismGateSpec {
  /** Friendly label surfaced in the rationale when the gate is missed. */
  label: string
  matchers: string[]
}

/**
 * Executable, anti-bingo mechanism rubric (assay-harness#54, council
 * `assay-harness-review-2026-06-18` Tier-2 #5). Scores a response on
 * quantitative / disambiguation / action gates and hard-caps pure
 * vocabulary-echo answers at 0.2. The gates describe the *shape* of a correct
 * mechanism, not a per-scenario answer key — see src/mechanism.ts.
 */
export interface MechanismRubric {
  kind: 'mechanism'
  /** Quantitative gates — the load-bearing magnitude / id must surface. */
  quantitative: MechanismGateSpec[]
  /** Disambiguation gates — distinguish correct from plausible-but-wrong. */
  disambiguation: MechanismGateSpec[]
  /** Concrete, signal-derived action gates. */
  actions: MechanismGateSpec[]
  /** Vocabulary tokens that, echoed alone, trip the anti-bingo cap. */
  bingoTokens: string[]
}

export interface LLMJudgeRubric {
  kind: 'llm-judge'
  /** Pinned judge model identifier, e.g. "anthropic:claude-opus-4-7". */
  judge: string
  /** Judge prompt template. Use {response} to interpolate the candidate. */
  prompt: string
  /** Reference answer, if any, for the judge to compare against. */
  reference?: string
  /** Calibration evidence required before the harness will call a judge. */
  calibration?: JudgeCalibration
  /** Bias probes that were run against the judge prompt/model pair. */
  biasChecks?: JudgeBiasCheck[]
  /** Defaults to analysis-only so judged scores cannot silently become claims. */
  claimPolicy?: 'analysis-only' | 'benchmark-eligible'
}

export interface HumanRubric {
  kind: 'human'
  instructions: string
}

export interface Scenario {
  id: string
  /** Axis labels this scenario contributes to. A scenario may test one or more. */
  axes: string[]
  input: ScenarioInput
  rubric: Rubric
  /** Optional metadata: source (practitioner-authored, synthetic), weight, notes. */
  meta?: Record<string, unknown>
}

export interface EnvironmentToolPolicy {
  /** Empty or omitted means the adapter decides which tools are valid. */
  allowedToolNames?: string[]
  /** Hard cap on model-originated tool/action calls for this scenario. */
  maxCalls?: number
}

export interface EnvironmentStateValidatorSpec {
  /** Stable validator id implemented by the environment adapter/domain pack. */
  id: string
  /** Serializable validator parameters, e.g. expected final state fields. */
  params?: Record<string, unknown>
  /** Optional additive weighting hint for consumers; the core scores pass fraction. */
  weight?: number
}

export interface EnvironmentScenarioSpec {
  /** Adapter/domain-pack id. Domain packs own the implementation behind this id. */
  environmentId: string
  /** Serializable setup payload consumed by the environment adapter. */
  setup?: unknown
  /** Defaults to 1. The runner bridge refuses non-positive values. */
  maxSteps?: number
  /** Public tool/action policy recorded into the trace. */
  toolPolicy?: EnvironmentToolPolicy
  /** Executable state validators to run against the final state. Must be non-empty. */
  validators: EnvironmentStateValidatorSpec[]
}

export interface EnvironmentScenario extends Scenario {
  /** Stateful environment contract. Omitted scenarios follow the normal chat path. */
  environment: EnvironmentScenarioSpec
}

export interface EnvironmentActionCall {
  callId?: string
  /** Tool/action name parsed from model output or adapter-native action envelope. */
  toolName: string
  /** Serializable call arguments. */
  input?: unknown
  /** Adapter-provided raw public-safe action envelope, redacted before tracing. */
  raw?: unknown
}

export interface EnvironmentObservation {
  ok: boolean
  output?: unknown
  error?: {
    code: string
    message: string
  }
  /** Signals the bridge to stop before maxSteps. */
  done?: boolean
}

export interface EnvironmentStateValidationResult {
  id: string
  passed: boolean
  /** Normalised 0 to 1. */
  value: number
  rationale?: string
  meta?: Record<string, unknown>
}

export interface EnvironmentTraceRedaction {
  applied: boolean
  redactedPaths: string[]
}

export interface EnvironmentTraceStep {
  index: number
  responseScenarioId: string
  modelOutput: string
  action?: EnvironmentActionCall
  observation: EnvironmentObservation
  state: unknown
}

export interface EnvironmentTrace {
  schemaVersion: 'assay.environment-trace.v1'
  scenarioId: string
  runnerId: string
  environmentId: string
  adapterVersion?: string
  toolPolicy?: EnvironmentToolPolicy
  setup?: unknown
  steps: EnvironmentTraceStep[]
  finalState: unknown
  validators: EnvironmentStateValidationResult[]
  redaction: EnvironmentTraceRedaction
}

export interface EnvironmentRunMetadata {
  schemaVersion: 'assay.environment-run-metadata.v1'
  results: EnvironmentTrace[]
}

export interface Dataset {
  name: string
  /** Semver tag for this dataset. Pinned per release. */
  version: string
  /** Optional description; shown in CLI list output. */
  description?: string
  scenarios: Scenario[]
}

export interface RunnerOptions {
  temperature?: number
  systemPrompt?: string
  seed?: number
  timeoutMs?: number
  /** Extra provider-specific options; serialised into ModelResponse.meta. */
  extra?: Record<string, unknown>
}

export interface ModelResponse {
  runnerId: string
  scenarioId: string
  output: string
  meta: {
    provider: string
    model: string
    version?: string
    accessedAt: string
    temperature?: number
    seed?: number
    latencyMs: number
    extra?: Record<string, unknown>
  }
}

export interface Runner {
  id: string
  provider: string
  model: string
  run(scenario: Scenario, opts?: RunnerOptions): Promise<ModelResponse>
}

export interface Score {
  runnerId: string
  scenarioId: string
  axis: string
  /** Normalised 0 to 1. */
  value: number
  rationale?: string
  judge?: string
  judgeProvenance?: JudgeProvenance
  claimStatus?: 'programmatic' | 'analysis-only' | 'benchmark-eligible'
  /**
   * Optional additive metadata for repeated samples and slice-aware reporting.
   * The core only interprets `slices` as arbitrary dimension/value labels.
   */
  meta?: {
    sampleId?: string
    slices?: Record<string, unknown>
    [key: string]: unknown
  }
}

export interface AxisAggregate {
  mean: number
  variance: number
  n: number
  confidenceInterval?: ConfidenceInterval
}

export interface ReliabilityMetrics {
  passThreshold: number
  /** Fraction of scenario/axis groups with at least one passing sample. */
  passAtK: number
  /** Fraction of scenario/axis groups where every sample passes. */
  passPowerK: number
  meanSamplesPerScenario: number
  repeatedScenarioCount: number
  evaluatedScenarioCount: number
  sampleCount: number
}

export interface OperationalMetrics {
  responseCount: number
  meanLatencyMs: number | null
  p50LatencyMs: number | null
  p95LatencyMs: number | null
  refusalRate: number | null
  totalPromptTokens: number | null
  totalCompletionTokens: number | null
  totalTokens: number | null
  totalCostUsd: number | null
  missingMetadata: {
    latency: number
    tokenCount: number
    cost: number
    refusal: number
  }
}

export interface SliceAggregate {
  axes: Record<string, AxisAggregate>
  composite: number
  n: number
  reliability: ReliabilityMetrics
}

export interface ModelAggregate {
  runnerId: string
  axes: Record<string, AxisAggregate>
  /** Weighted composite across axes. */
  composite: number
  /** Weighting rationale; published alongside the release. */
  weights: Record<string, number>
  reliability?: ReliabilityMetrics
  operational?: OperationalMetrics
  slices?: Record<string, SliceAggregate>
  statisticalClaims?: StatisticalClaimMetadata
}

export type ScenarioSetHashSchemaVersion = 'v1' | 'v2'

export interface ScenarioSetPluginIdentity {
  id: string
  version?: string
  uri?: string
}

export interface ScenarioSetFingerprint {
  id: string
  version?: string
  digest?: string
  uri?: string
}

export interface ClaimCardProviderCell {
  provider: string
  model?: string
  status: 'verified' | 'failed' | 'blocked' | 'stale'
  generatedAt?: string
  expiresAt?: string
  proofUrl?: string
}

export interface ClaimCard {
  schemaVersion: 'assay.claim-card.v1'
  dataset: {
    name: string
    version: string
  }
  scenarioSetHash: string
  hashSchemaVersion: ScenarioSetHashSchemaVersion
  status: 'allowed' | 'blocked'
  leaderboardClaimsAllowed: boolean
  generatedAt?: string
  expiresAt?: string
  allowedClaimText?: string
  blocker?: string
  implementationFingerprints?: ScenarioSetFingerprint[]
  scorerFingerprints?: ScenarioSetFingerprint[]
  quorum?: {
    required: number
    providers: string[]
  }
  providerCells?: ClaimCardProviderCell[]
  metadata?: Record<string, unknown>
}

export interface ScenarioMultiTurnShape {
  id: string
  multiTurn: boolean
  runnerVisibleTurnCount: number
  seedHistoryTurnCount: number
  userTurnCount: number
  persistenceCriteriaCount: number
}

export interface ScenarioSetMultiTurnSummary {
  scenarioCount: number
  singleTurnScenarioCount: number
  multiTurnScenarioCount: number
  maxRunnerVisibleTurns: number
  scenarios: ScenarioMultiTurnShape[]
}

export interface ScenarioSetHashV2Options {
  /** Public benchmark domain id, e.g. "adtech". */
  domain: string
  /** Public package/domain plugin that produced the scenario shape. */
  plugin: ScenarioSetPluginIdentity
  /**
   * Public-safe implementation ids/digests for canonicalisers, adapters, or
   * domain packs. Never put private prompt material or answer keys here.
   */
  implementationFingerprints?: ScenarioSetFingerprint[]
  /**
   * Public-safe scorer ids/digests. Private scorer data should be represented
   * by an opaque fingerprint, not by embedding answer-key fields.
   */
  scorerFingerprints?: ScenarioSetFingerprint[]
}

export interface ScenarioSetHashComputationV1 {
  hashSchemaVersion: 'v1'
  scenarioSetHash: string
}

export interface ScenarioSetHashMetadataV1 {
  hashSchemaVersion?: 'v1'
  scenarioSetHash: string
  shortHash?: string
  scenarioCount?: number
  [key: string]: unknown
}

export interface ScenarioSetHashMetadataV2 {
  hashSchemaVersion: 'v2'
  scenarioSetHash: string
  shortHash: string
  dataset: {
    name: string
    version: string
  }
  domain: string
  plugin: ScenarioSetPluginIdentity
  scenarioCount: number
  axes: string[]
  rubricDescriptors: string[]
  scoringDescriptors: string[]
  multiTurn: ScenarioSetMultiTurnSummary
  implementationFingerprints: ScenarioSetFingerprint[]
  scorerFingerprints: ScenarioSetFingerprint[]
  hashedFields: string[]
  excludedPrivateFields: string[]
}

export interface ScenarioSetHashComputationV2 {
  hashSchemaVersion: 'v2'
  scenarioSetHash: string
  metadata: ScenarioSetHashMetadataV2
}

export type ScenarioSetHashComputation =
  | ScenarioSetHashComputationV1
  | ScenarioSetHashComputationV2

export type ScenarioSetHashMetadata =
  | ScenarioSetHashMetadataV1
  | ScenarioSetHashMetadataV2

export interface RunRecord {
  /** Generated run identifier. */
  id: string
  dataset: {
    name: string
    version: string
  }
  /**
   * Content hash of the exact scenario set scored in this run. Binds the
   * RunRecord to a UNIQUE corpus, so two consumers scoring different corpora
   * cannot both emit "the v1.8.0-rc.4 score". When the run is bound to a
   * declared contract hash and the corpus hash does not match, the harness
   * refuses to score or publish (see `assertScenarioSetHashMatches`).
   *
   * Computed by `computeScenarioSetHash(dataset)` over the sorted scenario ids
   * and each scenario's runner-visible prompt + rubric. Optional only for
   * backwards compatibility with pre-binding RunRecords; new runs always set it.
   */
  scenarioSetHash?: string
  /**
   * Optional schema discriminator for `scenarioSetHash`. Missing means legacy
   * v0/v1 compatibility; unknown explicit versions fail validation closed.
   */
  scenarioSetHashSchemaVersion?: ScenarioSetHashSchemaVersion
  /**
   * Additive metadata describing how `scenarioSetHash` was computed. v2
   * metadata binds public corpus identity without exposing private answer-key
   * material.
   */
  scenarioSetHashMetadata?: ScenarioSetHashMetadata
  runners: string[]
  createdAt: string
  responses: ModelResponse[]
  scores: Score[]
  aggregates: ModelAggregate[]
  meta: {
    harnessVersion: string
    commandLine?: string
    /** Additive v1 metadata; #69 can extend this into hash schema v2. */
    scenarioSetHashMetadata?: {
      schemaVersion: string
      scenarioSetHash: string
      scenarioCount: number
      singleTurnScenarioCount?: number
      multiTurnScenarioCount?: number
    }
    /** Multi-turn audit trail, present only when a run executes multi-turn scenarios. */
    multiTurn?: {
      graderVersion: string
      results: Array<{
        scenarioId: string
        runnerId: string
        value: number
        graderVersion: string
        turnObservations: unknown[]
        persistence: unknown[]
        turnResponseScenarioIds: string[]
      }>
    }
    /** Environment audit trail, present only when a run executes environment scenarios. */
    environment?: EnvironmentRunMetadata
    /** Incremental resumable-run ledger metadata, present when the run used a ledger. */
    runLedger?: RunLedgerRunRecordMetadata
    /** Checksum-addressed per-sample traces emitted by a ledger-backed run. */
    traceBundles?: TraceBundleIndexMetadata
    /** Additional run-level context: host, env flags, etc. */
    env?: Record<string, unknown>
  }
}

export type TraceBundleVisibility = 'public' | 'internal'

export type TraceRawOutputPolicy = 'omit' | 'redacted' | 'include'

export interface TraceBundleReference {
  schemaVersion: 'assay.sample-trace.v1'
  scenarioId: string
  runnerId: string
  checksum: string
  fileName: string
  path: string
  visibility: TraceBundleVisibility
  rawOutputPolicy: TraceRawOutputPolicy
}

export interface TraceBundleIndexMetadata {
  schemaVersion: 'assay.trace-index.v1'
  visibility: TraceBundleVisibility
  rawOutputPolicy: TraceRawOutputPolicy
  bundles: TraceBundleReference[]
}

export interface MultiTurnRunLedgerMetadata {
  scenarioId: string
  runnerId: string
  value: number
  graderVersion: string
  turnObservations: unknown[]
  persistence: unknown[]
  turnResponseScenarioIds: string[]
}

export interface ScenarioRunLedgerOutcome {
  responses: ModelResponse[]
  scores: Score[]
  latencyMs: number
  multiTurn?: MultiTurnRunLedgerMetadata
}

export interface RunLedgerError {
  name: string
  message: string
  stack?: string
}

export interface RunLedgerConfidenceOptions {
  enabled: boolean
  iterations: number
  confidenceLevel: number
  seed: number
}

export interface RunLedgerAggregateOptions {
  confidence: RunLedgerConfidenceOptions
}

export interface RunLedgerHeader {
  schemaVersion: 'assay.run-ledger.v1'
  type: 'header'
  runId: string
  dataset: {
    name: string
    version: string
  }
  scenarioSetHash: string
  scenarioSetHashSchemaVersion: ScenarioSetHashSchemaVersion
  scenarioSetHashMetadata?: ScenarioSetHashMetadata
  runnerIds: string[]
  runnerOptions: RunnerOptions
  runnerOptionsHash: string
  aggregate: RunLedgerAggregateOptions
  tracePolicy?: {
    visibility: TraceBundleVisibility
    rawOutputPolicy: TraceRawOutputPolicy
  }
  harnessVersion: string
  commandLine?: string
  createdAt: string
}

export interface RunLedgerCellBase {
  schemaVersion: 'assay.run-ledger.v1'
  type: 'cell'
  runId: string
  scenarioId: string
  runnerId: string
  runnerOptionsHash: string
  startedAt: string
  completedAt: string
}

export interface RunLedgerCompletedCell extends RunLedgerCellBase {
  status: 'completed'
  outcome: ScenarioRunLedgerOutcome
  trace?: TraceBundleReference
}

export interface RunLedgerFailedCell extends RunLedgerCellBase {
  status: 'failed'
  error: RunLedgerError
}

export type RunLedgerCell = RunLedgerCompletedCell | RunLedgerFailedCell

export type RunLedgerEntry = RunLedgerHeader | RunLedgerCell

export interface RunLedgerRunRecordMetadata {
  schemaVersion: 'assay.run-ledger.v1'
  runId: string
  completedCells: number
  failedCells: number
}

export interface ConfidenceInterval {
  method: 'bootstrap' | 'paired-bootstrap'
  lower: number
  upper: number
  confidenceLevel: number
  iterations: number
  seed: number
  n: number
}

export interface StatisticalClaimMetadata {
  method: 'bootstrap'
  confidenceLevel: number
  iterations: number
  seed: number
  sampleUnit: 'score'
}

export interface PairedComparison {
  baselineRunnerId: string
  candidateRunnerId: string
  delta: number
  n: number
  confidenceInterval: ConfidenceInterval
}

export interface JudgeCalibration {
  setId: string
  minimumAgreement: number
  observedAgreement: number
  promptHash: string
}

export interface JudgeBiasCheck {
  kind: 'position' | 'verbosity' | 'refusal' | 'label-order'
  passed: boolean
  detail?: string
}

export interface JudgeProvenance {
  provider: string
  model: string
  promptHash: string
  rubricVersion: string
  parserVersion: string
  judgedAt: string
}

export interface LLMJudgeResult {
  value: number
  rationale?: string
  provenance?: JudgeProvenance
}

export type LLMJudgeExecutor = (
  request: {
    response: ModelResponse
    scenario: Scenario
    rubric: LLMJudgeRubric
    renderedPrompt: string
  },
) => Promise<LLMJudgeResult> | LLMJudgeResult

export interface HumanAnnotation {
  itemId: string
  scenarioHash: string
  responseId: string
  label: 'pass' | 'fail' | 'tie' | 'invalid'
  score: number
  reviewer: string
  rubricVersion: string
  annotatedAt: string
  status: 'pending' | 'agreed' | 'conflicted' | 'adjudicated' | 'rejected'
  rationale?: string
  adjudicator?: string
  adjudicatedAt?: string
}

export interface HumanAnnotationValidation {
  valid: boolean
  errors: string[]
  conflicts: Array<{
    itemId: string
    responseId: string
    labels: string[]
  }>
}

export interface HumanAdjudicationDecision {
  itemId: string
  responseId: string
  label: HumanAnnotation['label']
  score: number
  adjudicator: string
  scenarioHash?: string
  rubricVersion?: string
  adjudicatedAt?: string
  rationale?: string
}

export interface PreferencePair {
  itemId: string
  scenarioHash: string
  chosenResponseId: string
  rejectedResponseId: string
  source: 'human-annotation'
  rubricVersion: string
}
