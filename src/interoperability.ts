import type {
  Dataset,
  ModelAggregate,
  ModelResponse,
  RunRecord,
  Scenario,
  Score,
} from './types.js'

export const PORTABLE_RUN_EXPORT_SCHEMA_VERSION = 'assay.portable-run.v1' as const
export const RESULT_JSONL_SCHEMA_VERSION = 'assay.result-jsonl.v1' as const
export const JUNIT_EXPORT_SCHEMA_VERSION = 'assay.junit-export.v1' as const
export const GITHUB_ANNOTATIONS_SCHEMA_VERSION = 'assay.github-annotations.v1' as const
export const EXPERIMENT_STORE_SCHEMA_VERSION = 'assay.experiment-store.v1' as const

export type InteroperabilityFormat =
  | 'portable'
  | 'jsonl'
  | 'junit'
  | 'github-annotations'
  | 'experiment-store'

export interface InteroperabilityLossinessNote {
  code: string
  detail: string
}

export interface InteroperabilityReference {
  kind: 'trace' | 'proof'
  ref: string
  path: string
  scenarioId?: string
  runnerId?: string
  schemaVersion?: string
}

export interface InteroperabilityExportOptions {
  /**
   * CI-oriented exports mark scores below this threshold as failing.
   * The default is strict because the harness has no corpus-generic pass rule.
   */
  passThreshold?: number
}

export interface InspectExport {
  schemaVersion?: 'assay.inspect-export.v1'
  runId: string
  dataset: RunRecord['dataset']
  samples: Array<{
    id: string
    input: string
    target: null
    metadata: {
      scenarioHash?: string
      privacy: string
      axes: string[]
    }
  }>
  lossiness?: InteroperabilityLossinessNote[]
}

export interface LmEvaluationSummary {
  schemaVersion?: 'assay.lm-evaluation-summary.v1'
  results: Record<string, Record<string, number>>
  versions: {
    harness: string
    dataset: string
  }
  lossiness?: InteroperabilityLossinessNote[]
}

export interface PortableRunExport {
  schemaVersion: typeof PORTABLE_RUN_EXPORT_SCHEMA_VERSION
  run: {
    id: string
    dataset: RunRecord['dataset']
    createdAt: string
    runners: string[]
    harnessVersion: string
    scenarioSetHash?: string
    scenarioSetHashSchemaVersion?: string
  }
  tasks: PortableTaskResult[]
  aggregates: PortableAggregateResult[]
  references: InteroperabilityReference[]
  lossiness: InteroperabilityLossinessNote[]
}

export interface PortableTaskResult {
  schemaVersion: typeof RESULT_JSONL_SCHEMA_VERSION
  kind: 'task-result'
  runId: string
  dataset: RunRecord['dataset']
  runnerId: string
  scenarioId: string
  privacy: 'public' | 'private' | 'unknown'
  sample: {
    input?: string
    output?: string
    target: null
    redaction: {
      input: 'included' | 'omitted-private' | 'omitted-missing-dataset'
      output: 'included' | 'omitted-private' | 'omitted-missing-response'
    }
    metadata: {
      axes: string[]
      scenarioHash?: string
      outcomeType?: string
    }
  }
  scores: Array<{
    axis: string
    value: number
    judge?: string
    claimStatus?: string
    sampleId?: string
    slices?: Record<string, unknown>
  }>
  meanScore: number | null
  response: {
    provider?: string
    model?: string
    version?: string
    accessedAt?: string
    latencyMs?: number
  }
  references: InteroperabilityReference[]
  lossiness: string[]
}

export interface PortableAggregateResult {
  schemaVersion: typeof RESULT_JSONL_SCHEMA_VERSION
  kind: 'aggregate'
  runId: string
  dataset: RunRecord['dataset']
  runnerId: string
  composite: number
  axes: Record<string, {
    mean: number
    variance: number
    n: number
    confidenceInterval?: ModelAggregate['axes'][string]['confidenceInterval']
  }>
  reliability?: ModelAggregate['reliability']
  operational?: ModelAggregate['operational']
  lossiness: string[]
}

