import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const CLI = resolve(ROOT, 'src', 'cli.ts')

async function runCli(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['--import', 'tsx', CLI, ...args],
      { cwd: ROOT, env: { ...process.env, ...env } },
    )
    return { stdout, stderr, code: 0 }
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number }
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 }
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2), 'utf8')
}

function judgeDataset() {
  return {
    name: 'judge-cli-fixture',
    version: '1.0.0',
    scenarios: [
      {
        id: 'judge-001',
        axes: ['judgement'],
        input: { messages: [{ role: 'user', content: 'The seller id is missing.' }] },
        rubric: {
          kind: 'llm-judge',
          judge: 'fixture:judge-v1',
          prompt: 'Score the response: {response}',
          calibration: {
            setId: 'calibration/adtech-v1',
            minimumAgreement: 0.8,
            observedAgreement: 0.92,
            promptHash: 'sha256:fixtureprompt',
          },
          biasChecks: [
            { kind: 'position', passed: true },
            { kind: 'label-order', passed: true },
          ],
        },
        meta: { outcomeType: 'tp' },
      },
    ],
  }
}

function humanAnnotations() {
  return [
    {
      itemId: 'item-1',
      scenarioHash: 'scenario:1',
      responseId: 'a',
      label: 'pass',
      score: 1,
      reviewer: 'reviewer-a',
      rubricVersion: 'rubric-v1',
      annotatedAt: '2026-06-25T09:00:00.000Z',
      status: 'agreed',
    },
    {
      itemId: 'item-1',
      scenarioHash: 'scenario:1',
      responseId: 'b',
      label: 'fail',
      score: 0,
      reviewer: 'reviewer-b',
      rubricVersion: 'rubric-v1',
      annotatedAt: '2026-06-25T09:01:00.000Z',
      status: 'adjudicated',
      adjudicator: 'lead-reviewer',
      adjudicatedAt: '2026-06-25T09:10:00.000Z',
    },
  ]
}

describe('CLI judge and human workflows', () => {
  it('runs llm-judge rubrics through an explicit adapter and existing judge cache', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assay-judge-cli-'))
    try {
      const datasetPath = join(dir, 'dataset.json')
      const adapterPath = join(dir, 'judge-adapter.mjs')
      const callsPath = join(dir, 'judge-calls.txt')
      const cacheDir = join(dir, 'judge-cache')
      const out1 = join(dir, 'run-1.json')
      const out2 = join(dir, 'run-2.json')
      await writeJson(datasetPath, judgeDataset())
      await writeFile(
        adapterPath,
        `
import { readFile, writeFile } from 'node:fs/promises'

export default async function fixtureJudge() {
  const path = process.env.JUDGE_CALLS_PATH
  const current = path ? Number.parseInt(await readFile(path, 'utf8').catch(() => '0'), 10) : 0
  if (path) await writeFile(path, String(current + 1), 'utf8')
  return {
    provider: 'fixture',
    model: 'judge-v1',
    text: JSON.stringify({ score: 0.64, rationale: 'structured fixture judgement' }),
  }
}
`,
        'utf8',
      )

      const commonArgs = [
        'run',
        '-d',
        datasetPath,
        '-r',
        'stub:echo',
        '--llm-judge-adapter',
        adapterPath,
        '--cache-judges',
        '--judge-cache-dir',
        cacheDir,
        '--no-ci',
      ]
      const env = { JUDGE_CALLS_PATH: callsPath }

      expect((await runCli([...commonArgs, '-o', out1], env)).code).toBe(0)
      expect((await runCli([...commonArgs, '-o', out2], env)).code).toBe(0)

      const record = JSON.parse(await readFile(out2, 'utf8')) as {
        scores: Array<{
          value: number
          claimStatus?: string
          judgeProvenance?: { provider?: string; model?: string; promptHash?: string }
        }>
      }
      expect(record.scores[0]).toMatchObject({
        value: 0.64,
        claimStatus: 'analysis-only',
        judgeProvenance: {
          provider: 'fixture',
          model: 'judge-v1',
          promptHash: 'sha256:fixtureprompt',
        },
      })
      await expect(readFile(callsPath, 'utf8')).resolves.toBe('1')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 120_000)

  it('validates human annotations and exports agreed/adjudicated preference pairs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assay-human-cli-'))
    try {
      const annotationsPath = join(dir, 'annotations.json')
      const pairsPath = join(dir, 'pairs.json')
      await writeJson(annotationsPath, humanAnnotations())

      const validate = await runCli(['human', 'validate', annotationsPath, '--json'])
      expect(validate.code).toBe(0)
      expect(JSON.parse(validate.stdout)).toMatchObject({ valid: true, conflicts: [] })

      const exported = await runCli([
        'human',
        'export-pairs',
        annotationsPath,
        '-o',
        pairsPath,
      ])
      expect(exported.code).toBe(0)

      const pairs = JSON.parse(await readFile(pairsPath, 'utf8'))
      expect(pairs).toEqual([
        {
          itemId: 'item-1',
          scenarioHash: 'scenario:1',
          chosenResponseId: 'a',
          rejectedResponseId: 'b',
          source: 'human-annotation',
          rubricVersion: 'rubric-v1',
        },
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 120_000)

  it('fails human validation for unresolved conflicts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assay-human-cli-'))
    try {
      const annotationsPath = join(dir, 'annotations.json')
      await writeJson(annotationsPath, [
        {
          ...humanAnnotations()[0],
          responseId: 'a',
          label: 'pass',
          status: 'agreed',
        },
        {
          ...humanAnnotations()[0],
          responseId: 'a',
          label: 'fail',
          reviewer: 'reviewer-b',
          status: 'conflicted',
        },
      ])

      const result = await runCli(['human', 'validate', annotationsPath])
      expect(result.code).not.toBe(0)
      expect(result.stderr).toContain('conflict')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 120_000)

  it('applies adjudication decisions from the CLI', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assay-human-cli-'))
    try {
      const annotationsPath = join(dir, 'annotations.json')
      const decisionsPath = join(dir, 'decisions.json')
      const adjudicatedPath = join(dir, 'adjudicated.json')
      await writeJson(annotationsPath, [
        {
          ...humanAnnotations()[0],
          responseId: 'a',
          label: 'pass',
          status: 'agreed',
        },
        {
          ...humanAnnotations()[0],
          responseId: 'a',
          label: 'fail',
          reviewer: 'reviewer-b',
          status: 'conflicted',
        },
        {
          ...humanAnnotations()[1],
          responseId: 'b',
          label: 'fail',
          status: 'agreed',
        },
      ])
      await writeJson(decisionsPath, [
        {
          itemId: 'item-1',
          responseId: 'a',
          label: 'pass',
          score: 0.95,
          adjudicator: 'lead-reviewer',
          adjudicatedAt: '2026-06-25T09:15:00.000Z',
          rationale: 'lead adjudication resolved the label conflict',
        },
      ])

      const adjudicate = await runCli([
        'human',
        'adjudicate',
        annotationsPath,
        '--decisions',
        decisionsPath,
        '-o',
        adjudicatedPath,
      ])
      expect(adjudicate.code).toBe(0)

      const validate = await runCli(['human', 'validate', adjudicatedPath, '--json'])
      expect(validate.code).toBe(0)
      expect(JSON.parse(validate.stdout)).toMatchObject({ valid: true, conflicts: [] })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 120_000)
})
