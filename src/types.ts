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
}

export interface AxisAggregate {
  mean: number
  variance: number
  n: number
  confidenceInterval?: ConfidenceInterval
}

export interface ModelAggregate {
  runnerId: string
  axes: Record<string, AxisAggregate>
  /** Weighted composite across axes. */
  composite: number
  /** Weighting rationale; published alongside the release. */
  weights: Record<string, number>
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
    /** Additional run-level context: host, env flags, etc. */
    env?: Record<string, unknown>
  }
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

export interface PreferencePair {
  itemId: string
  scenarioHash: string
  chosenResponseId: string
  rejectedResponseId: string
  source: 'human-annotation'
  rubricVersion: string
}
