import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { aggregate } from './aggregator.js'
import { canonicalJson, checksumObject } from './proof.js'
import { isMultiTurnScenario } from './runners/multi-turn.js'
import { TRACE_INDEX_SCHEMA_VERSION } from './traces.js'
import type {
  Dataset,
  ModelResponse,
  RunLedgerAggregateOptions,
  RunLedgerCell,
  RunLedgerCompletedCell,
  RunLedgerError,
  RunLedgerFailedCell,
  RunLedgerHeader,
  RunnerOptions,
  RunRecord,
  ScenarioRunLedgerOutcome,
  ScenarioSetHashMetadata,
  ScenarioSetHashSchemaVersion,
  Score,
  TraceBundleReference,
} from './types.js'

export const RUN_LEDGER_SCHEMA_VERSION = 'assay.run-ledger.v1' as const

export interface CreateRunLedgerHeaderOptions {
  runId: string
  dataset: Pick<Dataset, 'name' | 'version'>
  scenarioSetHash: string
  scenarioSetHashSchemaVersion: ScenarioSetHashSchemaVersion
  scenarioSetHashMetadata?: ScenarioSetHashMetadata
  runnerIds: string[]
  runnerOptions: RunnerOptions
  aggregate: RunLedgerAggregateOptions
  tracePolicy?: RunLedgerHeader['tracePolicy']
  harnessVersion: string
  commandLine?: string
  createdAt?: string
}

export interface RunLedgerState {
  path: string
  header: RunLedgerHeader
  entries: RunLedgerCell[]
  latestByCell: Map<string, RunLedgerCell>
}

export interface RunLedgerWriterOptions {
  resume?: boolean
}

export interface AppendCompletedCellOptions {
  scenarioId: string
  runnerId: string
  startedAt: string
  completedAt: string
  outcome: ScenarioRunLedgerOutcome
  trace?: TraceBundleReference
}

export interface AppendFailedCellOptions {
  scenarioId: string
  runnerId: string
  startedAt: string
  completedAt: string
  error: unknown
}

export class RunLedgerMismatchError extends Error {
  readonly errors: string[]

  constructor(errors: string[]) {
    super(`ledger resume mismatch:\n${errors.map((error) => `  - ${error}`).join('\n')}`)
    this.name = 'RunLedgerMismatchError'
    this.errors = errors
  }
}

export class RunLedgerIncompleteError extends Error {
  readonly missingCells: string[]

  constructor(missingCells: string[]) {
    super(`run ledger is incomplete; missing completed cells: ${missingCells.join(', ')}`)
    this.name = 'RunLedgerIncompleteError'
    this.missingCells = missingCells
  }
}

export class RunLedgerWriter {
  private appendQueue: Promise<void> = Promise.resolve()

  private constructor(
    readonly path: string,
    private readonly currentState: RunLedgerState,
  ) {}

