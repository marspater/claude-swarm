import { expect, test } from 'claude-code/testing'
import type { Post, Swarm } from '../types'
import { edgesOf, graphSvg, isBroadcast } from './graph'
import { statusDot } from './palette'

test('the graph counts posts the pane no longer keeps', async () => {
  const posts: Post[] = Array.from({ length: 10 }, (_, index) => ({
    seq: index + 1,
    agent: index % 2 ? 'parser' : 'coordinator',
    to: [index % 2 ? 'coordinator' : 'parser'],
    text: 'note',
    time: '2026-11-16T14:03:22+0100',
  }))
  const earlierEdges = edgesOf(posts.slice(0, -4))
  expect(earlierEdges).toEqual({ 'coordinator>parser': 3, 'parser>coordinator': 3 })
  const member = { id: undefined, profile: undefined, model: '', effort: '', depends: [], owns: '', detail: '', unread: 0, posts: 5 }
  const swarm: Swarm = {
    title: 'Long', dir: '/project/.swarm/long-20261116-101010', isClosed: false, attention: [], budget: 0, tokens: {},
    posts: posts.slice(-4), total: 10, earlierEdges,
    members: [
      { ...member, name: 'coordinator', role: 'coordinator', type: 'coordinator', status: 'waiting' },
      { ...member, name: 'parser', role: 'worker', type: 'worker', status: 'waiting' },
    ],
  }
  // five posts each way in all, although only two each way are kept
  expect(graphSvg(swarm, 10, new Set(), false, false)).toMatch(/class="count"[^>]*>5</)
  // a state stored by an older version has no totals: the kept posts are counted alone
  expect(graphSvg({ ...swarm, earlierEdges: undefined }, 10, new Set(), false, false)).toMatch(/class="count"[^>]*>2</)
})

test('the coordinator sits at the center with members around it', async () => {
  const member = { id: undefined, profile: undefined, model: '', effort: '', depends: [], owns: '', detail: '', unread: 0, posts: 1, status: 'waiting' }
  const swarm: Swarm = {
    title: 'Team', dir: '/project/.swarm/team-20261116-101010', isClosed: false, attention: [], budget: 0, tokens: {},
    total: 3, earlierEdges: {},
    posts: [
      { seq: 1, agent: 'coordinator', to: ['parser'], text: '', time: '' },
      { seq: 2, agent: 'parser', to: ['verifier'], text: '', time: '' },
      { seq: 3, agent: 'verifier', to: ['coordinator'], text: '', time: '' },
    ],
    members: [
      { ...member, name: 'parser', role: 'worker', type: 'worker' },
      { ...member, name: 'coordinator', role: 'coordinator', type: 'coordinator' },
      { ...member, name: 'verifier', role: 'worker', type: 'worker' },
    ],
  }
  const graph = graphSvg(swarm, 3, new Set(), false, true, true)
  expect(graph).toContain('<g transform="translate(280.0 165.0)"><title>coordinator')
  expect(graph).toContain('<g transform="translate(280.0 36.0)"><title>parser')
  expect(graph).toContain('<g transform="translate(280.0 294.0)"><title>verifier')
  expect(graph).toContain('parser to verifier')
  expect(graph).toContain('repeatCount="indefinite"')
  expect(graph).toContain('prefers-reduced-motion')
  const first = graphSvg(swarm, 1, new Set(), false, false)
  expect(first).toContain('<g transform="translate(280.0 36.0)"><title>parser')
  expect(first).not.toContain('<title>verifier')
  const filtered = graphSvg(swarm, 3, new Set(['verifier']), false, true)
  expect(filtered).toContain('<g transform="translate(280.0 36.0)"><title>parser')
  expect(filtered).not.toContain('parser to verifier')
  expect(graphSvg({ ...swarm, earlierEdges: { 'parser>parser': 2 } }, 3, new Set(), false, true)).not.toMatch(/NaN|Infinity/)
  const peerRoute = graph.match(/d="M([\d.]+) ([\d.]+) Q([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+)"[^>]*><title>parser to verifier/)
  expect(peerRoute).toBeDefined()
  const [x1, y1, cx, cy, x2, y2] = peerRoute!.slice(1).map(Number) as [number, number, number, number, number, number]
  for (let step = 1; step < 20; step++) {
    const t = step / 20
    const x = (1 - t) ** 2 * x1 + 2 * (1 - t) * t * cx + t ** 2 * x2
    const y = (1 - t) ** 2 * y1 + 2 * (1 - t) * t * cy + t ** 2 * y2
    expect(Math.abs(x - 280) >= 22 + 'coordinator'.length * 4.7 + 8 || Math.abs(y - 165) >= 27).toBe(true)
  }

  const single = graphSvg({ ...swarm, members: [swarm.members[0]!] }, 3, new Set(), false, true)
  expect(single).toContain('<g transform="translate(280.0 165.0)"><title>parser')
  expect(single).not.toContain('NaN')
})

