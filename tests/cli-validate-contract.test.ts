import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import { loadDataset } from '../src/loader.js'
import { computeScenarioSetHash, computeScenarioSetHashV2 } from '../src/serialiser.js'
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
      hashSchemaVersion: 'v1',
    })
  })

  it('prints a schema-v2 dataset identity contract', async () => {
    const dataset = await loadDataset(EXAMPLES)
    const expected = computeScenarioSetHashV2(dataset, {
      domain: 'example',
      plugin: { id: 'assay.examples', version: '1' },
      implementationFingerprints: [{ id: 'loader', version: '1' }],
      scorerFingerprints: [{ id: 'programmatic', version: '1' }],
    })

    const { stdout } = await runCli([
      'contract',
      EXAMPLES,
      '--json',
      '--hash-schema-version',
      'v2',
      '--domain',
      'example',
      '--plugin-id',
      'assay.examples',
      '--plugin-version',
      '1',
      '--implementation-fingerprint',
      'loader@1',
      '--scorer-fingerprint',
      'programmatic@1',
    ])
    const contract = JSON.parse(stdout) as Record<string, unknown>

    expect(contract).toMatchObject({
      name: dataset.name,
      version: dataset.version,
      scenarioCount: dataset.scenarios.length,
      scenarioSetHash: expected.scenarioSetHash,
      hashSchemaVersion: 'v2',
      scenarioSetHashMetadata: {
        hashSchemaVersion: 'v2',
        domain: 'example',
        plugin: { id: 'assay.examples', version: '1' },
      },
    })
  })

  it('stamps schema-v2 identity metadata from the run CLI', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assay-cli-'))
    try {
      const out = join(dir, 'run.json')
      await runCli([
        'run',
        '--dataset',
        EXAMPLES,
        '--runner',
        'stub:echo',
        '--out',
        out,
        '--hash-schema-version',
        'v2',
        '--domain',
        'example',
        '--plugin-id',
        'assay.examples',
        '--implementation-fingerprint',
        'runner@1',
        '--scorer-fingerprint',
        'programmatic@1',
      ])
      const run = JSON.parse(await readFile(out, 'utf8')) as RunRecord

      expect(run.scenarioSetHashSchemaVersion).toBe('v2')
      expect(run.scenarioSetHashMetadata).toMatchObject({
        hashSchemaVersion: 'v2',
        domain: 'example',
        plugin: { id: 'assay.examples' },
        scenarioSetHash: run.scenarioSetHash,
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
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
