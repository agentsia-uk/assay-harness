import { describe, expect, it } from 'vitest'
import { createNullLogger, createStderrLogger } from '../src/progress.js'
import type { ProgressEvent } from '../src/progress.js'

describe('createNullLogger', () => {
  it('accepts events without throwing', () => {
    const log = createNullLogger()
    expect(() =>
      log.emit({ event: 'run:start', runId: 'r1', dataset: 'ds', runners: [], scenarioCount: 0, at: new Date().toISOString() }),
    ).not.toThrow()
  })
})

describe('createStderrLogger', () => {
  it('writes a JSON line to stderr for each event', () => {
    const written: string[] = []
    const orig = process.stderr.write.bind(process.stderr)
    process.stderr.write = (chunk: unknown) => {
      written.push(String(chunk))
      return true
    }

    try {
      const log = createStderrLogger()
      const event: ProgressEvent = {
        event: 'run:end',
        runId: 'r1',
        composite: { 'stub:echo': 0.75 },
        at: '2026-01-01T00:00:00.000Z',
      }
      log.emit(event)
    } finally {
      process.stderr.write = orig
    }

    expect(written).toHaveLength(1)
    const parsed = JSON.parse(written[0].trim())
    expect(parsed.event).toBe('run:end')
    expect(parsed.composite['stub:echo']).toBe(0.75)
  })
})