export type ResultJsonlLine = PortableTaskResult | PortableAggregateResult

export interface ExperimentStoreExport {
  schemaVersion: typeof EXPERIMENT_STORE_SCHEMA_VERSION
  experiment: {
    runId: string
    dataset: RunRecord['dataset']
    createdAt: string
    harnessVersion: string
    scenarioSetHash?: string
    scenarioSetHashSchemaVersion?: string
  }
  metrics: ExperimentMetricRecord[]
  spans: ExperimentSpanRecord[]
  references: InteroperabilityReference[]
  lossiness: InteroperabilityLossinessNote[]
}

export interface ExperimentMetricRecord {
  recordType: 'metric'
  name: 'assay.score' | 'assay.aggregate.composite' | 'assay.aggregate.axis.mean'
  value: number
  runId: string
  runnerId: string
  scenarioId?: string
  axis?: string
  timestamp: string
  attributes: Record<string, unknown>
}

export interface ExperimentSpanRecord {
  recordType: 'span'
  traceId: string
  spanId: string
  parentSpanId?: string
  name: 'assay.run' | 'assay.task'
  startTime: string
  durationMs?: number
  status: 'ok' | 'error' | 'unknown'
  attributes: Record<string, unknown>
  references: InteroperabilityReference[]
}

export function exportInspectRunRecord(record: RunRecord, dataset: Dataset): InspectExport {
  const lossiness = baseLossiness(Boolean(dataset))
  return {
    schemaVersion: 'assay.inspect-export.v1',
    runId: record.id,
    dataset: record.dataset,
    samples: dataset.scenarios.map((scenario) => {
      const privacy = privacyForScenario(scenario)
      return {
        id: scenario.id,
        input: privacy === 'public'
          ? promptText(scenario)
          : '[REDACTED: private scenario prompt omitted]',
        target: null,
        metadata: {
          ...(typeof scenario.meta?.['scenarioHash'] === 'string'
            ? { scenarioHash: scenario.meta['scenarioHash'] }
            : {}),
          privacy,
          axes: scenario.axes,
        },
      }
    }),
    lossiness,
  }
}

export function exportLmEvaluationSummary(record: RunRecord): LmEvaluationSummary {
  const grouped = new Map<string, Map<string, number[]>>()
  for (const score of record.scores) {
    const taskKey = `${record.dataset.name}:${score.runnerId}`
    const byAxis = grouped.get(taskKey) ?? new Map<string, number[]>()
    const bucket = byAxis.get(score.axis) ?? []
    bucket.push(score.value)
    byAxis.set(score.axis, bucket)
    grouped.set(taskKey, byAxis)
  }

  const results: LmEvaluationSummary['results'] = {}
  for (const [taskKey, byAxis] of grouped) {
    results[taskKey] = {}
    for (const [axis, values] of byAxis) {
      results[taskKey][axis] = values.reduce((sum, value) => sum + value, 0) / values.length
    }
  }

  return {
    schemaVersion: 'assay.lm-evaluation-summary.v1',
    results,
    versions: {
      harness: record.meta.harnessVersion,
      dataset: record.dataset.version,
    },
    lossiness: [
      {
        code: 'summary-only',
        detail: 'Per-sample prompts, outputs, score rationales, and trace payloads are omitted.',
      },
    ],
  }
}

export function exportPortableRunRecord(
  record: RunRecord,
  dataset?: Dataset,
  options: InteroperabilityExportOptions = {},
): PortableRunExport {
  void options
  const context = buildContext(record, dataset)
  const tasks = buildTaskResults(context)
  return {
    schemaVersion: PORTABLE_RUN_EXPORT_SCHEMA_VERSION,
    run: {
      id: record.id,
      dataset: record.dataset,
      createdAt: record.createdAt,
      runners: record.runners,
      harnessVersion: record.meta.harnessVersion,
      ...(record.scenarioSetHash ? { scenarioSetHash: record.scenarioSetHash } : {}),
      ...(record.scenarioSetHashSchemaVersion
        ? { scenarioSetHashSchemaVersion: record.scenarioSetHashSchemaVersion }
        : {}),
    },
    tasks,
    aggregates: buildAggregateResults(record),
    references: context.references,
    lossiness: baseLossiness(Boolean(dataset)),
  }
}

