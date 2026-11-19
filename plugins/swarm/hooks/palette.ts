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
  if (status === 'unreachable') return 'failed'
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

export function statusDot(status: string): string {
  const key = statusKey(status)
  const color = `var(--status-${key})`
  const dot = key === 'working' ? `<circle cx="6" cy="6" r="4.5" fill="${color}"/>`
    : key === 'waiting' ? `<circle cx="6" cy="6" r="3.75" fill="none" stroke="${color}" stroke-width="1.5"/><circle cx="6" cy="6" r="1.6" fill="${color}"/>`
    : key === 'coordinating' ? `<path d="M6 1.2L10.8 6 6 10.8 1.2 6z" fill="${color}"/>`
    : key === 'failed' ? `<path d="M2.8 2.8L9.2 9.2M9.2 2.8L2.8 9.2" fill="none" stroke="${color}" stroke-width="1.9" stroke-linecap="round"/>`
    : `<circle cx="6" cy="6" r="3.75" fill="none" stroke="${color}" stroke-width="1.5"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12"><style>${statusCss}</style>${dot}</svg>`
}
