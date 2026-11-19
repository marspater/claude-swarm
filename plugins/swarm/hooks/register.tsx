// The Swarm pane and its session hooks. board.py owns the board files.
import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, ModelUsage, Register, SessionMessage, Timer } from 'claude-code'

import type { Member, Post, Swarm, Tab } from '../types'
import { BOARD_CALL, COORDINATOR_READ, RUN, runsNamed, wakeMessage, wakeSequence } from './command'
import { DEFAULT_EFFORT, DEFAULT_MODEL, SPECIALISTS, SWARM_AGENTS, familyOf, latestOf } from './models'
import { KEPT, budgetOf, memberNamed, parse, parsePosts, tokensUsed, type BudgetState, type Report, type Roster } from './roster'
import { CLIP, bodyOf, clean, clip, compact, head, kindOf, openedText } from './text'
import { statusInk, statusCss, statusDot } from './palette'
import { hiveArt, toolMood, toolSummary, type Mood } from './hive'
import { edgesOf, graphHeight, graphSvg, isBroadcast, pairOf } from './graph'

const PANE = 'swarm'
const TITLE = 'Swarm'
const DEPLOYED = /^Swarm deployed\.(?:\s|$)/m
const EMPTY: Swarm = { title: '', dir: '', isClosed: false, posts: [], members: [], attention: [], budget: 0, tokens: {} }
const BOARD_TOOL = 'mcp__swarm__board'
const counted = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`
const TABS: Tab[] = ['board', 'attention', 'members', 'graph']
const REPLAY_FRAME_MS = 1200
const liveIndicator = (elapsed: number) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">
  <style>
    ${statusCss}circle{fill:var(--status-working)}
    @media (prefers-reduced-motion: reduce){.breath{display:none}}
  </style>
  <circle class="breath" cx="8" cy="8" r="4" opacity=".2">
    <animate attributeName="r" values="3.5;7;3.5" dur="4s" begin="-${elapsed % 4000}ms" repeatCount="indefinite"
      calcMode="spline" keyTimes="0;.5;1" keySplines=".42 0 .58 1;.42 0 .58 1"/>
    <animate attributeName="opacity" values=".3;.06;.3" dur="4s" begin="-${elapsed % 4000}ms" repeatCount="indefinite"
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
// Whether the graph draws an @all post as a dashed line to each member it reached, or only counts it on its sender.
const expandAll = atom({ plugin: 'swarm', key: 'expandAll' } as const, false)
// The seq of the one long post shown in full; 0 for none.
const expanded = atom({ plugin: 'swarm', key: 'expanded' } as const, 0)
const inspected = atom({ plugin: 'swarm', key: 'inspected' } as const, null as Post | null)
// What the Board tab is narrowed to: text matched against sender, recipients, kind and body.
const query = atom({ plugin: 'swarm', key: 'query' } as const, '')

// A run looked at through the pane's run switcher: read once and drawn read-only. The live run goes on being
// polled, woken and charged behind it; nothing done for this one binds it, wakes its members or accounts to it.
let browsed: Swarm | undefined
const shownSwarm = async ($: EngineInterface) => browsed ?? await read($, swarm)

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
    const [{ posts }, selected] = await Promise.all([shownSwarm($), read($, replay)])
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
  const [{ posts }, selected] = await Promise.all([shownSwarm($), read($, replay)])
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
// True while a session.end runs, and from an exit on: a poll in between would read the session that is ending.
let isEnding = false
let poller: Timer | undefined
let generation = 0
const agentRuns = new Map<string, string>()
// Agents looked up and found to be no member of a run: asked once, not on every model step and tool call.
const strangers = new Set<string>()
// The run this conversation drove until it closed: its members are still refused by name.
let closedRun = ''
// The owned run while it is paused or over budget, and why: its members are refused their next tool call.
let halted: { dir: string; why: string } | undefined
// What each turn's model steps have been charged so far, so its end charges only what no step reported.
type Spent = Pick<ModelUsage, 'input_tokens' | 'output_tokens' | 'cache_creation_input_tokens' | 'cache_read_input_tokens'>
// `landing` settles once every step charged so far is on the board, or taken out of the sum again.
const stepped = new Map<string, { steps: Set<number>; sum: Spent; landing: Promise<unknown>; isDone?: boolean }>()
const TURNS_KEPT = 256
// Charged against the budget as they are billed: fresh tokens whole, cached reads at a tenth.
const weigh = (spent: Spent | undefined) => spent === undefined ? 0
  : spent.input_tokens + spent.cache_creation_input_tokens + spent.output_tokens + Math.round(spent.cache_read_input_tokens * 0.1)
/** What this report adds to the turn's charge: a step's own usage, or at the turn's end what its steps left out. */
function charge(turnId: string, spent: Spent, index?: number): number {
  const turn: NonNullable<ReturnType<typeof stepped.get>> = stepped.get(turnId) ??
    { steps: new Set(), sum: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, landing: Promise.resolve() }
  if (index === undefined) {
    turn.isDone = true
    return weigh(spent) - weigh(turn.sum)
  }
  // Put back last on every use, and room is made from the turns that have ended, the one unused longest first:
  // a turn still running keeps its entry however long it waits between steps, or its end would charge its early
  // steps a second time. An ended turn's entry is kept a while too, so a repeated turn.complete finds what was charged.
  stepped.delete(turnId)
  stepped.set(turnId, turn)
  if (stepped.size > TURNS_KEPT) {
    const ended = [...stepped].find(([, one]) => one.isDone)?.[0]
    // ponytail: turns that never report an end are dropped only past four times the room.
    if (ended !== undefined || stepped.size > TURNS_KEPT * 4) stepped.delete(ended ?? stepped.keys().next().value!)
  }
  if (turn.steps.has(index)) return 0
  turn.steps.add(index)
  const before = weigh(turn.sum)
  for (const key of Object.keys(turn.sum) as (keyof Spent)[]) turn.sum[key] += spent[key] || 0
  return weigh(turn.sum) - before
}
// A step the board did not record (no run bound yet, a failed command) is the turn's end's to charge after all.
function uncharge(turnId: string, spent: Spent, index: number): void {
  const turn = stepped.get(turnId)
  if (!turn?.steps.delete(index)) return
  for (const key of Object.keys(turn.sum) as (keyof Spent)[]) turn.sum[key] -= spent[key] || 0
}
// A native teammate's address by agent id. The agent list drops a teammate when it ends, sometimes before its
// last turn completes, and its tokens and its wake are recorded under that address.
const teammates = new Map<string, string>()
// Kept in the plugin's store as well: after a restart a teammate may end before any step of its is seen, and
// the agent list no longer says whose address its id was.
// ponytail: the newest 200 across all projects; ids are unique, so an old entry only takes room.
const TEAMMATES = 'teammates'
function learnTeammate($: EngineInterface, id: string, address: string): void {
  if (teammates.get(id) === address) return
  teammates.set(id, address)
  void $.store.set(TEAMMATES, Object.fromEntries([...teammates].slice(-200))).catch(() => undefined)
}
function teammateOf($: EngineInterface, id: string, agent?: AgentInfo): string | undefined {
  if (agent?.teammateId) learnTeammate($, id, agent.teammateId)
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
// A pause of the owned run that nobody was told about (the board pauses by itself when a member keeps failing
// verification) is told to the coordinator once. Not told: one the budget made (`account` prompts), one the
// person made from the pane, one the coordinator's own board command made. Those mark the pause as expected:
// `pausing` while their command runs, `pauseQuiet` until a poll that began after it has looked.
let pauseSeen: string | undefined  // undefined until the first look at a run: the pause it starts with is not news
let pauseOwed = ''
let pausing = 0
let pauseQuiet = 0
let polls = 1
const pauseExpected = () => { pauseQuiet = polls }
const pauseNotice = (title: string, reason: string) =>
  `${title} is paused: ${reason}. Tell the user what is done and why the run stopped, and ask how to go on. The board's resume command continues the run; a spent budget is raised with limit first.`
