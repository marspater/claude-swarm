import type { Swarm } from '../types'
import { boardCalls } from './command'
import { easeInOut, easeOut, hashSeed, loopDelay, pickVariant, seededPhase } from './motion'

export type Mood = NonNullable<Swarm['mood']>
// The board's subcommands, as tests/parity.json lists them: a word after `board.py <folder>` that is none of these
// names a file, not a board call.
export const BOARD_ACTIONS = new Set(['init', 'member', 'limit', 'dispatch', 'plan', 'attention', 'retry', 'replace', 'post', 'read', 'show', 'ready', 'confirm',
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
  '@media(prefers-color-scheme:dark){svg{--wing:#99c8c8;--honey:#f2bd6a;--ink:#2e1d14;--wax:#c9835b;--ok:#4cc480;--spark:#fde08d;--warn:#e0ae4f}}' +
  '@supports(color:color(display-p3 1 0 0)){' +
  'svg{--wing:color(display-p3 .3602 .5544 .5647);--honey:color(display-p3 .8721 .6692 .3511);--ink:color(display-p3 .2003 .1367 .1005);--wax:color(display-p3 .6663 .4331 .3019);--ok:color(display-p3 .2864 .5337 .3551);--spark:color(display-p3 .9349 .8060 .4617);--warn:color(display-p3 .5620 .4192 .1691)}' +
  '@media(prefers-color-scheme:dark){svg{--wing:color(display-p3 .6379 .7791 .7816);--honey:color(display-p3 .9166 .7493 .4652);--ink:color(display-p3 .1705 .1165 .0841);--wax:color(display-p3 .7489 .5259 .3836);--ok:color(display-p3 .4333 .7586 .5248);--spark:color(display-p3 .9733 .8825 .5954);--warn:color(display-p3 .8479 .6901 .3727)}}}'

const BEE_TOKENS =
  'svg{--wing-front:#5b989a;--wing-back:#4b8f91;--glint:#e5f4f4;--honey:#e8a848;--spark:#f5cc66;--stripe:#483328;--antennae:#78573e;--ink:#362218;' +
  '--warn:#966919;--err:#c54451;--stop:#b85334;--unreach:#9a5b7a;' +
  '--retired-body:#74716c;--retired-band:#c9c2b6;--retired-stripe:#4f4a44;--retired-wing-f:#778182;--retired-wing-b:#656f70;--retired-ant:#5c5852;' +
  '--brood-body:#8d8374;--brood-band:#d7bc83;--brood-wing-f:#6b8d8e;--brood-wing-b:#577c7e}' +
  '@media(prefers-color-scheme:dark){svg{--wing-front:#b9dcdc;--wing-back:#99c8c8;--glint:#edfbf6;--honey:#f2bd6a;--spark:#fde08d;--stripe:#3e291e;--antennae:#d4b79c;--ink:#2e1d14;' +
  '--warn:#e0ae4f;--err:#eb6f7a;--stop:#ea8662;--unreach:#d68fb2;' +
  '--retired-body:#9e9a93;--retired-band:#cfc9be;--retired-stripe:#4a453f;--retired-wing-f:#adb5b6;--retired-wing-b:#939c9d;--retired-ant:#78746d;' +
  '--brood-body:#aba294;--brood-band:#e3c98f;--brood-wing-f:#a7c6c6;--brood-wing-b:#8db1b2}}' +
  '@supports(color:color(display-p3 1 0 0)){' +
  'svg{--wing-front:color(display-p3 .4125 .5900 .6001);--wing-back:color(display-p3 .3602 .5544 .5647);--glint:color(display-p3 .9089 .9550 .9558);--honey:color(display-p3 .8721 .6692 .3511);--spark:color(display-p3 .9349 .8060 .4617);--stripe:color(display-p3 .2698 .2033 .1634);--antennae:color(display-p3 .4510 .3464 .2576);--ink:color(display-p3 .2003 .1367 .1005);' +
  '--warn:color(display-p3 .5620 .4192 .1691);--err:color(display-p3 .7149 .3024 .3294);--stop:color(display-p3 .6724 .3484 .2367);--unreach:color(display-p3 .5698 .3685 .4734);' +
  '--retired-body:color(display-p3 .4529 .4435 .4255);--retired-band:color(display-p3 .7835 .7617 .7185);--retired-stripe:color(display-p3 .3065 .2909 .2692);--retired-wing-f:color(display-p3 .4740 .5046 .5088);--retired-wing-b:color(display-p3 .4034 .4341 .4382);--retired-ant:color(display-p3 .3569 .3412 .3176);' +
  '--brood-body:color(display-p3 .5463 .5151 .4613);--brood-band:color(display-p3 .8257 .7411 .5416);--brood-wing-f:color(display-p3 .4470 .5492 .5545);--brood-wing-b:color(display-p3 .3722 .4823 .4914)}' +
  '@media(prefers-color-scheme:dark){svg{--wing-front:color(display-p3 .7523 .8586 .8606);--wing-back:color(display-p3 .6379 .7791 .7816);--glint:color(display-p3 .9395 .9825 .9655);--honey:color(display-p3 .9166 .7493 .4652);--spark:color(display-p3 .9733 .8825 .5954);--stripe:color(display-p3 .2309 .1642 .1245);--antennae:color(display-p3 .8127 .7218 .6247);--ink:color(display-p3 .1705 .1165 .0841);' +
  '--warn:color(display-p3 .8479 .6901 .3727);--err:color(display-p3 .8606 .4629 .4877);--stop:color(display-p3 .8646 .5447 .4135);--unreach:color(display-p3 .7989 .5729 .6920);' +
  '--retired-body:color(display-p3 .6169 .6044 .5792);--retired-band:color(display-p3 .8077 .7890 .7495);--retired-stripe:color(display-p3 .2868 .2713 .2496);--retired-wing-f:color(display-p3 .6842 .7088 .7128);--retired-wing-b:color(display-p3 .5830 .6106 .6147);--retired-ant:color(display-p3 .4784 .4627 .4353);' +
  '--brood-body:color(display-p3 .6645 .6365 .5862);--brood-band:color(display-p3 .8733 .7919 .5886);--brood-wing-f:color(display-p3 .6786 .7728 .7745);--brood-wing-b:color(display-p3 .5813 .6900 .6955)}}}'

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
      '@media(prefers-reduced-motion:no-preference){' +
      `.sleep-mark{shape-rendering:auto;animation:doze ${duration}ms linear ${loopDelay(elapsed, duration, 460 + moodPhase)} infinite}` +
      `.sleep-mark-small{animation-delay:${loopDelay(elapsed, duration, 1760 + moodPhase)}}` +
      `.sleep-mark-left{animation-delay:${loopDelay(elapsed, duration, 2540 + moodPhase)}}` +
      `.bee{shape-rendering:auto;transform-box:fill-box;transform-origin:bottom center;animation:rest 4800ms ${easeInOut} ${loopDelay(elapsed, 4800, moodPhase)} infinite}` +
      `.right{animation-delay:${loopDelay(elapsed, 4800, 1370 + moodPhase)}}` +
      '}' +
      '@keyframes doze{0%{opacity:0;transform:translate(0,0)}22%,62%{opacity:var(--peak)}100%{opacity:0;transform:translate(1px,-2px)}}' +
      '@keyframes rest{0%,100%{transform:scaleY(1)}50%{transform:scaleY(.91)}}',
    // Symmetric Zzz above the sleeping bees, clear of the skep (14..30) even at peak drift.
    art:
      '<g transform="translate(7 8)"><path class="sleep-mark sleep-mark-small sleep-mark-left" d="M0 0h3v1H0zM2 1h1v1H2zM1 2h1v1H1zM0 3h3v1H0z"/></g>' +
      '<g transform="translate(31 7)"><path class="sleep-mark" d="M0 0h5v1H0zM3 1h1v1H3zM2 2h1v1H2zM1 3h1v1H1zM0 4h5v1H0z"/></g>' +
      '<g transform="translate(37 4)"><path class="sleep-mark sleep-mark-small" d="M0 0h4v1H0zM2 1h1v1H2zM1 2h1v1H1zM0 3h4v1H0z"/></g>',
  }
}

