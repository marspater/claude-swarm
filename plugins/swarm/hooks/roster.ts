// The roster and the board as the pane reads them: who is on the team, what each member is doing,
// and the posts. Pure: nothing here touches the engine, so all of it is tested directly.
import type { AgentInfo } from 'claude-code'

import type { AttentionItem, Member, Post, Swarm } from '../types'
import { earlierEdgesOf } from './graph'
import { clean, mentions, verdictOf } from './text'

export { mentions }

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

// A map read from the roster: a value that is no plain object, a string or a list, holds no entries.
const entriesOf = <T>(value: Record<string, T> | null | undefined): [string, T][] =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value) : []

export function tokensUsed(tokens?: Record<string, unknown> | null): number {
  return entriesOf(tokens).reduce<number>((sum, [, count]) => sum + positive(count), 0)
}

// A member's context is read again by every step it takes, so a long read-only sweep costs with the square of its
// length. Seen live: three investigators grew from 23k to 290k tokens in 34 steps and spent a 3M budget with nothing
// posted. Past NOTE a member is told once; past STOP a read-only member may only report.
// ponytail: fixed thresholds; make them a run limit (`context=`) if a run needs a longer-lived specialist.
// A read-only member is told at EARLY to post its findings as it goes.
export const CONTEXT_EARLY = 90_000
export const CONTEXT_NOTE = 150_000
export const CONTEXT_STOP = 200_000
/** What one model step read to answer: the context its member holds now. */
export const heldAt = (spent: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } | undefined) =>
  positive(spent?.input_tokens) + positive(spent?.cache_creation_input_tokens) + positive(spent?.cache_read_input_tokens)
export const contextState = (held: number): 'ok' | 'note' | 'stop' => held >= CONTEXT_STOP ? 'stop' : held >= CONTEXT_NOTE ? 'note' : 'ok'
// A run this far into its budget tells its members to post what they have: at the pause itself nothing more is paid for.
export const WIND_DOWN = 0.8
export const isWindingDown = (used: number, budget: number) => budget > 0 && used >= budget * WIND_DOWN

// What a model step reports it spent, and what that is charged against a budget as it is billed: fresh tokens whole,
// cached reads at a tenth.
type Spent = { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number }
const weigh = (spent: Spent | undefined) => spent === undefined ? 0
  : (spent.input_tokens || 0) + (spent.cache_creation_input_tokens || 0) + (spent.output_tokens || 0) + Math.round((spent.cache_read_input_tokens || 0) * 0.1)
// `sum` is what the steps reported, `charged` what the board took, and `endCharged` its share of that under END reports.
// `pending` holds unacknowledged charges by step index (END for turn totals), and `landing` waits for their step calls.
// `raw` is what each pending report spent before weighting and `taken` what the board holds of that, so the usage
// detail follows the charge through every retry.
type Turn = { steps: Set<number>; sum: Spent; charged: number; endCharged: number; pending: Map<number, number>; raw: Map<number, Spent>; taken: Spent; landing: Promise<unknown>; agentId?: string; last: number }
const KINDS = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'] as const

/**
 * What an agent's advisor has spent so far, off the agent's own per-model usage: the entries of the advisor's family.
 * A step's usage holds the member's own tokens alone, so the advisor's are charged from here, under their own name.
 * ponytail: told apart by family, so an advisor of the member's own family is not counted apart; compare model ids
 * if such a pairing is ever allowed.
 */
export function advisorSpent(usage: readonly (Partial<Spent> & { model: string })[] | undefined, advisorFamily: string, ownFamily: string, familyOf: (model: string) => string): Spent & { model: string } {
  const total = { ...none(), model: '' }
  if (advisorFamily === '' || advisorFamily === ownFamily) return total
  for (const entry of usage ?? []) {
    if (familyOf(entry.model) !== advisorFamily) continue
    for (const kind of KINDS) total[kind] += positive(entry[kind])
    total.model = entry.model
  }
  return total
}
/** What the board is charged for SPENT less what it already TOOK, weighed as a step is, and the raw counts of that. */
export function owedOf(spent: Spent, took: Spent | undefined): { amount: number; detail: string } {
  const rest = none()
  for (const kind of KINDS) rest[kind] = Math.max(0, spent[kind] - (took?.[kind] ?? 0))
  return { amount: weigh(rest), detail: `${rest.input_tokens},${rest.cache_creation_input_tokens},${rest.cache_read_input_tokens},${rest.output_tokens}` }
}
const none = (): Spent => ({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 })
const fresh = (agentId: string | undefined, last: number): Turn => ({ steps: new Set(), sum: none(), charged: 0, endCharged: 0, pending: new Map(), raw: new Map(), taken: none(), landing: Promise.resolve(), agentId, last })
/**
 * What each turn's model steps have been charged so far, so its end charges only what the board did not take. A
 * running turn keeps its entry however long it runs or waits between steps, or its end would charge its steps a
 * second time; once the agent it belongs to has ended and `graceMs` passed with no end reported for it, it joins the
 * newest `kept` turns that ended, so a late or repeated end still finds what was charged.
 */
