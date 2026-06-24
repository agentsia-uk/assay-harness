import { comparePairedScores } from './aggregator.js'
import type { BootstrapOptions } from './aggregator.js'
import type { ConfidenceInterval, RunRecord, Score } from './types.js'

export interface ScenarioComparison {
  scenarioId: string
  score1: number | null
  score2: number | null
  delta: number | null
  direction: 'improvement' | 'regression' | 'unchanged' | 'missing'
}

export interface CompareOptions {
  iterations?: number
  confidenceLevel?: number
  seed?: number
}

export type ScenarioSetHashStatus = 'match' | 'mismatch' | 'missing'

export interface CompareIntervalMetadata {
  method: 'paired-bootstrap'
  status: 'available' | 'unavailable'
  confidenceInterval: ConfidenceInterval | null
  promotionClaimSupported: boolean
  descriptiveOnly: boolean
  reason: string | null
  warnings: string[]
  pairedScenarioCount: number
  totalScenarioCount: number
  missingFromRun1: string[]
  missingFromRun2: string[]
  missingScoreKeysFromRun1: string[]
  missingScoreKeysFromRun2: string[]
  scenarioSetHash: {
    run1: string | null
    run2: string | null
    status: ScenarioSetHashStatus
  }
}

export interface CompareResult {
  run1Id: string
  run2Id: string
  run1Runners: string[]
  run2Runners: string[]
  rows: ScenarioComparison[]
  compositeDelta: number | null
  interval: CompareIntervalMetadata
}

