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
  | LLMJudgeRubric
  | HumanRubric

export interface ProgrammaticRubric {
  kind: 'programmatic'
  /** Identifier of a checker registered in src/rubric.ts */
  checker: string
  /** Arbitrary params consumed by the checker (e.g. expected value). */
  params?: Record<string, unknown>
}

export interface LLMJudgeRubric {
  kind: 'llm-judge'
  /** Pinned judge model identifier, e.g. "anthropic:claude-opus-4-7". */
  judge: string
  /** Judge prompt template. Use {response} to interpolate the candidate. */
  prompt: string
  /** Reference answer, if any, for the judge to compare against. */
  reference?: string
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
}

export interface AxisAggregate {
  mean: number
  variance: number
  n: number
}

export interface ModelAggregate {
  runnerId: string
  axes: Record<string, AxisAggregate>
  /** Weighted composite across axes. */
  composite: number
  /** Weighting rationale; published alongside the release. */
  weights: Record<string, number>
}

export interface RunRecord {
  /** Generated run identifier. */
  id: string
  dataset: {
    name: string
    version: string
  }
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
