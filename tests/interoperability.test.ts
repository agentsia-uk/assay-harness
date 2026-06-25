import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

import {
  EXPERIMENT_STORE_SCHEMA_VERSION,
  GITHUB_ANNOTATIONS_SCHEMA_VERSION,
  JUNIT_EXPORT_SCHEMA_VERSION,
  PORTABLE_RUN_EXPORT_SCHEMA_VERSION,
  RESULT_JSONL_SCHEMA_VERSION,
  exportExperimentStoreRecords,
  exportGitHubActionsAnnotations,
  exportInspectRunRecord,
  exportJUnitXml,
  exportPortableRunRecord,
  exportResultJsonl,
} from '../src/interoperability.js'
import type { Dataset, RunRecord } from '../src/types.js'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const CLI = resolve(ROOT, 'src', 'cli.ts')

const PRIVATE_PROMPT = 'PRIVATE CUSTOMER BIDSTREAM PROMPT answer-key-token'
const PRIVATE_OUTPUT = 'PRIVATE MODEL OUTPUT derived-answer-key-token'

const dataset: Dataset = {
  name: 'interop-fixture',
  version: '1.0.0',
  scenarios: [
    {
      id: 'public-scenario',
      axes: ['quality'],
      input: { messages: [{ role: 'user', content: 'Public auction summary' }] },
      rubric: { kind: 'programmatic', checker: 'non-empty' },
      meta: {
        benchmarkTier: 'public',
        scenarioHash: 'hash:public',
        outcomeType: 'tp',
      },
    },
    {
      id: 'private-scenario',
      axes: ['quality'],
      input: { messages: [{ role: 'user', content: PRIVATE_PROMPT }] },
      rubric: {
        kind: 'llm-judge',
        judge: 'stub:judge',
        prompt: 'Judge without exporting the private reference.',
        reference: 'PRIVATE REFERENCE answer key',
      },
      meta: {
        benchmarkTier: 'private',
        scenarioHash: 'hash:private',
        outcomeType: 'fn-guard',
      },
    },
  ],
}

const record: RunRecord = {
  id: 'run-interop',
  dataset: { name: dataset.name, version: dataset.version },
  runners: ['stub:echo'],
  createdAt: '2026-06-25T00:00:00.000Z',
  responses: [
    {
      runnerId: 'stub:echo',
      scenarioId: 'public-scenario',
      output: 'Public response',
      meta: {
        provider: 'stub',
        model: 'echo',
        accessedAt: '2026-06-25T00:00:01.000Z',
        latencyMs: 12,
      },
    },
    {
      runnerId: 'stub:echo',
      scenarioId: 'private-scenario',
      output: PRIVATE_OUTPUT,
      meta: {
        provider: 'stub',
        model: 'echo',
        accessedAt: '2026-06-25T00:00:02.000Z',
        latencyMs: 34,
      },
    },
  ],
  scores: [
    {
      runnerId: 'stub:echo',
      scenarioId: 'public-scenario',
      axis: 'quality',
      value: 1,
      rationale: 'Rationale should not be exported.',
      claimStatus: 'programmatic',
    },
    {
      runnerId: 'stub:echo',
      scenarioId: 'private-scenario',
      axis: 'quality',
      value: 0.25,
      rationale: 'Private score rationale should not be exported.',
      judge: 'stub:judge',
      claimStatus: 'analysis-only',
    },
  ],
  aggregates: [
    {
      runnerId: 'stub:echo',
      composite: 0.625,
      axes: {
        quality: {
          mean: 0.625,
          variance: 0.28125,
          n: 2,
        },
      },
      weights: { quality: 1 },
    },
  ],
  meta: {
    harnessVersion: '0.5.1',
    env: {
      traceRef: 's3://example-public-traces/run-interop.json',
      frontierProof: {
        proofUrl: 'https://example.invalid/proofs/run-interop.json',
      },
    },
  },
}

async function runCli(args: string[]) {
  return execFileAsync(process.execPath, ['--import', 'tsx', CLI, ...args], { cwd: ROOT })
}

function expectNoPrivatePayload(value: unknown): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  expect(text).not.toContain(PRIVATE_PROMPT)
  expect(text).not.toContain(PRIVATE_OUTPUT)
  expect(text).not.toContain('PRIVATE REFERENCE')
  expect(text).not.toContain('Private score rationale')
}

