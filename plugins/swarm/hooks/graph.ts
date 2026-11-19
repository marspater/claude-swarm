import { statusCss, statusKey } from './palette'
import { head as clipHead } from './text'
import type { Post, Swarm } from '../types'

const stripCode = (text: string) =>
  text.replace(/```[\s\S]*?```|(`+)[^\n]*?\1/g, ' ')
const BROADCAST = /(?<![\w.@/])@all[-_]*(?![\w-])/i
const named = (text: string, name: string) =>
  new RegExp(`(?<![\\w.@/])@${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[-_]*(?![\\w-])`, 'i').test(stripCode(text))

/** True when the post addresses `@all`: the members it does not also name are reached through that alone. */
export const isBroadcast = (post: Post) => BROADCAST.test(stripCode(post.text))
const viaAll = (post: Post, to: string) => isBroadcast(post) && !named(post.text, to)

/**
 * How often each member addressed each other, keyed `from>to`. A recipient reached only through `@all` is
 * counted under `from>to>all` instead. `from>@all` counts the sender's `@all` posts and `from>@none` its
 * posts that mention nobody: neither names a member.
 */
export function edgesOf(posts: Post[]): Record<string, number> {
  const counts: Record<string, number> = {}
  const add = (key: string) => { counts[key] = (counts[key] ?? 0) + 1 }
  for (const post of posts) {
    if (isBroadcast(post)) add(`${post.agent}>@all`)
    if (post.to.length === 0) add(`${post.agent}>@none`)
    for (const to of post.to) add(viaAll(post, to) ? `${post.agent}>${to}>all` : `${post.agent}>${to}`)
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

// Past this many members round the coordinator the ring gives way to two arcs, one name to a row.
const RING_LIMIT = 10
const SIDE_PITCH = PILL_HEIGHT + 12
const halfOf = (name: string) => Math.max(38, 22 + Math.min(15, name.length) * 4.7)
const CURVE_SAMPLES = Array.from({ length: 23 }, (_, index) => (index + 1) / 24)

/** Signed distance from (x, y) to a pill's rounded rectangle (corner radius 13). */
function pillDist(x: number, y: number, pill: { x: number; y: number; half: number }): number {
  const qx = Math.abs(x - pill.x) - (pill.half - 13)
  const qy = Math.abs(y - pill.y) - (PILL_HEIGHT / 2 - 13)
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - 13
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
  const phase = elapsed % 3600
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
    if (isBroadcast(post)) bump(broadcasts, post.agent)
    if (post.to.length === 0) bump(unaddressed, post.agent)
    for (const to of post.to) bump(viaAll(post, to) ? broadcastTo : direct, `${post.agent}>${to}`)
  }

  const { coordinator, outerMembers, width, height, place } = stageOf(members, direct)
  const centerHalf = coordinator ? halfOf(coordinator.name) : 0
  const outerIndex = new Map(outerMembers.map((member, index) => [member.name, index]))
  const positions = new Map(members.map(member => {
    const label = member.name.length > 15 ? `${clipHead(member.name, 14)}…` : member.name
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
  const edges = [
    ...[...direct].map(([edge, total]) => ({ edge, total, isDashed: false })),
    ...(expandAll ? [...broadcastTo].map(([edge, total]) => ({ edge, total, isDashed: true })) : []),
  ]
  const drawn = new Set(edges.map(({ edge }) => edge))

  const history: string[] = []
  const active: string[] = []
  const badges: string[] = []
  const ripples: string[] = []
  const outerCount = outerMembers.length
  const pad = outerCount <= 6 ? 8 : 4.5
  for (const { edge, total, isDashed } of edges) {
    const [from = '', to = ''] = edge.split('>')
    if (from === to || !visible.has(from) || !visible.has(to)) continue
    const a = positions.get(from)
    const b = positions.get(to)
    if (!a || !b) continue
    const dx = b.x - a.x
    const dy = b.y - a.y
    if (dx === 0 && dy === 0) continue  // two members on one spot have no direction to draw
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
    let [cx, cy, x1, y1, x2, y2] = chordBow(baseBow)
    const isForward = (controlX: number, controlY: number, ex: number, ey: number) =>
      (ex - controlX) * (b.x - ex) + (ey - controlY) * (b.y - ey) > 0
    const obstacles = members.filter(m => m.name !== from && m.name !== to).map(m => positions.get(m.name)!).filter(Boolean)
    const minClearance = (controlX: number, controlY: number, sx: number, sy: number, ex: number, ey: number) => {
      let min = Infinity
      for (const t of CURVE_SAMPLES) {
        const x = (1 - t) ** 2 * sx + 2 * (1 - t) * t * controlX + t ** 2 * ex
        const y = (1 - t) ** 2 * sy + 2 * (1 - t) * t * controlY + t ** 2 * ey
        for (const o of obstacles) {
          const dist = pillDist(x, y, o)
          if (dist < min) min = dist
        }
      }
      return min
    }
    const initialForward = isForward(cx, cy, x2, y2)
    if (!initialForward || (obstacles.length > 0 && minClearance(cx, cy, x1, y1, x2, y2) < pad)) {
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
        const clear = obstacles.length > 0 ? minClearance(candX, candY, sx, sy, ex, ey) : Infinity
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
          const clear = obstacles.length > 0 ? minClearance(candX, candY, sx, sy, ex, ey) : Infinity
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
    const isCurrent = current?.agent === from && current.to.includes(to) && viaAll(current, to) === isDashed
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
    if (!isCurrent) {
      history.push(
        `<g class="history-edge"><path class="edge${isDashed ? ' via-all' : ''}" d="${dHistory}" stroke-width="${n1(weight)}">${description}</path>` +
        `<path class="tip" d="${tip}"/></g>`)
      continue
    }

    const draw = '<animate attributeName="stroke-dashoffset" from="102" to="0" dur="0.8s" calcMode="spline" keyTimes="0;1" keySplines=".22 .61 .36 1" fill="freeze"/>'
    active.push(`<path class="route-base" d="${d}" stroke-width="${n1(weight + 4)}">${description}</path>`)
    if (animate) active.push(`<path class="route reduced-route${isDashed ? ' via-all' : ''}" d="${d}" stroke-width="${n1(weight + 0.9)}">${description}</path>`)
    // A dashed line cannot also be drawn on by its dashes, so it fades in instead.
    active.push(isDashed
      ? `<path class="route via-all${animate ? ' motion' : ''}" d="${d}" stroke-width="${n1(weight + 0.9)}"${animate ? ' opacity="0"' : ''}>${description}` +
        (animate ? '<animate attributeName="opacity" from="0" to="1" dur="0.65s" calcMode="spline" keyTimes="0;1" keySplines=".22 .61 .36 1" fill="freeze"/>' : '') + '</path>'
      : `<path class="route${animate ? ' motion-route' : ''}" d="${d}" pathLength="100" stroke-width="${n1(weight + 0.9)}"${animate ? ' stroke-dashoffset="102"' : ''}>${description}` +
        (animate ? draw : '') + '</path>')
    // The head lands when the line reaches it, not before.
    active.push(animate
      ? `<path class="tip-current motion" d="${tip}" opacity="0"><animate attributeName="opacity" values="0;0;1" keyTimes="0;.72;1" dur="0.8s" fill="freeze"/></path>` +
        `<path class="tip-current reduced-route" d="${tip}"/>`
      : `<path class="tip-current" d="${tip}"/>`)
    if (animate || repeat) {
      const route = `M${n1(x1)} ${n1(y1)} Q${n1(cx)} ${n1(cy)} ${n1(x2)} ${n1(y2)}`
      const motion = repeat
        ? `<animateMotion begin="-${phase}ms" dur="3.6s" path="${route}" calcMode="spline" keyPoints="0;1;1" keyTimes="0;.24;1" keySplines=".22 .61 .36 1;0 0 1 1" repeatCount="indefinite"/>`
        : `<animateMotion dur="0.86s" path="${route}" calcMode="spline" keyPoints="0;1" keyTimes="0;1" keySplines=".22 .61 .36 1" fill="freeze"/>`
      const opacity = (peak: string) => repeat
        ? `<animate attributeName="opacity" values="0;${peak};${peak};0;0" keyTimes="0;.025;.19;.265;1" begin="-${phase}ms" dur="3.6s" repeatCount="indefinite"/>`
        : `<animate attributeName="opacity" values="0;${peak};${peak};0" keyTimes="0;.1;.8;1" dur="0.95s"/>`
      active.push(
        '<circle class="motion packet-halo" r="7" opacity="0">' +
        motion + opacity('.35') + '</circle>' +
        '<circle class="motion packet" r="3.5" opacity="0">' +
        motion + opacity('1') + '</circle>',
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
  }

  const allPosts = [...broadcasts.values()].reduce((sum, count) => sum + count, 0)
  const pulse = (beginMs: number) => repeat
    ? `<animate attributeName="opacity" values="0;.65;0;0" keyTimes="0;.027;.12;1" begin="${beginMs - phase}ms" dur="3.6s" repeatCount="indefinite"/>`
    : `<animate attributeName="opacity" values="0;.65;0" keyTimes="0;.22;1" begin="${beginMs / 1000}s" dur=".44s"/>`
  const nodes = members.map(member => {
    const p = positions.get(member.name)!
    const sender = current?.agent === member.name
    const recipient = current?.to.includes(member.name)
    const status = live ? member.status : ''
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
      ? `<rect class="motion arrival" ${rect} opacity="0">${pulse(recipient ? 760 : 0)}</rect>`
      : ''
    if (moving && sender && isCurrentBroadcast && !expandAll) {
      ripples.push(
        `<g transform="translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})">` +
        [0, 0.22].map(delay =>
          `<circle class="motion ripple" r="24" opacity="0">` +
          (repeat
            ? `<animate attributeName="r" values="24;150;150" keyTimes="0;.3;1" calcMode="spline" keySplines=".22 .61 .36 1;0 0 1 1" begin="${Math.round(delay * 1000) - phase}ms" dur="3.6s" repeatCount="indefinite"/>` +
              `<animate attributeName="opacity" values=".5;0;0" keyTimes="0;.3;1" begin="${Math.round(delay * 1000) - phase}ms" dur="3.6s" repeatCount="indefinite"/>`
            : `<animate attributeName="r" from="24" to="150" begin="${delay}s" dur="0.9s" calcMode="spline" keyTimes="0;1" keySplines=".22 .61 .36 1"/>` +
              `<animate attributeName="opacity" from=".5" to="0" begin="${delay}s" dur="0.9s"/>`) +
          '</circle>').join('') +
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
    const dot = !live ? ''
      : skey === 'working' ? `<circle class="presence working" cx="${px}" r="3.7"/>`
      : skey === 'waiting' ? `<circle class="presence-ring waiting" cx="${px}" r="3.1"/><circle class="presence waiting" cx="${px}" r="1.4"/>`
      : skey === 'coordinating' ? `<path class="presence coordinating" d="M${px} -4L${px + 4} 0 ${px} 4 ${px - 4} 0z"/>`
      : skey === 'failed' ? `<path class="presence-x ${scls}" d="M${px - 2.6} -2.6L${px + 2.6} 2.6M${px + 2.6} -2.6L${px - 2.6} 2.6"/>`
      : `<circle class="presence ${scls}" cx="${px}" r="3.1"/>`
    return (
      `<g transform="translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})"${status === 'killed' ? ' class="killed"' : ''}>` +
      `<title>${esc(title)}</title><rect class="pill${emphasis}${silent > 0 ? ' quiet' : ''}" ${rect}/>` +
      arrival + dot +
      `<text class="name" x="${live ? 7 : 0}" dy=".35em">${esc(p.label)}</text>` + chip + '</g>'
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

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height + LEGEND}" width="100%" height="100%" font-family="system-ui, sans-serif">` +
    `<defs><clipPath id="stage"><rect width="${width}" height="${height}"/></clipPath></defs>` +
    `<style>
      svg{--edge:#596375;--pill:#f8f8f7;--border:#87909d;--ink:#252628;--accent:#235fc4;--tint:#eaf2ff;--packet:#fff}
      @media (prefers-color-scheme: dark){svg{--edge:#9399a5;--pill:#242424;--border:#737982;--ink:#f1f1ef;--accent:#8fb8ff;--tint:#243750;--packet:#fff}}
      @supports(color:color(display-p3 1 0 0)){
        svg{--edge:color(display-p3 .35 .39 .46);--pill:color(display-p3 .97 .97 .965);--border:color(display-p3 .53 .56 .61);--ink:color(display-p3 .15 .15 .16);--accent:color(display-p3 .2033 .3675 .7427);--tint:color(display-p3 .92 .95 1);--packet:color(display-p3 1 1 1)}
        @media(prefers-color-scheme:dark){svg{--edge:color(display-p3 .58 .60 .64);--pill:color(display-p3 .14 .14 .14);--border:color(display-p3 .45 .47 .51);--ink:color(display-p3 .95 .95 .94);--accent:color(display-p3 .5935 .7170 .9777);--tint:color(display-p3 .15 .22 .31)}}
      }
      .edge,.route,.route-base{fill:none;stroke-linecap:round}
      .history-edge{opacity:.72}.edge{stroke:var(--edge)}.tip{fill:var(--edge)}
      .via-all{stroke-dasharray:6 5;stroke-linecap:butt}
      .route-base{stroke:var(--accent);opacity:.13}
      .route{stroke:var(--accent)}.motion-route{stroke-dasharray:102 102}.tip-current{fill:var(--accent)}
      .packet-halo{fill:var(--accent)}.packet{fill:var(--packet);stroke:var(--accent);stroke-width:1.5}
      .pill{fill:var(--pill);stroke:var(--border)}.sender{fill:var(--tint);stroke:var(--accent);stroke-width:1.8}.recipient{stroke:var(--accent);stroke-width:1.5}
      .quiet{stroke-dasharray:5 4}.killed .pill{stroke-dasharray:2 3}.killed .name{opacity:.68;text-decoration:line-through}
      .arrival,.ripple{fill:none;stroke:var(--accent)}.arrival{stroke-width:4}.ripple{stroke-width:2}
      .name,.count{fill:var(--ink);text-anchor:middle;font-weight:600}.name{font-size:14px}.count{font-size:12px}
      .badge{fill:var(--tint);stroke:var(--accent)}
      .chip rect{fill:var(--pill);stroke:var(--border)}.chip text{fill:var(--ink);opacity:.82;font-size:10.5px;font-weight:600;text-anchor:middle}
      .chip.on rect{fill:var(--tint);stroke:var(--accent)}
      .legend>text{fill:var(--ink);opacity:.72;font-size:12px}
      ${statusCss}
      .presence{fill:none;stroke:var(--status-inactive);stroke-width:1.2}
      .presence-ring{fill:none;stroke:var(--status-waiting);stroke-width:1.2}
      .presence-x{fill:none;stroke:var(--status-failed);stroke-width:1.6;stroke-linecap:round}
      ${['working', 'coordinating', 'waiting'].map(status => `.presence.${status}{fill:var(--status-${status});stroke:none}`).join('')}
      .reduced-route{display:none}
      @media (prefers-reduced-motion: reduce){.motion,.motion-route{display:none}.reduced-route{display:inline}}
    </style>
    ` +
    `<g clip-path="url(#stage)">${ripples.join('')}</g>` +
    history.join('') + active.join('') + nodes.join('') + badges.join('') +
    `<line x1="16" y1="${height}" x2="${width - 16}" y2="${height}" stroke="var(--border)" opacity=".35"/>` +
    legend +
    '</svg>'
  )
}
