import type { Dataset, RunRecord, Scenario } from './types.js'

export interface ScenarioDiagnosticsOptions {
  trainingPrompts?: string[]
}

export interface ScenarioDiagnosticsReport {
  items: Record<string, {
    passRate: number
    n: number
    outcomeType?: string
    flags: string[]
  }>
  outcomeCoverage: Record<string, number>
  flags: Array<{
    scenarioId: string
    kind: 'possible-leakage' | 'too-easy' | 'too-hard'
    detail: string
  }>
}

export interface ScenarioSetDiff {
  added: string[]
  removed: string[]
  changed: string[]
  suspiciousOverlaps: Array<{
    fromScenarioId: string
    toScenarioId: string
    reason: string
  }>
}

export function analyseScenarioItems(
  dataset: Dataset,
  record: RunRecord,
  options: ScenarioDiagnosticsOptions = {},
): ScenarioDiagnosticsReport {
  const items: ScenarioDiagnosticsReport['items'] = {}
  const flags: ScenarioDiagnosticsReport['flags'] = []
  const outcomeCoverage: Record<string, number> = {}
  const trainingPrompts = new Set((options.trainingPrompts ?? []).map(normaliseText))

  for (const scenario of dataset.scenarios) {
    const scenarioScores = record.scores.filter((score) => score.scenarioId === scenario.id)
    const passRate = scenarioScores.length === 0
      ? 0
      : scenarioScores.reduce((sum, score) => sum + score.value, 0) / scenarioScores.length
    const outcomeType = typeof scenario.meta?.['outcomeType'] === 'string'
      ? scenario.meta['outcomeType']
      : undefined
    const itemFlags: string[] = []

    if (outcomeType) outcomeCoverage[outcomeType] = (outcomeCoverage[outcomeType] ?? 0) + 1
    if (passRate === 1 && scenarioScores.length > 0) {
      itemFlags.push('too-easy')
      flags.push({
        scenarioId: scenario.id,
        kind: 'too-easy',
        detail: 'all scored responses passed this item',
      })
    }
    if (passRate === 0 && scenarioScores.length > 0) {
      itemFlags.push('too-hard')
      flags.push({
        scenarioId: scenario.id,
        kind: 'too-hard',
        detail: 'all scored responses failed this item',
      })
    }
    if (trainingPrompts.has(normaliseText(promptText(scenario)))) {
      itemFlags.push('possible-leakage')
      flags.push({
        scenarioId: scenario.id,
        kind: 'possible-leakage',
        detail: 'scenario prompt exactly matches a training prompt',
      })
    }

    items[scenario.id] = {
      passRate,
      n: scenarioScores.length,
      ...(outcomeType ? { outcomeType } : {}),
      flags: itemFlags,
    }
  }

  return { items, outcomeCoverage, flags }
}

export function compareScenarioSets(previous: Dataset, next: Dataset): ScenarioSetDiff {
  const previousById = new Map(previous.scenarios.map((scenario) => [scenario.id, scenario]))
  const nextById = new Map(next.scenarios.map((scenario) => [scenario.id, scenario]))
  const added = next.scenarios
    .filter((scenario) => !previousById.has(scenario.id))
    .map((scenario) => scenario.id)
  const removed = previous.scenarios
    .filter((scenario) => !nextById.has(scenario.id))
    .map((scenario) => scenario.id)
  const changed = next.scenarios
    .filter((scenario) => {
      const prior = previousById.get(scenario.id)
      return prior !== undefined && scenarioFingerprint(prior) !== scenarioFingerprint(scenario)
    })
    .map((scenario) => scenario.id)
  const suspiciousOverlaps: ScenarioSetDiff['suspiciousOverlaps'] = []

  for (const prior of previous.scenarios) {
    for (const current of next.scenarios) {
      if (prior.id === current.id) continue
      if (normaliseText(promptText(prior)) === normaliseText(promptText(current))) {
        suspiciousOverlaps.push({
          fromScenarioId: prior.id,
          toScenarioId: current.id,
          reason: 'identical prompt text',
        })
      }
    }
  }

  return { added, removed, changed, suspiciousOverlaps }
}

function scenarioFingerprint(scenario: Scenario): string {
  return JSON.stringify({
    input: scenario.input,
    axes: scenario.axes,
    rubric: scenario.rubric,
    meta: scenario.meta,
  })
}

function promptText(scenario: Scenario): string {
  return scenario.input.messages.map((message) => message.content).join('\n')
}

function normaliseText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}
