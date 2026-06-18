/**
 * Cross-repo compatibility fixtures (issue #9, parent epic Modelsmith#2077).
 *
 * assay-harness sits on the adtech release path between two sibling repos:
 *
 *   Modelsmith Assay-Adtech export  ->  assay-harness Dataset
 *   assay-harness RunRecord         ->  agentsia-web Labs (rendered leaderboard)
 *
 * These tests pin those two boundaries against the REAL public types
 * (src/types.ts) and the REAL public loader/serialiser (loadDataset,
 * readRunRecord). A removed or renamed public field — or a serialisation
 * shape change — fails here with an explicit producer/consumer message so the
 * breakage is diagnosed at the contract, not downstream in agentsia-web/Labs.
 *
 * Fixtures under tests/fixtures/modelsmith-compat/ are FULLY SYNTHETIC and
 * sanitised: no private customer, publisher, or model output. They are safe
 * to ship in the public Apache-2.0 package.
 */
import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

import { loadDataset } from '../src/loader.js'
import { readRunRecord } from '../src/serialiser.js'
import type {
  Dataset,
  Scenario,
  Rubric,
  RunRecord,
  ModelResponse,
  Score,
  ModelAggregate,
  AxisAggregate,
} from '../src/types.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = resolve(HERE, 'fixtures', 'modelsmith-compat')
const DATASET_FIXTURE = resolve(FIXTURES, 'assay-adtech-dataset.json')
const RUN_RECORD_FIXTURE = resolve(FIXTURES, 'run-record.json')

/** Producer/consumer boundary labels surfaced in every failure message. */
const DATASET_BOUNDARY = 'Modelsmith Assay-Adtech export -> assay-harness Dataset'
const RUN_RECORD_BOUNDARY = 'assay-harness RunRecord -> agentsia-web Labs'

/** Outcome-type vocabulary a Modelsmith Assay-Adtech export emits. */
const OUTCOME_TYPES = ['tp', 'tn', 'fp-guard', 'fn-guard'] as const
/** Rubric discriminants the public Rubric union supports. */
const RUBRIC_KINDS = ['programmatic', 'llm-judge', 'human'] as const

/**
 * Assert `obj` carries exactly `expected` own keys. A removed/renamed/added
 * field fails loudly with the producer/consumer boundary named.
 */
function expectExactKeys(obj: object, expected: string[], boundary: string, where: string): void {
  const actual = Object.keys(obj).sort()
  expect(
    actual,
    `[${boundary}] field-set drift at ${where}: ` +
      `expected {${expected.slice().sort().join(', ')}}, got {${actual.join(', ')}}`,
  ).toEqual(expected.slice().sort())
}

