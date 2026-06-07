import type { RunRecord, Score } from './types.js'

export interface ScenarioComparison {
  scenarioId: string
  score1: number | null
  score2: number | null
  delta: number | null
  direction: 'improvement' | 'regression' | 'unchanged' | 'missing'
}

export interface CompareResult {
  run1Id: string
  run2Id: string
  run1Runners: string[]
  run2Runners: string[]
  rows: ScenarioComparison[]
  compositeDelta: number | null
}

function meanByScenario(scores: Score[]): Map<string, number> {
  const acc = new Map<string, number[]>()
  for (const s of scores) {
    const bucket = acc.get(s.scenarioId) ?? []
    bucket.push(s.value)
    acc.set(s.scenarioId, bucket)
  }
  return new Map(
    [...acc.entries()].map(([id, vals]) => [id, vals.reduce((a, b) => a + b, 0) / vals.length]),
  )
}

export function compareRuns(run1: RunRecord, run2: RunRecord): CompareResult {
  const map1 = meanByScenario(run1.scores)
  const map2 = meanByScenario(run2.scores)
  const allIds = [...new Set([...map1.keys(), ...map2.keys()])].sort()

  const rows: ScenarioComparison[] = allIds.map((id) => {
    const s1 = map1.get(id) ?? null
    const s2 = map2.get(id) ?? null
    const delta = s1 !== null && s2 !== null ? s2 - s1 : null
    let direction: ScenarioComparison['direction'] = 'missing'
    if (delta !== null) {
      if (delta > 0.001) direction = 'improvement'
      else if (delta < -0.001) direction = 'regression'
      else direction = 'unchanged'
    }
    return { scenarioId: id, score1: s1, score2: s2, delta, direction }
  })

  const paired = rows.filter((r) => r.delta !== null)
  const compositeDelta =
    paired.length > 0
      ? paired.reduce((a, r) => a + (r.delta ?? 0), 0) / paired.length
      : null

  return {
    run1Id: run1.id,
    run2Id: run2.id,
    run1Runners: run1.runners,
    run2Runners: run2.runners,
    rows,
    compositeDelta,
  }
}

const DIRECTION_SYMBOL: Record<ScenarioComparison['direction'], string> = {
  improvement: '+',
  regression: '-',
  unchanged: '=',
  missing: '?',
}

export function formatCompareTable(result: CompareResult): string {
  const col1 = Math.max(
    'scenario'.length,
    ...result.rows.map((r) => r.scenarioId.length),
  )
  const COL_N = 8

  const header = [
    'scenario'.padEnd(col1),
    'run1'.padStart(COL_N),
    'run2'.padStart(COL_N),
    'delta'.padStart(COL_N),
    '',
  ].join('  ')

  const sep = '-'.repeat(header.length)

  const lines: string[] = [
    `run1: ${result.run1Id}  (${result.run1Runners.join(', ')})`,
    `run2: ${result.run2Id}  (${result.run2Runners.join(', ')})`,
    '',
    header,
    sep,
  ]

  for (const row of result.rows) {
    const s1 = row.score1 !== null ? row.score1.toFixed(4) : '  n/a  '
    const s2 = row.score2 !== null ? row.score2.toFixed(4) : '  n/a  '
    const d = row.delta !== null ? (row.delta >= 0 ? `+${row.delta.toFixed(4)}` : row.delta.toFixed(4)) : '  n/a  '
    const sym = DIRECTION_SYMBOL[row.direction]
    lines.push(
      [
        row.scenarioId.padEnd(col1),
        s1.padStart(COL_N),
        s2.padStart(COL_N),
        d.padStart(COL_N),
        ` ${sym}`,
      ].join('  '),
    )
  }

  lines.push(sep)
  if (result.compositeDelta !== null) {
    const d = result.compositeDelta
    lines.push(
      `composite delta: ${d >= 0 ? '+' : ''}${d.toFixed(4)}  (mean across ${result.rows.filter((r) => r.delta !== null).length} paired scenarios)`,
    )
  }

  return lines.join('\n')
}
