import { easeInOut, easeOut, loopDelay, seededPhase } from './motion'

// The card border and its SVG use the same accent in both themes. The host's theme tokens are resolved outside the SVG.
export const memberAccents = {
  claude: '#c26952',
  suggestion: '#628fd2',
  planMode: '#338f83',
  ide: '#b87932',
  merged: '#9176c3',
  permission: '#bb6295',
  remember: '#7985c9',
  autoAccept: '#648d42',
  subtle: '#858589',
} as const

export interface PaletteToken {
  readonly light: string
  readonly lightP3: string
  readonly dark: string
  readonly darkP3: string
}

/** Unified Beehive Color Palette: OKLCH-authored, WCAG >= 3:1 UI verified, with in-gamut Display P3 variants. */
export const beehivePalette = {
  honeyCore: {
    light: '#e8a848',
    lightP3: 'color(display-p3 .8721 .6692 .3511)',
    dark: '#f2bd6a',
    darkP3: 'color(display-p3 .9166 .7493 .4652)',
  },
  honeyDeep: {
    light: '#996314',
    lightP3: 'color(display-p3 .5696 .3976 .1553)',
    dark: '#f0b74f',
    darkP3: 'color(display-p3 .9068 .7265 .3816)',
  },
  honeySpark: {
    light: '#f5cc66',
    lightP3: 'color(display-p3 .9349 .8060 .4617)',
    dark: '#fde08d',
    darkP3: 'color(display-p3 .9733 .8825 .5954)',
  },
  waxFill: {
    light: '#b46b46',
    lightP3: 'color(display-p3 .6663 .4331 .3019)',
    dark: '#c9835b',
    darkP3: 'color(display-p3 .7489 .5259 .3836)',
  },
  waxTrack: {
    light: '#e4ddd1',
    lightP3: 'color(display-p3 .8894 .8676 .8244)',
    dark: '#3a352e',
    darkP3: 'color(display-p3 .2241 .2085 .1834)',
  },
  waxBorder: {
    // 3.1:1 on waxTrack in both spaces, light and dark: the 3:1 progressBar promises for its track border.
    light: '#837a6d',
    lightP3: 'color(display-p3 .5077 .4797 .433)',
    // 3.1:1 on waxTrack in both spaces too.
    dark: '#8b8070',
    darkP3: 'color(display-p3 .5378 .5035 .4461)',
  },
  waxHairline: {
    light: '#d5cbbd',
    lightP3: 'color(display-p3 .8286 .7974 .747)',
    dark: '#453e36',
    darkP3: 'color(display-p3 .266 .2441 .2153)',
  },
  propolisInk: {
    light: '#362218',
    lightP3: 'color(display-p3 .2039 .1373 .102)',
    dark: '#2e1d14',
    darkP3: 'color(display-p3 .1725 .1176 .0863)',
  },
  wingBack: {
    light: '#4b8f91',
    lightP3: 'color(display-p3 .3602 .5544 .5647)',
    dark: '#99c8c8',
    darkP3: 'color(display-p3 .6379 .7791 .7816)',
  },
  wingFront: {
    light: '#5b989a',
    lightP3: 'color(display-p3 .409 .589 .6)',
    dark: '#b9dcdc',
    darkP3: 'color(display-p3 .7523 .8586 .8606)',
  },
  wingInfo: {
    light: '#287578',
    lightP3: 'color(display-p3 .2454 .4525 .4664)',
    dark: '#7ec7c9',
    darkP3: 'color(display-p3 .5592 .773 .7837)',
  },
} as const satisfies Record<string, PaletteToken>

