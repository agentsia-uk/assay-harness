import { request } from 'node:https'
import type { RunRecord } from './types.js'

export function buildMarkdownReport(record: RunRecord): string {
  const lines: string[] = []

  lines.push(`# Assay run ${record.id}`)
  lines.push('')
  lines.push(`**Dataset:** ${record.dataset.name} v${record.dataset.version}`)
  lines.push(`**Runners:** ${record.runners.join(', ')}`)
  lines.push(`**Created:** ${record.createdAt}`)
  lines.push(`**Harness:** v${record.meta.harnessVersion}`)
  lines.push('')

  if (record.aggregates.length > 0) {
    lines.push('## Composite scores')
    lines.push('')
    lines.push('| Runner | Composite |')
    lines.push('|--------|-----------|')
    for (const agg of record.aggregates) {
      lines.push(`| \`${agg.runnerId}\` | ${agg.composite.toFixed(4)} |`)
    }
    lines.push('')

    const allAxes = [...new Set(record.aggregates.flatMap((a) => Object.keys(a.axes)))]
    if (allAxes.length > 0) {
      lines.push('## Per-axis means')
      lines.push('')
      const header = ['| Runner', ...allAxes.map((a) => ` ${a}`), '|'].join(' |')
      const sep = ['|--------', ...allAxes.map(() => '--------'), '|'].join('|')
      lines.push(header)
      lines.push(sep)
      for (const agg of record.aggregates) {
        const cells = [
          `| \`${agg.runnerId}\``,
          ...allAxes.map((a) => ` ${(agg.axes[a]?.mean ?? 0).toFixed(4)}`),
          '|',
        ]
        lines.push(cells.join(' |'))
      }
      lines.push('')
    }
  }

  lines.push(`*${record.scores.length} scores across ${record.responses.length} responses*`)

  return lines.join('\n')
}

export interface GistResult {
  url: string
  id: string
}

export async function createGist(
  markdown: string,
  runId: string,
  token?: string,
): Promise<GistResult> {
  const body = JSON.stringify({
    description: `Assay benchmark run ${runId}`,
    public: true,
    files: {
      [`assay-run-${runId}.md`]: { content: markdown },
    },
  })

  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'assay-harness',
      Accept: 'application/vnd.github+json',
    }
    if (token) headers['Authorization'] = `Bearer ${token}`

    const req = request(
      {
        hostname: 'api.github.com',
        path: '/gists',
        method: 'POST',
        headers,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          if (res.statusCode !== 201) {
            reject(new Error(`GitHub API returned ${res.statusCode}: ${Buffer.concat(chunks).toString()}`))
            return
          }
          const parsed = JSON.parse(Buffer.concat(chunks).toString()) as { html_url: string; id: string }
          resolve({ url: parsed.html_url, id: parsed.id })
        })
      },
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}
