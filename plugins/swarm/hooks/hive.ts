import type { Swarm } from '../types'
import { boardCalls } from './command'
import { easeInOut, easeOut, loopDelay } from './motion'

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
  sleep: ['', [0, 0], [0, 0]],
  inspect: ['M1 0h3v1H1zM0 1h1v3H0zM4 1h1v3H4zM1 4h3v1H1zM4 4h2v2H4z', [3, -2], [-2, 1]],
  build: ['M4 0h5v2H7v4H5V2H4z', [2, -3], [-3, 0]],
  verify: ['M1 2h2v2H1zM3 4h2v2H3zM5 2h2v2H5zM7 0h2v2H7z', [2, 0], [0, -3]],
  relay: ['M0 0h7v5H0z', [3, -2], [-4, 2]],
  forage: ['M4 3h2v2H4zM2 5h2v2H2z', [3, -3], [-2, 2]],
}
const wingFrames = '@keyframes flutter{0%,100%{transform:scaleY(1)}50%{transform:scaleY(.58)}}'
const wings = (elapsed: number, duration: number, offset = 0) =>
  `transform-box:fill-box;transform-origin:bottom center;animation:flutter ${duration}ms ${easeInOut} ${loopDelay(elapsed, duration, offset)} infinite`

function beeBody(sleeping: boolean): string {
  return `<path class="wing" fill="var(--wing)" fill-opacity=".9" d="${sleeping ? 'M2 0h2v1H3v1H2zM5 0h2v1H6v1H5z' : 'M2 0h2v2H2zM5 0h2v2H5z'}"/>` +
    '<path fill="var(--honey)" d="M1 2h6v1h1v2H7v1H2V5H0V3h1z"/>' +
    `<path fill="var(--ink)" d="M3 2h1v4H3z${sleeping ? 'M5 4h2v1H5z' : 'M6 3h1v1H6z'}"/>`
}

// Follow one curve through the loop seam, without easing to a stop at each sampled waypoint.
function orbit([x, y]: [number, number], bend: number): string {
  return Array.from({ length: 13 }, (_, i) => {
    const angle = i * Math.PI / 6
    const distance = (1 - Math.cos(angle)) / 2
    return `${(i * 100 / 12).toFixed(2)}%{transform:translate(${(x * distance).toFixed(2)}px,${(y * distance + bend * Math.sin(angle)).toFixed(2)}px)}`
  }).join('')
}

function sleepMarks(elapsed: number): { style: string; art: string } {
  const duration = 3600
  return {
    style: `
      .sleep-mark{fill:var(--wing);opacity:.8;--peak:.9}.sleep-mark-small{opacity:.46;--peak:.58}
      @media(prefers-reduced-motion:no-preference){
        .sleep-mark{shape-rendering:auto;animation:doze ${duration}ms linear ${loopDelay(elapsed, duration, 460)} infinite}
        .sleep-mark-small{animation-delay:${loopDelay(elapsed, duration, 1760)}}
        .bee{shape-rendering:auto;transform-box:fill-box;transform-origin:bottom center;animation:rest 4.8s ${easeInOut} ${loopDelay(elapsed, 4800)} infinite}
        .right{animation-delay:${loopDelay(elapsed, 4800, 1370)}}
      }
      @keyframes doze{0%{opacity:0;transform:translate(0,0)}22%,62%{opacity:var(--peak)}100%{opacity:0;transform:translate(1px,-2px)}}
      @keyframes rest{0%,100%{transform:scaleY(1)}50%{transform:scaleY(.91)}}
    `,
    // Separate horizontal ranges, even at full drift: the large Z ends at x=36 and the small one starts at x=38.
    art: '<g transform="translate(30 8)"><path class="sleep-mark" d="M0 0h5v1H0zM3 1h1v1H3zM2 2h1v1H2zM1 3h1v1H1zM0 4h5v1H0z"/></g>' +
      '<g transform="translate(38 5)"><path class="sleep-mark sleep-mark-small" d="M0 0h4v1H0zM2 1h1v1H2zM1 2h1v1H1zM0 3h4v1H0z"/></g>',
  }
}

export const MEMBER_BEE_SIZE = { width: 16, height: 10 } as const

