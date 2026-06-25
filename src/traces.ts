import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { isEnvironmentScenario } from './environment.js'
import { canonicalJson, checksumObject } from './proof.js'
import { redactText } from './redact.js'
import { isMultiTurnScenario } from './runners/multi-turn.js'
import type {
  Dataset,
  Message,
  ModelResponse,
  RunLedgerHeader,
  Scenario,
  ScenarioRunLedgerOutcome,
  Score,
  TraceBundleReference,
  TraceBundleVisibility,
  TraceRawOutputPolicy,
} from './types.js'

export const SAMPLE_TRACE_SCHEMA_VERSION = 'assay.sample-trace.v1' as const
export const TRACE_INDEX_SCHEMA_VERSION = 'assay.trace-index.v1' as const

export interface SampleTraceBundle {
  schemaVersion: typeof SAMPLE_TRACE_SCHEMA_VERSION
  checksum: string
  payload: SampleTracePayload
}

export interface SampleTracePayload {
  schemaVersion: typeof SAMPLE_TRACE_SCHEMA_VERSION
  runId: string
  dataset: {
    name: string
    version: string
  }
  scenarioSetHash: string
  scenarioSetHashSchemaVersion: RunLedgerHeader['scenarioSetHashSchemaVersion']
  scenarioId: string
  runner: {
    id: string
    optionsHash: string
    options: unknown
  }
  prompt: unknown
  responses: TraceResponseSummary[]
  scores: TraceScoreComponent[]
  latencyMs: number
  multiTurn?: unknown
  redaction: TraceRedactionSummary
  tracePolicy: {
    visibility: TraceBundleVisibility
    rawOutputPolicy: TraceRawOutputPolicy
  }
}

export interface TraceResponseSummary {
  index: number
  scenarioId: string
  responseHash: string
  responseBytes: number
  provider: string
  model: string
  version?: string
  accessedAt: string
  latencyMs: number
  temperature?: number
  seed?: number
  providerRuntime?: unknown
  retryMetadata?: unknown
  rawOutput?: string
}

export interface TraceScoreComponent {
  axis: string
  value: number
  rationale?: string
  judge?: string
  judgeProvenance?: Score['judgeProvenance']
  claimStatus?: Score['claimStatus']
  meta?: unknown
}

export interface TraceRedactionSummary {
  applied: boolean
  redactedPaths: string[]
}

export interface BuildSampleTraceBundleOptions {
  header: RunLedgerHeader
  dataset: Pick<Dataset, 'name' | 'version'>
  scenario: Scenario
  runnerId: string
  outcome: ScenarioRunLedgerOutcome
  visibility?: TraceBundleVisibility
  rawOutputPolicy?: TraceRawOutputPolicy
}

export interface WriteSampleTraceBundleOptions extends BuildSampleTraceBundleOptions {
  traceDir: string
}

export function normaliseTracePolicy(
  visibility: TraceBundleVisibility = 'public',
  rawOutputPolicy: TraceRawOutputPolicy = 'omit',
): { visibility: TraceBundleVisibility, rawOutputPolicy: TraceRawOutputPolicy } {
  if (visibility !== 'public' && visibility !== 'internal') {
    throw new Error(`trace visibility must be "public" or "internal", got "${visibility}"`)
  }
  if (!['omit', 'redacted', 'include'].includes(rawOutputPolicy)) {
    throw new Error(
      `trace raw output policy must be "omit", "redacted", or "include", got "${rawOutputPolicy}"`,
    )
  }
  if (visibility === 'public' && rawOutputPolicy === 'include') {
    throw new Error('public trace bundles cannot include raw outputs; use redacted or internal visibility')
  }
  return { visibility, rawOutputPolicy }
}

export function buildSampleTraceBundle(
  options: BuildSampleTraceBundleOptions,
): SampleTraceBundle {
  const policy = normaliseTracePolicy(options.visibility, options.rawOutputPolicy)
  const redaction: TraceRedactionSummary = { applied: false, redactedPaths: [] }
  const payload: SampleTracePayload = {
    schemaVersion: SAMPLE_TRACE_SCHEMA_VERSION,
    runId: options.header.runId,
    dataset: {
      name: options.dataset.name,
      version: options.dataset.version,
    },
    scenarioSetHash: options.header.scenarioSetHash,
    scenarioSetHashSchemaVersion: options.header.scenarioSetHashSchemaVersion,
    scenarioId: options.scenario.id,
    runner: {
      id: options.runnerId,
      optionsHash: options.header.runnerOptionsHash,
      options: redactValue(options.header.runnerOptions, 'runner.options', redaction),
    },
    prompt: buildPromptTrace(options.scenario, redaction),
    responses: options.outcome.responses.map((response, index) =>
      summariseResponse(response, index, policy.rawOutputPolicy, redaction),
    ),
    scores: options.outcome.scores.map((score) => summariseScore(score, redaction)),
    latencyMs: options.outcome.latencyMs,
    ...(options.outcome.multiTurn
      ? { multiTurn: redactValue(options.outcome.multiTurn, 'multiTurn', redaction) }
      : {}),
    redaction,
    tracePolicy: policy,
  }
  const checksum = checksumObject(payload)
  return {
    schemaVersion: SAMPLE_TRACE_SCHEMA_VERSION,
    checksum,
    payload,
  }
}