export function exportResultJsonl(
  record: RunRecord,
  dataset?: Dataset,
  options: InteroperabilityExportOptions = {},
): string {
  const portable = exportPortableRunRecord(record, dataset, options)
  const lines: ResultJsonlLine[] = [...portable.tasks, ...portable.aggregates]
  return lines.map((line) => JSON.stringify(line)).join('\n') + (lines.length > 0 ? '\n' : '')
}

export function exportJUnitXml(
  record: RunRecord,
  dataset?: Dataset,
  options: InteroperabilityExportOptions = {},
): string {
  const passThreshold = options.passThreshold ?? 1
  const context = buildContext(record, dataset)
  const cases = buildTaskResults(context).flatMap((task) =>
    task.scores.map((score) => ({ task, score })),
  )
  const failures = cases.filter(({ score }) => score.value < passThreshold)
  const testsuiteAttrs = attrs({
    name: `${record.dataset.name}:${record.id}`,
    tests: String(cases.length),
    failures: String(failures.length),
    errors: '0',
    skipped: '0',
  })
  const lossinessSummary = baseLossiness(Boolean(dataset)).map((note) => note.code).join(',')
  const body = [
    `  <properties>`,
    `    <property name="schemaVersion" value="${JUNIT_EXPORT_SCHEMA_VERSION}" />`,
    `    <property name="assay.lossiness" value="${escapeXml(lossinessSummary)}" />`,
    `  </properties>`,
    ...cases.map(({ task, score }) => formatJUnitCase(task, score, passThreshold)),
  ].join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite ${testsuiteAttrs}>\n${body}\n</testsuite>\n`
}

export function exportGitHubActionsAnnotations(
  record: RunRecord,
  dataset?: Dataset,
  options: InteroperabilityExportOptions = {},
): string {
  const passThreshold = options.passThreshold ?? 1
  const context = buildContext(record, dataset)
  const tasks = buildTaskResults(context)
  const lines = [
    formatGitHubCommand(
      'notice',
      { title: 'Assay export lossiness' },
      `${GITHUB_ANNOTATIONS_SCHEMA_VERSION}: ${
        baseLossiness(Boolean(dataset)).map((note) => note.code).join(', ')
      }`,
    ),
  ]

  for (const task of tasks) {
    for (const score of task.scores) {
      if (score.value >= passThreshold) continue
      lines.push(formatGitHubCommand(
        'error',
        { title: 'Assay score below threshold' },
        [
          `run=${record.id}`,
          `dataset=${record.dataset.name}@${record.dataset.version}`,
          `runner=${task.runnerId}`,
          `scenario=${task.scenarioId}`,
          `axis=${score.axis}`,
          `score=${formatNumber(score.value)}`,
          `threshold=${formatNumber(passThreshold)}`,
          `privacy=${task.privacy}`,
          'prompt_output_boundary=public-only',
        ].join(' '),
      ))
    }
  }

  return lines.join('\n') + '\n'
}

export function exportExperimentStoreRecords(
  record: RunRecord,
  dataset?: Dataset,
  options: InteroperabilityExportOptions = {},
): ExperimentStoreExport {
  void options
  const context = buildContext(record, dataset)
  const tasks = buildTaskResults(context)
  const runSpanId = stableId('span', 'run', record.id)
  const traceId = stableId('trace', record.id)
  const spans: ExperimentSpanRecord[] = [
    {
      recordType: 'span',
      traceId,
      spanId: runSpanId,
      name: 'assay.run',
      startTime: record.createdAt,
      status: 'unknown',
      attributes: {
        datasetName: record.dataset.name,
        datasetVersion: record.dataset.version,
        runnerCount: record.runners.length,
        scenarioSetHash: record.scenarioSetHash,
        scenarioSetHashSchemaVersion: record.scenarioSetHashSchemaVersion,
      },
      references: context.references,
    },
  ]
  for (const task of tasks) {
    spans.push({
      recordType: 'span',
      traceId,
      spanId: stableId('span', 'task', record.id, task.runnerId, task.scenarioId),
      parentSpanId: runSpanId,
      name: 'assay.task',
      startTime: task.response.accessedAt ?? record.createdAt,
      ...(task.response.latencyMs !== undefined ? { durationMs: task.response.latencyMs } : {}),
      status: task.meanScore === null ? 'unknown' : 'ok',
      attributes: {
        runnerId: task.runnerId,
        scenarioId: task.scenarioId,
        privacy: task.privacy,
        provider: task.response.provider,
        model: task.response.model,
        outputIncluded: task.sample.redaction.output === 'included',
        promptIncluded: task.sample.redaction.input === 'included',
      },
      references: task.references,
    })
  }

  return {
    schemaVersion: EXPERIMENT_STORE_SCHEMA_VERSION,
    experiment: {
      runId: record.id,
      dataset: record.dataset,
      createdAt: record.createdAt,
      harnessVersion: record.meta.harnessVersion,
      ...(record.scenarioSetHash ? { scenarioSetHash: record.scenarioSetHash } : {}),
      ...(record.scenarioSetHashSchemaVersion
        ? { scenarioSetHashSchemaVersion: record.scenarioSetHashSchemaVersion }
        : {}),
    },
    metrics: buildExperimentMetrics(record, tasks),
    spans,
    references: context.references,
    lossiness: baseLossiness(Boolean(dataset)),
  }
}

interface ExportContext {
  record: RunRecord
  dataset?: Dataset
  scenarios: Map<string, Scenario>
  responses: Map<string, ModelResponse>
  scores: Map<string, Score[]>
  references: InteroperabilityReference[]
}

function buildContext(
  record: RunRecord,
  dataset: Dataset | undefined,
): ExportContext {
  return {
    record,
    dataset,
    scenarios: new Map(dataset?.scenarios.map((scenario) => [scenario.id, scenario]) ?? []),
    responses: mapResponses(record.responses),
    scores: mapScores(record.scores),
    references: extractRunReferences(record),
  }
}

function buildTaskResults(context: ExportContext): PortableTaskResult[] {
  const keys = new Map<string, { runnerId: string, scenarioId: string }>()
  for (const score of context.record.scores) {
    keys.set(taskKey(score.runnerId, score.scenarioId), {
      runnerId: score.runnerId,
      scenarioId: score.scenarioId,
    })
  }
  for (const response of context.record.responses) {
    keys.set(taskKey(response.runnerId, response.scenarioId), {
      runnerId: response.runnerId,
      scenarioId: response.scenarioId,
    })
  }

  return [...keys.values()]
    .sort((a, b) =>
      a.runnerId.localeCompare(b.runnerId) || a.scenarioId.localeCompare(b.scenarioId),
    )
    .map(({ runnerId, scenarioId }) => buildTaskResult(context, runnerId, scenarioId))
}

function buildTaskResult(
  context: ExportContext,
  runnerId: string,
  scenarioId: string,
): PortableTaskResult {
  const key = taskKey(runnerId, scenarioId)
  const scenario = context.scenarios.get(scenarioId)
  const response = context.responses.get(key)
  const scores = context.scores.get(key) ?? []
  const privacy = scenario ? privacyForScenario(scenario) : 'unknown'
  const includeInput = privacy === 'public' && Boolean(scenario)
  const includeOutput = privacy === 'public' && Boolean(response)
  const references = context.references.filter((reference) =>
    reference.scenarioId === undefined ||
    (reference.scenarioId === scenarioId &&
      (reference.runnerId === undefined || reference.runnerId === runnerId)),
  )
  const lossiness = taskLossiness({
    hasDataset: Boolean(context.dataset),
    hasScenario: Boolean(scenario),
    hasResponse: Boolean(response),
    privacy,
  })
  const values = scores.map((score) => score.value)

  return {
    schemaVersion: RESULT_JSONL_SCHEMA_VERSION,
    kind: 'task-result',
    runId: context.record.id,
    dataset: context.record.dataset,
    runnerId,
    scenarioId,
    privacy,
    sample: {
      ...(includeInput && scenario ? { input: promptText(scenario) } : {}),
      ...(includeOutput && response ? { output: response.output } : {}),
      target: null,
      redaction: {
        input: includeInput
          ? 'included'
          : context.dataset
            ? 'omitted-private'
            : 'omitted-missing-dataset',
        output: includeOutput
          ? 'included'
          : response
            ? 'omitted-private'
            : 'omitted-missing-response',
      },
      metadata: {
        axes: scenario?.axes ?? [],
        ...optionalStringMetadata(scenario, 'scenarioHash'),
        ...optionalStringMetadata(scenario, 'outcomeType'),
      },
    },
    scores: scores.map((score) => ({
      axis: score.axis,
      value: score.value,
      ...(score.judge ? { judge: score.judge } : {}),
      ...(score.claimStatus ? { claimStatus: score.claimStatus } : {}),
      ...(typeof score.meta?.sampleId === 'string' ? { sampleId: score.meta.sampleId } : {}),
      ...(isRecord(score.meta?.slices) ? { slices: score.meta.slices } : {}),
    })),
    meanScore: values.length > 0
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : null,
    response: response
      ? {
          provider: response.meta.provider,
          model: response.meta.model,
          ...(response.meta.version ? { version: response.meta.version } : {}),
          accessedAt: response.meta.accessedAt,
          latencyMs: response.meta.latencyMs,
        }
      : {},
    references,
    lossiness,
  }
}

function buildAggregateResults(record: RunRecord): PortableAggregateResult[] {
  return record.aggregates.map((aggregate) => ({
    schemaVersion: RESULT_JSONL_SCHEMA_VERSION,
    kind: 'aggregate',
    runId: record.id,
    dataset: record.dataset,
    runnerId: aggregate.runnerId,
    composite: aggregate.composite,
    axes: Object.fromEntries(Object.entries(aggregate.axes).map(([axis, value]) => [
      axis,
      {
        mean: value.mean,
        variance: value.variance,
        n: value.n,
        ...(value.confidenceInterval ? { confidenceInterval: value.confidenceInterval } : {}),
      },
    ])),
    ...(aggregate.reliability ? { reliability: aggregate.reliability } : {}),
    ...(aggregate.operational ? { operational: aggregate.operational } : {}),
    lossiness: ['slice-details-preserved-when-present', 'raw-score-rationales-omitted'],
  }))
}

function buildExperimentMetrics(
  record: RunRecord,
  tasks: PortableTaskResult[],
): ExperimentMetricRecord[] {
  const metrics: ExperimentMetricRecord[] = []
  for (const task of tasks) {
    for (const score of task.scores) {
      metrics.push({
        recordType: 'metric',
        name: 'assay.score',
        value: score.value,
        runId: record.id,
        runnerId: task.runnerId,
        scenarioId: task.scenarioId,
        axis: score.axis,
        timestamp: task.response.accessedAt ?? record.createdAt,
        attributes: {
          datasetName: record.dataset.name,
          datasetVersion: record.dataset.version,
          privacy: task.privacy,
          claimStatus: score.claimStatus,
          judge: score.judge,
          sampleId: score.sampleId,
          slices: score.slices,
        },
      })
    }
  }
  for (const aggregate of record.aggregates) {
    metrics.push({
      recordType: 'metric',
      name: 'assay.aggregate.composite',
      value: aggregate.composite,
      runId: record.id,
      runnerId: aggregate.runnerId,
      timestamp: record.createdAt,
      attributes: {
        datasetName: record.dataset.name,
        datasetVersion: record.dataset.version,
      },
    })
    for (const [axis, value] of Object.entries(aggregate.axes)) {
      metrics.push({
        recordType: 'metric',
        name: 'assay.aggregate.axis.mean',
        value: value.mean,
        runId: record.id,
        runnerId: aggregate.runnerId,
        axis,
        timestamp: record.createdAt,
        attributes: {
          datasetName: record.dataset.name,
          datasetVersion: record.dataset.version,
          variance: value.variance,
          n: value.n,
          confidenceInterval: value.confidenceInterval,
        },
      })
    }
  }
  return metrics
}

function promptText(scenario: Scenario): string {
  return scenario.input.messages.map((message) => message.content).join('\n')
}

function privacyForScenario(scenario: Scenario): 'public' | 'private' {
  const tier = scenario.meta?.['benchmarkTier']
  return tier === 'private' || tier === 'holdout' ? 'private' : 'public'
}

function mapResponses(responses: ModelResponse[]): Map<string, ModelResponse> {
  const mapped = new Map<string, ModelResponse>()
  for (const response of responses) {
    mapped.set(taskKey(response.runnerId, response.scenarioId), response)
  }
  return mapped
}

function mapScores(scores: Score[]): Map<string, Score[]> {
  const mapped = new Map<string, Score[]>()
  for (const score of scores) {
    const key = taskKey(score.runnerId, score.scenarioId)
    const bucket = mapped.get(key) ?? []
    bucket.push(score)
    mapped.set(key, bucket)
  }
  return mapped
}

function taskKey(runnerId: string, scenarioId: string): string {
  return `${runnerId}\u0000${scenarioId}`
}

function optionalStringMetadata(
  scenario: Scenario | undefined,
  key: string,
): Record<string, string> {
  const value = scenario?.meta?.[key]
  return typeof value === 'string' ? { [key]: value } : {}
}

function taskLossiness(args: {
  hasDataset: boolean
  hasScenario: boolean
  hasResponse: boolean
  privacy: PortableTaskResult['privacy']
}): string[] {
  const notes = [
    'target-omitted',
    'rubric-answer-keys-omitted',
    'score-rationales-omitted',
    'raw-trace-payloads-omitted',
  ]
  if (!args.hasDataset) notes.push('dataset-not-supplied')
  if (args.hasDataset && !args.hasScenario) notes.push('scenario-not-found-in-dataset')
  if (args.privacy !== 'public') notes.push('private-prompt-output-omitted')
  if (!args.hasResponse) notes.push('response-not-found')
  return notes
}

function baseLossiness(hasDataset: boolean): InteroperabilityLossinessNote[] {
  return [
    ...(hasDataset
      ? []
      : [{
          code: 'dataset-not-supplied',
          detail: 'Scenario prompts, axes, hashes, and privacy tiers can only be exported when a dataset is supplied.',
        }]),
    {
      code: 'public-boundary',
      detail: 'Prompt and output samples are included only for scenarios classified as public.',
    },
    {
      code: 'targets-omitted',
      detail: 'Targets and answer-key fields are never exported; sample.target is always null.',
    },
    {
      code: 'rubric-answer-keys-omitted',
      detail: 'Rubric internals, judge references, private scoring data, and score rationales are omitted.',
    },
    {
      code: 'raw-traces-omitted',
      detail: 'Trace and proof payloads are not inlined; only public-safe references are exported when present.',
    },
  ]
}

function extractRunReferences(record: RunRecord): InteroperabilityReference[] {
  const references: InteroperabilityReference[] = []
  collectReferences(record.meta, 'meta', {}, references, 0)
  const seen = new Set<string>()
  return references.filter((reference) => {
    const key = `${reference.kind}:${reference.ref}:${reference.path}:${reference.scenarioId ?? ''}:${reference.runnerId ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function collectReferences(
  value: unknown,
  path: string,
  context: { scenarioId?: string, runnerId?: string },
  references: InteroperabilityReference[],
  depth: number,
): void {
  if (depth > 6) return
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectReferences(item, `${path}[${index}]`, context, references, depth + 1))
    return
  }
  if (!isRecord(value)) return

  const schemaVersion = typeof value['schemaVersion'] === 'string'
    ? value['schemaVersion']
    : undefined
  const nextContext = {
    scenarioId: typeof value['scenarioId'] === 'string'
      ? value['scenarioId']
      : context.scenarioId,
    runnerId: typeof value['runnerId'] === 'string'
      ? value['runnerId']
      : context.runnerId,
  }

  if (schemaVersion === 'assay.environment-trace.v1') {
    references.push({
      kind: 'trace',
      ref: `RunRecord.${path}`,
      path,
      ...nextContext,
      schemaVersion,
    })
    return
  }

  for (const [key, item] of Object.entries(value)) {
    const itemPath = `${path}.${key}`
    const kind = referenceKindForKey(key)
    if (kind && typeof item === 'string' && item.trim().length > 0) {
      references.push({
        kind,
        ref: item,
        path: itemPath,
        ...nextContext,
      })
      continue
    }
    if (kind && Array.isArray(item)) {
      item.forEach((entry, index) => {
        if (typeof entry === 'string' && entry.trim().length > 0) {
          references.push({
            kind,
            ref: entry,
            path: `${itemPath}[${index}]`,
            ...nextContext,
          })
        }
      })
      continue
    }
    collectReferences(item, itemPath, nextContext, references, depth + 1)
  }
}

