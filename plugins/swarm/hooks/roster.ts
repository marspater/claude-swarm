// The roster and the board as the pane reads them: who is on the team, what each member is doing,
// and the posts. Pure: nothing here touches the engine, so all of it is tested directly.
import type { AgentInfo } from 'claude-code'

import type { AttentionItem, Member, Post, Swarm } from '../types'
import { edgesOf } from './graph'
import { clean } from './text'

// ponytail: keeps the newest 300 posts; page through board.jsonl if a swarm outgrows that
export const KEPT = 300

export type BudgetState = {
  limits?: Record<string, string>
  usage?: { tokens?: Record<string, number> }
}

export function budgetOf(state: BudgetState): number {
  return Number(state.limits?.budget ?? 0) || 0
}

export function tokensUsed(tokens: Record<string, number> = {}): number {
  return Object.values(tokens).reduce((sum, count) => sum + count, 0)
}

// The same rule as board.py: @name at a word start, never an email or a path.
export const MENTION = /(?<![\w.@/])@([A-Za-z][\w-]*)/g

export type Roster = Record<
  string,
  {
    role?: string
    backend?: string
    group?: string
    profile?: string
    writes?: string
    /** `1` for a consultant: it advises the coordinator and contributes nothing to the candidate. */
    consult?: string
    model?: string
    effort?: string
    paths?: string
    isolated?: string
    id?: string
    killed?: string
    replaced_by?: string
    last_read_seq: number
    last_nudged_seq?: number
    wake_claim?: { seq: number; attempts: number; until: number }
    told?: { seq: number; at: number; times: number }
  }
>

export const memberNamed = (members: Roster, name?: string) => name && Object.hasOwn(members, name) ? members[name] : undefined

// What `board.py attention --json` answers: the items, and each member as the board sees it.
export type Report = {
  items: AttentionItem[]
  members: Record<string, {
    type: string
    model: string
    effort: string
    depends: string[]
    owns: string
    paths?: string[]
    ready: boolean
    blocked_on: string[]
    asked: number
    unreachable: boolean
  }>
  limits: Record<string, string>
}

// What a member that is not working is waiting for, in words.
export function detailOf(status: string, hint: Report['members'][string] | undefined, isPaused: boolean): string {
  if (status === 'working' || status === 'killed' || status === 'coordinating' || status === 'failed') return ''
  if (status === 'unreachable') return 'cannot be woken'
  if (isPaused) return 'run paused'
  if (hint?.asked) return `waiting for an answer to #${hint.asked}`
  if (hint && hint.blocked_on.length > 0) return `waiting for ${hint.blocked_on.map(name => `@${name}`).join(', ')}`
  if (hint?.ready) return 'reported ready'

  return ''
}

