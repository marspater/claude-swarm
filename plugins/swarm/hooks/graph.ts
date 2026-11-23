import { statusCss, statusKey } from './palette'
import { easeOut, elapsedMs, loopDelay } from './motion'
import { head as clipHead, unquoted as stripCode } from './text'
import type { Post, Swarm } from '../types'

const BROADCAST = /(?<![\w.@/])@all[-_]*(?![\w-])/i
// `text` is stripped of code already.
const named = (text: string, name: string) =>
  new RegExp(`(?<![\\w.@/])@${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[-_]*(?![\\w-])`, 'i').test(text)

/** True when the post addresses `@all`: the members it does not also name are reached through that alone. */
export const isBroadcast = (post: Post) => BROADCAST.test(stripCode(post.text))
/** The recipients a post reached through `@all` alone, its text stripped of code once for all of them. */
function viaAllOf(post: Post): ReadonlySet<string> {
  const text = stripCode(post.text)
  return BROADCAST.test(text) ? new Set(post.to.filter(to => !named(text, to))) : new Set()
}

/**
 * How often each member addressed each other, keyed `from>to`. A recipient reached only through `@all` is
 * counted under `from>to>all` instead. `from>@all` counts the sender's `@all` posts and `from>@none` its
 * posts that mention nobody: neither names a member.
 */
export function edgesOf(posts: Post[]): Record<string, number> {
  const counts: Record<string, number> = {}
  const add = (key: string) => { counts[key] = (counts[key] ?? 0) + 1 }
  for (const post of posts) {
    // An @all that reached nobody (a team of one, or all retired) is still an @all post, not one with no mention.
    const viaAll = viaAllOf(post)
    if (isBroadcast(post)) add(`${post.agent}>@all`)
    else if (post.to.length === 0) add(`${post.agent}>@none`)
    for (const to of post.to) add(viaAll.has(to) ? `${post.agent}>${to}>all` : `${post.agent}>${to}`)
  }
  return counts
}

/** The two members of an edge key, or nothing for a key that counts `@all` or mention-free posts. */
export function pairOf(edge: string): [string, string] | undefined {
  const [from = '', to = ''] = edge.split('>')
  return to.startsWith('@') ? undefined : [from, to]
}

const PILL_HEIGHT = 38
const LEGEND = 50
const ROUTE_LOOP_MS = 3600
const TRAVEL_MS = 840
const TAIL_DELAY_MS = 62
const TRAVEL_EASE = '.37 0 .3 1'
const FADE_EASE = '.4 0 .6 1'
const LINEAR = '0 0 1 1'
const keyTimes = (duration: number, ...marks: number[]) =>
  marks.map(mark => String(Math.round(mark / duration * 10_000) / 10_000)).join(';')
// The host refuses an Svg source longer than this, and the whole pane with it.
export const SVG_LIMIT = 131_072
// The name font is 14px in the drawing's own units; drawn smaller than this on screen, the graph gives way to a list.
export const MIN_LABEL_PX = 9

// Past this many members round the coordinator the ring gives way to two arcs, one name to a row.
const RING_LIMIT = 10
const SIDE_PITCH = PILL_HEIGHT + 12
const halfOf = (name: string) => Math.max(38, 22 + Math.min(15, name.length) * 4.7)
const CURVE_SAMPLES = Array.from({ length: 23 }, (_, index) => (index + 1) / 24)

/** Signed distance from (x, y) to a pill's rounded rectangle (corner radius 13). */
function pillDist(x: number, y: number, pill: { x: number; y: number; half: number }): number {
  const qx = Math.abs(x - pill.x) - (pill.half - 13)
  const qy = Math.abs(y - pill.y) - (PILL_HEIGHT / 2 - 13)
  // Math.hypot(q, 0) is |q| exactly, so the square root is taken only where both sides stick out.
  const out = qx > 0 ? (qy > 0 ? Math.hypot(qx, qy) : qx) : qy > 0 ? qy : 0
  return out + Math.min(Math.max(qx, qy), 0) - 13
}

/** Members shown in the graph for the current replay cursor and filter state. */
export function visibleMembers(
  swarm: Swarm,
  upTo = Infinity,
  hidden: ReadonlySet<string> = new Set(),
  live = true,
): Swarm['members'] {
  if (live) return swarm.members.filter(member => !hidden.has(member.name))
  // Members whose only posts are older than the ones kept still took part.
  const participants = new Set<string>(
    Object.keys(swarm.earlierEdges ?? {}).flatMap(edge => pairOf(edge) ?? [edge.split('>')[0] ?? '']),
  )
  for (const post of swarm.posts) {
    if (post.seq <= upTo) {
      participants.add(post.agent)
      for (const recipient of post.to) participants.add(recipient)
    }
  }
  return swarm.members.filter(member => !hidden.has(member.name) && participants.has(member.name))
}

/** Clusters outer members that communicate or depend on each other while preserving roster order otherwise. */
export function orderOuterMembers(
  outerMembers: Swarm['members'],
  direct: ReadonlyMap<string, number> = new Map(),
): Swarm['members'] {
  if (outerMembers.length <= 2) return outerMembers
  const outerNames = new Set(outerMembers.map(member => member.name))
  const weightBetween = (a: Swarm['members'][number], b: Swarm['members'][number]) =>
    (direct.get(`${a.name}>${b.name}`) ?? 0) +
    (direct.get(`${b.name}>${a.name}`) ?? 0) +
    ((a.depends?.includes(b.name) || b.depends?.includes(a.name)) ? 1 : 0)

  let hasPeerLink = false
  for (let i = 0; i < outerMembers.length && !hasPeerLink; i++) {
    const u = outerMembers[i]!
    if (u.depends?.some(dep => dep !== u.name && outerNames.has(dep))) {
      hasPeerLink = true
      break
    }
    for (let j = i + 1; j < outerMembers.length; j++) {
      const v = outerMembers[j]!
      if ((direct.get(`${u.name}>${v.name}`) ?? 0) > 0 || (direct.get(`${v.name}>${u.name}`) ?? 0) > 0) {
        hasPeerLink = true
        break
      }
    }
  }
  if (!hasPeerLink) return outerMembers

  const visited = new Set<number>([0])
  const ordered: Swarm['members'] = [outerMembers[0]!]
  let current = outerMembers[0]!
  while (ordered.length < outerMembers.length) {
    let bestIndex = -1
    let bestWeight = 0
    for (let i = 0; i < outerMembers.length; i++) {
      if (visited.has(i)) continue
      const candidate = outerMembers[i]!
      const weight = weightBetween(current, candidate)
      if (weight > bestWeight) {
        bestWeight = weight
        bestIndex = i
      }
    }
    if (bestIndex < 0) {
      for (let i = 0; i < outerMembers.length; i++) {
        if (!visited.has(i)) {
          bestIndex = i
          break
        }
      }
    }
    visited.add(bestIndex)
    current = outerMembers[bestIndex]!
    ordered.push(current)
  }
  return ordered
}

