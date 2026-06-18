/**
 * Negation-aware, word-edge text matcher.
 *
 * Ported from Modelsmith's `src/lib/eval/rubric-text-matchers.ts` for
 * agentsia-uk/assay-harness#54 (council `assay-harness-review-2026-06-18`,
 * Tier-1 #1). The public harness previously scored a term with a bare
 * `output.toLowerCase().includes(term)`. That credits a TP item on
 * `["invalid traffic", "flag"]` for the answer "this is NOT invalid traffic,
 * do NOT flag" with a perfect 1.0 — keyword-bingo with a sign error.
 *
 * Two defences are ported here:
 *
 *   1. WORD-EDGE ANCHORING — a short rubric token must not leak into a longer
 *      word ("keep" must not match "keeper"). Alphanumeric phrase boundaries
 *      get `\b` anchors; punctuation-delimited phrases stay literal.
 *
 *   2. LOCAL NEGATION SCAN — every occurrence of a matcher is checked against a
 *      bounded window of preceding text (the {@link NEGATION_WINDOW_CHARS}
 *      window) for a direct or contrastive negation ("do not", "never",
 *      "no ...", "instead of ...", "rather than ..."). A match that sits inside
 *      a negated clause does not count. Clause boundaries (`. ! ? ;` and
 *      "but"/"however"/"then") reset the window so a negation in an earlier
 *      clause does not suppress a correct mechanism in a later one.
 *
 * The 48-char negation window is a governed constant — see
 * {@link NEGATION_WINDOW_CHARS} and `docs/scoring-constants.md`.
 */

/**
 * GOVERNED CONSTANT (Rule-28). Size of the look-behind window, in characters,
 * used to decide whether a matched phrase sits inside a negated clause.
 *
 * Derivation: a direct English negation cue ("do not", "never", "no <up-to-4
 * words>", "instead of", "rather than") that flips the meaning of a target
 * phrase sits within roughly one short clause of it. Empirically that clause is
 * under ~8 words; at an English mean of ~5.1 characters/word plus a space, 8
 * words ≈ 48 characters. A wider window starts pulling in negations that belong
 * to a *different* clause (false suppression of a genuinely-stated mechanism); a
 * narrower one misses "do NOT, under any circumstances, flag" style insertions.
 * Clause-boundary resetting (see {@link CLAUSE_BOUNDARY_BEFORE_MATCH}) bounds the
 * blast radius regardless. Verified by `tests/scoring-constants.test.ts`.
 *
 * If you change this value you MUST update `docs/scoring-constants.md` and the
 * governance assertion in `tests/scoring-constants.test.ts`, which both pin 48.
 */
export const NEGATION_WINDOW_CHARS = 48

const DIRECT_NEGATION_BEFORE_MATCH =
  /\b(?:do\s+not|don't|dont|never|not(?!\s+(?:only|just|necessarily|merely|simply)\b))\b[\w\s'",:()/-]*$/i
const DIRECT_NO_BEFORE_MATCH = /\bno\s+(?:[\w-]+\s+){0,4}$/i
const CONTRAST_NEGATION_BEFORE_MATCH = /\b(?:instead\s+of|rather\s+than)\b[\w\s'"()/-]*$/i
const CLAUSE_BOUNDARY_BEFORE_MATCH = /[.!?;]|\b(?:but|however|then)\b/gi

/**
 * Escape a string so it can be embedded verbatim in a `RegExp`. Inlined from
 * Modelsmith's shared `escapeRegExp` (this repo has no util barrel).
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function hasWordEdge(char: string): boolean {
  return /[a-z0-9]/i.test(char)
}

/**
 * Build a literal phrase matcher with word edges around alphanumeric phrases.
 * Keeps short rubric tokens from leaking into longer words (e.g. "keep" should
 * not match "keeper") while still allowing punctuation-delimited phrases.
 */
export function literalPhrase(phrase: string, flags = 'i'): RegExp {
  const trimmed = phrase.trim()
  const source = trimmed.split(/\s+/).map(escapeRegExp).join('\\s+')
  const first = trimmed.charAt(0)
  const last = trimmed.charAt(trimmed.length - 1)
  const prefix = hasWordEdge(first) ? '\\b' : ''
  const suffix = hasWordEdge(last) ? '\\b' : ''

  return new RegExp(`${prefix}${source}${suffix}`, flags)
}

export type StringMatcherMode = 'phrase' | 'substring'

function literalSubstring(phrase: string, flags = 'i'): RegExp {
  const source = phrase.trim().split(/\s+/).map(escapeRegExp).join('\\s+')
  return new RegExp(source, flags)
}

function matcherPattern(matcher: RegExp | string, stringMode: StringMatcherMode): RegExp {
  if (typeof matcher === 'string') {
    return stringMode === 'substring' ? literalSubstring(matcher) : literalPhrase(matcher)
  }
  const flags = matcher.flags.includes('i') ? matcher.flags : `${matcher.flags}i`
  return new RegExp(matcher.source, flags.replace('g', ''))
}

function isLocallyNegated(text: string, index: number): boolean {
  const window = text.slice(Math.max(0, index - NEGATION_WINDOW_CHARS), index)
  const boundaries = Array.from(window.matchAll(CLAUSE_BOUNDARY_BEFORE_MATCH))
  const lastBoundary = boundaries.at(-1)
  const before = lastBoundary
    ? window.slice((lastBoundary.index ?? 0) + lastBoundary[0].length)
    : window
  return (
    DIRECT_NEGATION_BEFORE_MATCH.test(before) ||
    DIRECT_NO_BEFORE_MATCH.test(before) ||
    CONTRAST_NEGATION_BEFORE_MATCH.test(before)
  )
}

/**
 * True if at least one matcher matches the text in a clause that is not locally
 * negated. This is the negation-aware replacement for
 * `output.toLowerCase().includes(term)`.
 */
export function containsUnnegatedMatch(
  text: string,
  matchers: Array<RegExp | string>,
  options: { stringMode?: StringMatcherMode } = {},
): boolean {
  const stringMode = options.stringMode ?? 'phrase'

  return matchers.some((matcher) => {
    const basePattern = matcherPattern(matcher, stringMode)
    // Normalise to a global scan so every occurrence can be checked for local
    // negation, regardless of the caller's original flags.
    const pattern = new RegExp(basePattern.source, `${basePattern.flags}g`)
    let match = pattern.exec(text)
    while (match) {
      if (!isLocallyNegated(text, match.index)) {
        return true
      }
      match = pattern.exec(text)
    }
    return false
  })
}

/** True if the token appears at all (negation-agnostic). Used for bingo-echo detection. */
export function tokenPresent(text: string, token: RegExp | string): boolean {
  if (typeof token === 'string') return literalPhrase(token).test(text)
  const flags = token.flags.includes('i') ? token.flags.replace('g', '') : `${token.flags.replace('g', '')}i`
  return new RegExp(token.source, flags).test(text)
}