test('replay keeps a member whose only posts are older than the ones kept', async () => {
  const member = { id: undefined, profile: undefined, model: '', effort: '', depends: [], owns: '', detail: '', unread: 0, posts: 1, status: 'waiting' }
  const swarm: Swarm = {
    title: 'Long', dir: '/project/.swarm/long-20261116-101010', isClosed: false, attention: [], budget: 0, tokens: {},
    total: 4, earlierEdges: { 'scout>coordinator': 2 },
    posts: [
      { seq: 3, agent: 'coordinator', to: ['parser'], text: '', time: '' },
      { seq: 4, agent: 'parser', to: ['coordinator'], text: '', time: '' },
    ],
    members: [
      { ...member, name: 'coordinator', role: 'coordinator', type: 'coordinator' },
      { ...member, name: 'parser', role: 'worker', type: 'worker' },
      { ...member, name: 'scout', role: 'worker', type: 'explorer' },
    ],
  }
  for (const live of [true, false]) {
    const graph = graphSvg(swarm, 3, new Set(), false, live)
    expect(graph).toContain('<title>scout')
    expect(graph).toContain('scout to coordinator')
  }
})

test('an @all post is counted on its sender, drawn dashed only when expanded, and the key says which', async () => {
  const member = { id: undefined, profile: undefined, model: '', effort: '', depends: [], owns: '', detail: '', unread: 0, posts: 1, status: 'waiting' }
  const posts: Post[] = [
    { seq: 1, agent: 'coordinator', to: [], text: 'RUN RULES for everyone', time: '' },
    { seq: 2, agent: 'coordinator', to: ['parser'], text: '@parser BRIEF', time: '' },
    { seq: 3, agent: 'coordinator', to: ['parser', 'lexer'], text: '@all stop, and @parser report', time: '' },
  ]
  // the member named beside @all is addressed by name; the other is reached through @all alone
  expect(edgesOf(posts)).toEqual({
    'coordinator>@none': 1, 'coordinator>parser': 2, 'coordinator>@all': 1, 'coordinator>lexer>all': 1,
  })
  const swarm: Swarm = {
    title: 'Team', dir: '/project/.swarm/team-20261116-101010', isClosed: false, attention: [], budget: 0, tokens: {},
    total: 3, earlierEdges: {}, posts,
    members: [
      { ...member, name: 'coordinator', role: 'coordinator', type: 'coordinator' },
      { ...member, name: 'parser', role: 'worker', type: 'worker' },
      { ...member, name: 'lexer', role: 'worker', type: 'worker' },
    ],
  }
  const collapsed = graphSvg(swarm, 3, new Set(), true, true)
  expect(collapsed).not.toContain('coordinator to lexer')
  expect(collapsed).toContain('coordinator to parser · 2 mentions')
  expect(collapsed).toMatch(/class="chip on"[^>]*><rect[^>]*\/><text[^>]*>@all 1</)
  expect(collapsed).toContain('class="motion ripple"')
  expect(collapsed).toContain('@all posts, drawn by Expand @all')
  // a post that names nobody leaves a dashed outline on its sender, as the key shows it
  expect(collapsed).toMatch(/<title>coordinator · waiting · 1 post with no mention · 1 to @all<\/title>.*?class="pill sender quiet"/)
  expect(collapsed).toContain('class="pill quiet" x="336"')

  const expanded = graphSvg(swarm, 3, new Set(), true, true, false, 0, true)
  expect(expanded).toMatch(/class="route via-all[^"]*"[^>]*><title>coordinator to lexer · 1 via @all/)
  expect(expanded).not.toContain('class="motion ripple"')
  expect(expanded).toContain('@all posts, drawn as dashed arrows')
  // a member named before and reached through @all later gets both lines, side by side
  const later = { ...swarm, posts: [...posts, { seq: 4, agent: 'coordinator', to: ['parser', 'lexer'], text: '@all wrap up', time: '' },
    { seq: 5, agent: 'coordinator', to: ['all-hands'], text: '@all-hands report', time: '' }] }
  const both = graphSvg(later, 4, new Set(), false, true, false, 0, true)
  expect(both).toMatch(/class="edge"[^>]*><title>coordinator to parser · 2 mentions/)
  expect(both).toMatch(/class="route via-all"[^>]*><title>coordinator to parser · 1 via @all/)
  expect(both).toMatch(/class="route via-all"[^>]*><title>coordinator to lexer · 2 via @all/)
  expect(graphSvg(later, 4, new Set(), false, true)).not.toContain(' via @all</title>')
  expect(edgesOf(later.posts)['coordinator>@all']).toBe(2)
  // before the @all post the key counts none, and replay does not show what has not happened yet
  const before = graphSvg(swarm, 2, new Set(), false, false, false, 0, true)
  expect(before).toContain('no @all posts yet')
  expect(before.split('via-all" d=').length - 1).toBe(1) // only the key's own sample is dashed
  expect(before).not.toContain('coordinator to lexer')
  // posts the pane no longer keeps still count
  const kept = graphSvg({ ...swarm, posts: [], earlierEdges: edgesOf(posts) }, 0, new Set(), false, true, false, 0, true)
  expect(kept).toContain('coordinator to lexer · 1 via @all')
  expect(kept).toContain('>@all 1<')
  for (const svg of [collapsed, expanded, before, kept]) expect(svg).not.toMatch(/NaN|Infinity|undefined/)
})

