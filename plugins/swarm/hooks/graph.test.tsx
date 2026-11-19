import { expect, test } from 'claude-code/testing'
import type { Post, Swarm } from '../types'
import { edgesOf, graphSvg } from './graph'

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