export const MEMBER_BEE_SIZE = { width: 24, height: 15 } as const

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
type EyePose = 'open' | 'closed' | 'flat' | 'wince' | 'search'

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

const WINGS: Record<WingPose, { left: string; glintL: string; right: string; glintR: string }> = {
  spread: {
    left: 'M5 5h3v1h1v2H8v1H6V8H5V7H4V6h1z',
    glintL: 'M5 6h1v1H5z',
    right: 'M16 5h3v1h1v1h-1v1h-1v1h-2V8h-1V6h1z',
    glintR: 'M18 6h1v1h-1z',
  },
  folded: {
    left: 'M5 7h3v1h1v2H7V9H6V8H5z',
    glintL: 'M6 7h1v1H6z',
    right: 'M16 7h3v1h-1v1h-1v1h-2V8h1z',
    glintR: 'M17 7h1v1h-1z',
  },
  drooped: {
    left: 'M4 8h4v1h1v2H6v-1H5V9H4z',
    glintL: 'M5 8h1v1H5z',
    right: 'M16 8h4v1h-1v1h-1v1h-3V9h1z',
    glintR: 'M18 8h1v1h-1z',
  },
}

const EYES: Record<EyePose, string> = {
  open: 'M10 5h1v2h-1zM13 5h1v2h-1z',
  closed: 'M9 6h2v1H9zM13 6h2v1h-2z',
  flat: 'M10 6h1v1h-1zM13 6h1v1h-1z',
  wince: 'M9 5h1v1H9zM10 6h1v1h-1zM9 7h1v1H9zM14 5h1v1h-1zM13 6h1v1h-1zM14 7h1v1h-1z',
  search: 'M9 5h1v2h-1zM13 5h2v1h-2z',
}

const HEX_CELL = 'M12 1L22 4V11L12 14L2 11V4Z'
const HEX_BADGE = 'M16 2L12 1L2 4V11L12 14L22 11V5'