test('a member level with the coordinator leaves room for its arrow, and every head sits on its pill', async () => {
  const member = { id: undefined, profile: undefined, model: '', effort: '', depends: [], owns: '', detail: '', unread: 0, posts: 1, status: 'waiting' }
  const names = ['build-forensics', 'code-forensics', 'build-fix', 'code-fix', 'verifier']
  const swarm: Swarm = {
    title: 'Team', dir: '/project/.swarm/team-20261116-101010', isClosed: false, attention: [], budget: 0, tokens: {},
    total: 5, earlierEdges: {},
    posts: names.map((name, index) => ({ seq: index + 1, agent: 'coordinator', to: [name], text: `@${name} BRIEF`, time: '' })),
    members: [{ ...member, name: 'coordinator', role: 'coordinator', type: 'coordinator' },
      ...names.map(name => ({ ...member, name, role: 'worker', type: 'worker' }))],
  }
  const graph = graphSvg(swarm, 5, new Set(), false, true)
  const at = (name: string) => graph.match(new RegExp(`translate\\(([\\d.]+) ([\\d.]+)\\)"><title>${name}`))!.slice(1).map(Number) as [number, number]
  const half = (name: string) => 22 + Math.min(15, name.length) * 4.7
  const [cx] = at('coordinator')
  for (const name of names) {
    const [x, y] = at(name)
    // no pill overlaps the coordinator's, and one beside it keeps a gap an arrow fits in
    if (Math.abs(y - 165) < 38) expect(Math.abs(x - cx) - half(name) - half('coordinator')).toBeGreaterThan(36)
    // the arrow's tip lands on the border of the pill it points at, give or take the gap
    const tip = graph.match(new RegExp(`coordinator to ${name}[^<]*</title></path><path class="tip[^"]*" d="M([\\d.]+) ([\\d.]+)`))!.slice(1).map(Number) as [number, number]
    const outside = Math.max(Math.abs(tip[0] - x) - half(name), Math.abs(tip[1] - y) - 19)
    expect(outside).toBeGreaterThan(0)
    expect(outside).toBeLessThan(9)
  }
})

