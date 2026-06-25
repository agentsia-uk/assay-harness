import type {
  AxisAggregate,
  ConfidenceInterval,
  ModelAggregate,
  ModelResponse,
  OperationalMetrics,
  PairedComparison,
  ReliabilityMetrics,
  Score,
  SliceAggregate,
} from './types.js'

export interface AggregatorOptions {
  /**
   * Per-axis weighting for the composite. Any axis not listed is treated as
   * weight 1. Weights are normalised so the composite is bounded [0, 1].
   */
  weights?: Record<string, number>
  confidence?: BootstrapOptions
  responses?: ModelResponse[]
  sliceMetadataByScenario?: Record<string, Record<string, unknown>>
  reliability?: {
    passThreshold?: number
  }
}

export interface BootstrapOptions {
  method: 'bootstrap'
  iterations: number
  confidenceLevel: number
  seed: number
}

export interface PairedComparisonOptions {
  baselineRunnerId: string
  candidateRunnerId: string
  iterations: number
  confidenceLevel: number
  seed: number
}

/**
 * Aggregate a flat list of Scores into one ModelAggregate per runner.
 */
export function aggregate(scores: Score[], opts: AggregatorOptions = {}): ModelAggregate[] {
  const byRunner = new Map<string, Score[]>()
  for (const s of scores) {
    const bucket = byRunner.get(s.runnerId) ?? []
    bucket.push(s)
    byRunner.set(s.runnerId, bucket)
  }

  const out: ModelAggregate[] = []
  for (const [runnerId, runnerScores] of byRunner) {
    const axes = summariseAxes(runnerScores, opts.confidence)

    const weights = normaliseWeights(Object.keys(axes), opts.weights ?? {})
    const composite = Object.entries(axes).reduce(
      (acc, [axis, agg]) => acc + (weights[axis] ?? 0) * agg.mean,
      0,
    )
    const passThreshold = opts.reliability?.passThreshold ?? 0.5
    const runnerResponses = opts.responses?.filter((response) => response.runnerId === runnerId)

    out.push({
      runnerId,
      axes,
      composite,
      weights,
      reliability: summariseReliability(runnerScores, passThreshold),
      ...(opts.responses
        ? { operational: summariseOperational(runnerResponses ?? []) }
        : {}),
      ...(opts.sliceMetadataByScenario
        ? {
            slices: summariseSlices(
              runnerScores,
              weights,
              passThreshold,
              opts.confidence,
              opts.sliceMetadataByScenario,
            ),
          }
        : {}),
      ...(opts.confidence
        ? {
            statisticalClaims: {
              method: opts.confidence.method,
              confidenceLevel: opts.confidence.confidenceLevel,
              iterations: opts.confidence.iterations,
              seed: opts.confidence.seed,
              sampleUnit: 'score' as const,
            },
          }
        : {}),
    })
  }

  out.sort((a, b) => b.composite - a.composite)
  return out
}

function summariseAxes(
  scores: Score[],
  confidence?: BootstrapOptions,
): Record<string, AxisAggregate> {
  const byAxis = new Map<string, number[]>()
  for (const s of scores) {
    const bucket = byAxis.get(s.axis) ?? []
    bucket.push(s.value)
    byAxis.set(s.axis, bucket)
  }

  const axes: Record<string, AxisAggregate> = {}
  for (const [axis, values] of byAxis) {
    axes[axis] = summarise(values, confidence)
  }
  return axes
}

function summarise(values: number[], confidence?: BootstrapOptions): AxisAggregate {
  const n = values.length
  if (n === 0) return { mean: 0, variance: 0, n: 0 }
  const mean = values.reduce((a, b) => a + b, 0) / n
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n
  return {
    mean,
    variance,
    n,
    ...(confidence
      ? { confidenceInterval: bootstrapMeanInterval(values, confidence) }
      : {}),
  }
}

function normaliseWeights(
  axes: string[],
  requested: Record<string, number>,
): Record<string, number> {
  const raw: Record<string, number> = {}
  for (const a of axes) raw[a] = requested[a] ?? 1
  const total = Object.values(raw).reduce((x, y) => x + y, 0)
  if (total === 0) return raw
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(raw)) out[k] = v / total
  return out
}

