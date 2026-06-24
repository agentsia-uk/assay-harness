import type { Dataset, RunRecord, Scenario } from './types.js'

const DEFAULT_LANE_METADATA_KEYS = [
  'lane',
  'lanes',
  'benchmarkLane',
  'benchmarkLanes',
  'evaluationLane',
  'evaluationLanes',
] as const

export interface ScenarioDiagnosticsOptions {
  trainingPrompts?: string[]
  leakageNgramSize?: number
  leakageNgramThreshold?: number
}

export interface ScenarioDiagnosticsReport {
  items: Record<string, {
    passRate: number
    n: number
    outcomeType?: string
    flags: string[]
  }>
  outcomeCoverage: Record<string, number>
  flags: Array<{
    scenarioId: string
    kind: 'possible-leakage' | 'too-easy' | 'too-hard'
    detail: string
  }>
}

export type DiagnosticSeverity = 'advisory' | 'claim-blocking'

export type ScenarioDiagnosticKind =
  | 'outcome-coverage'
  | 'lane-coverage'
  | 'duplicate-prompt'
  | 'near-duplicate-prompt'
  | 'possible-leakage'
  | 'weak-rubric'
  | 'stale-domain-fact'
  | 'too-easy'
  | 'too-hard'

export interface ScenarioDiagnosticFinding {
  id: string
  kind: ScenarioDiagnosticKind | string
  severity: DiagnosticSeverity
  scenarioIds: string[]
  detail: string
  source?: string
  data?: Record<string, unknown>
}

export interface ScenarioDiagnosticsPluginContext {
  dataset: Dataset
  scenario: Scenario
  prompt: string
  normalisedPrompt: string
  now: Date
}

export interface ScenarioDiagnosticsPluginFinding {
  kind: ScenarioDiagnosticKind | string
  severity: DiagnosticSeverity
  detail: string
  scenarioIds?: string[]
  source?: string
  data?: Record<string, unknown>
}

export interface ScenarioDiagnosticsPlugin {
  id: string
  description?: string
  run(context: ScenarioDiagnosticsPluginContext): ScenarioDiagnosticsPluginFinding[]
}

export interface ScenarioSetAuditOptions extends ScenarioDiagnosticsOptions {
  record?: RunRecord
  requiredOutcomeTypes?: string[]
  requiredLanes?: string[]
  laneMetadataKeys?: string[]
  nearDuplicateNgramSize?: number
  nearDuplicateThreshold?: number
  now?: Date | string
  plugins?: ScenarioDiagnosticsPlugin[]
}

export interface ScenarioSetAuditReport {
  dataset: {
    name: string
    version: string
    scenarioCount: number
  }
  items: ScenarioDiagnosticsReport['items']
  coverage: {
    outcomes: {
      counts: Record<string, number>
      missingRequired: string[]
      scenarioIdsWithoutOutcome: string[]
    }
    lanes: {
      counts: Record<string, number>
      missingRequired: string[]
      scenarioIdsWithoutLane: string[]
      metadataKeys: string[]
    }
  }
  promptOverlaps: {
    duplicates: Array<{
      scenarioIds: string[]
      prompt: string
    }>
    nearDuplicates: Array<{
      scenarioIds: [string, string]
      overlap: number
    }>
  }
  findings: ScenarioDiagnosticFinding[]
  summary: {
    findingCount: number
    advisoryCount: number
    claimBlockingCount: number
    claimBlockingKinds: string[]
  }
}

export interface MetadataFreshnessPluginOptions {
  id?: string
  factMetadataKey?: string
  now?: Date | string
  defaultMaxAgeDays?: number
  severity?: DiagnosticSeverity
}

export interface ScenarioSetDiff {
  added: string[]
  removed: string[]
  changed: string[]
  suspiciousOverlaps: Array<{
    fromScenarioId: string
    toScenarioId: string
    reason: string
  }>
}