export async function writeSampleTraceBundle(
  options: WriteSampleTraceBundleOptions,
): Promise<TraceBundleReference> {
  const bundle = buildSampleTraceBundle(options)
  const fileName = checksumToFileName(bundle.checksum)
  const path = join(options.traceDir, fileName)
  await mkdir(options.traceDir, { recursive: true })
  await writeFile(path, canonicalJson(bundle, true), 'utf8')
  const policy = normaliseTracePolicy(options.visibility, options.rawOutputPolicy)
  return {
    schemaVersion: SAMPLE_TRACE_SCHEMA_VERSION,
    scenarioId: options.scenario.id,
    runnerId: options.runnerId,
    checksum: bundle.checksum,
    fileName,
    path,
    visibility: policy.visibility,
    rawOutputPolicy: policy.rawOutputPolicy,
  }
}

export function checksumString(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`
}

function checksumToFileName(checksum: string): string {
  return `${checksum.replace(/^sha256:/, 'sha256-')}.json`
}

function buildPromptTrace(scenario: Scenario, redaction: TraceRedactionSummary): unknown {
  if (isMultiTurnScenario(scenario)) {
    return {
      kind: 'multi-turn',
      ...(scenario.systemPrompt
        ? { systemPrompt: redactValue(scenario.systemPrompt, 'prompt.systemPrompt', redaction) }
        : {}),
      conversationHistory: redactValue(
        scenario.conversationHistory ?? scenario.seedHistory ?? [],
        'prompt.conversationHistory',
        redaction,
      ),
      userTurns: redactValue(scenario.userTurns, 'prompt.userTurns', redaction),
    }
  }

  if (isEnvironmentScenario(scenario)) {
    return {
      kind: 'environment',
      messages: redactMessages(scenario.input.messages, redaction),
      environmentId: scenario.environment.environmentId,
      toolPolicy: redactValue(scenario.environment.toolPolicy ?? {}, 'prompt.toolPolicy', redaction),
      setup: redactValue(scenario.environment.setup ?? null, 'prompt.setup', redaction),
    }
  }

  return {
    kind: 'single-turn',
    messages: redactMessages(scenario.input.messages, redaction),
  }
}

function redactMessages(
  messages: Message[],
  redaction: TraceRedactionSummary,
): Message[] {
  return messages.map((message, index) => ({
    role: message.role,
    content: redactValue(message.content, `prompt.messages[${index}].content`, redaction) as string,
  }))
}

function summariseResponse(
  response: ModelResponse,
  index: number,
  rawOutputPolicy: TraceRawOutputPolicy,
  redaction: TraceRedactionSummary,
): TraceResponseSummary {
  const extra = response.meta.extra ?? {}
  const summary: TraceResponseSummary = {
    index,
    scenarioId: response.scenarioId,
    responseHash: checksumString(response.output),
    responseBytes: Buffer.byteLength(response.output, 'utf8'),
    provider: response.meta.provider,
    model: response.meta.model,
    ...(response.meta.version ? { version: response.meta.version } : {}),
    accessedAt: response.meta.accessedAt,
    latencyMs: response.meta.latencyMs,
    ...(response.meta.temperature !== undefined ? { temperature: response.meta.temperature } : {}),
    ...(response.meta.seed !== undefined ? { seed: response.meta.seed } : {}),
    ...(extra['runtime'] !== undefined
      ? { providerRuntime: redactValue(extra['runtime'], `responses[${index}].providerRuntime`, redaction) }
      : {}),
    ...(extractRetryMetadata(extra) !== undefined
      ? { retryMetadata: redactValue(extractRetryMetadata(extra), `responses[${index}].retryMetadata`, redaction) }
      : {}),
  }

  if (rawOutputPolicy === 'include') {
    summary.rawOutput = response.output
  } else if (rawOutputPolicy === 'redacted') {
    summary.rawOutput = redactValue(response.output, `responses[${index}].rawOutput`, redaction) as string
  }

  return summary
}

function summariseScore(score: Score, redaction: TraceRedactionSummary): TraceScoreComponent {
  return {
    axis: score.axis,
    value: score.value,
    ...(score.rationale
      ? { rationale: redactValue(score.rationale, `scores.${score.axis}.rationale`, redaction) as string }
      : {}),
    ...(score.judge ? { judge: score.judge } : {}),
    ...(score.judgeProvenance ? { judgeProvenance: score.judgeProvenance } : {}),
    ...(score.claimStatus ? { claimStatus: score.claimStatus } : {}),
    ...(score.meta ? { meta: redactValue(score.meta, `scores.${score.axis}.meta`, redaction) } : {}),
  }
}

function extractRetryMetadata(extra: Record<string, unknown>): unknown {
  for (const key of ['retry', 'retries', 'retryMetadata', 'attempt', 'attempts']) {
    if (extra[key] !== undefined) return extra[key]
  }
  return undefined
}

function redactValue(
  value: unknown,
  path: string,
  redaction: TraceRedactionSummary,
): unknown {
  if (typeof value === 'string') {
    const redacted = redactText(value)
    if (redacted !== value) markRedacted(redaction, path)
    return redacted
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => redactValue(item, `${path}[${index}]`, redaction))
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      const childPath = `${path}.${key}`
      if (isSensitiveKey(key)) {
        out[key] = '[REDACTED]'
        markRedacted(redaction, childPath)
      } else {
        out[key] = redactValue(item, childPath, redaction)
      }
    }
    return out
  }
  return value
}

function isSensitiveKey(key: string): boolean {
  return /api[_-]?key|token|secret|password|auth|credential/i.test(key)
}

function markRedacted(redaction: TraceRedactionSummary, path: string): void {
  redaction.applied = true
  if (!redaction.redactedPaths.includes(path)) redaction.redactedPaths.push(path)
}
