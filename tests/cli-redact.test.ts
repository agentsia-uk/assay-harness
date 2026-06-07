import { describe, expect, it } from 'vitest'
import { redactCommandLine } from '../src/redact.js'

describe('redactCommandLine', () => {
  it('passes through safe arguments unchanged', () => {
    const args = ['cli.js', 'run', '--dataset', 'examples/scenarios', '--runner', 'stub:echo']
    expect(redactCommandLine(args)).toBe(args.join(' '))
  })

  it('redacts the value after --api-key', () => {
    const args = ['cli.js', '--api-key', 'sk-ant-mykey123']
    expect(redactCommandLine(args)).toBe('cli.js --api-key [REDACTED]')
  })

  it('redacts values starting with sk- even without a flag', () => {
    const args = ['cli.js', 'run', 'sk-ant-somekey']
    expect(redactCommandLine(args)).toBe('cli.js run [REDACTED]')
  })

  it('redacts Bearer tokens', () => {
    const args = ['cli.js', '--token', 'Bearer abc123']
    expect(redactCommandLine(args)).toBe('cli.js --token [REDACTED]')
  })

  it('redacts --secret and --password flags', () => {
    const args = ['cli.js', '--secret', 'supersecret', '--password', 'hunter2']
    expect(redactCommandLine(args)).toBe('cli.js --secret [REDACTED] --password [REDACTED]')
  })

  it('does not consume the next flag as a value after a secret flag', () => {
    const args = ['cli.js', '--api-key', '--verbose']
    expect(redactCommandLine(args)).toBe('cli.js --api-key --verbose')
  })
})
