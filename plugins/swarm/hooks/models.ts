// The agent types of a swarm and the model and effort each starts on. board.py holds the same defaults by family.

// Read-only profiles that reach the board through its tool. The designer is a profile too, but writes files and uses the shell board like a worker.
export const SPECIALISTS = ['explorer', 'investigator', 'architect']
export const SWARM_AGENTS = new Set(['swarm:worker', 'swarm:verifier', 'swarm:designer', ...SPECIALISTS.map(role => `swarm:${role}`)])
// The newest model of each family. Every Swarm member starts on one of these: a bare family name on the Agent
// call resolves here. When a model ships, update this table and the `model:` line of each agents/*.md file.
export const LATEST: Record<string, string> = {
  haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', fable: 'claude-fable-5-2',
}
// A family name in any case, as familyOf reads it: `Opus` is the newest opus, not a model of its own.
export const latestOf = (model: string | undefined) => {
  const family = model?.toLowerCase() ?? ''
  return Object.hasOwn(LATEST, family) ? LATEST[family] : model
}
// The model each agent type starts on when the Agent call names none; board.py holds the same table.
export const DEFAULT_MODEL: Record<string, string> = {
  worker: LATEST.sonnet!, verifier: LATEST.sonnet!, explorer: LATEST.haiku!, investigator: LATEST.opus!, architect: LATEST.opus!, designer: LATEST.opus!,
}
export const DEFAULT_EFFORT: Record<string, string> = { worker: 'medium', verifier: 'medium', explorer: 'medium', investigator: 'medium', architect: 'high', designer: 'high' }
// As board.py's sized_effort: with no effort named, a small piece runs a step under its type's default and a large
// one a step over, never past high.
const EFFORT_STEPS = ['low', 'medium', 'high']
export const sizedEffort = (kind: string, size?: string) => {
  const base = DEFAULT_EFFORT[kind] ?? ''
  const at = EFFORT_STEPS.indexOf(base)
  return at < 0 || (size !== 's' && size !== 'l') ? base : EFFORT_STEPS[Math.max(0, Math.min(EFFORT_STEPS.length - 1, at + (size === 'l' ? 1 : -1)))]!
}
export const familyOf = (model: string) =>
  Object.keys(LATEST).find(name => model.toLowerCase().includes(name)) ?? model

/** The run's restriction on this advisor family, taking the member's profile and name into account. */
export function advisorBarred(limits: Record<string, string> | undefined, advisorModel: unknown, kind: string, name: string): { family: string; allowed: string[] } | undefined {
  if (typeof advisorModel !== 'string' || advisorModel.trim() === '') return undefined
  const family = familyOf(latestOf(advisorModel.trim()) ?? '')
  const raw = limits && Object.hasOwn(limits, family) ? limits[family] : undefined
  if (typeof raw !== 'string') return undefined
  const allowed = raw.split(',').filter(x => x && x !== 'none')
  return allowed.includes(kind) || allowed.includes(name) ? undefined : { family, allowed }
}
