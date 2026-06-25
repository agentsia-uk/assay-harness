import { readFile } from 'node:fs/promises'

import type {
  HumanAdjudicationDecision,
  HumanAnnotation,
  HumanAnnotationValidation,
} from './types.js'

export async function readHumanAnnotations(path: string): Promise<HumanAnnotation[]> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as unknown
  return coerceHumanAnnotationArray(raw, path)
}

export async function readHumanAdjudicationDecisions(
  path: string,
): Promise<HumanAdjudicationDecision[]> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as unknown
  return coerceHumanAdjudicationDecisionArray(raw, path)
}

export function applyHumanAdjudications(
  annotations: HumanAnnotation[],
  decisions: HumanAdjudicationDecision[],
  now: () => Date = () => new Date(),
): HumanAnnotation[] {
  const byKey = new Map<string, HumanAnnotation[]>()
  for (const annotation of annotations) {
    const key = annotationKey(annotation.itemId, annotation.responseId)
    const bucket = byKey.get(key) ?? []
    bucket.push(annotation)
    byKey.set(key, bucket)
  }

  const adjudicated = [...annotations]
  for (const [index, decision] of decisions.entries()) {
    validateDecisionShape(decision, index)
    const matching = byKey.get(annotationKey(decision.itemId, decision.responseId)) ?? []
    const template = matching[0]
    const scenarioHash = decision.scenarioHash ?? template?.scenarioHash
    const rubricVersion = decision.rubricVersion ?? template?.rubricVersion
    if (!scenarioHash) {
      throw new Error(`decision[${index}]: scenarioHash is required when no matching annotation exists`)
    }
    if (!rubricVersion) {
      throw new Error(`decision[${index}]: rubricVersion is required when no matching annotation exists`)
    }
    const adjudicatedAt = decision.adjudicatedAt ?? now().toISOString()

    adjudicated.push({
      itemId: decision.itemId,
      scenarioHash,
      responseId: decision.responseId,
      label: decision.label,
      score: decision.score,
      reviewer: decision.adjudicator,
      rubricVersion,
      annotatedAt: adjudicatedAt,
      status: 'adjudicated',
      adjudicator: decision.adjudicator,
      adjudicatedAt,
      ...(decision.rationale ? { rationale: decision.rationale } : {}),
    })
  }
  return adjudicated
}

export function formatHumanAnnotationValidation(
  report: HumanAnnotationValidation,
): string {
  if (report.valid) {
    return [
      'Human annotations valid',
      `errors=${report.errors.length}`,
      `conflicts=${report.conflicts.length}`,
    ].join('\n')
  }
  const lines = ['Human annotation validation failed']
  for (const error of report.errors) lines.push(`  - ${error}`)
  for (const conflict of report.conflicts) {
    lines.push(
      `  - conflict itemId=${conflict.itemId} responseId=${conflict.responseId} ` +
        `labels=${conflict.labels.join(',')}`,
    )
  }
  return lines.join('\n')
}

function coerceHumanAnnotationArray(value: unknown, source: string): HumanAnnotation[] {
  const candidate = readArrayPayload(value, 'annotations')
  if (!candidate) {
    throw new Error(`human annotations "${source}" must be a JSON array or {"annotations":[...]}`)
  }
  return candidate.map((item) => item as HumanAnnotation)
}

function coerceHumanAdjudicationDecisionArray(
  value: unknown,
  source: string,
): HumanAdjudicationDecision[] {
  const candidate = readArrayPayload(value, 'decisions')
  if (!candidate) {
    throw new Error(
      `human adjudication decisions "${source}" must be a JSON array or {"decisions":[...]}`,
    )
  }
  return candidate.map((item) => item as HumanAdjudicationDecision)
}

function readArrayPayload(value: unknown, property: string): unknown[] | null {
  if (Array.isArray(value)) return value
  if (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Array.isArray((value as Record<string, unknown>)[property])
  ) {
    return (value as Record<string, unknown>)[property] as unknown[]
  }
  return null
}

function validateDecisionShape(
  decision: HumanAdjudicationDecision,
  index: number,
): void {
  const prefix = `decision[${index}]`
  if (!decision.itemId) throw new Error(`${prefix}: itemId is required`)
  if (!decision.responseId) throw new Error(`${prefix}: responseId is required`)
  if (!['pass', 'fail', 'tie', 'invalid'].includes(decision.label)) {
    throw new Error(`${prefix}: label must be pass, fail, tie, or invalid`)
  }
  if (typeof decision.score !== 'number' || !Number.isFinite(decision.score)) {
    throw new Error(`${prefix}: score must be a finite number`)
  }
  if (decision.score < 0 || decision.score > 1) {
    throw new Error(`${prefix}: score must be normalised 0..1`)
  }
  if (!decision.adjudicator) throw new Error(`${prefix}: adjudicator is required`)
  if (
    decision.adjudicatedAt !== undefined &&
    Number.isNaN(Date.parse(decision.adjudicatedAt))
  ) {
    throw new Error(`${prefix}: adjudicatedAt must be an ISO timestamp`)
  }
}

function annotationKey(itemId: string, responseId: string): string {
  return `${itemId}\x00${responseId}`
}
