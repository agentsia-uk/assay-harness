import type {
  EnvironmentActionCall,
  EnvironmentObservation,
  EnvironmentScenario,
  EnvironmentStateValidationResult,
  EnvironmentTrace,
  EnvironmentTraceStep,
  EnvironmentToolPolicy,
  Message,
  ModelResponse,
  Runner,
  RunnerOptions,
  Scenario,
  Score,
} from './types.js'

type MaybePromise<T> = T | Promise<T>

export class EnvironmentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EnvironmentError'
  }
}

export interface EnvironmentRunContext<TState = unknown> {
  scenario: EnvironmentScenario
  runner: Runner
  stepIndex: number
  state?: TState
  responses: ModelResponse[]
}

export interface EnvironmentStepResult<TState = unknown> {
  state: TState
  observation: EnvironmentObservation
}

export type EnvironmentStateValidator<TState = unknown> = (
  state: TState,
  params: Record<string, unknown> | undefined,
  context: EnvironmentRunContext<TState>,
) => MaybePromise<EnvironmentStateValidationResult | boolean | number>

export interface EnvironmentAdapter<TState = unknown> {
  /** Stable id referenced by scenario.environment.environmentId. */
  id: string
  version?: string
  setup(
    setup: unknown,
    context: EnvironmentRunContext<TState>,
  ): MaybePromise<TState>
  parseAction(
    response: ModelResponse,
    context: EnvironmentRunContext<TState>,
  ): MaybePromise<EnvironmentActionCall>
  applyAction(
    state: TState,
    action: EnvironmentActionCall,
    context: EnvironmentRunContext<TState>,
  ): MaybePromise<EnvironmentStepResult<TState>>
  validators: Record<string, EnvironmentStateValidator<TState>>
  serializeState?(
    state: TState,
    context: EnvironmentRunContext<TState>,
  ): unknown
  renderObservation?(
    observation: EnvironmentObservation,
    context: EnvironmentRunContext<TState>,
  ): Message | string
  redact?: EnvironmentRedactor
}

export interface EnvironmentRunOptions<TState = unknown> {
  adapter?: EnvironmentAdapter<TState>
  registry?: EnvironmentRegistry
  runnerOptions?: RunnerOptions
  redact?: EnvironmentRedactor
}

export interface EnvironmentRunResult<TState = unknown> {
  scenarioId: string
  runnerId: string
  environmentId: string
  adapterVersion?: string
  responses: ModelResponse[]
  finalState: TState
  validations: EnvironmentStateValidationResult[]
  value: number
  trace: EnvironmentTrace
}

export interface EnvironmentRedactionContext {
  path: string
  redactedPaths: string[]
}

export type EnvironmentRedactor = (
  value: unknown,
  context: EnvironmentRedactionContext,
) => unknown

export class EnvironmentRegistry {
  private readonly adapters = new Map<string, EnvironmentAdapter>()

  register(adapter: EnvironmentAdapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new EnvironmentError(`environment adapter "${adapter.id}" is already registered`)
    }
    this.adapters.set(adapter.id, adapter)
  }

  resolve(id: string): EnvironmentAdapter | undefined {
    return this.adapters.get(id)
  }
}

const globalEnvironmentRegistry = new EnvironmentRegistry()

export function registerEnvironmentAdapter(adapter: EnvironmentAdapter): void {
  globalEnvironmentRegistry.register(adapter)
}

export function resolveEnvironmentAdapter(id: string): EnvironmentAdapter | undefined {
  return globalEnvironmentRegistry.resolve(id)
}

export function isEnvironmentScenario(value: unknown): value is EnvironmentScenario {
  if (!isRecord(value)) return false
  const environment = value['environment']
  return isRecord(environment) && typeof environment['environmentId'] === 'string'
}

export function assertNotEnvironmentScenario(scenario: Scenario): void {
  if (isEnvironmentScenario(scenario)) {
    throw new EnvironmentError(
      `scenario '${scenario.id}' declares environment '${scenario.environment.environmentId}' ` +
        'but reached the normal single-turn run path. Environment-backed scenarios ' +
        'must be executed via runEnvironmentScenario() so state validators and traces run.',
    )
  }
}

