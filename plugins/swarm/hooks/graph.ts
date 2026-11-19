import { statusCss } from './palette'
import type { Post, Swarm } from '../types'

const BROADCAST = /(?<![\w.@/])@all(?![\w-])/i
const named = (text: string, name: string) =>
  new RegExp(`(?<![\\w.@/])@${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'i').test(text)

/** True when the post addresses `@all`: the members it does not also name are reached through that alone. */
export const isBroadcast = (post: Post) => BROADCAST.test(post.text)
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

const WIDTH = 560
const PILL_HEIGHT = 38
const LEGEND = 50

export function graphHeight(columns: number, memberCount: number): number {
  // The desktop clamps the frame width to the actual slot. Columns estimate
  // its height only, so a change in font metrics cannot narrow the frame.
  return Math.max(200, Math.min(540, Math.round(columns * (memberCount > 6 ? 6.75 : 5.95))))
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
  // Members whose only posts are older than the ones kept still took part.
  const participants = new Set<string>(earlier.flatMap(([edge]) => pairOf(edge) ?? [edge.split('>')[0] ?? '']))
  for (const post of swarm.posts) {
    if (post.seq > upTo) break
    participants.add(post.agent)
    for (const recipient of post.to) participants.add(recipient)
  }
  const members = swarm.members.filter(member =>
    !hidden.has(member.name) && (live || participants.has(member.name)),
  )
  const height = swarm.members.length > 6 ? 404 : 330
  const coordinator = swarm.members.find(member => member.role === 'coordinator')
  const outerMembers = swarm.members.filter(member => member !== coordinator)
  const halfOf = (name: string) => Math.max(38, 22 + Math.min(15, name.length) * 4.7)
  const centerHalf = coordinator ? halfOf(coordinator.name) : 0
  const positions = new Map(swarm.members.map(member => {
    const label = member.name.length > 15 ? `${member.name.slice(0, 14)}…` : member.name
    const half = halfOf(member.name)
    const index = outerMembers.indexOf(member)
    const angle = -Math.PI / 2 + (2 * Math.PI * index) / Math.max(1, outerMembers.length)
    const isCenter = member === coordinator || (coordinator === undefined && swarm.members.length === 1)
    let x = isCenter ? WIDTH / 2 : WIDTH / 2 + (WIDTH / 2 - 94) * Math.cos(angle)
    const y = isCenter ? height / 2 : height / 2 + (height / 2 - 36) * Math.sin(angle)
    // A member level with the coordinator would sit against its side with no room for an arrow:
    // it moves out to the frame's edge.
    if (!isCenter && coordinator && Math.abs(y - height / 2) < PILL_HEIGHT + 18 && Math.abs(x - WIDTH / 2) - half - centerHalf < 64) {
      x = x < WIDTH / 2 ? half + 6 : WIDTH - half - 6
    }
    return [member.name, { label, half, x, y }] as const
  }))
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
  const isCurrentBroadcast = current !== undefined && isBroadcast(current)
  // Solid for mentions by name. What reached a member through @all is a dashed line of its own, drawn only
  // when asked for; where the two members also named each other it runs beside the solid one.
  const edges = [
    ...[...direct].map(([edge, total]) => ({ edge, total, isDashed: false })),
    ...(expandAll ? [...broadcastTo].map(([edge, total]) => ({ edge, total, isDashed: true })) : []),
  ]
  const drawn = new Set(edges.map(({ edge }) => edge))

  const center = coordinator && positions.get(coordinator.name)
  const history: string[] = []
  const active: string[] = []
  const badges: string[] = []
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
    // Two members that address each other get a lens of two curves; a one-way line is nearly straight.
    const isMutual = drawn.has(`${to}>${from}`)
    const beside = isDashed && direct.has(edge) ? 20 : 0
    const bow = (isMutual ? Math.max(16, Math.min(length * 0.16, 36)) : Math.min(length * 0.07, 14)) + beside
    let cx = (a.x + b.x) / 2 - uy * bow
    let cy = (a.y + b.y) / 2 + ux * bow
    // Where a line from a pill's center towards (tx, ty) leaves the pill, a little clear of its border.
    const leave = (p: { x: number; y: number; half: number }, tx: number, ty: number, gap: number) => {
      const span = Math.hypot(tx - p.x, ty - p.y) || 1
      const vx = (tx - p.x) / span
      const vy = (ty - p.y) / span
      const reach = Math.min(p.half / Math.abs(vx || 1e-9), (PILL_HEIGHT / 2) / Math.abs(vy || 1e-9)) + gap
      return [p.x + vx * reach, p.y + vy * reach] as const
    }
    let [x1, y1] = leave(a, cx, cy, 3)
    let [x2, y2] = leave(b, cx, cy, 4)
    if (center && from !== coordinator?.name && to !== coordinator?.name) {
      // Route peer-to-peer messages around the coordinator so packets stay visible.
      const crossesCenter = (controlX: number, controlY: number, sx: number, sy: number, ex: number, ey: number) =>
        Array.from({ length: 19 }, (_, index) => (index + 1) / 20).some(t => {
          const x = (1 - t) ** 2 * sx + 2 * (1 - t) * t * controlX + t ** 2 * ex
          const y = (1 - t) ** 2 * sy + 2 * (1 - t) * t * controlY + t ** 2 * ey
          return Math.abs(x - center.x) < center.half + 8 && Math.abs(y - center.y) < PILL_HEIGHT / 2 + 8
        })
      for (const offset of [bow, -bow, 90, -90, 150, -150, 220, -220]) {
        const candidateX = Math.max(8, Math.min(WIDTH - 8, (a.x + b.x) / 2 - uy * offset))
        const candidateY = Math.max(8, Math.min(height - 8, (a.y + b.y) / 2 + ux * offset))
        const [sx, sy] = leave(a, candidateX, candidateY, 3)
        const [ex, ey] = leave(b, candidateX, candidateY, 4)
        if (!crossesCenter(candidateX, candidateY, sx, sy, ex, ey)) {
          cx = candidateX
          cy = candidateY
          x1 = sx; y1 = sy; x2 = ex; y2 = ey
          break
        }
      }
    }
    const isCurrent = current?.agent === from && current.to.includes(to) && viaAll(current, to) === isDashed
    const weight = weightOf(total)
    // The head is drawn by hand so it sits on the pill's border, turned the way the curve arrives, and the
    // line stops at its base instead of showing through its tip.
    const head = (isCurrent ? 9 : 6.5) + weight * 1.3
    const tangent = Math.hypot(x2 - cx, y2 - cy) || 1
    const tx = (x2 - cx) / tangent
    const ty = (y2 - cy) / tangent
    const bx = x2 - tx * head
    const by = y2 - ty * head
    const wing = head * 0.46
    const tip = `M${n1(x2)} ${n1(y2)}L${n1(bx - ty * wing)} ${n1(by + tx * wing)}L${n1(bx + ty * wing)} ${n1(by - tx * wing)}z`
    const d = `M${n1(x1)} ${n1(y1)} Q${n1(cx)} ${n1(cy)} ${n1(bx + tx)} ${n1(by + ty)}`
    const description = `<title>${esc(from)} to ${esc(to)} · ` +
      (isDashed ? `${total} via @all` : `${total} ${total === 1 ? 'mention' : 'mentions'}`) + '</title>'
    if (!isCurrent) {
      history.push(
        `<path class="edge${isDashed ? ' via-all' : ''}" d="${d}" stroke-width="${n1(weight)}">${description}</path>` +
        `<path class="tip" d="${tip}"/>`)
      continue
    }

    const draw = '<animate attributeName="stroke-dashoffset" from="100" to="0" dur="0.8s" calcMode="spline" keyTimes="0;1" keySplines=".22 .61 .36 1" fill="freeze"/>'
    active.push(`<path class="route-base" d="${d}" stroke-width="${n1(weight + 4)}">${description}</path>`)
    if (animate) active.push(`<path class="route reduced-route${isDashed ? ' via-all' : ''}" d="${d}" stroke-width="${n1(weight + 0.9)}">${description}</path>`)
    // A dashed line cannot also be drawn on by its dashes, so it fades in instead.
    active.push(isDashed
      ? `<path class="route via-all${animate ? ' motion' : ''}" d="${d}" stroke-width="${n1(weight + 0.9)}"${animate ? ' opacity="0"' : ''}>${description}` +
        (animate ? '<animate attributeName="opacity" from="0" to="1" dur="0.5s" fill="freeze"/>' : '') + '</path>'
      : `<path class="route${animate ? ' motion-route' : ''}" d="${d}" pathLength="100" stroke-width="${n1(weight + 0.9)}"${animate ? ' stroke-dashoffset="100"' : ''}>${description}` +
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
      const short = Math.hypot(x2 - x1, y2 - y1) < 64
      const side = Math.hypot(cx - (x1 + x2) / 2, cy - (y1 + y2) / 2) > 1 ? 1 : -1
      const x = (x1 + 2 * cx + x2) / 4 + (short ? -uy * 15 * side : 0)
      const y = (y1 + 2 * cy + y2) / 4 + (short ? ux * 15 * side : 0)
      badges.push(
        `<g transform="translate(${n1(x)} ${n1(y)})">` +
        `<circle class="badge" r="10"/><text class="count" y="0" dy=".35em">${total}</text></g>`,
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
    // An @all post is not drawn as a line to everyone unless asked: rings leave its sender instead.
    const ripple = moving && sender && isCurrentBroadcast && !expandAll
      ? [0, 0.28].map(delay =>
        `<circle class="motion ripple" r="24" opacity="0">` +
        (repeat
          ? `<animate attributeName="r" values="24;150;150" keyTimes="0;.3;1" begin="${Math.round(delay * 1000) - phase}ms" dur="3.6s" repeatCount="indefinite"/>` +
            `<animate attributeName="opacity" values=".5;0;0" keyTimes="0;.3;1" begin="${Math.round(delay * 1000) - phase}ms" dur="3.6s" repeatCount="indefinite"/>`
          : `<animate attributeName="r" from="24" to="150" begin="${delay}s" dur="1.1s" calcMode="spline" keyTimes="0;1" keySplines=".22 .61 .36 1"/>` +
            `<animate attributeName="opacity" from=".5" to="0" begin="${delay}s" dur="1.1s"/>`) +
        '</circle>').join('')
      : ''
    const chip = sent > 0
      ? `<g class="chip${sender && isCurrentBroadcast ? ' on' : ''}" transform="translate(${n1(p.half - 20)} ${-PILL_HEIGHT / 2})">` +
        `<rect x="-23" y="-8" width="46" height="16" rx="8"/><text dy=".35em">@all ${sent}</text></g>`
      : ''
    return (
      `<g transform="translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})"${status === 'killed' ? ' opacity=".5"' : ''}>` +
      `<title>${esc(title)}</title>` + ripple + `<rect class="pill${emphasis}${silent > 0 ? ' quiet' : ''}" ${rect}/>` +
      arrival +
      (live ? `<circle class="presence ${esc(status.replace(/\s+/g, '-'))}" cx="${-p.half + 14}" r="3.7"/>` : '') +
      `<text class="name" x="${live ? 7 : 0}" dy=".35em">${esc(p.label)}</text>` + chip + '</g>'
    )
  })

  // The key under the diagram is drawn with the diagram's own classes, so it cannot say one thing and the lines another.
  const row = height + 16
  const legend =
    `<g class="legend"><path class="edge" d="M16 ${row}H40" stroke-width="2.4"/><path class="tip" d="M48 ${row}l-9 -4.2v8.4z"/>` +
    `<text x="56" y="${row}" dy=".35em">@mention, width = count</text>` +
    `<path class="edge via-all" d="M224 ${row}H248" stroke-width="1.6"/><path class="tip" d="M256 ${row}l-9 -4.2v8.4z"/>` +
    `<text x="264" y="${row}" dy=".35em">via @all</text>` +
    `<rect class="pill quiet" x="336" y="${row - 7}" width="26" height="14" rx="6"/>` +
    `<text x="370" y="${row}" dy=".35em">posted with no mention</text>` +
    `<g class="chip" transform="translate(39 ${row + 22})"><rect x="-23" y="-8" width="46" height="16" rx="8"/><text dy=".35em">@all ${allPosts}</text></g>` +
    `<text x="70" y="${row + 22}" dy=".35em">${allPosts === 0 ? 'no @all posts yet' : expandAll ? '@all posts, drawn as dashed arrows' : '@all posts, drawn by Expand @all'}</text></g>`

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${height + LEGEND}" width="100%" height="100%" font-family="system-ui, sans-serif">` +
    `<style>
      svg{--edge:#596375;--pill:#f8f8f7;--border:#a1a9b5;--ink:#252628;--accent:#235fc4;--tint:#eaf2ff;--packet:#fff}
      @media (prefers-color-scheme: dark){svg{--edge:#9399a5;--pill:#242424;--border:#666b73;--ink:#f1f1ef;--accent:#8fb8ff;--tint:#243750;--packet:#fff}}
      @supports(color:color(display-p3 1 0 0)){
        svg{--edge:color(display-p3 .35 .39 .46);--pill:color(display-p3 .97 .97 .965);--border:color(display-p3 .63 .66 .70);--ink:color(display-p3 .15 .15 .16);--accent:color(display-p3 .18 .37 .79);--tint:color(display-p3 .92 .95 1);--packet:color(display-p3 1 1 1)}
        @media(prefers-color-scheme:dark){svg{--edge:color(display-p3 .58 .60 .64);--pill:color(display-p3 .14 .14 .14);--border:color(display-p3 .40 .42 .45);--ink:color(display-p3 .95 .95 .94);--accent:color(display-p3 .57 .73 1);--tint:color(display-p3 .15 .22 .31)}}
      }
      .edge,.route,.route-base{fill:none;stroke-linecap:round}
      .edge{stroke:var(--edge);opacity:.5}.tip{fill:var(--edge);opacity:.72}
      .via-all{stroke-dasharray:6 5;stroke-linecap:butt}
      .route-base{stroke:var(--accent);opacity:.13}
      .route{stroke:var(--accent)}.motion-route{stroke-dasharray:100 100}.tip-current{fill:var(--accent)}
      .packet-halo{fill:var(--accent)}.packet{fill:var(--packet);stroke:var(--accent);stroke-width:1.5}
      .pill{fill:var(--pill);stroke:var(--border)}.sender{fill:var(--tint);stroke:var(--accent);stroke-width:1.8}.recipient{stroke:var(--accent);stroke-width:1.5}
      .quiet{stroke-dasharray:5 4}
      .arrival,.ripple{fill:none;stroke:var(--accent)}.arrival{stroke-width:4}.ripple{stroke-width:2}
      .name,.count{fill:var(--ink);text-anchor:middle;font-weight:600}.name{font-size:16px}.count{font-size:12px}
      .badge{fill:var(--tint);stroke:var(--accent)}
      .chip rect{fill:var(--pill);stroke:var(--border)}.chip text{fill:var(--ink);opacity:.82;font-size:10.5px;font-weight:600;text-anchor:middle}
      .chip.on rect{fill:var(--tint);stroke:var(--accent)}
      .legend>text{fill:var(--ink);opacity:.62;font-size:12px}
      .presence{fill:none;stroke:var(--edge);stroke-width:1.3}
      ${statusCss}
      .presence{stroke:var(--status-inactive)}
      ${['working', 'coordinating', 'waiting','failed','unreachable'].map(status => `.presence.${status}{fill:var(--status-${status === 'unreachable' ? 'failed' : status});stroke:none}`).join('')}
      .reduced-route{display:none}
      @media (prefers-reduced-motion: reduce){.motion,.motion-route{display:none}.reduced-route{display:inline}}
    </style>
    ` +
    history.join('') + active.join('') + badges.join('') + nodes.join('') + legend +
    '</svg>'
  )
}