/** The pending entry of a turn's end the board did not take: retried under the turn's own report. */
export const END = -1
export function ledger(kept = 256, graceMs = 600_000) {
  const running = new Map<string, Turn>()
  const ended = new Map<string, Turn>()
  const of = (turnId: string) => running.get(turnId) ?? ended.get(turnId)
  const end = (turnId: string, turn: Turn) => {
    running.delete(turnId)
    ended.delete(turnId)
    ended.set(turnId, turn)
    if (ended.size > kept) {
      // The oldest the board owes nothing for goes first: one with a charge still pending is kept while it can be.
      const settled = [...ended].find(([id, old]) => id !== turnId && old.pending.size === 0)
      ended.delete(settled ? settled[0] : ended.keys().next().value!)
    }
  }
  return {
    of,
    get running() { return running.size },
    clear() {
      running.clear()
      ended.clear()
    },
    /**
     * What this report adds to the turn's charge: a step's own usage, or at the turn's end its whole usage (what its
     * steps reported, when the end carries none) less what the board took (`landed`) and the step charges still pending,
     * which are retried under their own report. A step's share is what it adds to the turn's weighed sum, so cached
     * reads round once over the turn, not once a step. Nothing counts as charged until the board acknowledges it, so a
     * failed write is owed again when the report is retried, and a retry after it landed adds nothing.
     */
    charge(turnId: string, spent: Spent | undefined, index?: number, agentId?: string, now = 0): number {
      let turn = of(turnId)
      if (index === undefined) {
        const closed = turn ?? fresh(agentId, now)
        const total = weigh(spent ?? closed.sum)
        const pending = [...closed.pending.values()].reduce((sum, amount) => sum + amount, 0)
        // The end's detail is the turn's less what the board holds and what the steps still owe, as its charge is.
        const whole = spent ?? closed.sum, rest = none()
        for (const kind of KINDS) {
          const owing = [...closed.raw].reduce((sum, [index, raw]) => index === END ? sum : sum + raw[kind], 0)
          rest[kind] = Math.max(0, (whole[kind] || 0) - closed.taken[kind] - owing)
        }
        // A repeated end leaves the detail of the end still pending as it is: its retry carries that one.
        if (!closed.pending.has(END)) closed.raw.set(END, rest)
        end(turnId, closed)
        return Math.max(0, total - closed.charged - pending)
      }
      if (spent === undefined) return 0
      // A step that reports after its turn's end was charged with the end.
      if (ended.has(turnId)) return 0
      if (!turn) {
        turn = fresh(agentId, now)
        running.set(turnId, turn)
      }
      turn.last = now
      if (turn.steps.has(index)) return 0
      turn.steps.add(index)
      const before = weigh(turn.sum)
      for (const key of Object.keys(turn.sum) as (keyof Spent)[]) turn.sum[key] += spent[key] || 0
      const after = weigh(turn.sum)
      const delta = after - before
      if (delta > 0) {
        turn.pending.set(index, delta)
        const raw = none()
        for (const kind of KINDS) raw[kind] = spent[kind] || 0
        turn.raw.set(index, raw)
      }
      return delta
    },
    /**
     * Settle a pending report for the amount the board took. A report settled twice counts once. One never sent
     * lands as 0 so its tokens can be charged under the turn's end.
     */
    landed(turn: Turn, amount: number, index: number): void {
      if (!turn.pending.delete(index)) return
      const raw = turn.raw.get(index)
      turn.raw.delete(index)
      if (raw && amount > 0) for (const kind of KINDS) turn.taken[kind] += raw[kind]
      turn.charged += amount
      if (index === END) turn.endCharged += amount
    },
    /** What a pending report spent, as the board's `account` takes it: fresh input, cache writes, cache reads, output. */
    detail(turn: Turn, index: number): string {
      const raw = turn.raw.get(index)
      return raw ? KINDS.map(kind => raw[kind]).join(',') : ''
    },
    /** Keep a turn's end charge pending under the same report until the board takes it. */
    held(turn: Turn, amount: number): void {
      if (amount > 0) turn.pending.set(END, amount)
    },
    /** The ended turns with a charge the board has not taken yet, oldest first. */
    owed(): [string, Turn][] {
      return [...ended].filter(([, turn]) => turn.pending.size > 0)
    },
    /** Ends the running turns of agents that are no longer live and stepped last `graceMs` or more ago. */
    prune(isLive: (agentId: string) => boolean, now: number): void {
      for (const [turnId, turn] of running) {
        if (turn.agentId !== undefined && !isLive(turn.agentId) && now - turn.last >= graceMs) end(turnId, turn)
      }
    },
  }
}


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
    /** How large its piece is (s, m, l): sets its effort when none is named. */
    size?: string
    paths?: string
    isolated?: string
    id?: string
    killed?: string
    /** The members whose READY it waits for, comma-separated. */
    depends?: string
    after?: string
    /** Its own token budget, and why it was paused once that was spent: its tool calls are refused until `resume NAME`. */
    budget?: string
    paused?: string
    /** The context its last model step read, as the board keeps it across a restart of the hooks. */
    held?: number
    replaced_by?: string
    last_read_seq: number
    last_nudged_seq?: number
    wake_claim?: { seq: number; attempts: number; until: number }
    told?: { seq: number; at: number; times: number }
  }
