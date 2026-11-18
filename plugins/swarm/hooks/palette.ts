// Desktop status colors use the reference image's Display P3 space.
const colors = {
  coordinating: ['#ba5b3d', 'color(display-p3 .682353 .376471 .266667)', 'claude'],
  working: ['#349962', 'color(display-p3 .21 .61 .38)', 'success'],
  waiting: ['#b88732', 'color(display-p3 .72 .53 .18)', 'warning'],
  failed: ['#ca4c58', 'color(display-p3 .81 .30 .35)', 'error'],
  inactive: ['#85878c', 'color(display-p3 .52 .53 .55)', 'subtle'],
} as const
export function statusKey(status: string): keyof typeof colors {
  if (status === 'unreachable') return 'failed'
  if (status === 'working' || status === 'waiting' || status === 'coordinating' || status === 'failed') return status
  return 'inactive'
}
export function statusInk(status: string) {
  return colors[statusKey(status)][2]
}
const variables = (index: 0 | 1) => Object.entries(colors).map(([key, value]) => `--status-${key}:${value[index]}`).join(';')
export const statusCss = `svg{${variables(0)}}@supports(color:color(display-p3 1 0 0)){svg{${variables(1)}}}`

export function statusDot(status: string): string {
  const key = statusKey(status)
  const color = `var(--status-${key})`
  const dot = key === 'inactive' ? `<circle cx="6" cy="6" r="4" fill="none" stroke="${color}"/>`
    : `<circle cx="6" cy="6" r="4.5" fill="${color}"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12"><style>${statusCss}</style>${dot}</svg>`
}
