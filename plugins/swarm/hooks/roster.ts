// The roster and the board as the pane reads them: who is on the team, what each member is doing,
// and the posts. Pure: nothing here touches the engine, so all of it is tested directly.
import type { AgentInfo } from 'claude-code'

import type { AttentionItem, Member, Post, Swarm } from '../types'
import { edgesOf } from './graph'
import { clean, unquoted } from './text'

// ponytail: keeps the newest 300 posts; page through board.jsonl if a swarm outgrows that
export const KEPT = 300

export type BudgetState = {
  limits?: Record<string, string>
  usage?: { tokens?: Record<string, number> }
}

// A roster is a file anyone may have edited: a budget that is no positive number is no budget, and a count that is
// none adds nothing, so neither can halt a run or keep one from halting.
const positive = (value: unknown) => {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0
}

export function budgetOf(state: BudgetState): number {
  return positive(state.limits?.budget)
}

export function tokensUsed(tokens?: Record<string, unknown> | null): number {
  return Object.values(tokens ?? {}).reduce<number>((sum, count) => sum + positive(count), 0)
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
    /** The members whose READY it waits for, comma-separated. */
    depends?: string
    /** Its own token budget, and why it was paused once that was spent: its tool calls are refused until `resume NAME`. */
    budget?: string
    paused?: string
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
    /** It spent its own token budget. */
    paused?: boolean
  }>
  limits: Record<string, string>
}

// What a member that is not working is waiting for, in words.
export function detailOf(status: string, hint: Report['members'][string] | undefined, isPaused: boolean, isMemberPaused = false): string {
  if (status === 'killed' || status === 'coordinating' || status === 'failed') return ''
  // Said while it still works too: its next tool call is refused.
  if (isMemberPaused) return 'its token budget is spent'
  if (status === 'working') return ''
  if (status === 'unreachable') return 'cannot be woken'
  if (status === 'stopped') return 'its agent was stopped'
  if (isPaused) return 'run paused'
  if (hint?.asked) return `waiting for an answer to #${hint.asked}`
  if (Array.isArray(hint?.blocked_on) && hint.blocked_on.length) return `waiting for ${hint.blocked_on.map(name => `@${name}`).join(', ')}`
  if (hint?.ready) return 'reported ready'

  return ''
}

/** The names a text mentions, in lower case, code and URLs left out: members, groups and `all` alike. */
export const mentions = (text: string) => new Set(
  [...unquoted(text).matchAll(MENTION)].map(m => (m[1] ?? '').toLowerCase())
    .flatMap(name => [name, name.replace(/[-_]+$/, '')]),
)

/** The live members a post reaches, as board.py's targets reads them: `@verifiers` is every verifier, `@dependents` whoever waits for the sender. */
export function targets(text: string, roster: Roster, sender?: string): string[] {
  const mentioned = mentions(text)

  return Object.keys(roster).filter(name => {
    const member = roster[name]

    return (
      member !== undefined &&
      !member.killed &&
      (mentioned.has('all') ||
        mentioned.has(name) ||
        (member.group !== undefined && mentioned.has(member.group)) ||
        (mentioned.has('verifiers') && member.role === 'verifier') ||
        (mentioned.has('dependents') && sender !== undefined && (member.depends ?? '').split(',').includes(sender)))
    )
  })
}

const RUNNING_AGENT_STATUSES = new Set(['running', 'pending', 'waiting'])

/** Finds the newest agent matching `id`, preferring one that is running: an idle one is no newer than a later failure. */
export function findAgent(agents: AgentInfo[], id: string | undefined): AgentInfo | undefined {
  if (id === undefined) return undefined
  const matches = agents.filter(one => one.id === id || one.teammateId === id)
  return matches.findLast(one => RUNNING_AGENT_STATUSES.has(one.status)) ?? matches.at(-1)
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
  if (agent.status === 'running' || agent.status === 'pending' || agent.status === 'waiting') return 'working'

  // `killed` is the roster's word for a retired member. One still on the roster whose agent someone stopped is
  // `stopped`, not failed: it stays in the stall check, and a wake it cannot take still shows as unreachable.
  return agent.status === 'failed' ? 'failed' : agent.status === 'killed' ? 'stopped' : 'waiting'
}