>

const countIn = (counts: Record<string, number>, name: string) => {
  const count = Object.hasOwn(counts, name) ? counts[name] : 0
  return Number.isSafeInteger(count) && count! > 0 ? count! : 0
}
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
    ready: boolean
    blocked_on: string[]
    asked: number
    unreachable: boolean
    /** It spent its own token budget. */
    paused?: boolean
    /** Read-only, past the context ceiling, its report on the board: the board wakes it no more. */
    heavy?: boolean
  }>
  /** Each name's posts, and each member's unread mentions, over the whole journal. Absent from an older board. */
  sent?: Record<string, number>
  unread?: Record<string, number>
  /** Each member's last report over the whole journal, and every edge's count there. Absent from an older board. */
  reported?: Record<string, { seq: number; word: string; partial: boolean; members: string[] }>
  edges?: Record<string, number>
  /** The last post `reported` and `edges` count. */
  through?: number
}

// What a member that is not working is waiting for, in words.
export function detailOf(status: string, hint: Report['members'][string] | undefined, _isPaused = false, isMemberPaused = false): string {
  if (status === 'killed' || status === 'coordinating' || status === 'failed') return ''
  // Said while it still works too: its next tool call is refused.
  if (isMemberPaused) return 'its token budget is spent'
  if (status === 'working') return ''
  if (status === 'unreachable') return 'cannot be woken'
  if (status === 'stopped') return 'its agent was stopped'
  if (hint?.heavy) return 'context ceiling reached'
  if (hint?.asked) return `waiting for an answer to #${hint.asked}`
  if (Array.isArray(hint?.blocked_on) && hint.blocked_on.length) return `waiting for ${hint.blocked_on.map(name => `@${name}`).join(', ')}`
  if (hint?.ready) return 'reported ready'

  return ''
}

/** The names a text mentions, in lower case, code and URLs left out: members, groups and `all` alike. */

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

const fullCommit = (id: unknown): id is string => typeof id === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(id)
const names = (list: unknown) => Array.isArray(list) ? list.filter((name): name is string => typeof name === 'string').map(clean) : undefined
/**
 * The fields board.py adds to a post, as a board line or `show --json` gives them, each kept only in its own shape.
 * A READY's commit, its base and the commits it also leaves out go into a git command line when its diff is opened:
 * only full commit ids, and `except` only beside a base and only when it holds some, all of them full.
 */
export function postFields(post: Record<string, unknown>): Pick<Post, 'revision' | 'base' | 'except' | 'partial' | 'members' | 'rejects' | 'candidate'> {
  const { revision, base, except, partial, members, rejects, candidate } = post
  const kept: Pick<Post, 'revision' | 'base' | 'except' | 'partial' | 'members' | 'rejects' | 'candidate'> = {}
  if (fullCommit(revision)) kept.revision = revision
  if (fullCommit(base)) {
    kept.base = base
    if (Array.isArray(except) && except.length > 0 && except.every(fullCommit)) kept.except = except
  }
  if (partial === true) kept.partial = true
  const covered = names(members)
  if (covered) kept.members = covered
  const rejected = names(rejects)
  if (rejected) kept.rejects = rejected
  if (typeof candidate === 'string') kept.candidate = clean(candidate)
  return kept
}

