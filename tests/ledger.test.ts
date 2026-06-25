import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import {
  RunLedgerWriter,
  buildSampleTraceBundle,
  checksumString,
  createRunLedgerHeader,
  normaliseTracePolicy,
  readRunLedger,
  rebuildRunRecordFromLedger,
  validateResumeLedger,
} from '../src/index.js'
import { computeScenarioSetHash } from '../src/serialiser.js'
import type {
  Dataset,
  ModelResponse,
  RunLedgerAggregateOptions,
  Scenario,
  ScenarioRunLedgerOutcome,
  Score,
} from '../src/types.js'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const CLI = resolve(ROOT, 'src', 'cli.ts')
const EXAMPLES = resolve(ROOT, 'examples', 'scenarios')

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['--import', 'tsx', CLI, ...args],
      { cwd: ROOT },
    )
    return { stdout, stderr, code: 0 }
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number }
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 }
  }
}

function scenario(id: string, prompt = `prompt ${id}`): Scenario {
  return {
    id,
    axes: ['quality'],
    input: { messages: [{ role: 'user', content: prompt }] },
    rubric: { kind: 'programmatic', checker: 'non-empty' },
  }
}

function dataset(): Dataset {
  return {
    name: 'ledger-fixture',
    version: '1.0.0',
    scenarios: [scenario('a'), scenario('b')],
  }
}

function aggregateOptions(enabled = false): RunLedgerAggregateOptions {
  return {
    confidence: {
      enabled,
      iterations: 10,
      confidenceLevel: 0.95,
      seed: 1,
    },
  }
}

function response(s: Scenario, output: string): ModelResponse {
  return {
    runnerId: 'stub:echo',
    scenarioId: s.id,
    output,
    meta: {
      provider: 'stub',
      model: 'echo',
      version: '0',
      accessedAt: '2026-06-25T12:00:00.000Z',
      latencyMs: output.length,
      extra: {
        runtime: {
          provider: 'stub',
          attempts: 1,
        },
      },
    },
  }
}

function scoreFor(s: Scenario, value = 1): Score {
  return {
    runnerId: 'stub:echo',
    scenarioId: s.id,
    axis: 'quality',
    value,
    rationale: 'ok',
    claimStatus: 'programmatic',
  }
}

function outcome(s: Scenario, output = `answer ${s.id}`): ScenarioRunLedgerOutcome {
  const modelResponse = response(s, output)
  return {
    responses: [modelResponse],
    scores: [scoreFor(s)],
    latencyMs: modelResponse.meta.latencyMs,
  }
}

