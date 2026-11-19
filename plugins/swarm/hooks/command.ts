// The text forms this module recognises: a board command in a Bash call, a run folder, a wake message.

// python3 with any flags (-B, -X utf8), the script, the run folder (a trailing slash allowed), the subcommand.
export const BOARD_CALL = /^(?:[A-Za-z_]\w*=(?:"[^"\n]*"|'[^'\n]*'|[^\s"'<>;]*)\s+)*(?:\S*\/)?python3(?:\.\d+)?\s+(?:-(?:[A-Za-z]+|[XW]\s+\S+)\s+)*(?:"[^"\n]*(?:^|\/)board\.py"|'[^'\n]*(?:^|\/)board\.py'|(?:[^\s"'<>;]*\/)?board\.py)\s+(?:"([^"\n]+)"|'([^'\n]+)'|((?:\\.|[^\s"'<>;])+))\s+([a-z]+)(?:[ \t]+([a-z-]+))?/
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
  const re = /(?:^|[\s"'=])(?:[^\s"'=]*\/)?\.swarm\/([A-Za-z0-9_.-]+-\d{8}-\d{6}x*)(?![\w.-])/g
  for (const m of prompt.matchAll(re)) {
    if (m[1]) matches.push(m[1])
  }
  return [...new Set(matches)].slice(0, 20)
}

/** Splits a shell command line into individual statements on unquoted `&&`, `||`, `;`, and `\n`. */
export function splitShellSegments(command: string): string[] {
  const segments: string[] = []
  let quote: "'" | '"' | undefined
  let start = 0
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
    if (ch === ';' || ch === '\n' || (ch === '&' && command[i + 1] === '&') || (ch === '|' && command[i + 1] === '|')) {
      segments.push(command.slice(start, i))
      if (ch === '&' || ch === '|') i++
      start = i + 1
    }
  }
  segments.push(command.slice(start))
  return segments.map(s => s.trim()).filter(Boolean)
}

export type ParsedBoardCall = {
  dir: string
  action: string
  subarg?: string
  /** The remainder of the matched board.py segment starting at `<action>` after `<dir>`. */
  rest: string
}

/** Parses every board.py invocation in a possibly multi-command shell line. */
export function boardCalls(command: string): ParsedBoardCall[] {
  const results: ParsedBoardCall[] = []
  for (const segment of splitShellSegments(command)) {
    const match = BOARD_CALL.exec(segment)
    if (!match) continue
    const rawDir = match[1] ?? match[2] ?? match[3]?.replace(/\\(.)/g, '$1') ?? ''
    const dir = rawDir.replace(/\/+$/, '')
    const action = match[4]!
    const subarg = match[5]
    const tailLen = action.length + (subarg ? 1 + subarg.length : 0)
    const rest = segment.slice(Math.max(0, match[0].length - tailLen))
    results.push({ dir, action, subarg, rest })
  }
  return results
}