const DEFAULT_CONFIDENCE: BootstrapOptions = {
  method: 'bootstrap',
  iterations: 1000,
  confidenceLevel: 0.95,
  seed: 1,
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

export function compareRuns(
  run1: RunRecord,
  run2: RunRecord,
  opts: CompareOptions = {},
): CompareResult {
  if (run1.runners.length > 1) {
    throw new Error(
      `compareRuns: run1 (${run1.id}) contains multiple runners [${run1.runners.join(', ')}]. ` +
        'Filter to a single runner before comparing.',
    )
  }
  if (run2.runners.length > 1) {
    throw new Error(
      `compareRuns: run2 (${run2.id}) contains multiple runners [${run2.runners.join(', ')}]. ` +
        'Filter to a single runner before comparing.',
    )
  }
  const map1 = meanByScenario(run1.scores)
  const map2 = meanByScenario(run2.scores)
  const allIds = [...new Set([...map1.keys(), ...map2.keys()])].sort()
  const missingFromRun1 = [...map2.keys()].filter((id) => !map1.has(id)).sort()
  const missingFromRun2 = [...map1.keys()].filter((id) => !map2.has(id)).sort()
  const scoreKeyMismatch = compareScoreKeyCounts(run1.scores, run2.scores)

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
  const confidence: BootstrapOptions = {
    ...DEFAULT_CONFIDENCE,
    iterations: opts.iterations ?? DEFAULT_CONFIDENCE.iterations,
    confidenceLevel: opts.confidenceLevel ?? DEFAULT_CONFIDENCE.confidenceLevel,
    seed: opts.seed ?? DEFAULT_CONFIDENCE.seed,
  }
  const interval = buildIntervalMetadata({
    run1,
    run2,
    rows,
    missingFromRun1,
    missingFromRun2,
    missingScoreKeysFromRun1: scoreKeyMismatch.missingFromRun1,
    missingScoreKeysFromRun2: scoreKeyMismatch.missingFromRun2,
    confidence,
  })

  return {
    run1Id: run1.id,
    run2Id: run2.id,
    run1Runners: run1.runners,
    run2Runners: run2.runners,
    rows,
    compositeDelta,
    interval,
  }
}

function buildIntervalMetadata(args: {
  run1: RunRecord
  run2: RunRecord
  rows: ScenarioComparison[]
  missingFromRun1: string[]
  missingFromRun2: string[]
  missingScoreKeysFromRun1: string[]
  missingScoreKeysFromRun2: string[]
  confidence: BootstrapOptions
}): CompareIntervalMetadata {
  const {
    run1,
    run2,
    rows,
    missingFromRun1,
    missingFromRun2,
    missingScoreKeysFromRun1,
    missingScoreKeysFromRun2,
    confidence,
  } = args
  const hashStatus = scenarioSetHashStatus(run1.scenarioSetHash, run2.scenarioSetHash)
  const warnings: string[] = []
  if (hashStatus === 'mismatch') {
    warnings.push(
      `scenario-set hashes differ: run1=${run1.scenarioSetHash} run2=${run2.scenarioSetHash}; ` +
        'paired-bootstrap interval withheld',
    )
  } else if (hashStatus === 'missing') {
    warnings.push(
      'scenario-set hash missing from one or both runs; paired-bootstrap interval withheld',
    )
  }

  if (missingFromRun1.length > 0 || missingFromRun2.length > 0) {
    warnings.push(
      `paired comparison incomplete: ${missingFromRun1.length} scenario(s) missing from run1, ` +
      `${missingFromRun2.length} scenario(s) missing from run2; paired-bootstrap interval withheld`,
    )
  }
  if (missingScoreKeysFromRun1.length > 0 || missingScoreKeysFromRun2.length > 0) {
    warnings.push(
      `paired comparison score keys differ: ${missingScoreKeysFromRun1.length} key(s) missing from run1, ` +
        `${missingScoreKeysFromRun2.length} key(s) missing from run2; paired-bootstrap interval withheld`,
    )
  }
  warnings.push(...validateBootstrapOptions(confidence))

  const pairedScenarioCount = rows.filter((row) => row.delta !== null).length
  const canUseInterval =
    hashStatus === 'match' &&
    missingFromRun1.length === 0 &&
    missingFromRun2.length === 0 &&
    missingScoreKeysFromRun1.length === 0 &&
    missingScoreKeysFromRun2.length === 0 &&
    validateBootstrapOptions(confidence).length === 0 &&
    pairedScenarioCount > 0

  if (!canUseInterval) {
    return {
      method: 'paired-bootstrap',
      status: 'unavailable',
      confidenceInterval: null,
      promotionClaimSupported: false,
      descriptiveOnly: true,
      reason: warnings[0] ?? 'paired-bootstrap interval requires a matched scenario set',
      warnings,
      pairedScenarioCount,
      totalScenarioCount: rows.length,
      missingFromRun1,
      missingFromRun2,
      missingScoreKeysFromRun1,
      missingScoreKeysFromRun2,
      scenarioSetHash: {
        run1: run1.scenarioSetHash ?? null,
        run2: run2.scenarioSetHash ?? null,
        status: hashStatus,
      },
    }
  }

  const comparison = comparePairedScores(
    [
      ...run1.scores.map((score) => ({ ...score, runnerId: '__compare_run1__' })),
      ...run2.scores.map((score) => ({ ...score, runnerId: '__compare_run2__' })),
    ],
    {
      baselineRunnerId: '__compare_run1__',
      candidateRunnerId: '__compare_run2__',
      iterations: confidence.iterations,
      confidenceLevel: confidence.confidenceLevel,
      seed: confidence.seed,
    },
  )

  return {
    method: 'paired-bootstrap',
    status: 'available',
    confidenceInterval: comparison.confidenceInterval,
    promotionClaimSupported: true,
    descriptiveOnly: false,
    reason: null,
    warnings,
    pairedScenarioCount,
    totalScenarioCount: rows.length,
    missingFromRun1,
    missingFromRun2,
    missingScoreKeysFromRun1,
    missingScoreKeysFromRun2,
    scenarioSetHash: {
      run1: run1.scenarioSetHash ?? null,
      run2: run2.scenarioSetHash ?? null,
      status: hashStatus,
    },
  }
}

function compareScoreKeyCounts(
  run1Scores: Score[],
  run2Scores: Score[],
): { missingFromRun1: string[], missingFromRun2: string[] } {
  const run1Counts = scoreKeyCounts(run1Scores)
  const run2Counts = scoreKeyCounts(run2Scores)
  const allKeys = [...new Set([...run1Counts.keys(), ...run2Counts.keys()])].sort()
  const missingFromRun1: string[] = []
  const missingFromRun2: string[] = []
  for (const key of allKeys) {
    const count1 = run1Counts.get(key) ?? 0
    const count2 = run2Counts.get(key) ?? 0
    if (count1 < count2) {
      missingFromRun1.push(`${key} (run1=${count1}, run2=${count2})`)
    } else if (count2 < count1) {
      missingFromRun2.push(`${key} (run1=${count1}, run2=${count2})`)
    }
  }
  return { missingFromRun1, missingFromRun2 }
}

function scoreKeyCounts(scores: Score[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const score of scores) {
    const key = `${score.scenarioId}/${score.axis}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

function validateBootstrapOptions(confidence: BootstrapOptions): string[] {
  const warnings: string[] = []
  if (!Number.isInteger(confidence.iterations) || confidence.iterations < 1) {
    warnings.push(
      `invalid paired-bootstrap iterations ${JSON.stringify(confidence.iterations)}; ` +
        'paired-bootstrap interval withheld',
    )
  }
  if (
    !Number.isFinite(confidence.confidenceLevel) ||
    confidence.confidenceLevel <= 0 ||
    confidence.confidenceLevel >= 1
  ) {
    warnings.push(
      `invalid paired-bootstrap confidence level ${JSON.stringify(confidence.confidenceLevel)}; ` +
        'expected a finite value greater than 0 and less than 1; paired-bootstrap interval withheld',
    )
  }
  if (!Number.isInteger(confidence.seed)) {
    warnings.push(
      `invalid paired-bootstrap seed ${JSON.stringify(confidence.seed)}; ` +
        'paired-bootstrap interval withheld',
    )
  }
  return warnings
}

function scenarioSetHashStatus(
  run1Hash: string | undefined,
  run2Hash: string | undefined,
): ScenarioSetHashStatus {
  if (!run1Hash || !run2Hash) return 'missing'
  return run1Hash === run2Hash ? 'match' : 'mismatch'
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
  if (result.interval.status === 'available' && result.interval.confidenceInterval) {
    const ci = result.interval.confidenceInterval
    lines.push(
      `paired-bootstrap ${Math.round(ci.confidenceLevel * 100)}% CI: ` +
        `[${ci.lower >= 0 ? '+' : ''}${ci.lower.toFixed(4)}, ` +
        `${ci.upper >= 0 ? '+' : ''}${ci.upper.toFixed(4)}] ` +
        `(n=${ci.n}, iterations=${ci.iterations}, seed=${ci.seed})`,
    )
  } else {
    lines.push(
      'paired-bootstrap interval unavailable; non-interval deltas are descriptive, not promotion claims.',
    )
  }
  for (const warning of result.interval.warnings) {
    lines.push(`warning: ${warning}`)
  }

  return lines.join('\n')
}
