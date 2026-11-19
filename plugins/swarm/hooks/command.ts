// The text forms this module recognises: a board command in a Bash call, a run folder, a wake message.

// python3 with any flags (-B), the script, the run folder (a trailing slash allowed), the subcommand.
export const BOARD_CALL = /^\s*python3\s+(?:-[A-Za-z]+\s+)*(?:"[^"\n]*\/board\.py"|'[^'\n]*\/board\.py'|[^\s"'<>;]*\/board\.py)\s+(?:"([^"\n]+)"|'([^'\n]+)'|([^\s"'<>;]+))\s+([a-z]+)(?:[ \t]+([a-z-]+))?/
export const RUN = /\/\.swarm\/[\w.-]+-\d{8}-\d{6}x*$/
// `read coordinator`, with the read's flags on either side of the name, which the board also takes as `@coordinator`.
// Only read off a BOARD_CALL whose subcommand is `read`: alone it also matches a commit message.
export const COORDINATOR_READ = /\bread\s+(?:--[a-z-]+(?:=\d+)?\s+)*@?coordinator\b/
export const wakeMessage = (seq: number) => `Swarm board: call the board tool with action read for mentions through #${seq}.`
export const wakeSequence = (text: string) => Number(/^Swarm board: call the board tool with action read for mentions through #(\d+)\.$/.exec(text)?.[1])
/** The run folders a member's prompt names: its board command carries the one it belongs to. */
export const runsNamed = (prompt: string) => [...new Set(prompt.match(/[A-Za-z0-9_.-]+-\d{8}-\d{6}x*/g) ?? [])].slice(0, 20)