/** Front-facing card bee with stationary bounds. Active bees animate the light across both wings. */
export function memberBee(accent: `#${string}`, status: string, elapsed = 0): string {
  const active = status === 'working' || status === 'coordinating'
  const sleeping = status === 'waiting' || status === 'not started' || status === 'closed' || status === 'killed'
  const eyes = sleeping ? 'M6 3.5h1.5v.5H6zM8.5 3.5h1.5v.5H8.5z' : 'M6 3h1v1H6zM9 3h1v1H9z'
  const duration = 320
  const style =
    'svg{--wing-front:#769aa5;--wing-back:#65899b;--glint:#e5f4f4;--honey:#eab448;--stripe:#483328;--antennae:#78573e;--ink:#251e22}' +
    '@media(prefers-color-scheme:dark){svg{--wing-front:#afe0e1;--wing-back:#92cbd5;--glint:#edfbf6;--honey:#f3bf62;--antennae:#d4b79c}}' +
    '.wing-glint{fill:var(--glint);opacity:.54}' +
    (active
      ? `@media(prefers-reduced-motion:no-preference){` +
        `.wing-glint{animation:flutter ${duration}ms ${easeInOut} ${loopDelay(elapsed, duration)} infinite}` +
        `.wing-glint-back{animation-delay:${loopDelay(elapsed, duration, duration / 2)}}}` +
        '@keyframes flutter{0%,100%{opacity:.24}50%{opacity:.88}}'
      : '')
  const { width, height } = MEMBER_BEE_SIZE
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges"><style>${style}</style>` +
    '<path class="wing-back" fill="var(--wing-back)" d="M14 1h-2v1h-1v2h1v2h1V5h1V4h1V2h-1z"/>' +
    '<path class="wing-glint wing-glint-back" d="M13 2h1v1H13z"/>' +
    '<path class="wing-front" fill="var(--wing-front)" d="M2 1h2v1h1v2H4v2H3V5H2V4H1V2h1z"/>' +
    '<path class="wing-glint" d="M2 2h1v1H2z"/>' +
    '<path class="bee-antennae" fill="var(--antennae)" d="M5 0h1v1h1v1H6V1H5zM10 0h1v1h-1v1H9V1h1z"/>' +
    `<path class="bee-body" fill="${accent}" d="M6 2h4v1h1v1h1v4h-1v1h-1v1H6V9H5V8H4V4h1V3h1z"/>` +
    '<path class="bee-band" fill="var(--honey)" d="M5 5h6v1H5zM5 7h6v1H5z"/>' +
    '<path class="bee-band" fill="var(--stripe)" d="M5 6h6v1H5zM6 8h4v1H6z"/>' +
    `<path fill="var(--ink)" d="${eyes}"/></svg>`
}

