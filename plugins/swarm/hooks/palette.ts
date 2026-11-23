import { easeInOut, easeOut, loopDelay } from './motion'

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

// Desktop status colors use exact D65 Display P3 coordinates with WCAG-compliant light and dark themes.
const colors = {
  coordinating: ['#ba5b3d', 'color(display-p3 .682353 .376471 .266667)', 'claude'],
  working: ['#349962', 'color(display-p3 .3224 .5918 .4028)', 'success'],
  waiting: ['#9e701e', 'color(display-p3 .5926 .4467 .1877)', 'warning'],
  failed: ['#ca4c58', 'color(display-p3 .7344 .3309 .3561)', 'error'],
  inactive: ['#85878c', 'color(display-p3 .52 .53 .55)', 'subtle'],
} as const
const darkColors: Record<keyof typeof colors, readonly [string, string]> = {
  coordinating: ['#df7b5c', 'color(display-p3 .8222 .5021 .3877)'],
  working: ['#4cc480', 'color(display-p3 .4333 .7586 .5248)'],
  waiting: ['#e0ae4f', 'color(display-p3 .8479 .6901 .3728)'],
  failed: ['#eb6f7a', 'color(display-p3 .8605 .4629 .4878)'],
  inactive: ['#9ea2a9', 'color(display-p3 .6224 .6348 .6601)'],
}
export function statusKey(status: string): keyof typeof colors {
  if (status === 'unreachable' || status === 'stopped') return 'failed'
  if (status === 'working' || status === 'waiting' || status === 'coordinating' || status === 'failed') return status
  return 'inactive'
}
export function statusInk(status: string) {
  return colors[statusKey(status)][2]
}
const variables = (map: Record<string, readonly string[]>, index: 0 | 1) =>
  Object.entries(map).map(([key, value]) => `--status-${key}:${value[index]}`).join(';')
export const statusCss =
  `svg{${variables(colors, 0)}}` +
  `@media(prefers-color-scheme:dark){svg{${variables(darkColors, 0)}}}` +
  `@supports(color:color(display-p3 1 0 0)){svg{${variables(colors, 1)}}` +
  `@media(prefers-color-scheme:dark){svg{${variables(darkColors, 1)}}}}`

export function statusDot(status: string, elapsed = 0): string {
  const key = statusKey(status)
  const color = `var(--status-${key})`
  const anim = key === 'working'
    ? `.pulse{transform-box:fill-box;transform-origin:center;animation:sw-pulse 2.8s ${easeOut} ${loopDelay(elapsed, 2800)} infinite}` +
      '@keyframes sw-pulse{0%{transform:scale(.9);opacity:0}14%{opacity:.36}82%,100%{transform:scale(1.8);opacity:0}}'
    : key === 'coordinating'
      ? `.aura{transform-box:fill-box;transform-origin:center;animation:sw-aura 3.4s ${easeInOut} ${loopDelay(elapsed, 3400)} infinite}` +
        '@keyframes sw-aura{0%,100%{transform:scale(1);opacity:.24}50%{transform:scale(1.2);opacity:.08}}'
      : key === 'waiting'
        ? `.breathe{transform-box:fill-box;transform-origin:center;animation:sw-wait 3.6s ${easeInOut} ${loopDelay(elapsed, 3600)} infinite}` +
          '@keyframes sw-wait{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(.8);opacity:.55}}'
        : key === 'failed'
          ? `.alert{animation:sw-alert 3.2s ${easeInOut} ${loopDelay(elapsed, 3200)} infinite}` +
            '@keyframes sw-alert{0%,100%{opacity:.12}50%{opacity:.27}}'
          : ''
  const reduced = anim ? '@media(prefers-reduced-motion:reduce){.pulse,.aura,.breathe,.alert{animation:none;opacity:0}.breathe{opacity:1}}' : ''
  const dot = key === 'working'
    ? `<circle class="pulse" cx="6" cy="6" r="3.1" fill="${color}"/><circle cx="6" cy="6" r="3.1" fill="${color}"/><circle cx="5.2" cy="5.1" r=".75" fill="#fff" opacity=".32"/>`
    : key === 'waiting'
      ? `<circle cx="6" cy="6" r="3.75" fill="none" stroke="${color}" stroke-width="1.5"/><circle class="breathe" cx="6" cy="6" r="1.6" fill="${color}"/>`
      : key === 'coordinating'
        ? `<path class="aura" d="M6 1.2L10.8 6 6 10.8 1.2 6z" fill="${color}"/><path d="M6 1.2L10.8 6 6 10.8 1.2 6z" fill="${color}"/>`
        : key === 'failed'
          ? `<circle class="alert" cx="6" cy="6" r="5.2" fill="${color}"/><path d="M2.8 2.8L9.2 9.2M9.2 2.8L2.8 9.2" fill="none" stroke="${color}" stroke-width="1.9" stroke-linecap="round"/>`
          : `<circle cx="6" cy="6" r="3.75" fill="none" stroke="${color}" stroke-width="1.5"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12"><style>${statusCss}${anim}${reduced}</style>${dot}</svg>`
}