export function analyseScenarioItems(
  dataset: Dataset,
  record: RunRecord,
  options: ScenarioDiagnosticsOptions = {},
): ScenarioDiagnosticsReport {
  const items: ScenarioDiagnosticsReport['items'] = {}
  const flags: ScenarioDiagnosticsReport['flags'] = []
  const outcomeCoverage: Record<string, number> = {}
  const trainingPromptTexts = (options.trainingPrompts ?? []).map(normaliseText)
  const trainingPrompts = new Set(trainingPromptTexts)
  const leakageNgramSize = Math.max(1, Math.floor(options.leakageNgramSize ?? 5))
  const leakageNgramThreshold = Math.min(1, Math.max(0, options.leakageNgramThreshold ?? 0.65))

  for (const scenario of dataset.scenarios) {
    const scenarioScores = record.scores.filter((score) => score.scenarioId === scenario.id)
    const passRate = scenarioScores.length === 0
      ? 0
      : scenarioScores.reduce((sum, score) => sum + score.value, 0) / scenarioScores.length
    const outcomeType = normaliseOutcomeType(scenario)
    const itemFlags: string[] = []

    if (outcomeType) outcomeCoverage[outcomeType] = (outcomeCoverage[outcomeType] ?? 0) + 1
    if (passRate === 1 && scenarioScores.length > 0) {
      itemFlags.push('too-easy')
      flags.push({
        scenarioId: scenario.id,
        kind: 'too-easy',
        detail: 'all scored responses passed this item',
      })
    }
    if (passRate === 0 && scenarioScores.length > 0) {
      itemFlags.push('too-hard')
      flags.push({
        scenarioId: scenario.id,
        kind: 'too-hard',
        detail: 'all scored responses failed this item',
      })
    }
    const prompt = normaliseText(promptText(scenario))
    if (trainingPrompts.has(prompt)) {
      itemFlags.push('possible-leakage')
      flags.push({
        scenarioId: scenario.id,
        kind: 'possible-leakage',
        detail: 'scenario prompt exactly matches a training prompt',
      })
    } else {
      const fuzzyMatch = findNgramLeakage(prompt, trainingPromptTexts, {
        ngramSize: leakageNgramSize,
        threshold: leakageNgramThreshold,
      })
      if (fuzzyMatch !== null) {
        itemFlags.push('possible-leakage')
        flags.push({
          scenarioId: scenario.id,
          kind: 'possible-leakage',
          detail: `scenario prompt shares ${formatPercent(fuzzyMatch.overlap)} ${leakageNgramSize}-gram overlap with a training prompt`,
        })
      }
    }

    items[scenario.id] = {
      passRate,
      n: scenarioScores.length,
      ...(outcomeType ? { outcomeType } : {}),
      flags: itemFlags,
    }
  }

  return { items, outcomeCoverage, flags }
}

export function compareScenarioSets(previous: Dataset, next: Dataset): ScenarioSetDiff {
  const previousById = new Map(previous.scenarios.map((scenario) => [scenario.id, scenario]))
  const nextById = new Map(next.scenarios.map((scenario) => [scenario.id, scenario]))
  const added = next.scenarios
    .filter((scenario) => !previousById.has(scenario.id))
    .map((scenario) => scenario.id)
  const removed = previous.scenarios
    .filter((scenario) => !nextById.has(scenario.id))
    .map((scenario) => scenario.id)
  const changed = next.scenarios
    .filter((scenario) => {
      const prior = previousById.get(scenario.id)
      return prior !== undefined && scenarioFingerprint(prior) !== scenarioFingerprint(scenario)
    })
    .map((scenario) => scenario.id)
  const suspiciousOverlaps: ScenarioSetDiff['suspiciousOverlaps'] = []

  for (const prior of previous.scenarios) {
    for (const current of next.scenarios) {
      if (prior.id === current.id) continue
      if (normaliseText(promptText(prior)) === normaliseText(promptText(current))) {
        suspiciousOverlaps.push({
          fromScenarioId: prior.id,
          toScenarioId: current.id,
          reason: 'identical prompt text',
        })
      }
    }
  }

  return { added, removed, changed, suspiciousOverlaps }
}

