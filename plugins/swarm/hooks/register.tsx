// The Swarm pane and its session hooks. board.py owns the board files.
import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, Register, Timer } from 'claude-code'

import type { Member, Post, Swarm, Tab } from '../types'
import { BOARD_CALL, COORDINATOR_READ, RUN, runsNamed, wakeMessage, wakeSequence } from './command'
import { DEFAULT_EFFORT, DEFAULT_MODEL, SPECIALISTS, SWARM_AGENTS, familyOf, latestOf } from './models'
import { KEPT, budgetOf, memberNamed, parse, parsePosts, tokensUsed, type BudgetState, type Report, type Roster } from './roster'
import { CLIP, bodyOf, clean, clip, compact, kindOf, openedText } from './text'
import { statusInk, statusCss, statusDot } from './palette'
import { hiveArt, toolMood, type Mood } from './hive'
import { edgesOf, graphHeight, graphSvg } from './graph'

const PANE = 'swarm'
const TITLE = 'Swarm'
const DEPLOYED = /^Swarm deployed\.(?:\s|$)/m
const EMPTY: Swarm = { title: '', dir: '', isClosed: false, posts: [], members: [], attention: [], budget: 0, tokens: {} }
const BOARD_TOOL = 'mcp__swarm__board'
const counted = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`
const TABS: Tab[] = ['board', 'attention', 'members', 'graph']
const REPLAY_FRAME_MS = 1200
const LIVE_INDICATOR = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">
  <style>
    ${statusCss}circle{fill:var(--status-working)}
    @media (prefers-reduced-motion: reduce){.breath{display:none}}
  </style>
  <circle class="breath" cx="8" cy="8" r="4" opacity=".2">
    <animate attributeName="r" values="3.5;7;3.5" dur="4s" repeatCount="indefinite"
      calcMode="spline" keyTimes="0;.5;1" keySplines=".42 0 .58 1;.42 0 .58 1"/>
    <animate attributeName="opacity" values=".3;.06;.3" dur="4s" repeatCount="indefinite"
      calcMode="spline" keyTimes="0;.5;1" keySplines=".42 0 .58 1;.42 0 .58 1"/>
  </circle>
  <circle cx="8" cy="8" r="3.5"/>
</svg>`

const swarm = atom({ plugin: 'swarm', key: 'swarm' } as const, EMPTY, {
  shape: 'swarm-4',
})
// The run folder this conversation's own board commands named: the pane shows
// it, and only for it does this session wake members or call a stall.
const run = atom({ plugin: 'swarm', key: 'run' } as const, '')
const tab = atom({ plugin: 'swarm', key: 'tab' } as const, 'board' as Tab)
const replay = atom({ plugin: 'swarm', key: 'replay' } as const, 0)
const loadError = atom({ plugin: 'swarm', key: 'loadError' } as const, '')
const isPlaying = atom({ plugin: 'swarm', key: 'isPlaying' } as const, false)
const livePulse = atom({ plugin: 'swarm', key: 'livePulse' } as const, 0)
const latestOnly = atom({ plugin: 'swarm', key: 'latestOnly' } as const, false)
const earlier = atom({ plugin: 'swarm', key: 'earlier' } as const, 0)
const hideInactive = atom({ plugin: 'swarm', key: 'hideInactive' } as const, false)
// The seq of the one long post shown in full; 0 for none.
const expanded = atom({ plugin: 'swarm', key: 'expanded' } as const, 0)
const inspected = atom({ plugin: 'swarm', key: 'inspected' } as const, null as Post | null)
// What the Board tab is narrowed to: text matched against sender, recipients, kind and body.
const query = atom({ plugin: 'swarm', key: 'query' } as const, '')

// One theme colour per member, by its place on the roster.
const HUES = ['claude', 'suggestion', 'success', 'warning', 'planMode', 'ide', 'merged', 'permission'] as const

let player: Timer | undefined
let livePlayer: Timer | undefined

function stop($: EngineInterface): Promise<unknown> {
  player?.cancel()
  player = undefined
  return update($, isPlaying, () => false)
}

async function stopLive($: EngineInterface): Promise<void> {
  livePlayer?.cancel()
  livePlayer = undefined
  await update($, livePulse, () => 0)
}

// Posts arriving together advance in board order without moving the replay cursor.
function scheduleLiveFrame($: EngineInterface): void {
  const timer = $.clock.after(REPLAY_FRAME_MS, () => void advance())
  livePlayer = timer

  async function advance() {
    const [{ posts }, current] = await Promise.all([read($, swarm), read($, livePulse)])
    if (livePlayer !== timer) return
    const next = posts.find(post => post.seq > current)
    if (next === undefined) {
      await stopLive($)
      return
    }
    await update($, livePulse, () => next.seq)
    if (livePlayer === timer) scheduleLiveFrame($)
  }
}

async function seek($: EngineInterface, seq: number): Promise<void> {
  await stop($)
  await stopLive($)
  await update($, replay, () => seq)
}

function scheduleFrame($: EngineInterface): void {
  const timer = $.clock.after(REPLAY_FRAME_MS, () => void advance())
  player = timer

  async function advance() {
    const [{ posts }, selected] = await Promise.all([read($, swarm), read($, replay)])
    if (player !== timer) return
    const next = posts.find(post => post.seq > selected)
    if (next === undefined) {
      await stop($)
      return
    }
    await update($, replay, () => next.seq)
    if (player === timer) scheduleFrame($)
  }
}

let isStartingPlay = false
async function play($: EngineInterface): Promise<void> {
  if (player !== undefined) {
    await stop($)
    return
  }
  // A second press while the first is still reading state would start a second timer.
  if (isStartingPlay) return
  isStartingPlay = true
  try {
    await startPlay($)
  } finally {
    isStartingPlay = false
  }
}
async function startPlay($: EngineInterface): Promise<void> {
  const [{ posts }, selected] = await Promise.all([read($, swarm), read($, replay)])
  const first = posts[0]?.seq
  const last = posts.at(-1)?.seq
  if (first === undefined || first === last) return
  await stopLive($)
  await update($, replay, () => selected === 0 || selected === last ? first : Math.max(first, selected))
  await update($, isPlaying, () => true)
  scheduleFrame($)
}

const QUIET_MS = 30_000
const WAKE_ATTEMPTS = 3
let seen = ''
let seenBoard = ''
let snapshot: Swarm | undefined
let attentionRetry = 0
let noticeFailures = 0
let noticeRetry = 0
let activity = ''
let isPolling = false
// A refresh asked for while one runs is run after it: a board command's result is otherwise shown a poll late.
let isRefreshOwed = false
// Set when a session ended by /clear or a resume: no session.start follows, so the next poll looks for the new session's run.
let isRestoreOwed = false
let poller: Timer | undefined
let generation = 0
const agentRuns = new Map<string, string>()
// A native teammate's address by agent id. The agent list drops a teammate when it ends, sometimes before its
// last turn completes, and its tokens and its wake are recorded under that address.
const teammates = new Map<string, string>()
function teammateOf(id: string, agent?: AgentInfo): string | undefined {
  if (agent?.teammateId) teammates.set(id, agent.teammateId)
  return agent?.teammateId ?? teammates.get(id)
}
const pendingStarts = new Set<string>()
const spawnEfforts = new Map<string, string | undefined>()
let quietSince = 0
// The newest action of each participant lasts through its turn. Agent ids are
// resolved against the displayed roster before their actions affect the hive.
const moods = new Map<string, Mood>()
let isCoordinatorBusy = false
let stalled = ''
let opened = ''
// Posts addressed to the coordinator that it has not read: told once in a tool result while it
// works, and once as a prompt when it is idle. Attention and `close` hold whatever it still skips.
const NONE = { count: 0, first: 0, last: 0, since: 0 }
const MENTION_GRACE_MS = 10_000
let owed = NONE
let hinted = 0
let prompted = 0
type SpecialistWake = { name: string; id: string; seq: number; attempts: number; native: boolean }
let specialistWakes: SpecialistWake[] = []
let relayRun = ''
let relayHinted = ''
let relayPrompted = ''

const relayKey = (dir: string) => dir === relayRun && specialistWakes.length ? JSON.stringify([dir, specialistWakes]) : ''
const teammateName = (address: string) => address.split('@', 1)[0] || address
const relayNotice = () => 'Relay these Swarm board wakes now with your own SendMessage tool. ' +
  'Use the recipient address from BOARD wake and copy the message exactly. Swarm records accepted delivery automatically.\n' +
  specialistWakes.map(({ name, id, seq, native }) =>
    `@${name}${native ? ` (SendMessage to the bare teammate name ${JSON.stringify(teammateName(id))})` : ''}: ${wakeMessage(seq)}`,
  ).join('\n')

function resetMonitoring(): void {
  moods.clear()
  generation++
  seen = seenBoard = activity = stalled = ''
  snapshot = undefined
  attentionRetry = noticeFailures = noticeRetry = 0
  owed = NONE
  hinted = prompted = 0
  specialistWakes = []
  relayRun = relayHinted = relayPrompted = ''
}

function boardCommand($: EngineInterface, directory: string, args: string[], stdin?: string) {
  return $.process.run(
    ['python3', `${$.plugin.root}/skills/swarm/scripts/board.py`, directory, ...args],
    stdin === undefined ? undefined : { stdin },
  )
}

// A read over 4 MiB is refused, and a long run's board grows past that. The board's own `tail` then gives the
// newest posts, so the pane, the wakes and the stall check keep working.
// ponytail: posts older than the tail drop out of the pane and the graph; page through the file if that matters.
async function readBoard($: EngineInterface, dir: string): Promise<string> {
  try {
    return await $.fs.read(`${dir}/board.jsonl`)
  } catch (error) {
    const tail = await boardCommand($, dir, ['tail'])
    if (tail.exitCode !== 0 || tail.isStdoutTruncated) throw error
    return tail.stdout
  }
}

