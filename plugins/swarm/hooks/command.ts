// The text forms this module recognises: a board command in a Bash call, a run folder, a wake message.

// python3 with any flags (-B, -X utf8, -Xutf8; never -c or -m, which run something else) or the script run by its
// shebang, the script, the run folder (a trailing slash allowed), the subcommand. A backslash is only ever half of
// an escape, so no input can be matched two ways. An assignment's value holds no `(`: `R=$(board.py … init …)` is a
// call inside a substitution, whose output the shell keeps, not one this pattern reads.
export const BOARD_CALL = /^(?:[A-Za-z_]\w*=(?:"[^"\n]*"|'[^'\n]*'|[^\s"'<>;()`]*)\s+)*(?:(?:\S*\/)?python3(?:\.\d+)?\s+(?:-(?:[XW]\s+\S+|(?![cm](?:\s|$))[^\s"'<>;|&]+)\s+)*)?(?:"(?:[^"\n]*\/)?board\.py"|'(?:[^'\n]*\/)?board\.py'|(?:(?:\\.|[^\s"'<>;\\])*\/)?board\.py)\s+(?:"([^"\n]+)"|'([^'\n]+)'|((?:\\.|[^\s"'<>;\\])+))\s+([a-z]+(?:-[a-z]+)*)(?=$|[\s<>;|&)])/
export const RUN = /(?:^|\/)\.swarm\/[\w.-]+-\d{8}-\d{6}x*$/
// `read coordinator`, with the read's flags on either side of the name, which the board also takes as `@coordinator`.
// Only read off a BOARD_CALL whose subcommand is `read`: alone it also matches a commit message.
export const COORDINATOR_READ = /\bread\s+(?:["']?--[a-z-]+(?:=[^\s"']+)?["']?\s+)*["']?@?coordinator["']?(?=\s|$|[;|&<>)])/i
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

/**
 * A statement and the operator after it: `;` also stands for a newline, `|` for `|&`, `''` for the end.
 * `inner` lists the commands of its `$(…)`, backtick and `<(…)` substitutions, which run too; `plain` is the text
 * without them and without arithmetic, when it has any.
 */
export type Statement = { text: string; piped: boolean; next: '&&' | '||' | ';' | '|' | '&' | ''; inner?: string[]; plain?: string }

/** Index of the `))` closing the `((` that opens at `i`, or -1. */
const arithEnd = (command: string, i: number) => {
  let depth = 0
  for (let j = i + 2; j < command.length; j++) {
    if (command[j] === '(') depth++
    else if (command[j] === ')' && --depth < 0) return command[j + 1] === ')' ? j + 1 : -1
  }
  return -1
}

/** Index of the backtick closing the one at `i`, or -1. */
const tickEnd = (command: string, i: number) => {
  for (let j = i + 1; j < command.length; j++) {
    if (command[j] === '\\') j++
    else if (command[j] === '`') return j
  }
  return -1
}

/** Index of the quote closing the double quote at `i`, or -1: an escape and a substitution inside it are stepped over. */
const quoteEnd = (command: string, i: number): number => {
  for (let j = i + 1; j < command.length; j++) {
    const ch = command[j]
    if (ch === '\\') j++
    else if (ch === '"') return j
    else if (ch === '`' || (ch === '$' && command[j + 1] === '(')) {
      j = ch === '`' ? tickEnd(command, j) : parenEnd(command, j + 2)
      if (j < 0) return -1
    }
  }
  return -1
}

/** Index of the `)` closing a `(` whose body starts at `from`, or -1: quotes and nested parentheses are stepped over. */
const parenEnd = (command: string, from: number): number => {
  let depth = 0
  for (let j = from; j < command.length; j++) {
    const ch = command[j]
    if (ch === '\\') j++
    else if (ch === "'") {
      // $'…' takes escapes; a plain single quote takes none.
      if (command[j - 1] === '$') {
        for (j++; j < command.length && command[j] !== "'"; j++) if (command[j] === '\\') j++
        if (j >= command.length) return -1
      } else {
        j = command.indexOf("'", j + 1)
        if (j < 0) return -1
      }
    } else if (ch === '"' || ch === '`') {
      j = ch === '"' ? quoteEnd(command, j) : tickEnd(command, j)
      if (j < 0) return -1
    } else if (ch === '(') depth++
    else if (ch === ')' && depth-- === 0) return j
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
  let dollar = -2
  let inner: string[] = []
  let holes: Array<[number, number]> = []
  const push = (end: number, piped: boolean, next: Statement['next']) => {
    const stop = textEnd >= 0 ? textEnd : end
    const statement: Statement = { text: command.slice(start, stop), piped: piped || redirected, next }
    if (inner.length > 0) statement.inner = inner
    if (holes.length > 0) {
      let plain = ''
      let at = start
      for (const [from, to] of holes) {
        if (from >= stop) break
        plain += `${command.slice(at, from)}_`
        at = Math.min(stop, to + 1)
      }
      statement.plain = plain + command.slice(at, stop)
    }
    segments.push(statement)
    textEnd = -1
    redirected = false
    inner = []
    holes = []
  }
  // What a substitution or an arithmetic expression spans is kept whole in its statement and never split.
  const skip = (from: number, to: number, body?: string) => {
    if (body !== undefined) inner.push(body)
    holes.push([from, to])
    return to
  }
  // An arithmetic expression runs the substitutions inside it; its `<<` is a shift, not a heredoc.
  const arithmetic = (from: number, bodyStart: number, end: number) => {
    for (const s of scanShell(command.slice(bodyStart, end - 1).replace(/<</g, '  '))) inner.push(...(s.inner ?? []))
    return skip(from, end)
  }
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (ch === '\\' && quote !== "'") {
      i++
      continue
    }
    if (quote === "'") {
      if (ch === "'") quote = undefined
      continue
    }
    // A substitution runs its commands inside double quotes too.
    if (ch === '$' && command[i + 1] === '(' && command[i + 2] === '(') {
      const end = arithEnd(command, i + 1)
      if (end > 0) {
        i = arithmetic(i, i + 3, end)
        continue
      }
    }
    if ((ch === '$' || (!quote && (ch === '<' || ch === '>'))) && command[i + 1] === '(') {
      const end = parenEnd(command, i + 2)
      if (end > 0) {
        i = skip(i, end, command.slice(i + 2, end))
        continue
      }
    }
    if (ch === '`') {
      const end = tickEnd(command, i)
      if (end > 0) {
        i = skip(i, end, command.slice(i + 1, end).replace(/\\([`$\\])/g, '$1'))
        continue
      }
    }
    if (quote) {
      if (ch === quote) quote = undefined
      continue
    }
    if (ch === '$') {
      dollar = i
      continue
    }
    if (ch === "'" && dollar === i - 1) {
      // $'…' takes escapes, so \' does not end it.
      for (i++; i < command.length && command[i] !== "'"; i++) if (command[i] === '\\') i++
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
    if (ch === '(' && command[i + 1] === '(') {
      const end = arithEnd(command, i)
      if (end > 0) {
        i = arithmetic(i, i + 2, end)
        continue
      }
    }
    if (ch === '>') {
      const prev = command[i - 1]
      // The descriptor before it, whole: `10>out` is not stdout.
      let digits = i
      while (digits > 0 && /\d/.test(command[digits - 1]!)) digits--
      const fd = digits < i && (digits === 0 || /[\s;&|(]/.test(command[digits - 1]!)) ? command.slice(digits, i) : undefined
      // `>&2` and `1>&2` still reach the tool result, and `>&1` changes nothing. `>&3`, `>&file`, `>&1.log`,
      // `1>&-` (closed) and `&>file` do not; `<>file` opens stdin.
      const toResult = /^&\s*[12](?=$|[\s;|&)<>])/.test(command.slice(i + 1, i + 12))
      if (prev !== '>' && prev !== '<' && (fd === undefined || fd === '1') && !toResult) redirected = true
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
      // The delimiter is one shell word: its quoted and bare pieces join, as in <<E'O'F and <<""EOF.
      const wordStart = j
      let delim = ''
      while (j < command.length && !/[\s;|&<>()]/.test(command[j]!)) {
        const q = command[j]!
        if (q === "'" || q === '"') {
          for (j++; j < command.length && command[j] !== q && command[j] !== '\n'; j++) {
            if (q === '"' && command[j] === '\\' && j + 1 < command.length) j++
            delim += command[j]!
          }
          if (command[j] === q) j++
        } else {
          if (q === '\\' && j + 1 < command.length) j++
          delim += command[j]!
          j++
        }
      }
      if (j > wordStart) pendingHeredocs.push({ delim, stripTabs })
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
  return segments.map(s => ({ ...s, text: s.text.trim(), ...(s.plain === undefined ? {} : { plain: s.plain.trim() }) })).filter(s => s.text)
}

// What may stand before the command a statement runs: `(`, `{`, `!`, a shell keyword, or an env/time-style prefix with its flags.
const WRAPPER = /^(?:[({!]|(?:if|elif|while|until|then|do|else|time|command|exec|nohup|env)(?=\s|$)(?:\s+(?:-u\s+\S+|-\S+))*)\s*/

/** A statement without the wrappers before its command, and whether an odd number of `!` negates it. */
export function unwrap(statement: string): { text: string; negated: boolean } {
  let text = statement.trim()
  let negated = false
  for (let prev = ''; prev !== text;) {
    prev = text
    if (text.startsWith('!')) negated = !negated
    text = text.replace(WRAPPER, '')
  }
  return { text, negated }
}

/** A statement's words with their quotes and escapes taken off: `"git" commit` and `\git commit` read as they run. */
export function shellWords(text: string): string[] {
  const words: string[] = []
  let word: string | undefined
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (/\s/.test(ch)) {
      if (word !== undefined) words.push(word)
      word = undefined
    } else if (ch === '\\') {
      word = (word ?? '') + (text[++i] ?? '')
    } else if (ch === "'" || ch === '"') {
      const isAnsi = ch === "'" && word?.endsWith('$') === true
      word = isAnsi ? word!.slice(0, -1) : word ?? ''
      for (i++; i < text.length && text[i] !== ch; i++) {
        if (text[i] === '\\' && (ch === '"' || isAnsi) && i + 1 < text.length) i++
        word += text[i]
      }
    } else {
      word = (word ?? '') + ch
    }
  }
  if (word !== undefined) words.push(word)
  return words
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
  for (const { text, piped } of scanShell(command)) {
    // `env`, `nohup`, `if` and their like stand before the call without changing what it is.
    const segment = unwrap(text).text
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

/** The commands inside a command's substitutions, at any depth: what `R=$(…)` runs and keeps out of the tool result. */
export function substitutions(command: string): string[] {
  return scanShell(command).flatMap(s => s.inner ?? []).flatMap(body => [body, ...substitutions(body)])
}
