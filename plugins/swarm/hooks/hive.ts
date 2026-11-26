import type { Swarm } from '../types'
import { boardCalls } from './command'
import { easeInOut, easeOut, hashSeed, loopDelay, pickVariant, seededPhase } from './motion'

export type Mood = NonNullable<Swarm['mood']>
// The board's subcommands, as tests/parity.json lists them: a word after `board.py <folder>` that is none of these
// names a file, not a board call.
export const BOARD_ACTIONS = new Set(['init', 'event', 'member', 'limit', 'dispatch', 'plan', 'attention', 'retry', 'replace', 'post', 'read', 'show', 'ready', 'confirm',
  'revise', 'wake', 'claim', 'unclaim', 'woke', 'rearm', 'pause', 'resume', 'bind', 'restore', 'adopt', 'locate', 'agent-run', 'started', 'close', 'kill',
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
type SceneMood = 'sleep' | 'forage' | 'inspect' | 'build' | 'verify' | 'relay' | 'paused' | 'attention'

const scenes: Record<SceneMood, [string, [number, number], [number, number]]> = {
  sleep: ['', [0, 0], [0, 0]],
  paused: ['M1 0h2v5H1zM4 0h2v5H4z', [0, 0], [0, 0]],
  attention: ['M2 0h2v3H2zM2 4h2v1H2z', [2, -1], [-2, 1]],
  inspect: ['M1 0h3v1H1zM0 1h1v3H0zM4 1h1v3H4zM1 4h3v1H1zM4 4h2v2H4z', [3, -2], [-2, 1]],
  build: ['M4 0h5v2H7v4H5V2H4z', [2, -3], [-3, 0]],
  verify: ['M1 2h2v2H1zM3 4h2v2H3zM5 2h2v2H5zM7 0h2v2H7z', [2, 0], [0, -3]],
  relay: ['M0 0h7v5H0z', [3, -2], [-4, 2]],
  forage: ['M4 3h2v2H4zM2 5h2v2H2z', [3, -3], [-2, 2]],
}

const HIVE_TOKENS =
  'svg{--wing:#4b8f91;--honey:#e8a848;--ink:#362218;--wax:#b46b46;--ok:#2d8a56;--spark:#f5cc66;--warn:#966919}' +
  '@media(prefers-color-scheme:dark){svg:not([data-mode=light]){--wing:#99c8c8;--honey:#f2bd6a;--ink:#2e1d14;--wax:#c9835b;--ok:#4cc480;--spark:#fde08d;--warn:#e0ae4f}}' +
  'svg[data-mode=dark]{--wing:#99c8c8;--honey:#f2bd6a;--ink:#2e1d14;--wax:#c9835b;--ok:#4cc480;--spark:#fde08d;--warn:#e0ae4f}' +
  '@supports(color:color(display-p3 1 0 0)){' +
  'svg{--wing:color(display-p3 .3602 .5544 .5647);--honey:color(display-p3 .8721 .6692 .3511);--ink:color(display-p3 .2003 .1367 .1005);--wax:color(display-p3 .6663 .4331 .3019);--ok:color(display-p3 .2864 .5337 .3551);--spark:color(display-p3 .9349 .8060 .4617);--warn:color(display-p3 .5620 .4192 .1691)}' +
  '@media(prefers-color-scheme:dark){svg:not([data-mode=light]){--wing:color(display-p3 .6379 .7791 .7816);--honey:color(display-p3 .9166 .7493 .4652);--ink:color(display-p3 .1705 .1165 .0841);--wax:color(display-p3 .7489 .5259 .3836);--ok:color(display-p3 .4333 .7586 .5248);--spark:color(display-p3 .9733 .8825 .5954);--warn:color(display-p3 .8479 .6901 .3727)}}' +
  'svg[data-mode=dark]{--wing:color(display-p3 .6379 .7791 .7816);--honey:color(display-p3 .9166 .7493 .4652);--ink:color(display-p3 .1705 .1165 .0841);--wax:color(display-p3 .7489 .5259 .3836);--ok:color(display-p3 .4333 .7586 .5248);--spark:color(display-p3 .9733 .8825 .5954);--warn:color(display-p3 .8479 .6901 .3727)}}'

const BEE_TOKENS =
  'svg{--wing-front:#5b989a;--wing-back:#4b8f91;--wing-edge:#3b7577;--glint:#edf8f8;--honey:#e8a848;--spark:#f7d26f;--stripe:#362218;--antennae:#4a3022;--ink:#2e1d14;' +
  '--warn:#966919;--err:#c54451;--stop:#b85334;--unreach:#9a5b7a;' +
  '--retired-body:#827d77;--retired-honey:#b9b2a6;--retired-stripe:#47423c;--retired-wing-f:#889394;--retired-wing-b:#747f80;--retired-ant:#5c5852;--retired-ink:#272420;' +
  '--brood-body:#968977;--brood-honey:#dfb96e;--brood-stripe:#4a3525;--brood-wing-f:#6b8d8e;--brood-wing-b:#577c7e}' +
  '@media(prefers-color-scheme:dark){svg:not([data-mode=light]){--wing-front:#b9dcdc;--wing-back:#99c8c8;--wing-edge:#6fa7a8;--glint:#f2fcf9;--honey:#f2bd6a;--spark:#fde08d;--stripe:#2e1d14;--antennae:#d4b79c;--ink:#23150e;' +
  '--warn:#e0ae4f;--err:#eb6f7a;--stop:#ea8662;--unreach:#d68fb2;' +
  '--retired-body:#9e9a93;--retired-honey:#cfc9be;--retired-stripe:#423d37;--retired-wing-f:#b3bcbe;--retired-wing-b:#96a0a2;--retired-ant:#847f77;--retired-ink:#2c2824;' +
  '--brood-body:#afa391;--brood-honey:#e5c882;--brood-stripe:#3a281b;--brood-wing-f:#a7c6c6;--brood-wing-b:#8db1b2}}' +
  'svg[data-mode=dark]{--wing-front:#b9dcdc;--wing-back:#99c8c8;--wing-edge:#6fa7a8;--glint:#f2fcf9;--honey:#f2bd6a;--spark:#fde08d;--stripe:#2e1d14;--antennae:#d4b79c;--ink:#23150e;' +
  '--warn:#e0ae4f;--err:#eb6f7a;--stop:#ea8662;--unreach:#d68fb2;' +
  '--retired-body:#9e9a93;--retired-honey:#cfc9be;--retired-stripe:#423d37;--retired-wing-f:#b3bcbe;--retired-wing-b:#96a0a2;--retired-ant:#847f77;--retired-ink:#2c2824;' +
  '--brood-body:#afa391;--brood-honey:#e5c882;--brood-stripe:#3a281b;--brood-wing-f:#a7c6c6;--brood-wing-b:#8db1b2}' +
  '@supports(color:color(display-p3 1 0 0)){' +
  'svg{--wing-front:color(display-p3 .4125 .5900 .6002);--wing-back:color(display-p3 .3602 .5544 .5647);--wing-edge:color(display-p3 .2882 .4534 .4633);--glint:color(display-p3 .9373 .9712 .9718);--honey:color(display-p3 .8721 .6692 .3511);--spark:color(display-p3 .9450 .8289 .4926);--stripe:color(display-p3 .2003 .1367 .1005);--antennae:color(display-p3 .2752 .1926 .1423);--ink:color(display-p3 .1705 .1165 .0841);' +
  '--warn:color(display-p3 .5620 .4192 .1691);--err:color(display-p3 .7149 .3024 .3294);--stop:color(display-p3 .6724 .3484 .2367);--unreach:color(display-p3 .5698 .3685 .4734);' +
  '--retired-body:color(display-p3 .5064 .4909 .4692);--retired-honey:color(display-p3 .7207 .6990 .6559);--retired-stripe:color(display-p3 .2751 .2595 .2379);--retired-wing-f:color(display-p3 .5413 .5751 .5793);--retired-wing-b:color(display-p3 .4629 .4967 .5009);--retired-ant:color(display-p3 .3569 .3412 .3176);--retired-ink:color(display-p3 .1509 .1416 .1272);' +
  '--brood-body:color(display-p3 .5796 .5390 .4746);--brood-honey:color(display-p3 .8505 .7311 .4728);--brood-stripe:color(display-p3 .2776 .2112 .1542);--brood-wing-f:color(display-p3 .4470 .5492 .5545);--brood-wing-b:color(display-p3 .3722 .4823 .4914)}' +
  '@media(prefers-color-scheme:dark){svg:not([data-mode=light]){--wing-front:color(display-p3 .7523 .8586 .8606);--wing-back:color(display-p3 .6379 .7791 .7816);--wing-edge:color(display-p3 .4838 .6491 .6555);--glint:color(display-p3 .9561 .9870 .9769);--honey:color(display-p3 .9166 .7493 .4652);--spark:color(display-p3 .9733 .8825 .5954);--stripe:color(display-p3 .1705 .1165 .0841);--antennae:color(display-p3 .8127 .7218 .6247);--ink:color(display-p3 .1291 .0847 .0593);' +
  '--warn:color(display-p3 .8479 .6901 .3727);--err:color(display-p3 .8606 .4629 .4877);--stop:color(display-p3 .8646 .5447 .4135);--unreach:color(display-p3 .7989 .5729 .6920);' +
  '--retired-body:color(display-p3 .6169 .6044 .5792);--retired-honey:color(display-p3 .8077 .7890 .7495);--retired-stripe:color(display-p3 .2555 .2399 .2183);--retired-wing-f:color(display-p3 .7084 .7361 .7438);--retired-wing-b:color(display-p3 .5954 .6262 .6340);--retired-ant:color(display-p3 .5142 .4987 .4700);--retired-ink:color(display-p3 .1699 .1574 .1430);' +
  '--brood-body:color(display-p3 .6782 .6408 .5764);--brood-honey:color(display-p3 .8792 .7884 .5454);--brood-stripe:color(display-p3 .2168 .1597 .1134);--brood-wing-f:color(display-p3 .6786 .7728 .7745);--brood-wing-b:color(display-p3 .5813 .6900 .6955)}}' +
  'svg[data-mode=dark]{--wing-front:color(display-p3 .7523 .8586 .8606);--wing-back:color(display-p3 .6379 .7791 .7816);--wing-edge:color(display-p3 .4838 .6491 .6555);--glint:color(display-p3 .9561 .9870 .9769);--honey:color(display-p3 .9166 .7493 .4652);--spark:color(display-p3 .9733 .8825 .5954);--stripe:color(display-p3 .1705 .1165 .0841);--antennae:color(display-p3 .8127 .7218 .6247);--ink:color(display-p3 .1291 .0847 .0593);' +
  '--warn:color(display-p3 .8479 .6901 .3727);--err:color(display-p3 .8606 .4629 .4877);--stop:color(display-p3 .8646 .5447 .4135);--unreach:color(display-p3 .7989 .5729 .6920);' +
  '--retired-body:color(display-p3 .6169 .6044 .5792);--retired-honey:color(display-p3 .8077 .7890 .7495);--retired-stripe:color(display-p3 .2555 .2399 .2183);--retired-wing-f:color(display-p3 .7084 .7361 .7438);--retired-wing-b:color(display-p3 .5954 .6262 .6340);--retired-ant:color(display-p3 .5142 .4987 .4700);--retired-ink:color(display-p3 .1699 .1574 .1430);' +
  '--brood-body:color(display-p3 .6782 .6408 .5764);--brood-honey:color(display-p3 .8792 .7884 .5454);--brood-stripe:color(display-p3 .2168 .1597 .1134);--brood-wing-f:color(display-p3 .6786 .7728 .7745);--brood-wing-b:color(display-p3 .5813 .6900 .6955)}}'

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

function sleepMarks(elapsed: number, moodPhase: number): { style: string; art: string } {
  const duration = 3600
  return {
    style:
      '.sleep-mark{fill:var(--wing);opacity:0;--peak:.9}.sleep-mark-small{--peak:.58}' +
      `.sleep-mark{shape-rendering:auto;animation:doze ${duration}ms linear ${loopDelay(elapsed, duration, 460 + moodPhase)} infinite}` +
      `.sleep-mark-small{animation-delay:${loopDelay(elapsed, duration, 1760 + moodPhase)}}` +
      `.sleep-mark-left{animation-delay:${loopDelay(elapsed, duration, 2540 + moodPhase)}}` +
      `.bee{shape-rendering:auto;transform-box:fill-box;transform-origin:bottom center;animation:rest 4800ms ${easeInOut} ${loopDelay(elapsed, 4800, moodPhase)} infinite}` +
      `.right{animation-delay:${loopDelay(elapsed, 4800, 1370 + moodPhase)}}` +
      '@keyframes doze{0%{opacity:0;transform:translate(0,0)}22%,62%{opacity:var(--peak)}100%{opacity:0;transform:translate(1px,-2px)}}' +
      '@keyframes rest{0%,100%{transform:scaleY(1)}50%{transform:scaleY(.91)}}' +
      '@media(prefers-reduced-motion:reduce){.sleep-mark,.bee{animation:none!important;shape-rendering:crispEdges}.sleep-mark{opacity:0}}',
    // Symmetric Zzz above the sleeping bees, clear of the skep (14..30) even at peak drift.
    art:
      '<g transform="translate(7 8)"><path class="sleep-mark sleep-mark-small sleep-mark-left" d="M0 0h3v1H0zM2 1h1v1H2zM1 2h1v1H1zM0 3h3v1H0z"/></g>' +
      '<g transform="translate(31 7)"><path class="sleep-mark" d="M0 0h5v1H0zM3 1h1v1H3zM2 2h1v1H2zM1 3h1v1H1zM0 4h5v1H0z"/></g>' +
      '<g transform="translate(37 4)"><path class="sleep-mark sleep-mark-small" d="M0 0h4v1H0zM2 1h1v1H2zM1 2h1v1H1zM0 3h4v1H0z"/></g>',
  }
}

export const MEMBER_BEE_SIZE = { width: 24, height: 16 } as const

type BeeStatus =
  | 'working'
  | 'coordinating'
  | 'waiting'
  | 'not started'
  | 'paused'
  | 'closed'
  | 'killed'
  | 'stopped'
  | 'failed'
  | 'unreachable'

type WingPose = 'spread' | 'folded' | 'drooped'
type EyePose = 'open' | 'sleep' | 'calm' | 'flat' | 'wince' | 'search' | 'retired'

const KNOWN_STATUSES = new Set<BeeStatus>([
  'working', 'coordinating', 'waiting', 'not started', 'paused',
  'closed', 'killed', 'stopped', 'failed', 'unreachable',
])

const VARIANT_COUNTS: Record<BeeStatus, number> = {
  working: 4,
  coordinating: 3,
  waiting: 4,
  'not started': 3,
  paused: 3,
  closed: 3,
  killed: 3,
  stopped: 3,
  failed: 3,
  unreachable: 3,
}

const WING_LEFT =
  '<path class="wing-front" fill="var(--wing-front)" fill-opacity=".86" stroke="var(--wing-edge)" stroke-width=".95" d="M20.2 14.3C17.8 9.7 11.4 7.5 8.8 10.3 7 12.3 9.4 16.1 15.2 16.1 17.8 16.1 19.6 15.3 20.2 14.3Z"/>' +
  '<path class="wing-front" fill="var(--wing-front)" fill-opacity=".72" stroke="var(--wing-edge)" stroke-width=".85" d="M19.8 15.7C16.4 15.5 12 16.3 11.4 18.5 11 20 13.8 20.7 16.8 19.3 18.5 18.5 19.6 17 19.8 15.7Z"/>' +
  '<path class="wing-glint" fill="var(--glint)" fill-opacity=".68" d="M10.8 11.1C12.4 9.7 15.6 10.3 17.6 12.3 15.4 11.3 12.8 11.1 10.8 11.9Z"/>'

const WING_RIGHT =
  '<path class="wing-back" fill="var(--wing-back)" fill-opacity=".86" stroke="var(--wing-edge)" stroke-width=".95" d="M27.8 14.3C30.2 9.7 36.6 7.5 39.2 10.3 41 12.3 38.6 16.1 32.8 16.1 30.2 16.1 28.4 15.3 27.8 14.3Z"/>' +
  '<path class="wing-back" fill="var(--wing-back)" fill-opacity=".72" stroke="var(--wing-edge)" stroke-width=".85" d="M28.2 15.7C31.6 15.5 36 16.3 36.6 18.5 37 20 34.2 20.7 31.2 19.3 29.5 18.5 28.4 17 28.2 15.7Z"/>' +
  '<path class="wing-glint wing-glint-back" fill="var(--glint)" fill-opacity=".68" d="M37.2 11.1C35.6 9.7 32.4 10.3 30.4 12.3 32.6 11.3 35.2 11.1 37.2 11.9Z"/>'

const EYES: Record<EyePose, string> = {
  open:
    '<ellipse cx="22" cy="9.7" rx="1.05" ry="1.35" fill="var(--ink)"/>' +
    '<ellipse cx="26" cy="9.7" rx="1.05" ry="1.35" fill="var(--ink)"/>' +
    '<circle cx="21.6" cy="9.15" r=".45" fill="#fff"/>' +
    '<circle cx="25.6" cy="9.15" r=".45" fill="#fff"/>' +
    '<path d="M23.1 11.55Q24 12.25 24.9 11.55" fill="none" stroke="var(--ink)" stroke-width=".9" stroke-linecap="round"/>',
  sleep:
    '<path d="M20.8 9.6Q22 10.7 23.2 9.6M24.8 9.6Q26 10.7 27.2 9.6" fill="none" stroke="var(--ink)" stroke-width="1.15" stroke-linecap="round"/>' +
    '<path d="M23.2 11.5Q24 12 24.8 11.5" fill="none" stroke="var(--ink)" stroke-width=".85" stroke-linecap="round"/>',
  calm:
    '<path d="M20.9 9.9Q22 10.4 23.1 9.9M24.9 9.9Q26 10.4 27.1 9.9" fill="none" stroke="var(--ink)" stroke-width="1.1" stroke-linecap="round"/>',
  flat:
    '<path d="M20.8 9.8H23.1M24.9 9.8H27.2" fill="none" stroke="var(--ink)" stroke-width="1.3" stroke-linecap="round"/>',
  wince:
    '<path d="M20.9 8.8L22.9 9.8 20.9 10.8M27.1 8.8L25.1 9.8 27.1 10.8" fill="none" stroke="var(--ink)" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>',
  search:
    '<ellipse cx="22.3" cy="9.7" rx="1.15" ry="1.35" fill="var(--ink)"/>' +
    '<ellipse cx="26.3" cy="9.7" rx=".95" ry="1.15" fill="var(--ink)"/>' +
    '<circle cx="22.6" cy="9.2" r=".42" fill="#fff"/>' +
    '<circle cx="26.5" cy="9.2" r=".38" fill="#fff"/>',
  retired:
    '<path d="M21.2 9.1L22.8 10.5M22.8 9.1L21.2 10.5M25.2 9.1L26.8 10.5M26.8 9.1L25.2 10.5" fill="none" stroke="var(--retired-ink)" stroke-width="1.15" stroke-linecap="round"/>',
}

/**
 * Front-facing 48x32 vector member bee centered at (24, 16.5) across all 10 lifecycle states.
 * Deterministically picks one of 3–4 motion variants per status from `seed` and honors reduced motion.
 */
export function memberBee(accent: `#${string}`, status: string, elapsed = 0, seed = '', isPaused = false): string {
  // Kept through a pause, as the status dot and the graph keep them: a member the run lost contact with is still lost,
  // and one never started has no work for the pause to stop.
  const terminalOrBroken = status === 'killed' || status === 'closed' || status === 'failed' || status === 'stopped' || status === 'unreachable' || status === 'not started'
  const effective: BeeStatus =
    status === 'paused' || (isPaused && !terminalOrBroken)
      ? 'paused'
      : KNOWN_STATUSES.has(status as BeeStatus)
        ? (status as BeeStatus)
        : 'waiting'

  const who = seed || accent
  const variant = pickVariant(who, VARIANT_COUNTS[effective])
  const jitter = (base: number) => Math.max(80, Math.round(base * (0.93 + (hashSeed(`${who}:${base}`) % 15) / 100)))
  const delay = (dur: number, salt: string | number, extraOffset = 0) =>
    loopDelay(elapsed, dur, seededPhase(who, salt, dur) + extraOffset)

  const wingPose: WingPose =
    effective === 'working' || effective === 'coordinating' || effective === 'failed' || effective === 'unreachable'
      ? 'spread'
      : effective === 'stopped' || effective === 'killed'
        ? 'drooped'
        : 'folded'

  const eyePose: EyePose =
    effective === 'working' || effective === 'coordinating' ? 'open'
      : effective === 'waiting' || effective === 'closed' ? 'sleep'
        : effective === 'not started' || effective === 'paused' ? 'calm'
          : effective === 'stopped' ? 'flat'
            : effective === 'failed' ? 'wince'
              : effective === 'unreachable' ? 'search'
                : 'retired'

  let baseStyle = BEE_TOKENS
  let motionStyle = ''
  let defs = '<clipPath id="ab"><path d="M18.2 18.7C18.2 15.9 20.8 14.9 24 14.9 27.2 14.9 29.8 15.9 29.8 18.7 29.8 22.5 27 25.6 24 26 21 25.6 18.2 22.5 18.2 18.7Z"/></clipPath>'
  let backFx = ''
  let frontFx = ''
  let innerFx = ''
  let sheenFx = ''
  let reduceOverrides = ''

  if (effective === 'working') {
    const flapDur = jitter(260)
    const hoverDur = jitter(1500)
    const fxDur = jitter(1400)
    const antDur = jitter(1200)
    const flapDelay = delay(flapDur, 'fl')
    const flutterCss =
      `.wing-l{transform-origin:20px 14.5px;animation:w-flap-l ${flapDur}ms ${easeInOut} ${flapDelay} infinite}` +
      `.wing-r{transform-origin:28px 14.5px;animation:w-flap-r ${flapDur}ms ${easeInOut} ${flapDelay} infinite}` +
      `.wing-glint{animation:w-glint ${flapDur}ms ${easeInOut} ${flapDelay} infinite}` +
      '@keyframes w-flap-l{0%,100%{transform:rotate(20deg) scaleY(.94)}50%{transform:rotate(-22deg) scaleY(.76)}}' +
      '@keyframes w-flap-r{0%,100%{transform:rotate(-20deg) scaleY(.94)}50%{transform:rotate(22deg) scaleY(.76)}}' +
      '@keyframes w-glint{0%,100%{opacity:.35}50%{opacity:.95}}'

    if (variant === 0) {
      motionStyle =
        `.bee-hover{transform-origin:24px 16.5px;animation:w-dart ${hoverDur}ms ${easeInOut} ${delay(hoverDur, 'hv')} infinite}` +
        flutterCss +
        `.spark{transform-origin:center;transform-box:fill-box;animation:w-spark ${fxDur}ms ${easeOut} ${delay(fxDur, 'fx')} infinite}` +
        `.s2{animation-delay:${delay(fxDur, 'fx', 460)}}.s3{animation-delay:${delay(fxDur, 'fx', 920)}}` +
        '@keyframes w-dart{0%,100%{transform:translate(0,-2.2px) rotate(-4deg)}25%{transform:translate(2.2px,.4px) rotate(3deg)}50%{transform:translate(0,2.2px) rotate(4deg)}75%{transform:translate(-2.2px,-.4px) rotate(-3deg)}}' +
        '@keyframes w-spark{0%{opacity:0;transform:translateY(2px) scale(.6)}25%{opacity:1;transform:translateY(-1px) scale(1.15)}100%{opacity:0;transform:translateY(-5.5px) scale(.6)}}'
      frontFx =
        '<circle class="bee-fx spark s1" cx="7.5" cy="9.5" r="1.2" fill="var(--spark)"/>' +
        '<circle class="bee-fx spark s2" cx="40.5" cy="9.5" r="1.2" fill="var(--spark)"/>' +
        '<circle class="bee-fx spark s3" cx="38" cy="21.5" r="1.05" fill="var(--honey)"/>'
    } else if (variant === 1) {
      motionStyle =
        `.bee-hover{transform-origin:24px 16.5px;animation:w-forage ${hoverDur}ms ${easeInOut} ${delay(hoverDur, 'hv')} infinite}` +
        flutterCss +
        `.pollen{transform-origin:center;transform-box:fill-box;animation:w-pollen ${fxDur}ms ${easeInOut} ${delay(fxDur, 'fx')} infinite}` +
        `.p2{animation-delay:${delay(fxDur, 'fx', 450)}}.p3{animation-delay:${delay(fxDur, 'fx', 900)}}` +
        '@keyframes w-forage{0%,100%{transform:translate(-1.8px,-2px) rotate(-6deg)}50%{transform:translate(1.8px,2.2px) rotate(6deg)}}' +
        '@keyframes w-pollen{0%,100%{opacity:.25;transform:translate(-2px,1.5px) scale(.85)}50%{opacity:1;transform:translate(2px,-3px) scale(1.2)}}'
      frontFx =
        '<circle class="bee-fx pollen p1" cx="8" cy="21.5" r="1.35" fill="var(--honey)"/>' +
        '<circle class="bee-fx pollen p2" cx="40" cy="20.5" r="1.35" fill="var(--spark)"/>' +
        '<circle class="bee-fx pollen p3" cx="24" cy="29" r="1.15" fill="var(--spark)"/>'
    } else if (variant === 2) {
      motionStyle =
        `.bee-hover{transform-origin:24px 16.5px;animation:w-tap ${hoverDur}ms ${easeInOut} ${delay(hoverDur, 'hv')} infinite}` +
        flutterCss +
        `.spark{transform-origin:center;transform-box:fill-box;animation:w-burst ${fxDur}ms ${easeOut} ${delay(fxDur, 'fx')} infinite}` +
        `.s2{animation-delay:${delay(fxDur, 'fx', 550)}}` +
        '@keyframes w-tap{0%,100%{transform:translateY(-2.2px)}25%{transform:translateY(2.2px)}48%{transform:translateY(-.8px)}70%{transform:translateY(2.3px)}}' +
        '@keyframes w-burst{0%{opacity:0;transform:scale(.5)}30%{opacity:1;transform:translateY(-2px) scale(1.25)}100%{opacity:0;transform:translateY(-5px) scale(.6)}}'
      frontFx =
        '<path class="bee-fx spark s1" fill="var(--spark)" d="M9 22.5l1-2 1 2 2 1-2 1-1 2-1-2-2-1z"/>' +
        '<path class="bee-fx spark s2" fill="var(--spark)" d="M38 22.5l1-2 1 2 2 1-2 1-1 2-1-2-2-1z"/>'
    } else {
      motionStyle =
        `.bee-hover{transform-origin:24px 16.5px;animation:w-poise ${hoverDur}ms ${easeInOut} ${delay(hoverDur, 'hv')} infinite}` +
        flutterCss +
        `.bee-antennae{transform-origin:24px 7.5px;animation:w-ant ${antDur}ms ${easeInOut} ${delay(antDur, 'an')} infinite}` +
        `.buzz{animation:w-buzz ${flapDur}ms linear ${delay(flapDur, 'bz')} infinite}` +
        '@keyframes w-poise{0%,100%{transform:translateY(-2.2px)}50%{transform:translateY(2.2px)}}' +
        '@keyframes w-ant{0%,100%{transform:rotate(-14deg)}50%{transform:rotate(14deg)}}' +
        '@keyframes w-buzz{0%,100%{opacity:.15}50%{opacity:.85}}'
      frontFx =
        '<path class="bee-fx buzz" fill="none" stroke="var(--wing-front)" stroke-width="1.2" stroke-linecap="round" d="M5.5 11Q4 14 5.5 17M42.5 11Q44 14 42.5 17"/>'
    }
  } else if (effective === 'coordinating') {
    const flapDur = jitter(340)
    const hoverDur = jitter(1700)
    const auraDur = jitter(1800)
    const flapDelay = delay(flapDur, 'fl')
    defs +=
      '<radialGradient id="bg"><stop offset="0%" stop-color="var(--spark)" stop-opacity=".44"/>' +
      '<stop offset="68%" stop-color="var(--honey)" stop-opacity=".14"/><stop offset="100%" stop-color="var(--honey)" stop-opacity="0"/></radialGradient>'
    backFx = '<ellipse class="bee-fx aura" cx="24" cy="16.5" rx="17" ry="12" fill="url(#bg)"/>'
    innerFx = '<path class="bee-crown" fill="var(--spark)" stroke="var(--ink)" stroke-width=".8" stroke-linejoin="round" d="M21.4 5.5L22.3 3.4 24 4.7 25.7 3.4 26.6 5.5Z"/>'
    const coordWings =
      `.wing-l{transform-origin:20px 14.5px;animation:c-flap-l ${flapDur}ms ${easeInOut} ${flapDelay} infinite}` +
      `.wing-r{transform-origin:28px 14.5px;animation:c-flap-r ${flapDur}ms ${easeInOut} ${flapDelay} infinite}` +
      `.aura{transform-origin:24px 16.5px;animation:c-aura ${auraDur}ms ${easeInOut} ${delay(auraDur, 'au')} infinite}` +
      '@keyframes c-flap-l{0%,100%{transform:rotate(14deg) scaleY(.96)}50%{transform:rotate(-16deg) scaleY(.82)}}' +
      '@keyframes c-flap-r{0%,100%{transform:rotate(-14deg) scaleY(.96)}50%{transform:rotate(16deg) scaleY(.82)}}' +
      '@keyframes c-aura{0%,100%{opacity:.32;transform:scale(.88)}50%{opacity:.88;transform:scale(1.14)}}'
    if (variant === 0) {
      motionStyle =
        `.bee-hover{transform-origin:24px 16.5px;animation:c-royal ${hoverDur}ms ${easeInOut} ${delay(hoverDur, 'hv')} infinite}` +
        coordWings +
        '@keyframes c-royal{0%,100%{transform:translateY(-2px) rotate(-3deg)}50%{transform:translateY(2px) rotate(3deg)}}'
    } else if (variant === 1) {
      motionStyle =
        `.bee-hover{transform-origin:24px 16.5px;animation:c-waggle ${hoverDur}ms ${easeInOut} ${delay(hoverDur, 'hv')} infinite}` +
        coordWings +
        '@keyframes c-waggle{0%,100%{transform:translate(-2.6px,-1.2px) rotate(-5deg)}25%{transform:translate(0,1.6px) rotate(0deg)}50%{transform:translate(2.6px,-1.2px) rotate(5deg)}75%{transform:translate(0,1.6px) rotate(0deg)}}'
    } else {
      motionStyle =
        `.bee-hover{transform-origin:24px 16.5px;animation:c-poise ${hoverDur}ms ${easeInOut} ${delay(hoverDur, 'hv')} infinite}` +
        coordWings +
        `.beacon{transform-origin:24px 16.5px;animation:c-beacon ${auraDur}ms ${easeOut} ${delay(auraDur, 'bc')} infinite}` +
        '@keyframes c-poise{0%,100%{transform:translateY(-2px)}50%{transform:translateY(2px)}}' +
        '@keyframes c-beacon{0%{opacity:0;transform:scale(.76)}25%{opacity:.85}100%{opacity:0;transform:scale(1.22)}}'
      backFx += '<ellipse class="bee-fx beacon" cx="24" cy="16.5" rx="16" ry="11.5" fill="none" stroke="var(--honey)" stroke-width="1.2"/>'
    }
  } else if (effective === 'waiting') {
    const dur = jitter(variant === 2 ? 1600 : variant === 3 ? 2200 : 2000)
    const bob = '@keyframes w-bob{0%,100%{transform:translateY(1px)}50%{transform:translateY(-2.2px)}}'
    if (variant === 0) {
      motionStyle =
        `.bee-hover{transform-origin:24px 16.5px;animation:w-bob ${dur}ms ${easeInOut} ${delay(dur, 'hv')} infinite}` +
        `.z1{animation:i-doze ${dur}ms linear ${delay(dur, 'zz')} infinite}` +
        `.z2{animation:i-doze ${dur}ms linear ${delay(dur, 'zz', 800)} infinite}` +
        bob +
        '@keyframes i-doze{0%{opacity:0;transform:translate(0,2px) scale(.88)}25%,65%{opacity:.95}100%{opacity:0;transform:translate(2.4px,-3.4px) scale(1.08)}}'
      frontFx =
        '<path class="bee-fx doze-z z1" fill="none" stroke="var(--wing-back)" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" d="M33.5 10h3.6l-3.6 3.8h3.6"/>' +
        '<path class="bee-fx doze-z z2" fill="none" stroke="var(--wing-front)" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" d="M38.2 6.4h2.8l-2.8 3h2.8"/>'
      reduceOverrides = '.doze-z{opacity:.85}'
    } else if (variant === 1) {
      const preenDelay = delay(dur, 'pr')
      motionStyle =
        `.bee-hover{transform-origin:24px 16.5px;animation:w-bob ${dur}ms ${easeInOut} ${delay(dur, 'hv')} infinite}` +
        `.wing-r{transform-origin:28px 14.5px;animation:i-preen ${dur}ms ${easeInOut} ${preenDelay} infinite}` +
        `.wing-l{transform-origin:20px 14.5px;animation:i-preen-l ${dur}ms ${easeInOut} ${preenDelay} infinite}` +
        `.wing-glint-back{animation:i-preen-g ${dur}ms ${easeInOut} ${preenDelay} infinite}` +
        bob +
        '@keyframes i-preen{0%,100%{transform:rotate(0deg)}45%{transform:rotate(-24deg) translateY(-1px)}75%{transform:rotate(4deg)}}' +
        '@keyframes i-preen-l{0%,100%{transform:rotate(0deg)}45%{transform:rotate(10deg)}}' +
        '@keyframes i-preen-g{0%,100%{opacity:.55}45%{opacity:1}}'
    } else if (variant === 2) {
      motionStyle =
        `.bee-hover{transform-origin:24px 16.5px;animation:i-tilt ${dur}ms ${easeInOut} ${delay(dur, 'hv')} infinite}` +
        `.bee-antennae{transform-origin:24px 7.5px;animation:i-twitch ${dur}ms ${easeInOut} ${delay(dur, 'tw')} infinite}` +
        '@keyframes i-tilt{0%,100%{transform:translateY(1px) rotate(-4deg)}50%{transform:translateY(-2px) rotate(4deg)}}' +
        '@keyframes i-twitch{0%,20%,80%,100%{transform:rotate(0deg)}38%{transform:rotate(-18deg)}58%{transform:rotate(18deg)}}'
    } else {
      defs += '<radialGradient id="sg"><stop offset="0%" stop-color="var(--spark)" stop-opacity=".55"/><stop offset="100%" stop-color="var(--honey)" stop-opacity="0"/></radialGradient>'
      backFx = '<ellipse class="bee-fx sun-glow" cx="24" cy="17.5" rx="16" ry="11" fill="url(#sg)"/>'
      frontFx =
        '<circle class="bee-fx sun-mote m1" cx="11" cy="12.5" r="1.1" fill="var(--spark)"/>' +
        '<circle class="bee-fx sun-mote m2" cx="37" cy="19.5" r="1.1" fill="var(--honey)"/>'
      motionStyle =
        `.bee-hover{transform-origin:24px 16.5px;animation:i-float ${dur}ms ${easeInOut} ${delay(dur, 'hv')} infinite}` +
        `.sun-glow{transform-origin:24px 17.5px;animation:i-sunglow ${dur}ms ${easeInOut} ${delay(dur, 'sg')} infinite}` +
        `.m1{animation:i-mote ${dur}ms ${easeInOut} ${delay(dur, 'mt')} infinite}` +
        `.m2{animation:i-mote ${dur}ms ${easeInOut} ${delay(dur, 'mt', 900)} infinite}` +
        '@keyframes i-float{0%,100%{transform:translateY(1.4px)}50%{transform:translateY(-2.4px)}}' +
        '@keyframes i-sunglow{0%,100%{opacity:.22;transform:scale(.85)}50%{opacity:.82;transform:scale(1.16)}}' +
        '@keyframes i-mote{0%,100%{opacity:.25;transform:translateY(2px)}50%{opacity:.95;transform:translateY(-3px)}}'
    }
  } else if (effective === 'not started') {
    const dur = jitter(2000)
    // Desaturated warm wax brood-honey palette (>= 3:1 contrast) — no opacity:.5 washout and no enclosing hexagon.
    baseStyle +=
      '.bee-body{fill:var(--brood-body)}.bee-abdomen{fill:var(--brood-honey)}.bee-band-stripe{fill:var(--brood-stripe)}' +
      '.wing-front{fill:var(--brood-wing-f)}.wing-back{fill:var(--brood-wing-b)}' +
      '.brood-cradle{fill:none;stroke:var(--warn);stroke-width:1.15;stroke-dasharray:2.4 2.4;stroke-linecap:round;opacity:.85}'
    backFx = '<path class="bee-fx brood-cradle" d="M13 28.8Q24 31.2 35 28.8"/>'
    if (variant === 0) {
      defs += '<radialGradient id="ng"><stop offset="0%" stop-color="var(--honey)" stop-opacity=".48"/><stop offset="100%" stop-color="var(--honey)" stop-opacity="0"/></radialGradient>'
      backFx = '<ellipse class="bee-fx brood-glow" cx="24" cy="17.5" rx="15" ry="10.5" fill="url(#ng)"/>' + backFx
      frontFx =
        '<circle class="bee-fx q-pip qp1" cx="35.5" cy="5.5" r="1.05" fill="var(--warn)"/>' +
        '<circle class="bee-fx q-pip qp2" cx="39.5" cy="5.5" r="1.05" fill="var(--warn)"/>' +
        '<circle class="bee-fx q-pip qp3" cx="43.5" cy="5.5" r="1.05" fill="var(--warn)"/>'
      motionStyle =
        `.bee-hover{transform-origin:24px 16.5px;animation:n-bob ${dur}ms ${easeInOut} ${delay(dur, 'hv')} infinite}` +
        `.brood-glow{transform-origin:24px 17.5px;animation:n-glow ${dur}ms ${easeInOut} ${delay(dur, 'gl')} infinite}` +
        // Scaled about its own centre: about the icon's origin the last pip left the 48-unit frame at its peak.
        '.q-pip{transform-box:fill-box;transform-origin:center}' +
        `.qp1{animation:n-pip ${dur}ms ${easeInOut} ${delay(dur, 'qp')} infinite}` +
        `.qp2{animation:n-pip ${dur}ms ${easeInOut} ${delay(dur, 'qp', 350)} infinite}` +
        `.qp3{animation:n-pip ${dur}ms ${easeInOut} ${delay(dur, 'qp', 700)} infinite}` +
        '@keyframes n-bob{0%,100%{transform:translateY(1.2px)}50%{transform:translateY(-2px)}}' +
        '@keyframes n-glow{0%,100%{opacity:.22;transform:scale(.85)}50%{opacity:.85;transform:scale(1.14)}}' +
        '@keyframes n-pip{0%,100%{opacity:.25;transform:scale(.75)}45%{opacity:1;transform:scale(1.22)}}'
    } else if (variant === 1) {
      const peekDelay = delay(dur, 'pk')
      baseStyle += '.peek-eyes{opacity:0}'
      innerFx = `<g class="bee-fx peek-eyes">${EYES.open}</g>`
      frontFx = '<circle class="bee-fx q-pip" cx="40" cy="5.5" r="1.3" fill="var(--warn)"/>'
      motionStyle =
        `.bee-hover{transform-origin:24px 16.5px;animation:n-hop ${dur}ms ${easeInOut} ${peekDelay} infinite}` +
        `.bee-antennae{transform-origin:24px 7.5px;animation:n-perk ${dur}ms ${easeInOut} ${peekDelay} infinite}` +
        `.bee-eyes{animation:n-hide ${dur}ms ${easeInOut} ${peekDelay} infinite}` +
        `.peek-eyes{animation:n-peek ${dur}ms ${easeInOut} ${peekDelay} infinite}` +
        // Hop and perk peak together: sized so the right antenna tip (30.7, 3.9, r 1.05) stays inside the frame's top edge.
        '@keyframes n-hop{0%,20%,100%{transform:translateY(1.4px)}55%{transform:translateY(-1.6px)}}' +
        '@keyframes n-perk{0%,20%,100%{transform:rotate(0deg)}55%{transform:rotate(-8deg)}}' +
        '@keyframes n-hide{0%,22%,88%,100%{opacity:1}35%,75%{opacity:0}}' +
        '@keyframes n-peek{0%,25%,85%,100%{opacity:0}40%,70%{opacity:1}}'
      reduceOverrides = '.peek-eyes{opacity:0}'
    } else {
      frontFx =
        '<circle class="bee-fx cue-dot cd1" cx="10" cy="14.5" r="1.3" fill="var(--honey)"/>' +
        '<circle class="bee-fx cue-dot cd2" cx="38" cy="14.5" r="1.3" fill="var(--spark)"/>'
      motionStyle =
        `.bee-hover{transform-origin:24px 16.5px;animation:n-sway ${dur}ms ${easeInOut} ${delay(dur, 'hv')} infinite}` +
        `.cd1{animation:n-orb1 ${dur}ms ${easeInOut} ${delay(dur, 'o1')} infinite}` +
        `.cd2{animation:n-orb2 ${dur}ms ${easeInOut} ${delay(dur, 'o2')} infinite}` +
        '@keyframes n-sway{0%,100%{transform:translateX(-1.8px) rotate(-4deg)}50%{transform:translateX(1.8px) rotate(4deg)}}' +
        '@keyframes n-orb1{0%,100%{opacity:.35;transform:translate(0,3px)}50%{opacity:1;transform:translate(3px,-5px)}}' +
        '@keyframes n-orb2{0%,100%{opacity:.35;transform:translate(0,-4px)}50%{opacity:1;transform:translate(-3px,4px)}}'
    }
  } else if (effective === 'paused') {
    const dur = jitter(2200)
    baseStyle += '.stasis-bar{fill:var(--warn)}'
    frontFx =
      '<rect class="bee-fx stasis-bar b1" x="37.5" y="3.5" width="2" height="5.5" rx=".8"/>' +
      '<rect class="bee-fx stasis-bar b2" x="41" y="3.5" width="2" height="5.5" rx=".8"/>'
    if (variant === 0) {
      defs += '<radialGradient id="pg"><stop offset="0%" stop-color="var(--warn)" stop-opacity=".4"/><stop offset="100%" stop-color="var(--warn)" stop-opacity="0"/></radialGradient>'
      backFx = '<ellipse class="bee-fx p-halo" cx="24" cy="16.5" rx="16" ry="11" fill="url(#pg)"/>'
      motionStyle =
        `.bee-hover{transform-origin:24px 16.5px;animation:p-float ${dur}ms ${easeInOut} ${delay(dur, 'hv')} infinite}` +
        `.p-halo{transform-origin:24px 16.5px;animation:p-amber ${dur}ms ${easeInOut} ${delay(dur, 'am')} infinite}` +
        `.stasis-bar{animation:p-bars ${dur}ms ${easeInOut} ${delay(dur, 'br')} infinite}` +
        '@keyframes p-float{0%,100%{transform:translateY(1.2px)}50%{transform:translateY(-1.6px)}}' +
        '@keyframes p-amber{0%,100%{opacity:.22;transform:scale(.88)}50%{opacity:.85;transform:scale(1.12)}}' +
        '@keyframes p-bars{0%,100%{opacity:.42}50%{opacity:1}}'
    } else if (variant === 1) {
      const wingDelay = delay(dur, 'wg')
      motionStyle =
        `.bee-hover{transform-origin:24px 16.5px;animation:p-breath ${dur}ms ${easeInOut} ${delay(dur, 'hv')} infinite}` +
        `.wing-l{transform-origin:20px 14.5px;animation:p-wl ${dur}ms ${easeInOut} ${wingDelay} infinite}` +
        `.wing-r{transform-origin:28px 14.5px;animation:p-wr ${dur}ms ${easeInOut} ${wingDelay} infinite}` +
        '@keyframes p-breath{0%,100%{transform:translateY(1.5px)}50%{transform:translateY(-1.8px)}}' +
        '@keyframes p-wl{0%,100%{transform:rotate(0deg)}50%{transform:rotate(12deg)}}' +
        '@keyframes p-wr{0%,100%{transform:rotate(0deg)}50%{transform:rotate(-12deg)}}'
    } else {
      sheenFx = '<rect class="bee-fx seal-glint" x="17" y="16" width="2.8" height="10" rx="1" fill="var(--spark)" fill-opacity=".65"/>'
      motionStyle =
        `.bee-hover{transform-origin:24px 16.5px;animation:p-sway ${dur}ms ${easeInOut} ${delay(dur, 'hv')} infinite}` +
        `.bee-antennae{transform-origin:24px 7.5px;animation:p-tuck ${dur}ms ${easeInOut} ${delay(dur, 'tk')} infinite}` +
        `.seal-glint{animation:p-sheen ${dur}ms ${easeInOut} ${delay(dur, 'sh')} infinite}` +
        '@keyframes p-sway{0%,100%{transform:rotate(-3deg)}50%{transform:rotate(3deg)}}' +
        '@keyframes p-tuck{0%,100%{transform:rotate(-12deg)}50%{transform:rotate(12deg)}}' +
        '@keyframes p-sheen{0%,100%{opacity:0;transform:translateX(0)}50%{opacity:.9;transform:translateX(11px)}}'
    }
  } else if (effective === 'closed') {
    const dur = jitter(2400)
    backFx = '<path class="bee-fx arch-cradle" fill="none" stroke="var(--honey)" stroke-width="1.2" stroke-linecap="round" d="M14 28.5Q24 31.2 34 28.5"/>'
    frontFx = '<path class="bee-fx comb-seal" fill="var(--honey)" fill-opacity=".22" stroke="var(--honey)" stroke-width="1.15" stroke-linejoin="round" d="M40.5 3.4L43.2 5V8L40.5 9.6 37.8 8V5Z"/>'
    if (variant === 0) {
      sheenFx = '<rect class="bee-fx comb-luster" x="17" y="16" width="2.8" height="10" rx="1" fill="var(--spark)" fill-opacity=".68"/>'
      motionStyle =
        `.bee-hover{transform-origin:24px 16.5px;animation:cl-bob ${dur}ms ${easeInOut} ${delay(dur, 'hv')} infinite}` +
        `.comb-luster{animation:cl-sweep ${dur}ms ${easeInOut} ${delay(dur, 'sw')} infinite}` +
        '@keyframes cl-bob{0%,100%{transform:translateY(1px)}50%{transform:translateY(-1.5px)}}' +
        '@keyframes cl-sweep{0%,100%{opacity:0;transform:translateX(0)}50%{opacity:.95;transform:translateX(11px)}}'
    } else if (variant === 1) {
      const wingDelay = delay(dur, 'wg')
      motionStyle =
        `.bee-hover{transform-origin:24px 16.5px;animation:cl-rest ${dur}ms ${easeInOut} ${delay(dur, 'hv')} infinite}` +
        `.wing-l{transform-origin:20px 14.5px;animation:cl-wl ${dur}ms ${easeInOut} ${wingDelay} infinite}` +
        `.wing-r{transform-origin:28px 14.5px;animation:cl-wr ${dur}ms ${easeInOut} ${wingDelay} infinite}` +
        '@keyframes cl-rest{0%,100%{transform:translateY(1.2px)}50%{transform:translateY(-1.6px)}}' +
        '@keyframes cl-wl{0%,100%{transform:rotate(0deg)}50%{transform:rotate(12deg)}}' +
        '@keyframes cl-wr{0%,100%{transform:rotate(0deg)}50%{transform:rotate(-12deg)}}'
    } else {
      frontFx += '<circle class="bee-fx nectar-gem" cx="40.5" cy="6.5" r="1.4" fill="var(--spark)"/>'
      motionStyle =
        `.bee-hover{transform-origin:24px 16.5px;animation:cl-bob2 ${dur}ms ${easeInOut} ${delay(dur, 'hv')} infinite}` +
        `.nectar-gem{transform-origin:40.5px 6.5px;animation:cl-gem ${dur}ms ${easeInOut} ${delay(dur, 'gm')} infinite}` +
        '@keyframes cl-bob2{0%,100%{transform:translateY(1px)}50%{transform:translateY(-1.5px)}}' +
        '@keyframes cl-gem{0%,100%{opacity:.4;transform:scale(.7)}50%{opacity:1;transform:scale(1.35)}}'
    }
  } else if (effective === 'killed') {
    const dur = jitter(2400)
    // Desaturated propolis-ash tones preserving >= 3:1 contrast without svg{opacity:.5} and without enclosing hexagon.
    baseStyle +=
      '.bee-body{fill:var(--retired-body)}.bee-abdomen{fill:var(--retired-honey)}.bee-band-stripe{fill:var(--retired-stripe)}' +
      '.wing-front{fill:var(--retired-wing-f)}.wing-back{fill:var(--retired-wing-b)}' +
      '.bee-antennae path{stroke:var(--retired-ant)}.bee-antennae circle{fill:var(--retired-ant)}' +
      '.retire-badge{fill:none;stroke:var(--retired-body);stroke-width:1.3;stroke-linecap:round}'
    frontFx = '<g class="bee-fx retire-badge"><circle cx="40.5" cy="6.4" r="2.9"/><path d="M38.5 8.4L42.5 4.4"/></g>'
    if (variant === 0) {
      motionStyle =
        `.bee-hover{transform-origin:24px 16.5px;animation:k-drift ${dur}ms ${easeInOut} ${delay(dur, 'dr')} infinite}` +
        '@keyframes k-drift{0%,100%{transform:translateY(1.5px) rotate(-3deg)}50%{transform:translateY(-2px) rotate(3deg)}}'
    } else if (variant === 1) {
      frontFx +=
        '<circle class="bee-fx ash-mote am1" cx="35" cy="18.5" r="1.15" fill="var(--retired-honey)"/>' +
        '<circle class="bee-fx ash-mote am2" cx="12" cy="16.5" r="1.05" fill="var(--retired-body)"/>'
      motionStyle =
        `.bee-hover{transform-origin:24px 16.5px;animation:k-bob ${dur}ms ${easeInOut} ${delay(dur, 'hv')} infinite}` +
        `.am1{animation:k-ash ${dur}ms ${easeOut} ${delay(dur, 'am')} infinite}` +
        `.am2{animation:k-ash ${dur}ms ${easeOut} ${delay(dur, 'am', 900)} infinite}` +
        '@keyframes k-bob{0%,100%{transform:translateY(1px)}50%{transform:translateY(-1.6px)}}' +
        '@keyframes k-ash{0%{opacity:0;transform:translateY(2px)}30%{opacity:.95}100%{opacity:0;transform:translate(2.5px,-6px)}}'
    } else {
      const wingDelay = delay(dur, 'wg')
      motionStyle =
        `.bee-hover{transform-origin:24px 16.5px;animation:k-bob2 ${dur}ms ${easeInOut} ${delay(dur, 'hv')} infinite}` +
        `.wing-l{transform-origin:20px 14.5px;animation:k-wl ${dur}ms ${easeInOut} ${wingDelay} infinite}` +
        `.wing-r{transform-origin:28px 14.5px;animation:k-wr ${dur}ms ${easeInOut} ${wingDelay} infinite}` +
        '@keyframes k-bob2{0%,100%{transform:translateY(1px)}50%{transform:translateY(-1.5px)}}' +
        '@keyframes k-wl{0%,100%{transform:rotate(0deg)}50%{transform:rotate(12deg)}}' +
        '@keyframes k-wr{0%,100%{transform:rotate(0deg)}50%{transform:rotate(-12deg)}}'
    }
  } else if (effective === 'stopped') {
    const dur = jitter(1800)
    frontFx = '<rect class="bee-fx stop-badge" x="38" y="3.8" width="5" height="5" rx="1" fill="var(--stop)"/>'
    if (variant === 0) {
      const wingDelay = delay(dur, 'wg')
      motionStyle =
        `.bee-hover{transform-origin:24px 16.5px;animation:st-jit ${dur}ms ${easeInOut} ${delay(dur, 'hv')} infinite}` +
        `.wing-l{transform-origin:20px 14.5px;animation:st-shl ${dur}ms ${easeInOut} ${wingDelay} infinite}` +
        `.wing-r{transform-origin:28px 14.5px;animation:st-shr ${dur}ms ${easeInOut} ${wingDelay} infinite}` +
        '@keyframes st-jit{0%,55%,100%{transform:translateX(0)}65%{transform:translateX(-2px)}80%{transform:translateX(2px)}}' +
        '@keyframes st-shl{0%,55%,100%{transform:rotate(0deg)}68%{transform:rotate(18deg)}84%{transform:rotate(-8deg)}}' +
        '@keyframes st-shr{0%,55%,100%{transform:rotate(0deg)}68%{transform:rotate(-18deg)}84%{transform:rotate(8deg)}}'
    } else if (variant === 1) {
      motionStyle =
        `.bee-hover{transform-origin:24px 16.5px;animation:st-tilt ${dur}ms ${easeInOut} ${delay(dur, 'hv')} infinite}` +
        `.wing-l{transform-origin:20px 14.5px;animation:st-askew ${dur}ms ${easeInOut} ${delay(dur, 'ak')} infinite}` +
        `.stop-badge{animation:st-blink ${dur}ms ${easeInOut} ${delay(dur, 'bk')} infinite}` +
        '@keyframes st-tilt{0%,100%{transform:rotate(-5deg)}50%{transform:rotate(2deg)}}' +
        '@keyframes st-askew{0%,100%{transform:rotate(-18deg)}50%{transform:rotate(4deg)}}' +
        '@keyframes st-blink{0%,40%,100%{opacity:1}60%,80%{opacity:.3}}'
    } else {
      motionStyle =
        `.bee-hover{transform-origin:24px 16.5px;animation:st-thud ${dur}ms ${easeInOut} ${delay(dur, 'th')} infinite}` +
        `.bee-antennae{transform-origin:24px 7.5px;animation:st-droop ${dur}ms ${easeInOut} ${delay(dur, 'dp')} infinite}` +
        '@keyframes st-thud{0%,100%{transform:translateY(-1.5px)}45%{transform:translateY(2.2px)}70%{transform:translateY(.5px)}}' +
        '@keyframes st-droop{0%,100%{transform:rotate(-12deg)}50%{transform:rotate(12deg)}}'
    }
  } else if (effective === 'failed') {
    const dur = jitter(1500)
    frontFx = '<path class="bee-fx err-mark" fill="var(--err)" d="M39.5 3.3h2v4h-2zM39.5 8.5h2v1.8h-2z"/>'
    if (variant === 0) {
      frontFx +=
        '<circle class="bee-fx err-spark es1" cx="9" cy="9.5" r="1.25" fill="var(--err)"/>' +
        '<circle class="bee-fx err-spark es2" cx="35" cy="9.5" r="1.25" fill="var(--err)"/>'
      motionStyle =
        `.bee-hover{transform-origin:24px 16.5px;animation:f-rock ${dur}ms ${easeInOut} ${delay(dur, 'rk')} infinite}` +
        `.bee-antennae{transform-origin:24px 7.5px;animation:f-dizzy ${dur}ms ${easeInOut} ${delay(dur, 'dz')} infinite}` +
        `.es1{animation:f-es ${dur}ms ${easeOut} ${delay(dur, 'es')} infinite}` +
        `.es2{animation:f-es ${dur}ms ${easeOut} ${delay(dur, 'es', 600)} infinite}` +
        '@keyframes f-rock{0%,100%{transform:rotate(-5deg)}50%{transform:rotate(5deg)}}' +
        '@keyframes f-dizzy{0%,100%{transform:rotate(-20deg)}50%{transform:rotate(20deg)}}' +
        '@keyframes f-es{0%,100%{opacity:0;transform:translateY(2px)}35%{opacity:1;transform:translateY(-2px)}80%{opacity:0;transform:translateY(-5px)}}'
    } else if (variant === 1) {
      defs += '<radialGradient id="fg"><stop offset="0%" stop-color="var(--err)" stop-opacity=".55"/><stop offset="100%" stop-color="var(--err)" stop-opacity="0"/></radialGradient>'
      backFx = '<ellipse class="bee-fx alarm-halo" cx="24" cy="16.5" rx="17" ry="12" fill="url(#fg)"/>'
      motionStyle =
        `.bee-hover{transform-origin:24px 16.5px;animation:f-quiv ${dur}ms ${easeInOut} ${delay(dur, 'qv')} infinite}` +
        `.alarm-halo{transform-origin:24px 16.5px;animation:f-halo ${dur}ms ${easeInOut} ${delay(dur, 'hl')} infinite}` +
        '@keyframes f-quiv{0%,100%{transform:translateX(-1.8px)}50%{transform:translateX(1.8px)}}' +
        '@keyframes f-halo{0%,100%{opacity:.18;transform:scale(.85)}50%{opacity:.9;transform:scale(1.18)}}'
    } else {
      frontFx +=
        '<circle class="bee-fx sputter sp1" cx="11" cy="20.5" r="1.25" fill="var(--err)"/>' +
        '<circle class="bee-fx sputter sp2" cx="37" cy="21.5" r="1.25" fill="var(--honey)"/>'
      motionStyle =
        `.bee-hover{transform-origin:24px 16.5px;animation:f-tilt ${dur}ms ${easeInOut} ${delay(dur, 'tl')} infinite}` +
        `.sp1{animation:f-drop ${dur}ms ${easeOut} ${delay(dur, 'sp')} infinite}` +
        `.sp2{animation:f-drop ${dur}ms ${easeOut} ${delay(dur, 'sp', 600)} infinite}` +
        '@keyframes f-tilt{0%,100%{transform:rotate(-7deg) translateY(-1px)}50%{transform:rotate(2deg) translateY(2px)}}' +
        '@keyframes f-drop{0%{opacity:0;transform:translateY(-2px)}30%{opacity:1}100%{opacity:0;transform:translateY(5px)}}'
    }
  } else {
    // unreachable (3 lost-contact variants: signal-ping, antenna-search, weak-link)
    const dur = jitter(1700)
    if (variant === 0) {
      frontFx =
        '<path class="bee-fx sig-pip sp1" fill="none" stroke="var(--unreach)" stroke-width="1.35" stroke-linecap="round" d="M8 7A4 4 0 0 1 13 5"/>' +
        '<path class="bee-fx sig-pip sp2" fill="none" stroke="var(--unreach)" stroke-width="1.35" stroke-linecap="round" d="M35 5A4 4 0 0 1 40 7"/>'
      motionStyle =
        `.bee-hover{transform-origin:24px 16.5px;animation:u-hov ${dur}ms ${easeInOut} ${delay(dur, 'hv')} infinite}` +
        `.sp1{animation:u-ping ${dur}ms ${easeOut} ${delay(dur, 'sg')} infinite}` +
        `.sp2{animation:u-ping ${dur}ms ${easeOut} ${delay(dur, 'sg', 450)} infinite}` +
        '@keyframes u-hov{0%,100%{transform:translateY(1.5px)}50%{transform:translateY(-1.8px)}}' +
        '@keyframes u-ping{0%,100%{opacity:.2;transform:translateY(2px)}45%{opacity:1;transform:translateY(-3px)}}'
    } else if (variant === 1) {
      frontFx =
        '<circle class="bee-fx sig-pip" cx="24" cy="2.6" r="1.25" fill="var(--unreach)"/>' +
        '<path class="bee-fx sig-pip" fill="none" stroke="var(--unreach)" stroke-width="1.2" stroke-linecap="round" d="M20.5 4A5 5 0 0 1 27.5 4"/>'
      motionStyle =
        `.bee-hover{transform-origin:24px 16.5px;animation:u-look ${dur}ms ${easeInOut} ${delay(dur, 'lk')} infinite}` +
        `.bee-antennae{transform-origin:24px 7.5px;animation:u-search ${dur}ms ${easeInOut} ${delay(dur, 'sr')} infinite}` +
        `.sig-pip{animation:u-blink ${dur}ms linear ${delay(dur, 'bk')} infinite}` +
        '@keyframes u-look{0%,100%{transform:translateX(-2px)}50%{transform:translateX(2px)}}' +
        '@keyframes u-search{0%,100%{transform:rotate(-20deg)}50%{transform:rotate(20deg)}}' +
        '@keyframes u-blink{0%,35%,100%{opacity:.22}50%,85%{opacity:1}}'
    } else {
      frontFx = '<path class="bee-fx weak-arc" fill="none" stroke="var(--unreach)" stroke-width="1.3" stroke-dasharray="2.4 2" stroke-linecap="round" d="M36 5A6 6 0 0 1 43 10"/>'
      motionStyle =
        `.bee-hover{transform-origin:24px 16.5px;animation:u-drift ${dur}ms ${easeInOut} ${delay(dur, 'hv')} infinite}` +
        `.wing-l{transform-origin:20px 14.5px;animation:u-wl ${dur}ms ${easeInOut} ${delay(dur, 'wl')} infinite}` +
        `.weak-arc{animation:u-flicker ${dur}ms linear ${delay(dur, 'wf')} infinite}` +
        '@keyframes u-drift{0%,100%{transform:translateY(1.2px)}50%{transform:translateY(-1.8px)}}' +
        '@keyframes u-wl{0%,100%{transform:rotate(0deg)}50%{transform:rotate(-16deg)}}' +
        '@keyframes u-flicker{0%,28%,42%,74%,100%{opacity:1}34%,68%{opacity:.2}}'
    }
  }

  const wingLGroup = wingPose === 'spread' ? WING_LEFT
    : `<g transform="rotate(${wingPose === 'folded' ? -28 : -44} 20 14.5)">${WING_LEFT}</g>`
  const wingRGroup = wingPose === 'spread' ? WING_RIGHT
    : `<g transform="rotate(${wingPose === 'folded' ? 28 : 44} 28 14.5)">${WING_RIGHT}</g>`

  const reducedBlock = `@media(prefers-reduced-motion:reduce){.bee-hover,.wing-l,.wing-r,.bee-antennae,.bee-eyes,.bee-fx,.wing-glint{animation:none!important}${reduceOverrides}}`

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 32"><style>${baseStyle}${motionStyle}${reducedBlock}</style><defs>${defs}</defs>${backFx}` +
    '<g class="bee-hover">' +
    `<g class="wing-r">${wingRGroup}</g>` +
    `<g class="wing-l">${wingLGroup}</g>` +
    '<path class="bee-stinger" fill="var(--ink)" d="M23.1 25.5L24 28.1 24.9 25.5Z"/>' +
    '<path class="bee-abdomen" fill="var(--honey)" d="M18.2 18.7C18.2 15.9 20.8 14.9 24 14.9 27.2 14.9 29.8 15.9 29.8 18.7 29.8 22.5 27 25.6 24 26 21 25.6 18.2 22.5 18.2 18.7Z"/>' +
    '<g clip-path="url(#ab)">' +
    '<path class="bee-band-stripe" fill="var(--stripe)" d="M17 18.1Q24 20.1 31 18.1V20.4Q24 22.4 17 20.4Z"/>' +
    '<path class="bee-band-stripe" fill="var(--stripe)" d="M17 21.9Q24 23.7 31 21.9V24Q24 25.7 17 24Z"/>' +
    '<ellipse fill="var(--spark)" fill-opacity=".34" cx="21.4" cy="17.3" rx="1.6" ry=".9" transform="rotate(-18 21.4 17.3)"/>' +
    sheenFx +
    '</g>' +
    '<path fill="none" stroke="var(--ink)" stroke-width="1.15" d="M18.2 18.7C18.2 15.9 20.8 14.9 24 14.9 27.2 14.9 29.8 15.9 29.8 18.7 29.8 22.5 27 25.6 24 26 21 25.6 18.2 22.5 18.2 18.7Z"/>' +
    `<path class="bee-body" fill="${accent}" stroke="var(--ink)" stroke-width="1.1" d="M19 13.5C18.1 13.7 17.8 14.7 18.4 15.5 18 16.2 18.6 17.1 19.8 17.1 21.2 17.7 26.8 17.7 28.2 17.1 29.4 17.1 30 16.2 29.6 15.5 30.2 14.7 29.9 13.7 29 13.5 27.8 12.2 20.2 12.2 19 13.5Z"/>` +
    '<path fill="none" stroke="var(--ink)" stroke-opacity=".28" stroke-width=".9" stroke-linecap="round" d="M21 15.7Q24 16.7 27 15.7"/>' +
    '<g class="bee-antennae">' +
    '<path fill="none" stroke="var(--antennae)" stroke-width="1.35" stroke-linecap="round" d="M22 6.7C21.2 4.5 19.4 3.5 17.6 3.8"/>' +
    '<circle cx="17.3" cy="3.9" r="1.05" fill="var(--antennae)"/>' +
    '<path fill="none" stroke="var(--antennae)" stroke-width="1.35" stroke-linecap="round" d="M26 6.7C26.8 4.5 28.6 3.5 30.4 3.8"/>' +
    '<circle cx="30.7" cy="3.9" r="1.05" fill="var(--antennae)"/>' +
    '</g>' +
    `<ellipse class="bee-body" cx="24" cy="9.7" rx="4.8" ry="3.7" fill="${accent}" stroke="var(--ink)" stroke-width="1.1"/>` +
    '<ellipse cx="22.4" cy="7.7" rx="1.6" ry=".7" fill="#fff" fill-opacity=".24"/>' +
    `<g class="bee-eyes">${EYES[eyePose]}</g>${innerFx}</g>${frontFx}</svg>`
}

/**
 * Centerpiece beehive skep centered at x=22 inside viewBox="0 0 44 22", with honey coils,
 * faint honeycomb cell highlights, arched propolis doorway, and mood-driven bee choreography.
 */
export function hiveArt(shown: Mood | 'paused' | 'attention', elapsed = 0): string {
  // The mood comes from stored state and the time from a clock: unknown moods fall back cleanly to sleep.
  const mood: SceneMood = Object.hasOwn(scenes, shown) ? (shown as SceneMood) : 'sleep'
  const [prop, left, right] = scenes[mood]
  const sleeping = mood === 'sleep'
  const paused = mood === 'paused'
  const resting = sleeping || paused
  const moodPhase = hashSeed(mood) % 400
  const propKeyframes: Record<Exclude<SceneMood, 'sleep' | 'paused'>, string> = {
    attention: '0%,100%{opacity:.72;transform:scale(.94)}50%{opacity:1;transform:translateY(-.8px) scale(1.08)}',
    inspect: '0%,100%{opacity:.76;transform:translate(-1px,0)}50%{opacity:1;transform:translate(2.5px,-.6px)}',
    build: '0%,100%{opacity:.78;transform:rotate(-18deg)}40%{opacity:1;transform:rotate(16deg) translateY(.45px)}70%{opacity:.9;transform:rotate(-7deg) translateY(-.25px)}',
    verify: '0%,100%{opacity:.75;transform:scale(.94)}50%{opacity:1;transform:translateY(-.9px) scale(1.06)}',
    relay: '0%{opacity:0;transform:translate(-1px,.6px)}16%{opacity:.95}78%{opacity:.95}100%{opacity:0;transform:translate(18px,-.6px)}',
    forage: '0%,100%{opacity:.56;transform:translate(0,0)}50%{opacity:1;transform:translate(2px,-1.4px)}',
  }
  const body = beeBody(resting)
  const bee = (x: number, y: number, side: 'left' | 'right') =>
    `<g transform="translate(${x} ${y})"><g class="bee ${side}">${
      side === 'right' ? `<g transform="translate(8 0) scale(-1 1)">${body}</g>` : body
    }</g></g>`
  const propFill = mood === 'verify' ? 'var(--ok)' : mood === 'paused' || mood === 'attention' ? 'var(--warn)' : 'var(--wing)'
  const propMarkup = mood === 'relay'
    ? `<g class="prop"><path fill="var(--wing)" d="${prop}"/><path fill="var(--ink)" d="M0 0h1v1H0zM6 0h1v1H6zM1 1h1v1H1zM5 1h1v1H5zM2 2h3v1H2z"/></g>`
    : mood === 'build'
      ? `<g class="prop"><path fill="var(--wing)" d="${prop}"/></g><path class="spark" fill="var(--spark)" d="M1 2h1v1H1zM10 1h1v1h-1zM3 0h1v1H3z"/>`
      : mood === 'forage'
        ? `<path class="prop" fill="var(--wing)" d="${prop}"/><path class="spark" fill="var(--spark)" d="M0 2h1v1H0zM7 4h1v1H7zM5 0h1v1H5z"/>`
        : mood === 'attention'
          ? `<path class="prop" fill="${propFill}" d="${prop}"/><path class="spark" fill="var(--spark)" d="M0 1h1v1H0zM5 1h1v1H5z"/>`
          : `<path class="prop" fill="${propFill}" d="${prop}"/>`
  const pDur = mood === 'relay' ? 3100 : mood === 'build' ? 2300 : mood === 'attention' ? 2400 : 3600
  const aura = sleeping
    ? ''
    : `<defs><radialGradient id="hg"><stop offset="0%" stop-color="${mood === 'attention' || paused ? 'var(--warn)' : 'var(--honey)'}" stop-opacity="${paused ? '.28' : '.42'}"/><stop offset="70%" stop-color="var(--honey)" stop-opacity="${paused ? '.1' : '.14'}"/><stop offset="100%" stop-color="var(--honey)" stop-opacity="0"/></radialGradient></defs>` +
      '<ellipse class="aura" cx="22" cy="13" rx="13" ry="7.5" fill="url(#hg)" shape-rendering="auto"/>'
  const doorwayGlow = sleeping
    ? ''
    : `<path class="door-glow" d="M21 15h2v1h1v3h-4v-3h1z" fill="${mood === 'attention' || paused ? 'var(--warn)' : 'var(--spark)'}"/>`
  const scene = sleeping
    ? sleepMarks(elapsed, moodPhase)
    : paused
      ? {
          style:
            '.aura{opacity:.48}.door-glow{opacity:.18}.prop{opacity:.9}' +
            '.bee,.prop{shape-rendering:auto}' +
            `.bee{transform-box:fill-box;transform-origin:bottom center;animation:rest 5200ms ${easeInOut} ${loopDelay(elapsed, 5200, moodPhase)} infinite}` +
            `.right{animation-delay:${loopDelay(elapsed, 5200, 1400 + moodPhase)}}` +
            `.prop{animation:pause-glow 4400ms ${easeInOut} ${loopDelay(elapsed, 4400, moodPhase)} infinite}` +
            `.aura{transform-box:fill-box;transform-origin:center;animation:glow 4800ms ${easeInOut} ${loopDelay(elapsed, 4800, moodPhase)} infinite}` +
            '@keyframes rest{0%,100%{transform:scaleY(1)}50%{transform:scaleY(.95)}}' +
            '@keyframes pause-glow{0%,100%{opacity:.58}50%{opacity:1}}' +
            '@keyframes glow{0%,100%{opacity:.36;transform:scale(.97)}50%{opacity:.66;transform:scale(1.03)}}' +
            '@media(prefers-reduced-motion:reduce){.bee,.prop,.aura{animation:none!important}.bee,.prop{shape-rendering:crispEdges}}',
          art: `<g transform="translate(8 2)">${propMarkup}</g>`,
        }
      : {
          style:
            '.aura{opacity:.65}.door-glow{opacity:.2}.spark{opacity:0}' +
            '.bee,.prop,.spark{shape-rendering:auto}' +
            `.left{animation:l 3600ms linear ${loopDelay(elapsed, 3600, moodPhase)} infinite}` +
            `.right{animation:r 4300ms linear ${loopDelay(elapsed, 4300, 560 + moodPhase)} infinite}` +
            `.left .wing{${wings(elapsed, 320, moodPhase)}}` +
            `.right .wing{${wings(elapsed, 350, 130 + moodPhase)}}` +
            `.prop{transform-box:fill-box;transform-origin:center;animation:signal ${pDur}ms ${mood === 'relay' ? 'linear' : easeInOut} ${loopDelay(elapsed, pDur, moodPhase)} infinite}` +
            `.spark{animation:spark ${pDur}ms ${easeOut} ${loopDelay(elapsed, pDur, 200 + moodPhase)} infinite}` +
            `.aura{transform-box:fill-box;transform-origin:center;animation:glow 4000ms ${easeInOut} ${loopDelay(elapsed, 4000, moodPhase)} infinite}` +
            `.door-glow{animation:door-glow 3200ms ${easeInOut} ${loopDelay(elapsed, 3200, moodPhase)} infinite}` +
            `@keyframes l{${orbit(left, .6)}}` +
            `@keyframes r{${orbit(right, -.68)}}` +
            wingFrames +
            `@keyframes signal{${propKeyframes[mood]}}` +
            '@keyframes spark{0%,24%{opacity:0;transform:translateY(.5px)}48%{opacity:.85}100%{opacity:0;transform:translateY(-1.25px)}}' +
            '@keyframes glow{0%,100%{opacity:.45;transform:scale(.96)}50%{opacity:.85;transform:scale(1.06)}}' +
            '@keyframes door-glow{0%,100%{opacity:.13}50%{opacity:.38}}' +
            '@media(prefers-reduced-motion:reduce){.bee,.left .wing,.right .wing,.prop,.spark,.aura,.door-glow{animation:none!important}.bee,.prop,.spark{shape-rendering:crispEdges}}',
          art: `<g transform="translate(${mood === 'build' || mood === 'forage' ? 6 : 8} ${mood === 'relay' ? 1 : 2})">${propMarkup}</g>`,
        }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 22" shape-rendering="crispEdges"><style>${HIVE_TOKENS}${scene.style}</style>` +
    `${aura}<path fill="var(--wax)" d="M19 6h6v1h2v2h2v3h1v7H14v-7h1V9h2V7h2z"/>` +
    '<path fill="var(--honey)" d="M17 8h10v1H17zM15 11h14v2H15zM14 14h16v2H14z"/>' +
    '<path fill="var(--spark)" fill-opacity=".28" d="M20 7h4v1h-4zM16 10h2v1h-2zM26 10h2v1h-2zM16 13h2v1h-2zM26 13h2v1h-2zM15 17h2v1h-2zM27 17h2v1h-2z"/>' +
    '<g shape-rendering="auto" fill="var(--honey)" fill-opacity=".22" stroke="var(--honey)" stroke-opacity=".5" stroke-width=".6" stroke-linejoin="round">' +
    '<path d="M11.8 16.2L13.1 17V18.5L11.8 19.3L10.5 18.5V17Z"/>' +
    '<path d="M32.2 16.2L33.5 17V18.5L32.2 19.3L30.9 18.5V17Z"/></g>' +
    `<path fill="var(--ink)" d="M21 14h2v1h1v4h-4v-4h1z"/>${doorwayGlow}` +
    `${bee(resting ? 3 : 2, resting ? 13 : 11, 'left')}${bee(resting ? 33 : 34, resting ? 13 : 6, 'right')}` +
    `${scene.art}</svg>`
}
