export const easeInOut = 'cubic-bezier(.4,0,.6,1)'
export const easeOut = 'cubic-bezier(.22,1,.36,1)'

export const elapsedMs = (elapsed: number) => Number.isFinite(elapsed) && elapsed > 0 ? Math.floor(elapsed) : 0

export const loopDelay = (elapsed: number, duration: number, phase = 0) =>
  `-${(elapsedMs(elapsed) + phase) % duration}ms`