// Desktop status colors use exact in-gamut D65 Display P3 coordinates with WCAG-compliant light and dark themes.
const statusTokens = {
  coordinating: {
    light: '#ba5b3d',
    lightP3: 'color(display-p3 .6818 .3772 .2681)',
    dark: '#df7b5c',
    darkP3: 'color(display-p3 .8222 .5021 .3876)',
    ink: 'claude',
  },
  working: {
    light: '#2d8a56',
    lightP3: 'color(display-p3 .2864 .5337 .3551)',
    dark: '#4cc480',
    darkP3: 'color(display-p3 .4333 .7586 .5248)',
    ink: 'success',
  },
  waiting: {
    light: '#966919',
    lightP3: 'color(display-p3 .562 .4192 .1691)',
    dark: '#e0ae4f',
    darkP3: 'color(display-p3 .8479 .6901 .3727)',
    ink: 'warning',
  },
  paused: {
    light: '#966919',
    lightP3: 'color(display-p3 .562 .4192 .1691)',
    dark: '#e0ae4f',
    darkP3: 'color(display-p3 .8479 .6901 .3727)',
    ink: 'warning',
  },
  failed: {
    light: '#c54451',
    lightP3: 'color(display-p3 .7149 .3024 .3294)',
    dark: '#eb6f7a',
    darkP3: 'color(display-p3 .8606 .4629 .4877)',
    ink: 'error',
  },
  stopped: {
    light: '#b85334',
    lightP3: 'color(display-p3 .6724 .3484 .2367)',
    dark: '#ea8662',
    darkP3: 'color(display-p3 .8646 .5447 .4135)',
    ink: 'error',
  },
  unreachable: {
    light: '#9a5b7a',
    lightP3: 'color(display-p3 .5698 .3685 .4734)',
    dark: '#d68fb2',
    darkP3: 'color(display-p3 .7989 .5729 .692)',
    ink: 'error',
  },
  inactive: {
    light: '#74716c',
    lightP3: 'color(display-p3 .4529 .4435 .4255)',
    dark: '#9e9a93',
    darkP3: 'color(display-p3 .6169 .6044 .5792)',
    ink: 'subtle',
  },
} as const

export type StatusToken = keyof typeof statusTokens

export function statusKey(status: string): StatusToken {
  if (
    status === 'working' ||
    status === 'waiting' ||
    status === 'coordinating' ||
    status === 'paused' ||
    status === 'failed' ||
    status === 'stopped' ||
    status === 'unreachable'
  ) {
    return status
  }
  return 'inactive'
}

export function statusInk(status: string) {
  return statusTokens[statusKey(status)].ink
}

function themeVars(entries: readonly (readonly [string, PaletteToken])[]): string {
  const light = entries.map(([name, t]) => `--${name}:${t.light}`).join(';')
  const dark = entries.map(([name, t]) => `--${name}:${t.dark}`).join(';')
  const lightP3 = entries.map(([name, t]) => `--${name}:${t.lightP3}`).join(';')
  const darkP3 = entries.map(([name, t]) => `--${name}:${t.darkP3}`).join(';')
  return (
    `svg{${light}}` +
    `@media(prefers-color-scheme:dark){svg{${dark}}}` +
    `@supports(color:color(display-p3 1 0 0)){svg{${lightP3}}@media(prefers-color-scheme:dark){svg{${darkP3}}}}`
  )
}

export const statusCss = themeVars(
  (Object.entries(statusTokens) as [StatusToken, PaletteToken][]).map(([key, token]) => [`status-${key}`, token] as const),
)

/** Warm wax-hairline section divider SVG. */
export const hairlineDivider =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 1" preserveAspectRatio="none">' +
  `<style>${themeVars([['hairline', beehivePalette.waxHairline]])}rect{fill:var(--hairline)}</style>` +
  '<rect width="200" height="1"/></svg>'

// 12x12 hexagonal cell geometry centered at (6, 6).
const DOT_HEX_FILL = 'M6 2L9.5 4V8L6 10L2.5 8V4Z'
const DOT_HEX_OUTER = 'M6 1.5L9.9 3.75V8.25L6 10.5L2.1 8.25V3.75Z'

