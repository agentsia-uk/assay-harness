import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import { loadDataset } from '../src/loader.js'
import { computeScenarioSetHash } from '../src/serialiser.js'
import type { RunRecord } from '../src/types.js'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const CLI = resolve(ROOT, 'src', 'cli.ts')
const EXAMPLES = resolve(ROOT, 'examples', 'scenarios')

async function runCli(args: string[]) {
  return execFileAsync(process.execPath, ['--import', 'tsx', CLI, ...args], { cwd: ROOT })
}

async function minimalRunRecord(): Promise<RunRecord> {
  const dataset = await loadDataset(EXAMPLES)
  return {
    id: 'run-cli-001',
    dataset: { name: dataset.name, version: dataset.version },
    scenarioSetHash: computeScenarioSetHash(dataset),
    runners: ['stub:echo'],
    createdAt: new Date('2026-06-19T10:00:00.000Z').toISOString(),
    responses: [
      {
        runnerId: 'stub:echo',
        scenarioId: dataset.scenarios[0].id,
        output: 'hello',
        meta: {
          provider: 'stub',
          model: 'echo',
          accessedAt: new Date('2026-06-19T10:00:01.000Z').toISOString(),
          latencyMs: 1,
        },
      },
    ],
    scores: [{ runnerId: 'stub:echo', scenarioId: dataset.scenarios[0].id, axis: 'quality', value: 1 }],
    aggregates: [
      {
        runnerId: 'stub:echo',
        axes: { quality: { mean: 1, variance: 0, n: 1 } },
        composite: 1,
        weights: { quality: 1 },
      },
    ],
    meta: { harnessVersion: '0.4.0' },
  }
}

describe('cli validate/contract', () => {
  it('prints a dataset identity contract', async () => {
    const dataset = await loadDataset(EXAMPLES)
    const expectedHash = computeScenarioSetHash(dataset)

    const { stdout } = await runCli(['contract', EXAMPLES, '--json'])
    const contract = JSON.parse(stdout) as Record<string, unknown>

    expect(contract).toEqual({
      name: dataset.name,
      version: dataset.version,
      scenarioCount: dataset.scenarios.length,
      scenarioSetHash: expectedHash,
    })
  })

  it('fails closed when the declared contract hash does not match', async () => {
    await expect(runCli(['contract', EXAMPLES, '--expect-hash', 'not-the-hash'])).rejects.toThrow(
      /scenario-set hash mismatch/,
    )
  })

  it('validates a RunRecord against its dataset contract', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assay-cli-'))
    try {
      const record = await minimalRunRecord()
      const runPath = join(dir, 'run.json')
      await writeFile(runPath, JSON.stringify(record), 'utf8')

      const { stdout } = await runCli(['validate', runPath, '--dataset', EXAMPLES, '--json'])
      const result = JSON.parse(stdout) as Record<string, unknown>

      expect(result).toEqual({
        valid: true,
        errors: [],
        scenarioSetHash: record.scenarioSetHash,
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects a RunRecord whose scenarioSetHash does not match the dataset contract', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assay-cli-'))
    try {
      const record = await minimalRunRecord()
      record.scenarioSetHash = 'wrong-hash'
      const runPath = join(dir, 'run.json')
      await writeFile(runPath, JSON.stringify(record), 'utf8')

      await expect(runCli(['validate', runPath, '--dataset', EXAMPLES, '--json'])).rejects.toMatchObject({
        stdout: expect.stringContaining('wrong-hash'),
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