export function hiveArt(shown: Mood, elapsed = 0): string {
  // The mood comes from stored state and the time from a clock: one this version does not know, or a time that is
  // no count of milliseconds, must not break the drawing.
  const mood: Mood = Object.hasOwn(scenes, shown) ? shown : 'sleep'
  const [prop, left, right] = scenes[mood]
  const sleeping = mood === 'sleep'
  const propKeyframes: Record<Exclude<Mood, 'sleep'>, string> = {
    inspect: '0%,100%{opacity:.76;transform:translate(-1px,0)}50%{opacity:1;transform:translate(2.5px,-.6px)}',
    build: '0%,100%{opacity:.78;transform:rotate(-18deg)}40%{opacity:1;transform:rotate(16deg) translateY(.45px)}70%{opacity:.9;transform:rotate(-7deg) translateY(-.25px)}',
    verify: '0%,100%{opacity:.75;transform:scale(.94)}50%{opacity:1;transform:translateY(-.9px) scale(1.06)}',
    relay: '0%{opacity:0;transform:translate(-1px,.6px)}16%{opacity:.95}78%{opacity:.95}100%{opacity:0;transform:translate(17px,-.6px)}',
    forage: '0%,100%{opacity:.56;transform:translate(0,0)}50%{opacity:1;transform:translate(2px,-1.4px)}',
  }
  const body = beeBody(sleeping)
  const bee = (x: number, y: number, side: 'left' | 'right') =>
    `<g transform="translate(${x} ${y})"><g class="bee ${side}">${
      side === 'right' ? `<g transform="translate(8 0) scale(-1 1)">${body}</g>` : body
    }</g></g>`
  const propFill = mood === 'verify' ? 'var(--ok)' : 'var(--wing)'
  const propMarkup = mood === 'relay'
    ? `<g class="prop"><path fill="var(--wing)" d="${prop}"/><path fill="var(--ink)" d="M0 0h1v1H0zM6 0h1v1H6zM1 1h1v1H1zM5 1h1v1H5zM2 2h3v1H2z"/></g>`
    : mood === 'build'
      ? `<g class="prop"><path fill="var(--wing)" d="${prop}"/></g><path class="spark" fill="var(--spark)" d="M1 2h1v1H1zM10 1h1v1h-1zM3 0h1v1H3z"/>`
      : mood === 'forage'
        ? `<path class="prop" fill="var(--wing)" d="${prop}"/><path class="spark" fill="var(--spark)" d="M0 2h1v1H0zM7 4h1v1H7zM5 0h1v1H5z"/>`
        : `<path class="prop" fill="${propFill}" d="${prop}"/>`
  const pDur = mood === 'relay' ? 3100 : mood === 'build' ? 2300 : 3600
  const aura = sleeping
    ? ''
    : '<defs><radialGradient id="hg"><stop offset="0%" stop-color="var(--honey)" stop-opacity=".42"/><stop offset="70%" stop-color="var(--honey)" stop-opacity=".14"/><stop offset="100%" stop-color="var(--honey)" stop-opacity="0"/></radialGradient></defs>' +
      '<ellipse class="aura" cx="21" cy="13.5" rx="13" ry="7.2" fill="url(#hg)" shape-rendering="auto"/>'
  const doorwayGlow = sleeping
    ? ''
    : '<rect class="door-glow" x="19" y="15" width="4" height="4" fill="var(--spark)"/>'
  const scene = sleeping ? sleepMarks(elapsed) : {
    style: `
      .aura{opacity:.65}.door-glow{opacity:.2}.spark{opacity:0}
      @media(prefers-reduced-motion:no-preference){
        .bee,.prop,.spark{shape-rendering:auto}
        .left{animation:l 3600ms linear ${loopDelay(elapsed, 3600)} infinite}
        .right{animation:r 4300ms linear ${loopDelay(elapsed, 4300, 560)} infinite}
        .left .wing{${wings(elapsed, 320)}}
        .right .wing{${wings(elapsed, 350, 130)}}
        .prop{transform-box:fill-box;transform-origin:center;animation:signal ${pDur}ms ${mood === 'relay' ? 'linear' : easeInOut} ${loopDelay(elapsed, pDur)} infinite}
        .spark{animation:spark ${pDur}ms ${easeOut} ${loopDelay(elapsed, pDur, 200)} infinite}
        .aura{transform-box:fill-box;transform-origin:center;animation:glow 4s ${easeInOut} ${loopDelay(elapsed, 4000)} infinite}
        .door-glow{animation:door-glow 3.2s ${easeInOut} ${loopDelay(elapsed, 3200)} infinite}
      }
      @keyframes l{${orbit(left, .6)}}
      @keyframes r{${orbit(right, -.68)}}
      ${wingFrames}
      @keyframes signal{${propKeyframes[mood]}}
      @keyframes spark{0%,24%{opacity:0;transform:translateY(.5px)}48%{opacity:.85}100%{opacity:0;transform:translateY(-1.25px)}}
      @keyframes glow{0%,100%{opacity:.45;transform:scale(.96)}50%{opacity:.85;transform:scale(1.06)}}
      @keyframes door-glow{0%,100%{opacity:.13}50%{opacity:.38}}
    `,
    art: `<g transform="translate(${mood === 'build' || mood === 'forage' ? 7 : 9} ${mood === 'relay' ? 1 : 2})">${propMarkup}</g>`,
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 22" shape-rendering="crispEdges">
    <style>svg{--wing:#4b8f91;--honey:#e9ac55;--ink:#664437;--wax:#b46b46;--ok:#349962;--spark:#f6cf6e}
    @media(prefers-color-scheme:dark){svg{--wing:#99c8c8;--ok:#4cc480;--spark:#ffe08a}}
    @supports(color:color(display-p3 1 0 0)){svg{--wing:color(display-p3 .3602 .5544 .5647);--honey:color(display-p3 .8774 .6843 .3908);--ink:color(display-p3 .3804 .2724 .2245);--wax:color(display-p3 .6663 .4331 .3019);--ok:color(display-p3 .3224 .5918 .4028);--spark:color(display-p3 .96 .82 .45)}@media(prefers-color-scheme:dark){svg{--wing:color(display-p3 .6379 .7791 .7816);--ok:color(display-p3 .4333 .7586 .5248);--spark:color(display-p3 1 .88 .55)}}}
    ${scene.style}
    </style>${aura}<path fill="var(--wax)" d="M17 7h8v2h2v3h2v7H13v-7h2V9h2z"/>
    <path fill="var(--honey)" d="M17 8h8v2h-8zM15 11h12v2H15zM14 14h14v2H14z"/>
    <path fill="var(--ink)" d="M19 15h4v4h-4z"/>${doorwayGlow}
    ${bee(sleeping ? 3 : 1, sleeping ? 14 : 12, 'left')}${bee(sleeping ? 31 : 33, sleeping ? 14 : 6, 'right')}
    ${scene.art}</svg>`
}