/** 12x12 hexagonal cell status dot with distinct per-status glyphs and opt-in motion. */
export function statusDot(status: string, elapsed = 0, seed = ''): string {
  const key = statusKey(status)
  const color = `var(--status-${key})`
  const phaseOf = (duration: number) => (seed ? seededPhase(seed, 'status-dot', duration) : 0)
  const delayOf = (duration: number) => loopDelay(elapsed, duration, phaseOf(duration))

  let extraCss = ''
  let animCss = ''
  let glyph = ''

  if (status === 'working') {
    extraCss = '.pulse{opacity:0}'
    animCss =
      `.pulse{transform-box:fill-box;transform-origin:center;animation:sw-pulse 2.8s ${easeOut} ${delayOf(2800)} infinite}` +
      '@keyframes sw-pulse{0%{transform:scale(1);opacity:0}16%{opacity:.4}82%,100%{transform:scale(1.45);opacity:0}}'
    glyph =
      `<path class="pulse" d="${DOT_HEX_FILL}" fill="none" stroke="${color}" stroke-width="1.15" stroke-linejoin="round"/>` +
      `<path d="${DOT_HEX_FILL}" fill="${color}"/>` +
      '<circle cx="5.2" cy="4.9" r=".7" fill="#fff" opacity=".36"/>'
  } else if (status === 'coordinating') {
    extraCss = '.aura{opacity:0}'
    animCss =
      `.aura{transform-box:fill-box;transform-origin:center;animation:sw-aura 3.4s ${easeInOut} ${delayOf(3400)} infinite}` +
      '@keyframes sw-aura{0%{transform:scale(.94);opacity:0}20%{opacity:.46}82%,100%{transform:scale(1.16);opacity:0}}'
    glyph =
      `<path class="aura" d="${DOT_HEX_OUTER}" fill="none" stroke="${color}" stroke-width="1.15" stroke-linejoin="round"/>` +
      `<path d="M6 2L10 6L6 10L2 6Z" fill="${color}"/>`
  } else if (status === 'waiting') {
    animCss =
      `.breathe{transform-box:fill-box;transform-origin:center;animation:sw-wait 3.6s ${easeInOut} ${delayOf(3600)} infinite}` +
      '@keyframes sw-wait{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(.78);opacity:.55}}'
    glyph =
      `<path d="${DOT_HEX_OUTER}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>` +
      `<circle class="breathe" cx="6" cy="6" r="1.5" fill="${color}"/>`
  } else if (status === 'paused') {
    animCss =
      `.pause-bar{animation:sw-pause 4.2s ${easeInOut} ${delayOf(4200)} infinite}` +
      '@keyframes sw-pause{0%,100%{opacity:1}50%{opacity:.55}}'
    glyph =
      `<path d="${DOT_HEX_OUTER}" fill="none" stroke="${color}" stroke-width="1.4" stroke-linejoin="round"/>` +
      `<rect class="pause-bar" x="4.5" y="4" width="1" height="4" rx=".4" fill="${color}"/>` +
      `<rect class="pause-bar" x="6.5" y="4" width="1" height="4" rx=".4" fill="${color}"/>`
  } else if (status === 'not started') {
    animCss =
      `.queued{animation:sw-queue 4.4s ${easeInOut} ${delayOf(4400)} infinite}` +
      '@keyframes sw-queue{0%,100%{opacity:.85}50%{opacity:.5}}'
    glyph = `<path class="queued" d="${DOT_HEX_OUTER}" fill="none" stroke="${color}" stroke-width="1.5" stroke-dasharray="2.5 2" stroke-dashoffset="-1" stroke-linecap="round"/>`
  } else if (status === 'closed') {
    extraCss = themeVars([['cap', beehivePalette.honeyCore]])
    animCss =
      `.cap{animation:sw-cap 5.4s ${easeInOut} ${delayOf(5400)} infinite}` +
      '@keyframes sw-cap{0%,100%{fill-opacity:.14}50%{fill-opacity:.22}}'
    glyph =
      `<path class="cap" d="${DOT_HEX_OUTER}" fill="var(--cap)" fill-opacity=".14" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>` +
      `<circle cx="6" cy="6" r="1.2" fill="${color}"/>`
  } else if (status === 'killed') {
    animCss =
      `.retired{animation:sw-retire 4.8s ${easeInOut} ${delayOf(4800)} infinite}` +
      '@keyframes sw-retire{0%,100%{opacity:1}50%{opacity:.68}}'
    glyph =
      `<path class="retired" d="${DOT_HEX_OUTER}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>` +
      `<path d="M3.5 8.5L8.5 3.5" fill="none" stroke="${color}" stroke-width="1.45" stroke-linecap="round"/>`
  } else if (status === 'stopped') {
    animCss =
      `.halt{animation:sw-halt 3.2s ${easeInOut} ${delayOf(3200)} infinite}` +
      '@keyframes sw-halt{0%,100%{opacity:1}50%{opacity:.52}}'
    glyph =
      `<path d="${DOT_HEX_OUTER}" fill="none" stroke="${color}" stroke-width="1.4" stroke-linejoin="round"/>` +
      `<rect class="halt" x="4.5" y="4.5" width="3" height="3" rx=".5" fill="${color}"/>`
  } else if (status === 'failed') {
    animCss =
      `.alert{animation:sw-alert 3.2s ${easeInOut} ${delayOf(3200)} infinite}` +
      '@keyframes sw-alert{0%,100%{opacity:.08}50%{opacity:.18}}'
    glyph =
      `<path class="alert" d="${DOT_HEX_OUTER}" fill="${color}" opacity=".14"/>` +
      `<path d="M3.5 3.5L8.5 8.5M8.5 3.5L3.5 8.5" fill="none" stroke="${color}" stroke-width="1.75" stroke-linecap="round"/>`
  } else if (status === 'unreachable') {
    animCss =
      `.sig{animation:sw-sig 2.8s ${easeInOut} ${delayOf(2800)} infinite}` +
      '@keyframes sw-sig{0%,100%{opacity:1}50%{opacity:.3}}'
    glyph =
      `<path d="${DOT_HEX_OUTER}" fill="none" stroke="${color}" stroke-width="1.4" stroke-dasharray="2.5 2" stroke-dashoffset="-1" stroke-linecap="round"/>` +
      `<path class="sig" d="M4.2 5.2A2.3 2.3 0 0 1 7.8 5.2" fill="none" stroke="${color}" stroke-width="1.2" stroke-linecap="round"/>` +
      `<circle cx="6" cy="7.2" r="1.05" fill="${color}"/>`
  } else {
    glyph = `<path d="${DOT_HEX_OUTER}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>`
  }

  const motion = animCss ? `@media(prefers-reduced-motion:no-preference){${animCss}}` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12"><style>${statusCss}${extraCss}${motion}</style>${glyph}</svg>`
}