export function targets(text: string, roster: Roster): string[] {
  const stripped = text.replace(/```[\s\S]*?```|(`+)[^\n]*?\1|\w+:\/\/\S+/g, ' ')
  const mentioned = new Set(
    [...stripped.matchAll(MENTION)].map(m =>
      (m[1] ?? '').toLowerCase(),
    ).flatMap(name => [name, name.replace(/[-_]+$/, '')]),
  )

  return Object.keys(roster).filter(name => {
    const member = roster[name]

    return (
      member !== undefined &&
      !member.killed &&
      (mentioned.has('all') ||
        mentioned.has(name) ||
        (member.group !== undefined && mentioned.has(member.group)))
    )
  })
}

const ACTIVE_AGENT_STATUSES = new Set(['running', 'pending', 'waiting', 'idle'])

/** Finds the newest agent matching `id`, preferring active statuses over ended ones. */
export function findAgent(agents: AgentInfo[], id: string | undefined): AgentInfo | undefined {
  if (id === undefined) return undefined
  const matches = agents.filter(one => one.id === id || one.teammateId === id)
  return matches.findLast(one => ACTIVE_AGENT_STATUSES.has(one.status)) ?? matches.at(-1)
}

export function statusOf(
  role: string,
  member: Roster[string],
  agents: AgentInfo[],
): string {
  if (member.killed) return 'killed'
  if (role === 'coordinator') return 'waiting'
  if (!member.id) return 'not started'
  const agent = findAgent(agents, member.id)
  if (agent === undefined) return 'waiting'
  if (agent.status === 'killed') return 'killed'
  if (agent.status === 'running' || agent.status === 'pending' || agent.status === 'waiting') return 'working'

  return agent.status === 'failed' ? 'failed' : 'waiting'
}

export function parsePosts(board: string, roster: Roster): Post[] {
  const posts: Post[] = []
  for (const line of board.split('\n')) {
    if (line.trim() === '') continue
    try {
      const post = JSON.parse(line) as Omit<Post, 'to'> & { to?: string[] }
      if (!Number.isSafeInteger(post.seq) || post.seq <= (posts.at(-1)?.seq ?? 0) ||
          typeof post.agent !== 'string' || typeof post.text !== 'string' || typeof post.time !== 'string' ||
          (post.to !== undefined && (!Array.isArray(post.to) || post.to.some(name => typeof name !== 'string')))) continue
      // board.py records the recipients; a board written before it did is read by its mentions
      const to =
        post.to ?? targets(post.text, roster).filter(name => name !== post.agent)
      posts.push({ ...post, text: clean(post.text), to })
    } catch {
      // a line still being written; the next poll reads it whole
    }
  }
  return posts
}

export function parse(
  dir: string,
  board: string,
  rosterText: string,
  agents: AgentInfo[],
  limit = KEPT,
  report?: Report,
  coordinating = false,
): Swarm {
  const state = JSON.parse(rosterText) as {
    title: string
    closed?: boolean
    paused?: string
    members: Roster
  } & BudgetState
  const roster = state.members
  const posts = parsePosts(board, roster)
  const activity = new Map<string, { sent: number; unread: number }>()
  const counts = (name: string) => {
    let member = activity.get(name)
    if (!member) {
      member = { sent: 0, unread: 0 }
      activity.set(name, member)
    }
    return member
  }
  for (const post of posts) {
    counts(post.agent).sent++
    for (const name of post.to) if (post.seq > (memberNamed(roster, name)?.last_read_seq ?? Infinity)) counts(name).unread++
  }
  const isClosed = state.closed === true
  const liveAgents = isClosed ? [] : agents
  const zombieAttention: AttentionItem[] = []
  const members: Member[] = Object.entries(roster).map(([name, member]) => {
    const hint = report?.members && Object.hasOwn(report.members, name) ? report.members[name] : undefined
    const base = member.role === 'coordinator' && coordinating && !member.killed && !isClosed ? 'coordinating' : statusOf(member.role ?? 'worker', member, liveAgents)
    const status = !isClosed && hint?.unreachable && base !== 'working' && base !== 'killed' ? 'unreachable' : base
    const zombie = !isClosed && member.killed && member.id ? findAgent(liveAgents, member.id) : undefined
    const isZombie = zombie !== undefined && (zombie.status === 'running' || zombie.status === 'pending' || zombie.status === 'waiting')
    if (isZombie) {
      zombieAttention.push({
        kind: 'retired-running',
        member: name,
        seq: 0,
        text: `@${name} was retired, but agent ${zombie.id} is still ${zombie.status}. Stop it before reusing its files.`,
      })
    }

    return {
      name,
      id: member.id,
      role: member.role ?? 'worker',
      profile: member.profile,
      model: hint?.model ?? member.model ?? '',
      effort: hint?.effort ?? member.effort ?? '',
      type: hint?.type ?? (member.profile || member.role || 'worker'),
      depends: hint?.depends ?? [],
      owns: clean(hint?.owns ?? ''),
      status,
      detail: isClosed ? '' : isZombie ? `still ${zombie.status} (${zombie.id})` : detailOf(status, hint, Boolean(state.paused)),
      unread: counts(name).unread,
      posts: counts(name).sent,
    }
  })

  return {
    title: clean(state.title),
    dir,
    isClosed,
    isPaused: Boolean(state.paused),
    posts: posts.slice(-limit),
    total: Math.max(posts.length, posts.at(-1)?.seq ?? 0),
    earlierEdges: edgesOf(posts.slice(0, -limit)),
    members,
    attention: [...(report?.items ?? []), ...zombieAttention],
    budget: budgetOf(state),
    tokens: state.usage?.tokens ?? {},
  }
}
