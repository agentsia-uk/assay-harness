#!/usr/bin/env node
import { Command } from 'commander'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { loadDataset } from './loader.js'
import { resolveRunner } from './runners/index.js'
import {
  assertSingleTurn,
  isMultiTurnScenario,
  runMultiTurn,
  type MultiTurnResult,
  type MultiTurnScenario,
} from './runners/multi-turn.js'
import { assertNotEnvironmentScenario } from './environment.js'
import { PERSISTENCE_GRADER_VERSION } from './persistence-grader.js'
import { annotationsToPreferencePairs, score, validateHumanAnnotations } from './rubric.js'
import { aggregate } from './aggregator.js'
import {
  auditScenarioSet,
  createGenericAdversarialMutationPlugin,
  formatScenarioAuditReport,
} from './diagnostics.js'
import {
  ClaimEligibilityError,
  assertRunClaimEligible,
  assertScenarioSetHashMatches,
  validateRunRecord,
} from './validate.js'
import {
  computeScenarioSetHash,
  computeScenarioSetHashBySchema,
  writeRunRecord,
  readRunRecord,
  newRunId,
} from './serialiser.js'
import { redactCommandLine } from './redact.js'
import { pooled } from './concurrency.js'
import { withJudgeCache } from './judge-cache.js'
import {
  RunLedgerWriter,
  createRunLedgerHeader,
  readRunLedger,
  rebuildRunRecordFromLedger,
} from './ledger.js'
import {
  normaliseTracePolicy,
  writeSampleTraceBundle,
} from './traces.js'
import { compareRuns, formatCompareTable } from './compare.js'
import { buildMarkdownReport, createGist } from './publish.js'
import {
  buildProofBundleManifestFromFiles,
  formatProofReplayResult,
  formatProofBundleManifest,
  formatProofVerificationResult,
  replayProofBundle,
  verifyProofBundle,
  writeProofBundleManifest,
} from './proof.js'
import { createStderrLogger } from './progress.js'
import {
  applyHumanAdjudications,
  formatHumanAnnotationValidation,
  readHumanAdjudicationDecisions,
  readHumanAnnotations,
} from './human.js'
import {
  createLLMJudgeExecutor,
  createRunnerBackedLLMJudgeExecutor,
  loadLLMJudgeAdapterFromModule,
} from './llm-judge.js'
import {
  formatFrontierVerificationResult,
  readFrontierContractMetadata,
  verifyFrontierQuorum,
} from './frontier.js'
import {
  exportExperimentStoreRecords,
  exportGitHubActionsAnnotations,
  exportJUnitXml,
  exportPortableRunRecord,
  exportResultJsonl,
  type InteroperabilityFormat,
} from './interoperability.js'
import type {
  ClaimCard,
  Dataset,
  LLMJudgeExecutor,
  MultiTurnRunLedgerMetadata,
  ModelResponse,
  RunLedgerAggregateOptions,
  Runner,
  RunnerOptions,
  RunRecord,
  ScenarioRunLedgerOutcome,
  ScenarioSetFingerprint,
  Score,
  TraceBundleVisibility,
  TraceRawOutputPolicy,
} from './types.js'
import type {
  ReleaseDiagnosticArtifact,
  ReleaseDiagnosticDocument,
  ScenarioDiagnosticsPlugin,
} from './diagnostics.js'

const here = dirname(fileURLToPath(import.meta.url))
const pkgPath = resolve(here, '..', 'package.json')
const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as { version: string }

