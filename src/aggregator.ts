import type {
  AxisAggregate,
  ConfidenceInterval,
  ModelAggregate,
  PairedComparison,
  Score,
} from './types.js'

export interface AggregatorOptions {
  /**
   * Per-axis weighting for the composite. Any axis not listed is treated as
   * weight 1. Weights are normalised so the composite is bounded [0, 1].
   */
  weights?: Record<string, number>
  confidence?: BootstrapOptions
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
    const byAxis = new Map<string, number[]>()
    for (const s of runnerScores) {
      const bucket = byAxis.get(s.axis) ?? []
      bucket.push(s.value)
      byAxis.set(s.axis, bucket)
    }

    const axes: Record<string, AxisAggregate> = {}
    for (const [axis, values] of byAxis) {
      axes[axis] = summarise(values, opts.confidence)
    }

    const weights = normaliseWeights(Object.keys(axes), opts.weights ?? {})
    const composite = Object.entries(axes).reduce(
      (acc, [axis, agg]) => acc + (weights[axis] ?? 0) * agg.mean,
      0,
    )

    out.push({
      runnerId,
      axes,
      composite,
      weights,
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