function referenceKindForKey(key: string): InteroperabilityReference['kind'] | undefined {
  const lower = key.toLowerCase()
  if (lower.includes('trace') && /(ref|url|uri|path|id)$/.test(lower)) return 'trace'
  if (lower.includes('proof') && /(ref|url|uri|path|id|bundle)$/.test(lower)) return 'proof'
  return undefined
}

function formatJUnitCase(
  task: PortableTaskResult,
  score: PortableTaskResult['scores'][number],
  passThreshold: number,
): string {
  const attrsText = attrs({
    classname: `${task.dataset.name}.${task.runnerId}`,
    name: `${task.scenarioId}.${score.axis}`,
    time: task.response.latencyMs === undefined
      ? '0'
      : formatNumber(task.response.latencyMs / 1000),
  })
  if (score.value >= passThreshold) return `  <testcase ${attrsText} />`
  const message =
    `score ${formatNumber(score.value)} below threshold ${formatNumber(passThreshold)}`
  const details = [
    message,
    `run=${task.runId}`,
    `runner=${task.runnerId}`,
    `scenario=${task.scenarioId}`,
    `axis=${score.axis}`,
    `privacy=${task.privacy}`,
    `lossiness=${task.lossiness.join(',')}`,
  ].join('; ')
  return [
    `  <testcase ${attrsText}>`,
    `    <failure message="${escapeXml(message)}">${escapeXml(details)}</failure>`,
    `  </testcase>`,
  ].join('\n')
}

function attrs(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([key, value]) => `${key}="${escapeXml(value)}"`)
    .join(' ')
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function formatGitHubCommand(
  command: 'notice' | 'error',
  properties: Record<string, string>,
  message: string,
): string {
  const props = Object.entries(properties)
    .map(([key, value]) => `${key}=${escapeGitHubProperty(value)}`)
    .join(',')
  return `::${command}${props ? ` ${props}` : ''}::${escapeGitHubMessage(message)}`
}

function escapeGitHubMessage(value: string): string {
  return value
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A')
}

function escapeGitHubProperty(value: string): string {
  return escapeGitHubMessage(value)
    .replace(/:/g, '%3A')
    .replace(/,/g, '%2C')
}

function stableId(...parts: string[]): string {
  return parts
    .join(':')
    .replace(/[^A-Za-z0-9_.:-]+/g, '-')
    .slice(0, 200)
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value)
  return Number(value.toFixed(6)).toString()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