export function auditScenarioSet(
  dataset: Dataset,
  options: ScenarioSetAuditOptions = {},
): ScenarioSetAuditReport {
  const record = options.record ?? emptyRunRecord(dataset)
  const itemReport = analyseScenarioItems(dataset, record, options)
  const laneMetadataKeys = options.laneMetadataKeys ?? [...DEFAULT_LANE_METADATA_KEYS]
  const requiredOutcomeTypes = options.requiredOutcomeTypes ?? []
  const requiredLanes = options.requiredLanes ?? []
  const nearDuplicateNgramSize = Math.max(1, Math.floor(options.nearDuplicateNgramSize ?? 5))
  const nearDuplicateThreshold = Math.min(1, Math.max(0, options.nearDuplicateThreshold ?? 0.8))
  const now = coerceDate(options.now) ?? new Date()
  const findings: ScenarioDiagnosticFinding[] = []

  const outcomeCoverage = sortRecord(itemReport.outcomeCoverage)
  const scenarioIdsWithoutOutcome = dataset.scenarios
    .filter((scenario) => normaliseOutcomeType(scenario) === undefined)
    .map((scenario) => scenario.id)
  const missingRequiredOutcomes = requiredOutcomeTypes
    .filter((outcomeType) => (outcomeCoverage[outcomeType] ?? 0) === 0)

  for (const scenarioId of scenarioIdsWithoutOutcome) {
    findings.push(makeFinding({
      kind: 'outcome-coverage',
      severity: 'claim-blocking',
      scenarioIds: [scenarioId],
      detail: 'scenario is missing meta.outcomeType; publishable benchmark claims require outcome stratification',
    }))
  }
  for (const outcomeType of missingRequiredOutcomes) {
    findings.push(makeFinding({
      kind: 'outcome-coverage',
      severity: 'claim-blocking',
      scenarioIds: [],
      detail: `required outcome type "${outcomeType}" is not represented`,
      data: { requiredOutcomeType: outcomeType },
    }))
  }

  const laneCoverage = countLaneCoverage(dataset, laneMetadataKeys)
  const scenarioIdsWithoutLane = dataset.scenarios
    .filter((scenario) => extractScenarioLanes(scenario, laneMetadataKeys).length === 0)
    .map((scenario) => scenario.id)
  const missingRequiredLanes = requiredLanes
    .filter((lane) => (laneCoverage[lane] ?? 0) === 0)

  for (const scenarioId of scenarioIdsWithoutLane) {
    findings.push(makeFinding({
      kind: 'lane-coverage',
      severity: 'advisory',
      scenarioIds: [scenarioId],
      detail: `scenario has no lane metadata in ${laneMetadataKeys.join(', ')}`,
      data: { metadataKeys: laneMetadataKeys },
    }))
  }
  for (const lane of missingRequiredLanes) {
    findings.push(makeFinding({
      kind: 'lane-coverage',
      severity: 'claim-blocking',
      scenarioIds: [],
      detail: `required lane "${lane}" is not represented`,
      data: { requiredLane: lane },
    }))
  }

  const promptOverlaps = findPromptOverlaps(dataset, {
    ngramSize: nearDuplicateNgramSize,
    threshold: nearDuplicateThreshold,
  })

  for (const duplicate of promptOverlaps.duplicates) {
    findings.push(makeFinding({
      kind: 'duplicate-prompt',
      severity: 'claim-blocking',
      scenarioIds: duplicate.scenarioIds,
      detail: `${duplicate.scenarioIds.length} scenarios share identical prompt text`,
    }))
  }
  for (const nearDuplicate of promptOverlaps.nearDuplicates) {
    findings.push(makeFinding({
      kind: 'near-duplicate-prompt',
      severity: 'advisory',
      scenarioIds: nearDuplicate.scenarioIds,
      detail:
        `${nearDuplicate.scenarioIds[0]} and ${nearDuplicate.scenarioIds[1]} share ` +
        `${formatPercent(nearDuplicate.overlap)} prompt n-gram overlap`,
      data: { overlap: nearDuplicate.overlap },
    }))
  }

  for (const flag of itemReport.flags) {
    findings.push(makeFinding({
      kind: flag.kind,
      severity: flag.kind === 'possible-leakage' ? 'claim-blocking' : 'advisory',
      scenarioIds: [flag.scenarioId],
      detail: flag.detail,
    }))
  }

  for (const scenario of dataset.scenarios) {
    const weakRubric = describeWeakRubric(scenario)
    if (weakRubric) {
      findings.push(makeFinding({
        kind: 'weak-rubric',
        severity: 'claim-blocking',
        scenarioIds: [scenario.id],
        detail: weakRubric,
        data: { rubricKind: scenario.rubric.kind },
      }))
    }
  }

  for (const plugin of options.plugins ?? []) {
    for (const scenario of dataset.scenarios) {
      const prompt = promptText(scenario)
      const pluginFindings = plugin.run({
        dataset,
        scenario,
        prompt,
        normalisedPrompt: normaliseText(prompt),
        now,
      })
      for (const finding of pluginFindings) {
        findings.push(makeFinding({
          ...finding,
          scenarioIds: finding.scenarioIds ?? [scenario.id],
          source: finding.source ?? plugin.id,
        }))
      }
    }
  }

  const stableFindings = findings
    .map((finding, index) => ({ ...finding, id: `D${String(index + 1).padStart(3, '0')}` }))
  const claimBlockingKinds = Array.from(
    new Set(
      stableFindings
        .filter((finding) => finding.severity === 'claim-blocking')
        .map((finding) => finding.kind),
    ),
  ).sort()

  return {
    dataset: {
      name: dataset.name,
      version: dataset.version,
      scenarioCount: dataset.scenarios.length,
    },
    items: itemReport.items,
    coverage: {
      outcomes: {
        counts: outcomeCoverage,
        missingRequired: missingRequiredOutcomes,
        scenarioIdsWithoutOutcome,
      },
      lanes: {
        counts: sortRecord(laneCoverage),
        missingRequired: missingRequiredLanes,
        scenarioIdsWithoutLane,
        metadataKeys: laneMetadataKeys,
      },
    },
    promptOverlaps,
    findings: stableFindings,
    summary: {
      findingCount: stableFindings.length,
      advisoryCount: stableFindings.filter((finding) => finding.severity === 'advisory').length,
      claimBlockingCount: stableFindings.filter((finding) => finding.severity === 'claim-blocking').length,
      claimBlockingKinds,
    },
  }
}