const program = new Command()
  .name('assay')
  .description('Assay benchmark evaluation harness')
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
  .option('--run-id <id>', 'stable run id for ledger-backed resumable runs')
  .option('--ledger <path>', 'append-only run ledger JSONL path; defaults to runs/ledgers/<run-id>.jsonl when enabled')
  .option('--resume', 'resume an existing run ledger and skip completed scenario/runner cells')
  .option('--trace-dir <path>', 'directory for checksum-addressed per-sample trace bundles; defaults to runs/traces/<run-id> when the ledger is enabled')
  .option('--trace-visibility <visibility>', 'trace visibility policy: public or internal', 'public')
  .option('--trace-raw-output <policy>', 'trace raw output policy: omit, redacted, or include', 'omit')
  .option('-t, --temperature <n>', 'temperature', parseFloat, 0)
  .option('--seed <n>', 'seed (where supported)', parseIntSafe)
  .option('--concurrency <n>', 'max parallel scenarios per runner (default 3)', parseIntSafe, 3)
  .option('--cache-judges', 'cache LLM judge calls to .cache/judge/ (TTL 24 h)')
  .option('--cache-ttl <ms>', 'judge cache TTL in milliseconds', parseIntSafe)
  .option('--judge-cache-dir <path>', 'judge cache directory (default .cache/judge)')
  .option('--llm-judge-runner <id>', 'runner id for llm-judge scoring, e.g. openai:gpt-4.1')
  .option('--llm-judge-adapter <path>', 'module exporting an LLM judge adapter function')
  .option('--llm-judge-rubric-version <version>', 'rubric version stamped into judge provenance')
  .option(
    '--contract-hash <hash>',
    'declared scenario-set hash to bind this run to; the harness refuses to ' +
      'score a corpus whose content hash does not match',
  )
  .option('--hash-schema-version <version>', 'scenario-set hash schema version: v1 or v2', 'v1')
  .option('--domain <id>', 'public domain id required for --hash-schema-version v2')
  .option('--plugin-id <id>', 'public plugin id required for --hash-schema-version v2')
  .option('--plugin-version <version>', 'public plugin version for --hash-schema-version v2')
  .option('--plugin-uri <uri>', 'public plugin URI for --hash-schema-version v2')
  .option('--implementation-fingerprint <spec>', 'implementation fingerprint id[@version][#digest]; repeatable', collectOption, [])
  .option('--scorer-fingerprint <spec>', 'scorer fingerprint id[@version][#digest]; repeatable', collectOption, [])
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
    const scenarioSetIdentity = computeScenarioSetIdentity(dataset, opts)
    if (opts.contractHash && scenarioSetIdentity.scenarioSetHash !== opts.contractHash) {
      throw new Error(
        `scenario-set hash mismatch: the corpus scored hashes to ` +
          `"${scenarioSetIdentity.scenarioSetHash}" but the declared contract hash is ` +
          `"${opts.contractHash}"`,
      )
    }
    const scenarioSetHash = scenarioSetIdentity.scenarioSetHash
    const runnerIds = Array.isArray(opts.runner) ? opts.runner : [opts.runner]
    const runners = runnerIds.map((id) => resolveRunner(id))
    const runnerOpts: RunnerOptions = {
      temperature: opts.temperature,
      ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
    }
    if (opts.resume && !opts.runId) {
      throw new Error('--resume requires --run-id so the ledger key is explicit')
    }
    const log = createStderrLogger()
    const runId = opts.runId ?? newRunId()
    const at = () => new Date().toISOString()
    const createdAt = at()
    const withCi = opts.ci !== false
    const aggregateOptions: RunLedgerAggregateOptions = {
      confidence: {
        enabled: withCi,
        iterations: opts.ciIterations,
        confidenceLevel: opts.ciLevel,
        seed: opts.ciSeed,
      },
    }
    const tracePolicy = normaliseTracePolicy(
      opts.traceVisibility as TraceBundleVisibility,
      opts.traceRawOutput as TraceRawOutputPolicy,
    )
    const traceFlagsRequested = Boolean(
      opts.traceDir ||
        opts.traceVisibility !== 'public' ||
        opts.traceRawOutput !== 'omit',
    )
    const ledgerEnabled = Boolean(opts.runId || opts.ledger || opts.resume || traceFlagsRequested)
    const ledgerPath = ledgerEnabled
      ? opts.ledger ?? join('runs', 'ledgers', `${runId}.jsonl`)
      : undefined
    const traceDir = ledgerEnabled
      ? opts.traceDir ?? join('runs', 'traces', runId)
      : undefined
    const ledger = ledgerEnabled
      ? await RunLedgerWriter.open(
          ledgerPath!,
          createRunLedgerHeader({
            runId,
            dataset,
            scenarioSetHash,
            scenarioSetHashSchemaVersion: scenarioSetIdentity.hashSchemaVersion,
            ...(scenarioSetIdentity.metadata
              ? { scenarioSetHashMetadata: scenarioSetIdentity.metadata }
              : {}),
            runnerIds: runners.map((r) => r.id),
            runnerOptions: runnerOpts,
            aggregate: aggregateOptions,
            tracePolicy,
            harnessVersion: pkg.version,
            commandLine: redactCommandLine(process.argv.slice(1)),
            createdAt,
          }),
          { resume: opts.resume },
        )
      : undefined

    log.emit({
      event: 'run:start',
      runId,
      dataset: dataset.name,
      runners: runners.map((r) => r.id),
      scenarioCount: dataset.scenarios.length,
      ...(ledgerPath ? { ledger: ledgerPath } : {}),
      ...(opts.resume ? { resume: true } : {}),
      at: at(),
    })

    let llmJudge = await resolveCliLLMJudge(opts)
    if (opts.cacheJudges) {
      const executor = (llmJudge ?? (() => {
        throw new Error('No LLM judge executor configured for this run.')
      })) satisfies LLMJudgeExecutor
      llmJudge = withJudgeCache(executor, {
        ...(opts.judgeCacheDir ? { dir: opts.judgeCacheDir } : {}),
        ...(opts.cacheTtl !== undefined ? { ttlMs: opts.cacheTtl } : {}),
      })
      console.log(`[judge-cache] enabled — results cached to ${opts.judgeCacheDir ?? '.cache/judge'}/`)
    }

    const responses: ModelResponse[] = []
    const scores: Score[] = []
    const multiTurnResults: MultiTurnRunLedgerMetadata[] = []
    const multiTurnScenarioCount = dataset.scenarios.filter((scenario) =>
      isMultiTurnScenario(scenario),
    ).length

    for (const runner of runners) {
      const tasks = dataset.scenarios.map((scenario) => async () => {
        const cached = ledger?.completedCell(runner.id, scenario.id)
        if (cached) {
          log.emit({
            event: 'scenario:skip',
            runId,
            runnerId: runner.id,
            scenarioId: scenario.id,
            reason: 'ledger-completed',
            at: at(),
          })
          return cached.outcome
        }

        const startedAt = at()
        log.emit({ event: 'scenario:start', runId, runnerId: runner.id, scenarioId: scenario.id, at: at() })
        let outcome: ScenarioRunLedgerOutcome
        try {
          outcome = isMultiTurnScenario(scenario)
            ? await runMultiTurnForRecord(runner, scenario, runnerOpts)
            : await runSingleTurnForRecord(runner, scenario, runnerOpts, llmJudge)
          const trace = ledger && traceDir
            ? await writeSampleTraceBundle({
                traceDir,
                header: ledger.state.header,
                dataset,
                scenario,
                runnerId: runner.id,
                outcome,
                visibility: tracePolicy.visibility,
                rawOutputPolicy: tracePolicy.rawOutputPolicy,
              })
            : undefined
          await ledger?.appendCompletedCell({
            scenarioId: scenario.id,
            runnerId: runner.id,
            startedAt,
            completedAt: at(),
            outcome,
            ...(trace ? { trace } : {}),
          })
        } catch (err) {
          await ledger?.appendFailedCell({
            scenarioId: scenario.id,
            runnerId: runner.id,
            startedAt,
            completedAt: at(),
            error: err,
          })
          const error = err instanceof Error ? err.message : String(err)
          log.emit({ event: 'scenario:error', runId, runnerId: runner.id, scenarioId: scenario.id, error, at: at() })
          throw err
        }
        const meanScore = outcome.scores.reduce((acc, s) => acc + s.value, 0) / (outcome.scores.length || 1)
        log.emit({
          event: 'scenario:end',
          runId,
          runnerId: runner.id,
          scenarioId: scenario.id,
          score: meanScore,
          latencyMs: outcome.latencyMs,
          at: at(),
        })
        return outcome
      })
      const settled = await pooled(tasks, opts.concurrency)
      for (const result of settled) {
        if (result.status === 'rejected') {
          throw result.reason as Error
        }
        responses.push(...result.value.responses)
        scores.push(...result.value.scores)
        if (result.value.multiTurn) multiTurnResults.push(result.value.multiTurn)
      }
    }

    // Tier-1 #3: wire bootstrap confidence intervals into the run path. A
    // composite without an interval is not leaderboard-eligible.
    const persistedLedger = ledger ? await readRunLedger(ledger.path) : null
    const record: RunRecord = persistedLedger
      ? rebuildRunRecordFromLedger(persistedLedger, { dataset })
      : buildRunRecord({
          runId,
          dataset,
          scenarioSetHash,
          scenarioSetIdentity,
          runners,
          createdAt,
          responses,
          scores,
          multiTurnResults,
          multiTurnScenarioCount,
          aggregateOptions,
        })
    const aggregates = record.aggregates

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
      assertRunClaimEligible(record, { dataset })
    }

    log.emit({
      event: 'run:end',
      runId,
      composite: Object.fromEntries(aggregates.map((a) => [a.runnerId, a.composite])),
      at: at(),
    })

    await writeRunRecord(opts.out, record)
    console.log(`wrote ${opts.out}`)
    for (const a of aggregates) {
      console.log(`  ${a.runnerId.padEnd(40)} composite=${a.composite.toFixed(3)}`)
    }
  })

