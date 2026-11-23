// The text forms this module recognises: a board command in a Bash call, a run folder, a wake message.

// python with any flags (-B, -X utf8, -Xutf8, --check-hash-based-pycs always; never -c or -m, which run something else)
// or the script run by its shebang, the script, the run folder (a trailing slash allowed), the subcommand. A backslash
// is only ever half of an escape, so no input can be matched two ways. An assignment's value holds no `(`:
// `R=$(board.py … init …)` is a call inside a substitution, whose output the shell keeps, not one this pattern reads.
export const BOARD_CALL = /^(?:[A-Za-z_]\w*=(?:"[^"\n]*"|'[^'\n]*'|[^\s"'<>;()`]*)\s+)*(?:(?:\S*\/)?python(?:\d+(?:\.\d+)*)?\s+(?:-(?:(?:[XWQ]|-check-hash-based-pycs)\s+\S+|(?![cm](?:\s|$))[^\s"'<>;|&]+)\s+)*)?(?:"(?:[^"\n]*\/)?board\.py"|'(?:[^'\n]*\/)?board\.py'|(?:(?:\\.|[^\s"'<>;\\])*\/)?board\.py)\s+(?:"([^"\n]+)"|'([^'\n]+)'|((?:\\.|[^\s"'<>;\\])+))\s+([a-z]+(?:-[a-z]+)*)(?=$|[\s<>;|&)])/
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
 * A statement and the operator after it: `;` also stands for a newline, `|` for `|&`, `''` for the end; `;;` ends a
 * case arm, and `;&` (or `;;&`) ends one that goes on into the next.
 * `inner` lists the commands of its `$(…)`, backtick and `<(…)` substitutions, which run too; `plain` is the text
 * without them and without arithmetic, when it has any. `unread`: a substitution in it never closes, so what it runs
 * is not in `inner`.
 */
export type Statement = { text: string; piped: boolean; next: '&&' | '||' | ';' | ';;' | ';&' | '|' | '&' | ''; inner?: string[]; plain?: string; unread?: true }

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

/** Index of the `'` closing `$'…'` at `i`, or -1. */
const ansiQuoteEnd = (command: string, i: number): number => {
  for (let j = i + 1; j < command.length; j++) {
    if (command[j] === '\\') j++
    else if (command[j] === "'") return j
  }
  return -1
}

/** Index of the end of a `${…}`, `$((…))`, `$(…)` or backtick expansion at `i`, -1 if unclosed, or undefined if none. */
const expansionEnd = (command: string, i: number, inDouble = false): number | undefined => {
  const ch = command[i]
  if (ch === '`') return tickEnd(command, i)
  if (ch !== '$') return undefined
  if (command[i + 1] === '{') return braceEnd(command, i + 2, inDouble)
  if (command[i + 1] === '(') {
    const arith = command[i + 2] === '(' ? arithEnd(command, i + 1) : -1
    return arith > 0 ? arith : parenEnd(command, i + 2)
  }
  return undefined
}

/** Index of the quote closing the double quote at `i`, or -1: escapes, `${…}`, substitutions and arithmetic inside it are stepped over. */
const quoteEnd = (command: string, i: number): number => {
  for (let j = i + 1; j < command.length; j++) {
    const ch = command[j]
    if (ch === '\\') j++
    else if (ch === '"') return j
    else {
      const end = expansionEnd(command, j, true)
      if (end !== undefined) {
        if (end < 0) return -1
        j = end
      }
    }
  }
  return -1
}

/** Index of the `}` closing a `${` whose body starts at `from`, or -1: nested `${…}`, quotes and substitutions are stepped over. */
const braceEnd = (command: string, from: number, inDouble = false): number => {
  let depth = 0
  for (let j = from; j < command.length; j++) {
    const ch = command[j]!
    if (ch === '\\') j++
    else if (ch === '$' && command[j + 1] === '{') {
      depth++
      j++
    } else if (ch === '"') {
      j = quoteEnd(command, j)
      if (j < 0) return -1
    } else if (ch === "'" && !inDouble) {
      j = command[j - 1] === '$' && !escaped(command, j - 1, from) ? ansiQuoteEnd(command, j) : command.indexOf("'", j + 1)
      if (j < 0) return -1
    } else if (ch === '}' && depth-- === 0) return j
    else {
      const end = expansionEnd(command, j, inDouble)
      if (end !== undefined) {
        if (end < 0) return -1
        j = end
      }
    }
  }
  return -1
}

// `quoted`: any quoting in the delimiter word makes the body literal; a bare one leaves its substitutions live.
type Heredoc = { delim: string; stripTabs: boolean; quoted: boolean }

/** The heredoc the `<<` at `i` opens, if its delimiter is a word, and the index after that word. */
const heredocAt = (command: string, i: number): { heredoc?: Heredoc; end: number } => {
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
  return { heredoc: j > wordStart ? { delim, stripTabs, quoted: /["'\\]/.test(command.slice(wordStart, j)) } : undefined, end: j }
}

/**
 * Index after the bodies of the heredocs in `pending`, the first starting at `pos`; `pending` is emptied. Inside a
 * substitution a delimiter line may go on with its `)`, as in `EOF)`: shells differ on it, and reading it as the
 * delimiter then the close keeps the commands after it in view. The index of that `)` is returned.
 */
const heredocsEnd = (command: string, pos: number, pending: Heredoc[], inParen = false) => {
  while (pending.length > 0 && pos < command.length) {
    const { delim, stripTabs } = pending.shift()!
    while (pos < command.length) {
      const nl = command.indexOf('\n', pos)
      const lineEnd = nl === -1 ? command.length : nl
      const rawLine = command.slice(pos, lineEnd).replace(/\r$/, '')
      const candidate = stripTabs ? rawLine.replace(/^\t+/, '') : rawLine
      if (inParen && candidate.startsWith(`${delim})`)) {
        pending.length = 0
        return pos + rawLine.length - candidate.length + delim.length
      }
      pos = nl === -1 ? command.length : nl + 1
      if (candidate === delim) break
    }
  }
  pending.length = 0
  return pos
}

/** The `$(…)` and backtick bodies in the text of an unquoted heredoc, where nothing but a backslash quotes. */
const heredocSubstitutions = (body: string): string[] => {
  const found: string[] = []
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\') i++
    else if (body[i] === '$' && body[i + 1] === '(') {
      const end = parenEnd(body, i + 2)
      // One that never closes is kept to the end: better read too much than lose a command.
      found.push(body.slice(i + 2, end < 0 ? body.length : end))
      i = end < 0 ? body.length : end
    } else if (body[i] === '`') {
      const end = body.indexOf('`', i + 1)
      found.push(body.slice(i + 1, end < 0 ? body.length : end))
      i = end < 0 ? body.length : end
    }
  }
  return found
}

/** True when the character at `k` follows an odd run of backslashes: it is escaped. */
const escaped = (command: string, k: number, from = 0) => {
  let n = 0
  while (k - 1 - n >= from && command[k - 1 - n] === '\\') n++
  return n % 2 === 1
}

/**
 * True when the character at `j` starts a word: a `#` there opens a comment. A backslash-newline joins the lines, and
 * an escaped blank is part of the word, so `a\ #b` is one word. Only ever asked outside quotes.
 */
const startsWord = (command: string, j: number, from = 0, boundary = /[\s;&|(]/) => {
  let before = j - 1
  while (before >= from && command[before] === '\n' && escaped(command, before, from)) before -= 2
  return before < from || (boundary.test(command[before]!) && !escaped(command, before, from))
}

/** Index of the `)` closing a `(` whose body starts at `from`, or -1: quotes, heredoc bodies, arithmetic, case patterns and nested parentheses are stepped over. */
const parenEnd = (command: string, from: number): number => {
  let depth = 0
  const heredocs: Heredoc[] = []
  // The case statements open here, by the depth each opened at: a pattern's `)` closes nothing.
  const cases: Array<{ depth: number; state: 'word' | 'pattern' | 'body' }> = []
  for (let j = from; j < command.length; j++) {
    const ch = command[j]!
    const open = cases.at(-1)
    if (ch === '\\') j++
    else if (ch === '\n' && heredocs.length > 0) {
      j = heredocsEnd(command, j + 1, heredocs, true) - 1
    } else if (ch === '#' && startsWord(command, j, from)) {
      // A comment runs to the end of its line: a quote or a parenthesis in it is text.
      const nl = command.indexOf('\n', j)
      if (nl < 0) return -1
      j = nl - 1
    } else if (ch === '<' && command[j + 1] === '<') {
      if (command[j + 2] === '<') j += 2
      else {
        const { heredoc, end } = heredocAt(command, j)
        if (heredoc) heredocs.push(heredoc)
        j = end - 1
      }
    } else if (ch === '(' && command[j + 1] === '(' && arithEnd(command, j) > 0) {
      // Its `<<` is a shift, not a heredoc.
      j = arithEnd(command, j)
    } else if (/[a-z]/.test(ch) && startsWord(command, j, from, /[\s;&|()]/)) {
      let end = j
      while (end < command.length && /\w/.test(command[end]!)) end++
      const word = /^(?:[\s;&|()<>]|$)/.test(command.slice(end, end + 1)) ? command.slice(j, end) : ''
      // `case` and `esac` are keywords only where a command starts: `echo case in a)` is no case.
      let p = j - 1
      while (p >= from && (command[p] === ' ' || command[p] === '\t')) p--
      const atCommand = p < from || /[;&|()\n{!]/.test(command[p]!) ||
        /(?:^|[\s;&|()])(?:then|do|else|elif|if|while|until|time)$/.test(command.slice(Math.max(from, p - 5), p + 1))
      if (word === 'case' && atCommand) cases.push({ depth, state: 'word' })
      else if (word === 'in' && open?.state === 'word') open.state = 'pattern'
      else if (word === 'esac' && open && open.depth === depth && (open.state === 'pattern' || atCommand)) cases.pop()
      j = end - 1
    } else if (ch === ';' && open?.state === 'body' && (command[j + 1] === ';' || command[j + 1] === '&')) {
      // `;;`, `;&` and `;;&` end a clause: a pattern comes next.
      open.state = 'pattern'
      j += command[j + 1] === ';' && command[j + 2] === '&' ? 2 : 1
    } else if (ch === "'") {
      // $'…' takes escapes; a plain single quote takes none.
      j = command[j - 1] === '$' && !escaped(command, j - 1, from) ? ansiQuoteEnd(command, j) : command.indexOf("'", j + 1)
      if (j < 0) return -1
    } else if (ch === '$' && command[j + 1] === '{') {
      j = braceEnd(command, j + 2)
      if (j < 0) return -1
    } else if (ch === '"' || ch === '`') {
      j = ch === '"' ? quoteEnd(command, j) : tickEnd(command, j)
      if (j < 0) return -1
    } else if (ch === '(') {
      // A pattern may open with `(`, as in `(a|b)`, which nests nothing.
      if (!(open?.state === 'pattern' && open.depth === depth && /\s/.test(command[j - 1]!))) depth++
    } else if (ch === ')') {
      if (open?.state === 'pattern' && open.depth === depth) open.state = 'body'
      else if (depth-- === 0) return j
    }
  }
  return -1
}

/**
 * A statement with its backslash-newlines taken out, as the shell joins the lines before it reads the words. One in
 * single quotes or `$'…'` is kept. Heredoc bodies and comments never reach a statement's text.
 */
const fold = (text: string) =>
  text.includes('\\\n')
    ? text.replace(/\$'(?:\\[\s\S]|[^\\'])*'?|'[^']*'?|"(?:\\[\s\S]|[^\\"])*"?|\\[\s\S]/g, m =>
      m[0] === "'" || m[0] === '$' ? m : m[0] === '"' ? m.replace(/\\[\s\S]/g, e => e === '\\\n' ? '' : e) : m === '\\\n' ? '' : m)
    : text

/** Splits a shell line into statements, flagging those whose stdout goes to a pipe or a redirect. */
export function scanShell(command: string): Statement[] {
  const segments: Statement[] = []
  const pendingHeredocs: Heredoc[] = []
  let quote: "'" | '"' | undefined
  // Saved outer quote state for each open `${…}` so nested quotes inside `"${…}"` cannot flip the outer quote.
  const braceQuotes: Array<'"' | undefined> = []
  let start = 0
  let textEnd = -1
  let redirected = false
  let dollar = -2
  let inner: string[] = []
  let holes: Array<[number, number]> = []
  let unread = false
  // The compound commands open here: `(…)`, `{ …; }`, `if … fi`, a loop's `… done`, `case … esac`, each with the
  // statement it started at. What a compound writes goes where its close sends it: `{ a; b; } | head` and
  // `for …; do a; done | head` pipe `a` too. `closes` is the first one this statement closes. A case is read as
  // its patterns and its arms: a pattern's `|` and `)` split and close nothing.
  type Group = { at: number; kind: '(' | '{' | 'if' | 'loop' | 'case'; state?: 'word' | 'pattern' | 'body' }
  const groups: Group[] = []
  let closes: number | undefined
  let redirectedAfterClose = false
  // Where the command of this statement starts: after a case pattern's `)`.
  let commandStart = 0
  const close = (kind: Group['kind']) => {
    if (groups.at(-1)?.kind !== kind) return
    const open = groups.pop()!.at
    closes = Math.min(closes ?? open, open)
  }
  const push = (end: number, piped: boolean, next: Statement['next']) => {
    const stop = textEnd >= 0 ? textEnd : end
    const statement: Statement = { text: fold(command.slice(start, stop)), piped: piped || redirected, next }
    if (closes !== undefined && (piped || redirectedAfterClose)) for (const s of segments.slice(closes)) s.piped = true
    if (inner.length > 0) statement.inner = inner
    if (unread) statement.unread = true
    if (holes.length > 0) {
      let plain = ''
      let at = start
      for (const [from, to] of holes) {
        if (from >= stop) break
        plain += `${command.slice(at, from)}_`
        at = Math.min(stop, to + 1)
      }
      statement.plain = fold(plain + command.slice(at, stop))
    }
    segments.push(statement)
    textEnd = -1
    redirected = false
    closes = undefined
    redirectedAfterClose = false
    inner = []
    holes = []
    unread = false
  }
  // What a substitution or an arithmetic expression spans is kept whole in its statement and never split.
  const skip = (from: number, to: number, body?: string) => {
    if (body !== undefined) inner.push(body)
    holes.push([from, to])
    return to
  }
  // An arithmetic expression runs the substitutions inside it; its `<<` is a shift, not a heredoc.
  const arithmetic = (from: number, bodyStart: number, end: number) => {
    for (const s of scanShell(command.slice(bodyStart, end - 1).replace(/<</g, '  '))) {
      inner.push(...(s.inner ?? []))
      if (s.unread) unread = true
    }
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
    const inDouble = quote === '"' || braceQuotes.includes('"')
    if ((ch === '$' || (!inDouble && (ch === '<' || ch === '>'))) && command[i + 1] === '(') {
      const end = parenEnd(command, i + 2)
      if (end > 0) {
        i = skip(i, end, command.slice(i + 2, end))
        continue
      }
      unread = true
    }
    if (ch === '`') {
      const end = tickEnd(command, i)
      if (end > 0) {
        i = skip(i, end, command.slice(i + 1, end).replace(/\\([`$\\])/g, '$1'))
        continue
      }
      unread = true
    }
    if (ch === '$' && command[i + 1] === '{') {
      braceQuotes.push(quote)
      quote = undefined
      i++
      continue
    }
    if (quote) {
      if (ch === quote) quote = undefined
      continue
    }
    if (braceQuotes.length > 0) {
      if (ch === '}') quote = braceQuotes.pop()
      else if (ch === '$') dollar = i
      else if (ch === '"') quote = ch
      else if (ch === "'" && !braceQuotes.includes('"')) {
        if (dollar === i - 1) {
          const end = ansiQuoteEnd(command, i)
          if (end < 0) {
            unread = true
            i = command.length
          } else i = end
        } else quote = ch
      }
      continue
    }
    if (ch === '$') {
      dollar = i
      continue
    }
    if (ch === "'" && dollar === i - 1) {
      // $'…' takes escapes, so \' does not end it.
      for (i++; i < command.length && command[i] !== "'"; i++) if (command[i] === '\\') i++
      if (i >= command.length) unread = true
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (ch === '#' && startsWord(command, i)) {
      textEnd = i
      const nl = command.indexOf('\n', i)
      i = nl === -1 ? command.length : nl - 1
      continue
    }
    const kase = groups.at(-1)?.kind === 'case' ? groups.at(-1) : undefined
    if (/[a-z]/.test(ch) && startsWord(command, i, 0, /[\s;&|()]/)) {
      const word = /^[a-z]+(?=$|[\s;&|()<>])/.exec(command.slice(i, i + 8))?.[0]
      // A keyword only where a command starts: `echo done | head` closes nothing.
      const atCommand = word !== undefined && /^(?:[\s({!]+|(?:then|do|else|elif|if|while|until|time)\b)*$/.test(command.slice(Math.max(start, commandStart), i).replace(/\\\n/g, ''))
      if (word === 'in' && kase?.state === 'word') kase.state = 'pattern'
      else if (word === 'esac' && kase && (kase.state === 'pattern' || atCommand)) close('case')
      else if (atCommand && word === 'case') groups.push({ at: segments.length, kind: 'case', state: 'word' })
      else if (atCommand && (word === 'if' || word === 'while' || word === 'until' || word === 'for' || word === 'select')) {
        groups.push({ at: segments.length, kind: word === 'if' ? 'if' : 'loop' })
      } else if (atCommand && word === 'fi') close('if')
      else if (atCommand && word === 'done') close('loop')
      if (word !== undefined) {
        i += word.length - 1
        continue
      }
    }
    if (kase?.state === 'pattern') {
      // `a|b)` and `(a)` are a pattern: its `)` starts the arm's command.
      if (ch === ')') {
        kase.state = 'body'
        commandStart = i + 1
        continue
      }
      if (ch === '|' || ch === '(') continue
    }
    if (ch === ';' && kase?.state === 'body' && (command[i + 1] === ';' || command[i + 1] === '&')) {
      // `;;` ends an arm, `;&` and `;;&` go on into the next: a pattern comes next.
      const fallsThrough = command[i + 1] === '&' || command[i + 2] === '&'
      if (fold(command.slice(start, textEnd >= 0 ? textEnd : i)).trim() === '' && segments.length > 0) segments.at(-1)!.next = fallsThrough ? ';&' : ';;'
      else push(i, false, fallsThrough ? ';&' : ';;')
      i += command[i + 1] === ';' && command[i + 2] === '&' ? 2 : 1
      start = i + 1
      kase.state = 'pattern'
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
      const fd = digits < i && startsWord(command, digits) ? command.slice(digits, i) : undefined
      // `>&2` and `1>&2` still reach the tool result, and `>&1` changes nothing. `>&3`, `>&file`, `>&1.log`,
      // `1>&-` (closed) and `&>file` do not; `<>file` opens stdin.
      const toResult = /^&\s*[12](?=$|[\s;|&)<>])/.test(command.slice(i + 1, i + 12))
      if (prev !== '>' && prev !== '<' && (fd === undefined || fd === '1') && !toResult) {
        redirected = true
        if (closes !== undefined) redirectedAfterClose = true
      }
      continue
    }
    const isBrace = (ch === '{' || ch === '}') && startsWord(command, i) && /^(?:[\s;&|<>)]|$)/.test(command.slice(i + 1, i + 2))
    if (ch === '(' || (ch === '{' && isBrace)) {
      groups.push({ at: segments.length, kind: ch === '(' ? '(' : '{' })
      continue
    }
    if (ch === ')' || (ch === '}' && isBrace)) {
      close(ch === ')' ? '(' : '{')
      continue
    }
    if (ch === '<' && command[i + 1] === '<' && command[i + 2] === '<') {
      i += 2
      continue
    }
    if (ch === '<' && command[i + 1] === '<') {
      const { heredoc, end } = heredocAt(command, i)
      if (heredoc) pendingHeredocs.push(heredoc)
      i = end - 1
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
        const live = pendingHeredocs.some(heredoc => !heredoc.quoted)
        const bodies = i + 1
        i = heredocsEnd(command, bodies, pendingHeredocs) - 1
        // The shell runs what an unquoted heredoc's body substitutes: it belongs to the statement that reads it.
        const ran = live ? heredocSubstitutions(command.slice(bodies, i + 1)) : []
        if (ran.length > 0) (segments.at(-1)!.inner ??= []).push(...ran)
        start = i + 1
      }
    }
  }
  if (quote !== undefined || braceQuotes.length > 0) unread = true
  push(command.length, false, '')
  return segments.map(s => ({ ...s, text: s.text.trim(), ...(s.plain === undefined ? {} : { plain: s.plain.trim() }) })).filter(s => s.text)
}

// One word of a case pattern, and a pattern with its optional `(`, its alternatives and its `)`: what a case arm's command follows.
const PATTERN_WORD = `(?:"[^"]*"|'[^']*'|\\\\.|[^\\s()|;&"'\\\\\`])+`
const CASE_ARMS = `\\(?\\s*${PATTERN_WORD}(?:\\s*\\|\\s*${PATTERN_WORD})*\\s*\\)`
export const CASE_PATTERN = new RegExp(`^${CASE_ARMS}\\s*`)

// What may stand before the command a statement runs: `(`, `{`, `!`, a shell keyword, an env/time-style prefix with
// its flags, `case WORD in`, or a case pattern such as `*)` or `a|b)`: a clause after `;;` is a statement of its own.
// A word and `)` before a redirect is a subshell's last command, `(a; b) > out`, not a pattern.
const WRAPPER = new RegExp(`^(?:[({!]|(?:if|elif|while|until|then|do|else|time|command|exec|nohup|env)(?=\\s|$)(?:\\s+(?:-u\\s+\\S+|-\\S+))*|case\\s+(?:"[^"]*"|'[^']*'|\\S+)\\s+in(?=\\s|$)|${CASE_ARMS}(?!\\s*\\d*[<>]))\\s*`)

/** A statement without the wrappers before its command, and whether an odd number of `!` negates it. */
export function unwrap(statement: string): { text: string; negated: boolean } {
  let text = fold(statement).trim()
  let negated = false
  for (let prev = ''; prev !== text;) {
    prev = text
    if (text.startsWith('!')) negated = !negated
    text = text.replace(WRAPPER, '')
  }
  return { text, negated }
}

/** A statement's words with their quotes and escapes taken off: `"git" commit` and `\git commit` read as they run. */
/** A redirection operator at the start of a word, with the descriptor before it. */
const REDIRECT = /^(\d*|&)(<<<|<<-?|<>|>>|>\||&>>?|[<>]&?)/
/**
 * Leads a word that reads like a redirection and is none: its first character was quoted or escaped, as in the
 * program of `bash -c '>out cmd'`. `withoutRedirects` keeps such a word and takes the mark off; a redirection whose
 * target is quoted (`>'out file'`) begins bare and carries none.
 */
const QUOTED_START = '\u0001'
export function shellWords(text: string): string[] {
  text = fold(text)
  const words: string[] = []
  let word: string | undefined
  let isBare = true
  const push = () => {
    if (word !== undefined) words.push(!isBare && REDIRECT.test(word) ? QUOTED_START + word : word)
    word = undefined
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (word === undefined && !/\s/.test(ch)) isBare = ch !== '\\' && ch !== "'" && ch !== '"'
    if (/\s/.test(ch)) {
      push()
    } else if (ch === '\\') {
      word = (word ?? '') + (text[++i] ?? '')
    } else if (ch === '$' && text[i + 1] === '{') {
      const end = braceEnd(text, i + 2)
      const stop = end < 0 ? text.length : end + 1
      word = (word ?? '') + text.slice(i, stop)
      i = stop - 1
    } else if (ch === "'" || ch === '"') {
      const isAnsi = ch === "'" && word?.endsWith('$') === true
      word = isAnsi ? word!.slice(0, -1) : word ?? ''
      for (i++; i < text.length && text[i] !== ch; i++) {
        const end = ch === '"' ? expansionEnd(text, i, true) : undefined
        if (end !== undefined) {
          const stop = end < 0 ? text.length : end + 1
          word += text.slice(i, stop)
          i = stop - 1
          continue
        }
        if (text[i] === '\\' && (ch === '"' || isAnsi) && i + 1 < text.length) i++
        word += text[i]
      }
    } else {
      word = (word ?? '') + ch
    }
  }
  push()
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

// The git commands that make a commit. `stash`, `reset`, `checkout` and their like make none.
export const COMMITTING = ['commit', 'commit-tree', 'merge', 'cherry-pick', 'revert', 'am', 'rebase', 'pull', 'filter-branch', 'subtree']
// Per git command that may make none: its options that take a value, read with it so a value is never read as an
// option (`-X ignore-space-change` holds no -n): short ones (`-Xours`, `-X ours`), short ones whose value is only
// ever attached (`-S`, `-Skey`), and long ones (`--strategy=ours`, `--strategy ours`). `stops`: the long options that
// make it make none whatever else is given (git refuses them beside another action).
type GitOptions = { short: string; attached: string; long: string[]; stops: string[] }
const PICK: GitOptions = { short: 'mX', attached: 'S', long: ['mainline', 'strategy', 'strategy-option', 'cleanup', 'empty'], stops: ['abort', 'quit'] }
const GIT_OPTIONS: Record<string, GitOptions> = {
  merge: { short: 'sXmF', attached: 'S', long: ['strategy', 'strategy-option', 'message', 'file', 'into-name', 'cleanup'], stops: ['abort', 'quit'] },
  'cherry-pick': PICK,
  revert: PICK,
  am: { short: 'pC', attached: 'S', long: ['directory', 'exclude', 'include', 'patch-format', 'resolvemsg', 'whitespace', 'quoted-cr', 'empty'],
    stops: ['abort', 'quit', 'show-current-patch'] },
  rebase: { short: 'sXxC', attached: 'Sr', long: ['onto', 'strategy', 'strategy-option', 'exec', 'whitespace', 'empty', 'trailer'],
    stops: ['abort', 'quit', 'show-current-patch', 'edit-todo'] },
  pull: { short: 'sXjo', attached: 'Sr', long: ['strategy', 'strategy-option', 'depth', 'deepen', 'shallow-since', 'shallow-exclude', 'jobs',
    'upload-pack', 'server-option', 'negotiation-tip', 'cleanup', 'refmap'], stops: [] },
}
const FALSE = /^(?:false|no|off|0)$/i
/**
 * Whether `git <sub> <args…>` makes a commit: some options make these make none (`merge --abort`, `cherry-pick -n`).
 * Options are read in order, as git reads them: the last of `--no-commit` and `--commit` wins, and of `--ff-only`
 * and `--ff`. A long option git takes shortened (`--comm`) counts as the one it stands for when that makes a commit;
 * only the full spelling makes none.
 */
export function makesCommit(sub: string, args: readonly string[]): boolean {
  const options = GIT_OPTIONS[sub]
  if (!options) return COMMITTING.includes(sub)
  const isPick = sub === 'cherry-pick' || sub === 'revert'
  let stops = false
  let noCommit = false
  let squash = false
  let ffOnly = false
  let rebase = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--') break
    if (arg.startsWith('--')) {
      const [, name = '', value] = /^--([^=]*)(?:=([\s\S]*))?$/.exec(arg) ?? []
      if (name && options.long.some(long => long.startsWith(name))) {
        if (value === undefined) i++
        continue
      }
      if (options.stops.includes(name)) stops = true
      let base = name
      let negated = false
      while (base.startsWith('no-')) {
        base = base.slice(3)
        negated = !negated
      }
      if (base.length > 1 && 'commit'.startsWith(base)) noCommit = arg === '--no-commit'
      // A squash merge leaves its result staged and commits nothing; the last of the two given holds.
      if (base.length > 1 && 'squash'.startsWith(base)) squash = !negated
      if (base.length > 1 && 'ff-only'.startsWith(base)) ffOnly = arg === '--ff-only'
      if (base.length > 1 && 'rebase'.startsWith(base)) rebase = !negated && !FALSE.test(value ?? '')
    } else if (arg.startsWith('-')) {
      for (let j = 1; j < arg.length; j++) {
        const option = arg[j]!
        if (options.attached.includes(option)) {
          if (sub === 'pull' && option === 'r') rebase = !FALSE.test(arg.slice(j + 1))
          break
        }
        if (options.short.includes(option)) {
          if (j === arg.length - 1) i++
          break
        }
        if (option === 'n' && isPick) noCommit = true
      }
    }
  }
  if (stops) return false
  // A fast-forward makes no commit; a rebase may.
  if (sub === 'pull') return !ffOnly || rebase
  return !((noCommit && (isPick || sub === 'merge')) || (squash && sub === 'merge'))
}
/** A command line that names git and a command that commits: refused where the guard cannot read the command. */
export const NAMES_COMMIT = new RegExp(`\\bgit\\b[\\s\\S]*\\b(?:${COMMITTING.join('|')})\\b|\\bgit-(?:${COMMITTING.join('|')})\\b`)
// The git commands that make no commit and that no alias can stand for: git never lets an alias hide one.
export const GIT_BUILTINS = new Set(['add', 'annotate', 'apply', 'archive', 'bisect', 'blame', 'branch', 'bugreport', 'bundle', 'cat-file',
  'check-attr', 'check-ignore', 'check-mailmap', 'check-ref-format', 'checkout', 'checkout-index', 'cherry', 'clean', 'clone', 'column',
  'config', 'count-objects', 'describe', 'diff', 'diff-files', 'diff-index', 'diff-tree', 'difftool', 'fetch', 'for-each-ref',
  'format-patch', 'fsck', 'gc', 'grep', 'hash-object', 'help', 'init', 'log', 'ls-files', 'ls-remote', 'ls-tree', 'maintenance',
  'merge-base', 'merge-file', 'merge-tree', 'mergetool', 'mv', 'name-rev', 'notes', 'prune', 'push', 'range-diff', 'read-tree', 'reflog',
  'remote', 'repack', 'replace', 'rerere', 'reset', 'restore', 'rev-list', 'rev-parse', 'rm', 'shortlog', 'show', 'show-branch',
  'show-ref', 'sparse-checkout', 'stash', 'status', 'submodule', 'switch', 'symbolic-ref', 'tag', 'update-index', 'update-ref',
  'var', 'verify-commit', 'verify-tag', 'version', 'whatchanged', 'worktree', 'write-tree'])

/**
 * A command's text without the `)`s that close a subshell opened before it, and how many there are: `git commit)` is
 * `git commit` and one close. Quoted and escaped parentheses, and pairs such as `a=(1 2)`, stay.
 */
export function closesAfter(text: string): { text: string; closes: number } {
  let kept = ''
  let depth = 0
  let closes = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (ch === '\\') {
      kept += text.slice(i, i + 2)
      i++
    } else if (ch === '$' && text[i + 1] === '{') {
      const end = braceEnd(text, i + 2)
      const stop = end < 0 ? text.length : end + 1
      kept += text.slice(i, stop)
      i = stop - 1
    } else if (ch === "'") {
      const end = text[i - 1] === '$' && !escaped(text, i - 1) ? ansiQuoteEnd(text, i) : text.indexOf("'", i + 1)
      const stop = end < 0 ? text.length : end + 1
      kept += text.slice(i, stop)
      i = stop - 1
    } else if (ch === '"') {
      const end = quoteEnd(text, i)
      const stop = end < 0 ? text.length : end + 1
      kept += text.slice(i, stop)
      i = stop - 1
    } else if (ch === '(') {
      depth++
      kept += ch
    } else if (ch === ')') {
      if (depth > 0) {
        depth--
        kept += ch
      } else closes++
    } else kept += ch
  }
  return { text: kept, closes }
}

/** A command's words without its redirections and their targets; what a here-string (`<<< text`) feeds it is `fed`. */
export function withoutRedirects(words: readonly string[]): { words: string[]; fed?: string } {
  const kept: string[] = []
  let fed: string | undefined
  for (let i = 0; i < words.length; i++) {
    // A word marked as quoted from its start is an argument, a `-c` program that begins with a redirection among
    // them. The longer operators come first: `>>` read as `>` would leave its second character as the target.
    if (words[i]!.startsWith(QUOTED_START)) {
      kept.push(words[i]!.slice(1))
      continue
    }
    const operator = REDIRECT.exec(words[i]!)
    if (!operator) {
      kept.push(words[i]!)
      continue
    }
    const target = words[i]!.length > operator[0].length ? words[i]!.slice(operator[0].length) : words[++i]?.replace(QUOTED_START, '')
    // Only what feeds its input, descriptor 0, is a program it may read.
    if (operator[2] === '<<<' && (operator[1] === '' || Number(operator[1]) === 0)) fed = target ?? ''
  }
  return fed === undefined ? { words: kept } : { words: kept, fed }
}

export const SHELLS = /^(?:ba|da|k|z)?sh$/
/**
 * What a shell's words after its name run: the program `-c` gives (`code`, with the operands after it, which the
 * program may run as `$1`), a script file, or its input (`stdin`). `-o`, `-O` and `--rcfile` take a value, so
 * `bash -o pipefail` still reads its input; a c in a value is no -c.
 */
export function shellLaunch(args: readonly string[]): { code?: string; operands: string[]; file?: string; stdin: boolean; fed?: string } {
  const { words, fed } = withoutRedirects(args)
  let i = 0
  let isCode = false
  let isStdin = false
  for (; i < words.length; i++) {
    const word = words[i]!
    if (word === '--' || word === '-') {
      i++
      break
    }
    if (!/^[-+]./.test(word)) break
    if (word.startsWith('--')) {
      if (word === '--rcfile' || word === '--init-file') i++
      continue
    }
    for (const option of word.slice(1)) {
      if (option === 'c' && word[0] === '-') isCode = true
      else if (option === 's') isStdin = true
      else if (option === 'o' || option === 'O') i++
    }
  }
  const operands = words.slice(i)
  const extra = fed === undefined ? {} : { fed }
  if (isCode) return { code: operands[0] ?? '', operands: operands.slice(1), stdin: false, ...extra }
  return isStdin || operands.length === 0 ? { operands, stdin: true, ...extra } : { operands, file: operands[0], stdin: false, ...extra }
}

/**
 * Every script a command line runs, itself first: its substitutions, and what it hands to `sh -c`, a here-string
 * shell, `eval`, `watch` or `env -S`, at any depth.
 */
export function scriptsRun(command: string, depth = 0): string[] {
  const found = [command]
  if (depth > 6) return found
  for (const statement of scanShell(command)) {
    for (const body of statement.inner ?? []) found.push(...scriptsRun(body, depth + 1))
    const words = shellWords(unwrap(statement.text).text)
    words.forEach((word, k) => {
      const name = word.replace(/^.*\//, '')
      const after = words.slice(k + 1)
      if (SHELLS.test(name)) {
        const shell = shellLaunch(after)
        // The program, and the operands after it, which it may run as `$1`.
        if (shell.code !== undefined) for (const script of [shell.code, ...shell.operands]) found.push(...scriptsRun(script, depth + 1))
        else if (shell.stdin && shell.fed !== undefined) found.push(...scriptsRun(shell.fed, depth + 1))
      } else if (name === 'eval' || name === 'watch') found.push(...scriptsRun(after.join(' '), depth + 1))
    })
    // env -S splits its value into the command it runs: read off the words before the wrappers come off.
    const raw = shellWords(statement.text)
    raw.forEach((word, k) => {
      if (word.replace(/^.*\//, '') !== 'env') return
      for (let j = k + 1; j < raw.length && raw[j]!.startsWith('-'); j++) {
        const split = /^(?:-[^-S]*S|--split-string=?)([\s\S]*)$/.exec(raw[j]!)
        if (split) found.push(...scriptsRun(split[1] || raw[j + 1] || '', depth + 1))
      }
    })
  }
  return found
}

// Commands that run the rest of their words as a command: a script named after one of these is run.
export const RUNNERS = new Set(['env', 'nohup', 'time', 'command', 'builtin', 'exec', 'sudo', 'doas', 'timeout', 'nice', 'xargs', 'watch', 'stdbuf',
  'caffeinate', 'xcrun', 'flock', 'parallel', 'ionice', 'taskset', 'setsid', 'chronic', 'unbuffer'])
// The runners that take the program as their first word when no option or operand of their own comes before it.
const DIRECT = new Set(['env', 'nohup', 'time', 'command', 'builtin', 'exec', 'sudo', 'doas', 'nice', 'stdbuf', 'caffeinate', 'xcrun', 'chronic', 'unbuffer', 'ionice'])
const PYTHON = /^(?:python|pypy)(?:\d+(?:\.\d+)*)?$/
// Modules that read a script without running it: `python3 -m py_compile board.py` runs none of it. Any other module
// given the script (runpy, pdb, cProfile, trace) may run it.
const READING_MODULES = new Set(['py_compile', 'compileall', 'tokenize', 'tabnanny', 'pyflakes', 'mypy', 'ruff', 'black', 'isort', 'flake8',
  'pylint', 'pycodestyle'])
// Interpreters that take a program inline (`perl -e`, `node -e`, `ruby -e`, awk's program) or from their input.
const SCRIPTERS = /^(?:perl|ruby|node|nodejs|bun|deno|php|lua|osascript|[gmn]?awk|Rscript|tclsh|expect)$/

/**
 * How python's words after its name run the script `file`: `'script'` when it is the script python runs, `'other'`
 * when python may run it some other way (its -c program or the program's operands name it, a module that runs
 * scripts is given it, python reads its program from an input that names it, or -i reads more after the script).
 * Options are read as python reads
 * them: -W, -X and --check-hash-based-pycs take a value (`-Wonce` holds no c), and -c and -m end the options, with
 * their value attached (`-Bc…`) or the next word.
 */
function pythonRuns(args: readonly string[], file: string, input: string): 'script' | 'other' | undefined {
  const named = (words: readonly string[]) => words.some(word => word.includes(file))
  let inspects = false
  const script = (word: string | undefined) => word?.replace(/^.*\//, '') !== file ? undefined : inspects ? 'other' : 'script'
  for (let i = 0; i < args.length; i++) {
    const word = args[i]!
    if (word === '-') return input.includes(file) || named(args.slice(i + 1)) ? 'other' : undefined
    if (word === '--') return script(args[i + 1])
    if (!word.startsWith('-')) return script(word)
    if (word.startsWith('--')) {
      if (word === '--check-hash-based-pycs') i++
      continue
    }
    for (let j = 1; j < word.length; j++) {
      const option = word[j]!
      if (option === 'c' || option === 'm') {
        const value = word.slice(j + 1) || args[++i] || ''
        const rest = args.slice(i + 1)
        if (option === 'c') return named([value, ...rest]) ? 'other' : undefined
        return !READING_MODULES.has(value) && named(rest) ? 'other' : undefined
      }
      if (option === 'W' || option === 'X' || option === 'Q') {
        if (j === word.length - 1) i++
        break
      }
      if (option === 'i') inspects = true
    }
  }
  // No script: python reads its program from its input.
  return input.includes(file) ? 'other' : undefined
}

/**
 * How a statement's words run the script `file` (`board.py`): `'script'` when a python launcher or the command itself
 * runs it, with the words after it as its arguments; `'other'` when it may run it in a way those words do not show:
 * python's -c or a module that runs scripts, another interpreter's inline program that names it, or a shell or an
 * interpreter reading its program from an input that names it. `input` is what may reach a command's input: the
 * whole command line, heredoc bodies included. undefined when it does not run it.
 */
export function launches(statementWords: readonly string[], file: string, input = ''): 'script' | 'other' | undefined {
  const { words, fed } = withoutRedirects(statementWords)
  const stdin = `${fed ?? ''}\n${input}`
  const base = (word: string) => word.replace(/^.*\//, '')
  // Where a command starts: after assignments, and after a command that runs the rest of its words with its options.
  const isCommand = (k: number) => words.slice(0, k).every((word, j) =>
    /^[A-Za-z_]\w*=/.test(word) || RUNNERS.has(base(word)) || /^[-+\d]/.test(word) || words[j - 1]?.startsWith('-'))
  for (let k = 0; k < words.length; k++) {
    const name = base(words[k]!)
    const after = words.slice(k + 1)
    if (PYTHON.test(name)) {
      const how = pythonRuns(after, file, stdin)
      if (how) return how
    } else if (SHELLS.test(name) && isCommand(k)) {
      if (shellLaunch(after).stdin && stdin.includes(file)) return 'other'
    } else if (SCRIPTERS.test(name) && isCommand(k)) {
      if (after.some(word => word.includes(file))) return 'other'
      if (!after.some(word => !word.startsWith('-')) && stdin.includes(file)) return 'other'
    }
  }
  const at = words.findIndex(word => base(word) === file)
  if (at < 0) return undefined
  // Run as the command itself, or behind a command that runs the rest of its words; `find -name board.py` runs nothing.
  let first = words.findIndex(word => !/^[A-Za-z_]\w*=/.test(word))
  // A runner whose next word is the program it runs: `env grep board.py` runs grep. One followed by an option or an
  // operand of its own keeps its words unread, so the script among them counts as run.
  while (first >= 0 && first < at && DIRECT.has(base(words[first]!)) && /^[A-Za-z_./~]/.test(words[first + 1] ?? '-') &&
      !/^[A-Za-z_]\w*=/.test(words[first + 1]!)) first++
  return first >= 0 && (first === at || RUNNERS.has(base(words[first]!))) ? 'script' : undefined
}
