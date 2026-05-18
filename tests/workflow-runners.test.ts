import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WORKFLOWS_DIR = path.resolve(__dirname, '..', '.github', 'workflows')

function workflowBody(file: string): string {
  return readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8')
}

function extractJobBlock(yaml: string, jobName: string): string {
  const lines = yaml.split('\n')
  const start = lines.findIndex((line) => line === `  ${jobName}:`)

  expect(start).toBeGreaterThanOrEqual(0)

  const end = lines.findIndex((line, index) => {
    return index > start && /^ {2}[A-Za-z0-9_-]+:\s*$/.test(line)
  })

  return lines.slice(start, end === -1 ? undefined : end).join('\n')
}

describe('GitHub Actions runner routing', () => {
  it('routes the non-smoke CI check through ARC CI', () => {
    const block = extractJobBlock(workflowBody('ci.yml'), 'check')

    expect(block).toContain('runs-on: [self-hosted, Linux, x64, arc, arc-ci]')
    expect(block).not.toContain('runs-on: [self-hosted, Linux, ci]')
  })

  it('keeps advisory AI review on the subscription runner lane', () => {
    const body = workflowBody('ai-review.yml')

    expect(extractJobBlock(body, 'codex-review')).toContain(
      'runs-on: [self-hosted, Linux, ai-review]',
    )
    expect(extractJobBlock(body, 'gemini-review')).toContain(
      'runs-on: [self-hosted, Linux, ai-review]',
    )
    expect(extractJobBlock(body, 'claude-review')).toContain(
      'runs-on: [self-hosted, Linux, ai-review]',
    )
  })
})
