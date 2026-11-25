import { statusCss } from './palette'
import { easeInOut, easeOut, elapsedMs, hashSeed, loopDelay } from './motion'
import { head as clipHead, mentions } from './text'
import type { Post, Swarm } from '../types'

// Read as the board routes a post (board.py's mentions()): outside code, and a cited author ("per @bob #5") is no
// mention, so it reaches nobody by name.
/** True when the post addresses `@all`: the members it does not also name are reached through that alone. */
export const isBroadcast = (post: Post) => mentions(post.text).has('all')
/** The recipients a post reached through `@all` alone. */
function viaAllOf(post: Post): ReadonlySet<string> {
  const named = mentions(post.text)
  return named.has('all') ? new Set(post.to.filter(to => !named.has(to.toLowerCase()))) : new Set()
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

/**
 * The edges of the posts before KEPT. WHOLE is the board's count over its whole journal (its attention report), counted
 * through post THROUGH: when ALL is only the board's tail (its first post is not #1), the posts before it are counted
 * there and nowhere else. Joined only to a tail that ends at that post: a post that landed between the two reads would
 * otherwise be drawn as history before it is shown.
 */
export function earlierEdgesOf(all: Post[], kept: Post[], whole?: Record<string, number>, through?: number): Record<string, number> {
  if (!whole || (all[0]?.seq ?? 1) <= 1 || through !== (all.at(-1)?.seq ?? 0)) return edgesOf(all.slice(0, all.length - kept.length))
  const counts: Record<string, number> = {}
  const recent = edgesOf(kept)
  for (const [edge, count] of Object.entries(whole)) {
    const left = count - (recent[edge] ?? 0)
    if (left > 0) counts[edge] = left
  }
  return counts
}

/** The two members of an edge key, or nothing for a key that counts `@all` or mention-free posts. */
export function pairOf(edge: string): [string, string] | undefined {
  const [from = '', to = ''] = edge.split('>')
  return to.startsWith('@') ? undefined : [from, to]
}

const PILL_HEIGHT = 38
const LEGEND = 68
const ROUTE_LOOP_MS = 3600
const TRAVEL_MS = 840
const TAIL_DELAY_MS = 62
const TRAVEL_EASE = '.37 0 .3 1'
const FADE_EASE = '.4 0 .6 1'
const LINEAR = '0 0 1 1'
const keyTimes = (duration: number, ...marks: number[]) =>
  marks.map(mark => String(Math.round(mark / duration * 10_000) / 10_000)).join(';')
const utf8 = new TextEncoder()
const byteLen = (text: string) => utf8.encode(text).length
// The host refuses an Svg source longer than this UTF-8 byte count, and the whole pane with it.
export const SVG_LIMIT = 131_072
// The name font is 14px in the drawing's own units; drawn smaller than this on screen, the graph gives way to a list.
export const MIN_LABEL_PX = 10

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
    // The tail starts on a whole character: half of a pair is no text an SVG may hold.
    const cut = (start: number) => `${clipHead(name, start)}…${name.slice(start - 14).replace(/^[\uDC00-\uDFFF]/, '')}`
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
  const loopRoutes = repeat && !swarm.isClosed && !swarm.isPaused
  const phase = loopRoutes ? ms % ROUTE_LOOP_MS : ms
  const timing = (duration: number, start = 0) => `begin="${start - phase}ms" dur="${duration / 1000}s"`
  const repeatAttr = loopRoutes ? ' repeatCount="indefinite"' : ''
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
    const routeDur = isDashed ? 610 : TRAVEL_MS
    const routeAnim = animate && phase < routeDur
    if (routeAnim) active.push(`<path class="route reduced-route${isDashed ? ' via-all' : ''}" d="${d}" stroke-width="${n1(weight + 0.9)}"/>`)
    // A dashed line cannot also be drawn on by its dashes, so it fades in instead; once settled, omit the frozen <animate>.
    const draw = !routeAnim ? '' : isDashed
      ? `<animate attributeName="opacity" from="0" to="1" ${timing(610)} calcMode="spline" keyTimes="0;1" keySplines="${FADE_EASE}" fill="freeze"/>`
      : `<animate attributeName="stroke-dashoffset" from="102" to="0" ${timing(TRAVEL_MS)} calcMode="spline" keyTimes="0;1" keySplines="${TRAVEL_EASE}" fill="freeze"/>`
    active.push(isDashed
      ? `<path class="route via-all${routeAnim ? ' motion' : ''}" d="${d}" stroke-width="${n1(weight + 0.9)}"${routeAnim ? ' opacity="0"' : ''}>${description}${draw}</path>`
      : `<path class="route${routeAnim ? ' motion-route' : ''}" d="${d}" pathLength="100" stroke-width="${n1(weight + 0.9)}"${routeAnim ? ' stroke-dashoffset="102"' : ''}>${description}${draw}</path>`)
    // The arrowhead eases in as the packet reaches its destination; once settled, draw it directly.
    const tipAnim = animate && phase < TRAVEL_MS + 35
    active.push(tipAnim
      ? `<path class="tip-current motion" d="${tip}" opacity="0"><animate attributeName="opacity" from="0" to="1" ${timing(160, TRAVEL_MS - 125)} calcMode="spline" keyTimes="0;1" keySplines="${FADE_EASE}" fill="freeze"/></path>` +
        `<path class="tip-current reduced-route" d="${tip}"/>`
      : `<path class="tip-current" d="${tip}"/>`)
    if (animate || loopRoutes) {
      const route = `M${n1(x1)} ${n1(y1)} Q${n1(cx)} ${n1(cy)} ${n1(x2)} ${n1(y2)}`
      const motion = (lag = 0) => loopRoutes
        ? `<animateMotion ${timing(ROUTE_LOOP_MS, lag)} path="${route}" calcMode="spline" keyPoints="0;1;1" keyTimes="${keyTimes(ROUTE_LOOP_MS, 0, TRAVEL_MS, ROUTE_LOOP_MS)}" keySplines="${TRAVEL_EASE};${LINEAR}"${repeatAttr}/>`
        : `<animateMotion ${timing(TRAVEL_MS, lag)} path="${route}" calcMode="spline" keyPoints="0;1" keyTimes="0;1" keySplines="${TRAVEL_EASE}" fill="freeze"/>`
      const opacity = (peak: string, lag = 0) => {
        const finish = TRAVEL_MS + 130
        const duration = loopRoutes ? ROUTE_LOOP_MS : finish
        const marks = loopRoutes ? [0, 105, TRAVEL_MS - 65, finish, duration] : [0, 105, TRAVEL_MS - 65, finish]
        return `<animate attributeName="opacity" values="0;${peak};${peak};0${loopRoutes ? ';0' : ''}" keyTimes="${keyTimes(duration, ...marks)}" calcMode="spline" keySplines="${FADE_EASE};${LINEAR};${FADE_EASE}${loopRoutes ? `;${LINEAR}` : ''}" ${timing(duration, lag)}${repeatAttr}/>`
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
      const bw = Math.max(20, 10 + String(total).length * 7)
      const rawX = (x1 + 2 * cx + x2) / 4 + (short ? -uy * 15 * side : 0)
      const rawY = (y1 + 2 * cy + y2) / 4 + (short ? ux * 15 * side : 0)
      const x = Math.max(bw / 2 + 4, Math.min(width - bw / 2 - 4, rawX))
      const y = Math.max(12, Math.min(height - 12, rawY))
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
    const duration = loopRoutes ? ROUTE_LOOP_MS : 340
    const marks = loopRoutes ? [0, 100, 340, duration] : [0, 100, duration]
    return `<animate attributeName="opacity" values="0;.56;0${loopRoutes ? ';0' : ''}" keyTimes="${keyTimes(duration, ...marks)}" calcMode="spline" keySplines="${FADE_EASE};${FADE_EASE}${loopRoutes ? `;${LINEAR}` : ''}" ${timing(duration, start)}${repeatAttr}/>`
  }
  const liveMotion = live && !swarm.isClosed && !swarm.isPaused
  const pausedMotion = live && !swarm.isClosed
  const statusOfNode = (member: Swarm['members'][number]) => {
    if (!live) return ''
    if (swarm.isClosed) return member.status === 'killed' ? 'killed' : 'closed'
    if (member.status === 'killed' || member.status === 'failed' || member.status === 'stopped' || member.status === 'unreachable') {
      return member.status
    }
    if (swarm.isPaused) return member.status === 'not started' ? 'not started' : 'paused'
    if (member.status === 'paused' || member.detail === 'its token budget is spent') return 'paused'
    return member.status
  }
  const statusGlyph = (status: string, px: number, animateNode: boolean, seed: number): string => {
    if (status === '') return ''
    const dly = (dur: number) => animateNode ? ` style="animation-delay:${loopDelay(ms, dur, seed % dur)}"` : ''
    const x = n1(px)
    switch (status) {
      case 'coordinating': {
        const d = `M${x} -4L${n1(px + 3.5)} -2V2L${x} 4L${n1(px - 3.5)} 2V-2Z`
        return (animateNode && liveMotion ? `<path class="motion p-ping coordinating" d="${d}"${dly(3400)}/>` : '') +
          `<path class="presence coordinating" d="${d}"/>`
      }
      case 'working':
        return (animateNode && liveMotion ? `<circle class="motion p-ping working" cx="${x}" r="3.6"${dly(2800)}/>` : '') +
          `<circle class="presence working" cx="${x}" r="3.7"/>`
      case 'waiting':
        return `<circle class="presence-ring waiting" cx="${x}" r="3.3"/>` +
          `<circle class="presence waiting${animateNode && liveMotion ? ' p-wait' : ''}" cx="${x}" r="1.5"${liveMotion ? dly(3600) : ''}/>`
      case 'not started':
        return `<path class="presence not-started${animateNode && liveMotion ? ' p-queue' : ''}" d="M${x} -3.5L${n1(px + 3)} -1.8V1.8L${x} 3.5L${n1(px - 3)} 1.8V-1.8Z"${liveMotion ? dly(4400) : ''}/>`
      case 'paused':
        return `<circle class="presence-ring paused${animateNode && pausedMotion ? ' p-pause' : ''}" cx="${x}" r="3.8"${pausedMotion ? dly(4800) : ''}/>` +
          `<path class="presence paused" d="M${n1(px - 1.2)} -1.8V1.8M${n1(px + 1.2)} -1.8V1.8"/>`
      case 'closed':
        return `<path class="presence closed" d="M${x} -3.4L${n1(px + 2.9)} -1.7V1.7L${x} 3.4L${n1(px - 2.9)} 1.7V-1.7Z"/>` +
          `<circle class="presence-core closed" cx="${x}" r="1.2"/>`
      case 'killed':
        return `<circle class="presence killed" cx="${x}" r="3.4"/>` +
          `<path class="presence-slash killed" d="M${n1(px - 2.4)} 2.4L${n1(px + 2.4)} -2.4"/>`
      case 'stopped':
        return `<rect class="presence stopped" x="${n1(px - 3.3)}" y="-3.3" width="6.6" height="6.6" rx="1.1"/>` +
          `<rect class="presence-core stopped${animateNode && liveMotion ? ' p-stop' : ''}" x="${n1(px - 1.5)}" y="-1.5" width="3" height="3" rx=".4"${liveMotion ? dly(3600) : ''}/>`
      case 'failed':
        return (animateNode && liveMotion ? `<circle class="motion p-alert failed" cx="${x}" r="4.8"${dly(2800)}/>` : '') +
          `<path class="presence-x failed" d="M${n1(px - 2.6)} -2.6L${n1(px + 2.6)} 2.6M${n1(px + 2.6)} -2.6L${n1(px - 2.6)} 2.6"/>`
      case 'unreachable':
        return `<circle class="presence unreachable" cx="${x}" r="3.4"/>` +
          `<path class="presence-sig unreachable${animateNode && liveMotion ? ' p-sig' : ''}" d="M${n1(px - 2)} -4.6Q${x} -6.2 ${n1(px + 2)} -4.6"${liveMotion ? dly(3200) : ''}/>`
      default:
        return `<circle class="presence ${esc(status.replace(/\s+/g, '-'))}" cx="${x}" r="3.1"/>`
    }
  }
  const nodeStatuses = new Set<string>()
  const nodes = members.map(member => {
    const p = positions.get(member.name)!
    const isCenter = member === coordinator || (coordinator === undefined && members.length === 1)
    const sender = current?.agent === member.name
    const recipient = current?.to.includes(member.name)
    const status = statusOfNode(member)
    if (status) nodeStatuses.add(status)
    const silent = unaddressed.get(member.name) ?? 0
    const sent = broadcasts.get(member.name) ?? 0
    const title = [member.name, status, silent > 0 ? `${silent} ${silent === 1 ? 'post' : 'posts'} with no mention` : '',
      sent > 0 ? `${sent} to @all` : ''].filter(part => part !== '').join(' · ')
    const emphasis = sender ? ' sender' : recipient ? ' recipient' : ''
    const rect = `x="${-p.half}" y="${-PILL_HEIGHT / 2}" width="${p.half * 2}" height="${PILL_HEIGHT}" rx="13"`
    const moving = animate || loopRoutes
    // A recipient lights up as the packet lands. The sender of a post that names nobody has no line to
    // show it, so its own outline answers instead.
    const arrival = moving && (recipient || (sender && current?.to.length === 0))
      ? `<rect class="motion arrival" ${rect} opacity="0">${pulse(recipient ? TRAVEL_MS - 34 : 0)}</rect>`
      : ''
    if (moving && sender && isCurrentBroadcast) {
      const duration = loopRoutes ? ROUTE_LOOP_MS : TRAVEL_MS
      const motionMarks = loopRoutes ? [0, TRAVEL_MS, duration] : [0, duration]
      const fadeMarks = loopRoutes ? [0, 125, TRAVEL_MS, duration] : [0, 125, duration]
      if (!expandAll) {
        const maxR = isCenter ? 154 : 100
        ripples.push(
          `<g transform="translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})">` +
          [0, 135, 270].map(delay => {
            const attrs = `${timing(duration, delay)}${repeatAttr}`
            return `<circle class="motion ripple" r="24" opacity="0">` +
              `<animate attributeName="r" values="24;${maxR}${loopRoutes ? `;${maxR}` : ''}" keyTimes="${keyTimes(duration, ...motionMarks)}" calcMode="spline" keySplines=".22 .61 .36 1${loopRoutes ? `;${LINEAR}` : ''}" ${attrs}/>` +
              `<animate attributeName="opacity" values="0;.4;0${loopRoutes ? ';0' : ''}" keyTimes="${keyTimes(duration, ...fadeMarks)}" calcMode="spline" keySplines="${FADE_EASE};${FADE_EASE}${loopRoutes ? `;${LINEAR}` : ''}" ${attrs}/></circle>`
          }).join('') +
          '</g>',
        )
      } else {
        const attrs = `${timing(duration, 0)}${repeatAttr}`
        ripples.push(
          `<g transform="translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})">` +
          `<circle class="motion origin-pulse" r="24" opacity="0">` +
          `<animate attributeName="r" values="24;54${loopRoutes ? ';54' : ''}" keyTimes="${keyTimes(duration, ...motionMarks)}" calcMode="spline" keySplines=".22 .61 .36 1${loopRoutes ? `;${LINEAR}` : ''}" ${attrs}/>` +
          `<animate attributeName="opacity" values="0;.36;0${loopRoutes ? ';0' : ''}" keyTimes="${keyTimes(duration, ...fadeMarks)}" calcMode="spline" keySplines="${FADE_EASE};${FADE_EASE}${loopRoutes ? `;${LINEAR}` : ''}" ${attrs}/></circle></g>`,
        )
      }
    }
    const cw = Math.max(44, 30 + String(sent).length * 6.5)
    const chip = sent > 0
      ? `<g class="chip${sender && isCurrentBroadcast ? ' on' : ''}" transform="translate(${n1(p.half - cw / 2 - 4)} ${-PILL_HEIGHT / 2})">` +
        `<rect x="${n1(-cw / 2)}" y="-8" width="${n1(cw)}" height="16" rx="8"/><text dy=".35em">@all ${sent}</text></g>`
      : ''
    const px = -p.half + 14
    const scls = status ? esc(status.replace(/\s+/g, '-')) : ''
    const coordFrame = member === coordinator
      ? `<path class="coord-hex" d="M${n1(-p.half + 5)} -22H${n1(p.half - 5)}L${n1(p.half + 5)} 0L${n1(p.half - 5)} 22H${n1(-p.half + 5)}L${n1(-p.half - 5)} 0Z"/>` +
        `<path class="coord-crown" d="M${n1(px)} -6.8L${n1(px + 5.9)} -3.4V3.4L${n1(px)} 6.8L${n1(px - 5.9)} 3.4V-3.4Z"/>`
      : ''
    const dot = statusGlyph(status, px, true, hashSeed(member.name))
    return (
      `<g class="node${scls ? ` ${scls}` : ''}" transform="translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})">` +
      `<title>${esc(title)}</title>${coordFrame}<rect class="pill${emphasis}${silent > 0 ? ' quiet' : ''}" ${rect}/>` +
      arrival + dot +
      `<text class="name" x="${dot ? 7 : 0}" dy=".35em">${esc(p.label)}</text>` + chip + '</g>'
    )
  })

  // The key under the diagram is drawn with the diagram's own classes, so it cannot say one thing and the lines another.
  const STATUS_ORDER = ['coordinating', 'working', 'waiting', 'paused', 'not started', 'closed', 'stopped', 'failed', 'unreachable', 'killed'] as const
  const presentStatuses = live ? STATUS_ORDER.filter(s => nodeStatuses.has(s)) : []
  const row = height + 14
  const lcw = Math.max(44, 30 + String(allPosts).length * 6.5)
  let lx = 16
  let rowY = row + 42
  let statusRows = presentStatuses.length > 0 ? 1 : 0
  const statusLegendParts: string[] = []
  for (const st of presentStatuses) {
    const itemW = 14 + st.length * 6.3
    if (lx > 16 && lx + itemW > width - 12) {
      lx = 16
      rowY += 18
      statusRows++
    }
    statusLegendParts.push(
      `<g transform="translate(${n1(lx + 4.5)} ${rowY})">${statusGlyph(st, 0, false, 0)}</g>` +
      `<text x="${n1(lx + 13)}" y="${rowY}" dy=".35em">${esc(st)}</text>`,
    )
    lx += itemW + 12
  }
  const legendHeight = statusRows === 0 ? 50 : LEGEND + (statusRows - 1) * 18
  const legend =
    `<g class="legend"><g opacity=".72"><path class="edge" d="M16 ${row}H40" stroke-width="2.4"/><path class="tip" d="M48 ${row}l-9 -4.2v8.4z"/></g>` +
    `<text x="56" y="${row}" dy=".35em">@mention, width = count</text>` +
    `<g opacity=".72"><path class="edge via-all" d="M234 ${row}H258" stroke-width="1.6"/><path class="tip" d="M266 ${row}l-9 -4.2v8.4z"/></g>` +
    `<text x="274" y="${row}" dy=".35em">via @all</text>` +
    `<rect class="pill quiet" x="350" y="${row - 7}" width="26" height="14" rx="6"/>` +
    `<text x="384" y="${row}" dy=".35em">posted with no mention</text>` +
    `<g class="chip" transform="translate(${n1(16 + lcw / 2)} ${row + 21})"><rect x="${n1(-lcw / 2)}" y="-8" width="${n1(lcw)}" height="16" rx="8"/><text dy=".35em">@all ${allPosts}</text></g>` +
    `<text x="${n1(16 + lcw + 8)}" y="${row + 21}" dy=".35em">${allPosts === 0 ? 'no @all posts yet' : expandAll ? '@all posts, drawn as dashed arrows' : '@all posts, drawn by Expand @all'}</text>` +
    statusLegendParts.join('') + '</g>'
  const key = 'Arrow: @mention, thicker for more · Dashed arrow: reached via @all · Dashed outline: posted with no mention · ' +
    (allPosts === 0 ? 'No @all posts yet' : `“@all N” on a member: its @all posts (${allPosts} in all), ${expandAll ? 'drawn as dashed arrows' : 'drawn by Expand @all'}`) +
    (presentStatuses.length > 0 ? ` · Statuses: ${presentStatuses.join(', ')}` : '')

  const statusAnimCss = liveMotion
    ? `.p-ping{fill:none;stroke-width:1.4;transform-box:fill-box;transform-origin:center}` +
      `.p-ping.working{stroke:var(--status-working);animation:gp-ring 2.8s ${easeOut} infinite}` +
      `.p-ping.coordinating{stroke:var(--status-coordinating);animation:gp-hex 3.4s ${easeOut} infinite}` +
      `.p-wait{transform-box:fill-box;transform-origin:center;animation:gp-wait 3.6s ${easeInOut} infinite}` +
      `.p-queue{animation:gp-queue 4.4s ${easeInOut} infinite}` +
      `.p-pause{animation:gp-pause 4.8s ${easeInOut} infinite}` +
      `.p-stop{animation:gp-stop 3.6s ${easeInOut} infinite}` +
      `.p-alert{fill:var(--status-failed);animation:gp-alert 2.8s ${easeInOut} infinite}` +
      `.p-sig{animation:gp-sig 3.2s ${easeInOut} infinite}` +
      `@keyframes gp-ring{0%{transform:scale(.9);opacity:0}14%{opacity:.45}78%,100%{transform:scale(2.05);opacity:0}}` +
      `@keyframes gp-hex{0%{transform:scale(.95);opacity:0}16%{opacity:.46}80%,100%{transform:scale(2.05);opacity:0}}` +
      `@keyframes gp-wait{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(.78);opacity:.5}}` +
      `@keyframes gp-queue{0%,100%{opacity:.42}50%{opacity:.85}}` +
      `@keyframes gp-pause{0%,100%{opacity:1}50%{opacity:.48}}` +
      `@keyframes gp-stop{0%,100%{opacity:1}50%{opacity:.42}}` +
      `@keyframes gp-alert{0%,100%{opacity:.12}50%{opacity:.28}}` +
      `@keyframes gp-sig{0%,60%,100%{opacity:1}25%,40%{opacity:.25}}`
    : pausedMotion
      ? `.p-pause{animation:gp-pause 4.8s ${easeInOut} infinite}@keyframes gp-pause{0%,100%{opacity:1}50%{opacity:.48}}`
      : ''
  const open =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height + legendHeight}" width="100%" height="100%" font-family="system-ui, sans-serif">` +
    `<defs><clipPath id="stage"><rect width="${width}" height="${height}"/></clipPath>` +
    `<filter id="sh" x="-15%" y="-25%" width="130%" height="160%"><feDropShadow dx="0" dy="1.5" stdDeviation="2" flood-opacity=".11"/></filter>` +
    `<linearGradient id="sg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--tint)"/><stop offset="100%" stop-color="var(--pill)"/></linearGradient></defs>` +
    `<style>
      ${statusCss}
      svg{--edge:#73685a;--pill:#fcfaf5;--border:#968c7d;--ink:#2a231c;--accent:#b87314;--tint:#fdf3df;--packet:#fde08d;--failed-tint:#fdf1f2;--status-closed:#8c7d68;--status-killed:#74716c}
      @media (prefers-color-scheme: dark){svg{--edge:#a59b8d;--pill:#272420;--border:#7a7062;--ink:#f3efe8;--accent:#f2bd6a;--tint:#382d1e;--packet:#fde08d;--failed-tint:#382022;--status-closed:#a89b86;--status-killed:#9e9a93}}
      @supports(color:color(display-p3 1 0 0)){
        svg{--edge:color(display-p3 .451 .408 .353);--pill:color(display-p3 .988 .980 .960);--border:color(display-p3 .588 .549 .490);--ink:color(display-p3 .165 .137 .110);--accent:color(display-p3 .678 .455 .137);--tint:color(display-p3 .988 .953 .878);--packet:color(display-p3 .9733 .8825 .5954);--failed-tint:color(display-p3 .990 .945 .950);--status-closed:color(display-p3 .549 .490 .408);--status-killed:color(display-p3 .4529 .4435 .4255)}
        @media(prefers-color-scheme:dark){svg{--edge:color(display-p3 .647 .608 .553);--pill:color(display-p3 .153 .141 .125);--border:color(display-p3 .478 .439 .384);--ink:color(display-p3 .953 .937 .910);--accent:color(display-p3 .9166 .7493 .4652);--tint:color(display-p3 .216 .176 .122);--packet:color(display-p3 .9733 .8825 .5954);--failed-tint:color(display-p3 .220 .125 .135);--status-closed:color(display-p3 .659 .608 .525);--status-killed:color(display-p3 .6169 .6044 .5792)}}
      }
      .edge,.route,.route-base{fill:none;stroke-linecap:round}
      .history-edge{opacity:.64;transition:opacity .18s ease}.history-edge:hover{opacity:1}.history-edge:hover .edge{stroke:var(--accent)}.history-edge:hover .tip{fill:var(--accent)}
      .edge{stroke:var(--edge);transition:stroke .18s ease}.tip{fill:var(--edge);transition:fill .18s ease}
      .via-all{stroke-dasharray:6 5;stroke-linecap:butt}
      .route-base{stroke:var(--accent);opacity:.15}
      .route{stroke:var(--accent)}.motion-route{stroke-dasharray:102 102}.tip-current{fill:var(--accent)}
      .packet-tail{fill:var(--accent)}.packet-halo{fill:var(--packet)}.packet{fill:var(--packet);stroke:var(--accent);stroke-width:1.6}
      .pill{fill:var(--pill);stroke:var(--border);filter:url(#sh);transition:stroke .16s ease,fill .16s ease}
      .node:hover>.pill{stroke:var(--accent)}
      .coord-hex{fill:none;stroke:var(--status-coordinating);stroke-opacity:.38;stroke-width:1.15}
      .coord-crown{fill:var(--status-coordinating);fill-opacity:.11;stroke:var(--status-coordinating);stroke-opacity:.42;stroke-width:1;stroke-linejoin:round}
      .sender{fill:url(#sg);stroke:var(--accent);stroke-width:1.8}.recipient{stroke:var(--accent);stroke-width:1.5}
      .quiet{stroke-dasharray:5 4}
      .not-started .pill{opacity:.86}.closed .pill{opacity:.88}
      .killed .pill{stroke-dasharray:2 3;opacity:.62}.killed .name{opacity:.68;text-decoration:line-through}
      .stopped .pill{stroke:var(--status-stopped);stroke-dasharray:4 2}
      .failed .pill{stroke:var(--status-failed);fill:var(--failed-tint)}
      .unreachable .pill{stroke:var(--status-unreachable);stroke-dasharray:3 2.5}
      .arrival,.ripple,.origin-pulse{fill:none;stroke:var(--accent)}.arrival{stroke-width:4}.ripple{stroke-width:1.8}.origin-pulse{stroke-width:1.6}
      .name,.count{fill:var(--ink);text-anchor:middle;font-weight:600}.name{font-size:14px}.count{font-size:12px}
      .badge{fill:var(--tint);stroke:var(--accent);filter:url(#sh)}
      .chip rect{fill:var(--pill);stroke:var(--border)}.chip text{fill:var(--ink);opacity:.82;font-size:11.2px;font-weight:600;text-anchor:middle}
      .chip.on rect{fill:var(--tint);stroke:var(--accent)}
      .legend>text{fill:var(--ink);opacity:.72;font-size:12px}
      .legend .pill{filter:none;stroke-dasharray:3.5 2.5;stroke-width:1.15}
      ${statusAnimCss}
      .presence{fill:none;stroke:var(--status-inactive);stroke-width:1.2}
      .presence-ring{fill:none;stroke:var(--status-waiting);stroke-width:1.2}
      .presence-ring.paused{stroke:var(--status-paused)}
      .presence.paused{stroke:var(--status-paused);stroke-width:1.4;stroke-linecap:round}
      .presence.not-started{stroke-dasharray:2 1.8;stroke:var(--status-inactive)}
      .presence.closed{stroke:var(--status-closed);fill:var(--status-closed);fill-opacity:.14}
      .presence-core.closed{fill:var(--status-closed)}
      .presence.killed{stroke:var(--status-killed)}
      .presence-slash.killed{fill:none;stroke:var(--status-killed);stroke-width:1.3;stroke-linecap:round}
      .presence.stopped{stroke:var(--status-stopped)}
      .presence-core.stopped{fill:var(--status-stopped)}
      .presence-x{fill:none;stroke:var(--status-failed);stroke-width:1.6;stroke-linecap:round}
      .presence.unreachable{stroke:var(--status-unreachable);stroke-dasharray:2.4 1.6}
      .presence-sig.unreachable{fill:none;stroke:var(--status-unreachable);stroke-width:1.2;stroke-linecap:round}
      ${['working', 'coordinating', 'waiting'].map(status => `.presence.${status}{fill:var(--status-${status});stroke:none}`).join('')}
      .reduced-route{display:none}
      @media (prefers-reduced-motion: reduce){
        ${liveMotion ? '.motion,.motion-route,.p-ping,.p-alert{display:none}' : '.motion,.motion-route{display:none}'}.reduced-route{display:inline}
        ${liveMotion ? '.p-wait,.p-queue,.p-pause,.p-stop,.p-sig{animation:none;opacity:1}' : pausedMotion ? '.p-pause{animation:none;opacity:1}' : ''}
        .history-edge,.edge,.tip,.pill{transition:none}
      }
    </style>
    ` +
    `<g clip-path="url(#stage)">${ripples.join('')}</g>`
  const close = active.join('') + nodes.join('') + badges.join('') +
    `<line x1="16" y1="${height + 0.5}" x2="${width - 16}" y2="${height + 0.5}" stroke="var(--border)" opacity=".35"/>` +
    legend + '</svg>'
  // Measured whole in UTF-8 bytes: the history goes in, busiest first, until the first route that would take the
  // drawing past the limit. A shorter, quieter one after it stays out too, so what is left out is always the
  // quietest; and no route after that one is routed at all, since none could be drawn.
  let room = limit - byteLen(open) - byteLen(close)
  if (room < 0) return { hidden: quieter.length, key }
  const history: string[] = []
  for (const [index, one] of quieter.entries()) {
    const route = routeOf(one)
    if (route === undefined) continue
    if ((room -= byteLen(route)) < 0) return { svg: open + history.join('') + close, hidden: quieter.length - index, key }
    history.push(route)
  }
  return { svg: open + history.join('') + close, hidden: 0, key }
}
