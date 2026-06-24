import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import type { RunRecord } from '../src/types.js'

const execFileAsync = promisify(execFile)
const ROOT = resolve(__dirname, '..')
const CLI = resolve(ROOT, 'src', 'cli.ts')

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['--import', 'tsx', CLI, ...args],
      { cwd: ROOT },
    )
    return { stdout, stderr, code: 0 }
  } catch (error) {
    const e = error as { stdout?: string, stderr?: string, code?: number }
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 }
  }
}

function makeRun(
  id: string,
  scores: Array<{ scenarioId: string, value: number }>,
  opts: { scenarioSetHash?: string, runners?: string[] } = {},
): RunRecord {
  const runners = opts.runners ?? [`stub:${id}`]
  return {
    id,
    dataset: { name: 'test', version: '0.1.0' },
    scenarioSetHash: opts.scenarioSetHash ?? 'hash:matched',
    runners,
    createdAt: new Date('2026-06-24T12:00:00.000Z').toISOString(),
    responses: [],
    scores: scores.map((score) => ({
      runnerId: runners[0] ?? `stub:${id}`,
      scenarioId: score.scenarioId,
      axis: 'quality',
      value: score.value,
    })),
    aggregates: [],
    meta: { harnessVersion: '0.4.0' },
  }
}

describe('cli compare', () => {
  it('emits machine-readable JSON with paired-bootstrap interval metadata', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assay-cli-compare-'))
    try {
      const run1Path = join(dir, 'run1.json')
      const run2Path = join(dir, 'run2.json')
      await writeFile(
        run1Path,
        JSON.stringify(makeRun('baseline', [
          { scenarioId: 's1', value: 0.4 },
          { scenarioId: 's2', value: 0.6 },
          { scenarioId: 's3', value: 0.8 },
        ])),
        'utf8',
      )
      await writeFile(
        run2Path,
        JSON.stringify(makeRun('candidate', [
          { scenarioId: 's1', value: 0.6 },
          { scenarioId: 's2', value: 0.9 },
          { scenarioId: 's3', value: 0.7 },
        ])),
        'utf8',
      )

      const { stdout, stderr, code } = await runCli([
        'compare',
        run1Path,
        run2Path,
        '--json',
        '--ci-iterations',
        '75',
        '--ci-level',
        '0.9',
        '--ci-seed',
        '23',
      ])

      expect(code).toBe(0)
      expect(stderr).toBe('')
      const parsed = JSON.parse(stdout) as {
        interval: {
          status: string
          promotionClaimSupported: boolean
          descriptiveOnly: boolean
          confidenceInterval: {
            method: string
            confidenceLevel: number
            iterations: number
            seed: number
            n: number
          }
        }
      }
      expect(parsed.interval.status).toBe('available')
      expect(parsed.interval.promotionClaimSupported).toBe(true)
      expect(parsed.interval.descriptiveOnly).toBe(false)
      expect(parsed.interval.confidenceInterval).toMatchObject({
        method: 'paired-bootstrap',
        confidenceLevel: 0.9,
        iterations: 75,
        seed: 23,
        n: 3,
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps JSON parseable and warns clearly when scenario-set hashes differ', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assay-cli-compare-hash-'))
    try {
      const run1Path = join(dir, 'run1.json')
      const run2Path = join(dir, 'run2.json')
      await writeFile(
        run1Path,
        JSON.stringify(makeRun('baseline', [{ scenarioId: 's1', value: 0.4 }], {
          scenarioSetHash: 'hash:baseline',
        })),
        'utf8',
      )
      await writeFile(
        run2Path,
        JSON.stringify(makeRun('candidate', [{ scenarioId: 's1', value: 0.6 }], {
          scenarioSetHash: 'hash:candidate',
        })),
        'utf8',
      )

      const { stdout, stderr, code } = await runCli(['compare', run1Path, run2Path, '--json'])

      expect(code).toBe(0)
      expect(stderr).toContain('scenario-set hashes differ')
      const parsed = JSON.parse(stdout) as {
        interval: {
          status: string
          confidenceInterval: null
          descriptiveOnly: boolean
          scenarioSetHash: { status: string }
          warnings: string[]
        }
      }
      expect(parsed.interval.status).toBe('unavailable')
      expect(parsed.interval.confidenceInterval).toBeNull()
      expect(parsed.interval.descriptiveOnly).toBe(true)
      expect(parsed.interval.scenarioSetHash.status).toBe('mismatch')
      expect(parsed.interval.warnings.join('\n')).toContain('scenario-set hashes differ')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('fails clearly when a RunRecord contains multiple runners', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assay-cli-compare-runner-'))
    try {
      const run1Path = join(dir, 'run1.json')
      const run2Path = join(dir, 'run2.json')
      await writeFile(
        run1Path,
        JSON.stringify(makeRun('baseline', [{ scenarioId: 's1', value: 0.4 }], {
          runners: ['stub:a', 'stub:b'],
        })),
        'utf8',
      )
      await writeFile(
        run2Path,
        JSON.stringify(makeRun('candidate', [{ scenarioId: 's1', value: 0.6 }])),
        'utf8',
      )

      const { stderr, code } = await runCli(['compare', run1Path, run2Path])

      expect(code).not.toBe(0)
      expect(stderr).toContain('contains multiple runners')
      expect(stderr).toContain('Filter to a single runner before comparing')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
