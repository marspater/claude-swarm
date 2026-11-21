// How board text is shown: cleaned of what a drawing refuses, labelled by its first line, cut to a size.
import type { Post } from '../types'

export const compact = (tokens: number) =>
  tokens >= 999_500 ? `${(tokens / 1e6).toFixed(1)}M` : tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens)

// Code and URLs, where an @name or a ? is no mention and no question: a fence (closed by a run at least as long as
// its opener, tildes at a line start), a code span, a URL up to its trailing punctuation. board.py holds the same
// pattern as QUOTED; each is replaced by a space, so the words on either side stay apart.
const QUOTED = /(`{3,})[\s\S]*?\1|^ {0,3}(~{3,})[\s\S]*?^ {0,3}\2|(`+)[^\n]*?\3|\w+:\/\/\S+?(?=[.,;:!)]*(?:\?(?=\s|$))?(?:\s|$))/gm
export const unquoted = (text: string) => text.replace(QUOTED, ' ')
// The board's QUESTION: a question mark that asks, in a run of them too ("sure??"), and none of `a ?? b`, `a?.b`,
// `name?: type` or `c ? a : b`.
const QUESTION_MARK = /(?<![ \t]\?)(?:(?<![ \t])\?|\?(?![ \t]+[^\n?]*[ \t]+:))(?!\?|\.?\w|:)/
export const hasQuestion = (text: string) => QUESTION_MARK.test(unquoted(text))

// A long post is cut here until it is expanded.
export const CLIP = 480
// What a post is, read off its first line, for a chip beside the sender.
export function kindOf(text: string): { label: string; color: 'suggestion' | 'success' | 'error' | 'warning' } | undefined {
  const first = text.split('\n')[0] ?? ''
  const word = /^(?:@[\w-]+[\s,:]*)*(BRIEF|NOT PASSED|NOT VERIFIED|VERIFIED|READY|REVISE|FINDING|SHUTDOWN)\b/.exec(first)?.[1]
  if (word === 'BRIEF') return { label: word, color: 'suggestion' }
  if (word === 'NOT PASSED' || word === 'NOT VERIFIED') return { label: word, color: 'error' }
  if (word === 'VERIFIED' || word === 'READY') return { label: word, color: 'success' }
  if (word === 'REVISE' || word === 'SHUTDOWN') return { label: word, color: 'warning' }
  if (word === 'FINDING') return { label: word, color: 'suggestion' }

  return undefined
}

// Removes a leading kind token when the caller already renders it as a header chip.
export function stripKind(text: string): string {
  return text.replace(/^(?:@[\w-]+[ \t,:]*)*(BRIEF|NOT PASSED|NOT VERIFIED|VERIFIED|READY|REVISE|FINDING|SHUTDOWN)\b[ \t:,-]*(?:\n|$)?/, '')
}

// A post's body under a header that shows its kind as a chip. The word goes only when the chip really shows it:
// a kind word on line two is prose to the board and to kindOf, so it stays in the body.
export const chipped = (post: Post, text = bodyOf(post)) => kindOf(post.text) ? stripKind(text) : text

// A post as the feed shows it: the header already names the recipients and the kind, and a full
// commit id is noise, so the body starts at what the post says.
export function bodyOf(post: Post): string {
  const text = post.to.length > 0 ? post.text.replace(/^(?:@[\w-]+[ \t,:]*)+(?:\n)?/, '') : post.text

  return text.replace(/\b([0-9a-f]{8})[0-9a-f]{32}\b/g, '$1')
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
    if (end > 0) return text.slice(0, end)
  }
  const last = text.charCodeAt(length - 1)
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? length - 1 : length)
}

// An opened post is drawn whole up to this size: a drawing over 100,000 characters is refused, and every
// newline costs extra once it is drawn, so runs of blank lines are folded first. One post is open at a time.
export const OPEN_LIMIT = 20_000
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
