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