const human = program
  .command('human')
  .description('validate, adjudicate, and export human annotation files')

human
  .command('validate')
  .description('validate a human annotation JSON file')
  .argument('<annotations>', 'annotation JSON array or {"annotations":[...]} file')
  .option('--json', 'output validation report as JSON')
  .action(async (annotationsPath: string, opts: HumanValidateOptions) => {
    const annotations = await readHumanAnnotations(annotationsPath)
    const report = validateHumanAnnotations(annotations)
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2))
    } else if (report.valid) {
      console.log(formatHumanAnnotationValidation(report))
    } else {
      process.stderr.write(`${formatHumanAnnotationValidation(report)}\n`)
    }
    if (!report.valid) process.exitCode = 1
  })

human
  .command('adjudicate')
  .description('append adjudicated terminal labels from a decision file')
  .argument('<annotations>', 'annotation JSON array or {"annotations":[...]} file')
  .requiredOption('--decisions <path>', 'adjudication decision JSON array or {"decisions":[...]} file')
  .requiredOption('-o, --out <path>', 'output annotation JSON path')
  .action(async (annotationsPath: string, opts: HumanAdjudicateOptions) => {
    const [annotations, decisions] = await Promise.all([
      readHumanAnnotations(annotationsPath),
      readHumanAdjudicationDecisions(opts.decisions),
    ])
    const adjudicated = applyHumanAdjudications(annotations, decisions)
    const report = validateHumanAnnotations(adjudicated)
    if (!report.valid) {
      process.stderr.write(`${formatHumanAnnotationValidation(report)}\n`)
      process.exitCode = 1
      return
    }
    await writeFile(opts.out, `${JSON.stringify(adjudicated, null, 2)}\n`, 'utf8')
    console.log(`wrote ${opts.out}`)
  })

human
  .command('export-pairs')
  .description('export preference pairs from agreed/adjudicated annotations')
  .argument('<annotations>', 'annotation JSON array or {"annotations":[...]} file')
  .option('-o, --out <path>', 'output preference-pair JSON path; defaults to stdout')
  .action(async (annotationsPath: string, opts: HumanExportPairsOptions) => {
    const annotations = await readHumanAnnotations(annotationsPath)
    const report = validateHumanAnnotations(annotations)
    if (!report.valid) {
      process.stderr.write(`${formatHumanAnnotationValidation(report)}\n`)
      process.exitCode = 1
      return
    }
    const pairs = annotationsToPreferencePairs(annotations)
    const output = `${JSON.stringify(pairs, null, 2)}\n`
    if (opts.out) {
      await writeFile(opts.out, output, 'utf8')
      console.log(`wrote ${opts.out}`)
    } else {
      process.stdout.write(output)
    }
  })

program
  .command('compare')
  .description('diff two RunRecord JSON files, showing per-scenario score changes')
  .argument('<run1>', 'path to first RunRecord JSON')
  .argument('<run2>', 'path to second RunRecord JSON')
  .option('--json', 'output result as JSON instead of a table')
  .option('--ci-iterations <n>', 'paired-bootstrap iterations for confidence intervals (default 1000)', parseIntSafe, 1000)
  .option('--ci-level <p>', 'confidence level for the interval, e.g. 0.95 (default)', parseFloat, 0.95)
  .option('--ci-seed <n>', 'seed for the paired-bootstrap RNG so intervals are reproducible (default 1)', parseIntSafe, 1)
  .action(async (run1Path: string, run2Path: string, opts: CompareCliOptions) => {
    const [run1, run2] = await Promise.all([
      readRunRecord(run1Path),
      readRunRecord(run2Path),
    ])
    const result = compareRuns(run1, run2, {
      iterations: opts.ciIterations,
      confidenceLevel: opts.ciLevel,
      seed: opts.ciSeed,
    })
    emitCompareWarnings(result.interval.warnings)
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      console.log(formatCompareTable(result))
    }
  })