export function parsePosts(board: string, roster: Roster): Post[] {
  const posts: Post[] = []
  for (const line of board.split('\n')) {
    if (line.trim() === '') continue
    try {
      const post = JSON.parse(line) as Record<string, unknown> & Pick<Post, 'seq' | 'agent' | 'text' | 'time'> & { to?: string[] }
      if (!post || !Number.isSafeInteger(post.seq) || post.seq <= (posts.at(-1)?.seq ?? 0) ||
          typeof post.agent !== 'string' || typeof post.text !== 'string' || typeof post.time !== 'string' ||
          (post.to !== undefined && (!Array.isArray(post.to) || post.to.some(name => typeof name !== 'string')))) continue
      // board.py records the recipients; a board written before it did is read by its mentions
      const to =
        post.to ?? targets(post.text, roster, post.agent).filter(name => name !== post.agent)
      posts.push({ seq: post.seq, ...postFields(post), agent: clean(post.agent), time: clean(post.time), text: clean(post.text), to: to.map(clean) })
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
  const roster: Roster = Object.fromEntries(entriesOf(state.members).filter(([, member]) => member && typeof member === 'object'))
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
  // The last report each member made, for a closed run's roster.
  const reported = new Map<string, string>()
  const noteReport = (name: string, post: Pick<Post, 'seq' | 'text' | 'partial' | 'members'>) => {
    const kind = verdictOf(post as Post)
    if (!kind || kind.label === 'BRIEF') return
    const covered = kind.covered?.length ? ` of ${kind.covered.map(one => `@${one}`).join(', ')}` : ''
    reported.set(name, `Last report: ${kind.label}${covered} (#${post.seq})`)
  }
  // Read off the board's tail alone, a report before it is the board's to name. Seen in a test: a 4.2 MB journal left
  // an early READY "No outcome recorded".
  if ((posts[0]?.seq ?? 1) > 1) {
    for (const [name, last] of entriesOf(report?.reported)) {
      // One the tail holds, or newer than it, is read off the tail itself.
      if (last && typeof last.word === 'string' && Number(last.seq) < (posts[0]?.seq ?? 1)) noteReport(clean(name), { seq: Number(last.seq), text: last.word, ...(last.partial === true ? { partial: true as const } : {}), members: Array.isArray(last.members) ? last.members.map(String) : [] })
    }
  }
  for (const post of posts) {
    counts(post.agent).sent++
    said.set(post.agent, post.seq)
    noteReport(post.agent, post)
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
    // A closed run has no live state: a member is retired, or was there at the close.
    const base = isClosed ? (member.killed ? 'killed' : 'closed')
      : member.role === 'coordinator' && coordinating && !member.killed ? 'coordinating' : statusOf(member.role ?? 'worker', member, liveAgents)
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
    if (!isClosed && !state.paused && !member.paused && (member.role ?? 'worker') === 'worker' &&
        member.profile !== 'explorer' && member.profile !== 'architect' && member.consult !== '1' &&
        member.id !== undefined && status === 'waiting' &&
        hint !== undefined && !hint.ready && !hint.asked && !hint.paused && !hint.blocked_on?.length &&
        counts(name).unread === 0 && lastHeard > 0 && (said.get(name) ?? 0) < lastHeard) {
      zombieAttention.push({
        kind: 'silent',
        member: name,
        seq: lastHeard,
        text: `@${name} stopped without reporting: its agent ended after reading #${lastHeard} and it has posted nothing since. Ask it where it stands in a post that mentions it, or replace it.`,
      })
    }

    const isMemberPaused = !isClosed && !member.killed && (Boolean(member.paused) || hint?.paused === true)
    const isHeavy = !isClosed && !member.killed && hint?.heavy === true
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
      detail: isClosed ? (status !== 'closed' || member.role === 'coordinator' ? '' : reported.get(name) ?? 'No outcome recorded') : isZombie ? `still ${zombie.status} (${zombie.id})` : detailOf(status, hint, Boolean(state.paused), isMemberPaused),
      ...(isMemberPaused ? { isPaused: true as const } : {}),
      ...(isHeavy ? { isHeavy: true as const } : {}),
      ...(isZombie ? { isZombie: true as const } : {}),
      // The board counts over its whole journal; the posts read here are only the newest of a long board.
      unread: report?.unread ? countIn(report.unread, name) : counts(name).unread,
      posts: report?.sent ? countIn(report.sent, name) : counts(name).sent,
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
    earlierEdges: earlierEdgesOf(posts, kept, report?.edges, report?.through),
    members,
    attention: [...(report?.items ?? []), ...zombieAttention],
    budget: budgetOf(state),
    tokens: Object.fromEntries(entriesOf(state.usage?.tokens).map(([actor, count]) => [actor, positive(count)])),
  }
}
