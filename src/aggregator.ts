import type { AxisAggregate, ModelAggregate, Score } from './types.js'

export interface AggregatorOptions {
  /**
   * Per-axis weighting for the composite. Any axis not listed is treated as
   * weight 1. Weights are normalised so the composite is bounded [0, 1].
   */
  weights?: Record<string, number>
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
      axes[axis] = summarise(values)
    }

    const weights = normaliseWeights(Object.keys(axes), opts.weights ?? {})
    const composite = Object.entries(axes).reduce(
      (acc, [axis, agg]) => acc + (weights[axis] ?? 0) * agg.mean,
      0,
    )

    out.push({ runnerId, axes, composite, weights })
  }

  out.sort((a, b) => b.composite - a.composite)
  return out
}

function summarise(values: number[]): AxisAggregate {
  const n = values.length
  if (n === 0) return { mean: 0, variance: 0, n: 0 }
  const mean = values.reduce((a, b) => a + b, 0) / n
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n
  return { mean, variance, n }
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