export function liveIndicator(elapsed: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">
    <style>${statusCss}
      .core{fill:var(--status-working)}
      .breath{fill:none;stroke:var(--status-working);stroke-width:1.1;transform-box:fill-box;transform-origin:center;animation:breath 4s ${easeOut} ${loopDelay(elapsed, 4000)} infinite}
      .breath2{animation-delay:${loopDelay(elapsed, 4000, 2000)}}
      @keyframes breath{0%{transform:scale(.9);opacity:0}14%{opacity:.45}66%,100%{transform:scale(1.95);opacity:0}}
      @media(prefers-reduced-motion:reduce){.breath{display:none}}
    </style>
    <circle class="breath" cx="8" cy="8" r="3.4"/>
    <circle class="breath breath2" cx="8" cy="8" r="3.4"/>
    <circle class="core" cx="8" cy="8" r="3.4"/>
    <circle cx="7.1" cy="7.1" r=".85" fill="#fff" opacity=".34"/>
  </svg>`
}

export type EmblemState = 'working' | 'coordinating' | 'paused' | 'attention' | 'idle' | 'closed'

/** Compact geometric honeycomb emblem for chat buttons, banners, and the minimized widget. */
export function swarmEmblem(state: EmblemState, elapsed = 0): string {
  const tone = state === 'working' ? 'working'
    : state === 'coordinating' ? 'coordinating'
      : state === 'paused' || state === 'attention' ? 'waiting'
        : 'inactive'
  const active = state === 'working' || state === 'coordinating' || state === 'attention'
  // Three crisp interlocking hexagons centered optically in a 20x20 viewBox.
  const hexTop = 'M10 3.2L12.8 4.8V8L10 9.6L7.2 8V4.8Z'
  const hexLeft = 'M7 8.4L9.8 10V13.2L7 14.8L4.2 13.2V10Z'
  const hexRight = 'M13 8.4L15.8 10V13.2L13 14.8L10.2 13.2V10Z'
  const style = `${statusCss}` +
    `svg{--cell-warm:#e9ac55;--cell-stroke:var(--status-${tone})}` +
    `@media(prefers-color-scheme:dark){svg{--cell-warm:#f2bd6a}}` +
    `@supports(color:color(display-p3 1 0 0)){svg{--cell-warm:color(display-p3 .8774 .6843 .3908)}@media(prefers-color-scheme:dark){svg{--cell-warm:color(display-p3 .94 .75 .44)}}}` +
    `.c{fill:var(--cell-stroke);fill-opacity:.13;stroke:var(--cell-stroke);stroke-width:1.25;stroke-linejoin:round}` +
    `.c-hi{fill:var(--cell-warm);fill-opacity:${state === 'closed' ? '.18' : '.42'};stroke:var(--cell-stroke);stroke-width:1.3;stroke-linejoin:round}` +
    `.dot{fill:var(--status-${tone})}` +
    (active
      ? `.ring{fill:none;stroke:var(--status-${tone});stroke-width:1.15;transform-box:fill-box;transform-origin:center;animation:emb-ring 3.4s ${easeOut} ${loopDelay(elapsed, 3400)} infinite}` +
        `.c-hi{animation:emb-glow 3.4s ${easeInOut} ${loopDelay(elapsed, 3400)} infinite}` +
        '@keyframes emb-ring{0%{transform:scale(.92);opacity:0}16%{opacity:.46}80%,100%{transform:scale(1.26);opacity:0}}' +
        '@keyframes emb-glow{0%,100%{fill-opacity:.34}50%{fill-opacity:.58}}' +
        `@media(prefers-reduced-motion:reduce){.ring{display:none}.c-hi{animation:none}}`
      : '')
  const badge = state === 'attention'
    ? `<circle class="ring" cx="15.8" cy="4.4" r="2.5"/><circle class="dot" cx="15.8" cy="4.4" r="2.2"/>`
    : active
      ? `<circle class="ring" cx="10" cy="9.4" r="6.8"/><circle class="dot" cx="10" cy="6.4" r="1.25"/>`
      : state === 'paused'
        ? `<rect x="8.65" y="5.1" width="1.05" height="2.7" rx=".4" class="dot"/><rect x="10.3" y="5.1" width="1.05" height="2.7" rx=".4" class="dot"/>`
        : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><style>${style}</style>` +
    `<path class="c" d="${hexLeft}"/><path class="c" d="${hexRight}"/><path class="c-hi" d="${hexTop}"/>${badge}</svg>`
}

export type BarTone = 'accent' | 'success' | 'warning' | 'error'

export const progressUnits = (ratio: number) => Number.isFinite(ratio) ? Math.round(2000 * Math.max(0, Math.min(1, ratio))) / 10 : 0

/** Sleek rounded progress bar with optional shimmer for token budgets and replay scrubbers. */
export function progressBar(ratio: number, tone: BarTone = 'accent', animate = false, elapsed = 0): string {
  const fillW = progressUnits(ratio)
  const glowing = animate && fillW > 12
  const shineW = Math.round(Math.max(20, Math.min(54, fillW * .52)))
  const lightTone: Record<BarTone, readonly [string, string, ...string[]]> = {
    accent: ['#235fc4', 'color(display-p3 .2033 .3675 .7427)'],
    success: colors.working,
    warning: colors.waiting,
    error: colors.failed,
  }
  const darkTone: Record<BarTone, readonly [string, string]> = {
    accent: ['#8fb8ff', 'color(display-p3 .5935 .7170 .9777)'],
    success: darkColors.working,
    warning: darkColors.waiting,
    error: darkColors.failed,
  }
  const style =
    `svg{--track:#e5e7eb;--fill:${lightTone[tone][0]}}` +
    `@media(prefers-color-scheme:dark){svg{--track:#33363b;--fill:${darkTone[tone][0]}}}` +
    `@supports(color:color(display-p3 1 0 0)){svg{--fill:${lightTone[tone][1]}}@media(prefers-color-scheme:dark){svg{--fill:${darkTone[tone][1]}}}}` +
    (glowing
      ? `.shimmer{animation:sw-shim 3.1s linear ${loopDelay(elapsed, 3100)} infinite}` +
        `@keyframes sw-shim{0%{transform:translateX(-${shineW}px);opacity:0}16%{opacity:.65}52%{opacity:.5}68%,100%{transform:translateX(${fillW}px);opacity:0}}` +
        `@media(prefers-reduced-motion:reduce){.shimmer{display:none}}`
      : '')
  const defs = glowing
    ? `<defs><clipPath id="bf"><rect x="0" y="0" width="${fillW}" height="6" rx="3"/></clipPath>` +
      `<linearGradient id="sg" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#fff" stop-opacity="0"/><stop offset="50%" stop-color="#fff" stop-opacity=".55"/><stop offset="100%" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>`
    : ''
  const shimmer = glowing
    ? `<g clip-path="url(#bf)"><rect class="shimmer" x="0" y="0" width="${shineW}" height="6" fill="url(#sg)"/></g>`
    : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 6" preserveAspectRatio="none"><style>${style}</style>${defs}` +
    `<rect x="0" y="0" width="200" height="6" rx="3" fill="var(--track)"/>` +
    (fillW > 0 ? `<rect x="0" y="0" width="${fillW}" height="6" rx="3" fill="var(--fill)"/>` : '') +
    `${shimmer}</svg>`
}

/** Crisp 12x12 semantic icon for post verdicts and attention cards. */
export function semanticIcon(kind: 'pass' | 'ready' | 'warn' | 'error' | 'info' | 'paused'): string {
  const colorMap: Record<typeof kind, readonly [string, string, string, string]> = {
    pass: [colors.working[0], colors.working[1], darkColors.working[0], darkColors.working[1]],
    ready: [colors.coordinating[0], colors.coordinating[1], darkColors.coordinating[0], darkColors.coordinating[1]],
    warn: [colors.waiting[0], colors.waiting[1], darkColors.waiting[0], darkColors.waiting[1]],
    error: [colors.failed[0], colors.failed[1], darkColors.failed[0], darkColors.failed[1]],
    info: ['#235fc4', 'color(display-p3 .2033 .3675 .7427)', '#8fb8ff', 'color(display-p3 .5935 .7170 .9777)'],
    paused: ['#7b63c4', 'color(display-p3 .48 .39 .77)', '#b69eff', 'color(display-p3 .71 .62 1)'],
  }
  const [l, lp3, d, dp3] = colorMap[kind]
  const style = `svg{--ic:${l}}@media(prefers-color-scheme:dark){svg{--ic:${d}}}@supports(color:color(display-p3 1 0 0)){svg{--ic:${lp3}}@media(prefers-color-scheme:dark){svg{--ic:${dp3}}}}`
  const glyph = kind === 'pass'
    ? '<circle cx="6" cy="6" r="5" fill="var(--ic)" fill-opacity=".16"/><path d="M3.4 6.2L5.2 8L8.8 4.2" fill="none" stroke="var(--ic)" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"/>'
    : kind === 'ready'
      ? '<circle cx="6" cy="6" r="5" fill="var(--ic)" fill-opacity=".16"/><path d="M4.2 6H8M6.3 4.1L8.2 6L6.3 7.9" fill="none" stroke="var(--ic)" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round"/>'
      : kind === 'warn'
        ? '<path d="M6 1.5L10.8 9.8H1.2Z" fill="var(--ic)" fill-opacity=".16" stroke="var(--ic)" stroke-width="1.25" stroke-linejoin="round"/><line x1="6" y1="4.7" x2="6" y2="7.1" stroke="var(--ic)" stroke-width="1.35" stroke-linecap="round"/><circle cx="6" cy="8.5" r=".7" fill="var(--ic)"/>'
        : kind === 'error'
          ? '<circle cx="6" cy="6" r="5" fill="var(--ic)" fill-opacity=".16"/><path d="M4 4L8 8M8 4L4 8" fill="none" stroke="var(--ic)" stroke-width="1.6" stroke-linecap="round"/>'
          : kind === 'paused'
            ? '<circle cx="6" cy="6" r="5" fill="var(--ic)" fill-opacity=".16"/><rect x="4.1" y="3.7" width="1.35" height="4.6" rx=".45" fill="var(--ic)"/><rect x="6.55" y="3.7" width="1.35" height="4.6" rx=".45" fill="var(--ic)"/>'
            : '<circle cx="6" cy="6" r="5" fill="var(--ic)" fill-opacity=".16"/><circle cx="6" cy="3.9" r=".75" fill="var(--ic)"/><line x1="6" y1="5.7" x2="6" y2="8.5" stroke="var(--ic)" stroke-width="1.45" stroke-linecap="round"/>'
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12"><style>${style}</style>${glyph}</svg>`
}