export function parsePosts(board: string, roster: Roster): Post[] {
  const posts: Post[] = []
  for (const line of board.split('\n')) {
    if (line.trim() === '') continue
    try {
      const post = JSON.parse(line) as Omit<Post, 'to' | 'revision'> & { to?: string[]; revision?: unknown }
      if (!post || !Number.isSafeInteger(post.seq) || post.seq <= (posts.at(-1)?.seq ?? 0) ||
          typeof post.agent !== 'string' || typeof post.text !== 'string' || typeof post.time !== 'string' ||
          (post.to !== undefined && (!Array.isArray(post.to) || post.to.some(name => typeof name !== 'string')))) continue
      // board.py records the recipients; a board written before it did is read by its mentions
      const to =
        post.to ?? targets(post.text, roster, post.agent).filter(name => name !== post.agent)
      // A READY's commit goes into a git command line when its diff is opened: only a full commit id is kept.
      const { revision, ...rest } = post
      const commit = typeof revision === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(revision) ? { revision } : {}
      posts.push({ ...rest, ...commit, agent: clean(post.agent), time: clean(post.time), text: clean(post.text), to: to.map(clean) })
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
  const state = (JSON.parse(rosterText) ?? {}) as {
    title?: string
    closed?: boolean
    paused?: string
    members?: Roster
  } & BudgetState
  // A roster cut short or edited by hand still draws what it holds: an entry that is no object is left out.
  const roster: Roster = Object.fromEntries(Object.entries(state.members ?? {}).filter(([, member]) => member && typeof member === 'object'))
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
  // The last post each member made, and the last one addressed to it.
  const said = new Map<string, number>()
  const heard = new Map<string, number>()
  for (const post of posts) {
    counts(post.agent).sent++
    said.set(post.agent, post.seq)
    for (const name of post.to) {
      heard.set(name, post.seq)
      if (post.seq > (memberNamed(roster, name)?.last_read_seq ?? Infinity)) counts(name).unread++
    }
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

    // Its agent ended, it has read everything addressed to it, and it answered none of it: no report, no question,
    // nothing it waits for. While others work nobody notices, and whoever depends on it waits for good.
    const lastHeard = heard.get(name) ?? 0
    if (!isClosed && !state.paused && !member.paused && (member.role ?? 'worker') === 'worker' && member.id !== undefined && status === 'waiting' &&
        hint !== undefined && !hint.ready && !hint.asked && !hint.blocked_on?.length &&
        counts(name).unread === 0 && lastHeard > 0 && (said.get(name) ?? 0) < lastHeard) {
      zombieAttention.push({
        kind: 'silent',
        member: name,
        seq: lastHeard,
        text: `@${name} stopped without reporting: its agent ended after reading #${lastHeard} and it has posted nothing since. Ask it where it stands in a post that mentions it, or replace it.`,
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
      owns: clean(typeof hint?.owns === 'string' ? hint.owns : ''),
      status,
      detail: isClosed ? '' : isZombie ? `still ${zombie.status} (${zombie.id})` : detailOf(status, hint, Boolean(state.paused), Boolean(member.paused) || hint?.paused === true),
      unread: counts(name).unread,
      posts: counts(name).sent,
    }
  })

  // `slice(-0)` is the whole list, so a limit of none is spelled out.
  const kept = limit > 0 ? posts.slice(-limit) : []

  return {
    title: clean(String(state.title ?? '')),
    dir,
    isClosed,
    isPaused: Boolean(state.paused),
    posts: kept,
    total: Math.max(posts.length, posts.at(-1)?.seq ?? 0),
    earlierEdges: edgesOf(posts.slice(0, posts.length - kept.length)),
    members,
    attention: [...(report?.items ?? []), ...zombieAttention],
    budget: budgetOf(state),
    tokens: Object.fromEntries(Object.entries(state.usage?.tokens ?? {}).map(([actor, count]) => [actor, positive(count)])),
  }
}
