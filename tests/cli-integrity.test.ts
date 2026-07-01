/**
 * End-to-end CLI integrity wiring (Tier-1 #2/#3, council
 * `assay-harness-review-2026-06-18`, epic #54).
 *
 * Spawns the real CLI against the shipped example dataset and asserts the run
 * path stamps the scenario-set hash, emits bootstrap confidence intervals by
 * default, and refuses to score when a declared contract hash does not match.
 */

import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { readFile, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const ROOT = resolve(__dirname, '..')
const CLI = resolve(ROOT, 'src', 'cli.ts')
const EXAMPLES = resolve(ROOT, 'examples', 'scenarios')

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      'node',
      ['--import', 'tsx', CLI, ...args],
      { cwd: ROOT },
    )
    return { stdout, stderr, code: 0 }
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number }
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 }
  }
}

describe('CLI integrity wiring', () => {
  it('stamps scenarioSetHash and emits confidence intervals by default', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assay-cli-'))
    const out = join(dir, 'run.json')
    const { code } = await runCli(['run', '-d', EXAMPLES, '-r', 'stub:echo', '-o', out])
    expect(code).toBe(0)

    const record = JSON.parse(await readFile(out, 'utf8')) as {
      scenarioSetHash?: string
      aggregates: Array<{
        statisticalClaims?: unknown
        axes: Record<string, { confidenceInterval?: unknown }>
      }>
    }
    expect(record.scenarioSetHash).toMatch(/^[0-9a-f]{64}$/)
    const agg = record.aggregates[0]!
    expect(agg.statisticalClaims).toBeDefined()
    for (const axis of Object.values(agg.axes)) {
      expect(axis.confidenceInterval).toBeDefined()
    }
  }, 120_000)

  it('refuses to score when the declared contract hash does not match', async () => {
    const wrongHash = 'deadbeef'.repeat(8)
    const { code, stderr } = await runCli([
      'run',
      '-d',
      EXAMPLES,
      '-r',
      'stub:echo',
      '--contract-hash',
      wrongHash,
    ])
    expect(code).not.toBe(0)
    expect(stderr).toContain('scenario-set hash mismatch')
  }, 120_000)

  it('refuses legacy meta.multiTurn scenarios before the single-shot run path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assay-cli-multiturn-'))
    const datasetPath = join(dir, 'dataset.json')
    const out = join(dir, 'run.json')
    await writeFile(
      datasetPath,
      JSON.stringify(
        {
          name: 'multi-turn-guard',
          version: '0.0.0',
          scenarios: [
            {
              id: 'multi-turn-scenario',
              axes: ['persistence'],
              input: {
                messages: [{ role: 'user', content: 'remember this constraint' }],
              },
              rubric: {
                kind: 'programmatic',
                checker: 'non-empty',
              },
              meta: {
                multiTurn: true,
              },
            },
          ],
        },
        null,
        2,
      ),
    )

    const { code, stderr } = await runCli([
      'run',
      '-d',
      datasetPath,
      '-r',
      'stub:echo',
      '-o',
      out,
    ])

    expect(code).not.toBe(0)
    expect(stderr).toContain('legacy meta.multiTurn')
    await expect(readFile(out, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  }, 120_000)
})
