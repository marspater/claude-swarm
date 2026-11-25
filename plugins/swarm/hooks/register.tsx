// The Swarm pane and its session hooks. board.py owns the board files.
import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, Register, SessionMessage, Timer, ToolCallResult } from 'claude-code'

import type { Member, Post, Swarm, Tab } from '../types'
import { COORDINATOR_READ, RUN, boardCalls, type ParsedBoardCall, runsNamed, scanShell, shellWords, splitShellSegments, substitutions, unwrap, wakeMessage, wakeSequence, withoutRedirects } from './command'
import { actsAsAnother, blocksRelativeBoardLimit, commitsInSharedCheckout, hasHiddenBoardLimit, normalizePath, resolveRealPath, waitsOnLooseMatch } from './guard'
import { DEFAULT_EFFORT, DEFAULT_MODEL, LATEST, SPECIALISTS, SWARM_AGENTS, advisorBarred, familyOf, latestOf, sizedEffort } from './models'
import { CONTEXT_EARLY, CONTEXT_STOP, END, KEPT, advisorSpent, budgetOf, contextState, findAgent, heldAt, isWindingDown, ledger, memberNamed, mentions, owedOf, parse, parsePosts, postFields, targets, tokensUsed, type BudgetState, type Report, type Roster } from './roster'
import { CLIP, bodyOf, chipped, clean, clip, compact, fenceAfter, fenced, figuresIn, hasQuestion, head, kindOf, openedText, pointsAt, repeatsPosts, verdictOf, type Fence } from './text'
import { hairlineDivider, liveIndicator, memberAccents, progressBar, progressUnits, semanticIcon, statusDot, statusInk, swarmEmblem, type BarTone, type EmblemState } from './palette'
import { MEMBER_BEE_SIZE, hiveArt, memberBee, toolMood, toolSummary, type Mood } from './hive'
import { MIN_LABEL_PX, SVG_LIMIT, drawGraph, earlierEdgesOf, edgesOf, graphHeight, isBroadcast, labelPx, pairOf, visibleMembers } from './graph'

const PANE = 'swarm'
const TITLE = 'Swarm Board'
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
const INACTIVE_STATUSES = new Set(['waiting', 'not started', 'killed', 'closed'])
const isMemberBudgetPaused = (m: Member) => m.isPaused === true || m.detail === 'its token budget is spent'
const isMemberZombie = (m: Member) => m.isZombie === true || (m.status === 'killed' && m.detail !== '')
const needsMemberAttention = (m: Member) =>
  ['failed', 'unreachable', 'stopped'].includes(m.status) || isMemberBudgetPaused(m) || isMemberZombie(m)
const inactiveOf = (members: Swarm['members']) =>
  new Set(members.filter(m => INACTIVE_STATUSES.has(m.status) && !needsMemberAttention(m)).map(m => m.name))

// Every new graph source reloads the host's sandboxed frame, and members report statuses many times a second.
// The live graph takes new statuses with a new frame (another post, or play turning into the loop), or once
// STATUS_SETTLE_MS passed since it last took them with no packet in flight; a trailing redraw takes what was held.
const STATUS_SETTLE_MS = 2600
let heldStatuses: { frame: string; at: number; statuses: Map<string, string> } | undefined
let statusTimer: Timer | undefined

function clearHeldStatuses(): void {
  statusTimer?.cancel()
  statusTimer = undefined
  heldStatuses = undefined
}

// Cached drawGraph() result so interacting with Show more, List the routes, or Feed of returns the exact same
// SVG source & alt and Desktop's reconciler preserves the sandboxed <iframe> via isEqualNode with zero reload.
let graphCache: { key: string; graph: ReturnType<typeof drawGraph>; source: string | undefined } | undefined
function clearGraphCache(): void {
  graphCache = undefined
}

function settledStatuses($: EngineInterface, shown: Swarm, frame: string, isMoving: boolean, now: number): Swarm {
  const statuses = new Map(shown.members.map(m => [m.name, m.status]))
  const held = heldStatuses
  const isSame = held !== undefined && held.statuses.size === statuses.size &&
    [...statuses].every(([name, status]) => held.statuses.get(name) === status)
  if (!held || held.frame !== frame || (!isSame && !isMoving && now - held.at >= STATUS_SETTLE_MS)) {
    heldStatuses = { frame, at: now, statuses }
    return shown
  }
  if (isSame) return shown
  // A packet's end redraws by itself; the timer is the fallback if it never does.
  const wait = Math.max(50, isMoving ? STATUS_SETTLE_MS : held.at + STATUS_SETTLE_MS - now)
  statusTimer ??= $.clock.after(wait, () => {
    statusTimer = undefined
    void $.ui.invalidate('ui.render')
  })
  return { ...shown, members: shown.members.map(m => held.statuses.has(m.name) ? { ...m, status: held.statuses.get(m.name)! } : m) }
}

function emblemStateOf(shown: Swarm): EmblemState {
  if (shown.dir === '') return 'idle'
  if (shown.isClosed) return 'closed'
  if (shown.isPaused) return 'paused'
  if (shown.attention.length > 0) return 'attention'
  if (shown.members.some(m => m.status === 'working')) return 'working'
  if (shown.members.some(m => m.status === 'coordinating')) return 'coordinating'
  return 'idle'
}

function verdictIconOf(label: string): 'pass' | 'ready' | 'warn' | 'error' | 'info' {
  if (label === 'VERIFIED') return 'pass'
  if (label === 'READY') return 'ready'
  if (label === 'NOT PASSED' || label === 'NOT VERIFIED') return 'error'
  if (label === 'PARTIAL PASS' || label === 'Partial pass' || label === 'REVISE' || label === 'SHUTDOWN') return 'warn'
  return 'info'
}

function attentionIconOf(kind: string, tone: string | undefined): 'warn' | 'error' | 'paused' | 'info' {
  if (kind === 'paused' || kind === 'member_paused') return 'paused'
  if (tone === 'error') return 'error'
  if (tone === 'warning') return 'warn'
  return 'info'
}

const formatAttentionKind = (kind: string) => String(kind || 'note').replace(/[_-]+/g, ' ').toUpperCase()

function terminalStatusGlyph(status: string, isPaused = false): string {
  if (isPaused && !['killed', 'closed', 'failed', 'unreachable', 'stopped'].includes(status)) return '‖'
  if (status === 'coordinating') return '◆'
  if (status === 'working') return '●'
  if (status === 'failed') return '✕'
  if (status === 'unreachable') return '!'
  if (status === 'stopped') return '■'
  return '○'
}

const utf8Encoder = new TextEncoder()
const byteLength = (text: string) => utf8Encoder.encode(text).length

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
const history = atom({ plugin: 'swarm', key: 'history' } as const, null as { dir: string; posts: Post[] } | null)
let boardNavigation = 0
// The newest diff asked for: an older one that loads after it is dropped, not shown over it.
let diffAsked = 0
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
// Lightweight in-flight indicators for async pane actions.
let loadingDiffSeq = 0
// The request that shows each, 0 for none: one a navigation or a newer request made stale shows nothing, and its end
// clears only its own.
let loadingHistory = 0
let exportingRun = 0
let exportAsked = 0
let retryingRun = 0
// Whether the graph's routes are listed in words under the drawing, and how many pages of them are shown.
let routesListed = false
let routePages = 1
let routeRun = ''

// Roster order picks the member's hue across the board and cards.
const HUES = ['claude', 'suggestion', 'planMode', 'ide', 'merged', 'permission', 'remember', 'autoAccept'] as const

let player: Timer | undefined
let livePlayer: Timer | undefined
let playGen = 0

async function stop($: EngineInterface): Promise<void> {
  playGen++
  player?.cancel()
  player = undefined
  if (await read($, isPlaying)) await update($, isPlaying, () => false)
}

async function stopLive($: EngineInterface): Promise<void> {
  livePlayer?.cancel()
  livePlayer = undefined
  if ((await read($, livePulse)) !== 0) await update($, livePulse, () => 0)
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
        // Already on the latest post: keep livePulse steady in unified play-loop mode without reloading the iframe.
        livePlayer = undefined
        return
      }
      await update($, livePulse, () => next.seq)
      if (livePlayer === timer) {
        // Only schedule another step when a newer post is still queued behind `next`.
        if (posts.some(post => post.seq > next.seq)) scheduleLiveFrame($)
        else livePlayer = undefined
      }
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
let ownedPath = ''
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
// What /swarm-kill ended: its run, and the agents of the members it retired, whose hand-backs are dropped. While
// `killedRun` is set and no new /swarm:swarm came, the swarm skill's text is not given back to the conversation.
let killedRun = ''
let killedIds: ReadonlySet<string> = new Set()
// The agents a kill retired, as the board confirmed it: refused by the tool guard until another run is owned, whatever
// a poll that read the roster before the kill puts in `retired`.
const killConfirmed = new Set<string>()
// A kill that landed while the coordinator's turn ran: that turn's tool calls are refused, and the compaction, which
// cannot run mid-turn, waits for its end.
let isKillTurn = false
// Counts the coordinator's turns that ended, so a kill can tell whether the turn it landed in ended during its awaits.
let coordinatorTurnsEnded = 0
// Whether the project held a Swarm run when the session began: only then is the board offered unasked.
let hadRun = false
// The owned run while it is paused or over budget, and why: its members are refused their next tool call.
let halted: { dir: string; why: string } | undefined
// What each turn's model steps have been charged so far, so its end charges only what no step reported.
const stepped = ledger()
// A turn's run, or the ownership generation in which an unresolved member or completion arrived. Kept past the
// turn's end so a replay cannot be attributed to a replacement run.
type TurnOwner = string | number
const turnRuns = new Map<string, TurnOwner>()
// What started each turn, for the usage detail: a notice the monitor submitted (named by `wakeNext` until the turn it
// starts), else the user; a member's first turn here, else a wake.
// ponytail: a member turn after the hooks reload counts as `start` once; record starts on the board if that skews a comparison.
const turnWakes = new Map<string, string>()
const wokenAgents = new Set<string>()
let wakeNext = ''
// The spend guards. `heldBy`: the context each member's last step read. `contextTold`: who was told of it, and at
// which stage. `windingDown`: the run that passed WIND_DOWN of its budget, and `windTold` the members told so.
const heldBy = new Map<string, number>()
const contextTold = new Map<string, 'note' | 'stop'>()
let windingDown = ''
// The budget the wind-down was told at: a raised one ends it, so 80% of the new budget is told again.
let windBudget = 0
const windTold = new Set<string>()
const postTold = new Set<string>()
function forgetSpend(): void {
  postTold.clear()
  heldBy.clear()
  contextTold.clear()
  windTold.clear()
  windingDown = ''
}
/** A run whose budget was changed and is no longer near it is no longer winding down. */
function windUp(dir: string, used: number, budget: number): void {
  if (windingDown !== dir || budget === windBudget || isWindingDown(used, budget)) return
  windingDown = ''
  windTold.clear()
}
const memberOfAgent = (agentId: string) => {
  const address = teammates.get(agentId)
  return Object.entries(ownedRoster?.members ?? {}).find(([, member]) => member.id !== undefined && (member.id === agentId || member.id === address))
}
/**
 * The refusal for a read-only member whose context passed the ceiling: its work is its report, and every further
 * step would read the whole context again. The board tool and its final report stay open; a writer is only told
 * (`spendNotes`), since a refused edit would leave its change half made.
 */
function contextCeiling(agentId: string, tool: string): string | undefined {
  if (tool === BOARD_TOOL) return undefined
  const found = memberOfAgent(agentId)
  if (!found || !SPECIALISTS.includes(found[1].profile ?? '')) return undefined
  // The hooks' own measure, or after a restart the board's: a resumed member is stopped at its first call, not its second.
  const held = Math.max(heldBy.get(agentId) ?? 0, Number(found[1].held) || 0)
  if (contextState(held) !== 'stop') return undefined
  if (contextTold.get(agentId) !== 'stop') {
    contextTold.set(agentId, 'stop')
    notesOwed.push(`@${found[0]} reached the context ceiling (${compact(held)} tokens, re-read at every step) and was told to report. Its report is partial: start a fresh member for what it lists as not covered, on a narrower scope.`)
  }
  return `Your context holds about ${compact(held)} tokens, past the ceiling of ${compact(CONTEXT_STOP)}: every further step reads all of it again, so this tool call was not run. Report now with the board tool: your findings, what you covered and what you did not cover. Then end your turn. The coordinator starts a fresh member for the rest.`
}
/** What a member is told once with a tool result: its context is getting dear, or the run is near its budget. */
function spendNotes(agentId: string): string[] {
  const notes: string[] = []
  // Every agent's context is measured, but only a member of the open run driven here is told anything: an ordinary
  // agent in a conversation with no run has no board to post on.
  if (ownedRoster?.closed !== false || !memberOfAgent(agentId)) return notes
  const held = heldBy.get(agentId) ?? 0
  // A read-only member is told early to post as it goes: what is on the board outlives a pause and the ceiling, and
  // costs no wake of its whole context to recover.
  const member = memberOfAgent(agentId)
  if (held >= CONTEXT_EARLY && !postTold.has(agentId) && SPECIALISTS.includes(member?.[1].profile ?? '')) {
    postTold.add(agentId)
    notes.push('Swarm: post each finding to the board as soon as its evidence stands, and each branch you have ruled out, with the board\'s post action; do not hold them for one final report. What is on the board survives a pause and the context ceiling. Close with ready when your piece is done.')
  }
  if (contextState(held) !== 'ok' && !contextTold.has(agentId)) {
    contextTold.set(agentId, 'note')
    notes.push(`Swarm: your context holds about ${compact(held)} tokens, and every step reads all of it again. Search and read slices, not whole files. Post what you have on the board as soon as it stands; at ${compact(CONTEXT_STOP)} a read-only member's tools stop and it must report.`)
  }
  if (windingDown !== '' && agentRuns.get(agentId) === windingDown && !windTold.has(agentId)) {
    windTold.add(agentId)
    notes.push('Swarm: the run has spent 80% of its token budget and pauses at 100%. Post what you have so far on the board now, saying what is covered and what is not; then go on only with what is cheap to finish.')
  }
  return notes
}
// The coordinator's own reading of the repository, per turn of an open, deployed run. Whatever it reads stays in its
// context and is read again at every later wake. Seen live: a coordinator that re-read the code behind five findings
// spent 0.78M tokens in one round. Two lookups a turn answer a quick question; more is a member's work.
// ponytail: counts Read, Grep and Glob only; a `cat` through Bash is not seen. Count Bash reads if that becomes the way round.
const COORDINATOR_READS = 2
/** A member's usage detail with the context it last held: every attempt at a report carries it, a retry too. */
function withHeld(detail: string, agentId: string | undefined): string {
  const held = agentId === undefined ? undefined : heldBy.get(agentId)
  return detail && held ? `${detail},${held}` : detail
}
let coordinatorReads = 0
async function coordinatorRead($: EngineInterface, tool: string, target: string): Promise<{ deny?: string }> {
  const roster = ownedRoster
  if (!['Read', 'Grep', 'Glob'].includes(tool) || !roster || roster.closed || halted) return {}
  if (!Object.entries(roster.members).some(([name, member]) => name !== 'coordinator' && Boolean(member.id) && member.killed !== '1')) return {}
  // The run's own folder and the plugin's skills are the coordinator's to read.
  if (target) {
    const cwd = await $.session.cwd()
    const [path, boardRoot, pluginRoot] = await Promise.all([
      resolveRealPath($, target.startsWith('/') ? target : `${cwd}/${target}`),
      resolveRealPath($, `${cwd}/.swarm`),
      $.plugin.root ? resolveRealPath($, $.plugin.root) : '',
    ])
    const requested = normalizePath(path)
    const within = (folder: string) => requested === folder || requested.startsWith(`${folder}/`)
    if (ownedRoster !== roster) return {}
    if (within(boardRoot) || (pluginRoot && within(pluginRoot))) return {}
  }
  coordinatorReads++
  if (coordinatorReads > COORDINATOR_READS) {
    return { deny: `Swarm: this is a third or later repository lookup in one turn, so it was not run. What you read stays in your context and is read again at every wake of the run. Judge a report by the evidence its post cites; for more, ask its author on the board, or give the question to a member (an explorer for "where is it").` }
  }
  return {}
}
function rememberTurnRun(turnId: string, owner: TurnOwner): void {
  turnRuns.set(turnId, owner)
  if (turnRuns.size > TURNS_KEPT) turnRuns.delete(turnRuns.keys().next().value!)
}
// Runs closed or deleted in this session: never billed again, and their pending retries are dropped without
// clearing completed-turn accounting records (`stepped`) or `turnRuns` associations.
const retiredRuns = new Set<string>()
// Per-turn serialization for concurrent turn.complete events, and turnIds currently being settled in the late retry loop.
const completing = new Map<string, Promise<void>>()
const settling = new Set<string>()
// How many earlier turns with a charge the board did not take are tried again at each turn's end.
const STRANDED_RETRIES = 8
let strandedFrom = 0
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
const pendingStarts = new Map<string, symbol>()
const cancelledSpawns = new Set<string>()
async function retireLateSpawn($: EngineInterface, id: string, teammate?: string): Promise<void> {
  cancelledSpawns.add(id)
  if (teammate) killedIds = new Set([...killedIds, teammate])
  // Keep the built-in stop call separate from the overloads for every installed MCP tool.
  await ($.tool.call as unknown as (input: { tool: 'TaskStop'; task_id: string }) => Promise<ToolCallResult>)(
    { tool: 'TaskStop', task_id: id },
  ).catch(() => undefined)
}
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
const KILL_DROP = 'Swarm: a member retired by /swarm-kill reported back; it was not passed on.'
// A task of this many characters is saved to a file, and this much of its start stays in the conversation.
const TASK_CHARS = 16_000
const TASK_HEAD = 4_000
const TASK_TAIL = 2_000
// The arguments of the last /swarm:swarm or /swarm:plan, as the command passed them on: past this length the copy
// the skill's text holds of them is replaced with a pointer to the command's own message, which holds them already.
const ARGS_DEDUP = 2_000
let commandArgs = ''
// A conversation this long is worth a word before a run starts in it: about half of what the coordinator's last run averaged.
const LONG_CONVERSATION = 120_000
// Posts the coordinator has opened with `show`: the board still counts them unread, but it is not told of them again.
const shownPosts = { through: 0, posts: new Set<number>() }
// The posts `owed` counts, and whether all of them are routine (see ROUTINE_GRACE_MS).
let owedSeqs: number[] = []
let isOwedRoutine = false
let bgWarnedRun = ''
let sawSwarmCommand = false
let pluginBoardScript = ''
let activeCoordinatorTurnId: string | undefined
let lastReport: { dir: string; report: Report } | undefined
// Counts the long tasks saved to files, so two saved in one second are two files.
let tasksSaved = 0
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
// The posts a fresh specialist is expected to see when it reads the board at startup.
const startupReads = new Map<string, { address: string; through: number }>()
// Specialists owed a mention with no agent address on the roster: named in a relay notice, never the cause of one.
let unaddressed: { name: string; seq: number }[] = []
let relayRun = ''
let relayHinted = ''
let relayPrompted = ''

const relayKey = (dir: string) => dir === relayRun && specialistWakes.length ? JSON.stringify([dir, specialistWakes, unaddressed]) : ''
const teammateName = (address: string) => address.split('@', 1)[0] || address
// Each line carries the address to send to, so the relay costs no `wake` lookup first.
const relayNotice = () => 'Relay these Swarm board wakes now with your own SendMessage tool, each to the recipient given, ' +
  'with the message copied exactly. Swarm records accepted delivery automatically. Continue if a recipient already read the mention.\n' +
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

function dropRunPending(dir: string): void {
  if (!dir) return
  retiredRuns.add(dir)
  for (const [turnId, owing] of stepped.owed()) {
    const under = turnRuns.get(turnId) ?? (owing.agentId ? agentRuns.get(owing.agentId) : undefined)
    if (under === dir) owing.pending.clear()
  }
}

function resetMonitoring(): void {
  ownedPath = ''
  retired = new Set()
  memberPaused = new Set()
  headNoted = ''
  ownedRoster = undefined
  rosterMiss = undefined
  moods.clear()
  generation++
  seen = seenBoard = seenRoster = activity = stalled = compactedRun = bgWarnedRun = ''
  boardStat = undefined
  snapshot = undefined
  lastReport = undefined
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
  startupReads.clear()
  relayRun = relayHinted = relayPrompted = ''
  windingDown = ''
  windTold.clear()
  clearGraphCache()
}

function boardCommand($: EngineInterface, directory: string, args: string[], stdin?: string) {
  return $.process.run(
    ['python3', `${$.plugin.root}/skills/swarm/scripts/board.py`, directory, ...args],
    stdin === undefined ? undefined : { stdin },
  )
}

// A read over 4 MiB is refused, and a long run's board grows past that. The board's own `tail` then gives the
// newest posts, so the pane and the stall check keep working; the wakes also ask the board what is owed (`owedBeforeTail`).
// The graph uses the recent window. The Board tab can load earlier pages by post number.
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