// A submitted notice is held until the turn it starts: a poll before that turn.start would submit a second beside it.
const NOTICE_HOLD_MS = 10_000
let noticeHold = 0
type SpecialistWake = { name: string; id: string; seq: number; attempts: number; native: boolean }
let specialistWakes: SpecialistWake[] = []
// Specialists owed a mention with no agent address on the roster: named in a relay notice, never the cause of one.
let unaddressed: { name: string; seq: number }[] = []
let relayRun = ''
let relayHinted = ''
let relayPrompted = ''

const relayKey = (dir: string) => dir === relayRun && specialistWakes.length ? JSON.stringify([dir, specialistWakes]) : ''
const teammateName = (address: string) => address.split('@', 1)[0] || address
// Each line carries the address to send to, so the relay costs no `wake` lookup first.
const relayNotice = () => 'Relay these Swarm board wakes now with your own SendMessage tool, each to the recipient given, ' +
  'with the message copied exactly. Swarm records accepted delivery automatically.\n' +
  specialistWakes.map(({ name, id, seq, native }) =>
    `@${name} (SendMessage to ${native ? `the bare teammate name ${JSON.stringify(teammateName(id))}` : JSON.stringify(id)}): ${wakeMessage(seq)}`,
  ).concat(unaddressed.map(({ name, seq }) =>
    `@${name}: owed mentions through #${seq}, but the roster has no agent address for it, so there is nothing to send. Start it, or record its agent with the board's member command (id=<agent id>).`,
  )).join('\n')

// The member conversation the Members tab shows in place of its cards, where no main view can be moved to it.
type TalkRow = { kind: 'prompt' | 'said' | 'tools'; text: string }
type Talk = { dir: string; name: string; agentId: string; rows: TalkRow[]; skipped: number; key: string; more: number; isOver?: boolean }
let talk: Talk | undefined
let isReadingTalk = false
// ponytail: the first row (the prompt) and the newest ones only, each cut short; the agent's own panel holds the rest.
const TALK_ROWS = 40
const TALK_CLIP = 1200
function talkRows(messages: readonly SessionMessage[]): Pick<Talk, 'rows' | 'skipped' | 'key'> {
  const rows: TalkRow[] = []
  let tools: SessionMessage['toolUses'] = []
  const fold = () => {
    if (tools.length > 0) rows.push({ kind: 'tools', text: toolSummary(tools) })
    tools = []
  }
  for (const message of messages) {
    // Cut before cleaning: a transcript is read again on every poll. A user message of tool results alone has no text.
    const text = clean(head(message.text, TALK_CLIP * 2)).trim()
    if (text !== '') {
      fold()
      rows.push({ kind: message.role === 'user' ? 'prompt' : 'said', text: clip(text, TALK_CLIP) })
    }
    tools = [...tools, ...message.toolUses]
  }
  fold()
  const skipped = Math.max(0, rows.length - TALK_ROWS)
  const kept = skipped > 0 ? [rows[0]!, ...rows.slice(1 - TALK_ROWS)] : rows
  return { rows: kept, skipped, key: JSON.stringify([skipped, kept]) }
}
function closeTalk($: EngineInterface): void {
  if (!talk) return
  talk = undefined
  $.ui.invalidate('ui.render')
}
// Run by the poller while a conversation is open; the pane is drawn again only when its rows changed.
async function refreshTalk($: EngineInterface): Promise<void> {
  const open = talk
  if (!open || isReadingTalk) return
  isReadingTalk = true
  try {
    // An agent that has ended says nothing more: it is read one last time, and again only if it runs again.
    const agent = (await $.agent.list()).find(one => one.id === open.agentId)
    const isOver = !agent || ['completed', 'failed', 'killed'].includes(agent.status)
    if (isOver && open.isOver) return
    const messages = await $.session.messages({ agentId: open.agentId })
    // An agent whose conversation can no longer be read keeps the rows last read.
    if (talk !== open) return
    const next = Array.isArray(messages) ? talkRows(messages) : open
    talk = { ...open, ...next, isOver }
    if (next.key !== open.key) $.ui.invalidate('ui.render')
  } catch {
    // The next poll reads it again.
  } finally {
    isReadingTalk = false
  }
}

function resetMonitoring(): void {
  moods.clear()
  generation++
  seen = seenBoard = activity = stalled = ''
  snapshot = undefined
  attentionRetry = noticeFailures = noticeRetry = 0
  owed = NONE
  hinted = prompted = noticeHold = pauseQuiet = 0
  pauseSeen = undefined
  pauseOwed = ''
  halted = undefined
  unaddressed = []
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
  if (await read($, run) !== dir) {
    resetMonitoring()
    strangers.clear()
  }
  closedRun = ''
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
    const epoch = generation
    const saved = await boardCommand($, dir, ['bind', await lookupKey($)])
    if (saved.exitCode !== 0) return false
    // The session ended while the board answered (/clear): the run is the old conversation's, not this one's.
    if (epoch !== generation) return false
    await own($, dir)
    return true
  } catch {
    return false
  }
}

