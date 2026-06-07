const SECRET_FLAG_RE = /^--(api[_-]?key|token|secret|password|auth|credential)$/i
const SECRET_VALUE_RE = /^(sk-|Bearer\s|ghp_|ghs_|xox[baprs]-)/i

export function redactCommandLine(argv: string[]): string {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (SECRET_FLAG_RE.test(arg)) {
      out.push(arg)
      if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        out.push('[REDACTED]')
        i++
      }
    } else if (SECRET_VALUE_RE.test(arg)) {
      out.push('[REDACTED]')
    } else {
      out.push(arg)
    }
  }
  return out.join(' ')
}