export function validateEnvironmentScenario(
  value: unknown,
  hint = 'environment scenario',
): asserts value is EnvironmentScenario {
  if (!isRecord(value)) {
    throw new EnvironmentError(`${hint} must be an object.`)
  }
  requireString(value, 'id', hint)
  requireStringArray(value, 'axes', hint)
  const input = requireRecord(value, 'input', hint)
  const messages = input['messages']
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new EnvironmentError(`${hint}.input.messages must be a non-empty array.`)
  }
  messages.forEach((message, index) => validateMessage(message, `${hint}.input.messages[${index}]`))
  requireRecord(value, 'rubric', hint)

  const environment = requireRecord(value, 'environment', hint)
  requireString(environment, 'environmentId', `${hint}.environment`)
  if (environment['maxSteps'] !== undefined) {
    requirePositiveInteger(environment, 'maxSteps', `${hint}.environment`)
  }
  validateToolPolicy(environment['toolPolicy'], `${hint}.environment.toolPolicy`)
  const validators = environment['validators']
  if (!Array.isArray(validators) || validators.length === 0) {
    throw new EnvironmentError(`${hint}.environment.validators must contain at least one validator.`)
  }
  validators.forEach((validator, index) =>
    validateValidatorSpec(validator, `${hint}.environment.validators[${index}]`),
  )
}

export async function runEnvironmentScenario<TState>(
  runner: Runner,
  scenario: EnvironmentScenario,
  options: EnvironmentRunOptions<TState> = {},
): Promise<EnvironmentRunResult<TState>> {
  validateEnvironmentScenario(scenario)
  const adapter = resolveAdapter(scenario, options)
  const maxSteps = scenario.environment.maxSteps ?? 1
  const responses: ModelResponse[] = []
  const history: Message[] = scenario.input.messages.map((message) => ({ ...message }))
  const traceSteps: EnvironmentTraceStep[] = []
  const redactedPaths: string[] = []
  const redactor = options.redact ?? adapter.redact ?? defaultEnvironmentRedactor

  let context: EnvironmentRunContext<TState> = {
    scenario,
    runner,
    stepIndex: -1,
    responses,
  }
  let state = (await adapter.setup(scenario.environment.setup, context)) as TState

  for (let stepIndex = 0; stepIndex < maxSteps; stepIndex++) {
    const turnScenario = buildTurnScenario(scenario, history, stepIndex)
    context = { scenario, runner, stepIndex, responses, state }
    const response = await runner.run(turnScenario, options.runnerOptions)
    responses.push(response)
    history.push({ role: 'assistant', content: response.output })

    let action: EnvironmentActionCall | undefined
    let observation: EnvironmentObservation

    try {
      action = await adapter.parseAction(response, context)
      const policyError = enforceToolPolicy(
        action,
        scenario.environment.toolPolicy,
        stepIndex,
      )
      if (policyError) {
        observation = policyError
      } else {
        const result = await adapter.applyAction(state, action, context)
        state = result.state
        observation = result.observation
      }
    } catch (error) {
      observation = {
        ok: false,
        error: {
          code: 'environment-action-error',
          message: error instanceof Error ? error.message : String(error),
        },
      }
    }

    context = { scenario, runner, stepIndex, responses, state }
    const publicState = redactForTrace(
      serializeState(adapter, state, context),
      `steps[${stepIndex}].state`,
      redactor,
      redactedPaths,
    )
    traceSteps.push({
      index: stepIndex,
      responseScenarioId: response.scenarioId,
      modelOutput: redactForTrace(
        response.output,
        `steps[${stepIndex}].modelOutput`,
        redactor,
        redactedPaths,
      ) as string,
      ...(action
        ? {
            action: redactForTrace(
              action,
              `steps[${stepIndex}].action`,
              redactor,
              redactedPaths,
            ) as EnvironmentActionCall,
          }
        : {}),
      observation: redactForTrace(
        observation,
        `steps[${stepIndex}].observation`,
        redactor,
        redactedPaths,
      ) as EnvironmentObservation,
      state: publicState,
    })

    history.push(renderObservation(adapter, observation, context))
    if (!observation.ok || observation.done) break
  }

  context = {
    scenario,
    runner,
    stepIndex: traceSteps.length,
    responses,
    state,
  }
  const validations = await validateFinalState(adapter, state, scenario, context)
  const value = validations.reduce((sum, validation) => sum + validation.value, 0) /
    validations.length
  const trace: EnvironmentTrace = {
    schemaVersion: 'assay.environment-trace.v1',
    scenarioId: scenario.id,
    runnerId: runner.id,
    environmentId: adapter.id,
    ...(adapter.version ? { adapterVersion: adapter.version } : {}),
    ...(scenario.environment.toolPolicy
      ? {
          toolPolicy: redactForTrace(
            scenario.environment.toolPolicy,
            'toolPolicy',
            redactor,
            redactedPaths,
          ) as EnvironmentToolPolicy,
        }
      : {}),
    ...(scenario.environment.setup !== undefined
      ? {
          setup: redactForTrace(
            scenario.environment.setup,
            'setup',
            redactor,
            redactedPaths,
          ),
        }
      : {}),
    steps: traceSteps,
    finalState: redactForTrace(
      serializeState(adapter, state, context),
      'finalState',
      redactor,
      redactedPaths,
    ),
    validators: redactForTrace(
      validations,
      'validators',
      redactor,
      redactedPaths,
    ) as EnvironmentStateValidationResult[],
    redaction: {
      applied: redactedPaths.length > 0,
      redactedPaths: uniqueSorted(redactedPaths),
    },
  }

  return {
    scenarioId: scenario.id,
    runnerId: runner.id,
    environmentId: adapter.id,
    ...(adapter.version ? { adapterVersion: adapter.version } : {}),
    responses,
    finalState: state,
    validations,
    value,
    trace: ensureSerializable(trace, 'EnvironmentTrace'),
  }
}