export function formatScenarioAuditReport(report: ScenarioSetAuditReport): string {
  const lines: string[] = [
    `Scenario diagnostics: ${report.dataset.name} v${report.dataset.version}`,
    `Scenarios: ${report.dataset.scenarioCount}`,
    '',
    'Coverage',
    `  outcomes: ${formatCoverage(report.coverage.outcomes.counts)}`,
    `  lanes: ${formatCoverage(report.coverage.lanes.counts)}`,
  ]

  if (report.coverage.outcomes.missingRequired.length > 0) {
    lines.push(`  missing required outcomes: ${report.coverage.outcomes.missingRequired.join(', ')}`)
  }
  if (report.coverage.lanes.missingRequired.length > 0) {
    lines.push(`  missing required lanes: ${report.coverage.lanes.missingRequired.join(', ')}`)
  }

  lines.push('', 'Findings')
  if (report.findings.length === 0) {
    lines.push('  none')
  } else {
    for (const finding of report.findings) {
      const scenarios = finding.scenarioIds.length > 0
        ? ` (${finding.scenarioIds.join(', ')})`
        : ''
      lines.push(`  [${finding.severity}] ${finding.kind} ${finding.id}${scenarios}: ${finding.detail}`)
    }
  }

  lines.push(
    '',
    `Summary: ${report.summary.findingCount} findings; ` +
      `${report.summary.claimBlockingCount} claim-blocking; ` +
      `${report.summary.advisoryCount} advisory`,
  )

  return `${lines.join('\n')}\n`
}