/** The drawing's own size: it widens with long names and many members, so its shape is not one fixed ratio. */
function stageOf(all: Swarm['members'], direct?: ReadonlyMap<string, number>) {
  const coordinator = all.find(member => member.role === 'coordinator')
  const outerMembers = orderOuterMembers(all.filter(member => member !== coordinator), direct)
  const outerCount = outerMembers.length
  const maxHalf = Math.max(38, ...outerMembers.map(member => halfOf(member.name)))
  if (outerCount > RING_LIMIT) {
    // A ring keeps a name's width between neighbours all the way round, so a large team makes it very wide and
    // the frame scales everything down to fit. Two facing arcs stack the names instead: the drawing grows taller,
    // not wider, and the names keep their size.
    const perSide = Math.ceil(outerCount / 2)
    const rx = Math.max(250, maxHalf + (coordinator ? halfOf(coordinator.name) : 0) + 70)
    const width = Math.max(560, Math.ceil((rx + maxHalf + 12) * 2))
    const height = Math.max(404, (perSide - 1) * SIDE_PITCH + 72)
    const place = (index: number) => {
      const isRight = index < perSide
      const count = isRight ? perSide : outerCount - perSide
      // Clockwise, as on the ring: down the right side, then up the left.
      const row = isRight ? index : count - 1 - (index - perSide)
      const offset = (row - (count - 1) / 2) * SIDE_PITCH
      const t = perSide > 1 ? offset / (((perSide - 1) / 2) * SIDE_PITCH) : 0
      const reach = rx * (0.76 + 0.24 * Math.sqrt(Math.max(0, 1 - t * t)))
      return { x: width / 2 + (isRight ? reach : -reach), y: height / 2 + offset }
    }
    return { coordinator, outerMembers, width, height, place }
  }
  const rx = Math.max(186, outerCount <= 2 ? 186 : (maxHalf + 10) / Math.sin(Math.PI / outerCount))
  const width = Math.max(560, Math.ceil((rx + maxHalf + 12) * 2))
  const minRy = outerCount <= 2 ? 129 : (PILL_HEIGHT / 2 + 8) / Math.sin(Math.PI / outerCount)
  const baseHeight = all.length > 6 ? 404 : 330
  const height = Math.max(baseHeight, Math.ceil((Math.max(baseHeight / 2 - 36, minRy) + 36) * 2))
  const ry = height / 2 - 36
  const place = (index: number) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * index) / Math.max(1, outerCount)
    return { x: width / 2 + rx * Math.cos(angle), y: height / 2 + ry * Math.sin(angle) }
  }
  return { coordinator, outerMembers, width, height, place }
}

// What one text column measures across the frame, as the pane draws it.
const COLUMN_WIDTH = 8.77

export function graphHeight(columns: number, members: Swarm['members']): number {
  // The desktop clamps the frame width to the actual slot. Columns estimate its height only, so a change in font
  // metrics cannot narrow the frame. The height follows the drawing's shape: a frame taller than the drawing
  // leaves the difference empty above the graph and below its legend.
  const { width, height } = stageOf(members)
  return Math.max(200, Math.min(members.length > 22 ? 780 : 620, Math.round(columns * COLUMN_WIDTH * (height + LEGEND) / width)))
}

/** The on-screen size of a member's name, in CSS pixels, in a pane `columns` wide: an estimate, at 8.77 px a column. */
export function labelPx(columns: number, members: Swarm['members']): number {
  const { width, height } = stageOf(members)
  return 14 * Math.min(columns * COLUMN_WIDTH / width, graphHeight(columns, members) / (height + LEGEND))
}

/** Each member's name as its pill shows it: a long one keeps its start and its end, and two never read the same. */
function labelsOf(names: string[]): Map<string, string> {
  const labels = new Map<string, string>()
  const taken = new Set(names.filter(name => name.length <= 15))
  for (const name of names) {
    if (name.length <= 15) {
      labels.set(name, name)
      continue
    }
    const cut = (start: number) => `${clipHead(name, start)}…${name.slice(start - 14)}`
    // Names alike at both ends get a number: of as many numbers as names, one is always free.
    const label = [7, 4, 10, 2, 12].map(cut).find(one => !taken.has(one)) ??
      names.map((_, index) => `${clipHead(name, 11)}…${index + 2}`).find(one => !taken.has(one))!
    taken.add(label)
    labels.set(name, label)
  }
  return labels
}

// The control point and the two ends of each routed edge, for the layout last drawn: one graph is shown at a time,
// so the routes of the previous layout are dropped when another is drawn.
type Route = readonly [number, number, number, number, number, number]
let routeCache: { layout: string; routes: Map<string, Route> } = { layout: '', routes: new Map() }

const esc = (text: string) =>
  text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
const n1 = (value: number) => value.toFixed(1)
// Line width grows with the count and stays readable for one mention and for fifty.
const weightOf = (count: number) => Math.min(4.6, 1.3 + 0.75 * Math.log2(Math.max(1, count)))

