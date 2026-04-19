import type { GoogleGenAI } from '@google/genai'

import type { Message, ModelResponse, Runner, RunnerOptions, Scenario } from '../types.js'

/**
 * Minimal Google Gemini client contract the runner depends on. Kept narrow so
 * unit tests can inject a stub without pulling the full @google/genai surface.
 *
 * The real SDK exposes `ai.models.generateContent(params)`; this interface
 * captures only the `models.generateContent` call path.
 */
export interface GoogleClientLike {
  models: {
    generateContent(params: GenerateContentParams): Promise<GenerateContentResult>
  }
}

export interface GeminiPart {
  text: string
}

export interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

export interface GenerateContentConfig {
  systemInstruction?: string
  temperature?: number
  maxOutputTokens?: number
}

export interface GenerateContentParams {
  model: string
  contents: GeminiContent[]
  config?: GenerateContentConfig
}

/**
 * Subset of the Gemini GenerateContentResponse surface the runner reads. The
 * real SDK response is a class with additional helpers; at runtime we only
 * touch these fields, so accepting a plain object here keeps test stubs small.
 */
export interface GenerateContentResult {
  modelVersion?: string
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> }
    finishReason?: string
  }>
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
  }
  /** Optional convenience getter on the real SDK response. */
  text?: string
}

export interface GoogleRunnerOptions {
  /**
   * Inject a client for tests. If omitted, a real @google/genai client is
   * constructed lazily on first run. Requires GOOGLE_API_KEY in env.
   */
  client?: GoogleClientLike
  /**
   * Override maxOutputTokens. Default undefined (let the model decide).
   * Scenarios can still set input.meta.maxTokens to cap output per-scenario.
   */
  defaultMaxTokens?: number
}

/**
 * Google Gemini API runner.
 *
 * Reads GOOGLE_API_KEY from env, unless an explicit client is provided via
 * GoogleRunnerOptions. The model id is taken verbatim as the suffix of the
 * runner id, e.g. 'google:gemini-3-pro' resolves to the API model
 * 'gemini-3-pro'.
 *
 * Per the Google Gemini API Additional Terms, benchmark publication is
 * permitted with disclosure of model version and access date per run. The
 * server-reported model version travels in ModelResponse.meta.version; the
 * access timestamp is meta.accessedAt.
 *
 * Grounding (Google Search, URL context) is intentionally NOT enabled. The
 * Gemini API Additional Terms prohibit analysing Grounded Results, which
 * would be implicated by any evaluation use of this harness. No
 * grounding-related tool or config is passed.
 *
 * Sampling seed: the Gemini API exposes a `seed` parameter on the
 * configuration, but it is not honoured uniformly across models and the
 * benchmark series treats Gemini runs as seed-free. `runOpts.seed` is
 * accepted and serialised into ModelResponse.meta.seed for provenance, but
 * not forwarded to the API call.
 */
export function createGoogleRunner(model: string, opts: GoogleRunnerOptions = {}): Runner {
  const id = `google:${model}`
  let cached: GoogleClientLike | null = opts.client ?? null

  async function getClient(): Promise<GoogleClientLike> {
    if (cached) return cached
    const mod = (await import('@google/genai')) as unknown as {
      GoogleGenAI: new (init: { apiKey: string }) => GoogleGenAI
    }
    const apiKey = process.env['GOOGLE_API_KEY']
    if (!apiKey) {
      throw new Error(
        `[${id}] GOOGLE_API_KEY is not set. ` +
          `Set it in the environment or pass a client via createGoogleRunner's opts.`,
      )
    }
    cached = new mod.GoogleGenAI({ apiKey }) as unknown as GoogleClientLike
    return cached
  }

  return {
    id,
    provider: 'google',
    model,
    async run(scenario: Scenario, runOpts: RunnerOptions = {}): Promise<ModelResponse> {
      const client = await getClient()
      const { systemInstruction, contents } = splitMessages(
        scenario.input.messages,
        runOpts.systemPrompt,
      )
      const maxOutputTokens = readMaxTokens(scenario, opts.defaultMaxTokens)
      const started = Date.now()

      const config: GenerateContentConfig = {}
      if (systemInstruction) config.systemInstruction = systemInstruction
      if (runOpts.temperature !== undefined) config.temperature = runOpts.temperature
      if (maxOutputTokens !== undefined) config.maxOutputTokens = maxOutputTokens

      const params: GenerateContentParams = { model, contents }
      if (Object.keys(config).length > 0) params.config = config

      let apiResponse: GenerateContentResult
      try {
        apiResponse = await client.models.generateContent(params)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        throw new Error(
          `[${id}] generateContent failed for scenario "${scenario.id}": ${message}`,
        )
      }

      const latencyMs = Date.now() - started
      const output = extractText(apiResponse)

      const response: ModelResponse = {
        runnerId: id,
        scenarioId: scenario.id,
        output,
        meta: {
          provider: 'google',
          model,
          accessedAt: new Date().toISOString(),
          latencyMs,
          extra: {
            finishReason: apiResponse.candidates?.[0]?.finishReason ?? null,
            promptTokens: apiResponse.usageMetadata?.promptTokenCount,
            candidatesTokens: apiResponse.usageMetadata?.candidatesTokenCount,
            totalTokens: apiResponse.usageMetadata?.totalTokenCount,
            ...(maxOutputTokens !== undefined ? { maxTokens: maxOutputTokens } : {}),
          },
        },
      }
      if (apiResponse.modelVersion) response.meta.version = apiResponse.modelVersion
      if (runOpts.temperature !== undefined) response.meta.temperature = runOpts.temperature
      if (runOpts.seed !== undefined) response.meta.seed = runOpts.seed

      return response
    },
  }
}

/**
 * Gemini separates the system prompt from the conversational turns. Collapse
 * any system-role messages in scenario.input.messages into a single
 * systemInstruction string; map the rest into Gemini's contents schema,
 * where 'assistant' becomes 'model'. Fall back to opts.systemPrompt if no
 * system-role messages are present.
 */
function splitMessages(
  input: Message[],
  fallbackSystem?: string,
): { systemInstruction?: string; contents: GeminiContent[] } {
  const systems: string[] = []
  const contents: GeminiContent[] = []
  for (const m of input) {
    if (m.role === 'system') {
      systems.push(m.content)
      continue
    }
    const role: 'user' | 'model' = m.role === 'assistant' ? 'model' : 'user'
    contents.push({ role, parts: [{ text: m.content }] })
  }
  if (contents.length === 0) {
    throw new Error('google: scenario must include at least one user or assistant message')
  }
  const systemInstruction = systems.length > 0 ? systems.join('\n\n') : fallbackSystem
  const result: { systemInstruction?: string; contents: GeminiContent[] } = { contents }
  if (systemInstruction) result.systemInstruction = systemInstruction
  return result
}

function readMaxTokens(scenario: Scenario, fallback?: number): number | undefined {
  const fromScenario = scenario.input.meta?.['maxTokens']
  if (typeof fromScenario === 'number' && Number.isFinite(fromScenario) && fromScenario > 0) {
    return Math.floor(fromScenario)
  }
  return fallback
}

function extractText(response: GenerateContentResult): string {
  if (typeof response.text === 'string') {
    return response.text.trim()
  }
  const parts = response.candidates?.[0]?.content?.parts ?? []
  return parts
    .map((p) => (typeof p.text === 'string' ? p.text : ''))
    .join('')
    .trim()
}