export function createMetadataFreshnessPlugin(
  options: MetadataFreshnessPluginOptions = {},
): ScenarioDiagnosticsPlugin {
  const factMetadataKey = options.factMetadataKey ?? 'domainFacts'
  const now = coerceDate(options.now) ?? new Date()
  const defaultMaxAgeDays = Math.max(1, Math.floor(options.defaultMaxAgeDays ?? 90))
  const severity = options.severity ?? 'advisory'

  return {
    id: options.id ?? 'metadata-freshness',
    description: `flags stale domain facts from scenario.meta.${factMetadataKey}`,
    run({ scenario }) {
      const facts = coerceDomainFacts(scenario.meta?.[factMetadataKey])
      const findings: ScenarioDiagnosticsPluginFinding[] = []
      for (const fact of facts) {
        const observedAt = coerceDate(fact.observedAt ?? fact.asOf)
        if (!observedAt) continue
        const maxAgeDays = Math.max(1, Math.floor(fact.maxAgeDays ?? defaultMaxAgeDays))
        const ageDays = Math.floor((now.getTime() - observedAt.getTime()) / 86_400_000)
        if (ageDays > maxAgeDays) {
          findings.push({
            kind: 'stale-domain-fact',
            severity,
            detail:
              `domain fact "${fact.label ?? fact.id ?? 'unnamed'}" is ${ageDays} days old, ` +
              `above the ${maxAgeDays}-day freshness window`,
            data: {
              factId: fact.id ?? fact.label ?? null,
              observedAt: observedAt.toISOString(),
              ageDays,
              maxAgeDays,
            },
          })
        }
      }
      return findings
    },
  }
}

function scenarioFingerprint(scenario: Scenario): string {
  return JSON.stringify({
    input: scenario.input,
    axes: scenario.axes,
    rubric: scenario.rubric,
    meta: scenario.meta,
  })
}

function promptText(scenario: Scenario): string {
  return scenario.input.messages.map((message) => message.content).join('\n')
}

function emptyRunRecord(dataset: Dataset): RunRecord {
  return {
    id: 'diagnostics-only',
    dataset: { name: dataset.name, version: dataset.version },
    runners: [],
    createdAt: '1970-01-01T00:00:00.000Z',
    responses: [],
    scores: [],
    aggregates: [],
    meta: { harnessVersion: 'diagnostics-only' },
  }
}

function makeFinding(
  finding: Omit<ScenarioDiagnosticFinding, 'id'>,
): ScenarioDiagnosticFinding {
  return {
    id: '',
    ...finding,
    scenarioIds: [...finding.scenarioIds].sort(),
  }
}

function countLaneCoverage(dataset: Dataset, keys: string[]): Record<string, number> {
  const coverage: Record<string, number> = {}
  for (const scenario of dataset.scenarios) {
    for (const lane of extractScenarioLanes(scenario, keys)) {
      coverage[lane] = (coverage[lane] ?? 0) + 1
    }
  }
  return sortRecord(coverage)
}

function extractScenarioLanes(scenario: Scenario, keys: string[]): string[] {
  const lanes: string[] = []
  for (const source of [scenario.meta, scenario.input.meta]) {
    if (!source) continue
    for (const key of keys) {
      appendMetadataStrings(source[key], lanes)
    }
  }
  return Array.from(new Set(lanes))
}

function appendMetadataStrings(value: unknown, target: string[]): void {
  if (typeof value === 'string' && value.trim()) {
    target.push(value.trim())
    return
  }
  if (!Array.isArray(value)) return
  for (const item of value) {
    if (typeof item === 'string' && item.trim()) {
      target.push(item.trim())
    }
  }
}

function findPromptOverlaps(
  dataset: Dataset,
  options: { ngramSize: number; threshold: number },
): ScenarioSetAuditReport['promptOverlaps'] {
  const duplicatesByPrompt = new Map<string, string[]>()
  const prompts = dataset.scenarios.map((scenario) => ({
    id: scenario.id,
    prompt: promptText(scenario),
    normalised: normaliseText(promptText(scenario)),
  }))

  for (const prompt of prompts) {
    const ids = duplicatesByPrompt.get(prompt.normalised) ?? []
    ids.push(prompt.id)
    duplicatesByPrompt.set(prompt.normalised, ids)
  }

  const duplicates = Array.from(duplicatesByPrompt.entries())
    .filter(([, scenarioIds]) => scenarioIds.length > 1)
    .map(([normalisedPrompt, scenarioIds]) => ({
      scenarioIds: scenarioIds.sort(),
      prompt: normalisedPrompt,
    }))
    .sort((a, b) => a.scenarioIds[0]!.localeCompare(b.scenarioIds[0]!))

  const nearDuplicates: ScenarioSetAuditReport['promptOverlaps']['nearDuplicates'] = []
  for (let i = 0; i < prompts.length; i += 1) {
    for (let j = i + 1; j < prompts.length; j += 1) {
      const left = prompts[i]!
      const right = prompts[j]!
      if (left.normalised === right.normalised) continue
      const overlap = promptOverlap(left.normalised, right.normalised, options.ngramSize)
      if (overlap >= options.threshold) {
        nearDuplicates.push({
          scenarioIds: [left.id, right.id],
          overlap,
        })
      }
    }
  }

  return { duplicates, nearDuplicates }
}

