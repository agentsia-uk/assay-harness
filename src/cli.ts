#!/usr/bin/env node
import { Command } from 'commander'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadDataset } from './loader.js'
import { resolveRunner } from './runners/index.js'
import { assertSingleTurn } from './runners/multi-turn.js'
import { score } from './rubric.js'
import { aggregate } from './aggregator.js'
import { analyseScenarioItems } from './diagnostics.js'
import {
  assertScenarioSetHashMatches,
  assertScenarioStratificationPublishable,
  validateRunRecord,
} from './validate.js'
import {
  computeScenarioSetHash,
  writeRunRecord,
  readRunRecord,
  newRunId,
} from './serialiser.js'
import { redactCommandLine } from './redact.js'
import { pooled } from './concurrency.js'
import { withJudgeCache } from './judge-cache.js'
import { compareRuns, formatCompareTable } from './compare.js'
import { buildMarkdownReport, createGist } from './publish.js'
import { createStderrLogger } from './progress.js'
import type { Dataset, LLMJudgeExecutor, ModelResponse, RunRecord, Score } from './types.js'

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
  .option(
    '--contract-hash <hash>',
    'declared scenario-set hash to bind this run to; the harness refuses to ' +
      'score a corpus whose content hash does not match',
  )
  .option('--ci-iterations <n>', 'bootstrap iterations for confidence intervals (default 1000)', parseIntSafe, 1000)
  .option('--ci-level <p>', 'confidence level for the interval, e.g. 0.95 (default)', parseFloat, 0.95)
  .option('--ci-seed <n>', 'seed for the bootstrap RNG so intervals are reproducible (default 1)', parseIntSafe, 1)
  .option('--no-ci', 'skip bootstrap confidence intervals (NOT leaderboard-eligible)')
  .option(
    '--leaderboard-eligible',
    'enforce the publication integrity gates (confidence intervals present + ' +
      'outcome-type stratification balanced) and fail closed if unmet',
  )
  .action(async (opts: RunOptions) => {
    const dataset = await loadDataset(opts.dataset)

    // Tier-1 #2: bind the run to a unique corpus. When a contract hash is
    // declared, refuse to score a corpus whose content hash does not match.
    const scenarioSetHash = opts.contractHash
      ? assertScenarioSetHashMatches(dataset, opts.contractHash)
      : computeScenarioSetHash(dataset)
    const runnerIds = Array.isArray(opts.runner) ? opts.runner : [opts.runner]
    const runners = runnerIds.map((id) => resolveRunner(id))
    const log = createStderrLogger()
    const runId = newRunId()
    const at = () => new Date().toISOString()

    log.emit({
      event: 'run:start',
      runId,
      dataset: dataset.name,
      runners: runners.map((r) => r.id),
      scenarioCount: dataset.scenarios.length,
      at: at(),
    })

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
      const runnerOpts = {
        temperature: opts.temperature,
        ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
      }
      const tasks = dataset.scenarios.map((scenario) => async () => {
        log.emit({ event: 'scenario:start', runId, runnerId: runner.id, scenarioId: scenario.id, at: at() })
        let response: ModelResponse
        try {
          assertSingleTurn(scenario)
          response = await runner.run(scenario, runnerOpts)
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err)
          log.emit({ event: 'scenario:error', runId, runnerId: runner.id, scenarioId: scenario.id, error, at: at() })
          throw err
        }
        const scenarioScores = await score(response, scenario, llmJudge ? { llmJudge } : {})
        const meanScore = scenarioScores.reduce((acc, s) => acc + s.value, 0) / (scenarioScores.length || 1)
        log.emit({
          event: 'scenario:end',
          runId,
          runnerId: runner.id,
          scenarioId: scenario.id,
          score: meanScore,
          latencyMs: response.meta.latencyMs,
          at: at(),
        })
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

    // Tier-1 #3: wire bootstrap confidence intervals into the run path. A
    // composite without an interval is not leaderboard-eligible.
    const withCi = opts.ci !== false
    const aggregates = aggregate(
      scores,
      withCi
        ? {
            confidence: {
              method: 'bootstrap',
              iterations: opts.ciIterations,
              confidenceLevel: opts.ciLevel,
              seed: opts.ciSeed,
            },
          }
        : {},
    )

    // Tier-1 #3 + #4: enforce the publication integrity gates before a run can
    // claim leaderboard eligibility. Fail closed if intervals are missing or
    // outcome-type coverage is absent/imbalanced.
    if (opts.leaderboardEligible) {
      if (!withCi) {
        throw new Error(
          'leaderboard-eligible runs require confidence intervals; remove ' +
            '--no-ci to publish a composite as leaderboard-eligible',
        )
      }
      const diagnostics = analyseScenarioItems(dataset, {
        id: runId,
        dataset: { name: dataset.name, version: dataset.version },
        scenarioSetHash,
        runners: runners.map((r) => r.id),
        createdAt: at(),
        responses,
        scores,
        aggregates,
        meta: { harnessVersion: pkg.version },
      })
      assertScenarioStratificationPublishable(diagnostics.outcomeCoverage)
    }

    log.emit({
      event: 'run:end',
      runId,
      composite: Object.fromEntries(aggregates.map((a) => [a.runnerId, a.composite])),
      at: at(),
    })

    const record: RunRecord = {
      id: runId,
      dataset: { name: dataset.name, version: dataset.version },
      scenarioSetHash,
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

program
  .command('compare')
  .description('diff two RunRecord JSON files, showing per-scenario score changes')
  .argument('<run1>', 'path to first RunRecord JSON')
  .argument('<run2>', 'path to second RunRecord JSON')
  .option('--json', 'output result as JSON instead of a table')
  .action(async (run1Path: string, run2Path: string, opts: { json?: boolean }) => {
    const [run1, run2] = await Promise.all([
      readRunRecord(run1Path),
      readRunRecord(run2Path),
    ])
    const result = compareRuns(run1, run2)
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      console.log(formatCompareTable(result))
    }
  })

program
  .command('validate')
  .description('validate a RunRecord JSON file and optionally bind it to a dataset contract')
  .argument('<run>', 'path to RunRecord JSON')
  .option('-d, --dataset <path>', 'dataset directory or bundle file to verify corpus identity')
  .option('--json', 'output validation result as JSON')
  .action(async (runPath: string, opts: ValidateOptions) => {
    const raw = JSON.parse(await readFile(runPath, 'utf8')) as unknown
    const result = validateRunRecord(raw)
    const errors = [...result.errors]
    let scenarioSetHash: string | null = null

    if (opts.dataset && result.valid && isRunRecordLike(raw)) {
      const dataset = await loadDataset(opts.dataset)
      scenarioSetHash = computeScenarioSetHash(dataset)
      if (raw.dataset.name !== dataset.name) {
        errors.push(
          `RunRecord.dataset.name "${raw.dataset.name}" does not match dataset name "${dataset.name}"`,
        )
      }
      if (raw.dataset.version !== dataset.version) {
        errors.push(
          `RunRecord.dataset.version "${raw.dataset.version}" does not match dataset version "${dataset.version}"`,
        )
      }
      if (!raw.scenarioSetHash) {
        errors.push(
          `RunRecord.scenarioSetHash is required when validating against a dataset contract; ` +
            `expected "${scenarioSetHash}"`,
        )
      } else if (raw.scenarioSetHash !== scenarioSetHash) {
        errors.push(
          `RunRecord.scenarioSetHash "${raw.scenarioSetHash}" does not match dataset hash "${scenarioSetHash}"`,
        )
      }
    }

    const ok = errors.length === 0
    if (opts.json) {
      console.log(JSON.stringify({ valid: ok, errors, scenarioSetHash }, null, 2))
    } else if (ok) {
      console.log('RunRecord valid')
      if (scenarioSetHash) console.log(`scenarioSetHash=${scenarioSetHash}`)
    } else {
      process.stderr.write(`RunRecord validation failed:\n${errors.map((e) => `  - ${e}`).join('\n')}\n`)
    }

    if (!ok) process.exitCode = 1
  })

program
  .command('contract')
  .description('print or enforce the dataset identity contract used by --contract-hash')
  .argument('<dataset>', 'path to dataset directory or bundle file')
  .option('--expect-hash <hash>', 'fail if the dataset scenario-set hash differs from this value')
  .option('--json', 'output contract as JSON')
  .action(async (datasetPath: string, opts: ContractOptions) => {
    const dataset = await loadDataset(datasetPath)
    const scenarioSetHash = opts.expectHash
      ? assertScenarioSetHashMatches(dataset, opts.expectHash)
      : computeScenarioSetHash(dataset)
    const contract = {
      name: dataset.name,
      version: dataset.version,
      scenarioCount: dataset.scenarios.length,
      scenarioSetHash,
    }

    if (opts.json) {
      console.log(JSON.stringify(contract, null, 2))
    } else {
      console.log(`${contract.name} v${contract.version}`)
      console.log(`scenarioCount=${contract.scenarioCount}`)
      console.log(`scenarioSetHash=${contract.scenarioSetHash}`)
    }
  })

program
  .command('publish')
  .description('publish a RunRecord as a markdown summary')
  .argument('<run>', 'path to RunRecord JSON')
  .option('--to <target>', 'destination: stdout or github-gist (default: stdout)', 'stdout')
  .option('-d, --dataset <path>', 'dataset directory or bundle file to verify corpus identity')
  .option(
    '--contract-hash <hash>',
    'declared scenario-set hash to verify before publishing',
  )
  .option(
    '--leaderboard-eligible',
    'enforce publish integrity gates before emitting leaderboard-eligible output',
  )
  .action(async (runPath: string, opts: PublishOptions) => {
    const record = await readRunRecord(runPath)
    const dataset = opts.dataset ? await loadDataset(opts.dataset) : undefined

    assertPublishContract(record, { dataset, contractHash: opts.contractHash })
    if (opts.leaderboardEligible) {
      assertLeaderboardEligiblePublish(record, dataset)
    }

    const markdown = buildMarkdownReport(record)

    if (opts.to === 'github-gist') {
      const token = process.env['GITHUB_TOKEN']
      if (!token) {
        process.stderr.write('GITHUB_TOKEN not set — falling back to stdout\n')
        console.log(markdown)
        return
      }
      try {
        const gist = await createGist(markdown, record.id, token)
        console.log(`published: ${gist.url}`)
      } catch (err) {
        process.stderr.write(`gist creation failed — falling back to stdout\n${String(err)}\n`)
        console.log(markdown)
      }
      return
    }

    console.log(markdown)
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
  contractHash?: string
  ciIterations: number
  ciLevel: number
  ciSeed: number
  /** commander sets this to `false` when `--no-ci` is passed. */
  ci?: boolean
  leaderboardEligible?: boolean
}

interface ValidateOptions {
  dataset?: string
  json?: boolean
}

interface ContractOptions {
  expectHash?: string
  json?: boolean
}

interface PublishOptions {
  to: string
  dataset?: string
  contractHash?: string
  leaderboardEligible?: boolean
}

function isRunRecordLike(value: unknown): value is RunRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as RunRecord).dataset === 'object' &&
    (value as RunRecord).dataset !== null
  )
}

function assertPublishContract(
  record: RunRecord,
  opts: { dataset?: Dataset, contractHash?: string },
): void {
  const errors: string[] = []

  if (opts.dataset) {
    const scenarioSetHash = opts.contractHash
      ? assertScenarioSetHashMatches(opts.dataset, opts.contractHash)
      : computeScenarioSetHash(opts.dataset)

    if (record.dataset.name !== opts.dataset.name) {
      errors.push(
        `RunRecord.dataset.name "${record.dataset.name}" does not match dataset name "${opts.dataset.name}"`,
      )
    }
    if (record.dataset.version !== opts.dataset.version) {
      errors.push(
        `RunRecord.dataset.version "${record.dataset.version}" does not match dataset version "${opts.dataset.version}"`,
      )
    }
    errors.push(...scenarioSetHashErrors(record, scenarioSetHash, 'dataset hash'))
  } else if (opts.contractHash) {
    errors.push(...scenarioSetHashErrors(record, opts.contractHash, 'declared contract hash'))
  }

  if (errors.length > 0) {
    throw new Error(`RunRecord publish validation failed:\n${errors.map((e) => `  - ${e}`).join('\n')}`)
  }
}

function scenarioSetHashErrors(record: RunRecord, expected: string, label: string): string[] {
  if (!record.scenarioSetHash) {
    return [
      `RunRecord.scenarioSetHash is required when validating publish output against a ${label}; ` +
        `expected "${expected}"`,
    ]
  }
  if (record.scenarioSetHash !== expected) {
    return [
      `RunRecord.scenarioSetHash "${record.scenarioSetHash}" does not match ${label} "${expected}"`,
    ]
  }
  return []
}

function assertLeaderboardEligiblePublish(
  record: RunRecord,
  dataset: Dataset | undefined,
): void {
  const errors = aggregateConfidenceErrors(record)
  if (errors.length > 0) {
    throw new Error(
      `leaderboard-eligible publish gate failed:\n${errors.map((e) => `  - ${e}`).join('\n')}`,
    )
  }

  if (!dataset) {
    throw new Error(
      'leaderboard-eligible publish requires --dataset so outcome-type stratification can be verified',
    )
  }

  const diagnostics = analyseScenarioItems(dataset, record)
  assertScenarioStratificationPublishable(diagnostics.outcomeCoverage)
}

function aggregateConfidenceErrors(record: RunRecord): string[] {
  const errors: string[] = []

  if (record.aggregates.length === 0) {
    errors.push('RunRecord.aggregates must contain at least one aggregate with confidence intervals')
    return errors
  }

  for (const aggregateRecord of record.aggregates) {
    if (!aggregateRecord.statisticalClaims) {
      errors.push(
        `aggregate for runner "${aggregateRecord.runnerId}" is missing statisticalClaims; ` +
          'leaderboard-eligible publish requires bootstrap confidence intervals',
      )
    }

    const axes = Object.entries(aggregateRecord.axes)
    if (axes.length === 0) {
      errors.push(`aggregate for runner "${aggregateRecord.runnerId}" has no axes`)
    }

    for (const [axis, axisAggregate] of axes) {
      if (!axisAggregate.confidenceInterval) {
        errors.push(
          `aggregate for runner "${aggregateRecord.runnerId}" axis "${axis}" is missing a confidence interval`,
        )
      }
    }
  }

  return errors
}