async function reportOf($: EngineInterface, dir: string): Promise<Report | undefined> {
  try {
    const answer = await boardCommand($, dir, ['attention', '--json'])
    const report = JSON.parse(answer.stdout) as Report
    if (answer.exitCode !== 0 || !Array.isArray(report.items) || !report.members) return undefined

    return { ...report, items: report.items.map(item => ({ ...item, text: clean(String(item.text ?? '')) })) }
  } catch {
    return undefined // no python, or an older board: the pane still draws what it can
  }
}

async function digest(value: string): Promise<string> {
  const key = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(key)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

async function lookupKey($: EngineInterface): Promise<string> {
  return digest(await $.session.id())
}

// The chat row that opens the pane: one per run, so a new run gets a fresh row at the end.
const OPENER = 'swarm-open-'
const SHORTCUT = 'swarm-board-shortcut'
type Node = { type?: string; props?: { key?: unknown }; children?: unknown[] }
function findKey(node: unknown, key: string): Node | undefined {
  if (!node || typeof node !== 'object') return undefined
  const n = node as Node
  if (n.props?.key === key) return n
  for (const child of n.children ?? []) {
    const match = findKey(child, key)
    if (match) return match
  }
  return undefined
}
function textCount(node: unknown): number {
  if (!node || typeof node !== 'object') return 0
  const n = node as Node
  return n.type === 'Text' ? 1 : (n.children ?? []).reduce<number>((sum, child) => sum + textCount(child), 0)
}
const openerOf = (dir: string) =>
  OPENER + dir.slice(dir.lastIndexOf('/') + 1).replace(/[^A-Za-z0-9_-]/g, '_').slice(-50)

function openBoard($: EngineInterface) {
  return $.ui.open({ id: PANE, title: TITLE })
}

// Binds the run this session saved, if any: at a start, and on the first poll after /clear or a resume.
async function restore($: EngineInterface, cwd: string): Promise<void> {
  try {
    const restored = await boardCommand($, `${cwd}/.swarm`, ['restore', await lookupKey($)])
    const dir = restored.stdout.trim()
    if (restored.exitCode === 0 && RUN.test(dir)) await own($, dir)
  } catch {
    // A project without a board still starts normally.
  }
}

// True when the project's newest run exists and is not closed.
async function openRunHere($: EngineInterface): Promise<boolean> {
  try {
    const root = `${await $.session.cwd()}/.swarm`
    const name = (await $.fs.read(`${root}/current`)).trim()
    if (!/^[\w.-]+$/.test(name) || name === '.' || name === '..') return false
    return (JSON.parse(await $.fs.read(`${root}/${name}/members.json`)) as { closed?: boolean }).closed !== true
  } catch {
    return false
  }
}

// Makes `dir` this conversation's run and offers its pane in the chat.
async function own($: EngineInterface, dir: string): Promise<void> {
  if (await read($, run) !== dir) resetMonitoring()
  await update($, run, () => dir)
  // A resumed conversation gets the row again, since placed rows are not saved; a closed run does not.
  const isClosed = await $.fs.read(`${dir}/members.json`)
    .then(text => (JSON.parse(text) as { closed?: boolean }).closed === true)
    .catch(() => false)
  if (!isClosed) await $.ui.place({ id: openerOf(dir) }).catch(() => undefined)
  // The desktop app queues /swarm-board typed while the coordinator works, so a run opens its own pane once.
  if (!isClosed && opened !== dir) {
    opened = dir
    await openBoard($).catch(() => undefined)
  }
}

// A coordinator may type its board commands in any form (shell variables, a wrapper script), so
// ownership cannot rest on reading them. Starting a registered member is the act that shows it.
// The board never guesses between two unowned runs that both have the member: it answers AMBIGUOUS,
// unless the member's prompt names one of their folders.
const AMBIGUOUS = '?'
// An open run this conversation could drive exists, and the name is not on its roster.
const UNREGISTERED = '!'
const WRONG_RUN = '-'
async function adopt($: EngineInterface, name: string | undefined, prompt = ''): Promise<string> {
  if (!name) return ''
  try {
    const result = await boardCommand($, `${await $.session.cwd()}/.swarm`, ['locate', await lookupKey($), name, ...runsNamed(prompt)])
    if (result.exitCode === 3) return AMBIGUOUS
    if (result.exitCode === 4) return UNREGISTERED
    if (result.exitCode !== 0) return WRONG_RUN
    const dir = result.stdout.trim()
    if (!RUN.test(dir)) return ''
    return dir
  } catch {
    return WRONG_RUN
  }
}

async function bind($: EngineInterface, dir: string): Promise<boolean> {
  try {
    const saved = await boardCommand($, dir, ['bind', await lookupKey($)])
    if (saved.exitCode !== 0) return false
    await own($, dir)
    return true
  } catch {
    return false
  }
}

async function agentRun($: EngineInterface, id: string, agent?: AgentInfo): Promise<string> {
  const saved = agentRuns.get(id)
  if (saved) return saved
  const address = teammateOf(id, agent) ?? id
  const active = await read($, run)
  if (active) {
    const roster = await $.fs.read(`${active}/members.json`).then(text => (JSON.parse(text) as { members: Roster }).members)
      .catch(() => undefined)
    const registered = roster && Object.values(roster).some(member => member.id === address || member.id === id)
    const name = /^@([a-z][a-z0-9_-]*):/.exec(agent?.description ?? '')?.[1]
    const starting = roster && memberNamed(roster, name)
    if (registered || (starting && !starting.id && !starting.killed && agent?.type === `swarm:${starting.profile || starting.role || 'worker'}`)) {
      return active
    }
  }
  const result = await boardCommand($, `${await $.session.cwd()}/.swarm`, ['agent-run', await lookupKey($), id, ...(address === id ? [] : [address])])
  const dir = result.stdout.trim()
  if (result.exitCode !== 0 || !RUN.test(dir)) return ''
  agentRuns.set(id, dir)
  return dir
}

// The agent's own transcript in the main view; the coordinator's is the main conversation.
/** Shows the member's conversation; false when there is none to show, with a toast saying why. */
async function viewAgent($: EngineInterface, member: Member | undefined): Promise<boolean> {
  if (member === undefined) return false
  if (member.role === 'coordinator') return !(await $.ui.view({})).deny
  const agent = (await $.agent.list()).find(one => one.id === member.id || one.teammateId === member.id)
  const moved = agent
    ? await $.ui.view({ agentId: agent.id })
    : { deny: member.id === undefined
        ? 'no agent was started for it'
        : 'its agent has ended or belongs to another conversation, so there is no live conversation to open' }
  if (moved.deny) $.ui.toast(`@${member.name}: ${moved.deny}. Showing its posts instead.`)
  return !moved.deny
}

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'"
}

async function deliver(
  $: EngineInterface,
  dir: string,
  roster: Roster,
  posts: Post[],
  agents: AgentInfo[],
  now: number,
  epoch: number,
): Promise<{ pending: boolean; exhausted: string[]; relay: SpecialistWake[] }> {
  const script = `${$.plugin.root}/skills/swarm/scripts/board.py`
  const results = { pending: false, exhausted: [] as string[], relay: [] as SpecialistWake[] }
  const native = roster.coordinator?.backend === 'native'
  for (const [name, member] of Object.entries(roster)) {
    if (epoch !== generation) break
    const id = member.id
    if (!id || member.killed || member.role === 'coordinator') continue
    const from = Math.max(member.last_read_seq, member.last_nudged_seq ?? 0)
    const seq = posts.findLast(post => post.seq > from && post.to.includes(name))?.seq
    if (seq === undefined) {
      const told = member.told
      if (told && member.last_read_seq < told.seq && told.seq === member.last_nudged_seq && told.times < WAKE_ATTEMPTS &&
          now - told.at * 1000 >= QUIET_MS && agents.some(agent => (agent.id === id || agent.teammateId === id) &&
            ['completed', 'idle', 'failed'].includes(agent.status))) {
        // A fast turn can end before the send is acknowledged. Recover a missed rearm once its loop is idle.
        await boardCommand($, dir, ['rearm', '0', id])
        results.pending = true
      }
      continue
    }
    const claim = member.wake_claim
    if (claim && claim.until * 1000 > now) {
      results.pending = true
      continue
    }
    if (claim?.seq === seq && claim.attempts >= WAKE_ATTEMPTS) {
      results.exhausted.push(`@${name}`)
      continue
    }
    // Claude skips the sending plugin's tool hooks in a plugin-origin wake,
    // even when the plugin calls SendMessage. These roles need a model-origin send.
    if (SPECIALISTS.includes(member.profile ?? '')) {
      results.relay.push({ name, id, seq, attempts: claim?.seq === seq ? claim.attempts : 0, native })
      continue
    }

    const reserved = await boardCommand($, dir, ['claim', name, id, String(seq)]).catch(() => undefined)
    if (epoch !== generation) break
    const token = reserved?.stdout.trim() ?? ''
    if (reserved?.exitCode !== 0 || !/^[a-f0-9]{32}$/.test(token)) continue
    results.pending = true
    try {
      const text = `New board mentions through #${seq}. Run: python3 ${shellQuote(script)} ${shellQuote(dir)} read ${name}`
      const { isDelivered } = await $.session.send({ to: native ? teammateName(id) : { agentId: id }, text })
      if (isDelivered) await boardCommand($, dir, ['woke', name, String(seq), token])
    } catch {
      // The claim expires so an interrupted or failed send can be retried.
    }
  }
  return results
}

function unreadNotice($: EngineInterface, dir: string): string {
  const script = `${$.plugin.root}/skills/swarm/scripts/board.py`
  return `${owed.count} board post(s) address you from #${owed.first} on and you have not read them. ` +
    `Read them before anything else: python3 ${shellQuote(script)} ${shellQuote(dir)} read coordinator`
}