/** 16x16 pointy-top glowing honey-emerald hex cell with staggered hex-pulse rings. */
export function liveIndicator(elapsed: number): string {
  const hex = 'M8 4L11.5 6V10L8 12L4.5 10V6Z'
  const vars = themeVars([['honey-spark', beehivePalette.honeySpark]])
  const style =
    `${statusCss}${vars}` +
    '.core{fill:var(--status-working)}' +
    '.breath{fill:none;stroke:var(--status-working);stroke-width:1.1;stroke-linejoin:round;opacity:0}' +
    '@media(prefers-reduced-motion:no-preference){' +
    `.breath{transform-box:fill-box;transform-origin:center;animation:breath 4s ${easeOut} ${loopDelay(elapsed, 4000)} infinite}` +
    `.breath2{animation-delay:${loopDelay(elapsed, 4000, 2000)}}` +
    '@keyframes breath{0%{transform:scale(.95);opacity:0}16%{opacity:.48}70%,100%{transform:scale(1.75);opacity:0}}}'
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><style>${style}</style>` +
    `<path class="breath" d="${hex}"/>` +
    `<path class="breath breath2" d="${hex}"/>` +
    `<path class="core" d="${hex}"/>` +
    '<circle cx="7.2" cy="6.8" r=".85" fill="var(--honey-spark)" opacity=".75"/>' +
    '</svg>'
  )
}

export type EmblemState = 'working' | 'coordinating' | 'paused' | 'attention' | 'idle' | 'closed'

/** Compact geometric 3-cell honeycomb emblem for chat buttons, banners, and the minimized widget. */
export function swarmEmblem(state: EmblemState, elapsed = 0): string {
  const tone: StatusToken =
    state === 'working' ? 'working'
      : state === 'coordinating' ? 'coordinating'
        : state === 'paused' ? 'paused'
          : state === 'attention' ? 'waiting'
            : 'inactive'
  const active = state === 'working' || state === 'coordinating' || state === 'attention'

  // Three crisp interlocking pointy-top hexagons optically centered at (10, 10) in a 20x20 viewBox.
  const hexTop = 'M10 4.2L12.8 5.8V9L10 10.6L7.2 9V5.8Z'
  const hexLeft = 'M7 9.4L9.8 11V14.2L7 15.8L4.2 14.2V11Z'
  const hexRight = 'M13 9.4L15.8 11V14.2L13 15.8L10.2 14.2V11Z'
  const hexPulse = 'M10 1.1L17.7 5.55V14.45L10 18.9L2.3 14.45V5.55Z'

  const style =
    `${statusCss}` +
    `${themeVars([['cell-warm', beehivePalette.honeyCore]])}` +
    `svg{--cell-stroke:var(--status-${tone});--hi-op:.22;--hi-low:.14}` +
    '@media(prefers-color-scheme:dark){svg{--hi-op:.2;--hi-low:.12}}' +
    '.c{fill:var(--cell-stroke);fill-opacity:.13;stroke:var(--cell-stroke);stroke-width:1.3;stroke-linejoin:round}' +
    '.c-hi{fill:var(--cell-warm);fill-opacity:var(--hi-op);stroke:var(--cell-stroke);stroke-width:1.3;stroke-linejoin:round}' +
    `.dot{fill:var(--status-${tone})}` +
    (active
      ? `.ring{fill:none;stroke:var(--status-${tone});stroke-width:1;stroke-linejoin:round;opacity:0}` +
        '@media(prefers-reduced-motion:no-preference){' +
        `.ring{transform-box:fill-box;transform-origin:center;animation:emb-ring 3.4s ${easeOut} ${loopDelay(elapsed, 3400)} infinite}` +
        `.c-hi{animation:emb-glow 3.4s ${easeInOut} ${loopDelay(elapsed, 3400)} infinite}` +
        '@keyframes emb-ring{0%{transform:scale(1);opacity:0}18%{opacity:.46}82%,100%{transform:scale(1.06);opacity:0}}' +
        '@keyframes emb-glow{0%,100%{fill-opacity:var(--hi-low)}50%{fill-opacity:var(--hi-op)}}}'
      : '')

  const badge =
    state === 'attention'
      ? `<path class="ring" d="${hexPulse}"/><rect class="dot" x="9.45" y="5.4" width="1.1" height="2.05" rx=".5"/><circle class="dot" cx="10" cy="8.65" r=".6"/>`
      : active
        ? `<path class="ring" d="${hexPulse}"/><circle class="dot" cx="10" cy="7.4" r="1.25"/>`
        : state === 'paused'
          ? '<rect x="8.3" y="6" width="1.1" height="2.8" rx=".4" class="dot"/><rect x="10.6" y="6" width="1.1" height="2.8" rx=".4" class="dot"/>'
          : state === 'closed'
            ? '<path d="M10 6.05L11.15 6.72V8.08L10 8.75L8.85 8.08V6.72Z" fill="none" stroke="var(--cell-stroke)" stroke-width=".95" stroke-linejoin="round"/>'
            : ''

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><style>${style}</style>` +
    `<path class="c" d="${hexLeft}"/><path class="c" d="${hexRight}"/><path class="c-hi" d="${hexTop}"/>${badge}</svg>`
  )
}