async function agentRun($: EngineInterface, id: string, agent?: AgentInfo): Promise<string> {
  const saved = agentRuns.get(id)
  if (saved) return saved
  if (strangers.has(id)) return ''
  const address = teammateOf($, id, agent) ?? id
  const active = await read($, run)
  if (active) {
    const roster = await $.fs.read(`${active}/members.json`).then(text => (JSON.parse(text) as { members: Roster }).members)
      .catch(() => undefined)
    const registered = roster && Object.values(roster).some(member => member.id === address || member.id === id)
    const name = /^@([a-z][a-z0-9_-]*):/.exec(agent?.description ?? '')?.[1]
    const starting = roster && memberNamed(roster, name)
    if (registered || (starting && !starting.id && !starting.killed && agent?.type === `swarm:${starting.profile || starting.role || 'worker'}`)) {
      // Kept: the agent list drops a fast agent before its last turn is accounted, and its description with it.
      agentRuns.set(id, active)
      return active
    }
  }
  const result = await boardCommand($, `${await $.session.cwd()}/.swarm`, ['agent-run', await lookupKey($), id, ...(address === id ? [] : [address])])
  const dir = result.stdout.trim()
  if (result.exitCode !== 0 || !RUN.test(dir)) {
    if (result.exitCode === 0) strangers.add(id)
    return ''
  }
  agentRuns.set(id, dir)
  return dir
}