describe('interoperability exports', () => {
  it('exports portable task results with public-safe samples and explicit lossiness', () => {
    const portable = exportPortableRunRecord(record, dataset)

    expect(portable.schemaVersion).toBe(PORTABLE_RUN_EXPORT_SCHEMA_VERSION)
    expect(portable.lossiness.map((note) => note.code)).toEqual(
      expect.arrayContaining(['public-boundary', 'rubric-answer-keys-omitted']),
    )
    expect(portable.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'trace',
          ref: 's3://example-public-traces/run-interop.json',
        }),
        expect.objectContaining({
          kind: 'proof',
          ref: 'https://example.invalid/proofs/run-interop.json',
        }),
      ]),
    )

    const publicTask = portable.tasks.find((task) => task.scenarioId === 'public-scenario')
    const privateTask = portable.tasks.find((task) => task.scenarioId === 'private-scenario')
    expect(publicTask?.sample.input).toBe('Public auction summary')
    expect(publicTask?.sample.output).toBe('Public response')
    expect(privateTask?.privacy).toBe('private')
    expect(privateTask?.sample.input).toBeUndefined()
    expect(privateTask?.sample.output).toBeUndefined()
    expect(privateTask?.sample.redaction).toMatchObject({
      input: 'omitted-private',
      output: 'omitted-private',
    })
    expect(privateTask?.lossiness).toContain('private-prompt-output-omitted')
    expectNoPrivatePayload(portable)
  })

  it('keeps legacy Inspect exports safe for private scenarios', () => {
    const inspect = exportInspectRunRecord(record, dataset)

    expect(inspect.schemaVersion).toBe('assay.inspect-export.v1')
    expect(inspect.samples.find((sample) => sample.id === 'public-scenario')?.input).toBe(
      'Public auction summary',
    )
    expect(inspect.samples.find((sample) => sample.id === 'private-scenario')?.input).toBe(
      '[REDACTED: private scenario prompt omitted]',
    )
    expectNoPrivatePayload(inspect)
  })

  it('emits JSONL, JUnit XML, and GitHub Actions annotations for CI consumers', () => {
    const jsonl = exportResultJsonl(record, dataset)
    const lines = jsonl.trim().split('\n').map((line) => JSON.parse(line) as { kind: string, schemaVersion: string })
    expect(lines.map((line) => line.kind)).toEqual([
      'task-result',
      'task-result',
      'aggregate',
    ])
    expect(lines.every((line) => line.schemaVersion === RESULT_JSONL_SCHEMA_VERSION)).toBe(true)
    expectNoPrivatePayload(jsonl)

    const junit = exportJUnitXml(record, dataset, { passThreshold: 0.8 })
    expect(junit).toContain(`schemaVersion" value="${JUNIT_EXPORT_SCHEMA_VERSION}`)
    expect(junit).toContain('tests="2"')
    expect(junit).toContain('failures="1"')
    expect(junit).toContain('private-scenario.quality')
    expectNoPrivatePayload(junit)

    const annotations = exportGitHubActionsAnnotations(record, dataset, { passThreshold: 0.8 })
    expect(annotations).toContain(GITHUB_ANNOTATIONS_SCHEMA_VERSION)
    expect(annotations).toContain('::error')
    expect(annotations).toContain('scenario=private-scenario')
    expectNoPrivatePayload(annotations)
  })

  it('emits experiment-store metrics and span-style records without raw traces', () => {
    const store = exportExperimentStoreRecords(record, dataset)

    expect(store.schemaVersion).toBe(EXPERIMENT_STORE_SCHEMA_VERSION)
    expect(store.metrics.map((metric) => metric.name)).toEqual(
      expect.arrayContaining([
        'assay.score',
        'assay.aggregate.composite',
        'assay.aggregate.axis.mean',
      ]),
    )
    expect(store.spans.map((span) => span.name)).toEqual(
      expect.arrayContaining(['assay.run', 'assay.task']),
    )
    const privateSpan = store.spans.find((span) =>
      span.name === 'assay.task' && span.attributes['scenarioId'] === 'private-scenario')
    expect(privateSpan?.attributes['promptIncluded']).toBe(false)
    expect(privateSpan?.attributes['outputIncluded']).toBe(false)
    expectNoPrivatePayload(store)
  })

  it('writes selected export formats through the CLI', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assay-interop-'))
    try {
      const runPath = join(dir, 'run.json')
      const datasetPath = join(dir, 'dataset.json')
      const outPath = join(dir, 'results.jsonl')
      await writeFile(runPath, JSON.stringify(record), 'utf8')
      await writeFile(datasetPath, JSON.stringify(dataset), 'utf8')

      const { stdout } = await runCli([
        'export',
        runPath,
        '--format',
        'jsonl',
        '--dataset',
        datasetPath,
        '--out',
        outPath,
        '--pass-threshold',
        '0.8',
      ])
      expect(stdout).toContain(`wrote ${outPath}`)
      const exported = await readFile(outPath, 'utf8')
      expect(exported).toContain('"kind":"task-result"')
      expectNoPrivatePayload(exported)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
