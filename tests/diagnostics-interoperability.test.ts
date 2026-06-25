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
  createGenericAdversarialMutationPlugin,
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

  it('treats blank outcome labels as missing outcome metadata', () => {
    const blankOutcomeDataset: Dataset = {
      ...dataset,
      scenarios: [
        {
          ...dataset.scenarios[0],
          meta: { ...dataset.scenarios[0].meta, outcomeType: '   ' },
        },
      ],
    }

    const report = auditScenarioSet(blankOutcomeDataset)

    expect(report.coverage.outcomes.counts).toEqual({})
    expect(report.coverage.outcomes.scenarioIdsWithoutOutcome).toEqual(['s1'])
    expect(report.findings).toContainEqual(expect.objectContaining({
      kind: 'outcome-coverage',
      severity: 'claim-blocking',
      scenarioIds: ['s1'],
    }))
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

  it('flags stale release counts, hashes, quorum, and claim state in docs against artifacts', () => {
    const expectedHash = 'a'.repeat(64)
    const report = auditScenarioSet(dataset, {
      releaseDocDriftSeverity: 'claim-blocking',
      releaseArtifacts: [
        {
          id: 'release-contract.json',
          data: {
            scenarioSetHash: expectedHash,
            scenarioSetHashMetadata: { scenarioCount: 2 },
            quorum: { required: 2, total: 3 },
            claimGate: { status: 'allowed' },
          },
        },
      ],
      releaseDocuments: [
        {
          id: 'README.md',
          content:
            'The release has 3 scenarios, scenario-set hash ' +
            `${'b'.repeat(64)}, frontier quorum 1/3, and claim gate blocked.`,
        },
      ],
    })

    const driftFindings = report.findings.filter((finding) => finding.kind === 'artifact-doc-drift')
    expect(driftFindings.map((finding) => finding.data?.['field'])).toEqual(
      expect.arrayContaining(['scenarioCount', 'scenarioSetHash', 'quorum', 'claimState']),
    )
    expect(report.summary.claimBlockingKinds).toContain('artifact-doc-drift')
  })

  it('flags conflicting rubric gates as claim-blocking diagnostics', () => {
    const conflictingDataset: Dataset = {
      ...dataset,
      scenarios: [
        {
          id: 'conflict',
          axes: ['quality'],
          input: {
            messages: [
              {
                role: 'user',
                content: 'Explain whether the supplied evidence supports the requested decision.',
              },
            ],
          },
          rubric: {
            kind: 'programmatic',
            checker: 'keyword',
            params: {
              expected: ['cite the source'],
              forbidden: ['cite the source'],
            },
          },
          meta: { outcomeType: 'tp' },
        },
      ],
    }

    const report = auditScenarioSet(conflictingDataset)

    expect(report.findings).toContainEqual(expect.objectContaining({
      kind: 'conflicting-rubric-gates',
      severity: 'claim-blocking',
      scenarioIds: ['conflict'],
      detail: expect.stringContaining('requires and forbids'),
    }))
  })

  it('flags weak and ambiguous rubrics with configurable claim impact', () => {
    const weakAndAmbiguousDataset: Dataset = {
      ...dataset,
      scenarios: [
        {
          id: 'weak',
          axes: ['quality'],
          input: {
            messages: [
              {
                role: 'user',
                content: 'Evaluate the evidence and provide the supported conclusion.',
              },
            ],
          },
          rubric: { kind: 'programmatic', checker: 'non-empty' },
          meta: { outcomeType: 'tp' },
        },
        {
          id: 'ambiguous',
          axes: ['quality'],
          input: {
            messages: [
              {
                role: 'user',
                content: 'Assess the evidence and choose the most justified action.',
              },
            ],
          },
          rubric: {
            kind: 'mechanism',
            quantitative: [],
            disambiguation: [],
            actions: [],
            bingoTokens: [],
          },
          meta: { outcomeType: 'tn' },
        },
      ],
    }

    const report = auditScenarioSet(weakAndAmbiguousDataset, {
      rubricAmbiguitySeverity: 'claim-blocking',
    })

    expect(report.findings).toContainEqual(expect.objectContaining({
      kind: 'weak-rubric',
      severity: 'claim-blocking',
      scenarioIds: ['weak'],
    }))
    expect(report.findings).toContainEqual(expect.objectContaining({
      kind: 'rubric-ambiguity',
      severity: 'claim-blocking',
      scenarioIds: ['ambiguous'],
    }))
  })

  it('generates corpus-agnostic adversarial mutation probes through the plugin API', () => {
    const report = auditScenarioSet(dataset, {
      plugins: [createGenericAdversarialMutationPlugin({ maxProbesPerScenario: 2 })],
    })

    expect(report.adversarial.probes).toHaveLength(4)
    expect(report.adversarial.probes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        scenarioId: 's1',
        mutationKind: 'instruction-override',
        prompt: expect.stringContaining('A unique prompt'),
        expectedInvariant: expect.stringContaining('original task'),
      }),
      expect.objectContaining({
        scenarioId: 's2',
        mutationKind: 'irrelevant-distractor',
        prompt: expect.stringContaining('Another prompt'),
      }),
    ]))
    expect(report.findings).toContainEqual(expect.objectContaining({
      kind: 'adversarial-mutation-probe',
      severity: 'advisory',
      scenarioIds: ['s1'],
    }))
  })

  it('lets the CLI fail on configured doc drift and rubric ambiguity', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assay-diagnostics-claim-blocking-'))
    try {
      const datasetPath = join(dir, 'dataset.json')
      const artifactPath = join(dir, 'release-contract.json')
      const docPath = join(dir, 'README.md')
      await writeFile(
        datasetPath,
        JSON.stringify({
          name: 'cli-drift-fixture',
          version: '1.0.0',
          scenarios: [
            {
              id: 'ambiguous',
              axes: ['quality'],
              input: {
                messages: [
                  {
                    role: 'user',
                    content: 'Assess the evidence and choose the most justified action.',
                  },
                ],
              },
              rubric: {
                kind: 'mechanism',
                quantitative: [],
                disambiguation: [],
                actions: [],
                bingoTokens: [],
              },
              meta: { outcomeType: 'tp' },
            },
          ],
        }),
        'utf8',
      )
      await writeFile(
        artifactPath,
        JSON.stringify({
          scenarioSetHash: 'a'.repeat(64),
          scenarioSetHashMetadata: { scenarioCount: 1 },
          claimGate: { status: 'allowed' },
        }),
        'utf8',
      )
      await writeFile(
        docPath,
        `Release says 2 scenarios and scenario-set hash ${'b'.repeat(64)} with claim gate blocked.`,
        'utf8',
      )

      await expect(runCli([
        'diagnostics',
        datasetPath,
        '--release-doc',
        docPath,
        '--release-artifact',
        artifactPath,
        '--claim-block-doc-drift',
        '--claim-block-rubric-ambiguity',
        '--fail-on-claim-blocking',
      ])).rejects.toMatchObject({
        stdout: expect.stringContaining('artifact-doc-drift'),
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
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