function summariseReliability(scores: Score[], passThreshold: number): ReliabilityMetrics {
  const byScenarioAxis = new Map<string, number[]>()
  for (const score of scores) {
    const key = `${score.scenarioId}/${score.axis}`
    const bucket = byScenarioAxis.get(key) ?? []
    bucket.push(score.value)
    byScenarioAxis.set(key, bucket)
  }

  const groups = [...byScenarioAxis.values()]
  const evaluatedScenarioCount = groups.length
  if (evaluatedScenarioCount === 0) {
    return {
      passThreshold,
      passAtK: 0,
      passPowerK: 0,
      meanSamplesPerScenario: 0,
      repeatedScenarioCount: 0,
      evaluatedScenarioCount: 0,
      sampleCount: 0,
    }
  }

  const passAtK = groups.filter((values) => values.some((value) => value >= passThreshold)).length /
    evaluatedScenarioCount
  const passPowerK = groups.filter((values) => values.every((value) => value >= passThreshold)).length /
    evaluatedScenarioCount
  const sampleCount = groups.reduce((acc, values) => acc + values.length, 0)

  return {
    passThreshold,
    passAtK,
    passPowerK,
    meanSamplesPerScenario: sampleCount / evaluatedScenarioCount,
    repeatedScenarioCount: groups.filter((values) => values.length > 1).length,
    evaluatedScenarioCount,
    sampleCount,
  }
}

function summariseOperational(responses: ModelResponse[]): OperationalMetrics {
  const latencies = responses
    .map((response) => response.meta.latencyMs)
    .filter((value): value is number => Number.isFinite(value))
    .sort((a, b) => a - b)
  let totalPromptTokens = 0
  let totalCompletionTokens = 0
  let totalTokens = 0
  let totalCostUsd = 0
  let tokenResponseCount = 0
  let costResponseCount = 0
  let refusalResponseCount = 0
  let refusalCount = 0

  for (const response of responses) {
    const extra = response.meta.extra ?? {}
    const promptTokens = firstFiniteNumber(extra, ['promptTokens', 'inputTokens'])
    const completionTokens = firstFiniteNumber(extra, ['completionTokens', 'outputTokens'])
    const explicitTotalTokens = firstFiniteNumber(extra, ['totalTokens'])
    const responseTotalTokens =
      explicitTotalTokens ?? (
        promptTokens !== null || completionTokens !== null
          ? (promptTokens ?? 0) + (completionTokens ?? 0)
          : null
      )
    if (promptTokens !== null || completionTokens !== null || responseTotalTokens !== null) {
      totalPromptTokens += promptTokens ?? 0
      totalCompletionTokens += completionTokens ?? 0
      totalTokens += responseTotalTokens ?? 0
      tokenResponseCount += 1
    }

    const costUsd = firstFiniteNumber(extra, ['costUsd', 'totalCostUsd'])
    if (costUsd !== null) {
      totalCostUsd += costUsd
      costResponseCount += 1
    }

    const refused = detectRefusal(response)
    if (refused !== null) {
      refusalResponseCount += 1
      if (refused) refusalCount += 1
    }
  }

  return {
    responseCount: responses.length,
    meanLatencyMs: latencies.length > 0 ? mean(latencies) : null,
    p50LatencyMs: latencies.length > 0 ? percentile(latencies, 0.5) : null,
    p95LatencyMs: latencies.length > 0 ? percentile(latencies, 0.95) : null,
    refusalRate: refusalResponseCount > 0 ? refusalCount / refusalResponseCount : null,
    totalPromptTokens: tokenResponseCount > 0 ? totalPromptTokens : null,
    totalCompletionTokens: tokenResponseCount > 0 ? totalCompletionTokens : null,
    totalTokens: tokenResponseCount > 0 ? totalTokens : null,
    totalCostUsd: costResponseCount > 0 ? totalCostUsd : null,
    missingMetadata: {
      latency: responses.length - latencies.length,
      tokenCount: responses.length - tokenResponseCount,
      cost: responses.length - costResponseCount,
      refusal: responses.length - refusalResponseCount,
    },
  }
}

function summariseSlices(
  scores: Score[],
  weights: Record<string, number>,
  passThreshold: number,
  confidence: BootstrapOptions | undefined,
  sliceMetadataByScenario: Record<string, Record<string, unknown>>,
): Record<string, SliceAggregate> {
  const bySlice = new Map<string, Score[]>()
  for (const score of scores) {
    for (const slice of sliceLabels(score, sliceMetadataByScenario)) {
      const bucket = bySlice.get(slice) ?? []
      bucket.push(score)
      bySlice.set(slice, bucket)
    }
  }

  return Object.fromEntries(
    [...bySlice.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([slice, sliceScores]) => {
        const axes = summariseAxes(sliceScores, confidence)
        const composite = Object.entries(axes).reduce(
          (acc, [axis, agg]) => acc + (weights[axis] ?? 0) * agg.mean,
          0,
        )
        return [
          slice,
          {
            axes,
            composite,
            n: sliceScores.length,
            reliability: summariseReliability(sliceScores, passThreshold),
          },
        ]
      }),
  )
}