/**
 * Front-facing 24x15 pixel-art member bee with 3+ units clearance around (12, 8).
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
  const delay = (dur: number, salt: string | number) => loopDelay(elapsed, dur, seededPhase(who, salt, dur))

  const wingPose: WingPose =
    effective === 'working' || effective === 'coordinating'
      ? 'spread'
      : effective === 'killed' || effective === 'stopped' || effective === 'failed' || effective === 'unreachable'
        ? 'drooped'
        : 'folded'

  const eyePose: EyePose =
    effective === 'working' || effective === 'coordinating'
      ? 'open'
      : effective === 'stopped'
        ? 'flat'
        : effective === 'failed'
          ? 'wince'
          : effective === 'unreachable'
            ? 'search'
            : 'closed'

  let baseStyle = BEE_TOKENS + '.wing-glint{fill:var(--glint);opacity:.54}'
  let motionStyle = ''
  let defs = ''
  let backFx = ''
  let frontFx = ''
  let innerFx = ''

  if (effective === 'working') {
    const flapDur = jitter(150)
    const hoverDur = jitter(variant === 2 ? 920 : 1020)
    const fxDur = jitter(1120)
    const antDur = jitter(520)
    baseStyle += '.buzz,.spark,.pollen{opacity:0}'
    const flutterCss =
      `.wing-l{transform-box:fill-box;transform-origin:95% 58%;animation:w-flap-l ${flapDur}ms ${easeInOut} ${delay(flapDur, 'fl')} infinite}` +
      `.wing-r{transform-box:fill-box;transform-origin:5% 58%;animation:w-flap-r ${flapDur}ms ${easeInOut} ${delay(flapDur, 'fr')} infinite}` +
      `.wing-glint{animation:w-glint ${flapDur}ms ${easeInOut} ${delay(flapDur, 'gl')} infinite}` +
      `.wing-glint-back{animation-delay:${delay(flapDur, 'glb')}}`
    const flutterFrames =
      '@keyframes w-flap-l{0%,100%{transform:rotate(22deg) scaleY(.92)}50%{transform:rotate(-20deg) scaleY(.76)}}' +
      '@keyframes w-flap-r{0%,100%{transform:rotate(-22deg) scaleY(.92)}50%{transform:rotate(20deg) scaleY(.76)}}' +
      '@keyframes w-glint{0%,100%{opacity:.28}50%{opacity:.95}}'

    if (variant === 0) {
      // hover-dart: figure-8 darting bob + 3 rising sparks
      motionStyle =
        `.bee-hover{transform-box:fill-box;transform-origin:50% 55%;animation:w-dart ${hoverDur}ms ${easeInOut} ${delay(hoverDur, 'hv')} infinite}` +
        flutterCss +
        `.spark{transform-box:fill-box;transform-origin:center;animation:w-spark ${fxDur}ms ${easeOut} ${delay(fxDur, 's1')} infinite}` +
        `.s2{animation-delay:${delay(fxDur, 's2')}}.s3{animation-delay:${delay(fxDur, 's3')}}` +
        '@keyframes w-dart{0%,100%{transform:translate(0,-.9px) rotate(-3deg)}25%{transform:translate(.6px,.2px) rotate(2deg)}50%{transform:translate(0,.75px) rotate(3deg)}75%{transform:translate(-.6px,-.2px) rotate(-2deg)}}' +
        flutterFrames +
        '@keyframes w-spark{0%{opacity:0;transform:translateY(.6px) scale(.8)}22%{opacity:.95;transform:translateY(-.4px) scale(1)}100%{opacity:0;transform:translateY(-2.2px) scale(.7)}}'
      frontFx =
        '<rect class="bee-fx spark s1" x="2" y="3" width="1" height="1" fill="var(--spark)"/>' +
        '<rect class="bee-fx spark s2" x="21" y="3" width="1" height="1" fill="var(--spark)"/>' +
        '<rect class="bee-fx spark s3" x="20" y="10" width="1" height="1" fill="var(--spark)"/>'
    } else if (variant === 1) {
      // pollen-forage: foraging pitch-dip + lower orbiting pollen motes
      motionStyle =
        `.bee-hover{transform-box:fill-box;transform-origin:50% 55%;animation:w-forage ${hoverDur}ms ${easeInOut} ${delay(hoverDur, 'hv')} infinite}` +
        flutterCss +
        `.pollen{transform-box:fill-box;transform-origin:center;animation:w-pollen ${fxDur}ms ${easeInOut} ${delay(fxDur, 'p1')} infinite}` +
        `.p2{animation-delay:${delay(fxDur, 'p2')}}.p3{animation-delay:${delay(fxDur, 'p3')}}` +
        '@keyframes w-forage{0%,100%{transform:translate(-.5px,-.5px) rotate(-4deg)}50%{transform:translate(.5px,.8px) rotate(4deg)}}' +
        flutterFrames +
        '@keyframes w-pollen{0%,100%{opacity:.18;transform:translate(-.7px,.4px)}50%{opacity:.95;transform:translate(.7px,-.8px)}}'
      frontFx =
        '<rect class="bee-fx pollen p1" x="3" y="10" width="1" height="1" fill="var(--honey)"/>' +
        '<rect class="bee-fx pollen p2" x="20" y="10" width="1" height="1" fill="var(--spark)"/>' +
        '<rect class="bee-fx pollen p3" x="12" y="13" width="1" height="1" fill="var(--spark)"/>'
    } else if (variant === 2) {
      // comb-tap: rhythmic double-beat work tap + dual comb sparks
      motionStyle =
        `.bee-hover{transform-box:fill-box;transform-origin:50% 55%;animation:w-tap ${hoverDur}ms ${easeInOut} ${delay(hoverDur, 'hv')} infinite}` +
        flutterCss +
        `.spark{transform-box:fill-box;transform-origin:center;animation:w-burst ${fxDur}ms ${easeOut} ${delay(fxDur, 'b1')} infinite}` +
        `.s2{animation-delay:${delay(fxDur, 'b2')}}` +
        '@keyframes w-tap{0%,100%{transform:translateY(-.5px)}25%{transform:translateY(.7px)}45%{transform:translateY(-.2px)}68%{transform:translateY(.8px)}}' +
        flutterFrames +
        '@keyframes w-burst{0%{opacity:0;transform:scale(.6)}30%{opacity:.95;transform:translateY(-.8px) scale(1.1)}100%{opacity:0;transform:translateY(-1.8px) scale(.7)}}'
      frontFx =
        '<rect class="bee-fx spark s1" x="4" y="11" width="1" height="1" fill="var(--spark)"/>' +
        '<rect class="bee-fx spark s2" x="19" y="11" width="1" height="1" fill="var(--spark)"/>'
    } else {
      // antenna-scan: poised hover + sweeping antennae + buzz lines
      motionStyle =
        `.bee-hover{transform-box:fill-box;transform-origin:50% 55%;animation:w-poise ${hoverDur}ms ${easeInOut} ${delay(hoverDur, 'hv')} infinite}` +
        flutterCss +
        `.bee-antennae{transform-box:fill-box;transform-origin:50% 100%;animation:w-ant ${antDur}ms ${easeInOut} ${delay(antDur, 'an')} infinite}` +
        `.buzz{animation:w-buzz ${flapDur}ms linear ${delay(flapDur, 'bz')} infinite}` +
        '@keyframes w-poise{0%,100%{transform:translateY(-.6px)}50%{transform:translateY(.6px)}}' +
        flutterFrames +
        '@keyframes w-ant{0%,100%{transform:rotate(-7deg) scaleY(1.05)}50%{transform:rotate(7deg) scaleY(.95)}}' +
        '@keyframes w-buzz{0%,100%{opacity:0}45%,65%{opacity:.7}}'
      frontFx = '<path class="bee-fx buzz" fill="var(--wing-front)" d="M1 5h1v1H1zM2 7h1v1H2zM22 5h1v1h-1zM21 7h1v1h-1z"/>'
    }
  } else if (effective === 'coordinating') {
    const flapDur = jitter(220)
    const hoverDur = jitter(1680)
    const auraDur = jitter(2350)
    baseStyle += '.aura{opacity:.48}.beacon{opacity:0}'
    defs =
      '<defs><radialGradient id="bg"><stop offset="0%" stop-color="var(--spark)" stop-opacity=".42"/>' +
      '<stop offset="65%" stop-color="var(--honey)" stop-opacity=".16"/><stop offset="100%" stop-color="var(--honey)" stop-opacity="0"/></radialGradient></defs>'
    backFx = '<ellipse class="bee-fx aura" cx="12" cy="8" rx="9" ry="6" fill="url(#bg)" shape-rendering="auto"/>'
    const coordWings =
      `.wing-l{transform-box:fill-box;transform-origin:95% 58%;animation:c-flap-l ${flapDur}ms ${easeInOut} ${delay(flapDur, 'fl')} infinite}` +
      `.wing-r{transform-box:fill-box;transform-origin:5% 58%;animation:c-flap-r ${flapDur}ms ${easeInOut} ${delay(flapDur, 'fr')} infinite}` +
      `.wing-glint{animation:c-glint ${flapDur}ms ${easeInOut} ${delay(flapDur, 'gl')} infinite}` +
      `.aura{transform-box:fill-box;transform-origin:center;animation:c-aura ${auraDur}ms ${easeInOut} ${delay(auraDur, 'au')} infinite}`
    const coordFrames =
      '@keyframes c-flap-l{0%,100%{transform:rotate(15deg) scaleY(.95)}50%{transform:rotate(-14deg) scaleY(.84)}}' +
      '@keyframes c-flap-r{0%,100%{transform:rotate(-15deg) scaleY(.95)}50%{transform:rotate(14deg) scaleY(.84)}}' +
      '@keyframes c-glint{0%,100%{opacity:.3}50%{opacity:.9}}' +
      '@keyframes c-aura{0%,100%{opacity:.32;transform:scale(.95)}50%{opacity:.78;transform:scale(1.08)}}'

    if (variant === 0) {
      // royal-hover
      motionStyle =
        `.bee-hover{transform-box:fill-box;transform-origin:50% 55%;animation:c-royal ${hoverDur}ms ${easeInOut} ${delay(hoverDur, 'hv')} infinite}` +
        coordWings +
        '@keyframes c-royal{0%,100%{transform:translateY(-.65px) rotate(-1.5deg)}50%{transform:translateY(.6px) rotate(1.5deg)}}' +
        coordFrames
    } else if (variant === 1) {
      // waggle-dance
      motionStyle =
        `.bee-hover{transform-box:fill-box;transform-origin:50% 55%;animation:c-waggle ${hoverDur}ms ${easeInOut} ${delay(hoverDur, 'hv')} infinite}` +
        coordWings +
        '@keyframes c-waggle{0%,100%{transform:translate(-.9px,-.3px) rotate(-2.5deg)}25%{transform:translate(0,.5px) rotate(0deg)}50%{transform:translate(.9px,-.3px) rotate(2.5deg)}75%{transform:translate(0,.5px) rotate(0deg)}}' +
        coordFrames
    } else {
      // beacon-pulse
      motionStyle =
        `.bee-hover{transform-box:fill-box;transform-origin:50% 55%;animation:c-poise ${hoverDur}ms ${easeInOut} ${delay(hoverDur, 'hv')} infinite}` +
        coordWings +
        `.beacon{transform-box:fill-box;transform-origin:center;animation:c-beacon ${auraDur}ms ${easeOut} ${delay(auraDur, 'bc')} infinite}` +
        '@keyframes c-poise{0%,100%{transform:translateY(-.45px)}50%{transform:translateY(.45px)}}' +
        coordFrames +
        '@keyframes c-beacon{0%{opacity:0;transform:scale(.7)}30%{opacity:.85}100%{opacity:0;transform:scale(1.22)}}'
      backFx += `<path class="bee-fx beacon" fill="none" stroke="var(--honey)" stroke-width="1" d="${HEX_CELL}"/>`
    }
  } else if (effective === 'waiting') {
    const restDur = jitter(variant === 0 ? 4200 : variant === 1 ? 4600 : variant === 2 ? 4800 : 5200)
    const restFrames = '@keyframes i-rest{0%,100%{transform:scaleY(1)}50%{transform:scaleY(.94)}}'
    if (variant === 0) {
      // sleep-zzz
      baseStyle += '.doze-z{opacity:0}'
      motionStyle =
        `.bee-hover{transform-box:fill-box;transform-origin:50% 90%;animation:i-rest ${restDur}ms ${easeInOut} ${delay(restDur, 'rs')} infinite}` +
        `.z1{animation:i-doze 3600ms linear ${delay(3600, 'z1')} infinite}` +
        `.z2{animation:i-doze 3600ms linear ${delay(3600, 'z2')} infinite}` +
        restFrames +
        '@keyframes i-doze{0%{opacity:0;transform:translate(0,0)}25%,65%{opacity:.88}100%{opacity:0;transform:translate(.8px,-1.4px)}}'
      frontFx =
        '<path class="bee-fx doze-z z1" fill="var(--wing-back)" d="M17 3h3v1h-3zM19 4h1v1h-1zM18 5h1v1h-1zM17 6h3v1h-3z"/>' +
        '<path class="bee-fx doze-z z2" fill="var(--wing-front)" d="M21 2h2v1h-2zM21 3h1v1h-1zM20 4h2v1h-2z"/>'
    } else if (variant === 1) {
      // wing-preen
      motionStyle =
        `.bee-hover{transform-box:fill-box;transform-origin:50% 90%;animation:i-rest ${restDur}ms ${easeInOut} ${delay(restDur, 'rs')} infinite}` +
        `.wing-r{transform-box:fill-box;transform-origin:5% 60%;animation:i-preen ${restDur}ms ${easeInOut} ${delay(restDur, 'pr')} infinite}` +
        `.wing-glint-back{animation:i-preen-g ${restDur}ms ${easeInOut} ${delay(restDur, 'pr')} infinite}` +
        restFrames +
        '@keyframes i-preen{0%,62%,100%{transform:rotate(0deg)}75%{transform:rotate(12deg) translateY(-.4px)}88%{transform:rotate(-2deg)}}' +
        '@keyframes i-preen-g{0%,62%,100%{opacity:.54}75%{opacity:.98}}'
    } else if (variant === 2) {
      // antenna-twitch
      motionStyle =
        `.bee-hover{transform-box:fill-box;transform-origin:50% 90%;animation:i-rest ${restDur}ms ${easeInOut} ${delay(restDur, 'rs')} infinite}` +
        `.bee-antennae{transform-box:fill-box;transform-origin:50% 100%;animation:i-twitch ${restDur}ms ${easeInOut} ${delay(restDur, 'tw')} infinite}` +
        restFrames +
        '@keyframes i-twitch{0%,34%,56%,100%{transform:rotate(0deg)}40%{transform:rotate(-8deg)}46%{transform:rotate(6deg)}51%{transform:rotate(-5deg)}}'
    } else {
      // sunbeam-doze
      baseStyle += '.sun-glow{opacity:.18}'
      defs = '<defs><radialGradient id="sg"><stop offset="0%" stop-color="var(--spark)" stop-opacity=".46"/><stop offset="100%" stop-color="var(--honey)" stop-opacity="0"/></radialGradient></defs>'
      backFx = '<ellipse class="bee-fx sun-glow" cx="12" cy="9" rx="8" ry="5" fill="url(#sg)" shape-rendering="auto"/>'
      motionStyle =
        `.bee-hover{transform-box:fill-box;transform-origin:50% 60%;animation:i-float ${restDur}ms ${easeInOut} ${delay(restDur, 'fl')} infinite}` +
        `.sun-glow{animation:i-sunglow ${restDur}ms ${easeInOut} ${delay(restDur, 'sg')} infinite}` +
        '@keyframes i-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-.55px)}}' +
        '@keyframes i-sunglow{0%,100%{opacity:.16}50%{opacity:.4}}'
    }
  } else if (effective === 'not started') {
    const broodDur = jitter(variant === 0 ? 4600 : variant === 1 ? 5200 : 4200)
    // Desaturated warm wax brood-cell palette (>= 3:1 contrast) — no opacity:.5 washout.
    baseStyle +=
      '.bee-body{fill:var(--brood-body)}.bee-band-honey{fill:var(--brood-band)}' +
      '.wing-front{fill:var(--brood-wing-f)}.wing-back{fill:var(--brood-wing-b)}' +
      '.brood-cell{fill:none;stroke:var(--warn);stroke-width:1;stroke-dasharray:3 2;opacity:.82}'
    backFx = `<path class="bee-fx brood-cell" d="${HEX_CELL}"/>`

    if (variant === 0) {
      // cell-incubate
      motionStyle =
        `.brood-cell{animation:n-incubate ${broodDur}ms ${easeInOut} ${delay(broodDur, 'in')} infinite}` +
        '@keyframes n-incubate{0%,100%{opacity:.46}50%{opacity:.98}}'
    } else if (variant === 1) {
      // cell-peek
      baseStyle += '.peek-eyes{opacity:0}'
      innerFx = `<path class="bee-fx peek-eyes" fill="var(--ink)" d="${EYES.open}"/>`
      motionStyle =
        `.bee-hover{transform-box:fill-box;transform-origin:50% 60%;animation:n-nudge ${broodDur}ms ${easeInOut} ${delay(broodDur, 'nd')} infinite}` +
        `.peek-eyes{animation:n-peek ${broodDur}ms ${easeInOut} ${delay(broodDur, 'pk')} infinite}` +
        '@keyframes n-nudge{0%,10%,32%,100%{transform:translateY(0)}20%{transform:translateY(-.5px)}}' +
        '@keyframes n-peek{0%,10%,32%,100%{opacity:0}16%,26%{opacity:1}}'
    } else {
      // pollen-cue
      baseStyle += '.cue-dot{opacity:.55}'
      frontFx = '<rect class="bee-fx cue-dot" x="12" y="1" width="1" height="1" fill="var(--honey)"/>'
      motionStyle =
        `.cue-dot{transform-box:fill-box;transform-origin:12px 7.5px;animation:n-cue ${broodDur}ms linear ${delay(broodDur, 'cu')} infinite}` +
        '@keyframes n-cue{0%{opacity:.4;transform:translate(-5px,1px)}25%{opacity:1;transform:translate(0,0)}50%{opacity:.6;transform:translate(5px,1px)}75%{opacity:.9;transform:translate(0,2px)}100%{opacity:.4;transform:translate(-5px,1px)}}'
    }
  } else if (effective === 'paused') {
    const pauseDur = jitter(variant === 0 ? 4400 : variant === 1 ? 5200 : 4800)
    baseStyle += '.stasis-hex{fill:none;stroke:var(--warn);stroke-width:1;opacity:.8}.stasis-bar{fill:var(--warn);opacity:.95}'
    backFx = `<path class="bee-fx stasis-hex" d="${HEX_BADGE}"/>`
    frontFx =
      '<rect class="bee-fx stasis-bar b1" x="19" y="1" width="1" height="3"/>' +
      '<rect class="bee-fx stasis-bar b2" x="21" y="1" width="1" height="3"/>'

    if (variant === 0) {
      // amber-stasis
      motionStyle =
        `.stasis-hex{animation:p-amber ${pauseDur}ms ${easeInOut} ${delay(pauseDur, 'am')} infinite}` +
        '@keyframes p-amber{0%,100%{opacity:.52}50%{opacity:1}}'
    } else if (variant === 1) {
      // suspended-breath
      motionStyle =
        `.bee-hover{transform-box:fill-box;transform-origin:50% 60%;animation:p-breath ${pauseDur}ms ${easeInOut} ${delay(pauseDur, 'sb')} infinite}` +
        `.stasis-bar{animation:p-bars ${pauseDur}ms ${easeInOut} ${delay(pauseDur, 'br')} infinite}` +
        '@keyframes p-breath{0%,100%{transform:translateY(0)}50%{transform:translateY(-.35px)}}' +
        '@keyframes p-bars{0%,100%{opacity:.62}50%{opacity:1}}'
    } else {
      // wax-seal
      baseStyle += '.seal-glint{opacity:0}'
      frontFx += '<rect class="bee-fx seal-glint" x="9" y="8" width="2" height="1" fill="var(--spark)"/>'
      motionStyle =
        `.bee-antennae{transform-box:fill-box;transform-origin:50% 100%;animation:p-tuck ${pauseDur}ms ${easeInOut} ${delay(pauseDur, 'tk')} infinite}` +
        `.seal-glint{animation:p-sheen ${pauseDur}ms ${easeInOut} ${delay(pauseDur, 'sh')} infinite}` +
        '@keyframes p-tuck{0%,100%{transform:scaleY(.92)}50%{transform:scaleY(1)}}' +
        '@keyframes p-sheen{0%,35%,100%{opacity:0;transform:translateX(0)}55%{opacity:.85;transform:translateX(2px)}75%{opacity:0;transform:translateX(4px)}}'
    }
  } else if (effective === 'closed') {
    const closeDur = jitter(variant === 0 ? 5600 : variant === 1 ? 6000 : 5400)
    baseStyle += '.arch-cradle{fill:none;stroke:var(--honey);stroke-width:1;opacity:.75}'
    backFx = '<path class="bee-fx arch-cradle" d="M3 10L12 14L21 10"/>'
    if (variant === 0) {
      // sealed-comb
      baseStyle += '.comb-luster{opacity:.2}'
      frontFx = '<rect class="bee-fx comb-luster" x="9" y="10" width="2" height="1" fill="var(--spark)"/>'
      motionStyle =
        `.comb-luster{animation:cl-sweep ${closeDur}ms ${easeInOut} ${delay(closeDur, 'sw')} infinite}` +
        '@keyframes cl-sweep{0%,100%{opacity:.15;transform:translateX(0)}50%{opacity:.85;transform:translateX(4px)}}'
    } else if (variant === 1) {
      // content-rest
      motionStyle =
        `.bee-hover{transform-box:fill-box;transform-origin:50% 90%;animation:cl-rest ${closeDur}ms ${easeInOut} ${delay(closeDur, 'cr')} infinite}` +
        '@keyframes cl-rest{0%,100%{transform:scaleY(1)}50%{transform:scaleY(.96)}}'
    } else {
      // nectar-gem
      baseStyle += '.nectar-gem{opacity:.75}'
      frontFx = '<rect class="bee-fx nectar-gem" x="20" y="2" width="2" height="2" fill="var(--honey)"/>'
      motionStyle =
        `.nectar-gem{animation:cl-gem ${closeDur}ms ${easeInOut} ${delay(closeDur, 'gm')} infinite}` +
        '@keyframes cl-gem{0%,100%{opacity:.5;transform:scale(.92)}50%{opacity:.98;transform:scale(1.06)}}'
    }
  } else if (effective === 'killed') {
    const retDur = jitter(variant === 0 ? 5600 : variant === 1 ? 5000 : 4800)
    // Desaturated propolis-ash tones preserving >= 3:1 contrast without svg{opacity:.5}.
    baseStyle +=
      '.bee-body{fill:var(--retired-body)}.bee-band-honey{fill:var(--retired-band)}.bee-band-stripe{fill:var(--retired-stripe)}' +
      '.wing-front{fill:var(--retired-wing-f)}.wing-back{fill:var(--retired-wing-b)}.bee-antennae{fill:var(--retired-ant)}' +
      '.retired-hex{fill:none;stroke:var(--retired-body);stroke-width:1;stroke-dasharray:2 2;opacity:.85}' +
      '.retire-slash{stroke:var(--retired-body);stroke-width:1}'
    backFx = `<path class="bee-fx retired-hex" d="${HEX_BADGE}"/>`
    frontFx = '<path class="bee-fx retire-slash" d="M19 4L22 1"/>'

    if (variant === 0) {
      // spirit-drift
      motionStyle =
        `.bee-hover{transform-box:fill-box;transform-origin:50% 60%;animation:k-drift ${retDur}ms ${easeInOut} ${delay(retDur, 'dr')} infinite}` +
        `.retired-hex{animation:k-ring ${retDur}ms ${easeInOut} ${delay(retDur, 'rg')} infinite}` +
        '@keyframes k-drift{0%,100%{transform:translateY(0)}50%{transform:translateY(-.7px)}}' +
        '@keyframes k-ring{0%,100%{opacity:.55}50%{opacity:.95}}'
    } else if (variant === 1) {
      // ash-mote
      baseStyle += '.ash-mote{opacity:0}'
      frontFx += '<rect class="bee-fx ash-mote" x="18" y="5" width="1" height="1" fill="var(--retired-band)"/>'
      motionStyle =
        `.ash-mote{animation:k-ash ${retDur}ms ${easeOut} ${delay(retDur, 'as')} infinite}` +
        '@keyframes k-ash{0%{opacity:0;transform:translateY(1px)}28%{opacity:.9}100%{opacity:0;transform:translate(1px,-3px)}}'
    } else {
      // retired-seal
      motionStyle =
        `.retired-hex{animation:k-seal ${retDur}ms ${easeInOut} ${delay(retDur, 'sl')} infinite}` +
        '@keyframes k-seal{0%,100%{opacity:.48}50%{opacity:.92}}'
    }
  } else if (effective === 'stopped') {
    const stopDur = jitter(variant === 0 ? 3800 : variant === 1 ? 3200 : 3000)
    baseStyle += '.stop-badge{fill:var(--stop);opacity:.95}'
    frontFx = '<rect class="bee-fx stop-badge" x="19" y="1" width="3" height="3"/>'

    if (variant === 0) {
      // stall-shudder
      motionStyle =
        `.wing-l{transform-box:fill-box;transform-origin:95% 58%;animation:st-shudder-l ${stopDur}ms ${easeInOut} ${delay(stopDur, 'sl')} infinite}` +
        `.wing-r{transform-box:fill-box;transform-origin:5% 58%;animation:st-shudder-r ${stopDur}ms ${easeInOut} ${delay(stopDur, 'sr')} infinite}` +
        '@keyframes st-shudder-l{0%,68%,100%{transform:rotate(0deg)}76%{transform:rotate(11deg)}84%{transform:rotate(-5deg)}92%{transform:rotate(4deg)}}' +
        '@keyframes st-shudder-r{0%,68%,100%{transform:rotate(0deg)}76%{transform:rotate(-11deg)}84%{transform:rotate(5deg)}92%{transform:rotate(-4deg)}}'
    } else if (variant === 1) {
      // askew-wing
      motionStyle =
        `.wing-l{transform-box:fill-box;transform-origin:95% 58%;animation:st-askew ${stopDur}ms ${easeInOut} ${delay(stopDur, 'ak')} infinite}` +
        `.stop-badge{animation:st-blink ${stopDur}ms ${easeInOut} ${delay(stopDur, 'bk')} infinite}` +
        '@keyframes st-askew{0%,100%{transform:rotate(-10deg)}50%{transform:rotate(-5deg)}}' +
        '@keyframes st-blink{0%,45%,100%{opacity:.95}55%,85%{opacity:.42}}'
    } else {
      // grounded-thud
      motionStyle =
        `.bee-hover{transform-box:fill-box;transform-origin:50% 60%;animation:st-thud ${stopDur}ms ${easeInOut} ${delay(stopDur, 'th')} infinite}` +
        `.bee-antennae{transform-box:fill-box;transform-origin:50% 100%;animation:st-droop ${stopDur}ms ${easeInOut} ${delay(stopDur, 'dp')} infinite}` +
        `.stop-badge{animation:st-pulse ${stopDur}ms ${easeInOut} ${delay(stopDur, 'ps')} infinite}` +
        '@keyframes st-thud{0%,100%{transform:translateY(.9px)}50%{transform:translateY(.4px)}}' +
        '@keyframes st-droop{0%,100%{transform:scaleY(.88)}50%{transform:scaleY(.95)}}' +
        '@keyframes st-pulse{0%,100%{opacity:.55}50%{opacity:1}}'
    }
  } else if (effective === 'failed') {
    const errDur = jitter(variant === 0 ? 2600 : variant === 1 ? 2400 : 2800)
    baseStyle += '.err-mark{fill:var(--err);opacity:.95}'
    frontFx = '<path class="bee-fx err-mark" d="M20 1h1v2h-1zM20 4h1v1h-1z"/>'

    if (variant === 0) {
      // dizzy-antenna
      baseStyle += '.err-spark{opacity:0}'
      frontFx +=
        '<rect class="bee-fx err-spark es1" x="3" y="3" width="1" height="1" fill="var(--err)"/>' +
        '<rect class="bee-fx err-spark es2" x="18" y="3" width="1" height="1" fill="var(--err)"/>'
      motionStyle =
        `.bee-antennae{transform-box:fill-box;transform-origin:50% 100%;animation:f-dizzy ${errDur}ms ${easeInOut} ${delay(errDur, 'dz')} infinite}` +
        `.es1{animation:f-es ${errDur}ms ${easeOut} ${delay(errDur, 'e1')} infinite}` +
        `.es2{animation:f-es ${errDur}ms ${easeOut} ${delay(errDur, 'e2')} infinite}` +
        '@keyframes f-dizzy{0%,100%{transform:rotate(-8deg)}35%{transform:rotate(9deg)}70%{transform:rotate(-6deg)}}' +
        '@keyframes f-es{0%,100%{opacity:0;transform:translateY(0)}30%{opacity:.95;transform:translateY(-1px)}70%{opacity:0;transform:translateY(-2px)}}'
    } else if (variant === 1) {
      // alarm-halo
      baseStyle += '.alarm-halo{opacity:.16}'
      defs = '<defs><radialGradient id="fg"><stop offset="0%" stop-color="var(--err)" stop-opacity=".55"/><stop offset="100%" stop-color="var(--err)" stop-opacity="0"/></radialGradient></defs>'
      backFx = '<ellipse class="bee-fx alarm-halo" cx="12" cy="8" rx="9" ry="6" fill="url(#fg)" shape-rendering="auto"/>'
      motionStyle =
        `.alarm-halo{animation:f-halo ${errDur}ms ${easeInOut} ${delay(errDur, 'hl')} infinite}` +
        '@keyframes f-halo{0%,100%{opacity:.12;transform:scale(.95)}50%{opacity:.32;transform:scale(1.06)}}'
    } else {
      // spark-sputter
      baseStyle += '.sputter{opacity:0}'
      frontFx +=
        '<rect class="bee-fx sputter sp1" x="5" y="10" width="1" height="1" fill="var(--err)"/>' +
        '<rect class="bee-fx sputter sp2" x="18" y="11" width="1" height="1" fill="var(--honey)"/>'
      motionStyle =
        `.bee-hover{transform-box:fill-box;transform-origin:50% 55%;animation:f-tilt ${errDur}ms ${easeInOut} ${delay(errDur, 'tl')} infinite}` +
        `.sp1{animation:f-drop ${errDur}ms ${easeOut} ${delay(errDur, 'd1')} infinite}` +
        `.sp2{animation:f-drop ${errDur}ms ${easeOut} ${delay(errDur, 'd2')} infinite}` +
        '@keyframes f-tilt{0%,100%{transform:rotate(-4deg)}50%{transform:rotate(-2deg) translateY(.4px)}}' +
        '@keyframes f-drop{0%{opacity:0;transform:translateY(-.5px)}25%{opacity:.95}100%{opacity:0;transform:translateY(2.2px)}}'
    }
  } else {
    // unreachable (3 lost-contact variants: signal-ping, antenna-search, weak-link)
    const unDur = jitter(variant === 0 ? 2800 : variant === 1 ? 3400 : 3200)
    baseStyle += '.sig-pip{fill:var(--unreach);opacity:.9}'
    if (variant === 0) {
      // signal-ping
      frontFx =
        '<rect class="bee-fx sig-pip sp1" x="5" y="1" width="2" height="1"/>' +
        '<rect class="bee-fx sig-pip sp2" x="17" y="1" width="2" height="1"/>'
      motionStyle =
        `.sp1{animation:u-ping ${unDur}ms ${easeOut} ${delay(unDur, 'p1')} infinite}` +
        `.sp2{animation:u-ping ${unDur}ms ${easeOut} ${delay(unDur, 'p2')} infinite}` +
        '@keyframes u-ping{0%,100%{opacity:.25;transform:translateY(.5px)}45%{opacity:1;transform:translateY(-.8px)}}'
    } else if (variant === 1) {
      // antenna-search
      frontFx = '<rect class="bee-fx sig-pip" x="11" y="1" width="2" height="1"/>'
      motionStyle =
        `.bee-antennae{transform-box:fill-box;transform-origin:50% 100%;animation:u-search ${unDur}ms ${easeInOut} ${delay(unDur, 'sr')} infinite}` +
        `.sig-pip{animation:u-blink ${unDur}ms linear ${delay(unDur, 'bk')} infinite}` +
        '@keyframes u-search{0%,100%{transform:rotate(-9deg)}50%{transform:rotate(9deg)}}' +
        '@keyframes u-blink{0%,45%,100%{opacity:.25}50%,85%{opacity:1}}'
    } else {
      // weak-link
      baseStyle += '.weak-hex{fill:none;stroke:var(--unreach);stroke-width:1;stroke-dasharray:2 3;opacity:.75}'
      backFx = `<path class="bee-fx weak-hex" d="${HEX_CELL}"/>`
      motionStyle =
        `.weak-hex{animation:u-flicker ${unDur}ms linear ${delay(unDur, 'wf')} infinite}` +
        `.wing-glint{animation:u-flicker ${unDur}ms linear ${delay(unDur, 'wg')} infinite}` +
        '@keyframes u-flicker{0%,28%,42%,74%,100%{opacity:.85}34%,68%{opacity:.22}}'
    }
  }

  const reducedGuard =
    '@media(prefers-reduced-motion:no-preference){' +
    '.bee-hover,.wing-l,.wing-r,.bee-antennae,.bee-fx{shape-rendering:auto}' +
    motionStyle +
    '}'

  const w = WINGS[wingPose]
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 15" shape-rendering="crispEdges"><style>${baseStyle}${reducedGuard}</style>${defs}${backFx}` +
    '<g class="bee-hover">' +
    `<g class="wing-r"><path class="wing-back" fill="var(--wing-back)" d="${w.right}"/><path class="wing-glint wing-glint-back" d="${w.glintR}"/></g>` +
    `<g class="wing-l"><path class="wing-front" fill="var(--wing-front)" d="${w.left}"/><path class="wing-glint" d="${w.glintL}"/></g>` +
    '<path class="bee-antennae" fill="var(--antennae)" d="M8 3h1v1h1v1H9V4H8zM15 3h1v1h-1v1h-1V4h1z"/>' +
    `<path class="bee-body" fill="${accent}" d="M10 4h4v1h2v5h-1v1h-1v1h-4v-1H9v-1H8V5h2z"/>` +
    '<path class="bee-band bee-band-honey" fill="var(--honey)" d="M9 8h6v1H9zM9 10h6v1H9z"/>' +
    '<path class="bee-band bee-band-stripe" fill="var(--stripe)" d="M9 9h6v1H9zM10 11h4v1h-4z"/>' +
    `<path class="bee-eyes" fill="var(--ink)" d="${EYES[eyePose]}"/>${innerFx}</g>${frontFx}</svg>`
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
            '@media(prefers-reduced-motion:no-preference){' +
            '.bee,.prop{shape-rendering:auto}' +
            `.bee{transform-box:fill-box;transform-origin:bottom center;animation:rest 5200ms ${easeInOut} ${loopDelay(elapsed, 5200, moodPhase)} infinite}` +
            `.right{animation-delay:${loopDelay(elapsed, 5200, 1400 + moodPhase)}}` +
            `.prop{animation:pause-glow 4400ms ${easeInOut} ${loopDelay(elapsed, 4400, moodPhase)} infinite}` +
            `.aura{transform-box:fill-box;transform-origin:center;animation:glow 4800ms ${easeInOut} ${loopDelay(elapsed, 4800, moodPhase)} infinite}` +
            '}' +
            '@keyframes rest{0%,100%{transform:scaleY(1)}50%{transform:scaleY(.95)}}' +
            '@keyframes pause-glow{0%,100%{opacity:.58}50%{opacity:1}}' +
            '@keyframes glow{0%,100%{opacity:.36;transform:scale(.97)}50%{opacity:.66;transform:scale(1.03)}}',
          art: `<g transform="translate(8 2)">${propMarkup}</g>`,
        }
      : {
          style:
            '.aura{opacity:.65}.door-glow{opacity:.2}.spark{opacity:0}' +
            '@media(prefers-reduced-motion:no-preference){' +
            '.bee,.prop,.spark{shape-rendering:auto}' +
            `.left{animation:l 3600ms linear ${loopDelay(elapsed, 3600, moodPhase)} infinite}` +
            `.right{animation:r 4300ms linear ${loopDelay(elapsed, 4300, 560 + moodPhase)} infinite}` +
            `.left .wing{${wings(elapsed, 320, moodPhase)}}` +
            `.right .wing{${wings(elapsed, 350, 130 + moodPhase)}}` +
            `.prop{transform-box:fill-box;transform-origin:center;animation:signal ${pDur}ms ${mood === 'relay' ? 'linear' : easeInOut} ${loopDelay(elapsed, pDur, moodPhase)} infinite}` +
            `.spark{animation:spark ${pDur}ms ${easeOut} ${loopDelay(elapsed, pDur, 200 + moodPhase)} infinite}` +
            `.aura{transform-box:fill-box;transform-origin:center;animation:glow 4000ms ${easeInOut} ${loopDelay(elapsed, 4000, moodPhase)} infinite}` +
            `.door-glow{animation:door-glow 3200ms ${easeInOut} ${loopDelay(elapsed, 3200, moodPhase)} infinite}` +
            '}' +
            `@keyframes l{${orbit(left, .6)}}` +
            `@keyframes r{${orbit(right, -.68)}}` +
            wingFrames +
            `@keyframes signal{${propKeyframes[mood]}}` +
            '@keyframes spark{0%,24%{opacity:0;transform:translateY(.5px)}48%{opacity:.85}100%{opacity:0;transform:translateY(-1.25px)}}' +
            '@keyframes glow{0%,100%{opacity:.45;transform:scale(.96)}50%{opacity:.85;transform:scale(1.06)}}' +
            '@keyframes door-glow{0%,100%{opacity:.13}50%{opacity:.38}}',
          art: `<g transform="translate(${mood === 'build' || mood === 'forage' ? 6 : 8} ${mood === 'relay' ? 1 : 2})">${propMarkup}</g>`,
        }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 22" shape-rendering="crispEdges"><style>${HIVE_TOKENS}${scene.style}</style>` +
    `${aura}<path fill="var(--wax)" d="M19 6h6v1h2v2h2v3h1v7H14v-7h1V9h2V7h2z"/>` +
    '<path fill="var(--honey)" d="M17 8h10v1H17zM15 11h14v2H15zM14 14h16v2H14z"/>' +
    '<path fill="var(--spark)" fill-opacity=".18" d="M20 7h4v1h-4zM16 10h2v1h-2zM26 10h2v1h-2zM16 13h2v1h-2zM26 13h2v1h-2zM15 17h2v1h-2zM27 17h2v1h-2z"/>' +
    `<path fill="var(--ink)" d="M21 14h2v1h1v4h-4v-4h1z"/>${doorwayGlow}` +
    `${bee(resting ? 3 : 2, resting ? 13 : 11, 'left')}${bee(resting ? 33 : 34, resting ? 13 : 6, 'right')}` +
    `${scene.art}</svg>`
}
