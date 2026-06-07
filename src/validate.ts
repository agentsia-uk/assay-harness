import type { RunRecord } from './types.js'

export interface ValidationResult {
  valid: boolean
  errors: string[]
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function requireString(obj: Record<string, unknown>, key: string, path: string, errors: string[]): boolean {
  if (typeof obj[key] !== 'string' || (obj[key] as string).length === 0) {
    errors.push(`${path}.${key} must be a non-empty string`)
    return false
  }
  return true
}

function requireNumber(obj: Record<string, unknown>, key: string, path: string, errors: string[]): boolean {
  if (typeof obj[key] !== 'number' || !Number.isFinite(obj[key] as number)) {
    errors.push(`${path}.${key} must be a finite number`)
    return false
  }
  return true
}

function requireArray(obj: Record<string, unknown>, key: string, path: string, errors: string[]): boolean {
  if (!Array.isArray(obj[key])) {
    errors.push(`${path}.${key} must be an array`)
    return false
  }
  return true
}

function validateModelResponse(v: unknown, path: string, errors: string[]): boolean {
  if (!isRecord(v)) { errors.push(`${path} must be an object`); return false }
  let ok = true
  ok = requireString(v, 'runnerId', path, errors) && ok
  ok = requireString(v, 'scenarioId', path, errors) && ok
  if (typeof v['output'] !== 'string') { errors.push(`${path}.output must be a string`); ok = false }
  const meta = v['meta']
  if (!isRecord(meta)) {
    errors.push(`${path}.meta must be an object`)
    ok = false
  } else {
    ok = requireString(meta, 'provider', `${path}.meta`, errors) && ok
    ok = requireString(meta, 'model', `${path}.meta`, errors) && ok
    ok = requireString(meta, 'accessedAt', `${path}.meta`, errors) && ok
    ok = requireNumber(meta, 'latencyMs', `${path}.meta`, errors) && ok
  }
  return ok
}

function validateScore(v: unknown, path: string, errors: string[]): boolean {
  if (!isRecord(v)) { errors.push(`${path} must be an object`); return false }
  let ok = true
  ok = requireString(v, 'runnerId', path, errors) && ok
  ok = requireString(v, 'scenarioId', path, errors) && ok
  ok = requireString(v, 'axis', path, errors) && ok
  if (typeof v['value'] !== 'number' || !Number.isFinite(v['value'] as number) || (v['value'] as number) < 0 || (v['value'] as number) > 1) {
    errors.push(`${path}.value must be a finite number in [0, 1]`)
    ok = false
  }
  return ok
}

function validateAxisAggregate(v: unknown, path: string, errors: string[]): boolean {
  if (!isRecord(v)) { errors.push(`${path} must be an object`); return false }
  let ok = true
  ok = requireNumber(v, 'mean', path, errors) && ok
  ok = requireNumber(v, 'variance', path, errors) && ok
  if (typeof v['n'] !== 'number' || !Number.isInteger(v['n']) || (v['n'] as number) < 0) {
    errors.push(`${path}.n must be a non-negative integer`)
    ok = false
  }
  return ok
}

function validateModelAggregate(v: unknown, path: string, errors: string[]): boolean {
  if (!isRecord(v)) { errors.push(`${path} must be an object`); return false }
  let ok = true
  ok = requireString(v, 'runnerId', path, errors) && ok
  ok = requireNumber(v, 'composite', path, errors) && ok
  const axes = v['axes']
  if (!isRecord(axes)) {
    errors.push(`${path}.axes must be an object`)
    ok = false
  } else {
    for (const [axis, agg] of Object.entries(axes)) {
      ok = validateAxisAggregate(agg, `${path}.axes.${axis}`, errors) && ok
    }
  }
  const weights = v['weights']
  if (!isRecord(weights)) {
    errors.push(`${path}.weights must be an object`)
    ok = false
  }
  return ok
}

export function validateRunRecord(value: unknown): ValidationResult {
  const errors: string[] = []

  if (!isRecord(value)) {
    return { valid: false, errors: ['RunRecord must be a plain object'] }
  }

  requireString(value, 'id', 'RunRecord', errors)
  requireString(value, 'createdAt', 'RunRecord', errors)

  const dataset = value['dataset']
  if (!isRecord(dataset)) {
    errors.push('RunRecord.dataset must be an object')
  } else {
    requireString(dataset, 'name', 'RunRecord.dataset', errors)
    requireString(dataset, 'version', 'RunRecord.dataset', errors)
  }

  if (!Array.isArray(value['runners'])) {
    errors.push('RunRecord.runners must be an array')
  } else {
    for (const r of value['runners'] as unknown[]) {
      if (typeof r !== 'string') errors.push('RunRecord.runners must contain only strings')
    }
  }

  if (requireArray(value, 'responses', 'RunRecord', errors)) {
    ;(value['responses'] as unknown[]).forEach((r, i) =>
      validateModelResponse(r, `RunRecord.responses[${i}]`, errors),
    )
  }

  if (requireArray(value, 'scores', 'RunRecord', errors)) {
    ;(value['scores'] as unknown[]).forEach((s, i) =>
      validateScore(s, `RunRecord.scores[${i}]`, errors),
    )
  }

  if (requireArray(value, 'aggregates', 'RunRecord', errors)) {
    ;(value['aggregates'] as unknown[]).forEach((a, i) =>
      validateModelAggregate(a, `RunRecord.aggregates[${i}]`, errors),
    )
  }

  const meta = value['meta']
  if (!isRecord(meta)) {
    errors.push('RunRecord.meta must be an object')
  } else {
    requireString(meta, 'harnessVersion', 'RunRecord.meta', errors)
  }

  return { valid: errors.length === 0, errors }
}

export function assertValidRunRecord(value: unknown): asserts value is RunRecord {
  const result = validateRunRecord(value)
  if (!result.valid) {
    throw new Error(`RunRecord validation failed:\n${result.errors.map((e) => `  - ${e}`).join('\n')}`)
  }
}
