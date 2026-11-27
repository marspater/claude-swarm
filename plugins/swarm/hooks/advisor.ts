// Claude Code declares its server-side advisor before each Messages send. A deferred tool can also
// be introduced or referenced later in the transcript. Only edit structured tool controls.
import { familyOf, LATEST } from './models'

type Tool = { name?: string; type?: string; model?: string; definition?: Tool }
type Block = { type: string; tool?: Tool; tool_name?: string; content?: string | Block[] }
type Message = { role: string; content: string | Block[] }

const isAdvisor = (tool?: Tool) => tool?.name === 'advisor' || tool?.type?.startsWith('advisor_') === true

export function filterAdvisor(body: string, barred: readonly string[], preferred?: string, memberModel?: string, maxEffort?: string): string {
  if (!barred.length && !preferred && !memberModel && !maxEffort) return body
  const request = JSON.parse(body) as { model?: string; output_config?: { effort?: string | number }; tools?: Tool[]; messages?: Message[]; tool_choice?: Tool }
  if (!Array.isArray(request.messages)) return body
  const forbidden = (tool: Tool) => {
    const family = familyOf(tool.model ?? '')
    return !Object.hasOwn(LATEST, family) || barred.includes(family) || (preferred && family === 'opus' && familyOf(request.model ?? '') === 'fable')
  }
  let changed = false
  if (memberModel && request.model !== memberModel) {
    request.model = memberModel
    changed = true
  }
  const levels = ['low', 'medium', 'high', 'xhigh', 'max']
  if (maxEffort && levels.includes(maxEffort)) {
    const current = request.output_config?.effort
    if (typeof current !== 'string' || !levels.includes(current) || levels.indexOf(current) > levels.indexOf(maxEffort)) {
      request.output_config = { ...request.output_config, effort: maxEffort }
      changed = true
    }
  }
  const select = (tool: Tool) => {
    if (!preferred) return
    if (barred.includes('opus') && tool.model === LATEST.sonnet && !barred.includes('sonnet') &&
        (preferred !== LATEST.fable || barred.includes('fable'))) return
    // Fable escalation requires the host to have offered that exact advisor.
    const model = preferred === LATEST.fable && tool.model !== LATEST.fable ? LATEST.opus : preferred
    if (model !== tool.model) {
      tool.model = model
      changed = true
    }
  }
  const declaration = request.tools?.find(isAdvisor)
  if (declaration) select(declaration)
  let blocked = declaration === undefined || forbidden(declaration)
  if (declaration && blocked) {
    request.tools = request.tools!.filter(tool => !isAdvisor(tool))
    changed = true
  }

  request.messages = request.messages.flatMap(message => {
    if (!Array.isArray(message.content)) return [message]
    if (message.role === 'user' && blocked) {
      // ToolSearch may have returned a reference in an earlier, unrestricted turn.
      const content = message.content.map(block => {
        if (block.type !== 'tool_result' || !Array.isArray(block.content)) return block
        const kept = block.content.filter(item => item.type !== 'tool_reference' || item.tool_name !== 'advisor')
        if (kept.length === block.content.length) return block
        changed = true
        return { ...block, content: kept }
      })
      return [{ ...message, content }]
    }
    if (message.role !== 'system') return [message]
    const content = message.content.filter(block => {
      if (block.type !== 'tool_addition' && block.type !== 'tool_removal') return true
      const tool = block.tool?.definition ?? block.tool
      if (!tool || !isAdvisor(tool)) return true
      if (block.type === 'tool_addition') {
        if (block.tool?.type === 'tool_definition') select(tool)
        blocked = block.tool?.type === 'tool_definition' ? forbidden(tool) : !declaration || forbidden(declaration)
      }
      return !blocked
    })
    if (content.length === message.content.length) return [message]
    changed = true
    return content.length ? [{ ...message, content }] : []
  })
  if (blocked && (isAdvisor(request.tool_choice) || (changed && !request.tools?.length && request.tool_choice))) {
    delete request.tool_choice
    changed = true
  }
  return changed ? JSON.stringify(request) : body
}
