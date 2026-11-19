export type Post = {
  seq: number
  agent: string
  text: string
  time: string
  /** The live members the post reaches, its sender left out. */
  to: string[]
}

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
  /** `coordinating`, `working`, `waiting`, `not started`, `failed`, `unreachable` or `killed`. */
  status: string
  /** What a member that is not working waits for, in words; empty when nothing is pending. */
  detail: string
  unread: number
  posts: number
}

/** One thing that needs someone, and the board post (0 for none) that shows it. */
export type AttentionItem = { kind: string; member: string; seq: number; text: string }

export type Swarm = {
  mood?: 'sleep' | 'forage' | 'inspect' | 'build' | 'verify' | 'relay'
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
      action: 'read' | 'show' | 'post' | 'ready' | 'revise'
      member?: string
      seq?: number
      text?: string
    }
  }

  interface PluginState {
    /** `replay` is the seq the graph shows; 0 follows the newest post. */
    swarm: { swarm: Shaped<Swarm>; tab: Tab; replay: number; loadError: string; isPlaying: boolean; livePulse: number; earlier: number; latestOnly: boolean; hideInactive: boolean; expandAll: boolean; expanded: number; inspected: Post | null; run: string; query: string }
  }
}