program
  .command('diagnostics')
  .description('audit public scenario methodology diagnostics')
  .argument('<dataset>', 'path to dataset directory or bundle file')
  .option('--run <path>', 'optional RunRecord JSON path for pass-rate difficulty diagnostics')
  .option('--training-prompts <path>', 'JSON array, {"prompts": [...]}, or newline-delimited training prompts')
  .option('--required-outcome <type>', 'outcome type that must be represented; repeatable', collectOption, [])
  .option('--required-lane <lane>', 'scenario lane that must be represented; repeatable', collectOption, [])
  .option('--lane-key <key>', 'metadata key to read lanes from; repeatable', collectOption, [])
  .option('--leakage-ngram-size <n>', 'token n-gram size for training prompt leakage checks', parseIntSafe)
  .option('--leakage-threshold <n>', 'containment threshold for training prompt leakage checks', parseFloat)
  .option('--near-duplicate-ngram-size <n>', 'token n-gram size for near-duplicate prompt checks', parseIntSafe)
  .option('--near-duplicate-threshold <n>', 'containment threshold for near-duplicate prompt checks', parseFloat)
  .option('--release-doc <path>', 'release markdown/README file to compare against machine-readable artifacts; repeatable', collectOption, [])
  .option('--release-artifact <path>', 'machine-readable JSON artifact with release counts, hash, quorum, or claim state; repeatable', collectOption, [])
  .option('--generic-adversarial-probes', 'generate corpus-agnostic adversarial mutation probes')
  .option('--plugin <path>', 'diagnostics plugin module path; repeatable', collectOption, [])
  .option('--claim-block-doc-drift', 'mark artifact/doc drift findings as claim-blocking')
  .option('--claim-block-rubric-ambiguity', 'mark rubric ambiguity findings as claim-blocking')
  .option('--json', 'output result as JSON')
  .option('--fail-on-claim-blocking', 'exit non-zero when claim-blocking findings are present')
  .action(async (datasetPath: string, opts: DiagnosticsOptions) => {
    const [dataset, record, trainingPrompts, loadedPlugins, releaseDocuments, releaseArtifacts] = await Promise.all([
      loadDataset(datasetPath),
      opts.run ? readRunRecord(opts.run) : Promise.resolve(undefined),
      opts.trainingPrompts ? readTrainingPrompts(opts.trainingPrompts) : Promise.resolve(undefined),
      loadDiagnosticPlugins(opts.plugin ?? []),
      readReleaseDocuments(opts.releaseDoc ?? []),
      readReleaseArtifacts(opts.releaseArtifact ?? []),
    ])
    const plugins = opts.genericAdversarialProbes
      ? [...loadedPlugins, createGenericAdversarialMutationPlugin()]
      : loadedPlugins
    const report = auditScenarioSet(dataset, {
      ...(record ? { record } : {}),
      ...(trainingPrompts ? { trainingPrompts } : {}),
      ...(opts.leakageNgramSize !== undefined ? { leakageNgramSize: opts.leakageNgramSize } : {}),
      ...(opts.leakageThreshold !== undefined ? { leakageNgramThreshold: opts.leakageThreshold } : {}),
      ...(opts.nearDuplicateNgramSize !== undefined
        ? { nearDuplicateNgramSize: opts.nearDuplicateNgramSize }
        : {}),
      ...(opts.nearDuplicateThreshold !== undefined
        ? { nearDuplicateThreshold: opts.nearDuplicateThreshold }
        : {}),
      ...(opts.requiredOutcome.length > 0 ? { requiredOutcomeTypes: opts.requiredOutcome } : {}),
      ...(opts.requiredLane.length > 0 ? { requiredLanes: opts.requiredLane } : {}),
      ...(opts.laneKey.length > 0 ? { laneMetadataKeys: opts.laneKey } : {}),
      ...(releaseDocuments.length > 0 ? { releaseDocuments } : {}),
      ...(releaseArtifacts.length > 0 ? { releaseArtifacts } : {}),
      ...(opts.claimBlockDocDrift ? { releaseDocDriftSeverity: 'claim-blocking' as const } : {}),
      ...(opts.claimBlockRubricAmbiguity ? { rubricAmbiguitySeverity: 'claim-blocking' as const } : {}),
      ...(plugins.length > 0 ? { plugins } : {}),
    })

    if (opts.json) {
      console.log(JSON.stringify(report, null, 2))
    } else {
      process.stdout.write(formatScenarioAuditReport(report))
    }

    if (opts.failOnClaimBlocking && report.summary.claimBlockingCount > 0) {
      process.exitCode = 1
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
      if (raw.scenarioSetHashSchemaVersion === 'v2') {
        scenarioSetHash = raw.scenarioSetHash ?? null
        const metadata = raw.scenarioSetHashMetadata
        if (!metadata || metadata.hashSchemaVersion !== 'v2') {
          errors.push('RunRecord.scenarioSetHashMetadata v2 is required when validating a v2 run against a dataset')
        } else {
          if (metadata.dataset.name !== dataset.name) {
            errors.push(
              `RunRecord.scenarioSetHashMetadata.dataset.name "${metadata.dataset.name}" ` +
                `does not match dataset name "${dataset.name}"`,
            )
          }
          if (metadata.dataset.version !== dataset.version) {
            errors.push(
              `RunRecord.scenarioSetHashMetadata.dataset.version "${metadata.dataset.version}" ` +
                `does not match dataset version "${dataset.version}"`,
            )
          }
          if (metadata.scenarioCount !== dataset.scenarios.length) {
            errors.push(
              `RunRecord.scenarioSetHashMetadata.scenarioCount ${metadata.scenarioCount} ` +
                `does not match dataset scenario count ${dataset.scenarios.length}`,
            )
          }
        }
      } else {
        scenarioSetHash = computeScenarioSetHash(dataset)
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
  .option('--hash-schema-version <version>', 'scenario-set hash schema version: v1 or v2', 'v1')
  .option('--domain <id>', 'public domain id required for --hash-schema-version v2')
  .option('--plugin-id <id>', 'public plugin id required for --hash-schema-version v2')
  .option('--plugin-version <version>', 'public plugin version for --hash-schema-version v2')
  .option('--plugin-uri <uri>', 'public plugin URI for --hash-schema-version v2')
  .option('--implementation-fingerprint <spec>', 'implementation fingerprint id[@version][#digest]; repeatable', collectOption, [])
  .option('--scorer-fingerprint <spec>', 'scorer fingerprint id[@version][#digest]; repeatable', collectOption, [])
  .option('--json', 'output contract as JSON')
  .action(async (datasetPath: string, opts: ContractOptions) => {
    const dataset = await loadDataset(datasetPath)
    const identity = computeScenarioSetIdentity(dataset, opts)
    if (opts.expectHash && identity.scenarioSetHash !== opts.expectHash) {
      throw new Error(
        `scenario-set hash mismatch: the corpus hashes to "${identity.scenarioSetHash}" ` +
          `but --expect-hash is "${opts.expectHash}"`,
      )
    }
    const contract = {
      name: dataset.name,
      version: dataset.version,
      scenarioCount: dataset.scenarios.length,
      scenarioSetHash: identity.scenarioSetHash,
      hashSchemaVersion: identity.hashSchemaVersion,
      ...(identity.metadata ? { scenarioSetHashMetadata: identity.metadata } : {}),
    }

    if (opts.json) {
      console.log(JSON.stringify(contract, null, 2))
    } else {
      console.log(`${contract.name} v${contract.version}`)
      console.log(`scenarioCount=${contract.scenarioCount}`)
      console.log(`scenarioSetHash=${contract.scenarioSetHash}`)
      console.log(`hashSchemaVersion=${contract.hashSchemaVersion}`)
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
  .option('--claim-card <path>', 'machine-readable claim card to enforce for leaderboard-eligible output')
  .action(async (runPath: string, opts: PublishOptions) => {
    const record = await readRunRecord(runPath)
    const dataset = opts.dataset ? await loadDataset(opts.dataset) : undefined
    const claimCard = opts.claimCard
      ? JSON.parse(await readFile(opts.claimCard, 'utf8')) as ClaimCard
      : undefined

    assertPublishContract(record, { dataset, contractHash: opts.contractHash })
    if (opts.leaderboardEligible) {
      assertLeaderboardEligiblePublish(record, { dataset, claimCard })
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

program
  .command('export')
  .description('export a RunRecord for external CI, eval, or experiment-store consumers')
  .argument('<run>', 'path to RunRecord JSON')
  .requiredOption(
    '--format <format>',
    'portable, jsonl, junit, github-annotations, or experiment-store',
  )
  .option('-d, --dataset <path>', 'dataset directory or bundle file for public-safe samples')
  .option('-o, --out <path>', 'output path; defaults to stdout')
  .option('--pass-threshold <n>', 'CI failure threshold for per-score exports (default 1)', parseThreshold, 1)
  .action(async (runPath: string, opts: ExportOptions) => {
    const record = await readRunRecord(runPath)
    const dataset = opts.dataset ? await loadDataset(opts.dataset) : undefined
    const content = renderInteropExport(record, dataset, opts)
    await writeTextOutput(opts.out, content)
  })

const proof = program
  .command('proof')
  .description('build and verify public release proof bundles')

proof
  .command('build')
  .description('build a deterministic public proof-bundle manifest')
  .requiredOption('--run <path>', 'RunRecord JSON path')
  .requiredOption('--contract <path>', 'release-contract JSON path')
  .option('-d, --dataset <path>', 'dataset directory or bundle file to recompute scenario-set hash')
  .option('--trace-bundle <path>', 'environment trace bundle JSON path to checksum into the proof manifest')
  .option('-o, --out <path>', 'output proof manifest JSON path; defaults to stdout')
  .action(async (opts: ProofBuildOptions) => {
    const manifest = await buildProofBundleManifestFromFiles({
      runPath: opts.run,
      releaseContractPath: opts.contract,
      ...(opts.dataset ? { datasetPath: opts.dataset } : {}),
      ...(opts.traceBundle ? { traceBundlePath: opts.traceBundle } : {}),
      commandLine: process.argv.slice(1),
    })

    if (opts.out) {
      await writeProofBundleManifest(opts.out, manifest)
      console.log(`wrote ${opts.out}`)
      return
    }

    console.log(formatProofBundleManifest(manifest))
  })

proof
  .command('verify')
  .description('verify a proof manifest against its source RunRecord, release contract, and optional claim inputs')
  .argument('<proof>', 'proof manifest JSON path')
  .requiredOption('--run <path>', 'RunRecord JSON path')
  .requiredOption('--contract <path>', 'release-contract JSON path')
  .option('-d, --dataset <path>', 'dataset directory or bundle file to recompute scenario-set hash')
  .option('--claim-card <path>', 'machine-readable claim card for leaderboard-eligible verification')
  .option('--trace-bundle <path>', 'environment trace bundle JSON path declared by the proof manifest')
  .option('--leaderboard-eligible', 'enforce the shared claim-card eligibility gate')
  .option('--json', 'output verification result as JSON')
  .action(async (proofPath: string, opts: ProofVerifyOptions) => {
    const [manifest, record, releaseContract, dataset, claimCard, traceBundle] = await Promise.all([
      readJson(proofPath),
      readRunRecord(opts.run),
      readJson(opts.contract),
      opts.dataset ? loadDataset(opts.dataset) : Promise.resolve(undefined),
      opts.claimCard ? readJson(opts.claimCard) as Promise<ClaimCard> : Promise.resolve(undefined),
      opts.traceBundle ? readJson(opts.traceBundle) : Promise.resolve(undefined),
    ])
    const result = verifyProofBundle({
      manifest,
      runRecord: record,
      releaseContract,
      ...(dataset ? { dataset } : {}),
      ...(claimCard ? { claimCard } : {}),
      ...(traceBundle !== undefined ? { traceBundle } : {}),
      ...(opts.leaderboardEligible ? { leaderboardEligible: true } : {}),
    })

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2))
    } else if (result.valid) {
      console.log(formatProofVerificationResult(result))
    } else {
      process.stderr.write(`${formatProofVerificationResult(result)}\n`)
    }

    if (!result.valid) process.exitCode = 1
  })

proof
  .command('replay')
  .description('replay pinned model outputs and verify deterministic scores, aggregates, and proof inputs')
  .requiredOption('--run <path>', 'RunRecord JSON path with pinned model outputs')
  .requiredOption('--contract <path>', 'release-contract JSON path')
  .requiredOption('-d, --dataset <path>', 'dataset directory or bundle file used by the RunRecord')
  .option('--proof <path>', 'optional proof manifest JSON path to compare against regenerated proof inputs')
  .option('--trace-bundle <path>', 'environment trace bundle JSON path declared by the proof manifest')
  .option('--json', 'output replay result as JSON')
  .action(async (opts: ProofReplayOptions) => {
    const [record, releaseContract, dataset, proofManifest, traceBundle] = await Promise.all([
      readRunRecord(opts.run),
      readJson(opts.contract),
      loadDataset(opts.dataset),
      opts.proof ? readJson(opts.proof) : Promise.resolve(undefined),
      opts.traceBundle ? readJson(opts.traceBundle) : Promise.resolve(undefined),
    ])
    const result = replayProofBundle({
      runRecord: record,
      releaseContract,
      dataset,
      ...(proofManifest !== undefined ? { proofManifest } : {}),
      ...(traceBundle !== undefined ? { traceBundle } : {}),
    })

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2))
    } else if (result.valid) {
      console.log(formatProofReplayResult(result))
    } else {
      process.stderr.write(`${formatProofReplayResult(result)}\n`)
    }

    if (!result.valid) process.exitCode = 1
  })

const frontier = program
  .command('frontier')
  .description('verify public frontier proof metadata without running frontier models')

frontier
  .command('verify')
  .description('fail closed unless public proof metadata satisfies the configured frontier quorum')
  .argument('<proof>', 'path to public frontier proof metadata JSON')
  .option('--contract <path>', 'path to a release contract JSON carrying scenarioSetHash and claimGate')
  .option('--scenario-set-hash <hash>', 'expected scenario-set hash (overrides proof metadata)')
  .option('--hash-schema-version <version>', 'expected scenario-set hash schema version (default: contract or proof)')
  .option('--provider <id>', 'configured provider id; repeat or pass comma-separated ids', collectCsv, [])
  .option('--quorum <n>', 'required verified provider-cell count (default: proof quorum or governed 2)', parseIntSafe)
  .option('--max-proof-age-days <n>', 'fail if proof generatedAt is older than this many days', parseIntSafe)
  .option('--json', 'output the verification result as JSON')
  .action(async (proofPath: string, opts: FrontierVerifyOptions) => {
    const proof = JSON.parse(await readFile(proofPath, 'utf8')) as unknown
    const contract = opts.contract
      ? readFrontierContractMetadata(JSON.parse(await readFile(opts.contract, 'utf8')) as unknown)
      : undefined

    const result = verifyFrontierQuorum(proof, {
      ...(contract ?? {}),
      ...(opts.scenarioSetHash ? { scenarioSetHash: opts.scenarioSetHash } : {}),
      ...(opts.hashSchemaVersion ? { hashSchemaVersion: opts.hashSchemaVersion } : {}),
      ...(opts.provider.length > 0 ? { providers: opts.provider } : {}),
      ...(opts.quorum !== undefined ? { requiredCount: opts.quorum } : {}),
      ...(opts.maxProofAgeDays !== undefined ? { maxProofAgeDays: opts.maxProofAgeDays } : {}),
    })

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2))
    } else if (result.ok) {
      console.log(formatFrontierVerificationResult(result))
    } else {
      process.stderr.write(`${formatFrontierVerificationResult(result)}\n`)
    }

    if (!result.ok) process.exitCode = 1
  })

await program.parseAsync(process.argv)

interface BuildRunRecordOptions {
  runId: string
  dataset: Dataset
  scenarioSetHash: string
  scenarioSetIdentity: ReturnType<typeof computeScenarioSetIdentity>
  runners: Runner[]
  createdAt: string
  responses: ModelResponse[]
  scores: Score[]
  multiTurnResults: MultiTurnRunLedgerMetadata[]
  multiTurnScenarioCount: number
  aggregateOptions: RunLedgerAggregateOptions
}

function buildRunRecord(options: BuildRunRecordOptions): RunRecord {
  const confidence = options.aggregateOptions.confidence
  const aggregates = aggregate(
    options.scores,
    confidence.enabled
      ? {
          confidence: {
            method: 'bootstrap',
            iterations: confidence.iterations,
            confidenceLevel: confidence.confidenceLevel,
            seed: confidence.seed,
          },
          responses: options.responses,
          sliceMetadataByScenario: sliceMetadataByScenario(options.dataset),
        }
      : {
          responses: options.responses,
          sliceMetadataByScenario: sliceMetadataByScenario(options.dataset),
        },
  )

  return {
    id: options.runId,
    dataset: { name: options.dataset.name, version: options.dataset.version },
    scenarioSetHash: options.scenarioSetHash,
    scenarioSetHashSchemaVersion: options.scenarioSetIdentity.hashSchemaVersion,
    ...(options.scenarioSetIdentity.metadata
      ? { scenarioSetHashMetadata: options.scenarioSetIdentity.metadata }
      : {}),
    runners: options.runners.map((r) => r.id),
    createdAt: options.createdAt,
    responses: options.responses,
    scores: options.scores,
    aggregates,
    meta: {
      harnessVersion: pkg.version,
      commandLine: redactCommandLine(process.argv.slice(1)),
      scenarioSetHashMetadata: {
        schemaVersion: 'assay-harness.scenario-set-hash.v1',
        scenarioSetHash: options.scenarioSetHash,
        scenarioCount: options.dataset.scenarios.length,
        singleTurnScenarioCount: options.dataset.scenarios.length - options.multiTurnScenarioCount,
        multiTurnScenarioCount: options.multiTurnScenarioCount,
      },
      ...(options.multiTurnResults.length > 0
        ? {
            multiTurn: {
              graderVersion: PERSISTENCE_GRADER_VERSION,
              results: options.multiTurnResults,
            },
          }
        : {}),
    },
  }
}

async function runSingleTurnForRecord(
  runner: Runner,
  scenario: Dataset['scenarios'][number],
  runnerOpts: RunnerOptions,
  llmJudge: LLMJudgeExecutor | undefined,
): Promise<ScenarioRunLedgerOutcome> {
  assertNotEnvironmentScenario(scenario)
  assertSingleTurn(scenario)
  const response = await runner.run(scenario, runnerOpts)
  const scenarioScores = await score(response, scenario, llmJudge ? { llmJudge } : {})
  return {
    responses: [response],
    scores: scenarioScores,
    latencyMs: response.meta.latencyMs,
  }
}

async function runMultiTurnForRecord(
  runner: Runner,
  scenario: MultiTurnScenario,
  runnerOpts: RunnerOptions,
): Promise<ScenarioRunLedgerOutcome> {
  const result = await runMultiTurn(runner, scenario, runnerOpts)
  const response = collapseMultiTurnResponse(result)
  const scores = scoreMultiTurnResult(result, scenario)
  const meta: MultiTurnRunLedgerMetadata = {
    scenarioId: scenario.id,
    runnerId: runner.id,
    value: result.value,
    graderVersion: result.graderVersion,
    turnObservations: result.turns,
    persistence: result.persistence,
    turnResponseScenarioIds: result.responses.map((turnResponse) => turnResponse.scenarioId),
  }

  return {
    responses: [response],
    scores,
    latencyMs: response.meta.latencyMs,
    multiTurn: meta,
  }
}

function collapseMultiTurnResponse(result: MultiTurnResult): ModelResponse {
  const lastResponse = result.responses[result.responses.length - 1]
  const latencyMs = result.responses.reduce(
    (sum, response) => sum + response.meta.latencyMs,
    0,
  )
  const turnResponseScenarioIds = result.responses.map((response) => response.scenarioId)
  const turnObservations = result.turns
  const persistence = result.persistence

  return {
    runnerId: result.runnerId,
    scenarioId: result.scenarioId,
    output: result.turns[result.turns.length - 1]?.assistantText ?? '',
    meta: {
      provider: lastResponse?.meta.provider ?? 'unknown',
      model: lastResponse?.meta.model ?? 'unknown',
      ...(lastResponse?.meta.version ? { version: lastResponse.meta.version } : {}),
      accessedAt: lastResponse?.meta.accessedAt ?? new Date().toISOString(),
      ...(lastResponse?.meta.temperature !== undefined
        ? { temperature: lastResponse.meta.temperature }
        : {}),
      ...(lastResponse?.meta.seed !== undefined ? { seed: lastResponse.meta.seed } : {}),
      latencyMs,
      extra: {
        ...(lastResponse?.meta.extra ?? {}),
        multiTurn: {
          graderVersion: result.graderVersion,
          turnObservations,
          persistence,
          turnResponseScenarioIds,
        },
      },
    },
  }
}

function scoreMultiTurnResult(
  result: MultiTurnResult,
  scenario: MultiTurnScenario,
): Score[] {
  const passed = result.persistence.filter((item) => item.verdict === 'pass').length
  const total = result.persistence.length
  const rationale = `${result.graderVersion}: ${passed}/${total} persistence criteria passed`

  return scenario.axes.map((axis) => ({
    runnerId: result.runnerId,
    scenarioId: scenario.id,
    axis,
    value: result.value,
    rationale,
    claimStatus: 'programmatic',
  }))
}

function parseIntSafe(value: string): number {
  const n = Number.parseInt(value, 10)
  if (Number.isNaN(n)) throw new Error(`expected integer, got "${value}"`)
  return n
}

function collectCsv(value: string, previous: string[]): string[] {
  return [...previous, ...value.split(',').map((item) => item.trim()).filter(Boolean)]
}

interface ScenarioSetIdentityCliOptions {
  hashSchemaVersion?: string
  domain?: string
  pluginId?: string
  pluginVersion?: string
  pluginUri?: string
  implementationFingerprint?: string[]
  scorerFingerprint?: string[]
}

function computeScenarioSetIdentity(
  dataset: Dataset,
  opts: ScenarioSetIdentityCliOptions,
): {
  hashSchemaVersion: 'v1' | 'v2'
  scenarioSetHash: string
  metadata?: RunRecord['scenarioSetHashMetadata']
} {
  const identity = computeScenarioSetHashBySchema(dataset, {
    hashSchemaVersion: opts.hashSchemaVersion ?? 'v1',
    ...(opts.domain ? { domain: opts.domain } : {}),
    ...(opts.pluginId
      ? {
          plugin: {
            id: opts.pluginId,
            ...(opts.pluginVersion ? { version: opts.pluginVersion } : {}),
            ...(opts.pluginUri ? { uri: opts.pluginUri } : {}),
          },
        }
      : {}),
    implementationFingerprints: (opts.implementationFingerprint ?? []).map(parseFingerprintSpec),
    scorerFingerprints: (opts.scorerFingerprint ?? []).map(parseFingerprintSpec),
  })
  if (identity.hashSchemaVersion === 'v2') {
    return {
      hashSchemaVersion: 'v2',
      scenarioSetHash: identity.scenarioSetHash,
      metadata: identity.metadata,
    }
  }
  return {
    hashSchemaVersion: 'v1',
    scenarioSetHash: identity.scenarioSetHash,
  }
}

function parseFingerprintSpec(value: string): ScenarioSetFingerprint {
  const [withoutDigest, digest] = splitOnce(value.trim(), '#')
  const [id, version] = splitOnce(withoutDigest, '@')
  if (!id) throw new Error(`fingerprint spec "${value}" is missing an id`)
  return {
    id,
    ...(version ? { version } : {}),
    ...(digest ? { digest } : {}),
  }
}

function splitOnce(value: string, separator: string): [string, string | undefined] {
  const index = value.indexOf(separator)
  if (index === -1) return [value, undefined]
  return [value.slice(0, index), value.slice(index + separator.length)]
}

async function resolveCliLLMJudge(opts: RunOptions): Promise<LLMJudgeExecutor | undefined> {
  if (opts.llmJudgeAdapter && opts.llmJudgeRunner) {
    throw new Error('configure either --llm-judge-adapter or --llm-judge-runner, not both')
  }
  const common = {
    ...(opts.llmJudgeRubricVersion ? { rubricVersion: opts.llmJudgeRubricVersion } : {}),
  }
  if (opts.llmJudgeAdapter) {
    const adapter = await loadLLMJudgeAdapterFromModule(opts.llmJudgeAdapter)
    return createLLMJudgeExecutor({ adapter, ...common })
  }
  if (opts.llmJudgeRunner) {
    return createRunnerBackedLLMJudgeExecutor(resolveRunner(opts.llmJudgeRunner), common)
  }
  return undefined
}

interface RunOptions {
  dataset: string
  runner: string | string[]
  out: string
  runId?: string
  ledger?: string
  resume?: boolean
  traceDir?: string
  traceVisibility: string
  traceRawOutput: string
  temperature: number
  seed?: number
  concurrency: number
  cacheJudges?: boolean
  cacheTtl?: number
  judgeCacheDir?: string
  llmJudgeRunner?: string
  llmJudgeAdapter?: string
  llmJudgeRubricVersion?: string
  contractHash?: string
  hashSchemaVersion: string
  domain?: string
  pluginId?: string
  pluginVersion?: string
  pluginUri?: string
  implementationFingerprint: string[]
  scorerFingerprint: string[]
  ciIterations: number
  ciLevel: number
  ciSeed: number
  /** commander sets this to `false` when `--no-ci` is passed. */
  ci?: boolean
  leaderboardEligible?: boolean
}

interface HumanValidateOptions {
  json?: boolean
}

interface HumanAdjudicateOptions {
  decisions: string
  out: string
}

interface HumanExportPairsOptions {
  out?: string
}

interface ValidateOptions {
  dataset?: string
  json?: boolean
}

interface ContractOptions {
  expectHash?: string
  hashSchemaVersion: string
  domain?: string
  pluginId?: string
  pluginVersion?: string
  pluginUri?: string
  implementationFingerprint: string[]
  scorerFingerprint: string[]
  json?: boolean
}

interface CompareCliOptions {
  json?: boolean
  ciIterations: number
  ciLevel: number
  ciSeed: number
}

interface DiagnosticsOptions {
  run?: string
  trainingPrompts?: string
  requiredOutcome: string[]
  requiredLane: string[]
  laneKey: string[]
  leakageNgramSize?: number
  leakageThreshold?: number
  nearDuplicateNgramSize?: number
  nearDuplicateThreshold?: number
  releaseDoc?: string[]
  releaseArtifact?: string[]
  genericAdversarialProbes?: boolean
  plugin?: string[]
  claimBlockDocDrift?: boolean
  claimBlockRubricAmbiguity?: boolean
  json?: boolean
  failOnClaimBlocking?: boolean
}

interface PublishOptions {
  to: string
  dataset?: string
  contractHash?: string
  leaderboardEligible?: boolean
  claimCard?: string
}

interface ExportOptions {
  format: string
  dataset?: string
  out?: string
  passThreshold: number
}

interface ProofBuildOptions {
  run: string
  contract: string
  dataset?: string
  traceBundle?: string
  out?: string
}

interface ProofVerifyOptions {
  run: string
  contract: string
  dataset?: string
  claimCard?: string
  traceBundle?: string
  leaderboardEligible?: boolean
  json?: boolean
}

interface ProofReplayOptions {
  run: string
  contract: string
  dataset: string
  proof?: string
  traceBundle?: string
  json?: boolean
}

interface FrontierVerifyOptions {
  contract?: string
  scenarioSetHash?: string
  hashSchemaVersion?: string
  provider: string[]
  quorum?: number
  maxProofAgeDays?: number
  json?: boolean
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

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value]
}

