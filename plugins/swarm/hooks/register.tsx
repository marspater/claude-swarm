// The Swarm pane and its session hooks. board.py owns the board files.
import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, Register, SessionMessage, Timer, ToolCallResult } from 'claude-code'

import type { Member, Post, Swarm, Tab } from '../types'
import { COORDINATOR_READ, NAMES_COMMIT, RUN, boardCalls, type ParsedBoardCall, runsNamed, substitutions, wakeMessage, wakeSequence } from './command'
import { actsAsAnother, commitsInSharedCheckout, normalizePath, resolveRealPath } from './guard'
import { DEFAULT_EFFORT, DEFAULT_MODEL, LATEST, SPECIALISTS, SWARM_AGENTS, familyOf, latestOf } from './models'
import { KEPT, budgetOf, findAgent, ledger, memberNamed, mentions, parse, parsePosts, postFields, targets, tokensUsed, type BudgetState, type Report, type Roster } from './roster'
import { CLIP, bodyOf, chipped, clean, clip, compact, fenceAfter, hasQuestion, head, kindOf, openedText, verdictOf, type Fence } from './text'
import { statusInk, statusDot } from './palette'
import { hiveArt, toolMood, toolSummary, type Mood } from './hive'
import { MIN_LABEL_PX, SVG_LIMIT, drawGraph, edgesOf, graphHeight, isBroadcast, labelPx, pairOf, visibleMembers } from './graph'

const PANE = 'swarm'
const TITLE = 'Swarm'
const DEPLOYED = /^Swarm deployed\.(?:\s|$)/m
const EMPTY: Swarm = { title: '', dir: '', isClosed: false, posts: [], members: [], attention: [], budget: 0, tokens: {} }
const BOARD_TOOL = 'mcp__swarm__board'
// A swarm: agent starts only as a registered member of an open run: none is started, or resumed, outside one.
const NO_RUN_AGENT = 'swarm: agents run only inside a Swarm run the user started with /swarm:swarm, as members its coordinator registered. ' +
  'This conversation drives no such run, so it was not started: use a general-purpose or Explore agent for this.'
// What the board tool answers a caller in no run: it makes, adopts and reads nothing.
const NO_RUN_BOARD = 'There is no Swarm run here: the board tool works only inside a Swarm run the user started with /swarm:swarm.'
const counted = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`
const postTime = (post: Post) => post.time.length >= 16 ? post.time.slice(11, 16) : ''

// Adds Markdown hard-break trailing spaces only outside fenced code blocks, on non-blank lines, and not on GFM table rows.
function formatMarkdown(text: string): string {
  const lines = text.split('\n')
  let fence: Fence = null
  return lines.map((line, idx) => {
    const before = fence
    fence = fenceAfter(fence, line)
    // A fence's own lines and what lies between them stay as they are.
    if (before !== null || fence !== null || idx === lines.length - 1) return line
    if (line.trim() === '' || line.trimStart().startsWith('|')) return line
    return line.endsWith('  ') ? line : `${line}  `
  }).join('\n')
}

function visualWidth(text: string): number {
  let w = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    w += (cp >= 0x1100 && (
      cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      cp >= 0x1f300
    )) ? 2 : 1
  }
  return w
}
const estimateRows = (text: string, columns: number) =>
  text.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(visualWidth(line) / columns)), 0)
const TABS: Tab[] = ['board', 'attention', 'members', 'graph']
const REPLAY_FRAME_MS = 1200
const liveIndicator = (elapsed: number) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">
  <style>
    svg{--status-working:#349962}
    @media(prefers-color-scheme:dark){svg{--status-working:#4cc480}}
    @supports(color:color(display-p3 1 0 0)){svg{--status-working:color(display-p3 .3224 .5918 .4028)}@media(prefers-color-scheme:dark){svg{--status-working:color(display-p3 .4333 .7586 .5248)}}}
    circle{fill:var(--status-working)}
    .breath{transform-box:fill-box;transform-origin:center;animation:breath 4s cubic-bezier(.42,0,.58,1) -${elapsed % 4000}ms infinite}
    @keyframes breath{0%,100%{transform:scale(1);opacity:.3}50%{transform:scale(2);opacity:.06}}
    @media (prefers-reduced-motion: reduce){.breath{display:none}}
  </style>
  <circle class="breath" cx="8" cy="8" r="3.5"/>
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
// The READY whose commit's diff is open under it and that diff as git printed it, after a first line that says
// what it covers; seq 0 for none.
const NO_DIFF = { seq: 0, text: '' }
const diff = atom({ plugin: 'swarm', key: 'diff' } as const, NO_DIFF)
// The scope line and the fenced diff of what `diff` holds; one stored before the scope line has none.
const diffParts = (text: string) => text.startsWith('`') ? ['', text] : [text.slice(0, text.indexOf('\n')), text.slice(text.indexOf('\n') + 1)]
// What the Board tab is narrowed to: text matched against sender, recipients, kind and body.
const query = atom({ plugin: 'swarm', key: 'query' } as const, '')

// A run looked at through the pane's run switcher: read once and drawn read-only. The live run goes on being
// polled, woken and charged behind it; nothing done for this one binds it, wakes its members or accounts to it.
// `boardUnavailable`: its board could not be read, which is not a board with no posts.
let browsed: (Swarm & { boardUnavailable?: boolean }) | undefined
// Whether the run in `dir` has an older and a newer run beside it, false once the run list showed it has none;
// unknown until the switcher read the list.
let runEdge: { dir: string; older?: boolean; newer?: boolean } = { dir: '' }
const shownSwarm = async ($: EngineInterface) => browsed ?? await read($, swarm)
// The run whose long title is shown whole; '' for none.
let titleOpen = ''
// Whether the graph's routes are listed in words under the drawing, and how many pages of them are shown.
let routesListed = false
let routePages = 1

// One theme colour per member, by its place on the roster (never colliding with status hues).
const HUES = ['claude', 'suggestion', 'planMode', 'ide', 'merged', 'permission', 'remember', 'autoAccept'] as const

let player: Timer | undefined
let livePlayer: Timer | undefined
let playGen = 0

function stop($: EngineInterface): Promise<unknown> {
  playGen++
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
    try {
      const [{ posts }, current] = await Promise.all([read($, swarm), read($, livePulse)])
      if (livePlayer !== timer) return
      const next = posts.find(post => post.seq > current)
      if (next === undefined) {
        await stopLive($)
        return
      }
      await update($, livePulse, () => next.seq)
      if (livePlayer === timer) scheduleLiveFrame($)
    } catch {
      // A read or update that failed ends this animation, in a teardown or not: the next post starts another.
      if (livePlayer === timer) livePlayer = undefined
    }
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
    try {
      const [{ posts }, selected] = await Promise.all([shownSwarm($), read($, replay)])
      if (player !== timer) return
      const next = posts.find(post => post.seq > selected)
      if (next === undefined) {
        await stop($)
        return
      }
      await update($, replay, () => next.seq)
      if (player === timer) scheduleFrame($)
    } catch {
      // A replay that cannot go on is stopped, so Play starts it again instead of pausing nothing.
      if (player === timer) {
        player = undefined
        void update($, isPlaying, () => false).catch(() => undefined)
      }
    }
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
  const gen = ++playGen
  const [{ posts }, selected] = await Promise.all([shownSwarm($), read($, replay)])
  if (gen !== playGen || isEnding) return
  const first = posts[0]?.seq
  const last = posts.at(-1)?.seq
  if (first === undefined || first === last) return
  await stopLive($)
  if (gen !== playGen || isEnding) return
  await update($, replay, () => selected === 0 || selected === last ? first : Math.max(first, selected))
  if (gen !== playGen || isEnding) return
  await update($, isPlaying, () => true)
  if (gen !== playGen || isEnding) return
  scheduleFrame($)
}

const QUIET_MS = 30_000
const WAKE_ATTEMPTS = 3
let seen = ''
let seenBoard = ''
let seenRoster = ''
let boardStat: { dir: string; size: number; mtimeMs: number; content: string } | undefined
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
let isPaneOpen = false
// Whether the pane is up at all, minimised included: only then is a run this conversation does not drive read.
let isWatched = false
let poller: Timer | undefined
let generation = 0
let sessionEpoch = 0
let browseGen = 0
const agentRuns = new Map<string, string>()
// Agents looked up and found to be no member of a run: asked once, not on every model step and tool call.
const strangers = new Set<string>()
// The agents of the owned run's retired members, as the last poll read them.
let retired: ReadonlySet<string> = new Set()
// The agents of the owned run's members that spent their own token budget: refused like a paused run, one by one.
let memberPaused: ReadonlySet<string> = new Set()
// Cached roster of the owned run for immediate runtime enforcement before the next poll.
let ownedRoster: { dir: string; closed: boolean; members: Roster } | undefined
// Agents of the owned run that its roster file, as stamped, names nowhere: its next change, or a start this
// conversation records, has them looked for again.
let rosterMiss: { dir: string; stamp: string; ids: Set<string> } | undefined
// The run this conversation drove until it closed: its members are still refused by name.
let closedRun = ''
// Whether the project held a Swarm run when the session began: only then is the board offered unasked.
let hadRun = false
// The owned run while it is paused or over budget, and why: its members are refused their next tool call.
let halted: { dir: string; why: string } | undefined
// What each turn's model steps have been charged so far, so its end charges only what no step reported.
const stepped = ledger()
// The run the coordinator drove when a turn of its own last stepped, until that turn ends.
const turnRuns = new Map<string, string>()
// Past this many running turns, those of agents that have ended are looked for and dropped.
const TURNS_KEPT = 256
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
  while (teammates.size > 200) {
    const oldest = teammates.keys().next().value
    if (oldest === undefined) break
    teammates.delete(oldest)
  }
  void $.store.get(TEAMMATES).then(existing => {
    const merged = {
      ...(existing && typeof existing === 'object' ? existing as Record<string, string> : {}),
      ...Object.fromEntries(teammates),
    }
    const entries = Object.entries(merged).slice(-200)
    return $.store.set(TEAMMATES, Object.fromEntries(entries))
  }).catch(() => undefined)
}
function teammateOf($: EngineInterface, id: string, agent?: AgentInfo): string | undefined {
  if (agent?.teammateId) learnTeammate($, id, agent.teammateId)
  return agent?.teammateId ?? teammates.get(id)
}
const pendingStarts = new Set<string>()
const spawnEfforts = new Map<string, string | undefined>()
const spawnIsolations = new Map<string, string | undefined>()
const sharedAgents = new Set<string>()
const isolatedAgents = new Set<string>()
// The board's QUESTION: a question mark that asks, in a run of them too ("sure??"), and none of `a ?? b`, `a?.b`,
// `name?: type` or `c ? a : b`.
const WATCHER_BG_RE = /\b(sleep|watch|tail\s+-f|while|until|pgrep|lsof)\b|\bboard\.py\b|\bverify\.py\b|\.swarm\b|\.lock\b/

function parsePaths(raw?: string): string[] {
  return (raw ?? '')
    .split(',')
    .map(p => p.trim().replace(/\/+$/, ''))
    .filter(Boolean)
}

function pathCovers(ownerPath: string, targetPath: string): boolean {
  if (ownerPath === '.') return true
  // Case-insensitive, like the board's claimed_twice, so both sides agree on what overlaps.
  const owner = ownerPath.toLowerCase()
  const target = targetPath.toLowerCase()
  return target === owner || target.startsWith(`${owner}/`)
}

function pathsOverlap(a: string[], b: string[]): boolean {
  return a.some(pa => b.some(pb => pathCovers(pa, pb) || pathCovers(pb, pa)))
}

/** The agent ids and addresses of the members `pick` chooses: retired ones, or ones paused on their own budget. */
function agentIdsOf(members: Roster, agents: AgentInfo[], pick: (member: Roster[string]) => boolean): Set<string> {
  const ids = new Set<string>()
  for (const member of Object.values(members)) {
    if (!pick(member) || !member.id) continue
    ids.add(member.id)
    for (const agent of agents) {
      if (agent.id === member.id || agent.teammateId === member.id) {
        ids.add(agent.id)
        if (agent.teammateId) ids.add(agent.teammateId)
      }
    }
    for (const [id, address] of teammates) {
      if (address === member.id) ids.add(id)
    }
  }
  return ids
}
/** Whom the roster stops: retired members, and members paused on their own budget, whose notice is owed again once resumed. */
function rosterIds(members: Roster, agents: AgentInfo[], read: number) {
  for (const name of memberPausesTold) if (!memberNamed(members, name)?.paused) memberPausesTold.delete(name)
  // A notice owed for a member resumed, replaced or retired since is dropped, but only by a roster read begun after it was owed.
  memberPausesOwed = memberPausesOwed.filter(owed => owed.read >= read || (memberNamed(members, owed.name)?.paused && !memberNamed(members, owed.name)?.killed))
  return {
    retired: agentIdsOf(members, agents, member => Boolean(member.killed)),
    memberPaused: agentIdsOf(members, agents, member => !member.killed && Boolean(member.paused)),
  }
}
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
// A READY while others still work changes nothing the coordinator can act on: it waits to be read with the next
// one, or until the last member stops, or this long. Questions, findings and verdicts are never held.
const ROUTINE_GRACE_MS = 600_000
// The coordinator's conversation at this size makes every further wake dear: the person is told once per run.
const HEAVY_CONVERSATION = 180_000
let owed = NONE
// A conversation this long is worth a word before a run starts in it: about half of what the coordinator's last run averaged.
const LONG_CONVERSATION = 120_000
// Posts the coordinator has opened with `show`: the board still counts them unread, but it is not told of them again.
const shownPosts = { through: 0, posts: new Set<number>() }
// The posts `owed` counts, and whether all of them are routine (see ROUTINE_GRACE_MS).
let owedSeqs: number[] = []
let isOwedRoutine = false
let heavyTold = ''
let hinted = 0
let prompted = 0
// A pause of the owned run that nobody was told about (the board pauses by itself when a member keeps failing
// verification) is told to the coordinator once. Not told: one the budget made (`account` prompts), one the
// person made from the pane, one the coordinator's own board command made. Those mark the pause as expected:
// `pausing` while their command runs, `pauseQuiet` until a poll that began after it has looked.
let pauseSeen: string | undefined  // undefined until the first look at a run: the pause it starts with is not news
let pauseOwed = ''
// Members that stopped without reporting: when each was first seen so, and which the coordinator has been told of.
// Told once per member and post, with no wake of its own.
const SILENT_GRACE_MS = 60_000
let silentSince = new Map<string, number>()
let silentTold = new Set<string>()
// What the coordinator is owed with its next tool call, none of it worth a wake: a silent member, a HEAD that moved
// under a shared-checkout writer, a post the person made in its name from the pane.
let notesOwed: string[] = []
// Members that spent their own token budget, told once each as a paused run is: with the next tool call, or a prompt when idle.
let memberPausesOwed: { name: string; read: number }[] = []
// Each read of the owned roster, numbered as it begins.
let rosterReads = 0
let memberPausesTold = new Set<string>()
const memberPauseNotice = (name: string) =>
  `@${name} has spent its own token budget and is paused: its tool calls are refused. Raise its budget with the board's member command (budget=<tokens>) and then run resume ${name}, or replace it.`
let budgetPauseNotifiedFor = ''
let pausing = 0
let pauseQuiet = 0
let polls = 1
const pauseExpected = () => { pauseQuiet = polls }
const pauseNotice = (title: string, reason: string) =>
  `${title} is paused: ${reason}. Tell the user what is done and why the run stopped, and ask how to go on. The board's resume command continues the run; a spent budget is raised with limit first.`
// A submitted notice is held until the turn it starts: a poll before that turn.start would submit a second beside it.
const NOTICE_HOLD_MS = 10_000
let noticeHold = 0
/** A prompt the person sends from the pane, held as a notice is: the coordinator is not yet busy, and a poll would add a second. */
async function submitHeld($: EngineInterface, text: string, failed: () => void): Promise<void> {
  noticeHold = (await $.clock.now()) + NOTICE_HOLD_MS
  const fail = () => { noticeHold = 0; failed() }
  void $.prompt.submit({ text }).then(result => { if (result.drop) fail() }).catch(fail)
}
type SpecialistWake = { name: string; id: string; seq: number; attempts: number; told: number; native: boolean }
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
// `agentId` '' is the coordinator's: this session's main conversation.
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
    // The main conversation never ends while this session runs.
    const agent = open.agentId ? (await $.agent.list()).find(one => one.id === open.agentId) : undefined
    const isOver = open.agentId !== '' && (!agent || ['completed', 'failed', 'killed'].includes(agent.status))
    if (isOver && open.isOver) return
    const messages = open.agentId ? await $.session.messages({ agentId: open.agentId }) : await $.session.messages()
    // An agent whose conversation can no longer be read keeps the rows last read.
    if (!talk || talk.dir !== open.dir || talk.agentId !== open.agentId || talk.name !== open.name) return
    const next = Array.isArray(messages) ? talkRows(messages) : talk
    const changed = next.key !== talk.key
    if (changed || talk.isOver !== isOver) talk = { ...talk, ...next, isOver }
    if (changed) $.ui.invalidate('ui.render')
  } catch {
    // The next poll reads it again.
  } finally {
    isReadingTalk = false
  }
}

