import type { Swarm } from '../types'
import { boardCalls } from './command'

export type Mood = NonNullable<Swarm['mood']>
// The board's subcommands, as tests/parity.json lists them: a word after `board.py <folder>` that is none of these
// names a file, not a board call.
export const BOARD_ACTIONS = new Set(['init', 'member', 'limit', 'plan', 'attention', 'retry', 'replace', 'post', 'read', 'show', 'ready', 'confirm',
  'revise', 'wake', 'claim', 'woke', 'rearm', 'pause', 'resume', 'bind', 'restore', 'adopt', 'locate', 'agent-run', 'started', 'close', 'kill',
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
  const smoothOrbit = ([x, y]: [number, number], flip = 1) => {
    const midX = (x * 0.55).toFixed(1)
    const midY = (y * 0.55 - 0.6 * flip).toFixed(1)
    const altX = (x * 0.35).toFixed(1)
    const altY = (y * 0.8 + 0.5 * flip).toFixed(1)
    return `0%,100%{transform:translate(0,0)}28%{transform:translate(${midX}px,${midY}px)}54%{transform:translate(${x}px,${y}px)}78%{transform:translate(${altX}px,${altY}px)}`
  }
  const propKeyframes: Record<Mood, string> = {
    sleep: '0%{opacity:0;transform:translate(0,1.5px) scale(.85)}25%{opacity:.85}75%{opacity:.75;transform:translate(1.8px,-2.6px) scale(1)}100%{opacity:0;transform:translate(2.5px,-3.6px) scale(1.05)}',
    inspect: '0%,100%{opacity:.75;transform:translate(-1.5px,0)}45%{opacity:1;transform:translate(3.2px,-1px)}70%{opacity:.95;transform:translate(1.2px,1px)}',
    build: '0%,100%{opacity:.8;transform:rotate(-16deg) translate(0,0)}35%{opacity:1;transform:rotate(14deg) translate(1px,1px)}55%{opacity:1;transform:rotate(-8deg) translate(0,-.5px)}',
    verify: '0%,100%{opacity:.78;transform:scale(.92) translate(0,0)}40%,60%{opacity:1;transform:scale(1.1) translate(0,-1.2px)}',
    relay: '0%{opacity:0;transform:translate(-1px,1px)}15%{opacity:1}80%{opacity:1;transform:translate(13px,-.5px)}100%{opacity:0;transform:translate(15px,1px)}',
    forage: '0%,100%{opacity:.55;transform:translate(0,0)}50%{opacity:1;transform:translate(2.6px,-1.6px)}',
  }
  const beeBody = `<path class="wing" fill="var(--wing)" d="M2 0h2v2H2zM5 0h2v2H5z"/>
    <path fill="var(--honey)" d="M1 2h6v1h1v2H7v1H2V5H0V3h1z"/>
    <path fill="var(--ink)" d="M3 2h1v4H3z${sleeping ? 'M5 4h2v1H5z' : 'M6 3h1v1H6z'}"/>`
  const bee = (x: number, y: number, kind: string) =>
    `<g transform="translate(${x} ${y})"><g class="${kind}">${
      kind === 'right' ? `<g transform="translate(8 0) scale(-1 1)">${beeBody}</g>` : beeBody
    }</g></g>`
  const propFill = mood === 'verify' ? 'var(--ok)' : 'var(--wing)'
  const propMarkup = mood === 'relay'
    ? `<g class="prop"><path fill="var(--wing)" d="${prop}"/><path fill="var(--ink)" d="M0 0h1v1H0zM6 0h1v1H6zM1 1h1v1H1zM5 1h1v1H5zM2 2h3v1H2z"/></g>`
    : mood === 'build'
      ? `<g class="prop"><path fill="var(--wing)" d="${prop}"/></g><path class="spark" fill="var(--spark)" d="M1 2h1v1H1zM10 1h1v1h-1zM3 0h1v1H3z"/>`
      : mood === 'sleep'
        ? `<path class="prop" fill="var(--wing)" d="${prop}"/><path class="prop-echo" fill="var(--wing)" d="M4 0h3v1H4zM5 1h1v1H5zM4 2h3v1H4z"/>`
        : mood === 'forage'
          ? `<path class="prop" fill="var(--wing)" d="${prop}"/><path class="spark" fill="var(--spark)" d="M0 2h1v1H0zM7 4h1v1H7zM5 0h1v1H5z"/>`
          : `<path class="prop" fill="${propFill}" d="${prop}"/>`
  const lDur = sleeping ? 4600 : 3200
  const rDur = sleeping ? 5200 : 4000
  const pDur = mood === 'relay' ? 2800 : mood === 'build' ? 1800 : 3400
  const aura = sleeping
    ? ''
    : '<defs><radialGradient id="hg"><stop offset="0%" stop-color="var(--honey)" stop-opacity=".42"/><stop offset="70%" stop-color="var(--honey)" stop-opacity=".14"/><stop offset="100%" stop-color="var(--honey)" stop-opacity="0"/></radialGradient></defs>' +
      '<ellipse class="aura" cx="21" cy="14" rx="13" ry="7.5" fill="url(#hg)" shape-rendering="auto"/>'
  const doorwayGlow = sleeping
    ? ''
    : '<rect class="door-glow" x="19" y="15" width="4" height="4" fill="var(--spark)"/>'
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 22" shape-rendering="crispEdges">
    <style>svg{--wing:#4b8f91;--honey:#e9ac55;--ink:#664437;--wax:#b46b46;--ok:#349962;--spark:#f6cf6e}
    @media(prefers-color-scheme:dark){svg{--wing:#99c8c8;--ok:#4cc480;--spark:#ffe08a}}
    @supports(color:color(display-p3 1 0 0)){svg{--wing:color(display-p3 .3602 .5544 .5647);--honey:color(display-p3 .8774 .6843 .3908);--ink:color(display-p3 .3804 .2724 .2245);--wax:color(display-p3 .6663 .4331 .3019);--ok:color(display-p3 .3224 .5918 .4028);--spark:color(display-p3 .96 .82 .45)}@media(prefers-color-scheme:dark){svg{--wing:color(display-p3 .6379 .7791 .7816);--ok:color(display-p3 .4333 .7586 .5248);--spark:color(display-p3 1 .88 .55)}}}
    .aura{opacity:.65}.door-glow{opacity:.2}.spark{opacity:0}.prop-echo{opacity:0}
    @media(prefers-reduced-motion:no-preference){
      .left{animation:l ${lDur}ms cubic-bezier(.42,0,.58,1) -${elapsed % lDur}ms infinite}
      .right{animation:r ${rDur}ms cubic-bezier(.42,0,.58,1) -${elapsed % rDur}ms infinite}
      .prop{transform-box:fill-box;transform-origin:center;animation:signal ${pDur}ms cubic-bezier(.4,0,.2,1) -${elapsed % pDur}ms infinite}
      .prop-echo{transform-box:fill-box;transform-origin:center;animation:signal ${pDur}ms cubic-bezier(.4,0,.2,1) -${(elapsed + Math.floor(pDur / 2)) % pDur}ms infinite}
      .spark{transform-box:fill-box;transform-origin:center;animation:sp ${pDur}ms ease-out -${elapsed % pDur}ms infinite}
      .aura{transform-box:fill-box;transform-origin:center;animation:glow 3.6s ease-in-out -${elapsed % 3600}ms infinite}
      .door-glow{animation:dg 2.6s ease-in-out -${elapsed % 2600}ms infinite}
      ${sleeping ? '' : `.wing{transform-box:fill-box;transform-origin:bottom center;animation:flutter 220ms ease-in-out -${elapsed % 220}ms infinite}`}
    }
    @keyframes l{${smoothOrbit(left, 1)}}
    @keyframes r{${smoothOrbit(right, -1)}}
    @keyframes flutter{0%,100%{transform:translateY(0) scaleY(1)}50%{transform:translateY(.7px) scaleY(.72)}}
    @keyframes signal{${propKeyframes[mood]}}
    @keyframes sp{0%,28%{opacity:0;transform:translateY(1px)}42%{opacity:1;transform:translateY(-1px)}80%,100%{opacity:0;transform:translateY(-3px)}}
    @keyframes glow{0%,100%{opacity:.45;transform:scale(.94)}50%{opacity:.95;transform:scale(1.06)}}
    @keyframes dg{0%,100%{opacity:.12}50%{opacity:.42}}
    </style>${aura}<path fill="var(--wax)" d="M17 7h8v2h2v3h2v7H13v-7h2V9h2z"/>
    <path fill="var(--honey)" d="M17 8h8v2h-8zM15 11h12v2H15zM14 14h14v2H14z"/>
    <path fill="var(--ink)" d="M19 15h4v4h-4z"/>${doorwayGlow}
    ${bee(sleeping ? 3 : 1, sleeping ? 14 : 12, 'left')}${bee(sleeping ? 31 : 33, sleeping ? 14 : 6, 'right')}
    <g transform="translate(${sleeping ? 27 : 9} 1)">${propMarkup}</g></svg>`
}
