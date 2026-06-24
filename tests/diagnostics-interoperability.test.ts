import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

import {
  analyseScenarioItems,
  auditScenarioSet,
  compareScenarioSets,
  createMetadataFreshnessPlugin,
  formatScenarioAuditReport,
} from '../src/diagnostics.js'
import {
  exportInspectRunRecord,
  exportLmEvaluationSummary,
} from '../src/interoperability.js'
import { loadDataset } from '../src/loader.js'
import type { Dataset, RunRecord } from '../src/types.js'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const CLI = resolve(ROOT, 'src', 'cli.ts')
const ADTECH_PUBLIC_FIXTURE = resolve(
  ROOT,
  'tests',
  'fixtures',
  'diagnostics',
  'adtech-public-metadata.json',
)

async function runCli(args: string[]) {
  return execFileAsync(process.execPath, ['--import', 'tsx', CLI, ...args], { cwd: ROOT })
}

const dataset: Dataset = {
  name: 'diagnostic-fixture',
  version: '1.0.0',
  scenarios: [
    {
      id: 's1',
      axes: ['quality'],
      input: { messages: [{ role: 'user', content: 'A unique prompt' }] },
      rubric: { kind: 'programmatic', checker: 'non-empty' },
      meta: { outcomeType: 'tp', benchmarkTier: 'public', scenarioHash: 'hash:s1' },
    },
    {
      id: 's2',
      axes: ['quality'],
      input: { messages: [{ role: 'user', content: 'Another prompt' }] },
      rubric: { kind: 'programmatic', checker: 'non-empty' },
      meta: { outcomeType: 'tn', benchmarkTier: 'public', scenarioHash: 'hash:s2' },
    },
  ],
}

const record: RunRecord = {
  id: 'run-1',
  dataset: { name: 'diagnostic-fixture', version: '1.0.0' },
  runners: ['model:a', 'model:b'],
  createdAt: '2026-05-27T00:00:00.000Z',
  responses: [
    {
      runnerId: 'model:a',
      scenarioId: 's1',
      output: 'ok',
      meta: {
        provider: 'stub',
        model: 'a',
        accessedAt: '2026-05-27T00:00:00.000Z',
        latencyMs: 1,
      },
    },
  ],
  scores: [
    { runnerId: 'model:a', scenarioId: 's1', axis: 'quality', value: 1 },
    { runnerId: 'model:b', scenarioId: 's1', axis: 'quality', value: 0 },
    { runnerId: 'model:a', scenarioId: 's2', axis: 'quality', value: 1 },
    { runnerId: 'model:b', scenarioId: 's2', axis: 'quality', value: 1 },
  ],
  aggregates: [],
  meta: { harnessVersion: '0.4.0' },
}

