// How board text is shown: cleaned of what a drawing refuses, labelled by its first line, cut to a size.
import type { Post } from '../types'

export const compact = (tokens: number) =>
  tokens >= 999_500 ? `${(tokens / 1e6).toFixed(1)}M` : tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens)

// Code and URLs, where an @name or a ? is no mention and no question: a fence (closed by a run at least as long as
// its opener, tildes at a line start), a code span, a URL up to its trailing punctuation. board.py holds the same
// pattern as QUOTED; each is replaced by a space, so the words on either side stay apart.
const QUOTED = /(`{3,})[\s\S]*?\1`*|^ {0,3}(~{3,})[\s\S]*?^ {0,3}\2~*|(`+)[^\n]*?\3|(?<!\w)\w+:\/\/\S+?(?=[.,;:!)]*(?:\?(?=\s|$))?(?:\s|$))/gm
export const unquoted = (text: string) => text.replace(QUOTED, ' ')

// The same rule as board.py: @name at a word start, never an email or a path.
const MENTION = /(?<![\w.@/])@([A-Za-z][\w-]*)/g
// A post's author named as its source ("per @lead #5", "from @novelty (post #6)") addresses nobody: board.py's CITED.
const CITE = String.raw`@[A-Za-z][A-Za-z0-9_-]*(?:['’]s)?[ \t]*\(?(?:(?:posts?|in)[ \t]+)?#[0-9]+\)?`
const CITED = new RegExp(String.raw`(?:\b(?:from|per|see|by|in|of|via|cf\.?)[ \t]+|\()${CITE}(?:[ \t]*(?:,|and|&)[ \t]*${CITE})*`, 'gi')
/** The names TEXT addresses, as board.py's mentions() reads them: outside code, and not a post's author it cites. */
export const mentions = (text: string) => new Set(
  [...unquoted(text).replace(CITED, ' ').matchAll(MENTION)].map(m => (m[1] ?? '').toLowerCase())
    .flatMap(name => [name, name.replace(/[-_]+$/, '')]),
)
// The board's QUESTION: a question mark that asks, in a run of them too ("sure??"), and none of `a ?? b`, `a?.b`,
// `name?: type` or `c ? a : b`.
const QUESTION_MARK = /(?<![ \t]\?)(?:(?<![ \t])\?|\?(?![ \t][^\n?]*[ \t]:))(?!\?|\.?\w|:)/
// The board's OPTIONAL: an optional type named in prose ("inferred String? because") asks nothing. Only before a
// word that carries a statement on: "may I edit ListView? it is outside my paths" still asks.
const OPTIONAL = /(?<![@A-Za-z0-9_])[A-Z][A-Z0-9_]*[a-z][A-Za-z0-9_]*\?(?=[ \t]+(?:because|since|so|and|but|as|is|was|are|were|in|at|on|by|for|from|to|with|not|nil|null|none)(?![A-Za-z0-9_])|[ \t]+or[ \t]+(?:nil|null|none)(?![A-Za-z0-9_])|[ \t]*(?:[,;\]>=]|->))/g
// The board's INTERROGATIVE: a clause, past its leading blanks and mentions, opened by a word that asks. In one,
// "May I edit ListView? and its tests too." is a question, so its optional type is not masked. Each name and
// separator run ends where its class does, so a failed word backtracks into nothing: `@xmay` is one mention.
const INTERROGATIVE = /[ \t]*(?![ \t])(?:@[A-Za-z0-9_-]+(?![A-Za-z0-9_-])[ \t,:]*(?![ \t,:]))*(?:may|can|could|should|shall|will|would|do|does|did|is|are|was|were|has|have|had|which|what|who|whom|whose|where|when|why|how)(?![A-Za-z0-9_])/iy
export const hasQuestion = (text: string) => {
  // A question quoted whole on one line is somebody else's, told as part of a report: it asks nothing (board.py SPOKEN).
  // Whole spans are taken in order, so a closing quote never opens the next one.
  const plain = unquoted(text).replace(/"[^"\n]*"/g, span => span.includes('?') ? ' ' : span)
  // The clause starts after the last stop before the type. Each stretch is searched once, and a
  // type's own mark is a stop, so no clause is read twice: many types in a long text stay linear.
  let scanned = 0
  let start = 0
  const masked = plain.replace(OPTIONAL, (found: string, at: number) => {
    for (let i = at - 1; i >= scanned; i--) {
      // The board's clause stop: a `?` or a newline always; `.`, `!`, `;` and `:` only before a space, a tab or a
      // newline, so not inside `src/a.ts`.
      if (plain[i] === '?' || plain[i] === '\n' || ('.!;:'.includes(plain[i]!) && ' \t\n'.includes(plain[i + 1]!))) {
        start = i + 1
        break
      }
    }
    scanned = at
    INTERROGATIVE.lastIndex = start
    return INTERROGATIVE.test(plain) ? found : ' '
  })
  return QUESTION_MARK.test(masked)
}

// A long post is cut here until it is expanded.
export const CLIP = 480
// What a post is, read off its first line, for a chip beside the sender.
export function kindOf(text: string): { label: string; color: 'suggestion' | 'success' | 'error' | 'warning' } | undefined {
  const first = text.split('\n')[0] ?? ''
  const word = /^(?:@[\w-]+[ \t,:]*)*(BRIEF|NOT PASSED|NOT VERIFIED|VERIFIED|READY|REVISE|FINDING|SHUTDOWN)\b/.exec(first)?.[1]
  if (word === 'BRIEF') return { label: word, color: 'suggestion' }
  if (word === 'NOT PASSED' || word === 'NOT VERIFIED') return { label: word, color: 'error' }
  if (word === 'VERIFIED' || word === 'READY') return { label: word, color: 'success' }
  if (word === 'REVISE' || word === 'SHUTDOWN') return { label: word, color: 'warning' }
  if (word === 'FINDING') return { label: word, color: 'suggestion' }

  return undefined
}

// What a post is, as the feed labels it: kindOf, save that a pass of a partial candidate says so and names the
// workers it covered, in a tone of its own, since it is not the run's pass.
export function verdictOf(post: Post):
  (NonNullable<ReturnType<typeof kindOf>> & { covered?: string[] }) | undefined {
  const kind = kindOf(post.text)
  if (kind?.label !== 'VERIFIED' || post.partial !== true) return kind
  const covered = post.members ?? []
  return { label: 'PARTIAL PASS', color: 'warning', covered }
}

// Removes a leading kind token when the caller already renders it as a header chip.
export function stripKind(text: string): string {
  return text.replace(/^(?:@[\w-]+[ \t,:]*)*(BRIEF|NOT PASSED|NOT VERIFIED|VERIFIED|READY|REVISE|FINDING|SHUTDOWN)\b[ \t:,-]*(?:\n+|$)?/, '')
}

// A post's body under a header that shows its kind as a chip. The word goes only when the chip really shows it:
// a kind word on line two is prose to the board and to kindOf, so it stays in the body.
export const chipped = (post: Post, text = bodyOf(post)) => (kindOf(post.text) ? stripKind(text) : text).replace(/^\n+/, '')

// A post as the feed shows it: the header already names the recipients and the kind, and a full
// commit id is noise, so the body starts at what the post says.
export function bodyOf(post: Post): string {
  const text = post.to.length > 0 ? post.text.replace(/^(?:@[\w-]+[ \t,:]*)+(?:\n)?/, '') : post.text

  return text.replace(/\b([0-9a-f]{8})(?:[0-9a-f]{32}|[0-9a-f]{56})\b/g, '$1')
}

// Text and Markdown refuse control characters other than tab and newline, and one refused character blanks
// the whole pane: board text is written by agents and may carry CRs, ANSI colour codes or other controls.
export function clean(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '')
}

const graphemeSegmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : undefined

// A cut never ends inside a grapheme cluster or between the two halves of a surrogate pair.
export function head(text: string, length: number): string {
  if (length <= 0) return ''
  if (text.length <= length) return text
  if (graphemeSegmenter) {
    let end = 0
    for (const { segment, index } of graphemeSegmenter.segment(text)) {
      if (index + segment.length > length) break
      end = index + segment.length
    }
    // A first cluster longer than the cut leaves nothing: half of one is no character.
    return text.slice(0, end)
  }
  const last = text.charCodeAt(length - 1)
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? length - 1 : length)
}

// An opened post is drawn whole up to this size: a drawing over 100,000 characters is refused, and every
// newline costs extra once it is drawn, so runs of blank lines are folded first. One post is open at a time.
const OPEN_LIMIT = 20_000
export function openedText(post: Post): string {
  const body = bodyOf(post).replace(/\n{3,}/g, '\n\n')
  if (body.length <= OPEN_LIMIT) return body
  const cut = head(body, OPEN_LIMIT).trimEnd()
  const fence = openFence(cut)
  return `${cut}${fence ? `\n${fence}\n` : ' '}…\n\n(${body.length - OPEN_LIMIT} more characters. The board's \`show --post=${post.seq}\` prints the whole post.)`
}

export type Fence = { ch: '`' | '~'; len: number } | null
/** The fence state after `line`, as CommonMark reads it: a backtick opener's info string holds no backtick (that is a code span), and a closer is bare and at least as long as its opener. */
export function fenceAfter(fence: Fence, line: string): Fence {
  const m = /^(`{3,}|~{3,})(.*)$/.exec(line.trimStart())
  if (!m) return fence
  const ch = m[1]![0] as '`' | '~'
  if (fence === null) return ch === '`' && m[2]!.includes('`') ? null : { ch, len: m[1]!.length }
  return fence.ch === ch && m[1]!.length >= fence.len && m[2]!.trim() === '' ? null : fence
}
/** The line that closes the fence `text` leaves open, or '' when it leaves none. */
function openFence(text: string): string {
  let fence: Fence = null
  for (const line of text.split('\n')) fence = fenceAfter(fence, line)
  return fence ? fence.ch.repeat(fence.len) : ''
}

// Cuts a long text at a word, not inside one, and closes any unclosed code fence.
export function clip(text: string, length = CLIP): string {
  if (text.length <= length) return text
  const cut = head(text, length)
  const space = cut.search(/\s\S*$/)
  const trimmed = (space > length / 2 ? cut.slice(0, space) : cut).trimEnd()
  const fence = openFence(trimmed)
  return fence ? `${trimmed}\n${fence}\n…` : `${trimmed} …`
}

/**
 * TEXT inside a fence its own tildes cannot close. The board reads no mention inside one, so a report that quotes
 * `@name` wakes nobody. Seen live: a mirrored hand-back named two finished members, and each paid a turn to say so.
 */
export function fenced(text: string): string {
  const fence = '~'.repeat(Math.max(3, ...Array.from(text.matchAll(/~+/g), run => run[0].length + 1)))
  return `${fence}\n${text}\n${fence}`
}

// The share of a sentence's words the posts must hold for that sentence to count as said already, and the fewest
// words the posts lack that make a sentence news: a heading or a sign-off ("Summary", "Done.") is none.
const REPEATS = 0.8
const NEWS_WORDS = 2
const wordsOf = (text: string) => text.toLowerCase().match(/[a-z0-9_]{4,}/g) ?? []
const statusOf = (text: string) => text.toLowerCase().match(/\b(?:not|no|never|\w+n['’]t|fail(?:s|ed|ing|ure)?|broke|broken|errors?|pass(?:es|ed|ing)?)\b/g) ?? []
/**
 * Whether REPORT says nothing the POSTS do not: each of its lines and sentences has its words, nearly all, in them.
 * Judged a sentence at a time, so a long recap that ends on one new failure is news. Seen live: a hand-back that
 * carried a new build failure after a READY was dropped as a repeat because the READY existed.
 * ponytail: words of four letters or more, so a one-word sentence ("Blocked.") is no news; only the negations and
 * status words in statusOf count however short; compare phrases if a short report that differs otherwise is dropped.
 */
export function repeatsPosts(posts: string[], report: string): boolean {
  const said = new Set(posts.flatMap(wordsOf))
  const statusSaid = new Set(posts.flatMap(statusOf))
  return report.split(/\n|(?<=[.!?;])\s+/).every(sentence => {
    // A negation or a status word the posts never used flips what they said: "Build failed" after "Build passed".
    if (statusOf(sentence).some(word => !statusSaid.has(word))) return false
    const words = [...new Set(wordsOf(sentence))]
    const unsaid = words.filter(word => !said.has(word)).length
    return unsaid < NEWS_WORDS || words.length - unsaid >= words.length * REPEATS
  })
}

/**
 * The token figures a text names, for telling the user's budget from one the coordinator chose: "3M", "2.5 mln",
 * "500k", "3,000,000", "3 000 000". Anything under ten thousand is no budget.
 */
export function figuresIn(text: string): number[] {
  return Array.from(text.matchAll(/(\d+(?:[ ,._]\d{3})+|\d+(?:[.,]\d+)?)(?:\s*(k|m|mln|mio|million|thousand)\b)?/gi), found => {
    const unit = (found[2] ?? '').toLowerCase()
    // With a unit the figure is a decimal ("0.125M", "2,5 mln"); alone, its separators group thousands.
    const value = unit === '' ? Number(found[1]!.replace(/[ ,._]/g, '')) : Number(found[1]!.replace(/[ _]/g, '').replace(',', '.'))
    return Math.round(value * (unit === '' ? 1 : unit === 'k' || unit === 'thousand' ? 1e3 : 1e6))
  }).filter(value => value >= 10_000)
}
