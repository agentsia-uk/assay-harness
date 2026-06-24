import { execFile } from 'node:child_process'
import { readFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import { PERSISTENCE_GRADER_VERSION } from '../src/persistence-grader.js'
import type { RunRecord } from '../src/types.js'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const CLI = resolve(ROOT, 'src', 'cli.ts')
const FIXTURES = resolve(ROOT, 'tests', 'fixtures', 'cli-multi-turn')
const MIXED_DATASET = resolve(FIXTURES, 'mixed-dataset.json')
const LEGACY_META_MARKER = resolve(FIXTURES, 'legacy-meta-marker.json')
const MISSING_CRITERIA = resolve(FIXTURES, 'missing-persistence-criteria.json')

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

describe('CLI multi-turn execution', () => {
  it('runs a mixed single/multi-turn dataset and stamps multi-turn metadata', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assay-cli-multiturn-'))
    const out = join(dir, 'run.json')

    const { code } = await runCli([
      'run',
      '-d',
      MIXED_DATASET,
      '-r',
      'stub:echo',
      '-o',
      out,
      '--ci-iterations',
      '10',
    ])

    expect(code).toBe(0)
    const record = JSON.parse(await readFile(out, 'utf8')) as RunRecord
    expect(record.scenarioSetHash).toMatch(/^[0-9a-f]{64}$/)
    expect(record.responses.map((response) => response.scenarioId).sort()).toEqual([
      'refund-policy-pressure',
      'single-non-empty',
    ])

    expect(record.meta.scenarioSetHashMetadata).toEqual({
      schemaVersion: 'assay-harness.scenario-set-hash.v1',
      scenarioSetHash: record.scenarioSetHash,
      scenarioCount: 2,
      singleTurnScenarioCount: 1,
      multiTurnScenarioCount: 1,
    })

    const multiTurnResponse = record.responses.find(
      (response) => response.scenarioId === 'refund-policy-pressure',
    )
    const responseExtra = multiTurnResponse?.meta.extra as
      | { multiTurn?: { graderVersion?: string, turnObservations?: unknown[], persistence?: unknown[] } }
      | undefined
    expect(responseExtra?.multiTurn?.graderVersion).toBe(PERSISTENCE_GRADER_VERSION)
    expect(responseExtra?.multiTurn?.turnObservations).toHaveLength(2)
    expect(responseExtra?.multiTurn?.persistence).toHaveLength(1)

    const persistenceScore = record.scores.find(
      (score) => score.scenarioId === 'refund-policy-pressure',
    )
    expect(persistenceScore?.value).toBe(1)
    expect(persistenceScore?.rationale).toContain(PERSISTENCE_GRADER_VERSION)
    expect(record.meta.multiTurn?.graderVersion).toBe(PERSISTENCE_GRADER_VERSION)
    expect(record.meta.multiTurn?.results[0]).toMatchObject({
      scenarioId: 'refund-policy-pressure',
      runnerId: 'stub:echo',
      value: 1,
      graderVersion: PERSISTENCE_GRADER_VERSION,
      turnResponseScenarioIds: [
        'refund-policy-pressure#turn0',
        'refund-policy-pressure#turn1',
      ],
    })

    const validation = await runCli(['validate', out, '-d', MIXED_DATASET, '--json'])
    expect(validation.code).toBe(0)
    expect(JSON.parse(validation.stdout)).toMatchObject({
      valid: true,
      errors: [],
      scenarioSetHash: record.scenarioSetHash,
    })
  }, 30_000)

  it('fails closed on legacy meta.multiTurn marker-only scenarios', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assay-cli-multiturn-'))
    const out = join(dir, 'run.json')

    const { code, stderr } = await runCli([
      'run',
      '-d',
      LEGACY_META_MARKER,
      '-r',
      'stub:echo',
      '-o',
      out,
    ])

    expect(code).not.toBe(0)
    expect(stderr).toContain('legacy meta.multiTurn')
  }, 30_000)

  it('fails closed on public multi-turn scenarios without persistence criteria', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assay-cli-multiturn-'))
    const out = join(dir, 'run.json')

    const { code, stderr } = await runCli([
      'run',
      '-d',
      MISSING_CRITERIA,
      '-r',
      'stub:echo',
      '-o',
      out,
    ])

    expect(code).not.toBe(0)
    expect(stderr).toContain('no persistenceCriteria')
  }, 30_000)
})