function moodOf(full: Swarm, agents: AgentInfo[]): Mood {
  if (full.isClosed || full.isPaused) return 'sleep'
  const participants = new Set(full.members.filter(m => m.status === 'working' || m.status === 'coordinating')
    .map(m => m.role === 'coordinator' ? 'coordinator' : agents.find(a => a.teammateId === m.id || a.id === m.id)?.id ?? m.id))
  if (!participants.size) return 'sleep'
  return Array.from(moods).reverse().find(([id]) => participants.has(id))?.[1] ?? 'forage'
}

async function refresh($: EngineInterface): Promise<void> {
  if (isPolling) {
    isRefreshOwed = true
    return
  }
  isPolling = true
  if (isRestoreOwed) {
    isRestoreOwed = false
    await restore($, await $.session.cwd().catch(() => ''))
  }
  const epoch = generation
  try {
    const now = await $.clock.now()
    const owned = await read($, run)
    let dir = owned
    if (dir === '') {
      // No run of this conversation's: show the project's newest, and only show it.
      const root = `${await $.session.cwd()}/.swarm`
      if (!(await $.fs.exists(`${root}/current`))) {
        if (epoch !== generation) return
        if ((await read($, swarm)).dir) {
          await seek($, 0)
          await update($, swarm, () => EMPTY)
        }
        seen = seenBoard = ''
        snapshot = undefined
        if (await read($, loadError)) await update($, loadError, () => '')
        return
      }
      const name = (await $.fs.read(`${root}/current`)).trim()
      if (!/^[\w.-]+$/.test(name) || name === '.' || name === '..') throw new Error('invalid board pointer')
      dir = `${root}/${name}`
    }
    const [board, rosterText, agents] = await Promise.all([
      readBoard($, dir),
      $.fs.read(`${dir}/members.json`),
      $.agent.list(),
    ])
    if (epoch !== generation) return
    const state = JSON.parse(rosterText) as { members: Roster; paused?: string; closed?: boolean }
    const agentStates = JSON.stringify(agents.map(a => [a.id, a.teammateId, a.status]))
    const progress = JSON.stringify([dir, board.length, agentStates, state.paused, state.closed,
      Object.entries(state.members).map(([name, m]) => [name, m.id, m.killed, m.last_read_seq])])
    if (progress !== activity) {
      activity = progress
      quietSince = now
    }
    const coordinating = !!owned && isCoordinatorBusy && !state.closed && !state.paused
    const key = JSON.stringify([dir, rosterText, agentStates, coordinating])
    let full = snapshot
    if (!full || key !== seen || board !== seenBoard || (attentionRetry > 0 && now >= attentionRetry)) {
      const report = await reportOf($, dir)
      if (epoch !== generation) return
      attentionRetry = report ? 0 : now + 10_000
      full = parse(dir, board, rosterText, agents, Infinity, report, coordinating)
      full.mood = moodOf(full, agents)
      const next = { ...full, posts: full.posts.slice(-KEPT), earlierEdges: edgesOf(full.posts.slice(0, -KEPT)), attentionUnavailable: !report }
      const previous = await read($, swarm)
      const lastPost = previous.posts.at(-1)?.seq ?? 0
      if (previous.dir !== dir) {
        await seek($, 0)
        await update($, expanded, () => 0)
        await update($, inspected, () => null)
        await update($, earlier, () => 0)
        await update($, query, () => '')
      } else if (livePlayer === undefined && await read($, tab) === 'graph' && await read($, replay) === 0) {
        const firstNew = next.posts.find(post => post.seq > lastPost)
        if (firstNew) {
          await update($, livePulse, () => firstNew.seq)
          scheduleLiveFrame($)
        }
      }
      await update($, swarm, () => next)
      seen = key
      seenBoard = board
      snapshot = full
    }
    if (epoch !== generation) return
    const mood = moodOf(full, agents)
    if (full.mood !== mood) {
      await update($, swarm, prev => prev.dir === dir ? { ...prev, mood } : prev)
      full.mood = mood
    }
    if (await read($, loadError)) await update($, loadError, () => '')
    const unread = owned && !state.closed
      ? full.posts.filter(post => post.seq > (state.members.coordinator?.last_read_seq ?? 0) && post.to.includes('coordinator'))
      : []
    const last = unread.at(-1)?.seq ?? 0
    owed = last === 0 ? NONE : { count: unread.length, first: unread[0]?.seq ?? last, last, since: last === owed.last ? owed.since : now }
    if (!owned || state.closed || state.paused || (full.budget > 0 && tokensUsed(full.tokens) >= full.budget)) {
      specialistWakes = []
      relayHinted = relayPrompted = ''
      return
    }
    if (epoch !== generation) return
    const { pending, exhausted, relay } = await deliver($, dir, state.members, full.posts, agents, now, epoch)
    if (epoch !== generation) return
    specialistWakes = relay
    relayRun = dir
    const keyToRelay = relayKey(dir)
    if (keyToRelay === '') relayHinted = relayPrompted = ''
    if (isCoordinatorBusy || now < noticeRetry) return
    const workers = full.members.filter(member => member.role !== 'coordinator' && member.status !== 'killed')
    const notices: string[] = []
    const askRelay = keyToRelay !== '' && keyToRelay !== relayPrompted
    const answerThrough = owed.last > prompted && (askRelay || now - owed.since >= MENTION_GRACE_MS) ? owed.last : 0
    const askStall = !pending && !askRelay && workers.length > 0 &&
      workers.every(member => member.status !== 'working') && stalled !== progress && now - quietSince >= QUIET_MS
    if (askRelay) {
      relayPrompted = keyToRelay
      notices.push(relayNotice())
    }
    if (answerThrough) {
      prompted = answerThrough
      notices.push(unreadNotice($, dir))
    }
    if (askStall) {
      stalled = progress
      const failures = exhausted.length ? ` Wake attempts exhausted for ${exhausted.join(', ')}.` : ''
      notices.push(`Every member is waiting, stopped or unstarted and the run is still open.${failures} Read the board and either unblock work, close the run, or pause it if you need the user's decision.`)
      if (relay.length > 0) notices.push(relayNotice())
    }
    if (notices.length > 0) {
      const heading = askRelay ? 'Delivering board mentions' : answerThrough ? 'Unread board mentions' : 'Run needs attention'
      void $.prompt.submit({ text: `Swarm: ${heading}\nRun: ${full.title.replace(/\s+/g, ' ')}\n${notices.join('\n\n')}` })
        .then(result => {
          if (epoch !== generation) return
          noticeFailures = noticeRetry = 0
          // An explicit drop can mean the user stopped the session. Leave the notice on the board.
          if (result.drop) $.ui.toast('Swarm was unable to notify the coordinator. Check the board for pending work.')
        }).catch(() => {
          if (epoch !== generation) return
          if (++noticeFailures >= WAKE_ATTEMPTS) {
            noticeFailures = 0
            $.ui.toast('Swarm was unable to notify the coordinator. Check the board for pending work.')
            return
          }
          noticeRetry = now + noticeFailures * 5000
          if (askRelay && relayPrompted === keyToRelay) relayPrompted = ''
          if (answerThrough && prompted === answerThrough) prompted = 0
          if (askStall && stalled === progress) stalled = ''
        })
    }
  } catch {
    if (epoch === generation && !(await read($, loadError))) {
      await update($, loadError, () => 'Swarm could not read the board. It will retry automatically.')
    }
  } finally {
    isPolling = false
    if (isRefreshOwed) {
      isRefreshOwed = false
      $.clock.after(0, () => void refresh($))
    }
  }
}

// Only a completed turn contributes usage, even if it finishes after a pause.
async function account(
  $: EngineInterface,
  turnId: string,
  agentId: string | undefined,
  spent: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number } | undefined,
): Promise<void> {
  if (spent === undefined) return
  const fresh = spent.input_tokens + spent.cache_creation_input_tokens + spent.output_tokens
  if (!Number.isSafeInteger(fresh) || fresh <= 0) return

  const agent = agentId ? await $.agent.list().then(agents => agents.find(one => one.id === agentId)).catch(() => undefined) : undefined
  const address = agentId && (teammateOf(agentId, agent) ?? agentId)
  const dir = agentId ? await agentRun($, agentId, agent) : await read($, run)
  if (!dir) return
  const [turn, actor] = await Promise.all([
    digest(`swarm-turn:${turnId}`),
    address ? digest(`swarm-agent:${address}`) : Promise.resolve('coordinator'),
  ])
  const result = await boardCommand($, dir, ['account', turn, actor, String(fresh)])
  if (result.exitCode !== 0) return
  const entry = JSON.parse(result.stdout) as { title: string; total: number; budget: number; paused: boolean }
  if (!entry.paused || dir !== await read($, run)) return
  void $.prompt.submit({
    text: `Swarm: Run paused at token budget\n${entry.title} spent ${compact(entry.total)} tokens and reached its budget of ${compact(entry.budget)}. Tell the user what is done and ask whether to raise the budget with limit and then resume, or close the run.`,
  }).catch(() => {})
}