// The agent's own transcript in the main view; the coordinator's is the main conversation.
/** Shows the member's conversation; false when there is none to show, with a toast saying why. */
async function viewAgent($: EngineInterface, member: Member | undefined): Promise<boolean> {
  if (member === undefined) return false
  if (member.role === 'coordinator') return !(await $.ui.view({})).deny
  const agent = (await $.agent.list()).find(one => one.id === member.id || one.teammateId === member.id)
  if (agent && !(await $.ui.view({ agentId: agent.id }).catch(() => ({ deny: 'no main view' }))).deny) return true
  // No main view to move (the desktop app draws none) or no live agent: the pane shows what the session holds
  // of the conversation, which outlasts the agent. An ended teammate is read by its agent id, not its address.
  const agentId = agent?.id ?? [...teammates].find(([, address]) => address === member.id)?.[0] ?? member.id
  const messages = agentId === undefined
    ? { deny: 'no agent was started for it' }
    : await $.session.messages({ agentId }).catch(() => ({ deny: 'its conversation could not be read' }))
  if (agentId === undefined || !Array.isArray(messages)) {
    const why = Array.isArray(messages) ? '' : messages.deny.replace(/\.$/, '')
    $.ui.toast(`@${member.name}: ${why}. Showing its posts instead.`)
    return false
  }
  await stop($)
  talk = { dir: (await shownSwarm($)).dir, name: member.name, agentId, ...talkRows(messages), more: 0 }
  await update($, tab, () => 'members')
  $.ui.invalidate('ui.render')
  return true
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
): Promise<{ pending: boolean; exhausted: string[]; relay: SpecialistWake[]; unaddressed: typeof unaddressed }> {
  const script = `${$.plugin.root}/skills/swarm/scripts/board.py`
  const results = { pending: false, exhausted: [] as string[], relay: [] as SpecialistWake[], unaddressed: [] as typeof unaddressed }
  const native = roster.coordinator?.backend === 'native'
  for (const [name, member] of Object.entries(roster)) {
    if (epoch !== generation) break
    const id = member.id
    if (member.killed || member.role === 'coordinator') continue
    const from = Math.max(member.last_read_seq, member.last_nudged_seq ?? 0)
    const seq = posts.findLast(post => post.seq > from && post.to.includes(name))?.seq
    if (!id) {
      if (seq !== undefined && SPECIALISTS.includes(member.profile ?? '')) results.unaddressed.push({ name, seq })
      continue
    }
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
    // Failed attempts belong to the member, not to one post, as the board's `claim` counts them: a newer mention
    // does not start them again. A read by the member clears the claim, and so does the board's `retry`.
    if (claim && claim.attempts >= WAKE_ATTEMPTS) {
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
  if (isEnding) return
  if (isPolling) {
    isRefreshOwed = true
    return
  }
  isPolling = true
  const poll = ++polls
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
        closeTalk($)
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
    const state = JSON.parse(rosterText) as { members: Roster; paused?: string; closed?: boolean } & BudgetState
    const isSpent = budgetOf(state) > 0 && tokensUsed(state.usage?.tokens) >= budgetOf(state)
    // Read anew on every poll, so a resume or a raised budget lets the members' tools through again.
    halted = owned && !state.closed && (state.paused || isSpent)
      ? { dir, why: state.paused ? `paused (${state.paused})` : 'over its token budget' }
      : undefined
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
      if (previous.dir !== dir && !browsed) {
        closeTalk($)
        await seek($, 0)
        await update($, expanded, () => 0)
        await update($, inspected, () => null)
        await update($, earlier, () => 0)
        await update($, query, () => '')
      } else if (!browsed && livePlayer === undefined && await read($, tab) === 'graph' && await read($, replay) === 0) {
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
    if (owned) {
      const reason = state.closed ? '' : state.paused ?? ''
      if (pauseSeen !== undefined && reason !== pauseSeen) pauseOwed = pausing > 0 || pauseQuiet > 0 ? '' : reason
      pauseSeen = reason
      if (poll > pauseQuiet) pauseQuiet = 0
      // Mid-turn it rides on the coordinator's next tool result instead.
      if (pauseOwed && !isCoordinatorBusy && now >= noticeHold) {
        const text = `Swarm: Run paused\n${pauseNotice(full.title.replace(/\s+/g, ' '), pauseOwed)}`
        const unheard = () => $.ui.toast(`Swarm paused "${full.title}": ${reason}. The coordinator could not be told.`)
        pauseOwed = ''
        noticeHold = now + NOTICE_HOLD_MS
        void $.prompt.submit({ text }).then(result => { if (result.drop) unheard() }).catch(unheard)
      }
    }
    if (!owned || state.closed || state.paused || isSpent) {
      specialistWakes = []
      relayHinted = relayPrompted = ''
      return
    }
    if (epoch !== generation) return
    const { pending, exhausted, relay, unaddressed: unsent } = await deliver($, dir, state.members, full.posts, agents, now, epoch)
    if (epoch !== generation) return
    specialistWakes = relay
    unaddressed = unsent
    relayRun = dir
    const keyToRelay = relayKey(dir)
    if (keyToRelay === '') relayHinted = relayPrompted = ''
    if (isCoordinatorBusy || now < noticeRetry || now < noticeHold) return
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
      // The prompt carries these notices, so the first tool call of the turn it starts does not repeat them.
      const told = { relayHinted, hinted }
      if (askRelay) relayHinted = keyToRelay
      if (answerThrough) hinted = Math.max(hinted, answerThrough)
      noticeHold = now + NOTICE_HOLD_MS
      void $.prompt.submit({ text: `Swarm: ${heading}\nRun: ${full.title.replace(/\s+/g, ' ')}\n${notices.join('\n\n')}` })
        .then(result => {
          if (epoch !== generation) return
          noticeFailures = noticeRetry = 0
          // An explicit drop can mean the user stopped the session. Leave the notice on the board.
          if (result.drop) {
            noticeHold = 0
            $.ui.toast('Swarm was unable to notify the coordinator. Check the board for pending work.')
          }
        }).catch(() => {
          if (epoch !== generation) return
          noticeHold = 0
          if (askRelay && relayHinted === keyToRelay) relayHinted = told.relayHinted
          if (answerThrough && hinted === answerThrough) hinted = told.hinted
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

// Charges `amount` tokens to the actor's run under `report`, a name the board records once: a model step
// (`<turn>:<index>`) as it answers, and a turn's end (`<turn>`) for what no step reported. False when the
// charge is still owed: no run to charge yet, or the board did not take it.
async function account($: EngineInterface, report: string, agentId: string | undefined, amount: number): Promise<boolean> {
  if (!Number.isSafeInteger(amount) || amount <= 0 || (agentId && strangers.has(agentId) && !agentRuns.has(agentId))) return false

  const agent = agentId ? await $.agent.list().then(agents => agents.find(one => one.id === agentId)).catch(() => undefined) : undefined
  const address = agentId && (teammateOf($, agentId, agent) ?? agentId)
  const dir = agentId ? await agentRun($, agentId, agent) : await read($, run)
  if (!dir) return false
  // A closed run is charged nothing more and is no longer this conversation's run: what the coordinator does next is not its work.
  const isClosed = await $.fs.read(`${dir}/members.json`)
    .then(text => (JSON.parse(text) as { closed?: boolean }).closed === true).catch(() => false)
  if (isClosed) {
    if (dir === await read($, run)) {
      closedRun = dir
      await update($, run, () => '')
    }
    return true
  }
  const [turn, actor] = await Promise.all([
    digest(`swarm-turn:${report}`),
    address ? digest(`swarm-agent:${address}`) : Promise.resolve('coordinator'),
  ])
  const result = await boardCommand($, dir, ['account', turn, actor, String(amount)])
  if (result.exitCode !== 0 || result.stdout.trim() === '') return false
  const entry = JSON.parse(result.stdout) as { title: string; total: number; budget: number; paused: boolean }
  if (!entry.paused || dir !== await read($, run)) return true
  const isTold = Boolean(pauseSeen)  // a poll saw the pause before this did, and tells it
  pauseExpected()
  // Known at once, not a poll later: the members' next tool calls are refused from here.
  halted = { dir, why: `paused (token budget of ${compact(entry.budget)} spent)` }
  // The board reports the crossing once. A prompt that does not land would leave the run paused with nobody told.
  const unheard = () => $.ui.toast(`Swarm paused "${entry.title}": its token budget of ${compact(entry.budget)} is spent, and the coordinator could not be told. Raise the budget or close the run.`)
  if (isTold) return true
  void $.prompt.submit({
    text: `Swarm: Run paused at token budget\n${entry.title} spent ${compact(entry.total)} tokens and reached its budget of ${compact(entry.budget)}. Tell the user what is done and ask whether to raise the budget with limit and then resume, or close the run.`,
  }).then(result => { if (result.drop) unheard() }).catch(unheard)
  return true
}

// A member of a paused or spent run is refused its next tool call, so a turn in flight ends there instead of
// spending on. The coordinator is never refused: it has to report, raise the budget and resume.
async function refusal($: EngineInterface, agentId: string | undefined): Promise<string | undefined> {
  if (agentId === undefined || !halted) return undefined
  try {
    const dir = agentRuns.get(agentId) ??
      await agentRun($, agentId, (await $.agent.list()).find(one => one.id === agentId))
    if (dir !== halted?.dir) return undefined
    return `This Swarm run is ${halted.why}, so this tool call was not run. Make no more tool calls: end your turn now with one line saying where you stopped. The coordinator decides what happens when the run resumes.`
  } catch {
    return undefined // a check that failed stops nobody's tools
  }
}

/** Runs board commands for the owned run straight from a pane button, with no coordinator turn; the first that fails is told. */
async function control($: EngineInterface, dir: string, ...steps: string[][]): Promise<void> {
  if (dir === '' || dir !== await read($, run)) return
  pausing++  // what the person does from the pane is not news to tell the coordinator
  try {
    for (const args of steps) {
      const result = await boardCommand($, dir, args).catch(error => ({ exitCode: 1, stderr: String(error) }))
      if (result.exitCode !== 0) {
        $.ui.toast(`Swarm: ${clean(result.stderr).trim() || `the board's ${args[0]} command failed`}`)
        break
      }
    }
  } finally {
    pausing--
    pauseExpected()
  }
  await refresh($)
}

async function resetView($: EngineInterface): Promise<void> {
  talk = undefined
  await seek($, 0)
  await update($, expanded, () => 0)
  await update($, inspected, () => null)
  await update($, earlier, () => 0)
  await update($, query, () => '')
  $.ui.invalidate('ui.render')
}

/** Steps the pane to the project's next older (1) or newer (-1) run, or back to the live one (0). */
async function browse($: EngineInterface, step: 1 | 0 | -1): Promise<void> {
  try {
    const live = await read($, swarm)
    const root = `${await $.session.cwd()}/.swarm`
    // Run folders only, newest first as the board orders them: `archive` and stray folders carry no run's name.
    const stamp = (name: string) => name.replace(/x*$/, '').slice(-15)
    const names = step === 0 ? [] : (await $.fs.list(root))
      .filter(entry => entry.kind === 'dir' && RUN.test(`/.swarm/${entry.name}`)).map(entry => entry.name)
      .sort((a, b) => stamp(b).localeCompare(stamp(a)) || b.localeCompare(a))
    const at = names.indexOf((browsed ?? live).dir.slice(root.length + 1))
    let isLiveNext = step === 0
    for (let index = at + step; step !== 0 && index >= 0 && index < names.length; index += step) {
      const dir = `${root}/${names[index]}`
      if (dir === live.dir) {
        isLiveNext = true
        break
      }
      // A folder without a roster is no run: stepped over.
      const roster = await $.fs.read(`${dir}/members.json`).catch(() => undefined)
      if (roster === undefined) continue
      const [board, report] = await Promise.all([readBoard($, dir).catch(() => ''), reportOf($, dir)])
      browsed = { ...parse(dir, board, roster, await $.agent.list().catch(() => []), KEPT, report), mood: 'sleep', attentionUnavailable: !report }
      await stopLive($)
      await resetView($)
      return
    }
    if (!isLiveNext) {
      $.ui.toast(step > 0 ? 'No earlier run in this project.' : 'No later run in this project.')
      return
    }
    if (!browsed) return
    browsed = undefined
    await resetView($)
  } catch {
    $.ui.toast('Swarm could not read this project\'s runs.')
  }
}

// What one board tool answer may hold: the `read` page, and the cut `show` gets.
const PAGE = 48000
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
  if (action === 'read') args.push(`--max-bytes=${PAGE}`)
  if (action === 'revise') args.push(text)
  const result = await boardCommand($, dir, args, action === 'post' || action === 'ready' ? text : undefined)
  if (result.exitCode !== 0) return { deny: result.stderr.trim() || 'The board action failed.' }
  if (result.isStdoutTruncated) return { deny: 'The board response exceeded the tool limit. Use show with a post number, or ask the coordinator for help if it is a single long post.' }
  if (writesPost || action === 'read') $.clock.after(0, () => void refresh($))
  if (action === 'show' && result.stdout.length > PAGE) {
    if (e.seq) return { result: `${head(result.stdout, PAGE)}\n(Cut here: the post is longer than one page.)` }
    // `show` has no page of its own: the newest posts are kept, from the start of a line.
    const kept = result.stdout.slice(-PAGE)
    return { result: `Earlier posts are left out: the history is longer than one page. Narrow it with a member filter, or open one post with seq.\n${kept.slice(kept.indexOf('\n') + 1)}` }
  }
  // The board cuts a post longer than the page and says how to see it whole, in shell words: a specialist has the tool.
  return { result: result.stdout.replace(/\[cut to fit the page\. The whole post: show --post=(\d+)\]/g, '[cut to fit the page. The whole post: action "show" with seq $1]') }
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
  // Keep stable SVG sources during a visit. On a remount, resume each loop
  // at the phase it would have reached while its tab was away.
  const clocks = new Map<string, { scene: string; view: string; start: number; offset: number }>()
  function phase(slot: string, scene: string, view: string, now: number): number {
    let clock = clocks.get(slot)
    if (!clock || clock.scene !== scene) {
      clock = { scene, view, start: now, offset: 0 }
      clocks.set(slot, clock)
    } else if (clock.view !== view) {
      clock.view = view
      clock.offset = Math.max(0, now - clock.start)
    }
    return clock.offset
  }

  on('session.start', async ($, e, next) => {
    poller?.cancel()
    resetMonitoring()
    agentRuns.clear()
    strangers.clear()
    stepped.clear()
    teammates.clear()
    pendingStarts.clear()
    spawnEfforts.clear()
    isCoordinatorBusy = isEnding = isRefreshOwed = false
    // A start that follows no session.end (a reload) still opens its run's pane and reads its state anew.
    opened = closedRun = ''
    talk = browsed = undefined
    const saved = await $.store.get(TEAMMATES).catch(() => undefined)
    for (const [id, address] of Object.entries(saved && typeof saved === 'object' ? saved : {})) {
      if (typeof address === 'string') teammates.set(id, address)
    }
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
    poller = $.clock.every(2000, () => {
      void refresh($)
      void refreshTalk($)
    })

    return next(e)
  })

  // The board tool has a hook of its own, as the engine asks of a registered tool. Seen live: served
  // from the general hook below, a specialist resumed by a wake got "no tool.call hook answered".
  on('tool.call', { tool: BOARD_TOOL }, async ($, e) => {
    if (e.agentId) {
      moods.delete(e.agentId)
      moods.set(e.agentId, ['read', 'show'].includes(e.action) ? 'inspect' : 'relay')
    }
    try {
      const stopped = await refusal($, e.agentId)
      if (stopped) return { deny: stopped }
      return await specialistBoard($, e)
    } catch (error) {
      return { deny: `The board tool failed (${error instanceof Error ? error.message : String(error)}). End your turn and report this sentence to the coordinator.` }
    }
  }).catch(() => (
    // The hook is the whole tool: one that ran out of time is refused in words, never left unanswered.
    { deny: 'The board tool ran out of time. End your turn and report this sentence to the coordinator.' }
  ))

  on('tool.call', async ($, e, next) => {
    // A tool call in the main conversation means the coordinator is mid-turn, even when this
    // module loaded after that turn began (a restart, a reload) and never saw it start.
    if (e.agentId === undefined) isCoordinatorBusy = true
    const stopped = await refusal($, e.agentId)
    if (stopped) return { deny: stopped }
    const actor = e.agentId ?? 'coordinator'
    moods.delete(actor)
    moods.set(actor, e.tool === BOARD_TOOL && ['read', 'show'].includes(e.action) ? 'inspect' : toolMood(e.tool, e.tool === 'Bash' ? String(e.command) : ''))
    const agentCall = e.tool === 'Agent' && typeof e.tool_use_id === 'string' ? e.tool_use_id : undefined
    if (agentCall && e.tool === 'Agent') spawnEfforts.set(agentCall, e.effort)
    // The board command this call runs, if it is one: its run folder and its subcommand.
    const command = e.tool === 'Bash' ? String(e.command) : ''
    const match = BOARD_CALL.exec(command)
    const action = match?.[4]
    const isCoordinatorRead = action === 'read' && COORDINATOR_READ.test(command)
    let called = (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').replace(/\/+$/, '')
    // A pause the coordinator's own command makes (`pause`, a `limit` under what is spent) it reads in the output.
    const mayPause = e.agentId === undefined && (action === 'pause' || action === 'limit')
    if (mayPause) pausing++
    const raw = await next(e).finally(() => {
      if (agentCall) spawnEfforts.delete(agentCall)
      if (mayPause) {
        pausing--
        pauseExpected()
        $.clock.after(0, () => void refresh($))
      }
    })
    let result = raw
    try {
      if (e.agentId === undefined && raw.deny === undefined && raw.isError === undefined) {
        const dir = await read($, run)
        // Only a real read of this run's board answers its mentions: the words alone may sit in a commit message.
        if (isCoordinatorRead && called === dir) owed = NONE
        const notices: string[] = []
        const key = relayKey(dir)
        if (key && key !== relayHinted && !(e.tool === 'SendMessage' && Number.isSafeInteger(wakeSequence(String(e.message))))) {
          relayHinted = key
          notices.push(relayNotice())
        }
        // A read of the board is never told to read it, however it named the run (a shell variable, a relative path).
        if (dir && owed.last > hinted && !isCoordinatorRead) {
          hinted = owed.last
          notices.push(`Swarm: ${unreadNotice($, dir)}`)
        }
        if (dir && pauseOwed) {
          notices.push(`Swarm: ${pauseNotice('This run', pauseOwed)}`)
          pauseOwed = ''
        }
        if (notices.length > 0) result = { ...raw, context: [...(raw.context ?? []), ...notices] }
      }
    } catch {
      // A failed reminder must not change the tool's result.
    }
    if (e.tool !== 'Bash' || result.isError || result.deny) return result
    // `init` names the folder to make the run under and prints the run folder it made.
    if (action === 'init' && e.agentId === undefined) {
      called = String((raw.result as { stdout?: unknown } | undefined)?.stdout ?? '').trim().split('\n').at(-1)?.trim() ?? ''
    }
    const dir = called
    // A read whose run could not be read off the command still changed what is owed: the roster is read again now.
    if (isCoordinatorRead && e.agentId === undefined && !RUN.test(dir)) $.clock.after(0, () => void refresh($))
    if (!RUN.test(dir)) return result
    try {
      const owned = await read($, run)
      // The coordinator's own planning shows whose run it is as surely as its first read, which it may skip: the
      // run is bound from `init` on, so that planning is charged to it. `plan` only reads, so it claims a run only
      // while none is owned. The board refuses a run another conversation owns.
      const claims = isCoordinatorRead || action === 'init' || action === 'member' || (action === 'plan' && owned === '')
      if (e.agentId === undefined && claims && dir !== owned) await bind($, dir)
      // The roster may now record an agent that was looked up before it was on it.
      if (e.agentId === undefined) strangers.clear()
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
    const current = await read($, run) || closedRun
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
        ? { deny: `Swarm "${state.title ?? ''}" is closed, so ${named ? `@${named}` : 'this member'} is not started. Start a new run with the board's init command and register the member there.` }
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
        if (started.teammateId) learnTeammate($, started.agentId, started.teammateId)
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
    if (e.agentId === undefined) {
      isCoordinatorBusy = true
      noticeHold = 0
    }

    return next(e)
  })
  // Each model response is charged as it answers: a turn of many steps would otherwise cross the budget unseen
  // until it ends. The response passes through untouched and never waits for the board; the turn's end does.
  on('turn.step', async function* ($, e, next) {
    const response = yield* next(e)
    try {
      const spent = response.usage
      const turn = spent && charge(e.turnId, spent, e.index) > 0 ? stepped.get(e.turnId) : undefined
      if (spent && turn) {
        const amount = weigh(spent)
        turn.landing = turn.landing
          .then(() => account($, `${e.turnId}:${e.index}`, e.agentId, amount))
          .catch(() => false)
          .then(landed => { if (!landed) uncharge(e.turnId, spent, e.index) })
      }
    } catch {
      // A usage failure must not change the response.
    }
    return response
  })
  on('turn.complete', async ($, e, next) => {
    moods.delete(e.agentId ?? 'coordinator')

    try {
      try {
        // The steps first: what they could not charge is this report's, and a pause one of them set must be known here.
        await stepped.get(e.turnId)?.landing
        await account($, e.turnId, e.agentId, e.usage ? charge(e.turnId, e.usage) : 0).catch(() => undefined)
      } finally {
        // Only once its usage is on the board: a poll in between would act on the roster as it was before a budget pause.
        if (e.agentId === undefined) {
          isCoordinatorBusy = false
          quietSince = await $.clock.now()
        }
      }
      if (e.agentId !== undefined) {
        // A member that was woken and ended its turn without reading is owed the wake again.
        const agent = (await $.agent.list()).find(agent => agent.id === e.agentId)
        const dir = await agentRun($, e.agentId, agent)
        const address = teammateOf($, e.agentId, agent)
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
    // No poll runs from here until the end is through: one in between would look the new session's run up under
    // the old session's id, and after an exit nothing is left to poll for.
    isEnding = true
    isRefreshOwed = false
    if (!goesOn) {
      poller?.cancel()
      poller = undefined
    }
    resetMonitoring()
    agentRuns.clear()
    strangers.clear()
    stepped.clear()
    // A teammate's address is kept through /clear and a resume: one that ends afterwards has left the agent
    // list, and its last turn and its wake are still recorded under that address.
    if (!goesOn) teammates.clear()
    pendingStarts.clear()
    spawnEfforts.clear()
    opened = closedRun = ''
    talk = browsed = undefined
    isCoordinatorBusy = false
    try {
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
      return await next(e)
    } finally {
      isRestoreOwed = goesOn
      isEnding = !goesOn
    }
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
    talk = undefined  // nothing reads a conversation behind a closed pane
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
    // Every plugin's hook hears every placed row: only this plugin's own opener is drawn here.
    if (e.props.plugin !== $.plugin.name || !e.props.id.startsWith(OPENER)) return next(e)
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
    const shown = await shownSwarm($)
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
    const now = HeaderArt ? await $.clock.now() : 0
    const mood = shown.mood ?? 'sleep'
    const hiveOffset = phase(e.surface + '-hive', shown.dir + '/' + mood, current, now)
    const liveOffset = phase(e.surface + '-live', shown.dir, current, now)
    const latest = shown.posts.at(-1)?.seq
    if (current !== 'graph') phase(e.surface + '-route', shown.dir + '/' + latest, current, now)
    const memberOf = (name: string) => shown.members.find(member => member.name === name)
    const feedOf = async (name: string) => {
      talk = undefined
      await stop($)  // a replay left running would keep stepping behind the Board tab
      await update($, query, () => `@${name}`)
      await update($, inspected, () => null)
      await update($, latestOnly, () => false)
      await update($, tab, () => 'board')
    }
    const hiding = await read($, hideInactive)
    const columns = Math.max(20, e.props.bodyColumns ?? 40)
    // The rows the pane's own window shows, less the header and the tab row; the viewport only where the surface gives no window.
    const rows = Math.max(8, (e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 24) - 7)

    if (shown.dir === '') {
      return (
        <Box flexDirection="column">
          {HeaderArt && <HeaderArt key="hive" source={hiveArt('sleep', hiveOffset)} alt="Sleeping bees" width={88} height={44} />}
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

    // The buttons that change a run act on the one this conversation owns, while it is open: never on a run only looked at.
    const isDriven = !browsed && !shown.isClosed && (await read($, run)) === shown.dir
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
        if ((await shownSwarm($)).dir !== shown.dir) return
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
        // The opened post takes the rows it really draws, so the posts around it are fitted to what is left.
        const text = post.seq === open ? openedText(post) : preview(post)
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
      // A kind this version does not know is still shown, uncoloured.
      const tone = (kind: string) =>
        ['unreachable', 'ignored', 'stale', 'rework'].includes(kind) ? 'error' : kind === 'paused' ? 'suggestion'
          : ['unread', 'review', 'question', 'unstarted', 'blocked', 'spend'].includes(kind) ? 'warning' : undefined
      const isSpent = shown.budget > 0 && total >= shown.budget
      const ask = (text: string) => void $.prompt.submit({ text }).catch(() => undefined)
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
              borderColor={tone(item.kind) ?? 'subtle'}
              borderDimColor
              paddingX={1}
            >
              <Text>
                <Text bold color={tone(item.kind)}>{String(item.kind || 'note').toUpperCase()}</Text>
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
                {item.kind === 'unreachable' && isDriven && (
                  <Button
                    key={`attention-recover-${index}`}
                    plain
                    label="Ask coordinator to recover"
                    onPress={() => ask(`Swarm: Recover @${item.member}\n@${item.member} is unreachable (board post #${item.seq}). Run the board's retry command for it once. If it is still unreachable after that, use the board's replace command to register a successor with its brief and history, then spawn the successor.`)}
                  />
                )}
                {item.kind === 'paused' && isSpent && isDriven && (
                  <Button
                    key={`attention-budget-${index}`}
                    plain
                    label="+500k & resume"
                    onPress={() => control($, shown.dir, ['limit', `budget=${shown.budget + 500_000}`], ['resume'])}
                  />
                )}
                {item.kind === 'ignored' && isDriven && (
                  <Button key={`attention-retry-${index}`} plain label="Retry" onPress={() => control($, shown.dir, ['retry', item.member])} />
                )}
                {item.kind === 'review' && isDriven && (
                  <Button
                    key={`attention-review-${index}`}
                    plain
                    label="Ask coordinator to review"
                    onPress={() => ask(`Swarm: Review @${item.member}'s finding\n@${item.member}'s finding awaits your review (board post #${item.seq}). Read it with the board's show --post=${item.seq}, then accept it with the board's confirm command or answer @${item.member} on the board.`)}
                  />
                )}
                {item.kind === 'rework' && isDriven && (
                  <Button
                    key={`attention-rework-${index}`}
                    plain
                    label="Ask coordinator"
                    onPress={() => ask(`Swarm: @${item.member} keeps failing verification\n@${item.member} has not passed verification several times in a row${item.seq ? ` (board post #${item.seq})` : ''}. Read its NOT PASSED posts, then decide: give it a narrower brief, replace it, or pause the run and ask the user.`)}
                  />
                )}
              </Box>
            </Box>
          ))}
        </Box>
      )
    } else if (current === 'members' && talk?.dir === shown.dir) {
      const open = talk
      const member = memberOf(open.name)
      // Filled from the newest row back, as the Board is, so what the agent does now is in view.
      let fitted = 0
      let used = 0
      for (const row of [...open.rows].reverse()) {
        const cost = 2 + row.text.split('\n').length + Math.floor(row.text.length / columns)
        if (fitted > 0 && used + cost > rows) break
        fitted++
        used += cost
      }
      // The first row stays in view whatever is between it and the newest.
      const from = Math.max(1, open.rows.length - fitted - open.more)
      const hidden = from - 1 + open.skipped
      const draw = (row: TalkRow, index: number) => row.kind === 'tools' ? (
        <Text key={`talk-${index}`} dimColor>{row.text}</Text>
      ) : row.kind === 'prompt' ? (
        <Box key={`talk-${index}`} flexDirection="column" borderStyle="round" borderColor="subtle" borderDimColor paddingX={1}>
          <Text bold dimColor>{index === 0 ? 'Prompt' : 'Message'}</Text>
          <Markdown text={row.text.replace(/\n/g, '  \n')} />
        </Box>
      ) : (
        <Markdown key={`talk-${index}`} text={row.text} />
      )
      body = (
        <Box flexDirection="column" marginTop={1} gap={1}>
          <Box flexDirection="row" alignItems="center" columnGap={1} flexWrap="wrap">
            <Button key="talk-back" plain label="‹ Members" onPress={() => closeTalk($)} />
            <Text wrap="truncate-end">
              <Text bold color={hueOf(open.name)}>@{open.name}</Text>
              <Text dimColor>{`  conversation${member ? ` · ${member.status}` : ''}`}</Text>
            </Text>
          </Box>
          {open.rows.length === 0 ? <Text dimColor>Nothing said yet.</Text> : draw(open.rows[0]!, 0)}
          {from > 1 ? (
            <Button
              key="talk-earlier"
              plain
              dimColor
              label={`↑ Show earlier (${hidden})`}
              onPress={() => {
                if (talk === open) talk = { ...open, more: open.more + 6 }
                $.ui.invalidate('ui.render')
              }}
            />
          ) : open.skipped > 0 && (
            <Text dimColor>{`${open.skipped} earlier entries are not kept here.`}</Text>
          )}
          {open.rows.slice(from).map((row, index) => draw(row, from + index + open.skipped))}
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

        // Every card has the same rows in the same order, so a column of them can be scanned: who it is and
        // what it runs on, then how it is doing, then what it waits for, owns and last said.
        return (
          <Box key={member.name} flexDirection="column" borderStyle="round" borderColor={hueOf(member.name)} borderDimColor paddingX={1}>
            <Text strikethrough={member.status === 'killed'} wrap="truncate-end">
              <Text bold color={hueOf(member.name)}>@{member.name}</Text>
              <Text dimColor>
                {`  ${[member.role === 'coordinator' ? '' : member.type, `${member.model} ${member.effort}`.trim()].filter(part => part !== '').join(' · ')}`}
              </Text>
            </Text>
            <Box flexDirection="row" alignItems="center">
              {HeaderArt ? <HeaderArt source={statusDot(member.status)} alt={member.status} width={12} height={12} /> :
              <Text color={statusColor}>{isBroken ? '!' : ['killed', 'not started'].includes(member.status) ? '○' : '●'}</Text>}
              <Text wrap="truncate-end">
                <Text dimColor>{` ${member.status} · ${counted(member.posts, 'post')}`}</Text>
                {spentBy(member) > 0 && <Text dimColor>{` · ${compact(spentBy(member))} tokens`}</Text>}
                {member.unread > 0 && member.status !== 'killed' && (
                  <Text bold color="warning">{` · ${member.unread} unread`}</Text>
                )}
              </Text>
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
              <Box key={title} flexDirection="column" marginTop={1}>
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
        ...Object.keys(shown.earlierEdges ?? {}).flatMap(edge => pairOf(edge) ?? [edge.split('>')[0] ?? '']),
        ...shown.posts.slice(0, index + 1).flatMap(entry => [entry.agent, ...entry.to]),
      ])
      const hideable = [...inactive].filter(name =>
        memberOf(name)?.role !== 'coordinator' && (participants === undefined || participants.has(name)) &&
        name !== post.agent && !post.to.includes(name),
      )
      const hidden = new Set(hiding ? hideable : [])
      const animate = playing || (live && pulse === post.seq)
      const repeat = index === shown.posts.length - 1 && !animate
      const isExpanded = await read($, expandAll)
      const hasBroadcast = shown.posts.some(isBroadcast) || Object.keys(shown.earlierEdges ?? {}).some(edge => edge.endsWith('>@all'))
      const routeOffset = phase(e.surface + '-route', shown.dir + '/' + latest,
        [current, post.seq, animate, repeat, isExpanded, ...hidden].join('/'), now)
      body = (
        <Box flexDirection="column" marginTop={1} gap={1}>
          <Box flexDirection="row" justifyContent="space-between" flexWrap="wrap" columnGap={1}>
            {live && !browsed && !shown.isClosed && !shown.isPaused ? (
              <Box flexDirection="row" alignItems="center" gap="xs">
                <Svg key="live-indicator" source={liveIndicator(liveOffset)} alt="Live activity" width={16} height={16} isInteractive />
                <Text bold color="success">Live</Text>
              </Box>
            ) : (
              <Text dimColor>{live ? (shown.isPaused && !shown.isClosed ? 'Paused' : 'Latest post') : `Post ${index + 1} of ${shown.posts.length}`}</Text>
            )}
            <Box flexDirection="row" gap="sm" alignItems="center">
              <Button
                key="expand-all"
                plain
                dimColor={!hasBroadcast}
                label={isExpanded ? 'Collapse @all' : 'Expand @all'}
                onPress={() => update($, expandAll, isOn => !isOn)}
              />
              {inactiveToggle(hideable.length)}
            </Box>
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
            key="message-routes" source={graphSvg(shown, post.seq, hidden, animate, live, repeat, routeOffset, isExpanded)}
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
      // The same keys the diagram counts: a pair by name, a pair reached through @all, and a sender's @all posts.
      for (const [edge, count] of Object.entries({ ...shown.earlierEdges, ...Object.fromEntries(
        Object.entries(edgesOf(shown.posts)).map(([key, more]) => [key, more + (shown.earlierEdges?.[key] ?? 0)])) })) {
        const [from = '', to = '', via] = edge.split('>')
        if (to === '@none' || (hiding && (inactive.has(from) || inactive.has(to)))) continue
        edges.set(to === '@all' ? `@${from} → @all` : `@${from} → @${to}${via ? ' (via @all)' : ''}`, count)
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
              <Text key={edge}>
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
          {HeaderArt && <HeaderArt key="hive" source={hiveArt(mood, hiveOffset)} alt={`Swarm hive: ${shown.mood ?? 'sleep'}`} width={88} height={44} />}
          <Box flexDirection="column" flexShrink={1}>
            <Text bold wrap="truncate-end">{shown.title}</Text>
            <Text dimColor>
              {`${shown.isClosed ? 'Closed' : shown.isPaused ? 'Paused' : `${working} working · ${waiting} waiting`} · ${counted(shown.total ?? shown.posts.length, 'post')}`}
              {total > 0 ? ` · ${compact(total)}${shown.budget > 0 ? ` of ${compact(shown.budget)}` : ''} tokens` : ''}
            </Text>
          </Box>
        </Box>
        {error && <Text color="warning">{error}</Text>}
        <Box flexDirection="row" gap="sm" flexWrap="wrap" alignItems="center">
          {isDriven && (
            <Button
              key="run-pause"
              plain
              label={shown.isPaused ? 'Resume run' : 'Pause run'}
              onPress={() => control($, shown.dir, shown.isPaused ? ['resume'] : ['pause', 'paused from the pane'])}
            />
          )}
          <Button key="run-prev" plain dimColor label="‹ Prev run" onPress={() => browse($, 1)} />
          <Button key="run-next" plain dimColor label="Next run ›" onPress={() => browse($, -1)} />
          {browsed && <Text bold color="warning">Not the live run · read-only</Text>}
          {browsed && <Button key="run-live" plain label="Back to live run" onPress={() => browse($, 0)} />}
        </Box>
        <Box flexDirection="row" gap="xs" flexWrap="wrap" marginTop={1}>
          {TABS.map(name => (
            <Button
              key={`tab-${name}`}
              variant={name === current ? 'primary' : 'secondary'}
              onPress={async () => {
                closeTalk($)
                if (name !== current) {
                  await stop($)
                  await stopLive($)
                  // A post opened from another tab belongs to that visit: it is not kept selected behind the next tab.
                  await update($, inspected, () => null)
                  await update($, expanded, () => 0)
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