export function environmentResultToModelResponse(
  result: EnvironmentRunResult,
): ModelResponse {
  const lastResponse = result.responses[result.responses.length - 1]
  const latencyMs = result.responses.reduce(
    (sum, response) => sum + response.meta.latencyMs,
    0,
  )
  const passedValidatorCount = result.validations.filter((validation) => validation.passed).length

  return {
    runnerId: result.runnerId,
    scenarioId: result.scenarioId,
    output: lastResponse?.output ?? '',
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
        environment: {
          environmentId: result.environmentId,
          traceSchemaVersion: result.trace.schemaVersion,
          validatorCount: result.validations.length,
          passedValidatorCount,
        },
      },
    },
  }
}

export function scoreEnvironmentResult(
  result: EnvironmentRunResult,
  scenario: EnvironmentScenario,
): Score[] {
  const passed = result.validations.filter((validation) => validation.passed).length
  const total = result.validations.length
  return scenario.axes.map((axis) => ({
    runnerId: result.runnerId,
    scenarioId: scenario.id,
    axis,
    value: result.value,
    rationale: `${result.environmentId}: ${passed}/${total} state validators passed`,
    claimStatus: 'programmatic',
  }))
}

export function defaultEnvironmentRedactor(
  value: unknown,
  context: EnvironmentRedactionContext,
): unknown {
  if (typeof value === 'string') {
    if (SECRET_VALUE_PATTERN.test(value)) {
      context.redactedPaths.push(context.path)
      return '[REDACTED]'
    }
    return value
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      defaultEnvironmentRedactor(item, {
        ...context,
        path: `${context.path}[${index}]`,
      }),
    )
  }
  if (isRecord(value)) {
    const redacted: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
      const childPath = context.path ? `${context.path}.${key}` : key
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        context.redactedPaths.push(childPath)
        redacted[key] = '[REDACTED]'
      } else {
        redacted[key] = defaultEnvironmentRedactor(child, {
          ...context,
          path: childPath,
        })
      }
    }
    return redacted
  }
  return value
}