async function specialistBoard($: EngineInterface, e: {
  agentId?: string
  action: string
  member?: string
  seq?: number
  text?: string
}) {
  if (!e.agentId) return { deny: 'The Swarm board tool is for Swarm specialists. The coordinator uses the board command.' }
  const agents = await $.agent.list()
  const agent = agents.find(candidate => candidate.id === e.agentId)
  if (!agent || !SPECIALISTS.some(role => agent.type === `swarm:${role}`)) return { deny: 'The Swarm board tool requires a read-only Swarm specialist.' }
  const describedName = /^@([a-z][a-z0-9_-]*):/.exec(agent?.description ?? '')?.[1]
  let dir = await agentRun($, e.agentId, agent)
  let needsBinding = false
  // No run yet, or this agent belongs to a newer run than the one the conversation last owned.
  if (!dir) {
    let adopted = await adopt($, describedName)
    if (adopted === UNREGISTERED || adopted === WRONG_RUN) adopted = ''
    if (adopted === AMBIGUOUS) {
      return { deny: `The board refused this call: more than one open Swarm run in this project has a member @${describedName} and none is bound to the conversation that started you. End your turn and report this sentence to the coordinator: it must run its board's "read coordinator" command written out in full (python3 <board.py> <run folder> read coordinator), then message you to retry.` }
    }
    dir = adopted || dir
    needsBinding = Boolean(adopted)
  }
  if (!dir) {
    return { deny: 'No Swarm run is bound to the conversation that started you, so the board cannot tell which run you belong to. End your turn and report this to the coordinator: it must register you with the board\'s member command, start you with a description that begins "@<your name>: ", and then send you a message to retry.' }
  }

  const { members, closed } = JSON.parse(await $.fs.read(`${dir}/members.json`)) as {
    members: Roster
    closed?: boolean
  }
  const assigned = Object.entries(members).find(([, member]) =>
    member.id !== undefined && (member.id === e.agentId || member.id === agent?.teammateId),
  )
  // The first read may arrive before the coordinator records the returned address.
  const starting = memberNamed(members, describedName)
  const uniqueStarter = starting && !starting.id &&
    agents.filter(candidate => candidate.type === agent?.type && candidate.description.startsWith(`@${describedName}:`)).length === 1
  const assignment = assigned ?? (uniqueStarter && describedName ? [describedName, starting] as const : undefined)
  const member = assignment?.[1]
  const kind = agent?.type.slice('swarm:'.length) ?? ''
  const fault = !assignment || !member
    ? `the roster has no member for this agent. It must be registered under the name its description starts with ("@<name>: ")`
    : member.killed
      ? `@${assignment[0]} was removed from the run`
      : member.role !== 'worker' || member.writes !== '0' || member.profile !== kind || !SPECIALISTS.includes(kind)
        ? `@${assignment[0]} is not registered as a read-only ${kind}. The coordinator fixes it with: member ${assignment[0]} profile=${kind} writes=0`
        : ''
  if (!assignment || !member || fault) {
    return { deny: `The board refused this call: ${fault}. End your turn and report this sentence to the coordinator.` }
  }
  if (needsBinding && !(await bind($, dir))) return { deny: 'The Swarm run could not be bound to this conversation.' }

  const [name] = assignment
  agentRuns.set(e.agentId, dir)
  const { action } = e
  // A name as a member would write it: with its @, in any case.
  const who = e.member?.trim().replace(/^@/, '').toLowerCase()
  if (who !== undefined && (action !== 'show' || !/^[a-z][a-z0-9_-]*$/.test(who))) {
    return { deny: action === 'show' ? 'The member filter is a member\'s name, such as "parser".' : 'A member filter is only valid for show.' }
  }
  if (e.seq !== undefined && (action !== 'show' || e.member !== undefined || !Number.isSafeInteger(e.seq) || e.seq < 1)) {
    return { deny: 'Use a positive post number with show, without a member filter.' }
  }
  if (!['read', 'show', 'post', 'ready', 'revise'].includes(action)) {
    return { deny: 'Unknown board action.' }
  }

  const text = typeof e.text === 'string' ? e.text.trim() : ''
  const writesPost = action === 'post' || action === 'ready' || action === 'revise'
  if (writesPost && (closed || !text || text.length > 12000)) {
    return { deny: 'Use a nonempty report of at most 12,000 characters on an open run.' }
  }
  const args = action === 'show'
    ? (who ? [action, who] : e.seq ? [action, `--post=${e.seq}`] : [action])
    : [action, name]
  if (action === 'read') args.push('--max-bytes=48000')
  if (action === 'revise') args.push(text)
  let result = await boardCommand($, dir, args, action === 'post' || action === 'ready' ? text : undefined)
  let note = ''
  if (action === 'read' && result.exitCode !== 0 && result.stderr.includes('exceeds the read page')) {
    // One post longer than a page would block every later read. Its first line is shown, the cursor moves on.
    result = await boardCommand($, dir, [...args, '--headers'])
    note = '\nA post addressed to you was too long to show whole: every post is shown as one line. Open the ones you need with action show and seq.'
  }
  if (result.exitCode !== 0) return { deny: result.stderr.trim() || 'The board action failed.' }
  if (result.isStdoutTruncated) return { deny: 'The board response exceeded the tool limit. Use show with a post number, or ask the coordinator for help if it is a single long post.' }
  if (writesPost || action === 'read') $.clock.after(0, () => void refresh($))
  return { result: result.stdout + note }
}