export type BarTone = 'accent' | 'success' | 'warning' | 'error'

export const progressUnits = (ratio: number): number =>
  Number.isFinite(ratio) ? Math.round(2000 * Math.max(0, Math.min(1, ratio))) / 10 : 0

const MAX_NOTCHES = 200
const MAX_BAR_WIDTH = 100_000
/** Rounded beeswax progress bar with explicit outer viewBox, comb notches, 3:1+ track border, and opt-in shimmer. */
export function progressBar(
  ratio: number,
  tone: BarTone = 'accent',
  animate = false,
  elapsed = 0,
  width = 200,
): string {
  // Bounded, so `clamped * w * 10` stays finite and the drawing a size a surface can hold.
  const w = Number.isFinite(width) && width > 0 ? Math.min(MAX_BAR_WIDTH, Math.max(24, Math.round(width))) : 200
  const clamped = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0
  const fillW = Math.round(clamped * w * 10) / 10
  const glowing = animate && fillW > 12
  const shineW = Math.round(Math.max(18, Math.min(54, fillW * 0.45)))

  const fillToken: Record<BarTone, PaletteToken> = {
    accent: beehivePalette.honeyDeep,
    success: statusTokens.working,
    warning: statusTokens.waiting,
    error: statusTokens.failed,
  }

  const style =
    themeVars([
      ['track', beehivePalette.waxTrack],
      ['track-border', beehivePalette.waxBorder],
      ['fill', fillToken[tone]],
    ]) +
    (glowing
      ? '.shimmer{opacity:0}' +
        '@media(prefers-reduced-motion:no-preference){' +
        `.shimmer{animation:sw-shim 3.1s linear ${loopDelay(elapsed, 3100)} infinite}` +
        `@keyframes sw-shim{0%{transform:translateX(-${shineW}px);opacity:0}16%{opacity:.6}52%{opacity:.45}68%,100%{transform:translateX(${fillW}px);opacity:0}}}`
      : '')

  const defs =
    `<defs><clipPath id="bt"><rect x="0" y="0" width="${w}" height="6" rx="3"/></clipPath>` +
    (fillW > 0
      ? `<clipPath id="bf"><rect x="0" y="0" width="${fillW}" height="6" rx="3"/></clipPath>`
      : '') +
    (glowing
      ? '<linearGradient id="sg" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#fff" stop-opacity="0"/><stop offset="50%" stop-color="#fff" stop-opacity=".55"/><stop offset="100%" stop-color="#fff" stop-opacity="0"/></linearGradient>'
      : '') +
    '</defs>'

  let notches = ''
  if (fillW >= 8) {
    const segs: string[] = []
    // Every 10 units, spread wider past MAX_NOTCHES: an exported helper may be handed any width.
    const step = Math.max(10, Math.ceil(fillW / MAX_NOTCHES))
    for (let x = 8; x < fillW; x += step) segs.push(`M${x} 0L${x - 3} 6`)
    if (segs.length > 0) {
      notches = `<path d="${segs.join('')}" fill="none" stroke="#fff" stroke-width="1" opacity=".14"/>`
    }
  }

  const shimmer = glowing
    ? `<rect class="shimmer" x="0" y="0" width="${shineW}" height="6" fill="url(#sg)"/>`
    : ''

  const fillGroup =
    fillW > 0
      ? `<rect x="0" y="0" width="${fillW}" height="6" rx="3" fill="var(--fill)"/>` +
        (notches || shimmer ? `<g clip-path="url(#bf)">${notches}${shimmer}</g>` : '')
      : ''

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} 6" width="${w}" height="6"><style>${style}</style>${defs}` +
    `<g clip-path="url(#bt)"><rect x="0" y="0" width="${w}" height="6" rx="3" fill="var(--track)"/>${fillGroup}</g>` +
    `<rect x=".5" y=".5" width="${w - 1}" height="5" rx="2.5" fill="none" stroke="var(--track-border)" stroke-width="1"/></svg>`
  )
}