function parseThreshold(value: string): number {
  const threshold = Number.parseFloat(value)
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error(`expected threshold from 0 to 1, got "${value}"`)
  }
  return threshold
}

function renderInteropExport(
  record: RunRecord,
  dataset: Dataset | undefined,
  opts: ExportOptions,
): string {
  const format = parseInteropFormat(opts.format)
  const exportOptions = { passThreshold: opts.passThreshold }
  switch (format) {
    case 'portable':
      return `${JSON.stringify(exportPortableRunRecord(record, dataset, exportOptions), null, 2)}\n`
    case 'jsonl':
      return exportResultJsonl(record, dataset, exportOptions)
    case 'junit':
      return exportJUnitXml(record, dataset, exportOptions)
    case 'github-annotations':
      return exportGitHubActionsAnnotations(record, dataset, exportOptions)
    case 'experiment-store':
      return `${JSON.stringify(exportExperimentStoreRecords(record, dataset, exportOptions), null, 2)}\n`
  }
}

function parseInteropFormat(value: string): InteroperabilityFormat {
  const allowed: InteroperabilityFormat[] = [
    'portable',
    'jsonl',
    'junit',
    'github-annotations',
    'experiment-store',
  ]
  if ((allowed as string[]).includes(value)) return value as InteroperabilityFormat
  throw new Error(
    `unsupported export format "${value}"; expected ${allowed.join(', ')}`,
  )
}

