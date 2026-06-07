#!/usr/bin/env node
import { Command } from 'commander'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadDataset } from './loader.js'
import { resolveRunner } from './runners/index.js'
import { score } from './rubric.js'
import { aggregate } from './aggregator.js'
import { writeRunRecord, newRunId } from './serialiser.js'
import { redactCommandLine } from './redact.js'
import { pooled } from './concurrency.js'
import { withJudgeCache } from './judge-cache.js'
import type { LLMJudgeExecutor, ModelResponse, RunRecord, Score } from './types.js'

const here = dirname(fileURLToPath(import.meta.url))
const pkgPath = resolve(here, '..', 'package.json')
const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as { version: string }

const program = new Command()
  .name('assay')
  .description('Agentsia Labs evaluation harness')
  .version(pkg.version)

program
  .command('list')
  .description('list the scenarios in a dataset')
  .argument('<dataset>', 'path to dataset directory or bundle file')
  .action(async (datasetPath: string) => {
    const dataset = await loadDataset(datasetPath)
    console.log(`${dataset.name} v${dataset.version} (${dataset.scenarios.length} scenarios)`)
    for (const s of dataset.scenarios) {
      console.log(`  ${s.id}  [${s.axes.join(', ')}]`)
    }
  })

program
  .command('run')
  .description('run one or more runners against a dataset')
  .requiredOption('-d, --dataset <path>', 'dataset directory or bundle file')
  .requiredOption('-r, --runner <id...>', 'runner id(s), e.g. stub:echo, anthropic:claude-opus-4-7')
  .option('-o, --out <path>', 'output RunRecord JSON path', 'runs/latest.json')
  .option('-t, --temperature <n>', 'temperature', parseFloat, 0)
  .option('--seed <n>', 'seed (where supported)', parseIntSafe)
  .option('--concurrency <n>', 'max parallel scenarios per runner (default 3)', parseIntSafe, 3)
  .option('--cache-judges', 'cache LLM judge calls to .cache/judge/ (TTL 24 h)')
  .option('--cache-ttl <ms>', 'judge cache TTL in milliseconds', parseIntSafe)
  .action(async (opts: RunOptions) => {
    const dataset = await loadDataset(opts.dataset)
    const runnerIds = Array.isArray(opts.runner) ? opts.runner : [opts.runner]
    const runners = runnerIds.map((id) => resolveRunner(id))

    let llmJudge: LLMJudgeExecutor | undefined
    if (opts.cacheJudges) {
      const identity: LLMJudgeExecutor = () => {
        throw new Error('No LLM judge executor configured for this run.')
      }
      llmJudge = withJudgeCache(identity, { ttlMs: opts.cacheTtl })
      console.log('[judge-cache] enabled — results cached to .cache/judge/')
    }

    const responses: ModelResponse[] = []
    const scores: Score[] = []

    for (const runner of runners) {
      console.log(`[${runner.id}] running ${dataset.scenarios.length} scenarios (concurrency=${opts.concurrency})`)
      const runnerOpts = {
        temperature: opts.temperature,
        ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
      }
      const tasks = dataset.scenarios.map((scenario) => async () => {
        const response = await runner.run(scenario, runnerOpts)
        const scenarioScores = await score(response, scenario, llmJudge ? { llmJudge } : {})
        console.log(`[${runner.id}] ${scenario.id} done`)
        return { response, scores: scenarioScores }
      })
      const settled = await pooled(tasks, opts.concurrency)
      for (const result of settled) {
        if (result.status === 'rejected') {
          throw result.reason as Error
        }
        responses.push(result.value.response)
        scores.push(...result.value.scores)
      }
    }

    const aggregates = aggregate(scores)

    const record: RunRecord = {
      id: newRunId(),
      dataset: { name: dataset.name, version: dataset.version },
      runners: runners.map((r) => r.id),
      createdAt: new Date().toISOString(),
      responses,
      scores,
      aggregates,
      meta: {
        harnessVersion: pkg.version,
        commandLine: redactCommandLine(process.argv.slice(1)),
      },
    }

    await writeRunRecord(opts.out, record)
    console.log(`wrote ${opts.out}`)
    for (const a of aggregates) {
      console.log(`  ${a.runnerId.padEnd(40)} composite=${a.composite.toFixed(3)}`)
    }
  })

await program.parseAsync(process.argv)

function parseIntSafe(value: string): number {
  const n = Number.parseInt(value, 10)
  if (Number.isNaN(n)) throw new Error(`expected integer, got "${value}"`)
  return n
}

interface RunOptions {
  dataset: string
  runner: string | string[]
  out: string
  temperature: number
  seed?: number
  concurrency: number
  cacheJudges?: boolean
  cacheTtl?: number
}
