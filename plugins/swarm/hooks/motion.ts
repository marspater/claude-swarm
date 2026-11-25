export const easeInOut = 'cubic-bezier(.4,0,.6,1)'
export const easeOut = 'cubic-bezier(.22,1,.36,1)'

export const elapsedMs = (elapsed: number): number =>
  Number.isFinite(elapsed) && elapsed > 0 ? Math.floor(elapsed) : 0

export const loopDelay = (elapsed: number, duration: number, phase = 0): string => {
  if (!Number.isFinite(duration) || duration <= 0) return '0ms'
  const d = Math.floor(duration)
  if (d <= 0) return '0ms'
  const p = Number.isFinite(phase) ? Math.trunc(phase) : 0
  const offset = (((elapsedMs(elapsed) + p) % d) + d) % d
  return offset === 0 ? '0ms' : `-${offset}ms`
}

/** Deterministic FNV-1a 32-bit hash for per-worker motion variety. */
export function hashSeed(seed: string | number): number {
  const input = typeof seed === 'number' ? String(seed) : seed
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Deterministic variant index in [0, count - 1] derived from seed. */
export function pickVariant(seed: string | number, count: number): number {
  if (!Number.isFinite(count)) return 0
  const n = Math.floor(count)
  if (n <= 1) return 0
  return hashSeed(seed) % n
}

/** Deterministic phase offset in [0, duration - 1] ms derived from seed and salt. */
export function seededPhase(seed: string | number, salt: string | number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0
  const d = Math.floor(duration)
  if (d <= 0) return 0
  return hashSeed(`${seed}:${salt}`) % d
}