describe('scenario diagnostics and interoperability exports', () => {
  it('reports item difficulty, outcome coverage, and leakage-like overlaps', () => {
    const report = analyseScenarioItems(dataset, record, {
      trainingPrompts: ['A unique prompt'],
    })

    expect(report.items.s1.passRate).toBe(0.5)
    expect(report.items.s2.passRate).toBe(1)
    expect(report.outcomeCoverage).toMatchObject({ tp: 1, tn: 1 })
    expect(report.flags).toContainEqual({
      scenarioId: 's1',
      kind: 'possible-leakage',
      detail: 'scenario prompt exactly matches a training prompt',
    })
  })

  it('flags near-copy leakage with token n-gram overlap, not only exact prompt matches', () => {
    const fuzzyDataset: Dataset = {
      ...dataset,
      scenarios: [
        {
          id: 'fuzzy',
          axes: ['quality'],
          input: {
            messages: [
              {
                role: 'user',
                content:
                  'Classify this auction log with publisher id pub-77, bid floor 1.25, and ivt spike evidence.',
              },
            ],
          },
          rubric: { kind: 'programmatic', checker: 'non-empty' },
        },
      ],
    }

    const report = analyseScenarioItems(fuzzyDataset, { ...record, scores: [] }, {
      leakageNgramSize: 4,
      leakageNgramThreshold: 0.5,
      trainingPrompts: [
        'Classify this auction log with publisher id pub-77, bid floor 1.25, and anomalous ivt spike evidence.',
      ],
    })

    expect(report.items.fuzzy.flags).toEqual(['possible-leakage'])
    expect(report.flags).toContainEqual(expect.objectContaining({
      scenarioId: 'fuzzy',
      kind: 'possible-leakage',
      detail: expect.stringContaining('4-gram overlap with a training prompt'),
    }))
  })

  it('compares scenario-set versions and flags changed or overlapping items', () => {
    const next: Dataset = {
      ...dataset,
      version: '1.1.0',
      scenarios: [
        dataset.scenarios[0],
        {
          ...dataset.scenarios[1],
          input: { messages: [{ role: 'user', content: 'Changed prompt' }] },
        },
        {
          id: 's3',
          axes: ['quality'],
          input: { messages: [{ role: 'user', content: 'A unique prompt' }] },
          rubric: { kind: 'programmatic', checker: 'non-empty' },
        },
      ],
    }

    const diff = compareScenarioSets(dataset, next)

    expect(diff.added).toEqual(['s3'])
    expect(diff.changed).toEqual(['s2'])
    expect(diff.suspiciousOverlaps).toEqual([
      { fromScenarioId: 's1', toScenarioId: 's3', reason: 'identical prompt text' },
    ])
  })

  it('exports run records into Inspect and lm-evaluation-harness friendly shapes', () => {
    const inspect = exportInspectRunRecord(record, dataset)
    expect(inspect.samples[0]).toMatchObject({
      id: 's1',
      input: 'A unique prompt',
      target: null,
      metadata: {
        scenarioHash: 'hash:s1',
        privacy: 'public',
      },
    })

    const summary = exportLmEvaluationSummary(record)
    expect(summary.results['diagnostic-fixture:model:a'].quality).toBe(1)
    expect(summary.versions.harness).toBe('0.4.0')
  })

  it('audits public adtech-style metadata without private answer keys', async () => {
    const publicAdtech = await loadDataset(ADTECH_PUBLIC_FIXTURE)
    const trainingPrompt = publicAdtech.scenarios[0].input.messages[0].content
    const report = auditScenarioSet(publicAdtech, {
      requiredOutcomeTypes: ['tp', 'tn', 'fp-guard', 'fn-guard'],
      requiredLanes: ['bid-floor', 'pmp', 'creative-quality'],
      trainingPrompts: [trainingPrompt],
      leakageNgramSize: 4,
      nearDuplicateNgramSize: 4,
      nearDuplicateThreshold: 0.7,
      plugins: [
        createMetadataFreshnessPlugin({
          now: '2026-03-20T00:00:00.000Z',
          severity: 'claim-blocking',
        }),
      ],
    })

    expect(report.coverage.outcomes.counts).toEqual({
      'fp-guard': 1,
      tn: 1,
      tp: 2,
    })
    expect(report.coverage.outcomes.missingRequired).toEqual(['fn-guard'])
    expect(report.coverage.lanes.counts).toEqual({ 'bid-floor': 3, pmp: 1 })
    expect(report.coverage.lanes.missingRequired).toEqual(['creative-quality'])
    expect(report.promptOverlaps.duplicates).toEqual([
      {
        scenarioIds: ['PUBLIC_ADTECH_TP_BID_FLOOR', 'PUBLIC_ADTECH_TP_BID_FLOOR_COPY'],
        prompt: expect.stringContaining('public auction summary'),
      },
    ])
    expect(report.promptOverlaps.nearDuplicates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scenarioIds: ['PUBLIC_ADTECH_TP_BID_FLOOR', 'PUBLIC_ADTECH_TN_BID_FLOOR_NEAR_COPY'],
        }),
      ]),
    )

    const kinds = report.findings.map((finding) => finding.kind)
    expect(kinds).toEqual(expect.arrayContaining([
      'duplicate-prompt',
      'near-duplicate-prompt',
      'possible-leakage',
      'weak-rubric',
      'stale-domain-fact',
    ]))
    expect(report.summary.claimBlockingKinds).toEqual(expect.arrayContaining([
      'duplicate-prompt',
      'outcome-coverage',
      'possible-leakage',
      'stale-domain-fact',
      'weak-rubric',
    ]))

    const readable = formatScenarioAuditReport(report)
    expect(readable).toContain('Scenario diagnostics: adtech-public-diagnostics-fixture v1.0.0')
    expect(readable).toContain('[claim-blocking] duplicate-prompt')
    expect(readable).toContain('[advisory] near-duplicate-prompt')
  })

  it('prints diagnostics as stable JSON and readable CLI output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assay-diagnostics-'))
    try {
      const publicAdtech = await loadDataset(ADTECH_PUBLIC_FIXTURE)
      const trainingPromptPath = join(dir, 'training-prompts.txt')
      await writeFile(
        trainingPromptPath,
        `${publicAdtech.scenarios[0].input.messages[0].content}\n`,
        'utf8',
      )

      const { stdout: jsonStdout } = await runCli([
        'diagnostics',
        ADTECH_PUBLIC_FIXTURE,
        '--json',
        '--training-prompts',
        trainingPromptPath,
        '--required-outcome',
        'tp',
        '--required-outcome',
        'tn',
        '--required-outcome',
        'fp-guard',
        '--required-outcome',
        'fn-guard',
        '--required-lane',
        'bid-floor',
        '--required-lane',
        'creative-quality',
      ])
      const jsonReport = JSON.parse(jsonStdout) as { summary: { claimBlockingCount: number } }
      expect(jsonReport.summary.claimBlockingCount).toBeGreaterThan(0)

      const { stdout: readableStdout } = await runCli([
        'diagnostics',
        ADTECH_PUBLIC_FIXTURE,
        '--required-outcome',
        'fn-guard',
        '--required-lane',
        'creative-quality',
      ])
      expect(readableStdout).toContain('Coverage')
      expect(readableStdout).toContain('missing required outcomes: fn-guard')
      expect(readableStdout).toContain('[claim-blocking] outcome-coverage')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
