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
import type { ModelResponse, RunRecord, Score } from './types.js'

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
  .action(async (opts: RunOptions) => {
    const dataset = await loadDataset(opts.dataset)
    const runnerIds = Array.isArray(opts.runner) ? opts.runner : [opts.runner]
    const runners = runnerIds.map((id) => resolveRunner(id))

    const responses: ModelResponse[] = []
    const scores: Score[] = []

    for (const runner of runners) {
      console.log(`[${runner.id}] running ${dataset.scenarios.length} scenarios`)
      for (const scenario of dataset.scenarios) {
        const response = await runner.run(scenario, {
          temperature: opts.temperature,
          ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
        })
        responses.push(response)
        scores.push(...score(response, scenario))
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
        commandLine: process.argv.slice(1).join(' '),
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
}