test('arrowheads point into destination pills without overlap or clipping across N=4..12', async () => {
  const baseMember = { id: undefined, profile: undefined, model: '', effort: '', depends: [], owns: '', detail: '', unread: 0, posts: 1, status: 'working' }
  const halfOf = (name: string) => Math.max(38, 22 + Math.min(15, name.length) * 4.7)
  for (const withCoord of [true, false]) {
    for (const n of [4, 5, 6, 8, 9, 10, 12]) {
      const names = Array.from({ length: withCoord ? n - 1 : n }, (_, i) => `worker-node-${String(i).padStart(2, '0')}x`)
      const members = [
        ...(withCoord ? [{ ...baseMember, name: 'coordinator', role: 'coordinator', type: 'coordinator' }] : []),
        ...names.map(name => ({ ...baseMember, name, role: 'worker', type: 'worker' })),
      ]
      const posts: Post[] = []
      let seq = 1
      for (let i = 0; i < members.length; i++) {
        const from = members[i]!.name
        const to = members[(i + 1) % members.length]!.name
        posts.push({ seq: seq++, agent: from, to: [to], text: `@${to} ping`, time: '' })
        if (withCoord && i > 0) {
          posts.push({ seq: seq++, agent: 'coordinator', to: [from], text: `@${from} task`, time: '' })
        }
      }
      const swarm: Swarm = {
        title: 'Scale', dir: '/project/.swarm/scale-20261116-101010', isClosed: false, attention: [], budget: 0, tokens: {},
        total: posts.length, earlierEdges: {}, posts, members,
      }
      const svg = graphSvg(swarm, posts[posts.length - 1]!.seq, new Set(), false, true)
      const vb = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/)!
      const vw = Number(vb[1]), vh = Number(vb[2]) - 50
      const boxes = members.map(m => {
        const [x, y] = svg.match(new RegExp(`translate\\(([\\d.]+) ([\\d.]+)\\)"><title>${m.name}`))!.slice(1).map(Number) as [number, number]
        const half = halfOf(m.name)
        // Zero viewBox clipping (including 2px outer half of 4px .arrival stroke)
        expect(x - half - 2).toBeGreaterThanOrEqual(0)
        expect(x + half + 2).toBeLessThanOrEqual(vw)
        expect(y - 19 - 2).toBeGreaterThanOrEqual(0)
        expect(y + 19 + 2).toBeLessThanOrEqual(vh)
        return { name: m.name, x, y, half }
      })
      // Zero pill-to-pill overlaps
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i]!, b = boxes[j]!
          const overlapX = Math.abs(a.x - b.x) < a.half + b.half
          const overlapY = Math.abs(a.y - b.y) < 38
          expect(overlapX && overlapY).toBe(false)
        }
      }
      // Every arrowhead points toward its destination center (dot > 0)
      const posMap = new Map(boxes.map(b => [b.name, b]))
      const tipRegex = /<title>([^<]+) to ([^<]+) · [^<]+<\/title><\/path><path class="tip[^"]*" d="M([\d.]+) ([\d.]+)L([\d.]+) ([\d.]+)L([\d.]+) ([\d.]+)z"\/>/g
      let match: RegExpExecArray | null
      let checked = 0
      while ((match = tipRegex.exec(svg)) !== null) {
        const toName = match[2]!
        const dest = posMap.get(toName)!
        const x2 = Number(match[3]), y2 = Number(match[4])
        const bx = (Number(match[5]) + Number(match[7])) / 2
        const by = (Number(match[6]) + Number(match[8])) / 2
        const dot = (x2 - bx) * (dest.x - x2) + (y2 - by) * (dest.y - y2)
        expect(dot).toBeGreaterThan(0)
        checked++
      }
      expect(checked).toBeGreaterThan(0)
    }
  }
})

