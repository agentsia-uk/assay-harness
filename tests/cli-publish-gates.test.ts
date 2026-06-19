import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import { computeScenarioSetHash } from '../src/serialiser.js'
import type { Dataset, ModelAggregate, RunRecord } from '../src/types.js'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const CLI = resolve(ROOT, 'src', 'cli.ts')

async function runCli(args: string[]) {
  return execFileAsync(process.execPath, ['--import', 'tsx', CLI, ...args], { cwd: ROOT })
}

function scenario(id: string, outcomeType: string) {
  return {
    id,
    axes: ['quality'],
    input: { messages: [{ role: 'user' as const, content: `classify ${id}` }] },
    rubric: { kind: 'programmatic' as const, checker: 'non-empty' },
    meta: { outcomeType },
  }
}

function dataset(outcomeTypes = ['tp', 'tn', 'fp-guard', 'fn-guard']): Dataset {
  return {
    name: 'publish-gates',
    version: '1.0.0',
    scenarios: outcomeTypes.map((outcomeType, index) => scenario(`sc-${index + 1}`, outcomeType)),
  }
}

function aggregate(withConfidenceIntervals = true): ModelAggregate {
  return {
    runnerId: 'stub:echo',
    axes: {
      quality: {
        mean: 1,
        variance: 0,
        n: 4,
        ...(withConfidenceIntervals
          ? {
              confidenceInterval: {
                method: 'bootstrap' as const,
                lower: 1,
                upper: 1,
                confidenceLevel: 0.95,
                iterations: 1000,
                seed: 1,
                n: 4,
              },
            }
          : {}),
      },
    },
    composite: 1,
    weights: { quality: 1 },
    ...(withConfidenceIntervals
      ? {
          statisticalClaims: {
            method: 'bootstrap' as const,
            confidenceLevel: 0.95,
            iterations: 1000,
            seed: 1,
            sampleUnit: 'score' as const,
          },
        }
      : {}),
  }
}

function runRecord(ds: Dataset, withConfidenceIntervals = true): RunRecord {
  return {
    id: 'publish-run-001',
    dataset: { name: ds.name, version: ds.version },
    scenarioSetHash: computeScenarioSetHash(ds),
    runners: ['stub:echo'],
    createdAt: new Date('2026-06-20T09:00:00.000Z').toISOString(),
    responses: ds.scenarios.map((s) => ({
      runnerId: 'stub:echo',
      scenarioId: s.id,
      output: 'ok',
      meta: {
        provider: 'stub',
        model: 'echo',
        accessedAt: new Date('2026-06-20T09:00:01.000Z').toISOString(),
        latencyMs: 1,
      },
    })),
    scores: ds.scenarios.map((s) => ({
      runnerId: 'stub:echo',
      scenarioId: s.id,
      axis: 'quality',
      value: 1,
    })),
    aggregates: [aggregate(withConfidenceIntervals)],
    meta: { harnessVersion: '0.4.0' },
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2), 'utf8')
}

describe('cli publish gates', () => {
  it('keeps default publish backwards compatible for older records', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assay-publish-'))
    try {
      const ds = dataset()
      const record = runRecord(ds, false)
      delete record.scenarioSetHash
      const runPath = join(dir, 'run.json')
      await writeJson(runPath, record)

      const { stdout } = await runCli(['publish', runPath])

      expect(stdout).toContain('# Assay run publish-run-001')
      expect(stdout).toContain('Composite scores')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses a requested publish contract hash mismatch before emitting markdown', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assay-publish-'))
    try {
      const ds = dataset()
      const runPath = join(dir, 'run.json')
      await writeJson(runPath, runRecord(ds))

      await expect(
        runCli(['publish', runPath, '--contract-hash', 'deadbeef'.repeat(8)]),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining('RunRecord.scenarioSetHash'),
        stdout: '',
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('validates publish output against a dataset contract when requested', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assay-publish-'))
    try {
      const ds = dataset()
      const wrongDataset = { ...ds, version: '2.0.0' }
      const runPath = join(dir, 'run.json')
      const datasetPath = join(dir, 'dataset.json')
      await writeJson(runPath, runRecord(ds))
      await writeJson(datasetPath, wrongDataset)

      await expect(runCli(['publish', runPath, '--dataset', datasetPath])).rejects.toMatchObject({
        stderr: expect.stringContaining('RunRecord.dataset.version'),
        stdout: '',
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('emits markdown when requested publish gates pass', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assay-publish-'))
    try {
      const ds = dataset()
      const record = runRecord(ds)
      const runPath = join(dir, 'run.json')
      const datasetPath = join(dir, 'dataset.json')
      await writeJson(runPath, record)
      await writeJson(datasetPath, ds)

      const { stdout } = await runCli([
        'publish',
        runPath,
        '--dataset',
        datasetPath,
        '--contract-hash',
        record.scenarioSetHash!,
        '--leaderboard-eligible',
      ])

      expect(stdout).toContain('# Assay run publish-run-001')
      expect(stdout).toContain('Composite scores')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses leaderboard-eligible publish output without aggregate confidence intervals', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assay-publish-'))
    try {
      const ds = dataset()
      const runPath = join(dir, 'run.json')
      const datasetPath = join(dir, 'dataset.json')
      await writeJson(runPath, runRecord(ds, false))
      await writeJson(datasetPath, ds)

      await expect(
        runCli(['publish', runPath, '--dataset', datasetPath, '--leaderboard-eligible']),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining('confidence intervals'),
        stdout: '',
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses leaderboard-eligible publish output with unpublishable stratification', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assay-publish-'))
    try {
      const ds = dataset(['tp', 'tn', 'fp-guard', 'tp'])
      const runPath = join(dir, 'run.json')
      const datasetPath = join(dir, 'dataset.json')
      await writeJson(runPath, runRecord(ds))
      await writeJson(datasetPath, ds)

      await expect(
        runCli(['publish', runPath, '--dataset', datasetPath, '--leaderboard-eligible']),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining('scenario stratification is not publishable'),
        stdout: '',
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