export function graphSvg(
  swarm: Swarm,
  upTo: number,
  hidden: ReadonlySet<string>,
  animate: boolean,
  live: boolean,
  repeat = false,
  elapsed = 0,
  expandAll = false,
): string {
  return drawGraph(swarm, upTo, hidden, animate, live, repeat, elapsed, expandAll, Infinity).svg ?? ''
}

/**
 * The graph as the pane draws it: the SVG within `limit` characters, the routes left out of it to stay there, and
 * the key in words. Every route of the post at `upTo` is kept; the quietest others go first, @all ones before
 * named ones. No `svg` when even that much does not fit.
 */
export function drawGraph(
  swarm: Swarm,
  upTo: number,
  hidden: ReadonlySet<string>,
  animate: boolean,
  live: boolean,
  repeat = false,
  elapsed = 0,
  expandAll = false,
  limit = SVG_LIMIT,
): { svg?: string; hidden: number; key: string } {
  const ms = elapsedMs(elapsed)
  const phase = repeat ? ms % ROUTE_LOOP_MS : ms
  const timing = (duration: number, start = 0) => `begin="${start - phase}ms" dur="${duration / 1000}s"`
  const repeatAttr = repeat ? ' repeatCount="indefinite"' : ''
  const current = swarm.posts.find(post => post.seq === upTo)
  const earlier = Object.entries(swarm.earlierEdges ?? {})
  const members = visibleMembers(swarm, upTo, hidden, live)
  const visible = new Set(members.map(member => member.name))

  // Posts older than the ones kept still count: the pane keeps their totals, not their text.
  const direct = new Map<string, number>()
  const broadcastTo = new Map<string, number>()
  const broadcasts = new Map<string, number>()
  const unaddressed = new Map<string, number>()
  const bump = (counts: Map<string, number>, key: string, by = 1) => counts.set(key, (counts.get(key) ?? 0) + by)
  for (const [edge, count] of earlier) {
    const [from = '', to = '', via] = edge.split('>')
    if (to === '@all') bump(broadcasts, from, count)
    else if (to === '@none') bump(unaddressed, from, count)
    else bump(via === 'all' ? broadcastTo : direct, `${from}>${to}`, count)
  }
  for (const post of swarm.posts) {
    if (post.seq > upTo) break
    const viaAll = viaAllOf(post)
    if (isBroadcast(post)) bump(broadcasts, post.agent)
    else if (post.to.length === 0) bump(unaddressed, post.agent)
    for (const to of post.to) bump(viaAll.has(to) ? broadcastTo : direct, `${post.agent}>${to}`)
  }

  const { coordinator, outerMembers, width, height, place } = stageOf(members, direct)
  const centerHalf = coordinator ? halfOf(coordinator.name) : 0
  const outerIndex = new Map(outerMembers.map((member, index) => [member.name, index]))
  const labels = labelsOf(members.map(member => member.name))
  const positions = new Map(members.map(member => {
    const label = labels.get(member.name)!
    const half = halfOf(member.name)
    const isCenter = member === coordinator || (coordinator === undefined && members.length === 1)
    const spot = isCenter ? { x: width / 2, y: height / 2 } : place(outerIndex.get(member.name)!)
    let x = spot.x
    const y = spot.y
    // A member level with the coordinator would sit against its side with no room for an arrow:
    // it moves outward toward the frame's edge, never inward.
    if (!isCenter && coordinator && Math.abs(y - height / 2) < PILL_HEIGHT + 18 && Math.abs(x - width / 2) - half - centerHalf < 64) {
      x = x < width / 2 ? Math.min(x, half + 10) : Math.max(x, width - half - 10)
    }
    return [member.name, { label, half, x, y }] as const
  }))
  const isCurrentBroadcast = current !== undefined && isBroadcast(current)
  // Solid for mentions by name. What reached a member through @all is a dashed line of its own, drawn only
  // when asked for; where the two members also named each other it runs beside the solid one.
  const currentViaAll = current ? viaAllOf(current) : new Set<string>()
  const isCurrentEdge = (edge: string, isDashed: boolean) => {
    const [from = '', to = ''] = edge.split('>')
    return current?.agent === from && current.to.includes(to) && currentViaAll.has(to) === isDashed
  }
  const candidates = [
    ...[...direct].map(([edge, total]) => ({ edge, total, isDashed: false })),
    ...(expandAll ? [...broadcastTo].map(([edge, total]) => ({ edge, total, isDashed: true })) : []),
  ].filter(({ edge }) => {
    const [from = '', to = ''] = edge.split('>')
    return from !== to && visible.has(from) && visible.has(to)
  })
  // The current post's routes first, then the busiest named ones, then the busiest via @all.
  const rank = ({ edge, total, isDashed }: (typeof candidates)[number]) =>
    isCurrentEdge(edge, isDashed) ? Infinity : isDashed ? total : total + 1e9
  const edges = candidates.map((one, index) => ({ ...one, index })).sort((a, b) => rank(b) - rank(a) || a.index - b.index)
  const drawn = new Set(edges.map(({ edge }) => edge))

  const active: string[] = []
  const badges: string[] = []
  const ripples: string[] = []
  const outerCount = outerMembers.length
  const pad = outerCount <= 6 ? 8 : 4.5
  // Everything a route depends on besides its own edge: the frame and where each member's pill stands.
  const layout = JSON.stringify([width, height, coordinator?.name ?? null, outerCount,
    members.map(member => { const p = positions.get(member.name)!; return [member.name, p.x, p.y, p.half] })])
  if (routeCache.layout !== layout) routeCache = { layout, routes: new Map() }
  const { routes } = routeCache
  // Routes one edge. A route of the current post is drawn into `active`; any other is returned, for the history.
  const routeOf = ({ edge, total, isDashed }: (typeof edges)[number]): string | undefined => {
    const isCurrent = isCurrentEdge(edge, isDashed)
    const [from = '', to = ''] = edge.split('>')
    if (from === to || !visible.has(from) || !visible.has(to)) return
    const a = positions.get(from)
    const b = positions.get(to)
    if (!a || !b) return
    const dx = b.x - a.x
    const dy = b.y - a.y
    if (dx === 0 && dy === 0) return  // two members on one spot have no direction to draw
    const length = Math.hypot(dx, dy)
    const ux = dx / length
    const uy = dy / length
    // Two members that address each other get a lens of two curves; a one-way line bends gently inward.
    const isMutual = drawn.has(`${to}>${from}`)
    const beside = isDashed && direct.has(edge) ? 20 : 0
    const bowMag = isMutual
      ? (outerCount > RING_LIMIT ? Math.max(14, Math.min(length * 0.14, 28)) : Math.max(16, Math.min(length * 0.16, 36)))
      : Math.min(length * 0.07, 14)
    const bowSign = !isMutual && outerCount > 4 && coordinator &&
      (from === coordinator.name || to === coordinator.name) &&
      uy * ((a.x + b.x) / 2 - width / 2) < 0
      ? -1
      : 1
    const baseBow = bowSign * (bowMag + beside)
    // Where a line from a pill's center towards (tx, ty) leaves the pill, a little clear of its border.
    const leave = (p: { x: number; y: number; half: number }, tx: number, ty: number, gap: number) => {
      const span = Math.hypot(tx - p.x, ty - p.y) || 1
      const vx = (tx - p.x) / span
      const vy = (ty - p.y) / span
      const reach = Math.min(p.half / Math.abs(vx || 1e-9), (PILL_HEIGHT / 2) / Math.abs(vy || 1e-9)) + gap
      return [p.x + vx * reach, p.y + vy * reach] as const
    }
    const clampStage = (px: number, py: number) =>
      [Math.max(8, Math.min(width - 8, px)), Math.max(8, Math.min(height - 8, py))] as const
    // Apply border-to-border chord midpoints & proportional bow clamp so control points never enter a pill's box.
    const chordBow = (offset: number) => {
      const c0x = (a.x + b.x) / 2 - uy * offset
      const c0y = (a.y + b.y) / 2 + ux * offset
      const [sx, sy] = leave(a, c0x, c0y, 3)
      const [ex, ey] = leave(b, c0x, c0y, 4)
      const cdx = ex - sx
      const cdy = ey - sy
      const clen = Math.hypot(cdx, cdy) || 1
      const cux = cdx / clen
      const cuy = cdy / clen
      const clamped = Math.sign(offset) * Math.min(Math.abs(offset), clen * 0.42)
      const [kx, ky] = clampStage((sx + ex) / 2 - cuy * clamped, (sy + ey) / 2 + cux * clamped)
      return [kx, ky, sx, sy, ex, ey] as const
    }
    const detourBow = (offset: number) => {
      const [kx, ky] = clampStage((a.x + b.x) / 2 - uy * offset, (a.y + b.y) / 2 + ux * offset)
      const [sx, sy] = leave(a, kx, ky, 3)
      const [ex, ey] = leave(b, kx, ky, 4)
      return [kx, ky, sx, sy, ex, ey] as const
    }
    // The same members in the same places route an edge the same way: a redraw that changed nothing else
    // (a press, the next frame of a replay) takes the route found before.
    const routeKey = `${edge}|${isMutual}|${beside}`
    const [cx, cy, x1, y1, x2, y2] = routes.get(routeKey) ?? (() => {
      let [cx, cy, x1, y1, x2, y2] = chordBow(baseBow)
      const isForward = (controlX: number, controlY: number, ex: number, ey: number) =>
        (ex - controlX) * (b.x - ex) + (ey - controlY) * (b.y - ey) > 0
      const obstacles = members.filter(m => m.name !== from && m.name !== to).map(m => positions.get(m.name)!).filter(Boolean)
      // The least distance from the curve to a pill in its way. Once it is at or below `floor` the caller has no use for
      // the exact value, so the search stops there. A pill whose box is no nearer than the least so far cannot be nearer
      // itself: the rounded pill lies inside its box.
      const minClearance = (controlX: number, controlY: number, sx: number, sy: number, ex: number, ey: number, floor = -Infinity) => {
        let min = Infinity
        for (const t of CURVE_SAMPLES) {
          const x = (1 - t) ** 2 * sx + 2 * (1 - t) * t * controlX + t ** 2 * ex
          const y = (1 - t) ** 2 * sy + 2 * (1 - t) * t * controlY + t ** 2 * ey
          for (const o of obstacles) {
            if (Math.abs(x - o.x) - o.half > min + 1e-6 || Math.abs(y - o.y) - PILL_HEIGHT / 2 > min + 1e-6) continue
            const dist = pillDist(x, y, o)
            if (dist < min) {
              min = dist
              if (min <= floor) return min
            }
          }
        }
        return min
      }
      const initialForward = isForward(cx, cy, x2, y2)
      if (!initialForward || (obstacles.length > 0 && minClearance(cx, cy, x1, y1, x2, y2, pad - 1e-9) < pad)) {
        // Route around non-endpoint pills with graduated detours while keeping mutual and @all edges separated,
        // and scale down bow on short diagonal chords if the default bow reverses the arrival tangent.
        const shrinkCandidates = !initialForward
          ? [baseBow * 0.6, baseBow * 0.35, baseBow * 0.15, 0].map(offset => ({ useChord: true, offset }))
          : []
        const bowCandidates = (isMutual ? [baseBow, baseBow * 1.45, baseBow * 1.9, -baseBow] : [baseBow, -baseBow])
          .map(offset => ({ useChord: true, offset }))
        const stepCandidates = [24, 36, 52, 70, 90, 120, 155, 195, 235].flatMap(mag => [
          { useChord: mag <= 70, offset: bowSign * (mag + beside) },
          { useChord: mag <= 70, offset: -bowSign * (mag + beside) },
        ])
        const innerFace = (p: { x: number; y: number; half: number }, targetX: number, gap: number) => {
          const dir = p.x < width / 2 ? 1 : p.x > width / 2 ? -1 : (targetX >= p.x ? 1 : -1)
          return [p.x + dir * (p.half + gap), p.y] as const
        }
        const [isx, isy] = innerFace(a, b.x, 3)
        const [iex, iey] = innerFace(b, a.x, 4)
        const corridorCandidates = (() => {
          if (outerCount <= RING_LIMIT && beside === 0) return []
          const list: Array<readonly [number, number, number, number, number, number]> = []
          const idx = iex - isx, idy = iey - isy
          const ilen = Math.hypot(idx, idy) || 1
          const iux = idx / ilen, iuy = idy / ilen
          const midX = (isx + iex) / 2, midY = (isy + iey) / 2
          const small = beside > 0 ? [16, -16, 24, -24, 32, -32] : []
          for (const offset of [...small, baseBow, -baseBow, 24, -24, 36, -36, 52, -52, 70, -70, 90, -90, 120, -120, 155, -155, 195, -195, 235, -235]) {
            const [kx, ky] = clampStage(midX - iuy * offset, midY + iux * offset)
            list.push([kx, ky, isx, isy, iex, iey])
          }
          const laneLeft = width / 2 - (centerHalf + 28)
          const laneRight = width / 2 + (centerHalf + 28)
          const minSideX = Math.min(isx, iex) - 28
          const maxSideX = Math.max(isx, iex) + 28
          for (const [kx, ky] of [
            [width / 2, height / 2 - 48],
            [width / 2, height / 2 + 48],
            [laneLeft, midY],
            [laneRight, midY],
            [laneLeft, height / 2 - 48],
            [laneLeft, height / 2 + 48],
            [laneRight, height / 2 - 48],
            [laneRight, height / 2 + 48],
            [minSideX, midY],
            [maxSideX, midY],
            [width / 2, 24],
            [width / 2, height - 24],
          ] as const) {
            const [cxC, cyC] = clampStage(kx, ky)
            list.push([cxC, cyC, isx, isy, iex, iey])
          }
          return list
        })()
        let bestClear = -Infinity
        let bestCand: readonly [number, number, number, number, number, number] | undefined
        let found = false
        for (const { useChord, offset } of [...shrinkCandidates, ...bowCandidates, ...stepCandidates]) {
          const cand = useChord ? chordBow(offset) : detourBow(offset)
          const [candX, candY, sx, sy, ex, ey] = cand
          if (!isForward(candX, candY, ex, ey)) continue
          const clear = obstacles.length > 0 ? minClearance(candX, candY, sx, sy, ex, ey, bestClear) : Infinity
          if (clear >= pad) {
            cx = candX; cy = candY; x1 = sx; y1 = sy; x2 = ex; y2 = ey
            found = true
            break
          }
          if (clear > bestClear) {
            bestClear = clear
            bestCand = cand
          }
        }
        if (!found) {
          for (const cand of corridorCandidates) {
            const [candX, candY, sx, sy, ex, ey] = cand
            if (!isForward(candX, candY, ex, ey)) continue
            const clear = obstacles.length > 0 ? minClearance(candX, candY, sx, sy, ex, ey, bestClear) : Infinity
            if (clear >= pad) {
              cx = candX; cy = candY; x1 = sx; y1 = sy; x2 = ex; y2 = ey
              found = true
              break
            }
            if (clear > bestClear) {
              bestClear = clear
              bestCand = cand
            }
          }
        }
        if (!found && bestCand) {
          [cx, cy, x1, y1, x2, y2] = bestCand
        }
      }
      const routed: Route = [cx, cy, x1, y1, x2, y2]
      routes.set(routeKey, routed)
      return routed
    })()
    const weight = weightOf(total)
    // The head is drawn by hand so it sits on the pill's border, turned the way the curve arrives, and the
    // line stops at its base instead of showing through its tip.
    const gap = Math.hypot(x2 - x1, y2 - y1)
    const head = Math.min((isCurrent ? 9 : 6.5) + weight * 1.3, Math.max(4, gap * 0.45))
    const tangent = Math.hypot(x2 - cx, y2 - cy) || 1
    const tx = (x2 - cx) / tangent
    const ty = (y2 - cy) / tangent
    const bx = x2 - tx * head
    const by = y2 - ty * head
    const wing = head * 0.46
    const tip = `M${n1(x2)} ${n1(y2)}L${n1(bx - ty * wing)} ${n1(by + tx * wing)}L${n1(bx + ty * wing)} ${n1(by - tx * wing)}z`
    const dHistory = `M${n1(x1)} ${n1(y1)} Q${n1(cx)} ${n1(cy)} ${n1(bx)} ${n1(by)}`
    const d = `M${n1(x1)} ${n1(y1)} Q${n1(cx)} ${n1(cy)} ${n1(bx + tx)} ${n1(by + ty)}`
    const description = `<title>${esc(from)} to ${esc(to)} · ` +
      (isDashed ? `${total} via @all` : `${total} ${total === 1 ? 'mention' : 'mentions'}`) + '</title>'
    // One description a route, on the line that is always drawn: a tooltip where the host draws the frame live. The host
    // gives a reader only the drawing's alt, so the pane lists the routes in words beside it.
    if (!isCurrent) {
      return `<g class="history-edge"><path class="edge${isDashed ? ' via-all' : ''}" d="${dHistory}" stroke-width="${n1(weight)}">${description}</path>` +
        `<path class="tip" d="${tip}"/></g>`
    }

    active.push(`<path class="route-base" d="${d}" stroke-width="${n1(weight + 4)}"/>`)
    if (animate) active.push(`<path class="route reduced-route${isDashed ? ' via-all' : ''}" d="${d}" stroke-width="${n1(weight + 0.9)}"/>`)
    // A dashed line cannot also be drawn on by its dashes, so it fades in instead.
    const draw = !animate ? '' : isDashed
      ? `<animate attributeName="opacity" from="0" to="1" ${timing(610)} calcMode="spline" keyTimes="0;1" keySplines="${FADE_EASE}" fill="freeze"/>`
      : `<animate attributeName="stroke-dashoffset" from="102" to="0" ${timing(TRAVEL_MS)} calcMode="spline" keyTimes="0;1" keySplines="${TRAVEL_EASE}" fill="freeze"/>`
    active.push(isDashed
      ? `<path class="route via-all${animate ? ' motion' : ''}" d="${d}" stroke-width="${n1(weight + 0.9)}"${animate ? ' opacity="0"' : ''}>${description}${draw}</path>`
      : `<path class="route${animate ? ' motion-route' : ''}" d="${d}" pathLength="100" stroke-width="${n1(weight + 0.9)}"${animate ? ' stroke-dashoffset="102"' : ''}>${description}${draw}</path>`)
    // The arrowhead eases in as the packet reaches its destination.
    active.push(animate
      ? `<path class="tip-current motion" d="${tip}" opacity="0"><animate attributeName="opacity" from="0" to="1" ${timing(160, TRAVEL_MS - 125)} calcMode="spline" keyTimes="0;1" keySplines="${FADE_EASE}" fill="freeze"/></path>` +
        `<path class="tip-current reduced-route" d="${tip}"/>`
      : `<path class="tip-current" d="${tip}"/>`)
    if (animate || repeat) {
      const route = `M${n1(x1)} ${n1(y1)} Q${n1(cx)} ${n1(cy)} ${n1(x2)} ${n1(y2)}`
      const motion = (lag = 0) => repeat
        ? `<animateMotion ${timing(ROUTE_LOOP_MS, lag)} path="${route}" calcMode="spline" keyPoints="0;1;1" keyTimes="${keyTimes(ROUTE_LOOP_MS, 0, TRAVEL_MS, ROUTE_LOOP_MS)}" keySplines="${TRAVEL_EASE};${LINEAR}"${repeatAttr}/>`
        : `<animateMotion ${timing(TRAVEL_MS, lag)} path="${route}" calcMode="spline" keyPoints="0;1" keyTimes="0;1" keySplines="${TRAVEL_EASE}" fill="freeze"/>`
      const opacity = (peak: string, lag = 0) => {
        const finish = TRAVEL_MS + 130
        const duration = repeat ? ROUTE_LOOP_MS : finish
        const marks = repeat ? [0, 105, TRAVEL_MS - 65, finish, duration] : [0, 105, TRAVEL_MS - 65, finish]
        return `<animate attributeName="opacity" values="0;${peak};${peak};0${repeat ? ';0' : ''}" keyTimes="${keyTimes(duration, ...marks)}" calcMode="spline" keySplines="${FADE_EASE};${LINEAR};${FADE_EASE}${repeat ? `;${LINEAR}` : ''}" ${timing(duration, lag)}${repeatAttr}/>`
      }
      const headMotion = motion()
      active.push(
        '<circle class="motion packet-tail" r="2.2" opacity="0">' +
        motion(TAIL_DELAY_MS) + opacity('.48', TAIL_DELAY_MS) + '</circle>' +
        '<circle class="motion packet-halo" r="7.5" opacity="0">' +
        headMotion + opacity('.3') + '</circle>' +
        '<circle class="motion packet" r="3.5" opacity="0">' +
        headMotion + opacity('1') + '</circle>',
      )
    }
    if (total > 1 && (current?.to.length ?? 0) <= 3) {
      // On a short line the count would cover it, so it stands beside the line instead.
      const short = gap < 64
      const mx = (x1 + x2) / 2
      const my = (y1 + y2) / 2
      const side = (-(cx - mx) * uy + (cy - my) * ux) < 0 ? -1 : 1
      const x = (x1 + 2 * cx + x2) / 4 + (short ? -uy * 15 * side : 0)
      const y = (y1 + 2 * cy + y2) / 4 + (short ? ux * 15 * side : 0)
      const bw = Math.max(20, 10 + String(total).length * 7)
      badges.push(
        `<g transform="translate(${n1(x)} ${n1(y)})">` +
        `<rect class="badge" x="${n1(-bw / 2)}" y="-10" width="${n1(bw)}" height="20" rx="10"/><text class="count" y="0" dy=".35em">${total}</text></g>`,
      )
    }
    return undefined
  }
  // The current post's routes, ranked first, are always drawn; the rest are routed only as far as they are kept.
  const quieter = edges.filter(one => !isCurrentEdge(one.edge, one.isDashed))
  for (const one of edges) if (isCurrentEdge(one.edge, one.isDashed)) routeOf(one)

  const allPosts = [...broadcasts.values()].reduce((sum, count) => sum + count, 0)
  const pulse = (start: number) => {
    const duration = repeat ? ROUTE_LOOP_MS : 340
    const marks = repeat ? [0, 100, 340, duration] : [0, 100, duration]
    return `<animate attributeName="opacity" values="0;.56;0${repeat ? ';0' : ''}" keyTimes="${keyTimes(duration, ...marks)}" calcMode="spline" keySplines="${FADE_EASE};${FADE_EASE}${repeat ? `;${LINEAR}` : ''}" ${timing(duration, start)}${repeatAttr}/>`
  }
  const nodes = members.map(member => {
    const p = positions.get(member.name)!
    const sender = current?.agent === member.name
    const recipient = current?.to.includes(member.name)
    // A closed run has no live state to show, only who was retired.
    const status = live && (!swarm.isClosed || member.status === 'killed') ? member.status : ''
    const silent = unaddressed.get(member.name) ?? 0
    const sent = broadcasts.get(member.name) ?? 0
    const title = [member.name, status, silent > 0 ? `${silent} ${silent === 1 ? 'post' : 'posts'} with no mention` : '',
      sent > 0 ? `${sent} to @all` : ''].filter(part => part !== '').join(' · ')
    const emphasis = sender ? ' sender' : recipient ? ' recipient' : ''
    const rect = `x="${-p.half}" y="${-PILL_HEIGHT / 2}" width="${p.half * 2}" height="${PILL_HEIGHT}" rx="13"`
    const moving = animate || repeat
    // A recipient lights up as the packet lands. The sender of a post that names nobody has no line to
    // show it, so its own outline answers instead.
    const arrival = moving && (recipient || (sender && current?.to.length === 0))
      ? `<rect class="motion arrival" ${rect} opacity="0">${pulse(recipient ? TRAVEL_MS - 34 : 0)}</rect>`
      : ''
    if (moving && sender && isCurrentBroadcast && !expandAll) {
      ripples.push(
        `<g transform="translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})">` +
        [0, 135, 270].map(delay => {
          const duration = repeat ? ROUTE_LOOP_MS : TRAVEL_MS
          const motionMarks = repeat ? [0, TRAVEL_MS, duration] : [0, duration]
          const fadeMarks = repeat ? [0, 125, TRAVEL_MS, duration] : [0, 125, duration]
          const attrs = `${timing(duration, delay)}${repeatAttr}`
          return `<circle class="motion ripple" r="24" opacity="0">` +
            `<animate attributeName="r" values="24;154${repeat ? ';154' : ''}" keyTimes="${keyTimes(duration, ...motionMarks)}" calcMode="spline" keySplines=".22 .61 .36 1${repeat ? `;${LINEAR}` : ''}" ${attrs}/>` +
            `<animate attributeName="opacity" values="0;.4;0${repeat ? ';0' : ''}" keyTimes="${keyTimes(duration, ...fadeMarks)}" calcMode="spline" keySplines="${FADE_EASE};${FADE_EASE}${repeat ? `;${LINEAR}` : ''}" ${attrs}/></circle>`
        }).join('') +
        '</g>',
      )
    }
    const cw = Math.max(44, 30 + String(sent).length * 6.5)
    const chip = sent > 0
      ? `<g class="chip${sender && isCurrentBroadcast ? ' on' : ''}" transform="translate(${n1(p.half - cw / 2 - 4)} ${-PILL_HEIGHT / 2})">` +
        `<rect x="${n1(-cw / 2)}" y="-8" width="${n1(cw)}" height="16" rx="8"/><text dy=".35em">@all ${sent}</text></g>`
      : ''
    const px = -p.half + 14
    const skey = statusKey(status)
    const scls = esc(status.replace(/\s+/g, '-'))
    const pulseRing = repeat && (skey === 'working' || skey === 'coordinating')
      ? `<circle class="motion p-ping ${skey}" cx="${px}" r="3.6"/>`
      : ''
    const dot = status === '' ? ''
      : skey === 'working' ? `${pulseRing}<circle class="presence working" cx="${px}" r="3.7"/>`
      : skey === 'waiting' ? `<circle class="presence-ring waiting" cx="${px}" r="3.1"/><circle class="presence waiting" cx="${px}" r="1.4"/>`
      : skey === 'coordinating' ? `${pulseRing}<path class="presence coordinating" d="M${px} -4L${px + 4} 0 ${px} 4 ${px - 4} 0z"/>`
      : skey === 'failed' ? `<path class="presence-x ${scls}" d="M${px - 2.6} -2.6L${px + 2.6} 2.6M${px + 2.6} -2.6L${px - 2.6} 2.6"/>`
      : `<circle class="presence ${scls}" cx="${px}" r="3.1"/>`
    return (
      `<g transform="translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})"${status === 'killed' ? ' class="killed"' : ''}>` +
      `<title>${esc(title)}</title><rect class="pill${emphasis}${silent > 0 ? ' quiet' : ''}" ${rect}/>` +
      arrival + dot +
      `<text class="name" x="${dot ? 7 : 0}" dy=".35em">${esc(p.label)}</text>` + chip + '</g>'
    )
  })

  // The key under the diagram is drawn with the diagram's own classes, so it cannot say one thing and the lines another.
  const row = height + 16
  const lcw = Math.max(44, 30 + String(allPosts).length * 6.5)
  const legend =
    `<g class="legend"><g opacity=".72"><path class="edge" d="M16 ${row}H40" stroke-width="2.4"/><path class="tip" d="M48 ${row}l-9 -4.2v8.4z"/></g>` +
    `<text x="56" y="${row}" dy=".35em">@mention, width = count</text>` +
    `<g opacity=".72"><path class="edge via-all" d="M224 ${row}H248" stroke-width="1.6"/><path class="tip" d="M256 ${row}l-9 -4.2v8.4z"/></g>` +
    `<text x="264" y="${row}" dy=".35em">via @all</text>` +
    `<rect class="pill quiet" x="336" y="${row - 7}" width="26" height="14" rx="6"/>` +
    `<text x="370" y="${row}" dy=".35em">posted with no mention</text>` +
    `<g class="chip" transform="translate(${n1(16 + lcw / 2)} ${row + 22})"><rect x="${n1(-lcw / 2)}" y="-8" width="${n1(lcw)}" height="16" rx="8"/><text dy=".35em">@all ${allPosts}</text></g>` +
    `<text x="${n1(16 + lcw + 8)}" y="${row + 22}" dy=".35em">${allPosts === 0 ? 'no @all posts yet' : expandAll ? '@all posts, drawn as dashed arrows' : '@all posts, drawn by Expand @all'}</text></g>`
  const key = 'Arrow: @mention, thicker for more · Dashed arrow: reached via @all · Dashed outline: posted with no mention · ' +
    (allPosts === 0 ? 'No @all posts yet' : `“@all N” on a member: its @all posts (${allPosts} in all), ${expandAll ? 'drawn as dashed arrows' : 'drawn by Expand @all'}`)

  const pingCss = repeat
    ? `.p-ping{fill:none;stroke-width:1.4;transform-box:fill-box;transform-origin:center;animation:pp 3.2s ${easeOut} ${loopDelay(ms, 3200)} infinite}` +
      `.p-ping.working{stroke:var(--status-working)}.p-ping.coordinating{stroke:var(--status-coordinating)}` +
      '@keyframes pp{0%{transform:scale(.9);opacity:0}14%{opacity:.45}78%,100%{transform:scale(2.05);opacity:0}}'
    : ''
  const open =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height + LEGEND}" width="100%" height="100%" font-family="system-ui, sans-serif">` +
    `<defs><clipPath id="stage"><rect width="${width}" height="${height}"/></clipPath>` +
    `<filter id="sh" x="-15%" y="-25%" width="130%" height="160%"><feDropShadow dx="0" dy="1.5" stdDeviation="2" flood-opacity=".11"/></filter>` +
    `<linearGradient id="sg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--tint)"/><stop offset="100%" stop-color="var(--pill)"/></linearGradient></defs>` +
    `<style>
      svg{--edge:#596375;--pill:#f8f8f7;--border:#87909d;--ink:#252628;--accent:#235fc4;--tint:#eaf2ff;--packet:#fff}
      @media (prefers-color-scheme: dark){svg{--edge:#9399a5;--pill:#242424;--border:#737982;--ink:#f1f1ef;--accent:#8fb8ff;--tint:#243750;--packet:#fff}}
      @supports(color:color(display-p3 1 0 0)){
        svg{--edge:color(display-p3 .35 .39 .46);--pill:color(display-p3 .97 .97 .965);--border:color(display-p3 .53 .56 .61);--ink:color(display-p3 .15 .15 .16);--accent:color(display-p3 .2033 .3675 .7427);--tint:color(display-p3 .92 .95 1);--packet:color(display-p3 1 1 1)}
        @media(prefers-color-scheme:dark){svg{--edge:color(display-p3 .58 .60 .64);--pill:color(display-p3 .14 .14 .14);--border:color(display-p3 .45 .47 .51);--ink:color(display-p3 .95 .95 .94);--accent:color(display-p3 .5935 .7170 .9777);--tint:color(display-p3 .15 .22 .31)}}
      }
      .edge,.route,.route-base{fill:none;stroke-linecap:round}
      .history-edge{opacity:.64;transition:opacity .18s ease}.history-edge:hover{opacity:1}.history-edge:hover .edge{stroke:var(--accent)}.history-edge:hover .tip{fill:var(--accent)}
      .edge{stroke:var(--edge);transition:stroke .18s ease}.tip{fill:var(--edge);transition:fill .18s ease}
      .via-all{stroke-dasharray:6 5;stroke-linecap:butt}
      .route-base{stroke:var(--accent);opacity:.15}
      .route{stroke:var(--accent)}.motion-route{stroke-dasharray:102 102}.tip-current{fill:var(--accent)}
      .packet-tail{fill:var(--accent)}.packet-halo{fill:var(--accent)}.packet{fill:var(--packet);stroke:var(--accent);stroke-width:1.6}
      .pill{fill:var(--pill);stroke:var(--border);filter:url(#sh);transition:stroke .16s ease,fill .16s ease}
      g:hover>.pill{stroke:var(--accent)}
      .sender{fill:url(#sg);stroke:var(--accent);stroke-width:1.8}.recipient{stroke:var(--accent);stroke-width:1.5}
      .quiet{stroke-dasharray:5 4}.killed .pill{stroke-dasharray:2 3}.killed .name{opacity:.68;text-decoration:line-through}
      .arrival,.ripple{fill:none;stroke:var(--accent)}.arrival{stroke-width:4}.ripple{stroke-width:1.8}
      .name,.count{fill:var(--ink);text-anchor:middle;font-weight:600}.name{font-size:14px}.count{font-size:12px}
      .badge{fill:var(--tint);stroke:var(--accent);filter:url(#sh)}
      .chip rect{fill:var(--pill);stroke:var(--border)}.chip text{fill:var(--ink);opacity:.82;font-size:10.5px;font-weight:600;text-anchor:middle}
      .chip.on rect{fill:var(--tint);stroke:var(--accent)}
      .legend>text{fill:var(--ink);opacity:.72;font-size:12px}
      .legend .pill{filter:none;stroke-dasharray:3.5 2.5;stroke-width:1.15}
      ${statusCss}${pingCss}
      .presence{fill:none;stroke:var(--status-inactive);stroke-width:1.2}
      .presence-ring{fill:none;stroke:var(--status-waiting);stroke-width:1.2}
      .presence-x{fill:none;stroke:var(--status-failed);stroke-width:1.6;stroke-linecap:round}
      ${['working', 'coordinating', 'waiting'].map(status => `.presence.${status}{fill:var(--status-${status});stroke:none}`).join('')}
      .reduced-route{display:none}
      @media (prefers-reduced-motion: reduce){
        .motion,.motion-route{display:none}.reduced-route{display:inline}
        .history-edge,.edge,.tip,.pill{transition:none}
      }
    </style>
    ` +
    `<g clip-path="url(#stage)">${ripples.join('')}</g>`
  const close = active.join('') + nodes.join('') + badges.join('') +
    `<line x1="16" y1="${height + 0.5}" x2="${width - 16}" y2="${height + 0.5}" stroke="var(--border)" opacity=".35"/>` +
    legend + '</svg>'
  // Measured whole: the history goes in, busiest first, until the first route that would take the drawing past the
  // limit. A shorter, quieter one after it stays out too, so what is left out is always the quietest; and no route
  // after that one is routed at all, since none could be drawn.
  let room = limit - open.length - close.length
  if (room < 0) return { hidden: quieter.length, key }
  const history: string[] = []
  for (const [index, one] of quieter.entries()) {
    const route = routeOf(one)
    if (route === undefined) continue
    if ((room -= route.length) < 0) return { svg: open + history.join('') + close, hidden: quieter.length - index, key }
    history.push(route)
  }
  return { svg: open + history.join('') + close, hidden: 0, key }
}