test('peer detours separate solid and @all edges, badges expand for 3 digits and render after nodes, backticks are ignored, and statuses have distinct shapes', async () => {
  const member = { id: undefined, profile: undefined, model: '', effort: '', depends: [], owns: '', detail: '', unread: 0, posts: 1 }
  const members = [
    { ...member, name: 'coordinator', role: 'coordinator', type: 'coordinator', status: 'coordinating' },
    { ...member, name: 'parser', role: 'worker', type: 'worker', status: 'working' },
    { ...member, name: 'verifier', role: 'worker', type: 'worker', status: 'waiting' },
    { ...member, name: 'checker', role: 'worker', type: 'worker', status: 'failed' },
    { ...member, name: 'idler', role: 'worker', type: 'worker', status: 'not started' },
  ]
  const posts: Post[] = [
    { seq: 1, agent: 'parser', to: ['verifier'], text: '`@all` and `@checker` in backticks\n```\n@all\n```\nreal @verifier_', time: '' },
    { seq: 2, agent: 'parser', to: ['verifier', 'checker'], text: '@all @verifier check', time: '' },
  ]
  expect(isBroadcast(posts[0]!)).toBe(false)
  expect(isBroadcast(posts[1]!)).toBe(true)
  expect(edgesOf(posts)).toEqual({
    'parser>verifier': 2,
    'parser>@all': 1,
    'parser>checker>all': 1,
  })
  // Test 3-digit badge width & z-order + peer detour separation
  const swarm: Swarm = {
    title: 'Shapes', dir: '/project/.swarm/shapes-20261116-101010', isClosed: false, attention: [], budget: 0, tokens: {},
    total: 120,
    earlierEdges: { 'parser>verifier': 118, 'parser>verifier>all': 5 },
    posts,
    members,
  }
  const svg = graphSvg(swarm, 2, new Set(), false, true, false, 0, true)
  const solidPath = svg.match(/d="([^"]+)"[^>]*><title>parser to verifier · 120 mentions/)?.[1]
  const dashedPath = svg.match(/d="([^"]+)"[^>]*><title>parser to verifier · 5 via @all/)?.[1]
  expect(solidPath).toBeDefined()
  expect(dashedPath).toBeDefined()
  expect(solidPath).not.toBe(dashedPath)
  // 3-digit badge uses rect wider than 20 and renders after nodes
  const badgeMatch = svg.match(/<rect class="badge" x="([^"]+)" y="-10" width="([^"]+)" height="20" rx="10"\/><text class="count"[^>]*>120</)
  expect(badgeMatch).not.toBeNull()
  expect(Number(badgeMatch![2])).toBeGreaterThan(20)
  expect(svg.indexOf('class="badge"')).toBeGreaterThan(svg.indexOf('<title>idler'))
  // Colorblind distinct shapes in graphSvg & statusDot
  expect(svg).toContain('class="presence working"')
  expect(svg).toContain('class="presence-ring waiting"')
  expect(svg).toContain('class="presence coordinating"')
  expect(svg).toContain('class="presence-x failed"')
  expect(svg).toContain('class="presence not-started"')
  expect(statusDot('coordinating')).toContain('<path')
  expect(statusDot('waiting')).toContain('r="1.6"')
  expect(statusDot('failed')).toContain('stroke-linecap="round"')
  expect(statusDot('not started')).toContain('stroke-width="1.5"')
})
