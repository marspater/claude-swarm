// The agent types of a swarm and the model and effort each starts on. board.py holds the same defaults by family.

// Read-only profiles that reach the board through its tool. The designer is a profile too, but writes files and uses the shell board like a worker.
export const SPECIALISTS = ['explorer', 'investigator', 'architect']
export const SWARM_AGENTS = new Set(['swarm:worker', 'swarm:verifier', 'swarm:designer', ...SPECIALISTS.map(role => `swarm:${role}`)])
// The model each agent type starts on when the Agent call names none; board.py holds the same table.
// The newest model of each family. Every Swarm member starts on one of these: a bare family name on the Agent
// call resolves here. When a model ships, update this table and the `model:` line of each agents/*.md file.
export const LATEST: Record<string, string> = {
  haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', fable: 'claude-fable-5-2',
}
export const latestOf = (model: string | undefined) => (model !== undefined && Object.hasOwn(LATEST, model) ? LATEST[model] : model)
export const DEFAULT_MODEL: Record<string, string> = {
  worker: LATEST.sonnet!, verifier: LATEST.opus!, explorer: LATEST.haiku!, investigator: LATEST.opus!, architect: LATEST.fable!, designer: LATEST.opus!,
}
export const DEFAULT_EFFORT: Record<string, string> = { worker: 'medium', verifier: 'high', explorer: 'medium', investigator: 'high', architect: 'high', designer: 'high' }
export const familyOf = (model: string) =>
  ['haiku', 'sonnet', 'opus', 'fable'].find(name => model.toLowerCase().includes(name)) ?? model
