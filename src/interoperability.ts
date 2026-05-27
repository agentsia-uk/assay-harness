import type { Dataset, RunRecord, Scenario } from './types.js'

export interface InspectExport {
  runId: string
  dataset: RunRecord['dataset']
  samples: Array<{
    id: string
    input: string
    target: null
    metadata: {
      scenarioHash?: string
      privacy: string
      axes: string[]
    }
  }>
}

export interface LmEvaluationSummary {
  results: Record<string, Record<string, number>>
  versions: {
    harness: string
    dataset: string
  }
}

export function exportInspectRunRecord(record: RunRecord, dataset: Dataset): InspectExport {
  return {
    runId: record.id,
    dataset: record.dataset,
    samples: dataset.scenarios.map((scenario) => ({
      id: scenario.id,
      input: promptText(scenario),
      target: null,
      metadata: {
        ...(typeof scenario.meta?.['scenarioHash'] === 'string'
          ? { scenarioHash: scenario.meta['scenarioHash'] }
          : {}),
        privacy: privacyForScenario(scenario),
        axes: scenario.axes,
      },
    })),
  }
}

export function exportLmEvaluationSummary(record: RunRecord): LmEvaluationSummary {
  const grouped = new Map<string, Map<string, number[]>>()
  for (const score of record.scores) {
    const taskKey = `${record.dataset.name}:${score.runnerId}`
    const byAxis = grouped.get(taskKey) ?? new Map<string, number[]>()
    const bucket = byAxis.get(score.axis) ?? []
    bucket.push(score.value)
    byAxis.set(score.axis, bucket)
    grouped.set(taskKey, byAxis)
  }

  const results: LmEvaluationSummary['results'] = {}
  for (const [taskKey, byAxis] of grouped) {
    results[taskKey] = {}
    for (const [axis, values] of byAxis) {
      results[taskKey][axis] = values.reduce((sum, value) => sum + value, 0) / values.length
    }
  }

  return {
    results,
    versions: {
      harness: record.meta.harnessVersion,
      dataset: record.dataset.version,
    },
  }
}

function promptText(scenario: Scenario): string {
  return scenario.input.messages.map((message) => message.content).join('\n')
}

function privacyForScenario(scenario: Scenario): string {
  const tier = scenario.meta?.['benchmarkTier']
  return tier === 'private' || tier === 'holdout' ? 'private' : 'public'
}