function resolveAdapter<TState>(
  scenario: EnvironmentScenario,
  options: EnvironmentRunOptions<TState>,
): EnvironmentAdapter<TState> {
  const expectedId = scenario.environment.environmentId
  const adapter = options.adapter ??
    options.registry?.resolve(expectedId) as EnvironmentAdapter<TState> | undefined ??
    resolveEnvironmentAdapter(expectedId) as EnvironmentAdapter<TState> | undefined
  if (!adapter) {
    throw new EnvironmentError(`no environment adapter registered for "${expectedId}"`)
  }
  if (adapter.id !== expectedId) {
    throw new EnvironmentError(
      `environment adapter id "${adapter.id}" does not match scenario environmentId "${expectedId}"`,
    )
  }
  return adapter
}

function buildTurnScenario(
  scenario: EnvironmentScenario,
  history: Message[],
  stepIndex: number,
): Scenario {
  return {
    id: `${scenario.id}#env${stepIndex}`,
    axes: scenario.axes,
    input: { messages: history.map((message) => ({ ...message })) },
    rubric: scenario.rubric,
    ...(scenario.meta ? { meta: scenario.meta } : {}),
  }
}

function enforceToolPolicy(
  action: EnvironmentActionCall,
  policy: EnvironmentToolPolicy | undefined,
  stepIndex: number,
): EnvironmentObservation | null {
  if (!policy) return null
  if (policy.maxCalls !== undefined && stepIndex >= policy.maxCalls) {
    return {
      ok: false,
      error: {
        code: 'tool-policy-violation',
        message: `tool call ${stepIndex + 1} exceeds maxCalls=${policy.maxCalls}`,
      },
    }
  }
  if (
    policy.allowedToolNames &&
    policy.allowedToolNames.length > 0 &&
    !policy.allowedToolNames.includes(action.toolName)
  ) {
    return {
      ok: false,
      error: {
        code: 'tool-policy-violation',
        message: `tool "${action.toolName}" is not allowed by scenario policy`,
      },
    }
  }
  return null
}

function serializeState<TState>(
  adapter: EnvironmentAdapter<TState>,
  state: TState,
  context: EnvironmentRunContext<TState>,
): unknown {
  return adapter.serializeState ? adapter.serializeState(state, context) : state
}

function renderObservation<TState>(
  adapter: EnvironmentAdapter<TState>,
  observation: EnvironmentObservation,
  context: EnvironmentRunContext<TState>,
): Message {
  const rendered = adapter.renderObservation
    ? adapter.renderObservation(observation, context)
    : `Environment observation: ${JSON.stringify(observation)}`
  return typeof rendered === 'string' ? { role: 'user', content: rendered } : rendered
}

async function validateFinalState<TState>(
  adapter: EnvironmentAdapter<TState>,
  state: TState,
  scenario: EnvironmentScenario,
  context: EnvironmentRunContext<TState>,
): Promise<EnvironmentStateValidationResult[]> {
  const results: EnvironmentStateValidationResult[] = []
  for (const validatorSpec of scenario.environment.validators) {
    const validator = adapter.validators[validatorSpec.id]
    if (!validator) {
      throw new EnvironmentError(
        `environment adapter "${adapter.id}" has no state validator "${validatorSpec.id}"`,
      )
    }
    const result = await validator(state, validatorSpec.params, context)
    results.push(normaliseValidationResult(validatorSpec.id, result))
  }
  return results
}