describe('run ledger', () => {
  it('rebuilds a deterministic RunRecord from completed ledger cells', async () => {
    const ds = dataset()
    const dir = await mkdtemp(join(tmpdir(), 'assay-ledger-'))
    const ledgerPath = join(dir, 'run.jsonl')
    const header = createRunLedgerHeader({
      runId: 'ledger-run-001',
      dataset: ds,
      scenarioSetHash: computeScenarioSetHash(ds),
      scenarioSetHashSchemaVersion: 'v1',
      runnerIds: ['stub:echo'],
      runnerOptions: { temperature: 0, seed: 7 },
      aggregate: aggregateOptions(false),
      tracePolicy: { visibility: 'public', rawOutputPolicy: 'omit' },
      harnessVersion: '0.0.0-test',
      commandLine: 'assay run --runner stub:echo',
      createdAt: '2026-06-25T12:00:00.000Z',
    })
    const writer = await RunLedgerWriter.open(ledgerPath, header)

    for (const s of ds.scenarios) {
      await writer.appendCompletedCell({
        scenarioId: s.id,
        runnerId: 'stub:echo',
        startedAt: '2026-06-25T12:00:00.000Z',
        completedAt: '2026-06-25T12:00:01.000Z',
        outcome: outcome(s),
      })
    }

    const state = await readRunLedger(ledgerPath)
    expect(state).not.toBeNull()
    const first = rebuildRunRecordFromLedger(state!, { dataset: ds })
    const second = rebuildRunRecordFromLedger(state!, { dataset: ds })

    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
    expect(first.id).toBe('ledger-run-001')
    expect(first.responses.map((item) => item.scenarioId)).toEqual(['a', 'b'])
    expect(first.meta.runLedger).toMatchObject({
      runId: 'ledger-run-001',
      completedCells: 2,
      failedCells: 0,
    })
  })

  it('refuses resume when dataset hash or runner options change', () => {
    const ds = dataset()
    const base = createRunLedgerHeader({
      runId: 'ledger-run-001',
      dataset: ds,
      scenarioSetHash: computeScenarioSetHash(ds),
      scenarioSetHashSchemaVersion: 'v1',
      runnerIds: ['stub:echo'],
      runnerOptions: { temperature: 0 },
      aggregate: aggregateOptions(false),
      harnessVersion: '0.0.0-test',
    })
    const changedDataset = createRunLedgerHeader({
      ...base,
      scenarioSetHash: 'f'.repeat(64),
    })
    const changedOptions = createRunLedgerHeader({
      ...base,
      runnerOptions: { temperature: 0.5 },
    })

    expect(() => validateResumeLedger(base, changedDataset)).toThrow(/dataset hash changed/)
    expect(() => validateResumeLedger(base, changedOptions)).toThrow(/runner options changed/)
  })

  it('builds public-safe trace bundles and blocks raw public output', () => {
    const secretScenario = scenario('secret', 'Use token sk-secret123 and Bearer abc123')
    const ds: Dataset = {
      name: 'trace-fixture',
      version: '1.0.0',
      scenarios: [secretScenario],
    }
    const header = createRunLedgerHeader({
      runId: 'trace-run-001',
      dataset: ds,
      scenarioSetHash: computeScenarioSetHash(ds),
      scenarioSetHashSchemaVersion: 'v1',
      runnerIds: ['stub:echo'],
      runnerOptions: { temperature: 0 },
      aggregate: aggregateOptions(false),
      tracePolicy: { visibility: 'public', rawOutputPolicy: 'redacted' },
      harnessVersion: '0.0.0-test',
    })
    const tracedOutcome = outcome(secretScenario, 'raw sk-output-secret')
    const bundle = buildSampleTraceBundle({
      header,
      dataset: ds,
      scenario: secretScenario,
      runnerId: 'stub:echo',
      outcome: tracedOutcome,
      visibility: 'public',
      rawOutputPolicy: 'redacted',
    })
    const serialized = JSON.stringify(bundle)

    expect(bundle.checksum).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(serialized).not.toContain('sk-secret123')
    expect(serialized).not.toContain('Bearer abc123')
    expect(serialized).not.toContain('sk-output-secret')
    expect(serialized).toContain('[REDACTED]')
    expect(bundle.payload.responses[0].responseHash).toBe(checksumString('raw sk-output-secret'))
    expect(() => normaliseTracePolicy('public', 'include')).toThrow(/cannot include raw outputs/)
  })

  it('resumes from CLI ledger cells without appending duplicate completed cells', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assay-cli-ledger-'))
    const ledger = join(dir, 'run.jsonl')
    const traces = join(dir, 'traces')
    const firstOut = join(dir, 'first.json')
    const secondOut = join(dir, 'second.json')
    const args = [
      'run',
      '-d',
      EXAMPLES,
      '-r',
      'stub:echo',
      '-o',
      firstOut,
      '--run-id',
      'cli-resume-001',
      '--ledger',
      ledger,
      '--trace-dir',
      traces,
      '--no-ci',
    ]

    const first = await runCli(args)
    expect(first.code).toBe(0)
    const lineCount = (await readFile(ledger, 'utf8')).trim().split(/\r?\n/).length
    const firstRecord = JSON.parse(await readFile(firstOut, 'utf8')) as {
      meta: { traceBundles?: { bundles?: unknown[] } }
    }
    expect(firstRecord.meta.traceBundles?.bundles).toHaveLength(2)

    const second = await runCli([
      'run',
      '-d',
      EXAMPLES,
      '-r',
      'stub:echo',
      '-o',
      secondOut,
      '--run-id',
      'cli-resume-001',
      '--ledger',
      ledger,
      '--trace-dir',
      traces,
      '--no-ci',
      '--resume',
    ])
    expect(second.code).toBe(0)
    expect(second.stderr).toContain('"scenario:skip"')
    expect((await readFile(ledger, 'utf8')).trim().split(/\r?\n/)).toHaveLength(lineCount)
    expect(await readFile(secondOut, 'utf8')).toBe(await readFile(firstOut, 'utf8'))
  }, 30_000)

  it('persists failed cells from CLI runs for diagnosis', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assay-cli-ledger-failure-'))
    const datasetPath = join(dir, 'failing.json')
    const ledger = join(dir, 'failure.jsonl')
    await writeFile(datasetPath, JSON.stringify({
      name: 'failing-ledger-fixture',
      version: '1.0.0',
      scenarios: [
        {
          id: 'bad-checker',
          axes: ['quality'],
          input: { messages: [{ role: 'user', content: 'hello' }] },
          rubric: { kind: 'programmatic', checker: 'missing-checker' },
        },
      ],
    }), 'utf8')

    const result = await runCli([
      'run',
      '-d',
      datasetPath,
      '-r',
      'stub:echo',
      '-o',
      join(dir, 'out.json'),
      '--run-id',
      'cli-failure-001',
      '--ledger',
      ledger,
      '--trace-dir',
      join(dir, 'traces'),
      '--no-ci',
    ])

    expect(result.code).not.toBe(0)
    const state = await readRunLedger(ledger)
    expect(state?.entries).toHaveLength(1)
    expect(state?.entries[0]).toMatchObject({
      status: 'failed',
      scenarioId: 'bad-checker',
      runnerId: 'stub:echo',
    })
    expect(JSON.stringify(state?.entries[0])).toContain('missing-checker')
  }, 30_000)
})
