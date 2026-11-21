import { boardCalls } from './command'

export type Mood = 'sleep' | 'forage' | 'inspect' | 'build' | 'verify' | 'relay'
// The board's subcommands: a word after `board.py <folder>` that is none of these names a file, not a board call.
const BOARD_ACTIONS = new Set(['init', 'member', 'limit', 'plan', 'attention', 'retry', 'replace', 'post', 'read', 'show', 'ready', 'confirm',
  'revise', 'wake', 'claim', 'woke', 'rearm', 'pause', 'resume', 'bind', 'restore', 'adopt', 'locate', 'agent-run', 'started', 'close',
  'account', 'status', 'prune', 'tail', 'sync', 'export'])
/** The board subcommand a Bash command runs, if it runs one. */
const boardAction = (command: string) => {
  const loose = /\bboard\.py\S*\s+\S+\s+([a-z-]+)/.exec(command)?.[1]
  return boardCalls(command)[0]?.action ?? (loose && BOARD_ACTIONS.has(loose) ? loose : undefined)
}
export function toolMood(tool: string, command = ''): Mood {
  // The board first, by its subcommand: a post that mentions tests or reading is still a post.
  const board = tool === 'Bash' ? boardAction(command) : undefined
  if (board) return ['read', 'show', 'status', 'plan', 'attention', 'wake', 'tail', 'export'].includes(board) ? 'inspect' : 'relay'
  // A command that only looks is a lookup whatever its arguments are called: `cat test.py` runs no test.
  if (tool === 'Bash' && /^(?:git (?:diff|log|show|status)|cat|rg|ls|find|grep)\b/.test(command.trim())) return 'inspect'
  if (tool === 'Bash' && /\bverify\.py\b|\b(test|pytest|vitest|jest|unittest|check|verify)\b/.test(command)) return 'verify'
  if (['Read','Grep','Glob','LSP','WebSearch','WebFetch'].includes(tool)) return 'inspect'
  if (['Write','Edit','MultiEdit','NotebookEdit','Bash'].includes(tool)) return 'build'
  if (['Agent','SendMessage','mcp__swarm__board'].includes(tool)) return 'relay'
  return 'forage'
}
// A run of tool calls as one line, by what they did, as the desktop app folds them: "Searched code, read 13 files, 1 failed".
export function toolSummary(uses: readonly { tool: string; input?: Record<string, unknown>; isError?: true }[]): string {
  const counts = new Map<string, number>()
  for (const { tool, input } of uses) {
    const command = tool === 'Bash' ? String(input?.command ?? '') : ''
    const mood = toolMood(tool, command)
    const what = tool === 'Read' ? 'read|file'
      : tool === 'Grep' || tool === 'Glob' ? 'searched code|'
      : tool === 'mcp__swarm__board' || (command && boardAction(command)) ? 'used the board|'
      : mood === 'verify' ? 'ran|check'
      : tool === 'Bash' ? 'ran|command'
      : mood === 'build' ? 'edited|file'
      : tool === 'Agent' ? 'started|agent'
      : mood === 'relay' ? 'sent|message'
      : mood === 'inspect' ? 'made|lookup' : 'made|other call'
    counts.set(what, (counts.get(what) ?? 0) + 1)
  }
  const parts = [...counts].map(([what, n]) => {
    const [verb, noun] = what.split('|')
    return noun ? `${verb} ${n} ${noun}${n === 1 ? '' : 's'}` : `${verb}`
  })
  const failed = uses.filter(use => use.isError).length
  if (failed > 0) parts.push(`${failed} failed`)
  const line = parts.join(', ')
  return line.charAt(0).toUpperCase() + line.slice(1)
}
const scenes: Record<Mood, [string, [number, number], [number, number]]> = {
  sleep: ['M1 2h4v1H1zM3 3h1v1H3zM2 4h1v1H2zM1 5h4v1H1z', [0, -1], [0, -1]],
  inspect: ['M1 0h3v1H1zM0 1h1v3H0zM4 1h1v3H4zM1 4h3v1H1zM4 4h2v2H4z', [3, -2], [-2, 1]],
  build: ['M4 0h5v2H7v4H5V2H4z', [2, -3], [-3, 0]],
  verify: ['M1 2h2v2H1zM3 4h2v2H3zM5 2h2v2H5zM7 0h2v2H7z', [2, 0], [0, -3]],
  relay: ['M0 0h7v5H0z', [3, -2], [-4, 2]],
  forage: ['M4 3h2v2H4zM2 5h2v2H2z', [3, -3], [-2, 2]],
}
export function hiveArt(shown: Mood, elapsed = 0): string {
  // The mood comes from stored state and the time from a clock: one this version does not know, or a time that is
  // no count of milliseconds, must not break the drawing.
  const mood: Mood = Object.hasOwn(scenes, shown) ? shown : 'sleep'
  elapsed = Number.isFinite(elapsed) && elapsed > 0 ? Math.floor(elapsed) : 0
  const [prop, left, right] = scenes[mood]
  const sleeping = mood === 'sleep'
  const gesture = {
    sleep: 'translate(1px,-2px)', forage: 'translate(2px,-1px)', inspect: 'translate(1px,0px)',
    build: 'translate(0px,-1px)', verify: 'translate(0px,-1px)', relay: 'translate(10px,0px)',
  }[mood]
  const steps = ([x, y]: [number, number]) => {
    const midX = Math.round(x / 2), midY = Math.round(y / 2)
    return `0%,100%{transform:translate(0,0)}24%,80%{transform:translate(${midX}px,${midY}px)}48%,64%{transform:translate(${x}px,${y}px)}`
  }
  const beeBody = `<path class="wing" fill="var(--wing)" d="M2 0h2v2H2zM5 0h2v2H5z"/>
    <path fill="var(--honey)" d="M1 2h6v1h1v2H7v1H2V5H0V3h1z"/>
    <path fill="var(--ink)" d="M3 2h1v4H3z${sleeping ? 'M5 4h2v1H5z' : 'M6 3h1v1H6z'}"/>`
  const bee = (x: number, y: number, kind: string) =>
    `<g transform="translate(${x} ${y})"><g class="${kind}">${
      kind === 'right' ? `<g transform="translate(8 0) scale(-1 1)">${beeBody}</g>` : beeBody
    }</g></g>`
  const propMarkup = mood === 'relay'
    ? `<g class="prop"><path fill="var(--wing)" d="${prop}"/><path fill="var(--ink)" d="M0 0h1v1H0zM6 0h1v1H6zM1 1h1v1H1zM5 1h1v1H5zM2 2h3v1H2z"/></g>`
    : `<path class="prop" fill="var(--wing)" d="${prop}"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 22" shape-rendering="crispEdges">
    <style>svg{--wing:#4b8f91;--honey:#e9ac55;--ink:#664437;--wax:#b46b46}
    @media(prefers-color-scheme:dark){svg{--wing:#99c8c8}}
    @supports(color:color(display-p3 1 0 0)){svg{--wing:color(display-p3 .3602 .5544 .5647);--honey:color(display-p3 .8774 .6843 .3908);--ink:color(display-p3 .3804 .2724 .2245);--wax:color(display-p3 .6663 .4331 .3019)}@media(prefers-color-scheme:dark){svg{--wing:color(display-p3 .6379 .7791 .7816)}}}
    @media(prefers-reduced-motion:no-preference){.left{animation:l ${sleeping ? '5' : '3.4'}s steps(1,end) infinite;animation-delay:-${elapsed % (sleeping ? 5000 : 3400)}ms}.right{animation:r ${sleeping ? '5.6' : '4.8'}s steps(1,end) infinite;animation-delay:-${elapsed % (sleeping ? 5600 : 4800)}ms}.prop{transform-box:fill-box;transform-origin:center;animation:signal 4s steps(1,end) infinite;animation-delay:-${elapsed % 4000}ms}${sleeping ? '' : `.wing{animation:flutter .28s steps(1,end) infinite;animation-delay:-${elapsed % 280}ms}`}}
    @keyframes l{${steps(left)}}
    @keyframes r{${steps(right)}}
    @keyframes flutter{50%{transform:translateY(1px)}}@keyframes signal{0%,100%{opacity:.5}55%{opacity:1;transform:${gesture}}}
    </style><path fill="var(--wax)" d="M17 7h8v2h2v3h2v7H13v-7h2V9h2z"/>
    <path fill="var(--honey)" d="M17 8h8v2h-8zM15 11h12v2H15zM14 14h14v2H14z"/>
    <path fill="var(--ink)" d="M19 15h4v4h-4z"/>
    ${bee(sleeping ? 3 : 1, sleeping ? 14 : 12, 'left')}${bee(sleeping ? 31 : 33, sleeping ? 14 : 6, 'right')}
    <g transform="translate(${sleeping ? 27 : 9} 1)">${propMarkup}</g></svg>`
}
