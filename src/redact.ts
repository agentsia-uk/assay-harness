const SECRET_FLAG_RE = /^--(api[_-]?key|token|secret|password|auth|credential)$/i
const SECRET_FLAG_WITH_VALUE_RE = /^(--(?:api[_-]?key|token|secret|password|auth|credential))=(.+)$/i
const SECRET_VALUE_RE = /^(sk-|Bearer\s|ghp_|ghs_|xox[baprs]-)/i
const SECRET_TEXT_RE = /\b(sk-[A-Za-z0-9._-]+|ghp_[A-Za-z0-9_]+|ghs_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+)\b/g
const BEARER_TEXT_RE = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi
const SECRET_FLAG_TEXT_RE =
  /(^|\s)(--(?:api[_-]?key|token|secret|password|auth|credential))(=|\s+)(?!--)(?:"[^"]*"|'[^']*'|\S+)/gi

export function redactCommandLine(argv: string[]): string {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const flagWithValue = arg.match(SECRET_FLAG_WITH_VALUE_RE)
    if (flagWithValue) {
      out.push(`${flagWithValue[1]}=[REDACTED]`)
    } else if (SECRET_FLAG_RE.test(arg)) {
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

export function redactCommandLineText(commandLine: string): string {
  return commandLine
    .replace(SECRET_FLAG_TEXT_RE, (_match, prefix: string, flag: string, separator: string) =>
      `${prefix}${flag}${separator}[REDACTED]`)
    .replace(BEARER_TEXT_RE, '[REDACTED]')
    .replace(SECRET_TEXT_RE, '[REDACTED]')
}