function resetMonitoring(): void {
  retired = new Set()
  memberPaused = new Set()
  headNoted = ''
  ownedRoster = undefined
  rosterMiss = undefined
  moods.clear()
  generation++
  seen = seenBoard = seenRoster = activity = stalled = heavyTold = ''
  boardStat = undefined
  snapshot = undefined
  attentionRetry = noticeFailures = noticeRetry = 0
  owed = NONE
  shownPosts.through = 0
  shownPosts.posts.clear()
  owedSeqs = []
  isOwedRoutine = false
  hinted = prompted = noticeHold = pauseQuiet = 0
  pauseSeen = undefined
  pauseOwed = ''
  silentSince = new Map()
  silentTold = new Set()
  notesOwed = []
  memberPausesOwed = []
  memberPausesTold = new Set()
  budgetPauseNotifiedFor = ''
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
// newest posts, so the pane and the stall check keep working; the wakes also ask the board what is owed (`owedBeforeTail`).
// ponytail: posts older than the tail drop out of the pane and the graph, and the coordinator is not reminded of an
// unread mention that old (the board's own UNREAD line on its next post still is); page through the file if that matters.
async function readBoard($: EngineInterface, dir: string): Promise<string> {
  const stat = await $.fs.stat(`${dir}/board.jsonl`).catch(() => undefined)
  if (stat && boardStat && boardStat.dir === dir && boardStat.size === stat.size && boardStat.mtimeMs === stat.mtimeMs) {
    return boardStat.content
  }
  let content: string
  if (stat && stat.size > 4_000_000) {
    const tail = await boardCommand($, dir, ['tail'])
    if (tail.exitCode !== 0 || tail.isStdoutTruncated) throw new Error('board tail failed')
    content = tail.stdout
  } else {
    try {
      content = await $.fs.read(`${dir}/board.jsonl`)
    } catch (error) {
      const tail = await boardCommand($, dir, ['tail'])
      if (tail.exitCode !== 0 || tail.isStdoutTruncated) throw error
      content = tail.stdout
    }
  }
  if (stat) boardStat = { dir, size: stat.size, mtimeMs: stat.mtimeMs, content }
  return content
}

/** The newest mention the board still owes each member a wake for: read off `wake` when only the board's tail was read. */
async function owedBeforeTail($: EngineInterface, dir: string): Promise<Map<string, number>> {
  const listed = await boardCommand($, dir, ['wake']).catch(() => undefined)
  const owedTo = new Map<string, number>()
  if (listed?.exitCode !== 0) return owedTo
  for (const [, name, seq] of listed.stdout.matchAll(/^@(\S+) \S+ through #(\d+)/gm)) owedTo.set(name!, Number(seq))
  return owedTo
}

async function reportOf($: EngineInterface, dir: string): Promise<Report | undefined> {
  try {
    const answer = await boardCommand($, dir, ['attention', '--json'])
    const report = JSON.parse(answer.stdout) as Report
    if (answer.exitCode !== 0 || !Array.isArray(report.items) || !report.members) return undefined

    return { ...report, items: report.items.map(item => ({ ...item, kind: clean(String(item.kind ?? '')), member: clean(String(item.member ?? '')), text: clean(String(item.text ?? '')) })) }
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


async function resolveRunDir($: EngineInterface, dir: string): Promise<string> {
  const cleanDir = dir.replace(/\/+$/, '')
  if (cleanDir.startsWith('/')) return normalizePath(cleanDir)
  const cwd = await $.session.cwd()
  return normalizePath(`${cwd}/${cleanDir}`)
}

const parseDescribedName = (desc: string | undefined) =>
  /^\s*@([A-Za-z][A-Za-z0-9_-]*):/.exec(desc ?? '')?.[1]?.toLowerCase()

// Binds the run this session saved, if any: at a start, and on the first poll after /clear or a resume.
async function restore($: EngineInterface, cwd: string): Promise<void> {
  const sEpoch = sessionEpoch
  try {
    const restored = await boardCommand($, `${cwd}/.swarm`, ['restore', await lookupKey($)])
    if (sEpoch !== sessionEpoch || isEnding) return
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


/**
 * What still runs inside a retired member's own worktree, whose folder carries the agent's id. A process started in
 * the shared folder is not found: nothing ties it to the member that started it.
 */
async function leftRunning($: EngineInterface, id: string, listing: string): Promise<{ pid: string; command: string }[]> {
  if (!/^[\w-]+$/.test(id)) return []
  const pids: string[] = []
  let pid = ''
  for (const line of listing.split('\n')) {
    if (line.startsWith('p')) pid = line.slice(1)
    // The folder itself or anything under it, and not another agent's whose id only starts alike.
    else if (line.startsWith('n') && /^\d+$/.test(pid) && (`${line}/`).includes(`/worktrees/agent-${id}/`)) pids.push(pid)
  }
  if (pids.length === 0) return []
  const named = await $.process.run(['ps', '-o', 'pid=,comm=', '-p', [...new Set(pids)].join(',')]).catch(() => undefined)
  return (named?.stdout ?? '').split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line)
    return match ? [{ pid: match[1]!, command: clean(match[2]!.split('/').pop() ?? '').slice(0, 40) }] : []
  }).slice(0, 12)
}

/**
 * Publishes `dir`'s roster as the owned run's guard state: the roster, the pause, the retired and paused members.
 * `owner` is the ownership generation the caller acted under: a run that took over meanwhile (resetMonitoring) keeps
 * its own state, so nothing is published. True when the roster was read and all of it published.
 */
async function syncOwnedState(
  $: EngineInterface,
  dir: string,
  loaded?: { closed?: boolean; paused?: string; members?: Roster } & BudgetState,
  agents?: AgentInfo[],
  owner = generation,
): Promise<boolean> {
  const sEpoch = sessionEpoch
  const isOwner = () => sEpoch === sessionEpoch && !isEnding && owner === generation
  // A roster the caller read some time before drops no owed notice.
  const read = loaded ? 0 : ++rosterReads
  const state = loaded ?? await $.fs.read(`${dir}/members.json`)
    .then(text => JSON.parse(text) as { closed?: boolean; paused?: string; members?: Roster } & BudgetState)
    .catch(() => undefined)
  if (!isOwner() || !state) return false
  const isClosed = state.closed === true
  const isSpent = budgetOf(state) > 0 && tokensUsed(state.usage?.tokens) >= budgetOf(state)
  halted = !isClosed && (state.paused || isSpent)
    ? { dir, why: state.paused ? `paused (${state.paused})` : 'over its token budget' }
    : undefined
  ownedRoster = state.members ? { dir, closed: isClosed, members: state.members } : undefined
  if (state.members) {
    const live = agents ?? await $.agent.list().catch(() => [])
    if (!isOwner()) return false
    const stops = rosterIds(state.members, live, read)
    // A retired member stays refused after the close, while its agent may still run; a budget pause ends with the run.
    retired = stops.retired
    memberPaused = isClosed ? new Set() : stops.memberPaused
  } else {
    retired = memberPaused = new Set()
  }
  return true
}

// Makes `dir` this conversation's run and offers its pane in the chat.
async function own($: EngineInterface, dir: string): Promise<void> {
  const sEpoch = sessionEpoch
  const current = await read($, run)
  if (sEpoch !== sessionEpoch || isEnding) return
  if (current !== dir) {
    resetMonitoring()
    strangers.clear()
  }
  const owner = generation
  closedRun = ''
  hadRun = true
  await update($, run, () => dir)
  if (sEpoch !== sessionEpoch || isEnding) return
  // A resumed conversation gets the row again, since placed rows are not saved; a closed run does not.
  const state = await $.fs.read(`${dir}/members.json`)
    .then(text => JSON.parse(text) as { closed?: boolean; paused?: string; members?: Roster } & BudgetState)
    .catch(() => undefined)
  if (sEpoch !== sessionEpoch || isEnding) return
  await syncOwnedState($, dir, state, undefined, owner)
  // Another run bound meanwhile: this one is no longer the conversation's to offer.
  if (sEpoch !== sessionEpoch || isEnding || owner !== generation) return
  const isClosed = state?.closed === true
  if (!isClosed) await $.ui.place({ id: openerOf(dir) }).catch(() => undefined)
  // The desktop app queues /swarm-board typed while the coordinator works, so a run opens its own pane once.
  if (!isClosed && opened !== dir && sEpoch === sessionEpoch && !isEnding) {
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

/** The checkout's HEAD commit, or '' when git cannot say: a read that fails changes nothing. */
const headOf = ($: EngineInterface, checkout: string) =>
  $.process.run(['git', '-C', checkout, 'rev-parse', 'HEAD'], { timeoutMs: 5000 })
    .then(answer => answer.exitCode === 0 && COMMIT_ID.test(answer.stdout.trim()) ? answer.stdout.trim() : '', () => '')

// What the coordinator is told when it makes a run. A run can be started from memory, with no /swarm:swarm in the
// turn and so none of the skill's current rules; and every wake re-reads the whole conversation, so a run started
// in a long one pays for that history each time.
async function initNotes($: EngineInterface): Promise<string[]> {
  const notes = [`Swarm: A run was made. If this turn did not start from /swarm:swarm, Read ${$.plugin.root}/skills/swarm/SKILL.md before going on: its rules are the current ones. Before you start a member, show the user the plan and name the token budget, or say that none is set.`]
  const held = await $.session.usage().then(usage => usage.context.tokens ?? 0).catch(() => 0)
  // The desktop app starts a conversation in a worktree of its own and lets its tools edit files only there.
  const cwd = await $.session.cwd().catch(() => '')
  const link = cwd ? await $.fs.read(`${cwd}/.git`).catch(() => '') : ''
  if (/^gitdir:.*\/worktrees\//.test(link.trim())) {
    notes.push(`Swarm: This conversation runs in a Git worktree of its own (${cwd}). The app can refuse a member's file edits outside that folder, and a member started with isolation: "worktree" works outside it. Before you start a writer with worktree isolation, tell the user: either the writers share this folder with owners that do not overlap, or the run is started from a conversation on the main checkout.`)
  }
  if (held >= LONG_CONVERSATION) {
    notes.push(`Swarm: This conversation already holds about ${compact(held)} tokens, and each time you are woken during the run all of them are read again. Before you start any member, tell the user that a fresh conversation, or /compact first, would make this run much cheaper, and ask whether to go on here.`)
  }
  return notes
}

/** A member's tool call as the guard reads it: plain values, read off the event once. */
type MemberCall = { agentId: string; tool: string; target: string; command: string; isBackground: boolean }
/**
 * What the owned run's roster says of a member's Edit, Write, NotebookEdit or Bash call: a refusal, or for a
 * shared-checkout writer's foreground command, the checkout whose HEAD is read before and after it.
 */
async function memberCall($: EngineInterface, call: MemberCall, activeDir: string, memberName: string, member: Roster[string], members: Roster):
  Promise<{ deny?: string; headWatch?: { checkout: string; name: string } }> {
  const { command } = call
  const isIsolated = member.isolated === '1' || isolatedAgents.has(call.agentId)
  const isShared = !isIsolated && (
    member.isolated === '0' ||
    sharedAgents.has(call.agentId) ||
    members.coordinator?.backend === 'native'
  )
  if (call.tool === 'Edit' || call.tool === 'Write' || call.tool === 'NotebookEdit') {
    const rawTarget = call.target
    const cwd = await $.session.cwd().catch(() => '')
    if (rawTarget && cwd) {
      const normCwd = normalizePath(cwd)
      const realCwd = await resolveRealPath($, normCwd)
      const absTarget = rawTarget.startsWith('/') ? normalizePath(rawTarget) : normalizePath(`${normCwd}/${rawTarget}`)
      const realTarget = await resolveRealPath($, absTarget)
      let rel = realTarget === realCwd
        ? ''
        : realTarget.startsWith(`${realCwd}/`)
          ? realTarget.slice(realCwd.length + 1)
          : undefined
      if (rel === undefined) {
        // A coordinator in a worktree of its own has the members' worktrees beside its folder, under
        // the main checkout: they are guarded there as they are under this one.
        const link = await $.fs.read(`${normCwd}/.git`).catch(() => '')
        const main = /^gitdir:\s*(.+)\/\.git\/worktrees\/[^/]+$/.exec(link.trim())?.[1]
        const realMain = main ? await resolveRealPath($, normalizePath(main)) : undefined
        if (realMain && realTarget.startsWith(`${realMain}/.claude/worktrees/`)) rel = realTarget.slice(realMain.length + 1)
      }
      // An isolated writer's paths= are relative to its own worktree, not to the shared checkout.
      const inWorktree = rel === undefined ? null : /^\.claude\/worktrees\/([^/]+)\/(.*)$/.exec(rel)
      let foreign: string | undefined
      if (inWorktree) {
        // Its own only: not a worktree at all for a member of the shared checkout, and not the one
        // whose folder carries another member's agent id.
        const folder = /^agent-(.+)$/.exec(inWorktree[1]!)?.[1]
        const owner = folder === undefined ? undefined
          : Object.entries(members).find(([name, other]) => name !== memberName && other.id === folder)?.[0]
        if (isShared || owner !== undefined) {
          foreign = `@${memberName} cannot edit inside ${owner ? `@${owner}'s` : "another member's"} worktree (.claude/worktrees/${inWorktree[1]}): ${isShared ? 'it works in the shared checkout' : 'an isolated member edits only its own'}.`
        }
        rel = inWorktree[2]!
      }
      if (rel !== undefined) {
        if (rel === '.swarm' || rel.startsWith('.swarm/')) {
          // A specialist has the board tool alone; a worker, a designer and a verifier have the board command as well.
          return { deny: `Direct edits inside .swarm/ are not allowed. ${SPECIALISTS.includes(member.profile ?? '') ? 'Use the board tool to read or post.' : 'Read and post with the board tool, or the board command (board.py) in Bash.'}` }
        }
        if (member.role === 'verifier' || member.writes === '0') {
          return { deny: `@${memberName} is read-only (${member.role === 'verifier' ? 'verifier' : 'writes=0'}), so it cannot edit files in the repository.` }
        }
        if (foreign) return { deny: foreign }
        for (const [otherName, other] of Object.entries(members)) {
          if (otherName === memberName || otherName === 'coordinator') continue
          // Exactly the members the board's claimed_twice ignores.
          if (other.role !== 'worker' || other.killed || other.writes === '0' || other.consult === '1' ||
              ['explorer', 'investigator', 'architect'].includes(other.profile ?? '')) continue
          const claimed = parsePaths(other.paths).find(p => pathCovers(p, rel))
          if (claimed) {
            return { deny: `Path "${rel}" is claimed by @${otherName} (paths=${claimed}), so @${memberName} cannot edit it.` }
          }
        }
        const ownPaths = parsePaths(member.paths)
        if (ownPaths.length > 0 && !ownPaths.some(p => pathCovers(p, rel))) {
          return { deny: `@${memberName} may only edit its claimed paths (${ownPaths.join(', ')}), not "${rel}".` }
        }
      }
    }
  } else if (call.tool === 'Bash') {
    const spoof = actsAsAnother(command, memberName, member)
    if (spoof) {
      return { deny: `The board refused this command: ${spoof}. Use the board tool, which acts as you, or the board command under your own name.` }
    }
    const checkout = activeDir.slice(0, activeDir.lastIndexOf('/.swarm/'))
    if (isShared && await commitsInSharedCheckout($, command, checkout)) {
      return { deny: `Shared-checkout writers must not run \`git commit\`: leave your edits in the working tree and report via \`BOARD ready ${memberName}\`.` }
    }
    // A commit the guard cannot read (a script, a tool that commits) still moves HEAD. A background
    // command ends after this call does, so there is no after to read.
    if (isShared && !call.isBackground) return { headWatch: { checkout, name: memberName } }
  }
  return {}
}

// Six members started at once ask for the same run at once: they share one answer.
const binding = new Map<string, Promise<boolean>>()
function bind($: EngineInterface, dir: string): Promise<boolean> {
  const pending = binding.get(dir) ?? bindOnce($, dir).finally(() => binding.delete(dir))
  binding.set(dir, pending)
  return pending
}

async function bindOnce($: EngineInterface, dir: string): Promise<boolean> {
  try {
    const sEpoch = sessionEpoch
    const canonical = await resolveRunDir($, dir)
    const saved = await boardCommand($, canonical, ['bind', await lookupKey($)])
    if (saved.exitCode !== 0) return false
    // The session ended while the board answered (/clear): the run is the old conversation's, not this one's.
    if (sEpoch !== sessionEpoch || isEnding) return false
    const out = saved.stdout.trim()
    const boundDir = RUN.test(out) ? out : canonical
    if (await read($, run) === boundDir) return true
    await own($, boundDir)
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
    const name = parseDescribedName(agent?.description)
    const starting = roster && memberNamed(roster, name)
    if (registered || (starting && (!starting.id || pendingStarts.has(`${active}/${name}`)) && !starting.killed && agent?.type === `swarm:${starting.profile || starting.role || 'worker'}`)) {
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

/** True when the coordinator of the run in `dir` is this session's main conversation: the run it drives or drove. */
async function drivesHere($: EngineInterface, dir: string): Promise<boolean> {
  return !browsed && dir !== '' && (dir === closedRun || dir === await read($, run))
}

// The agent's own transcript in the main view; the coordinator's is the main conversation.
/** Shows the member's conversation; false when there is none to show, with a toast saying why. */
async function viewAgent($: EngineInterface, member: Member | undefined): Promise<boolean> {
  if (member === undefined) return false
  // Taken before anything is awaited: what is read for one run is never shown under another the person moved to.
  const gen = browseGen
  const dir = (await shownSwarm($)).dir
  const isStale = async () => gen !== browseGen || (await shownSwarm($)).dir !== dir
  let agentId: string | undefined
  let messages: readonly SessionMessage[] | { deny: string }
  if (member.role === 'coordinator') {
    // The main conversation is the coordinator of the run it drives or drove only: another run's shows its posts.
    if (!(await drivesHere($, dir))) return false
    if (await isStale()) return true
    if (!(await $.ui.view({}).catch(() => ({ deny: 'no main view' }))).deny) return true
    // No main view to move: the pane shows the main conversation.
    agentId = ''
    messages = await $.session.messages().catch(() => ({ deny: 'its conversation could not be read' }))
  } else {
    const agent = findAgent(await $.agent.list().catch(() => []), member.id)
    if (await isStale()) return true
    if (agent && !(await $.ui.view({ agentId: agent.id }).catch(() => ({ deny: 'no main view' }))).deny) return true
    // No main view to move (the desktop app draws none) or no live agent: the pane shows what the session holds
    // of the conversation, which outlasts the agent. An ended teammate is read by its agent id, not its address.
    agentId = agent?.id ?? [...teammates].findLast(([, address]) => address === member.id)?.[0] ?? member.id
    messages = agentId === undefined
      ? { deny: 'no agent was started for it' }
      : await $.session.messages({ agentId }).catch(() => ({ deny: 'its conversation could not be read' }))
  }
  // The person moved to another run meanwhile: the answer is dropped, and nothing else is done in its place.
  if (await isStale()) return true
  if (agentId === undefined || !Array.isArray(messages)) {
    const why = Array.isArray(messages) ? '' : (messages as { deny: string }).deny.replace(/\.$/, '')
    $.ui.toast(`@${member.name}: ${why}. Showing its posts instead.`)
    return false
  }
  await stop($)
  if (await isStale()) return true
  talk = { dir, name: member.name, agentId, ...talkRows(messages as readonly SessionMessage[]), more: 0 }
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
  older: ReadonlyMap<string, number> = new Map(),
): Promise<{ pending: boolean; exhausted: string[]; relay: SpecialistWake[]; unaddressed: typeof unaddressed }> {
  const script = `${$.plugin.root}/skills/swarm/scripts/board.py`
  const results = { pending: false, exhausted: [] as string[], relay: [] as SpecialistWake[], unaddressed: [] as typeof unaddressed }
  const native = roster.coordinator?.backend === 'native'
  const toWake: { name: string; id: string; seq: number }[] = []
  for (const [name, member] of Object.entries(roster)) {
    if (epoch !== generation) break
    const id = member.id
    // A member paused on its own budget is woken by nobody, as the board's own wake list has it: its turn would be refused.
    if (member.killed || member.paused || member.role === 'coordinator') continue
    const from = Math.max(member.last_read_seq, member.last_nudged_seq ?? 0)
    // `older`: what the board itself says is owed, for a mention that lies before the tail read of a large board.
    const before = older.get(name) ?? 0
    const seq = posts.findLast(post => post.seq > from && post.to.includes(name))?.seq ?? (before > from ? before : undefined)
    if (!id) {
      if (seq !== undefined && SPECIALISTS.includes(member.profile ?? '')) results.unaddressed.push({ name, seq })
      continue
    }
    if (seq === undefined) {
      const told = member.told
      const agent = findAgent(agents, id)
      if (told && member.last_read_seq < told.seq && told.seq === member.last_nudged_seq && told.times < WAKE_ATTEMPTS &&
          now - told.at * 1000 >= QUIET_MS && (!agent || !['running', 'pending', 'waiting', 'killed'].includes(agent.status))) {
        // A fast turn can end before the send is acknowledged. Recover a missed rearm once its loop is idle.
        await boardCommand($, dir, ['rearm', '0', id]).catch(() => undefined)
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
      results.relay.push({ name, id, seq, attempts: claim?.attempts ?? 0, told: member.told?.times ?? 0, native })
      continue
    }
    toWake.push({ name, id, seq })
  }
  const CONCURRENCY = 4
  for (let i = 0; i < toWake.length; i += CONCURRENCY) {
    if (epoch !== generation) break
    const batch = toWake.slice(i, i + CONCURRENCY)
    await Promise.allSettled(batch.map(async ({ name, id, seq }) => {
      const reserved = await boardCommand($, dir, ['claim', name, id, String(seq)]).catch(() => undefined)
      if (epoch !== generation) return
      const token = reserved?.stdout.trim() ?? ''
      if (reserved?.exitCode !== 0 || !/^[a-f0-9]{32}$/.test(token)) return
      results.pending = true
      try {
        const text = `New board mentions through #${seq}. Run: python3 ${shellQuote(script)} ${shellQuote(dir)} read ${name}`
        const { isDelivered } = await $.session.send({ to: native ? teammateName(id) : { agentId: id }, text })
        if (isDelivered) await boardCommand($, dir, ['woke', name, String(seq), token])
      } catch {
        // The claim expires so an interrupted or failed send can be retried.
      }
    }))
  }
  return results
}

function unreadNotice($: EngineInterface, dir: string): string {
  const script = `${$.plugin.root}/skills/swarm/scripts/board.py`
  return `${counted(owed.count, 'board post')} ${owed.count === 1 ? 'addresses' : 'address'} you from #${owed.first} on and you have not read ${owed.count === 1 ? 'it' : 'them'}. ` +
    `Read ${owed.count === 1 ? 'it' : 'them'} before anything else: python3 ${shellQuote(script)} ${shellQuote(dir)} read coordinator`
}

function moodOf(full: Swarm, agents: AgentInfo[]): Mood {
  if (full.isClosed || full.isPaused) return 'sleep'
  const participants = new Set(full.members.filter(m => m.status === 'working' || m.status === 'coordinating')
    .map(m => m.role === 'coordinator' ? 'coordinator' : findAgent(agents, m.id)?.id ?? m.id))
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
  const sEpoch = sessionEpoch
  if (isRestoreOwed) {
    isRestoreOwed = false
    await restore($, await $.session.cwd().catch(() => ''))
    if (sEpoch !== sessionEpoch || isEnding) {
      isPolling = false
      // A refresh asked for during the restore belongs to the session that is live now.
      if (isRefreshOwed) {
        isRefreshOwed = false
        $.clock.after(0, () => void refresh($))
      }
      return
    }
  }
  const epoch = generation
  try {
    const now = await $.clock.now()
    const owned = await read($, run)
    let dir = owned
    if (dir === '') {
      // Another conversation's run is shown to someone looking at the pane, and read for nobody else: a session that
      // never used Swarm polls no run. The run this conversation drove until its close is still its own to follow.
      if (!isWatched && !closedRun) {
        if (epoch !== generation) return
        if ((await read($, swarm)).dir) await update($, swarm, () => EMPTY)
        seen = seenBoard = ''
        snapshot = undefined
        return
      }
      // Unwatched, only that closed run is followed: the project's newest may be another conversation's by now.
      if (!isWatched) dir = closedRun
    }
    if (dir === '') {
      // No run of this conversation's: show the project's newest, and only show it.
      const root = `${await $.session.cwd()}/.swarm`
      if (!(await $.fs.exists(`${root}/current`))) {
        if (epoch !== generation) return
        // A run browsed meanwhile keeps its conversation and replay: only the live run is gone.
        if (!browsed) closeTalk($)
        if ((await read($, swarm)).dir) {
          if (!browsed) await seek($, 0)
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
    // A run folder that was deleted or archived is no run: the pane says so instead of failing to load one forever.
    // Any other failure to read the roster is still an error.
    const roster = `${dir}/members.json`
    const rosterRead = ++rosterReads
    const rosterText = await $.fs.read(roster).catch(async error => {
      if (await $.fs.exists(roster).catch(() => true)) throw error
      return undefined
    })
    if (rosterText === undefined) {
      if (epoch !== generation) return
      if (owned) {
        // The run is gone, and what was known of it goes with it: nobody is refused or reminded in its name.
        resetMonitoring()
        agentRuns.clear()
        runEdge = { dir: '' }
        edgesAsked = ''
        strangers.clear()
        await update($, run, () => '')
      }
      if (!browsed) closeTalk($)
      if ((await read($, swarm)).dir) {
        if (!browsed) await seek($, 0)
        await update($, swarm, () => EMPTY)
      }
      seen = seenBoard = ''
      snapshot = undefined
      if (await read($, loadError)) await update($, loadError, () => '')
      return
    }
    const [board, agents] = await Promise.all([readBoard($, dir), $.agent.list()])
    if (epoch !== generation) return
    const state = JSON.parse(rosterText) as { members: Roster; paused?: string; closed?: boolean } & BudgetState
    const isSpent = budgetOf(state) > 0 && tokensUsed(state.usage?.tokens) >= budgetOf(state)
    // The run this conversation drove keeps its retired members refused after the close; budget pauses end with it.
    const drove = owned || (dir !== '' && dir === closedRun)
    const stops = drove ? rosterIds(state.members, agents, rosterRead) : undefined
    retired = stops?.retired ?? new Set()
    memberPaused = owned && !state.closed ? stops?.memberPaused ?? new Set() : new Set()
    // Read anew on every poll, so a resume or a raised budget lets the members' tools through again.
    halted = owned && !state.closed && (state.paused || isSpent)
      ? { dir, why: state.paused ? `paused (${state.paused})` : 'over its token budget' }
      : undefined
    if (drove) ownedRoster = { dir, closed: state.closed === true, members: state.members }
    else ownedRoster = undefined
    const agentStates = JSON.stringify(agents.map(a => [a.id, a.teammateId, a.status]))
    const progress = JSON.stringify([dir, board.length, agentStates, state.paused, state.closed,
      Object.entries(state.members).map(([name, m]) => [name, m.id, m.killed, m.last_read_seq, m.last_nudged_seq ?? 0, m.wake_claim?.attempts ?? 0, (m.wake_claim?.attempts ?? 0) >= WAKE_ATTEMPTS])])
    if (progress !== activity) {
      activity = progress
      quietSince = now
    }
    const coordinating = !!owned && isCoordinatorBusy && !state.closed && !state.paused
    const key = JSON.stringify([dir, rosterText, agentStates, coordinating])
    let full = snapshot
    if (!full || key !== seen || board !== seenBoard || (attentionRetry > 0 && now >= attentionRetry)) {
      if (rosterText !== seenRoster) {
        strangers.clear()
        seenRoster = rosterText
      }
      const report = await reportOf($, dir)
      if (epoch !== generation || isEnding) return
      attentionRetry = report ? 0 : now + 10_000
      full = parse(dir, board, rosterText, agents, Infinity, report, coordinating)
      full.mood = moodOf(full, agents)
      const next = { ...full, posts: full.posts.slice(-KEPT), earlierEdges: edgesOf(full.posts.slice(0, -KEPT)), attentionUnavailable: !report }
      const previous = await read($, swarm)
      if (epoch !== generation || isEnding) return
      const lastPost = previous.posts.at(-1)?.seq ?? 0
      if (previous.dir !== dir && !browsed) {
        closeTalk($)
        await seek($, 0)
        await update($, expanded, () => 0)
        await update($, diff, () => NO_DIFF)
        await update($, inspected, () => null)
        await update($, earlier, () => 0)
        await update($, query, () => '')
      } else if (!browsed && isPaneOpen && livePlayer === undefined && await read($, tab) === 'graph' && await read($, replay) === 0) {
        const firstNew = next.posts.find(post => post.seq > lastPost)
        if (firstNew) {
          await update($, livePulse, () => firstNew.seq)
          // The session may have ended or the pane closed while the pulse was stored: no timer is started behind them.
          if (epoch === generation && !isEnding && isPaneOpen && livePlayer === undefined) scheduleLiveFrame($)
          else if (livePlayer === undefined) await update($, livePulse, () => 0)
        }
      }
      if (epoch !== generation || isEnding) return
      await update($, swarm, () => next)
      seen = key
      seenBoard = board
      snapshot = full
    }
    if (owned) {
      const since = new Map<string, number>()
      for (const item of full.attention) {
        if (item.kind !== 'silent') continue
        const key = `${item.member}#${item.seq}`
        const first = silentSince.get(key) ?? now
        since.set(key, first)
        // A turn that ends and the wake that starts the next one can be a poll apart.
        if (!silentTold.has(key) && now - first >= SILENT_GRACE_MS) {
          silentTold.add(key)
          notesOwed.push(item.text)
        }
      }
      silentSince = since
    }
    if (epoch !== generation || isEnding) return
    const mood = moodOf(full, agents)
    if (full.mood !== mood) {
      await update($, swarm, prev => prev.dir === dir ? { ...prev, mood } : prev)
      full.mood = mood
    }
    if (await read($, loadError)) await update($, loadError, () => '')
    const unread = owned && !state.closed
      ? full.posts.filter(post => post.seq > Math.max(state.members.coordinator?.last_read_seq ?? 0, shownPosts.through) &&
        post.to.includes('coordinator') && !shownPosts.posts.has(post.seq))
      : []
    const last = unread.at(-1)?.seq ?? 0
    const firstPending = unread.find(post => post.seq > prompted)?.seq
    const since = firstPending !== undefined && owedSeqs.includes(firstPending) && owed.last > prompted
      ? owed.since : now
    owed = last === 0 ? NONE : { count: unread.length, first: unread[0]?.seq ?? last, last, since }
    owedSeqs = unread.map(post => post.seq)
    // A consultant's READY is the answer the coordinator asked for, and a READY that asks something is a question.
    isOwedRoutine = !full.attentionUnavailable && unread.length > 0 && unread.every(post => kindOf(post.text)?.label === 'READY' &&
      state.members[post.agent]?.consult !== '1' && !hasQuestion(post.text) &&
      !full.attention.some(item => item.kind === 'question' && item.seq === post.seq)) &&
      full.members.some(member => member.role !== 'coordinator' && member.status === 'working')
    if (owned) {
      const reason = state.closed ? '' : state.paused ?? ''
      if (reason === '') budgetPauseNotifiedFor = ''
      if (pauseSeen !== undefined && reason !== pauseSeen) {
        pauseOwed = pausing > 0 || pauseQuiet > 0 ? '' : reason
        if (pauseOwed.startsWith('token budget of ')) budgetPauseNotifiedFor = pauseOwed
      }
      pauseSeen = reason
      if (poll > pauseQuiet) pauseQuiet = 0
      // Mid-turn it rides on the coordinator's next tool result instead.
      if ((pauseOwed || memberPausesOwed.length > 0) && !isCoordinatorBusy && now >= noticeHold) {
        const what = pauseOwed ? `"${full.title}": ${reason}` : 'a member on its own token budget'
        const text = `Swarm: ${pauseOwed ? 'Run paused' : 'Member paused'}\n${[
          ...(pauseOwed ? [pauseNotice(full.title.replace(/\s+/g, ' '), pauseOwed)] : []), ...memberPausesOwed.map(owed => memberPauseNotice(owed.name))].join('\n\n')}`
        const unheard = () => $.ui.toast(`Swarm paused ${what}. The coordinator could not be told.`)
        pauseOwed = ''
        memberPausesOwed = []
        noticeHold = (await $.clock.now()) + NOTICE_HOLD_MS
        void $.prompt.submit({ text }).then(result => {
          if (epoch !== generation) return
          if (result.drop) { noticeHold = 0; unheard() }
        }).catch(() => {
          if (epoch !== generation) return
          noticeHold = 0
          unheard()
        })
      }
    }
    if (!owned || state.closed || state.paused || isSpent) {
      specialistWakes = []
      relayHinted = relayPrompted = ''
      return
    }
    if (epoch !== generation) return
    const { pending, exhausted, relay, unaddressed: unsent } = await deliver($, dir, state.members, full.posts, agents, now, epoch,
      (full.posts[0]?.seq ?? 1) > 1 ? await owedBeforeTail($, dir) : undefined)
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
    const answerThrough = owed.last > prompted && (askRelay || now - owed.since >= (isOwedRoutine ? ROUTINE_GRACE_MS : MENTION_GRACE_MS)) ? owed.last : 0
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
      noticeHold = (await $.clock.now()) + NOTICE_HOLD_MS
      void $.prompt.submit({ text: `Swarm: ${heading}\nRun: ${full.title.replace(/\s+/g, ' ')}\n${notices.join('\n\n')}` })
        .then(result => {
          if (epoch !== generation) return
          noticeFailures = noticeRetry = 0
          // An explicit drop can mean the user stopped the session. Leave the notice on the board.
          if (result.drop) {
            noticeHold = 0
            if (askRelay && relayHinted === keyToRelay) relayHinted = told.relayHinted
            if (answerThrough && hinted === answerThrough) hinted = told.hinted
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
    try {
      if (epoch === generation && !isEnding && !(await read($, loadError))) {
        await update($, loadError, () => 'Swarm could not read the board. It will retry automatically.')
      }
    } catch {
      // Ignore store errors during teardown.
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
async function account($: EngineInterface, report: string, agentId: string | undefined, amount: number, at?: string): Promise<boolean> {
  if (!Number.isSafeInteger(amount) || amount <= 0 || (agentId && strangers.has(agentId) && !agentRuns.has(agentId))) return false

  const agent = agentId ? await $.agent.list().then(agents => agents.find(one => one.id === agentId)).catch(() => undefined) : undefined
  const address = agentId && (teammateOf($, agentId, agent) ?? agentId)
  // AT is the run the coordinator drove when it spent this: a charge that waits is not another run's by the time it lands.
  const dir = agentId ? await agentRun($, agentId, agent) : at || await read($, run)
  if (!dir) return false
  // A closed run is charged nothing more and is no longer this conversation's run: what the coordinator does next is not its work.
  const isClosed = await $.fs.read(`${dir}/members.json`)
    .then(text => (JSON.parse(text) as { closed?: boolean }).closed === true).catch(() => false)
  if (isClosed) {
    if (dir === await read($, run)) {
      closedRun = dir
      resetMonitoring()
      // Read under this generation: a run bound while the roster is read keeps its own guard state.
      const owner = generation
      await update($, run, () => '')
      // Its members are still refused by name: a retired one, a commit, an edit outside its paths.
      await syncOwnedState($, dir, undefined, undefined, owner).catch(() => undefined)
    }
    return true
  }
  const [turn, actor] = await Promise.all([
    digest(`swarm-turn:${report}`),
    address ? digest(`swarm-agent:${address}`) : Promise.resolve('coordinator'),
  ])
  const result = await boardCommand($, dir, ['account', turn, actor, String(amount)])
  if (result.exitCode !== 0 || result.stdout.trim() === '') return false
  const entry = JSON.parse(result.stdout) as { title: string; total: number; budget: number; paused: boolean; member_paused?: unknown }
  const pausedName = typeof entry.member_paused === 'string' ? entry.member_paused : ''
  if (pausedName && dir === await read($, run)) {
    // Known at once, as a run's pause is: the member this turn charged is refused from its next tool call on.
    const id = ownedRoster?.dir === dir ? memberNamed(ownedRoster.members, pausedName)?.id : undefined
    memberPaused = new Set([...memberPaused, ...(id ? [id] : []), ...(agentId && (!id || id === address) ? [agentId] : [])])
    if (!memberPausesTold.has(pausedName)) {
      memberPausesTold.add(pausedName)
      memberPausesOwed.push({ name: pausedName, read: rosterReads })
    }
  }
  if (!entry.paused || dir !== await read($, run)) return true
  const reason = `token budget of ${compact(entry.budget)} spent`
  const rawReason = `token budget of ${entry.budget} spent`
  const isTold = budgetPauseNotifiedFor === rawReason || budgetPauseNotifiedFor === reason
  budgetPauseNotifiedFor = rawReason
  pauseSeen = rawReason
  pauseExpected()
  // Known at once, not a poll later: the members' next tool calls are refused from here.
  halted = { dir, why: `paused (${reason})` }
  // The board reports the crossing once. A prompt that does not land would leave the run paused with nobody told.
  const unheard = () => $.ui.toast(`Swarm paused "${entry.title}": its token budget of ${compact(entry.budget)} is spent, and the coordinator could not be told. Raise the budget or close the run.`)
  if (isTold) return true
  noticeHold = (await $.clock.now()) + NOTICE_HOLD_MS
  void $.prompt.submit({
    text: `Swarm: Run paused at token budget\n${entry.title} spent ${compact(entry.total)} tokens and reached its budget of ${compact(entry.budget)}. Tell the user what is done and ask whether to raise the budget with limit and then resume, or close the run.`,
  }).then(result => { if (result.drop) { noticeHold = 0; unheard() } }).catch(() => { noticeHold = 0; unheard() })
  return true
}

// A member of a paused or spent run is refused its next tool call, so a turn in flight ends there instead of
// spending on. The coordinator is never refused: it has to report, raise the budget and resume.
const MEMBER_PAUSED = 'This Swarm member has spent its own token budget, so this tool call was not run. Make no more tool calls: end your turn now with one line saying where you stopped. The coordinator decides whether you go on.'
/** The refusal the roster alone settles, with no lookup that can fail: a retired member, or one paused on its own budget. */
function stoppedMember(agentId: string): string | undefined {
  const address = teammates.get(agentId)
  const has = (ids: ReadonlySet<string>) => ids.has(agentId) || (address !== undefined && ids.has(address))
  // A member that was replaced or removed may still be mid-turn: it builds and edits beside the team that took over.
  if (has(retired)) return 'This Swarm member has been retired, so this tool call was not run. Make no more tool calls: end your turn now with one line saying where you stopped.'
  if (has(memberPaused)) return MEMBER_PAUSED
  return undefined
}

const OVER = 'This Swarm run is over and its conversation drives another run now, so this tool call was not run. Make no more tool calls: end your turn now with one line saying where you stopped.'
async function refusal($: EngineInterface, agentId: string | undefined): Promise<string | undefined> {
  if (agentId === undefined) return undefined
  const stopped = stoppedMember(agentId)
  if (stopped) return stopped
  // The run this conversation drives, or drove until its close: closing it makes no earlier run's agents welcome.
  const active = (await read($, run).catch(() => '')) || closedRun
  if (!halted && !active) return undefined
  try {
    // The run the agent belongs to, as the board has it: one this conversation drove before the run it drives now
    // has nobody left to guard its agents, whatever tool they call. Asked of the board once per agent, so a resume,
    // which forgets the runs driven before, forgets none of this.
    const dir = agentRuns.get(agentId) ?? (strangers.has(agentId) ? '' :
      await agentRun($, agentId, (await $.agent.list()).find(one => one.id === agentId)))
    if (dir && active && dir !== active) return OVER
    if (dir !== halted?.dir) return undefined
    return `This Swarm run is ${halted.why}, so this tool call was not run. Make no more tool calls: end your turn now with one line saying where you stopped. The coordinator decides what happens when the run resumes.`
  } catch {
    return undefined // a check that failed stops nobody's tools
  }
}

/** A command that may pause or resume the run: the coordinator's own doing, which it reads in the output, so not news to tell it. */
async function pauseAware<T>($: EngineInterface, calls: ParsedBoardCall[], agentId: string | undefined, command: () => Promise<T>): Promise<T> {
  const mayPause = agentId === undefined && calls.some(c => c.action === 'pause' || c.action === 'resume' || c.action === 'limit')
  if (mayPause) pausing++
  try {
    return await command()
  } finally {
    if (mayPause) {
      pausing--
      pauseExpected()
      $.clock.after(0, () => void refresh($))
    }
  }
}

/** After a coordinator's tool call: what its board commands read of the posts owed it, and the notes it is owed. */
async function coordinatorNotes<R extends ToolCallResult>($: EngineInterface, calls: ParsedBoardCall[], isRelay: boolean, raw: ToolCallResult, result: R, isCut = false): Promise<R> {
  if (raw.deny !== undefined || raw.isError !== undefined) return result
  try {
    const dir = await read($, run)
    // Only a real read of this run's board answers its mentions: the words alone may sit in a commit message.
    // A page cut short (`isCut`) printed only part of them, so it answers none.
    for (const c of isCut ? [] : calls) {
      if (c.action === 'read' && COORDINATOR_READ.test(c.rest)) {
        const calledDir = RUN.test(c.dir) ? await resolveRunDir($, c.dir) : c.dir
        if (calledDir === dir) {
          owed = NONE
          break
        }
      }
    }
    for (const c of isCut ? [] : calls) {
      if (c.action !== 'show' || c.piped || !RUN.test(c.dir) || await resolveRunDir($, c.dir) !== dir) continue
      // One post, the whole board, or one member's posts: only what was printed counts as seen.
      const one = /--post=(\d+)/.exec(c.rest)
      // The member named, if any: a flag or a redirection (`show 2>&1`) names none.
      const who = c.subarg?.startsWith('-') ? undefined : c.subarg
      if (one) shownPosts.posts.add(Number(one[1]))
      else if (who === undefined) shownPosts.through = Math.max(shownPosts.through, snapshot?.posts.at(-1)?.seq ?? 0)
      else for (const post of snapshot?.posts ?? []) if (post.agent === who || post.to.includes(who)) shownPosts.posts.add(post.seq)
      owedSeqs = owedSeqs.filter(seq => seq > shownPosts.through && !shownPosts.posts.has(seq))
      owed = owedSeqs.length === 0 ? NONE : { ...owed, count: owedSeqs.length, first: owedSeqs[0]!, last: owedSeqs.at(-1)! }
    }
    const notices: string[] = []
    const key = relayKey(dir)
    if (key && key !== relayHinted && !isRelay) {
      relayHinted = key
      notices.push(relayNotice())
    }
    // A read of the board is never told to read it, however it named the run (a shell variable, a relative path),
    // and neither is a page of it: the page itself says what remains.
    if (dir && owed.last > hinted && !isCut && !calls.some(c => c.action === 'read' && COORDINATOR_READ.test(c.rest))) {
      hinted = owed.last
      notices.push(`Swarm: ${unreadNotice($, dir)}`)
    }
    if (dir && pauseOwed) {
      notices.push(`Swarm: ${pauseNotice('This run', pauseOwed)}`)
      pauseOwed = ''
    }
    if (dir && memberPausesOwed.length > 0) {
      notices.push(...memberPausesOwed.map(owed => `Swarm: ${memberPauseNotice(owed.name)}`))
      memberPausesOwed = []
    }
    if (dir && notesOwed.length > 0) {
      notices.push(...notesOwed.map(text => `Swarm: ${text}`))
      notesOwed = []
    }
    if (notices.length > 0 && result.deny === undefined) result = { ...result, context: [...(result.context ?? []), ...notices] }
  } catch {
    // A failed reminder must not change the tool's result.
  }
  return result
}

/** What board commands change here, typed in Bash or made through the board tool: the run they bind, the roster they sync. */
async function boardCallsRan<R extends ToolCallResult>($: EngineInterface, agentId: string | undefined, calls: ParsedBoardCall[], stdout: string, result: R): Promise<R> {
  if (result.isError || result.deny || calls.length === 0) return result
  try {
    if (agentId === undefined && calls.some(c => c.action === 'member' || c.action === 'started' || c.action === 'replace')) {
      strangers.clear()
    }
    for (const c of calls) {
      // `init` names the folder to make the run under and prints the run folder it made.
      const rawDir = c.action === 'init' && agentId === undefined
        ? stdout.split('\n').map(line => line.trim()).findLast(line => RUN.test(line)) ?? ''
        : c.dir
      const isReadCoord = c.action === 'read' && COORDINATOR_READ.test(c.rest)
      // A read whose run could not be read off the command still changed what is owed: the roster is read again now.
      if (isReadCoord && agentId === undefined && !RUN.test(rawDir)) $.clock.after(0, () => void refresh($))
      if (!RUN.test(rawDir)) continue
      const dir = await resolveRunDir($, rawDir)
      const owned = await read($, run)
      // The coordinator's own planning shows whose run it is as surely as its first read, which it may skip: the
      // run is bound from `init` on, so that planning is charged to it. `plan` only reads, so it claims a run only
      // while none is owned. The board refuses a run another conversation owns.
      const claims = isReadCoord || c.action === 'init' || c.action === 'member' || (c.action === 'plan' && owned === '')
      // One that could not be bound is said so: the pane, the wakes and the budget would quietly follow nothing.
      if (agentId === undefined && claims && dir !== owned && !(await bind($, dir)) && result.deny === undefined) {
        result = { ...result, context: [...(result.context ?? []), `Swarm: ${dir} could not be bound to this conversation (another conversation may own it, or the board did not answer), so the pane, the wakes and the budget do not follow it. Run its read coordinator command again, or tell the user.`] }
      }
      // The roster may now record an agent that was looked up before it was on it.
      if (agentId === undefined) strangers.clear()
      if (dir === owned || agentId === undefined) $.clock.after(0, () => void refresh($))
    }
    if (agentId === undefined && calls.some(c => ['member', 'replace', 'pause', 'resume', 'limit', 'close'].includes(c.action))) {
      // Only the run this conversation owns: another run's pause and roster are not this session's to enforce.
      const resolvedSyncDir = await read($, run)
      if (resolvedSyncDir) {
        await syncOwnedState($, resolvedSyncDir).catch(() => undefined)
        const retiredNames = calls
          .filter(c => c.action === 'replace' || (c.action === 'member' && /\bkilled=(["']?)1\1(?=\s|$)/.test(c.rest)))
          .map(c => c.subarg?.trim())
          .filter((n): n is string => Boolean(n))
        if (retiredNames.length > 0 && ownedRoster && ownedRoster.dir === resolvedSyncDir && !ownedRoster.closed) {
          const liveAgents = await $.agent.list().catch(() => [])
          const zombieNotices: string[] = []
          // Every process's working folder, read once for the command however many members it retires. lsof exits 1
          // when it could not read every process and still lists the rest; -b keeps it off a mount that does not answer.
          const listing = await $.process.run(['lsof', '-b', '-w', '-a', '-d', 'cwd', '-Fpn'], { timeoutMs: 5000 })
            .then(listed => listed.stdout, () => '')
          const replaced = new Set(calls.filter(c => c.action === 'replace').map(c => c.subarg?.trim()))
          for (const oldName of retiredNames) {
            const entry = memberNamed(ownedRoster.members, oldName)
            const live = entry?.killed && entry.id ? findAgent(liveAgents, entry.id) : undefined
            if (live && ['running', 'pending', 'waiting'].includes(live.status)) {
              zombieNotices.push(`Swarm: @${oldName} was retired, but agent ${live.id} is still ${live.status}. Stop it before spawning a successor.`)
            }
            // Refusing its tools stops the agent, not a build it had already launched.
            const left = entry?.killed && entry.id ? await leftRunning($, entry.id, listing) : []
            if (left.length > 0) {
              zombieNotices.push(`Swarm: @${oldName} was retired, but ${left.length} process${left.length === 1 ? '' : 'es'} it started ${left.length === 1 ? 'is' : 'are'} still running in its worktree: ${left.map(one => `${one.pid} (${one.command})`).join(', ')}. Unless the user wants ${left.length === 1 ? 'it' : 'them'} to finish, stop ${left.length === 1 ? 'it' : 'them'}: kill ${left.map(one => one.pid).join(' ')}`)
            } else if (replaced.has(oldName) && entry?.killed && entry.id && entry.isolated !== '1' &&
                entry.role === 'worker' && entry.writes !== '0' && !['explorer', 'investigator', 'architect'].includes(entry.profile ?? '')) {
              zombieNotices.push(`Swarm: @${oldName} was retired. A build or test it started in the shared folder cannot be told from the team's own, so nothing was checked: look for one before its successor builds.`)
            }
          }
          if (zombieNotices.length > 0 && result.deny === undefined) {
            result = { ...result, context: [...(result.context ?? []), ...zombieNotices] }
          }
        }
      }
    }
    // Every wake of the coordinator re-reads its whole conversation, so a run started in a long one pays for
    // that history on each of them. Said once, when the run is made, while starting elsewhere is still cheap.
    if (agentId === undefined && calls.some(c => c.action === 'init') && result.deny === undefined && result.isError === undefined) {
      result = { ...result, context: [...(result.context ?? []), ...await initNotes($)] }
    }
  } catch (error) {
    // A failure here leaves the command's own result as it was, and says what was not followed up.
    if (agentId === undefined && result.deny === undefined) {
      result = { ...result, context: [...(result.context ?? []), `Swarm could not follow up this board command (${error instanceof Error ? error.message : String(error)}): the pane and the roster guards catch up on the next poll.`] }
    }
  }
  return result
}

/** Runs board commands for the owned run straight from a pane button, with no coordinator turn; the first that fails is told. */
async function control($: EngineInterface, dir: string, ...steps: string[][]): Promise<void> {
  if (dir === '' || dir !== await read($, run)) return
  const mayPause = steps.some(args => args[0] === 'pause' || args[0] === 'resume' || args[0] === 'limit')
  if (mayPause) pausing++  // what the person does from the pane is not news to tell the coordinator
  try {
    for (const args of steps) {
      const result = await boardCommand($, dir, args).catch(error => ({ exitCode: 1, stderr: String(error) }))
      if (result.exitCode !== 0) {
        $.ui.toast(`Swarm: ${clean(result.stderr).trim() || `the board's ${args[0]} command failed`}`)
        break
      }
    }
  } finally {
    if (mayPause) {
      pausing--
      pauseExpected()
    }
  }
  await refresh($)
}

async function resetView($: EngineInterface): Promise<void> {
  talk = undefined
  await seek($, 0)
  await update($, expanded, () => 0)
  await update($, diff, () => NO_DIFF)
  await update($, inspected, () => null)
  await update($, earlier, () => 0)
  await update($, query, () => '')
  $.ui.invalidate('ui.render')
}

/** Reads a run looked at through the switcher, once: a board or attention report that cannot be read is said to be so. */
async function readRun($: EngineInterface, dir: string, roster: string, isClosed: boolean): Promise<NonNullable<typeof browsed>> {
  let boardUnavailable = false
  const [board, report] = await Promise.all([readBoard($, dir).catch(() => {
    boardUnavailable = true
    return ''
  }), reportOf($, dir)])
  const agents = isClosed ? [] : await $.agent.list().catch(() => [])
  return { ...parse(dir, board, roster, agents, KEPT, report), mood: 'sleep', attentionUnavailable: !report, boardUnavailable }
}

/** Reads the browsed run again in place: the tab, the open post and the scroll stay as they are. */
async function reloadBrowsed($: EngineInterface): Promise<void> {
  const dir = browsed?.dir
  if (dir === undefined) return
  const gen = ++browseGen
  try {
    const roster = await $.fs.read(`${dir}/members.json`)
    const next = await readRun($, dir, roster, (JSON.parse(roster) as { closed?: boolean } | null)?.closed === true)
    if (gen !== browseGen || browsed?.dir !== dir) return
    browsed = next
    $.ui.invalidate('ui.render')
  } catch {
    if (gen === browseGen) $.ui.toast('Swarm could not read this run again.')
  }
}

/** The project's run folders, newest first as the board orders them: `archive` and stray folders carry no run's name. */
async function runNames($: EngineInterface, root: string): Promise<string[]> {
  const stamp = (name: string) => name.replace(/x*$/, '').slice(-15)
  return (await $.fs.list(root))
    .filter(entry => entry.kind === 'dir' && RUN.test(`/.swarm/${entry.name}`)).map(entry => entry.name)
    .sort((a, b) => stamp(b).localeCompare(stamp(a)) || b.localeCompare(a))
}
/**
 * The first run in `names` from `index` on, stepping by `by`. The live run is one; a folder without a roster, or with
 * one that cannot be read, is not, and is stepped over: one broken folder does not end the walk to the others.
 */
async function runFromAt($: EngineInterface, root: string, names: string[], liveDir: string, index: number, by: 1 | -1) {
  for (; index >= 0 && index < names.length; index += by) {
    const dir = `${root}/${names[index]}`
    if (dir === liveDir) return { index, dir }
    const roster = await $.fs.read(`${dir}/members.json`).catch(() => undefined)
    if (roster === undefined) continue
    try {
      // What board.py asks of a roster before it reads one: a folder holding less is no run to show.
      const state = JSON.parse(roster) as { closed?: boolean; title?: unknown; members?: { coordinator?: unknown } } | null
      if (typeof state?.title !== 'string' || typeof state.members?.coordinator !== 'object' || state.members.coordinator === null) continue
      return { index, dir, roster, isClosed: state.closed === true }
    } catch {
      continue
    }
  }
  return undefined
}

// The run whose neighbours are being read for the run row, or were read and could not be: read once per run shown.
let edgesAsked = ''
/** Reads whether the shown run has an older and a newer run beside it, so the run row draws an end as no control. */
async function learnEdges($: EngineInterface, dir: string): Promise<void> {
  if (edgesAsked === dir || (runEdge.dir === dir && runEdge.older !== undefined && runEdge.newer !== undefined)) return
  edgesAsked = dir
  try {
    const root = `${await $.session.cwd()}/.swarm`
    const names = await runNames($, root)
    const liveDir = (await read($, swarm)).dir
    const at = names.indexOf(dir.slice(root.length + 1))
    if (at < 0) return
    const older = await runFromAt($, root, names, liveDir, at + 1, 1) !== undefined
    const newer = await runFromAt($, root, names, liveDir, at - 1, -1) !== undefined
    // Only for the run still shown, and never over what a step through the runs learned meanwhile.
    if ((await shownSwarm($)).dir !== dir || (runEdge.dir === dir && runEdge.older !== undefined)) return
    runEdge = { dir, older, newer }
    $.ui.invalidate('ui.render')
  } catch {
    // The row keeps its steps as controls: a press reads the list again, and says so if it finds nothing.
  }
}

/** Steps the pane to the project's next older (1) or newer (-1) run, or back to the live one (0). */
async function browse($: EngineInterface, step: 1 | 0 | -1): Promise<void> {
  const gen = ++browseGen
  try {
    const live = await read($, swarm)
    if (gen !== browseGen) return
    const root = `${await $.session.cwd()}/.swarm`
    if (gen !== browseGen) return
    const names = step === 0 ? [] : await runNames($, root)
    if (gen !== browseGen) return
    const shownDir = (browsed ?? live).dir
    const at = names.indexOf(shownDir.slice(root.length + 1))
    const runFrom = (index: number, by: 1 | -1) => runFromAt($, root, names, live.dir, index, by)
    if (step !== 0) {
      const found = await runFrom(at + step, step)
      if (gen !== browseGen) return
      if (!found) {
        runEdge = { ...(runEdge.dir === shownDir ? runEdge : {}), dir: shownDir, [step > 0 ? 'older' : 'newer']: false }
        $.ui.toast(step > 0 ? 'No earlier run in this project.' : 'No later run in this project.')
        $.ui.invalidate('ui.render')
        return
      }
      // Whether a run lies further that way is read now, so the end of the history is drawn as no control.
      const further = await runFrom(found.index + step, step) !== undefined
      if (gen !== browseGen) return
      runEdge = { dir: found.dir, ...(step > 0 ? { older: further, newer: true } : { older: true, newer: further }) }
      if (found.roster !== undefined) {
        const next = await readRun($, found.dir, found.roster, found.isClosed)
        if (gen !== browseGen) return
        browsed = next
        await stopLive($)
        await resetView($)
        return
      }
    }
    if (!browsed) {
      $.ui.invalidate('ui.render')
      return
    }
    browsed = undefined
    await resetView($)
  } catch {
    if (gen === browseGen) $.ui.toast('Swarm could not read this project\'s runs.')
  }
}

// What one board tool answer may hold: the `read` page, and the cut `show` gets.
const PAGE = 48000
/** What the board tool takes: a member's fields, then the ones only the coordinator's actions take. */
type BoardInput = {
  agentId?: string
  action: string
  member?: string
  seq?: number
  text?: string
  commit?: string
  title?: string
  name?: string
  newName?: string
  options?: string[]
  out?: string
}
const BOARD_FIELDS = ['member', 'seq', 'text', 'commit', 'title', 'name', 'newName', 'options', 'out'] as const
// What answers without changing the board: the hive shows its caller inspecting.
const BOARD_READS = ['read', 'show', 'status', 'plan', 'attention']
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

/** A show's arguments from its `member` filter or `seq`, taken as a member would write them; a deny for any other use of the two. */
function showArgs(e: BoardInput): string[] | { deny: string } {
  // A name as a member would write it: with its @, in any case.
  const rawMember = typeof e.member === 'string' ? e.member.trim() : ''
  const who = rawMember ? rawMember.replace(/^@/, '').toLowerCase() : undefined
  if (who !== undefined && (e.action !== 'show' || !/^[a-z][a-z0-9_-]*$/.test(who))) {
    return { deny: e.action === 'show' ? 'The member filter is a member\'s name, such as "parser".' : 'A member filter is only valid for show.' }
  }
  if (e.seq !== undefined && (e.action !== 'show' || who !== undefined || !Number.isSafeInteger(e.seq) || e.seq < 1)) {
    return { deny: 'Use a positive post number with show, without a member filter.' }
  }
  return who ? ['show', who] : e.seq ? ['show', `--post=${e.seq}`] : ['show']
}

// A member acts on the run it was started for, as itself: its own reads and reports, never another's or the run's setup.
async function memberBoard($: EngineInterface, e: BoardInput & { agentId: string }) {
  const agents = await $.agent.list()
  const agent = findAgent(agents, e.agentId)
  if (!agent || !SWARM_AGENTS.has(agent.type)) {
    return { deny: await read($, run) ? 'The Swarm board tool requires a Swarm member agent.' : NO_RUN_BOARD }
  }
  const describedName = parseDescribedName(agent?.description)
  let dir = await agentRun($, e.agentId, agent)
  let needsBinding = false
  // Whether any run could be this agent's: one this conversation drives, or one the board found for its name.
  let isRunNear = false
  // No run yet, or this agent belongs to a newer run than the one the conversation last owned.
  if (!dir) {
    let adopted = await adopt($, describedName)
    isRunNear = adopted !== '' || Boolean(await read($, run))
    if (adopted === UNREGISTERED || adopted === WRONG_RUN) adopted = ''
    if (adopted === AMBIGUOUS) {
      return { deny: `The board refused this call: more than one open Swarm run in this project has a member @${describedName} and none is bound to the conversation that started you. End your turn and report this sentence to the coordinator: it must run its board's "read coordinator" command written out in full (python3 <board.py> <run folder> read coordinator), then message you to retry.` }
    }
    dir = adopted || dir
    needsBinding = Boolean(adopted)
  }
  if (!dir && !isRunNear) return { deny: NO_RUN_BOARD }
  if (!dir) {
    return { deny: 'No Swarm run is bound to the conversation that started you, so the board cannot tell which run you belong to. End your turn and report this to the coordinator: it must register you with the board\'s member command, start you with a description that begins "@<your name>: ", and then send you a message to retry.' }
  }

  const state = JSON.parse(await $.fs.read(`${dir}/members.json`)) as {
    members: Roster
    closed?: boolean
    paused?: string
  } & BudgetState
  const { members, closed, paused } = state
  const assigned = Object.entries(members).find(([, member]) =>
    member.id !== undefined && (member.id === e.agentId || member.id === agent?.teammateId),
  )
  // The first read may arrive before the coordinator records the returned address.
  const starting = memberNamed(members, describedName)
  const uniqueStarter = starting && !starting.id && describedName !== undefined &&
    agents.filter(candidate =>
      candidate.type === agent?.type &&
      !['killed', 'failed', 'completed'].includes(candidate.status) &&
      parseDescribedName(candidate.description) === describedName,
    ).length === 1
  const assignment = assigned ?? (uniqueStarter && describedName ? [describedName, starting] as const : undefined)
  const member = assignment?.[1]
  const kind = agent?.type.slice('swarm:'.length) ?? ''
  // The type the roster gives it, as the spawn hook reads it.
  const registered = member ? member.profile || member.role || 'worker' : ''
  const fault = !assignment || !member
    ? `the roster has no member for this agent. It must be registered under the name its description starts with ("@<name>: ")`
    : member.killed
      ? `@${assignment[0]} was removed from the run`
      : SPECIALISTS.includes(kind)
        ? member.role !== 'worker' || member.writes !== '0' || member.profile !== kind
          ? `@${assignment[0]} is not registered as a read-only ${kind}. The coordinator fixes it with: member ${assignment[0]} profile=${kind} writes=0`
          : ''
        : registered !== kind || member.role === 'coordinator'
          ? `the roster has @${assignment[0]} as ${registered}, but this agent is a ${kind}. The coordinator fixes the roster with its member command`
          : ''
  if (!assignment || !member || fault) {
    return { deny: `The board refused this call: ${fault}. End your turn and report this sentence to the coordinator.` }
  }
  if (needsBinding && !(await bind($, dir))) return { deny: 'The Swarm run could not be bound to this conversation.' }

  const [name] = assignment
  agentRuns.set(e.agentId, dir)
  const isSpent = budgetOf(state) > 0 && tokensUsed(state.usage?.tokens) >= budgetOf(state)
  if (!closed && (paused || isSpent)) {
    const why = paused ? `paused (${paused})` : 'over its token budget'
    if (dir === await read($, run)) halted = { dir, why }
    return { deny: `This Swarm run is ${why}, so this tool call was not run. Make no more tool calls: end your turn now with one line saying where you stopped. The coordinator decides what happens when the run resumes.` }
  }
  if (!closed && member.paused) return { deny: MEMBER_PAUSED }
  const { action } = e
  const setup = (['title', 'name', 'newName', 'options', 'out'] as const).filter(field => e[field] !== undefined)
  if (setup.length > 0) return { deny: `${setup.join(', ')} ${setup.length === 1 ? 'belongs' : 'belong'} to the coordinator's actions: a member acts as itself, on its own posts.` }
  const shown = showArgs(e)
  if ('deny' in shown) return shown
  // A verifier's verdict is a post: readiness is a worker's to record and withdraw.
  if (!['read', 'show', 'status', 'post', ...(member.role === 'verifier' ? [] : ['ready', 'revise'])].includes(action)) {
    return { deny: member.role === 'verifier' && (action === 'ready' || action === 'revise') ? 'A verifier reports with action "post": VERIFIED, NOT PASSED or NOT VERIFIED.' : 'Unknown board action.' }
  }
  // The board resolves HEAD in the checkout it runs in, which is not the member's own: only a full id is taken here.
  if (e.commit !== undefined && (action !== 'ready' || !COMMIT_ID.test(e.commit))) {
    return { deny: action === 'ready' ? 'commit is a full 40- or 64-character commit id. HEAD is read only by the board command run from your own checkout: BOARD ready <your name> HEAD' : 'A commit is only valid for ready.' }
  }

  const text = typeof e.text === 'string' ? e.text.trim() : ''
  const writesPost = action === 'post' || action === 'ready' || action === 'revise'
  if (writesPost && (closed || !text || text.length > 12000)) {
    return { deny: 'Use a nonempty report of at most 12,000 characters on an open run.' }
  }
  const args = action === 'show' ? shown : action === 'status' ? [action] : [action, name]
  if (action === 'read') args.push(`--max-bytes=${PAGE}`)
  if (action === 'revise') args.push(text)
  if (action === 'ready' && e.commit) args.push(e.commit)
  return boardAnswer($, dir, args, action === 'post' || action === 'ready' ? text : undefined, e)
}

// What each of the coordinator's actions needs and may take, beside its action; board.py checks the values.
const COORDINATOR_TAKES: Record<string, [needs: string[], may: string[]]> = {
  init: [['name', 'title'], []], member: [['name'], ['options']], limit: [[], ['options']], plan: [[], []], attention: [[], []],
  post: [['text'], []], read: [[], []], show: [[], ['member', 'seq']], confirm: [['name', 'seq'], []], retry: [['name'], []],
  replace: [['name', 'newName'], ['options']], pause: [[], ['text']], resume: [[], ['name']], status: [[], []], close: [[], []],
  export: [[], ['out']],
}
// The coordinator drives the run this conversation owns, or makes one with init.
async function coordinatorBoard($: EngineInterface, e: BoardInput) {
  const { action } = e
  const takes = Object.hasOwn(COORDINATOR_TAKES, action) ? COORDINATOR_TAKES[action] : undefined
  if (!takes) return { deny: `Unknown board action. The coordinator's are ${Object.keys(COORDINATOR_TAKES).join(', ')}.` }
  const [needs, may] = takes
  const given = BOARD_FIELDS.filter(field => e[field] !== undefined && !(typeof e[field] === 'string' && (e[field] as string).trim() === ''))
  const missing = needs.filter(field => !given.includes(field as typeof given[number]))
  const extra = given.filter(field => !needs.includes(field) && !may.includes(field))
  if (missing.length > 0 || extra.length > 0) {
    return { deny: `${action} takes ${[...needs, ...may.map(field => `${field} (optional)`)].join(', ') || 'no fields'}${missing.length ? `; ${missing.join(', ')} missing` : ''}${extra.length ? `; not ${extra.join(', ')}` : ''}.` }
  }
  const one = (value: string | undefined) => value?.trim().replace(/^@/, '').toLowerCase() ?? ''
  const name = one(e.name)
  const newName = one(e.newName)
  // Checked as stripped: "@" alone would otherwise pass as no name, and `resume` would resume the whole run.
  if (action !== 'init' && ([['name', name], ['newName', newName]] as const).some(([field, value]) => given.includes(field) && !/^[a-z][a-z0-9_-]*$/.test(value))) {
    return { deny: 'A member name is lowercase letters, digits, underscores and hyphens, such as "parser".' }
  }
  if (action === 'init' && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(e.name?.trim() ?? '')) {
    return { deny: 'name is the run\'s folder name under .swarm: a letter or digit, then letters, digits, dots, underscores or hyphens.' }
  }
  const options = e.options ?? []
  if (!Array.isArray(options) || options.length > 40 || options.some(option => typeof option !== 'string' || !/^[A-Za-z_]\w*=[^\n]*$/.test(option))) {
    return { deny: 'options are key=value strings, such as "role=verifier" or "paths=src/a,src/b".' }
  }
  if (e.seq !== undefined && (!Number.isSafeInteger(e.seq) || e.seq < 1)) return { deny: 'seq is a positive post number.' }
  const text = typeof e.text === 'string' ? e.text.trim() : ''
  const oneLine = [e.title, e.out].find(value => typeof value === 'string' && /\n/.test(value))
  if (oneLine !== undefined || text.length > 12000) return { deny: 'title and out are one line each, and text at most 12,000 characters.' }
  const owned = await read($, run)
  // init is how the skill may make a run with this tool; anything else needs the run this conversation drives.
  if (action !== 'init' && !owned) return { deny: NO_RUN_BOARD }
  const dir = action === 'init' ? `${await $.session.cwd()}/.swarm/${e.name!.trim()}` : owned
  const shown = action === 'show' ? showArgs(e) : []
  if ('deny' in shown) return shown
  const args = action === 'init' ? [action, e.title!.trim()]
    : action === 'member' || action === 'retry' ? [action, name, ...options]
    : action === 'limit' ? [action, ...options]
    : action === 'post' || action === 'read' ? [action, 'coordinator', ...(action === 'read' ? [`--max-bytes=${PAGE}`] : [])]
    : action === 'show' ? shown
    : action === 'confirm' ? [action, name, String(e.seq)]
    : action === 'replace' ? [action, name, newName, ...options]
    : action === 'pause' ? [action, ...(text ? [text] : [])]
    : action === 'resume' ? [action, ...(name ? [name] : [])]
    : action === 'export' ? [action, ...(e.out ? [`--out=${e.out.trim()}`] : [])]
    : [action]
  // The same record a board command typed in Bash makes, so everything that follows one follows this too.
  const call: ParsedBoardCall = { dir, action, subarg: /^@?[\w-]+$/.test(args[1] ?? '') ? args[1]!.replace(/^@/, '').toLowerCase() : undefined, rest: args.join(' '), piped: false }
  return pauseAware($, [call], undefined, async () => {
    const answer = await boardAnswer($, dir, args, action === 'post' ? text : undefined, e)
    // A whole-board show cut to its newest page printed none of the older posts: they are not marked as seen.
    // Nor is a read that stopped at a page with more to come the end of what the coordinator is owed.
    const isCut = 'result' in answer && (answer.result.startsWith('Earlier posts are left out') || /^\d+ more post\(s\) remain\./m.test(answer.result))
    // The roster sync and a new run's bind come first: what is owed then is this run's and current.
    const ran = await boardCallsRan($, undefined, [call], 'result' in answer ? answer.result : '', answer)
    return coordinatorNotes($, [call], false, answer, ran, isCut)
  })
}

/** Runs one board command for the tool and answers in the tool's words: a failure is a deny, a long answer is cut to a page. */
async function boardAnswer($: EngineInterface, dir: string, args: string[], stdin: string | undefined, e: BoardInput): Promise<{ deny: string } | { result: string }> {
  const { action } = e
  const result = await boardCommand($, dir, args, stdin)
  if (result.exitCode !== 0) {
    const err = result.stderr.trim()
      .replace(/show --post=(\d+)/g, 'action "show" with seq $1')
      .replace(/board\.py \S+ (ready|revise)\b[^\n]*/g, 'action "$1" with text')
    return { deny: err || 'The board action failed.' }
  }
  if (result.isStdoutTruncated) return { deny: 'The board response exceeded the tool limit. Use show with a post number, or ask the coordinator for help if it is a single long post.' }
  if (action === 'read' || !BOARD_READS.includes(action)) $.clock.after(0, () => void refresh($))
  if (action === 'show' && result.stdout.length > PAGE) {
    if (e.seq) return { result: `${head(result.stdout, PAGE)}\n(Cut here: the post is longer than one page.)` }
    // `show` has no page of its own: the newest posts are kept, from the start of a line.
    const kept = result.stdout.slice(-PAGE)
    const nl = kept.indexOf('\n')
    let body = nl >= 0 ? kept.slice(nl + 1) : kept
    if (body.length > 0 && body.charCodeAt(0) >= 0xdc00 && body.charCodeAt(0) <= 0xdfff) body = body.slice(1)
    return { result: `Earlier posts are left out: the history is longer than one page. Narrow it with a member filter, or open one post with seq.\n${body}` }
  }
  // The board cuts a post longer than the page and says how to see it whole, in shell words: the caller has the tool.
  return { result: result.stdout
    .replace(/\[cut to fit the page\. The whole post: show --post=(\d+)\]/g, '[cut to fit the page. The whole post: action "show" with seq $1]')
    .replace(/^(UNREAD: .*) Read them now: read \S+$/gm, '$1 Read them now: action "read"') }
}

// ponytail: a diff past this many characters is cut; `git diff HEAD...<commit>` prints it whole.
const DIFF_CLIP = 12_000
// The move of the shared checkout's HEAD the coordinator was last told of, as `from>to`.
let headNoted = ''
/** Opens a READY's commit under its post, saying what it covers. With the base the board recorded (the project's
 * HEAD when the READY was posted), that is the first-parent commits since, merges left out: a synced dependency's
 * merge and what it brought in are not shown, but another worker's commits fast-forwarded into the branch are, and
 * a conflict resolution recorded in a merge is not. The commits in `except` (ones the board knew were others' work)
 * are left out beside the base. A report with no base is shown as all it adds to HEAD, and once it adds nothing, as
 * its last commit alone. */
async function showDiff($: EngineInterface, dir: string, seq: number, revision: string, base?: string, except: readonly string[] = []): Promise<void> {
  const project = dir.slice(0, dir.lastIndexOf('/.swarm/'))
  const sEpoch = sessionEpoch
  const git = (args: string[]) => $.process.run(['git', '-C', project, ...args], { timeoutMs: 10_000 })
    .catch(error => ({ exitCode: 1, stdout: '', stderr: String(error) }))
  const shape = ['--stat', '--patch', '--no-color', '--no-ext-diff']
  let shown
  let scope
  if (base !== undefined) {
    shown = await git(['log', '--first-parent', '--no-merges', '--reverse', ...shape, revision, '--not', base, ...except])
    scope = `First-parent commits since ${base.slice(0, 7)} · merges omitted`
  } else {
    shown = await git(['diff', ...shape, `HEAD...${revision}`])
    scope = `What ${revision.slice(0, 7)} changes since it branched from HEAD, including any synced dependency's work not yet in HEAD`
    if (shown.exitCode === 0 && shown.stdout.trim() === '') {
      shown = await git(['show', '--first-parent', ...shape, revision])
      scope = `Last commit only (${revision.slice(0, 7)}): this report records no base, so its earlier commits are not shown`
    }
  }
  // git may take seconds: a diff for a run no longer shown would open under another run's post of the same number.
  if (sEpoch !== sessionEpoch || (await shownSwarm($)).dir !== dir) return
  if (shown.exitCode !== 0) {
    $.ui.toast(`Swarm could not show ${revision.slice(0, 12)}: ${clean(shown.stderr).trim().split('\n')[0] || 'git failed'}`)
    return
  }
  const text = clip(clean(shown.stdout).trimEnd(), DIFF_CLIP)
  // A fence longer than any run of backticks in the diff, so a Markdown file's own fences stay inside it.
  const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(run => run[0].length + 1)))
  await update($, diff, () => ({ seq, text: `${scope}\n${fence}diff\n${text}\n${fence}` }))
}

/** Writes the shown run's Markdown summary with the board's export and says where. */
async function exportRun($: EngineInterface, dir: string): Promise<void> {
  const written = await boardCommand($, dir, ['export']).catch(error => ({ exitCode: 1, stdout: '', stderr: String(error) }))
  const path = clean(written.stdout).trim().split('\n').at(-1) ?? ''
  $.ui.toast(written.exitCode === 0 && path ? `Swarm wrote ${path}` : `Swarm: ${clean(written.stderr).trim() || 'the board\'s export command failed'}`)
}

// The band's button that opens the pane.
function shortcut($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0], singleCaption = false) {
  const { Box, Button } = $.ui.resolve(e)
  const button = <Button key={SHORTCUT} variant="secondary" label="Swarm: The Board" onPress={() => void openBoard($).catch(() => undefined)} />
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
      const prev = clock.view.split('/')
      const next = view.split('/')
      if (clock.view.startsWith('graph/') && view.startsWith('graph/') && next[3] === 'true' && prev[3] !== 'true') {
        clock.start = prev[2] === 'true' ? now - REPLAY_FRAME_MS : now
      }
      clock.view = view
      clock.offset = Math.max(0, now - clock.start)
    }
    return clock.offset
  }

  on('session.start', async ($, e, next) => {
    poller?.cancel()
    sessionEpoch++
    browseGen++
    resetMonitoring()
    agentRuns.clear()
    runEdge = { dir: '' }
    edgesAsked = ''
    strangers.clear()
    stepped.clear()
    turnRuns.clear()
    teammates.clear()
    pendingStarts.clear()
    spawnEfforts.clear()
    spawnIsolations.clear()
    sharedAgents.clear()
    isolatedAgents.clear()
    isCoordinatorBusy = isEnding = isRefreshOwed = isPaneOpen = isWatched = false
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
    hadRun = Boolean((await $.fs.read(`${e.cwd}/.swarm/current`).catch(() => '')).trim())
    try {
      await $.command.register({
        name: 'swarm-board',
        immediate: true,
        description:
          'Open the Swarm pane: the live board, members and @mention graph',
      })
      await $.tool.register({
        name: 'board',
        description: 'Works only inside a Swarm run the user started with /swarm:swarm, and answers nothing useful anywhere else. ' +
          'The Swarm board, as the caller: a member reads its unread posts, shows history, posts, and sees status; a worker also reports ready or withdraws readiness. ' +
          'The coordinator drives its run: init, member, limit, plan, attention, post, read, show, confirm, retry, replace, pause, resume, status, close, export.',
        isDeferred: false,
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: { enum: ['read', 'show', 'post', 'ready', 'revise', 'status', 'init', 'member', 'limit', 'plan', 'attention', 'confirm', 'retry', 'replace', 'pause', 'resume', 'close', 'export'] },
            member: { type: 'string', description: 'Optional member filter for show.' },
            seq: { type: 'integer', minimum: 1, description: 'A post number: one post for show, the finding for confirm.' },
            text: { type: 'string', maxLength: 12000, description: 'Report, message, or reason (post, ready, revise, pause).' },
            commit: { type: 'string', description: 'ready: the full 40- or 64-character commit id the report covers. Never HEAD.' },
            title: { type: 'string', description: 'init: the run\'s title.' },
            name: { type: 'string', description: 'init: the run\'s folder name under .swarm. member, retry, replace (the old one), confirm, resume: the member.' },
            newName: { type: 'string', description: 'replace: the successor\'s name.' },
            options: { type: 'array', items: { type: 'string' }, description: 'member, limit, replace: key=value settings, such as "role=verifier".' },
            out: { type: 'string', description: 'export: where to write the Markdown summary; the run folder\'s summary.md when left out.' },
          },
          required: ['action'],
        },
      })
    } finally {
      await stop($).catch(() => undefined)
      await stopLive($).catch(() => undefined)
      isRestoreOwed = false
      await restore($, e.cwd)
      poller = $.clock.every(2000, () => {
        void refresh($)
        void refreshTalk($)
      })
    }

    return next(e)
  })

  // The board tool has a hook of its own, as the engine asks of a registered tool. Seen live: served
  // from the general hook below, a specialist resumed by a wake got "no tool.call hook answered".
  on('tool.call', { tool: BOARD_TOOL }, async ($, e) => {
    // The coordinator's call means it is mid-turn, as any tool call of its own does in the hook below.
    if (e.agentId === undefined) isCoordinatorBusy = true
    const actor = e.agentId ?? 'coordinator'
    moods.delete(actor)
    moods.set(actor, BOARD_READS.includes(e.action) ? 'inspect' : 'relay')
    try {
      const stopped = await refusal($, e.agentId)
      if (stopped) return { deny: stopped }
      return e.agentId === undefined ? await coordinatorBoard($, e) : await memberBoard($, { ...e, agentId: e.agentId })
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
    moods.set(actor, toolMood(e.tool, e.tool === 'Bash' ? String(e.command) : ''))
    const agentCall = e.tool === 'Agent' && typeof e.tool_use_id === 'string' ? e.tool_use_id : undefined
    if (agentCall && e.tool === 'Agent') {
      spawnEfforts.set(agentCall, e.effort)
      spawnIsolations.set(agentCall, e.isolation)
    }
    // The board command(s) this call runs, if any: each run folder and subcommand.
    const command = e.tool === 'Bash' ? String(e.command) : ''
    const calls = e.tool === 'Bash' ? boardCalls(command) : []
    const isCoordinatorBg = e.agentId === undefined && (e.tool === 'Monitor' || (e.tool === 'Bash' && e.run_in_background === true))
    const isMemberGuard = e.agentId !== undefined && (e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'NotebookEdit' || e.tool === 'Bash')
    let bgWarning: string | undefined
    let guarded: string | undefined
    // A shared-checkout writer's command whose HEAD is read before and after it.
    let headWatch: { checkout: string; name: string } | undefined
    try {
      if (isCoordinatorBg || isMemberGuard) {
        // The ownership this call is checked under: a roster read for a run that lost it meanwhile is not published.
        const owner = generation
        // The run this conversation drives, or drove until its close: its members' agents may still run.
        let activeDir = await read($, run) || closedRun
        if (!activeDir && e.agentId !== undefined) {
          // After a resume the run this conversation drove and closed is known to the board alone: its members are
          // still guarded by its roster. Only a Swarm agent can be one, so no other agent costs a lookup.
          const agent = (await $.agent.list().catch(() => [])).find(one => one.id === e.agentId)
          if (agent && SWARM_AGENTS.has(agent.type)) activeDir = await agentRun($, e.agentId, agent).catch(() => '')
        }
        if (activeDir && (!ownedRoster || ownedRoster.dir !== activeDir)) {
          await syncOwnedState($, activeDir, undefined, undefined, owner).catch(() => undefined)
        }
        if (activeDir && ownedRoster && ownedRoster.dir === activeDir && (e.agentId !== undefined || !ownedRoster.closed)) {
          if (e.agentId === undefined) {
            if (e.tool === 'Monitor') {
              return { deny: 'Do not use Monitor while driving a Swarm run: each event wakes the coordinator and re-reads its whole conversation, and Swarm hooks already monitor the board.' }
            }
            if (e.tool === 'Bash' && e.run_in_background === true) {
              if (WATCHER_BG_RE.test(command)) {
                return { deny: 'Do not run background watcher, poll, or board commands while driving a Swarm run: Swarm hooks already monitor the board, and background completions wake the coordinator and re-read its whole conversation.' }
              }
              bgWarning = 'Swarm: Running a background Bash command while driving a Swarm run will wake the coordinator and re-read its whole conversation when it finishes.'
            }
          } else {
            const agents = await $.agent.list().catch(() => [])
            const agent = agents.find(one => one.id === e.agentId)
            // A member the owned roster names is identified before any lookup that can throw, so a failure fails closed.
            const address = teammateOf($, e.agentId, agent)
            const named = () => ownedRoster?.dir === activeDir
              ? Object.entries(ownedRoster.members).find(([, m]) => m.id === e.agentId || (address !== undefined && m.id === address))
              : undefined
            let found = named()
            // A member started since the roster was cached (its `started` is on disk, the poll that reads it is not
            // yet run) is no stranger: read the roster again before the guard decides it names nobody. Read once per
            // change of the roster file: an agent it still does not name is not read for again on every call.
            if (!found && (agentRuns.get(e.agentId) ?? await agentRun($, e.agentId, agent)) === activeDir) {
              const stamp = await $.fs.stat(`${activeDir}/members.json`).then(st => `${st.size}:${st.mtimeMs}`, () => '')
              const isKnownMiss = stamp !== '' && rosterMiss?.dir === activeDir && rosterMiss.stamp === stamp && rosterMiss.ids.has(e.agentId)
              if (!isKnownMiss) {
                // A miss is remembered only for a roster read just now: one that could not be read is read again next time.
                const isRead = await syncOwnedState($, activeDir, undefined, undefined, owner).catch(() => false)
                found = named()
                if (!found && stamp !== '' && isRead) {
                  if (rosterMiss?.dir !== activeDir || rosterMiss.stamp !== stamp || rosterMiss.ids.size >= 64) rosterMiss = { dir: activeDir, stamp, ids: new Set() }
                  rosterMiss.ids.add(e.agentId)
                }
              }
              // Still unrecorded (its start is in flight): known by its description, by the rule agentRun took it in with.
              const described = parseDescribedName(agent?.description)
              const starting = !found && ownedRoster?.dir === activeDir ? memberNamed(ownedRoster.members, described) : undefined
              if (described && starting && (!starting.id || pendingStarts.has(`${activeDir}/${described}`)) && !starting.killed &&
                  agent?.type === `swarm:${starting.profile || starting.role || 'worker'}`) found = [described, starting]
            }
            const [memberName, member] = found ?? []
            if (memberName && memberName !== 'coordinator' && member) guarded = memberName
            // A roster read just now may have retired it.
            const stoppedNow = stoppedMember(e.agentId)
            if (stoppedNow) return { deny: stoppedNow }
            // The owned roster naming this agent settles its run: a lookup that fails, by throwing or by an
            // error exit, must not let a known member past the guard.
            const memberDir = guarded ? activeDir : agentRuns.get(e.agentId) ?? await agentRun($, e.agentId, agent)
            if (memberDir === activeDir) {
              if (memberName && memberName !== 'coordinator' && member) {
                const target = e.tool === 'NotebookEdit' ? String(e.notebook_path ?? '') : e.tool === 'Edit' || e.tool === 'Write' ? String(e.file_path ?? '') : ''
                const checked = await memberCall($, { agentId: e.agentId, tool: e.tool, target, command, isBackground: e.tool === 'Bash' && e.run_in_background === true }, activeDir, memberName, member, ownedRoster.members)
                if (checked.deny !== undefined) return { deny: checked.deny }
                headWatch = checked.headWatch
              }
            }
          }
        }
      }
    } catch (error) {
      // Fail closed for a known member of the owned run; board commands still pass so it can report.
      if (guarded === undefined) throw error
      if (e.tool !== 'Bash' || NAMES_COMMIT.test(command)) {
        return { deny: `Swarm could not check @${guarded}'s call against the run's roster (${error instanceof Error ? error.message : String(error)}), so it was refused. Report this sentence to the coordinator.` }
      }
    }
    const headBefore = headWatch ? await headOf($, headWatch.checkout) : ''
    const raw = await pauseAware($, calls, e.agentId, () => next(e)).finally(() => {
      if (agentCall) {
        spawnEfforts.delete(agentCall)
        spawnIsolations.delete(agentCall)
      }
    })
    let result = raw
    if (bgWarning && result.deny === undefined && result.isError === undefined) {
      result = { ...result, context: [...(result.context ?? []), bgWarning] }
    }
    const headAfter = headWatch && headBefore ? await headOf($, headWatch.checkout) : ''
    if (headWatch && headAfter && headAfter !== headBefore) {
      // Said as what was seen, not who did it: another member or the person may have moved it. Nothing is undone.
      const moved = `HEAD of the shared checkout moved from ${headBefore.slice(0, 12)} to ${headAfter.slice(0, 12)}`
      // A refused command moved nothing, and one move seen by several members' commands is one piece of news.
      if (result.deny === undefined && headNoted !== `${headBefore}>${headAfter}`) {
        headNoted = `${headBefore}>${headAfter}`
        result = { ...result, context: [...(result.context ?? []), `Swarm: ${moved} during this command. Shared-checkout writers must not commit; nothing was undone. Tell the coordinator in your report that HEAD moved.`] }
        notesOwed.push(`${moved} while @${headWatch.name} ran a Bash command. Another actor may have moved it, and nothing was undone: check git log before the next candidate.`)
      }
    }
    if (e.tool === 'Bash' && e.agentId === undefined && !result.isError && !result.deny && !calls.some(c => c.action === 'init') &&
      substitutions(command).some(body => /\bboard\.py\b[^\n;|&]*\sinit\s/.test(body))) {
      // `R=$(board.py … init …)` keeps the folder out of the output and the call out of what is read off the
      // command. Read loosely, however the script is run, but only inside a substitution: the same words in a
      // quoted string or a heredoc make no run. The pointer `init` just wrote names the run; the board refuses
      // one another conversation owns.
      // The new run also takes the place of one this conversation drove and closed, as a plain `init` does.
      try {
        const ownedNow = await read($, run)
        if (ownedNow === '' || (ownedRoster?.dir === ownedNow && ownedRoster.closed)) {
          const root = `${await $.session.cwd()}/.swarm`
          const name = (await $.fs.read(`${root}/current`)).trim()
          if (/^[\w.-]+$/.test(name) && RUN.test(`${root}/${name}`)) await bind($, `${root}/${name}`)
        }
      } catch {
        // No pointer, no run to claim.
      }
      // Hidden in a substitution or not, it is an `init`: the same words go with it.
      const notes = await initNotes($).catch(() => [])
      if (notes.length > 0 && result.deny === undefined && result.isError === undefined) result = { ...result, context: [...(result.context ?? []), ...notes] }
    }
    if (e.tool === 'Bash') result = await boardCallsRan($, e.agentId, calls, String((raw.result as { stdout?: unknown } | undefined)?.stdout ?? ''), result)
    // After the board commands took effect: a new run's bind leaves nothing of the old one's owed, and a resume or
    // replace drops the pause notices it settled.
    if (e.agentId !== undefined) return result
    return coordinatorNotes($, calls, e.tool === 'SendMessage' && Number.isSafeInteger(wakeSequence(String(e.message))), raw, result)
  }).catch((_, e, next) => {
    if (next.called) return next(e)
    if (e.agentId !== undefined) {
      const stopped = stoppedMember(e.agentId)
      if (stopped) return { deny: stopped }
      if (halted && agentRuns.get(e.agentId) === halted.dir) {
        return { deny: `This Swarm run is ${halted.why}, so this tool call was not run. Make no more tool calls: end your turn now with one line saying where you stopped. The coordinator decides what happens when the run resumes.` }
      }
      // A check that failed or ran out of time lets no known member edit or commit unchecked; its board commands still
      // pass so it can report.
      const address = teammates.get(e.agentId)
      const isMember = agentRuns.has(e.agentId) || Object.values(ownedRoster?.members ?? {}).some(member => member.id !== undefined && (member.id === e.agentId || member.id === address))
      const command = e.tool === 'Bash' ? String(e.command) : ''
      if (isMember && (e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'NotebookEdit' || NAMES_COMMIT.test(command))) {
        return { deny: 'Swarm could not check this call against the run\'s roster in time, so it was refused. Try it once more; if it is refused again, report this sentence to the coordinator.' }
      }
    }
    return next(e)
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
    const matches = Object.entries(state.members).filter(([, member]) => member.id && !member.killed && !member.paused &&
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
    const named = parseDescribedName(e.description)
    type RunState = {
      title?: string
      members: Roster
      closed?: boolean
      paused?: string
    } & BudgetState
    const stateOf = async (dir: string) => JSON.parse(await $.fs.read(`${dir}/members.json`)) as RunState
    const activeRun = await read($, run)
    const current = activeRun || closedRun
    const running = e.resume ? findAgent(await $.agent.list(), e.resume.agentId) : undefined
    const resumedRun = e.resume ? await agentRun($, e.resume.agentId, running) : ''
    // A member of a run this conversation no longer drives: every tool call it made would be refused as the run's.
    if (resumedRun && activeRun && resumedRun !== activeRun) {
      const name = (dir: string) => dir.slice(dir.lastIndexOf('/') + 1)
      return { deny: `This agent is a member of the Swarm run ${name(resumedRun)}, and this conversation now drives ${name(activeRun)}, so it is not resumed: each of its tool calls would be refused. Start a member registered in ${name(activeRun)} instead.` }
    }
    let owned = resumedRun || current
    let state = owned ? await stateOf(owned).catch(() => undefined) : undefined
    if (owned && !state) {
      if (!activeRun && !resumedRun && owned === closedRun) {
        closedRun = ''
        owned = ''
      } else {
        return { deny: 'Swarm could not read this run’s roster. Check the board before starting or resuming a member.' }
      }
    }
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
      return { deny: NO_RUN_AGENT }
    }
    // A closed run starts nobody: its own members are told so, any other swarm: agent that it drives no run.
    if (state.closed) {
      return resumedRun || memberNamed(state.members, named)
        ? { deny: `Swarm "${state.title ?? ''}" is closed, so ${named ? `@${named}` : 'this member'} is not started. Start a new run with the board's init command and register the member there.` }
        : { deny: NO_RUN_AGENT }
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
      const address = teammateOf($, e.resume.agentId, running)
      const entry = Object.values(state.members).find(member => member.id === e.resume?.agentId ||
        (address !== undefined && member.id === address))
      if (entry?.killed || memberNamed(state.members, named)?.killed) return { deny: 'This Swarm member has been retired.' }
      const resumed = memberNamed(state.members, named)
      if (resumed && entry && resumed !== entry) return { deny: 'This agent is no longer assigned to that Swarm member.' }
      if (resumed?.id && !entry) return { deny: 'This agent is no longer assigned to that Swarm member.' }
      // A member whose first start was never recorded is recorded now, or it could not be woken. Only an
      // agent of the type the roster gives the member: a resume skips the checks a fresh start goes through.
      const isUnrecorded = !entry && named !== undefined && resumed !== undefined && !resumed.id &&
        running?.type === `swarm:${resumed.profile || resumed.role || 'worker'}`
      // A swarm: agent the roster does not know is no member: it is not resumed into the run, nor outside it.
      if (!entry && !isUnrecorded) return { deny: 'This agent is no member of this Swarm run, so it is not resumed: a swarm: agent runs only as a member its coordinator registered. Use a general-purpose or Explore agent for other work.' }
      const again = await next(e)
      if (again.agentId) {
        agentRuns.set(again.agentId, owned)
        if (again.teammateId) learnTeammate($, again.agentId, again.teammateId)
      }
      if (isUnrecorded && named && again.agentId) {
        const recorded = await boardCommand($, owned, ['started', named, again.teammateId ?? again.agentId, '']).catch(() => undefined)
        if (recorded?.exitCode !== 0) $.ui.toast(`Swarm could not record @${named}'s agent address, so it cannot be woken. Record it with the board's member command: id=${again.teammateId ?? again.agentId}`)
        rosterMiss = undefined
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
    // Its every tool call would be refused: the start would buy one turn that ends at once.
    if (member.paused) {
      return { deny: `@${named} is paused (${member.paused}). Raise it with the board's member ${named} budget=<tokens>, then resume ${named}, before starting it.` }
    }
    // A replacement is not started beside the member it replaces (transitively) or beside a killed member with overlapping paths.
    const liveAgents = await $.agent.list().catch(() => [])
    const queue = [named]
    const visited = new Set([named])
    const predecessors: Array<[string, Roster[string]]> = []
    while (queue.length > 0) {
      const target = queue.shift()!
      for (const [prevName, entry] of Object.entries(state.members)) {
        if (entry.killed && entry.replaced_by === target && !visited.has(prevName)) {
          visited.add(prevName)
          predecessors.push([prevName, entry])
          queue.push(prevName)
        }
      }
    }
    for (const [prevName, entry] of predecessors) {
      if (!entry.id) continue
      const before = findAgent(liveAgents, entry.id)
      if (before && ['running', 'pending', 'waiting'].includes(before.status)) {
        return { deny: `@${prevName}, which @${named} replaces, is still ${before.status} as agent ${before.id}. Stop that agent first, and wait for any build or test it started to end, then start @${named} again.` }
      }
    }
    const memberPaths = parsePaths(member.paths)
    if (memberPaths.length > 0) {
      for (const [killedName, entry] of Object.entries(state.members)) {
        if (!entry.killed || !entry.id || visited.has(killedName)) continue
        if (!pathsOverlap(memberPaths, parsePaths(entry.paths))) continue
        const before = findAgent(liveAgents, entry.id)
        if (before && ['running', 'pending', 'waiting'].includes(before.status)) {
          return { deny: `@${killedName}, which previously owned overlapping paths, is still ${before.status} as agent ${before.id}. Stop that agent first, and wait for any build or test it started to end, then start @${named} again.` }
        }
      }
    }
    const team = Object.entries(state.members).filter(([name, entry]) => name !== 'coordinator' && !entry.killed)
    if (team.length > Number(state.limits?.max_members ?? Infinity) ||
        team.filter(([, entry]) => entry.role !== 'verifier').length > Number(state.limits?.max_workers ?? Infinity)) {
      return { deny: 'The Swarm roster exceeds this run’s member limit. Check the board plan before launching more agents.' }
    }
    const isExactModel = (m: string) => /(?:^|\.)claude-/i.test(m) || (m !== 'inherit' && !Object.hasOwn(LATEST, m.toLowerCase()))
    let modelToUse: string | undefined
    {
      const kind = e.subagentType.slice('swarm:'.length)
      // The type is what the roster says: the default model, the limits and the board tool all follow it.
      const registered = member.profile || member.role || 'worker'
      if (registered !== kind) {
        return { deny: `The roster has @${named} as ${registered}, but this call would start it as ${kind}. Start it with subagent_type "swarm:${registered}", or change the roster with the board's member command.` }
      }
      const memberModel = member.model
      let actual: string
      // `inherit` is the coordinator's own model, whichever of its family that is. Agent.model takes family names
      // only, so the call leaves it out or names that family.
      if (memberModel === 'inherit' && (e.model === undefined || e.model === 'inherit' ||
          (!isExactModel(e.model) && familyOf(latestOf(e.model) ?? '') === familyOf(e.parentModel)))) {
        actual = e.parentModel
        modelToUse = e.parentModel
      } else if (memberModel && isExactModel(memberModel) && (e.model === undefined || (!isExactModel(e.model) && familyOf(latestOf(e.model) ?? '') === familyOf(memberModel)))) {
        actual = memberModel
        modelToUse = memberModel
      } else {
        actual = e.model === 'inherit' ? e.parentModel : latestOf(e.model) ?? DEFAULT_MODEL[kind] ?? ''
        modelToUse = e.model === 'inherit' ? e.parentModel : latestOf(e.model) ?? DEFAULT_MODEL[kind]
      }
      const runsOn = familyOf(actual)
      const limitRaw = state.limits && Object.hasOwn(state.limits, runsOn) ? state.limits[runsOn] : undefined
      const allowed = limitRaw?.split(',').filter(x => x && x !== 'none')
      if (allowed && !allowed.includes(kind) && !allowed.includes(named)) {
        return { deny: `This run allows ${runsOn} only for: ${allowed.join(', ') || 'none'}. Register @${named} with another model= and pass that model on the Agent call.` }
      }
      // The roster's model, or the type's default when it names none: a model passed only on the
      // Agent call would otherwise skip the plan the user saw and the board's rules for the type.
      if (memberModel === 'inherit' && e.model !== undefined && e.model !== 'inherit' && familyOf(e.parentModel) !== runsOn) {
        return { deny: `The roster has @${named} on the coordinator's model. Omit model on the Agent call or pass the coordinator's own family (model: "${familyOf(e.parentModel)}"), or change the roster with the board's member command.` }
      }
      const expected = memberModel === 'inherit' ? e.parentModel : memberModel || familyOf(DEFAULT_MODEL[kind] ?? '')
      if (expected && (isExactModel(expected) ? expected.toLowerCase() !== actual.toLowerCase() : familyOf(expected) !== runsOn)) {
        const guidance = memberModel === 'inherit'
          ? `Omit model on the Agent call or pass the coordinator's own family (model: "${familyOf(e.parentModel)}")`
          : isExactModel(expected)
            ? `Omit model or pass model: "${familyOf(expected)}" on the Agent call`
            : `Pass model: "${expected}" on the Agent call`
        return { deny: `The roster has @${named} on ${expected}, but this call would start it on ${actual || runsOn}. ${guidance}, or change the roster with the board's member command.` }
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
      if (member.id) {
        const existing = findAgent(await $.agent.list(), member.id)
        if (!existing || (existing.status !== 'killed' && existing.status !== 'failed')) {
          return { deny: `@${named} already has an agent. Resume it with SendMessage or replace its assignment.` }
        }
      }
      if (owned !== current && !(await bind($, owned))) return { deny: 'Swarm could not claim that run. Check that this conversation owns it.' }
      // The table decides, not the session's alias or the agent file: a family name becomes the newest model
      // of that family, and a call that names no model gets its type's default.
      const background = !e.isTeammate ? true : e.background
      const started = await next(
        modelToUse !== e.model || background !== e.background
          ? { ...e, model: modelToUse, background }
          : e,
      )
      if (started.agentId) {
        strangers.delete(started.agentId)
        if (started.teammateId) strangers.delete(started.teammateId)
        agentRuns.set(started.agentId, owned)
        rosterMiss = undefined
        if (started.teammateId) learnTeammate($, started.agentId, started.teammateId)
        const hasIsolation = spawnIsolations.has(e.tool_use_id)
        const isIsolated = hasIsolation && !e.isTeammate && spawnIsolations.get(e.tool_use_id) === 'worktree'
        if (hasIsolation || e.isTeammate) {
          if (isIsolated) isolatedAgents.add(started.agentId)
          else sharedAgents.add(started.agentId)
        }
        const address = started.teammateId ?? started.agentId
        const startedArgs = ['started', named, address, member.id ?? '']
        if (hasIsolation || e.isTeammate) startedArgs.push(isIsolated ? 'isolated=1' : 'isolated=0')
        const recorded = await boardCommand($, owned, startedArgs).catch(() => undefined)
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
      const now = await $.clock.now()
      const delta = spent ? stepped.charge(e.turnId, spent, e.index, e.agentId, now) : 0
      const turn = delta > 0 ? stepped.of(e.turnId) : undefined
      if (stepped.running > TURNS_KEPT) {
        // An agent that ended without ending its turn leaves it running: such turns go, and no live one does.
        void $.agent.list().then(agents => stepped.prune(id => agents.some(agent => agent.id === id && !['completed', 'failed', 'killed'].includes(agent.status)), now)).catch(() => undefined)
      }
      if (spent && turn) {
        // Queued before anything is awaited: the turn's end waits for this charge, and so never charges it again. The
        // charge itself goes out once the budget below is judged, as it always did.
        let judged = () => {}
        const judging = new Promise<void>(resolve => { judged = resolve })
        let at: string | undefined
        turn.landing = turn.landing
          .then(() => judging)
          .then(() => account($, `${e.turnId}:${e.index}`, e.agentId, delta, at))
          .catch(() => false)
          .then(landed => { if (landed) stepped.landed(turn, delta) })
        try {
          // Only a step of this run's own spends its budget: the coordinator's, or an agent already known to be a member.
          at = e.agentId === undefined ? (await read($, run)) || undefined : undefined
          if (at) {
            turnRuns.set(e.turnId, at)
            // A turn that never reports its end leaves its entry: the oldest go first.
            if (turnRuns.size > TURNS_KEPT) turnRuns.delete(turnRuns.keys().next().value!)
          }
          const isOwn = snapshot !== undefined && (e.agentId === undefined ? at : agentRuns.get(e.agentId)) === snapshot.dir
          if (snapshot && !snapshot.isClosed && isOwn && snapshot.budget > 0 && tokensUsed(snapshot.tokens) + delta >= snapshot.budget) {
            halted = { dir: snapshot.dir, why: `paused (token budget of ${compact(snapshot.budget)} spent)` }
          }
        } finally {
          judged()
        }
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
        // Again while a step queued another charge meanwhile.
        for (let turn = stepped.of(e.turnId), seen: Promise<unknown> | undefined; turn && seen !== turn.landing;) {
          seen = turn.landing
          await seen
        }
        // What its steps left uncharged goes to the run they were spent under, where one was driven then.
        const at = turnRuns.get(e.turnId)
        turnRuns.delete(e.turnId)
        await account($, e.turnId, e.agentId, e.usage ? stepped.charge(e.turnId, e.usage) : 0, at).catch(() => undefined)
      } finally {
        // Only once its usage is on the board: a poll in between would act on the roster as it was before a budget pause.
        if (e.agentId === undefined) {
          isCoordinatorBusy = false
          quietSince = await $.clock.now()
          const dir = await read($, run)
          if (dir && heavyTold !== dir) {
            const held = await $.session.usage().then(usage => usage.context.tokens ?? 0).catch(() => 0)
            if (held >= HEAVY_CONVERSATION) {
              heavyTold = dir
              $.ui.toast(`Swarm: the coordinator's conversation now holds about ${compact(held)} tokens, and every wake re-reads them. /compact while it is idle makes the rest of this run cheaper.`)
            }
          }
        }
      }
      if (e.agentId !== undefined) {
        // A member that was woken and ended its turn without reading is owed the wake again.
        const agent = findAgent(await $.agent.list(), e.agentId)
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
    isPaneOpen = false
    sessionEpoch++
    browseGen++
    if (!goesOn) {
      poller?.cancel()
      poller = undefined
    }
    resetMonitoring()
    agentRuns.clear()
    runEdge = { dir: '' }
    edgesAsked = ''
    strangers.clear()
    stepped.clear()
    turnRuns.clear()
    // A teammate's address is kept through /clear and a resume: one that ends afterwards has left the agent
    // list, and its last turn and its wake are still recorded under that address.
    if (!goesOn) teammates.clear()
    pendingStarts.clear()
    spawnEfforts.clear()
    spawnIsolations.clear()
    sharedAgents.clear()
    isolatedAgents.clear()
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
    isPaneOpen = true
    // Runs may have come and gone since the pane was last looked at: the ends of the run row are read anew.
    runEdge = { dir: '' }
    edgesAsked = ''
    const result = await next(e)
    await $.ui.invalidate('ui.render')
    return result
  })
  on('ui.close', { id: PANE }, async ($, e, next) => {
    isPaneOpen = isWatched = false
    const result = await next(e)
    talk = undefined  // nothing reads a conversation behind a closed pane
    await stop($)
    await stopLive($)
    await $.ui.invalidate('ui.render')
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.props.maxRows < 1) return next(e)
    // The terminal shows the shortcut for the run this conversation drives; Desktop also where the project had a run
    // to look at when the session began. A project Swarm never ran in shows nothing.
    if (!(await read($, run)) && (e.surface !== 'desktop' || !hadRun)) return next(e)
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
          <Button key="swarm-board-from-reply" variant="secondary" label="Open Swarm board" onPress={() => void openBoard($).catch(() => undefined)} />
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
        <Text dimColor><Text weight="semibold">Swarm</Text>{` · ${heading}`}</Text>
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

    const activeMembers = shown.members.filter(m => m.role !== 'coordinator' && m.status !== 'killed').length

    return (
      <Box flexDirection="row" alignItems="center" columnGap={2} flexWrap="wrap" borderStyle="round" borderColor="subtle" paddingX={1}>
        <Text>
          <Text weight="semibold">Swarm</Text>
          {isShown && <Text>{`  ${shown.title}`}</Text>}
          {isShown && (
            <Text dimColor tabular>
              {` · ${shown.isClosed ? 'closed' : shown.isPaused ? `paused · ${counted(activeMembers, 'member')}` : counted(activeMembers, 'member')} · ${counted(shown.total ?? shown.posts.length, 'post')}`}
            </Text>
          )}
        </Text>
        <Button
          key="open-swarm"
          variant="primary"
          label="Open Swarm board"
          onPress={() => void openBoard($).catch(() => undefined)}
        />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown, Input } = $.ui.resolve(e)
    const HeaderArt = e.surface !== 'terminal' ? $.ui.resolve(e).Svg : undefined
    if (!isWatched) {
      // Looked at for the first time: the run to show is read now, not at the next poll.
      isWatched = true
      void refresh($)
    }
    const shown = await shownSwarm($)
    const error = await read($, loadError)
    if (e.props.placement === 'widget') {
      // Minimised: nothing of the pane is in view, so no live animation is started for it.
      isPaneOpen = false
      const active = shown.members.filter(member => member.status === 'working').length
      const coordinating = shown.members.filter(member => member.status === 'coordinating').length
      return (
        <Box flexDirection="row" columnGap={1} alignItems="center">
          <Text weight="semibold">Swarm board</Text>
          {shown.dir === '' ? (
            <Text dimColor>No swarm</Text>
          ) : shown.isClosed ? (
            <Text dimColor>Closed</Text>
          ) : shown.isPaused ? (
            <Text color="warning">Paused</Text>
          ) : active > 0 ? (
            <Text color="success" tabular>{`${active} working`}</Text>
          ) : coordinating > 0 ? (
            <Text color="claude" tabular>{`${coordinating} coordinating`}</Text>
          ) : null}
          {shown.dir !== '' && shown.attention.length > 0 && (
            <Text color="warning" tabular>{`${shown.attention.length} attention`}</Text>
          )}
        </Box>
      )
    }
    isPaneOpen = true
    // The run row's ends are read as the pane opens, so they are drawn as no control from the first look on.
    if (runEdge.dir !== shown.dir || runEdge.older === undefined || runEdge.newer === undefined) void learnEdges($, shown.dir)
    const current = await read($, tab)
    const now = HeaderArt ? await $.clock.now() : 0
    const mood = shown.mood ?? 'sleep'
    const hiveOffset = phase(e.surface + '-hive', shown.dir + '/' + mood, shown.dir ? 'header' : 'empty', now)
    const latest = shown.posts.at(-1)?.seq
    if (current !== 'graph' && clocks.get(e.surface + '-route')?.scene === shown.dir + '/' + latest) {
      phase(e.surface + '-route', shown.dir + '/' + latest, current, now)
    }
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
        <Box flexDirection="column" gap={1}>
          {HeaderArt && <HeaderArt key="hive" source={hiveArt('sleep', hiveOffset)} alt="Sleeping bees" width={88} height={44} />}
          <Text weight="semibold" color={error ? 'warning' : undefined}>{error || 'No swarm in this project'}</Text>
          {!error && <Text dimColor>Start one with /swarm:swarm and a task.</Text>}
        </Box>
      )
    }

    const inactive = new Set(
      shown.members
        .filter(m => ['waiting', 'not started', 'killed', 'closed'].includes(m.status))
        .map(m => m.name),
    )
    const hueOf = (name: string) => {
      const idx = shown.members.findIndex(m => m.name === name)
      return idx < 0 ? 'subtle' : HUES[idx % HUES.length]!
    }
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
    // A run looked at is read once, so what could not be read is read again only on a press, in place.
    const retry = browsed && <Button key="run-retry" plain label="Retry" onPress={() => reloadBrowsed($)} />
    const working = shown.members.filter(m => m.status === 'working').length
    const coordinating = shown.members.filter(m => m.status === 'coordinating').length
    const waiting = shown.members.filter(m => m.role !== 'coordinator' && m.status === 'waiting').length
    const failed = shown.members.filter(m => m.status === 'failed' || m.status === 'unreachable').length
    const stopped = shown.members.filter(m => m.status === 'stopped').length
    const tokens = shown.tokens
    const total = tokensUsed(tokens)
    const openPost = async (seq: number) => {
      let older: Post | undefined
      if (!shown.posts.some(post => post.seq === seq)) {
        try {
          const [board, saved] = await Promise.all([readBoard($, shown.dir), $.fs.read(`${shown.dir}/members.json`)])
          const roster = (JSON.parse(saved) as { members: Roster }).members
          older = parsePosts(board, roster).find(post => post.seq === seq)
          if (!older) {
            const shownOne = await boardCommand($, shown.dir, ['show', `--post=${seq}`, '--json']).catch(() => undefined)
            const rawOut = shownOne?.exitCode === 0 ? shownOne.stdout.trim() : ''
            if (rawOut.startsWith('{')) {
              const parsed = JSON.parse(rawOut) as Record<string, unknown> & Pick<Post, 'seq' | 'agent' | 'text' | 'time'> & { to?: string[] }
              older = {
                seq: Number(parsed.seq),
                ...postFields(parsed),
                agent: clean(String(parsed.agent)),
                time: clean(String(parsed.time)),
                text: clean(String(parsed.text)),
                to: (parsed.to ?? targets(String(parsed.text), roster, String(parsed.agent)).filter(n => n !== parsed.agent)).map(name => clean(String(name))),
              }
            } else if (rawOut) {
              const m = /^#(\d+)\s+(\d{2}:\d{2}:\d{2})\s+@(\S+)\s+->\s+([^\n]*)(?:\n([\s\S]*))?$/.exec(rawOut)
              if (m) {
                const body = clean((m[5] ?? '').split('\n').map(l => l.startsWith('  ') ? l.slice(2) : l).join('\n').trimEnd())
                const toRaw = (m[4] ?? '').trim()
                older = {
                  seq: Number(m[1]),
                  agent: m[3]!,
                  time: `0000-00-00T${m[2]}`,
                  to: toRaw === '-' || toRaw === '' ? [] : toRaw.split(/\s+/).map(s => s.replace(/^@/, '')),
                  text: body,
                }
              }
            }
          }
        } catch {
          // The board may have disappeared while this row was visible.
        }
        if (!older) {
          $.ui.toast(`Post #${seq} could not be loaded.`)
          return
        }
        if ((await shownSwarm($)).dir !== shown.dir) return
      }
      await stop($)
      await stopLive($)
      await update($, inspected, () => older ?? null)
      await update($, query, () => '')  // a filter left on the Board would hide the post
      await update($, latestOnly, () => false)
      await update($, earlier, () => 0)
      await update($, expanded, () => seq)
      await update($, tab, () => 'board')
    }

    // Every route as one line, busiest first: the terminal's graph, and a graph too dense or narrow to draw.
    const routeList = (isExpanded: boolean, quiet: ReadonlySet<string>, upTo = Infinity) => {
      const edges = new Map<string, number>()
      // Posts older than the ones kept still count, as they do in the diagram, and nobody is drawn addressing itself.
      // The same keys the diagram counts: a pair by name, a pair reached through @all, and a sender's @all posts.
      for (const [edge, count] of Object.entries({ ...shown.earlierEdges, ...Object.fromEntries(
        Object.entries(edgesOf(shown.posts.filter(one => one.seq <= upTo))).map(([key, more]) => [key, more + (shown.earlierEdges?.[key] ?? 0)])) })) {
        const [from = '', to = '', via] = edge.split('>')
        if (to === '@none' || from === to || (via && !isExpanded) || quiet.has(from) || quiet.has(to)) continue
        edges.set(to === '@all' ? `@${from} → @all` : `@${from} → @${to}${via ? ' (via @all)' : ''}`, count)
      }
      const sorted = [...edges.entries()].sort((a, b) => b[1] - a[1])
      // A short first page; the rest a page a press, in reach of the keyboard.
      const page = Math.min(rows, 12)
      const visibleEdges = sorted.slice(0, page * routePages)
      const unseen = sorted.length - visibleEdges.length
      const showPages = (pages: number) => { routePages = pages; $.ui.invalidate('ui.render') }
      const most = [...edges.values()].reduce((max, count) => Math.max(max, count), 1)
      const maxDigits = Math.max(1, ...visibleEdges.map(([, c]) => String(c).length))
      return edges.size === 0 ? (
        <Text dimColor>No mentions yet.</Text>
      ) : (
        <Box flexDirection="column">
          {visibleEdges.map(([edge, count]) => (
            <Text key={edge} tabular>
              <Text color="claude">
                {'█'.repeat(Math.max(1, Math.round((count / most) * 8))).padEnd(8, '░')}
              </Text>
              {` ${String(count).padStart(maxDigits, ' ')}  ${edge}`}
            </Text>
          ))}
          {unseen > 0 && <Text dimColor>{`… and ${unseen} more`}</Text>}
          {(unseen > 0 || routePages > 1) && (
            <Box flexDirection="row" gap="sm">
              {unseen > 0 && <Button key="routes-more" plain dimColor label={`Show ${Math.min(page, unseen)} more routes`} onPress={() => showPages(routePages + 1)} />}
              {routePages > 1 && <Button key="routes-fewer" plain dimColor label="Show fewer routes" onPress={() => showPages(1)} />}
            </Box>
          )}
        </Box>
      )
    }

    let body
    if (current === 'board') {
      const open = await read($, expanded)
      const openDiff = await read($, diff)
      const collapsed = await read($, latestOnly)
      const more = await read($, earlier)
      const preview = (post: Post) => clip(chipped(post))
      // Fill the pane from the newest post back, so the feed follows the board.
      const rawQuery = await read($, query)
      const wanted = rawQuery.trim().toLowerCase()
      const inspectedPost = await read($, inspected)
      const available = inspectedPost && !shown.posts.some(post => post.seq === inspectedPost.seq) ? [inspectedPost, ...shown.posts] : shown.posts
      const terms = (wanted.match(/(?:kind:)?not\s+(?:passed|verified)(?!\S)|\S+/g) ?? []).map(t => t.replace(/\s+/g, ' '))
      // Whom a post is for: the members it reached, and the names it mentions. `all` and a group are only ever
      // in the text: `to` holds the members they stood for.
      const reaches = (post: Post, who: string) => post.to.some(name => name.toLowerCase() === who) || mentions(post.text).has(who)
      const matchesTerm = (post: Post, term: string): boolean => {
        if (term.startsWith('from:')) {
          const who = term.slice(5).replace(/^@/, '')
          return who !== '' && post.agent.toLowerCase() === who
        }
        if (term.startsWith('to:')) {
          const who = term.slice(3).replace(/^@/, '')
          return who !== '' && reaches(post, who)
        }
        if (term.startsWith('@') && term.length > 1) {
          const who = term.slice(1)
          return post.agent.toLowerCase() === who || reaches(post, who)
        }
        if (/^#\d+$/.test(term)) {
          return post.seq === Number(term.slice(1))
        }
        const kind = kindOf(post.text)?.label.toLowerCase()
        if (term.startsWith('kind:')) {
          const k = term.slice(5).replace(/[-_]/g, ' ')
          return k !== '' && kind === k
        }
        if ((term === 'passed' || term === 'verified') && kind === `not ${term}`) return false
        if (kind && kind === term) return true
        return post.text.toLowerCase().includes(term) || post.agent.toLowerCase().includes(term) ||
          post.to.some(name => name.toLowerCase().includes(term))
      }
      const matching = terms.length === 0
        ? available
        : available.filter(post => terms.every(term => matchesTerm(post, term)))
      const search = (
        <Box flexDirection="row" alignItems="center" columnGap={1} flexWrap="wrap" marginTop={1}>
          <Input
            key="board-search"
            placeholder="Filter: text, @name, from:, to:, kind:"
            value={rawQuery}
            submitLabel="Filter"
            onSubmit={value => update($, query, () => value.trim())}
          />
          {terms.length > 0 && (
            <Button key="board-search-clear" plain label={`Clear filter (${matching.length} of ${available.length})`} onPress={() => update($, query, () => '')} />
          )}
        </Box>
      )
      // The person posts in the coordinator's name, and the coordinator is told with its next tool call.
      const compose = isDriven && (
        <Box flexDirection="row" alignItems="center" marginTop={1}>
          <Input
            key="board-compose"
            placeholder="Post to the board as the coordinator"
            value=""
            submitLabel="Post"
            onSubmit={async value => {
              const text = value.trim()
              if (text === '' || shown.dir !== await read($, run)) return
              const posted = await boardCommand($, shown.dir, ['post', 'coordinator'], `(from the user, in the pane)\n${text}`)
                .catch(error => ({ exitCode: 1, stdout: '', stderr: String(error) }))
              if (posted.exitCode !== 0) {
                $.ui.toast(`Swarm: ${clean(posted.stderr).trim() || 'the board\'s post command failed'}`)
                return
              }
              const seq = /^posted #(\d+)/m.exec(posted.stdout)?.[1]
              const note = seq
                ? `The user posted #${seq} to the board in your name from the Swarm pane. Read it before going on: the board's show --post=${seq}`
                : 'The user posted to the board in your name from the Swarm pane. Read the newest posts with the board\'s show before going on.'
              // Mid-turn it rides on the next tool result. An idle coordinator is in no post's `to`, so nothing
              // would ever wake it to what was said in its name: it is told now.
              if (isCoordinatorBusy) notesOwed.push(note)
              else await submitHeld($, `Swarm: ${note}`, () => { notesOwed.push(note) })
              await refresh($)
            }}
          />
        </Box>
      )
      const selected = !collapsed && open > 0 ? matching.find(post => post.seq === open) : undefined
      // Opens one post whole, or closes it again.
      const toggle = async (seq: number) => {
        const nextSeq = open === seq ? 0 : seq
        await update($, expanded, () => nextSeq)
        if (inspectedPost && inspectedPost.seq !== nextSeq) await update($, inspected, () => null)
      }
      const selectedCost = selected ? 4 + estimateRows(chipped(selected, openedText(selected)), columns) : 0
      const fitted: Post[] = []
      let used = 0
      for (const post of [...matching].reverse()) {
        // The opened post takes the rows it really draws, so the posts around it are fitted to what is left.
        const text = post.seq === open ? chipped(post, openedText(post)) : preview(post)
        const cost = 4 + estimateRows(text, columns)
        const reserve = selected && !fitted.some(p => p.seq === open) && post.seq !== open ? selectedCost : 0
        if (fitted.length > 0 && used + cost + reserve > rows) break
        fitted.unshift(post)
        used += cost
      }
      // A drawing over 100,000 characters is refused, and a post costs up to its clip and its frame: so many are drawn at once.
      const DRAWN = 100
      const visible = matching.slice(collapsed && terms.length === 0 ? -1 : -Math.min(DRAWN, Math.max(1, fitted.length + more)))
      const isFull = visible.length >= DRAWN
      if (selected && !visible.some(post => post.seq === open)) {
        visible.unshift(selected)
      }
      const older = matching.length - visible.length
      body =
        visible.length === 0 ? (
          <Box flexDirection="column">
            {compose}
            {shown.posts.length > 0 && search}
            <Box marginTop={1}>
              <Text dimColor>{shown.posts.length > 0 ? 'No posts match the filter.' : browsed?.boardUnavailable ? 'Board data unavailable: its board could not be read.' : 'No posts yet.'}</Text>
            </Box>
            {browsed?.boardUnavailable && retry}
          </Box>
        ) : (
          <Box flexDirection="column" gap={1}>
            {compose}
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
            {(!collapsed || terms.length > 0) && older > 0 && isFull && (
              <Text dimColor>{`Showing the newest ${visible.length} of ${matching.length}. Narrow the filter to reach earlier posts.`}</Text>
            )}
            {(!collapsed || terms.length > 0) && older > 0 && !isFull && (
              <Button
                key="earlier-posts"
                plain
                dimColor
                label={`↑ Show earlier posts (${older})`}
                onPress={() => update($, earlier, count => count + 6)}
              />
            )}
            {visible.map(post => {
              const kind = verdictOf(post)
              const time = postTime(post)
              const hasMore = chipped(post).length > CLIP
              const isOpen = post.seq === open
              const canViewGraph = e.surface !== 'terminal' && shown.posts.some(p => p.seq === post.seq)
              // Both ways a post arrives (the board's lines, and `show --json` for one opened from Attention) keep only full ids.
              const revision = kind?.label === 'READY' ? post.revision : undefined
              const since = revision !== undefined ? post.base : undefined
              const isDiffOpen = revision !== undefined && openDiff.seq === post.seq
              // A post opened from Attention that the pane no longer keeps: it stays until it is dismissed.
              const isInspected = inspectedPost?.seq === post.seq && !shown.posts.some(p => p.seq === post.seq)

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
                      {post.to.length > 0 && (
                        <Text dimColor>{`→ ${(isOpen ? post.to : post.to.slice(0, 2)).map(name => `@${name}`).join(' ')}`}</Text>
                      )}
                      {/* The rest of the recipients, on a press: an opened post names them all. */}
                      {post.to.length > 2 && !(isOpen && hasMore) && (
                        <Button key={`recipients-${post.seq}`} plain dimColor label={isOpen ? 'Show fewer' : `+${post.to.length - 2} more`} onPress={() => toggle(post.seq)} />
                      )}
                      {kind !== undefined && (
                        <Text weight="semibold" color={kind.color}>{kind.covered?.length ? `${kind.label} · ${kind.covered.map(name => `@${name}`).join(' ')}` : kind.label}</Text>
                      )}
                    </Box>
                    <Text dimColor tabular>{`#${post.seq}${time ? ` · ${time}` : ''}`}</Text>
                  </Box>
                  {isOpen && kind?.covered && (
                    <Text color="warning">{`Partial pass of ${kind.covered.map(name => `@${name}`).join(', ') || 'some workers'}: their pieces only, not the run's pass.`}</Text>
                  )}
                  <Markdown text={formatMarkdown(isOpen ? chipped(post, openedText(post)) : preview(post))} />
                  {isDiffOpen && diffParts(openDiff.text)[0] !== '' && <Text key={`diff-scope-${post.seq}`} dimColor>{diffParts(openDiff.text)[0]}</Text>}
                  {isDiffOpen && <Markdown key={`diff-text-${post.seq}`} text={diffParts(openDiff.text)[1]!} />}
                  {(hasMore || canViewGraph || isInspected || revision !== undefined) && (
                    <Box flexDirection="row" gap="sm" flexWrap="wrap">
                      {isInspected && (
                        <Button
                          key={`dismiss-${post.seq}`}
                          plain
                          dimColor
                          label="✕ Dismiss"
                          onPress={async () => {
                            await update($, inspected, () => null)
                            if (open === post.seq) await update($, expanded, () => 0)
                          }}
                        />
                      )}
                      {hasMore && (
                        <Button
                          key={`more-${post.seq}`}
                          plain
                          dimColor
                          onPress={() => toggle(post.seq)}
                          label={isOpen ? '▴ Show less' : '▾ Show more'}
                        />
                      )}
                      {revision !== undefined && (
                        <Button
                          key={`diff-${post.seq}`}
                          plain
                          dimColor
                          label={isDiffOpen ? '▴ Hide diff' : 'View diff'}
                          onPress={() => isDiffOpen ? update($, diff, () => NO_DIFF) : showDiff($, shown.dir, post.seq, revision, since, since ? post.except : undefined)}
                        />
                      )}
                      {canViewGraph && (
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
                  )}
                </Box>
              )
            })}
          </Box>
        )
    } else if (current === 'attention') {
      // A kind this version does not know is still shown, uncoloured.
      const tone = (kind: string) =>
        ['unreachable', 'ignored', 'stale', 'rework', 'retired-running', 'conflict'].includes(kind) ? 'error' : kind === 'paused' || kind === 'member_paused' ? 'suggestion'
          : ['unread', 'review', 'question', 'unstarted', 'blocked', 'spend', 'silent', 'loop'].includes(kind) ? 'warning' : undefined
      const isSpent = shown.budget > 0 && total >= shown.budget
      const ask = (text: string) => submitHeld($, text, () => $.ui.toast('Swarm could not send that request to the coordinator.'))
      const seenKeys = new Map<string, number>()
      // The live run's report is read again on the next poll; a browsed run's only on Retry.
      body = shown.attention.length === 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>{!shown.attentionUnavailable ? 'Nothing needs attention.' : browsed ? 'Attention details unavailable for this run.' : 'Attention details unavailable. Swarm will retry.'}</Text>
          {browsed?.boardUnavailable && <Text dimColor>Board data unavailable: its board could not be read.</Text>}
          {(browsed?.boardUnavailable || shown.attentionUnavailable) && retry}
        </Box>
      ) : (
        <Box flexDirection="column" gap={1} marginTop={1}>
          {shown.attention.map(item => {
            const baseKey = `${item.kind}-${item.member}-${item.seq}`
            const count = seenKeys.get(baseKey) ?? 0
            seenKeys.set(baseKey, count + 1)
            const itemKey = count === 0 ? baseKey : `${baseKey}-${count}`
            // Every item can be put in front of the coordinator: the kinds below have a request of their own, a
            // paused run waits for the person, and an ignored member is retried on the board itself.
            const isPlainAsk = !['unreachable', 'review', 'rework', 'paused', 'ignored', 'member_paused'].includes(item.kind)
            const hasActions = item.seq > 0 || (isDriven && (
              item.kind === 'unreachable' ||
              item.kind === 'member_paused' ||
              (item.kind === 'paused' && isSpent) ||
              item.kind === 'ignored' ||
              item.kind === 'review' ||
              item.kind === 'rework' ||
              isPlainAsk
            ))
            return (
            <Box
              key={`attention-${itemKey}`}
              flexDirection="column"
              borderStyle="round"
              borderColor={tone(item.kind) ?? 'subtle'}
              borderDimColor
              paddingX={1}
            >
              <Text>
                <Text weight="semibold" color={tone(item.kind)}>{String(item.kind || 'note').toUpperCase()}</Text>
                <Text>{`  ${item.text}`}</Text>
              </Text>
              {hasActions && (
              <Box flexDirection="row" gap="sm" flexWrap="wrap">
                {item.seq > 0 && (
                  <Button
                    key={`attention-open-${itemKey}`}
                    plain
                    label={`Open post #${item.seq}`}
                    onPress={() => openPost(item.seq)}
                  />
                )}
                {item.kind === 'unreachable' && isDriven && (
                  <Button
                    key={`attention-recover-${itemKey}`}
                    plain
                    label="Ask coordinator to recover"
                    onPress={() => ask(`Swarm: Recover @${item.member}\n@${item.member} is unreachable (board post #${item.seq}). Run the board's retry command for it once. If it is still unreachable after that, use the board's replace command to register a successor with its brief and history, then spawn the successor.`)}
                  />
                )}
                {item.kind === 'paused' && isSpent && isDriven && (
                  <Button
                    key={`attention-budget-${itemKey}`}
                    plain
                    label="+500k & resume"
                    onPress={() => control($, shown.dir, ['limit', `budget=${Math.max(shown.budget, total) + 500_000}`], ['resume'])}
                  />
                )}
                {item.kind === 'member_paused' && isDriven && (
                  <Button key={`attention-resume-${itemKey}`} plain label="+250k & resume"
                    onPress={async () => {
                      // The board refuses a resume while the member is at its budget, so the two go together.
                      const id = shown.members.find(member => member.name === item.member)?.id
                      const used = shown.tokens[id ? await digest(`swarm-agent:${id}`) : ''] ?? 0
                      await control($, shown.dir, ['member', item.member, `budget=${used + 250_000}`], ['resume', item.member])
                    }} />
                )}
                {item.kind === 'ignored' && isDriven && (
                  <Button key={`attention-retry-${itemKey}`} plain label="Retry" onPress={() => control($, shown.dir, ['retry', item.member])} />
                )}
                {item.kind === 'review' && isDriven && (
                  <Button
                    key={`attention-review-${itemKey}`}
                    plain
                    label="Ask coordinator to review"
                    onPress={() => ask(`Swarm: Review @${item.member}'s finding\n@${item.member}'s finding awaits your review (board post #${item.seq}). Read it with the board's show --post=${item.seq}, then accept it with the board's confirm command or answer @${item.member} on the board.`)}
                  />
                )}
                {isPlainAsk && isDriven && (
                  <Button
                    key={`attention-ask-${itemKey}`}
                    plain
                    label={item.member === 'coordinator' ? 'Tell coordinator' : 'Ask coordinator to handle'}
                    onPress={() => ask(`Swarm: Needs your attention\n${item.text}${item.seq ? ` It is board post #${item.seq}: read it with the board's show --post=${item.seq}.` : ''} Deal with it now, or tell the user why it stands.`)}
                  />
                )}
                {item.kind === 'rework' && isDriven && (
                  <Button
                    key={`attention-rework-${itemKey}`}
                    plain
                    label="Ask coordinator to intervene"
                    onPress={() => ask(`Swarm: @${item.member} keeps failing verification\n@${item.member} has not passed verification several times in a row${item.seq ? ` (board post #${item.seq})` : ''}. Read its NOT PASSED posts with the board's show command, then decide: give it a narrower brief, replace it, or pause the run and ask the user.`)}
                  />
                )}
              </Box>
              )}
            </Box>
            )
          })}
        </Box>
      )
    } else if (current === 'members' && talk?.dir === shown.dir) {
      const open = talk
      const member = memberOf(open.name)
      // Filled from the newest row back, as the Board is, so what the agent does now is in view.
      let fitted = 0
      let used = 0
      for (const row of [...open.rows].reverse()) {
        const cost = 2 + estimateRows(row.text, columns)
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
          <Text size="caption" weight="semibold" dimColor>{index === 0 ? 'Prompt' : 'Message'}</Text>
          <Markdown text={formatMarkdown(row.text)} />
        </Box>
      ) : (
        <Markdown key={`talk-${index}`} text={row.text} />
      )
      body = (
        <Box flexDirection="column" marginTop={1} gap={1}>
          <Box flexDirection="row" alignItems="center" columnGap={1} flexWrap="wrap">
            <Button key="talk-back" plain label="‹ Members" onPress={() => closeTalk($)} />
            <Text wrap="truncate-end">
              <Text weight="semibold" color={hueOf(open.name)}>@{open.name}</Text>
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
                // By what it shows, not by identity: a poll since this was drawn may have put a new object in its place.
                if (talk && talk.dir === open.dir && talk.agentId === open.agentId) talk = { ...talk, more: talk.more + 6 }
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
        const isBroken = ['failed', 'unreachable', 'stopped'].includes(member.status)
        const plan = [
          member.owns === '' ? '' : `owns ${member.owns}`,
          member.depends.length === 0 ? '' : `after ${member.depends.map(name => `@${name}`).join(', ')}`,
        ].filter(part => part !== '').join(' · ')

        // The coordinator's conversation is this session's main one, and only for a run it drives or drove.
        const canOpenTalk = member.role === 'coordinator' ? hasMainTalk : member.id !== undefined && member.status !== 'killed'
        const hasActions = canOpenTalk || member.posts > 0 || member.role === 'coordinator'
        const summaryLines = last ? bodyOf(last).split('\n').slice(0, kindOf(last.text) ? 2 : 1).filter(l => l.trim() !== '').join(' · ') : ''

        // Every card has the same rows in the same order, so a column of them can be scanned: who it is and
        // what it runs on, then how it is doing, then what it waits for, owns and last said.
        return (
          <Box key={member.name} flexDirection="column" borderStyle="round" borderColor={hueOf(member.name)} borderDimColor paddingX={1}>
            <Text strikethrough={member.status === 'killed'} wrap="truncate-end">
              <Text weight="semibold" color={hueOf(member.name)}>@{member.name}</Text>
              <Text dimColor>
                {`  ${[member.role === 'coordinator' ? '' : member.type, `${member.model} ${member.effort}`.trim()].filter(part => part !== '').join(' · ')}`}
              </Text>
            </Text>
            <Box flexDirection="row" alignItems="center" columnGap="xs">
              {member.status === 'closed' ? null : HeaderArt ? <HeaderArt source={statusDot(member.status)} alt={member.status} width={12} height={12} /> :
              <Text color={statusColor}>{isBroken ? '!' : ['killed', 'not started'].includes(member.status) ? '○' : '●'}</Text>}
              <Text tabular wrap="truncate-end">
                <Text dimColor>{`${member.status} · ${counted(member.posts, 'post')}`}</Text>
                {spentBy(member) > 0 && <Text dimColor>{` · ${compact(spentBy(member))} tokens`}</Text>}
                {member.unread > 0 && member.status !== 'killed' && (
                  <Text weight="semibold" color="warning">{` · ${member.unread} unread`}</Text>
                )}
              </Text>
            </Box>
            {member.detail !== '' && (
              <Text color={member.status === 'closed' ? undefined : isBroken || member.status === 'killed' ? 'error' : member.detail === 'reported ready' ? 'success' : 'warning'} wrap="truncate-end">{member.detail}</Text>
            )}
            {member.status !== 'killed' && plan !== '' && <Text dimColor wrap="truncate-end">{plan}</Text>}
            {last !== undefined && (
              <Text dimColor tabular wrap="truncate-end">
                {`#${last.seq}${summaryLines ? `  ${summaryLines}` : ''}`}
              </Text>
            )}
            {hasActions && (
              <Box flexDirection="row" gap="sm" flexWrap="wrap">
                {canOpenTalk && (
                  <Button key={`view-${member.name}`} plain dimColor label="Open conversation" onPress={async () => { if (!(await viewAgent($, member))) await feedOf(member.name) }} />
                )}
                {member.posts > 0 && (
                  <Button key={`feed-${member.name}`} plain dimColor label="Posts" onPress={() => feedOf(member.name)} />
                )}
                {member.role === 'coordinator' && !hasMainTalk && <Text dimColor>Its conversation is not available here.</Text>}
              </Box>
            )}
          </Box>
        )
      }
      const hasMainTalk = await drivesHere($, shown.dir)
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
        ['Needs attention', shown.members.filter(m => ['failed', 'unreachable', 'stopped'].includes(m.status))],
        ['Active', shown.members.filter(m => ['working', 'coordinating'].includes(m.status))],
        ['Standing by', shown.members.filter(m => ['waiting', 'not started'].includes(m.status) && !(hiding && inactive.has(m.name)))],
        ['At close', hiding ? [] : shown.members.filter(m => m.status === 'closed')],
        ['Retired', hiding ? [] : shown.members.filter(m => m.status === 'killed')],
      ]
      const visibleGroups = groups.filter(([, list]) => list.length > 0)
      body = (
        <Box flexDirection="column" marginTop={1}>
          <Box flexDirection="row" justifyContent="flex-end">{inactiveToggle(inactive.size)}</Box>
          {visibleGroups.length === 0 && shown.members.length > 0 ? (
            <Box marginTop={1}>
              <Text dimColor>All members are inactive.</Text>
            </Box>
          ) : (
            visibleGroups.map(([title, list]) => (
              <Box key={title} flexDirection="column" gap={1} marginTop={1}>
                <Text size="caption" weight="semibold" dimColor>{`${title} · ${list.length}`}</Text>
                {[...list].sort(byName).map(card)}
              </Box>
            ))
          )}
        </Box>
      )
    } else if (shown.posts.length === 0) {
      body = (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>{browsed?.boardUnavailable ? 'Board data unavailable: its board could not be read.' : 'No posts yet.'}</Text>
          {browsed?.boardUnavailable && retry}
        </Box>
      )
    } else if (e.surface !== 'terminal') {
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
      // A closed, paused or looked-at run moves only while it is replayed.
      const isLiveRun = !browsed && !shown.isClosed && !shown.isPaused
      const animate = playing || (isLiveRun && live && pulse === post.seq)
      const repeat = isLiveRun && index === shown.posts.length - 1 && !animate
      const isExpanded = await read($, expandAll)
      const hasBroadcast = shown.posts.some(isBroadcast) || Object.keys(shown.earlierEdges ?? {}).some(edge => edge.endsWith('>@all'))
      const isLiveVisible = live && isLiveRun
      const liveOffset = phase(e.surface + '-live', shown.dir, String(isLiveVisible), now)
      const statusSig = live && repeat ? shown.members.map(m => `${m.name}:${m.status}`).join(',') : ''
      const routeOffset = phase(e.surface + '-route', shown.dir + '/' + latest,
        [current, post.seq, animate, repeat, isExpanded, statusSig, ...hidden].join('/'), now)
      const postKind = verdictOf(post)
      const time = postTime(post)
      const strippedGraphBody = chipped(post)
      const drawnMembers = visibleMembers(shown, post.seq, hidden, live)
      // Names drawn smaller than this are not read, so the routes are listed instead. The pane gives its width in
      // columns only: pixels are estimated from them.
      const isLegible = labelPx(columns, drawnMembers) >= MIN_LABEL_PX
      const graph = isLegible ? drawGraph(shown, post.seq, hidden, animate, live, repeat, routeOffset, isExpanded) : undefined
      // The host refuses a longer source, and the whole pane with it: such a graph is listed too.
      const source = graph?.svg !== undefined && graph.svg.length <= SVG_LIMIT ? graph.svg : undefined
      const last = shown.posts.length - 1
      // A step that leads nowhere is text, not a control that does nothing.
      const step = (key: string, label: string, seq: number | undefined) => seq === undefined
        ? <Text key={key} dimColor>{label}</Text>
        : <Button key={key} plain onPress={() => seek($, seq)}>{label}</Button>
      body = (
        <Box flexDirection="column" marginTop={1} gap={1}>
          <Box flexDirection="row" justifyContent="space-between" flexWrap="wrap" columnGap={1}>
            {isLiveVisible ? (
              <Box flexDirection="row" alignItems="center" gap="xs">
                <Svg key="live-indicator" source={liveIndicator(liveOffset)} alt="Live activity" width={16} height={16} />
                <Text weight="semibold" color="success">Live</Text>
              </Box>
            ) : (
              <Box flexDirection="row" alignItems="center" gap="sm">
                <Text dimColor tabular>{live ? (shown.isPaused && !shown.isClosed ? 'Paused' : 'Latest post') : `Post ${index + 1} of ${shown.posts.length}`}</Text>
                {!live && (
                  <Button key="replay-live" plain label={shown.isClosed || browsed ? 'Latest' : 'Go live'} onPress={() => seek($, 0)} />
                )}
              </Box>
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
            <Text size="caption" weight="semibold" dimColor>Replay</Text>
            {step('replay-first', 'First', index > 0 ? shown.posts[0]!.seq : undefined)}
            {step('replay-back', '‹ Prev', index > 0 ? shown.posts[index - 1]!.seq : undefined)}
            {last > 0
              ? <Button key="replay-play" variant="primary" label={playing ? 'Pause' : 'Play'} onPress={() => play($)} />
              : <Text key="replay-play" dimColor>Play</Text>}
            {step('replay-next', 'Next ›', index < last ? shown.posts[index + 1]!.seq : undefined)}
          </Box>
          {source !== undefined ? (
            <Svg
              key="message-routes" source={source}
              width={1024}
              height={graphHeight(columns, drawnMembers)}
              alt={`Post ${post.seq} · @${post.agent}${post.to.length ? ` to ${post.to.map(name => `@${name}`).join(', ')}` : ' · no mentions'}. A mention graph of ${counted(drawnMembers.length, 'member')}: List the routes below for each one in words.`}
              isInteractive
            />
          ) : (
            <Box key="route-list" flexDirection="column" gap="xs">
              <Text dimColor>{isLegible ? 'Too many routes to draw at once, so they are listed.' : 'The pane is too narrow to draw this graph legibly, so its routes are listed.'}</Text>
              {routeList(isExpanded, hidden, post.seq)}
            </Box>
          )}
          {source !== undefined && (graph?.hidden ?? 0) > 0 && (
            <Text dimColor>{`${counted(graph?.hidden ?? 0, 'quieter route')} not drawn: one drawing holds only so many.`}</Text>
          )}
          {source !== undefined && <Text key="graph-key" size="caption" dimColor>{graph?.key}</Text>}
          {/* The host reads a drawing's alt and nothing inside it: the routes in words are one press away, in reach of the keyboard. */}
          {source !== undefined && (
            <Button key="graph-routes" plain dimColor label={routesListed ? 'Hide the route list' : 'List the routes'}
              onPress={() => { routesListed = !routesListed; routePages = 1; $.ui.invalidate('ui.render') }} />
          )}
          {source !== undefined && routesListed && <Box key="graph-route-list" flexDirection="column">{routeList(isExpanded, hidden, post.seq)}</Box>}
          <Box key="graph-members" flexDirection="row" gap="sm" flexWrap="wrap" alignItems="center">
            <Text dimColor>Feed of</Text>
            {shown.members.filter(member => !hidden.has(member.name) && member.posts > 0).map(member => (
              <Button key={`graph-feed-${member.name}`} plain label={`@${member.name}`} onPress={() => feedOf(member.name)} />
            ))}
          </Box>
          <Box key="graph-post" flexDirection="column" gap="xs" borderStyle="round" borderColor="subtle" borderDimColor paddingX={1}>
            <Box flexDirection="row" justifyContent="space-between" flexWrap="wrap" columnGap={1}>
              <Text wrap="wrap">
                <Text weight="semibold" color={hueOf(post.agent)}>@{post.agent}</Text>
                <Text dimColor>{post.to.length ? ` → ${post.to.map(name => `@${name}`).join(' ')}` : ' · no mentions'}</Text>
                {postKind !== undefined && (
                  <Text weight="semibold" color={postKind.color}>{` · ${postKind.covered?.length ? `${postKind.label} of ${postKind.covered.map(name => `@${name}`).join(', ')}` : postKind.label}`}</Text>
                )}
              </Text>
              <Text dimColor tabular>{`#${post.seq}${time ? ` · ${time}` : ''}`}</Text>
            </Box>
            <Markdown text={formatMarkdown(detailsOpen ? chipped(post, openedText(post)) : clip(strippedGraphBody))} />
            {strippedGraphBody.length > CLIP && (
              <Button
                key="graph-post-details"
                plain
                dimColor
                label={detailsOpen ? '▴ Show less' : '▾ Show more'}
                onPress={() => update($, expanded, seq => seq === post.seq ? 0 : post.seq)}
              />
            )}
          </Box>
        </Box>
      )
    } else {
      const isExpanded = await read($, expandAll)
      const hasBroadcast = shown.posts.some(isBroadcast) || Object.keys(shown.earlierEdges ?? {}).some(edge => edge.endsWith('>@all'))
      // As in the diagram: the coordinator is never hidden for being idle.
      const hideable = [...inactive].filter(name => memberOf(name)?.role !== 'coordinator')
      body = (
        <Box flexDirection="column" marginTop={1} gap={1}>
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
          {routeList(isExpanded, new Set(hiding ? hideable : []))}
        </Box>
      )
    }

    // Two lines of the heading's column: the pane's width less the hive's, at about 1.25 columns a heading character.
    const titleRoom = 2 * Math.max(12, Math.floor((columns - (HeaderArt ? (columns < 48 ? 8 : 11) : 0)) / 1.25))
    const isTitleCut = shown.title.length > titleRoom
    const activeSummary = [
      coordinating > 0 ? `${coordinating} coordinating` : '',
      `${working} working`,
      `${waiting} waiting`,
    ].filter(Boolean).join(' · ')

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" alignItems="center" columnGap={1}>
          {/* A narrow pane gives the title the hive's room. The host clamps no lines, so a title longer than two lines of
              its column is cut at a word, and the whole of it is one press away. */}
          {HeaderArt && <HeaderArt key="hive" source={hiveArt(mood, hiveOffset)} alt={`Swarm hive: ${shown.mood ?? 'sleep'}`} width={columns < 48 ? 56 : 88} height={columns < 48 ? 28 : 44} />}
          <Box flexDirection="column" flexShrink={1}>
            <Text size="heading" weight="semibold" wrap="wrap">{isTitleCut && titleOpen !== shown.dir ? clip(shown.title, titleRoom) : shown.title}</Text>
            {isTitleCut && (
              <Button key="title-more" plain dimColor label={titleOpen === shown.dir ? 'Show less of the title' : 'Show the whole title'}
                onPress={() => { titleOpen = titleOpen === shown.dir ? '' : shown.dir; $.ui.invalidate('ui.render') }} />
            )}
            <Text dimColor tabular wrap="truncate-end">
              {shown.isClosed ? 'Closed' : shown.isPaused ? 'Paused' : activeSummary}
              {!shown.isClosed && failed > 0 && <Text color="error">{` · ${failed} failed`}</Text>}
              {!shown.isClosed && stopped > 0 && <Text color="error">{` · ${stopped} stopped`}</Text>}
              {` · ${counted(shown.total ?? shown.posts.length, 'post')}`}
              {total > 0 ? ` · ${compact(total)}${shown.budget > 0 ? ` of ${compact(shown.budget)}` : ''} tokens` : ''}
            </Text>
          </Box>
        </Box>
        {error && <Text color="warning">{error}</Text>}
        <Box flexDirection="row" gap="sm" flexWrap="wrap" alignItems="center">
          <Text size="caption" weight="semibold" dimColor>Run</Text>
          {/* At an end of the history the list showed, the step is text, as a replay step that leads nowhere is. */}
          {runEdge.dir === shown.dir && runEdge.older === false
            ? <Text key="run-prev" dimColor>‹ Prev run</Text>
            : <Button key="run-prev" plain dimColor label="‹ Prev run" onPress={() => browse($, 1)} />}
          {runEdge.dir === shown.dir && runEdge.newer === false
            ? <Text key="run-next" dimColor>Next run ›</Text>
            : <Button key="run-next" plain dimColor label="Next run ›" onPress={() => browse($, -1)} />}
          <Button key="run-export" plain dimColor label="Export MD" onPress={() => exportRun($, shown.dir)} />
          {isDriven && (
            <Button
              key="run-pause"
              plain
              label={shown.isPaused ? 'Resume run' : 'Pause run'}
              onPress={() => control($, shown.dir, shown.isPaused ? ['resume'] : ['pause', 'paused from the pane'])}
            />
          )}
          {browsed && <Text weight="semibold" color="warning">Not the live run · read-only</Text>}
          {browsed && <Button key="run-live" plain label="Back to live run" onPress={() => browse($, 0)} />}
        </Box>
        <Box flexDirection="row" gap="xs" flexWrap="wrap" marginTop={1}>
          {TABS.map((name, tabIdx) => (
            <Button
              key={`tab-${name}`}
              hotkey={String(tabIdx + 1)}
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