// The band's button that opens the pane.
function shortcut($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0], singleCaption = false) {
  const { Box, Button } = $.ui.resolve(e)
  const button = <Button key={SHORTCUT} variant="secondary" label="Swarm: The Board" onPress={() => void openBoard($)} />
  if (e.surface !== 'desktop') return button
  // Cover the composer's tinted inset with the same theme surface as the crab.
  return <Box flexDirection="row" alignItems="center" backgroundColor="userMessageBackground"
    marginLeft={-2} paddingLeft={2} marginRight={-2} paddingRight={2}
    marginTop={-2} paddingTop={singleCaption ? 3 : 2} marginBottom={-1.16} paddingBottom={singleCaption ? 0.16 : 1.16}>{button}</Box>
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    poller?.cancel()
    resetMonitoring()
    agentRuns.clear()
    teammates.clear()
    pendingStarts.clear()
    spawnEfforts.clear()
    isCoordinatorBusy = false
    await update($, run, () => '')
    await update($, swarm, () => EMPTY)
    await update($, loadError, () => '')
    await $.command.register({
      name: 'swarm-board',
      immediate: true,
      description:
        'Open the Swarm pane: the live board, members and @mention graph',
    })
    await $.tool.register({
      name: 'board',
      description: 'Swarm specialist board. Read unread posts, show history, post a message, report ready, or withdraw readiness. The tool uses your own assignment.',
      isDeferred: false,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { enum: ['read', 'show', 'post', 'ready', 'revise'] },
          member: { type: 'string', description: 'Optional member filter for show.' },
          seq: { type: 'integer', minimum: 1, description: 'Optional single post number for show.' },
          text: { type: 'string', maxLength: 12000, description: 'Report, message, or reason.' },
        },
        required: ['action'],
      },
    })
    await stop($)
    await stopLive($)
    isRestoreOwed = false
    await restore($, e.cwd)
    poller = $.clock.every(2000, () => void refresh($))

    return next(e)
  })

  // The board tool has a hook of its own, as the engine asks of a registered tool. Seen live: served
  // from the general hook below, a specialist resumed by a wake got "no tool.call hook answered".
  // @ts-ignore TS2589: with every connected MCP tool in the generated types, this overload is too deep to check
  on('tool.call', { tool: BOARD_TOOL }, async ($, e) => {
    if (e.agentId) {
      moods.delete(e.agentId)
      moods.set(e.agentId, ['read', 'show'].includes(e.action) ? 'inspect' : 'relay')
    }
    try {
      return await specialistBoard($, e)
    } catch (error) {
      return { deny: `The board tool failed (${error instanceof Error ? error.message : String(error)}). End your turn and report this sentence to the coordinator.` }
    }
  })

  on('tool.call', async ($, e, next) => {
    // A tool call in the main conversation means the coordinator is mid-turn, even when this
    // module loaded after that turn began (a restart, a reload) and never saw it start.
    if (e.agentId === undefined) isCoordinatorBusy = true
    const actor = e.agentId ?? 'coordinator'
    moods.delete(actor)
    moods.set(actor, e.tool === BOARD_TOOL && ['read', 'show'].includes(e.action) ? 'inspect' : toolMood(e.tool, e.tool === 'Bash' ? String(e.command) : ''))
    const agentCall = e.tool === 'Agent' && typeof e.tool_use_id === 'string' ? e.tool_use_id : undefined
    if (agentCall && e.tool === 'Agent') spawnEfforts.set(agentCall, e.effort)
    const raw = await next(e).finally(() => { if (agentCall) spawnEfforts.delete(agentCall) })
    let result = raw
    try {
      if (e.agentId === undefined && raw.deny === undefined && raw.isError === undefined) {
        if (e.tool === 'Bash' && COORDINATOR_READ.test(String(e.command))) owed = NONE
        const dir = await read($, run)
        const notices: string[] = []
        const key = relayKey(dir)
        if (key && key !== relayHinted && !(e.tool === 'SendMessage' && Number.isSafeInteger(wakeSequence(String(e.message))))) {
          relayHinted = key
          notices.push(relayNotice())
        }
        if (dir && owed.last > hinted) {
          hinted = owed.last
          notices.push(`Swarm: ${unreadNotice($, dir)}`)
        }
        if (notices.length > 0) result = { ...raw, context: [...(raw.context ?? []), ...notices] }
      }
    } catch {
      // A failed reminder must not change the tool's result.
    }
    if (e.tool !== 'Bash' || result.isError || result.deny) return result
    const match = BOARD_CALL.exec(String(e.command))
    const dir = (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').replace(/\/+$/, '')
    if (!RUN.test(dir)) return result
    try {
      const owned = await read($, run)
      if (e.agentId === undefined && match?.[4] === 'read' && COORDINATOR_READ.test(String(e.command)) && dir !== owned) {
        await bind($, dir)
      }
      if (dir === owned || e.agentId === undefined) $.clock.after(0, () => void refresh($))
    } catch {
      // A failed binding must not change the tool's result.
    }
    return result
  })

  on('session.send', async ($, e, next) => {
    const seq = wakeSequence(e.text)
    if (!Number.isSafeInteger(seq) || e.agentId !== undefined || e.origin.kind !== 'model') return next(e)
    const dir = await read($, run)
    if (!dir) return { isDelivered: false, reason: 'No Swarm run is bound to this conversation.' }
    const state = await $.fs.read(`${dir}/members.json`).then(text => JSON.parse(text) as BudgetState & {
      members: Roster; paused?: string; closed?: boolean
    }).catch(() => undefined)
    if (!state) return { isDelivered: false, reason: 'Swarm could not read the run state. Retry after checking the board.' }
    const native = state.members.coordinator?.backend === 'native'
    const matches = Object.entries(state.members).filter(([, member]) => member.id && !member.killed &&
      SPECIALISTS.includes(member.profile ?? '') && (member.id === e.to || (native && teammateName(member.id) === e.to)))
    const [name, member] = matches.length === 1 ? matches[0]! : []
    const budget = budgetOf(state)
    if (!name || !member?.id || state.closed || state.paused || (budget > 0 && tokensUsed(state.usage?.tokens) >= budget)) {
      return { isDelivered: false, reason: 'The Swarm wake is no longer eligible.' }
    }
    const reserved = await boardCommand($, dir, ['claim', name, member.id, String(seq)]).catch(() => undefined)
    const token = reserved?.stdout.trim() ?? ''
    if (reserved?.exitCode !== 0 || !/^[a-f0-9]{32}$/.test(token)) {
      return { isDelivered: false, reason: 'The Swarm wake is already handled or awaiting retry.' }
    }
    const sent = await next(e)
    if (sent.isDelivered) await boardCommand($, dir, ['woke', name, String(seq), token]).catch(() => undefined)
    $.clock.after(0, () => void refresh($))
    return sent
  }).catch((_, e, next) => {
    // A wake relay that could not be checked is not sent unclaimed: it would be delivered twice or to a retired member.
    if (next.called || !Number.isSafeInteger(wakeSequence(e.text)) || e.agentId !== undefined || e.origin.kind !== 'model') return next(e)
    return { isDelivered: false, reason: 'Swarm could not check this wake. Retry after checking the board.' }
  })

  on('agent.spawn', async ($, e, next) => {
    if (!SWARM_AGENTS.has(e.subagentType)) return next(e)
    const named = /^@([a-z][a-z0-9_-]*):/.exec(e.description)?.[1]
    type RunState = {
      title?: string
      members: Roster
      closed?: boolean
      paused?: string
    } & BudgetState
    const stateOf = async (dir: string) => JSON.parse(await $.fs.read(`${dir}/members.json`)) as RunState
    const current = await read($, run)
    const running = e.resume ? await $.agent.list().then(agents => agents.find(agent => agent.id === e.resume?.agentId)) : undefined
    const resumedRun = e.resume ? await agentRun($, e.resume.agentId, running) : ''
    let owned = resumedRun || current
    let state = owned ? await stateOf(owned).catch(() => undefined) : undefined
    if (owned && !state) return { deny: 'Swarm could not read this run’s roster. Check the board before starting or resuming a member.' }
    // No run yet, or the member belongs to another run than the one this conversation last owned:
    // a newer one, or, where the name is reused, the one its prompt names.
    const ownName = owned.slice(owned.lastIndexOf('/') + 1)
    const elsewhere = runsNamed(e.prompt).filter(name => name !== ownName)
    const isReused = Boolean(state && !state.closed && memberNamed(state.members, named)) && elsewhere.length > 0
    if (!e.resume && (!state || state.closed || !memberNamed(state.members, named) || isReused)) {
      let adopted = await adopt($, named, e.prompt)
      if (adopted === WRONG_RUN) return { deny: `Swarm could not resolve a run for @${named}. Check the board folder, ownership, and roster before starting the member.` }
      // A reused name moves the conversation only to a run the prompt names. A prompt that names
      // other runs and not this one is never quietly started under this one's rules.
      if (isReused && !elsewhere.includes(adopted.slice(adopted.lastIndexOf('/') + 1))) {
        if (!runsNamed(e.prompt).includes(ownName)) {
          return { deny: `@${named}'s prompt names the run folder ${elsewhere.join(', ')}, which this conversation cannot drive: it is closed, owned by another conversation, has no member @${named}, or cannot be told apart from another run. So @${named} is not started, and not under this conversation's run ${ownName} either. Put the folder of the run it belongs to in its prompt, or register the member in that run first.` }
        }
        adopted = ""
      }
      // Seen live: the first start of a run, before the conversation owns it, let an unregistered name through.
      if (adopted === UNREGISTERED) {
        if (!state || state.closed) {
          return { deny: 'Register the member with the board\'s member command first, then start it with a description that begins "@<its name>: ".' }
        }
        adopted = ""
      }
      if (adopted === AMBIGUOUS) {
        return { deny: `More than one open Swarm run in this project has a member @${named}, and this conversation owns none of them, so @${named} is not started. Claim your run by running its "read coordinator" command written out in full (python3 <board.py> <run folder> read coordinator), or name the run folder in the member's prompt. Then start the member again.` }
      }
      if (adopted && adopted !== owned) {
        owned = adopted
        state = await stateOf(owned).catch(() => undefined)
        if (!state) return { deny: 'Swarm could not read the selected run’s roster.' }
      }
    }
    if (!owned || !state) {
      // No run could be matched. With a name the board already answered; without one, a member of the
      // project's open run would start outside its roster and limits.
      if (!named && !e.resume && await openRunHere($)) {
        return { deny: 'This project has an open Swarm run. Register the member with the board\'s member command, then start it with a description that begins "@<its name>: ".' }
      }
      return next(e)
    }
    // A closed run starts nobody. An agent that is no member of it is none of the swarm's business.
    if (state.closed) {
      return resumedRun || memberNamed(state.members, named)
        ? { deny: `Swarm "${state.title ?? ''}" is closed, so @${named} is not started. Start a new run with the board's init command and register the member there.` }
        : next(e)
    }
    const budget = budgetOf(state)
    const total = tokensUsed(state.usage?.tokens)
    if (budget > 0 && total >= budget) {
      return { deny: `This run has spent ${compact(total)} of its ${compact(budget)} token budget, so no member is started. Tell the user; they can raise the budget with the board's limit command, after which you resume the run.` }
    }
    if (state.paused) {
      return { deny: `This run is paused (${state.paused}), so no member is started. Resume it with the board's resume command first.` }
    }
    if (e.resume) {
      const entry = Object.values(state.members).find(member => member.id === e.resume?.agentId ||
        (running?.teammateId !== undefined && member.id === running.teammateId))
      if (entry?.killed || memberNamed(state.members, named)?.killed) return { deny: 'This Swarm member has been retired.' }
      const resumed = memberNamed(state.members, named)
      if (resumed?.id && !entry) return { deny: 'This agent is no longer assigned to that Swarm member.' }
      const again = await next(e)
      // A member whose first start was never recorded is recorded now, or it could not be woken. Only an
      // agent of the type the roster gives the member: a resume skips the checks a fresh start goes through.
      if (!entry && named && resumed && !resumed.id && again.agentId &&
          running?.type === `swarm:${resumed.profile || resumed.role || 'worker'}`) {
        agentRuns.set(again.agentId, owned)
        await boardCommand($, owned, ['started', named, again.teammateId ?? again.agentId, '']).catch(() => undefined)
      }
      return again
    }
    const native = state.members.coordinator?.backend === 'native'
    if (native !== (e.isTeammate === true)) {
      return {
        deny: native
          ? 'This run uses native Agent Teams. Enable Agent Teams and launch a named teammate without call-level worktree isolation.'
          : 'This run uses background subagents. Omit name from the Agent call.',
      }
    }
    // The model a member really starts on must be the one the roster and the run's limits allow:
    // a model= on the roster that the Agent call forgets would otherwise run on the type's default.
    const member = memberNamed(state.members, named)
    // Registration is where the limits are checked, so an unregistered member would start outside them.
    if (!named || !member || member.killed) {
      return { deny: 'Register the member with the board\'s member command first, then start it with a description that begins "@<its name>: ".' }
    }
    const team = Object.entries(state.members).filter(([name, entry]) => name !== 'coordinator' && !entry.killed)
    if (team.length > Number(state.limits?.max_members ?? Infinity) ||
        team.filter(([, entry]) => entry.role !== 'verifier').length > Number(state.limits?.max_workers ?? Infinity)) {
      return { deny: 'The Swarm roster exceeds this run’s member limit. Check the board plan before launching more agents.' }
    }
    {
      const kind = e.subagentType.slice('swarm:'.length)
      // The type is what the roster says: the default model, the limits and the board tool all follow it.
      const registered = member.profile || member.role || 'worker'
      if (registered !== kind) {
        return { deny: `The roster has @${named} as ${registered}, but this call would start it as ${kind}. Start it with subagent_type "swarm:${registered}", or change the roster with the board's member command.` }
      }
      const actual = e.model === 'inherit' ? e.parentModel : latestOf(e.model) ?? DEFAULT_MODEL[kind] ?? ''
      const runsOn = familyOf(actual)
      const allowed = state.limits?.[runsOn]?.split(',')
      if (allowed && !allowed.includes(kind) && !allowed.includes(named)) {
        return { deny: `This run allows ${runsOn} only for: ${allowed.join(', ')}. Register @${named} with another model= and pass that model on the Agent call.` }
      }
      // The roster's model, or the type's default when it names none: a model passed only on the
      // Agent call would otherwise skip the plan the user saw and the board's rules for the type.
      if (member.model === 'inherit' && e.model !== 'inherit') {
        return { deny: `The roster has @${named} on the coordinator's model. Pass model: "inherit" on the Agent call, or change the roster with the board's member command.` }
      }
      const expected = member.model === 'inherit' ? e.parentModel : member.model || familyOf(DEFAULT_MODEL[kind] ?? '')
      if (expected && (expected.startsWith('claude-') ? expected !== actual : familyOf(expected) !== runsOn)) {
        return { deny: `The roster has @${named} on ${expected}, but this call would start it on ${runsOn}. Pass model: "${expected}" on the Agent call, or change the roster with the board's member command.` }
      }
      const effort = member.effort || DEFAULT_EFFORT[kind]
      if (spawnEfforts.has(e.tool_use_id) && (spawnEfforts.get(e.tool_use_id) ?? DEFAULT_EFFORT[kind]) !== effort) {
        return { deny: `The roster has @${named} on ${effort} effort. Pass effort: "${effort}" on the Agent call, or change the roster first.` }
      }
    }
    const key = `${owned}/${named}`
    if (pendingStarts.has(key)) return { deny: `@${named} is already starting.` }
    pendingStarts.add(key)
    try {
      if (member.id && (await $.agent.list()).some(agent =>
        (agent.id === member.id || agent.teammateId === member.id) && agent.status !== 'killed' && agent.status !== 'failed')) {
        return { deny: `@${named} already has an agent. Resume it with SendMessage or replace its assignment.` }
      }
      if (owned !== current && !(await bind($, owned))) return { deny: 'Swarm could not claim that run. Check that this conversation owns it.' }
      // The table decides, not the session's alias or the agent file: a family name becomes the newest model
      // of that family, and a call that names no model gets its type's default.
      const model = e.model === 'inherit' ? e.model : latestOf(e.model) ?? DEFAULT_MODEL[e.subagentType.slice('swarm:'.length)]
      const started = await next(model === e.model ? e : { ...e, model })
      if (started.agentId) {
        agentRuns.set(started.agentId, owned)
        if (started.teammateId) teammates.set(started.agentId, started.teammateId)
        const address = started.teammateId ?? started.agentId
        const recorded = await boardCommand($, owned, ['started', named, address, member.id ?? '']).catch(() => undefined)
        if (recorded?.exitCode !== 0) $.ui.toast(`Swarm could not record @${named}'s agent address, so it cannot be woken. Record it with the board's member command: id=${address}`)
        $.clock.after(0, () => void refresh($))
      }
      return started
    } finally {
      pendingStarts.delete(key)
    }
  }).catch((_, e, next) => {
    // The roster, the limits, the budget and a pause are enforced here: a check that failed or ran out of time starts nobody.
    if (next.called || !SWARM_AGENTS.has(e.subagentType)) return next(e)
    return { deny: 'Swarm could not check this start against the run\'s roster and limits, so the member was not started. Check the board, then start it again.' }
  })

  // The coordinator is the main conversation: a stall is never called mid-turn.
  on('turn.start', async (_, e, next) => {
    if (e.agentId === undefined) isCoordinatorBusy = true

    return next(e)
  })
  on('turn.complete', async ($, e, next) => {
    moods.delete(e.agentId ?? 'coordinator')
    if (e.agentId === undefined) {
      isCoordinatorBusy = false
      quietSince = await $.clock.now()
    }

    try {
      await account($, e.turnId, e.agentId, e.usage).catch(() => undefined)
      if (e.agentId !== undefined) {
        // A member that was woken and ended its turn without reading is owed the wake again.
        const agent = (await $.agent.list()).find(agent => agent.id === e.agentId)
        const dir = await agentRun($, e.agentId, agent)
        const address = teammateOf(e.agentId, agent)
        if (dir) await boardCommand($, dir, ['rearm', String(Math.ceil(e.durationMs)), e.agentId, ...(address ? [address] : [])]).catch(() => undefined)
      }
      if (e.agentId !== undefined || e.usage) $.clock.after(0, () => void refresh($))
    } catch {
      // A usage failure must not change how a turn ends.
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // After /clear or a resume the process goes on under a new session and no session.start fires for it,
    // so the poller stays: without it the pane, the wakes and the stall check are dead until a restart.
    const goesOn = e.reason === 'clear' || e.reason === 'resume'
    if (!goesOn) {
      poller?.cancel()
      poller = undefined
    }
    resetMonitoring()
    agentRuns.clear()
    teammates.clear()
    pendingStarts.clear()
    spawnEfforts.clear()
    opened = ''
    isCoordinatorBusy = false
    isRestoreOwed = goesOn
    await update($, run, () => '')
    await stop($)
    await stopLive($)
    // An exit shares one short time bound, so only a session that goes on has its view reset.
    if (goesOn) {
      await update($, swarm, () => EMPTY)
      await update($, loadError, () => '')
      await update($, expanded, () => 0)
      await update($, inspected, () => null)
      await update($, earlier, () => 0)
      await update($, query, () => '')
    }
    return next(e)
  })

  on('command.run', { command: 'swarm-board' }, async $ => {
    await openBoard($)

    return {}
  })

  on('ui.open', { id: PANE }, async ($, e, next) => {
    const result = await next(e)
    await $.ui.invalidate('ui.render')
    return result
  })
  on('ui.close', { id: PANE }, async ($, e, next) => {
    const result = await next(e)
    await $.ui.invalidate('ui.render')
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.props.maxRows < 1) return next(e)
    if (e.surface !== 'desktop' && !(await read($, run))) return next(e)
    if (e.surface === 'desktop' && (await $.ui.panes()).some(p => p.id === PANE && p.isShown && p.isPlaced)) return next(e)
    return shortcut($, e)
  })

  // Swarm's own row goes only once the shortcut is really in another settled row.
  on('ui.render', { component: 'AbovePromptList' }, async ($, e, next) => {
    const isOwn = (row: { plugin: string }) => row.plugin === $.plugin.name
    const peers = e.props.rows.filter(row => !isOwn(row))
    // When Crab Buddy renders last its finished tree is available only here.
    // Keep its row intact so the host retains its animation and event handlers.
    if (e.surface !== 'desktop' || e.props.hasSurvey || !e.props.rows.some(isOwn) ||
        peers.length !== 1 || !findKey(peers[0]?.tree, 'crab-fill')) return next(e)
    const { Box } = $.ui.resolve(e)
    const crab = await next({ ...e, props: { ...e.props, rows: peers } })
    return <Box flexDirection="row" columnGap={2}>
      {shortcut($, e, textCount(findKey(peers[0]?.tree, 'crab-text')) === 1)}
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>{crab}</Box>
    </Box>
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.surface !== 'desktop' || e.props.isSummary || !DEPLOYED.test(e.props.text) || !(await read($, run))) return next(e)
    const { Box, Button } = $.ui.resolve(e)
    const reply = await next(e)
    return (
      <Box flexDirection="column" rowGap={1}>
        {reply}
        <Box flexDirection="row">
          <Button key="swarm-board-from-reply" variant="secondary" label="Open Swarm board" onPress={() => void openBoard($)} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (e.props.origin.kind !== 'plugin' || e.props.origin.name !== $.plugin.name || !e.props.text.startsWith('Swarm: ')) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const [heading, ...body] = e.props.text.slice('Swarm: '.length).split('\n')
    return (
      <Box flexDirection="column">
        <Text dimColor><Text bold>Swarm</Text>{` · ${heading}`}</Text>
        {e.props.isExpanded && body.length > 0 && <Text dimColor>{body.join('\n')}</Text>}
      </Box>
    )
  })

  // The row in the chat that opens the pane: a queued /swarm-board waits for the turn to end, a press does not.
  on('ui.render', { component: 'Placed' }, async ($, e, next) => {
    if (!e.props.id.startsWith(OPENER)) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const shown = await read($, swarm)
    const isShown = shown.dir !== '' && openerOf(shown.dir) === e.props.id

    return (
      <Box flexDirection="row" alignItems="center" columnGap={2} flexWrap="wrap" borderStyle="round" borderColor="subtle" paddingX={1}>
        <Text>
          <Text bold>Swarm</Text>
          {isShown && <Text>{`  ${shown.title}`}</Text>}
          {isShown && <Text dimColor>{`  ·  ${shown.isClosed ? 'closed' : counted(Math.max(0, shown.members.length - 1), 'member')} · ${counted(shown.total ?? shown.posts.length, 'post')}`}</Text>}
        </Text>
        <Button
          key="open-swarm"
          variant="primary"
          label="Open Swarm board"
          onPress={() => void openBoard($)}
        />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown, Input } = $.ui.resolve(e)
    const HeaderArt = e.surface !== 'terminal' ? $.ui.resolve(e).Svg : undefined
    const shown = await read($, swarm)
    const error = await read($, loadError)
    if (e.props.placement === 'widget') {
      const active = shown.members.filter(member => member.status === 'working').length
      return (
        <Box flexDirection="row" columnGap={1} alignItems="center">
          <Text bold>Swarm board</Text>
          {active > 0 && <Text dimColor>{`${active} working`}</Text>}
        </Box>
      )
    }
    const current = await read($, tab)
    const memberOf = (name: string) => shown.members.find(member => member.name === name)
    const feedOf = async (name: string) => {
      await stop($)  // a replay left running would keep stepping behind the Board tab
      await update($, query, () => `@${name}`)
      await update($, inspected, () => null)
      await update($, latestOnly, () => false)
      await update($, tab, () => 'board')
    }
    const hiding = await read($, hideInactive)
    const columns = Math.max(20, e.props.bodyColumns ?? 40)
    const rows = Math.max(8, (e.viewport?.rows ?? 24) - 6)

    if (shown.dir === '') {
      return (
        <Box flexDirection="column">
          {HeaderArt && <HeaderArt source={hiveArt('sleep')} alt="Sleeping bees" width={88} height={44} />}
          <Text bold>{error || 'No swarm in this project'}</Text>
          {!error && <Text dimColor>Start one with /swarm:swarm and a task.</Text>}
        </Box>
      )
    }

    const inactive = new Set(
      shown.members
        .filter(m => ['waiting', 'not started', 'killed'].includes(m.status))
        .map(m => m.name),
    )
    const hueOf = (name: string) =>
      HUES[Math.max(0, shown.members.findIndex(m => m.name === name)) % HUES.length]
    const inactiveToggle = (count: number) =>
      count === 0 && !hiding ? (
        <Text dimColor>No inactive members</Text>
      ) : (
        <Button
          key="hide-inactive"
          plain
          dimColor={!hiding}
          onPress={() => update($, hideInactive, isOn => !isOn)}
          label={`${hiding ? 'Show inactive' : 'Hide inactive'} (${count})`}
        />
      )

    const working = shown.members.filter(m => m.status === 'working').length
    const waiting = shown.members.filter(m => m.role !== 'coordinator' && m.status === 'waiting').length
    const tokens = shown.tokens
    const total = tokensUsed(tokens)
    const openPost = async (seq: number) => {
      let older: Post | undefined
      if (!shown.posts.some(post => post.seq === seq)) {
        try {
          const [board, saved] = await Promise.all([readBoard($, shown.dir), $.fs.read(`${shown.dir}/members.json`)])
          older = parsePosts(board, (JSON.parse(saved) as { members: Roster }).members).find(post => post.seq === seq)
        } catch {
          // The board may have disappeared while this row was visible.
        }
        if (!older) {
          $.ui.toast(`Post #${seq} could not be loaded.`)
          return
        }
        if ((await read($, swarm)).dir !== shown.dir) return
      }
      await update($, inspected, () => older ?? null)
      await update($, query, () => '')  // a filter left on the Board would hide the post
      await update($, latestOnly, () => false)
      await update($, earlier, () => 0)
      await update($, expanded, () => seq)
      await update($, tab, () => 'board')
    }

    let body
    if (current === 'board') {
      const open = await read($, expanded)
      const collapsed = await read($, latestOnly)
      const more = await read($, earlier)
      const preview = (post: Post) => clip(bodyOf(post))
      // Fill the pane from the newest post back, so the feed follows the board.
      const wanted = (await read($, query)).trim().toLowerCase()
      const inspectedPost = await read($, inspected)
      const available = inspectedPost && !shown.posts.some(post => post.seq === inspectedPost.seq) ? [inspectedPost, ...shown.posts] : shown.posts
      const terms = wanted.split(/\s+/).filter(term => term !== '')
      const haystack = (post: Post) =>
        `@${post.agent} from:${post.agent} ${post.to.map(name => `@${name} to:${name}`).join(' ')} #${post.seq} ${kindOf(post.text)?.label ?? ''} ${post.text}`.toLowerCase()
      const matching = terms.length === 0
        ? available
        : available.filter(post => { const text = haystack(post); return terms.every(term => text.includes(term)) })
      const search = (
        <Box flexDirection="row" alignItems="center" columnGap={1} flexWrap="wrap" marginTop={1}>
          <Input
            key="board-search"
            placeholder="Filter posts: text, @member, from:name, to:name, brief…"
            value={wanted}
            submitLabel="Filter"
            onSubmit={value => update($, query, () => value.trim())}
          />
          {terms.length > 0 && (
            <Button key="board-search-clear" plain label={`Clear filter (${matching.length} of ${available.length})`} onPress={() => update($, query, () => '')} />
          )}
        </Box>
      )
      const fitted: Post[] = []
      let used = 0
      for (const post of [...matching].reverse()) {
        const text = preview(post)
        const cost =
          4 + text.split('\n').length + Math.floor(text.length / columns)
        if (fitted.length > 0 && used + cost > rows) break
        fitted.unshift(post)
        used += cost
      }
      const visible = matching.slice(collapsed && terms.length === 0 ? -1 : -Math.max(1, fitted.length + more))
      if (!collapsed && open > 0 && !visible.some(post => post.seq === open)) {
        const selected = matching.find(post => post.seq === open)
        if (selected) visible.unshift(selected)
      }
      const older = matching.length - visible.length
      body =
        visible.length === 0 ? (
          <Box flexDirection="column">
            {shown.posts.length > 0 && search}
            <Box marginTop={1}>
              <Text dimColor>{shown.posts.length === 0 ? 'No posts yet.' : 'No posts match the filter.'}</Text>
            </Box>
          </Box>
        ) : (
          <Box flexDirection="column" gap={1}>
            {search}
            {terms.length === 0 && shown.posts.length > 1 && (
              <Button
                key="collapse-history"
                plain
                dimColor
                label={collapsed ? `Show history (${shown.posts.length - 1})` : 'Collapse history'}
                onPress={() => update($, latestOnly, value => !value)}
              />
            )}
            {(!collapsed || terms.length > 0) && older === 0 && (shown.total ?? 0) > shown.posts.length && (
              <Text dimColor>{`The pane keeps the newest ${shown.posts.length} of ${shown.total} posts. Earlier ones are on the board: show`}</Text>
            )}
            {(!collapsed || terms.length > 0) && older > 0 && (
              <Button
                key="earlier-posts"
                plain
                dimColor
                label={`↑ Show earlier posts (${older})`}
                onPress={() => update($, earlier, count => count + 6)}
              />
            )}
            {visible.map(post => {
              const kind = kindOf(post.text)

              return (
                <Box
                  key={`post-${post.seq}`}
                  flexDirection="column"
                  borderStyle="round"
                  borderColor="subtle"
                  borderDimColor
                  paddingX={1}
                >
                  <Box flexDirection="row" justifyContent="space-between" flexWrap="wrap" columnGap={1}>
                    <Box flexDirection="row" alignItems="center" columnGap={1} flexWrap="wrap">
                      <Text color={hueOf(post.agent)}>●</Text>
                      <Button
                        key={`agent-${post.seq}`}
                        plain
                        label={`@${post.agent}`}
                        onPress={async () => { if (!(await viewAgent($, memberOf(post.agent)))) await feedOf(post.agent) }}
                      />
                      <Text>
                        <Text dimColor>
                          {post.to.length > 0
                            ? `→  ${post.to.slice(0, 2).map(name => `@${name}`).join(' ')}${post.to.length > 2 ? ` +${post.to.length - 2}` : ''}`
                            : ''}
                        </Text>
                        {kind !== undefined && (
                          <Text bold color={kind.color}>{`   ${kind.label}`}</Text>
                        )}
                      </Text>
                    </Box>
                    <Text dimColor>{`#${post.seq} · ${post.time.slice(11, 16)}`}</Text>
                  </Box>
                  <Markdown text={(post.seq === open ? openedText(post) : preview(post)).replace(/\n/g, '  \n')} />
                  <Box flexDirection="row" gap="sm" flexWrap="wrap">
                    {bodyOf(post).length > CLIP && (
                      <Button
                        key={`more-${post.seq}`}
                        plain
                        dimColor
                        onPress={() =>
                          update($, expanded, seq => (seq === post.seq ? 0 : post.seq))
                        }
                        label={post.seq === open ? '▴ Show less' : '▾ Show more'}
                      />
                    )}
                    {e.surface !== 'terminal' && post.to.length > 0 && (
                      <Button
                        key={`graph-post-${post.seq}`}
                        plain
                        dimColor
                        label="View in graph"
                        onPress={async () => {
                          await seek($, post.seq)
                          await update($, tab, () => 'graph')
                        }}
                      />
                    )}
                  </Box>
                </Box>
              )
            })}
          </Box>
        )
    } else if (current === 'attention') {
      const tone = (kind: string) =>
        kind === 'unreachable' || kind === 'ignored' || kind === 'stale' ? 'error' : kind === 'paused' ? 'suggestion' : 'warning'
      const isOwned = (await read($, run)) === shown.dir
      body = shown.attention.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>{shown.attentionUnavailable ? 'Attention details unavailable. Swarm will retry.' : 'Nothing needs attention.'}</Text>
        </Box>
      ) : (
        <Box flexDirection="column" gap={1} marginTop={1}>
          {shown.attention.map((item, index) => (
            <Box
              key={`attention-${index}`}
              flexDirection="column"
              borderStyle="round"
              borderColor={tone(item.kind)}
              borderDimColor
              paddingX={1}
            >
              <Text>
                <Text bold color={tone(item.kind)}>{item.kind.toUpperCase()}</Text>
                <Text>{`  ${item.text}`}</Text>
              </Text>
              <Box flexDirection="row" gap="sm" flexWrap="wrap">
                {item.seq > 0 && (
                  <Button
                    key={`attention-open-${index}`}
                    plain
                    label={`Open post #${item.seq}`}
                    onPress={() => openPost(item.seq)}
                  />
                )}
                {item.kind === 'unreachable' && isOwned && (
                  <Button
                    key={`attention-recover-${index}`}
                    plain
                    label="Ask coordinator to recover"
                    onPress={() => void $.prompt.submit({
                      text: `Swarm: Recover @${item.member}\n@${item.member} is unreachable (board post #${item.seq}). Run the board's retry command for it once. If it is still unreachable after that, use the board's replace command to register a successor with its brief and history, then spawn the successor.`,
                    }).catch(() => undefined)}
                  />
                )}
              </Box>
            </Box>
          ))}
        </Box>
      )
    } else if (current === 'members') {
      const lastOf = (name: string) =>
        [...shown.posts].reverse().find(post => post.agent === name)
      const card = (member: Member) => {
        const last = lastOf(member.name)
        const statusColor = statusInk(member.status)
        const isBroken = member.status === 'failed' || member.status === 'unreachable'
        const plan = [
          member.owns === '' ? '' : `owns ${member.owns}`,
          member.depends.length === 0 ? '' : `after ${member.depends.map(name => `@${name}`).join(', ')}`,
        ].filter(part => part !== '').join(' · ')

        return (
          <Box key={member.name} flexDirection="column">
            <Box flexDirection="row" justifyContent="space-between" flexWrap="wrap" columnGap={1}>
              <Text strikethrough={member.status === 'killed'} wrap="truncate-end">
                <Text bold color={hueOf(member.name)}>@{member.name}</Text>
                <Text dimColor>
                  {member.role === 'coordinator' ? '' : `  ${member.type}`}
                  {member.model === '' ? '' : `  ${member.model}${member.effort === '' ? '' : ` ${member.effort}`}`}
                </Text>
              </Text>
              <Box flexDirection="row" alignItems="center">
                {HeaderArt ? <HeaderArt source={statusDot(member.status)} alt={member.status} width={12} height={12} /> :
                <Text color={statusColor}>{isBroken ? '!' : ['killed', 'not started'].includes(member.status) ? '○' : '●'}</Text>}
                <Text>
                <Text dimColor>{` ${member.status} · ${counted(member.posts, 'post')}`}</Text>
                {spentBy(member) > 0 && <Text dimColor>{` · ${compact(spentBy(member))} tokens`}</Text>}
                {member.unread > 0 && member.status !== 'killed' && (
                  <Text bold color="warning">{` · ${member.unread} unread`}</Text>
                )}
                </Text>
              </Box>
            </Box>
            {member.status !== 'killed' && member.detail !== '' && (
              <Text color={isBroken ? 'error' : 'warning'} wrap="truncate-end">{member.detail}</Text>
            )}
            {member.status !== 'killed' && plan !== '' && <Text dimColor wrap="truncate-end">{plan}</Text>}
            {last !== undefined && (
              <Text dimColor wrap="truncate-end">
                {`#${last.seq}  ${bodyOf(last).split('\n').slice(0, kindOf(last.text) ? 2 : 1).join(' · ')}`}
              </Text>
            )}
            <Box flexDirection="row" gap="sm" flexWrap="wrap">
              {(member.role === 'coordinator' || (member.id !== undefined && member.status !== 'killed')) && (
                <Button key={`view-${member.name}`} plain dimColor label="Open conversation" onPress={async () => { if (!(await viewAgent($, member))) await feedOf(member.name) }} />
              )}
              {member.posts > 0 && (
                <Button key={`feed-${member.name}`} plain dimColor label="Posts" onPress={() => feedOf(member.name)} />
              )}
            </Box>
          </Box>
        )
      }
      const memberTokenEntries = await Promise.all(shown.members.map(async member => {
        const key = member.role === 'coordinator'
          ? 'coordinator'
          : member.id ? await digest(`swarm-agent:${member.id}`) : ''
        return [member.name, tokens[key] ?? 0] as const
      }))
      const memberTokens = new Map(memberTokenEntries)
      const spentBy = (member: Member) => memberTokens.get(member.name) ?? 0
      const byName = (a: Member, b: Member) =>
        Number(b.role === 'coordinator') - Number(a.role === 'coordinator') ||
        a.name.localeCompare(b.name)
      const groups: [string, Member[]][] = [
        ['Needs attention', shown.members.filter(m => ['failed', 'unreachable'].includes(m.status))],
        ['Active', shown.members.filter(m => ['working', 'coordinating'].includes(m.status))],
        ['Standing by', shown.members.filter(m => ['waiting', 'not started'].includes(m.status) && !(hiding && inactive.has(m.name)))],
        ['Retired', hiding ? [] : shown.members.filter(m => m.status === 'killed')],
      ]
      body = (
        <Box flexDirection="column" marginTop={1}>
          {inactiveToggle(inactive.size)}
          {groups
            .filter(([, list]) => list.length > 0)
            .map(([title, list]) => (
              <Box key={title} flexDirection="column" gap={1} marginTop={1}>
                <Text bold dimColor>{`${title} · ${list.length}`}</Text>
                {[...list].sort(byName).map(card)}
              </Box>
            ))}
        </Box>
      )
    } else if (e.surface !== 'terminal' && shown.posts.length > 0) {
      // the terminal has no Svg: it keeps the list below
      const { Svg } = $.ui.resolve(e)
      const selected = await read($, replay)
      const playing = await read($, isPlaying)
      const pulse = await read($, livePulse)
      const live = selected === 0
      const frame = shown.posts.findIndex(post => post.seq >= (live ? pulse : selected))
      const index = (live && pulse === 0) || frame < 0 ? shown.posts.length - 1 : frame
      const post = shown.posts[index]!
      const detailsOpen = await read($, expanded) === post.seq
      const participants = live ? undefined : new Set([
        ...Object.keys(shown.earlierEdges ?? {}).flatMap(edge => edge.split('>')),
        ...shown.posts.slice(0, index + 1).flatMap(entry => [entry.agent, ...entry.to]),
      ])
      const hideable = [...inactive].filter(name =>
        memberOf(name)?.role !== 'coordinator' && (participants === undefined || participants.has(name)) &&
        name !== post.agent && !post.to.includes(name),
      )
      const hidden = new Set(hiding ? hideable : [])
      const animate = playing || (live && pulse === post.seq)
      const repeat = index === shown.posts.length - 1 && !animate
      body = (
        <Box flexDirection="column" marginTop={1} gap={1}>
          <Box flexDirection="row" justifyContent="space-between" flexWrap="wrap" columnGap={1}>
            {live && !shown.isClosed && !shown.isPaused ? (
              <Box flexDirection="row" alignItems="center" gap="xs">
                <Svg source={LIVE_INDICATOR} alt="Live activity" width={16} height={16} isInteractive />
                <Text bold color="success">Live</Text>
              </Box>
            ) : (
              <Text dimColor>{live ? (shown.isPaused && !shown.isClosed ? 'Paused' : 'Latest post') : `Post ${index + 1} of ${shown.posts.length}`}</Text>
            )}
            {inactiveToggle(hideable.length)}
          </Box>
          <Box flexDirection="row" gap="xs" alignItems="center" flexWrap="wrap">
            <Button key="replay-first" plain dimColor={index === 0} onPress={() => seek($, shown.posts[0]!.seq)}>First</Button>
            <Button key="replay-back" plain dimColor={index === 0} onPress={() => seek($, shown.posts[Math.max(0, index - 1)]!.seq)}>‹ Prev</Button>
            <Button
              key="replay-play"
              variant="primary"
              label={playing ? 'Pause' : 'Play'}
              dimColor={shown.posts.length === 1}
              onPress={() => play($)}
            />
            <Button key="replay-next" plain dimColor={index === shown.posts.length - 1} onPress={() => seek($, shown.posts[Math.min(index + 1, shown.posts.length - 1)]!.seq)}>Next ›</Button>
            {!live && (
              <Button key="replay-live" plain label={shown.isClosed ? 'Latest' : 'Go live'} onPress={() => seek($, 0)} />
            )}
          </Box>
          <Svg
            source={graphSvg(shown, post.seq, hidden, animate, live, repeat)}
            width={1024}
            height={graphHeight(columns, shown.members.length)}
            alt={`Post ${post.seq} · @${post.agent}${post.to.length ? ` to ${post.to.map(name => `@${name}`).join(', ')}` : ' · no mentions'}`}
            isInteractive
          />
          <Box key="graph-members" flexDirection="row" gap="sm" flexWrap="wrap" alignItems="center">
            <Text dimColor>Feed of</Text>
            {shown.members.filter(member => !hidden.has(member.name) && member.posts > 0).map(member => (
              <Button key={`graph-feed-${member.name}`} plain label={`@${member.name}`} onPress={() => feedOf(member.name)} />
            ))}
          </Box>
          <Box key="graph-post" flexDirection="column" gap="xs" borderStyle="round" borderColor="subtle" borderDimColor paddingX={1}>
            <Text wrap="truncate-end">
              <Text dimColor>{`#${post.seq}  `}</Text>
              <Text bold color={hueOf(post.agent)}>@{post.agent}</Text>
              <Text dimColor>{post.to.length ? `  →  ${post.to.map(name => `@${name}`).join(' ')}` : '  ·  No mentions'}</Text>
            </Text>
            <Markdown text={(detailsOpen ? openedText(post) : clip(bodyOf(post))).replace(/\n/g, '  \n')} />
            {bodyOf(post).length > CLIP && (
              <Button
                key="graph-post-details"
                plain
                dimColor
                label={detailsOpen ? 'Show less' : 'Show full post'}
                onPress={() => update($, expanded, seq => seq === post.seq ? 0 : post.seq)}
              />
            )}
          </Box>
        </Box>
      )
    } else {
      const edges = new Map<string, number>()
      // Posts older than the ones kept still count, as they do in the diagram.
      for (const [edge, count] of Object.entries(shown.earlierEdges ?? {})) {
        const [from = '', to = ''] = edge.split('>')
        if (hiding && (inactive.has(from) || inactive.has(to))) continue
        edges.set(`@${from} → @${to}`, count)
      }
      for (const post of shown.posts) {
        for (const name of post.to) {
          if (hiding && (inactive.has(post.agent) || inactive.has(name))) continue
          const edge = `@${post.agent} → @${name}`
          edges.set(edge, (edges.get(edge) ?? 0) + 1)
        }
      }
      const most = [...edges.values()].reduce((max, count) => Math.max(max, count), 1)
      const summary =
        edges.size === 0 ? (
          <Text dimColor>No mentions yet.</Text>
        ) : (
          [...edges.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, rows)
            .map(([edge, count]) => (
              <Text>
                <Text color="success">
                  {'█'.repeat(Math.max(1, Math.round((count / most) * 8)))}
                </Text>
                {` ${count}  ${edge}`}
              </Text>
            ))
        )
      body = (
        <Box flexDirection="column" marginTop={1} gap={1}>
          {inactiveToggle(inactive.size)}
          {summary}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" alignItems="center" columnGap={1}>
          {HeaderArt && <HeaderArt source={hiveArt(shown.mood ?? 'sleep')} alt={`Swarm hive: ${shown.mood ?? 'sleep'}`} width={88} height={44} />}
          <Box flexDirection="column" flexShrink={1}><Text bold wrap="truncate-end">{shown.title}</Text></Box>
        </Box>
        {error && <Text color="warning">{error}</Text>}
        <Text dimColor>
          {`${shown.isClosed ? 'Closed' : shown.isPaused ? 'Paused' : `${working} working · ${waiting} waiting`} · ${counted(shown.total ?? shown.posts.length, 'post')}`}
          {total > 0 ? ` · ${compact(total)}${shown.budget > 0 ? ` of ${compact(shown.budget)}` : ''} tokens` : ''}
        </Text>
        <Box flexDirection="row" gap="xs" marginTop={1}>
          {TABS.map(name => (
            <Button
              key={`tab-${name}`}
              variant={name === current ? 'primary' : 'secondary'}
              onPress={async () => {
                if (name !== current) {
                  await stop($)
                  await stopLive($)
                  await update($, tab, () => name)
                }
              }}
              label={`${name[0]?.toUpperCase()}${name.slice(1)}${name === 'attention' && shown.attention.length > 0 ? ` ${shown.attention.length}` : ''}`}
            />
          ))}
        </Box>
        {body}
      </Box>
    )
  })
}