function promptOverlap(left: string, right: string, ngramSize: number): number {
  const leftNgrams = tokenNgrams(left, ngramSize)
  const rightNgrams = tokenNgrams(right, ngramSize)
  return Math.max(containment(leftNgrams, rightNgrams), containment(rightNgrams, leftNgrams))
}

function describeWeakRubric(scenario: Scenario): string | null {
  const rubric = scenario.rubric
  if (rubric.kind !== 'programmatic') return null
  if (rubric.checker === 'non-empty') {
    return 'non-empty checker is smoke-only and cannot support benchmark-grade claims'
  }
  if (rubric.checker === 'contains') {
    const smokeTestOnly = rubric.params?.['smokeTestOnly'] === true
    return smokeTestOnly
      ? 'contains checker is explicitly marked smokeTestOnly'
      : 'contains checker is sign-blind and anti-bingo-capped; use keyword or mechanism scoring for claims'
  }
  return null
}

function formatCoverage(counts: Record<string, number>): string {
  const entries = Object.entries(counts)
  if (entries.length === 0) return 'none'
  return entries.map(([key, count]) => `${key}=${count}`).join(', ')
}

function sortRecord(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)))
}

function coerceDate(value: unknown): Date | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value
  if (typeof value !== 'string') return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

interface DomainFactMetadata {
  id?: string
  label?: string
  observedAt?: string
  asOf?: string
  maxAgeDays?: number
}

function coerceDomainFacts(value: unknown): DomainFactMetadata[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => coerceDomainFacts(item))
  }
  if (!isObject(value)) return []

  const fact: DomainFactMetadata = {}
  if (typeof value['id'] === 'string') fact.id = value['id']
  if (typeof value['label'] === 'string') fact.label = value['label']
  if (typeof value['observedAt'] === 'string') fact.observedAt = value['observedAt']
  if (typeof value['asOf'] === 'string') fact.asOf = value['asOf']
  if (typeof value['maxAgeDays'] === 'number' && Number.isFinite(value['maxAgeDays'])) {
    fact.maxAgeDays = value['maxAgeDays']
  }
  return [fact]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normaliseOutcomeType(scenario: Scenario): string | undefined {
  const value = scenario.meta?.['outcomeType']
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function normaliseText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

function findNgramLeakage(
  prompt: string,
  trainingPrompts: string[],
  options: { ngramSize: number; threshold: number },
): { overlap: number } | null {
  const promptNgrams = tokenNgrams(prompt, options.ngramSize)
  if (promptNgrams.size === 0) return null

  for (const trainingPrompt of trainingPrompts) {
    const trainingNgrams = tokenNgrams(trainingPrompt, options.ngramSize)
    if (trainingNgrams.size === 0) continue
    const overlap = containment(promptNgrams, trainingNgrams)
    if (overlap >= options.threshold) return { overlap }
  }

  return null
}

function tokenNgrams(value: string, size: number): Set<string> {
  const tokens = value
    .split(/\s+/)
    .map((token) => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter(Boolean)
  if (tokens.length < size) return new Set(tokens)
  const ngrams = new Set<string>()
  for (let i = 0; i <= tokens.length - size; i += 1) {
    ngrams.add(tokens.slice(i, i + size).join(' '))
  }
  return ngrams
}

function containment(left: Set<string>, right: Set<string>): number {
  if (left.size === 0) return 0
  let shared = 0
  for (const value of left) {
    if (right.has(value)) shared += 1
  }
  return shared / left.size
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`
}
