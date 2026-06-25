export type ProgressEvent =
  | { event: 'run:start'; runId: string; dataset: string; runners: string[]; scenarioCount: number; ledger?: string; resume?: boolean; at: string }
  | { event: 'scenario:start'; runId: string; runnerId: string; scenarioId: string; at: string }
  | { event: 'scenario:skip'; runId: string; runnerId: string; scenarioId: string; reason: string; at: string }
  | { event: 'scenario:end'; runId: string; runnerId: string; scenarioId: string; score: number; latencyMs: number; at: string }
  | { event: 'scenario:error'; runId: string; runnerId: string; scenarioId: string; error: string; at: string }
  | { event: 'run:end'; runId: string; composite: Record<string, number>; at: string }

export interface ProgressLogger {
  emit(event: ProgressEvent): void
}

export function createStderrLogger(): ProgressLogger {
  return {
    emit(event: ProgressEvent): void {
      process.stderr.write(JSON.stringify(event) + '\n')
    },
  }
}

export function createNullLogger(): ProgressLogger {
  return { emit(): void {} }
}
