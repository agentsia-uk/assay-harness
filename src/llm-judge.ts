import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type {
  LLMJudgeExecutor,
  LLMJudgeResult,
  Runner,
  RunnerOptions,
  Scenario,
} from './types.js'

export const LLM_JUDGE_PARSER_VERSION = 'assay-llm-judge-json-v1'
export const DEFAULT_LLM_JUDGE_RUBRIC_VERSION = 'llm-judge-rubric-v1'

export interface LLMJudgeAdapterRequest {
  response: Parameters<LLMJudgeExecutor>[0]['response']
  scenario: Parameters<LLMJudgeExecutor>[0]['scenario']
  rubric: Parameters<LLMJudgeExecutor>[0]['rubric']
  renderedPrompt: string
  judgePrompt: string
}

export interface LLMJudgeAdapterResult {
  text: string
  provider: string
  model: string
}

export type LLMJudgeAdapter = (
  request: LLMJudgeAdapterRequest,
) => Promise<LLMJudgeAdapterResult> | LLMJudgeAdapterResult

export interface CreateLLMJudgeExecutorOptions {
  adapter: LLMJudgeAdapter
  parserVersion?: string
  rubricVersion?: string
  now?: () => Date
}

export interface RunnerBackedLLMJudgeExecutorOptions {
  parserVersion?: string
  rubricVersion?: string
  now?: () => Date
  runnerOptions?: RunnerOptions
}

export interface ParsedLLMJudgeOutput {
  value: number
  rationale?: string
}

type LoadedAdapterModule = Record<string, unknown>

export function createLLMJudgeExecutor(
  options: CreateLLMJudgeExecutorOptions,
): LLMJudgeExecutor {
  const parserVersion = options.parserVersion ?? LLM_JUDGE_PARSER_VERSION
  const rubricVersion = options.rubricVersion ?? DEFAULT_LLM_JUDGE_RUBRIC_VERSION
  const now = options.now ?? (() => new Date())

  return async (request): Promise<LLMJudgeResult> => {
    const promptHash = request.rubric.calibration?.promptHash
    if (!promptHash) {
      throw new Error('llm-judge: calibration promptHash is required before judging')
    }
    const judgePrompt = buildLLMJudgePrompt(request.renderedPrompt)
    const adapterResult = await options.adapter({ ...request, judgePrompt })
    const parsed = parseLLMJudgeStructuredOutput(adapterResult.text)

    return {
      value: parsed.value,
      ...(parsed.rationale ? { rationale: parsed.rationale } : {}),
      provenance: {
        provider: adapterResult.provider,
        model: adapterResult.model,
        promptHash,
        rubricVersion,
        parserVersion,
        judgedAt: now().toISOString(),
      },
    }
  }
}

export function createRunnerBackedLLMJudgeExecutor(
  runner: Runner,
  options: RunnerBackedLLMJudgeExecutorOptions = {},
): LLMJudgeExecutor {
  return createLLMJudgeExecutor({
    parserVersion: options.parserVersion,
    rubricVersion: options.rubricVersion,
    now: options.now,
    adapter: async (request) => {
      const judgeScenario = buildJudgeScenario(request.scenario, request.judgePrompt)
      const response = await runner.run(judgeScenario, {
        temperature: 0,
        ...(options.runnerOptions ?? {}),
      })
      return {
        text: response.output,
        provider: response.meta.provider,
        model: response.meta.version ?? response.meta.model,
      }
    },
  })
}

export async function loadLLMJudgeAdapterFromModule(path: string): Promise<LLMJudgeAdapter> {
  const moduleUrl = pathToFileURL(resolve(path)).href
  const mod = await import(moduleUrl) as LoadedAdapterModule
  const candidate = mod['default'] ?? mod['judgeAdapter'] ?? mod['adapter']
  if (typeof candidate !== 'function') {
    throw new Error(
      `llm-judge: adapter module "${path}" must export a default, judgeAdapter, or adapter function`,
    )
  }

  return async (request) => {
    const raw = await candidate(request)
    return normaliseAdapterResult(raw, path)
  }
}

export function buildLLMJudgePrompt(renderedPrompt: string): string {
  return [
    'You are an evaluation judge. Score the candidate response using the supplied rubric.',
    'Return only structured judge JSON with this schema:',
    '{"score": number between 0 and 1, "rationale": "brief public-safe reason"}',
    'Do not include markdown or any extra keys.',
    'Rubric prompt:',
    renderedPrompt,
  ].join('\n\n')
}

export function parseLLMJudgeStructuredOutput(text: string): ParsedLLMJudgeOutput {
  const jsonText = extractJsonObject(text)
  if (!jsonText) {
    throw new Error('llm-judge: expected structured judge JSON object')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`llm-judge: structured judge JSON could not be parsed: ${message}`)
  }

  if (!isRecord(parsed)) {
    throw new Error('llm-judge: structured judge JSON must be an object')
  }
  const rawScore = parsed['score'] ?? parsed['value']
  if (typeof rawScore !== 'number' || !Number.isFinite(rawScore)) {
    throw new Error('llm-judge: structured judge JSON score must be a finite number')
  }
  if (rawScore < 0 || rawScore > 1) {
    throw new Error('llm-judge: structured judge JSON score must be in 0..1')
  }
  const rationale = parsed['rationale']
  if (rationale !== undefined && typeof rationale !== 'string') {
    throw new Error('llm-judge: structured judge JSON rationale must be a string')
  }

  return {
    value: rawScore,
    ...(rationale ? { rationale } : {}),
  }
}

function buildJudgeScenario(
  original: Scenario,
  judgePrompt: string,
): Scenario {
  return {
    id: `${original.id}::llm-judge`,
    axes: [...original.axes],
    input: {
      messages: [{ role: 'user', content: judgePrompt }],
      meta: { judgeForScenarioId: original.id },
    },
    rubric: { kind: 'programmatic', checker: 'non-empty' },
    meta: {
      source: 'llm-judge',
      judgedScenarioId: original.id,
    },
  }
}

function normaliseAdapterResult(value: unknown, source: string): LLMJudgeAdapterResult {
  if (typeof value === 'string') {
    return { text: value, provider: 'adapter', model: source }
  }
  if (!isRecord(value)) {
    throw new Error(`llm-judge: adapter "${source}" must return text or an object`)
  }
  if (typeof value['text'] !== 'string') {
    throw new Error(`llm-judge: adapter "${source}" result.text must be a string`)
  }
  return {
    text: value['text'],
    provider: typeof value['provider'] === 'string' ? value['provider'] : 'adapter',
    model: typeof value['model'] === 'string' ? value['model'] : source,
  }
}

function extractJsonObject(text: string): string | null {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  const candidate = fenced?.[1]?.trim() ?? trimmed
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  return candidate.slice(start, end + 1)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
