import { statusCss } from './palette'
import type { Post, Swarm } from '../types'

/** How often each member addressed each other, keyed `from>to`. */
export function edgesOf(posts: Post[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const post of posts) for (const to of post.to) counts[`${post.agent}>${to}`] = (counts[`${post.agent}>${to}`] ?? 0) + 1
  return counts
}

const WIDTH = 560
const PILL_HEIGHT = 38

export function graphHeight(columns: number, memberCount: number): number {
  // The desktop clamps the frame width to the actual slot. Columns estimate
  // its height only, so a change in font metrics cannot narrow the frame.
  return Math.max(180, Math.min(480, Math.round(columns * (memberCount > 6 ? 6 : 5.15))))
}

const esc = (text: string) =>
  text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)

export function graphSvg(
  swarm: Swarm,
  upTo: number,
  hidden: ReadonlySet<string>,
  animate: boolean,
  live: boolean,
  repeat = false,
): string {
  const current = swarm.posts.find(post => post.seq === upTo)
  // Members whose only posts are older than the ones kept still took part.
  const participants = new Set<string>(Object.keys(swarm.earlierEdges ?? {}).flatMap(edge => edge.split('>')))
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
  const positions = new Map(swarm.members.map(member => {
    const label = member.name.length > 15 ? `${member.name.slice(0, 14)}…` : member.name
    const half = Math.max(38, 22 + label.length * 4.7)
    const index = outerMembers.indexOf(member)
    const angle = -Math.PI / 2 + (2 * Math.PI * index) / Math.max(1, outerMembers.length)
    return [member.name, {
      label,
      half,
      x: member === coordinator || (coordinator === undefined && swarm.members.length === 1)
        ? WIDTH / 2 : WIDTH / 2 + (WIDTH / 2 - 94) * Math.cos(angle),
      y: member === coordinator || (coordinator === undefined && swarm.members.length === 1)
        ? height / 2 : height / 2 + (height / 2 - 36) * Math.sin(angle),
    }] as const
  }))
  const visible = new Set(members.map(member => member.name))

  // Posts older than the ones kept still count: the pane keeps their totals, not their text.
  const counts = new Map<string, number>(Object.entries(swarm.earlierEdges ?? {}))
  for (const post of swarm.posts) {
    if (post.seq > upTo) break
    for (const to of post.to) {
      if (!visible.has(post.agent) || !visible.has(to)) continue
      const edge = `${post.agent}>${to}`
      counts.set(edge, (counts.get(edge) ?? 0) + 1)
    }
  }

  const history: string[] = []
  const active: string[] = []
  const badges: string[] = []
  for (const [edge, count] of counts) {
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
    const inset = (half: number) => Math.min(
      half / Math.abs(ux),
      (PILL_HEIGHT / 2) / Math.abs(uy),
    ) + 4
    const x1 = a.x + ux * inset(a.half)
    const y1 = a.y + uy * inset(a.half)
    const x2 = b.x - ux * inset(b.half)
    const y2 = b.y - uy * inset(b.half)
    const bow = Math.min(length * 0.18, 42)
    let cx = (x1 + x2) / 2 - uy * bow
    let cy = (y1 + y2) / 2 + ux * bow
    const center = coordinator && positions.get(coordinator.name)
    if (center && from !== coordinator?.name && to !== coordinator?.name) {
      // Route peer-to-peer messages around the coordinator so packets stay visible.
      const crossesCenter = (controlX: number, controlY: number) =>
        Array.from({ length: 19 }, (_, index) => (index + 1) / 20).some(t => {
          const x = (1 - t) ** 2 * x1 + 2 * (1 - t) * t * controlX + t ** 2 * x2
          const y = (1 - t) ** 2 * y1 + 2 * (1 - t) * t * controlY + t ** 2 * y2
          return Math.abs(x - center.x) < center.half + 8 && Math.abs(y - center.y) < PILL_HEIGHT / 2 + 8
        })
      for (const offset of [bow, -bow, 90, -90, 150, -150, 220, -220]) {
        const candidateX = Math.max(8, Math.min(WIDTH - 8, (x1 + x2) / 2 - uy * offset))
        const candidateY = Math.max(8, Math.min(height - 8, (y1 + y2) / 2 + ux * offset))
        if (!crossesCenter(candidateX, candidateY)) {
          cx = candidateX
          cy = candidateY
          break
        }
      }
    }
    const d = `M${x1.toFixed(1)} ${y1.toFixed(1)} Q${cx.toFixed(1)} ${cy.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`
    const isCurrent = current?.agent === from && current.to.includes(to)
    const weight = Math.min(3, 1.25 + 0.45 * Math.log2(count))
    const description = `<title>${esc(from)} to ${esc(to)} · ${count} ${count === 1 ? 'mention' : 'mentions'}</title>`
    if (!isCurrent) {
      history.push(`<path class="edge" d="${d}" stroke-width="${weight}" marker-end="url(#tip)">${description}</path>`)
      continue
    }

    active.push(`<path class="route-base" d="${d}">${description}</path>`)
    if (animate) active.push(`<path class="route reduced-route" d="${d}" marker-end="url(#tip-current)">${description}</path>`)
    active.push(`<path class="route${animate ? ' motion-route' : ''}" d="${d}" pathLength="100"${animate ? ' stroke-dashoffset="100"' : ''} marker-end="url(#tip-current)">${description}` +
      (animate ? '<animate attributeName="stroke-dashoffset" from="100" to="0" dur="0.86s" calcMode="spline" keyTimes="0;1" keySplines=".22 .61 .36 1" fill="freeze"/>' : '') +
      '</path>')
    if (animate || repeat) {
      const motion = repeat
        ? `<animateMotion dur="3.6s" path="${d}" calcMode="spline" keyPoints="0;1;1" keyTimes="0;.24;1" keySplines=".22 .61 .36 1;0 0 1 1" repeatCount="indefinite"/>`
        : `<animateMotion dur="0.86s" path="${d}" calcMode="spline" keyPoints="0;1" keyTimes="0;1" keySplines=".22 .61 .36 1" fill="freeze"/>`
      const opacity = (peak: string) => repeat
        ? `<animate attributeName="opacity" values="0;${peak};${peak};0;0" keyTimes="0;.025;.19;.265;1" dur="3.6s" repeatCount="indefinite"/>`
        : `<animate attributeName="opacity" values="0;${peak};${peak};0" keyTimes="0;.1;.8;1" dur="0.95s"/>`
      active.push(
        '<circle class="motion packet-halo" r="7" opacity="0">' +
        motion + opacity('.35') + '</circle>' +
        '<circle class="motion packet" r="3.5" opacity="0">' +
        motion + opacity('1') + '</circle>',
      )
    }
    if (count > 1 && (current?.to.length ?? 0) <= 3) {
      const x = (x1 + 2 * cx + x2) / 4
      const y = (y1 + 2 * cy + y2) / 4
      badges.push(
        `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)})">` +
        `<circle class="badge" r="10"/><text class="count" y="0" dy=".35em">${count}</text></g>`,
      )
    }
  }

  const nodes = members.map(member => {
    const p = positions.get(member.name)!
    const sender = current?.agent === member.name
    const recipient = current?.to.includes(member.name)
    const status = live ? member.status : ''
    const title = status ? `${member.name} · ${status}` : member.name
    const emphasis = sender ? ' sender' : recipient ? ' recipient' : ''
    const rect = `x="${-p.half}" y="${-PILL_HEIGHT / 2}" width="${p.half * 2}" height="${PILL_HEIGHT}" rx="13"`
    const arrival = recipient && (animate || repeat)
      ? `<rect class="motion arrival" ${rect} opacity="0">` +
        (repeat
          ? '<animate attributeName="opacity" values="0;.65;0;0" keyTimes="0;.027;.12;1" begin=".76s" dur="3.6s" repeatCount="indefinite"/>'
          : '<animate attributeName="opacity" values="0;.65;0" keyTimes="0;.22;1" begin=".76s" dur=".44s"/>') + '</rect>'
      : ''
    return (
      `<g transform="translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})"${status === 'killed' ? ' opacity=".5"' : ''}>` +
      `<title>${esc(title)}</title><rect class="pill${emphasis}" ${rect}/>` +
      arrival +
      (live ? `<circle class="presence ${esc(status.replace(/\s+/g, '-'))}" cx="${-p.half + 14}" r="3.7"/>` : '') +
      `<text class="name" x="${live ? 7 : 0}" dy=".35em">${esc(p.label)}</text></g>`
    )
  })

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${height}" width="100%" height="100%" font-family="system-ui, sans-serif">` +
    `<style>
      svg{--edge:#596375;--pill:#f8f8f7;--border:#a1a9b5;--ink:#252628;--accent:#235fc4;--tint:#eaf2ff;--packet:#fff}
      @media (prefers-color-scheme: dark){svg{--edge:#9399a5;--pill:#242424;--border:#666b73;--ink:#f1f1ef;--accent:#8fb8ff;--tint:#243750;--packet:#fff}}
      @supports(color:color(display-p3 1 0 0)){
        svg{--edge:color(display-p3 .35 .39 .46);--pill:color(display-p3 .97 .97 .965);--border:color(display-p3 .63 .66 .70);--ink:color(display-p3 .15 .15 .16);--accent:color(display-p3 .18 .37 .79);--tint:color(display-p3 .92 .95 1);--packet:color(display-p3 1 1 1)}
        @media(prefers-color-scheme:dark){svg{--edge:color(display-p3 .58 .60 .64);--pill:color(display-p3 .14 .14 .14);--border:color(display-p3 .40 .42 .45);--ink:color(display-p3 .95 .95 .94);--accent:color(display-p3 .57 .73 1);--tint:color(display-p3 .15 .22 .31)}}
      }
      .edge,.route,.route-base{fill:none;stroke-linecap:round}
      .edge{stroke:var(--edge);opacity:.38}.tip{fill:var(--edge);opacity:.7}
      .route-base{stroke:var(--accent);stroke-width:5;opacity:.13}
      .route{stroke:var(--accent);stroke-width:2.7}.motion-route{stroke-dasharray:100 100}.tip-current{fill:var(--accent)}
      .packet-halo{fill:var(--accent)}.packet{fill:var(--packet);stroke:var(--accent);stroke-width:1.5}
      .pill{fill:var(--pill);stroke:var(--border)}.sender{fill:var(--tint);stroke:var(--accent);stroke-width:1.8}.recipient{stroke:var(--accent);stroke-width:1.5}
      .arrival{fill:none;stroke:var(--accent);stroke-width:4}
      .name,.count{fill:var(--ink);text-anchor:middle;font-weight:600}.name{font-size:16px}.count{font-size:12px}
      .badge{fill:var(--tint);stroke:var(--accent)}
      .presence{fill:none;stroke:var(--edge);stroke-width:1.3}
      ${statusCss}
      .presence{stroke:var(--status-inactive)}
      ${['working', 'coordinating', 'waiting','failed','unreachable'].map(status => `.presence.${status}{fill:var(--status-${status === 'unreachable' ? 'failed' : status});stroke:none}`).join('')}
      .reduced-route{display:none}
      @media (prefers-reduced-motion: reduce){.motion,.motion-route{display:none}.reduced-route{display:inline}}
    </style>
    <defs>
      <marker id="tip" viewBox="0 0 10 10" refX="10" refY="5" markerUnits="userSpaceOnUse" markerWidth="8" markerHeight="8" orient="auto"><path class="tip" d="M0 0L10 5L0 10z"/></marker>
      <marker id="tip-current" viewBox="0 0 10 10" refX="10" refY="5" markerUnits="userSpaceOnUse" markerWidth="11" markerHeight="11" orient="auto"><path class="tip-current" d="M0 0L10 5L0 10z"/></marker>
    </defs>
    ` +
    history.join('') + active.join('') + badges.join('') + nodes.join('') +
    '</svg>'
  )
}