// One open, whether or not the pane is up: the host gives an open id its title and the focus again, never a second
// pane. It used to close the pane first and reopen it. Seen 2026-11-25 with that in place: a desktop tab named
// "Plugin" whose close mark did nothing while the pane's own Close button worked. The reopen is the suspect, not proven.
function openBoard($: EngineInterface) {
  return $.ui.open({ id: PANE, title: TITLE, focus: true })
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
  const owner = generation
  try {
    const restored = await boardCommand($, `${cwd}/.swarm`, ['restore', await lookupKey($)])
    if (sEpoch !== sessionEpoch || isEnding) return
    const dir = restored.stdout.trim()
    if (restored.exitCode === 0 && RUN.test(dir)) await own($, dir, owner)
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
let ownershipWrites: Promise<unknown> = Promise.resolve()
function withOwnership<T>(write: () => Promise<T>): Promise<T> {
  const pending = ownershipWrites.then(write)
  ownershipWrites = pending.catch(() => undefined)
  return pending
}

async function own($: EngineInterface, dir: string, restoreGeneration?: number): Promise<void> {
  const sEpoch = sessionEpoch
  const valid = () => sEpoch === sessionEpoch && !isEnding
  const owner = await withOwnership(async () => {
    const current = await read($, run)
    if (!valid() || (restoreGeneration !== undefined && restoreGeneration !== generation)) return undefined
    if (current !== dir) {
      resetMonitoring()
      strangers.clear()
    }
    closedRun = ''
    // Keep retired ids for late hand-backs. An earlier kill's owed compaction must not take away the new run's rules.
    if (dir !== killedRun) {
      killedRun = ''
      killConfirmed.clear()
      owedCompaction = undefined
      isKillTurn = false
    }
    hadRun = true
    const owner = generation
    await update($, run, value => valid() && owner === generation ? dir : value)
    if (valid() && owner === generation) ownedPath = dir
    return owner
  })
  if (owner === undefined || !valid() || owner !== generation) return
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
  if (!isClosed && opened !== dir && valid() && owner === generation) {
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

/** Whether a statement runs a variable that holds the board script, with `init` after it: `S=…/board.py; python3 $S <run> init …`. */
function runsHeldInit(command: string): boolean {
  const held = [...command.matchAll(/(?:^|[\s;&|(])([A-Za-z_]\w*)=(?:"[^"\n]*board\.py[^"\n]*"|'[^'\n]*board\.py[^'\n]*'|[^\s"';&|]*board\.py)(?=[\s;&|]|$)/g)].map(match => match[1])
  return held.length > 0 && scanShell(command).some(({ text }) => {
    const words = shellWords(unwrap(text).text)
    const at = words.findIndex(word => held.some(name => word === `$${name}` || word === `\${${name}}`))
    // The variable is what runs: first, or after a launcher and its options. `echo $S init` runs echo.
    const isRun = at === 0 || (at > 0 && /^(?:\S*\/)?(?:python3?(?:\.\d+)?|uv)$/.test(words[0]!) &&
      words.slice(1, at).every(word => word === 'run' || word.startsWith('-')))
    return isRun && words.includes('init', at + 1)
  })
}

// What the coordinator is told when it makes a run. A run can be started from memory, with no /swarm:swarm in the
// turn and so none of the skill's current rules; and every wake re-reads the whole conversation, so a run started
// in a long one pays for that history each time.
async function initNotes($: EngineInterface): Promise<string[]> {
  const notes = sawSwarmCommand
    ? []
    : [`Swarm: A run was made. If this turn did not start from /swarm:swarm, Read ${$.plugin.root}/skills/swarm/SKILL.md before going on: its rules are the current ones. Before you start a member, show the user the plan and name the token budget the board's plan command allocates from the team (3,000,000 until one is registered), or say that none is set.`]
  const held = await $.session.usage().then(usage => usage.context.tokens ?? 0).catch(() => 0)
  // The desktop app starts a conversation in a worktree of its own and lets its tools edit files only there.
  const cwd = await $.session.cwd().catch(() => '')
  const link = cwd ? await $.fs.read(`${cwd}/.git`).catch(() => '') : ''
  if (/^gitdir:.*\/worktrees\//.test(link.trim())) {
    notes.push(`Swarm: This conversation runs in a Git worktree of its own (${cwd}). The app can refuse a member's file edits outside that folder, and a member started with isolation: "worktree" works outside it. Before you start a writer with worktree isolation, tell the user: either the writers share this folder with owners that do not overlap, or the run is started from a conversation on the main checkout.`)
  }
  if (held >= LONG_CONVERSATION) {
    notes.push(`Swarm: This conversation already holds about ${compact(held)} tokens, and each time you are woken during the run all of them are read again. Swarm compacts it by itself at the first idle point after the team is deployed, so write every brief now, from all you know: put in each one everything its member needs, because after the compaction the board is your memory. Tell the user in one line that this happens.`)
  }
  return notes
}

const SAFE_MEMBER_BOARD_ACTIONS = new Set(['read', 'show', 'status', 'post', 'ready', 'revise'])
/** True when a shell segment contains any unquoted output redirection other than pure fd duplication (e.g. `2>&1`). */
function hasOutputRedirect(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (ch === '\\') { i++; continue }
    if (ch === "'") {
      const end = text.indexOf("'", i + 1)
      if (end < 0) return true
      i = end
      continue
    }
    if (ch === '$' && text[i + 1] === "'") {
      for (i += 2; i < text.length; i++) {
        if (text[i] === '\\') { i++; continue }
        if (text[i] === "'") break
      }
      continue
    }
    if (ch === '"') {
      for (i++; i < text.length; i++) {
        if (text[i] === '\\') { i++; continue }
        if (text[i] === '"') break
      }
      continue
    }
    if (ch === '>') {
      // Allow pure fd duplication / close like `2>&1`, `>&2`, `2>&-`; reject all file-writing output redirects.
      const dup = /^>&(?:\d+|-)(?=[\s;&|)]|$)/.exec(text.slice(i))
      if (dup) { i += dup[0].length - 1; continue }
      return true
    }
  }
  return false
}
/** True only when a member's Bash command parses exclusively as safe own-member board.py commands targeting the installed script without output redirects. */
function isSafeMemberBoardBash(command: string, memberName?: string, member?: Roster[string], expectedScript = pluginBoardScript): boolean {
  if (!command.trim() || !memberName || !member || !expectedScript) return false
  try {
    if (substitutions(command).length > 0) return false
    const segments = scanShell(command)
    if (segments.length === 0) return false
    for (const { text, unread } of segments) {
      if (unread || hasOutputRedirect(text)) return false
      const parsed = boardCalls(text)
      if (parsed.length !== 1 || !SAFE_MEMBER_BOARD_ACTIONS.has(parsed[0]!.action)) return false
      const script = shellWords(unwrap(text).text).find(word => /(?:^|\/)board\.py$/.test(word))
      if (!script || normalizePath(script) !== expectedScript) return false
    }
    return actsAsAnother(command, memberName, member) === undefined
  } catch {
    return false
  }
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
  const checkout = activeDir.includes('/.swarm/') ? activeDir.slice(0, activeDir.lastIndexOf('/.swarm/')) : ''
  if (call.tool === 'Edit' || call.tool === 'Write' || call.tool === 'NotebookEdit') {
    const rawTarget = call.target
    const cwd = (await $.session.cwd().catch(() => '')) || checkout
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
        const wtMain = /^(.+)\/\.claude\/worktrees\/[^/]+$/.exec(realCwd)?.[1]
        if (wtMain && (realTarget === wtMain || realTarget.startsWith(`${wtMain}/`))) {
          if (realTarget.startsWith(`${wtMain}/.claude/worktrees/`) || isIsolated) {
            rel = realTarget === wtMain ? '' : realTarget.slice(wtMain.length + 1)
          }
        }
        if (rel === undefined) {
          const link = await $.fs.read(`${normCwd}/.git`).catch(() => '')
          const main = /^gitdir:\s*(.+)\/\.git\/worktrees\/[^/]+$/.exec(link.trim())?.[1]
          const absMain = main ? (main.startsWith('/') ? normalizePath(main) : normalizePath(`${normCwd}/${main}`)) : undefined
          const realMain = absMain ? await resolveRealPath($, absMain) : undefined
          if (realMain && (realTarget === realMain || realTarget.startsWith(`${realMain}/`))) {
            if (realTarget.startsWith(`${realMain}/.claude/worktrees/`) || isIsolated) {
              rel = realTarget === realMain ? '' : realTarget.slice(realMain.length + 1)
            }
          }
        }
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
        const ownId = member.id ?? call.agentId
        if (isShared || owner !== undefined || (isIsolated && folder !== ownId && folder !== call.agentId)) {
          foreign = `@${memberName} cannot edit inside ${owner ? `@${owner}'s` : "another member's"} worktree (.claude/worktrees/${inWorktree[1]}): ${isShared ? 'it works in the shared checkout' : 'an isolated member edits only its own'}.`
        }
        rel = inWorktree[2]!
      } else if (isIsolated && rel !== undefined && rel !== '.swarm' && !rel.startsWith('.swarm/')) {
        foreign = `@${memberName} is isolated to its own worktree (.claude/worktrees/agent-${member.id ?? call.agentId}/) and cannot edit "${rel}" in the shared checkout.`
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
      return { deny: `The board refused this command: ${spoof}. Nothing in it ran, whatever was chained before the board command included: run that part again on its own. Use the board tool, which acts as you, or the board command under your own name.` }
    }
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
let bindingWrites: Promise<unknown> = Promise.resolve()
function bind($: EngineInterface, dir: string): Promise<boolean> {
  const existing = binding.get(dir)
  if (existing) return existing
  const epoch = sessionEpoch
  const pending = bindingWrites.then(() => epoch === sessionEpoch && !isEnding && bindOnce($, dir))
    .finally(() => { if (binding.get(dir) === pending) binding.delete(dir) })
  bindingWrites = pending.catch(() => undefined)
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

async function agentRun(
  $: EngineInterface,
  id: string,
  agent?: AgentInfo,
  listFailed = false,
  expectedEpoch = sessionEpoch,
  expectedGen?: number,
): Promise<string> {
  if (expectedEpoch !== sessionEpoch || isEnding) return ''
  const saved = agentRuns.get(id)
  if (saved) return saved
  if (strangers.has(id)) return ''
  const address = teammateOf($, id, agent) ?? id
  const active = await read($, run)
  if (expectedEpoch !== sessionEpoch || isEnding) return ''
  if (expectedGen !== undefined && expectedGen !== generation) return ''
  if (active) {
    const roster = await $.fs.read(`${active}/members.json`).then(text => (JSON.parse(text) as { members: Roster }).members)
      .catch(() => undefined)
    if (expectedEpoch !== sessionEpoch || isEnding) return ''
    if (expectedGen !== undefined && expectedGen !== generation) return ''
    const registered = roster && Object.values(roster).some(member => member.id === address || member.id === id)
    const name = parseDescribedName(agent?.description)
    const starting = roster && memberNamed(roster, name)
    if (registered || (starting && (!starting.id || pendingStarts.has(`${active}/${name}`)) && !starting.killed && agent?.type === `swarm:${starting.profile || starting.role || 'worker'}`)) {
      // Kept: the agent list drops a fast agent before its last turn is accounted, and its description with it.
      agentRuns.set(id, active)
      return active
    }
  }
  const cwd = await $.session.cwd()
  const key = await lookupKey($)
  if (expectedEpoch !== sessionEpoch || isEnding) return ''
  if (expectedGen !== undefined && expectedGen !== generation) return ''
  const result = await boardCommand($, `${cwd}/.swarm`, ['agent-run', key, id, ...(address === id ? [] : [address])])
  if (expectedEpoch !== sessionEpoch || isEnding) return ''
  if (expectedGen !== undefined && expectedGen !== generation) return ''
  const dir = result.stdout.trim()
  if (result.exitCode !== 0 || !RUN.test(dir)) {
    if (result.exitCode === 0 && !listFailed && agent !== undefined && !SWARM_AGENTS.has(agent.type)) strangers.add(id)
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
  report?: Report,
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
      const hasDeps = Boolean(member.depends?.trim() || member.after?.trim())
      const hint = report?.members && Object.hasOwn(report.members, name) ? report.members[name] : undefined
      const hasUnmetDepends = Array.isArray(hint?.blocked_on) ? hint.blocked_on.length > 0 : hasDeps
      if (seq !== undefined && SPECIALISTS.includes(member.profile ?? '') && !hasUnmetDepends) results.unaddressed.push({ name, seq })
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
    // The board refuses the claim of a read-only member past the context ceiling whose report it holds: asking the
    // coordinator to relay that wake would cost a turn for nothing. Attention says to replace it.
    if (report?.members && Object.hasOwn(report.members, name) && report.members[name]!.heavy) continue
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
      const startup = startupReads.get(`${dir}/${name}`)
      if (startup?.address === id && seq <= startup.through) {
        const status = findAgent(agents, id)?.status
        if (status === 'pending' || status === 'running') continue
      }
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
    `Read ${owed.count === 1 ? 'it' : 'them'} before anything else: python3 ${shellQuote(script)} ${shellQuote(dir)} read coordinator --attention`
}

function moodOf(full: Swarm, agents: AgentInfo[]): Mood {
  if (full.isClosed) return 'sleep'
  if (full.isPaused) return 'paused'
  const participants = new Set(full.members.filter(m => m.status === 'working' || m.status === 'coordinating')
    .map(m => m.role === 'coordinator' ? 'coordinator' : findAgent(agents, m.id)?.id ?? m.id))
  if (!participants.size) {
    return full.attention.length > 0 || full.members.some(needsMemberAttention) ? 'attention' : 'sleep'
  }
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
        dropRunPending(dir)
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
      lastReport = undefined
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
    windUp(dir, tokensUsed(state.usage?.tokens), budgetOf(state))
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
    const key = JSON.stringify([dir, rosterText, agentStates])
    let full = snapshot
    if (!full || key !== seen || board !== seenBoard || (attentionRetry > 0 && now >= attentionRetry)) {
      if (rosterText !== seenRoster) {
        strangers.clear()
        seenRoster = rosterText
      }
      const report = await reportOf($, dir)
      if (epoch !== generation || isEnding) return
      lastReport = report ? { dir, report } : undefined
      attentionRetry = report ? 0 : now + 10_000
      full = parse(dir, board, rosterText, agents, Infinity, report, coordinating)
      full.mood = moodOf(full, agents)
      const next = { ...full, posts: full.posts.slice(-KEPT), earlierEdges: earlierEdgesOf(full.posts, full.posts.slice(-KEPT), report?.edges, report?.through), attentionUnavailable: !report }
      const previous = await read($, swarm)
      if (epoch !== generation || isEnding) return
      const lastPost = previous.posts.at(-1)?.seq ?? 0
      if (previous.dir !== dir && !browsed) {
        closeTalk($)
        await seek($, 0)
        await update($, expanded, () => 0)
        // A diff or an older page asked for on the run shown before is that visit's, even when it comes back to it.
        // A poll of the same run leaves both alone.
        diffAsked++
        loadingDiffSeq = 0
        boardNavigation++
        await update($, diff, () => NO_DIFF)
        await update($, inspected, () => null)
        await update($, earlier, () => 0)
        await update($, query, () => '')
      } else if (!browsed && isPaneOpen && livePlayer === undefined && await read($, tab) === 'graph' && await read($, replay) === 0) {
        if (next.isClosed || next.isPaused) {
          await stopLive($)
        } else {
          const firstNew = next.posts.find(post => post.seq > lastPost)
          if (firstNew) {
            await update($, livePulse, () => firstNew.seq)
            // The session may have ended or the pane closed while the pulse was stored: no timer is started behind them.
            // Only schedule live stepping when a newer post is queued behind `firstNew`; a single latest post renders
            // directly in unified play-loop mode without a second iframe reload.
            if (epoch === generation && !isEnding && isPaneOpen && livePlayer === undefined) {
              if (next.posts.some(post => post.seq > firstNew.seq)) scheduleLiveFrame($)
            } else if (livePlayer === undefined) {
              await update($, livePulse, () => 0)
            }
          }
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
    const nextCoordStatus = state.closed ? 'closed' : coordinating ? 'coordinating' : 'waiting'
    const coord = full.members.find(m => m.role === 'coordinator')
    const coordChanged = coord !== undefined && coord.status !== 'killed' && coord.status !== nextCoordStatus
    if (coordChanged) {
      full = { ...full, members: full.members.map(m => m.role === 'coordinator' && m.status !== 'killed' ? { ...m, status: nextCoordStatus } : m) }
      snapshot = full
    }
    const mood = moodOf(full, agents)
    if (coordChanged || full.mood !== mood) {
      const updatedMembers = full.members
      full = { ...full, mood }
      snapshot = full
      await update($, swarm, prev => prev.dir === dir ? { ...prev, members: updatedMembers, mood } : prev)
    }
    if (await read($, loadError)) await update($, loadError, () => '')
    const unread = owned && !state.closed
      ? full.posts.filter(post => post.seq > Math.max(state.members.coordinator?.last_read_seq ?? 0, shownPosts.through) &&
        post.to.includes('coordinator') && !shownPosts.posts.has(post.seq))
      : []
    // Only the tail of a large board is read, and a mention older than it is in no post here: the board, which counts
    // over the whole journal, names the newest one. Seen in an audit: Attention showed the question and no prompt came.
    const tailFrom = full.posts[0]?.seq ?? 1
    const beforeTail = owned && !state.closed && tailFrom > 1 && lastReport?.dir === dir ? lastReport.report.unread_through?.coordinator ?? 0 : 0
    const unreadSeqs = [...(beforeTail > 0 && beforeTail < tailFrom ? [beforeTail] : []), ...unread.map(post => post.seq)]
    const last = unreadSeqs.at(-1) ?? 0
    const firstPending = unreadSeqs.find(seq => seq > prompted)
    const since = firstPending !== undefined && owedSeqs.includes(firstPending) && owed.last > prompted
      ? owed.since : now
    owed = last === 0 ? NONE : { count: unreadSeqs.length, first: unreadSeqs[0] ?? last, last, since }
    owedSeqs = unreadSeqs
    // A consultant's READY is the answer the coordinator asked for, a READY that asks something is a question, and one
    // that mentions the coordinator asks it to rule on something. Independent FINDING posts (no active dependent) also
    // coalesce while other members still work.
    const hasActiveDependent = (sender: string) => Object.entries(state.members).some(([name, m]) =>
      name !== 'coordinator' && !m.killed && (m.depends ?? '').split(',').map(d => d.trim()).includes(sender))
    isOwedRoutine = !full.attentionUnavailable && unread.length > 0 && unread.every(post => {
      const label = kindOf(post.text)?.label
      // A hand-back Swarm put on the board is a turn's closing words: read with the next wake, as a READY is.
      const isHandback = post.text.startsWith(HANDBACK_POST)
      const isRoutineKind = isHandback || label === 'READY' || (label === 'FINDING' && !hasActiveDependent(post.agent))
      return isRoutineKind &&
        state.members[post.agent]?.consult !== '1' && !hasQuestion(post.text) && (isHandback || !/(?<![\w@.-])@coordinator(?![\w-])/.test(post.text)) &&
        !full.attention.some(item => item.kind === 'question' && item.seq === post.seq)
    }) &&
      (full.members.some(member => member.role !== 'coordinator' && member.status === 'working') ||
        // A verifier with an agent reviews these READY posts next and mentions the coordinator with what it found: one
        // wake, not two inspecting the same diff. One with no agent yet is the coordinator's to start, so it is not waited for.
        full.members.some(member => member.role === 'verifier' && member.id && member.status === 'waiting' &&
          unread.some(post => post.to.includes(member.name) && post.seq > (state.members[member.name]?.last_read_seq ?? 0))))
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
        wakeNext = 'pause'
        void $.prompt.submit({ text }).then(result => {
          if (epoch !== generation) return
          if (result.drop) { noticeHold = 0; wakeNext = ''; unheard() }
        }).catch(() => {
          if (epoch !== generation) return
          noticeHold = 0
          wakeNext = ''
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
      (full.posts[0]?.seq ?? 1) > 1 ? await owedBeforeTail($, dir) : undefined,
      lastReport?.dir === dir ? lastReport.report : undefined)
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
      workers.some(member => member.status !== 'not started') &&
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
      if (relay.length > 0 && keyToRelay !== relayPrompted) notices.push(relayNotice())
    }
    if (notices.length > 0) {
      const heading = askRelay ? 'Delivering board mentions' : answerThrough ? 'Unread board mentions' : 'Run needs attention'
      // The prompt carries these notices, so the first tool call of the turn it starts does not repeat them.
      const told = { relayHinted, hinted }
      if (askRelay) relayHinted = keyToRelay
      if (answerThrough) hinted = Math.max(hinted, answerThrough)
      noticeHold = (await $.clock.now()) + NOTICE_HOLD_MS
      wakeNext = [askRelay && 'relay', answerThrough && 'unread', askStall && 'stall'].filter(Boolean).join('+')
      void $.prompt.submit({ text: `Swarm: ${heading}\nRun: ${full.title.replace(/\s+/g, ' ')}\n${notices.join('\n\n')}` })
        .then(result => {
          if (epoch !== generation) return
          noticeFailures = noticeRetry = 0
          // An explicit drop can mean the user stopped the session. Leave the notice on the board.
          if (result.drop) {
            noticeHold = 0
            wakeNext = ''
            if (askRelay && relayHinted === keyToRelay) relayHinted = told.relayHinted
            if (answerThrough && hinted === answerThrough) hinted = told.hinted
            $.ui.toast('Swarm was unable to notify the coordinator. Check the board for pending work.')
          }
        }).catch(() => {
          if (epoch !== generation) return
          noticeHold = 0
          wakeNext = ''
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
    } else if (!pending && await owesRunCompaction($, dir)) {
      // No turn is running to end: asked for now.
      $.clock.after(0, () => compactOwed($))
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

/**
 * The agent that sent a notification, read off its envelope alone: a peer message's first `<agent-message from>`
 * frame, a task notification's opening `<task-id>`, a SendMessage delivery's `Message from ID:`. The text inside may
 * name any agent; a format not known here names none.
 */
function senderOf(e: { text: string; origin: { kind: string } }): string | undefined {
  const envelope = e.origin.kind === 'peer' ? /<agent-message from="([^"]+)">/
    : e.origin.kind === 'task-notification' ? /^\s*<task-notification>\s*<task-id>([^<]+)<\/task-id>/
    : e.origin.kind === 'peer-send-message' ? /^Message from ([^\s:]+):/ : undefined
  return envelope?.exec(e.text)?.[1]?.trim() || undefined
}
/**
 * A member's final report that is in no board post is put there in its name, and the coordinator gets a pointer in
 * its place: on the board a replacement, a dependent and the verifier can read it, and the member need not be woken,
 * at the price of its whole context, to copy it over. Seen live: three investigators stopped by a pause held their
 * findings only in a hand-back, and were woken at 290k tokens each to post them. Only a report of some length from a
 * live member that posted nothing since it was last woken: a turn that ended on its own READY already said it.
 */
const HANDBACK_MIN = 400
const HANDBACK_PART = 11_000
const HANDBACK = /<agent-message from="([^"]+)">\s*\[Subagent hand-back\]\s*([\s\S]*?)\s*<\/agent-message>/
const HANDBACK_FRAME = /^The text below is the final report of a subagent[\s\S]*?The report follows:[ \t]*\n?/
// The host frames every hand-back with a note of its own: what the member said is measured and compared without it.
const unframed = (body: string) => body.replace(HANDBACK_FRAME, '').trim()
const HANDBACK_POST = '@coordinator HAND-BACK'
/**
 * `quiet` when the hand-back need start no turn of the coordinator's: other members still work, the report asks
 * nothing, and what it says is on the board now, where the next wake reads it. Seen live: in 150 seconds ten
 * hand-backs and notifications each started a coordinator turn at 180k tokens, and five were answered "nothing new".
 * A member rewords its report as it hands back, so no comparison of words tells a repeat from news: the board keeps
 * both, and neither is worth a turn of its own.
 */
async function mirrorHandback($: EngineInterface, e: { text: string; origin: { kind: string } }): Promise<{ text: string; quiet: boolean } | undefined> {
  const roster = ownedRoster
  if (e.origin.kind !== 'peer' || !roster || roster.closed) return undefined
  const found = HANDBACK.exec(e.text)
  const body = found?.[2] ?? ''
  if (!found) return undefined
  const from = found[1]!
  const owner = generation
  if (roster.dir !== await read($, run)) return undefined
  const [fresh, board] = await Promise.all([
    $.fs.read(`${roster.dir}/members.json`).then(text => JSON.parse(text) as { closed?: boolean; members?: Roster }),
    readBoard($, roster.dir),
  ])
  if (!fresh.members || fresh.closed || owner !== generation || isEnding) return undefined
  const address = teammates.get(from)
  const entry = Object.entries(fresh.members).find(([name, m]) => name !== 'coordinator' && m.id && m.killed !== '1' && (m.id === from || m.id === address))
  if (!entry) return undefined
  const [name, member] = entry
  // The host frames every hand-back with a note of its own, longer than the least report worth a post: measured
  // and posted without it. Seen live: a one-line status was mirrored because its frame alone passed the minimum.
  const report = unframed(body)
  const shown = snapshot
  // Nor when a post the coordinator must read is unread and not yet told: the "Unread board mentions" notice starts its
  // turn within seconds anyway. Seen live: a verifier's "No change" hand-back right after a worker's READY, two turns.
  const quiet = !halted && shown?.dir === roster.dir && member.consult !== '1' && !hasQuestion(report) &&
    (shown.members.some(m => m.role !== 'coordinator' && m.name !== name && m.status === 'working') ||
      (owed.count !== 0 && !isOwedRoutine && owed.last > prompted))
  const newest = parsePosts(board, fresh.members).findLast(post => post.agent === name)
  if (newest && newest.seq > Number(member.last_nudged_seq ?? 0)) {
    const compactBody = report.replace(/\s+/g, ' ').trim()
    if (compactBody && report.length >= HANDBACK_MIN && newest.text.replace(/\s+/g, ' ').includes(compactBody)) {
      return { quiet, text: e.text.replace(body, () => `@${name} reported on the board in post #${newest.seq}.`) }
    }
    // A last line that only points at that post is no report of its own, however short: nothing of it goes up.
    if (pointsAt([newest], report)) return { quiet, text: e.text.replace(body, () => `@${name} reported on the board in post #${newest.seq}.`) }
    // A turn that ended on its own report has said it, even once the member read that post back: closing words that
    // repeat the report are not posted again. Seen live: a READY read back after an UNREAD note went up a second time
    // as a hand-back. Words the report does not hold are news (work done after it), and are posted as before.
    // A replacer function: the report's own `$&` or `$'` must reach the notice as typed.
    if (report.length >= HANDBACK_MIN && ['READY', 'FINDING', 'VERIFIED', 'NOT PASSED'].includes(kindOf(newest.text)?.label ?? '') && repeatsPosts([newest.text], report)) {
      return { quiet, text: e.text.replace(body, () => `@${name} reported on the board in post #${newest.seq}. Its closing words began: ${clip(compactBody, 300)}`) }
    }
    // Said to the coordinator as it is, unless that would start a turn others' work does not need: then it is posted.
    if (newest.seq > member.last_read_seq && !quiet) return undefined
  }
  // Held, even a line is posted: dropped unposted it would be lost, and said to the coordinator it costs a turn.
  if (report.length < (quiet ? 1 : HANDBACK_MIN)) return undefined
  // A post holds 12,000 characters: a longer report goes up in parts, and the pointer replaces it only once every
  // part is saved. A part the board did not take leaves the coordinator the report itself.
  const parts = Math.ceil(report.length / HANDBACK_PART)
  const seqs: string[] = []
  for (let part = 0; part < parts; part++) {
    if (owner !== generation || isEnding) return undefined
    const posted = await boardCommand($, roster.dir, ['post', name],
      `${HANDBACK_POST}${parts > 1 ? ` (part ${part + 1} of ${parts})` : ''}: @${name}'s turn ended with this report in no board post, so Swarm put it here.\n${fenced(report.slice(part * HANDBACK_PART, (part + 1) * HANDBACK_PART))}`)
    const seq = /posted #(\d+)/.exec(posted.stdout)?.[1]
    if (posted.exitCode !== 0 || !seq) return undefined
    seqs.push(seq)
  }
  $.clock.after(0, () => void refresh($))
  const where = seqs.map(seq => `#${seq}`).join(', ')
  return { quiet, text: e.text.replace(body, () => `@${name}'s final report is on the board, whole, in post${seqs.length > 1 ? 's' : ''} ${where}: read it there with the board's show action. It is not repeated here.`) }
}

// Per member of a run, the newest post that let one of its turn ends be dropped, and the kinds of wake dropped for it:
// a hand-back and a task notification each once.
const boardDrops = new Map<string, { seq: number; kinds: Set<string> }>()

/**
 * Whether a member's hand-back or task notification would only repeat the board: it would start a turn of its own
 * while other members still work, the member posted on the board since it was last woken, and nothing the
 * coordinator must act on is unread. The board's own paths still wake the coordinator: an urgent mention, a silent
 * exit, the last member stopping. Anything in doubt goes through.
 */
async function repeatsBoard($: EngineInterface, e: { text: string; origin: { kind: string }; turnId?: string }): Promise<boolean> {
  const roster = ownedRoster
  const shown = snapshot
  if (e.turnId !== undefined || !roster || roster.closed || halted || !shown || shown.dir !== roster.dir) return false
  const kind = e.origin.kind
  if (kind !== 'peer' && kind !== 'task-notification') return false
  // A failure, or a stop, is news the board does not hold.
  if (kind === 'task-notification' && /<status>([^<]*)<\/status>/.exec(e.text)?.[1]?.trim() !== 'completed') return false
  const from = senderOf(e)
  if (!from) return false
  // A peer message is dropped only as a turn's end; one a member sends about something new goes through.
  if (kind === 'peer' && !/<agent-message from="[^"]+">\s*\[Subagent hand-back\]/.test(e.text)) return false
  if (roster.dir !== await read($, run)) return false
  // The roster and the board as they are now: since the last poll the board may have woken the member again, and a
  // turn that ended on that wake with nothing posted is a silent exit. Either unread, the prompt goes through.
  const [fresh, board] = await Promise.all([
    $.fs.read(`${roster.dir}/members.json`).then(text => JSON.parse(text) as { closed?: boolean; members?: Roster }),
    readBoard($, roster.dir),
  ]).catch(() => [undefined, ''] as const)
  if (!fresh?.members || fresh.closed) return false
  const address = teammates.get(from)
  const found = Object.entries(fresh.members).find(([name, m]) => name !== 'coordinator' && m.id && m.killed !== '1' &&
    (m.id === from || m.id === address))
  if (!found) return false
  const [name, member] = found
  const woken = Number(member.last_nudged_seq ?? 0)
  const since = parsePosts(board, fresh.members).filter(post => post.agent === name && post.seq > woken)
  const newest = since.reduce((seq, post) => post.seq > seq ? post.seq : seq, 0)
  // Only what the member's posts since its wake already say: a hand-back with news is heard, whatever came before it.
  // Seen live: a READY, then a hand-back with a new build failure, dropped because the READY was there.
  const handedBack = HANDBACK.exec(e.text)
  if (kind === 'peer' && (!handedBack || !(pointsAt(since, unframed(handedBack[2]!)) || repeatsPosts(since.map(post => post.text), unframed(handedBack[2]!))))) return false
  const key = `${roster.dir}\n${name}`
  const used = boardDrops.get(key)
  // Only a post newer than its last wake, and one turn's end per post: a member that read its wake and posted
  // nothing exited silently, and one that ran again and posted nothing new left no news on the board.
  if (newest <= woken || (used?.seq === newest && used.kinds.has(kind))) return false
  const othersWork = shown.members.some(m => m.role !== 'coordinator' && m.name !== name && m.status === 'working')
  if (!othersWork || (owed.count !== 0 && !isOwedRoutine)) return false
  if (used?.seq === newest) used.kinds.add(kind)
  else boardDrops.set(key, { seq: newest, kinds: new Set([kind]) })
  return true
}

/** A closed run stops being the one this conversation drives: nothing is woken or charged, its members stay refused. */
async function released($: EngineInterface, dir: string): Promise<void> {
  const epoch = sessionEpoch
  const owner = await withOwnership(async () => {
    if (dir !== await read($, run) || epoch !== sessionEpoch || isEnding) return undefined
    closedRun = dir
    dropRunPending(dir)
    resetMonitoring()
    const owner = generation
    await update($, run, value => generation === owner && epoch === sessionEpoch && value === dir ? '' : value)
    return owner
  })
  if (owner === undefined || epoch !== sessionEpoch || owner !== generation) return
  // Its members are still refused by name: a retired one, a commit, an edit outside its paths.
  await syncOwnedState($, dir, undefined, undefined, owner).catch(() => undefined)
}

/**
 * The coordinator's own context is read again at every wake of a run. Once the team is deployed the briefs are on
 * the board, written from the whole conversation, so nothing a member gets can lose by a compaction after that
 * point; before it, one could. Seen live: a coordinator that started at 132k tokens spent 1.2M of a 6.7M run.
 */
const runCompact = (dir: string, title: string, root: string) =>
  `This conversation coordinates the Swarm run "${title}" at ${dir}, and goes on coordinating it. Summarize it for the ` +
  'same coordinator. Keep, in the user\'s own words, the task and every later instruction, limit and preference; the ' +
  'verification checks and commands agreed for the run; decisions made and why; anything a member reported to you ' +
  'that is in no board post; questions still open with the user; uncommitted or unlanded work. Leave out file contents ' +
  'you read, tool output, and whatever the board holds (briefs, reports, the roster, usage). End with: the board is ' +
  `the memory of this run; on every wake read it first (the board tool's read action), and Read ${root}/skills/swarm/SKILL.md ` +
  'again before the next step whose rules are no longer in view.'
let compactedRun = ''
let compactedAt = -1
let failedCompaction = ''
let toldFailedCompaction = ''
// The token figures the user has written in this conversation: the only budgets the coordinator may set above the
// one that stands. Seen live: a coordinator whose team was estimated past the budget set 3,000,000 by itself.
const userFigures = new Set<number>()
const BUDGET_IS_USERS = 'Nothing changed: the budget is the user\'s to set, and no message of theirs names this figure. Tell them what the run has used and what the plan estimates, and ask for the new total as a figure. Once they write one, set it. Lowering the budget needs no word from them.'
const BUDGET_NEEDS_PLAIN_ARGS = 'Nothing ran: set run limits with the board tool or a direct board command with literal options.'
const SHELL_LIMIT_EXPANSION = /[$`*?\[\]{}]/
/**
 * Whether the coordinator may set this budget: one no higher than the one that stands, or the total the user wrote.
 * "Raise it by 500k" names no total, so the coordinator asks for one: a raise it could apply would apply again.
 */
const mayBudget = (asked: number, standing: number) => Number.isSafeInteger(asked) &&
  ((asked > 0 && standing > 0 && asked <= standing) || userFigures.has(asked))
/**
 * Whether a `limit` with these options sets a budget the coordinator may not. Every `budget=` is judged, as the board
 * keeps the last one; `budget=` with no figure lifts the budget, and a value that is no plain figure (`9_000_000`,
 * `$B`) is none the user wrote.
 */
/** The standing budget of the target run, or the run driven now for the board tool. */
async function standingBudget($: EngineInterface, target?: string): Promise<number> {
  const dir = await (target === undefined ? read($, run) : resolveRunDir($, target)).catch(() => '')
  if (!dir) return 0
  // The board's own word, never the pane's snapshot: that is as old as the last poll, and a raise judged against it
  // could pass a figure the saved budget does not allow. A roster this cannot read stands for no budget, so only a
  // figure the user wrote passes. Seen in a test: a budget raised to 3M while the snapshot still held 1M refused a cut
  // to 2M.
  try {
    return Number((JSON.parse(await $.fs.read(`${dir}/members.json`)) as { limits?: { budget?: string } } | null)?.limits?.budget ?? 0) || 0
  } catch {
    return 0
  }
}
// With --raise the board writes the figure whatever the budget is by then, so only one the user wrote passes. Without
// it, a cut passes here and the board refuses it if, by the time it writes, it would be a raise.
const breaksBudget = (options: string[], standing: number) => options.some(option => {
  const asked = /^budget=(.*)$/s.exec(option.trim())?.[1]
  if (asked === undefined) return false
  const figure = asked === '' ? 0 : Number(asked)
  return options.some(word => word.trim() === '--raise') ? !userFigures.has(figure) : !mayBudget(figure, standing)
})
const limitOptions = (call: ParsedBoardCall) => withoutRedirects(shellWords(call.rest)).words.slice(1)

async function bashLimitDenial($: EngineInterface, command: string, calls: ParsedBoardCall[]): Promise<string | undefined> {
  if (hasHiddenBoardLimit(command)) return BUDGET_NEEDS_PLAIN_ARGS
  let hasRelative = false
  for (const call of calls) {
    if (call.action !== 'limit') continue
    // `..` after a folder that may be a symlink leads the board elsewhere than the path read as text:
    // `/p/link/../.swarm/R` is judged against /p/.swarm/R while board.py raises the run under link's target. A leading
    // `../` is read from the physical folder the shell is in (see blocksRelativeBoardLimit), as the board reads it.
    if (SHELL_LIMIT_EXPANSION.test(call.dir) || /(?:^|\/)(?!\.\.(?:\/|$))[^/]+\/\.\.(?:\/|$)/.test(call.dir)) return BUDGET_NEEDS_PLAIN_ARGS
    const options = limitOptions(call)
    if (call.dir.startsWith('/')) {
      if (breaksBudget(options, await standingBudget($, call.dir))) return BUDGET_IS_USERS
    } else {
      hasRelative = true
    }
    if (options.some(word => SHELL_LIMIT_EXPANSION.test(word))) return BUDGET_NEEDS_PLAIN_ARGS
  }
  if (!hasRelative) return
  let denial: string | undefined
  const blocked = await blocksRelativeBoardLimit($, command, async (call, target) => {
    const standing = target === undefined ? 0 : await standingBudget($, target)
    if (!breaksBudget(limitOptions(call), standing)) return false
    denial = target === undefined ? BUDGET_NEEDS_PLAIN_ARGS : BUDGET_IS_USERS
    return true
  })
  return blocked ? denial ?? BUDGET_NEEDS_PLAIN_ARGS : undefined
}
/**
 * Owes the run's compaction when the coordinator is idle with a long conversation: first once the team is deployed
 * (LONG), then whenever the conversation has grown back (HEAVY). Never with a mention unread, a wake to relay or a
 * pause to answer: those are what the next turn is for. Asked at each end of the coordinator's turn and at each poll
 * while it is idle. Seen live: checked at a turn's end alone, a conversation went from 106k to 180k tokens over two
 * runs and 43 steps with a team deployed and was never compacted, five idle minutes included.
 */
async function owesRunCompaction($: EngineInterface, dir: string): Promise<boolean> {
  const epoch = sessionEpoch
  // Read again after the usage: the run may have changed hands meanwhile, and its address is no other run's instructions.
  const fits = () => epoch === sessionEpoch && !isEnding && !isCoordinatorBusy && !owedCompaction && !halted && dir !== '' &&
    ownedRoster?.dir === dir && !ownedRoster.closed && owed.count === 0 && specialistWakes.length === 0 &&
    Object.entries(ownedRoster.members).some(([name, member]) => name !== 'coordinator' && Boolean(member.id))
  // One compaction per idle stretch: a conversation that stays long after it is not compacted again at every poll.
  if (!fits() || compactedAt === coordinatorTurnsEnded) return false
  const held = await $.session.usage().then(usage => usage.context.tokens ?? 0).catch(() => 0)
  if (!fits() || held < (compactedRun === dir ? HEAVY_CONVERSATION : LONG_CONVERSATION)) return false
  compactedRun = dir
  compactedAt = coordinatorTurnsEnded
  owedCompaction = { epoch: sessionEpoch, tries: 0, isAsked: false, instructions: runCompact(dir, snapshot?.title ?? '', $.plugin.root) }
  $.ui.toast(`Swarm: compacting the coordinator's conversation (about ${compact(held)} tokens). The team is deployed and the board holds the briefs, so every later wake reads less.`)
  return true
}

const KILL_COMPACT = 'The user ended the Swarm run with /swarm-kill. Summarize this conversation for one assistant that ' +
  'continues the user\'s work alone. Keep the user\'s request and every later instruction in their own words, what was ' +
  'changed in which files, what was verified and what was not, what is uncommitted, failures, and open decisions. Leave ' +
  'out the Swarm skill\'s rules, board commands, the roster, wakes and budget mechanics. Say that this conversation is ' +
  'no longer a Swarm coordinator: it runs no board command and starts no member unless the user starts a new run.'

/**
 * /swarm-kill, answered in the command's place so no model turn starts: the board retires every member and closes
 * the run, the hooks let go of it as after a close, and the conversation is compacted between turns.
 */
async function killRun($: EngineInterface, reason: string): Promise<{ text: string }> {
  // The turn the kill lands in, read before any await: one that ends while the kill runs is not refused afterwards.
  const landedMidTurn = isCoordinatorBusy
  const turnsEnded = coordinatorTurnsEnded
  const sEpoch = sessionEpoch
  const owner = generation
  const dir = await read($, run) || closedRun
  if (!dir) return { text: 'No Swarm run is driven from this conversation, so there is nothing to kill.' }
  const result = await boardCommand($, dir, ['kill', ...(reason.trim() ? [reason.trim()] : [])])
    .catch(error => ({ exitCode: 1, stdout: '', stderr: String(error) }))
  const readRoster = () => $.fs.read(`${dir}/members.json`).then(text => JSON.parse(text) as { closed?: boolean; killed?: string; members?: Roster })
  // The board can close the run and fail after it (the SHUTDOWN post not appended): a roster closed by a kill is one.
  const committed = result.exitCode === 0 ? undefined : await readRoster().then(state => state.closed && state.killed ? state : undefined, () => undefined)
  if (result.exitCode !== 0 && !committed) return { text: `Swarm: the board's kill failed: ${clean(result.stderr).trim() || 'it gave no answer'}` }
  if (result.exitCode === 0 && /^already closed\s*$/m.test(result.stdout)) return { text: 'The Swarm run was already closed.' }
  // Every write of kill state is this session's alone: one that began since (/clear) is left as it is. The board's
  // kill stands either way.
  const isOurs = () => sEpoch === sessionEpoch && !isEnding && (owner === generation || closedRun === dir)
  if (!isOurs()) return { text: 'The Swarm run is closed.' }
  // At once, with no await since the board answered: a tool call the coordinator makes while the diagnostics run is
  // refused, unless the turn the kill landed in has ended meanwhile.
  const armed = landedMidTurn && coordinatorTurnsEnded === turnsEnded
  if (armed) isKillTurn = true
  // The board names each member it retired, with its agent: the guard refuses them from here on, before the roster is read.
  const retiredNow = new Map([...result.stdout.matchAll(/^@([\w.-]+) (\S+)$/gm)].map(([, name, id]) => [name!, id!]))
  const said: Roster = Object.fromEntries([...retiredNow].map(([name, id]) => [name, { role: 'worker', id, last_read_seq: 0 }]))
  const confirm = (ids: Set<string>) => {
    if (!isOurs()) return
    killedIds = new Set([...killedIds, ...ids])
    retired = new Set([...retired, ...ids])
    for (const id of ids) killConfirmed.add(id)
  }
  confirm(agentIdsOf(said, [], () => true))
  const unread: string[] = []
  const roster = committed?.members ?? await readRoster().then(state => state.members ?? {})
    .catch((): Roster => { unread.push('the run\'s roster'); return {} })
  for (const [name, member] of Object.entries(said)) roster[name] ??= member
  const members = Object.entries(roster).filter(([, m]) => m.role !== 'coordinator' && m.id)
  const killed = Object.fromEntries(members)
  // Both identities of a native teammate, as the tool guard knows them, the saved mapping of one gone from the list included.
  const retire = (agents: AgentInfo[]) => confirm(agentIdsOf(killed, agents, () => true))
  if (isOurs()) killedRun = dir
  retire([])
  if (isOurs()) await released($, dir)
  if (isOurs()) $.clock.after(0, () => void refresh($))
  const lines = [`The Swarm run is closed: ${/^killed: (\d+)/m.exec(result.stdout)?.[1] ?? members.length} member(s) retired.`]
  const live = await $.agent.list().catch((): AgentInfo[] => { unread.push('the agent list'); return [] })
  retire(live)
  const running = members.filter(([, m]) => ['running', 'pending', 'waiting'].includes(findAgent(live, m.id)?.status ?? ''))
  if (running.length > 0) lines.push(`Still running: ${running.map(([name]) => `@${name}`).join(', ')}. Each stops at its next tool call, which is refused.`)
  // A failed scan with nothing listed is no scan; what a scan that partly failed listed is kept.
  const listing = await $.process.run(['lsof', '-b', '-w', '-a', '-d', 'cwd', '-Fpn'], { timeoutMs: 5000 })
    .then(listed => listed.exitCode !== 0 && !listed.stdout.trim() ? Promise.reject(new Error('lsof failed')) : listed.stdout)
    .catch(() => { unread.push('the process list'); return '' })
  for (const [name, m] of members) {
    const left = await leftRunning($, m.id!, listing)
    if (left.length > 0) lines.push(`@${name} left ${left.map(one => `${one.pid} (${one.command})`).join(', ')} running in its worktree. Unless it should finish: kill ${left.map(one => one.pid).join(' ')}`)
  }
  if (unread.length > 0) lines.push(`Not checked, as ${unread.join(' and ')} could not be read: which members still run and what they left running.`)
  // No await from here on: the check and the owed compaction are one step, so a turn's end cannot fall between them.
  // A turn that ended during the diagnostics found the kill armed and owes the compaction already.
  const isMidTurn = armed && coordinatorTurnsEnded === turnsEnded
  lines.push('Nothing was committed or reverted: the files are as the members left them.', isMidTurn
    ? 'The coordinator\'s turn is told to end now; then this conversation is compacted, to go on as an ordinary assistant.'
    : 'This conversation is being compacted, to go on as an ordinary assistant.')
  if (!armed && isOurs()) compactAfterKill($)
  return { text: lines.join('\n') }
}

// The compaction a kill owes, to the session that asked, between its turns only. The host refuses one while a turn
// runs, so a refused one is asked again twice at most. A new run, bound or started, cancels it.
let owedCompaction: { epoch: number; tries: number; isAsked: boolean; instructions?: string } | undefined
const COMPACTION_RETRY_MS = 1000
/** Owes the compaction to this session; it runs once no coordinator turn is running, or at the end of the one that is. */
function compactAfterKill($: EngineInterface): void {
  owedCompaction = { epoch: sessionEpoch, tries: 0, isAsked: false }
  $.clock.after(0, () => compactOwed($))
}
function compactOwed($: EngineInterface): void {
  const owed = owedCompaction
  if (!owed || owed.isAsked || owed.epoch !== sessionEpoch || isCoordinatorBusy) return
  owed.isAsked = true
  void $.session.compact({ instructions: owed.instructions ?? KILL_COMPACT }).then(
    done => {
      if (owedCompaction === owed) owedCompaction = undefined
      // Only a kill's compaction ends the run's hold on the conversation: one made mid-run keeps coordinating.
      if (done.skip === undefined && owed.epoch === sessionEpoch && owed.instructions === undefined) sawSwarmCommand = false
      // A hook's veto is final.
      if (done.skip !== undefined) $.ui.toast(`Swarm: the compaction was skipped (${done.skip}). Run /compact to drop the run from the context.`)
    },
    (error: unknown) => {
      // Cancelled meanwhile, by a new run or another session: nothing is owed.
      if (owedCompaction !== owed) return
      if (++owed.tries > 2) {
        owedCompaction = undefined
        const why = error instanceof Error ? error.message : String(error ?? '')
        // A run's own compaction is tried again at the next idle point after a turn of the coordinator's: said once
        // per run, with the host's reason, and never as the kill's advice to drop a run that still goes on.
        if (owed.instructions === undefined) return $.ui.toast('Swarm: the conversation could not be compacted. Run /compact to drop the run from the context.')
        if (compactedRun !== '') failedCompaction = compactedRun
        compactedRun = ''
        if (failedCompaction !== toldFailedCompaction) {
          toldFailedCompaction = failedCompaction
          $.ui.toast(`Swarm: the coordinator's conversation could not be compacted${why ? ` (${clip(why, 120)})` : ''}. The run goes on, and Swarm tries again later.`)
        }
        return
      }
      // Asked again at the next idle point: a turn's end, or shortly when none runs.
      owed.isAsked = false
      $.clock.after(COMPACTION_RETRY_MS, () => compactOwed($))
    },
  )
}

/** What a kill leaves behind belongs to its conversation: a new one, after /clear or a resume, starts without it. */
function forgetKills(): void {
  killedRun = ''
  killedIds = new Set()
  killConfirmed.clear()
  boardDrops.clear()
  isKillTurn = false
  owedCompaction = undefined
  userFigures.clear()  // the budget one conversation's user named is not another's
}

/** One line of the run's debug log (`events.jsonl`), which `export` prints as the summary's timeline. Never awaited. */
function logEvent($: EngineInterface, dir: string | undefined, kind: string, fields: Record<string, unknown>): void {
  if (dir) void boardCommand($, dir, ['event', kind, JSON.stringify(fields).slice(0, 3900)]).catch(() => undefined)
}

// The agents that consulted the session's advisor, what the board has taken of its tokens, and the queue that charges them.
const advisorUsers = new Set<string>()
const advisorTaken = new Map<string, ReturnType<typeof advisorSpent>>()
let advising: Promise<unknown> = Promise.resolve()
/**
 * A member's advisor calls, put in the debug log and charged to the run. The advisor answers on its own model inside
 * the member's step, whose usage holds the member's tokens alone, so the advisor's are read off the agent's own
 * per-model usage and charged under the `advisor` wake. Seen live: 117k input and 18k output tokens of a Fable
 * advisor in a run limited to Sonnet, none of them in its budget or its summary. An agent that consulted once is
 * looked at again on its later steps: the usage of a call may reach the agent's total after the step that made it.
 */
async function advised(
  $: EngineInterface, turnId: string, index: number, agentId: string,
  consults: readonly { startedAt: number; endedAt?: number }[], ownModel: string, owner: TurnOwner, expectedEpoch: number,
): Promise<void> {
  const [setting, agents] = await Promise.all([
    $.settings.read({ key: 'advisorModel' }).catch(() => undefined),
    $.agent.list().catch((): AgentInfo[] => []),
  ])
  if (expectedEpoch !== sessionEpoch || isEnding) return
  const model = typeof setting === 'string' ? latestOf(setting.trim()) ?? '' : ''
  const dir = typeof owner === 'string' ? owner : agentRuns.get(agentId)
  const member = memberOfAgent(agentId)?.[0] ?? agentId
  for (const use of consults) {
    logEvent($, dir, 'advisor', {
      member, model,
      ...(use.endedAt === undefined ? { error: 'the response ended before the advisor answered' } : { seconds: Math.round((use.endedAt - use.startedAt) / 100) / 10 }),
    })
  }
  // A host whose agents carry no `usage` counts no advisor tokens: the calls are still logged.
  const agent = agents.find(one => one.id === agentId)
  const perModel = (agent as { usage?: Parameters<typeof advisorSpent>[0] } | undefined)?.usage
  const spent = advisorSpent(perModel, familyOf(model), familyOf(ownModel), familyOf)
  if (!advisorTaken.has(agentId)) {
    // The agent's total goes on over a reload of these hooks, which forgets what was charged: the roster has it. Its
    // run is found as `account` finds it: charged with no roster read, the whole total was taken again after a reload.
    const at = dir ?? await agentRun($, agentId, agent, false, expectedEpoch, typeof owner === 'number' ? owner : undefined)
    if (expectedEpoch !== sessionEpoch || isEnding || !at) return
    const actor = await digest(`swarm-agent:${teammateOf($, agentId, agent) ?? agentId}`)
    const row = await $.fs.read(`${at}/members.json`)
      .then(text => (JSON.parse(text) as { usage?: { detail?: Record<string, Record<string, number[]>> } }).usage?.detail?.[actor]?.advisor)
    if (expectedEpoch !== sessionEpoch || isEnding) return
    advisorTaken.set(agentId, { input_tokens: row?.[1] ?? 0, cache_creation_input_tokens: row?.[2] ?? 0, cache_read_input_tokens: row?.[3] ?? 0, output_tokens: row?.[4] ?? 0, model: '' })
  }
  const owed = owedOf(spent, advisorTaken.get(agentId))
  if (owed.amount <= 0) return
  const taken = await account($, turnId, `${turnId}:${index}:advisor`, agentId, owed.amount, owner, expectedEpoch, owed.detail, spent.model, 'advisor')
  // Unconfirmed, the board may still have saved it: the roster is asked again before the next charge, as after a
  // reload. Charged from memory, a lost response had the same tokens taken twice, under the next step's report.
  if (typeof taken === 'number') advisorTaken.set(agentId, spent)
  else advisorTaken.delete(agentId)
}

// Charges `amount` tokens to the actor's run under `report`, a name the board records once: a model step
// (`<turn>:<index>`) as it answers, and a turn's end (`<turn>`) for what no step reported. False when the board
// did not take it, so it is retried under the same report; undefined when it was never sent (nothing to charge, or no
// run to charge yet), so a step's falls to its turn's end.
async function account(
  $: EngineInterface,
  turnId: string,
  report: string,
  agentId: string | undefined,
  amount: number,
  owner: TurnOwner,
  expectedEpoch: number,
  detail = '',
  model = '',
  wakeAs = '',
): Promise<number | false | undefined> {
  const at = typeof owner === 'string' ? owner : undefined
  const isCurrent = () => expectedEpoch === sessionEpoch && !isEnding && (at !== undefined || owner === generation)
  if (!isCurrent()) return undefined
  if (!Number.isSafeInteger(amount) || amount <= 0 || (agentId && strangers.has(agentId) && !agentRuns.has(agentId))) return undefined

  let listFailed = false
  const agent = agentId ? await $.agent.list().then(agents => agents.find(one => one.id === agentId)).catch(() => { listFailed = true; return undefined }) : undefined
  if (!isCurrent()) return undefined
  const address = agentId && (teammateOf($, agentId, agent) ?? agentId)
  // AT is the run the actor drove when it spent this: a charge that waits is not another run's by the time it lands.
  const dir = at ?? (agentId ? await agentRun($, agentId, agent, listFailed, expectedEpoch, typeof owner === 'number' ? owner : undefined) : await read($, run))
  if (!isCurrent() || !dir) return undefined
  rememberTurnRun(turnId, dir)
  if (retiredRuns.has(dir)) return amount
  // A closed or deleted run is charged nothing more and is no longer this conversation's run.
  const rosterPath = `${dir}/members.json`
  const rosterText = await $.fs.read(rosterPath).catch(async () =>
    await $.fs.exists(rosterPath).catch(() => true) ? '' : undefined,
  )
  if (expectedEpoch !== sessionEpoch || isEnding) return undefined
  if (rosterText === undefined) {
    dropRunPending(dir)
    if (dir === await read($, run)) {
      resetMonitoring()
      agentRuns.clear()
      runEdge = { dir: '' }
      edgesAsked = ''
      strangers.clear()
      await update($, run, () => '')
    }
    return amount
  }
  const isClosed = rosterText !== '' && (() => {
    try { return (JSON.parse(rosterText) as { closed?: boolean }).closed === true } catch { return false }
  })()
  if (isClosed) {
    await released($, dir)
    return amount
  }
  const [turn, actor] = await Promise.all([
    digest(`swarm-turn:${report}`),
    address ? digest(`swarm-agent:${address}`) : Promise.resolve('coordinator'),
  ])
  if (expectedEpoch !== sessionEpoch || isEnding) return undefined
  const wake = wakeAs || (turnWakes.get(turnId) ?? (agentId ? 'wake' : 'user'))
  // The model is a label on the charge: one the board would refuse is left off, never the reason the charge fails.
  const label = /^[A-Za-z0-9._:@/[\]-]{1,100}$/.test(model) ? [model] : []
  const result = await boardCommand($, dir, ['account', turn, actor, String(amount), ...(detail ? [`${wake}:${detail}`, ...label] : [])])
  if (result.exitCode !== 0 || result.stdout.trim() === '') return false
  if (expectedEpoch !== sessionEpoch || isEnding) return amount
  const entry = JSON.parse(result.stdout) as { title: string; total: number; budget: number; paused: boolean; member_paused?: unknown; accepted?: number }
  const accepted = entry.accepted ?? amount
  const pausedName = typeof entry.member_paused === 'string' ? entry.member_paused : ''
  if (pausedName && dir === await read($, run)) {
    if (expectedEpoch !== sessionEpoch || isEnding) return accepted
    // Known at once, as a run's pause is: the member this turn charged is refused from its next tool call on.
    const id = ownedRoster?.dir === dir ? memberNamed(ownedRoster.members, pausedName)?.id : undefined
    memberPaused = new Set([...memberPaused, ...(id ? [id] : []), ...(agentId && (!id || id === address) ? [agentId] : [])])
    if (!memberPausesTold.has(pausedName)) {
      memberPausesTold.add(pausedName)
      memberPausesOwed.push({ name: pausedName, read: rosterReads })
    }
  }
  if (!entry.paused || dir !== await read($, run)) return accepted
  if (expectedEpoch !== sessionEpoch || isEnding) return accepted
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
  if (isTold) return accepted
  noticeHold = (await $.clock.now()) + NOTICE_HOLD_MS
  wakeNext = 'pause'
  void $.prompt.submit({
    text: `Swarm: Run paused at token budget\n${entry.title} spent ${compact(entry.total)} tokens and reached its budget of ${compact(entry.budget)}. Tell the user what is done and ask whether to raise the budget with limit and then resume, or close the run.`,
  }).then(result => { if (result.drop) { noticeHold = 0; wakeNext = ''; unheard() } }).catch(() => { noticeHold = 0; wakeNext = ''; unheard() })
  return accepted
}

// A member of a paused or spent run is refused its next tool call, so a turn in flight ends there instead of
// spending on. The coordinator is never refused: it has to report, raise the budget and resume.
// A pause is no retirement: what the member found so far is paid for, so its last report carries it. That report is
// never refused (see the tool.call guard), or the host asks for it again and again at the member's full context.
const HAND_BACK = 'Make no other tool call but one: if your findings are not on the board yet, put them there now, which is taken while the run is paused: use the board\'s post action with a text that begins "@coordinator HAND-BACK:" (everything you have found so far, what you covered, what you did not). Use ready instead only if the whole assignment is done. Then end your turn now with your final report (SubagentHandback, if you were told to use it).'
const MEMBER_PAUSED = `This Swarm member has spent its own token budget, so this tool call was not run. ${HAND_BACK} The coordinator decides whether you go on.`
/** The refusal the roster alone settles, with no lookup that can fail: a retired member, or one paused on its own budget. */
function stoppedMember(agentId: string, reporting = false): string | undefined {
  const address = teammates.get(agentId)
  const has = (ids: ReadonlySet<string>) => ids.has(agentId) || (address !== undefined && ids.has(address))
  // A member that was replaced or removed may still be mid-turn: it builds and edits beside the team that took over.
  if (has(cancelledSpawns) || has(retired) || has(killConfirmed)) return 'This Swarm member has been retired, so this tool call was not run. Make no more tool calls: end your turn now with one line saying where you stopped.'
  // A paused member's report is what the pause must not lose: `reporting` lets that one board action through.
  if (has(memberPaused) && !reporting) return MEMBER_PAUSED
  return undefined
}

/** A member's command that is nothing but the board's `ready` or `post`: its report, which a pause lets through. */
function reportsOnly(e: { agentId?: string; tool: string; command?: unknown }): boolean {
  const said = e.agentId !== undefined && e.tool === 'Bash' ? String(e.command) : ''
  const reports = boardCalls(said)
  return reports.length > 0 && reports.every(c => (c.action === 'ready' || c.action === 'post') && !c.piped) &&
    splitShellSegments(said).length === reports.length && substitutions(said).length === 0 && !writesFile(said)
}
/** True when a command, outside its quotes, opens a file to write: any `>` but a descriptor copy such as `2>&1`, or `<>`. */
const writesFile = (command: string) =>
  /<>|>(?!&(?:\d+|-)(?:\s|$))/.test(command.replace(/\$'(?:\\[\s\S]|[^\\'])*'?|'[^']*'?|"(?:\\[\s\S]|[^\\"])*"?|\\[\s\S]/g, '_'))

const OVER = 'This Swarm run is over and its conversation drives another run now, so this tool call was not run. Make no more tool calls: end your turn now with one line saying where you stopped.'
async function refusal($: EngineInterface, agentId: string | undefined, reporting = false): Promise<string | undefined> {
  if (agentId === undefined) return isKillTurn ? 'The user ended the Swarm run with /swarm-kill. End your turn now, in one line.' : undefined
  const stopped = stoppedMember(agentId, reporting)
  if (stopped) return stopped
  const sEpoch = sessionEpoch
  const owner = generation
  // The run this conversation drives, or drove until its close: closing it makes no earlier run's agents welcome.
  const active = (await read($, run).catch(() => '')) || closedRun
  if (sEpoch !== sessionEpoch || owner !== generation || isEnding) return undefined
  if (!halted && !active) {
    // After a restart/resume, a closed or killed run is no longer in `run` or `closedRun`: check whether this
    // registered member (including a general-purpose stand-in) belongs to one so retired members are blocked on
    // read-only tools (Read/Grep/Glob) too.
    if (strangers.has(agentId) && !agentRuns.has(agentId)) return undefined
    try {
      let listFailed = false
      const agents = await $.agent.list().catch(() => { listFailed = true; return [] as AgentInfo[] })
      if (sEpoch !== sessionEpoch || owner !== generation || isEnding) return undefined
      const agent = agents.find(one => one.id === agentId)
      const dir = agentRuns.get(agentId) ?? await agentRun($, agentId, agent, listFailed, sEpoch, owner)
      if (sEpoch !== sessionEpoch || owner !== generation || isEnding) return undefined
      if (!dir) return undefined
      const state = await $.fs.read(`${dir}/members.json`)
        .then(text => JSON.parse(text) as { closed?: boolean; members?: Roster })
        .catch(() => undefined)
      if (sEpoch !== sessionEpoch || owner !== generation || isEnding) return undefined
      if (!state?.members) return undefined
      const stoppedIds = agentIdsOf(state.members, agents, member => Boolean(member.killed))
      const address = teammates.get(agentId) ?? agent?.teammateId
      if (state.closed) {
        if (!closedRun) closedRun = dir
        if (!ownedRoster || ownedRoster.dir !== dir) {
          ownedRoster = { dir, closed: true, members: state.members }
        }
        retired = new Set([...retired, ...stoppedIds])
      } else if (stoppedIds.has(agentId) || (address !== undefined && stoppedIds.has(address))) {
        retired = new Set([...retired, ...stoppedIds])
      }
      return stoppedMember(agentId, reporting)
    } catch {
      return undefined
    }
  }
  try {
    // The run the agent belongs to, as the board has it: one this conversation drove before the run it drives now
    // has nobody left to guard its agents, whatever tool they call. Asked of the board once per agent, so a resume,
    // which forgets the runs driven before, forgets none of this.
    const dir = agentRuns.get(agentId) ?? (strangers.has(agentId) ? '' :
      await agentRun($, agentId, (await $.agent.list()).find(one => one.id === agentId), false, sEpoch, owner))
    if (sEpoch !== sessionEpoch || owner !== generation || isEnding) return undefined
    if (dir && active && dir !== active) return OVER
    if (dir !== halted?.dir || reporting) return undefined
    return `This Swarm run is ${halted.why}, so this tool call was not run. ${HAND_BACK} The coordinator decides what happens when the run resumes.`
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
          owedSeqs = []
          break
        }
      }
    }
    for (const c of isCut ? [] : calls) {
      if (c.action !== 'show' || c.piped || /(?:^|\s)--before=/.test(c.rest) ||
        !RUN.test(c.dir) || await resolveRunDir($, c.dir) !== dir) continue
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
    if (agentId === undefined && calls.some(c => ['member', 'replace', 'pause', 'resume', 'limit', 'close', 'kill'].includes(c.action))) {
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
  // A diff or an older page still loading belongs to the visit this ends: back on the same run, neither opens.
  diffAsked++
  loadingDiffSeq = 0
  boardNavigation++
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
  const parsed = parse(dir, board, roster, agents, KEPT, report)
  const mood: Mood = parsed.isClosed ? 'sleep'
    : parsed.isPaused ? 'paused'
      : (parsed.attention.length > 0 || parsed.members.some(needsMemberAttention)) ? 'attention' : 'sleep'
  return { ...parsed, mood, attentionUnavailable: !report, boardUnavailable }
}

/** Reads the browsed run again in place: the tab, the open post and the scroll stay as they are. */
async function reloadBrowsed($: EngineInterface): Promise<void> {
  const dir = browsed?.dir
  if (dir === undefined) return
  const gen = ++browseGen
  retryingRun = gen
  $.ui.invalidate('ui.render')
  try {
    const roster = await $.fs.read(`${dir}/members.json`)
    const next = await readRun($, dir, roster, (JSON.parse(roster) as { closed?: boolean } | null)?.closed === true)
    if (gen !== browseGen || browsed?.dir !== dir) return
    browsed = next
  } catch {
    if (gen === browseGen) $.ui.toast('Swarm could not read this run again.')
  } finally {
    if (retryingRun === gen) retryingRun = 0
    $.ui.invalidate('ui.render')
  }
}

/**
 * A run's folder name, by which it is found among the project's runs: the board names a run by its real path, which a
 * symlinked project folder (macOS's /tmp, say) spells otherwise than the session's folder.
 */
const runName = (dir: string) => dir.slice(dir.lastIndexOf('/') + 1)
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
    if (names[index] === runName(liveDir)) return { index, dir: liveDir }
    const dir = `${root}/${names[index]}`
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
    const at = names.indexOf(runName(dir))
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
    const at = names.indexOf(runName(shownDir))
    const runFrom = (index: number, by: 1 | -1) => runFromAt($, root, names, live.dir, index, by)
    // A run the list does not hold has no neighbours in it: from nowhere, the newest run is no older one.
    if (step !== 0 && at < 0 && shownDir !== '') {
      $.ui.toast('Swarm could not find this run among the project\'s runs.')
      return
    }
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
    // The one action a pause leaves open: the report of what the member found, which nothing else saves.
    if (e.action !== 'ready' && e.action !== 'post') return { deny: `This Swarm run is ${why}, so this tool call was not run. ${HAND_BACK} The coordinator decides what happens when the run resumes.` }
  }
  if (!closed && member.paused && e.action !== 'ready' && e.action !== 'post') return { deny: MEMBER_PAUSED }
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
  if (writesPost && (closed || !text || text.length > TEXT_LIMIT)) {
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
  // The coordinator's own name on its own read says nothing more. Seen live: refused, it cost a whole step at 150k.
  if (action === 'read' && typeof e.name === 'string' && e.name.trim().replace(/^@/, '').toLowerCase() === 'coordinator') e = { ...e, name: undefined }
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
  if (action === 'limit' && breaksBudget(options, await standingBudget($))) return { deny: BUDGET_IS_USERS }
  if (e.seq !== undefined && (!Number.isSafeInteger(e.seq) || e.seq < 1)) return { deny: 'seq is a positive post number.' }
  const text = typeof e.text === 'string' ? e.text.trim() : ''
  const oneLine = [e.title, e.out].find(value => typeof value === 'string' && /\n/.test(value))
  if (oneLine !== undefined || text.length > TEXT_LIMIT) return { deny: 'title and out are one line each, and text at most 12,000 characters.' }
  const owned = await read($, run)
  // init is how the skill may make a run with this tool; anything else needs the run this conversation drives.
  if (action !== 'init' && !owned) return { deny: NO_RUN_BOARD }
  const dir = action === 'init' ? `${await $.session.cwd()}/.swarm/${e.name!.trim()}` : owned
  const shown = action === 'show' ? showArgs(e) : []
  if ('deny' in shown) return shown
  const args = action === 'init' ? [action, e.title!.trim()]
    : action === 'member' || action === 'retry' ? [action, name, ...options]
    : action === 'limit' ? [action, ...options]
    : action === 'post' || action === 'read' ? [action, 'coordinator', ...(action === 'read' ? [`--max-bytes=${PAGE}`, '--attention'] : [])]
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
// The longest text the board tool takes for a post, a report or a reason.
const TEXT_LIMIT = 12_000
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
  const asked = ++diffAsked
  loadingDiffSeq = seq
  $.ui.invalidate('ui.render')
  const git = (args: string[]) => $.process.run(['git', '-C', project, ...args], { timeoutMs: 10_000 })
    .catch(error => ({ exitCode: 1, stdout: '', stderr: String(error) }))
  const shape = ['--stat', '--patch', '--no-color', '--no-ext-diff']
  try {
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
    if (sEpoch !== sessionEpoch || (await shownSwarm($)).dir !== dir || asked !== diffAsked) return
    if (shown.exitCode !== 0) {
      $.ui.toast(`Swarm could not show ${revision.slice(0, 12)}: ${clean(shown.stderr).trim().split('\n')[0] || 'git failed'}`)
      return
    }
    const text = clip(clean(shown.stdout).trimEnd(), DIFF_CLIP)
    // A fence longer than any run of backticks in the diff, so a Markdown file's own fences stay inside it.
    const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(run => run[0].length + 1)))
    // Asked again as it is stored: a newer diff may have been shown during the await above.
    await update($, diff, current => asked === diffAsked ? { seq, text: `${scope}\n${fence}diff\n${text}\n${fence}` } : current)
  } finally {
    if (asked === diffAsked) {
      loadingDiffSeq = 0
      $.ui.invalidate('ui.render')
    }
  }
}

/** Writes the shown run's Markdown summary with the board's export and says where. */
async function exportRun($: EngineInterface, dir: string): Promise<void> {
  if (exportingRun) return
  // Its own number: one a session change left running neither ends a newer export's "Exporting…" nor speaks for it.
  const asked = ++exportAsked
  exportingRun = asked
  $.ui.invalidate('ui.render')
  try {
    const written = await boardCommand($, dir, ['export']).catch(error => ({ exitCode: 1, stdout: '', stderr: String(error) }))
    const path = clean(written.stdout).trim().split('\n').at(-1) ?? ''
    if (exportingRun === asked) $.ui.toast(written.exitCode === 0 && path ? `Swarm wrote ${path}` : `Swarm: ${clean(written.stderr).trim() || 'the board\'s export command failed'}`)
  } finally {
    if (exportingRun === asked) exportingRun = 0
    $.ui.invalidate('ui.render')
  }
}

// The band's button that opens the pane.
function shortcut($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0], singleCaption = false, shown?: Swarm, emblemOffset = 0, besidePeer = false) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const isLive = shown !== undefined && shown.dir !== '' && !shown.isClosed
  const working = isLive ? shown.members.filter(m => m.status === 'working').length : 0
  const coordinating = isLive ? shown.members.filter(m => m.status === 'coordinating').length : 0
  const attentionCount = isLive ? shown.attention.length : 0
  const isPrimary = isLive && (!shown.isPaused || attentionCount > 0)
  const badgeParts: string[] = []
  if (isLive) {
    if (shown.isPaused) badgeParts.push('paused')
    else if (working > 0) badgeParts.push(`${working} working`)
    else if (coordinating > 0) badgeParts.push(`${coordinating} coordinating`)
    if (attentionCount > 0) badgeParts.push(`${attentionCount} attention`)
  }
  const badgeText = badgeParts.join(' · ')
  const badgeColor = shown?.isPaused || attentionCount > 0 ? 'warning' : working > 0 ? 'success' : 'claude'
  const showBadge = badgeText !== '' && !singleCaption
  const button = showBadge ? (
    <Button
      key={SHORTCUT}
      variant={isPrimary ? 'primary' : 'secondary'}
      label={`Swarm Board · ${badgeText}`}
      onPress={() => void openBoard($).catch(() => undefined)}
    >
      Swarm Board
      <Text size="caption" weight="medium" color={isPrimary ? undefined : badgeColor} tabular>{` · ${badgeText}`}</Text>
    </Button>
  ) : (
    <Button
      key={SHORTCUT}
      variant={isPrimary ? 'primary' : 'secondary'}
      label="Swarm Board"
      onPress={() => void openBoard($).catch(() => undefined)}
    />
  )
  if (e.surface === 'terminal') return button
  const { Svg } = $.ui.resolve(e)
  const state = shown ? emblemStateOf(shown) : 'idle'
  if (e.surface !== 'desktop') {
    return (
      <Box flexDirection="row" alignItems="center" flexShrink={0} columnGap="xs">
        <Box flexShrink={0}><Svg source={swarmEmblem(state, emblemOffset)} alt="Swarm" width={16} height={16} /></Box>
        {button}
      </Box>
    )
  }
  // Cover the composer's tinted inset with the same theme surface as the crab.
  // Keep the honeycomb emblem beside the native Button (not trapped inside a separate outer border)
  // so the entire button pill highlights uniformly from edge to edge on mouse hover.
  // When placed beside Crab Buddy, keep flexShrink={0} and positive right clearance so Crab Buddy's
  // negative left inset margin overlaps only the matching background padding and never clips the button.
  return (
    <Box
      flexDirection="row"
      alignItems="center"
      flexShrink={0}
      columnGap="xs"
      backgroundColor="userMessageBackground"
      marginLeft={-2}
      paddingLeft={2}
      marginRight={besidePeer ? 0 : -2}
      paddingRight={2}
      marginTop={-2}
      paddingTop={singleCaption ? 3 : 2}
      marginBottom={-1.16}
      paddingBottom={singleCaption ? 0.16 : 1.16}
    >
      <Box flexShrink={0}><Svg source={swarmEmblem(state, emblemOffset)} alt="Swarm" width={16} height={16} /></Box>
      {button}
    </Box>
  )
}

type RichRenderEvent = Extract<Parameters<EngineInterface['ui']['resolve']>[0], { surface: 'desktop' | 'vscode' | 'mobile' }>
type AnyRenderEvent = Parameters<EngineInterface['ui']['resolve']>[0]

function GraphControls(
  $: EngineInterface,
  e: RichRenderEvent,
  props: {
    shown: Swarm
    isLiveVisible: boolean
    live: boolean
    browsed: boolean
    index: number
    last: number
    playing: boolean
    isExpanded: boolean
    hasBroadcast: boolean
    liveOffset: number
    timelineRatio: number
    timelineBarWidth: number
    timelineOffset: number
    inactiveControl: ReturnType<typeof shortcut>
  },
) {
  const { Box, Text, Button, Svg } = $.ui.resolve(e)
  const { shown, isLiveVisible, live, browsed: isBrowsed, index, last, playing, isExpanded, hasBroadcast, liveOffset, timelineRatio, timelineBarWidth, timelineOffset, inactiveControl } = props
  // A step that leads nowhere is text, not a control that does nothing.
  const step = (key: string, label: string, seq: number | undefined) => seq === undefined
    ? <Text key={key} dimColor>{label}</Text>
    : <Button key={key} plain onPress={() => seek($, seq)}>{label}</Button>
  return (
    <Box
      key="graph-controls"
      flexDirection="column"
      gap="xs"
      borderStyle="round"
      borderColor="subtle"
      borderDimColor
      hover={{ borderDimColor: false }}
      paddingX="sm"
      paddingY="xs"
      minWidth={0}
    >
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" columnGap="sm" rowGap="xs" minWidth={0}>
        {isLiveVisible ? (
          <Box flexDirection="row" alignItems="center" gap="xs">
            <Box flexShrink={0}><Svg key="live-indicator" source={liveIndicator(liveOffset)} alt="Live activity" width={16} height={16} /></Box>
            <Text weight="semibold" color="success">Live</Text>
          </Box>
        ) : (
          <Box flexDirection="row" alignItems="center" gap="sm">
            <Text dimColor={!shown.isPaused || shown.isClosed || !live} color={live && shown.isPaused && !shown.isClosed ? 'warning' : undefined} weight={live && shown.isPaused && !shown.isClosed ? 'medium' : undefined} tabular>
              {live ? (shown.isPaused && !shown.isClosed ? 'Paused' : 'Latest post') : `Post ${index + 1} of ${shown.posts.length}`}
            </Text>
            {!live && (
              <Button key="replay-live" plain label={shown.isClosed || isBrowsed ? 'Latest' : 'Go live'} onPress={() => seek($, 0)} />
            )}
          </Box>
        )}
        <Box flexDirection="row" columnGap="sm" rowGap="xs" alignItems="center" flexWrap="wrap" minWidth={0}>
          {hasBroadcast ? (
            <Button
              key="expand-all"
              plain
              dimColor={!isExpanded}
              label={isExpanded ? 'Collapse @all' : 'Expand @all'}
              onPress={() => update($, expandAll, isOn => !isOn)}
            />
          ) : (
            <Text key="expand-all" dimColor>Expand @all</Text>
          )}
          {inactiveControl}
        </Box>
      </Box>
      <Box flexDirection="row" gap="xs" alignItems="center" flexWrap="wrap" minWidth={0}>
        <Text size="caption" weight="semibold" dimColor>Replay</Text>
        {step('replay-first', 'First', index > 0 ? shown.posts[0]!.seq : undefined)}
        {step('replay-back', '‹ Prev', index > 0 ? shown.posts[index - 1]!.seq : undefined)}
        {last > 0
          ? <Button key="replay-play" variant={playing ? 'primary' : 'secondary'} label={playing ? 'Pause' : 'Play'} onPress={() => play($)} />
          : <Text key="replay-play" dimColor>Play</Text>}
        {step('replay-next', 'Next ›', index < last ? shown.posts[index + 1]!.seq : undefined)}
        {step('replay-last', 'Last', index < last ? shown.posts[last]!.seq : undefined)}
      </Box>
      {shown.posts.length > 1 && (
        <Svg
          source={progressBar(timelineRatio, isLiveVisible ? 'success' : 'accent', playing, timelineOffset, timelineBarWidth)}
          alt={`Timeline position ${index + 1} of ${shown.posts.length}`}
          width={timelineBarWidth}
          height={6}
        />
      )}
    </Box>
  )
}

function GraphCanvas(
  $: EngineInterface,
  e: RichRenderEvent,
  props: {
    source: string | undefined
    isLegible: boolean
    post: Post
    columns: number
    drawnMembers: Swarm['members']
    hiddenRoutes: number
    legendHeight?: number
    fallbackRoutes: ReturnType<typeof shortcut>
  },
) {
  const { Box, Text, Svg } = $.ui.resolve(e)
  const { source, isLegible, post, columns, drawnMembers, hiddenRoutes, legendHeight, fallbackRoutes } = props
  if (source === undefined) {
    return (
      <Box key="route-list" flexDirection="column" gap="xs" minWidth={0}>
        <Text dimColor>{isLegible ? 'Too many routes to draw at once, so they are listed.' : 'The pane is too narrow to draw this graph legibly, so its routes are listed.'}</Text>
        {fallbackRoutes}
      </Box>
    )
  }
  return (
    <Box flexDirection="column" gap="sm" minWidth={0}>
      <Svg
        key="message-routes"
        source={source}
        width={1024}
        height={graphHeight(columns, drawnMembers, legendHeight)}
        alt={`Post ${post.seq} · @${post.agent}${post.to.length ? ` to ${post.to.map(name => `@${name}`).join(', ')}` : ' · no mentions'}. A mention graph of ${counted(drawnMembers.length, 'member')}: List the routes below for each one in words.`}
        isInteractive
      />
      {hiddenRoutes > 0 && (
        <Text size="caption" dimColor>{`${counted(hiddenRoutes, 'quieter route')} not drawn: one drawing holds only so many.`}</Text>
      )}
    </Box>
  )
}

function GraphRouteList(
  $: EngineInterface,
  e: RichRenderEvent,
  props: {
    listed: boolean
    onToggle: () => void
    content: ReturnType<typeof shortcut>
  },
) {
  const { Box, Button } = $.ui.resolve(e)
  const { listed, onToggle, content } = props
  return (
    <Box flexDirection="column" gap="sm" minWidth={0}>
      {/* The host reads a drawing's alt and nothing inside it: the routes in words are one press away, in reach of the keyboard. */}
      <Button
        key="graph-routes"
        plain
        dimColor
        label={listed ? 'Hide the route list' : 'List the routes'}
        onPress={onToggle}
      />
      {listed && <Box key="graph-route-list" flexDirection="column" minWidth={0}>{content}</Box>}
    </Box>
  )
}

function GraphMembersStrip(
  $: EngineInterface,
  e: AnyRenderEvent,
  props: {
    members: Swarm['members']
    hueOf: (name: string) => (typeof HUES)[number] | 'subtle'
    onFeed: (name: string) => Promise<void>
  },
) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const { members, hueOf, onFeed } = props
  if (members.length === 0) return null
  return (
    <Box key="graph-members" flexDirection="row" columnGap="sm" rowGap="xs" flexWrap="wrap" alignItems="center" minWidth={0}>
      <Text size="caption" weight="semibold" dimColor>Feed of</Text>
      {members.map(member => (
        <Box key={`graph-feed-wrap-${member.name}`} flexDirection="row" alignItems="center" columnGap="xs">
          <Text color={hueOf(member.name)}>●</Text>
          <Button key={`graph-feed-${member.name}`} plain label={`@${member.name}`} onPress={() => onFeed(member.name)} />
        </Box>
      ))}
    </Box>
  )
}

function GraphPostCard(
  $: EngineInterface,
  e: RichRenderEvent,
  props: {
    post: Post
    postKind: ReturnType<typeof verdictOf>
    time: string
    detailsOpen: boolean
    strippedGraphBody: string
    graphPostBody: string
    hue: (typeof HUES)[number] | 'subtle'
    onOpenAgent: () => Promise<void>
    onToggleDetails: () => Promise<void>
  },
) {
  const { Box, Text, Button, Markdown, Svg } = $.ui.resolve(e)
  const { post, postKind, time, detailsOpen, strippedGraphBody, graphPostBody, hue, onOpenAgent, onToggleDetails } = props
  return (
    <Box
      key="graph-post"
      flexDirection="column"
      gap="xs"
      borderStyle="round"
      borderColor={postKind?.color ?? 'subtle'}
      borderDimColor
      hover={{ borderDimColor: false }}
      paddingX="sm"
      paddingY="xs"
      minWidth={0}
    >
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" columnGap="sm" minWidth={0}>
        <Box flexDirection="row" alignItems="center" columnGap="xs" flexWrap="wrap" minWidth={0}>
          <Text color={hue}>●</Text>
          <Button
            key="graph-post-agent"
            plain
            label={`@${post.agent}`}
            onPress={onOpenAgent}
          />
          <Text dimColor>{post.to.length ? `→ ${(detailsOpen ? post.to : post.to.slice(0, 2)).map(name => `@${name}`).join(' ')}` : '· no mentions'}</Text>
          {post.to.length > 2 && !(detailsOpen && strippedGraphBody.length > CLIP) && (
            <Button key="graph-post-recipients" plain dimColor label={detailsOpen ? 'Show fewer' : `+${post.to.length - 2} more`} onPress={onToggleDetails} />
          )}
          {postKind !== undefined && (
            <Box flexDirection="row" alignItems="center" columnGap="xs">
              <Box flexShrink={0}><Svg source={semanticIcon(verdictIconOf(postKind.label))} alt={postKind.label} width={12} height={12} /></Box>
              <Text size="caption" weight="semibold" color={postKind.color}>{postKind.covered?.length ? `${postKind.label} · ${postKind.covered.map(name => `@${name}`).join(' ')}` : postKind.label}</Text>
            </Box>
          )}
        </Box>
        <Text size="caption" dimColor tabular>{`#${post.seq}${time ? ` · ${time}` : ''}`}</Text>
      </Box>
      {detailsOpen && postKind?.covered && (
        <Text size="caption" color="warning">{`Partial pass of ${postKind.covered.map(name => `@${name}`).join(', ') || 'some workers'}: their pieces only, not the run's pass.`}</Text>
      )}
      {graphPostBody !== '' && (
        <Box flexShrink={1} minWidth={0}>
          <Markdown text={formatMarkdown(graphPostBody)} />
        </Box>
      )}
      {strippedGraphBody.length > CLIP && (
        <Button
          key="graph-post-details"
          plain
          dimColor
          label={detailsOpen ? '▴ Show less' : '▾ Show more'}
          onPress={onToggleDetails}
        />
      )}
    </Box>
  )
}

export const register: Register = on => {
  // Keep the SVG source stable while it is on screen. Only a different drawing or a remount needs a fresh offset.
  // Non-interactive <img> animations (hiveArt, liveIndicator) pass continuous=true so Desktop's full-sibling redraws
  // resume mid-cycle at `now - clock.start` instead of restarting from 0ms.
  const clocks = new Map<string, { scene: string; view: string; start: number; offset: number; visible: boolean }>()
  function phase(slot: string, scene: string, view: string, now: number, restart = false, continuous = false): number {
    let clock = clocks.get(slot)
    if (!clock || clock.scene !== scene || restart) {
      clock = { scene, view, start: now, offset: 0, visible: true }
      clocks.set(slot, clock)
    } else if (continuous || clock.view !== view || !clock.visible) {
      clock.view = view
      clock.offset = Math.max(0, now - clock.start)
      clock.visible = true
    }
    return clock.offset
  }
  function hideMotion(slot: string): void {
    const clock = clocks.get(slot)
    if (clock) clock.visible = false
  }

  on('session.start', async ($, e, next) => {
    poller?.cancel()
    clocks.clear()
    userFigures.clear()
    clearHeldStatuses()
    sessionEpoch++
    browseGen++
    resetMonitoring()
    agentRuns.clear()
    runEdge = { dir: '' }
    edgesAsked = ''
    strangers.clear()
    stepped.clear()
    turnRuns.clear()
    turnWakes.clear()
    forgetSpend()
    wokenAgents.clear()
    wakeNext = ''
    retiredRuns.clear()
    strandedFrom = 0
    teammates.clear()
    pendingStarts.clear()
    spawnEfforts.clear()
    spawnIsolations.clear()
    sharedAgents.clear()
    isolatedAgents.clear()
    isCoordinatorBusy = isEnding = isRefreshOwed = isPaneOpen = isWatched = false
    activeCoordinatorTurnId = undefined
    // A start that follows no session.end (a reload) still opens its run's pane and reads its state anew.
    opened = closedRun = titleOpen = ''
    loadingDiffSeq = 0
    loadingHistory = retryingRun = 0
    exportingRun = 0
    // A load the last session started is not this one's, even for the same run.
    boardNavigation++
    diffAsked++
    sawSwarmCommand = false
    pluginBoardScript = normalizePath(`${$.plugin.root}/skills/swarm/scripts/board.py`)
    forgetKills()
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
      await $.command.register({
        name: 'swarm-kill',
        immediate: true,
        argumentHint: '[reason]',
        description: 'End this conversation\'s Swarm run now, even mid-turn: retire every member, close the run, commit and revert nothing',
      })
      await $.tool.register({
        name: 'board',
        description: 'Swarm board (/swarm:swarm runs only). Members: read, show, post, status (+ ready, revise). Coordinator: all actions.',
        isDeferred: false,
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: { enum: ['read', 'show', 'post', 'ready', 'revise', 'status', 'init', 'member', 'limit', 'plan', 'attention', 'confirm', 'retry', 'replace', 'pause', 'resume', 'close', 'export'] },
            member: { type: 'string', description: 'show: member filter.' },
            seq: { type: 'integer', minimum: 1, description: 'Post # (show, confirm).' },
            text: { type: 'string', maxLength: TEXT_LIMIT, description: 'Message/reason (post, ready, revise, pause).' },
            commit: { type: 'string', description: 'ready: full 40/64-char commit SHA (not HEAD).' },
            title: { type: 'string', description: 'init: run title.' },
            name: { type: 'string', description: 'init: folder name; member/retry/replace/confirm/resume: member.' },
            newName: { type: 'string', description: 'replace: successor name.' },
            options: { type: 'array', items: { type: 'string' }, description: 'member/limit/replace: key=value opts.' },
            out: { type: 'string', description: 'export: output path (default: summary.md).' },
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
      const stopped = await refusal($, e.agentId, e.agentId !== undefined && (e.action === 'ready' || e.action === 'post'))
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
    // A plugin-issued stop is part of retiring a late spawn, including during the coordinator's kill turn.
    if (e.tool === 'TaskStop' && typeof e.task_id === 'string' && cancelledSpawns.has(e.task_id)) return next(e)
    // A tool call in the main conversation means the coordinator is mid-turn, even when this
    // module loaded after that turn began (a restart, a reload) and never saw it start.
    if (e.agentId === undefined) isCoordinatorBusy = true
    // A member's final report ends its run and spends nothing more: refused, the host demands it again each turn.
    if (e.agentId !== undefined && (e.tool as string) === 'SubagentHandback') return next(e)
    // A member's command that is nothing but the board's `ready` or `post` reports as the board tool does: let through a pause.
    const reporting = reportsOnly(e)
    const stopped = await refusal($, e.agentId, reporting)
    if (stopped) return { deny: stopped }
    const ceiling = e.agentId === undefined ? undefined : contextCeiling(e.agentId, e.tool)
    if (ceiling) return { deny: ceiling }
    const lookup = e.agentId === undefined
      ? await coordinatorRead($, e.tool, String((e as { file_path?: unknown; path?: unknown }).file_path ?? (e as { path?: unknown }).path ?? ''))
      : {}
    if (lookup.deny) return { deny: lookup.deny }
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
    if (command && waitsOnLooseMatch(command) && await read($, run)) {
      return { deny: 'Nothing ran: this command waits on a loose process match, which can match unrelated command lines. Match the process name exactly with `pgrep -x NAME`, or wait on the PID of a process you started.' }
    }
    const calls = e.tool === 'Bash' ? boardCalls(command) : []
    if (e.agentId === undefined && e.tool === 'Bash') {
      const deny = await bashLimitDenial($, command, calls)
      if (deny) return { deny }
    }
    const isCoordinatorBg = e.agentId === undefined && (e.tool === 'Monitor' || (e.tool === 'Bash' && e.run_in_background === true))
    const isMemberGuard = e.agentId !== undefined && (e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'NotebookEdit' || e.tool === 'Bash')
    let bgWarning: string | undefined
    let bgWarnedDir = ''
    let guarded: [string, Roster[string]] | undefined
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
              if (bgWarnedRun !== activeDir) {
                bgWarning = 'Swarm: Running a background Bash command while driving a Swarm run will wake the coordinator and re-read its whole conversation when it finishes.'
                bgWarnedDir = activeDir
              }
            }
          } else {
            let listFailed = false
            const agents = await $.agent.list().catch(() => { listFailed = true; return [] as AgentInfo[] })
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
            if (!found && (agentRuns.get(e.agentId) ?? await agentRun($, e.agentId, agent, listFailed)) === activeDir) {
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
            if (memberName && memberName !== 'coordinator' && member) guarded = [memberName, member]
            // A roster read just now may have retired it.
            const stoppedNow = stoppedMember(e.agentId, reporting)
            if (stoppedNow) return { deny: stoppedNow }
            // The owned roster naming this agent settles its run: a lookup that fails, by throwing or by an
            // error exit, must not let a known member past the guard.
            const memberDir = guarded ? activeDir : agentRuns.get(e.agentId) ?? await agentRun($, e.agentId, agent, listFailed)
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
      // Fail closed for a known member of the owned run; only safe own-member board commands pass so it can report.
      if (guarded === undefined) throw error
      if (e.tool !== 'Bash' || !isSafeMemberBoardBash(command, guarded[0], guarded[1], normalizePath(`${$.plugin.root}/skills/swarm/scripts/board.py`))) {
        return { deny: `Swarm could not check @${guarded[0]}'s call against the run's roster (${error instanceof Error ? error.message : String(error)}), so it was refused. Report this sentence to the coordinator.` }
      }
    }
    // In a substitution the folder is not printed: the script typed out, or a variable of this command that holds it.
    const isHiddenInit = substitutions(command).some(body => /\bboard\.py\b[^\n;|&]*\sinit\s/.test(body) ||
      runsHeldInit(`${command.replace(/\$\([\s\S]*$/, '')}\n${body}`))
    const mayMake = e.tool === 'Bash' && e.agentId === undefined && !calls.some(c => c.action === 'init') && (isHiddenInit || runsHeldInit(command))
    // The run the pointer names before the command: an init that failed inside it leaves the pointer on an older run.
    // Absent counts as a pointer read; one that could not be read leaves nothing to compare, and no run is inferred.
    const pointed = mayMake ? await $.session.cwd().then(async cwd => {
      const path = `${cwd}/.swarm/current`
      return await $.fs.exists(path) ? (await $.fs.read(path)).trim() : ''
    }).catch(() => undefined) : undefined
    const headBefore = headWatch ? await headOf($, headWatch.checkout) : ''
    const raw = await pauseAware($, calls, e.agentId, () => next(e)).finally(() => {
      if (agentCall) {
        spawnEfforts.delete(agentCall)
        spawnIsolations.delete(agentCall)
      }
    })
    let result = raw
    if (e.agentId !== undefined && result.deny === undefined) {
      const spend = spendNotes(e.agentId)
      if (spend.length > 0) result = { ...result, context: [...(result.context ?? []), ...spend] }
    }
    if (bgWarning && result.deny === undefined && result.isError === undefined) {
      bgWarnedRun = bgWarnedDir
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
    if (mayMake && !result.isError && !result.deny) {
      // `R=$(board.py … init …)` keeps the folder out of the output and the call out of what is read off the
      // command. Read loosely, however the script is run, but only inside a substitution: the same words in a
      // quoted string or a heredoc make no run. The pointer `init` just wrote names the run; the board refuses
      // one another conversation owns.
      // `S=…/board.py; python3 $S … init …` hides the script behind a variable instead: a statement must run that
      // variable with `init` after it, and the command must have printed the run folder the pointer names, as
      // `init` does. Text that only prints such words runs nothing and makes no run.
      // The new run also takes the place of one this conversation drove and closed, as a plain `init` does.
      // Either way only a pointer the command moved names a run it made.
      let isMade = false
      try {
        const root = `${await $.session.cwd()}/.swarm`
        const name = (await $.fs.read(`${root}/current`)).trim()
        const made = pointed !== undefined && name !== pointed && /^[\w.-]+$/.test(name) && RUN.test(`${root}/${name}`) ? `${root}/${name}` : ''
        const printed = String((raw.result as { stdout?: unknown } | undefined)?.stdout ?? '').split('\n').map(line => line.trim())
        // By its name: the folder is printed as the command spelled it, which a symlink or the letter case can vary.
        isMade = made !== '' && (isHiddenInit || printed.some(line => line.endsWith(`/.swarm/${name}`)))
        const ownedNow = await read($, run)
        if (isMade && made && (ownedNow === '' || (ownedRoster?.dir === ownedNow && ownedRoster.closed))) await bind($, made)
      } catch {
        // No pointer, no run to claim.
      }
      // Hidden in a substitution, behind a variable or not, it is an `init`: the same words go with it.
      const notes = isMade ? await initNotes($).catch(() => []) : []
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
      // The parser may be what failed: a report it cannot read is no report.
      let reporting = false
      try { reporting = reportsOnly(e) } catch { /* refused below as any other call */ }
      const stopped = stoppedMember(e.agentId, reporting)
      if (stopped) return { deny: stopped }
      if (halted && agentRuns.get(e.agentId) === halted.dir && !reporting) {
        return { deny: `This Swarm run is ${halted.why}, so this tool call was not run. ${HAND_BACK} The coordinator decides what happens when the run resumes.` }
      }
      // A check that failed or ran out of time lets no known member edit or run arbitrary Bash unchecked; only safe
      // own-member board commands pass so it can report.
      const address = teammates.get(e.agentId)
      const found = Object.entries(ownedRoster?.members ?? {}).find(([name, member]) => name !== 'coordinator' && member.id !== undefined && (member.id === e.agentId || member.id === address))
      const isMember = agentRuns.has(e.agentId) || found !== undefined
      const command = e.tool === 'Bash' ? String(e.command) : ''
      if (isMember && (e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'NotebookEdit' ||
          (e.tool === 'Bash' && !isSafeMemberBoardBash(command, found?.[0], found?.[1])))) {
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
    const readState = () => $.fs.read(`${dir}/members.json`).then(text => JSON.parse(text) as BudgetState & {
      members: Roster; paused?: string; closed?: boolean
    }).catch(() => undefined)
    const state = await readState()
    if (!state) return { isDelivered: false, reason: 'Swarm could not read the run state. Retry after checking the board.' }
    const native = state.members.coordinator?.backend === 'native'
    const matches = Object.entries(state.members).filter(([, member]) => member.id && !member.killed && !member.paused &&
      SPECIALISTS.includes(member.profile ?? '') && (member.id === e.to || (native && teammateName(member.id) === e.to)))
    const [name, member] = matches.length === 1 ? matches[0]! : []
    const budget = budgetOf(state)
    if (!name || !member?.id || state.closed || state.paused || (budget > 0 && tokensUsed(state.usage?.tokens) >= budget)) {
      return { isDelivered: false, reason: 'The Swarm wake is no longer eligible.' }
    }
    const alreadyRead = { isDelivered: false as const, reason: `@${name} already read through #${seq}.` }
    if (member.last_read_seq >= seq) return alreadyRead
    const reserved = await boardCommand($, dir, ['claim', name, member.id, String(seq)]).catch(() => undefined)
    const token = reserved?.stdout.trim() ?? ''
    if (reserved?.exitCode !== 0 || !/^[a-f0-9]{32}$/.test(token)) {
      if (reserved?.exitCode === 0 && token === '') {
        const current = (await readState())?.members[name]
        if (current?.id === member.id && current.last_read_seq >= seq) return alreadyRead
      }
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
    const epoch = sessionEpoch
    let requestedUnder = generation
    const named = parseDescribedName(e.description)
    type RunState = {
      title?: string
      members: Roster
      closed?: boolean
      paused?: string
    } & BudgetState
    const stateOf = async (dir: string) => JSON.parse(await $.fs.read(`${dir}/members.json`)) as RunState
    const recordedAddress = async (dir: string, args: string[], current: () => boolean) => {
      const result = await boardCommand($, dir, args).catch(() => undefined)
      if (!current()) return false
      if (result?.exitCode === 0) return true
      const saved = await stateOf(dir).catch(() => undefined)
      const member = memberNamed(saved?.members ?? {}, args[1])
      return current() && !!saved && !saved.closed && !!member && !member.killed && member.id === args[2] &&
        (args[4] === undefined || args[4] === `isolated=${member.isolated}`)
    }
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
    const liveAgents = e.resume ? [] : await $.agent.list().catch(() => [])
    if (!e.resume && requestedUnder !== generation) {
      // Another first start may have bound the run selected by both requests.
      const joined = await withOwnership(async () => ({ dir: ownedPath, generation }))
      if (current === owned || joined.dir !== owned) {
        return { deny: 'The Swarm run changed before the agent could start.' }
      }
      state = await stateOf(owned).catch(() => undefined)
      if (!state || joined.generation !== generation || epoch !== sessionEpoch || isEnding || killedRun === owned) {
        return { deny: 'The Swarm run changed before the agent could start.' }
      }
      requestedUnder = joined.generation
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
      if (epoch !== sessionEpoch || requestedUnder !== generation || isEnding || killedRun === owned) {
        return { deny: 'The Swarm run changed before the agent could resume.' }
      }
      const again = await next(e)
      if (again.agentId) {
        const fresh = await stateOf(owned).catch(() => undefined)
        const currentEntry = entry
          ? Object.values(fresh?.members ?? {}).find(member => member.id === entry.id)
          : memberNamed(fresh?.members ?? {}, named)
        if (epoch !== sessionEpoch || requestedUnder !== generation || isEnding || killedRun === owned ||
          !fresh || fresh.closed || !currentEntry || currentEntry.killed || (isUnrecorded && currentEntry.id)) {
          await retireLateSpawn($, again.agentId, again.teammateId)
          return { model: again.model }
        }
      }
      if (isUnrecorded && named && again.agentId) {
        const hasIsolation = spawnIsolations.has(e.tool_use_id)
        const iso = resumed?.isolated === '1' || isolatedAgents.has(again.agentId) || (e.resume && isolatedAgents.has(e.resume.agentId)) ||
          (hasIsolation && !e.isTeammate && spawnIsolations.get(e.tool_use_id) === 'worktree')
          ? '1'
          : resumed?.isolated === '0' || sharedAgents.has(again.agentId) || (e.resume && sharedAgents.has(e.resume.agentId)) ||
            hasIsolation || e.isTeammate || state.members.coordinator?.backend === 'native'
            ? '0'
            : undefined
        const startedArgs = ['started', named, again.teammateId ?? again.agentId, '']
        if (iso !== undefined) startedArgs.push(`isolated=${iso}`)
        if (!(await recordedAddress(owned, startedArgs, () =>
          epoch === sessionEpoch && requestedUnder === generation && !isEnding && killedRun !== owned))) {
          await retireLateSpawn($, again.agentId, again.teammateId)
          return { model: again.model }
        }
        if (iso === '1') isolatedAgents.add(again.agentId)
        else if (iso === '0') sharedAgents.add(again.agentId)
        rosterMiss = undefined
      }
      if (again.agentId) {
        agentRuns.set(again.agentId, owned)
        if (again.teammateId) learnTeammate($, again.agentId, again.teammateId)
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
      } else if (memberModel && e.model === undefined) {
        // Apply the roster's registered model automatically when omitted on the Agent call instead of denying.
        actual = latestOf(memberModel) ?? memberModel
        modelToUse = actual
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
      // A read that fails starts nobody, as every check here: this hook's own catch refuses the start.
      // Asked only of a run that limits a family at all: no other can bar an advisor.
      const isLimited = Object.keys(LATEST).some(family => state.limits !== undefined && Object.hasOwn(state.limits, family))
      const barred = isLimited ? advisorBarred(state.limits, await $.settings.read({ key: 'advisorModel' }), kind, named) : undefined
      if (barred) {
        logEvent($, owned, 'refused', { member: named, why: `advisor on ${barred.family}, which the run's limits keep it off` })
        return { deny: `This run allows ${barred.family} only for: ${barred.allowed.join(', ') || 'none'}, and this session's advisor answers on ${barred.family}. @${named} would inherit that advisor, and nothing can refuse an advisor call once a member runs. Start no member. Tell the user the limit and the advisor conflict, and ask which holds: they turn the advisor off for this session (/advisor off), or they lift the limit on ${barred.family}. Then start the team.` }
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
      const effort = member.effort || sizedEffort(kind, member.size)
      if (spawnEfforts.has(e.tool_use_id) && (spawnEfforts.get(e.tool_use_id) ?? DEFAULT_EFFORT[kind]) !== effort) {
        return { deny: `The roster has @${named} on ${effort} effort. Pass effort: "${effort}" on the Agent call, or change the roster first.` }
      }
    }
    const key = `${owned}/${named}`
    if (pendingStarts.has(key)) return { deny: `@${named} is already starting.` }
    const pending = Symbol(key)
    pendingStarts.set(key, pending)
    try {
      if (member.id) {
        const existing = findAgent(liveAgents, member.id)
        if (!existing || (existing.status !== 'killed' && existing.status !== 'failed')) {
          return { deny: `@${named} already has an agent. Resume it with SendMessage or replace its assignment.` }
        }
      }
      if (epoch !== sessionEpoch || requestedUnder !== generation || isEnding || killedRun === owned) {
        return { deny: 'The Swarm run changed before the agent could start.' }
      }
      if (owned !== current && ownedPath !== owned && !(await bind($, owned))) {
        return { deny: 'Swarm could not claim that run. Check that this conversation owns it.' }
      }
      const launchGeneration = generation
      const startupThrough = SPECIALISTS.includes(member.profile ?? '')
        ? parsePosts(await readBoard($, owned).catch(() => ''), state.members).at(-1)?.seq
        : undefined
      // The read can outlast a /swarm:kill, a close or a /clear: the run it was made for is no longer this one's to
      // start anyone in. Refused here, before the agent exists, not noticed after it was launched.
      const launchIsCurrent = () => epoch === sessionEpoch && launchGeneration === generation && !isEnding && killedRun !== owned
      if (!launchIsCurrent()) {
        return { deny: `The Swarm run changed while @${named} was starting (it was ended, closed or replaced), so the member was not started. Check the board before starting anyone.` }
      }
      // The table decides, not the session's alias or the agent file: a family name becomes the newest model
      // of that family, and a call that names no model gets its type's default.
      const background = !e.isTeammate ? true : e.background
      const started = await next(
        modelToUse !== e.model || background !== e.background
          ? { ...e, model: modelToUse, background }
          : e,
      )
      if (started.agentId) {
        const fresh = launchIsCurrent() ? await stateOf(owned).catch(() => undefined) : undefined
        const assignment = memberNamed(fresh?.members ?? {}, named)
        if (!launchIsCurrent() || !fresh || fresh.closed || !assignment || assignment.killed || assignment.id !== member.id) {
          await retireLateSpawn($, started.agentId, started.teammateId)
          return { model: started.model }
        }
        const hasIsolation = spawnIsolations.has(e.tool_use_id)
        const isIsolated = hasIsolation && !e.isTeammate && spawnIsolations.get(e.tool_use_id) === 'worktree'
        const address = started.teammateId ?? started.agentId
        const startedArgs = ['started', named, address, member.id ?? '']
        if (hasIsolation || e.isTeammate) startedArgs.push(isIsolated ? 'isolated=1' : 'isolated=0')
        if (!(await recordedAddress(owned, startedArgs, launchIsCurrent))) {
          await retireLateSpawn($, started.agentId, started.teammateId)
          return { model: started.model }
        }
        strangers.delete(started.agentId)
        if (started.teammateId) strangers.delete(started.teammateId)
        agentRuns.set(started.agentId, owned)
        rosterMiss = undefined
        if (started.teammateId) learnTeammate($, started.agentId, started.teammateId)
        if (hasIsolation || e.isTeammate) {
          if (isIsolated) isolatedAgents.add(started.agentId)
          else sharedAgents.add(started.agentId)
        }
        if (startupThrough !== undefined) startupReads.set(key, { address, through: startupThrough })
        $.clock.after(0, () => void refresh($))
      }
      return started
    } finally {
      if (pendingStarts.get(key) === pending) pendingStarts.delete(key)
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
      activeCoordinatorTurnId = e.turnId
      noticeHold = 0
      coordinatorReads = 0
    }
    turnWakes.set(e.turnId, e.agentId === undefined ? wakeNext || 'user' : wokenAgents.has(e.agentId) ? 'wake' : 'start')
    if (turnWakes.size > TURNS_KEPT) turnWakes.delete(turnWakes.keys().next().value!)
    if (e.agentId === undefined) wakeNext = ''
    else wokenAgents.add(e.agentId)

    return next(e)
  })
  // Each model response is charged as it answers: a turn of many steps would otherwise cross the budget unseen
  // until it ends. The response passes through untouched and never waits for the board; the turn's end does.
  on('turn.step', async function* ($, e, next) {
    const sEpoch = sessionEpoch
    const rGen = generation
    let owner = turnRuns.get(e.turnId)
    if (owner === undefined) {
      const dir = e.agentId === undefined ? await read($, run).catch(() => '') : agentRuns.get(e.agentId)
      if (sEpoch === sessionEpoch && !isEnding) {
        owner = turnRuns.get(e.turnId) ?? (rGen === generation ? dir || undefined : rGen)
        if (owner !== undefined) rememberTurnRun(e.turnId, owner)
      }
    }
    const response = yield* next(e)
    try {
      if (sEpoch !== sessionEpoch || isEnding) return response
      const spent = response.usage
      const now = await $.clock.now()
      if (sEpoch !== sessionEpoch || isEnding) return response
      if (spent && e.agentId !== undefined) heldBy.set(e.agentId, heldAt(spent))
      const delta = spent ? stepped.charge(e.turnId, spent, e.index, e.agentId, now) : 0
      const turn = delta > 0 ? stepped.of(e.turnId) : undefined
      if (stepped.running > TURNS_KEPT) {
        // An agent that ended without ending its turn leaves it running: such turns go, and no live one does.
        void $.agent.list().then(agents => stepped.prune(id => agents.some(agent => agent.id === id && !['completed', 'failed', 'killed'].includes(agent.status)), now)).catch(() => undefined)
      }
      if (spent && turn) {
        const at = owner ?? (e.agentId === undefined ? undefined : rGen)
        if (at !== undefined && !turnRuns.has(e.turnId)) rememberTurnRun(e.turnId, at)
        // The turn's end waits for this charge. Planning steps that begin before a run is bound fall to that end.
        turn.landing = turn.landing
          .then(() => at === undefined ? undefined : account($, e.turnId, `${e.turnId}:${e.index}`, e.agentId, delta, at, sEpoch,
            // A member's step also says what context it read: the board keeps it, to refuse a wake that would only pay for it again.
            withHeld(stepped.detail(turn, e.index), e.agentId), spent.model))
          .catch(() => false as const)
          // One never sent is no longer pending under its own report: its turn's end charges it.
          .then(landed => { if (sEpoch === sessionEpoch && !isEnding && landed !== false) stepped.landed(turn, landed ?? 0, e.index) })
        if (snapshot && !snapshot.isClosed && at === snapshot.dir && windingDown !== snapshot.dir && isWindingDown(tokensUsed(snapshot.tokens) + delta, snapshot.budget)) {
          windingDown = snapshot.dir
          windBudget = snapshot.budget
          windTold.clear()
          notesOwed.push(`The run has spent 80% of its token budget of ${compact(snapshot.budget)} and pauses at 100%. Its members are being told to post what they have. Decide now what the rest is worth: narrow the remaining work, or ask the user about the budget before the pause.`)
        }
        if (snapshot && !snapshot.isClosed && at === snapshot.dir && snapshot.budget > 0 && tokensUsed(snapshot.tokens) + delta >= snapshot.budget) {
          halted = { dir: snapshot.dir, why: `paused (token budget of ${compact(snapshot.budget)} spent)` }
        }
      }
      const consults = (response.serverToolUses ?? []).filter(use => use.name === 'advisor')
      if (e.agentId !== undefined && (consults.length > 0 || advisorUsers.has(e.agentId))) {
        const agentId = e.agentId
        advisorUsers.add(agentId)
        // One at a time: two steps that read the same total would each charge the same tokens.
        advising = advising.then(() => advised($, e.turnId, e.index, agentId, consults, spent?.model ?? '', owner ?? rGen, sEpoch)).catch(() => undefined)
      }
    } catch {
      // A usage failure must not change the response.
    }
    return response
  })
  on('turn.complete', async ($, e, next) => {
    moods.delete(e.agentId ?? 'coordinator')

    // Whether this end put anything on the board, so the pane shows it at once.
    let isCharged = false
    const sEpoch = sessionEpoch
    const rGen = generation
    const pinnedAt = turnRuns.get(e.turnId) ?? (e.agentId !== undefined ? agentRuns.get(e.agentId) : undefined) ?? rGen
    if (!isEnding && !turnRuns.has(e.turnId)) rememberTurnRun(e.turnId, pinnedAt)
    // A completion still in flight during /clear must not serialize turns in the new session.
    const queueKey = (turnId: string) => `${sEpoch}:${turnId}`
    const key = queueKey(e.turnId)
    const prevComplete = completing.get(key)
    let doneComplete!: () => void
    const thisComplete = new Promise<void>(resolve => { doneComplete = resolve })
    const tailComplete = prevComplete ? prevComplete.then(() => thisComplete) : thisComplete
    completing.set(key, tailComplete)
    try {
      try {
        if (prevComplete) await prevComplete
        if (sEpoch !== sessionEpoch || isEnding) return next(e)
        // The steps first: what they could not charge is this report's, and a pause one of them set must be known here.
        // Again while a step queued another charge meanwhile.
        for (let turn = stepped.of(e.turnId), seen: Promise<unknown> | undefined; turn && seen !== turn.landing;) {
          seen = turn.landing
          await seen
        }
        if (sEpoch !== sessionEpoch || isEnding) return next(e)
        const at = turnRuns.get(e.turnId) ?? pinnedAt
        const turn = stepped.of(e.turnId)
        // Retry the same amount under the same report ID: a missing response can hide a successful write.
        const endReport = (turnId: string, owing: NonNullable<typeof turn>) =>
          owing.endCharged === 0 ? turnId : `${turnId}:end:${owing.endCharged}`
        const settle = async (turnId: string, owing: NonNullable<typeof turn>, under: TurnOwner) => {
          const key = queueKey(turnId)
          if (settling.has(key)) return
          settling.add(key)
          try {
            for (const [index, amount] of [...owing.pending]) {
              if (sEpoch !== sessionEpoch || isEnding) break
              const report = index === END ? endReport(turnId, owing) : `${turnId}:${index}`
              const accepted = await account($, turnId, report, owing.agentId, amount, under, sEpoch, withHeld(stepped.detail(owing, index), owing.agentId)).catch(() => false as const)
              // Taken already (0) or nothing to charge (undefined) is settled too: left owing, it is sent at every turn's end.
              if (accepted !== false) {
                stepped.landed(owing, accepted ?? 0, index)
                if (accepted) isCharged = true
              }
            }
          } finally {
            settling.delete(key)
          }
        }
        if (turn) await settle(e.turnId, turn, at)
        if (sEpoch !== sessionEpoch || isEnding) return next(e)
        const owed = stepped.charge(e.turnId, e.usage, undefined, e.agentId)
        const ended = stepped.of(e.turnId)
        if (ended && owed > 0 && !ended.pending.has(END)) {
          stepped.held(ended, owed)
          const taken = await account($, e.turnId, endReport(e.turnId, ended), e.agentId, owed, turnRuns.get(e.turnId) ?? at, sEpoch, withHeld(stepped.detail(ended, END), e.agentId)).catch(() => false as const)
          // The ledger may have been cleared meanwhile (a new session): nothing is left to mark.
          if (sEpoch !== sessionEpoch || isEnding) return next(e)
          if (taken !== false) stepped.landed(ended, taken ?? 0, END)
          if (taken) isCharged = true
        }
        // What earlier turns still owe is tried again now: their own end is not reported twice, so a board that was
        // out of reach then would never be charged. Under each one's own report and run; a coordinator's turn whose
        // run is no longer known is left for its own end.
        // ponytail: the oldest few an end, so a board that stays out of reach costs each end a bounded number of commands.
        // Taken in turn, so one the board keeps refusing does not hold up those behind it.
        const late = stepped.owed().filter(([turnId]) => turnId !== e.turnId && !settling.has(queueKey(turnId)) && !completing.has(queueKey(turnId)))
        for (let tried = 0; tried < Math.min(STRANDED_RETRIES, late.length); tried++) {
          if (sEpoch !== sessionEpoch || isEnding) break
          const [turnId, owing] = late[(strandedFrom + tried) % late.length]!
          const under = turnRuns.get(turnId)
          if (under !== undefined) await settle(turnId, owing, under)
        }
        if (sEpoch === sessionEpoch && !isEnding) strandedFrom += STRANDED_RETRIES
      } finally {
        doneComplete()
        if (completing.get(key) === tailComplete) completing.delete(key)
        // Only once its usage is on the board: a poll in between would act on the roster as it was before a budget pause.
        const ownsCoordTurn = activeCoordinatorTurnId === undefined || activeCoordinatorTurnId === e.turnId
        if (e.agentId === undefined && sEpoch === sessionEpoch && !isEnding && ownsCoordTurn) {
          activeCoordinatorTurnId = undefined
          isCoordinatorBusy = false
          coordinatorTurnsEnded++
          // The turn a kill landed in owes its compaction from here on; it is asked for once the host has ended the turn.
          if (isKillTurn) {
            isKillTurn = false
            owedCompaction = { epoch: sessionEpoch, tries: 0, isAsked: false }
          }
          quietSince = await $.clock.now()
          if (sEpoch === sessionEpoch) await owesRunCompaction($, await read($, run))
        }
      }
      const owner = turnRuns.get(e.turnId) ?? pinnedAt
      if (sEpoch === sessionEpoch && !isEnding && rGen === generation && e.agentId !== undefined &&
          (typeof owner === 'string' || owner === rGen)) {
        // A member that was woken and ended its turn without reading is owed the wake again.
        const agent = findAgent(await $.agent.list(), e.agentId)
        if (sEpoch === sessionEpoch && !isEnding && rGen === generation) {
          const dir = typeof owner === 'string' ? owner : await agentRun($, e.agentId, agent, false, sEpoch, rGen)
          if (sEpoch === sessionEpoch && !isEnding && rGen === generation && dir && !retiredRuns.has(dir)) {
            rememberTurnRun(e.turnId, dir)
            const address = teammateOf($, e.agentId, agent)
            await boardCommand($, dir, ['rearm', String(Math.ceil(e.durationMs)), e.agentId, ...(address ? [address] : [])]).catch(() => undefined)
          }
        }
      }
      if (sEpoch === sessionEpoch && !isEnding && (e.agentId !== undefined || e.usage || isCharged)) $.clock.after(0, () => void refresh($))
    } catch {
      // A usage failure must not change how a turn ends.
    }
    const answered = await next(e)
    // Only once the host has ended the turn: compacting earlier is refused while it runs.
    if (e.agentId === undefined && owedCompaction?.epoch === sessionEpoch) $.clock.after(0, () => compactOwed($))
    return answered
  })

  on('session.end', async ($, e, next) => {
    // After /clear or a resume the process goes on under a new session and no session.start fires for it,
    // so the poller stays: without it the pane, the wakes and the stall check are dead until a restart.
    const goesOn = e.reason === 'clear' || e.reason === 'resume'
    // No poll runs from here until the end is through: one in between would look the new session's run up under
    // the old session's id, and after an exit nothing is left to poll for.
    isEnding = true
    clocks.clear()
    isRefreshOwed = false
    isPaneOpen = false
    sessionEpoch++
    forgetKills()
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
    turnWakes.clear()
    forgetSpend()
    wokenAgents.clear()
    wakeNext = ''
    retiredRuns.clear()
    strandedFrom = 0
    // A teammate's address is kept through /clear and a resume: one that ends afterwards has left the agent
    // list, and its last turn and its wake are still recorded under that address.
    if (!goesOn) teammates.clear()
    pendingStarts.clear()
    spawnEfforts.clear()
    spawnIsolations.clear()
    sharedAgents.clear()
    isolatedAgents.clear()
    opened = closedRun = titleOpen = ''
    loadingDiffSeq = 0
    loadingHistory = retryingRun = 0
    exportingRun = 0
    // A load the last session started is not this one's, even for the same run.
    boardNavigation++
    diffAsked++
    sawSwarmCommand = false
    talk = browsed = undefined
    isCoordinatorBusy = false
    activeCoordinatorTurnId = undefined
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
  // A task this long is mostly a paste: a log, a specification. A slash command's arguments reach the model twice,
  // as typed and inside the skill, and the coordinator re-reads its whole conversation on every step. Seen live: a
  // 370,000-character console log made a new run's first step cost 440,000 tokens and each later one 45,000. The
  // whole text goes to a file the coordinator reads from, and the task keeps its two ends, where the request is.
  on('command.run', { command: 'swarm-kill' }, ($, e) => killRun($, e.args))
  // A run that was killed gives the swarm skill's text back only to a new /swarm:swarm.
  on('skill.prompt', ($, e, next) => {
    if (e.pluginName !== $.plugin.name || !/^(?:swarm:)?(?:swarm|plan)$/.test(e.skill)) return next(e)
    if (killedRun && /^(?:swarm:)?swarm$/.test(e.skill)) {
      return { text: 'The Swarm run of this conversation was ended with /swarm-kill: you are an ordinary assistant again, and run no board command and start no member unless the user starts a new run with /swarm:swarm.' }
    }
    if (/^(?:swarm:)?swarm$/.test(e.skill)) sawSwarmCommand = true
    // The command's own message holds a long task already: the skill's copy of it would be read twice at every step.
    const args = commandArgs
    commandArgs = ''
    if (args.length < ARGS_DEDUP || !e.text.includes(args)) return next(e)
    return next({ ...e, text: e.text.replace(args, () => '(The task is the text of the user\'s command above.)') })
  })
  // A member the kill retired may still hand back or message: that would start a paid turn for nothing. Only a
  // notification whose envelope names one of its agents as the sender is dropped; anything in doubt goes through.
  on('prompt.submit', async ($, e, next) => {
    // Seen live: a member's turn ended on a routine READY while three others worked, and its hand-back and its task
    // notification each started a coordinator turn the board's own notice would start again.
    // Seen live: a background member's last words arrive as a peer message framed `<agent-message from="ID">`, and
    // its task notification follows. Settled first, with no file read: a retired agent is dropped while the kill runs.
    const from = senderOf(e)
    // What the user typed: not a member's words, and not a notice of Swarm's own, which names budgets too.
    const origin = (e as { origin?: { kind?: string } }).origin?.kind ?? ''
    if (from === undefined && origin === 'composer' && !/^\s*Swarm:/.test(e.text)) {
      for (const figure of figuresIn(e.text)) userFigures.add(figure)
    }
    if (from !== undefined && cancelledSpawns.has(from)) return { drop: KILL_DROP }
    if (from !== undefined && killedIds.has(from)) {
      // A teammate's address can come back in a later run: a live member of the run driven now by that id is heard.
      // Not the killed run itself, whose retirements stand until another run is owned.
      const now = ownedRoster
      const isLive = !killConfirmed.has(from) && now !== undefined && !now.closed && now.dir === await read($, run).catch(() => '') &&
        Object.values(now.members).some(member => member.id === from && member.killed !== '1')
      if (!isLive) return { drop: KILL_DROP }
    }
    const sender = senderOf(e)
    const handing = { member: sender ? memberOfAgent(sender)?.[0] ?? sender : '', origin: e.origin.kind }
    if (await repeatsBoard($, e).catch(() => false)) {
      logEvent($, ownedRoster?.dir, 'turn-end', { ...handing, outcome: 'dropped: the board holds what it said' })
      return { drop: 'Swarm: a member handed back while others still work; the board holds what it left.' }
    }
    const mirrored = await mirrorHandback($, e).catch(() => undefined)
    if (sender && ownedRoster && !ownedRoster.closed) {
      logEvent($, ownedRoster.dir, 'turn-end', { ...handing, outcome: mirrored?.quiet ? 'dropped: no turn of the coordinator\'s needed' : mirrored ? 'passed to the coordinator as a pointer' : 'passed to the coordinator' })
    }
    if (mirrored?.quiet) return { drop: 'Swarm: a member handed back while others still work; its report is on the board.' }
    if (mirrored) e = { ...e, text: mirrored.text }
    // A member's hand-back or task notification that starts the coordinator's next turn is that turn's wake, not the
    // user's. Mid-turn it starts none, and a notice the monitor just submitted keeps its own name.
    const kind = (e as { origin?: { kind?: string } }).origin?.kind
    if (!isCoordinatorBusy && wakeNext === '' && (kind === 'peer' || kind === 'task-notification')) wakeNext = 'member'
    return next(e)
  })
  on('command.run', async ($, e, next) => {
    // A new run takes the place of the killed one: an old kill's compaction would take away its rules.
    if (/^(?:swarm:)?swarm$/.test(e.command)) {
      sawSwarmCommand = true
      killedRun = ''
      owedCompaction = undefined
    }
    // A plan's task sits in the conversation that may become the coordinator's, so it is saved the same way.
    if (/^(?:swarm:)?(?:swarm|plan)$/.test(e.command)) commandArgs = e.args
    if ((e as { origin?: { kind?: string } }).origin?.kind === 'composer') for (const figure of figuresIn(e.args ?? '')) userFigures.add(figure)
    if (!/^(?:swarm:)?(?:swarm|plan)$/.test(e.command) || e.args.length < TASK_CHARS) return next(e)
    let args = e.args
    try {
      // A folder of its own that keeps itself out of git: a plan comes before any `init`, and a .swarm/.gitignore of
      // the project's own need not ignore everything.
      const folder = `${await $.session.cwd()}/.swarm/tasks`
      const ignore = `${folder}/.gitignore`
      // One already there is never rewritten: unless it ignores everything, the task is not saved where git sees it.
      if (!(await $.fs.exists(ignore))) await $.fs.write(ignore, '*\n')
      else if (!(await $.fs.read(ignore)).split('\n').some(line => line.replace(/\r$/, '') === '*')) throw new Error('the tasks folder is not ignored')
      const stamp = `${new Date(await $.clock.now()).toISOString().replace(/\D/g, '').slice(0, 14)}-${++tasksSaved}`
      // The conversation's own key in the name: two tasks sent in one second from two conversations are two files.
      const path = `${folder}/${stamp}-${(await lookupKey($)).slice(0, 8)}.md`
      await $.fs.write(path, e.args)
      const size = e.args.length.toLocaleString('en-US')
      // Neither end starts or stops between the two halves of a character.
      const tail = e.args.length - TASK_TAIL
      args = `${head(e.args, TASK_HEAD)}\n\n[Swarm: the task is ${size} characters long, and its middle is left out here. All of it is in ${path}. What you keep in this conversation is re-read at every step of the run: search that file with Grep and read the parts the task needs, all of it only when it is a specification to follow as a whole, and give a member the path and the lines to look at instead of pasting from it. The task ends:]\n\n${e.args.slice(/[\udc00-\udfff]/.test(e.args[tail] ?? '') ? tail + 1 : tail)}`
      $.ui.toast(`Swarm: the task holds ${size} characters, so the coordinator got its start and its end and reads the rest from ${path}. Held in the conversation, every step of the run would re-read it.`)
    } catch {
      // The file could not be written: the task goes on whole.
    }
    commandArgs = args
    return next(args === e.args ? e : { ...e, args })
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
    for (const clock of clocks.values()) clock.visible = false
    clearHeldStatuses()
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
    const shown = await read($, swarm)
    const offset = e.surface !== 'terminal' ? phase(`${e.surface}:shortcut`, shown.dir, emblemStateOf(shown), await $.clock.now().catch(() => 0)) : 0
    return shortcut($, e, false, shown, offset)
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
    const shown = await read($, swarm)
    const offset = phase(`${e.surface}:shortcut`, shown.dir, emblemStateOf(shown), await $.clock.now().catch(() => 0))
    // 1.25 cells sits the caption about 6 px nearer the button than 2 did.
    return <Box flexDirection="row" columnGap={1.25}>
      {shortcut($, e, textCount(findKey(peers[0]?.tree, 'crab-text')) === 1, shown, offset, true)}
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>{crab}</Box>
    </Box>
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.surface === 'terminal' || e.props.isSummary || !DEPLOYED.test(e.props.text) || !(await read($, run))) return next(e)
    const { Box, Text, Button, Svg } = $.ui.resolve(e)
    const reply = await next(e)
    const shown = await read($, swarm)
    const state = emblemStateOf(shown)
    const working = shown.members.filter(m => m.status === 'working').length
    const borderColor = shown.dir === '' || shown.isClosed ? 'subtle'
      : shown.isPaused || shown.attention.length > 0 ? 'warning'
        : working > 0 ? 'success' : 'claude'
    const subtitle = shown.dir === '' ? 'Multi-agent board & graph'
      : shown.isClosed ? 'Closed run · board & graph'
        : shown.isPaused ? 'Paused run · board & graph'
          : 'Live multi-agent board & graph'
    const emblemOffset = phase(`${e.surface}:reply:${shown.dir}`, shown.dir, state, await $.clock.now().catch(() => 0))
    return (
      <Box flexDirection="column" rowGap="sm">
        {reply}
        <Box
          key="swarm-reply-card"
          flexDirection="row"
          alignItems="center"
          justifyContent="space-between"
          flexWrap="wrap"
          columnGap="md"
          rowGap="xs"
          borderStyle="round"
          borderColor={borderColor}
          borderDimColor
          hover={{ borderDimColor: false }}
          paddingX="sm"
          paddingY="xs"
        >
          <Box flexDirection="row" alignItems="center" columnGap="sm" flexShrink={1} minWidth={0}>
            <Box flexShrink={0}>
              <Svg source={swarmEmblem(state, emblemOffset)} alt="Swarm" width={20} height={20} />
            </Box>
            <Box flexDirection="column" flexShrink={1} minWidth={0}>
              <Text weight="semibold" color={shown.isClosed ? undefined : 'claude'} wrap="truncate-end">Swarm Board</Text>
              <Text size="caption" dimColor wrap="truncate-end">{subtitle}</Text>
            </Box>
          </Box>
          <Button
            key="swarm-board-from-reply"
            variant="primary"
            label="Open Swarm Board"
            onPress={() => void openBoard($).catch(() => undefined)}
          />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (e.props.origin.kind !== 'plugin' || e.props.origin.name !== $.plugin.name || !e.props.text.startsWith('Swarm: ')) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const Emblem = e.surface !== 'terminal' ? $.ui.resolve(e).Svg : undefined
    const [heading, ...body] = e.props.text.slice('Swarm: '.length).split('\n')
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="claude" borderDimColor paddingX="sm" paddingY="xs" gap="xs">
        <Box flexDirection="row" alignItems="center" columnGap="xs" minWidth={0}>
          {Emblem && <Box flexShrink={0}><Emblem source={swarmEmblem('coordinating')} alt="Swarm" width={16} height={16} /></Box>}
          <Box flexShrink={1} minWidth={0}>
            <Text dimColor wrap="truncate-end">
              <Text weight="semibold" color="claude">Swarm</Text>
              {` · ${heading}`}
              {!e.props.isExpanded && body.length > 0 && ` (${counted(body.length, 'more line')})`}
            </Text>
          </Box>
        </Box>
        {e.props.isExpanded && body.length > 0 && <Text size="caption" dimColor>{body.join('\n')}</Text>}
      </Box>
    )
  })

  // The row in the chat that opens the pane: a queued /swarm-board waits for the turn to end, a press does not.
  on('ui.render', { component: 'Placed' }, async ($, e, next) => {
    // Every plugin's hook hears every placed row: only this plugin's own opener is drawn here.
    if (e.props.plugin !== $.plugin.name || !e.props.id.startsWith(OPENER)) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const Emblem = e.surface !== 'terminal' ? $.ui.resolve(e).Svg : undefined
    const shown = await read($, swarm)
    const isShown = shown.dir !== '' && openerOf(shown.dir) === e.props.id

    const activeMembers = shown.members.filter(m => m.role !== 'coordinator' && m.status !== 'killed').length
    const working = shown.members.filter(m => m.status === 'working').length
    const state = isShown ? emblemStateOf(shown) : 'idle'
    const borderColor = !isShown || shown.isClosed ? 'subtle'
      : shown.isPaused || shown.attention.length > 0 ? 'warning'
        : working > 0 ? 'success' : 'claude'
    const emblemOffset = Emblem ? phase(`${e.surface}:placed:${e.props.id}`, isShown ? shown.dir : e.props.id, state, await $.clock.now().catch(() => 0)) : 0

    return (
      <Box
        key="swarm-placed-card"
        flexDirection="row"
        alignItems="center"
        justifyContent="space-between"
        columnGap="md"
        rowGap="xs"
        flexWrap="wrap"
        borderStyle="round"
        borderColor={borderColor}
        borderDimColor
        hover={{ borderDimColor: false }}
        paddingX="sm"
        paddingY="xs"
      >
        <Box flexDirection="row" alignItems="center" columnGap="sm" flexShrink={1} minWidth={0}>
          {Emblem && <Box flexShrink={0}><Emblem source={swarmEmblem(state, emblemOffset)} alt="Swarm" width={20} height={20} /></Box>}
          <Box flexDirection="column" flexShrink={1} minWidth={0}>
            <Text wrap="truncate-end">
              <Text weight="semibold" color={isShown && !shown.isClosed ? 'claude' : undefined}>Swarm Board</Text>
              {isShown && <Text weight="medium">{` · ${shown.title}`}</Text>}
            </Text>
            {isShown ? (
              <Text size="caption" dimColor tabular wrap="truncate-end">
                {shown.isClosed ? 'closed' : shown.isPaused ? <Text color="warning" weight="medium">paused</Text> : null}
                {shown.isClosed ? '' : `${shown.isPaused ? ' · ' : ''}${counted(activeMembers, 'member')}`}
                {` · ${counted(shown.total ?? shown.posts.length, 'post')}`}
                {!shown.isClosed && !shown.isPaused && working > 0 && (
                  <Text color="success" weight="medium">{` · ${working} working`}</Text>
                )}
                {!shown.isClosed && shown.attention.length > 0 && (
                  <Text color="warning" weight="medium">{` · ${shown.attention.length} attention`}</Text>
                )}
              </Text>
            ) : (
              <Text size="caption" dimColor wrap="truncate-end">Open Swarm Board</Text>
            )}
          </Box>
        </Box>
        <Button
          key="open-swarm"
          variant="primary"
          label="Open Swarm Board"
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
    if (routeRun !== shown.dir) {
      routeRun = shown.dir
      routesListed = false
      routePages = 1
    }
    const error = await read($, loadError)
    const now = HeaderArt ? await $.clock.now() : 0
    const slot = (part: string) => `${e.surface}:pane:${part}`
    if (e.props.placement === 'widget') {
      // Minimised: nothing of the pane is in view, so no live animation is started for it.
      isPaneOpen = false
      for (const part of ['hive', 'budget', 'members', 'live', 'timeline', 'route']) hideMotion(slot(part))
      const active = shown.members.filter(member => member.status === 'working').length
      const coordinating = shown.members.filter(member => member.status === 'coordinating').length
      const state = emblemStateOf(shown)
      return (
        <Box flexDirection="row" columnGap="xs" alignItems="center">
          {HeaderArt && <Box flexShrink={0}><HeaderArt source={swarmEmblem(state, phase(slot('widget'), shown.dir, state, now))} alt="Swarm" width={16} height={16} /></Box>}
          <Text weight="semibold">Swarm Board</Text>
          {shown.dir === '' ? (
            <Text dimColor>No swarm</Text>
          ) : shown.isClosed ? (
            <Text dimColor>Closed</Text>
          ) : shown.isPaused ? (
            <Text color="warning" weight="medium">Paused</Text>
          ) : active > 0 ? (
            <Text color="success" weight="medium" tabular>{`${active} working`}</Text>
          ) : coordinating > 0 ? (
            <Text color="claude" weight="medium" tabular>{`${coordinating} coordinating`}</Text>
          ) : null}
          {shown.dir !== '' && !shown.isClosed && shown.attention.length > 0 && (
            <Text color="warning" weight="semibold" tabular>{`${shown.attention.length} attention`}</Text>
          )}
        </Box>
      )
    }
    hideMotion(slot('widget'))
    isPaneOpen = true
    // The run row's ends are read as the pane opens, so they are drawn as no control from the first look on.
    if (runEdge.dir !== shown.dir || runEdge.older === undefined || runEdge.newer === undefined) void learnEdges($, shown.dir)
    const current = await read($, tab)
    const columns = Math.max(20, e.props.bodyColumns ?? 40)
    const tabView = current === 'members' && talk?.dir === shown.dir ? `members/talk/${talk.name}` : current
    const mood = shown.mood ?? 'sleep'
    // Desktop recreates non-interactive <Svg> <img> siblings on every Pane render: continuous=true advances
    // hiveOffset to live wall-clock `now - clock.start` so recreated hive artwork resumes mid-animation.
    const hiveOffset = phase(slot('hive'), shown.dir, `${shown.dir ? 'header' : 'empty'}/${mood}/${tabView}/${columns < 48 ? 's' : 'l'}`, now, false, true)
    if (current !== 'graph' || shown.posts.length === 0) {
      for (const part of ['route', 'live', 'timeline']) hideMotion(slot(part))
    }
    if (current !== 'members') hideMotion(slot('members'))
    const memberOf = (name: string) => shown.members.find(member => member.name === name)
    const feedOf = async (name: string) => {
      talk = undefined
      await stop($)  // a replay left running would keep stepping behind the Board tab
      if ((await read($, query)) !== `@${name}`) await update($, query, () => `@${name}`)
      if ((await read($, inspected)) !== null) await update($, inspected, () => null)
      if (await read($, latestOnly)) await update($, latestOnly, () => false)
      // The feed is the latest window's: an older page left open on Board may hold none of this member's posts.
      boardNavigation++
      if ((await read($, history)) !== null) await update($, history, () => null)
      if ((await read($, tab)) !== 'board') await update($, tab, () => 'board')
    }
    const hiding = await read($, hideInactive)
    // The rows the pane's own window shows, less the header and the tab row; the viewport only where the surface gives no window.
    const rows = Math.max(8, (e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 24) - 7)

    if (shown.dir === '') {
      hideMotion(slot('budget'))
      return (
        <Box
          flexDirection="column"
          gap="sm"
          borderStyle="round"
          borderColor={error ? 'warning' : 'subtle'}
          borderDimColor
          paddingX="md"
          paddingY="sm"
        >
          {HeaderArt && <HeaderArt key="hive" source={hiveArt('sleep', hiveOffset)} alt="Sleeping bees" width={columns < 48 ? 56 : 88} height={columns < 48 ? 28 : 44} />}
          <Text size="heading" weight="semibold" color={error ? 'warning' : undefined}>{error || 'No swarm in this project'}</Text>
          {!error && <Text dimColor>Start one with /swarm:swarm and a task.</Text>}
        </Box>
      )
    }

    const inactive = inactiveOf(shown.members)
    const memberOrder = new Map(shown.members.map((member, idx) => [member.name, idx]))
    const hueOf = (name: string) => HUES[(memberOrder.get(name) ?? -1) % HUES.length] ?? 'subtle'
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
    const retry = browsed && <Button key="run-retry" plain label={retryingRun !== 0 && retryingRun === browseGen ? 'Retrying…' : 'Retry'} onPress={() => reloadBrowsed($)} />
    const working = shown.members.filter(m => m.status === 'working').length
    const coordinating = shown.members.filter(m => m.status === 'coordinating').length
    const waiting = shown.members.filter(m => m.role !== 'coordinator' && m.status === 'waiting').length
    const failed = shown.members.filter(m => m.status === 'failed' || m.status === 'unreachable').length
    const stopped = shown.members.filter(m => m.status === 'stopped').length
    const tokens = shown.tokens
    const total = tokensUsed(tokens)
    const openPost = async (seq: number) => {
      const navigation = ++boardNavigation
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
      if (navigation !== boardNavigation) return
      if ((await read($, inspected)) !== (older ?? null)) await update($, inspected, () => older ?? null)
      await update($, history, () => null)
      if ((await read($, query)) !== '') await update($, query, () => '')  // a filter left on the Board would hide the post
      if (await read($, latestOnly)) await update($, latestOnly, () => false)
      if ((await read($, earlier)) !== 0) await update($, earlier, () => 0)
      if ((await read($, expanded)) !== seq) await update($, expanded, () => seq)
      if ((await read($, tab)) !== 'board') await update($, tab, () => 'board')
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
        <Box flexDirection="row" alignItems="center" columnGap="xs" borderStyle="round" borderColor="subtle" borderDimColor paddingX="sm" paddingY="xs" minWidth={0}>
          {HeaderArt && <Box flexShrink={0}><HeaderArt source={semanticIcon('info')} alt="Info" width={12} height={12} /></Box>}
          <Box flexShrink={1} minWidth={0}>
            <Text dimColor>No mentions yet.</Text>
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column">
          {visibleEdges.map(([edge, count]) => (
            <Text key={edge} tabular wrap="truncate-end">
              <Text color="claude">
                {'█'.repeat(Math.max(1, Math.round((count / most) * 8))).padEnd(8, '░')}
              </Text>
              {` ${String(count).padStart(maxDigits, ' ')}  ${edge}`}
            </Text>
          ))}
          {unseen > 0 && <Text dimColor>{`… and ${unseen} more`}</Text>}
          {(unseen > 0 || routePages > 1) && (
            <Box flexDirection="row" gap="sm" flexWrap="wrap">
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
      const historical = await read($, history)
      const page = historical?.dir === shown.dir ? historical.posts : undefined
      const available = page ?? (inspectedPost && !shown.posts.some(post => post.seq === inspectedPost.seq)
        ? [inspectedPost, ...shown.posts] : shown.posts)
      const before = (page ?? shown.posts)[0]?.seq ?? 1
      const historyControls = (page || before > 1) && (
        <Box flexDirection="row" flexWrap="wrap" gap="sm" alignItems="center">
          {page && <Text size="caption" dimColor tabular>{`Posts #${before}–#${page.at(-1)?.seq} of ${shown.total ?? shown.posts.length}`}</Text>}
          {page && <Button key="history-latest" plain label="Back to latest posts" onPress={() => {
            boardNavigation++
            return update($, history, () => null)
          }} />}
          {before > 1 && <Button key="history-page" plain label={loadingHistory !== 0 && loadingHistory === boardNavigation ? 'Loading…' : page ? 'Older posts' : 'Browse older posts'} onPress={async () => {
            const navigation = ++boardNavigation
            loadingHistory = navigation
            $.ui.invalidate('ui.render')
            try {
              const loaded = await boardCommand($, shown.dir, ['show', `--before=${before}`, '--json']).catch(() => undefined)
              if ((await shownSwarm($)).dir !== shown.dir || navigation !== boardNavigation) return
              const posts = loaded?.exitCode === 0 && !loaded.isStdoutTruncated ? parsePosts(loaded.stdout, {}) : []
              if (!posts.length) { $.ui.toast('Could not load earlier board posts.'); return }
              await update($, history, current => navigation === boardNavigation ? { dir: shown.dir, posts } : current)
              await update($, expanded, current => navigation === boardNavigation ? 0 : current)
            } finally {
              if (loadingHistory === navigation) loadingHistory = 0
              $.ui.invalidate('ui.render')
            }
          }} />}
        </Box>
      )
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
        <Box flexDirection="row" alignItems="center" columnGap="sm" rowGap="xs" flexWrap="wrap" flexGrow={1} flexShrink={1} minWidth={0}>
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Input
              key="board-search"
              placeholder="Filter: text, @name, from:, to:, kind:"
              value={rawQuery}
              submitLabel="Filter"
              onSubmit={value => update($, query, () => value.trim())}
            />
          </Box>
          {terms.length > 0 && (
            <Button key="board-search-clear" plain label={`Clear filter (${matching.length} of ${available.length})`} onPress={() => update($, query, () => '')} />
          )}
        </Box>
      )
      // The person posts in the coordinator's name, and the coordinator is told with its next tool call.
      const compose = isDriven && (
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Input
            key="board-compose"
            placeholder="Post to board as coordinator"
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
      // Posting and filtering share one row, and the filter wraps under the post field where the pane is too narrow.
      const bar = (isSearchable: boolean) => (compose || isSearchable) && (
        <Box flexDirection="row" alignItems="center" columnGap="sm" rowGap="xs" flexWrap="wrap" marginTop="sm" minWidth={0}>
          {compose}
          {isSearchable && search}
        </Box>
      )
      const selected = (!collapsed || page) && open > 0 ? matching.find(post => post.seq === open) : undefined
      // Opens one post whole, or closes it again.
      const toggle = async (seq: number) => {
        boardNavigation++
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
      const visible = page ? matching.slice(-DRAWN) : matching.slice(collapsed && terms.length === 0 ? -1 : -Math.min(DRAWN, Math.max(1, fitted.length + more)))
      const isFull = visible.length >= DRAWN
      if (selected && !visible.some(post => post.seq === open)) {
        visible.unshift(selected)
      }
      const older = matching.length - visible.length
      body =
        visible.length === 0 ? (
          <Box flexDirection="column" gap="sm" minWidth={0}>
            {bar(shown.posts.length > 0)}
            {historyControls}
            <Box flexDirection="column" gap="xs" marginTop={compose || shown.posts.length > 0 ? undefined : 'sm'} borderStyle="round" borderColor={browsed?.boardUnavailable ? 'warning' : 'subtle'} borderDimColor paddingX="sm" paddingY="xs" minWidth={0}>
              <Box flexDirection="row" alignItems="center" columnGap="xs" minWidth={0}>
                {HeaderArt && <Box flexShrink={0}><HeaderArt source={semanticIcon(browsed?.boardUnavailable ? 'warn' : 'info')} alt={browsed?.boardUnavailable ? 'Unavailable' : 'Info'} width={12} height={12} /></Box>}
                <Box flexShrink={1} minWidth={0}>
                  <Text dimColor>{shown.posts.length > 0 ? 'No posts match the filter.' : browsed?.boardUnavailable ? 'Board data unavailable: its board could not be read.' : 'No posts yet.'}</Text>
                </Box>
              </Box>
              {browsed?.boardUnavailable && retry}
            </Box>
          </Box>
        ) : (
          <Box flexDirection="column" gap="sm" minWidth={0}>
            {bar(true)}
            {historyControls}
            {!page && before > 1 && (
              <Text size="caption" dimColor tabular>{`Recent view · ${shown.posts.length} of ${shown.total ?? shown.posts.at(-1)?.seq} posts`}</Text>
            )}
            {!page && terms.length === 0 && shown.posts.length > 1 && (
              <Button
                key="collapse-history"
                plain
                dimColor
                label={collapsed ? `Show history (${shown.posts.length - 1})` : 'Collapse history'}
                onPress={() => update($, latestOnly, value => !value)}
              />
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
              const isDiffLoading = loadingDiffSeq === post.seq
              // A post opened from Attention that the pane no longer keeps: it stays until it is dismissed.
              const isInspected = inspectedPost?.seq === post.seq && !shown.posts.some(p => p.seq === post.seq)
              const postText = isOpen ? chipped(post, openedText(post)) : preview(post)

              return (
                <Box
                  key={`post-${post.seq}`}
                  flexDirection="column"
                  gap="xs"
                  borderStyle="round"
                  borderColor={kind?.color ?? 'subtle'}
                  borderDimColor
                  hover={{ borderDimColor: false }}
                  paddingX="sm"
                  paddingY="xs"
                  minWidth={0}
                >
                  {isInspected && <Text size="caption" color="warning">Pinned from attention</Text>}
                  <Box flexDirection="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" columnGap="sm" minWidth={0}>
                    <Box flexDirection="row" alignItems="center" columnGap="xs" flexWrap="wrap" minWidth={0}>
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
                        <Box flexDirection="row" alignItems="center" columnGap="xs">
                          {HeaderArt && <Box flexShrink={0}><HeaderArt source={semanticIcon(verdictIconOf(kind.label))} alt={kind.label} width={12} height={12} /></Box>}
                          <Text size="caption" weight="semibold" color={kind.color}>{kind.covered?.length ? `${kind.label} · ${kind.covered.map(name => `@${name}`).join(' ')}` : kind.label}</Text>
                        </Box>
                      )}
                    </Box>
                    <Text size="caption" dimColor tabular>{`#${post.seq}${time ? ` · ${time}` : ''}`}</Text>
                  </Box>
                  {isOpen && kind?.covered && (
                    <Text size="caption" color="warning">{`Partial pass of ${kind.covered.map(name => `@${name}`).join(', ') || 'some workers'}: their pieces only, not the run's pass.`}</Text>
                  )}
                  {postText !== '' && (
                    <Box flexShrink={1} minWidth={0}>
                      <Markdown text={formatMarkdown(postText)} />
                    </Box>
                  )}
                  {isDiffOpen && diffParts(openDiff.text)[0] !== '' && <Text key={`diff-scope-${post.seq}`} size="caption" dimColor>{diffParts(openDiff.text)[0]}</Text>}
                  {isDiffOpen && (
                    <Box flexShrink={1} minWidth={0}>
                      <Markdown key={`diff-text-${post.seq}`} text={diffParts(openDiff.text)[1]!} />
                    </Box>
                  )}
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
                          label={isDiffOpen ? '▴ Hide diff' : isDiffLoading ? 'Loading diff…' : 'View diff'}
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
        ['unreachable', 'ignored', 'stale', 'rework', 'dispute', 'retired-running', 'conflict'].includes(kind) ? 'error' : kind === 'paused' || kind === 'member_paused' ? 'warning'
          : ['unread', 'review', 'question', 'unstarted', 'blocked', 'spend', 'silent', 'loop', 'heavy', 'dispatch'].includes(kind) ? 'warning' : undefined
      const isSpent = shown.budget > 0 && total >= shown.budget
      const ask = (text: string) => submitHeld($, text, () => $.ui.toast('Swarm could not send that request to the coordinator.'))
      const seenKeys = new Map<string, number>()
      // The live run's report is read again on the next poll; a browsed run's only on Retry.
      const isAttentionIssue = Boolean(shown.attentionUnavailable || browsed?.boardUnavailable)
      body = shown.attention.length === 0 ? (
        <Box flexDirection="column" gap="xs" marginTop="sm" borderStyle="round" borderColor={isAttentionIssue ? 'warning' : 'subtle'} borderDimColor paddingX="sm" paddingY="xs" minWidth={0}>
          <Box flexDirection="row" alignItems="center" columnGap="xs" minWidth={0}>
            {HeaderArt && <Box flexShrink={0}><HeaderArt source={semanticIcon(isAttentionIssue ? 'warn' : 'pass')} alt={isAttentionIssue ? 'Unavailable' : 'All clear'} width={12} height={12} /></Box>}
            <Box flexShrink={1} minWidth={0}>
              <Text dimColor>{!shown.attentionUnavailable ? 'Nothing needs attention.' : browsed ? 'Attention details unavailable for this run.' : 'Attention details unavailable. Swarm will retry.'}</Text>
            </Box>
          </Box>
          {browsed?.boardUnavailable && <Text dimColor>Board data unavailable: its board could not be read.</Text>}
          {(browsed?.boardUnavailable || shown.attentionUnavailable) && retry}
        </Box>
      ) : (
        <Box flexDirection="column" gap="sm" marginTop="sm">
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
              item.kind === 'paused' ||
              item.kind === 'ignored' ||
              item.kind === 'review' ||
              item.kind === 'rework' ||
              isPlainAsk
            ))
            const itemTone = tone(item.kind)
            return (
            <Box
              key={`attention-${itemKey}`}
              flexDirection="column"
              gap="xs"
              borderStyle="round"
              borderColor={itemTone ?? 'subtle'}
              borderDimColor
              hover={{ borderDimColor: false }}
              paddingX="sm"
              paddingY="xs"
              minWidth={0}
            >
              <Box flexDirection="row" alignItems="flex-start" columnGap="xs" minWidth={0}>
                {HeaderArt && <Box flexShrink={0}><HeaderArt source={semanticIcon(attentionIconOf(item.kind, itemTone))} alt={formatAttentionKind(item.kind)} width={12} height={12} /></Box>}
                <Box flexShrink={1} minWidth={0}>
                  <Text>
                    <Text weight="semibold" color={itemTone}>{formatAttentionKind(item.kind)}</Text>
                    <Text>{`  ${item.text}`}</Text>
                  </Text>
                </Box>
              </Box>
              {hasActions && (
              <Box flexDirection="row" gap="sm" flexWrap="wrap">
                {item.seq > 0 && (
                  <Button
                    key={`attention-open-${itemKey}`}
                    plain
                    dimColor
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
                    onPress={() => control($, shown.dir, ['limit', '--raise', `budget=${Math.max(shown.budget, total) + 500_000}`], ['resume'])}
                  />
                )}
                {item.kind === 'paused' && !isSpent && isDriven && (
                  <Button
                    key={`attention-resume-run-${itemKey}`}
                    plain
                    label="Resume run"
                    onPress={() => control($, shown.dir, ['resume'])}
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
      const memberOffset = phase(slot('members'), shown.dir, `talk/${open.name}`, now)
      const talkPaused = member !== undefined && !shown.isClosed && (shown.isPaused === true || isMemberBudgetPaused(member))
      const talkStatus = member
        ? (talkPaused && !['killed', 'closed', 'failed', 'unreachable', 'stopped'].includes(member.status) ? 'paused' : member.status)
        : ''
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
        <Text key={`talk-${index}`} size="caption" dimColor>{row.text}</Text>
      ) : row.kind === 'prompt' ? (
        <Box key={`talk-${index}`} flexDirection="column" gap="xs" borderStyle="round" borderColor="subtle" borderDimColor paddingX="sm" paddingY="xs" minWidth={0}>
          <Text size="caption" weight="semibold" dimColor>{index === 0 ? 'Prompt' : 'Message'}</Text>
          <Box flexShrink={1} minWidth={0}>
            <Markdown text={formatMarkdown(row.text)} />
          </Box>
        </Box>
      ) : (
        <Box key={`talk-${index}`} flexDirection="column" gap="xs" minWidth={0}>
          <Text size="caption" weight="semibold" color={hueOf(open.name)}>@{open.name}</Text>
          <Box flexShrink={1} minWidth={0}>
            <Markdown text={formatMarkdown(row.text)} />
          </Box>
        </Box>
      )
      body = (
        <Box flexDirection="column" marginTop="sm" gap="sm">
          <Box
            key="talk-header"
            flexDirection="row"
            alignItems="center"
            justifyContent="space-between"
            columnGap="sm"
            rowGap="xs"
            flexWrap="wrap"
            borderStyle="round"
            borderColor={hueOf(open.name)}
            borderDimColor
            hover={{ borderDimColor: false }}
            paddingX="sm"
            paddingY="xs"
          >
            <Box flexDirection="row" alignItems="center" columnGap="sm" flexShrink={1} minWidth={0}>
              <Button key="talk-back" plain label="‹ Members" onPress={() => closeTalk($)} />
              {member && member.status !== 'closed' && (
                HeaderArt ? (
                  <Box flexShrink={0}>
                    <HeaderArt source={statusDot(talkStatus, memberOffset, open.name)} alt={talkStatus} width={12} height={12} />
                  </Box>
                ) : (
                  <Text color={statusInk(talkStatus)}>{terminalStatusGlyph(member.status, talkPaused)}</Text>
                )
              )}
              <Box flexShrink={1} minWidth={0}>
                <Text wrap="truncate-end">
                  <Text weight="semibold" color={hueOf(open.name)}>@{open.name}</Text>
                  <Text dimColor>{`  conversation${member ? ` · ${talkStatus}` : ''}`}</Text>
                </Text>
              </Box>
            </Box>
            {member && member.posts > 0 && (
              <Button key="talk-posts" plain dimColor label="Posts" onPress={() => feedOf(open.name)} />
            )}
          </Box>
          {open.rows.length === 0 ? (
            <Box flexDirection="row" alignItems="center" columnGap="xs" borderStyle="round" borderColor="subtle" borderDimColor paddingX="sm" paddingY="xs" minWidth={0}>
              {HeaderArt && <Box flexShrink={0}><HeaderArt source={semanticIcon('info')} alt="Info" width={12} height={12} /></Box>}
              <Box flexShrink={1} minWidth={0}>
                <Text dimColor>Nothing said yet.</Text>
              </Box>
            </Box>
          ) : draw(open.rows[0]!, 0)}
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
            <Text size="caption" dimColor>{`${open.skipped} earlier entries are not kept here.`}</Text>
          )}
          {open.rows.slice(from).map((row, index) => draw(row, from + index + open.skipped))}
        </Box>
      )
    } else if (current === 'members') {
      const memberOffset = phase(slot('members'), shown.dir, 'cards', now)
      const beeScale = 2
      const beeWidth = MEMBER_BEE_SIZE.width * beeScale
      const beeHeight = MEMBER_BEE_SIZE.height * beeScale
      const isCompact = HeaderArt !== undefined && columns < 42
      const unitSpace = isCompact ? '\u00a0' : ' '
      const card = (member: Member) => {
        const last = shown.posts.findLast(post => post.agent === member.name)
        const hue = hueOf(member.name)
        const accent = memberAccents[hue]
        const motionOffset = memberOffset + (memberOrder.get(member.name) ?? 0) * 173
        const memberPaused = !shown.isClosed && (shown.isPaused === true || isMemberBudgetPaused(member))
        const isBroken = ['failed', 'unreachable', 'stopped'].includes(member.status)
        const effectiveStatus = memberPaused && !isBroken && member.status !== 'killed' && member.status !== 'closed' ? 'paused' : member.status
        const statusColor = statusInk(effectiveStatus)
        const plan = [
          member.owns === '' ? '' : `owns ${member.owns}`,
          member.depends.length === 0 ? '' : `after ${member.depends.map(name => `@${name}`).join(', ')}`,
        ].filter(part => part !== '').join(' · ')

        // The coordinator's conversation is this session's main one, and only for a run it drives or drove.
        const canOpenTalk = member.role === 'coordinator' ? hasMainTalk : member.id !== undefined && member.status !== 'killed'
        const hasActions = canOpenTalk || member.posts > 0 || member.role === 'coordinator'
        const summaryLines = last ? bodyOf(last).split('\n').slice(0, kindOf(last.text) ? 2 : 1).filter(l => l.trim() !== '').join(' · ') : ''
        const meta = [member.role === 'coordinator' ? '' : member.type, `${member.model} ${member.effort}`.trim()].filter(Boolean).join(' · ')
        // Allow for card border, padding, column gap, and the bee's width + inset when fitting name and model.
        const identityWidth = visualWidth(member.name) + 3 + .8 * visualWidth(meta)
        const stackIdentity = HeaderArt !== undefined && (isCompact || identityWidth > columns - Math.ceil(beeWidth / 8) - 7)
        const memberSpend = spentBy(member)
        const detailColor = member.status === 'closed'
          ? (member.detail.includes('NOT PASSED') || member.detail.includes('NOT VERIFIED') ? 'error'
            : member.detail.includes('VERIFIED') || member.detail.includes('READY') ? 'success'
              : member.detail.includes('PARTIAL PASS') || member.detail.includes('Partial pass') || member.detail.includes('REVISE') || member.detail.includes('SHUTDOWN') ? 'warning'
                : undefined)
          : isBroken || member.status === 'killed' ? 'error'
            : member.detail === 'reported ready' ? 'success'
              : 'warning'
        const identity = (
          <Text wrap="truncate-end">
            <Text weight="semibold" color={hue} strikethrough={member.status === 'killed'}>@{member.name}</Text>
            {!stackIdentity && meta && <Text size="caption" dimColor>{`  ${meta}`}</Text>}
          </Text>
        )
        const status = (
          <Box flexDirection="row" alignItems={isCompact ? 'flex-start' : 'center'} columnGap="xs" minWidth={0}>
            {member.status === 'closed' ? null : HeaderArt ? (
              <Box flexShrink={0}>
                <HeaderArt source={statusDot(effectiveStatus, motionOffset, member.name)} alt={effectiveStatus} width={12} height={12} />
              </Box>
            ) : <Text color={statusColor}>{terminalStatusGlyph(member.status, memberPaused)}</Text>}
            <Box flexShrink={1} minWidth={0}>
              <Text tabular size={HeaderArt ? 'caption' : undefined} wrap={isCompact ? 'wrap' : 'truncate-end'}>
                <Text dimColor>{`${effectiveStatus} ·${unitSpace}${counted(member.posts, 'post').replace(' ', unitSpace)}`}</Text>
                {memberSpend > 0 && <Text dimColor>{` ·${unitSpace}${compact(memberSpend)}${unitSpace}tokens`}</Text>}
              </Text>
            </Box>
            {member.unread > 0 && member.status !== 'killed' && (
              <Box flexShrink={0}>
                <Text tabular size={HeaderArt ? 'caption' : undefined} weight="semibold" color="warning">{`·${unitSpace}${member.unread}${unitSpace}unread`}</Text>
              </Box>
            )}
          </Box>
        )

        return (
          <Box
            key={member.name}
            flexDirection="column"
            gap="xs"
            borderStyle="round"
            borderColor={HeaderArt ? accent : hue}
            borderDimColor
            hover={{ borderDimColor: false }}
            paddingX="sm"
            paddingY="xs"
            minWidth={0}
          >
            {HeaderArt ? (
              <Box flexDirection="row" alignItems="flex-start" columnGap="sm" minWidth={0}>
                <Box flexDirection="column" gap="xs" flexGrow={1} flexShrink={1} minWidth={0}>
                  {identity}
                  {stackIdentity && meta && <Text size="caption" dimColor wrap="truncate-end">{meta}</Text>}
                  {status}
                </Box>
                <Box key={`bee-${member.name}`} flexShrink={0} paddingTop="xs" paddingRight="sm">
                  <HeaderArt
                    source={memberBee(accent, member.status, motionOffset, member.name, memberPaused)}
                    alt={`Bee for ${member.name}`}
                    width={beeWidth}
                    height={beeHeight}
                  />
                </Box>
              </Box>
            ) : identity}
            {!HeaderArt && status}
            {member.detail !== '' && (
              <Text color={detailColor} dimColor={member.status === 'closed' && detailColor === undefined} wrap="truncate-end">{member.detail}</Text>
            )}
            {member.status !== 'killed' && plan !== '' && <Text size="caption" dimColor wrap="truncate-end">{plan}</Text>}
            {last !== undefined && (
              <Text size="caption" dimColor tabular wrap="truncate-end">
                {`#${last.seq}${summaryLines ? `  ${summaryLines}` : ''}`}
              </Text>
            )}
            {hasActions && (
              <Box flexDirection="row" columnGap="sm" rowGap="xs" flexWrap="wrap" alignItems="center">
                {canOpenTalk && (
                  <Button key={`view-${member.name}`} plain dimColor label="Open conversation" onPress={async () => { if (!(await viewAgent($, member))) await feedOf(member.name) }} />
                )}
                {member.posts > 0 && (
                  <Button key={`feed-${member.name}`} plain dimColor label="Posts" onPress={() => feedOf(member.name)} />
                )}
                {member.role === 'coordinator' && !hasMainTalk && <Text size="caption" dimColor>Its conversation is not available here.</Text>}
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
      const needsAttn = shown.members.filter(needsMemberAttention)
      const needsAttnNames = new Set(needsAttn.map(m => m.name))
      const knownStatuses = new Set(['failed', 'unreachable', 'stopped', 'working', 'coordinating', 'waiting', 'not started', 'closed', 'killed'])
      const groups: [string, Member[]][] = [
        ['Needs attention', needsAttn],
        ['Active', shown.members.filter(m => !needsAttnNames.has(m.name) && ['working', 'coordinating'].includes(m.status))],
        ['Standing by', shown.members.filter(m => !needsAttnNames.has(m.name) && ['waiting', 'not started'].includes(m.status) && !(hiding && inactive.has(m.name)))],
        ['At close', hiding ? [] : shown.members.filter(m => !needsAttnNames.has(m.name) && m.status === 'closed')],
        ['Retired', hiding ? [] : shown.members.filter(m => !needsAttnNames.has(m.name) && m.status === 'killed')],
        ['Other', shown.members.filter(m => !needsAttnNames.has(m.name) && !knownStatuses.has(m.status))],
      ]
      const visibleGroups = groups.filter(([, list]) => list.length > 0)
      body = (
        <Box flexDirection="column" marginTop="sm" gap="sm">
          {shown.members.length > 0 && <Box flexDirection="row" justifyContent="flex-end">{inactiveToggle(inactive.size)}</Box>}
          {shown.members.length === 0 ? (
            <Box flexDirection="row" alignItems="center" columnGap="xs" borderStyle="round" borderColor="subtle" borderDimColor paddingX="sm" paddingY="xs" minWidth={0}>
              {HeaderArt && <Box flexShrink={0}><HeaderArt source={semanticIcon('info')} alt="Info" width={12} height={12} /></Box>}
              <Box flexShrink={1} minWidth={0}>
                <Text dimColor>No members registered yet.</Text>
              </Box>
            </Box>
          ) : visibleGroups.length === 0 ? (
            <Box flexDirection="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" columnGap="sm" rowGap="xs" borderStyle="round" borderColor="subtle" borderDimColor paddingX="sm" paddingY="xs" minWidth={0}>
              <Box flexDirection="row" alignItems="center" columnGap="xs" flexShrink={1} minWidth={0}>
                {HeaderArt && <Box flexShrink={0}><HeaderArt source={semanticIcon('info')} alt="Info" width={12} height={12} /></Box>}
                <Box flexShrink={1} minWidth={0}>
                  <Text dimColor>All members are inactive.</Text>
                </Box>
              </Box>
              <Button key="show-inactive-empty" plain label={`Show inactive (${inactive.size})`} onPress={() => update($, hideInactive, () => false)} />
            </Box>
          ) : (
            visibleGroups.map(([title, list]) => (
              <Box key={title} flexDirection="column" gap="sm">
                <Text size="caption" weight="semibold" dimColor tabular>{`${title} · ${list.length}`}</Text>
                {[...list].sort(byName).map(card)}
              </Box>
            ))
          )}
        </Box>
      )
    } else if (shown.posts.length === 0) {
      body = (
        <Box flexDirection="column" gap="xs" marginTop="sm" borderStyle="round" borderColor={browsed?.boardUnavailable ? 'warning' : 'subtle'} borderDimColor paddingX="sm" paddingY="xs">
          <Box flexDirection="row" alignItems="center" columnGap="xs" minWidth={0}>
            {HeaderArt && <Box flexShrink={0}><HeaderArt source={semanticIcon(browsed?.boardUnavailable ? 'warn' : 'info')} alt={browsed?.boardUnavailable ? 'Unavailable' : 'Info'} width={12} height={12} /></Box>}
            <Box flexShrink={1} minWidth={0}>
              <Text dimColor>{browsed?.boardUnavailable ? 'Board data unavailable: its board could not be read.' : 'No posts yet.'}</Text>
            </Box>
          </Box>
          {browsed?.boardUnavailable && retry}
        </Box>
      )
    } else if (e.surface !== 'terminal') {
      // the terminal has no Svg: it keeps the list below
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
      // Incoming posts animate once on the live board; a live post with no newer post queued renders directly in
      // unified play-loop mode (animate + repeat) to avoid a second iframe reload. At the latest post outside active
      // playback, repeat stays on across live, closed, paused, and browsed runs so breathing loops stay active.
      const isLiveRun = !browsed && !shown.isClosed && !shown.isPaused
      const isLatest = index === shown.posts.length - 1
      const isLivePulse = isLiveRun && live && pulse === post.seq
      const animate = playing || isLivePulse
      const repeat = (!playing && isLatest && !animate) || (!playing && isLatest && isLivePulse)
      const mode = animate && repeat ? 'play-loop' : animate ? 'play' : repeat ? 'repeat' : 'still'
      const isLiveVisible = live && isLiveRun
      if (!isLiveVisible) clearHeldStatuses()
      const graphSwarm = isLiveVisible ? settledStatuses($, shown, `${slot('route')}/${shown.dir}/${post.seq}/${mode}`, animate && !repeat, now) : shown
      const hideable = [...(graphSwarm === shown ? inactive : inactiveOf(graphSwarm.members))].filter(name =>
        memberOf(name)?.role !== 'coordinator' && (participants === undefined || participants.has(name)) &&
        name !== post.agent && !post.to.includes(name),
      )
      const hidden = new Set(hiding ? hideable : [])
      const isExpanded = await read($, expandAll)
      const hasBroadcast = shown.posts.some(isBroadcast) || Object.keys(shown.earlierEdges ?? {}).some(edge => edge.endsWith('>@all'))
      if (!isLiveVisible) hideMotion(slot('live'))
      const postKind = verdictOf(post)
      const time = postTime(post)
      const strippedGraphBody = chipped(post)
      const graphPostBody = detailsOpen ? chipped(post, openedText(post)) : clip(strippedGraphBody)
      const drawnMembers = visibleMembers(graphSwarm, post.seq, hidden, live)
      // Names drawn smaller than this are not read, so the routes are listed instead. The pane gives its width in
      // columns only: pixels are estimated from them.
      const isLegible = labelPx(columns, drawnMembers) >= MIN_LABEL_PX
      const routeSlot = slot('route')
      const drawing = JSON.stringify([live, isExpanded, Boolean(shown.isPaused), shown.isClosed, [...hidden],
        drawnMembers.map(m => [m.name, m.role, live ? m.status : '', m.depends])])
      const routeOffset = isLegible
        ? phase(routeSlot, `${shown.dir}/${post.seq}`, `${mode}/${drawing}`, now, animate && !clocks.get(routeSlot)?.view.startsWith('play'))
        : 0
      const graphKey = `${shown.dir}\0${post.seq}\0${mode}\0${drawing}\0${routeOffset}\0${shown.posts.length}\0${shown.total ?? 0}\0${Object.keys(shown.earlierEdges ?? {}).length}\0${post.agent}\0${post.to.join(',')}`
      let graph: ReturnType<typeof drawGraph> | undefined
      let source: string | undefined
      if (isLegible) {
        if (graphCache?.key === graphKey) {
          graph = graphCache.graph
          source = graphCache.source
        } else {
          graph = drawGraph(graphSwarm, post.seq, hidden, animate, live, repeat, routeOffset, isExpanded)
          // The host refuses a longer source, and the whole pane with it: such a graph is listed too.
          source = graph.svg !== undefined && byteLength(graph.svg) <= SVG_LIMIT ? graph.svg : undefined
          graphCache = { key: graphKey, graph, source }
        }
      }
      if (source === undefined) hideMotion(routeSlot)
      const last = shown.posts.length - 1
      const feedMembers = shown.members.filter(member => !hidden.has(member.name) && member.posts > 0)
      const timelineRatio = (index + 1) / shown.posts.length
      const timelineBarWidth = Math.max(160, Math.min(600, columns * 8))
      const timelineOffset = phase(slot('timeline'), shown.dir, `${progressUnits(timelineRatio)}/${playing}/${isLiveVisible}/${timelineBarWidth}`, now)
      const liveOffset = isLiveVisible ? phase(slot('live'), shown.dir, 'live', now, false, true) : 0
      body = (
        <Box flexDirection="column" marginTop="sm" gap="sm" minWidth={0}>
          {GraphControls($, e, {
            shown,
            isLiveVisible,
            live,
            browsed: Boolean(browsed),
            index,
            last,
            playing,
            isExpanded,
            hasBroadcast,
            liveOffset,
            timelineRatio,
            timelineBarWidth,
            timelineOffset,
            inactiveControl: inactiveToggle(hideable.length),
          })}
          {GraphCanvas($, e, {
            source,
            isLegible,
            post,
            columns,
            drawnMembers,
            hiddenRoutes: graph?.hidden ?? 0,
            legendHeight: graph?.legendHeight,
            fallbackRoutes: routeList(isExpanded, hidden, post.seq),
          })}
          {source !== undefined && GraphRouteList($, e, {
            listed: routesListed,
            onToggle: () => { routesListed = !routesListed; routePages = 1; $.ui.invalidate('ui.render') },
            content: routeList(isExpanded, hidden, post.seq),
          })}
          {GraphMembersStrip($, e, {
            members: feedMembers,
            hueOf,
            onFeed: feedOf,
          })}
          {GraphPostCard($, e, {
            post,
            postKind,
            time,
            detailsOpen,
            strippedGraphBody,
            graphPostBody,
            hue: hueOf(post.agent),
            onOpenAgent: async () => { if (!(await viewAgent($, memberOf(post.agent)))) await feedOf(post.agent) },
            onToggleDetails: () => update($, expanded, seq => seq === post.seq ? 0 : post.seq).then(() => undefined),
          })}
        </Box>
      )
    } else {
      const isExpanded = await read($, expandAll)
      const hasBroadcast = shown.posts.some(isBroadcast) || Object.keys(shown.earlierEdges ?? {}).some(edge => edge.endsWith('>@all'))
      // As in the diagram: the coordinator is never hidden for being idle.
      const hideable = [...inactive].filter(name => memberOf(name)?.role !== 'coordinator')
      const hiddenSet = new Set(hiding ? hideable : [])
      const feedMembers = shown.members.filter(member => !hiddenSet.has(member.name) && member.posts > 0)
      body = (
        <Box flexDirection="column" marginTop="sm" gap="sm" minWidth={0}>
          <Box flexDirection="row" columnGap="sm" rowGap="xs" alignItems="center" flexWrap="wrap" minWidth={0}>
            {hasBroadcast ? (
              <Button
                key="expand-all"
                plain
                dimColor={!isExpanded}
                label={isExpanded ? 'Collapse @all' : 'Expand @all'}
                onPress={() => update($, expandAll, isOn => !isOn)}
              />
            ) : (
              <Text key="expand-all" dimColor>Expand @all</Text>
            )}
            {inactiveToggle(hideable.length)}
          </Box>
          {routeList(isExpanded, hiddenSet)}
          {GraphMembersStrip($, e, {
            members: feedMembers,
            hueOf,
            onFeed: feedOf,
          })}
        </Box>
      )
    }

    // Two lines of the heading's column: the pane's width less the hive's, at about 1.25 columns a heading character.
    const titleRoom = 2 * Math.max(12, Math.floor((columns - (HeaderArt ? (columns < 48 ? 8 : 11) : 0)) / 1.25))
    const isTitleCut = visualWidth(shown.title) > titleRoom
    const activeSummary = [
      coordinating > 0 ? `${coordinating} coordinating` : '',
      `${working} working`,
      `${waiting} waiting`,
    ].filter(Boolean).join(' · ')

    const budgetRatio = shown.budget > 0 ? total / shown.budget : 0
    const budgetPercent = Math.round(budgetRatio * 100)
    const budgetTone: BarTone = budgetRatio >= 0.9 ? 'error' : budgetRatio >= 0.75 ? 'warning' : 'accent'
    const isHeaderLive = !browsed && !shown.isClosed && !shown.isPaused
    const budgetBarWidth = columns < 40 ? 80 : 120
    const dividerWidth = Math.max(160, Math.min(1024, columns * 8))
    const budgetOffset = phase(slot('budget'), shown.dir, `${budgetPercent}/${budgetTone}/${isHeaderLive}/${tabView}/${budgetBarWidth}`, now)

    return (
      <Box flexDirection="column" minWidth={0}>
        <Box flexDirection="row" alignItems="center" columnGap="sm" minWidth={0}>
          {/* A narrow pane gives the title the hive's room. The host clamps no lines, so a title longer than two lines of
              its column is cut at a word, and the whole of it is one press away. */}
          {HeaderArt && <Box flexShrink={0}><HeaderArt key="hive" source={hiveArt(mood, hiveOffset)} alt={`Swarm hive: ${shown.mood ?? 'sleep'}`} width={columns < 48 ? 56 : 88} height={columns < 48 ? 28 : 44} /></Box>}
          <Box flexDirection="column" gap="xs" flexGrow={1} flexShrink={1} minWidth={0}>
            <Text size="heading" weight="semibold" wrap="wrap">{isTitleCut && titleOpen !== shown.dir ? clip(shown.title, titleRoom) : shown.title}</Text>
            {isTitleCut && (
              <Button key="title-more" plain dimColor label={titleOpen === shown.dir ? 'Show less of the title' : 'Show the whole title'}
                onPress={() => { titleOpen = titleOpen === shown.dir ? '' : shown.dir; $.ui.invalidate('ui.render') }} />
            )}
            <Text dimColor tabular wrap="truncate-end">
              {shown.isClosed ? 'Closed' : shown.isPaused ? <Text color="warning" weight="medium">Paused</Text> : activeSummary}
              {!shown.isClosed && failed > 0 && <Text color="error" weight="medium">{` · ${failed} failed`}</Text>}
              {!shown.isClosed && stopped > 0 && <Text color="error" weight="medium">{` · ${stopped} stopped`}</Text>}
              {` · ${counted(shown.total ?? shown.posts.length, 'post')}`}
              {total > 0 ? ` · ${compact(total)}${shown.budget > 0 ? ` of ${compact(shown.budget)}` : ''} tokens` : ''}
              {!HeaderArt && shown.budget > 0 && (
                <Text color={budgetRatio >= 0.9 ? 'error' : budgetRatio >= 0.75 ? 'warning' : undefined} dimColor={budgetRatio < 0.75}>
                  {` (${Math.round(budgetRatio * 100)}%)`}
                </Text>
              )}
            </Text>
            {HeaderArt && shown.budget > 0 && (
              <Box flexDirection="row" alignItems="center" columnGap="xs">
                <Box flexShrink={0}>
                  <HeaderArt
                    source={progressBar(budgetRatio, budgetTone, isHeaderLive && total > 0, budgetOffset, budgetBarWidth)}
                    alt={`Token budget ${Math.round(budgetRatio * 100)}%`}
                    width={budgetBarWidth}
                    height={6}
                  />
                </Box>
                <Text size="caption" color={budgetRatio >= 0.9 ? 'error' : budgetRatio >= 0.75 ? 'warning' : undefined} dimColor={budgetRatio < 0.75} tabular>
                  {`${Math.round(budgetRatio * 100)}%`}
                </Text>
              </Box>
            )}
          </Box>
        </Box>
        {error && (
          <Box flexDirection="row" alignItems="center" columnGap="xs" marginTop="xs" borderStyle="round" borderColor="warning" borderDimColor paddingX="sm" paddingY="xs" minWidth={0}>
            {HeaderArt && <Box flexShrink={0}><HeaderArt source={semanticIcon('warn')} alt="Warning" width={12} height={12} /></Box>}
            <Box flexShrink={1} minWidth={0}><Text color="warning">{error}</Text></Box>
          </Box>
        )}
        <Box flexDirection="row" columnGap="sm" rowGap="xs" flexWrap="wrap" alignItems="center" marginTop="xs">
          <Text weight="medium" dimColor>Run</Text>
          {/* At an end of the history the list showed, the step is text, as a replay step that leads nowhere is. */}
          {runEdge.dir === shown.dir && runEdge.older === false
            ? <Text key="run-prev" dimColor>‹ Prev run</Text>
            : <Button key="run-prev" plain label="‹ Prev run" onPress={() => browse($, 1)} />}
          {runEdge.dir === shown.dir && runEdge.newer === false
            ? <Text key="run-next" dimColor>Next run ›</Text>
            : <Button key="run-next" plain label="Next run ›" onPress={() => browse($, -1)} />}
          <Button key="run-export" plain dimColor hover={{ scope: 'run-export', dimColor: false }} label={exportingRun !== 0 ? 'Exporting…' : 'Export MD'} onPress={() => exportRun($, shown.dir)} />
          {isDriven && (
            <Button
              key="run-pause"
              plain
              dimColor={!shown.isPaused}
              hover={shown.isPaused ? undefined : { scope: 'run-pause', dimColor: false }}
              label={shown.isPaused ? 'Resume run' : 'Pause run'}
              onPress={() => control($, shown.dir, shown.isPaused ? ['resume'] : ['pause', 'paused from the pane'])}
            />
          )}
          {browsed && <Text weight="semibold" color="warning">Not the live run · read-only</Text>}
          {browsed && <Button key="run-live" plain label="Back to live run" onPress={() => browse($, 0)} />}
          <Button key="pane-close" plain dimColor label="Close" onPress={() => void $.ui.close({ id: PANE }).catch(() => undefined)} />
        </Box>
        {HeaderArt && (
          <Box marginTop="xs">
            <HeaderArt source={hairlineDivider} alt="Section divider" width={dividerWidth} height={1} />
          </Box>
        )}
        <Box flexDirection="row" gap="xs" flexWrap="wrap" marginTop="sm">
          {TABS.map((name, tabIdx) => {
            const hasAlert = name === 'attention' && shown.attention.length > 0
            const hasUrgent = hasAlert && shown.attention.some(item =>
              ['unreachable', 'ignored', 'stale', 'rework', 'dispute', 'retired-running', 'conflict'].includes(item.kind),
            )
            const tabLabel = `${name[0]?.toUpperCase()}${name.slice(1)}${hasAlert ? ` ${shown.attention.length}` : ''}`
            const onTabPress = async () => {
              closeTalk($)
              if (name !== current) {
                await stop($)
                await stopLive($)
                // A post opened from another tab belongs to that visit: it is not kept selected behind the next tab.
                if ((await read($, inspected)) !== null) await update($, inspected, () => null)
                if ((await read($, expanded)) !== 0) await update($, expanded, () => 0)
                // A diff or an older page still loading from this visit is dropped too: it would open on a tab the
                // user left. A page that loaded before stays.
                diffAsked++
                loadingDiffSeq = 0
                boardNavigation++
                if ((await read($, diff)).seq !== 0) await update($, diff, () => NO_DIFF)
                await update($, tab, () => name)
              }
            }
            return hasAlert && name !== current ? (
              <Button key={`tab-${name}`} hotkey={String(tabIdx + 1)} variant="secondary" label={tabLabel} onPress={onTabPress}>
                Attention
                <Text size="caption" weight="semibold" color={hasUrgent ? 'error' : 'warning'} tabular>{` ${shown.attention.length}`}</Text>
              </Button>
            ) : (
              <Button
                key={`tab-${name}`}
                hotkey={String(tabIdx + 1)}
                variant={name === current ? 'primary' : 'secondary'}
                onPress={onTabPress}
                label={tabLabel}
              />
            )
          })}
        </Box>
        {body}
      </Box>
    )
  })
}