describe('modelsmith-compat: Assay-Adtech export -> assay-harness Dataset', () => {
  it('loads the fixture dataset through the real public loadDataset()', async () => {
    const dataset: Dataset = await loadDataset(DATASET_FIXTURE)

    expectExactKeys(
      dataset,
      ['name', 'version', 'description', 'scenarios'],
      DATASET_BOUNDARY,
      'Dataset',
    )
    expect(dataset.name, `[${DATASET_BOUNDARY}] Dataset.name`).toBe(
      'modelsmith-assay-adtech-compat',
    )
    expect(dataset.version, `[${DATASET_BOUNDARY}] Dataset.version`).toBe('1.2.0')
    expect(typeof dataset.description, `[${DATASET_BOUNDARY}] Dataset.description`).toBe(
      'string',
    )
    expect(
      dataset.scenarios.length,
      `[${DATASET_BOUNDARY}] Dataset.scenarios must be non-empty`,
    ).toBeGreaterThan(0)
  })

  it('every scenario conforms to the public Scenario shape', async () => {
    const dataset = await loadDataset(DATASET_FIXTURE)

    for (const scenario of dataset.scenarios) {
      const s: Scenario = scenario
      expectExactKeys(
        s,
        ['id', 'axes', 'input', 'rubric', 'meta'],
        DATASET_BOUNDARY,
        `Scenario "${s.id}"`,
      )

      expect(typeof s.id, `[${DATASET_BOUNDARY}] Scenario.id`).toBe('string')
      expect(
        Array.isArray(s.axes) && s.axes.length > 0,
        `[${DATASET_BOUNDARY}] Scenario "${s.id}".axes must be a non-empty string[]`,
      ).toBe(true)
      for (const axis of s.axes) {
        expect(typeof axis, `[${DATASET_BOUNDARY}] Scenario "${s.id}" axis`).toBe('string')
      }

      // ScenarioInput
      expectExactKeys(
        s.input,
        ['messages', 'meta'],
        DATASET_BOUNDARY,
        `Scenario "${s.id}".input`,
      )
      expect(
        s.input.messages.length,
        `[${DATASET_BOUNDARY}] Scenario "${s.id}".input.messages must be non-empty`,
      ).toBeGreaterThan(0)
      for (const m of s.input.messages) {
        expectExactKeys(
          m,
          ['role', 'content'],
          DATASET_BOUNDARY,
          `Scenario "${s.id}" message`,
        )
        expect(
          ['system', 'user', 'assistant'].includes(m.role),
          `[${DATASET_BOUNDARY}] Scenario "${s.id}" message.role must be a valid Role`,
        ).toBe(true)
        expect(typeof m.content, `[${DATASET_BOUNDARY}] message.content`).toBe('string')
      }
    }
  })

  it('exercises the full outcome-type vocabulary in scenario.meta', async () => {
    const dataset = await loadDataset(DATASET_FIXTURE)

    const seenOutcomes = new Set<string>()
    for (const s of dataset.scenarios) {
      const meta = s.meta ?? {}
      expect(
        typeof meta['source'],
        `[${DATASET_BOUNDARY}] Scenario "${s.id}".meta.source (provenance) must be present`,
      ).toBe('string')
      const outcome = meta['outcomeType']
      expect(
        typeof outcome === 'string' && (OUTCOME_TYPES as readonly string[]).includes(outcome),
        `[${DATASET_BOUNDARY}] Scenario "${s.id}".meta.outcomeType must be one of ` +
          OUTCOME_TYPES.join(' / '),
      ).toBe(true)
      seenOutcomes.add(outcome as string)
      expect(
        typeof meta['benchmarkTier'],
        `[${DATASET_BOUNDARY}] Scenario "${s.id}".meta.benchmarkTier must be present`,
      ).toBe('string')
    }

    // The fixture must cover every outcome-type label, not just one.
    for (const t of OUTCOME_TYPES) {
      expect(
        seenOutcomes.has(t),
        `[${DATASET_BOUNDARY}] outcome-type vocabulary incomplete: missing "${t}"`,
      ).toBe(true)
    }
  })

  it('exercises every rubric discriminant in the public Rubric union', async () => {
    const dataset = await loadDataset(DATASET_FIXTURE)

    const seenKinds = new Set<string>()
    for (const s of dataset.scenarios) {
      const rubric: Rubric = s.rubric
      expect(
        (RUBRIC_KINDS as readonly string[]).includes(rubric.kind),
        `[${DATASET_BOUNDARY}] Scenario "${s.id}".rubric.kind must be a valid Rubric discriminant`,
      ).toBe(true)
      seenKinds.add(rubric.kind)

      if (rubric.kind === 'programmatic') {
        expect(
          typeof rubric.checker,
          `[${DATASET_BOUNDARY}] ProgrammaticRubric.checker`,
        ).toBe('string')
      } else if (rubric.kind === 'llm-judge') {
        expect(typeof rubric.judge, `[${DATASET_BOUNDARY}] LLMJudgeRubric.judge`).toBe(
          'string',
        )
        expect(typeof rubric.prompt, `[${DATASET_BOUNDARY}] LLMJudgeRubric.prompt`).toBe(
          'string',
        )
      } else if (rubric.kind === 'mechanism') {
        expect(
          Array.isArray(rubric.quantitative),
          `[${DATASET_BOUNDARY}] MechanismRubric.quantitative`,
        ).toBe(true)
      } else {
        expect(
          typeof rubric.instructions,
          `[${DATASET_BOUNDARY}] HumanRubric.instructions`,
        ).toBe('string')
      }
    }

    for (const k of RUBRIC_KINDS) {
      expect(
        seenKinds.has(k),
        `[${DATASET_BOUNDARY}] rubric-kind coverage incomplete: missing "${k}"`,
      ).toBe(true)
    }
  })

  it('fixtures contain only synthetic, sanitised data', async () => {
    const dataset = await loadDataset(DATASET_FIXTURE)
    for (const s of dataset.scenarios) {
      expect(
        s.meta?.['source'],
        `[${DATASET_BOUNDARY}] Scenario "${s.id}" must be marked synthetic for the public package`,
      ).toBe('synthetic')
      const blob = JSON.stringify(s).toLowerCase()
      // Public Apache-2.0 package: no private customer/model identifiers.
      for (const banned of ['loopme', 'chartboost', 'agentsia.uk', 'op://']) {
        expect(
          blob.includes(banned),
          `[${DATASET_BOUNDARY}] Scenario "${s.id}" leaks non-public token "${banned}"`,
        ).toBe(false)
      }
    }
  })
})

