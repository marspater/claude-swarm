export type Post = {
  seq: number
  agent: string
  text: string
  time: string
  /** The live members the post reaches, its sender left out. */
  to: string[]
  /** The full commit id a READY reported, when it reported one. */
  revision?: string
  /** A READY's base: the project's HEAD when it was posted, a full commit id. Its diff is the first-parent commits since. */
  base?: string
  /** Full commit ids a READY with a base also leaves out of its diff; never empty. */
  except?: string[]
  /** A VERIFIED of a partial candidate, and the workers it covered: not the run's pass. */
  partial?: true
  members?: string[]
  /** The workers a verifier's NOT PASSED rejects, and the candidate a verifier's verdict answers. */
  rejects?: string[]
  candidate?: string
}

export type MemberStatus =
  | 'coordinating'
  | 'working'
  | 'waiting'
  | 'not started'
  | 'failed'
  | 'stopped'
  | 'unreachable'
  | 'killed'
  | 'closed'

export type Member = {
  name: string
  role: string
  profile?: string
  /** The agent's address, once the coordinator has recorded it. */
  id?: string
  /** The model and effort it runs at: the roster's, else its type's default. */
  model: string
  effort: string
  /** The agent type behind it: `coordinator`, `worker`, `verifier`, `designer`, `explorer`, `investigator` or `architect`. */
  type: string
  /** The members whose READY it waits for, and what it owns, as the roster records them. */
  depends: string[]
  owns: string
  /** `coordinating`, `working`, `waiting`, `not started`, `failed`, `stopped` (its agent was killed while it is still on the roster), `unreachable`, `killed` (retired), or in a closed run `closed` (there at the close). */
  status: MemberStatus | (string & {})
  /** What a member that is not working waits for, in words; empty when nothing is pending. A member paused on its own token budget says so even while it works. */
  detail: string
  /** Paused on its own token budget. */
  isPaused?: boolean
  /** Read-only specialist that reached the context ceiling; the board wakes it no more. */
  isHeavy?: boolean
  /** Retired on the roster, but its underlying agent is still running. */
  isZombie?: boolean
  unread: number
  posts: number
}

/** One thing that needs someone, and the board post (0 for none) that shows it. */
export type AttentionItem = { kind: string; member: string; seq: number; text: string }

export type Swarm = {
  mood?: 'sleep' | 'forage' | 'inspect' | 'build' | 'verify' | 'relay' | 'paused' | 'attention'
  title: string
  dir: string
  /** The coordinator closed the run: nothing more is woken or called. */
  isClosed: boolean
  isPaused?: boolean
  /** The newest posts only; `total` counts them all. */
  posts: Post[]
  /** Every post on the board. Absent in a state stored by an older version. */
  total?: number
  /** Mention counts, keyed `from>to`, of the posts no longer in `posts`. */
  earlierEdges?: Record<string, number>
  members: Member[]
  attention: AttentionItem[]
  attentionUnavailable?: boolean
  /** The run's token budget; 0 for none. */
  budget: number
  tokens: Record<string, number>
}

export type Tab = 'board' | 'attention' | 'members' | 'graph'

declare module 'claude-code' {
  interface McpToolInputs {
    mcp__swarm__board: {
      /** A member's actions, then the coordinator's. */
      action: 'read' | 'show' | 'post' | 'ready' | 'revise' | 'status' |
        'init' | 'member' | 'limit' | 'plan' | 'attention' | 'confirm' | 'retry' | 'replace' | 'pause' | 'resume' | 'close' | 'export'
      member?: string
      seq?: number
      text?: string
      /** ready: the full commit id the report covers. */
      commit?: string
      title?: string
      name?: string
      newName?: string
      /** member, limit, replace: `key=value` settings. */
      options?: string[]
      out?: string
    }
  }

  interface PluginState {
    /** `replay` is the seq the graph shows; 0 follows the newest post. */
    swarm: { swarm: Shaped<Swarm>; tab: Tab; replay: number; loadError: string; isPlaying: boolean; livePulse: number; earlier: number; latestOnly: boolean; hideInactive: boolean; expandAll: boolean; expanded: number; inspected: Post | null; history: { dir: string; posts: Post[] } | null; run: string; query: string; diff: { seq: number; text: string } }
  }
}
