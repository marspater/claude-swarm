// The text forms this module recognises: a board command in a Bash call, a run folder, a wake message.

// python3 with any flags (-B, -X utf8), the script, the run folder (a trailing slash allowed), the subcommand.
export const BOARD_CALL = /^(?:[A-Za-z_]\w*=(?:"[^"\n]*"|'[^'\n]*'|[^\s"'<>;]*)\s+)*(?:\S*\/)?python3(?:\.\d+)?\s+(?:-(?:[A-Za-z]+|[XW]\s+\S+)\s+)*(?:"[^"\n]*(?:^|\/)board\.py"|'[^'\n]*(?:^|\/)board\.py'|(?:(?:\\.|[^\s"'<>;])*\/)?board\.py)\s+(?:"([^"\n]+)"|'([^'\n]+)'|((?:\\.|[^\s"'<>;])+))\s+([a-z]+)(?=\s|$)/
export const RUN = /(?:^|\/)\.swarm\/[\w.-]+-\d{8}-\d{6}x*$/
// `read coordinator`, with the read's flags on either side of the name, which the board also takes as `@coordinator`.
// Only read off a BOARD_CALL whose subcommand is `read`: alone it also matches a commit message.
export const COORDINATOR_READ = /\bread\s+(?:--[a-z-]+(?:=\S+)?\s+)*["']?@?coordinator["']?(?=\s|$|[;|&])/i
export const wakeMessage = (seq: number) => `Swarm board: call the board tool with action read for mentions through #${seq}.`
export const wakeSequence = (text: string) => {
  const n = Number(/^Swarm board: call the board tool with action read for mentions through #(\d+)\.$/.exec(text.trim())?.[1])
  return Number.isSafeInteger(n) && n >= 1 ? n : NaN
}
/** The run folders a member's prompt names: its board command carries the one it belongs to. */
export const runsNamed = (prompt: string) => {
  const matches: string[] = []
  const re = /(?:^|[\s"'=`(])(?:[^\s"'=`(]*\/)?\.swarm\/([A-Za-z0-9_.-]+-\d{8}-\d{6}x*)(?![\w-]|\.\w)/g
  for (const m of prompt.matchAll(re)) {
    if (m[1]) matches.push(m[1])
  }
  return [...new Set(matches)].slice(0, 20)
}

/** A statement and the operator after it: `;` also stands for a newline, `|` for `|&`, `''` for the end. */
export type Statement = { text: string; piped: boolean; next: '&&' | '||' | ';' | '|' | '&' | '' }

/** Index of the `))` closing the `$((` that opens at `i`, or -1. */
const arithEnd = (command: string, i: number) => {
  let depth = 0
  for (let j = i + 2; j < command.length; j++) {
    if (command[j] === '(') depth++
    else if (command[j] === ')' && --depth < 0) return command[j + 1] === ')' ? j + 1 : -1
  }
  return -1
}

/** Splits a shell line into statements, flagging those whose stdout goes to a pipe or a redirect. */
export function scanShell(command: string): Statement[] {
  const segments: Statement[] = []
  const pendingHeredocs: Array<{ delim: string; stripTabs: boolean }> = []
  let quote: "'" | '"' | undefined
  let start = 0
  let textEnd = -1
  let redirected = false
  const push = (end: number, piped: boolean, next: Statement['next']) => {
    segments.push({ text: command.slice(start, textEnd >= 0 ? textEnd : end), piped: piped || redirected, next })
    textEnd = -1
    redirected = false
  }
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (ch === '\\' && quote !== "'") {
      i++
      continue
    }
    if (quote) {
      if (ch === quote) quote = undefined
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (ch === '#' && (i === 0 || /[\s;&|(]/.test(command[i - 1]!))) {
      textEnd = i
      const nl = command.indexOf('\n', i)
      i = nl === -1 ? command.length : nl - 1
      continue
    }
    if (ch === '$' && command[i + 1] === '(' && command[i + 2] === '(') {
      const end = arithEnd(command, i + 1)
      if (end > 0) {
        i = end
        continue
      }
    }
    if (ch === '>') {
      const prev = command[i - 1]
      const fd = /(?:^|[\s;&|(])(\d)$/.exec(command.slice(Math.max(0, i - 2), i))?.[1]
      // `>&2` and `1>&2` still reach the tool result; `>&file`, `1>&-` (closed) and `&>file` do not.
      const toFd = command[i + 1] === '&' && /^&\s*\d/.test(command.slice(i + 1))
      if (prev !== '>' && (fd === undefined || fd === '1') && !toFd) redirected = true
      continue
    }
    if (ch === '<' && command[i + 1] === '<' && command[i + 2] === '<') {
      i += 2
      continue
    }
    if (ch === '<' && command[i + 1] === '<') {
      let j = i + 2
      let stripTabs = false
      if (command[j] === '-') {
        stripTabs = true
        j++
      }
      while (j < command.length && (command[j] === ' ' || command[j] === '\t')) j++
      let delim = ''
      const q = command[j]
      if (q === "'" || q === '"') {
        j++
        while (j < command.length && command[j] !== q && command[j] !== '\n') {
          if (q === '"' && command[j] === '\\' && j + 1 < command.length) j++
          delim += command[j]!
          j++
        }
        if (command[j] === q) j++
      } else {
        while (j < command.length && !/[\s;|&<>()]/.test(command[j]!)) {
          if (command[j] === '\\' && j + 1 < command.length) j++
          delim += command[j]!
          j++
        }
      }
      if (delim) pendingHeredocs.push({ delim, stripTabs })
      i = j - 1
      continue
    }
    const isAnd = ch === '&' && command[i + 1] === '&'
    const isOr = ch === '|' && command[i + 1] === '|'
    const isPipe = ch === '|' && !isOr && command[i - 1] !== '>'
    const isBackground = ch === '&' && !isAnd && command[i + 1] !== '>' && command[i - 1] !== '>' && command[i - 1] !== '<'
    if (ch === ';' || ch === '\n' || isAnd || isOr || isPipe || isBackground) {
      push(i, isPipe, isAnd ? '&&' : isOr ? '||' : isPipe ? '|' : isBackground ? '&' : ';')
      if (isAnd || isOr || (isPipe && command[i + 1] === '&')) i++
      start = i + 1
      if (ch === '\n' && pendingHeredocs.length > 0) {
        let pos = i + 1
        while (pendingHeredocs.length > 0 && pos < command.length) {
          const { delim, stripTabs } = pendingHeredocs.shift()!
          while (pos < command.length) {
            const nl = command.indexOf('\n', pos)
            const lineEnd = nl === -1 ? command.length : nl
            const rawLine = command.slice(pos, lineEnd).replace(/\r$/, '')
            const candidate = stripTabs ? rawLine.replace(/^\t+/, '') : rawLine
            pos = nl === -1 ? command.length : nl + 1
            if (candidate === delim) break
          }
        }
        i = pos - 1
        start = pos
      }
    }
  }
  push(command.length, false, '')
  return segments.map(s => ({ ...s, text: s.text.trim() })).filter(s => s.text)
}

/** Splits a shell command line into individual statements on unquoted `&&`, `||`, `|`, `;`, `&`, and `\n`, skipping heredoc bodies and comments. */
export const splitShellSegments = (command: string): string[] => scanShell(command).map(s => s.text)

export type ParsedBoardCall = {
  dir: string
  action: string
  subarg?: string
  /** The remainder of the matched board.py segment starting at `<action>` after `<dir>`. */
  rest: string
  /** True when this segment's stdout goes to a pipe or is redirected (not `2>` or `2>&1`). */
  piped: boolean
}

/** Parses every board.py invocation in a possibly multi-command shell line. */
export function boardCalls(command: string): ParsedBoardCall[] {
  const results: ParsedBoardCall[] = []
  for (const { text: segment, piped } of scanShell(command)) {
    const match = BOARD_CALL.exec(segment)
    if (!match) continue
    const rawDir = match[1] ?? match[2] ?? match[3]?.replace(/\\(.)/g, '$1') ?? ''
    const dir = rawDir.replace(/\/+$/, '')
    const action = match[4]!
    const rest = segment.slice(match[0].length - action.length)
    const argument = /^[a-z]+[ \t]+(?:"@?([\w-]+)"|'@?([\w-]+)'|@?([\w-]+))(?=\s|$)/.exec(rest)
    const subarg = (argument?.[1] ?? argument?.[2] ?? argument?.[3])?.toLowerCase()
    results.push({ dir, action, subarg, rest, piped })
  }
  return results
}