describe('modelsmith-compat: assay-harness RunRecord -> agentsia-web Labs', () => {
  it('reads the fixture through the real public readRunRecord()', async () => {
    const record: RunRecord = await readRunRecord(RUN_RECORD_FIXTURE)

    expectExactKeys(
      record,
      ['id', 'dataset', 'runners', 'createdAt', 'responses', 'scores', 'aggregates', 'meta'],
      RUN_RECORD_BOUNDARY,
      'RunRecord',
    )
    expect(typeof record.id, `[${RUN_RECORD_BOUNDARY}] RunRecord.id`).toBe('string')
    expectExactKeys(
      record.dataset,
      ['name', 'version'],
      RUN_RECORD_BOUNDARY,
      'RunRecord.dataset',
    )
    expect(
      Array.isArray(record.runners) && record.runners.length > 0,
      `[${RUN_RECORD_BOUNDARY}] RunRecord.runners must be a non-empty string[]`,
    ).toBe(true)
    expect(
      Number.isNaN(Date.parse(record.createdAt)),
      `[${RUN_RECORD_BOUNDARY}] RunRecord.createdAt must be an ISO timestamp`,
    ).toBe(false)
  })

  it('every ModelResponse carries the runner metadata Labs renders', async () => {
    const record = await readRunRecord(RUN_RECORD_FIXTURE)

    expect(
      record.responses.length,
      `[${RUN_RECORD_BOUNDARY}] RunRecord.responses must be non-empty`,
    ).toBeGreaterThan(0)

    for (const response of record.responses) {
      const r: ModelResponse = response
      expectExactKeys(
        r,
        ['runnerId', 'scenarioId', 'output', 'meta'],
        RUN_RECORD_BOUNDARY,
        `ModelResponse (${r.runnerId} / ${r.scenarioId})`,
      )
      expect(typeof r.runnerId, `[${RUN_RECORD_BOUNDARY}] ModelResponse.runnerId`).toBe(
        'string',
      )
      expect(typeof r.scenarioId, `[${RUN_RECORD_BOUNDARY}] ModelResponse.scenarioId`).toBe(
        'string',
      )
      expect(typeof r.output, `[${RUN_RECORD_BOUNDARY}] ModelResponse.output`).toBe('string')

      // Runner metadata: provider / model / version / temperature /
      // latencyMs / accessedAt — the columns agentsia-web/Labs renders.
      const m = r.meta
      expect(
        typeof m.provider,
        `[${RUN_RECORD_BOUNDARY}] ModelResponse.meta.provider (Labs provider column)`,
      ).toBe('string')
      expect(
        typeof m.model,
        `[${RUN_RECORD_BOUNDARY}] ModelResponse.meta.model (Labs model column)`,
      ).toBe('string')
      expect(
        typeof m.latencyMs,
        `[${RUN_RECORD_BOUNDARY}] ModelResponse.meta.latencyMs (Labs latency column)`,
      ).toBe('number')
      expect(
        Number.isNaN(Date.parse(m.accessedAt)),
        `[${RUN_RECORD_BOUNDARY}] ModelResponse.meta.accessedAt must be an ISO timestamp`,
      ).toBe(false)
      // version + temperature are optional in the public type — assert the
      // type when present so a renamed field fails the consumer loudly.
      if (m.version !== undefined) {
        expect(
          typeof m.version,
          `[${RUN_RECORD_BOUNDARY}] ModelResponse.meta.version`,
        ).toBe('string')
      }
      if (m.temperature !== undefined) {
        expect(
          typeof m.temperature,
          `[${RUN_RECORD_BOUNDARY}] ModelResponse.meta.temperature`,
        ).toBe('number')
      }
    }
  })

  it('edge case: runner metadata varies — version absent, temperature 0, seed optional', async () => {
    const record = await readRunRecord(RUN_RECORD_FIXTURE)
    const byScenario = (runnerId: string, scenarioId: string): ModelResponse | undefined =>
      record.responses.find(
        (r) => r.runnerId === runnerId && r.scenarioId === scenarioId,
      )

    // A response WITH full optional metadata (version + seed + temperature 0).
    const full = byScenario('anthropic:claude-opus-4-7', 'ASSAY_ADTECH_COMPAT_TP_IVT_DETECTION')
    expect(
      full,
      `[${RUN_RECORD_BOUNDARY}] expected the full-metadata fixture response`,
    ).toBeDefined()
    expect(full?.meta.temperature, `[${RUN_RECORD_BOUNDARY}] temperature 0 must survive`).toBe(
      0,
    )
    expect(full?.meta.seed, `[${RUN_RECORD_BOUNDARY}] seed must be preserved`).toBe(42)
    expect(typeof full?.meta.version, `[${RUN_RECORD_BOUNDARY}] version present`).toBe(
      'string',
    )

    // A response WITHOUT the optional `seed` field — Labs must tolerate absence.
    const noSeed = byScenario('openai:gpt-5.5', 'ASSAY_ADTECH_COMPAT_TP_IVT_DETECTION')
    expect(
      noSeed,
      `[${RUN_RECORD_BOUNDARY}] expected the no-seed fixture response`,
    ).toBeDefined()
    expect(
      noSeed?.meta.seed,
      `[${RUN_RECORD_BOUNDARY}] seed is optional and may be absent`,
    ).toBeUndefined()
  })

  it('every Score conforms to the public Score shape', async () => {
    const record = await readRunRecord(RUN_RECORD_FIXTURE)

    expect(
      record.scores.length,
      `[${RUN_RECORD_BOUNDARY}] RunRecord.scores must be non-empty`,
    ).toBeGreaterThan(0)

    for (const score of record.scores) {
      const s: Score = score
      const required = ['runnerId', 'scenarioId', 'axis', 'value']
      for (const key of required) {
        expect(
          key in s,
          `[${RUN_RECORD_BOUNDARY}] Score missing required field "${key}"`,
        ).toBe(true)
      }
      expect(typeof s.axis, `[${RUN_RECORD_BOUNDARY}] Score.axis`).toBe('string')
      expect(
        typeof s.value === 'number' && s.value >= 0 && s.value <= 1,
        `[${RUN_RECORD_BOUNDARY}] Score.value must be normalised 0..1, got ${s.value}`,
      ).toBe(true)
    }
  })

  it('every ModelAggregate carries per-axis AxisAggregate, composite and weights', async () => {
    const record = await readRunRecord(RUN_RECORD_FIXTURE)

    expect(
      record.aggregates.length,
      `[${RUN_RECORD_BOUNDARY}] RunRecord.aggregates must be non-empty`,
    ).toBeGreaterThan(0)

    for (const aggregate of record.aggregates) {
      const a: ModelAggregate = aggregate
      expectExactKeys(
        a,
        ['runnerId', 'axes', 'composite', 'weights'],
        RUN_RECORD_BOUNDARY,
        `ModelAggregate "${a.runnerId}"`,
      )
      expect(typeof a.runnerId, `[${RUN_RECORD_BOUNDARY}] ModelAggregate.runnerId`).toBe(
        'string',
      )
      expect(
        typeof a.composite === 'number' && a.composite >= 0 && a.composite <= 1,
        `[${RUN_RECORD_BOUNDARY}] ModelAggregate "${a.runnerId}".composite must be 0..1`,
      ).toBe(true)

      const axisLabels = Object.keys(a.axes)
      expect(
        axisLabels.length,
        `[${RUN_RECORD_BOUNDARY}] ModelAggregate "${a.runnerId}".axes must be non-empty`,
      ).toBeGreaterThan(0)

      for (const [axis, agg] of Object.entries(a.axes)) {
        const ax: AxisAggregate = agg
        expectExactKeys(
          ax,
          ['mean', 'variance', 'n'],
          RUN_RECORD_BOUNDARY,
          `AxisAggregate "${a.runnerId}"/"${axis}"`,
        )
        expect(typeof ax.mean, `[${RUN_RECORD_BOUNDARY}] AxisAggregate.mean`).toBe('number')
        expect(typeof ax.variance, `[${RUN_RECORD_BOUNDARY}] AxisAggregate.variance`).toBe(
          'number',
        )
        expect(typeof ax.n, `[${RUN_RECORD_BOUNDARY}] AxisAggregate.n`).toBe('number')
        // Labs renders the per-axis weight next to each axis bar.
        expect(
          typeof a.weights[axis],
          `[${RUN_RECORD_BOUNDARY}] ModelAggregate "${a.runnerId}" missing weight for axis "${axis}"`,
        ).toBe('number')
      }
    }

    // Labs sorts the leaderboard by composite descending; the producer
    // (aggregator) emits aggregates already sorted. Pin that ordering.
    const composites = record.aggregates.map((a) => a.composite)
    const sorted = [...composites].sort((x, y) => y - x)
    expect(
      composites,
      `[${RUN_RECORD_BOUNDARY}] RunRecord.aggregates must be sorted by composite descending`,
    ).toEqual(sorted)
  })

  it('RunRecord.meta carries the harnessVersion Labs stamps on the leaderboard', async () => {
    const record = await readRunRecord(RUN_RECORD_FIXTURE)
    expect(
      typeof record.meta.harnessVersion,
      `[${RUN_RECORD_BOUNDARY}] RunRecord.meta.harnessVersion (Labs build stamp)`,
    ).toBe('string')
    // commandLine + env are optional; assert types when present.
    if (record.meta.commandLine !== undefined) {
      expect(
        typeof record.meta.commandLine,
        `[${RUN_RECORD_BOUNDARY}] RunRecord.meta.commandLine`,
      ).toBe('string')
    }
    if (record.meta.env !== undefined) {
      expect(
        typeof record.meta.env,
        `[${RUN_RECORD_BOUNDARY}] RunRecord.meta.env`,
      ).toBe('object')
    }
  })

  it('RunRecord cross-references resolve: responses/scores/aggregates agree on runners', async () => {
    const record = await readRunRecord(RUN_RECORD_FIXTURE)
    const declared = new Set(record.runners)

    for (const r of record.responses) {
      expect(
        declared.has(r.runnerId),
        `[${RUN_RECORD_BOUNDARY}] ModelResponse runnerId "${r.runnerId}" not in RunRecord.runners`,
      ).toBe(true)
    }
    for (const s of record.scores) {
      expect(
        declared.has(s.runnerId),
        `[${RUN_RECORD_BOUNDARY}] Score runnerId "${s.runnerId}" not in RunRecord.runners`,
      ).toBe(true)
    }
    for (const a of record.aggregates) {
      expect(
        declared.has(a.runnerId),
        `[${RUN_RECORD_BOUNDARY}] ModelAggregate runnerId "${a.runnerId}" not in RunRecord.runners`,
      ).toBe(true)
    }
    // The RunRecord's dataset reference must match the dataset fixture.
    const dataset = await loadDataset(DATASET_FIXTURE)
    expect(
      record.dataset.name,
      `[${RUN_RECORD_BOUNDARY}] RunRecord.dataset.name must match the exported Dataset`,
    ).toBe(dataset.name)
    expect(
      record.dataset.version,
      `[${RUN_RECORD_BOUNDARY}] RunRecord.dataset.version must match the exported Dataset`,
    ).toBe(dataset.version)
  })
})