function normaliseValidationResult(
  id: string,
  result: EnvironmentStateValidationResult | boolean | number,
): EnvironmentStateValidationResult {
  if (typeof result === 'boolean') {
    return {
      id,
      passed: result,
      value: result ? 1 : 0,
    }
  }
  if (typeof result === 'number') {
    const value = clampScore(result)
    return {
      id,
      passed: value >= 1,
      value,
    }
  }
  if (!isRecord(result)) {
    throw new EnvironmentError(`environment validator "${id}" returned an invalid result`)
  }
  const value = clampScore(result.value)
  return {
    id: result.id || id,
    passed: Boolean(result.passed),
    value,
    ...(typeof result.rationale === 'string' ? { rationale: result.rationale } : {}),
    ...(isRecord(result.meta) ? { meta: result.meta } : {}),
  }
}

function redactForTrace(
  value: unknown,
  path: string,
  redactor: EnvironmentRedactor,
  redactedPaths: string[],
): unknown {
  return ensureSerializable(
    redactor(ensureSerializable(value, path), { path, redactedPaths }),
    path,
  )
}

function ensureSerializable<T>(value: T, hint: string): T {
  if (value === undefined) return value
  try {
    return JSON.parse(JSON.stringify(value)) as T
  } catch (error) {
    throw new EnvironmentError(
      `${hint} must be JSON-serializable: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function validateToolPolicy(value: unknown, hint: string): void {
  if (value === undefined) return
  if (!isRecord(value)) {
    throw new EnvironmentError(`${hint} must be an object when present.`)
  }
  if (value['allowedToolNames'] !== undefined) {
    requireStringArray(value, 'allowedToolNames', hint)
  }
  if (value['maxCalls'] !== undefined) {
    requirePositiveInteger(value, 'maxCalls', hint)
  }
}

function validateValidatorSpec(value: unknown, hint: string): void {
  if (!isRecord(value)) {
    throw new EnvironmentError(`${hint} must be an object.`)
  }
  requireString(value, 'id', hint)
  if (value['params'] !== undefined && !isRecord(value['params'])) {
    throw new EnvironmentError(`${hint}.params must be an object when present.`)
  }
  if (
    value['weight'] !== undefined &&
    (typeof value['weight'] !== 'number' || !Number.isFinite(value['weight']))
  ) {
    throw new EnvironmentError(`${hint}.weight must be a finite number when present.`)
  }
}

function validateMessage(value: unknown, hint: string): void {
  if (!isRecord(value)) {
    throw new EnvironmentError(`${hint} must be an object.`)
  }
  const role = value['role']
  if (role !== 'system' && role !== 'user' && role !== 'assistant') {
    throw new EnvironmentError(`${hint}.role must be system, user, or assistant.`)
  }
  requireString(value, 'content', hint)
}

function requireRecord(
  obj: Record<string, unknown>,
  key: string,
  hint: string,
): Record<string, unknown> {
  const value = obj[key]
  if (!isRecord(value)) {
    throw new EnvironmentError(`${hint}.${key} must be an object.`)
  }
  return value
}

function requireString(
  obj: Record<string, unknown>,
  key: string,
  hint: string,
): string {
  const value = obj[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new EnvironmentError(`${hint}.${key} must be a non-empty string.`)
  }
  return value
}

function requireStringArray(
  obj: Record<string, unknown>,
  key: string,
  hint: string,
): string[] {
  const value = obj[key]
  if (!Array.isArray(value) || value.length === 0) {
    throw new EnvironmentError(`${hint}.${key} must be a non-empty string array.`)
  }
  value.forEach((item, index) => {
    if (typeof item !== 'string' || item.length === 0) {
      throw new EnvironmentError(`${hint}.${key}[${index}] must be a non-empty string.`)
    }
  })
  return value as string[]
}

function requirePositiveInteger(
  obj: Record<string, unknown>,
  key: string,
  hint: string,
): number {
  const value = obj[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new EnvironmentError(`${hint}.${key} must be a positive integer.`)
  }
  return value
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const SENSITIVE_KEY_PATTERN = /secret|token|password|api[-_]?key|authorization|credential|private/i
const SECRET_VALUE_PATTERN = /\b(sk-[A-Za-z0-9_-]{6,}|gh[pousr]_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+|Bearer\s+\S+)/i