export type SemanticIconKind = 'pass' | 'ready' | 'warn' | 'error' | 'info' | 'paused'

const ICON_HEX = 'M6 1L10.3 3.5V8.5L6 11L1.7 8.5V3.5Z'

/** Crisp 12x12 semantic icon with soft hexagonal beehive backing for post verdicts and attention cards. */
export function semanticIcon(kind: SemanticIconKind): string {
  const tokenMap: Record<SemanticIconKind, PaletteToken> = {
    pass: statusTokens.working,
    ready: statusTokens.working,
    warn: statusTokens.waiting,
    error: statusTokens.failed,
    info: beehivePalette.wingInfo,
    // The emblem draws a paused run in the waiting tone; its icon and its attention card follow.
    paused: statusTokens.paused,
  }
  const style = themeVars([['ic', tokenMap[kind]]])
  const backing = `<path d="${ICON_HEX}" fill="var(--ic)" fill-opacity=".14"/>`
  const glyph =
    kind === 'pass'
      ? `${backing}<path d="M3.5 6.2L5.2 7.9L8.6 4.3" fill="none" stroke="var(--ic)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`
      : kind === 'ready'
        ? `${backing}<path d="M3.8 6H8.1M6.3 4.1L8.2 6L6.3 7.9" fill="none" stroke="var(--ic)" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round"/>`
        : kind === 'warn'
          ? '<path d="M6 1.7L10.5 9.6H1.5Z" fill="var(--ic)" fill-opacity=".14" stroke="var(--ic)" stroke-width="1.2" stroke-linejoin="round"/><line x1="6" y1="4.4" x2="6" y2="6.1" stroke="var(--ic)" stroke-width="1.25" stroke-linecap="round"/><circle cx="6" cy="7.9" r=".6" fill="var(--ic)"/>'
          : kind === 'error'
            ? `${backing}<path d="M4 4L8 8M8 4L4 8" fill="none" stroke="var(--ic)" stroke-width="1.6" stroke-linecap="round"/>`
            : kind === 'paused'
              ? `${backing}<rect x="4.1" y="3.7" width="1.3" height="4.6" rx=".45" fill="var(--ic)"/><rect x="6.6" y="3.7" width="1.3" height="4.6" rx=".45" fill="var(--ic)"/>`
              : `${backing}<circle cx="6" cy="3.8" r=".75" fill="var(--ic)"/><line x1="6" y1="5.6" x2="6" y2="8.5" stroke="var(--ic)" stroke-width="1.45" stroke-linecap="round"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12"><style>${style}</style>${glyph}</svg>`
}
