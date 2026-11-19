// How board text is shown: cleaned of what a drawing refuses, labelled by its first line, cut to a size.
import type { Post } from '../types'

export const compact = (tokens: number) =>
  tokens >= 1e6 ? `${(tokens / 1e6).toFixed(1)}M` : tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens)

// A long post is cut here until it is expanded.
export const CLIP = 480
// What a post is, read off its first line, for a chip beside the sender.
export function kindOf(text: string): { label: string; color: 'suggestion' | 'success' | 'error' | 'warning' } | undefined {
  const first = text.split('\n')[0] ?? ''
  const word = /^(?:@[\w-]+[\s,]*)*(BRIEF|NOT PASSED|NOT VERIFIED|VERIFIED|READY|REVISE|PASSED|FINDING|SHUTDOWN)\b/.exec(first)?.[1]
  if (word === 'BRIEF') return { label: word, color: 'suggestion' }
  if (word === 'NOT PASSED' || word === 'NOT VERIFIED') return { label: word, color: 'error' }
  if (word === 'VERIFIED') return { label: word, color: 'success' }
  if (word === 'READY' || word === 'PASSED') return { label: word, color: 'success' }
  if (word === 'REVISE' || word === 'SHUTDOWN') return { label: word, color: 'warning' }
  if (word === 'FINDING') return { label: word, color: 'suggestion' }

  return undefined
}

// A post as the feed shows it: the header already names the recipients and the kind, and a full
// commit id is noise, so the body starts at what the post says.
export function bodyOf(post: Post): string {
  const text = post.to.length > 0 ? post.text.replace(/^(?:@[\w-]+[\s,]*)+/, '') : post.text

  return text.replace(/\b([0-9a-f]{8})[0-9a-f]{32}\b/g, '$1')
}

// Text and Markdown refuse control characters other than tab and newline, and one refused character blanks
// the whole pane: board text is written by agents and may carry CRs, ANSI colour codes or other controls.
export function clean(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
}

// A cut never ends between the two halves of a surrogate pair.
export function head(text: string, length: number): string {
  const last = text.charCodeAt(length - 1)
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? length - 1 : length)
}

// An opened post is drawn whole up to this size: a drawing over 100,000 characters is refused, and every
// newline costs extra once it is drawn, so runs of blank lines are folded first. One post is open at a time.
export const OPEN_LIMIT = 20_000
export function openedText(post: Post): string {
  const body = bodyOf(post).replace(/\n{3,}/g, '\n\n')
  if (body.length <= OPEN_LIMIT) return body
  return `${head(body, OPEN_LIMIT).trimEnd()} …\n\n(${body.length - OPEN_LIMIT} more characters. The board's \`show --post=${post.seq}\` prints the whole post.)`
}

// Cuts a long text at a word, not inside one.
export function clip(text: string, length = CLIP): string {
  if (text.length <= length) return text
  const cut = head(text, length)
  const space = cut.search(/\s\S*$/)

  return `${(space > length / 2 ? cut.slice(0, space) : cut).trimEnd()} …`
}