function sliceLabels(
  score: Score,
  sliceMetadataByScenario: Record<string, Record<string, unknown>>,
): string[] {
  const metadata = {
    ...(sliceMetadataByScenario[score.scenarioId] ?? {}),
    ...(score.meta?.slices ?? {}),
  }
  const labels: string[] = []
  for (const [dimension, value] of Object.entries(metadata)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      labels.push(`${dimension}=${String(value)}`)
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (
          typeof item === 'string' ||
          typeof item === 'number' ||
          typeof item === 'boolean'
        ) {
          labels.push(`${dimension}=${String(item)}`)
        }
      }
    }
  }
  return labels.length > 0 ? labels.sort() : ['__unsliced__']
}

function firstFiniteNumber(
  obj: Record<string, unknown>,
  keys: string[],
): number | null {
  for (const key of keys) {
    const value = obj[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

function detectRefusal(response: ModelResponse): boolean | null {
  const extra = response.meta.extra ?? {}
  if (typeof extra['refusal'] === 'boolean') return extra['refusal']
  const reason = extra['finishReason'] ?? extra['stopReason']
  if (typeof reason === 'string') {
    const normalized = reason.toLowerCase()
    if (normalized.includes('refusal') || normalized.includes('content_filter')) {
      return true
    }
  }
  return false
}

export function comparePairedScores(
  scores: Score[],
  opts: PairedComparisonOptions,
): PairedComparison {
  const baseline = valuesByScenario(scores, opts.baselineRunnerId)
  const candidate = valuesByScenario(scores, opts.candidateRunnerId)
  const scenarioIds = [...baseline.keys()].filter((id) => candidate.has(id)).sort()
  if (scenarioIds.length === 0) {
    throw new Error('paired comparison requires at least one shared scenario')
  }
  const deltas = scenarioIds.map((id) => (candidate.get(id) ?? 0) - (baseline.get(id) ?? 0))
  const delta = mean(deltas)
  const interval = bootstrapMeanInterval(deltas, {
    method: 'bootstrap',
    iterations: opts.iterations,
    confidenceLevel: opts.confidenceLevel,
    seed: opts.seed,
  })
  return {
    baselineRunnerId: opts.baselineRunnerId,
    candidateRunnerId: opts.candidateRunnerId,
    delta,
    n: deltas.length,
    confidenceInterval: {
      ...interval,
      method: 'paired-bootstrap',
    },
  }
}

function valuesByScenario(scores: Score[], runnerId: string): Map<string, number> {
  const grouped = new Map<string, number[]>()
  for (const score of scores) {
    if (score.runnerId !== runnerId) continue
    const bucket = grouped.get(score.scenarioId) ?? []
    bucket.push(score.value)
    grouped.set(score.scenarioId, bucket)
  }
  return new Map([...grouped.entries()].map(([scenarioId, values]) => [scenarioId, mean(values)]))
}

function bootstrapMeanInterval(
  values: number[],
  opts: BootstrapOptions,
): ConfidenceInterval {
  if (values.length === 0) {
    return {
      method: opts.method,
      lower: 0,
      upper: 0,
      confidenceLevel: opts.confidenceLevel,
      iterations: opts.iterations,
      seed: opts.seed,
      n: 0,
    }
  }
  const random = seededRandom(opts.seed)
  const samples: number[] = []
  for (let i = 0; i < opts.iterations; i += 1) {
    let total = 0
    for (let j = 0; j < values.length; j += 1) {
      total += values[Math.floor(random() * values.length)] ?? 0
    }
    samples.push(total / values.length)
  }
  samples.sort((a, b) => a - b)
  const alpha = 1 - opts.confidenceLevel
  return {
    method: opts.method,
    lower: percentile(samples, alpha / 2),
    upper: percentile(samples, 1 - alpha / 2),
    confidenceLevel: opts.confidenceLevel,
    iterations: opts.iterations,
    seed: opts.seed,
    n: values.length,
  }
}

function percentile(sorted: number[], p: number): number {
  const clamped = Math.min(1, Math.max(0, p))
  const index = Math.round(clamped * (sorted.length - 1))
  return sorted[index] ?? 0
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (1664525 * state + 1013904223) >>> 0
    return state / 0x100000000
  }
}