async function writeTextOutput(path: string | undefined, content: string): Promise<void> {
  if (!path || path === '-') {
    process.stdout.write(content)
    return
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf8')
  console.log(`wrote ${path}`)
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

async function readTrainingPrompts(path: string): Promise<string[]> {
  const raw = await readFile(path, 'utf8')
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) return parsed.filter((value): value is string => typeof value === 'string')
    if (isPlainObject(parsed) && Array.isArray(parsed['prompts'])) {
      return parsed['prompts'].filter((value): value is string => typeof value === 'string')
    }
  } catch {
    // Fall through to newline-delimited text. This keeps the CLI useful with
    // exported prompt lists without requiring a wrapper JSON shape.
  }
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

async function readReleaseDocuments(paths: string[]): Promise<ReleaseDiagnosticDocument[]> {
  return Promise.all(paths.map(async (path) => ({
    path,
    content: await readFile(path, 'utf8'),
  })))
}

async function readReleaseArtifacts(paths: string[]): Promise<ReleaseDiagnosticArtifact[]> {
  return Promise.all(paths.map(async (path) => ({
    path,
    data: JSON.parse(await readFile(path, 'utf8')) as unknown,
  })))
}

async function loadDiagnosticPlugins(paths: string[]): Promise<ScenarioDiagnosticsPlugin[]> {
  const plugins: ScenarioDiagnosticsPlugin[] = []
  for (const pluginPath of paths) {
    const moduleUrl = pathToFileURL(resolve(pluginPath)).href
    const mod = (await import(moduleUrl)) as Record<string, unknown>
    plugins.push(...normaliseDiagnosticPlugins(mod['default'], pluginPath))
    plugins.push(...normaliseDiagnosticPlugins(mod['plugin'], pluginPath))
    plugins.push(...normaliseDiagnosticPlugins(mod['plugins'], pluginPath))
  }
  return dedupePlugins(plugins)
}

function normaliseDiagnosticPlugins(value: unknown, source: string): ScenarioDiagnosticsPlugin[] {
  if (value === undefined) return []
  const candidates = Array.isArray(value) ? value : [value]
  return candidates.map((candidate) => {
    if (!isDiagnosticPlugin(candidate)) {
      throw new Error(
        `diagnostics plugin "${source}" must export a plugin object with string id and a run(context) ` +
          `or generateAdversarialProbes(context) function`,
      )
    }
    return candidate
  })
}

function isDiagnosticPlugin(value: unknown): value is ScenarioDiagnosticsPlugin {
  return (
    isPlainObject(value) &&
    typeof value['id'] === 'string' &&
    (typeof value['run'] === 'function' || typeof value['generateAdversarialProbes'] === 'function')
  )
}

function dedupePlugins(plugins: ScenarioDiagnosticsPlugin[]): ScenarioDiagnosticsPlugin[] {
  const seen = new Set<string>()
  const deduped: ScenarioDiagnosticsPlugin[] = []
  for (const plugin of plugins) {
    if (seen.has(plugin.id)) continue
    seen.add(plugin.id)
    deduped.push(plugin)
  }
  return deduped
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertPublishContract(
  record: RunRecord,
  opts: { dataset?: Dataset, contractHash?: string },
): void {
  const errors: string[] = []

  if (opts.dataset) {
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
    if (record.scenarioSetHashSchemaVersion === 'v2') {
      const metadata = record.scenarioSetHashMetadata
      if (!metadata || metadata.hashSchemaVersion !== 'v2') {
        errors.push('RunRecord.scenarioSetHashMetadata v2 is required when validating v2 publish output')
      } else {
        if (metadata.dataset.name !== opts.dataset.name) {
          errors.push('RunRecord.scenarioSetHashMetadata.dataset.name does not match supplied dataset')
        }
        if (metadata.dataset.version !== opts.dataset.version) {
          errors.push('RunRecord.scenarioSetHashMetadata.dataset.version does not match supplied dataset')
        }
        if (metadata.scenarioCount !== opts.dataset.scenarios.length) {
          errors.push('RunRecord.scenarioSetHashMetadata.scenarioCount does not match supplied dataset')
        }
      }
      if (opts.contractHash) {
        errors.push(...scenarioSetHashErrors(record, opts.contractHash, 'declared contract hash'))
      }
    } else {
      const scenarioSetHash = opts.contractHash
        ? assertScenarioSetHashMatches(opts.dataset, opts.contractHash)
        : computeScenarioSetHash(opts.dataset)
      errors.push(...scenarioSetHashErrors(record, scenarioSetHash, 'dataset hash'))
    }
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

function emitCompareWarnings(warnings: string[]): void {
  for (const warning of warnings) {
    process.stderr.write(`warning: ${warning}\n`)
  }
}

function sliceMetadataByScenario(dataset: Dataset): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    dataset.scenarios.map((scenario) => [
      scenario.id,
      isRecord(scenario.meta?.['slices']) ? scenario.meta['slices'] : {},
    ]),
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertLeaderboardEligiblePublish(
  record: RunRecord,
  opts: { dataset?: Dataset, claimCard?: ClaimCard },
): void {
  if (!opts.dataset) {
    throw new Error(
      'leaderboard-eligible publish requires --dataset so outcome-type stratification can be verified',
    )
  }
  try {
    assertRunClaimEligible(record, opts)
  } catch (err) {
    if (err instanceof ClaimEligibilityError) throw new Error(err.message)
    throw err
  }
}