  static async open(
    path: string,
    expectedHeader: RunLedgerHeader,
    options: RunLedgerWriterOptions = {},
  ): Promise<RunLedgerWriter> {
    const existing = await readRunLedger(path)
    if (existing) {
      if (!options.resume) {
        throw new Error(`run ledger already exists at ${path}; pass --resume to continue it`)
      }
      validateResumeLedger(existing.header, expectedHeader)
      return new RunLedgerWriter(path, existing)
    }

    if (options.resume) {
      throw new Error(`cannot resume run ledger at ${path}: file does not exist`)
    }

    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${canonicalJson(expectedHeader)}\n`, 'utf8')
    return new RunLedgerWriter(path, {
      path,
      header: expectedHeader,
      entries: [],
      latestByCell: new Map(),
    })
  }

  get state(): RunLedgerState {
    return this.currentState
  }

  completedCell(runnerId: string, scenarioId: string): RunLedgerCompletedCell | undefined {
    const cell = this.currentState.latestByCell.get(cellKey(runnerId, scenarioId))
    return cell?.status === 'completed' ? cell : undefined
  }

  async appendCompletedCell(options: AppendCompletedCellOptions): Promise<RunLedgerCompletedCell> {
    const cell: RunLedgerCompletedCell = {
      schemaVersion: RUN_LEDGER_SCHEMA_VERSION,
      type: 'cell',
      runId: this.currentState.header.runId,
      scenarioId: options.scenarioId,
      runnerId: options.runnerId,
      runnerOptionsHash: this.currentState.header.runnerOptionsHash,
      startedAt: options.startedAt,
      completedAt: options.completedAt,
      status: 'completed',
      outcome: options.outcome,
      ...(options.trace ? { trace: options.trace } : {}),
    }
    await this.appendEntry(cell)
    return cell
  }

  async appendFailedCell(options: AppendFailedCellOptions): Promise<RunLedgerFailedCell> {
    const cell: RunLedgerFailedCell = {
      schemaVersion: RUN_LEDGER_SCHEMA_VERSION,
      type: 'cell',
      runId: this.currentState.header.runId,
      scenarioId: options.scenarioId,
      runnerId: options.runnerId,
      runnerOptionsHash: this.currentState.header.runnerOptionsHash,
      startedAt: options.startedAt,
      completedAt: options.completedAt,
      status: 'failed',
      error: serialiseError(options.error),
    }
    await this.appendEntry(cell)
    return cell
  }

  private async appendEntry(cell: RunLedgerCell): Promise<void> {
    this.appendQueue = this.appendQueue.then(async () => {
      await appendFile(this.path, `${canonicalJson(cell)}\n`, 'utf8')
      this.currentState.entries.push(cell)
      this.currentState.latestByCell.set(cellKey(cell.runnerId, cell.scenarioId), cell)
    })
    await this.appendQueue
  }
}

export function createRunLedgerHeader(
  options: CreateRunLedgerHeaderOptions,
): RunLedgerHeader {
  return {
    schemaVersion: RUN_LEDGER_SCHEMA_VERSION,
    type: 'header',
    runId: options.runId,
    dataset: {
      name: options.dataset.name,
      version: options.dataset.version,
    },
    scenarioSetHash: options.scenarioSetHash,
    scenarioSetHashSchemaVersion: options.scenarioSetHashSchemaVersion,
    ...(options.scenarioSetHashMetadata
      ? { scenarioSetHashMetadata: options.scenarioSetHashMetadata }
      : {}),
    runnerIds: [...options.runnerIds],
    runnerOptions: normaliseRunnerOptions(options.runnerOptions),
    runnerOptionsHash: computeRunnerOptionsHash(options.runnerOptions),
    aggregate: options.aggregate,
    ...(options.tracePolicy ? { tracePolicy: options.tracePolicy } : {}),
    harnessVersion: options.harnessVersion,
    ...(options.commandLine ? { commandLine: options.commandLine } : {}),
    createdAt: options.createdAt ?? new Date().toISOString(),
  }
}

export function computeRunnerOptionsHash(options: RunnerOptions): string {
  return checksumObject(normaliseRunnerOptions(options))
}

export function normaliseRunnerOptions(options: RunnerOptions): RunnerOptions {
  return {
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.extra !== undefined ? { extra: options.extra } : {}),
  }
}

export async function readRunLedger(path: string): Promise<RunLedgerState | null> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null
    throw error
  }

  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) {
    throw new Error(`run ledger ${path} is empty`)
  }

  const header = parseLedgerLine(lines[0], path, 1)
  if (!isRunLedgerHeader(header)) {
    throw new Error(`run ledger ${path} line 1 must be an ${RUN_LEDGER_SCHEMA_VERSION} header`)
  }

  const entries: RunLedgerCell[] = []
  const latestByCell = new Map<string, RunLedgerCell>()
  for (let i = 1; i < lines.length; i++) {
    const parsed = parseLedgerLine(lines[i], path, i + 1)
    if (!isRunLedgerCell(parsed)) {
      throw new Error(`run ledger ${path} line ${i + 1} must be an ${RUN_LEDGER_SCHEMA_VERSION} cell`)
    }
    if (parsed.runId !== header.runId) {
      throw new Error(
        `run ledger ${path} line ${i + 1} has runId "${parsed.runId}" but header runId is "${header.runId}"`,
      )
    }
    entries.push(parsed)
    latestByCell.set(cellKey(parsed.runnerId, parsed.scenarioId), parsed)
  }

  return { path, header, entries, latestByCell }
}

export function validateResumeLedger(
  existing: RunLedgerHeader,
  expected: RunLedgerHeader,
): void {
  const errors: string[] = []
  if (existing.runId !== expected.runId) {
    errors.push(`run id changed from "${existing.runId}" to "${expected.runId}"`)
  }
  if (existing.dataset.name !== expected.dataset.name || existing.dataset.version !== expected.dataset.version) {
    errors.push(
      `dataset changed from ${existing.dataset.name} v${existing.dataset.version} ` +
        `to ${expected.dataset.name} v${expected.dataset.version}`,
    )
  }
  if (existing.scenarioSetHash !== expected.scenarioSetHash) {
    errors.push(
      `dataset hash changed from "${existing.scenarioSetHash}" to "${expected.scenarioSetHash}"`,
    )
  }
  if (existing.scenarioSetHashSchemaVersion !== expected.scenarioSetHashSchemaVersion) {
    errors.push(
      `dataset hash schema changed from "${existing.scenarioSetHashSchemaVersion}" ` +
        `to "${expected.scenarioSetHashSchemaVersion}"`,
    )
  }
  if (canonicalJson(existing.runnerIds) !== canonicalJson(expected.runnerIds)) {
    errors.push(
      `runner ids changed from ${canonicalJson(existing.runnerIds)} to ${canonicalJson(expected.runnerIds)}`,
    )
  }
  if (existing.runnerOptionsHash !== expected.runnerOptionsHash) {
    errors.push(
      `runner options changed from ${existing.runnerOptionsHash} to ${expected.runnerOptionsHash}`,
    )
  } else if (canonicalJson(existing.runnerOptions) !== canonicalJson(expected.runnerOptions)) {
    errors.push('runner options canonical payload changed despite matching hash')
  }
  if (canonicalJson(existing.aggregate) !== canonicalJson(expected.aggregate)) {
    errors.push('aggregate options changed')
  }
  if (canonicalJson(existing.tracePolicy ?? null) !== canonicalJson(expected.tracePolicy ?? null)) {
    errors.push('trace policy changed')
  }

  if (errors.length > 0) throw new RunLedgerMismatchError(errors)
}

export function rebuildRunRecordFromLedger(
  state: RunLedgerState,
  options: { dataset: Dataset },
): RunRecord {
  const responses: ModelResponse[] = []
  const scores: Score[] = []
  const multiTurnResults: NonNullable<RunRecord['meta']['multiTurn']>['results'] = []
  const traces: TraceBundleReference[] = []
  const missingCells: string[] = []

  for (const runnerId of state.header.runnerIds) {
    for (const scenario of options.dataset.scenarios) {
      const cell = state.latestByCell.get(cellKey(runnerId, scenario.id))
      if (!cell || cell.status !== 'completed') {
        missingCells.push(`${runnerId}/${scenario.id}`)
        continue
      }
      responses.push(...cell.outcome.responses)
      scores.push(...cell.outcome.scores)
      if (cell.outcome.multiTurn) multiTurnResults.push(cell.outcome.multiTurn)
      if (cell.trace) traces.push(cell.trace)
    }
  }

  if (missingCells.length > 0) throw new RunLedgerIncompleteError(missingCells)

  const confidence = state.header.aggregate.confidence
  const aggregates = aggregate(
    scores,
    confidence.enabled
      ? {
          confidence: {
            method: 'bootstrap',
            iterations: confidence.iterations,
            confidenceLevel: confidence.confidenceLevel,
            seed: confidence.seed,
          },
          responses,
          sliceMetadataByScenario: sliceMetadataByScenario(options.dataset),
        }
      : {
          responses,
          sliceMetadataByScenario: sliceMetadataByScenario(options.dataset),
        },
  )
  const failedCells = state.entries.filter((entry) => entry.status === 'failed').length
  const completedCells = state.entries.filter((entry) => entry.status === 'completed').length
  const multiTurnScenarioCount = options.dataset.scenarios.filter((scenario) =>
    isMultiTurnScenario(scenario),
  ).length

  return {
    id: state.header.runId,
    dataset: { name: state.header.dataset.name, version: state.header.dataset.version },
    scenarioSetHash: state.header.scenarioSetHash,
    scenarioSetHashSchemaVersion: state.header.scenarioSetHashSchemaVersion,
    ...(state.header.scenarioSetHashMetadata
      ? { scenarioSetHashMetadata: state.header.scenarioSetHashMetadata }
      : {}),
    runners: [...state.header.runnerIds],
    createdAt: state.header.createdAt,
    responses,
    scores,
    aggregates,
    meta: {
      harnessVersion: state.header.harnessVersion,
      ...(state.header.commandLine ? { commandLine: state.header.commandLine } : {}),
      scenarioSetHashMetadata: {
        schemaVersion: 'assay-harness.scenario-set-hash.v1',
        scenarioSetHash: state.header.scenarioSetHash,
        scenarioCount: options.dataset.scenarios.length,
        singleTurnScenarioCount: options.dataset.scenarios.length - multiTurnScenarioCount,
        multiTurnScenarioCount,
      },
      ...(multiTurnResults.length > 0
        ? {
            multiTurn: {
              graderVersion: String(multiTurnResults[0]?.graderVersion ?? 'unknown'),
              results: multiTurnResults,
            },
          }
        : {}),
      runLedger: {
        schemaVersion: RUN_LEDGER_SCHEMA_VERSION,
        runId: state.header.runId,
        completedCells,
        failedCells,
      },
      ...(traces.length > 0
        ? {
            traceBundles: {
              schemaVersion: TRACE_INDEX_SCHEMA_VERSION,
              visibility: state.header.tracePolicy?.visibility ?? traces[0]?.visibility ?? 'public',
              rawOutputPolicy: state.header.tracePolicy?.rawOutputPolicy ?? traces[0]?.rawOutputPolicy ?? 'omit',
              bundles: traces,
            },
          }
        : {}),
    },
  }
}

function serialiseError(error: unknown): RunLedgerError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    }
  }
  return {
    name: 'Error',
    message: String(error),
  }
}

function parseLedgerLine(line: string, path: string, lineNumber: number): unknown {
  try {
    return JSON.parse(line) as unknown
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`run ledger ${path} line ${lineNumber} is not valid JSON: ${message}`)
  }
}

function isRunLedgerHeader(value: unknown): value is RunLedgerHeader {
  return isRecord(value) &&
    value['schemaVersion'] === RUN_LEDGER_SCHEMA_VERSION &&
    value['type'] === 'header' &&
    typeof value['runId'] === 'string' &&
    isRecord(value['dataset']) &&
    typeof value['scenarioSetHash'] === 'string' &&
    (value['scenarioSetHashSchemaVersion'] === 'v1' || value['scenarioSetHashSchemaVersion'] === 'v2') &&
    Array.isArray(value['runnerIds']) &&
    value['runnerIds'].every((runnerId) => typeof runnerId === 'string') &&
    isRecord(value['runnerOptions']) &&
    typeof value['runnerOptionsHash'] === 'string' &&
    isRecord(value['aggregate']) &&
    typeof value['harnessVersion'] === 'string' &&
    typeof value['createdAt'] === 'string'
}

function isRunLedgerCell(value: unknown): value is RunLedgerCell {
  if (!isRecord(value)) return false
  if (value['schemaVersion'] !== RUN_LEDGER_SCHEMA_VERSION || value['type'] !== 'cell') return false
  if (typeof value['runId'] !== 'string') return false
  if (typeof value['scenarioId'] !== 'string' || typeof value['runnerId'] !== 'string') return false
  if (typeof value['runnerOptionsHash'] !== 'string') return false
  if (typeof value['startedAt'] !== 'string' || typeof value['completedAt'] !== 'string') return false
  if (value['status'] === 'completed') return isRecord(value['outcome'])
  if (value['status'] === 'failed') return isRecord(value['error'])
  return false
}

function sliceMetadataByScenario(dataset: Dataset): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    dataset.scenarios.map((scenario) => [
      scenario.id,
      isRecord(scenario.meta?.['slices']) ? scenario.meta['slices'] : {},
    ]),
  )
}

function cellKey(runnerId: string, scenarioId: string): string {
  return `${runnerId}\u0000${scenarioId}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
