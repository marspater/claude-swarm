import type { AgentLoop, McpToolInputs, ToolCallEnvelope, ToolCallReserved, ToolCallResult } from 'claude-code'
import { expect, mock, test, type Engine } from 'claude-code/testing'
import { wakeMessage } from './command'

// `$.tool.call`, its input checked per tool as the engine's own overloads check it. Those overloads (ToolCallArgs)
// relate every declared tool to every other: with the session's MCP tools declared, as `plugin validate` declares
// them, one call costs the type check gigabytes. This union is built per tool, once. The id is dropped by a key
// remap, not Omit: Omit over an MCP tool's input, which has an index signature, would drop its named fields too.
type ToolInput = ToolCallEnvelope extends infer I ? I extends { tool: string }
  ? { [K in keyof I as K extends 'tool_use_id' ? never : K]: I[K] } & ToolCallReserved<I['tool']> & AgentLoop : never : never
const toolCall = ($: Engine, input: ToolInput) => ($.tool.call as unknown as (input: ToolInput) => Promise<ToolCallResult>)(input)
// Pinned at compile time: each tool's own input holds through the helper, and a field only another tool takes is refused.
void (($: Engine) => [
  toolCall($, { tool: 'Monitor', command: 'tail -f log', description: 'watch the log', timeout_ms: 60_000 }),
  toolCall($, { tool: 'mcp__swarm__board', action: 'read', agentId: 'a1' }),
  // @ts-expect-error Edit's field is no Monitor field
  toolCall($, { tool: 'Monitor', command: 'tail -f log', description: 'watch the log', timeout_ms: 60_000, old_string: 'a' }),
  // @ts-expect-error Monitor needs its description
  toolCall($, { tool: 'Monitor', command: 'tail -f log', timeout_ms: 60_000 }),
  // @ts-expect-error the board knows no such action
  toolCall($, { tool: 'mcp__swarm__board', action: 'bogus' }),
  // @ts-expect-error the board's seq is a number
  toolCall($, { tool: 'mcp__swarm__board', action: 'show', seq: 'two' }),
])

// Agent lists are cast with `as never`: the fixtures name only the fields this plugin reads, and the engine's
// AgentInfo gains required fields between builds, so a literal typed against one build fails the next.

const PANE = {
  plugin: 'swarm',
  component: 'Pane',
  requestId: 'swarm',
  props: {
    title: 'Swarm',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const BOARD =
  [
    { seq: 1, agent: 'coordinator', text: '@parser BRIEF\nOwns: date.ts' },
    { seq: 2, agent: 'parser', text: '@verifier date.ts is ready' },
    { seq: 3, agent: 'verifier', to: ['parser'], text: '@parser line 4 fails, cc a@b.com\nDetails for the next pass.' },
  ]
    .map(post => JSON.stringify({ ...post, time: '2026-11-16T14:03:22+0100' }))
    .join('\n') + '\n{"seq": 4, "agent": "par'

const ROSTER = JSON.stringify({
  title: 'Demo swarm',
  members: {
    coordinator: { role: 'coordinator', last_read_seq: 3 },
    parser: { role: 'worker', id: 'a1', last_read_seq: 1 },
    verifier: { role: 'verifier', id: 'a2', last_read_seq: 3 },
    old: { role: 'worker', killed: '1', last_read_seq: 0 },
    later: { role: 'worker', last_read_seq: 3 },
  },
})

test('the pane draws the board, the members and the graph', async ($, on) => {
  // Nothing sits beneath the plugin: each hook here stands for the engine.
  on('command.register', () => ({ value: { command: 'swarm-board' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.register', (_, spec) => ({ value: { tool: `mcp__swarm__${spec.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/project' }))
  on('fs.exists', () => ({ value: true }))
  let board = BOARD
  let roster = ROSTER
  const viewed: (string | undefined)[] = []
  on('ui.view', (_, view) => { viewed.push(view.agentId); return { value: {} } })
  on('fs.read', (_, e) => ({
    value: e.path.endsWith('/current')
      ? 'demo\n'
      : e.path === '/project/.swarm/demo/board.jsonl'
        ? board
        : roster,
  }))
  let parserStatus: 'running' | 'idle' = 'running'
  on('agent.list', () => ({
    value: [
      { id: 'a1', description: '@parser', type: 'swarm:worker', status: parserStatus },
      { id: 'a2', description: '@verifier', type: 'swarm:verifier', status: 'completed' },
    ] as never,
  }))
  const clock = mock.clock(on)
  const findSvg = async (ui: Pick<Awaited<ReturnType<typeof $.ui.mount>>, 'findAll'>, alt: RegExp) =>
    (await ui.findAll({ type: 'Svg' })).find(element => alt.test(String(element.props.alt)))

  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await clock.advance(2000) // one poll

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect((await ui.find({ type: 'Text', text: /Demo swarm/ }))?.text).toBe('Demo swarm')
    expect(await ui.find({ type: 'Text', text: /1 working · 1 waiting · 3 posts/ })).toBeDefined()
    // the half-written fourth line is left for the next poll
    expect(await ui.find({ type: 'Markdown', text: /line 4 fails/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /BRIEF/ })).toBeDefined()
    await ui.press({ key: 'collapse-history' })
    expect(await ui.find({ type: 'Markdown', text: /line 4 fails/ })).toBeDefined()
    expect(await ui.find({ type: 'Markdown', text: /Owns: date.ts/ })).toBeUndefined()
    await ui.press({ key: 'collapse-history' })
    expect(await ui.find({ type: 'Markdown', text: /Owns: date.ts/ })).toBeDefined()

    // the filter narrows the feed by sender, recipient, kind or text, and clears again
    await ui.input({ key: 'board-search', text: 'from:verifier line' })
    expect(await ui.find({ type: 'Markdown', text: /line 4 fails/ })).toBeDefined()
    expect(await ui.find({ type: 'Markdown', text: /Owns: date.ts/ })).toBeUndefined()
    await ui.input({ key: 'board-search', text: 'no such thing' })
    expect(await ui.find({ type: 'Text', text: /No posts match/ })).toBeDefined()
    await ui.press({ key: 'board-search-clear' })
    expect(await ui.find({ type: 'Markdown', text: /Owns: date.ts/ })).toBeDefined()
    // a sender's name opens that agent's own conversation
    viewed.length = 0
    await ui.press({ key: 'agent-3' })
    // the coordinator of a run this conversation does not drive is not this conversation: its posts are shown
    await ui.press({ key: 'agent-1' })
    expect(viewed).toEqual(['a2'])
    await ui.press({ key: 'board-search-clear' })

    await ui.press({ key: 'tab-members' })
    expect(await ui.find({ type: 'Text', text: /working · 1 post$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 unread/ })).toBeDefined()
    // Who it is and how it is doing share the art row. Details and actions start below that row.
    const cards = (await ui.findAll({ type: 'Box' })).filter(box => box.props.borderStyle === 'round')
    expect(cards.length).toBeGreaterThan(2)
    for (const card of cards) {
      type Row = { type: string; key?: string; props: Record<string, unknown>; text?: string; children?: Row[] }
      const [first, second] = card.children as Row[]
      expect(String(card.text).startsWith(`@${card.key}`)).toBe(true)
      if (surface === 'terminal') {
        expect(first?.type).toBe('Text')
        expect(second?.props.flexDirection).toBe('row')
      } else {
        expect(first?.props).toMatchObject({ flexDirection: 'row', alignItems: 'flex-start' })
        expect(card.props.borderColor).toMatch(/^#[\da-f]{6}$/i)
        expect(card.props.borderDimColor).toBe(false)
        const [identity, art] = first?.children ?? []
        expect(identity?.props).toMatchObject({ flexDirection: 'column', flexShrink: 1, minWidth: 0 })
        expect(identity?.children?.[0]?.type).toBe('Text')
        expect(identity?.children?.at(-1)?.props.flexDirection).toBe('row')
        expect(art?.props).toMatchObject({ flexShrink: 0 })
        if (surface === 'desktop') expect(art?.props).toMatchObject({ paddingTop: 'md', paddingRight: 'sm' })
        expect(art?.children?.[0]?.type).toBe('Svg')
        expect(art?.children?.[0]?.props).toMatchObject({ alt: `Bee for ${card.key}`, width: 48, height: 30 })
        expect(String(art?.children?.[0]?.props.source)).toContain(`class="bee-body" fill="${card.props.borderColor}"`)
      }
    }
    if (surface === 'desktop') {
      // Desktop discards SVG elements whose alt text is blank after trimming.
      expect((await ui.findAll({ type: 'Svg' })).map(svg => String(svg.props.alt ?? '').trim())).not.toContain('')
      const parserBee = async () => (await ui.find({ key: 'bee-parser' }))?.children?.[0] as { props: Record<string, unknown> } | undefined
      const wideBee = await parserBee()
      expect(String(wideBee?.props.source)).toContain('@keyframes flutter')
      await clock.advance(180)
      for (const bodyColumns of [42, 27, 20]) {
        await ui.redraw({ ...PANE.props, bodyColumns })
        const bees = (await ui.findAll({ type: 'Svg' })).filter(svg => String(svg.props.alt).startsWith('Bee for '))
        expect(bees).toHaveLength(cards.length)
        expect(bees.every(bee => bee.props.width === 48 && bee.props.height === 30)).toBe(true)
        expect((await parserBee())?.props.source).toBe(wideBee?.props.source)
        expect(await ui.find({ key: 'feed-parser' })).toBeDefined()
      }
      await ui.redraw(PANE.props)
    }
    // the removed member shows until inactive members are hidden
    expect(await ui.find({ type: 'Text', text: /Retired/ })).toBeDefined()
    await ui.press({ key: 'hide-inactive' })
    expect(await ui.find({ type: 'Text', text: /Retired/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Standing by/ })).toBeUndefined()
    expect(await ui.find({ type: 'Button', text: 'Show inactive (4)' })).toBeDefined()
    await ui.press({ key: 'hide-inactive' })

    await ui.press({ key: 'tab-graph' })
    if (surface === 'terminal') {
      // one edge each way, and the email is no mention
      expect(await ui.find({ type: 'Text', text: /1 {2}@verifier → @parser/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /@b/ })).toBeUndefined()
      await ui.press({ key: 'hide-inactive' })
      expect(await ui.find({ type: 'Text', text: /@verifier/ })).toBeUndefined()
      await ui.press({ key: 'hide-inactive' })
    } else {
      // a diagram, following the newest post; stepping back replays an earlier one
      const svg = await findSvg(ui, /^Post /)
      expect(Number(svg?.props.width)).toBeGreaterThan(580)
      expect(Number(svg?.props.height)).toBeGreaterThan(250)
      expect(String(svg?.props.source)).toContain('repeatCount="indefinite"')
      expect(String(svg?.props.source)).toContain('dur="3.6s"')
      expect(String(svg?.props.source)).not.toContain('pattern')
      expect(String(svg?.props.source)).not.toContain('class="surface"')
      expect(String(svg?.props.source)).toContain('parser · working')
      expect(await ui.find({ type: 'Markdown', text: /Details for the next pass/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^Live$/ })).toBeDefined()
      const badge = await findSvg(ui, /^Live activity$/)
      expect(String(badge?.props.source)).toContain('@keyframes breath')
      expect(String(badge?.props.source)).toContain('animation:breath 4s')
      expect(String(badge?.props.source)).toContain('prefers-reduced-motion')
      expect(await ui.find({ type: 'Button', text: 'Go live' })).toBeUndefined()
      await ui.press({ key: 'hide-inactive' })
      const focusedGraph = String((await findSvg(ui, /^Post 3 · @verifier to @parser\./))?.props.source)
      expect(focusedGraph).toContain('verifier · waiting')
      expect(focusedGraph).not.toContain('old · killed')
      expect(focusedGraph).not.toContain('later · not started')
      expect(await ui.find({ type: 'Button', text: 'Show inactive (2)' })).toBeDefined()
      await ui.press({ key: 'hide-inactive' })
      await ui.press({ key: 'replay-back' })
      expect(await findSvg(ui, /^Live activity$/)).toBeUndefined()
      expect(await ui.find({ type: 'Button', text: 'Go live' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Post 2 of 3/ })).toBeDefined()
      expect(await ui.find({ type: 'Markdown', text: /date\.ts is ready/ })).toBeDefined()
      const replaySource = String((await findSvg(ui, /^Post /))?.props.source)
      expect(replaySource).not.toContain('later')
      expect(replaySource).not.toContain('parser · working')
      expect(replaySource).not.toContain('animateMotion')

      await ui.press({ key: 'replay-play' })
      const animated = String((await findSvg(ui, /^Post /))?.props.source)
      expect(animated).toContain('animateMotion')
      expect(animated).toContain('prefers-reduced-motion')
      expect(animated).toContain('reduced-route')
      expect(animated).toContain('packet-halo')
      expect(animated).not.toContain('indefinite')
      await clock.advance(2600)
      expect(await ui.find({ type: 'Text', text: /Post 3 of 3/ })).toBeDefined()
      expect(String((await findSvg(ui, /^Post /))?.props.source)).toContain('repeatCount="indefinite"')

      await ui.press({ key: 'replay-play' })
      expect(await ui.find({ type: 'Text', text: /Post 1 of 3/ })).toBeDefined()
      await ui.press({ key: 'tab-members' })
      await clock.advance(2000)
      await ui.press({ key: 'tab-graph' })
      expect(await ui.find({ type: 'Text', text: /Post 1 of 3/ })).toBeDefined()
      await ui.press({ key: 'replay-live' })
      expect(await ui.find({ type: 'Text', text: /^Live$/ })).toBeDefined()
    }

    await ui.press({ key: 'tab-board' })
    await ui.unmount()
  }
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const beforeSwitch = String((await findSvg(ui, /Swarm hive/))?.props.source)
  await clock.advance(317)
  await ui.press({ key: 'tab-graph' })
  const afterSwitch = String((await findSvg(ui, /Swarm hive/))?.props.source)
  expect(afterSwitch).toBe(beforeSwitch)
  const routeBefore = String((await findSvg(ui, /^Post /))?.props.source)
  const badgeBefore = (await findSvg(ui, /^Live activity$/))?.props.source
  await ui.press({ key: 'tab-board' })
  await clock.advance(431)
  await ui.press({ key: 'tab-graph' })
  const routeAfter = String((await findSvg(ui, /^Post /))?.props.source)
  expect(routeAfter).not.toBe(routeBefore)
  expect(routeAfter).toMatch(/animateMotion begin="-[1-9][0-9]*ms"/)
  expect((await findSvg(ui, /^Live activity$/))?.props.source).not.toBe(badgeBefore)
  board = BOARD.slice(0, BOARD.lastIndexOf('\n') + 1) + JSON.stringify({
    seq: 4, agent: 'parser', to: ['later'], text: '@verifier quoted in a follow-up',
    time: '2026-11-16T14:03:23+0100',
  }) + '\n' + JSON.stringify({
    seq: 5, agent: 'later', to: ['verifier'], text: 'Checked the patch.',
    time: '2026-11-16T14:03:23+0100',
  }) + '\n'
  await clock.advance(2000 - clock.now() % 2000)
  expect(String((await findSvg(ui, /^Post /))?.props.source)).toContain('animateMotion')
  expect(await findSvg(ui, /^Post /).then(svg => svg?.props.alt)).toMatch(/^Post 4 · @parser to @later\. A mention graph of /)
  await clock.advance(1200)
  expect(await findSvg(ui, /^Post /).then(svg => svg?.props.alt)).toMatch(/^Post 5 · @later to @verifier\. A mention graph of /)
  expect(String((await findSvg(ui, /^Post /))?.props.source)).toContain('animateMotion')
  await clock.advance(370)
  await ui.press({ key: 'expand-all' })
  expect(String((await findSvg(ui, /^Post /))?.props.source)).toContain('animateMotion begin="-370ms"')
  await clock.advance(830)
  const repeating = String((await findSvg(ui, /^Post /))?.props.source)
  expect(repeating).toContain('repeatCount="indefinite"')
  expect(repeating).toContain('animateMotion begin="-1200ms"')
  await ui.press({ key: 'tab-board' })
  await ui.press({ key: 'graph-post-4' })
  expect(await findSvg(ui, /^Post /).then(svg => svg?.props.alt)).toMatch(/^Post 4 · @parser to @later\. A mention graph of /)
  parserStatus = 'idle'
  await clock.advance(2000)
  expect(await findSvg(ui, /^Post /).then(svg => svg?.props.alt)).toMatch(/^Post 4 · @parser to @later\. A mention graph of /)
  await ui.press({ key: 'replay-live' })
  expect(String((await findSvg(ui, /^Post /))?.props.source)).toContain('parser · waiting')
  await ui.press({ key: 'hide-inactive' })
  const filtered = String((await findSvg(ui, /^Post /))?.props.source)
  expect(filtered).not.toContain('parser · waiting')
  expect(filtered).toContain('verifier · waiting')
  await ui.press({ key: 'hide-inactive' })
  roster = ROSTER.replace('"title"', '"closed":true,"title"')
  await clock.advance(2000)
  expect(await ui.find({ type: 'Text', text: /^Latest post$/ })).toBeDefined()
  expect(await findSvg(ui, /^Live activity$/)).toBeUndefined()
  await ui.press({ key: 'tab-members' })
  // a closed run lists who was there at the close and what each last reported, never as standing by
  expect(await ui.find({ type: 'Text', text: /^closed · 2 posts$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^At close · 4$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Standing by/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^No outcome recorded$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Retired · 1$/ })).toBeDefined()
  await ui.unmount()
})

test('with no swarm the pane says how to start one', async $ => {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await ui.find({ type: 'Text', text: /No swarm in this project/ })).toBeDefined()
  await ui.unmount()
})

test('the owning conversation retries failed wakes, acknowledges only the delivered sequence, and reports a stall once', async ($, on) => {
  const RUN = '/project/.swarm/demo-20261116-101010'
  const token = 'a'.repeat(32)
  const sends: string[] = []
  const marks: string[] = []
  const prompts: string[] = []
  let roster = JSON.parse(ROSTER)
  let restore = ''
  const clock = mock.clock(on)
  on('command.register', () => ({ value: { command: 'swarm-board' } }))
  on('tool.register', (_, spec) => ({ value: { tool: `mcp__swarm__${spec.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'fixture-conversation' }))
  on('session.cwd', () => ({ value: '/project' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', (_, e) => ({
    value: e.path === `${RUN}/board.jsonl` ? BOARD : e.path === `${RUN}/members.json` ? JSON.stringify(roster) : '',
  }))
  on('agent.list', () => ({
    value: [
      { id: 'a1', description: '@parser', type: 'swarm:worker', status: 'completed' },
      { id: 'a2', description: '@verifier', type: 'swarm:verifier', status: 'completed' },
    ] as never,
  }))
  on('tool.call', () => ({ result: {} }))
  on('turn.complete', () => ({ text: '' }))
  on('process.run', (_, e) => {
    const [, , directory, action, name, address, seq] = e.argv
    let stdout = ''
    if (action === 'restore') stdout = restore
    if (action === 'bind') restore = directory ?? ''
    if (action === 'claim') {
      const parser = roster.members.parser
      marks.push(`claim ${name} ${address} ${seq}`)
      parser.wake_claim = { seq: Number(seq), attempts: (parser.wake_claim?.attempts ?? 0) + 1, until: (clock.now() + 15000) / 1000 }
      stdout = token
    }
    if (action === 'woke') {
      marks.push(`woke ${name} ${address} ${seq}`)
      roster.members.parser.last_nudged_seq = Number(address)
      delete roster.members.parser.wake_claim
    }
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.send', (_, e) => {
    sends.push(`${e.to}: ${e.text}`)
    return sends.length === 1 ? { isDelivered: false, reason: 'temporary failure' } : { isDelivered: true }
  })
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })

  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await clock.advance(2000)
  expect(sends).toEqual([])
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${RUN}" read coordinator` })
  await clock.advance(1)
  expect(sends.length).toBe(1)
  expect(sends[0]).toContain('a1')
  expect(sends[0]).toContain(`'${RUN}' read parser`)
  expect(marks).toEqual(['claim parser a1 3'])
  await clock.advance(14000)
  expect(sends.length).toBe(1)
  await clock.advance(4000)
  expect(sends.length).toBe(2)
  expect(marks).toEqual(['claim parser a1 3', 'claim parser a1 3', `woke parser 3 ${token}`])
  // the coordinator's own tool call showed it is mid-turn: no stall is called until that turn ends
  await clock.advance(40000)
  expect(prompts).toEqual([])
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  await clock.advance(40000)
  expect(sends.length).toBe(2)
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('Every member is waiting')
  await clock.advance(40000)
  expect(prompts.length).toBe(1)
  // a pause that reaches the roster with nobody told is told once; no stall is called on a paused or closed run
  roster.paused = 'waiting for the user'
  await clock.advance(40000)
  expect(prompts.map(text => text.split('\n')[0])).toEqual(['Swarm: Run needs attention', 'Swarm: Run paused'])
  roster.closed = true
  await clock.advance(40000)
  expect(prompts.length).toBe(2)
})

test('the Swarm board and kill commands register as immediate, and the board command only opens the pane', async ($, on) => {
  on('ui.panes', () => ({ value: [] }))
  const actions: string[] = []
  const registered: [string, true | undefined][] = []
  on('tool.register', (_, spec) => ({ value: { tool: `mcp__swarm__${spec.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, spec) => {
    registered.push([spec.name, spec.immediate])

    return { value: { command: spec.name } }
  })
  on('session.cwd', () => {
    actions.push('poll')

    return { value: '/project' }
  })
  // the project has had a run: only then is the shortcut offered unasked
  on('fs.read', (_, e) => e.path === '/project/.swarm/current' ? { value: 'old-20261101-090000' } : { value: '' })
  on('fs.exists', () => ({ value: false }))
  on('prompt.submit', (_, e) => {
    actions.push('prompt')

    return { text: e.text }
  })
  on('ui.open', (_, e) => {
    actions.push(`open:${e.id}`)

    return { value: { isPlaced: true } }
  })
  mock.clock(on)

  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  const shortcut = await $.ui.mount({
    component: 'AbovePrompt', plugin: 'swarm', surface: 'desktop',
    props: { hasSurvey: false, isCollapsed: false, isWorking: true, maxRows: 3, bodyColumns: 60, scroll: { offset: 0, bodyRows: 3 }, view: {} },
  })
  // A Desktop session has a launcher before a run is bound.
  await shortcut.press({ key: 'swarm-board-shortcut' })
  expect(actions).toEqual(['open:swarm'])
  await shortcut.unmount()

  const result = await $.command.run({
    command: 'swarm-board', args: '', origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 80 },
  })

  expect(registered).toEqual([['swarm-board', true], ['swarm-kill', true]])
  expect(actions).toEqual(['open:swarm', 'open:swarm'])
  expect(result.text).toBeUndefined()
  expect(result.context).toBeUndefined()
})

test('the shortcut leads crab-buddy\'s row and Swarm\'s own row goes', async ($, on) => {
  const opened: string[] = []
  on('ui.open', (_, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  type Tree = { props?: { key?: string }; children?: Tree[] }
  const box = (key: string, children: unknown[] = []) => ({ type: 'Box', props: { key }, children })
  // The harness's own hooks are a plugin named `test`: it stands in for crab-buddy.
  let shown = false
  on('ui.panes', () => ({ value: shown ? [{ id: 'swarm', title: 'Swarm', isShown: true, isPlaced: true, isFocused: false }] : [] }))
  let crabRow = box('crab-band', [box('crab-fill', [box('crab-text'), box('crab-buddy')])])
  on('ui.render', { component: 'AbovePrompt', plugin: 'test' }, () => crabRow as never)
  const props = { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 3, bodyColumns: 80, scroll: { offset: 0, bodyRows: 3 }, view: {} }
  const keys = (tree: Tree): string[] => [...(tree.props?.key ? [tree.props.key] : []), ...(tree.children ?? []).flatMap(keys)]

  // the project has had a run: only then is the shortcut offered unasked
  on('fs.read', (_, e) => e.path === '/project/.swarm/current' ? { value: 'old-20261101-090000' } : { value: '' })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.register', (_, spec) => ({ value: { tool: `mcp__swarm__${spec.name}` } }))
  on('command.register', (_, spec) => ({ value: { command: spec.name } }))
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ component: 'AbovePrompt', plugin: 'swarm', surface: 'desktop', props })
  // One row: the shortcut first on the crab's line, Swarm's own row left out.
  expect(keys(await band.drawn() as Tree)).toEqual(['swarm-board-shortcut', 'crab-band', 'crab-fill', 'crab-text', 'crab-buddy'])
  expect(await band.find({ type: 'Button', text: /Swarm: The Board/ })).toBeDefined()
  await band.press({ key: 'swarm-board-shortcut' })
  expect(opened).toEqual(['swarm'])
  await band.unmount()

  for (const count of [1, 2]) {
    const captions = Array.from({ length: count }, () => ({ type: 'Text', props: {}, children: ['Waiting'] }))
    crabRow = box('crab-band', [box('crab-fill', [box('crab-text', captions), box('crab-buddy')])])
    const layout = await $.ui.mount({ component: 'AbovePrompt', plugin: 'swarm', surface: 'desktop', props })
    const first = (await layout.drawn() as { children?: { props?: { paddingTop?: number } }[] }).children?.[0]
    expect(first?.props?.paddingTop).toBe(count === 1 ? 3 : 2)
    await layout.unmount()
  }
  shown = true
  const visible = await $.ui.mount({ component: 'AbovePrompt', plugin: 'swarm', surface: 'desktop', props })
  expect(keys(await visible.drawn() as Tree)).toEqual(['crab-band', 'crab-fill', 'crab-text', 'crab-buddy'])
  await visible.unmount()
  shown = false

  // A row without crab-buddy's line passes untouched and Swarm keeps its own row.
  crabRow = box('other-band', [box('other-text')])
  const plain = await $.ui.mount({ component: 'AbovePrompt', plugin: 'swarm', surface: 'desktop', props })
  expect(keys(await plain.drawn() as Tree).sort()).toEqual(['other-band', 'other-text', 'swarm-board-shortcut'])
  await plain.unmount()
})

test('/clear keeps the poller alive, an exit stops it, and a start that cannot be checked is refused', async ($, on) => {
  let polls = 0
  let isBroken = false
  on('command.register', (_, spec) => ({ value: { command: spec.name } }))
  on('tool.register', (_, spec) => ({ value: { tool: `mcp__swarm__${spec.name}` } }))
  on('session.start', (_, event) => ({ cwd: event.cwd }))
  on('session.end', (_, event) => ({ sessionId: event.sessionId }))
  on('session.id', () => ({ value: 'fixture-conversation' }))
  on('session.cwd', () => ({ value: '/project' }))
  let restores = 0
  on('process.run', (_, event) => {
    if (event.argv.includes('restore')) restores++

    return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.exists', () => {
    polls++

    return { value: false }
  })
  on('agent.list', () => {
    if (isBroken) throw new Error('agent list unavailable')

    return { value: [] }
  })
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'started' }))
  const clock = mock.clock(on)

  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  // with no run of its own and no pane up, a session looks for nobody's run
  await clock.advance(2000)
  expect(polls).toBe(0)
  await $.ui.mount({ ...PANE, surface: 'desktop' })
  await clock.advance(2000)
  expect(polls).toBeGreaterThan(0)

  // No session.start follows a /clear, so the poller must survive it.
  await $.session.end({ reason: 'clear', sessionId: 'fixture-conversation', resume: { id: 'fixture-conversation' } })
  polls = 0
  await clock.advance(4000)
  expect(polls).toBeGreaterThan(0)
  // A resume goes on in the same process too: its first poll looks up the run the new session saved, once.
  restores = 0
  await $.session.end({ reason: 'resume', sessionId: 'fixture-conversation', resume: { id: 'fixture-conversation' } })
  await clock.advance(6000)
  expect(restores).toBe(1)

  // The gate fails closed: a Swarm member is not started when its check throws; another agent type is untouched.
  isBroken = true
  const spawn = {
    tool_use_id: 'fixture', prompt: 'Use the board.', provider: { plugin: 'swarm', tier: 'core' as const },
    parentModel: 'sonnet', background: true, fork: false,
    resume: { agentId: 'gone' },
  }
  expect((await $.agent.spawn({ ...spawn, description: '@parser: date.ts', subagentType: 'swarm:worker' })).deny).toContain('could not check this start')
  expect((await $.agent.spawn({ ...spawn, description: 'explore', subagentType: 'Explore' })).agentId).toBe('started')

  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'fixture-conversation', resume: { id: 'fixture-conversation' } })
  polls = 0
  await clock.advance(4000)
  expect(polls).toBe(0)
})

test('a board too large to read is tailed, and control characters never reach the pane', async ($, on) => {
  const post = { seq: 1, agent: 'parser', to: ['coordinator'], time: '2026-11-16T14:03:22+0100',
    text: `@coordinator all \u001b[31mred\u001b[0m tests\u0007 pass\r\nsecond line\n${`${'word '.repeat(4000)}\n`.repeat(4)}` }
  let tails = 0
  on('command.register', () => ({ value: { command: 'swarm-board' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.register', (_, spec) => ({ value: { tool: `mcp__swarm__${spec.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/project' }))
  on('session.id', () => ({ value: 'fixture-conversation' }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', (_, e) => {
    if (e.path.endsWith('/board.jsonl')) throw new Error('over 4 MiB')

    return { value: e.path.endsWith('/current') ? 'demo\n' : ROSTER }
  })
  on('process.run', (_, e) => {
    const isTail = e.argv.includes('tail')
    if (isTail) tails++

    return { value: { exitCode: isTail ? 0 : 1, stdout: isTail ? `${JSON.stringify(post)}\n` : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('agent.list', () => ({ value: [] }))
  const clock = mock.clock(on)

  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await clock.advance(2000)
  // another conversation's run is read once someone looks at the pane, not before
  expect(tails).toBe(0)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await clock.advance(0)
  expect(tails).toBeGreaterThan(0)
  // The post drew: the escape codes, the bell and the carriage return are gone, the words are not.
  expect(await ui.find({ type: 'Markdown', text: /all red tests pass/ })).toBeDefined()
  expect(JSON.stringify(await ui.drawn())).not.toMatch(/\\u001b|\\u0007|\\r/)
  // An 80,000-character post opens cut, inside the size a drawing may have.
  await ui.press({ key: 'more-1' })
  expect(await ui.find({ type: 'Markdown', text: /more characters/ })).toBeDefined()
  expect(await ui.find({ type: 'Markdown', text: /all red tests pass/ })).toBeDefined()
  expect(JSON.stringify(await ui.drawn()).length).toBeLessThan(100_000)
  await ui.unmount()
})

test('an unnamed Swarm agent is refused while the project has an open run, and a teammate keeps its address after it ends', async ($, on) => {
  const run = '/project/.swarm/demo-20261116-101010'
  let roster = ROSTER
  let agents: { id: string; teammateId: string; description: string; type: string; status: 'running' }[] =
    [{ id: 'a9', teammateId: 'art@team', description: '@art: icons', type: 'swarm:designer', status: 'running' }]
  const rearms: string[][] = []
  const starts: string[][] = []
  on('command.register', () => ({ value: { command: 'swarm-board' } }))
  on('tool.register', (_, spec) => ({ value: { tool: `mcp__swarm__${spec.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/project' }))
  on('session.id', () => ({ value: 'fixture-conversation' }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', (_, e) => ({ value: e.path.endsWith('/current') ? 'demo\n' : e.path.endsWith('.jsonl') ? '' : roster }))
  on('process.run', (_, e) => {
    if (e.argv.includes('rearm')) rearms.push(e.argv.slice(e.argv.indexOf('rearm') + 1))
    if (e.argv.includes('started')) starts.push(e.argv.slice(e.argv.indexOf('started') + 1))
    const isLookup = e.argv.includes('agent-run')

    return { value: { exitCode: isLookup || e.argv.includes('rearm') ? 0 : 1, stdout: isLookup ? run : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('agent.list', () => ({ value: agents as never }))
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'started' }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  mock.clock(on)

  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  const spawn = {
    tool_use_id: 'fixture', prompt: 'Help out.', description: 'help with the parser', subagentType: 'swarm:worker',
    provider: { plugin: 'swarm', tier: 'core' as const }, parentModel: 'sonnet', background: true, fork: false,
  }
  expect((await $.agent.spawn(spawn)).deny).toContain('open Swarm run')
  // A resumed agent is recorded as an unrecorded member only when it is the type the roster gives that member.
  const resume = { ...spawn, description: '@later: second pass' }
  await $.agent.spawn({ ...resume, resume: { agentId: 'a9' } })  // a designer, and @later is a worker
  expect(starts).toEqual([])
  agents = [...agents, { id: 'w1', teammateId: 'later@team', description: '@later: second pass', type: 'swarm:worker', status: 'running' as const }]
  await $.agent.spawn({ ...resume, resume: { agentId: 'w1' } })
  expect(starts.map(args => args[0])).toEqual(['later'])
  agents = agents.slice(0, 1)
  roster = JSON.stringify({ ...JSON.parse(ROSTER), closed: true })
  // a closed run starts no swarm: agent that is none of its members
  expect((await $.agent.spawn(spawn)).deny).toContain('swarm: agents run only inside a Swarm run the user started with /swarm:swarm')
  // a refused resume whose description names nobody still reads as a sentence
  const refused = (await $.agent.spawn({ ...spawn, resume: { agentId: 'a9' } })).deny
  expect(refused).toContain('is closed, so this member is not started')

  const turn = { agentId: 'a9', turnId: 't1', durationMs: 1200, reason: 'answer' as const, answer: 'done' }
  await $.turn.complete(turn as never)
  agents = []  // the teammate ended and left the list before its last turn completed
  await $.turn.complete({ ...turn, turnId: 't2' } as never)
  expect(rearms.map(args => args.slice(1))).toEqual([['a9', 'art@team'], ['a9', 'art@team']])
})

test('only Swarm-origin notices get the Swarm transcript label', async $ => {
  const text = 'Swarm: Delivering board mentions\nRun: Demo swarm'
  const notice = await $.ui.mount({
    plugin: 'swarm', surface: 'desktop', component: 'UserMessage',
    props: { text, origin: { kind: 'plugin', name: 'swarm' }, isExpanded: true },
  })
  expect(await notice.find({ type: 'Text', text: /Swarm · Delivering board mentions/ })).toBeDefined()
  expect(await notice.find({ type: 'Text', text: 'Run: Demo swarm' })).toBeDefined()
  await notice.unmount()

  const typed = await $.ui.mount({
    plugin: 'swarm', surface: 'desktop', component: 'UserMessage',
    props: { text, origin: { kind: 'composer' }, isExpanded: true },
  })
  expect(await typed.find({ type: 'Text', text: /Swarm · Delivering board mentions/ })).toBeUndefined()
  await typed.unmount()
})

test('a restored run enforces the chosen backend for new workers', async ($, on) => {
  const run = '/project/.swarm/demo-20261116-101010'
  let backend = 'subagents'
  on('command.register', (_, spec) => ({ value: { command: spec.name } }))
  on('tool.register', (_, spec) => ({ value: { tool: `mcp__swarm__${spec.name}` } }))
  on('session.start', (_, event) => ({ cwd: event.cwd }))
  on('session.id', () => ({ value: 'fixture-conversation' }))
  on('process.run', (_, event) => ({
    value: {
      exitCode: 0, stdout: event.argv.includes('restore') ? run : '', stderr: '',
      isStdoutTruncated: false, isStderrTruncated: false,
    },
  }))
  on('fs.read', (_, event) => ({
    value: event.path === `${run}/members.json` ? JSON.stringify({ members: {
      coordinator: { backend }, parser: {},
      explorer: { profile: 'explorer' }, investigator: { profile: 'investigator' }, architect: { profile: 'architect' },
    } }) : '',
  }))
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'started' }))
  mock.clock(on)

  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  const spawn = {
    tool_use_id: 'fixture',
    prompt: 'Use the board.',
    description: '@parser: read the brief',
    subagentType: 'swarm:worker',
    provider: { plugin: 'swarm', tier: 'core' as const },
    parentModel: 'sonnet',
    background: true,
    fork: false,
  }
  expect((await $.agent.spawn({ ...spawn, isTeammate: true })).deny).toContain('Omit name')
  expect((await $.agent.spawn(spawn)).agentId).toBe('started')
  backend = 'native'
  expect((await $.agent.spawn(spawn)).deny).toContain('native Agent Teams')
  expect((await $.agent.spawn({ ...spawn, isTeammate: true })).agentId).toBe('started')
  for (const profile of ['explorer', 'investigator', 'architect']) {
    const specialist = { ...spawn, description: `@${profile}: read the brief`, subagentType: `swarm:${profile}` }
    expect((await $.agent.spawn(specialist)).deny).toContain('native Agent Teams')
    expect((await $.agent.spawn({ ...specialist, isTeammate: true })).agentId).toBe('started')
  }
})


test('a read-only specialist can report to the board under its own assignment', async ($, on) => {
  const directory = '/project/.swarm/demo-20261116-101010'
  const agents = [
    { id: 'scout-address', description: '@scout: Locate parser', type: 'swarm:explorer', status: 'running' as const },
    { id: 'other-address', description: '@other: Review layout', type: 'swarm:architect', status: 'running' as const },
  ]
  const members = {
    scout: { profile: 'explorer', role: 'worker', writes: '0', last_read_seq: 0 },
    other: { profile: 'architect', role: 'worker', writes: '0', id: 'other-address', last_read_seq: 0, killed: '1' },
  }
  const processed: { args: readonly string[]; stdin?: string }[] = []
  on('command.register', (_, spec) => ({ value: { command: spec.name } }))
  on('tool.register', (_, spec) => ({ value: { tool: `mcp__swarm__${spec.name}` } }))
  on('session.start', (_, event) => ({ cwd: event.cwd }))
  let isTooLong = false
  on('session.id', () => ({ value: 'fixture-conversation' }))
  on('fs.read', () => ({ value: JSON.stringify({ members }) }))
  on('agent.list', () => ({ value: agents as never }))
  on('tool.call', () => ({ deny: 'unexpected call' }))
  on('process.run', (_, event) => {
    const args = event.argv.slice(2)
    const restored = args.includes('restore')
    if (!restored) processed.push({ args, stdin: event.init?.stdin })
    if (isTooLong && args.includes('show')) {
      const stdout = Array.from({ length: 2000 }, (_, i) => `#${i + 1} @parser ${'x'.repeat(40)}`).join('\n')
      return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (isTooLong && args.includes('read')) {
      return { value: { exitCode: 0, stdout: '* #3 @parser long\n  [cut to fit the page. The whole post: show --post=3]\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return {
      value: { exitCode: 0, stdout: restored ? directory : 'ok', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  const call = { tool: 'mcp__swarm__board' as const, agentId: 'scout-address' }
  expect((await toolCall($, { ...call, action: 'read' })).deny).toBeUndefined()
  // The board cuts a post longer than a page; how to open it whole is said in the tool's words, not the shell's.
  isTooLong = true
  const paged = await toolCall($, { ...call, action: 'read' })
  expect(String(paged.result)).toContain('[cut to fit the page. The whole post: action "show" with seq 3]')
  // `show` is cut to a page too, keeping the newest posts whole
  const history = String((await toolCall($, { ...call, action: 'show' })).result)
  expect(history.length).toBeLessThan(48200)
  expect(history).toMatch(/^Earlier posts are left out/)
  expect(history).toMatch(/\n#2000 @parser x+$/)
  expect(history.split('\n')[1]).toMatch(/^#\d+ @parser/)
  isTooLong = false
  // A member filter is taken as a member would write the name.
  expect((await toolCall($, { ...call, action: 'show', member: '@Scout' })).deny).toBeUndefined()
  expect(processed.at(-1)?.args.slice(-2)).toEqual(['show', 'scout'])
  processed.length = 1  // the assertions below count the calls from the first read on
  expect((await toolCall($, { ...call, action: 'ready', text: 'Parser is in src/parser.ts.' })).deny).toBeUndefined()
  expect((await toolCall($, { ...call, action: 'post', member: 'other', text: 'Spoofed' })).deny).toBeDefined()
  expect((await toolCall($, { ...call, action: 'post', agentId: 'other-address', text: 'Retired' })).deny).toBeDefined()
  expect(processed).toEqual([
    { args: [directory, 'read', 'scout', '--max-bytes=48000'] },
    { args: [directory, 'ready', 'scout'], stdin: 'Parser is in src/parser.ts.' },
  ])
})

test('attention items open their post, members say what they wait for, and a spent budget pauses the run', async ($, on) => {
  const RUN = '/project/.swarm/demo-20261116-101010'
  const runs: string[] = []
  const prompts: string[] = []
  const clock = mock.clock(on)
  const state = {
    ...(JSON.parse(ROSTER) as { title: string; members: Record<string, unknown> }),
    limits: { budget: '1000' },
    usage: { tokens: {} as Record<string, number>, turns: new Set<string>() },
    paused: undefined as string | undefined,
  }
  const report = {
    items: [
      { kind: 'question', member: 'parser', seq: 3, text: '@parser has not answered @verifier' },
      { kind: 'unreachable', member: 'parser', seq: 3, text: '@parser could not be woken after 3 attempts. Retry it or replace it' },
    ],
    members: {
      parser: { type: 'worker', model: 'sonnet', effort: 'medium', depends: [], owns: 'date.ts', ready: false, blocked_on: [], asked: 0, unreachable: true },
      verifier: { type: 'verifier', model: 'opus', effort: 'high', depends: [], owns: '', ready: false, blocked_on: [], asked: 3, unreachable: false },
      later: { type: 'worker', model: 'sonnet', effort: 'medium', depends: ['parser'], owns: '', ready: false, blocked_on: ['parser'], asked: 0, unreachable: false },
      old: { type: 'worker', model: 'sonnet', effort: 'medium', depends: [], owns: '', ready: false, blocked_on: [], asked: 0, unreachable: false },
    },
    limits: { budget: '1000' },
  }
  on('command.register', () => ({ value: { command: 'swarm-board' } }))
  on('tool.register', (_, spec) => ({ value: { tool: `mcp__swarm__${spec.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'fixture-conversation' }))
  on('session.cwd', () => ({ value: '/project' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', (_, e) => ({
    value: e.path === `${RUN}/board.jsonl` ? BOARD : e.path === `${RUN}/members.json` ? JSON.stringify(state) : '',
  }))
  on('agent.list', () => ({
    value: [
      { id: 'a1', description: '@parser', type: 'swarm:worker', status: 'completed' },
      { id: 'a2', description: '@verifier', type: 'swarm:verifier', status: 'completed' },
    ] as never,
  }))
  on('tool.call', () => ({ result: {} }))
  on('session.send', () => ({ isDelivered: true }))
  on('turn.complete', () => ({ text: '' }))
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'started' }))
  on('process.run', (_, e) => {
    const action = e.argv[3] ?? ''
    runs.push(e.argv.slice(3).join(' '))
    let stdout = action === 'attention' ? JSON.stringify(report) : ''
    if (action === 'account') {
      const [turn, actor, count] = e.argv.slice(4)
      if (turn && actor && !state.usage.turns.has(turn)) {
        state.usage.turns.add(turn)
        state.usage.tokens[actor] = (state.usage.tokens[actor] ?? 0) + Number(count)
      }
      const total = Object.values(state.usage.tokens).reduce((sum, value) => sum + value, 0)
      const paused = !state.paused && total >= 1000
      if (paused) state.paused = 'budget spent'
      stdout = JSON.stringify({ title: state.title, total, budget: 1000, paused })
    }

    return {
      value: {
        exitCode: 0,
        stdout,
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)

    return { text: e.text }
  })

  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${RUN}" read coordinator` })
  await clock.advance(2000)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // the tab carries the count, and each item names what happened
  await ui.press({ key: 'tab-attention' })
  expect(await ui.find({ type: 'Text', text: /QUESTION/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /could not be woken/ })).toBeDefined()
  // an item leads to its post, shown in full on the board, whatever filter the board was left with
  await ui.press({ key: 'tab-board' })
  await ui.input({ key: 'board-search', text: 'no such thing' })
  expect(await ui.find({ type: 'Text', text: /No posts match/ })).toBeDefined()
  await ui.press({ key: 'tab-attention' })
  await ui.press({ key: 'attention-open-question-parser-3' })
  expect(await ui.find({ type: 'Markdown', text: /Details for the next pass/ })).toBeDefined()
  // the coordinator is asked to recover an unreachable member with its brief and history
  await ui.press({ key: 'tab-attention' })
  await ui.press({ key: 'attention-recover-unreachable-parser-3' })
  expect(prompts.at(-1)).toContain('replace command')

  // members: the plan (type, model, effort, ownership, order) and what each one waits for
  await ui.press({ key: 'tab-members' })
  expect(await ui.find({ type: 'Text', text: /cannot be woken/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /waiting for an answer to #3/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /waiting for @parser/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /owns date\.ts/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /sonnet medium/ })).toBeDefined()

  // tokens are counted per agent, cache reads at the tenth they are billed at; the budget pauses the run once
  const turn = { answer: '', durationMs: 1, isAborted: false, turnId: 't', agentId: 'a1', reason: 'answer' } as const
  const spend = (turnId: string) =>
    $.turn.complete({ ...turn, turnId, usage: { model: 'm', input_tokens: 477, output_tokens: 100, cache_creation_input_tokens: 23, cache_read_input_tokens: 1004 } })
  // an agent of this conversation that is no member of the run spends none of its budget
  await $.turn.complete({ ...turn, agentId: 'outsider', turnId: 'elsewhere', usage: { model: 'm', input_tokens: 5000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } })
  expect(runs.filter(run => run.startsWith('account'))).toEqual([])
  expect(state.paused).toBeUndefined()
  await spend('first')
  await clock.advance(1)
  expect(state.paused).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /700 of 1k tokens/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /700 tokens/ })).toBeDefined()
  await spend('second')
  await spend('second')
  expect(Object.values(state.usage.tokens)).toEqual([1400])
  // an end reported twice reaches the board once: the hook charges nothing the second time
  expect(runs.filter(run => run.startsWith('account')).length).toBe(2)
  expect(prompts.filter(text => text.includes('reached its budget')).length).toBe(1)
  // members mid-turn finish; nobody new is started on a spent budget
  const started = await $.agent.spawn({
    tool_use_id: 'fixture', prompt: 'Use the board.', description: '@later: next piece', subagentType: 'swarm:worker',
    provider: { plugin: 'swarm', tier: 'core' as const }, parentModel: 'sonnet', background: true, fork: false,
  })
  expect(started.deny).toContain('token budget')
  await ui.unmount()
})

test('a member starts only on the model the roster and the limits allow', async ($, on) => {
  const run = '/project/.swarm/demo-20261116-101010'
  const members = {
    coordinator: {},
    probe: { profile: 'investigator', model: 'sonnet' },
    design: { profile: 'architect' },
    scout: { profile: 'investigator' },
    art: { profile: 'designer' },
    parser: {},
  }
  on('command.register', (_, spec) => ({ value: { command: spec.name } }))
  on('tool.register', (_, spec) => ({ value: { tool: `mcp__swarm__${spec.name}` } }))
  on('session.start', (_, event) => ({ cwd: event.cwd }))
  on('session.id', () => ({ value: 'fixture-conversation' }))
  let closed = false
  let twins = false
  let adoptTo = ''
  let unregistered = false
  on('session.cwd', () => ({ value: '/project' }))
  const adoptions: string[][] = []
  on('process.run', (_, event) => {
    if (event.argv.includes('locate')) adoptions.push(event.argv.slice(event.argv.indexOf('locate') + 2))
    return {
      value: {
        exitCode: event.argv.includes('locate') ? (twins ? 3 : unregistered ? 4 : 0) : 0, stderr: '',
        stdout: event.argv.includes('restore') ? run : event.argv.includes('locate') ? adoptTo : '',
        isStdoutTruncated: false, isStderrTruncated: false,
      },
    }
  })
  on('fs.read', () => ({ value: JSON.stringify({ title: 'Demo', members, closed, limits: { fable: 'architect' } }) }))
  const startedOn: (string | undefined)[] = []
  on('agent.spawn', (_, e) => {
    startedOn.push(e.model)

    return { model: 'sonnet', agentId: 'started' }
  })
  mock.clock(on)

  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  const spawn = {
    tool_use_id: 'fixture',
    prompt: 'Use the board.',
    provider: { plugin: 'swarm', tier: 'core' as const },
    parentModel: 'sonnet',
    background: true,
    fork: false,
  }
  const probe = { ...spawn, description: '@probe: trace the retry bug', subagentType: 'swarm:investigator' }
  // the roster says sonnet; omitting model auto-injects the roster model instead of denying, while an explicit wrong model is denied
  expect((await $.agent.spawn({ ...probe, model: 'opus' })).deny).toContain('model: "sonnet"')
  expect((await $.agent.spawn(probe)).agentId).toBe('started')
  // a family name on the roster or call starts the newest model of that family
  expect(startedOn).toEqual(['claude-sonnet-5-5'])
  // fable is reserved for the architect
  expect((await $.agent.spawn({ ...spawn, description: '@design: storage plan', subagentType: 'swarm:architect' })).agentId).toBe('started')
  const parser = { ...spawn, description: '@parser: date.ts', subagentType: 'swarm:worker' }
  expect((await $.agent.spawn({ ...parser, model: 'claude-fable-5-2' })).deny).toContain('only for: architect')
  expect((await $.agent.spawn(parser)).agentId).toBe('started')
  // a model named only on the Agent call does not override the type's default the plan showed
  const scout = { ...spawn, description: '@scout: second trace', subagentType: 'swarm:investigator' }
  expect((await $.agent.spawn({ ...scout, model: 'sonnet' })).deny).toContain('model: "opus"')
  expect((await $.agent.spawn(scout)).agentId).toBe('started')
  // a designer starts as its own type on its default model, and not as a plain worker
  const art = { ...spawn, description: '@art: icon set', subagentType: 'swarm:designer' }
  expect((await $.agent.spawn({ ...art, subagentType: 'swarm:worker' })).deny).toContain('subagent_type "swarm:designer"')
  expect((await $.agent.spawn({ ...art, model: 'sonnet' })).deny).toContain('model: "opus"')
  expect((await $.agent.spawn(art)).agentId).toBe('started')
  // a call that names no model starts the newest model of the type's family
  expect(startedOn.at(-1)).toBe('claude-opus-5-5')
  // a member the roster does not know would start outside the limits
  expect((await $.agent.spawn({ ...parser, description: '@ghost: anything' })).deny).toContain('Register the member')
  expect((await $.agent.spawn({ ...parser, description: 'no name' })).deny).toContain('Register the member')
  // the roster decides the type: an architect's name does not start an investigator
  const disguised = await $.agent.spawn({ ...spawn, description: '@design: storage plan', subagentType: 'swarm:investigator', model: 'claude-fable-5-2' })
  expect(disguised.deny).toContain('subagent_type "swarm:architect"')
  // two unowned runs with the name: the board will not guess, and the run folders in the prompt are its hint
  twins = true
  const ghost = { ...parser, description: '@ghost: anything', prompt: 'Board: python3 b.py /project/.swarm/other-20261117-090000 read ghost' }
  expect((await $.agent.spawn(ghost)).deny).toContain('More than one open Swarm run')
  expect(adoptions.at(-1)).toEqual(['ghost', 'other-20261117-090000'])
  twins = false
  // a reused name: the conversation owns a run with @parser, and the prompt names another run's folder
  const before = adoptions.length
  expect((await $.agent.spawn({ ...parser, prompt: `Board: python3 b.py ${run} read parser` })).agentId).toBe('started')
  expect(adoptions.length).toBe(before)  // its own run named: nothing to settle
  adoptTo = '/project/.swarm/other-20261117-090000'
  const moved = { ...parser, prompt: 'Board: python3 b.py /project/.swarm/other-20261117-090000 read parser' }
  expect((await $.agent.spawn(moved)).agentId).toBe('started')
  expect(adoptions.at(-1)).toEqual(['parser', 'other-20261117-090000'])
  expect((await $.agent.spawn(parser)).agentId).toBe('started')
  expect(adoptions.length).toBe(before + 1)  // the named run is now the conversation's
  adoptTo = ''
  // a named run that cannot be adopted is refused, not started under the conversation's own run
  const stray = { ...parser, prompt: 'Board: python3 b.py /project/.swarm/gone-20261117-100000 read parser' }
  expect((await $.agent.spawn(stray)).deny).toContain('cannot drive')
  twins = true
  expect((await $.agent.spawn(stray)).deny).toContain('cannot drive')
  twins = false
  // a prompt that also names the conversation's own run starts under it
  const both = { ...parser, prompt: `Board: python3 b.py /project/.swarm/other-20261117-090000 read parser. Earlier: /project/.swarm/gone-20261117-100000` }
  expect((await $.agent.spawn(both)).agentId).toBe('started')
  // a closed run starts none of its members, nor any other swarm: agent: it drives no run
  closed = true
  expect((await $.agent.spawn(parser)).deny).toContain('is closed')
  expect((await $.agent.spawn({ ...parser, description: 'no name', isTeammate: true })).deny).toContain('swarm: agents run only inside a Swarm run')
  // with the last run closed, a new run is open and unowned: a name it does not know is refused, not waved through
  unregistered = true
  expect((await $.agent.spawn({ ...parser, description: '@ghost: anything' })).deny).toContain('Register the member')
})


test('a restored run enforces its saved budget before the first pane refresh', async ($, on) => {
  const directory = '/project/.swarm/demo-20261116-101010'
  const roster = { ...JSON.parse(ROSTER), limits: { budget: '1000' }, usage: { tokens: { coordinator: 1200 } } }
  on('command.register', (_, spec) => ({ value: { command: spec.name } }))
  on('tool.register', (_, spec) => ({ value: { tool: `mcp__swarm__${spec.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'fixture-conversation' }))
  on('fs.read', () => ({ value: JSON.stringify(roster) }))
  on('process.run', (_, e) => ({
    value: { exitCode: 0, stdout: e.argv.includes('restore') ? directory : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'started' }))
  mock.clock(on)

  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  const spawn = {
    tool_use_id: 'fixture', prompt: 'Use the board.', description: '@later: next piece', subagentType: 'swarm:worker',
    provider: { plugin: 'swarm', tier: 'core' as const }, parentModel: 'sonnet', background: true, fork: false,
  }
  expect((await $.agent.spawn(spawn)).deny).toContain('token budget')
  roster.limits.budget = '1500'
  expect((await $.agent.spawn(spawn)).agentId).toBe('started')
})


test('starting a registered member binds the run, however the board commands were typed', async ($, on) => {
  on('ui.panes', () => ({ value: [] }))
  const run = '/project/.swarm/demo-20261116-101010'
  const adopted: string[] = []
  const placed: string[] = []
  const opened: string[] = []
  const submitted: string[] = []
  const aborted: string[] = []
  on('command.register', (_, spec) => ({ value: { command: spec.name } }))
  on('tool.register', (_, spec) => ({ value: { tool: `mcp__swarm__${spec.name}` } }))
  on('session.start', (_, event) => ({ cwd: event.cwd }))
  on('session.cwd', () => ({ value: '/project' }))
  on('session.id', () => ({ value: 'fixture-conversation' }))
  on('ui.place', (_, event) => { placed.push(event.id); return { value: { isPlaced: true, requestId: event.id } } })
  on('ui.open', (_, event) => { opened.push(event.id); return { value: { isPlaced: true } } })
  on('turn.start', (_, event) => ({ turnId: event.turnId }))
  on('turn.abort', (_, event) => { aborted.push(event.turnId); return { value: undefined } })
  on('prompt.submit', (_, event) => { submitted.push(event.text); return { text: event.text } })
  on('ui.render', { component: 'AssistantMessage' }, ($, event) => {
    const { Text } = $.ui.resolve(event)
    return <Text>{event.props.text}</Text>
  })
  on('agent.list', () => ({
    value: [{ id: 'probe-address', description: '@probe: trace the bug', type: 'swarm:investigator', status: 'running' as const }] as never,
  }))
  // nothing restores, and no Bash command names the run: only `locate` finds it, by the member's name
  on('process.run', (_, event) => {
    const isAdopt = event.argv.includes('locate')
    if (isAdopt) adopted.push(event.argv.at(-1) ?? '')
    const known = isAdopt && ['parser', 'probe'].includes(event.argv.at(-1) ?? '')
    return { value: { exitCode: 0, stdout: known ? run : event.argv.includes('read') ? 'brief for probe' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.read', (_, e) => ({
    value: e.path.endsWith('/members.json')
      ? JSON.stringify({ title: 'Current run title', members: { coordinator: {}, parser: {}, probe: { role: 'worker', profile: 'investigator', writes: '0' } } })
      : '',
  }))
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'started' }))
  on('tool.call', () => ({ result: 'unused' }))
  const clock = mock.clock(on)

  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  expect(placed).toEqual([])
  const spawn = {
    tool_use_id: 'fixture', prompt: 'Use the board.', subagentType: 'swarm:worker',
    provider: { plugin: 'swarm', tier: 'core' as const }, parentModel: 'sonnet', background: true, fork: false,
  }
  // an unknown name adopts nothing, and a swarm: agent outside a run is not started; a registered one binds the run
  expect((await $.agent.spawn({ ...spawn, description: '@ghost: anything' })).deny).toContain('swarm: agents run only inside a Swarm run')
  expect((await $.agent.spawn({ ...spawn, description: '@parser: date.ts' })).agentId).toBe('started')
  expect(adopted).toEqual(['ghost', 'parser'])
  // bound now: the limits apply, and the chat holds the row that opens the pane
  expect((await $.agent.spawn({ ...spawn, description: '@ghost: anything' })).deny).toContain('Register the member')
  expect(placed).toEqual(['swarm-open-demo-20261116-101010'])
  const row = await $.ui.mount({
    plugin: 'swarm', component: 'Placed', requestId: placed[0]!, surface: 'desktop',
    props: { id: placed[0]!, plugin: 'swarm' },
  })
  expect(await row.find({ type: 'Button', text: /Open Swarm board/ })).toBeDefined()
  await row.press({ key: 'open-swarm' })
  expect(opened).toEqual(['swarm', 'swarm'])  // once by the run itself when its first member started, once by the press
  const shortcut = await $.ui.mount({
    component: 'AbovePrompt', plugin: 'swarm', surface: 'desktop',
    props: { hasSurvey: false, isCollapsed: false, isWorking: true, maxRows: 3, bodyColumns: 60, scroll: { offset: 0, bodyRows: 3 }, view: {} },
  })
  await shortcut.press({ key: 'swarm-board-shortcut' })
  expect(opened).toEqual(['swarm', 'swarm', 'swarm'])
  await shortcut.unmount()

  await $.turn.start({ text: 'Continue coordinating', turnId: 'fixture-turn' })
  await clock.advance(2000)
  const reply = await $.ui.mount({
    component: 'AssistantMessage', plugin: 'swarm', surface: 'desktop',
    props: { text: 'Swarm deployed.\n\nParser is checking date.ts.', isFirstOfReply: true },
  })
  expect(await reply.find({ type: 'Text', text: /Parser is checking date\.ts/ })).toBeDefined()
  expect(await reply.find({ type: 'Text', text: /Current run title/ })).toBeUndefined()
  expect(await reply.find({ type: 'Text', text: 'Live multi-agent board & graph' })).toBeDefined()
  await reply.press({ key: 'swarm-board-from-reply' })
  expect(opened).toEqual(['swarm', 'swarm', 'swarm', 'swarm'])
  expect(submitted).toEqual([])
  expect(aborted).toEqual([])
  await reply.unmount()
  await row.unmount()
})

test('a specialist whose run was never bound adopts it on its first board call', async ($, on) => {
  const run = '/project/.swarm/demo-20261116-101010'
  let isRegistered = false
  // board.py's locate: 4 when an open run this conversation could drive does not know the name
  let locateExit = 0
  on('command.register', (_, spec) => ({ value: { command: spec.name } }))
  on('tool.register', (_, spec) => ({ value: { tool: `mcp__swarm__${spec.name}` } }))
  on('session.start', (_, event) => ({ cwd: event.cwd }))
  on('session.cwd', () => ({ value: '/project' }))
  on('session.id', () => ({ value: 'fixture-conversation' }))
  on('ui.place', (_, event) => ({ value: { isPlaced: true, requestId: event.id } }))
  on('agent.list', () => ({
    value: [{ id: 'probe-address', description: '@probe: trace the bug', type: 'swarm:investigator', status: 'running' as const }] as never,
  }))
  on('process.run', (_, event) => ({
    value: {
      exitCode: event.argv.includes('locate') ? locateExit : 0, stderr: '', isStdoutTruncated: false, isStderrTruncated: false,
      stdout: event.argv.includes('locate') ? (isRegistered ? run : '') : event.argv.includes('read') ? 'brief for probe' : '',
    },
  }))
  on('fs.read', () => ({
    value: JSON.stringify({ members: { coordinator: {}, probe: { role: 'worker', profile: 'investigator', writes: '0' } } }),
  }))
  mock.clock(on)

  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  const call = { tool: 'mcp__swarm__board' as const, tool_use_id: 'fixture', agentId: 'probe-address', action: 'read' as const }
  expect((await toolCall($, call)).deny).toContain('There is no Swarm run here')
  // a run is near, only not bound for it: the coordinator is asked to register it
  locateExit = 4
  expect((await toolCall($, call)).deny).toContain('No Swarm run is bound to the conversation that started you')
  locateExit = 0
  isRegistered = true
  expect((await toolCall($, call)).result).toBe('brief for probe')
})

test('a specialist whose run ends while its start reads the board is not started', async ($, on) => {
  const run = '/project/.swarm/demo-20261116-101010'
  let held: () => void = () => {}
  let release: () => void = () => {}
  const holding = new Promise<void>(resolve => { held = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  let spawned = 0
  on('command.register', (_, spec) => ({ value: { command: spec.name } }))
  on('tool.register', (_, spec) => ({ value: { tool: `mcp__swarm__${spec.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('session.cwd', () => ({ value: '/project' }))
  on('session.id', () => ({ value: 'fixture-conversation' }))
  on('fs.read', async (_, e) => {
    if (e.path.endsWith('/board.jsonl')) {
      held()
      await gate
      return { value: '' }
    }
    return { value: JSON.stringify({ title: 'Demo', members: { coordinator: {}, probe: { role: 'worker', profile: 'investigator', writes: '0' } } }) }
  })
  on('process.run', (_, e) => ({ value: { exitCode: e.argv[3] === 'locate' ? 4 : 0, stdout: e.argv[3] === 'restore' ? run : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('agent.list', () => ({ value: [] as never }))
  on('agent.spawn', () => {
    spawned++
    return { model: 'opus', agentId: 'probe-address' }
  })
  mock.clock(on)

  await $.session.start({ cwd: '/project', surface: null, isInteractive: false })
  const starting = $.agent.spawn({
    tool_use_id: 'first-call', prompt: 'Use the board.', description: '@probe: trace the bug', subagentType: 'swarm:investigator',
    provider: { plugin: 'swarm', tier: 'core' as const }, parentModel: 'opus', background: true, fork: false,
  })
  await holding
  // the conversation ends its run (a /clear here; a /swarm:kill or a close moves the same generation) before the read returns
  await $.session.end({ reason: 'clear', sessionId: 'fixture-conversation', resume: { id: 'fixture-conversation' } })
  release()
  expect([(await starting).deny, spawned]).toEqual([expect.stringContaining('the member was not started'), 0])
})

test('concurrent starts reserve a member once and a recorded agent is resumed rather than duplicated', async ($, on) => {
  const run = '/project/.swarm/demo-20261116-101010'
  const parser: { role: string; id?: string } = { role: 'worker' }
  let begin: () => void = () => {}
  let finish: () => void = () => {}
  const starting = new Promise<void>(resolve => { begin = resolve })
  const gate = new Promise<void>(resolve => { finish = resolve })
  const addresses: string[] = []
  on('command.register', (_, spec) => ({ value: { command: spec.name } }))
  on('tool.register', (_, spec) => ({ value: { tool: `mcp__swarm__${spec.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/project' }))
  on('session.id', () => ({ value: 'fixture-conversation' }))
  on('fs.read', () => ({ value: JSON.stringify({ title: 'Demo', members: { coordinator: {}, parser } }) }))
  on('process.run', (_, e) => {
    if (e.argv[3] === 'started' && e.argv[5]) {
      parser.id = e.argv[5]
      addresses.push(parser.id)
    }
    return { value: { exitCode: e.argv[3] === 'locate' ? 4 : 0, stdout: e.argv[3] === 'restore' ? run : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('agent.list', () => ({ value: (parser.id ? [{ id: parser.id, description: '@parser: example', type: 'swarm:worker', status: 'completed' }] : []) as never }))
  on('agent.spawn', async () => {
    begin()
    await gate
    return { model: 'sonnet', agentId: 'worker-address' }
  })
  mock.clock(on)

  await $.session.start({ cwd: '/project', surface: null, isInteractive: false })
  const spawn = {
    tool_use_id: 'first-call', prompt: 'Use the board.', description: '@parser: example', subagentType: 'swarm:worker',
    provider: { plugin: 'swarm', tier: 'core' as const }, parentModel: 'sonnet', background: true, fork: false,
  }
  const first = $.agent.spawn(spawn)
  await starting
  try {
    expect((await $.agent.spawn({ ...spawn, tool_use_id: 'second-call' })).deny).toContain('already starting')
  } finally {
    finish()
  }
  expect((await first).agentId).toBe('worker-address')
  expect(addresses).toEqual(['worker-address'])
  expect((await $.agent.spawn({ ...spawn, tool_use_id: 'third-call' })).deny).toContain('already has an agent')
  expect((await $.agent.spawn({ ...spawn, description: '@constructor: unregistered' })).deny).toContain('Register the member')
})

test('Attention opens a post outside the recent window and a missing board clears the preview', async ($, on) => {
  const run = '/project/.swarm/history'
  let current = 'history'
  const board = Array.from({ length: 302 }, (_, i) => JSON.stringify({
    seq: i + 1, text: i === 0 ? 'Original question still open?' : 'Routine update.', agent: 'worker', time: '', to: ['coordinator'],
  })).join('\n')
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, spec) => ({ value: { tool: `mcp__swarm__${spec.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/project' }))
  on('session.id', () => ({ value: 'fixture-conversation' }))
  on('agent.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: Boolean(current) }))
  const requested: string[] = []
  on('fs.read', (_, e) => {
    requested.push(e.path)
    return { value: e.path.endsWith('/current') ? current : e.path === `${run}/board.jsonl` ? board : ROSTER }
  })
  on('process.run', (_, e) => ({ value: {
    exitCode: 0, stderr: '', isStdoutTruncated: false, isStderrTruncated: false,
    stdout: e.argv[3] === 'attention' ? JSON.stringify({ items: [{ kind: 'question', member: 'coordinator', seq: 1, text: 'Open question' }], members: {} }) : '',
  } }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await clock.advance(2000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-attention' })
  await ui.press({ key: 'attention-open-question-coordinator-1' })
  expect(await ui.find({ type: 'Markdown', text: /Original question still open/ })).toBeDefined()
  // a short post the pane no longer keeps has no "Show less" to close it with: it has a button of its own
  await ui.press({ key: 'dismiss-1' })
  expect(await ui.find({ type: 'Markdown', text: /Original question still open/ })).toBeUndefined()
  expect(await ui.find({ key: 'dismiss-302' })).toBeUndefined()
  // however often earlier posts are asked for, no more are drawn than one drawing may hold
  for (let press = 0; press < 20 && await ui.find({ key: 'earlier-posts' }); press++) await ui.press({ key: 'earlier-posts' })
  expect((await ui.findAll({ type: 'Markdown' })).length).toBe(100)
  expect(await ui.find({ type: 'Text', text: /^Showing the newest 100 of 300\. Narrow the filter/ })).toBeDefined()
  expect(await ui.find({ key: 'earlier-posts' })).toBeUndefined()
  current = '../other-workspace'
  await clock.advance(2000)
  expect(await ui.find({ type: 'Text', text: /could not read the board/ })).toBeDefined()
  expect(requested.some(path => path.includes('../other-workspace'))).toBe(false)
  current = ''
  await clock.advance(2000)
  expect(await ui.find({ type: 'Text', text: /No swarm in this project/ })).toBeDefined()
  await ui.unmount()
})

test('the coordinator is told of unread mentions mid-turn and when idle, and a member turn re-arms its wake', async ($, on) => {
  const RUN = '/project/.swarm/demo-20261116-101010'
  let board = [
    { seq: 1, agent: 'coordinator', to: ['parser'], text: '@parser BRIEF\nOwns: date.ts' },
    { seq: 2, agent: 'parser', to: ['coordinator'], text: '@coordinator which file?' },
  ].map(post => JSON.stringify({ ...post, time: '2026-11-16T14:03:22+0100' })).join('\n') + '\n'
  const roster = JSON.stringify({
    title: 'Demo swarm',
    members: {
      coordinator: { role: 'coordinator', last_read_seq: 1 },
      parser: { role: 'worker', id: 'a1', last_read_seq: 1 },
    },
  })
  const prompts: string[] = []
  const commands: string[] = []
  let restore = ''
  const clock = mock.clock(on)
  on('command.register', () => ({ value: { command: 'swarm-board' } }))
  on('tool.register', (_, spec) => ({ value: { tool: `mcp__swarm__${spec.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'fixture-conversation' }))
  on('session.cwd', () => ({ value: '/project' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', (_, e) => ({
    value: e.path === `${RUN}/board.jsonl` ? board : e.path === `${RUN}/members.json` ? roster : '',
  }))
  on('agent.list', () => ({ value: [{ id: 'a1', description: '@parser', type: 'swarm:worker', status: 'running' }] as never }))
  on('tool.call', () => ({ result: {} }))
  on('turn.complete', () => ({ text: '' }))
  on('process.run', (_, e) => {
    const [, , directory, action, ...rest] = e.argv
    commands.push([action, ...rest].join(' '))
    const stdout = action === 'restore' ? restore : ''
    if (action === 'bind') restore = directory ?? ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })

  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  // the read that binds the run is itself the read: it carries no reminder
  const bound = await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${RUN}" read coordinator` })
  expect(bound.context).toBeUndefined()
  await clock.advance(2000)
  const told = await toolCall($, { tool: 'Read', file_path: '/project/a.ts' })
  expect(told.context?.join(' ')).toContain('1 board post addresses you from #2')
  expect(told.context?.join(' ')).toContain(`'${RUN}' read coordinator --attention`)
  // once per newest unread post, not on every call
  expect((await toolCall($, { tool: 'Read', file_path: '/project/a.ts' })).context).toBeUndefined()
  // mid-turn nothing is submitted; once the turn ends with the post still unread, one prompt is
  await clock.advance(20000)
  expect(prompts).toEqual([])
  board += JSON.stringify({ seq: 3, agent: 'parser', to: ['coordinator'], text: '@coordinator another question?',
    time: '2026-11-16T14:03:42+0100' }) + '\n'
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  await clock.advance(4000)
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('2 board posts address you from #2')
  await clock.advance(20000)
  expect(prompts.filter(text => text.includes('board posts address you')).length).toBe(1)
  // a member's finished turn asks the board to wake it again for anything it left unread
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'm', reason: 'answer', agentId: 'a1' })
  expect(commands).toContain('rearm 1 a1')
})

test('the hive follows roster actions, coordinator turns and sleep', async ($, on) => {
  const dir = '/project/.swarm/demo-20261116-101010'
  const clock = mock.clock(on)
  let worker: 'running' | 'idle' = 'idle'
  on('command.register', () => ({ value: { command: 'swarm-board' } }))
  on('tool.register', (_, spec) => ({ value: { tool: `mcp__swarm__${spec.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'fixture-conversation' }))
  on('session.cwd', () => ({ value: '/project' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.place', () => ({ value: { isPlaced: true, requestId: 'fixture' } }))
  on('fs.read', (_, e) => ({ value: e.path.endsWith('members.json') ? ROSTER : '' }))
  on('process.run', (_, e) => ({ value: { exitCode: 0, stdout: e.argv.includes('restore') ? dir : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('agent.list', () => ({ value: [{ id: 'a1', description: '@parser', type: 'swarm:worker', status: worker }] as never }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await clock.advance(2000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-members' })
  const check = async (mood: string, coordinating: boolean) => {
    await clock.advance(2000)
    const images = await ui.findAll({ type: 'Svg' })
    expect(images.some(el => el.props.alt === 'Swarm hive: ' + mood)).toBe(true)
    expect(images.some(el => String(el.props.source).includes('@keyframes sw-aura'))).toBe(coordinating)
  }
  await check('sleep', false)
  await $.turn.start({ text: 'Work', turnId: 'c' })
  await check('forage', true)
  await toolCall($, { tool: 'Read', file_path: '/project/a' })
  await check('inspect', true)
  worker = 'running'
  await toolCall($, { tool: 'Bash', command: 'npm test', agentId: 'a1' })
  await check('verify', true)
  await toolCall($, { tool: 'Bash', command: 'touch scratch', agentId: 'outsider' })
  await check('verify', true)
  await toolCall($, { tool: 'Write', file_path: '/project/a', content: '', agentId: 'a1' })
  await check('build', true)
  await toolCall($, { tool: 'Bash', command: 'python3 board.py run post worker', agentId: 'a1' })
  await check('relay', true)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'c', reason: 'answer' })
  await check('relay', false)
  worker = 'idle'
  await check('sleep', false)
  await ui.unmount()
})

// The engine beneath a conversation that owns RUN, as the tests below share it.
const OWNED = '/project/.swarm/demo-20261116-101010'
type On = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[1]
function owning(on: On, files: { board: () => string; roster: () => string; session?: () => string; cwd?: () => string; read?: (path: string) => string | undefined; hold?: (path: string) => Promise<void> | undefined; end?: () => Promise<void>; exists?: boolean | ((path: string) => boolean) }) {
  const seen = { commands: [] as string[], prompts: [] as string[], toasts: [] as string[], isDeaf: false, restore: '' }
  on('command.register', () => ({ value: { command: 'swarm-board' } }))
  on('tool.register', (_, spec) => ({ value: { tool: `mcp__swarm__${spec.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: files.session?.() ?? 'fixture-conversation' }))
  on('session.cwd', () => ({ value: files.cwd ? files.cwd() : '/project' }))
  on('fs.exists', (_, e) => ({ value: typeof files.exists === 'function' ? files.exists(e.path) : (files.exists ?? false) }))
  on('fs.read', async (_, e) => {
    // A read the test holds answers once it lets go, with the file as it is then.
    await files.hold?.(e.path)
    return { value: files.read?.(e.path) ?? (e.path.endsWith('/board.jsonl') ? files.board() : e.path.endsWith('/members.json') ? files.roster() : '') }
  })
  on('session.end', async (_, e) => {
    await files.end?.()
    return { sessionId: e.sessionId }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.toast', (_, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', (_, e) => {
    seen.prompts.push(e.text)
    if (seen.isDeaf) throw new Error('no prompt is taken')
    return { text: e.text }
  })
  const answer = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  const board = (e: { argv: readonly string[] }) => {
    const [, , directory, action, ...rest] = e.argv
    seen.commands.push([action, ...rest].join(' '))
    if (action === 'bind') seen.restore = directory ?? ''
    return action === 'restore' ? seen.restore : ''
  }
  return { seen, answer, board }
}
const posts = (...list: { agent: string; to: string[]; text: string }[]) =>
  list.map((post, index) => JSON.stringify({ ...post, seq: index + 1, time: '2026-11-16T14:03:22+0100' })).join('\n') + '\n'

test('specialists read posts from before their launch without a wake, and later or missed mentions still relay', async ($, on) => {
  const members = {
    coordinator: { role: 'coordinator', last_read_seq: 0 },
    storage: { role: 'worker', profile: 'investigator', writes: '0', last_read_seq: 0, id: '', status: 'pending' },
    views: { role: 'worker', profile: 'investigator', writes: '0', last_read_seq: 0, id: '', status: 'pending' },
  }
  const briefs = [
    { agent: 'coordinator', to: ['storage', 'views'], text: '@storage @views BRIEF\nCheck the shared seams.' },
    { agent: 'coordinator', to: ['storage'], text: '@storage BRIEF\nCover Storage.' },
    { agent: 'coordinator', to: ['views'], text: '@views BRIEF\nCover Views.' },
  ]
  let board = posts(...briefs)
  const { seen, answer, board: run } = owning(on, { board: () => board, roster: () => JSON.stringify({ title: 'Demo', members }) })
  seen.restore = OWNED
  on('process.run', (_, e) => {
    const result = run(e)
    const [, , , action, name, id] = e.argv
    if (action === 'started' && (name === 'storage' || name === 'views')) members[name].id = id!
    return answer(result)
  })
  on('agent.spawn', (_, e) => ({ model: e.model ?? 'opus', agentId: e.description.split(':')[0]!.slice(1) + '-agent' }))
  on('agent.list', () => ({ value: [members.storage, members.views].filter(m => m.id).map(m => ({
    id: m.id, description: '', type: 'swarm:investigator', status: m.status,
  })) as never }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  for (const name of ['storage', 'views']) {
    const start = await $.agent.spawn({
      tool_use_id: name, prompt: 'Read your brief.', description: `@${name}: inspect`, subagentType: 'swarm:investigator',
      provider: { plugin: 'swarm', tier: 'core' }, parentModel: 'opus', background: true, fork: false,
    })
    expect(start.agentId).toBe(`${name}-agent`)
  }
  members.storage.status = 'running'
  await clock.advance(2000)
  expect(seen.prompts).toHaveLength(0)

  board = posts(...briefs, { agent: 'coordinator', to: ['storage'], text: '@storage Include recovery.' })
  await clock.advance(2000)
  expect(seen.prompts).toHaveLength(1)
  expect(seen.prompts[0]).toContain(wakeMessage(4))
  expect(seen.prompts[0]).not.toContain('@views')

  members.storage.last_read_seq = 4
  members.views.status = 'idle'
  await clock.advance(12000)
  expect(seen.prompts).toHaveLength(2)
  expect(seen.prompts[1]).toContain('@views')
  expect(seen.prompts[1]).toContain(wakeMessage(3))
})

test('a task too long to hold is saved to a file, and the coordinator gets its two ends and the path', async ($, on) => {
  const { seen } = owning(on, { board: () => '', roster: () => '{}' })
  const written: Record<string, string> = {}
  const ran: string[] = []
  on('fs.write', (_, e) => {
    written[e.path] = e.text
    return { value: undefined }
  })
  on('command.run', (_, e) => {
    ran.push(e.args)
    return { text: '' }
  })
  mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  const swarm = (args: string) => $.command.run({ command: 'swarm:swarm', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 80 } })
  await swarm('fix the parser')
  expect([ran, written]).toEqual([['fix the parser'], {}])
  const long = `fix what this log shows\n${'x'.repeat(60_000)}\nand keep the parser's tests green`
  await swarm(long)
  // the tasks folder keeps itself out of git, whatever .swarm/.gitignore holds; that file is init's, not written here
  expect(written['/project/.swarm/tasks/.gitignore']).toBe('*\n')
  expect(written['/project/.swarm/.gitignore']).toBeUndefined()
  const tasks = () => Object.keys(written).filter(key => key.endsWith('.md'))
  const [path = ''] = tasks()
  expect(path).toMatch(/^\/project\/\.swarm\/tasks\/\d{14}-\d+-[0-9a-f]{8}\.md$/)
  // a second one in the same second is a second file
  await swarm(`${long} too`)
  expect(tasks().length).toBe(2)
  expect(written[path]).toBe(long)
  expect(ran[1]!.length).toBeLessThan(9_000)
  expect(ran[1]).toMatch(/^fix what this log shows\n[^]*and keep the parser's tests green$/)
  expect(ran[1]).toContain(`All of it is in ${path}`)
  expect(seen.toasts.join(' ')).toContain('60,058 characters')
})

test('a plan\'s long task is saved the same way, and a tasks/.gitignore already there is left alone', async ($, on) => {
  let ignore = '*\n'
  owning(on, { board: () => '', roster: () => '{}', exists: true, read: path => path.endsWith('/.swarm/tasks/.gitignore') ? ignore : undefined })
  const written: Record<string, string> = {}
  const ran: string[] = []
  on('fs.write', (_, e) => {
    written[e.path] = e.text
    return { value: undefined }
  })
  on('command.run', (_, e) => {
    ran.push(e.args)
    return { text: '' }
  })
  mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  const long = `plan this log\n${'x'.repeat(60_000)}\nend`
  await $.command.run({ command: 'swarm:plan', args: long, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 80 } })
  const [path = '', ...more] = Object.keys(written)
  expect([more, path]).toEqual([[], expect.stringMatching(/^\/project\/\.swarm\/tasks\/.*\.md$/)])
  expect(written[path]).toBe(long)
  expect(ran[0]).toContain(`All of it is in ${path}`)
  // one that does not ignore everything is not rewritten, and nothing is saved where git would see it: the task goes on whole
  ignore = 'node_modules\n'
  await $.command.run({ command: 'swarm:plan', args: `${long} again`, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 80 } })
  expect([Object.keys(written).length, ran[1]]).toEqual([1, `${long} again`])
})

test('where no main view can be moved the pane shows the member\'s conversation, and its posts only when that cannot be read', async ($, on) => {
  const { seen, answer, board } = owning(on, { board: () => BOARD, roster: () => ROSTER })
  on('process.run', (_, e) => answer(board(e)))
  on('tool.call', () => ({ result: {} }))
  let status = 'running'
  on('agent.list', () => ({ value: [{ id: 'a1', description: '@parser', type: 'swarm:worker', status }] as never }))
  // the desktop app draws no main view
  on('ui.view', () => ({ value: { deny: 'no main view here' } }))
  const use = (tool: string, input: Record<string, unknown> = {}, isError?: true) => ({ tool_use_id: tool, tool, input, ...(isError && { isError }) })
  let said: unknown = [
    { role: 'user', text: 'Fix the parser in date.ts\u0007', toolUses: [] },
    { role: 'assistant', text: 'Looking at it.', toolUses: [use('Grep'), use('Read')] },
    { role: 'user', text: '', toolUses: [], toolResults: [] },
    { role: 'assistant', text: '', toolUses: [use('Read'), use('Bash', { command: 'npm test' }, true)] },
    { role: 'assistant', text: 'Line 4 is fixed.', toolUses: [] },
  ]
  let reads = 0
  on('session.messages', (_, e) => {
    reads++
    expect(e.agentId).toBe('a1')
    return { value: said as never }
  })
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-members' })
  await ui.press({ key: 'view-parser' })
  expect(seen.toasts).toEqual([])
  // the prompt it started on, what it said, and each run of tool calls as one line
  expect(await ui.find({ type: 'Text', text: /^Prompt$/ })).toBeDefined()
  expect((await ui.find({ type: 'Markdown', text: /Fix the parser/ }))?.text).toBe('Fix the parser in date.ts')
  expect(await ui.find({ type: 'Markdown', text: /Looking at it/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Searched code, read 2 files, ran 1 check, 1 failed$/ })).toBeDefined()
  expect(await ui.find({ type: 'Markdown', text: /Line 4 is fixed/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Standing by|Active/ })).toBeUndefined()
  // the poller keeps it fresh with no press, and only while it is open
  said = [...(said as unknown[]), { role: 'assistant', text: 'Second pass done.', toolUses: [] }]
  await clock.advance(2000)
  expect(await ui.find({ type: 'Markdown', text: /Second pass done/ })).toBeDefined()
  // a long conversation is drawn from its newest entries, each cut short
  said = Array.from({ length: 300 }, (_, i) => ({ role: 'assistant', text: `step ${i} ${'word '.repeat(i === 299 ? 2000 : 1)}`, toolUses: [] }))
  await clock.advance(2000)
  const drawn = await ui.findAll({ type: 'Markdown' })
  expect(drawn.length).toBeLessThan(41)
  expect(String(drawn[0]?.text)).toMatch(/^step 0 /)  // what it started on stays in view
  expect(String(drawn.at(-1)?.text)).toMatch(/^step 299 /)
  expect(String(drawn.at(-1)?.text).length).toBeLessThan(1300)
  expect(await ui.find({ type: 'Button', text: /Show earlier/ })).toBeDefined()
  // an agent that has ended is read once more and then left alone, until it runs again
  status = 'completed'
  await clock.advance(2000)
  reads = 0
  await clock.advance(6000)
  expect(reads).toBe(0)
  status = 'running'
  await clock.advance(2000)
  expect(reads).toBe(1)
  // back to the cards, and nothing is read behind them
  await ui.press({ key: 'talk-back' })
  expect(await ui.find({ type: 'Text', text: /Active · \d/ })).toBeDefined()
  reads = 0
  await clock.advance(4000)
  expect(reads).toBe(0)
  // from a post's sender too
  await ui.press({ key: 'tab-board' })
  await ui.press({ key: 'agent-2' })
  expect(await ui.find({ type: 'Button', text: '‹ Members' })).toBeDefined()
  await ui.press({ key: 'tab-members' })
  expect(await ui.find({ type: 'Button', text: '‹ Members' })).toBeUndefined()
  // an empty conversation is still a conversation; one that cannot be read falls back to the posts, saying why
  said = []
  await ui.press({ key: 'view-parser' })
  expect(await ui.find({ type: 'Text', text: /Nothing said yet/ })).toBeDefined()
  await ui.press({ key: 'talk-back' })
  said = { deny: 'agent a1 has ended and the session saved no transcript for it.' }
  await ui.press({ key: 'view-parser' })
  expect(seen.toasts).toEqual(['@parser: agent a1 has ended and the session saved no transcript for it. Showing its posts instead.'])
  expect(await ui.find({ type: 'Markdown', text: /date\.ts is ready/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /^Clear filter \(3 of 3\)$/ })).toBeDefined()
  await ui.unmount()
})

test('one relay notice names every specialist with its address, an exhausted one is not relayed, and no notice is told twice', async ($, on) => {
  const quiet = { role: 'worker', writes: '0', last_read_seq: 0 }
  const roster = JSON.stringify({
    title: 'Demo swarm',
    members: {
      coordinator: { role: 'coordinator', last_read_seq: 0 },
      scout: { ...quiet, profile: 'explorer', id: 's1' },
      arch: { ...quiet, profile: 'architect', id: 'r1' },
      deep: { ...quiet, profile: 'investigator' },
      // three failed wakes for an earlier mention: a newer one does not start them again
      spent: { ...quiet, profile: 'explorer', id: 'x1', wake_claim: { seq: 1, attempts: 3, until: 0 } },
    },
  })
  let board = posts({ agent: 'scout', to: ['coordinator', 'spent'], text: '@coordinator @spent which file?' })
  const { seen, answer, board: run } = owning(on, { board: () => board, roster: () => roster })
  on('process.run', (_, e) => answer(run(e)))
  on('tool.call', () => ({ result: {} }))
  on('agent.list', () => ({ value: ['s1', 'r1', 'x1'].map(id => ({ id, description: '', type: 'swarm:explorer', status: 'idle' })) as never }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'c1', reason: 'answer' })
  await clock.advance(14000)
  expect(seen.prompts.length).toBe(1)
  expect(seen.prompts[0]).toContain('Unread board mentions')
  // a notice submitted a moment ago has not started its turn yet: the next one waits instead of landing beside it
  board += posts({ agent: 'coordinator', to: [], text: '' }).replace('"seq":1', '"seq":2').replace('"to":[]', '"to":["scout","arch","deep","spent"]')
  await clock.advance(2000)
  expect(seen.prompts.length).toBe(1)
  await clock.advance(10000)
  expect(seen.prompts.length).toBe(2)
  const relay = seen.prompts[1] ?? ''
  expect(relay).toContain('Delivering board mentions')
  expect(relay).toContain('@scout (SendMessage to "s1"): Swarm board: call the board tool with action read for mentions through #2.')
  expect(relay).toContain('@arch (SendMessage to "r1"): Swarm board: call the board tool with action read for mentions through #2.')
  expect(relay).toMatch(/@deep: owed mentions through #2, but the roster has no agent address/)
  expect(relay).not.toContain('@spent')
  expect(relay).not.toContain('BOARD wake')
  // the turn those prompts start is not told again on its first tool call
  await $.turn.start({ text: relay, turnId: 'c2' })
  expect((await toolCall($, { tool: 'Read', file_path: '/project/a.ts' })).context).toBeUndefined()
})

test('a poll during /clear does not look the next session\'s run up under the old session', async ($, on) => {
  let session = 'old-session'
  const clock = mock.clock(on)
  const { answer } = owning(on, {
    board: () => '', roster: () => ROSTER, session: () => session,
    end: async () => {
      await clock.advance(2000)  // a poll falls inside the end
      session = 'new-session'
    },
  })
  const lookups: string[] = []
  on('agent.list', () => ({ value: [] }))
  on('process.run', (_, e) => {
    if (e.argv[3] === 'restore') lookups.push(session)
    return answer('')
  })
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  lookups.length = 0
  await $.session.end({ reason: 'clear', sessionId: 'old-session', resume: { id: 'old-session' } })
  expect(lookups).toEqual([])
  await clock.advance(2000)
  expect(lookups).toEqual(['new-session'])
})

test('each model step is charged once, a spent budget stops members mid-turn and not the coordinator, and a closed run is charged nothing', async ($, on) => {
  const state = {
    title: 'Demo swarm', limits: { budget: '1000' }, closed: false, paused: undefined as string | undefined,
    usage: { tokens: {} as Record<string, number> },
    members: { coordinator: { role: 'coordinator', last_read_seq: 0 }, parser: { role: 'worker', id: 'a1', last_read_seq: 1 } },
  }
  const { seen, answer, board } = owning(on, {
    board: () => posts({ agent: 'coordinator', to: ['parser'], text: '@parser BRIEF' }, { agent: 'parser', to: ['coordinator'], text: '@coordinator which file?' }),
    roster: () => JSON.stringify(state),
  })
  const clock = mock.clock(on)
  const charged = new Set<string>()
  let isSlow = false
  on('process.run', async (_, e) => {
    const stdout = board(e)
    if (e.argv[3] !== 'account') return answer(stdout)
    const [turn = '', actor = '', count] = e.argv.slice(4)
    if (isSlow) await clock.advance(2000)  // a poll falls between the turn's end and its usage reaching the board
    if (!charged.has(turn)) state.usage.tokens[actor] = (state.usage.tokens[actor] ?? 0) + Number(count)
    charged.add(turn)
    const total = Object.values(state.usage.tokens).reduce((sum, value) => sum + value, 0)
    const paused = !state.paused && total >= 1000
    if (paused) state.paused = 'token budget of 1000 spent'
    return answer(JSON.stringify({ title: state.title, total, budget: 1000, paused }))
  })
  on('agent.list', () => ({ value: [{ id: 'a1', description: '@parser', type: 'swarm:worker', status: 'running' }] as never }))
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'started' }))
  on('tool.call', () => ({ result: {} }))
  const usage = (fresh: number, cached = 0) => ({ model: 'm', input_tokens: fresh, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: cached })
  let answered = usage(0)
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use' as const, usage: answered }
  })
  const step = async (index: number, spent: ReturnType<typeof usage>, agentId?: string) => {
    answered = spent
    for await (const _ of $.turn.step({ turnId: 'm', index, model: 'm', messageCount: 1, ...(agentId && { agentId }) })) { /* no chunks */ }
    await clock.advance(1)
  }
  const accounts = () => seen.commands.filter(command => command.startsWith('account'))
  const total = () => Object.values(state.usage.tokens).reduce((sum, value) => sum + value, 0)
  const done = { answer: '', durationMs: 1, isAborted: false, reason: 'answer' } as const

  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(14000)  // the coordinator is mid-turn, so its unread mention is not prompted

  // a step is charged as it answers, cached reads at a tenth, and never twice; the turn's end adds only what no step reported
  await step(0, usage(300, 1000), 'a1')
  expect(total()).toBe(400)
  await step(0, usage(300, 1000), 'a1')
  await $.turn.complete({ ...done, turnId: 'm', agentId: 'a1', usage: usage(300, 1000) })
  await $.turn.complete({ ...done, turnId: 'm', agentId: 'a1', usage: usage(300, 1000) })
  expect([total(), accounts().length]).toEqual([400, 1])
  await $.turn.complete({ ...done, turnId: 'm', agentId: 'a1', usage: usage(350, 1000) })
  expect([total(), accounts().length]).toEqual([450, 2])
  expect((await toolCall($, { tool: 'Read', file_path: '/project/a.ts', agentId: 'a1' })).deny).toBeUndefined()

  // the coordinator's last step crosses the budget: until that is on the board its turn is not over, so no poll
  // prompts it on the roster as it was; and a pause prompt that does not land is told to the person
  isSlow = seen.isDeaf = true
  answered = usage(600)
  for await (const _ of $.turn.step({ turnId: 'c', index: 0, model: 'm', messageCount: 1 })) { /* no chunks */ }
  await $.turn.complete({ ...done, turnId: 'c', usage: usage(600) })
  isSlow = seen.isDeaf = false
  expect(total()).toBe(1050)
  expect(seen.prompts.map(text => text.split('\n')[0])).toEqual(['Swarm: Run paused at token budget'])
  expect(seen.toasts.join(' ')).toContain('the coordinator could not be told')

  // the member's next tool call is refused, on the board tool too; the coordinator and other agents go on
  const refused = await toolCall($, { tool: 'Read', file_path: '/project/a.ts', agentId: 'a1' })
  expect(refused.deny).toMatch(/run is paused \(token budget of 1k spent\).*end your turn now/)
  expect((await toolCall($, { tool: 'mcp__swarm__board', action: 'read', agentId: 'a1' })).deny).toContain('run is paused')
  // its final report is asked for and never refused: a refused one is demanded again, each time at the member's full context
  expect(refused.deny).toContain('everything you have found so far')
  expect((await toolCall($, { tool: 'SubagentHandback', message: 'stopped at step 3', agentId: 'a1' } as unknown as ToolInput)).deny).toBeUndefined()
  // so is the board's ready action, the one call a pause leaves open: on the board a report needs no later wake to recover
  expect(refused.deny).toContain('which is taken while the run is paused')
  expect((await toolCall($, { tool: 'mcp__swarm__board', action: 'ready', text: 'found the cause in src/a.ts:3', agentId: 'a1' })).deny ?? '').not.toContain('paused')
  // a partial report goes up as a post, which marks nothing ready
  expect(refused.deny).toContain('begins "@coordinator HAND-BACK:"')
  expect((await toolCall($, { tool: 'mcp__swarm__board', action: 'post', text: '@coordinator HAND-BACK: half done', agentId: 'a1' })).deny ?? '').not.toContain('paused')
  // the same report through Bash is let through too, but only a command that is nothing else
  expect((await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" ready a "found it"`, agentId: 'a1' })).deny ?? '').not.toContain('paused')
  expect((await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" ready a "found it" && make`, agentId: 'a1' })).deny).toContain('run is paused')
  expect((await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" status` })).deny).toBeUndefined()
  expect((await toolCall($, { tool: 'Read', file_path: '/project/a.ts', agentId: 'outsider' })).deny).toBeUndefined()
  // a resume with a raised budget lets it through again
  state.paused = undefined
  state.limits.budget = '5000'
  await clock.advance(2000)
  expect((await toolCall($, { tool: 'Read', file_path: '/project/a.ts', agentId: 'a1' })).deny).toBeUndefined()

  // once the run is closed, later turns are not charged to it, its members are still refused by name, and it is no longer owned
  state.closed = true
  const before = accounts().length
  await $.turn.complete({ ...done, turnId: 'after', usage: usage(500) })
  await step(0, usage(500))
  expect(accounts().length).toBe(before)
  const again = await $.agent.spawn({
    tool_use_id: 'fixture', prompt: 'Use the board.', description: '@parser: once more', subagentType: 'swarm:worker',
    provider: { plugin: 'swarm', tier: 'core' as const }, parentModel: 'sonnet', background: true, fork: false,
  })
  expect(again.deny).toContain('is closed')
  const binds = () => seen.commands.filter(command => command.startsWith('bind')).length
  expect(binds()).toBe(1)
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  expect(binds()).toBe(2)
})

// A run at 95 tokens of a budget of 100 whose board refuses `account` while `isFailing` is set: each attempt's report
// key is kept, so a retry can be checked against the attempt it repeats.
async function nearBudget($: Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0], on: On) {
  const state = {
    title: 'Demo swarm', limits: { budget: '100' }, closed: false, paused: undefined as string | undefined,
    usage: { tokens: { coordinator: 95 } as Record<string, number> },
    members: { coordinator: { role: 'coordinator', last_read_seq: 0 } },
  }
  const { seen, answer, board } = owning(on, { board: () => posts({ agent: 'coordinator', to: [], text: 'started' }), roster: () => JSON.stringify(state) })
  const clock = mock.clock(on)
  const charged = new Set<string>()
  const fixture = { state, clock, seen, isFailing: true, failed: [] as string[], landed: [] as string[] }
  on('process.run', async (_, e) => {
    const stdout = board(e)
    if (e.argv[3] !== 'account') return answer(stdout)
    const [turn = '', actor = '', count] = e.argv.slice(4)
    if (fixture.isFailing) {
      fixture.failed.push(turn)
      return { value: { exitCode: 1, stdout: '', stderr: 'disk full', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    fixture.landed.push(turn)
    if (!charged.has(turn)) state.usage.tokens[actor] = (state.usage.tokens[actor] ?? 0) + Number(count)
    charged.add(turn)
    const total = Object.values(state.usage.tokens).reduce((sum, value) => sum + value, 0)
    const paused = !state.paused && total >= 100
    if (paused) state.paused = 'token budget of 100 spent'
    return answer(JSON.stringify({ title: state.title, total, budget: 100, paused }))
  })
  on('tool.call', () => ({ result: {} }))
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use' as const, usage: { model: 'm', input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }
  })
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  return fixture
}
const ends = { answer: '', durationMs: 1, isAborted: false, reason: 'answer' } as const

test('a turn\'s end whose write failed is charged in full when it is reported again, under the same report', async ($, on) => {
  const run = await nearBudget($, on)
  const ten = { model: 'm', input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  await $.turn.complete({ ...ends, turnId: 'r', usage: ten })
  expect([run.state.usage.tokens.coordinator, run.failed.length]).toEqual([95, 1])
  run.isFailing = false
  await $.turn.complete({ ...ends, turnId: 'r', usage: ten })
  expect([run.state.usage.tokens.coordinator, run.state.paused, run.landed]).toEqual([105, 'token budget of 100 spent', run.failed])
  expect(run.seen.prompts.map(text => text.split('\n')[0])).toEqual(['Swarm: Run paused at token budget'])
  // once it landed, a further report adds nothing
  await $.turn.complete({ ...ends, turnId: 'r', usage: ten })
  expect([run.state.usage.tokens.coordinator, run.landed.length]).toEqual([105, 1])
})

test('losing the response to an END charge preserves its amount when a step and a revised total arrive', async ($, on) => {
  const { answer, board } = owning(on, { board: () => '', roster: () => ROSTER })
  const usage = (input_tokens: number) => ({ model: 'm', input_tokens, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 })
  const attempts: number[] = []
  const persisted = new Map<string, number>()
  on('process.run', (_, e) => {
    if (e.argv[3] !== 'account') return answer(board(e))
    const id = e.argv[4]!
    const requested = Number(e.argv[6])
    attempts.push(requested)
    if (attempts.length >= 3 && !persisted.has(id)) persisted.set(id, requested)
    if (attempts.length <= 3) return { value: { ...answer('').value, exitCode: 1 } }
    return answer(JSON.stringify({ title: 'Demo swarm', accepted: persisted.get(id), total: 0, budget: 0, paused: false }))
  })
  on('tool.call', () => ({ result: {} }))
  on('agent.list', () => ({ value: [] }))
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use' as const, usage: usage(100) }
  })
  mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  for await (const _ of $.turn.step({ turnId: 'lost-end', index: 0, model: 'm', messageCount: 1 })) { /* no chunks */ }
  await $.turn.complete({ ...ends, turnId: 'lost-end', usage: usage(250) })
  expect(attempts).toEqual([100, 100, 150])
  await $.turn.complete({ ...ends, turnId: 'lost-end', usage: usage(260) })
  await $.turn.complete({ ...ends, turnId: 'lost-end', usage: usage(260) })
  expect(attempts).toEqual([100, 100, 150, 100, 150, 10])
  expect([...persisted.values()]).toEqual([150, 100, 10])
})

test('a charge the board took neither at its step nor at its turn\'s end is charged when a later turn ends', async ($, on) => {
  const run = await nearBudget($, on)
  for await (const _ of $.turn.step({ turnId: 's', index: 0, model: 'm', messageCount: 1 })) { /* no chunks */ }
  await run.clock.advance(1)
  await $.turn.complete({ ...ends, turnId: 's' })
  expect([run.state.usage.tokens.coordinator, run.failed.length]).toEqual([95, 2])
  run.isFailing = false
  await $.turn.complete({ ...ends, turnId: 't', usage: { model: 'm', input_tokens: 1, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } })
  expect([run.state.usage.tokens.coordinator, run.state.paused]).toEqual([106, 'token budget of 100 spent'])
  expect(run.landed).toContain(run.failed[0])
})

test('a turn that reported only its end, and whose charge the board did not take, is charged when a later turn ends', async ($, on) => {
  const run = await nearBudget($, on)
  const spent = (input_tokens: number) => ({ model: 'm', input_tokens, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 })
  await $.turn.complete({ ...ends, turnId: 'r', usage: spent(10) })
  expect([run.state.usage.tokens.coordinator, run.failed.length]).toEqual([95, 1])
  run.isFailing = false
  await $.turn.complete({ ...ends, turnId: 't', usage: spent(1) })
  expect([run.state.usage.tokens.coordinator, run.landed]).toEqual([106, [expect.any(String), run.failed[0]]])
})

test('a step whose write failed is charged at its turn\'s end under its own report, though the end carries no usage', async ($, on) => {
  const run = await nearBudget($, on)
  for await (const _ of $.turn.step({ turnId: 's', index: 0, model: 'm', messageCount: 1 })) { /* no chunks */ }
  await run.clock.advance(1)
  expect([run.state.usage.tokens.coordinator, run.failed.length]).toEqual([95, 1])
  run.isFailing = false
  await $.turn.complete({ ...ends, turnId: 's' })
  expect([run.state.usage.tokens.coordinator, run.state.paused, run.landed]).toEqual([105, 'token budget of 100 spent', run.failed])
  expect(run.seen.prompts.map(text => text.split('\n')[0])).toEqual(['Swarm: Run paused at token budget'])
})

test('the run is bound from its first planning command, and only a real read of its board answers its mentions', async ($, on) => {
  const roster = JSON.stringify({ title: 'Demo swarm', members: { coordinator: { role: 'coordinator', last_read_seq: 0 }, parser: { role: 'worker', id: 'a1', last_read_seq: 1 } } })
  const { seen, answer, board } = owning(on, { board: () => posts({ agent: 'parser', to: ['coordinator'], text: '@coordinator which file?' }), roster: () => roster })
  on('process.run', (_, e) => {
    const stdout = board(e)
    return answer(e.argv[3] === 'account' ? JSON.stringify({ title: 'Demo swarm', total: 0, budget: 0, paused: false }) : stdout)
  })
  on('agent.list', () => ({ value: [] }))
  on('tool.call', (_, e) => ({ result: { stdout: e.tool === 'Bash' && String(e.command).includes(' init ') ? `${OWNED}\n` : '' } as never }))
  const clock = mock.clock(on)
  const binds = () => seen.commands.filter(command => command.startsWith('bind')).length
  const bash = (command: string) => toolCall($, { tool: 'Bash', command })

  // planning done before the run is bound is charged to it at the turn's end: no step's usage is lost on the way
  let spent = { model: 'm', input_tokens: 250, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use' as const, usage: spent }
  })
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  for await (const _ of $.turn.step({ turnId: 'plan', index: 0, model: 'm', messageCount: 1 })) { /* no chunks */ }
  await bash('python3 /p/board.py /project/.swarm/demo init "Demo swarm"')
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, reason: 'answer', turnId: 'plan', usage: spent })
  expect(seen.commands.filter(command => command.startsWith('account')).map(command => command.split(' ')[3])).toEqual(['250'])
  // The same charge carries what it spent before weighting and what started the turn: here, the user.
  expect(seen.commands.filter(command => command.startsWith('account')).map(command => command.split(' ')[4])).toEqual([expect.stringMatching(/^user:\d+,\d+,\d+,\d+$/)])
  // A turn that a member's report starts is the member's wake, not the user's.
  await $.prompt.submit({ text: 'Another Claude session sent a message:\n<agent-message from="a1">\nthe build broke in src/shared</agent-message>', origin: { kind: 'peer' }, wait: false })
  await $.turn.start({ turnId: 'woken', prompt: '' } as never)
  for await (const _ of $.turn.step({ turnId: 'woken', index: 0, model: 'm', messageCount: 1 })) { /* no chunks */ }
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, reason: 'answer', turnId: 'woken', usage: spent })
  expect(seen.commands.filter(command => command.startsWith('account')).map(command => command.split(' ')[4]?.split(':')[0])).toEqual(['user', 'member'])

  for (const [index, command] of [
    'python3 /p/board.py /project/.swarm/demo init "Demo swarm"',
    `python3 /p/board.py "${OWNED}" member parser role=worker`,
    `python3 /p/board.py "${OWNED}" plan`,
    `python3 /p/board.py "${OWNED}" read @coordinator`,
  ].entries()) {
    seen.restore = ''  // each start is a conversation that owns nothing yet
    seen.commands.length = 0
    await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
    await bash(`python3 /p/board.py "${OWNED}" status`)
    await bash(command)
    expect([index, binds()]).toEqual([index, 1])
  }
  // owning it, a board command that only reads another run does not move the conversation there
  await bash('python3 /p/board.py /project/.swarm/other-20261117-090000 plan')
  expect(binds()).toBe(1)

  await clock.advance(2000)
  // a read is never told to read, however it names the run; the words in a commit message are no read, so the
  // mention is still owed, and told
  expect((await bash('python3 /p/board.py "$RUN" read coordinator')).context).toBeUndefined()
  const committed = await bash('git commit -m "read coordinator notes"')
  expect(committed.context?.join(' ')).toContain('addresses you from #1')

  // a turn still stepping while hundreds of others come and go is charged once, not again at its end
  seen.commands.length = 0
  const step = async (turnId: string, index: number) => {
    for await (const _ of $.turn.step({ turnId, index, model: 'm', messageCount: 1 })) { /* no chunks */ }
  }
  spent = { ...spent, input_tokens: 100 }
  await step('long', 0)
  for (let other = 0; other < 256; other++) await step(`other-${other}`, 0)
  await step('long', 1)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, reason: 'answer', turnId: 'long', usage: { ...spent, input_tokens: 200 } })
  const charged = seen.commands.filter(command => command.startsWith('account')).map(command => Number(command.split(' ')[3]))
  expect(charged.reduce((sum, count) => sum + count, 0)).toBe(100 * 258)
})

test('a bind still waiting for the board when /clear fires does not bring the old run back', async ($, on) => {
  const { seen, answer, board } = owning(on, { board: () => '', roster: () => ROSTER })
  let isClearing = false
  on('process.run', async (_, e) => {
    const stdout = board(e)
    if (e.argv[3] === 'bind' && isClearing) {
      isClearing = false
      await $.session.end({ reason: 'clear', sessionId: 's', resume: { id: 's' } })
      seen.restore = ''  // the new session has saved no run
    }
    return answer(stdout)
  })
  on('agent.list', () => ({ value: [] }))
  on('tool.call', () => ({ result: {} }))
  mock.clock(on)
  const read = () => toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  const binds = () => seen.commands.filter(command => command.startsWith('bind')).length
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  isClearing = true
  await read()
  expect(binds()).toBe(1)
  // the conversation that follows /clear owns nothing until it binds for itself
  await read()
  expect(binds()).toBe(2)
})

test('the pane pauses, resumes and answers attention items on the board itself, only for the run this conversation drives', async ($, on) => {
  const state = {
    title: 'Demo swarm', limits: { budget: '1000' }, closed: false, paused: undefined as string | undefined,
    usage: { tokens: { coordinator: 0 } },
    members: { coordinator: { role: 'coordinator', last_read_seq: 2 }, parser: { role: 'worker', id: 'a1', last_read_seq: 2 } },
  }
  const item = (kind: string, text: string) => ({ kind, member: kind === 'paused' ? 'coordinator' : 'parser', seq: kind === 'paused' ? 0 : 2, text })
  const report = {
    items: [
      item('paused', 'The run is paused: token budget of 1000 spent'), item('ignored', '@parser was woken 3 times'),
      item('review', '@parser posted a finding'), item('rework', '@parser has 2 NOT PASSED in a row'),
      item('spend', '@parser used more than half the tokens'), item('mystery', 'a kind from a newer board'),
      item('unreachable', '@parser could not be woken after 3 attempts'),
    ],
    members: {},
  }
  const { seen, answer, board } = owning(on, {
    board: () => posts({ agent: 'coordinator', to: ['parser'], text: '@parser BRIEF' }, { agent: 'parser', to: ['coordinator'], text: '@coordinator FINDING' }),
    roster: () => JSON.stringify(state),
  })
  let refusal = ''
  on('process.run', (_, e) => {
    const stdout = board(e)
    const [action, ...rest] = e.argv.slice(3)
    if (refusal && action === 'resume') return { value: { exitCode: 1, stdout: '', stderr: `${refusal}\n`, isStdoutTruncated: false, isStderrTruncated: false } }
    if (action === 'pause') state.paused = rest.join(' ')
    if (action === 'resume') state.paused = undefined
    if (action === 'limit') state.limits.budget = (rest[0] ?? '').split('=')[1] ?? ''
    return answer(action === 'attention' ? JSON.stringify(report) : stdout)
  })
  on('agent.list', () => ({ value: [{ id: 'a1', description: '@parser', type: 'swarm:worker', status: 'idle' }] as never }))
  on('tool.call', () => ({ result: {} }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const ran = () => seen.commands.filter(command => /^(pause|resume|limit|retry)\b/.test(command))

  // the header toggle runs the board's own pause and resume, and the pane shows the result at once
  await ui.press({ key: 'run-pause' })
  expect(ran()).toEqual(['pause paused from the pane'])
  expect(await ui.find({ type: 'Text', text: /^Paused · / })).toBeDefined()
  expect((await ui.find({ key: 'run-pause' }))?.text).toBe('Resume run')
  // a command the board refuses is told with its own words
  refusal = 'token budget spent (1200 of 1000); raise it with limit before resuming'
  await ui.press({ key: 'run-pause' })
  expect(seen.toasts).toEqual([`Swarm: ${refusal}`])
  refusal = ''
  await ui.press({ key: 'run-pause' })
  expect(ran().at(-1)).toBe('resume')
  expect((await ui.find({ key: 'run-pause' }))?.text).toBe('Pause run')

  // each attention kind draws, a new or unknown one too, with the action it has
  state.usage.tokens.coordinator = 1200
  state.paused = 'token budget of 1000 spent'
  await clock.advance(2000)
  await ui.press({ key: 'tab-attention' })
  for (const label of [/^PAUSED$/, /^IGNORED$/, /^REVIEW$/, /^REWORK$/, /^SPEND$/, /^MYSTERY$/]) expect(await ui.find({ type: 'Text', text: label })).toBeDefined()
  seen.commands.length = 0
  await ui.press({ key: 'attention-budget-paused-coordinator-0' })
  expect(ran()).toEqual(['limit budget=501200', 'resume'])
  await ui.press({ key: 'attention-retry-ignored-parser-2' })
  expect(ran().at(-1)).toBe('retry parser')
  expect(seen.prompts).toEqual([])
  await ui.press({ key: 'attention-review-review-parser-2' })
  expect(seen.prompts.at(-1)).toMatch(/^Swarm: Review @parser's finding\n.*show --post=2/)
  await ui.press({ key: 'attention-rework-rework-parser-2' })
  expect(seen.prompts.at(-1)).toMatch(/^Swarm: @parser keeps failing verification\n/)
  await ui.press({ key: 'attention-recover-unreachable-parser-2' })
  expect(seen.prompts.at(-1)).toMatch(/^Swarm: Recover @parser\n/)

  // a closed run shows its items without buttons (a run only looked at: the run switcher test)
  state.closed = true
  await clock.advance(2000)
  expect(await ui.find({ type: 'Text', text: /^IGNORED$/ })).toBeDefined()
  for (const key of ['run-pause', 'attention-budget-paused-coordinator-0', 'attention-retry-ignored-parser-2', 'attention-review-review-parser-2', 'attention-rework-rework-parser-2', 'attention-recover-unreachable-parser-2']) expect(await ui.find({ key })).toBeUndefined()
  await ui.unmount()
})

test('the run switcher shows the project\'s other runs read-only and leaves the live run alone', async ($, on) => {
  const older = '/project/.swarm/older-20261101-090000'
  const reads: string[] = []
  const { seen, answer, board } = owning(on, {
    board: () => BOARD, roster: () => ROSTER,
    read: path => {
      reads.push(path)
      if (path.includes('/junk-')) throw new Error('no such file')
      // F23: a roster cut short between the live run and an older one does not end the walk to that one
      if (path === '/project/.swarm/broken-20261110-000000/members.json') return '{"title": "Bro'
      if (path === `${older}/members.json`) return JSON.stringify({ title: 'Older swarm', members: { coordinator: { role: 'coordinator', last_read_seq: 1 }, scout: { role: 'worker', id: 'gone', last_read_seq: 1 } } })
      // open, unpaused, and its member owed a mention: live in every way but being this conversation's run
      if (path === `${older}/board.jsonl`) return posts({ agent: 'scout', to: ['coordinator'], text: '@coordinator the old report' }, { agent: 'coordinator', to: ['scout'], text: '@scout go on' })
      return undefined
    },
  })
  on('fs.list', () => ({
    value: ['archive', 'junk-20261001-000000', 'older-20261101-090000', 'broken-20261110-000000', OWNED.slice(OWNED.lastIndexOf('/') + 1), '.bindings']
      .map(name => ({ name, kind: 'dir', size: 0 })) as never,
  }))
  on('process.run', (_, e) => {
    const stdout = board(e)
    return answer(e.argv[3] === 'claim' ? 'a'.repeat(32) : stdout)
  })
  on('agent.list', () => ({ value: [{ id: 'a1', description: '@parser', type: 'swarm:worker', status: 'completed' }, { id: 'gone', description: '@scout', type: 'swarm:worker', status: 'completed' }] as never }))
  on('tool.call', () => ({ result: {} }))
  const sends: string[] = []
  on('session.send', (_, e) => { sends.push(`${e.to}: ${e.text}`); return { isDelivered: true } })
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /read-only/ })).toBeUndefined()

  await ui.press({ key: 'run-prev' })
  expect(await ui.find({ type: 'Text', text: /^Older swarm$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Not the live run · read-only$/ })).toBeDefined()
  expect(await ui.find({ type: 'Markdown', text: /the old report/ })).toBeDefined()
  expect(await ui.find({ key: 'run-pause' })).toBeUndefined()
  // every tab is there for it, and its graph never claims to be live
  await ui.press({ key: 'tab-members' })
  expect(await ui.find({ type: 'Text', text: /@scout/ })).toBeDefined()
  await ui.press({ key: 'tab-graph' })
  expect(await ui.find({ type: 'Text', text: /^Latest post$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Live$/ })).toBeUndefined()
  // an open run that is only looked at has a latest post, never a "live" to go to
  await ui.press({ key: 'replay-first' })
  expect(await ui.find({ type: 'Button', text: 'Latest' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: 'Go live' })).toBeUndefined()
  await ui.press({ key: 'replay-live' })
  await ui.press({ key: 'tab-board' })
  // it is read once: the poller, the wakes and the binding stay with the live run
  reads.length = 0
  seen.commands.length = 0
  await clock.advance(6000)
  expect(reads.filter(path => path.startsWith(older))).toEqual([])
  expect(reads.some(path => path.startsWith(OWNED))).toBe(true)
  expect(seen.commands.filter(command => command.startsWith('bind') || command.includes('scout'))).toEqual([])
  // the live run's member is woken meanwhile, the browsed run's is not
  expect(sends.length).toBeGreaterThan(0)
  expect(sends.every(send => send.includes('a1') && send.includes(`'${OWNED}' read parser`))).toBe(true)
  expect(await ui.find({ type: 'Text', text: /^Older swarm$/ })).toBeDefined()
  // the folder with no roster and `archive` are no runs: nothing lies further back, so the step back is no control
  expect(await ui.find({ type: 'Button', key: 'run-prev' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^‹ Prev run$/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'run-next' })).toBeDefined()
  expect(seen.toasts).toEqual([])
  // one press back to the live run, by the button or by stepping forward onto it
  await ui.press({ key: 'run-live' })
  expect(await ui.find({ type: 'Text', text: /^Demo swarm$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /read-only/ })).toBeUndefined()
  // before the run list is read, both steps are offered
  expect(await ui.find({ type: 'Button', key: 'run-prev' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'run-next' })).toBeDefined()
  await ui.press({ key: 'run-prev' })
  await ui.press({ key: 'run-next' })
  expect(await ui.find({ type: 'Text', text: /^Demo swarm$/ })).toBeDefined()
  // the live run is the newest: stepped onto, it offers the step back only
  expect(await ui.find({ type: 'Button', key: 'run-next' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^Next run ›$/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'run-prev' })).toBeDefined()
  expect(seen.toasts).toEqual([])
  expect(seen.commands.filter(command => command.startsWith('bind')).length).toBe(0)
  await ui.unmount()
})

test('a pause nobody made in front of the coordinator is told to it once, and a teammate\'s address outlives a restart', async ($, on) => {
  const state = {
    title: 'Demo swarm', paused: undefined as string | undefined,
    members: { coordinator: { role: 'coordinator', last_read_seq: 0 }, art: { role: 'worker', id: 'art@team', last_read_seq: 0 } },
  }
  const { seen, answer, board } = owning(on, { board: () => '', roster: () => JSON.stringify(state) })
  on('process.run', (_, e) => {
    const stdout = board(e)
    const [action, ...rest] = e.argv.slice(3)
    if (action === 'pause') state.paused = rest.join(' ')
    if (action === 'resume') state.paused = undefined
    return answer(stdout)
  })
  // the address of a teammate met before the restart, as the plugin's store kept it
  const stored: Record<string, unknown> = { teammates: { a9: 'art@team' } }
  on('store.get', (_, e) => ({ value: stored[e.key] }))
  on('store.set', (_, e) => { stored[e.key] = e.value; return { value: undefined } })
  let agents: unknown[] = []
  on('agent.list', () => ({ value: agents as never }))
  on('tool.call', (_, e) => {
    if (e.tool === 'Bash' && String(e.command).includes(' pause ')) state.paused = 'awaiting the user'
    return { result: {} }
  })
  const clock = mock.clock(on)
  const done = { answer: '', durationMs: 1, isAborted: false, reason: 'answer' } as const
  const bash = (command: string) => toolCall($, { tool: 'Bash', command })
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await bash(`python3 /p/board.py "${OWNED}" read coordinator`)
  await $.turn.complete({ ...done, turnId: 'c1' })
  await clock.advance(2000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  // the person's own pause from the pane, and the coordinator's own board command, are no news to it
  await ui.press({ key: 'run-pause' })
  await clock.advance(4000)
  await ui.press({ key: 'run-pause' })
  await clock.advance(4000)
  await bash(`python3 /p/board.py "${OWNED}" pause awaiting the user`)
  await $.turn.complete({ ...done, turnId: 'c2' })
  await clock.advance(4000)
  expect(state.paused).toBe('awaiting the user')
  state.paused = undefined
  await clock.advance(12000)
  expect(seen.prompts).toEqual([])

  // the board paused the run by itself: the idle coordinator is prompted, once
  state.paused = '@art failed verification 3 times in a row'
  await clock.advance(2000)
  await clock.advance(20000)
  expect(seen.prompts.length).toBe(1)
  expect(seen.prompts[0]).toMatch(/^Swarm: Run paused\nDemo swarm is paused: @art failed verification 3 times in a row\. Tell the user.*resume command/)
  // mid-turn it rides on the next tool result instead, and a prompt that does not land is told to the person
  state.paused = undefined
  await clock.advance(2000)
  await $.turn.start({ text: 'go on', turnId: 'c3' })
  state.paused = '@art failed verification 4 times in a row'
  await clock.advance(4000)
  expect(seen.prompts.length).toBe(1)
  expect((await toolCall($, { tool: 'Read', file_path: '/project/a.ts' })).context?.join(' ')).toContain('is paused: @art failed verification 4 times')
  expect((await toolCall($, { tool: 'Read', file_path: '/project/a.ts' })).context).toBeUndefined()
  await $.turn.complete({ ...done, turnId: 'c3' })
  state.paused = undefined
  await clock.advance(12000)
  seen.isDeaf = true
  state.paused = 'a third reason'
  await clock.advance(2000)
  expect(seen.toasts.at(-1)).toContain('a third reason. The coordinator could not be told.')
  await ui.unmount()

  // the teammate ends with no agent listed and no step seen since the restart: its turn is still recorded under its address
  await $.turn.complete({ ...done, turnId: 'm', agentId: 'a9', durationMs: 1200 })
  expect(seen.commands).toContain('rearm 1200 a9 art@team')
  // and one met now is kept for the next restart
  agents = [{ id: 'b2', teammateId: 'bob@team', description: '@bob', type: 'swarm:worker', status: 'running' }]
  await $.turn.complete({ ...done, turnId: 'n', agentId: 'b2' })
  expect(stored.teammates).toEqual({ a9: 'art@team', b2: 'bob@team' })
})

test('session.send relays specialist wakes, gates on budget/pause, and matches native teammates', async ($, on) => {
  const run = '/project/.swarm/demo-20261116-101010'
  const scout = { role: 'worker', profile: 'explorer', writes: '0', id: 'scout@team', last_read_seq: 0 }
  const state: { members: Record<string, unknown>; paused?: string; closed?: boolean; limits?: Record<string, string>; usage?: { tokens: Record<string, number> } } = {
    members: {
      coordinator: { backend: 'native', last_read_seq: 0 },
      scout,
    },
  }
  let readDuringClaim = false
  let sends = 0
  const commands: string[] = []
  on('command.register', (_, spec) => ({ value: { command: spec.name } }))
  on('tool.register', (_, spec) => ({ value: { tool: `mcp__swarm__${spec.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'fixture-conversation' }))
  on('session.cwd', () => ({ value: '/project' }))
  on('fs.read', () => ({ value: JSON.stringify(state) }))
  on('process.run', (_, e) => {
    const args = e.argv.slice(3)
    commands.push(args.join(' '))
    if (args[0] === 'restore') return { value: { exitCode: 0, stdout: run, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (args[0] === 'claim') {
      const seq = Number(args[3])
      if (readDuringClaim) scout.last_read_seq = seq
      if (scout.last_read_seq < seq) return { value: { exitCode: 0, stdout: '0123456789abcdef0123456789abcdef', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.send', () => {
    sends++
    return { isDelivered: true }
  })
  mock.clock(on)

  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  const res = await $.session.send({ to: 'scout', text: `  ${wakeMessage(4)}\n`, origin: { kind: 'model' } } as never)
  expect(res.isDelivered).toBe(true)
  expect(commands).toContain('claim scout scout@team 4')
  expect(commands).toContain('woke scout 4 0123456789abcdef0123456789abcdef')

  scout.last_read_seq = 4
  const stale = await $.session.send({ to: 'scout', text: wakeMessage(4), origin: { kind: 'model' } } as never)
  expect(stale).toEqual({ isDelivered: false, reason: '@scout already read through #4.' })
  expect(commands.filter(command => command === 'claim scout scout@team 4')).toHaveLength(1)

  readDuringClaim = true
  const caughtUp = await $.session.send({ to: 'scout', text: wakeMessage(5), origin: { kind: 'model' } } as never)
  expect(caughtUp).toEqual({ isDelivered: false, reason: '@scout already read through #5.' })
  expect(commands).toContain('claim scout scout@team 5')
  expect(sends).toBe(1)

  state.paused = 'awaiting coordinator'
  const blocked = await $.session.send({ to: 'scout', text: wakeMessage(6), origin: { kind: 'model' } } as never)
  expect(blocked.isDelivered).toBe(false)
})

test('agent.spawn handles model=inherit, exact older IDs, spawnEfforts, parallel bind, pruned closedRun, and dropped native resume', async ($, on) => {
  const run1 = '/project/.swarm/first-20261116-101010'
  const run2 = '/project/.swarm/second-20261116-101011'
  let activeRun = run1
  let run1Deleted = false
  let boundDir = ''
  const spawned: { model?: string; background?: boolean }[] = []
  const agents: { id: string; teammateId?: string; description: string; type: string; status: string }[] = []
  const state1 = {
    title: 'First',
    limits: { opus: 'none' },
    members: {
      coordinator: {},
      none: { role: 'worker', model: 'opus' },
      inh: { role: 'worker', model: 'inherit' },
      inh2: { role: 'worker', model: 'inherit' },
      inh3: { role: 'worker', model: 'inherit' },
      exact: { role: 'worker', model: 'claude-opus-4-6' },
      bedrock: { role: 'worker', model: 'us.anthropic.claude-opus-4-6-v1' },
      w1: { role: 'worker' },
      w2: { role: 'worker' },
    },
  }
  const state2 = {
    title: 'Second',
    members: { coordinator: {}, w1: { role: 'worker' }, w2: { role: 'worker' } },
  }
  on('command.register', (_, spec) => ({ value: { command: spec.name } }))
  on('tool.register', (_, spec) => ({ value: { tool: `mcp__swarm__${spec.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 'fixture-conversation' }))
  on('session.id', () => ({ value: 'fixture-conversation' }))
  on('session.cwd', () => ({ value: '/project' }))
  on('agent.list', () => ({ value: agents as never }))
  let effortDeny: string | undefined
  on('tool.call', async (_, e) => {
    if (e.tool === 'Agent') {
      const res = await $.agent.spawn({
        tool_use_id: e.tool_use_id ?? 'eff-1', prompt: 'Use the board.', description: '@w1: test', subagentType: 'swarm:worker',
        provider: { plugin: 'swarm', tier: 'core' as const }, parentModel: 'claude-sonnet-5-5', background: false, fork: false,
      })
      effortDeny = res.deny
    }
    return { result: {} }
  })
  on('fs.read', (_, e) => {
    if (run1Deleted && e.path.startsWith(run1)) return { deny: 'ENOENT' }
    if (e.path.startsWith(run1)) return { value: JSON.stringify(state1) }
    if (e.path.startsWith(run2)) return { value: JSON.stringify(state2) }
    return { value: '' }
  })
  on('process.run', (_, e) => {
    const args = e.argv.slice(3)
    if (args[0] === 'restore') return { value: { exitCode: 0, stdout: activeRun, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (args[0] === 'bind') { boundDir = e.argv[2] ?? ''; return { value: { exitCode: 0, stdout: boundDir, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } }
    if (args[0] === 'locate') return { value: { exitCode: 0, stdout: run2, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('agent.spawn', (_, e) => {
    spawned.push({ model: e.model, background: e.background })
    return { model: e.model ?? 'sonnet', agentId: `id-${spawned.length}` }
  })
  mock.clock(on)

  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  const base = {
    tool_use_id: 't1', prompt: 'Use the board.', subagentType: 'swarm:worker',
    provider: { plugin: 'swarm', tier: 'core' as const }, parentModel: 'claude-sonnet-5-5', background: false, fork: false,
  }
  // `opus=none` is enforced even for a member literally named `none`
  expect((await $.agent.spawn({ ...base, description: '@none: test', model: 'opus' })).deny).toContain('allows opus only for: none')
  // `model=inherit` rewrites to parentModel and `background: true` when !isTeammate
  expect((await $.agent.spawn({ ...base, description: '@inh: test' })).agentId).toBe('id-1')
  expect(spawned.at(-1)).toEqual({ model: 'claude-sonnet-5-5', background: true })
  // F7: the docs say to omit model or pass the matching family. A coordinator on an older model of that family
  // still starts the member on its own model, and a refusal never advises model: "inherit", which Agent does not take.
  const olderParent = { ...base, parentModel: 'claude-sonnet-4-5' }
  const other = await $.agent.spawn({ ...olderParent, description: '@inh2: test', model: 'haiku' })
  expect(other.deny).toContain('pass the coordinator\'s own family (model: "sonnet")')
  expect(other.deny).not.toContain('"inherit"')
  expect((await $.agent.spawn({ ...olderParent, description: '@inh2: test', model: 'sonnet' })).deny).toBeUndefined()
  expect(spawned.at(-1)?.model).toBe('claude-sonnet-4-5')
  expect((await $.agent.spawn({ ...olderParent, description: '@inh3: test', model: 'Sonnet' })).deny).toBeUndefined()
  expect(spawned.at(-1)?.model).toBe('claude-sonnet-4-5')
  // exact older ID and Bedrock ID pass when e.model is omitted or matches family
  state1.limits = {} as never
  expect((await $.agent.spawn({ ...base, description: '@exact: test' })).agentId).toBe('id-4')
  expect(spawned.at(-1)?.model).toBe('claude-opus-4-6')
  expect((await $.agent.spawn({ ...base, description: '@bedrock: test', model: 'opus' })).agentId).toBe('id-5')
  expect(spawned.at(-1)?.model).toBe('us.anthropic.claude-opus-4-6-v1')
  // spawnEfforts enforcement via tool.call('Agent')
  await toolCall($, { tool: 'Agent', tool_use_id: 'eff-1', effort: 'high' } as never)
  expect(effortDeny).toContain('medium effort')

  // Parallel bind on an unbound run succeeds for both workers
  activeRun = ''
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  const [r1, r2] = await Promise.all([
    $.agent.spawn({ ...base, description: '@w1: parallel 1' }),
    $.agent.spawn({ ...base, description: '@w2: parallel 2' }),
  ])
  expect(r1.agentId).toBeDefined()
  expect(r2.agentId).toBeDefined()
  expect(boundDir).toBe(run2)

  // Pruned closedRun does not brick subsequent spawns
  await $.session.end({ reason: 'clear' } as never)
  run1Deleted = true
  expect((await $.agent.spawn({ ...base, description: '@w1: after prune' })).agentId).toBeDefined()
})

test('turn.step passes charge() delta, account() vs refresh() budget pause notifies once, and openPost/filter/ui.close behave cleanly', async ($, on) => {
  const run = '/project/.swarm/demo-20261116-101010'
  const state: { title: string; members: Record<string, unknown>; paused?: string; closed?: boolean; limits: Record<string, string>; usage: { tokens: Record<string, number> } } = {
    title: 'Demo', limits: { budget: '100' }, usage: { tokens: { coordinator: 95 } },
    members: { coordinator: { role: 'coordinator', last_read_seq: 0 }, parser: { role: 'worker', id: 'a1', last_read_seq: 0 }, 'fix-1': { role: 'worker', last_read_seq: 0 }, fix: { role: 'worker', last_read_seq: 0 } },
  }
  const accounted: number[] = []
  const prompts: string[] = []
  const board = [
    JSON.stringify({ seq: 1, agent: 'fix', to: ['coordinator'], text: '@coordinator PASSED', time: '2026-11-16T10:00:00Z' }),
    JSON.stringify({ seq: 2, agent: 'fix-1', to: ['coordinator'], text: '@coordinator NOT PASSED: line 1', time: '2026-11-16T10:01:00Z' }),
    JSON.stringify({ seq: 10, agent: 'parser', to: ['coordinator'], text: '@coordinator READY', time: '2026-11-16T10:02:00Z' }),
  ].join('\n')
  on('command.register', (_, spec) => ({ value: { command: spec.name } }))
  on('tool.register', (_, spec) => ({ value: { tool: `mcp__swarm__${spec.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'fixture-conversation' }))
  on('session.cwd', () => ({ value: '/project' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('prompt.submit', (_, e) => { prompts.push(e.text); return { text: e.text } })
  on('turn.complete', () => ({ text: '' }))
  on('fs.read', (_, e) => ({ value: e.path.endsWith('members.json') ? JSON.stringify(state) : board }))
  on('agent.list', () => ({ value: [] }))
  const usage = (fresh: number, cached = 0) => ({ model: 'm', input_tokens: fresh, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: cached })
  let answered = usage(0)
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use' as const, usage: answered }
  })
  const step = async (turnId: string, index: number, spent: ReturnType<typeof usage>) => {
    answered = spent
    for await (const _ of $.turn.step({ turnId, index, model: 'm', messageCount: 1 })) { /* no chunks */ }
    await clock.advance(1)
  }
  const done = { answer: '', durationMs: 1, isAborted: false, reason: 'answer' } as const
  on('process.run', (_, e) => {
    const args = e.argv.slice(3)
    if (args[0] === 'restore') return { value: { exitCode: 0, stdout: run, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (args[0] === 'account') {
      const amt = Number(args[3])
      accounted.push(amt)
      state.usage.tokens.coordinator = (state.usage.tokens.coordinator ?? 0) + amt
      const paused = state.usage.tokens.coordinator >= 100
      if (paused) state.paused = 'token budget of 100 spent'
      return { value: { exitCode: 0, stdout: JSON.stringify({ title: 'Demo', total: state.usage.tokens.coordinator, budget: 100, paused }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (args[0] === 'attention') return { value: { exitCode: 0, stdout: JSON.stringify({ items: [], members: {}, limits: state.limits }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const clock = mock.clock(on)

  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  // Two steps with cache_read_input_tokens=4 accumulate in turn.sum and charge delta=1 on step 2
  await step('t-cr', 0, usage(0, 4))
  await step('t-cr', 1, usage(0, 4))
  await $.turn.complete({ ...done, turnId: 't-cr', usage: usage(0, 8) })
  expect(accounted).toEqual([1])

  // Budget crossing via account() before Poll #1 still submits the budget pause prompt
  await step('t-over', 0, usage(5, 0))
  await $.turn.complete({ ...done, turnId: 't-over', usage: usage(5, 0) })
  await clock.advance(2000)
  expect(prompts.some(p => p.startsWith('Swarm: Run paused at token budget'))).toBe(true)

  // Structured Board filter: `@fix` does not match `@fix-1`, `passed` does not match `NOT PASSED`, `#1` does not match `#10`, `from:@parser` works
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'board-search', text: '@fix passed' })
  expect(await ui.find({ type: 'Text', text: /#1 ·/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /#2 ·/ })).toBeUndefined()
  await ui.input({ key: 'board-search', text: 'from:@parser #10' })
  expect(await ui.find({ type: 'Text', text: /#10 ·/ })).toBeDefined()
  await ui.unmount()
})

test('wave 2 UI: off-tab clock, dimmed replay guards, markdown fences, hide-inactive empty, placed, widget, and terminal graph', async ($, on) => {
  on('command.register', () => ({ value: { command: 'swarm-board' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.register', (_, spec) => ({ value: { tool: `mcp__swarm__${spec.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/project' }))
  on('fs.exists', () => ({ value: true }))
  const dir = '/project/.swarm/ui-20261116-101010'
  let board = [
    { seq: 1, agent: 'coordinator', to: ['parser'], text: '@parser BRIEF\n```ts\nconst a = 1\nconst b = 2\n```\n| col1 | col2 |\n| --- | --- |', time: '2026-11-16T14:03:22+0100' },
    { seq: 2, agent: 'coordinator', text: '@all sync', time: '2026-11-16T14:03:23+0100' },
  ].map(p => JSON.stringify(p)).join('\n') + '\n'
  let roster = JSON.stringify({
    title: 'UI swarm',
    paused: '',
    members: {
      coordinator: { role: 'coordinator', last_read_seq: 2 },
      parser: { role: 'worker', id: 'a1', last_read_seq: 1 },
      old: { role: 'worker', killed: '1', last_read_seq: 0 },
    },
  })
  let attentionItems: unknown[] = [{ kind: 'question', member: 'parser', seq: 1, text: 'Need input' }]
  on('fs.read', (_, e) => ({
    value: e.path.endsWith('/current') ? 'ui-20261116-101010\n'
      : e.path === `${dir}/board.jsonl` ? board
        : roster,
  }))
  on('agent.list', () => ({ value: [{ id: 'a1', description: '@parser', type: 'swarm:worker', status: 'idle' }] as never }))
  on('process.run', (_, e) => {
    if (e.argv.includes('attention')) {
      return { value: { exitCode: 0, stdout: JSON.stringify({ items: attentionItems, members: {} }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const clock = mock.clock(on)

  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await clock.advance(2000)

  // formatMarkdown preserves fenced code blocks and GFM tables without adding trailing two spaces inside fences
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const md = await ui.find({ type: 'Markdown', text: /const a = 1/ })
  expect(String(md?.props.text)).toContain('```ts\nconst a = 1\nconst b = 2\n```')
  expect(String(md?.props.text)).toContain('| col1 | col2 |\n| --- | --- |')

  // Off-tab Graph clock does not pre-start for unseen posts, while preserving return-visit continuity
  board += JSON.stringify({ seq: 3, agent: 'parser', to: ['coordinator'], text: '@coordinator done', time: '2026-11-16T14:03:24+0100' }) + '\n'
  await clock.advance(2000)
  await clock.advance(500) // 500ms while still on Board tab
  await ui.press({ key: 'tab-graph' })
  const firstVisit = String((await ui.findAll({ type: 'Svg' })).find(el => /^Post /.test(String(el.props.alt)))?.props.source)
  expect(firstVisit).toContain('animateMotion begin="0ms"')
  await ui.press({ key: 'tab-board' })
  await clock.advance(400)
  await ui.press({ key: 'tab-graph' })
  const returnVisit = String((await ui.findAll({ type: 'Svg' })).find(el => /^Post /.test(String(el.props.alt)))?.props.source)
  expect(returnVisit).toContain('animateMotion begin="-400ms"')

  // At the newest post Next leads nowhere: it is text, not a control, and Live stays
  expect(await ui.find({ type: 'Button', key: 'replay-next' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^Next ›$/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'replay-back' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Live$/ })).toBeDefined()

  // Hide inactive empty state in Members tab when all members are inactive
  await ui.press({ key: 'tab-members' })
  await ui.press({ key: 'hide-inactive' })
  expect(await ui.find({ type: 'Text', text: /All members are inactive\./ })).toBeDefined()
  await ui.press({ key: 'hide-inactive' })
  await ui.unmount()

  // Placed excludes killed members and reflects paused state; widget surfaces paused & attention
  roster = JSON.stringify({
    title: 'UI swarm',
    paused: 'paused by user',
    members: {
      coordinator: { role: 'coordinator', last_read_seq: 2 },
      parser: { role: 'worker', id: 'a1', last_read_seq: 1 },
      old: { role: 'worker', killed: '1', last_read_seq: 0 },
    },
  })
  await clock.advance(2000)
  const placed = await $.ui.mount({ plugin: 'swarm', component: 'Placed', props: { plugin: 'swarm', id: 'swarm-open-ui-20261116-101010' }, surface: 'desktop' })
  expect(await placed.find({ type: 'Text', text: /paused · 1 member · 3 posts/ })).toBeDefined()
  await placed.unmount()

  const widget = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, placement: 'widget' } })
  expect(await widget.find({ type: 'Text', text: /^Paused$/ })).toBeDefined()
  expect(await widget.find({ type: 'Text', text: /1 attention/ })).toBeDefined()
  await widget.unmount()

  // Terminal Graph pads bars to 8 cells and filters (via @all) when !expandAll
  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await term.press({ key: 'tab-graph' })
  expect(await term.find({ type: 'Text', text: /█+░*/ })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /\(via @all\)/ })).toBeUndefined()
  await term.press({ key: 'expand-all' })
  expect(await term.find({ type: 'Text', text: /\(via @all\)/ })).toBeDefined()
  await term.unmount()
})

test('a post already opened is not announced again, a run made from memory is pointed at the skill, and a deleted run is no error', async ($, on) => {
  const RUN = '/project/.swarm/demo-20261116-101010'
  const board = [
    { seq: 1, agent: 'coordinator', to: ['parser'], text: '@parser BRIEF\nOwns: date.ts' },
    { seq: 2, agent: 'parser', to: ['coordinator'], text: '@coordinator which file?' },
    { seq: 3, agent: 'verifier', to: ['coordinator'], text: '@coordinator NOT PASSED: the test fails' },
  ].map(post => JSON.stringify({ ...post, time: '2026-11-16T14:03:22+0100' })).join('\n') + '\n'
  const roster = JSON.stringify({
    title: 'Demo swarm',
    members: {
      coordinator: { role: 'coordinator', last_read_seq: 1 }, parser: { role: 'worker', id: 'a1', last_read_seq: 1 },
      verifier: { role: 'verifier', id: 'a2', last_read_seq: 1 },
    },
  })
  const prompts: string[] = []
  let isGone = false
  let held = 300_000
  const clock = mock.clock(on)
  on('command.register', () => ({ value: { command: 'swarm-board' } }))
  on('tool.register', (_, spec) => ({ value: { tool: `mcp__swarm__${spec.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'fixture-conversation' }))
  on('session.cwd', () => ({ value: '/project' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: held, window: 1_000_000 }, rateLimits: [] } as never }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', (_, e) => {
    if (isGone) throw new Error('ENOENT')
    return { value: e.path === `${RUN}/board.jsonl` ? board : e.path === `${RUN}/members.json` ? roster : '' }
  })
  on('agent.list', () => ({ value: [{ id: 'a1', description: '@parser', type: 'swarm:worker', status: 'running' }] as never }))
  on('tool.call', (_, e) => ({ result: e.tool === 'Bash' && String(e.command).includes(' init ') ? { stdout: `made it\n${RUN}\nok\n`, stderr: '' } : {} }))
  on('turn.complete', () => ({ text: '' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })

  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  // `init` always points at the skill, since a run can be made from memory; a long conversation is named with it.
  // The run folder is found on whichever line of the output holds it.
  const made = await toolCall($, { tool: 'Bash', command: 'python3 /p/board.py /project/.swarm/demo init "Demo swarm" && echo ok' })
  expect(made.context?.join(' ')).toContain('skills/swarm/SKILL.md')
  expect(made.context?.join(' ')).toContain('already holds about 300k tokens')
  held = 20_000
  const again = await toolCall($, { tool: 'Bash', command: 'python3 /p/board.py /project/.swarm/demo init "Demo swarm"' })
  expect(again.context?.join(' ')).toContain('name the token budget')
  expect(again.context?.join(' ')).not.toContain('already holds')
  await clock.advance(2000)
  // one member's posts were shown: the other member's post is still owed, and said so on that very result
  const some = await toolCall($, { tool: 'Bash', command: `python3 /p/board.py ${RUN} show parser` })
  expect(some.context?.join(' ')).toContain('1 board post addresses you from #3')
  // a show piped to `head` or redirected to a file was not seen: the post stays owed
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py ${RUN} show --post=3 | head -1` })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py ${RUN} show --post=3 > /tmp/x` })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't0', reason: 'answer' })
  await clock.advance(30000)
  expect(prompts.filter(text => text.includes('addresses you')).length).toBeGreaterThan(0)
  prompts.length = 0
  // opening that post is reading it: no reminder then, and no prompt when idle
  const shown = await toolCall($, { tool: 'Bash', command: `python3 /p/board.py ${RUN} show --post=3` })
  expect(shown.context).toBeUndefined()
  expect((await toolCall($, { tool: 'Read', file_path: '/project/a.ts' })).context).toBeUndefined()
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  await clock.advance(30000)
  expect(prompts.filter(text => text.includes('addresses you'))).toEqual([])
  // the run folder is deleted under the pane: the next polls are quiet and a tool call is not disturbed
  isGone = true
  await clock.advance(6000)
  const after = await toolCall($, { tool: 'Read', file_path: '/project/a.ts' })
  expect(after.context).toBeUndefined()
  expect(after.deny).toBeUndefined()
})

test('a READY is held while others still work, and a run made inside a command substitution is still bound', async ($, on) => {
  const RUN = '/project/.swarm/demo-20261116-101010'
  const board = [
    { seq: 1, agent: 'coordinator', to: ['parser', 'lexer'], text: '@parser @lexer BRIEF' },
    { seq: 2, agent: 'parser', to: ['coordinator'], text: 'READY\ndone' },
  ].map(post => JSON.stringify({ ...post, time: '2026-11-16T14:03:22+0100' })).join('\n') + '\n'
  const roster = JSON.stringify({
    title: 'Demo swarm',
    members: {
      coordinator: { role: 'coordinator', last_read_seq: 1 }, parser: { role: 'worker', id: 'a1', last_read_seq: 1 },
      lexer: { role: 'worker', id: 'a2', last_read_seq: 1 },
    },
  })
  const prompts: string[] = []
  const commands: string[] = []
  let lexer = 'running'
  let advice = false
  const consulted = board + JSON.stringify({ seq: 3, agent: 'sage', to: ['coordinator'], text: 'READY\nuse the adapter', time: '2026-11-16T14:05:22+0100' }) + '\n'
  const withSage = JSON.stringify({ ...JSON.parse(roster), members: { ...JSON.parse(roster).members, sage: { role: 'worker', profile: 'architect', consult: '1', id: 'a3', last_read_seq: 1 } } })
  const clock = mock.clock(on)
  on('command.register', () => ({ value: { command: 'swarm-board' } }))
  on('tool.register', (_, spec) => ({ value: { tool: `mcp__swarm__${spec.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'fixture-conversation' }))
  on('session.cwd', () => ({ value: '/project' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', (_, e) => ({
    value: e.path === `${RUN}/board.jsonl` ? (advice ? consulted : board) : e.path === `${RUN}/members.json` ? (advice ? withSage : roster)
      : e.path === '/project/.swarm/current' ? pointer : '',
  }))
  on('agent.list', () => ({ value: [
    { id: 'a1', description: '@parser', type: 'swarm:worker', status: 'completed' },
    { id: 'a2', description: '@lexer', type: 'swarm:worker', status: lexer },
  ] as never }))
  // the pointer names the run once a command's init has made it
  let pointer = ''
  on('tool.call', () => {
    pointer = 'demo-20261116-101010\n'
    return { result: { stdout: '', stderr: '' } }
  })
  on('turn.complete', () => ({ text: '' }))
  on('process.run', (_, e) => {
    const [, , directory, action] = e.argv
    commands.push(`${action} ${directory}`)
    const stdout = action === 'attention' ? JSON.stringify({ items: [], members: {} }) : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })

  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  // the folder never reaches the output and no board call can be read off the command: the pointer names the run
  const made = await toolCall($, { tool: 'Bash', command: 'R=$(python3 /p/board.py /project/.swarm/demo init "Demo swarm")' })
  expect(commands).toContain(`bind ${RUN}`)
  expect(made.context?.join(' ')).toContain('skills/swarm/SKILL.md')
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  // one of two workers reported: nothing the coordinator can act on, so it is left asleep while the other works
  await clock.advance(60000)
  expect(prompts.filter(text => text.includes('addresses you'))).toEqual([])
  // the last worker stops: now the report is worth a turn
  lexer = 'completed'
  await clock.advance(16000)
  expect(prompts.filter(text => text.includes('addresses you')).length).toBe(1)
  // a consultant's READY is the answer that was asked for: it is not held, whoever else is working
  lexer = 'running'
  advice = true
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
  await clock.advance(16000)
  expect(prompts.filter(text => /address(es)? you/.test(text)).length).toBe(2)
})

test('wave 3 fixes: multi-word kind filter, non-round budget pause dedup, specialistBoard guards, conflicting exact model IDs', async ($, on) => {
  const run = '/project/.swarm/demo-20261116-101010'
  const state: {
    title: string
    members: Record<string, unknown>
    paused?: string
    closed?: boolean
    limits: Record<string, string>
    usage: { tokens: Record<string, number> }
  } = {
    title: 'Demo',
    limits: { budget: '1000' },
    usage: { tokens: { coordinator: 950 } },
    members: {
      coordinator: { role: 'coordinator', last_read_seq: 0 },
      exact: { role: 'worker', model: 'claude-opus-4-6', last_read_seq: 0 },
      scout: { role: 'worker', profile: 'explorer', writes: '0', id: 's1', last_read_seq: 0 },
      fix: { role: 'worker', last_read_seq: 0 },
    },
  }
  const prompts: string[] = []
  const board = [
    JSON.stringify({ seq: 1, agent: 'fix', to: ['coordinator'], text: '@coordinatorVERIFIED', time: '2026-11-16T10:00:00Z' }).replace('@coordinatorVERIFIED', '@coordinator VERIFIED'),
    JSON.stringify({ seq: 2, agent: 'fix', to: ['coordinator'], text: '@coordinator NOT PASSED: line 1', time: '2026-11-16T10:01:00Z' }),
    JSON.stringify({ seq: 3, agent: 'fix', to: ['coordinator'], text: '@coordinator NOT VERIFIED: check failed', time: '2026-11-16T10:02:00Z' }),
  ].join('\n')
  on('command.register', (_, spec) => ({ value: { command: spec.name } }))
  on('tool.register', (_, spec) => ({ value: { tool: `mcp__swarm__${spec.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'fixture-conversation' }))
  on('session.cwd', () => ({ value: '/project' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('prompt.submit', (_, e) => { prompts.push(e.text); return { text: e.text } })
  on('turn.complete', () => ({ text: '' }))
  on('fs.read', (_, e) => ({ value: e.path.endsWith('members.json') ? JSON.stringify(state) : board }))
  on('agent.list', () => ({ value: [{ id: 's1', description: '@scout: explore', type: 'swarm:explorer', status: 'running' }] as never }))
  on('agent.spawn', (_, e) => ({ model: e.model ?? 'sonnet', agentId: 'spawned' }))
  const usage = (fresh: number) => ({ model: 'm', input_tokens: fresh, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 })
  let answered = usage(0)
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use' as const, usage: answered }
  })
  let failReady = false
  on('process.run', (_, e) => {
    const args = e.argv.slice(3)
    if (args[0] === 'restore') return { value: { exitCode: 0, stdout: run, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (args[0] === 'account') {
      const amt = Number(args[3])
      state.usage.tokens.coordinator = (state.usage.tokens.coordinator ?? 0) + amt
      const paused = state.usage.tokens.coordinator >= 1000
      if (paused) state.paused = 'token budget of 1000 spent'
      return { value: { exitCode: 0, stdout: JSON.stringify({ title: 'Demo', total: state.usage.tokens.coordinator, budget: 1000, paused }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (args[0] === 'ready' && failReady) {
      return { value: { exitCode: 1, stdout: '', stderr: 'usage: board.py <dir> ready <agent> <text>\n', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (args[0] === 'show') {
      return { value: { exitCode: 0, stdout: `shown:${args.slice(1).join(' ')}`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (args[0] === 'attention') return { value: { exitCode: 0, stdout: JSON.stringify({ items: [], members: {}, limits: state.limits }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const clock = mock.clock(on)

  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })

  // 1. Conflicting exact model ID of the same family on agent.spawn is denied rather than silently overwritten
  const baseSpawn = {
    tool_use_id: 't1', prompt: 'Use the board.', subagentType: 'swarm:worker',
    provider: { plugin: 'swarm', tier: 'core' as const }, parentModel: 'claude-sonnet-5-5', background: false, fork: false,
  }
  const conflict = await $.agent.spawn({ ...baseSpawn, description: '@exact: test', model: 'claude-opus-4-5' })
  expect(conflict.deny).toContain('The roster has @exact on claude-opus-4-6, but this call would start it on claude-opus-4-5')

  // 2. specialistBoard treats empty member="" as undefined when seq is passed, and translates ready/revise usage errors
  const showSeq = await toolCall($, { tool: 'mcp__swarm__board', tool_use_id: 'b1', agentId: 's1', action: 'show', member: '  ', seq: 2 } as never)
  expect(showSeq.result).toBe('shown:--post=2')
  failReady = true
  const readyErr = await toolCall($, { tool: 'mcp__swarm__board', tool_use_id: 'b2', agentId: 's1', action: 'ready', text: 'done' } as never)
  expect(readyErr.deny).toContain('action "ready" with text')
  failReady = false

  // 3. Budget pause with 1000 tokens (compact = 1k vs raw = 1000) fires only once across account() and subsequent refresh() polls
  answered = usage(60)
  for await (const _ of $.turn.step({ turnId: 'b-1000', index: 0, model: 'm', messageCount: 1 })) { /* no chunks */ }
  await clock.advance(1)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, reason: 'answer', turnId: 'b-1000', usage: usage(60) })
  await clock.advance(15000)
  expect(prompts.filter(p => p.includes('paused')).length).toBe(1)

  // 4. specialistBoard refuses calls when the run is paused or over budget even if halted was not pre-populated
  const pausedCall = await toolCall($, { tool: 'mcp__swarm__board', tool_use_id: 'b3', agentId: 's1', action: 'read' } as never)
  expect(pausedCall.deny).toContain('paused')

  // 5. Board search filter matches multi-word negative kinds (`not passed`, `kind:not passed`, `kind:not-verified`)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'board-search', text: 'not passed' })
  expect(await ui.find({ type: 'Text', text: /#2 ·/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /#1 ·/ })).toBeUndefined()
  await ui.input({ key: 'board-search', text: 'kind:not-verified' })
  expect(await ui.find({ type: 'Text', text: /#3 ·/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /#1 ·/ })).toBeUndefined()
  await ui.input({ key: 'board-search', text: 'verified' })
  expect(await ui.find({ type: 'Text', text: /#1 ·/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /#3 ·/ })).toBeUndefined()
  await ui.unmount()
})

test('an agent outside the roster is not resumed into the run and does not pause its members by spending', async ($, on) => {
  const state = {
    title: 'Demo swarm', limits: { budget: '1000' }, paused: undefined as string | undefined,
    usage: { tokens: { coordinator: 900 } as Record<string, number> },
    members: { coordinator: { role: 'coordinator', last_read_seq: 1 }, parser: { role: 'worker', id: 'a1', last_read_seq: 1 } },
  }
  const { seen, answer, board } = owning(on, {
    board: () => posts({ agent: 'coordinator', to: ['parser'], text: '@parser BRIEF' }),
    roster: () => JSON.stringify(state),
  })
  const clock = mock.clock(on)
  on('process.run', (_, e) => {
    const stdout = board(e)
    if (e.argv[3] !== 'account') return answer(stdout)
    const actor = e.argv[5] ?? ''
    state.usage.tokens[actor] = (state.usage.tokens[actor] ?? 0) + Number(e.argv[6])
    const total = Object.values(state.usage.tokens).reduce((sum, value) => sum + value, 0)
    const paused = !state.paused && total >= 1000
    if (paused) state.paused = 'token budget of 1000 spent'
    return answer(JSON.stringify({ title: state.title, total, budget: 1000, paused }))
  })
  on('agent.list', () => ({ value: [
    { id: 'a1', description: '@parser', type: 'swarm:worker', status: 'running' },
    { id: 'outsider', description: 'Continue previous work', type: 'swarm:worker', status: 'running' },
  ] as never }))
  on('agent.spawn', (_, e) => ({ model: 'sonnet', agentId: e.resume?.agentId ?? 'started' }))
  on('tool.call', () => ({ result: {} }))
  let spent = 0
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use' as const,
      usage: { model: 'm', input_tokens: spent, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }
  })
  const step = async (turnId: string, tokens: number, agentId: string) => {
    spent = tokens
    for await (const _ of $.turn.step({ turnId, index: 0, model: 'm', messageCount: 1, agentId })) { /* no chunks */ }
    await clock.advance(1)
  }
  const accounts = () => seen.commands.filter(command => command.startsWith('account')).length
  const reads = (agentId: string) => toolCall($, { tool: 'Read', file_path: '/project/a.ts', agentId })

  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)
  expect((await reads('a1')).deny).toBeUndefined()

  // An unrelated swarm: agent is not resumed while the run is open: it belongs to no run.
  const resumed = await $.agent.spawn({
    tool_use_id: 'again', prompt: 'Go on.', description: 'Continue previous work', subagentType: 'swarm:worker',
    provider: { plugin: 'swarm', tier: 'core' as const }, parentModel: 'sonnet', background: true, fork: false,
    resume: { agentId: 'outsider' },
  } as never)
  expect(resumed.deny).toContain('is no member of this Swarm run')
  // Still running from before, its model step would cross the budget, were it the run's: nothing is charged and no member is stopped.
  await step('foreign', 200, 'outsider')
  expect(accounts()).toBe(0)
  expect((await reads('a1')).deny).toBeUndefined()
  // A member's step that crosses it stops the members at once, and still not the outsider.
  await step('own', 200, 'a1')
  expect((await reads('a1')).deny).toContain('run is paused')
  expect((await reads('outsider')).deny).toBeUndefined()
})

test('a mention older than the tail of a large board is still delivered', async ($, on) => {
  const state = {
    title: 'Demo swarm',
    members: { coordinator: { role: 'coordinator', last_read_seq: 2000 }, parser: { role: 'worker', id: 'a1', last_read_seq: 0 } },
  }
  const tail = JSON.stringify({ seq: 2000, agent: 'coordinator', to: [], text: 'a later note for nobody', time: '2026-11-16T14:03:22+0100' }) + '\n'
  const { seen, answer, board } = owning(on, { board: () => tail, roster: () => JSON.stringify(state) })
  on('fs.stat', () => ({ value: { size: 5_000_000, mtimeMs: 1 } as never }))
  on('process.run', (_, e) => {
    const stdout = board(e)
    const action = e.argv[3]
    return answer(action === 'tail' ? tail : action === 'wake' ? '@parser a1 through #1\n' : action === 'claim' ? 'a'.repeat(32) : stdout)
  })
  on('agent.list', () => ({ value: [{ id: 'a1', description: '@parser', type: 'swarm:worker', status: 'idle' }] as never }))
  on('tool.call', () => ({ result: {} }))
  const sends: string[] = []
  on('session.send', (_, e) => { sends.push(e.text); return { isDelivered: true } })
  const clock = mock.clock(on)

  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'c', reason: 'answer' })
  await clock.advance(4000)
  expect(seen.commands).toContain('claim parser a1 1')
  expect(sends.join('\n')).toContain('mentions through #1')
  expect(seen.commands).toContain(`woke parser 1 ${'a'.repeat(32)}`)
})

test('a retired member that is still mid-turn has its tool calls refused, and its replacement does not', async ($, on) => {
  const state = {
    title: 'Demo swarm',
    members: {
      coordinator: { role: 'coordinator', last_read_seq: 1 },
      parser: { role: 'worker', id: 'old', killed: '1', last_read_seq: 1 },
      'parser-2': { role: 'worker', id: 'new', last_read_seq: 1 },
    },
  }
  const { answer, board } = owning(on, {
    board: () => posts({ agent: 'coordinator', to: ['parser-2'], text: '@parser-2 BRIEF' }),
    roster: () => JSON.stringify(state),
  })
  on('process.run', (_, e) => answer(board(e)))
  on('agent.list', () => ({ value: [
    { id: 'old', description: '@parser', type: 'swarm:worker', status: 'running' },
    { id: 'new', description: '@parser-2', type: 'swarm:worker', status: 'running' },
  ] as never }))
  on('tool.call', () => ({ result: {} }))
  const clock = mock.clock(on)

  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)
  expect((await toolCall($, { tool: 'Bash', command: './test.sh', agentId: 'old' })).deny).toContain('has been retired')
  expect((await toolCall($, { tool: 'Bash', command: './test.sh', agentId: 'new' })).deny).toBeUndefined()
  expect((await toolCall($, { tool: 'Bash', command: 'ls' })).deny).toBeUndefined()
})

test('a replacement is not started while the member it replaces is still running', async ($, on) => {
  const state = {
    title: 'Demo swarm',
    members: {
      coordinator: { role: 'coordinator', last_read_seq: 1 },
      parser: { role: 'worker', id: 'old', killed: '1', replaced_by: 'parser-2', last_read_seq: 1 },
      'parser-2': { role: 'worker', last_read_seq: 1 },
    },
  }
  const { answer, board } = owning(on, {
    board: () => posts({ agent: 'coordinator', to: ['parser-2'], text: '@parser-2 BRIEF' }),
    roster: () => JSON.stringify(state),
  })
  on('process.run', (_, e) => answer(board(e)))
  let status = 'running'
  on('agent.list', () => ({ value: [{ id: 'old', description: '@parser', type: 'swarm:worker', status }] as never }))
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'new' }))
  on('tool.call', () => ({ result: {} }))
  const clock = mock.clock(on)
  const start = () => $.agent.spawn({
    tool_use_id: 'successor', prompt: 'Use the board.', description: '@parser-2: take over', subagentType: 'swarm:worker',
    provider: { plugin: 'swarm', tier: 'core' as const }, parentModel: 'sonnet', background: true, fork: false,
  })

  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)
  const held = await start()
  expect(held.deny).toContain('@parser, which @parser-2 replaces, is still running as agent old')
  status = 'completed'
  const started = await start()
  expect(started.deny).toBeUndefined()
  expect(started.agentId).toBe('new')
})

test('hardening: native retired enforcement, immediate sync after coordinator commands, and zombie replace notice', async ($, on) => {
  const state: Record<string, unknown> = {
    title: 'Native swarm',
    members: {
      coordinator: { role: 'coordinator', backend: 'native', last_read_seq: 1 },
      parser: { role: 'worker', id: 'parser@demo', killed: '1', last_read_seq: 1 },
      worker: { role: 'worker', id: 'w-1', last_read_seq: 1 },
    },
  }
  const { answer, board } = owning(on, {
    board: () => posts({ agent: 'coordinator', to: ['worker'], text: '@worker BRIEF' }),
    roster: () => JSON.stringify(state),
  })
  on('process.run', (_, e) => answer(board(e)))
  on('agent.list', () => ({
    value: [
      { id: 'tm-1', teammateId: 'parser@demo', description: '@parser', type: 'swarm:worker', status: 'waiting' },
      { id: 'w-1', description: '@worker', type: 'swarm:worker', status: 'waiting' },
    ] as never,
  }))
  on('tool.call', (_, e) => {
    if (e.tool === 'Bash' && String(e.command).includes('replace')) {
      const members = state.members as Record<string, Record<string, unknown>>
      members.worker = { ...members.worker, killed: '1', replaced_by: 'worker-2' }
      members['worker-2'] = { role: 'worker', last_read_seq: 1 }
    }
    return { result: {} }
  })
  mock.clock(on)

  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  // Binding via read immediately populates retired (including native teammate id) before any poll.
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  expect((await toolCall($, { tool: 'Bash', command: 'echo hi', agentId: 'tm-1' })).deny).toContain('has been retired')

  // Coordinator replace immediately syncs retired and attaches zombie notice when w-1 is waiting.
  const rep = await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" replace worker worker-2` })
  expect(rep.context?.join('\n')).toContain('@worker was retired, but agent w-1 is still waiting')
  expect((await toolCall($, { tool: 'Bash', command: 'echo hi', agentId: 'w-1' })).deny).toContain('has been retired')
})

test('hardening: transitive predecessor chain, overlapping paths, spawnIsolations, and exact model guidance', async ($, on) => {
  const startedCalls: string[][] = []
  const state = {
    title: 'Chain swarm',
    members: {
      coordinator: { role: 'coordinator', last_read_seq: 1 },
      a: { role: 'worker', id: 'a-old', killed: '1', replaced_by: 'a-2', last_read_seq: 1 },
      'a-2': { role: 'worker', killed: '1', replaced_by: 'a-3', last_read_seq: 1 },
      'a-3': { role: 'worker', last_read_seq: 1 },
      x: { role: 'worker', id: 'x-old', killed: '1', paths: 'src/api', last_read_seq: 1 },
      y: { role: 'worker', paths: 'src/api/routes.ts', last_read_seq: 1 },
      wt: { role: 'worker', last_read_seq: 1 },
      exact: { role: 'worker', model: 'claude-opus-4-6', last_read_seq: 1 },
    },
  }
  const { answer, board } = owning(on, {
    board: () => posts({ agent: 'coordinator', to: ['wt'], text: '@wt BRIEF' }),
    roster: () => JSON.stringify(state),
  })
  on('process.run', (_, e) => {
    if (e.argv.includes('started')) startedCalls.push([...e.argv.slice(4)])
    return answer(board(e))
  })
  on('agent.list', () => ({
    value: [
      { id: 'a-old', description: '@a', type: 'swarm:worker', status: 'waiting' },
      { id: 'x-old', description: '@x', type: 'swarm:worker', status: 'running' },
    ] as never,
  }))
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'wt-1' }))
  let wtSpawn: Awaited<ReturnType<typeof $.agent.spawn>> | undefined
  on('tool.call', async (_, e) => {
    if (e.tool === 'Agent' && e.tool_use_id === 'wt-call') {
      wtSpawn = await $.agent.spawn({
        tool_use_id: 'wt-call', prompt: 'Use the board.', description: '@wt: go', subagentType: 'swarm:worker',
        provider: { plugin: 'swarm', tier: 'core' as const }, parentModel: 'sonnet', background: true, fork: false,
      })
    }
    return { result: {} }
  })
  mock.clock(on)

  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })

  // Transitive chain a -> a-2 -> a-3 blocked while a-old is waiting.
  const chainDeny = await $.agent.spawn({
    tool_use_id: 't1', prompt: 'Use the board.', description: '@a-3: go', subagentType: 'swarm:worker',
    provider: { plugin: 'swarm', tier: 'core' as const }, parentModel: 'sonnet', background: true, fork: false,
  })
  expect(chainDeny.deny).toContain('@a, which @a-3 replaces, is still waiting as agent a-old')

  // Overlapping paths with killed x-old still running blocks y.
  const pathDeny = await $.agent.spawn({
    tool_use_id: 't2', prompt: 'Use the board.', description: '@y: go', subagentType: 'swarm:worker',
    provider: { plugin: 'swarm', tier: 'core' as const }, parentModel: 'sonnet', background: true, fork: false,
  })
  expect(pathDeny.deny).toContain('@x, which previously owned overlapping paths, is still running as agent x-old')

  // Exact model guidance does not tell coordinator to pass exact ID.
  const modelDeny = await $.agent.spawn({
    tool_use_id: 't3', prompt: 'Use the board.', description: '@exact: go', model: 'sonnet', subagentType: 'swarm:worker',
    provider: { plugin: 'swarm', tier: 'core' as const }, parentModel: 'sonnet', background: true, fork: false,
  })
  expect(modelDeny.deny).toContain('Omit model or pass model: "opus" on the Agent call')

  // spawnIsolations passes isolated=1 for worktree.
  await toolCall($, {
    tool: 'Agent', tool_use_id: 'wt-call', subagent_type: 'swarm:worker', description: '@wt: go',
    prompt: 'Use the board.', isolation: 'worktree',
  })
  expect(wtSpawn?.agentId).toBe('wt-1')
  expect(startedCalls.at(-1)).toEqual(['wt', 'wt-1', '', 'isolated=1'])
})

test('hardening: runtime file edit guards, shared git commit guard, coordinator bg/Monitor guard, and READY question grace', async ($, on) => {
  const boardLines = posts(
    { agent: 'coordinator', to: ['alice', 'bob', 'ver'], text: '@alice @bob @ver BRIEF' },
    { agent: 'alice', to: ['coordinator'], text: '@coordinator READY: done, should we deploy?' },
  )
  const state = {
    title: 'Guard swarm',
    members: {
      coordinator: { role: 'coordinator', last_read_seq: 1 },
      alice: { role: 'worker', id: 'alice-1', paths: 'src/alice', isolated: '0', last_read_seq: 1 },
      bob: { role: 'worker', id: 'bob-1', paths: 'src/bob', isolated: '1', last_read_seq: 1 },
      ver: { role: 'verifier', id: 'ver-1', last_read_seq: 1 },
    },
  }
  const { answer, board, seen } = owning(on, {
    board: () => boardLines,
    roster: () => JSON.stringify(state),
  })
  on('process.run', (_, e) => answer(board(e)))
  on('agent.list', () => ({
    value: [
      { id: 'alice-1', description: '@alice', type: 'swarm:worker', status: 'running' },
      { id: 'bob-1', description: '@bob', type: 'swarm:worker', status: 'running' },
      { id: 'ver-1', description: '@ver', type: 'swarm:verifier', status: 'running' },
    ] as never,
  }))
  on('tool.call', () => ({ result: {} }))
  const clock = mock.clock(on)

  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)

  // File edit guards inside cwd
  expect((await toolCall($, { tool: 'Edit', file_path: '/project/.swarm/r/board.jsonl', old_string: 'a', new_string: 'b', agentId: 'alice-1' })).deny).toContain('.swarm/')
  expect((await toolCall($, { tool: 'Write', file_path: '/project/src/alice/a.ts', content: 'x', agentId: 'ver-1' })).deny).toContain('read-only')
  expect((await toolCall($, { tool: 'Edit', file_path: '/project/src/bob/b.ts', old_string: 'a', new_string: 'b', agentId: 'alice-1' })).deny).toContain('claimed by @bob')
  expect((await toolCall($, { tool: 'Edit', file_path: '/project/README.md', old_string: 'a', new_string: 'b', agentId: 'alice-1' })).deny).toContain('claimed paths')
  expect((await toolCall($, { tool: 'Edit', file_path: '/project/src/alice/a.ts', old_string: 'a', new_string: 'b', agentId: 'alice-1' })).deny).toBeUndefined()
  // Outside cwd (/tmp and worktrees) are untouched
  expect((await toolCall($, { tool: 'Write', file_path: '/tmp/design.html', content: '<html/>', agentId: 'ver-1' })).deny).toBeUndefined()
  expect((await toolCall($, { tool: 'Edit', file_path: '/worktrees/wt1/src/bob/b.ts', old_string: 'a', new_string: 'b', agentId: 'bob-1' })).deny).toBeUndefined()

  // A wait on a substring process match is refused; an exact one runs
  expect((await toolCall($, { tool: 'Bash', command: 'while pgrep -f xcodebuild >/dev/null; do sleep 10; done', agentId: 'alice-1' })).deny).toContain('pgrep -x NAME')
  expect((await toolCall($, { tool: 'Bash', command: 'while pgrep -x xcodebuild >/dev/null; do sleep 10; done', agentId: 'alice-1' })).deny).toBeUndefined()

  // Shared git commit guard
  for (const command of ['git -C . commit', 'cd . && git commit', 'cd /tmp/wt && git -C /project commit']) {
    expect((await toolCall($, { tool: 'Bash', command, agentId: 'alice-1' })).deny).toContain('Shared-checkout writers')
  }
  expect((await toolCall($, { tool: 'Bash', command: 'git commit -m "wip"', agentId: 'alice-1' })).deny).toContain('Shared-checkout writers must not run `git commit`')
  expect((await toolCall($, { tool: 'Bash', command: 'git -C /tmp/wt commit -m "wip"', agentId: 'alice-1' })).deny).toBeUndefined()
  expect((await toolCall($, { tool: 'Bash', command: 'cd /tmp/wt && git commit -m "wip"', agentId: 'alice-1' })).deny).toBeUndefined()
  expect((await toolCall($, { tool: 'Bash', command: 'git commit -m "wip"', agentId: 'bob-1' })).deny).toBeUndefined()

  // Coordinator Monitor & background Bash guards
  expect((await toolCall($, { tool: 'Monitor', command: 'tail -f log' } as never)).deny).toContain('Monitor')
  expect((await toolCall($, { tool: 'Bash', command: 'sleep 10 && echo hi', run_in_background: true })).deny).toContain('background watcher')
  const bgOk = await toolCall($, { tool: 'Bash', command: 'bun test', run_in_background: true })
  expect(bgOk.deny).toBeUndefined()
  expect(bgOk.context?.join('\n')).toContain('wake the coordinator')

  // READY with unquoted '?' is NOT delayed 10 minutes (delivered after 10s MENTION_GRACE_MS)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'coord-turn', reason: 'answer' })
  await clock.advance(12_000)
  expect(seen.prompts.some(t => t.includes('board post'))).toBe(true)
})

test('guard regressions: commit wrappers, worktree paths, ignored claims, case, and fail-closed', async ($, on) => {
  const state = {
    title: 'Guard swarm',
    members: {
      coordinator: { role: 'coordinator', last_read_seq: 1 },
      alice: { role: 'worker', id: 'alice-1', paths: 'src/alice,notes,Shared', isolated: '0', last_read_seq: 1 },
      bob: { role: 'worker', id: 'bob-1', paths: 'src/bob', isolated: '1', last_read_seq: 1 },
      dan: { role: 'worker', id: 'dan-1', paths: 'Docs', isolated: '0', last_read_seq: 1 },
      exp: { role: 'worker', id: 'exp-1', paths: 'notes', profile: 'explorer', writes: '0', last_read_seq: 1 },
      cons: { role: 'worker', id: 'cons-1', paths: 'src/alice/c', consult: '1', last_read_seq: 1 },
    },
  }
  let lookupFails = false
  let lookupExits = false
  const { answer, board } = owning(on, {
    board: () => posts({ agent: 'coordinator', to: ['alice'], text: '@alice BRIEF' }),
    read: path => (path === '/project/.claude/worktrees/w/.git' ? 'gitdir: /project/.git/worktrees/w\n' : undefined),
    roster: () => {
      if (lookupFails) throw new Error('roster unreadable')
      return JSON.stringify(state)
    },
  })
  on('process.run', async (_, e) => {
    if (lookupFails && e.argv.includes('agent-run')) throw new Error('lookup failed')
    if (lookupExits && e.argv.includes('agent-run')) return { value: { exitCode: 1, stdout: '', stderr: 'roster unreadable', isStdoutTruncated: false, isStderrTruncated: false } }
    return answer(board(e))
  })
  on('agent.list', () => ({
    value: ['alice', 'bob', 'dan', 'exp', 'cons'].map(n => ({ id: `${n}-1`, description: `@${n}`, type: 'swarm:worker', status: 'running' })) as never,
  }))
  on('tool.call', () => ({ result: {} }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)
  const bash = (command: string, agentId = 'alice-1') => toolCall($, { tool: 'Bash', command, agentId })
  const edit = (file_path: string, agentId = 'alice-1') => toolCall($, { tool: 'Edit', file_path, old_string: 'a', new_string: 'b', agentId })

  // R1/R8: commit guard sees through wrappers, multi-line commands, subdirectories and background operators.
  for (const command of [
    'git commit -m "$(cat <<\'EOF\'\nmsg\nEOF\n)"',
    'cat <<< "x"\ngit commit -m wip',
    "# don't push\ngit commit -m wip",
    'sleep 1 & git commit -m x',
    'cd src && git commit -m x',
    'git -C src commit',
    '(cd src && git commit -m x)',
    'env git commit -m x',
    'if true; then git commit -m x; fi',
    'time git commit -m x',
  ]) {
    expect((await bash(command)).deny, command).toContain('Shared-checkout writers')
  }
  expect((await bash('git -C /tmp/wt commit -m x')).deny).toBeUndefined()
  expect((await bash('cd /tmp/wt && git commit -m x')).deny).toBeUndefined()
  expect((await bash('git -C /project/.claude/worktrees/w commit -m x')).deny).toBeUndefined()
  expect((await bash('cd .claude/worktrees/w/src && git commit -m x')).deny).toBeUndefined()
  // A plain folder under .claude/worktrees is not a worktree: git commits to the main checkout from it.
  expect((await bash('cd .claude/worktrees/plain && git commit -m x')).deny).toContain('Shared-checkout writers')
  // A cd that failed, or one kept inside a subshell, pipeline or background job, leaves the commit in the checkout.
  for (const command of [
    'command cd /tmp/swarm-missing || git commit -m wip',
    'cd /tmp/wt && git commit -m x || git commit -m y',
    'cd /tmp/wt; git commit -m x',
    '(cd /tmp/wt); git commit -m wip',
    '(cd /tmp/wt) && git commit -m wip',
    'cd /tmp/wt | true; git commit -m wip',
    'cd /tmp/wt & git commit -m wip',
    '! cd /tmp/wt && git commit -m wip',
  ]) {
    expect((await bash(command)).deny, command).toContain('Shared-checkout writers')
  }
  for (const command of ['(cd /tmp/wt && git commit -m x)', 'cd /tmp/wt || exit 1; git commit -m x', '{ cd /tmp/wt && git commit -m x; }']) {
    expect((await bash(command)).deny, command).toBeUndefined()
  }
  expect((await bash('git -C /project/.claude/worktrees/plain/sub commit -m x')).deny).toContain('Shared-checkout writers')
  expect((await bash('git commit -m x', 'bob-1')).deny).toBeUndefined()

  // R2: an isolated writer's paths= match inside its own worktree.
  expect((await edit('/project/.claude/worktrees/agent-bob-1/src/bob/b.ts', 'bob-1')).deny).toBeUndefined()
  expect((await edit('/project/.claude/worktrees/agent-bob-1/src/alice/a.ts', 'bob-1')).deny).toContain('claimed by @alice')
  expect((await edit('/project/.claude/worktrees/agent-bob-1/.swarm/x', 'bob-1')).deny).toContain('.swarm/')

  // R3: read-only, consult and other ignored members hold no claim.
  expect((await edit('/project/notes/n.md')).deny).toBeUndefined()
  expect((await edit('/project/src/alice/c/x.ts')).deny).toBeUndefined()
  // R7: path claims compare case-insensitively.
  expect((await edit('/project/docs/d.md')).deny).toContain('claimed by @dan')
  expect((await edit('/project/shared/s.md', 'dan-1')).deny).toContain('claimed by @alice')

  // R4: a guard that throws (a malformed roster entry) refuses edits but lets board commands through.
  const alice = state.members.alice as Record<string, unknown>
  alice.paths = 5
  await bash(`python3 /p/board.py "${OWNED}" read alice`)
  await clock.advance(5000)
  expect((await edit('/project/src/alice/a.ts')).deny).toContain('could not check')
  expect((await bash(`python3 /p/board.py "${OWNED}" read alice`)).deny).toBeUndefined()
  alice.paths = 'src/alice,notes,Shared'

  // R4: a failed run lookup for a member the roster names (not yet cached) also fails closed.
  // A member the owned roster names keeps its guard when the run lookup throws or exits with an error.
  for (const fail of [() => { lookupFails = true }, () => { lookupExits = true }]) {
    fail()
    expect((await edit('/project/src/bob/b.ts', 'exp-1')).deny).toContain('read-only')
    expect((await bash('git commit -m x')).deny).toContain('Shared-checkout writers')
    expect((await bash(`python3 /p/board.py "${OWNED}" read exp`, 'exp-1')).deny).toBeUndefined()
    lookupFails = lookupExits = false
  }
})

test('a retired member whose build is still running in its worktree is reported with the processes to stop', async ($, on) => {
  const state = {
    title: 'Demo swarm',
    members: {
      coordinator: { role: 'coordinator', last_read_seq: 1 },
      parser: { role: 'worker', id: 'a1b2', isolated: '1', last_read_seq: 1 } as Record<string, unknown>,
      shared: { role: 'worker', id: 'c3d4', isolated: '0', last_read_seq: 1 } as Record<string, unknown>,
    },
  }
  const { answer, board } = owning(on, {
    board: () => posts({ agent: 'coordinator', to: ['parser'], text: '@parser BRIEF' }),
    roster: () => JSON.stringify(state),
  })
  on('process.run', (_, e) => {
    if (e.argv[0] === 'lsof') {
      return answer('p101\nn/project\np202\nn/project/.claude/worktrees/agent-a1b2/Tests\np303\nn/project/.claude/worktrees/agent-a1b2c3\np404\nn/project/.claude/worktrees/agent-a1b2\n')
    }
    if (e.argv[0] === 'ps') return answer(e.argv.at(-1) === '202,404' ? '  202 /usr/bin/xcodebuild\n  404 /bin/zsh\n' : '')
    return answer(board(e))
  })
  // the agent itself has ended: only what it launched is left
  on('agent.list', () => ({ value: [] }))
  on('tool.call', (_, e) => {
    const retiring = e.tool === 'Bash' ? /(?:member (parser|shared) killed=1|replace (shared) )/.exec(String(e.command))?.slice(1).find(Boolean) as 'parser' | 'shared' | undefined : undefined
    if (retiring) state.members[retiring].killed = '1'
    return { result: {} }
  })
  mock.clock(on)

  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  const gone = await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" member parser killed=1` })
  expect(gone.context?.join('\n')).toContain('@parser was retired, but 2 processes it started are still running in its worktree: 202 (xcodebuild), 404 (zsh)')
  expect(gone.context?.join('\n')).toContain('kill 202 404')
  expect(gone.context?.join('\n')).not.toContain('303')
  // a shared writer's build cannot be attributed: said when it is replaced, and not when it is simply removed
  const removed = await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" member shared killed=1` })
  expect(removed.context?.join('\n') ?? '').not.toContain('@shared was retired')
  const other = await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" replace shared shared-2` })
  expect(other.context?.join('\n')).toContain('@shared was retired. A build or test it started in the shared folder cannot be told')
})

test('a member whose agent ended without a report is flagged while others work, and the coordinator hears once', async ($, on) => {
  const state = {
    title: 'Demo swarm',
    members: {
      coordinator: { role: 'coordinator', last_read_seq: 4 },
      quiet: { role: 'worker', id: 'q1', last_read_seq: 1 },
      asker: { role: 'worker', id: 'k1', last_read_seq: 2 },
      busy: { role: 'worker', id: 'b1', last_read_seq: 3 },
      done: { role: 'worker', id: 'd1', last_read_seq: 4 },
    },
  }
  const hint = (ready = false) => ({ type: 'worker', model: 'sonnet', effort: 'medium', depends: [], owns: '', ready, blocked_on: [], asked: 0, unreachable: false })
  const { seen, answer, board } = owning(on, {
    board: () => posts(
      { agent: 'coordinator', to: ['quiet'], text: '@quiet BRIEF' },
      { agent: 'coordinator', to: ['asker'], text: '@asker BRIEF' },
      { agent: 'coordinator', to: ['busy'], text: '@busy BRIEF' },
      { agent: 'coordinator', to: ['done'], text: '@done BRIEF' },
      { agent: 'asker', to: ['coordinator'], text: '@coordinator which file?' },
      { agent: 'done', to: ['coordinator'], text: 'READY\nall done' },
    ),
    roster: () => JSON.stringify(state),
  })
  on('process.run', (_, e) => {
    const stdout = board(e)
    return answer(e.argv[3] === 'attention'
      ? JSON.stringify({
        items: [{ kind: 'question', member: 'coordinator', seq: 5, text: '@asker asked @coordinator in #5 and has no answer.' }],
        members: { quiet: hint(), asker: hint(), busy: hint(), done: hint(true) },
      })
      : stdout)
  })
  // quiet, asker and done have ended; busy is still at work
  on('agent.list', () => ({ value: [
    { id: 'q1', description: '@quiet', type: 'swarm:worker', status: 'completed' },
    { id: 'k1', description: '@asker', type: 'swarm:worker', status: 'completed' },
    { id: 'b1', description: '@busy', type: 'swarm:worker', status: 'running' },
    { id: 'd1', description: '@done', type: 'swarm:worker', status: 'completed' },
  ] as never }))
  on('tool.call', () => ({ result: {} }))
  const clock = mock.clock(on)
  const told = async () => (await toolCall($, { tool: 'Bash', command: 'ls' })).context?.join('\n') ?? ''

  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)
  // a turn may have just ended: nothing is said within the first minute
  expect(await told()).not.toContain('stopped without reporting')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-attention' })
  expect(await ui.find({ type: 'Text', text: /@quiet stopped without reporting/ })).toBeDefined()
  // any item can be put in front of the coordinator from the pane: a post it ignored, and a member that went quiet
  expect((await ui.find({ key: 'attention-ask-question-coordinator-5' }))?.props.label).toBe('Tell coordinator')
  await ui.press({ key: 'attention-ask-question-coordinator-5' })
  expect(seen.prompts.at(-1)).toContain('Swarm: Needs your attention\n@asker asked @coordinator in #5 and has no answer. It is board post #5: read it with the board\'s show --post=5.')
  expect((await ui.find({ key: 'attention-ask-silent-quiet-1' }))?.props.label).toBe('Ask coordinator to handle')
  await ui.press({ key: 'attention-ask-silent-quiet-1' })
  expect(seen.prompts.at(-1)).toContain('@quiet stopped without reporting')
  await ui.unmount()
  await clock.advance(62_000)
  const notice = await told()
  expect(notice).toContain('@quiet stopped without reporting: its agent ended after reading #1')
  // a member that asked, one that is still working and one that reported are not flagged
  expect(notice).not.toMatch(/@(asker|busy|done) stopped/)
  await clock.advance(62_000)
  expect(await told()).not.toContain('stopped without reporting')
})

// The tests below are named for the findings of the 2026-11-21 bug analysis they pin. They run on the test kit's
// engine, not a live one.

test('F3: the shared-checkout commit guard reads a commit however it is quoted, wrapped, nested or pointed elsewhere', async ($, on) => {
  const state = {
    title: 'Guard swarm',
    members: {
      coordinator: { role: 'coordinator', last_read_seq: 1 },
      alice: { role: 'worker', id: 'alice-1', paths: 'src/alice', isolated: '0', last_read_seq: 1 },
    },
  }
  const { answer, board } = owning(on, {
    board: () => posts({ agent: 'coordinator', to: ['alice'], text: '@alice BRIEF' }),
    read: path => (path === '/project/.claude/worktrees/w/.git' ? 'gitdir: /project/.git/worktrees/w\n' : undefined),
    roster: () => JSON.stringify(state),
  })
  on('process.run', (_, e) => answer(board(e)))
  on('agent.list', () => ({ value: [{ id: 'alice-1', description: '@alice', type: 'swarm:worker', status: 'running' }] as never }))
  on('tool.call', () => ({ result: {} }))
  // /link is another name for the checkout
  on('fs.stat', (_, e) => {
    if (e.path === '/link' || e.path === '/project') return { value: { realPath: '/project' } as never }
    throw new Error('ENOENT')
  })
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)
  const bash = (command: string) => toolCall($, { tool: 'Bash', command, agentId: 'alice-1' })
  for (const command of [
    // quoted and escaped words
    '"git" commit -m x', '\\git commit -m x', 'git "commit" -m x', "'git' 'commit'", '/usr/bin/git commit',
    // keywords and prefixes before the command
    'if git commit -m wip; then true; fi', 'while git commit -m x; do :; done', 'until git commit -m x; do :; done',
    'FOO=1 env git commit -m x', 'true; elif git commit; then :',
    // a repository named some other way than by the folder
    'cd /tmp/wt && git --git-dir /project/.git commit -m x', 'cd /tmp/wt && git --git-dir=/project/.git --work-tree=/project commit',
    'cd /tmp/wt && GIT_DIR=/project/.git git commit -m x', 'GIT_WORK_TREE=/project git -C /tmp/wt commit',
    // a folder that cannot be followed
    'cd -P src && git commit', 'cd /tmp/wt && cd - && git commit -m x', 'pushd src && git commit', 'cd /tmp/wt; popd; git commit -m x',
    // the checkout by another name
    'cd /link && git commit -m x', 'git -C /link/src commit',
    // commands inside substitutions, arithmetic and nested shells
    'echo "$(git commit -m x)"', 'x=`git commit -m x`', 'echo $((1 + $(git commit -m x | wc -l)))', 'diff <(git commit -m x) /dev/null',
    'echo "$(cd /tmp/wt; true)" && git commit -m "a; b"', 'bash -c "git commit -m x"', "sh -lc 'cd src && git commit'", 'eval "git commit -m x"',
    // what used to throw the scanner off the next line
    '(( 1 << 4 ))\ngit commit -m wip', "echo $'\\'' && git commit -m wip", "cat <<'EO'F\nbody\nEOF\ngit commit -m wip",
  ]) {
    expect((await bash(command)).deny, command).toContain('Shared-checkout writers')
  }
  for (const command of [
    'cd -P /tmp/wt && git commit -m x', 'pushd /tmp/wt && git commit', 'echo "$(cd /tmp/wt && git commit -m x)"',
    'bash -c "cd /tmp/wt && git commit -m x"', 'git log --grep commit', 'echo git commit', 'echo "git commit"',
    "echo '$(git commit)'", "cat <<'EOF'\ngit commit -m x\nEOF", 'git -C /project/.claude/worktrees/w commit -m x',
    '(( 1 << 4 ))\ngit status',
  ]) {
    expect((await bash(command)).deny, command).toBeUndefined()
  }
})

test('F4, F25, F28: an isolated member is guarded in its worktree wherever the coordinator runs, and only in its own', async ($, on) => {
  const state = {
    title: 'Guard swarm',
    members: {
      coordinator: { role: 'coordinator', last_read_seq: 1 },
      alice: { role: 'worker', id: 'alice-1', paths: 'src/alice', isolated: '0', last_read_seq: 1 },
      bob: { role: 'worker', id: 'bob-1', paths: 'src/bob', isolated: '1', last_read_seq: 1 },
      carol: { role: 'worker', id: 'carol-1', paths: 'src/carol', isolated: '1', last_read_seq: 1 },
      ver: { role: 'verifier', id: 'ver-1', last_read_seq: 1 },
      exp: { role: 'worker', id: 'exp-1', profile: 'explorer', writes: '0', last_read_seq: 1 },
    },
  }
  const { answer, board } = owning(on, {
    board: () => posts({ agent: 'coordinator', to: ['alice'], text: '@alice BRIEF' }),
    // the coordinator's own conversation runs in a worktree of the main checkout
    read: path => (path === '/project/.git' ? 'gitdir: /main/.git/worktrees/coordinator\n' : undefined),
    roster: () => JSON.stringify(state),
  })
  on('process.run', (_, e) => answer(board(e)))
  on('agent.list', () => ({
    value: ['alice', 'bob', 'carol', 'ver', 'exp'].map(n => ({ id: `${n}-1`, description: `@${n}`, type: n === 'ver' ? 'swarm:verifier' : n === 'exp' ? 'swarm:explorer' : 'swarm:worker', status: 'running' })) as never,
  }))
  on('tool.call', () => ({ result: {} }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)
  const edit = async (file_path: string, agentId: string) => (await toolCall($, { tool: 'Edit', file_path, old_string: 'a', new_string: 'b', agentId })).deny
  const own = '/main/.claude/worktrees/agent-bob-1'
  // F4: beside the coordinator's worktree, under the main checkout, the roster's rules still hold
  expect(await edit(`${own}/src/bob/b.ts`, 'bob-1')).toBeUndefined()
  expect(await edit(`${own}/src/alice/a.ts`, 'bob-1')).toContain('claimed by @alice')
  expect(await edit(`${own}/README.md`, 'bob-1')).toContain('claimed paths')
  expect(await edit(`${own}/src/bob/b.ts`, 'ver-1')).toContain('read-only')
  // CR3-3: the main checkout itself is blocked for isolated writers even from a linked worktree; unrelated folders stay outside
  expect(await edit('/main/src/bob/b.ts', 'bob-1')).toContain('isolated to its own worktree')
  expect(await edit('/elsewhere/.claude/worktrees/agent-bob-1/README.md', 'bob-1')).toBeUndefined()
  // F28: a worker has the board command, a specialist the board tool
  expect(await edit(`${own}/.swarm/x`, 'bob-1')).toBe('Direct edits inside .swarm/ are not allowed. Read and post with the board tool, or the board command (board.py) in Bash.')
  expect(await edit('/project/.swarm/x', 'exp-1')).toBe('Direct edits inside .swarm/ are not allowed. Use the board tool to read or post.')
  // F25: a worktree is edited by its own member only
  expect(await edit('/project/.claude/worktrees/bob/src/alice/a.ts', 'alice-1')).toContain("cannot edit inside another member's worktree")
  expect(await edit('/main/.claude/worktrees/agent-carol-1/src/bob/b.ts', 'bob-1')).toContain("cannot edit inside @carol's worktree")
  expect(await edit('/main/.claude/worktrees/agent-carol-1/src/carol/c.ts', 'carol-1')).toBeUndefined()
})

test('F25: a pause typed for a run this conversation does not own halts nobody here', async ($, on) => {
  const other = '/project/.swarm/other-20261116-101010'
  const { answer, board } = owning(on, {
    board: () => '',
    roster: () => JSON.stringify({ title: 'Other', paused: 'by its own coordinator', members: { coordinator: { role: 'coordinator', last_read_seq: 0 }, zed: { role: 'worker', id: 'zed-1', last_read_seq: 0 } } }),
  })
  on('process.run', (_, e) => answer(e.argv[3] === 'agent-run' ? other : board(e)))
  on('agent.list', () => ({ value: [{ id: 'zed-1', description: '@zed', type: 'swarm:worker', status: 'running' }] as never }))
  on('tool.call', () => ({ result: {} }))
  mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${other}" pause` })
  expect((await toolCall($, { tool: 'Read', file_path: '/project/a.ts', agentId: 'zed-1' } as never)).deny).toBeUndefined()
})

test('F5: Show earlier in a member conversation still works after a poll', async ($, on) => {
  const { answer, board } = owning(on, { board: () => BOARD, roster: () => ROSTER })
  on('process.run', (_, e) => answer(board(e)))
  on('tool.call', () => ({ result: {} }))
  on('agent.list', () => ({ value: [{ id: 'a1', description: '@parser', type: 'swarm:worker', status: 'running' }] as never }))
  on('ui.view', () => ({ value: { deny: 'no main view here' } }))
  const said = Array.from({ length: 30 }, (_, i) => ({ role: 'assistant', text: `step ${i} ${'word '.repeat(60)}`, toolUses: [] }))
  on('session.messages', () => ({ value: said as never }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-members' })
  await ui.press({ key: 'view-parser' })
  // two polls read the same rows again: what is drawn is still what is open
  await clock.advance(4000)
  const before = (await ui.findAll({ type: 'Markdown' })).length
  expect(before).toBeLessThan(30)
  await ui.press({ key: 'talk-earlier' })
  expect((await ui.findAll({ type: 'Markdown' })).length).toBe(before + 6)
  await clock.advance(2000)
  await ui.press({ key: 'talk-earlier' })
  expect((await ui.findAll({ type: 'Markdown' })).length).toBe(before + 12)
  await ui.unmount()
})

test('F6: a run folder that is deleted takes its pause and its retired members with it', async ($, on) => {
  let isGone = false
  const { answer, board } = owning(on, {
    board: () => posts({ agent: 'coordinator', to: ['parser'], text: '@parser BRIEF' }),
    roster: () => {
      if (isGone) throw new Error('ENOENT')
      return JSON.stringify({ title: 'Doomed', paused: 'awaiting the user', members: {
        coordinator: { role: 'coordinator', last_read_seq: 1 },
        parser: { role: 'worker', id: 'a1', last_read_seq: 1 },
        old: { role: 'worker', id: 'a0', killed: '1', last_read_seq: 1 },
      } })
    },
  })
  on('process.run', (_, e) => answer(board(e)))
  on('agent.list', () => ({ value: [
    { id: 'a1', description: '@parser', type: 'swarm:worker', status: 'running' },
    { id: 'a0', description: '@old', type: 'swarm:worker', status: 'running' },
  ] as never }))
  on('tool.call', () => ({ result: {} }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)
  const read = async (agentId: string) => (await toolCall($, { tool: 'Read', file_path: '/project/a.ts', agentId } as never)).deny
  expect(await read('a1')).toContain('paused (awaiting the user)')
  expect(await read('a0')).toContain('has been retired')
  isGone = true
  await clock.advance(2000)
  expect(await read('a1')).toBeUndefined()
  expect(await read('a0')).toBeUndefined()
})

test('F24: the Board filter finds @all and group posts, and a kind is a whole word', async ($, on) => {
  const roster = JSON.stringify({ title: 'Demo swarm', members: {
    coordinator: { role: 'coordinator', last_read_seq: 9 },
    parser: { role: 'worker', id: 'a1', group: 'backend', last_read_seq: 9 },
    lexer: { role: 'worker', id: 'a2', group: 'backend', last_read_seq: 9 },
    verifier: { role: 'verifier', id: 'a3', last_read_seq: 9 },
  } })
  const lines = posts(
    { agent: 'coordinator', to: ['parser', 'lexer', 'verifier'], text: '@all stand by for the plan' },
    { agent: 'coordinator', to: ['parser', 'lexer'], text: '@backend the schema changed' },
    { agent: 'verifier', to: ['parser'], text: '@parser NOT PASSED: an extra line fails' },
    { agent: 'parser', to: ['coordinator'], text: '@coordinator a note that says `@all` in code' },
    { agent: 'lexer', to: ['lexer'], text: 'a note to self' },
  )
  const { answer, board } = owning(on, { board: () => lines, roster: () => roster })
  on('process.run', (_, e) => answer(board(e)))
  on('tool.call', () => ({ result: {} }))
  // the coordinator and @parser stand by while @lexer works
  on('agent.list', () => ({ value: [
    { id: 'a1', description: '@parser', type: 'swarm:worker', status: 'completed' },
    { id: 'a2', description: '@lexer', type: 'swarm:worker', status: 'running' },
    { id: 'a3', description: '@verifier', type: 'swarm:verifier', status: 'running' },
  ] as never }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  await clock.advance(2000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  for (const [filter, matches] of [['@all', 1], ['to:@all', 1], ['to:all', 1], ['@backend', 1], ['to:backend', 1], ['to:parser', 3], ['not passed', 1], ['not passedx', 0], ['kind:not-passed extra', 1]] as const) {
    await ui.input({ key: 'board-search', text: filter })
    expect(await ui.find({ type: 'Button', text: `Clear filter (${matches} of 5)` }), filter).toBeDefined()
  }
  await ui.unmount()
  // the terminal's list of the graph: an idle coordinator is never hidden, and nobody addresses itself
  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await term.press({ key: 'tab-graph' })
  expect(await term.find({ type: 'Text', text: /@lexer → @lexer/ })).toBeUndefined()
  expect(await term.find({ type: 'Text', text: /@coordinator → @all/ })).toBeDefined()
  await term.press({ key: 'hide-inactive' })
  expect(await term.find({ type: 'Text', text: /@coordinator → @all/ })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /@verifier → @parser/ })).toBeUndefined()
  await term.unmount()
})

test('a run made inside a command substitution takes the place of the closed run this conversation drove', async ($, on) => {
  let isClosed = false
  // The pointer names the run this conversation drove until a command's init moves it to the new one.
  const OLD = 'demo-20261116-101010'
  let pointer = OLD
  let isMaking = false
  let isPointerUnread = false
  const { seen, answer, board } = owning(on, {
    exists: true,
    board: () => posts({ agent: 'coordinator', to: [], text: 'done' }),
    read: path => {
      if (path !== '/project/.swarm/current') return undefined
      if (isPointerUnread) throw new Error('EIO')
      return `${pointer}\n`
    },
    roster: () => JSON.stringify({ title: 'Demo swarm', closed: isClosed, members: { coordinator: { role: 'coordinator', last_read_seq: 1 } } }),
  })
  on('process.run', (_, e) => answer(board(e)))
  on('agent.list', () => ({ value: [] }))
  let printed = ''
  on('tool.call', () => {
    isPointerUnread = false
    if (isMaking) pointer = 'next-20261117-101010'
    return { result: { stdout: printed, stderr: '' } }
  })
  mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  expect(seen.restore).toBe(OWNED)
  // text that only mentions an init, in a quoted string or a heredoc, makes no run
  const noted = await toolCall($, { tool: 'Bash', command: `cat <<'EOF'\nR=$(python3 /p/board.py /project/.swarm/next init "Next")\nEOF\necho 'board.py x init y'` })
  expect(noted.context ?? []).toEqual([])
  // a script held in a variable is an init once the command printed the run folder the pointer names
  printed = '/p/board.py\n/Project/.swarm/next-20261117-101010\n'
  isMaking = true
  const held = await toolCall($, { tool: 'Bash', command: 'S=/p/board.py; ls $S && python3 $S /project/.swarm/next init "Next"' })
  expect(held.context?.join(' ')).toContain('A run was made')
  expect(seen.restore).toBe(OWNED)
  // text that prints the same words and the folder runs no init
  const faked = await toolCall($, { tool: 'Bash', command: `printf '%s\\n' 'S=/p/board.py; python3 $S x init y' /project/.swarm/next-20261117-101010` })
  expect(faked.context ?? []).toEqual([])
  // nor does a command that only names the variable: echo runs, not the script
  const named = await toolCall($, { tool: 'Bash', command: 'S=/p/board.py; echo $S init; echo /project/.swarm/next-20261117-101010' })
  expect(named.context ?? []).toEqual([])
  printed = ''
  pointer = OLD
  // the variable run inside a substitution prints no folder and is an init all the same
  const both = await toolCall($, { tool: 'Bash', command: 'S=/p/board.py; R=$(python3 $S /project/.swarm/next init "Next")' })
  expect(both.context?.join(' ')).toContain('A run was made')
  expect(seen.restore).toBe(OWNED)
  // while the owned run is open, a run made in a substitution does not take the conversation from it
  await toolCall($, { tool: 'Bash', command: 'R=$(python3 /p/board.py /project/.swarm/next init "Next")' })
  expect(seen.restore).toBe(OWNED)
  isClosed = true
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" close` })
  // an init that failed while the command went on left the pointer on the closed run: nothing was made, in either form
  pointer = OLD
  isMaking = false
  for (const command of ['R=$(python3 /p/board.py /project/.swarm/next init "Next"); echo ok', 'S=/p/board.py; R=$(python3 $S /project/.swarm/next init "Next") || true']) {
    expect((await toolCall($, { tool: 'Bash', command })).context ?? [], command).toEqual([])
  }
  printed = `${OWNED}\n`
  expect((await toolCall($, { tool: 'Bash', command: `S=/p/board.py; python3 $S /project/.swarm/next init "Next"; ls -d ${OWNED}` })).context ?? []).toEqual([])
  printed = ''
  isMaking = true
  // a pointer that could not be read before the command leaves nothing to compare with: no run is inferred
  isPointerUnread = true
  expect((await toolCall($, { tool: 'Bash', command: 'R=$(python3 /p/board.py /project/.swarm/next init "Next")' })).context ?? []).toEqual([])
  pointer = OLD
  // however the script is run inside the substitution
  const made = await toolCall($, { tool: 'Bash', command: 'R=$(uv run /p/board.py /project/.swarm/next init "Next")' })
  expect(seen.restore).toBe('/project/.swarm/next-20261117-101010')
  expect(made.context?.join(' ')).toContain('skills/swarm/SKILL.md')
})

test('the coordinator drives its run through the board tool, and what a typed board command sets off follows it too', async ($, on) => {
  const state = {
    title: 'Demo swarm', paused: undefined as string | undefined,
    members: { coordinator: { role: 'coordinator', last_read_seq: 0 }, parser: { role: 'worker', id: 'a1', last_read_seq: 0 } } as Record<string, Record<string, unknown>>,
  }
  const { seen, answer, board } = owning(on, { board: () => posts({ agent: 'parser', to: ['coordinator'], text: '@coordinator which file?' }), roster: () => JSON.stringify(state) })
  const ran: { dir: string; args: string; stdin?: string }[] = []
  on('process.run', (_, e) => {
    const stdout = board(e)
    const [, , dir = '', action = '', ...rest] = e.argv
    ran.push({ dir, args: [action, ...rest].join(' '), stdin: e.init?.stdin })
    if (action === 'pause') state.paused = rest.join(' ') || 'paused'
    if (action === 'resume') state.paused = undefined
    if (action === 'replace') state.members.parser = { ...state.members.parser, killed: '1' }
    return answer(action === 'init' ? `${OWNED}\n` : action === 'export' ? `${OWNED}/summary.md\n` : action === 'post' ? 'posted #2 -> @parser\n' : stdout)
  })
  on('agent.list', () => ({ value: [{ id: 'a1', description: '@parser', type: 'swarm:worker', status: 'running' }] as never }))
  on('tool.call', () => ({ result: {} }))
  const clock = mock.clock(on)
  const tool = (input: McpToolInputs['mcp__swarm__board']) => toolCall($, { tool: 'mcp__swarm__board', ...input })
  const last = (action: string) => ran.findLast(one => one.args.split(' ')[0] === action)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })

  // nothing to drive before a run is made; a field an action does not take is refused before the board runs
  expect((await tool({ action: 'status' })).deny).toContain('There is no Swarm run here')
  expect((await tool({ action: 'init', title: 'Demo swarm' })).deny).toContain('name missing')
  expect((await tool({ action: 'init', name: '../up', title: 'Demo swarm' })).deny).toContain('folder name')
  expect((await tool({ action: 'ready', text: 'done' })).deny).toContain('Unknown board action')
  // init makes the run under .swarm, binds it, and carries the notes a typed init gets
  const made = await tool({ action: 'init', name: 'demo', title: 'Demo swarm' })
  expect(last('init')).toEqual({ dir: '/project/.swarm/demo', args: 'init Demo swarm', stdin: undefined })
  expect(seen.restore).toBe(OWNED)
  expect(made.context?.join(' ')).toContain('A run was made')

  // structured fields become the command's words, and a post's text goes on stdin
  expect((await tool({ action: 'member', options: ['role=worker'] })).deny).toContain('name missing')
  expect((await tool({ action: 'member', name: 'lexer', options: ['role worker'] })).deny).toContain('key=value')
  expect((await tool({ action: 'post', text: 'hi', name: 'parser' })).deny).toContain('not name')
  await tool({ action: 'member', name: '@Lexer', options: ['role=worker', 'owns=the lexer, its tests'] })
  expect(last('member')).toEqual({ dir: OWNED, args: 'member lexer role=worker owns=the lexer, its tests', stdin: undefined })
  expect((await tool({ action: 'post', text: '@parser go on' })).result).toContain('posted #2')
  expect(last('post')).toEqual({ dir: OWNED, args: 'post coordinator', stdin: '@parser go on' })
  await tool({ action: 'confirm', name: 'probe', seq: 4 })
  expect(last('confirm')?.args).toBe('confirm probe 4')
  await tool({ action: 'export', out: '/tmp/run.md' })
  expect(last('export')?.args).toBe('export --out=/tmp/run.md')
  await tool({ action: 'resume', name: 'parser' })
  expect(last('resume')?.args).toBe('resume parser')

  // the mention owed is told with the next call, and a read through the tool answers it as a typed read does
  await clock.advance(2000)
  const reading = await tool({ action: 'read' })
  expect(last('read')?.args).toBe('read coordinator --max-bytes=48000 --attention')
  expect(reading.context).toBeUndefined()
  expect((await tool({ action: 'status' })).context).toBeUndefined()

  // a pause the coordinator makes itself is not told back to it
  seen.prompts.length = 0
  await tool({ action: 'pause', text: 'waiting for the user' })
  expect(last('pause')?.args).toBe('pause waiting for the user')
  await clock.advance(4000)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'idle', reason: 'answer' })
  await clock.advance(4000)
  expect(seen.prompts.filter(text => text.includes('paused'))).toEqual([])
  await tool({ action: 'resume' })

  // replace retires the old member, and a retired agent still running is reported, as after a typed replace
  const replaced = await tool({ action: 'replace', name: 'parser', newName: 'parser-2', options: ['model=opus'] })
  expect(last('replace')?.args).toBe('replace parser parser-2 model=opus')
  expect(replaced.context?.join(' ')).toContain('@parser was retired, but agent a1 is still running')
  // and its tool calls are refused from here, with no poll in between
  expect((await toolCall($, { tool: 'Bash', command: 'ls', agentId: 'a1' })).deny).toContain('retired')
})

test('workers, designers and verifiers use the board tool as themselves, within what each may report', async ($, on) => {
  const state = {
    title: 'Team',
    members: {
      coordinator: { role: 'coordinator', last_read_seq: 0 },
      alice: { role: 'worker', id: 'alice-1', last_read_seq: 0 },
      des: { role: 'worker', profile: 'designer', id: 'des-1', last_read_seq: 0 },
      ver: { role: 'verifier', id: 'ver-1', last_read_seq: 0 },
      odd: { role: 'worker', profile: 'explorer', writes: '0', id: 'odd-1', last_read_seq: 0 },
    },
  }
  const { answer, board } = owning(on, { board: () => '', roster: () => JSON.stringify(state) })
  const ran: { args: string; stdin?: string }[] = []
  on('process.run', (_, e) => {
    const stdout = board(e)
    if (!['restore', 'bind', 'attention', 'wake', 'account'].includes(e.argv[3] ?? '')) ran.push({ args: e.argv.slice(2).join(' '), stdin: e.init?.stdin })
    return answer(stdout)
  })
  on('agent.list', () => ({
    value: [
      { id: 'alice-1', description: '@alice', type: 'swarm:worker', status: 'running' },
      { id: 'des-1', description: '@des', type: 'swarm:designer', status: 'running' },
      { id: 'ver-1', description: '@ver', type: 'swarm:verifier', status: 'running' },
      { id: 'odd-1', description: '@odd', type: 'swarm:worker', status: 'running' },
    ] as never,
  }))
  on('tool.call', () => ({ result: {} }))
  mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  ran.length = 0
  const as = (agentId: string, input: McpToolInputs['mcp__swarm__board']) => toolCall($, { tool: 'mcp__swarm__board', agentId, ...input })

  expect((await as('alice-1', { action: 'read' })).deny).toBeUndefined()
  expect((await as('alice-1', { action: 'status' })).deny).toBeUndefined()
  const sha = 'a'.repeat(40)
  expect((await as('alice-1', { action: 'ready', text: 'Parser done.', commit: sha })).deny).toBeUndefined()
  expect((await as('des-1', { action: 'revise', text: 'fixing the spacing' })).deny).toBeUndefined()
  expect((await as('ver-1', { action: 'post', text: '@coordinator NOT VERIFIED: no candidate yet' })).deny).toBeUndefined()
  expect(ran).toEqual([
    // a member's read pages but never asks for the coordinator's attention items
    { args: `${OWNED} read alice --max-bytes=48000`, stdin: undefined },
    { args: `${OWNED} status`, stdin: undefined },
    { args: `${OWNED} ready alice ${sha}`, stdin: 'Parser done.' },
    { args: `${OWNED} revise des fixing the spacing`, stdin: undefined },
    { args: `${OWNED} post ver`, stdin: '@coordinator NOT VERIFIED: no candidate yet' },
  ])
  ran.length = 0
  // HEAD is resolved where the board runs, which is not the member's checkout: only a full id is taken
  expect((await as('alice-1', { action: 'ready', text: 'done', commit: 'HEAD' })).deny).toContain('full 40- or 64-character commit id')
  expect((await as('alice-1', { action: 'post', text: 'hi', commit: sha })).deny).toContain('only valid for ready')
  // a member acts as itself, never on the run's setup or another's name
  expect((await as('alice-1', { action: 'post', text: 'hi', name: 'ver' })).deny).toContain("coordinator's actions")
  expect((await as('alice-1', { action: 'member', options: ['killed=1'] })).deny).toContain("coordinator's actions")
  expect((await as('alice-1', { action: 'pause' })).deny).toBe('Unknown board action.')
  // a verifier's verdict is a post: readiness is a worker's
  expect((await as('ver-1', { action: 'ready', text: 'VERIFIED' })).deny).toContain('A verifier reports with action "post"')
  // an agent started as another type than the roster gives it is refused, as the spawn hook refuses it
  expect((await as('odd-1', { action: 'read' })).deny).toContain('the roster has @odd as explorer, but this agent is a worker')
  expect(ran).toEqual([])
})

test('a member that spends its own token budget is stopped at once, the coordinator hears once, and Resume lets it go on', async ($, on) => {
  const state = {
    title: 'Team',
    members: {
      coordinator: { role: 'coordinator', last_read_seq: 0 },
      alice: { role: 'worker', id: 'alice-1', last_read_seq: 0 } as Record<string, unknown>,
      bob: { role: 'worker', id: 'bob-1', last_read_seq: 0 } as Record<string, unknown>,
    },
  }
  const report = { items: [] as unknown[], members: {} }
  const { seen, answer, board } = owning(on, { board: () => '', roster: () => JSON.stringify(state) })
  let spender: 'alice' | 'bob' = 'alice'
  on('process.run', (_, e) => {
    const stdout = board(e)
    const action = e.argv[3]
    if (action === 'account') {
      // the board pauses the member whose turn crossed its own budget, and says so once
      const crossed = e.argv[5] !== 'coordinator' && state.members[spender].paused === undefined
      if (crossed) state.members[spender].paused = 'token budget of 500 spent'
      return answer(JSON.stringify({ title: 'Team', total: 600, budget: 0, paused: false, ...(crossed && { member_paused: spender }) }))
    }
    if (action === 'resume' && e.argv[4] === 'alice') delete state.members.alice.paused
    return answer(action === 'attention' ? JSON.stringify(report) : stdout)
  })
  on('agent.list', () => ({
    value: [
      { id: 'alice-1', description: '@alice', type: 'swarm:worker', status: 'running' },
      { id: 'bob-1', description: '@bob', type: 'swarm:worker', status: 'running' },
    ] as never,
  }))
  on('tool.call', () => ({ result: {} }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'coordinator-turn', reason: 'answer' })
  await clock.advance(2000)

  const usage = { model: 'm', input_tokens: 600, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'alice-turn', reason: 'answer', agentId: 'alice-1', usage })
  // refused from its next tool call on, before any poll reads the roster
  expect((await toolCall($, { tool: 'Bash', command: 'ls', agentId: 'alice-1' })).deny).toContain('spent its own token budget')
  expect((await toolCall($, { tool: 'mcp__swarm__board', agentId: 'alice-1', action: 'read' })).deny).toContain('spent its own token budget')
  expect((await toolCall($, { tool: 'Bash', command: 'ls', agentId: 'bob-1' })).deny).toBeUndefined()
  // an idle coordinator is told by a prompt, once
  await clock.advance(2000)
  await clock.advance(12_000)
  expect(seen.prompts.filter(text => text.startsWith('Swarm: Member paused\n@alice has spent its own token budget'))).toHaveLength(1)
  // a busy one with its next tool call, once
  expect((await toolCall($, { tool: 'Bash', command: 'ls' })).context ?? []).toEqual([])
  spender = 'bob'
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'bob-turn', reason: 'answer', agentId: 'bob-1', usage })
  expect((await toolCall($, { tool: 'Bash', command: 'ls' })).context?.join(' ')).toContain('@bob has spent its own token budget')
  expect((await toolCall($, { tool: 'Bash', command: 'ls' })).context?.join(' ') ?? '').not.toContain('@bob')
  expect(seen.prompts.filter(text => text.includes('@bob'))).toEqual([])

  // the pane names it, and Resume runs the board's resume for that member
  report.items = [{ kind: 'member_paused', member: 'alice', seq: 0, text: '@alice spent its token budget' }, { kind: 'loop', member: 'alice', seq: 0, text: 'loop' }, { kind: 'conflict', member: 'alice', seq: 0, text: 'conflict' }]
  report.members = { alice: { type: 'worker', model: 'sonnet', effort: 'medium', depends: [], owns: '', ready: false, blocked_on: [], asked: 0, unreachable: false, paused: true } }
  await clock.advance(2000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-members' })
  expect(await ui.find({ type: 'Text', text: 'its token budget is spent' })).toBeDefined()
  await ui.press({ key: 'tab-attention' })
  for (const label of [/^MEMBER_PAUSED$/, /^LOOP$/, /^CONFLICT$/]) expect(await ui.find({ type: 'Text', text: label })).toBeDefined()
  expect(await ui.find({ key: 'attention-ask-member_paused-alice-0' })).toBeUndefined()
  await ui.press({ key: 'attention-resume-member_paused-alice-0' })
  expect(seen.commands.some(command => /^member alice budget=\d+$/.test(command))).toBe(true)
  expect(seen.commands).toContain('resume alice')
  // the roster no longer shows it paused: its tools run again
  expect((await toolCall($, { tool: 'Bash', command: 'ls', agentId: 'alice-1' })).deny).toBeUndefined()
  await ui.unmount()
})

test('a shared-checkout writer is told when HEAD moved during its command, and the coordinator hears with its next call', async ($, on) => {
  const state = {
    title: 'Team',
    members: {
      coordinator: { role: 'coordinator', last_read_seq: 0 },
      alice: { role: 'worker', id: 'alice-1', isolated: '0', last_read_seq: 0 },
      bob: { role: 'worker', id: 'bob-1', isolated: '1', last_read_seq: 0 },
    },
  }
  const { answer, board } = owning(on, { board: () => '', roster: () => JSON.stringify(state) })
  let heads: string[] = []
  const reads: string[] = []
  on('process.run', (_, e) => {
    if (e.argv[0] === 'git') {
      reads.push(e.argv.join(' '))
      const head = heads.shift()
      return head === undefined
        ? { value: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }
        : answer(`${head}\n`)
    }
    return answer(board(e))
  })
  on('agent.list', () => ({
    value: [
      { id: 'alice-1', description: '@alice', type: 'swarm:worker', status: 'running' },
      { id: 'bob-1', description: '@bob', type: 'swarm:worker', status: 'running' },
    ] as never,
  }))
  on('tool.call', (_, e) => e.tool === 'Bash' && e.command === './commit-then-fail.sh' ? { isError: true as const, result: 'exit 1' } : { result: {} })
  mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  const [before, after] = ['a'.repeat(40), 'b'.repeat(40)]

  heads = [before, after]
  const moved = await toolCall($, { tool: 'Bash', command: './scripts/release.sh', agentId: 'alice-1' })
  expect(reads).toEqual(['git -C /project rev-parse HEAD', 'git -C /project rev-parse HEAD'])
  expect(moved.deny).toBeUndefined()
  expect(moved.context?.join(' ')).toContain(`HEAD of the shared checkout moved from ${before.slice(0, 12)} to ${after.slice(0, 12)} during this command`)
  expect(moved.context?.join(' ')).toContain('Tell the coordinator in your report that HEAD moved')
  const told = await toolCall($, { tool: 'Bash', command: 'ls' })
  expect(told.context?.join(' ')).toContain('while @alice ran a Bash command. Another actor may have moved it')
  expect((await toolCall($, { tool: 'Bash', command: 'ls' })).context ?? []).toEqual([])
  // a command that commits and then fails is told too
  heads = [after, before]
  const failed = await toolCall($, { tool: 'Bash', command: './commit-then-fail.sh', agentId: 'alice-1' })
  expect(failed.isError).toBe(true)
  expect(failed.context?.join(' ')).toContain('HEAD of the shared checkout moved')
  expect((await toolCall($, { tool: 'Bash', command: 'ls' })).context?.join(' ')).toContain('while @alice ran a Bash command')

  // a HEAD that stayed, a read that failed, a background command and an isolated writer change nothing
  reads.length = 0
  heads = [before, before]
  expect((await toolCall($, { tool: 'Bash', command: 'make', agentId: 'alice-1' })).context ?? []).toEqual([])
  heads = []
  expect((await toolCall($, { tool: 'Bash', command: 'make', agentId: 'alice-1' })).context ?? []).toEqual([])
  expect(reads).toHaveLength(3)
  reads.length = 0
  await toolCall($, { tool: 'Bash', command: 'make', agentId: 'alice-1', run_in_background: true })
  await toolCall($, { tool: 'Bash', command: 'make', agentId: 'bob-1' })
  expect(reads).toEqual([])
  expect((await toolCall($, { tool: 'Bash', command: 'ls' })).context ?? []).toEqual([])
})

test('a READY with a commit opens its diff, the run exports to Markdown, and the person posts from the pane in the coordinator\'s name', async ($, on) => {
  const sha = 'c'.repeat(40)
  const lines = [
    { seq: 1, agent: 'coordinator', to: ['alice'], text: '@alice BRIEF', time: '2026-11-16T14:03:22+0100' },
    { seq: 2, agent: 'alice', to: ['coordinator'], text: `READY ${sha}\nParser done.`, time: '2026-11-16T14:04:22+0100', kind: 'ready', revision: sha },
  ].map(line => JSON.stringify(line)).join('\n') + '\n'
  const state = { title: 'Team', members: { coordinator: { role: 'coordinator', last_read_seq: 2 }, alice: { role: 'worker', id: 'alice-1', last_read_seq: 1 } } }
  const { seen, answer, board } = owning(on, { board: () => lines, roster: () => JSON.stringify(state) })
  const runs: { argv: string; stdin?: string }[] = []
  on('process.run', (_, e) => {
    runs.push({ argv: e.argv.join(' '), stdin: e.init?.stdin })
    if (e.argv[0] === 'git') return answer('commit cccc\n src/a.md | 2 +-\ndiff --git a/src/a.md b/src/a.md\n+```js\n+x\n+```\n')
    const action = e.argv[3]
    const stdout = board(e)
    return answer(action === 'export' ? `${OWNED}/summary.md\n` : action === 'post' ? 'posted #3 -> @alice\n' : stdout)
  })
  on('agent.list', () => ({ value: [{ id: 'alice-1', description: '@alice', type: 'swarm:worker', status: 'running' }] as never }))
  on('tool.call', () => ({ result: {} }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await ui.find({ key: 'diff-1' })).toBeUndefined()
  await ui.press({ key: 'diff-2' })
  expect(runs.findLast(one => one.argv.startsWith('git'))?.argv).toBe(`git -C /project diff --stat --patch --no-color --no-ext-diff HEAD...${sha}`)
  // drawn as code, in a fence longer than the Markdown fence inside the diff
  const drawn = String((await ui.find({ key: 'diff-text-2' }))?.text ?? (await ui.find({ type: 'Markdown', text: /diff --git/ }))?.text)
  expect(drawn).toMatch(/^````diff\n[\s\S]*\+```js[\s\S]*\n````$/)
  await ui.press({ key: 'diff-2' })
  expect(await ui.find({ type: 'Markdown', text: /diff --git/ })).toBeUndefined()

  await ui.press({ key: 'run-export' })
  expect(seen.toasts.at(-1)).toBe(`Swarm wrote ${OWNED}/summary.md`)

  await ui.input({ key: 'board-compose', text: 'Please also cover leap years @alice' })
  const posted = runs.findLast(one => one.argv.endsWith(`${OWNED} post coordinator`))
  expect(posted?.stdin).toBe('(from the user, in the pane)\nPlease also cover leap years @alice')
  const told = await toolCall($, { tool: 'Bash', command: 'ls' })
  expect(told.context?.join(' ')).toContain('The user posted #3 to the board in your name from the Swarm pane')
  expect(told.context?.join(' ')).toContain("the board's show --post=3")
  await ui.unmount()
})

// The tests below pin the findings of the second 2026-11-21 scan.

test('S1: a member started after the roster was cached is guarded from its first tool call', async ($, on) => {
  const state = {
    title: 'Team',
    members: {
      coordinator: { role: 'coordinator', last_read_seq: 1 },
      alice: { role: 'worker', paths: 'src/alice', isolated: '0', last_read_seq: 0 } as Record<string, unknown>,
      bob: { role: 'worker', id: 'bob-1', paths: 'src/bob', isolated: '0', last_read_seq: 0 } as Record<string, unknown>,
    },
  }
  const { answer, board } = owning(on, { board: () => '', roster: () => JSON.stringify(state) })
  on('process.run', (_, e) => {
    if (e.argv[3] === 'started') state.members.alice.id = e.argv[5]
    return answer(board(e))
  })
  on('agent.list', () => ({
    value: [
      ...(state.members.alice.id ? [{ id: 'alice-1', description: '@alice: parser', type: 'swarm:worker', status: 'running' }] : []),
      { id: 'bob-1', description: '@bob: dates', type: 'swarm:worker', status: 'running' },
    ] as never,
  }))
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'alice-1' }))
  on('tool.call', () => ({ result: {} }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)
  // the registration caches the roster while @alice has no agent yet, and no poll runs after its start
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" member alice paths=src/alice` })
  const started = await $.agent.spawn({
    tool_use_id: 'start-alice', prompt: 'Use the board.', description: '@alice: parser', subagentType: 'swarm:worker',
    provider: { plugin: 'swarm', tier: 'core' as const }, parentModel: 'sonnet', background: true, fork: false,
  })
  expect(started.agentId).toBe('alice-1')
  expect((await toolCall($, { tool: 'Edit', file_path: '/project/src/bob/b.ts', old_string: 'a', new_string: 'b', agentId: 'alice-1' })).deny).toContain('claimed by @bob')
  expect((await toolCall($, { tool: 'Bash', command: 'git commit -m x', agentId: 'alice-1' })).deny).toContain('Shared-checkout writers')
  expect((await toolCall($, { tool: 'Edit', file_path: '/project/src/alice/a.ts', old_string: 'a', new_string: 'b', agentId: 'alice-1' })).deny).toBeUndefined()
})

test('S2: the commit guard follows escapes, case arms, env options and clustered shell flags', async ($, on) => {
  const state = {
    title: 'Guard swarm',
    members: {
      coordinator: { role: 'coordinator', last_read_seq: 1 },
      alice: { role: 'worker', id: 'alice-1', paths: 'src/alice', isolated: '0', last_read_seq: 1 },
    },
  }
  const { answer, board } = owning(on, { board: () => '', roster: () => JSON.stringify(state) })
  on('process.run', (_, e) => answer(board(e)))
  on('agent.list', () => ({ value: [{ id: 'alice-1', description: '@alice', type: 'swarm:worker', status: 'running' }] as never }))
  on('tool.call', () => ({ result: {} }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)
  const bash = (command: string) => toolCall($, { tool: 'Bash', command, agentId: 'alice-1' })
  for (const command of [
    '(echo \\) && cd /tmp/wt) && git commit -m x', '(echo "\\")" && cd /tmp/wt) && git commit -m x',
    'case x in *) git commit -m x ;; esac', 'case x in a) true ;; *) git commit -m x ;; esac',
    'cd /tmp/wt && env -C /project git commit -m x', 'cd /tmp/wt && env -C/project git commit -m x',
    'cd /tmp/wt && env --chdir=/project git commit -m x', "env -S 'git commit -m x'", 'env -u FOO -P /usr/bin git commit -m x',
    "sh -ce 'git commit -m x'", 'bash -ec "git commit -m x"', "bash -o pipefail -c 'git commit -m x'",
    '/usr/bin/env git commit -m x',
    // a pattern's `)` must not close the subshell the cd is kept in
    'cd /tmp/wt; (case x in *) cd /project ;; esac; git commit -m x)',
  ]) {
    expect((await bash(command)).deny, command).toContain('Shared-checkout writers')
  }
  for (const command of [
    '(echo "(" && cd /tmp/wt && git commit -m x)', 'env -C /tmp/wt git commit -m x', "sh -ce 'cd /tmp/wt && git commit -m x'",
    'case x in *) echo commit ;; esac',
  ]) {
    expect((await bash(command)).deny, command).toBeUndefined()
  }
})

test('S3: a member name that is only "@" is refused rather than read as no name', async ($, on) => {
  const state = { title: 'Team', members: { coordinator: { role: 'coordinator', last_read_seq: 0 }, alice: { role: 'worker', id: 'alice-1', last_read_seq: 0 } } }
  const { seen, answer, board } = owning(on, { board: () => '', roster: () => JSON.stringify(state) })
  on('process.run', (_, e) => answer(board(e)))
  on('agent.list', () => ({ value: [] }))
  on('tool.call', () => ({ result: {} }))
  mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  for (const name of ['@', ' @ ']) {
    expect((await toolCall($, { tool: 'mcp__swarm__board', action: 'resume', name })).deny, name).toContain('A member name')
  }
  expect((await toolCall($, { tool: 'mcp__swarm__board', action: 'replace', name: 'alice', newName: '@' })).deny).toContain('A member name')
  expect(seen.commands.filter(command => /^(?:resume|replace)\b/.test(command))).toEqual([])
  expect((await toolCall($, { tool: 'mcp__swarm__board', action: 'resume', name: '@alice' })).deny).toBeUndefined()
  expect(seen.commands).toContain('resume alice')
})

test('S4: a page of the board neither answers nor reminds, and a new run hears nothing owed by the old one', async ($, on) => {
  const TWO = '/project/.swarm/two-20261121-101010'
  const state = { title: 'Team', members: { coordinator: { role: 'coordinator', last_read_seq: 0 }, alice: { role: 'worker', id: 'alice-1', last_read_seq: 1 } } }
  const list = [{ agent: 'coordinator', to: ['alice'], text: '@alice BRIEF' }, { agent: 'alice', to: ['coordinator'], text: '@coordinator which file?' }]
  const { answer, board } = owning(on, { board: () => posts(...list), roster: () => JSON.stringify(state) })
  on('process.run', (_, e) => {
    const stdout = board(e)
    return answer(e.argv[3] === 'read' ? '#2 @alice: which file?\n1 more post(s) remain. Run read again.\n' : e.argv[3] === 'init' ? `${TWO}\n` : stdout)
  })
  on('agent.list', () => ({ value: [{ id: 'alice-1', description: '@alice', type: 'swarm:worker', status: 'running' }] as never }))
  on('tool.call', () => ({ result: {} }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)
  const page = await toolCall($, { tool: 'mcp__swarm__board', action: 'read' })
  expect(page.result).toContain('1 more post(s) remain')
  expect(page.context?.join(' ') ?? '').not.toContain('you have not read')
  // what the page left out is still owed, and told with the next call
  expect((await toolCall($, { tool: 'Bash', command: 'ls' })).context?.join(' ')).toContain('you have not read it')

  list.push({ agent: 'alice', to: ['coordinator'], text: '@coordinator and another thing' })
  await clock.advance(2000)
  const made = await toolCall($, { tool: 'mcp__swarm__board', action: 'init', name: 'two', title: 'Two' })
  expect(made.context?.join(' ')).toContain('A run was made')
  expect(made.context?.join(' ')).not.toContain('you have not read')
})

test('S5: a member pause the coordinator settled is not told to it afterwards', async ($, on) => {
  const state = {
    title: 'Team',
    members: {
      coordinator: { role: 'coordinator', last_read_seq: 0 },
      alice: { role: 'worker', id: 'alice-1', last_read_seq: 0 } as Record<string, unknown>,
      bob: { role: 'worker', id: 'bob-1', last_read_seq: 0 } as Record<string, unknown>,
    },
  }
  const { answer, board } = owning(on, { board: () => '', roster: () => JSON.stringify(state) })
  let spender: 'alice' | 'bob' = 'alice'
  on('process.run', (_, e) => {
    const stdout = board(e)
    if (e.argv[3] === 'account') {
      const crossed = e.argv[5] !== 'coordinator' && state.members[spender].paused === undefined
      if (crossed) state.members[spender].paused = 'token budget of 500 spent'
      return answer(JSON.stringify({ title: 'Team', total: 600, budget: 0, paused: false, ...(crossed && { member_paused: spender }) }))
    }
    if (e.argv[3] === 'resume' && e.argv[4] === 'alice') delete state.members.alice.paused
    return answer(stdout)
  })
  on('agent.list', () => ({
    value: [
      { id: 'alice-1', description: '@alice', type: 'swarm:worker', status: 'running' },
      { id: 'bob-1', description: '@bob', type: 'swarm:worker', status: 'running' },
    ] as never,
  }))
  on('tool.call', (_, e) => {
    if (e.tool === 'Bash' && /member bob killed=1/.test(String(e.command))) state.members.bob.killed = '1'
    return { result: {} }
  })
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)
  const usage = { model: 'm', input_tokens: 600, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  const told = (result: { context?: readonly string[] }) => result.context?.join(' ') ?? ''

  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'alice-turn', reason: 'answer', agentId: 'alice-1', usage })
  expect(told(await toolCall($, { tool: 'mcp__swarm__board', action: 'resume', name: 'alice' }))).not.toContain('has spent its own token budget')
  expect(told(await toolCall($, { tool: 'Bash', command: 'ls' }))).not.toContain('has spent its own token budget')

  spender = 'bob'
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'bob-turn', reason: 'answer', agentId: 'bob-1', usage })
  expect(told(await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" member bob killed=1` }))).not.toContain('has spent its own token budget')
  expect(told(await toolCall($, { tool: 'Bash', command: 'ls' }))).not.toContain('has spent its own token budget')
})

test('S6: a request sent from the pane holds the poll\'s own notice until its turn starts', async ($, on) => {
  const state = { title: 'Team', members: { coordinator: { role: 'coordinator', last_read_seq: 0 }, alice: { role: 'worker', id: 'alice-1', last_read_seq: 1 } } }
  const { seen, answer, board } = owning(on, {
    board: () => posts({ agent: 'coordinator', to: ['alice'], text: '@alice BRIEF' }, { agent: 'alice', to: ['coordinator'], text: '@coordinator which file?' }),
    roster: () => JSON.stringify(state),
  })
  on('process.run', (_, e) => {
    const stdout = board(e)
    return answer(e.argv[3] === 'attention'
      ? JSON.stringify({ items: [{ kind: 'question', member: 'coordinator', seq: 2, text: '@alice asked @coordinator in #2 and has no answer.' }], members: {} })
      : stdout)
  })
  on('agent.list', () => ({ value: [{ id: 'alice-1', description: '@alice', type: 'swarm:worker', status: 'running' }] as never }))
  on('tool.call', () => ({ result: {} }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'coordinator-turn', reason: 'answer' })
  await clock.advance(2000)
  await clock.advance(6000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-attention' })
  await ui.press({ key: 'attention-ask-question-coordinator-2' })
  expect(seen.prompts.at(-1)).toContain('Swarm: Needs your attention')
  // the mention's grace runs out before the asked turn has started: no second prompt beside the first
  await clock.advance(6000)
  expect(seen.prompts.filter(text => text.includes('Unread board mentions'))).toEqual([])
  // held, not dropped
  await clock.advance(6000)
  expect(seen.prompts.filter(text => text.includes('Unread board mentions'))).toHaveLength(1)
  await ui.unmount()
})

test('S7: a browsed run keeps its conversation when the live run goes, and a slow diff opens only under its own run', async ($, on) => {
  const older = '/project/.swarm/older-20261101-090000'
  const [mine, theirs] = ['c'.repeat(40), 'd'.repeat(40)]
  const ready = (agent: string, sha: string) => [
    { seq: 1, agent: 'coordinator', to: [agent], text: `@${agent} BRIEF`, time: '2026-11-16T14:03:22+0100' },
    { seq: 2, agent, to: ['coordinator'], text: `READY ${sha}\ndone`, time: '2026-11-16T14:04:22+0100', kind: 'ready', revision: sha },
  ].map(line => JSON.stringify(line)).join('\n') + '\n'
  let isGone = false
  const { answer, board } = owning(on, {
    board: () => ready('alice', mine),
    roster: () => {
      if (isGone) throw new Error('ENOENT')
      return JSON.stringify({ title: 'Team', members: { coordinator: { role: 'coordinator', last_read_seq: 2 }, alice: { role: 'worker', id: 'alice-1', last_read_seq: 1 } } })
    },
    read: path => path === `${older}/members.json`
      ? JSON.stringify({ title: 'Older swarm', members: { coordinator: { role: 'coordinator', last_read_seq: 2 }, scout: { role: 'worker', id: 'gone', last_read_seq: 1 } } })
      : path === `${older}/board.jsonl` ? ready('scout', theirs) : undefined,
  })
  on('fs.list', () => ({ value: ['older-20261101-090000', OWNED.slice(OWNED.lastIndexOf('/') + 1)].map(name => ({ name, kind: 'dir', size: 0 })) as never }))
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  on('process.run', async (_, e) => {
    if (e.argv[0] === 'git') {
      await gate
      return answer('diff --git a/src/a.md b/src/a.md\n+late\n')
    }
    return answer(board(e))
  })
  on('agent.list', () => ({ value: [{ id: 'alice-1', description: '@alice', type: 'swarm:worker', status: 'running' }, { id: 'gone', description: '@scout', type: 'swarm:worker', status: 'completed' }] as never }))
  on('ui.view', () => ({ value: { deny: 'no main view here' } }))
  on('session.messages', () => ({ value: [{ role: 'user', text: 'Scout the parser', toolUses: [] }] as never }))
  on('tool.call', () => ({ result: {} }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  // the diff of the live run's #2 is still being read when the person steps to the older run, whose #2 is a READY too
  const pressing = ui.press({ key: 'diff-2' })
  await ui.press({ key: 'run-prev' })
  release()
  await pressing
  expect(await ui.find({ type: 'Text', text: /^Older swarm$/ })).toBeDefined()
  expect(await ui.find({ type: 'Markdown', text: /\+late/ })).toBeUndefined()

  await ui.press({ key: 'tab-members' })
  await ui.press({ key: 'view-scout' })
  expect(await ui.find({ key: 'talk-back' })).toBeDefined()
  isGone = true
  await clock.advance(2000)
  await clock.advance(2000)
  expect(await ui.find({ key: 'talk-back' })).toBeDefined()
  await ui.unmount()
})

// The tests below pin the fixes of the 0.3.47 audit; the first three are its host probes, made to assert the fix.

const AUDIT_RUN = '/project/.swarm/audit-20261122-090000'
const OLD_RUN = 'old-20261121-090000'
function auditEngine(on: On, read: (path: string) => string, agents: () => unknown[] | Promise<unknown[]> = () => []) {
  const toasts: string[] = []
  on('command.register', () => ({ value: { command: 'swarm-board' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.register', (_, spec) => ({ value: { tool: `mcp__swarm__${spec.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/project' }))
  on('fs.exists', () => ({ value: true }))
  on('fs.list', () => ({ value: [{ name: OLD_RUN, kind: 'dir' }, { name: AUDIT_RUN.split('/').at(-1)!, kind: 'dir' }] as never }))
  on('fs.read', (_, e) => ({ value: e.path.endsWith('/current') ? AUDIT_RUN.split('/').at(-1)! : read(e.path) }))
  on('agent.list', async () => ({ value: await agents() as never }))
  on('ui.toast', (_, e) => { toasts.push(e.text); return { value: undefined } })
  return toasts
}

// One test a team size: a dense graph takes about a second to route, and a test has five.
for (const members of [18, 24]) test(`audit: a dense graph of ${members} never hands the host a source over its limit, and a narrow pane lists the routes`, async ($, on) => {
  const size = members
  const fixture = () => {
    const names = ['coordinator', ...Array.from({ length: size - 1 }, (_, i) => `worker-${i}`)]
    const members = Object.fromEntries(names.map((name, index) => [name, { role: index === 0 ? 'coordinator' : 'worker', id: `agent-${index}`, last_read_seq: size * 2 }]))
    const board = Array.from({ length: size * 2 }, (_, i) => {
      const agent = names[i % names.length]!
      const to = i === size * 2 - 1 ? ['coordinator'] : names.filter(name => name !== agent)
      return JSON.stringify({ seq: i + 1, agent, to, text: i < size ? '@all' : to.map(name => `@${name}`).join(' '), time: '2026-11-22T09:00:00+0100' })
    }).join('\n')
    return { roster: JSON.stringify({ title: 'Dense graph fixture', members }), board }
  }
  auditEngine(on, path => path.endsWith('/board.jsonl') ? fixture().board : fixture().roster)
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  const sources = async (ui: Pick<Awaited<ReturnType<typeof $.ui.mount>>, 'findAll'>) => (await ui.findAll({ type: 'Svg' })).map(svg => String(svg.props.source))
  {
    await clock.advance(2000)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'tab-graph' })
    for (const stage of ['collapsed', 'expanded']) {
      const drawn = await sources(ui)
      expect({ members, stage, longest: Math.max(...drawn.map(source => source.length)) <= 131072 }).toEqual({ members, stage, longest: true })
      const graph = (await ui.findAll({ type: 'Svg' })).find(svg => String(svg.props.alt).startsWith('Post '))
      expect({ members, stage, hasSvg: graph !== undefined }).toEqual({ members, stage, hasSvg: true })
      // the route of the post shown is always drawn; the key is pane text
      const [, from, to] = /^Post \d+ · @(\S+) to @([\w-]+)/.exec(String(graph?.props.alt)) ?? []
      // on the highlighted route itself: an earlier @all route between the same two members carries a like title
      expect(String(graph?.props.source)).toMatch(new RegExp(`<path class="route(?: motion-route)?" d="[^"]*" pathLength="100"[^>]*><title>${from} to ${to} · \\d+ mentions?</title>`))
      expect(String(graph?.props.source)).toContain('class="legend"')
      // expanded, there are more routes than one drawing holds, and the pane says how many it left out
      if (stage === 'expanded') expect(await ui.find({ type: 'Text', text: /^\d+ quieter routes? not drawn/ })).toBeDefined()
      if (stage === 'collapsed') await ui.press({ key: 'expand-all' })
    }
    await ui.unmount()
    // too narrow for names to be read: the routes are listed, with how many more there are
    const narrow = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: 30 } })
    await narrow.press({ key: 'tab-graph' })
    expect((await narrow.findAll({ type: 'Svg' })).find(svg => String(svg.props.alt).startsWith('Post '))).toBeUndefined()
    expect(await narrow.find({ type: 'Text', text: /too narrow to draw this graph legibly/ })).toBeDefined()
    expect(await narrow.find({ type: 'Text', text: /@worker-\d+ → @/ })).toBeDefined()
    expect(await narrow.find({ type: 'Text', text: /^… and \d+ more$/ })).toBeDefined()
    await narrow.unmount()
  }
})

test('audit: a failed load of a browsed run says so, and Retry reads it again in place', async ($, on) => {
  // the current run has a title of its own, so a Retry that went back to it would show
  const roster = (title: string) => JSON.stringify({ title, closed: true, members: { coordinator: { role: 'coordinator', last_read_seq: 1 } } })
  let isBoardReadable = false
  // the browsed run's reads, of its board (directly or through the board's tail) and of its attention
  let boardReads = 0
  let attentionReads = 0
  auditEngine(on, path => {
    if (path.includes(OLD_RUN) && path.endsWith('/board.jsonl')) {
      boardReads++
      if (!isBoardReadable) throw new Error('EIO')
    }
    return path.endsWith('/board.jsonl') ? '' : roster(path.includes(OLD_RUN) ? 'Archive fixture' : 'Current fixture')
  })
  let isAttentionReadable = false
  on('process.run', (_, e) => {
    if (String(e.argv[2]).includes(OLD_RUN)) {
      if (e.argv[3] === 'attention') attentionReads++
      if (e.argv[3] === 'tail') boardReads++
    }
    return isAttentionReadable
      ? { value: { exitCode: 0, stdout: JSON.stringify({ items: [], members: {} }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
      : { value: { exitCode: 1, stdout: '', stderr: 'no python', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await clock.advance(2000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'run-prev' })
  await ui.press({ key: 'tab-attention' })
  expect(await ui.find({ type: 'Button', key: 'run-live' })).toBeDefined()
  // nothing promises a retry that a browsed run never makes, nor makes one unasked, and a board that could not be
  // read is not an empty one
  const tried = { boardReads, attentionReads }
  expect(tried.boardReads > 0 && tried.attentionReads > 0).toBe(true)
  await clock.advance(20000)
  expect({ boardReads, attentionReads }).toEqual(tried)
  expect(await ui.find({ type: 'Text', text: /Swarm will retry/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^Attention details unavailable for this run\.$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Board data unavailable/ })).toBeDefined()
  await ui.press({ key: 'tab-board' })
  expect(await ui.find({ type: 'Text', text: /^Board data unavailable/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /No posts yet/ })).toBeUndefined()
  await ui.press({ key: 'tab-attention' })
  isBoardReadable = isAttentionReadable = true
  const asked = { boardReads, attentionReads }
  expect(asked).toEqual(tried)
  await ui.press({ key: 'run-retry' })
  expect(boardReads > asked.boardReads && attentionReads > asked.attentionReads).toBe(true)
  // read again where the person stood: the same run, the same tab
  expect(await ui.find({ type: 'Text', text: /^Nothing needs attention\.$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Archive fixture$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Current fixture$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'run-retry' })).toBeUndefined()
  await ui.press({ key: 'tab-board' })
  expect(await ui.find({ type: 'Text', text: /^No posts yet\.$/ })).toBeDefined()
  await ui.unmount()
})

test('audit: a slow conversation cannot open under a different run', async ($, on) => {
  const roster = (title: string, name: string) => JSON.stringify({ title, closed: true, members: {
    coordinator: { role: 'coordinator', last_read_seq: 1 }, [name]: { role: 'worker', id: `${name}-id`, last_read_seq: 1 },
  } })
  const toasts = auditEngine(on, path => path.endsWith('/board.jsonl') ? '' : path.includes(OLD_RUN) ? roster('Older fixture', 'old-worker') : roster('Current fixture', 'live-worker'))
  on('ui.view', () => ({ value: { deny: 'no main view here' } }))
  let started = () => {}
  let release = () => {}
  let requesting = Promise.resolve()
  let delay = Promise.resolve()
  let answer: unknown
  on('session.messages', async () => {
    started()
    await delay
    return { value: answer as never }
  })
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await clock.advance(2000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // the audit's case, then a read that cannot be answered: either falls to nothing once the person has moved on
  for (const reply of [[{ role: 'user', text: 'Conversation from the current run', toolUses: [] }], { deny: 'agent live-worker-id cannot be read.' }]) {
    answer = reply
    requesting = new Promise<void>(resolve => { started = resolve })
    delay = new Promise<void>(resolve => { release = resolve })
    await ui.press({ key: 'tab-members' })
    const pending = ui.press({ key: 'view-live-worker' })
    try {
      await requesting
      await ui.press({ key: 'run-prev' })
    } finally {
      release()
      await pending
    }
    expect(await ui.find({ type: 'Text', text: /Older fixture/ })).toBeDefined()
    expect(await ui.find({ type: 'Markdown', text: /Conversation from the current run/ })).toBeUndefined()
    // nothing was done in the dropped answer's place: no toast, no switch away from Members, no filter
    expect(toasts).toEqual([])
    expect(await ui.find({ type: 'Text', text: /@old-worker/ })).toBeDefined()
    await ui.press({ key: 'tab-board' })
    expect(await ui.find({ type: 'Button', text: /Clear filter/ })).toBeUndefined()
    await ui.press({ key: 'run-live' })
  }
  await ui.unmount()
})

test('audit: the coordinator\'s conversation opens in the pane where this session drives the run, and is not offered where it does not', async ($, on) => {
  const { seen, answer, board } = owning(on, { board: () => BOARD, roster: () => ROSTER })
  on('process.run', (_, e) => answer(board(e)))
  on('tool.call', () => ({ result: {} }))
  on('agent.list', () => ({ value: [{ id: 'a1', description: '@parser', type: 'swarm:worker', status: 'running' }] as never }))
  on('ui.view', () => ({ value: { deny: 'no main view here' } }))
  const asked: (string | undefined)[] = []
  on('session.messages', (_, e) => {
    asked.push(e.agentId)
    return { value: [{ role: 'user', text: 'Plan the parser fix with two workers', toolUses: [] }, { role: 'assistant', text: 'Deploying the swarm.', toolUses: [] }] as never }
  })
  on('fs.list', () => ({ value: [{ name: 'older-20261101-090000', kind: 'dir' }, { name: OWNED.split('/').at(-1)!, kind: 'dir' }] as never }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-members' })
  await ui.press({ key: 'view-coordinator' })
  // the main conversation, in the pane, and no Board filter in its place
  expect(asked).toEqual([undefined])
  expect(await ui.find({ type: 'Markdown', text: /Plan the parser fix/ })).toBeDefined()
  expect(await ui.find({ type: 'Markdown', text: /Deploying the swarm/ })).toBeDefined()
  expect(seen.toasts).toEqual([])
  // the poller keeps it fresh: the main conversation never ends while the session runs
  await clock.advance(2000)
  expect(asked.length).toBeGreaterThan(1)
  expect(asked.every(id => id === undefined)).toBe(true)
  await ui.press({ key: 'talk-back' })
  // a run only looked at: its coordinator is another session, so only its posts are offered
  await ui.press({ key: 'run-prev' })
  await ui.press({ key: 'tab-members' })
  expect(await ui.find({ type: 'Button', key: 'view-coordinator' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'feed-coordinator' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Its conversation is not available here\.$/ })).toBeDefined()
  await ui.unmount()
})

test('audit: a READY with a base shows the first-parent commits since it and says merges are omitted; one without says it shows the last commit only', async ($, on) => {
  const sha = 'c'.repeat(40)
  const base = 'b'.repeat(40)
  const lines = [
    { seq: 1, agent: 'alice', to: ['coordinator'], text: `READY ${sha}\nParser done.`, time: '2026-11-16T14:04:22+0100', kind: 'ready', revision: sha, base },
    { seq: 2, agent: 'bob', to: ['coordinator'], text: `READY ${sha}\nLexer done.`, time: '2026-11-16T14:04:22+0100', kind: 'ready', revision: sha },
    { seq: 3, agent: 'carol', to: ['coordinator'], text: `READY ${sha}\nRuns done.`, time: '2026-11-16T14:04:22+0100', kind: 'ready', revision: sha, base: '--output=/tmp/x' },
  ].map(line => JSON.stringify(line)).join('\n') + '\n'
  const state = { title: 'Team', members: { coordinator: { role: 'coordinator', last_read_seq: 3 }, alice: { role: 'worker', id: 'alice-1', last_read_seq: 1 },
    bob: { role: 'worker', id: 'bob-1', last_read_seq: 1 }, carol: { role: 'worker', id: 'carol-1', last_read_seq: 1 } } }
  const { answer, board } = owning(on, { board: () => lines, roster: () => JSON.stringify(state) })
  const git: string[] = []
  on('process.run', (_, e) => {
    if (e.argv[0] !== 'git') return answer(board(e))
    git.push(e.argv.join(' '))
    // the work is in HEAD already, so what it adds to HEAD is nothing
    return answer(e.argv.includes('diff') ? '' : 'commit cccc\n piece.txt | 1 +\n')
  })
  on('agent.list', () => ({ value: [] }))
  on('tool.call', () => ({ result: {} }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'diff-1' })
  expect(git).toEqual([`git -C /project log --first-parent --no-merges --reverse --stat --patch --no-color --no-ext-diff ${sha} --not ${base}`])
  expect(await ui.find({ type: 'Text', text: /^First-parent commits since bbbbbbb · merges omitted$/ })).toBeDefined()
  expect(String((await ui.find({ type: 'Markdown', text: /piece\.txt/ }))?.text)).toMatch(/^```diff\n/)
  git.length = 0
  await ui.press({ key: 'diff-2' })
  expect(git).toEqual([`git -C /project diff --stat --patch --no-color --no-ext-diff HEAD...${sha}`, `git -C /project show --first-parent --stat --patch --no-color --no-ext-diff ${sha}`])
  expect(await ui.find({ type: 'Text', text: /^Last commit only \(ccccccc\): this report records no base/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /commits since/ })).toBeUndefined()
  // a base that is no full commit id never reaches git's command line
  git.length = 0
  await ui.press({ key: 'diff-3' })
  expect(git).toEqual([`git -C /project diff --stat --patch --no-color --no-ext-diff HEAD...${sha}`, `git -C /project show --first-parent --stat --patch --no-color --no-ext-diff ${sha}`])
  expect(await ui.find({ type: 'Text', text: /^Last commit only \(ccccccc\): this report records no base/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'diff-3' })).toBeDefined()
  await ui.unmount()
})

test('audit: a partial pass is labelled as one, a long recipient list opens, the replay and run steps are told apart, and a long title shows two lines with the rest a press away', async ($, on) => {
  const title = 'Normalize every input path, index the article metadata, and verify the release packaging end to end'
  const names = ['parser', 'lexer', 'indexer', 'packager', 'checker']
  const lines = [
    { seq: 1, agent: 'coordinator', to: names, text: `${names.map(name => `@${name}`).join(' ')} BRIEF\nStart.` },
    { seq: 2, agent: 'checker', to: ['coordinator'], text: '@coordinator VERIFIED cand-1 abcdef', partial: true, members: ['parser', 'lexer'] },
    { seq: 3, agent: 'checker', to: ['coordinator'], text: '@coordinator VERIFIED cand-2 abcdef' },
  ].map(line => JSON.stringify({ ...line, time: '2026-11-16T14:04:22+0100' })).join('\n') + '\n'
  const state = { title, members: Object.fromEntries([['coordinator', { role: 'coordinator', last_read_seq: 3 }],
    ...names.map(name => [name, { role: name === 'checker' ? 'verifier' : 'worker', last_read_seq: 3 }])]) }
  const { answer, board } = owning(on, { board: () => lines, roster: () => JSON.stringify(state) })
  on('process.run', (_, e) => answer(board(e)))
  on('agent.list', () => ({ value: [] }))
  on('tool.call', () => ({ result: {} }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)
  for (const columns of [36, 60, 140]) {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: columns } })
    // at most two lines of the title, cut at a word, beside a hive that gives way in a narrow pane; the whole title a press away
    const heading = async () => (await ui.find({ type: 'Text', text: /^Normalize every input path/ }))?.text
    const hive = (await ui.findAll({ type: 'Svg' })).find(svg => /Swarm hive/.test(String(svg.props.alt)))
    expect(hive?.props.width).toBe(columns < 48 ? 56 : 88)
    if (columns === 140) {
      expect(await heading()).toBe(title)
      expect(await ui.find({ type: 'Button', key: 'title-more' })).toBeUndefined()
    } else {
      const cut = await heading()
      expect(cut).toMatch(/\S …$/)
      expect(cut!.length).toBeLessThanOrEqual(2 * Math.floor((columns - (columns < 48 ? 8 : 11)) / 1.25) + 2)
      expect(title.startsWith(cut!.slice(0, -2))).toBe(true)
      await ui.press({ key: 'title-more' })
      expect(await heading()).toBe(title)
      expect((await ui.find({ type: 'Button', key: 'title-more' }))?.props.label).toBe('Show less of the title')
      await ui.press({ key: 'title-more' })
      expect(await heading()).toBe(cut)
    }
    await ui.unmount()
  }
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // a partial pass names the workers it covered, in a tone of its own; a full pass is still VERIFIED
  const partial = await ui.find({ type: 'Text', text: /^Partial pass · @parser @lexer$/ })
  expect(partial?.props.color).toBe('warning')
  expect((await ui.find({ type: 'Text', text: /^VERIFIED$/ }))?.props.color).toBe('success')
  // three recipients past the first two are one press away, and the opened post names them all
  expect(await ui.find({ type: 'Text', text: /^→ @parser @lexer$/ })).toBeDefined()
  await ui.press({ key: 'recipients-1' })
  expect(await ui.find({ type: 'Text', text: /^→ @parser @lexer @indexer @packager @checker$/ })).toBeDefined()
  await ui.press({ key: 'recipients-1' })
  expect(await ui.find({ type: 'Text', text: /^→ @parser @lexer$/ })).toBeDefined()
  // the expanded partial pass says what it is not
  await ui.press({ key: 'recipients-1' })
  await ui.press({ key: 'graph-post-2' })
  expect(await ui.find({ type: 'Text', text: / · Partial pass of @parser, @lexer$/ })).toBeDefined()
  // the run's steps and the replay's are labelled, and a step that leads nowhere is no control
  expect(await ui.find({ type: 'Text', text: /^Run$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Replay$/ })).toBeDefined()
  await ui.press({ key: 'replay-first' })
  expect(await ui.find({ type: 'Button', key: 'replay-first' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'replay-back' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'replay-next' })).toBeDefined()
  await ui.press({ key: 'tab-board' })
  await ui.unmount()
  // in the terminal an opened post lists every recipient too
  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await term.press({ key: 'recipients-1' })
  expect(await term.find({ type: 'Text', text: /@indexer @packager @checker/ })).toBeDefined()
  await term.unmount()
})

// The forensic scan of fb0ab9b: commits the shared-writer guard let through, members acting as another in Bash,
// and the guards a close turned off.

test('forensic: a shared writer\'s commit is refused through wrappers, functions, fed shells, aliases, expanded paths and exported repositories', async ($, on) => {
  const state = { title: 'Guard swarm', members: {
    coordinator: { role: 'coordinator', last_read_seq: 1 },
    alice: { role: 'worker', id: 'alice-1', paths: 'src/alice', isolated: '0', last_read_seq: 1 },
    vera: { role: 'verifier', id: 'vera-1', last_read_seq: 1 },
  } }
  const { answer, board } = owning(on, { board: () => posts({ agent: 'coordinator', to: ['alice'], text: '@alice BRIEF' }), roster: () => JSON.stringify(state) })
  on('process.run', (_, e) => answer(board(e)))
  on('agent.list', () => ({ value: [{ id: 'alice-1', description: '@alice', type: 'swarm:worker', status: 'running' }, { id: 'vera-1', description: '@vera', type: 'swarm:verifier', status: 'running' }] as never }))
  on('tool.call', () => ({ result: {} }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)
  const bash = (command: string, agentId = 'alice-1', run_in_background?: true) => toolCall($, { tool: 'Bash', command, agentId, ...(run_in_background && { run_in_background }) })
  for (const command of [
    'nice git commit -m x', 'timeout 60 git commit -m x', 'xcrun git commit -m x', 'stdbuf -o0 git commit -m x',
    'caffeinate -i git commit -m x', 'builtin command git commit -m x', 'env -- git commit -m x',
    'cd /$PWD && git commit -m x', 'git -C /$PWD commit -m x', 'cd "$PWD" && git commit -m x', 'cd ~/x && git commit -m x',
    'git --attr-source HEAD commit -m x', 'git -c alias.c=commit c -m x',
    'f() { git commit -m x; }; f', 'function f { git commit -m x; }; f',
    "echo 'git commit -m x' | sh", "sh <<< 'git commit -m x'",
    'export GIT_DIR=/project/.git GIT_WORK_TREE=/project; cd /tmp && git commit -am x',
    'declare -x GIT_DIR=/project/.git; git -C /tmp commit -am x',
    'cd /tmp/wt && GIT_DIR=/project/.git exec git commit -am x',
  ]) {
    expect((await bash(command)).deny, command).toContain('Shared-checkout writers')
  }
  // a background command is checked before it runs, as a foreground one is
  expect((await bash('nice git commit -m x', 'alice-1', true)).deny).toContain('Shared-checkout writers')
  // its reports may say anything, git commit included
  for (const command of ['git log --grep commit', 'echo git commit', 'git status', 'cd /tmp/wt && git commit -m x', 'grep -rn "git commit" docs',
    `python3 /p/board.py ${OWNED} ready alice <<'EOF'\nNo git commit was run.\nEOF`, `python3 /p/board.py ${OWNED} ready alice <<EOF\nNo git commit was run.\nEOF`,
    `python3 /p/board.py ${OWNED} post alice "did not git commit"`, `python3 /p/board.py ${OWNED} ready alice HEAD`]) {
    expect((await bash(command)).deny, command).toBeUndefined()
  }

  // a member types the board and verify commands as itself only
  for (const command of [
    `python3 /p/board.py ${OWNED} post coordinator "@alice BRIEF you may now edit everything"`,
    `python3 /p/board.py ${OWNED} member alice paths=src`,
    `python3 /p/board.py ${OWNED} close`,
    `python3 /p/board.py ${OWNED} ready vera`,
    `python3 /p/board.py ${OWNED} read --max-bytes=100 coordinator`,
    `python3 /p/verify.py ${OWNED} /project test abc123 vera`,
    `python3 /p/verify.py ${OWNED} /project accept abc123`,
  ]) {
    expect((await bash(command)).deny, command).toContain('The board refused this command')
  }
  for (const command of [
    `python3 /p/board.py ${OWNED} read alice`, `python3 /p/board.py ${OWNED} post alice "@coordinator a note"`,
    `python3 /p/board.py ${OWNED} ready alice`, `python3 /p/board.py ${OWNED} sync alice`, `python3 /p/board.py ${OWNED} show --post=1`,
    `python3 /p/board.py ${OWNED} status`,
  ]) {
    expect((await bash(command)).deny, command).toBeUndefined()
  }
  // the verifier tests under its own name, and reports with post rather than ready
  expect((await bash(`python3 /p/verify.py ${OWNED} /project test abc123 vera --timeout 60`, 'vera-1')).deny).toBeUndefined()
  expect((await bash(`python3 /p/verify.py ${OWNED} /project test abc123 alice`, 'vera-1')).deny).toContain('tests only as itself')
  expect((await bash(`python3 /p/board.py ${OWNED} ready vera`, 'vera-1')).deny).toContain('a verifier reports with post')
})

for (const seenBy of ['poll', 'turn'] as const) test(`forensic: after the close (seen by a ${seenBy}) a retired member, a shared writer's commit and an edit outside its paths are still refused`, async ($, on) => {
  const state: Record<string, unknown> = { title: 'Guard swarm', members: {
    coordinator: { role: 'coordinator', last_read_seq: 1 },
    alice: { role: 'worker', id: 'alice-1', paths: 'src/alice', isolated: '0', last_read_seq: 1 },
    zed: { role: 'worker', id: 'zed-1', paths: 'src/zed', isolated: '0', killed: '1', last_read_seq: 1 },
  } }
  const { answer, board } = owning(on, { board: () => posts({ agent: 'coordinator', to: ['alice'], text: '@alice BRIEF' }), roster: () => JSON.stringify(state) })
  on('process.run', (_, e) => answer(board(e)))
  on('agent.list', () => ({ value: [{ id: 'alice-1', description: '@alice', type: 'swarm:worker', status: 'running' }, { id: 'zed-1', description: '@zed', type: 'swarm:worker', status: 'running' }] as never }))
  on('tool.call', () => ({ result: {} }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)
  const refusals = async () => [
    (await toolCall($, { tool: 'Edit', file_path: '/project/src/zed/a.ts', old_string: 'a', new_string: 'b', agentId: 'zed-1' })).deny,
    (await toolCall($, { tool: 'Bash', command: 'git commit -m x', agentId: 'alice-1' })).deny,
    (await toolCall($, { tool: 'Edit', file_path: '/project/README.md', old_string: 'a', new_string: 'b', agentId: 'alice-1' })).deny,
  ]
  const open = await refusals()
  expect(open.every(deny => deny !== undefined)).toBe(true)
  state.closed = true
  // the close seen by one poll, or by the coordinator's own turn as it charges its usage, checked right after it:
  // guards the turn dropped and a later poll restored would pass otherwise
  if (seenBy === 'turn') {
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'c1', reason: 'answer',
      usage: { model: 'm', input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } })
  } else await clock.advance(2000)
  const closed = await refusals()
  expect(closed.map(deny => deny?.slice(0, 40))).toEqual(open.map(deny => deny?.slice(0, 40)))
  // inside its own paths it still edits
  expect((await toolCall($, { tool: 'Edit', file_path: '/project/src/alice/a.ts', old_string: 'a', new_string: 'b', agentId: 'alice-1' })).deny).toBeUndefined()
})

for (const isClosed of [false, true]) test(`forensic: once this conversation drives another run, the members of the ${isClosed ? 'closed' : 'open'} run it drove before are refused, and the new run's are judged by its own roster`, async ($, on) => {
  const NEXT = '/project/.swarm/next-20261122-100000'
  const stateA: Record<string, unknown> = { title: 'First swarm', members: {
    coordinator: { role: 'coordinator', last_read_seq: 1 },
    alice: { role: 'worker', id: 'alice-1', paths: 'src/alice', isolated: '0', last_read_seq: 1 },
    zed: { role: 'worker', id: 'zed-1', paths: 'src/zed', isolated: '0', killed: '1', last_read_seq: 1 },
    quiet: { role: 'worker', id: 'quiet-1', paths: 'src/quiet', isolated: '0', last_read_seq: 1 },
  } }
  // the same name in the next run, under another agent and other paths
  const stateB = { title: 'Next swarm', members: {
    coordinator: { role: 'coordinator', last_read_seq: 1 },
    alice: { role: 'worker', id: 'alice-b', paths: 'src/b', isolated: '0', last_read_seq: 1 },
  } }
  const { answer, board } = owning(on, {
    board: () => posts({ agent: 'coordinator', to: ['alice'], text: '@alice BRIEF' }),
    roster: () => JSON.stringify(stateA),
    read: path => path === `${NEXT}/members.json` ? JSON.stringify(stateB) : undefined,
  })
  // the board's agent-run lookup, as board.py answers it from the rosters
  const runOf: Record<string, string> = { 'alice-1': OWNED, 'zed-1': OWNED, 'quiet-1': OWNED, 'alice-b': NEXT }
  on('process.run', (_, e) => answer(e.argv[3] === 'agent-run' ? runOf[e.argv[5] ?? ''] ?? '' : board(e)))
  on('agent.list', () => ({ value: [
    ...['alice-1', 'zed-1', 'quiet-1', 'alice-b', 'helper-1'].map(id => ({ id, description: `@${id.split('-')[0]}`, type: 'swarm:worker', status: 'running' })),
  ] as never }))
  on('tool.call', () => ({ result: {} }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  const drive = async (dir: string) => {
    await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${dir}" read coordinator` })
    await clock.advance(2000)
  }
  const edit = async (file: string, agentId: string) => (await toolCall($, { tool: 'Edit', file_path: `/project/${file}`, old_string: 'a', new_string: 'b', agentId })).deny
  const commit = async (agentId: string) => (await toolCall($, { tool: 'Bash', command: 'git commit -m x', agentId })).deny
  const OVER = 'This Swarm run is over'
  await drive(OWNED)
  // under the first run: its own rules
  expect(await edit('src/zed/a.ts', 'zed-1')).toBeDefined()
  expect(await commit('alice-1')).toContain('Shared-checkout writers')
  expect(await edit('README.md', 'alice-1')).toBeDefined()
  if (isClosed) {
    stateA.closed = true
    await clock.advance(2000)
  }
  await drive(NEXT)
  // the first run's members, the one that never made a call under it included, are refused whatever they try
  for (const deny of [await edit('src/zed/a.ts', 'zed-1'), await commit('alice-1'), await edit('README.md', 'alice-1'),
    await edit('src/alice/a.ts', 'alice-1'), await edit('src/quiet/a.ts', 'quiet-1')]) {
    expect(deny).toContain(OVER)
  }
  // the next run's @alice by its own roster: inside its paths it edits, outside and committing it is refused, never as over
  expect(await edit('src/b/a.ts', 'alice-b')).toBeUndefined()
  expect(await edit('src/alice/a.ts', 'alice-b')).not.toContain(OVER)
  expect(await edit('src/alice/a.ts', 'alice-b')).toBeDefined()
  expect(await commit('alice-b')).toContain('Shared-checkout writers')
  // a subagent of no run is untouched
  expect(await edit('README.md', 'helper-1')).toBeUndefined()
  expect(await commit('helper-1')).toBeUndefined()
  // the next run closes: that makes no earlier run's agents welcome, and its own members keep its rules
  ;(stateB as Record<string, unknown>).closed = true
  // the coordinator's turn ends after the close: the hook sees it there and drives no run from then on
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'closing', reason: 'answer', usage: { model: 'm', input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } })
  await clock.advance(2000)
  expect(await edit('src/alice/a.ts', 'alice-1')).toContain(OVER)
  expect(await edit('src/quiet/a.ts', 'quiet-1')).toContain(OVER)
  expect(await commit('alice-b')).toContain('Shared-checkout writers')
  expect(await edit('src/alice/a.ts', 'alice-b')).not.toContain(OVER)
  // driving the first run again: its members are judged by its roster again, and the next run is the one over
  await drive(OWNED)
  expect(await edit('src/alice/a.ts', 'alice-1')).toBeUndefined()
  expect(await commit('alice-1')).toContain('Shared-checkout writers')
  expect(await edit('src/zed/a.ts', 'zed-1')).not.toContain(OVER)
  expect(await edit('src/zed/a.ts', 'zed-1')).toBeDefined()
  expect(await edit('src/b/a.ts', 'alice-b')).toContain(OVER)
})

test('review: what the coordinator spent under one run is charged to that run, though it drives another by the time the charge lands', async ($, on) => {
  const NEXT = '/project/.swarm/next-20261122-100000'
  const state = (title: string) => JSON.stringify({ title, members: { coordinator: { role: 'coordinator', last_read_seq: 1 } } })
  const { answer, board } = owning(on, {
    board: () => posts({ agent: 'coordinator', to: [], text: 'plan' }), roster: () => state('First swarm'),
    read: path => path === `${NEXT}/members.json` ? state('Next swarm') : undefined,
  })
  const charged: string[] = []
  const failed: string[] = []
  let isFailing = true
  on('process.run', (_, e) => {
    if (e.argv[3] !== 'account') return answer(board(e))
    // the step's own charge does not reach the board: it is left to the turn's end
    if (isFailing) {
      failed.push(String(e.argv[2]))
      return { value: { exitCode: 1, stdout: '', stderr: 'busy', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    charged.push(`${e.argv[2]} ${e.argv[6]}`)
    return answer(JSON.stringify({ title: 'x', total: 0, budget: 0, paused: false }))
  })
  on('agent.list', () => ({ value: [] }))
  on('tool.call', () => ({ result: {} }))
  const spent = { model: 'm', input_tokens: 250, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use' as const, usage: spent }
  })
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  const drive = async (dir: string) => {
    await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${dir}" read coordinator` })
    await clock.advance(2000)
  }
  await drive(OWNED)
  for await (const _ of $.turn.step({ turnId: 'long', index: 0, model: 'm', messageCount: 1 })) { /* no chunks */ }
  await clock.advance(0)
  // the step's charge was tried under the first run and did not land
  expect(failed).toEqual([OWNED])
  isFailing = false
  await drive(NEXT)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, reason: 'answer', turnId: 'long', usage: spent })
  expect(charged).toEqual([`${OWNED} 250`])
  // and the conversation does drive the next run by then: a turn of its own is charged there
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, reason: 'answer', turnId: 'after', usage: spent })
  expect(charged).toEqual([`${OWNED} 250`, `${NEXT} 250`])
})

// The review of the 0.3.47 audit fixes.

test('review: a slow agent list cannot move the main view to a run the person left, and an unchanged run still opens it', async ($, on) => {
  const roster = (title: string, name: string) => JSON.stringify({ title, closed: true, members: {
    coordinator: { role: 'coordinator', last_read_seq: 1 }, [name]: { role: 'worker', id: `${name}-id`, last_read_seq: 1 },
  } })
  // only the call the press makes is held: polls and renders are answered at once
  let gate: Promise<void> | undefined
  let started = () => {}
  const toasts = auditEngine(on, path => path.endsWith('/board.jsonl') ? '' : path.includes(OLD_RUN) ? roster('Older fixture', 'old-worker') : roster('Current fixture', 'live-worker'), async () => {
    const wait = gate
    gate = undefined
    if (wait) {
      started()
      await wait
    }
    return [{ id: 'live-worker-id', description: '@live-worker', type: 'swarm:worker', status: 'running' }]
  })
  const viewed: unknown[] = []
  on('ui.view', (_, e) => { viewed.push(e); return { value: {} as never } })
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await clock.advance(2000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-members' })
  let release = () => {}
  const requesting = new Promise<void>(resolve => { started = resolve })
  gate = new Promise<void>(resolve => { release = resolve })
  const pending = ui.press({ key: 'view-live-worker' })
  try {
    await requesting
    await ui.press({ key: 'run-prev' })
  } finally {
    release()
    await pending
  }
  // the main view stays where it was, and the run the person moved to is still shown
  expect(viewed).toEqual([])
  expect(await ui.find({ type: 'Text', text: /Older fixture/ })).toBeDefined()
  expect(toasts).toEqual([])
  // nobody moved: the main view opens the agent's conversation
  await ui.press({ key: 'run-live' })
  await ui.press({ key: 'tab-members' })
  await ui.press({ key: 'view-live-worker' })
  expect(viewed).toEqual([{ agentId: 'live-worker-id' }])
  await ui.unmount()
})

test('review: the main view is moved to the coordinator only for the run this session drives; another run\'s author shows its posts', async ($, on) => {
  const { seen, answer, board } = owning(on, { board: () => BOARD, roster: () => ROSTER })
  on('process.run', (_, e) => answer(board(e)))
  on('tool.call', () => ({ result: {} }))
  on('agent.list', () => ({ value: [{ id: 'a1', description: '@parser', type: 'swarm:worker', status: 'running' }] as never }))
  const viewed: unknown[] = []
  on('ui.view', (_, e) => { viewed.push(e); return { value: {} as never } })
  on('fs.list', () => ({ value: [{ name: 'older-20261101-090000', kind: 'dir' }, { name: OWNED.split('/').at(-1)!, kind: 'dir' }] as never }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // the run driven here: its coordinator is the main conversation, which the main view shows
  await ui.press({ key: 'agent-1' })
  expect(viewed).toEqual([{}])
  expect(await ui.find({ type: 'Button', text: /Clear filter/ })).toBeUndefined()
  // a run only looked at: the main view is not touched, and the author's posts are shown
  await ui.press({ key: 'run-prev' })
  await ui.press({ key: 'tab-board' })
  await ui.press({ key: 'agent-1' })
  expect(viewed).toEqual([{}])
  expect(await ui.find({ type: 'Button', text: /Clear filter/ })).toBeDefined()
  expect(seen.toasts).toEqual([])
  await ui.unmount()
})

test('review: routes listed in place of a graph count only the posts up to the replayed one; the terminal counts them all', async ($, on) => {
  const state = { title: 'Routes', members: { coordinator: { role: 'coordinator', last_read_seq: 3 },
    alice: { role: 'worker', id: 'alice-1', last_read_seq: 3 }, bob: { role: 'worker', id: 'bob-1', last_read_seq: 3 } } }
  const { answer, board } = owning(on, {
    board: () => posts({ agent: 'coordinator', to: ['alice'], text: '@alice BRIEF' }, { agent: 'alice', to: ['bob'], text: '@bob a question' },
      { agent: 'coordinator', to: ['alice'], text: '@alice go on' }),
    roster: () => JSON.stringify(state),
  })
  on('process.run', (_, e) => answer(board(e)))
  on('agent.list', () => ({ value: [] }))
  on('tool.call', () => ({ result: {} }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)
  const route = (count: number, edge: string) => ({ type: 'Text' as const, text: new RegExp(`^\\S+ ${count} {2}${edge}$`) })
  const narrow = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: 12 } })
  await narrow.press({ key: 'tab-graph' })
  expect(await narrow.find({ type: 'Text', text: /too narrow to draw this graph legibly/ })).toBeDefined()
  expect(await narrow.find(route(2, '@coordinator → @alice'))).toBeDefined()
  expect(await narrow.find(route(1, '@alice → @bob'))).toBeDefined()
  // at the first post, the later ones are neither listed nor counted
  await narrow.press({ key: 'replay-first' })
  expect(await narrow.find({ type: 'Text', text: /too narrow to draw this graph legibly/ })).toBeDefined()
  expect(await narrow.find(route(1, '@coordinator → @alice'))).toBeDefined()
  expect(await narrow.find({ type: 'Text', text: /@alice → @bob/ })).toBeUndefined()
  await narrow.unmount()
  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await term.press({ key: 'tab-graph' })
  expect(await term.find(route(2, '@coordinator → @alice'))).toBeDefined()
  expect(await term.find(route(1, '@alice → @bob'))).toBeDefined()
  await term.unmount()
})

test('review: a long route list shows a short page and the rest a press at a time, still counting only the posts up to the replayed one', async ($, on) => {
  const names = Array.from({ length: 30 }, (_, i) => `w${String(i + 1).padStart(2, '0')}`)
  const state = { title: 'Routes', members: { coordinator: { role: 'coordinator', last_read_seq: 30 },
    ...Object.fromEntries(names.map(name => [name, { role: 'worker', id: `${name}-id`, last_read_seq: 30 }])) } }
  const { answer, board } = owning(on, {
    board: () => posts(...names.map(name => ({ agent: name, to: ['coordinator'], text: '@coordinator a note' }))),
    roster: () => JSON.stringify(state),
  })
  on('process.run', (_, e) => answer(board(e)))
  on('agent.list', () => ({ value: [] }))
  on('tool.call', () => ({ result: {} }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)
  const narrow = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: 12 } })
  await narrow.press({ key: 'tab-graph' })
  // replayed to post 20: its twenty routes, a short page of them first
  for (let i = 0; i < 10; i++) await narrow.press({ key: 'replay-back' })
  // a route's line is tabular; the post shown below names its own route too
  const listed = async () => (await narrow.findAll({ type: 'Text', text: /→ @coordinator$/ })).filter(line => line.props.tabular).length
  expect(await listed()).toBe(12)
  expect(await narrow.find({ type: 'Text', text: '… and 8 more' })).toBeDefined()
  await narrow.press({ key: 'routes-more' })
  expect(await listed()).toBe(20)
  expect(await narrow.find({ type: 'Text', text: /\d {2}@w2[1-9] → / })).toBeUndefined()
  expect(await narrow.find({ key: 'routes-more' })).toBeUndefined()
  await narrow.press({ key: 'routes-fewer' })
  expect(await listed()).toBe(12)
  await narrow.unmount()
})

test('review: a shared writer\'s command is read through the wrappers it knows, and one it cannot read is still refused when it names a commit', async ($, on) => {
  const state = { title: 'Guard swarm', members: {
    coordinator: { role: 'coordinator', last_read_seq: 1 },
    alice: { role: 'worker', id: 'alice-1', paths: 'src/alice', isolated: '0', last_read_seq: 1 },
  } }
  const { answer, board } = owning(on, { board: () => posts({ agent: 'coordinator', to: ['alice'], text: '@alice BRIEF' }), roster: () => JSON.stringify(state) })
  on('process.run', (_, e) => answer(board(e)))
  on('agent.list', () => ({ value: [{ id: 'alice-1', description: '@alice', type: 'swarm:worker', status: 'running' }] as never }))
  on('tool.call', () => ({ result: {} }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)
  const deny = async (command: string) => (await toolCall($, { tool: 'Bash', command, agentId: 'alice-1' })).deny
  for (const command of [
    'timeout 60 git commit -m x', 'timeout -s KILL -k 5 --foreground --signal=TERM 60 git commit -m x', 'nice -n 5 git commit -m x',
    'nice -5 git commit -m x', 'nice --adjustment=5 git commit -m x', 'xcrun --sdk macosx -r git commit -m x', 'stdbuf -o L -eL git commit -m x',
    'caffeinate -di -t 60 git commit -m x', 'nohup time builtin command git commit -m x',
    // an option a wrapper is not known to take leaves the command unread: naming git and commit, it is refused
    'timeout --weird 60 git log --grep commit', 'caffeinate -z git log --grep commit', 'stdbuf --line git log --grep commit',
    // a cd or an exit a wrapper runs is a child's: the shell stays where it was
    'nice cd /tmp && git commit -m x', 'timeout 60 cd /tmp; git commit -m x', 'caffeinate -i exit; git commit -m x',
    'stdbuf -oL popd; git commit -m x', 'env cd /tmp && git commit -m x', 'nohup cd /tmp && git commit -m x',
  ]) {
    expect(await deny(command), command).toContain('Shared-checkout writers')
  }
  for (const command of [
    'timeout 60 git log --grep commit', 'timeout -s KILL --preserve-status 60 git log --grep commit', 'nice -n 5 git -C /x status',
    'nice -5 git log --grep commit', 'xcrun --sdk macosx git log --grep commit', 'stdbuf -oL -e 0 git log --grep commit',
    'caffeinate -i -w 123 git log --grep commit', 'caffeinate -it60 git log --grep commit',
  ]) {
    expect(await deny(command), command).toBeUndefined()
  }
})

// The shell reader behind the shared-checkout commit guard: compound commands, wrappers and the commands that commit.

/** A conversation driving a run whose @alice writes in the shared checkout; `config` answers `git config --get alias.<name>`. */
async function sharedWriter($: Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0], on: On, config: Record<string, { exitCode: number; stdout?: string }> = {}) {
  const state = { title: 'Guard swarm', members: {
    coordinator: { role: 'coordinator', last_read_seq: 1 },
    alice: { role: 'worker', id: 'alice-1', paths: 'src/alice', isolated: '0', last_read_seq: 1 },
  } }
  const { answer, board } = owning(on, { board: () => posts({ agent: 'coordinator', to: ['alice'], text: '@alice BRIEF' }), roster: () => JSON.stringify(state) })
  on('process.run', (_, e) => {
    const asked = e.argv[0] === 'git' && e.argv[3] === 'config' ? config[e.argv[5]?.replace(/^alias\./, '') ?? ''] : undefined
    return asked ? { value: { exitCode: asked.exitCode, stdout: asked.stdout ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } : answer(board(e))
  })
  on('agent.list', () => ({ value: [{ id: 'alice-1', description: '@alice', type: 'swarm:worker', status: 'running' }] as never }))
  on('tool.call', () => ({ result: {} }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)
  return async (command: string) => (await toolCall($, { tool: 'Bash', command, agentId: 'alice-1' })).deny
}
const REFUSED = 'Shared-checkout writers'

test('guard: a case is read arm by arm, so only an arm that commits is refused, wherever the arms leave the shell', async ($, on) => {
  const deny = await sharedWriter($, on)
  for (const command of [
    'case $x in a) git status ;; b) git commit -m x ;; esac', 'case $x in\n  a)\n    git commit -m x\n    ;;\nesac',
    // the arm that ran decides where the shell is after it, and no arm at all leaves it where it was
    'cd /tmp/wt && case $x in a) cd /project ;; esac && git commit -m x', 'case $x in a) cd /tmp/wt ;; esac && git commit -m x',
    // an arm that goes on into the next takes its folder with it
    'cd /tmp/wt && case $x in a) cd /project ;& b) git commit -m x ;; esac',
    // a pattern this cannot read leaves the case unread: it names a commit, so it is refused
    'case x in @(a|b)) git commit -m x ;; esac',
  ]) expect(await deny(command), command).toContain(REFUSED)
  for (const command of [
    'case $x in a) git status ;; b) echo commit ;; esac', 'case $x in a|b) git status ;; *) echo commit ;; esac',
    'cd /tmp/wt && case $x in a) echo ;; esac && git commit -m x', 'case "$1" in (--all) git add -A ;; esac',
  ]) expect(await deny(command), command).toBeUndefined()
})

test('guard: a compound piped onward keeps its cd to itself, and a comment in a substitution hides nothing', async ($, on) => {
  const deny = await sharedWriter($, on)
  for (const command of [
    '{ cd /tmp/wt; } | cat; git commit -m x', 'cd /project; while true; do cd /tmp/wt; break; done | cat; git commit -m x',
    'if true; then cd /tmp/wt; fi | cat; git commit -m x', 'cd /tmp/wt && { cd /project; } && git commit -m x',
    "x=$(echo a # it's fine\n git commit -m x)", '(git commit -m x) > /dev/null', 'cd /tmp/wt && (cd /project; git commit -m x)',
  ]) expect(await deny(command), command).toContain(REFUSED)
  for (const command of [
    '{ cd /tmp/wt; } && git commit -m x', "x=$(echo a # it's fine\n git status)", '(cd /tmp/wt && git commit -m x)',
    'cd /tmp/wt && (cd /project) && git commit -m x',
  ]) expect(await deny(command), command).toBeUndefined()
})

test('guard: an if, a loop, a function and eval are followed as the shell runs them', async ($, on) => {
  const deny = await sharedWriter($, on)
  for (const command of [
    // the branch not taken leaves the shell where the condition left it
    'if false; then cd /tmp/wt || exit; fi; git commit -m x',
    // a loop's second pass starts where its first one ended
    'cd /tmp/wt && for i in 1 2; do git commit -m x; cd /project; done', 'while read l; do git commit -m "$l"; done < list',
    // a function's body commits wherever it is called, and a call may move the shell
    'f() { git commit -m x; }', 'f() { cd /project; }; cd /tmp/wt && f && git commit -m x',
    // eval runs in this shell, and words a variable fills in may be any command
    'cd /tmp/wt && eval "cd /project" && git commit -m x', "C='git commit -m x'; eval \"$C\"", 'GIT=git; $GIT commit -m x',
    'cd /tmp/wt || git commit -m x', 'false && cd /tmp/wt; git commit -m x',
  ]) expect(await deny(command), command).toContain(REFUSED)
  for (const command of [
    'for f in a b; do git add "$f"; done', 'cd /tmp/wt && for i in 1 2; do git commit -m x; done',
    'if git diff --quiet; then echo clean; else echo commit needed; fi', 'cd /tmp/wt && eval "git commit -m x"',
    'cd /tmp/wt && cd .. && for i in 1 2 3 4 5 6 7 8; do cd ..; git commit -m x; done', 'f() { git status; }; f',
  ]) expect(await deny(command), command).toBeUndefined()
})

test('guard: every common wrapper is read through, or refused for sure when it cannot be', async ($, on) => {
  const deny = await sharedWriter($, on)
  // read: the commit refused, anything else let through
  for (const [refused, allowed] of [
    ['xargs git commit -m x', 'printf a | xargs git log --grep commit'],
    ['echo commit | xargs git', 'find . -name "*.ts" -exec git log --grep commit {} \\;'],
    ['xargs -I{} git {} -m x', 'watch -n 5 git status'],
    ['find . -name x -exec git commit -m x \\;', "watch -n 1 'git log --grep commit'"],
    ['cd /tmp/wt && find . -execdir git commit -m x {} +', 'sudo -u bob git status'],
    [`bash >'out file' -c 'git commit -m x'`, `bash -c '>out printf ok'`],
    [`bash -c '>out git commit -m x'`, `bash >> 'out file' -c 'git log --grep commit'`],
    ['watch -n 5 git commit -m x', 'cd /tmp/wt && sudo git commit -m x'],
    ["watch 'git commit -m x'", 'time -p git status'],
    ['sudo -u bob git commit -m x', 'env -i PATH=/usr/bin git log --grep commit'],
    ['cd /tmp/wt && sudo -D /project git commit -m x', "bash -lc 'git log --grep commit'"],
    ['cd /tmp/wt && sudo -i git commit -m x', 'sh -c "git status"'],
    ['time -p git commit -m x', 'eval "git status"'],
    ['env -i git commit -m x', 'bash <<< \'git status\''],
    ["bash -lc 'git commit -m x'", 'cat <<< "git commit"'],
    ['cd /tmp/wt && sh -c "cd /project && git commit -m x"', 'diff <(git show HEAD:a) a'],
    ['eval "git commit -m x"', 'cd /tmp/wt && sh -c "git commit -m x"'],
    ["sh <<< 'git commit -m x'", 'flock /tmp/l git status'],
    ['git commit -F - <<< "msg"', 'git status && git diff'],
    ['diff <(git commit -m x) /dev/null', 'git log | grep commit'],
    ['git status && git commit -m x', 'git stash && git stash pop'],
  ] as const) {
    expect(await deny(refused), refused).toContain(REFUSED)
    expect(await deny(allowed), allowed).toBeUndefined()
  }
  // deliberately refused: a wrapper it does not know before a command that names one, read or not, and a script a
  // substitution writes for a shell, a trap's script, wherever the shell is when it runs
  for (const command of ['flock /tmp/l git commit -m x', 'doas git commit -m x', 'parallel git log --grep commit ::: a', 'echo "git commit" | sh',
    "trap 'git commit -m x' EXIT", '. <(echo "git commit -m x")', 'source <(echo "git commit -m x")', "bash <(echo 'git commit -m x')"]) {
    expect(await deny(command), command).toContain(REFUSED)
  }
  // what only a report or a variable that names no commit says is not read as one
  for (const command of [
    `B="python3 /p/board.py ${OWNED}"; $B ready alice <<'EOF'\nNo git commit was run.\nEOF`, `$PY /p/board.py ${OWNED} post alice "git diff is clean, I am done"`,
    "trap 'rm -f /tmp/x' EXIT", '. ./env.sh && git status',
  ]) expect(await deny(command), command).toBeUndefined()
})

test('guard: every git command that makes a commit is refused, and aliases are followed to what they run', async ($, on) => {
  const deny = await sharedWriter($, on, { ci: { exitCode: 0, stdout: 'commit -v' }, lg: { exitCode: 0, stdout: 'log --oneline' }, sh: { exitCode: 0, stdout: '!git commit -am wip' }, zz: { exitCode: 2 } })
  for (const command of [
    'git merge feature', 'git merge --continue', 'git cherry-pick abc', 'git revert HEAD', 'git am x.patch', 'git rebase main', 'git pull',
    'git pull --rebase --ff-only', 'git commit-tree HEAD^{tree} -m x', 'git update-ref HEAD $(git commit-tree HEAD^{tree} -m x)',
    'git filter-branch --tree-filter true HEAD', 'git subtree add --prefix=x repo main', '/usr/lib/git-core/git-commit -m x',
    'git -c alias.p=cherry-pick p abc', 'git --config-env=alias.x=X x', 'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.x GIT_CONFIG_VALUE_0=commit git x -m y',
    // the repository's own aliases, a shell alias, one that cannot be read, and one this command sets
    'git ci -m x', 'git sh', 'git zz', 'git config alias.c commit && git c -m x',
  ]) expect(await deny(command), command).toContain(REFUSED)
  for (const command of [
    'git merge --abort', 'git merge --no-commit feature', 'git cherry-pick -n abc', 'git revert --no-commit HEAD', 'git rebase --abort',
    'git am --abort', 'git pull --ff-only', 'git stash', 'git stash pop', 'git -c alias.p=cherry-pick status', 'git lg', 'git update-ref refs/x HEAD',
  ]) expect(await deny(command), command).toBeUndefined()
})

test('guard: a member\'s board and verify commands are read through cd, env, python flags, quoting, shells and eval, and refused when hidden', async ($, on) => {
  const state = { title: 'Guard swarm', members: {
    coordinator: { role: 'coordinator', last_read_seq: 1 },
    alice: { role: 'worker', id: 'alice-1', paths: 'src/alice', isolated: '1', last_read_seq: 1 },
    vera: { role: 'verifier', id: 'vera-1', last_read_seq: 1 },
  } }
  const { answer, board } = owning(on, { board: () => posts({ agent: 'coordinator', to: ['alice'], text: '@alice BRIEF' }), roster: () => JSON.stringify(state) })
  on('process.run', (_, e) => answer(board(e)))
  on('agent.list', () => ({ value: [{ id: 'alice-1', description: '@alice', type: 'swarm:worker', status: 'running' }, { id: 'vera-1', description: '@vera', type: 'swarm:verifier', status: 'running' }] as never }))
  on('tool.call', () => ({ result: {} }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)
  const deny = async (command: string, agentId = 'alice-1') => (await toolCall($, { tool: 'Bash', command, agentId })).deny
  const B = `python3 /p/skills/swarm/scripts/board.py ${OWNED}`
  for (const command of [
    `cd /project/.claude/worktrees/agent-alice-1 && python3 -B /p/board.py ${OWNED} close`, `FOO=1 env python3 /p/board.py ${OWNED} close`,
    `python3 "/p/my scripts/board.py" ${OWNED} post coordinator x`, `python3 ./board.py ${OWNED} member alice paths=.`,
    `bash -c '${B} close'`, `sh -c "${B} post bob hi"`, `eval "${B} close"`, `X=$(${B} close)`, `echo "$(${B} member alice paths=.)"`,
    // a subcommand or a name that cannot be read
    `${B} $ACTION alice`, `${B} "$(echo close)"`, `${B} post "$ME" hi`, `${B} post $(whoami) hi`, `sudo ${B} close`, `timeout 9 ${B} read alice`,
    `python3 /p/verify.py ${OWNED} /project $ACT abc alice`,
  ]) expect(await deny(command), command).toContain('The board refused this command')
  // every documented member command still runs, in each documented form
  for (const command of [
    `${B} read alice`, `${B} show --post=3`, `${B} post alice <<'EOF'\n@coordinator a note\nEOF`, `${B} ready alice <<'EOF'\nREADY\nEOF`,
    `cd /project/.claude/worktrees/agent-alice-1 && ${B} ready alice HEAD`, `${B} revise alice "a reason"`, `${B} sync alice`,
    `${B} sync alice --check-only`, `${B} status`, `"${B.split(' ')[1]}" ${OWNED} read alice`, `python3 -B ${B.split(' ')[1]} "${OWNED}" read @alice`,
    'cat /p/skills/swarm/scripts/board.py', 'python3 -m py_compile /p/skills/swarm/scripts/board.py', 'git diff -- skills/swarm/scripts/board.py',
    // a command that only names the script runs none of it
    'find . -name board.py', 'ruff check skills/swarm/scripts/board.py', 'find . -name verify.py', 'mypy verify.py',
  ]) expect(await deny(command), command).toBeUndefined()
  expect(await deny(`python3 /p/verify.py ${OWNED} /project test abc vera`, 'vera-1')).toBeUndefined()
  expect(await deny(`python3 /p/verify.py ${OWNED} /project test abc "$WHO"`, 'vera-1')).toContain('tests only as itself')
  expect(await deny(`bash -c 'python3 /p/verify.py ${OWNED} /project accept abc'`, 'vera-1')).toContain("the coordinator's")
  // the commit after an acceptance is the coordinator's too, for a worker and for a verifier
  expect(await deny(`python3 /p/verify.py ${OWNED} /project commit abc -m land`, 'vera-1')).toContain("verify.py commit is the coordinator's")
  // the user's kill is the coordinator's alone: a member's is refused before the board runs, the coordinator's runs
  expect(await deny(`${B} kill`)).toContain("the board's kill is the coordinator's")
  expect(await deny(`${B} kill`, 'vera-1')).toContain("the board's kill is the coordinator's")
  expect((await toolCall($, { tool: 'Bash', command: `${B} kill` })).deny).toBeUndefined()
})

test('guard: a # inside a word is no comment, a substitution that never closes is refused, and git options are read in order with their values', async ($, on) => {
  const deny = await sharedWriter($, on)
  for (const command of [
    // an escaped blank is part of the word: `#b` opens no comment, and the substitution runs the commit
    'echo "$(git commit -m a\\ #b)"', 'x=$(git commit -m a\\ #b)', 'echo "$(git commit -m x"', 'echo `git commit -m x',
    // a value is never read as an option: -X ignore-space-change holds no -n
    'git cherry-pick -Xignore-space-change abc', 'git cherry-pick -X ignore-space-change abc', 'git cherry-pick --strategy-option -n abc',
    'git cherry-pick -mn abc', 'git merge -m --no-commit topic', 'git rebase --exec --abort main', 'git am --directory --abort x.patch',
    // the last of two opposite options wins
    'git merge --no-commit --commit --no-ff --no-edit topic', 'git cherry-pick -n --commit abc', 'git merge --no-commit --comm topic',
    'git pull --ff-only --ff', 'git pull --ff-only --reb', 'git pull --ff-only -r',
    // an alias this command defines, found by its name, whatever options stand before it
    'git config --file .git/config alias.c commit && git c -m x', 'git config -f .git/config alias.c commit; git c', 'alias g=git\ng commit -m x',
  ]) expect(await deny(command), command).toContain(REFUSED)
  for (const command of [
    'echo "$(git status # a\\ comment\n)"', 'echo a\\ \\#b # git commit', 'echo "$(git status a\\ #b)" commit', 'git cherry-pick -xn abc', 'git cherry-pick -m 1 -n abc',
    'git merge --commit --no-commit topic', 'git pull --ff --ff-only', 'git pull --ff-only --rebase=false', 'git pull --rebase --ff-only --no-rebase',
    'git am --show-current-patch=diff', 'git rebase --edit-todo', 'alias g=git\ng status', 'alias ll="ls -l"; ll',
  ]) expect(await deny(command), command).toBeUndefined()
})

test('guard: an interpreter\'s options are read with their values, and a program that names the board is refused', async ($, on) => {
  const state = { title: 'Guard swarm', members: {
    coordinator: { role: 'coordinator', last_read_seq: 1 },
    alice: { role: 'worker', id: 'alice-1', paths: 'src/alice', isolated: '1', last_read_seq: 1 },
  } }
  const { answer, board } = owning(on, { board: () => posts({ agent: 'coordinator', to: ['alice'], text: '@alice BRIEF' }), roster: () => JSON.stringify(state) })
  on('process.run', (_, e) => answer(board(e)))
  on('agent.list', () => ({ value: [{ id: 'alice-1', description: '@alice', type: 'swarm:worker', status: 'running' }] as never }))
  on('tool.call', () => ({ result: {} }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)
  const deny = async (command: string) => (await toolCall($, { tool: 'Bash', command, agentId: 'alice-1' })).deny
  for (const command of [
    // -Wonce is a warning option with its value: no c in it is a -c
    `python3 -Wonce /plugin/board.py ${OWNED} $ACTION`, `python3 -Wonce /p/verify.py ${OWNED} /project accept abc`, `python3 -W once -X dev /p/verify.py ${OWNED} /project prepare shared`,
    // a program that runs the board some other way
    `python3 -c "exec(open('/p/board.py').read())" ${OWNED} close`, `python3 -Bc 'import runpy' /p/board.py ${OWNED} close`, `python3 -m runpy /p/board.py ${OWNED} close`,
    `perl -e 'system("python3 /p/board.py ${OWNED} close")'`, `node -e 'require("child_process").execSync("python3 /p/board.py ${OWNED} close")'`,
    `echo "python3 /p/board.py ${OWNED} close" | bash -o pipefail`, `bash <<'EOF'\npython3 /p/board.py ${OWNED} close\nEOF`, `python3 - <<'EOF'\nimport os; os.system("python3 /p/board.py ${OWNED} close")\nEOF`,
    `env -S 'python3 /p/board.py ${OWNED} close'`, `echo "$(python3 /p/board.py ${OWNED} close"`,
    // -i reads more python from the input once the script has run
    `printf 'import os' | python3 -i /p/board.py ${OWNED} read alice`, `python3 -Bi /p/board.py ${OWNED} read alice`,
  ]) expect(await deny(command), command).toContain('The board refused this command')
  for (const command of [
    `python3 -Wonce /p/board.py ${OWNED} read alice`, "python3 -c 'print(1)'", 'python3 -m py_compile /p/board.py', "bash -o pipefail -c 'git status'",
    'perl -ne "print if /x/" notes.txt', `echo sh; python3 /p/board.py ${OWNED} read alice`,
  ]) expect(await deny(command), command).toBeUndefined()
})

test('guard: an agent of the run that its roster names nowhere is looked for again only once the roster changes or a start is recorded', async ($, on) => {
  const state = { title: 'Guard swarm', members: {
    coordinator: { role: 'coordinator', last_read_seq: 1 },
    alice: { role: 'worker', id: 'alice-1', paths: 'src/alice', isolated: '0', last_read_seq: 1 } as Record<string, unknown>,
  } }
  let rosterReads = 0
  let stamp = 1
  const { answer, board } = owning(on, { board: () => '', roster: () => { rosterReads++; return JSON.stringify(state) } })
  // the board places the agent in the owned run, though the roster has no member for it
  on('process.run', (_, e) => answer(e.argv[3] === 'agent-run' ? OWNED : board(e)))
  on('fs.stat', (_, e) => e.path.endsWith('/members.json') ? { value: { size: JSON.stringify(state).length, mtimeMs: stamp } as never } : { deny: 'none' })
  on('agent.list', () => ({ value: [{ id: 'alice-1', description: '@alice', type: 'swarm:worker', status: 'running' }, { id: 'ghost-1', description: 'a helper', type: 'swarm:worker', status: 'running' }] as never }))
  on('tool.call', () => ({ result: {} }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)
  const bash = async (command: string, agentId = 'ghost-1') => (await toolCall($, { tool: 'Bash', command, agentId })).deny
  expect(await bash('git status')).toBeUndefined()
  const after = rosterReads
  for (let i = 0; i < 5; i++) expect(await bash('git status')).toBeUndefined()
  expect(rosterReads).toBe(after)
  // the roster changes: the agent is now @alice's successor, and is guarded from that call on
  state.members.alice.id = 'ghost-1'
  stamp = 2
  expect(await bash('git commit -m x')).toContain('Shared-checkout writers')
  expect(rosterReads).toBe(after + 1)
  // a known member is never let past by the cache
  expect(await bash('git commit -m x')).toContain('Shared-checkout writers')
})

test('guard: a resume forgets no run driven before, a teammate is known by its address, and the coordinator is never a member', async ($, on) => {
  const NEXT = '/project/.swarm/next-20261122-100000'
  const stateA = { title: 'First swarm', members: {
    coordinator: { role: 'coordinator', last_read_seq: 1 },
    alice: { role: 'worker', id: 'alice-1', paths: 'src/alice', isolated: '0', last_read_seq: 1 },
    tess: { role: 'worker', id: 'tess@team', paths: 'src/tess', isolated: '0', last_read_seq: 1 },
  } }
  const stateB: Record<string, unknown> = { title: 'Next swarm', members: {
    coordinator: { role: 'coordinator', last_read_seq: 1 },
    bob: { role: 'worker', id: 'bob-b', paths: 'src/b', isolated: '0', last_read_seq: 1 },
  } }
  const { answer, board } = owning(on, {
    board: () => '', roster: () => JSON.stringify(stateA),
    read: path => path === `${NEXT}/members.json` ? JSON.stringify(stateB) : undefined,
  })
  // the board's own answers: which run an agent (or its address) belongs to, and what a resumed conversation restores
  const runOf: Record<string, string> = { 'alice-1': OWNED, 'tess@team': OWNED, 'bob-b': NEXT }
  let restored = ''
  on('process.run', (_, e) => answer(e.argv[3] === 'agent-run' ? e.argv.slice(5).map(id => runOf[id]).find(Boolean) ?? ''
    : e.argv[3] === 'restore' ? restored : board(e)))
  on('agent.list', () => ({ value: [
    { id: 'alice-1', description: '@alice', type: 'swarm:worker', status: 'running' },
    { id: 'tm-1', teammateId: 'tess@team', description: '@tess', type: 'swarm:worker', status: 'running' },
    { id: 'bob-b', description: '@bob', type: 'swarm:worker', status: 'running' },
  ] as never }))
  on('tool.call', () => ({ result: {} }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  const drive = async (dir: string) => {
    await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${dir}" read coordinator` })
    await clock.advance(2000)
  }
  const resume = async () => {
    await $.session.end({ reason: 'resume', sessionId: 'fixture-conversation', resume: { id: 'fixture-conversation' } })
    await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
    await clock.advance(2000)
  }
  const OVER = 'This Swarm run is over'
  await drive(OWNED)
  await drive(NEXT)
  restored = NEXT
  await resume()
  // the first run's members, the teammate known only by its address among them, are refused every tool, the board's included
  expect((await toolCall($, { tool: 'Bash', command: 'git status', agentId: 'alice-1' })).deny).toContain(OVER)
  expect((await toolCall($, { tool: 'Read', file_path: '/project/a', agentId: 'alice-1' })).deny).toContain(OVER)
  expect((await toolCall($, { tool: 'mcp__swarm__board', action: 'read', agentId: 'alice-1' })).deny).toContain(OVER)
  expect((await toolCall($, { tool: 'Edit', file_path: '/project/src/tess/a.ts', old_string: 'a', new_string: 'b', agentId: 'tm-1' })).deny).toContain(OVER)
  // the run driven now judges its own, and the coordinator is no member of any
  expect((await toolCall($, { tool: 'Bash', command: 'git status', agentId: 'bob-b' })).deny).toBeUndefined()
  expect((await toolCall($, { tool: 'Bash', command: 'git commit -m x', agentId: 'bob-b' })).deny).toContain('Shared-checkout writers')
  expect((await toolCall($, { tool: 'Bash', command: 'git commit -m x' })).deny).toBeUndefined()
  // closed, then resumed: the board restores no closed run, and its members are still guarded by its roster
  stateB.closed = true
  await clock.advance(2000)
  restored = ''
  await resume()
  expect((await toolCall($, { tool: 'Bash', command: 'git commit -m x', agentId: 'bob-b' })).deny).toContain('Shared-checkout writers')
  expect((await toolCall($, { tool: 'Edit', file_path: '/project/README.md', old_string: 'a', new_string: 'b', agentId: 'bob-b' })).deny).toContain('may only edit')
  expect((await toolCall($, { tool: 'Bash', command: 'git commit -m x' })).deny).toBeUndefined()
})

test('review: a member of a run this conversation no longer drives is refused its resume up front, and one of the run it drives resumes', async ($, on) => {
  const NEXT = '/project/.swarm/next-20261122-100000'
  const member = (id: string) => ({ role: 'worker', id, paths: 'src', isolated: '0', last_read_seq: 1 })
  const stateA = { title: 'First swarm', members: { coordinator: { role: 'coordinator', last_read_seq: 1 }, alice: member('alice-1') } }
  const stateB = { title: 'Second swarm', members: { coordinator: { role: 'coordinator', last_read_seq: 1 }, bob: member('bob-b') } }
  const { answer, board } = owning(on, { board: () => '', roster: () => JSON.stringify(stateA), read: path => path === `${NEXT}/members.json` ? JSON.stringify(stateB) : undefined })
  const runOf: Record<string, string> = { 'alice-1': OWNED, 'bob-b': NEXT }
  on('process.run', (_, e) => answer(e.argv[3] === 'agent-run' ? e.argv.slice(5).map(id => runOf[id]).find(Boolean) ?? '' : board(e)))
  on('agent.list', () => ({ value: [
    { id: 'alice-1', description: '@alice', type: 'swarm:worker', status: 'completed' },
    { id: 'bob-b', description: '@bob', type: 'swarm:worker', status: 'completed' },
  ] as never }))
  on('agent.spawn', (_, e) => ({ model: 'sonnet', agentId: e.resume?.agentId ?? 'started' }))
  on('tool.call', () => ({ result: {} }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  for (const dir of [OWNED, NEXT]) {
    await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${dir}" read coordinator` })
    await clock.advance(2000)
  }
  const resume = (agentId: string, name: string) => $.agent.spawn({
    tool_use_id: `again-${agentId}`, prompt: 'Go on.', description: `@${name}: go on`, subagentType: 'swarm:worker',
    provider: { plugin: 'swarm', tier: 'core' as const }, parentModel: 'sonnet', background: true, fork: false, resume: { agentId },
  } as never)
  // still open, the first run is no longer this conversation's: its member would be refused every tool call
  const refused = (await resume('alice-1', 'alice')).deny
  expect(refused).toContain('not resumed')
  expect(refused).toContain('next-20261122-100000')
  expect((await resume('bob-b', 'bob')).deny).toBeUndefined()
})

test('review: a run bound while the closed run\'s roster is read again keeps its own pause; with no such run the closed one keeps its retired members refused', async ($, on) => {
  const NEXT = '/project/.swarm/next-20261122-100000'
  const THIRD = '/project/.swarm/third-20261122-110000'
  const lead = { role: 'coordinator', last_read_seq: 1 }
  const member = (id: string, killed?: string) => ({ role: 'worker', id, paths: 'src', isolated: '0', last_read_seq: 1, ...killed ? { killed } : {} })
  const stateA = { title: 'First swarm', closed: false, members: { coordinator: lead, alice: member('alice-1'), old: member('old-1', '1') } }
  const stateB = { title: 'Second swarm', closed: false, members: { coordinator: lead, bob: member('bob-b') } }
  const stateC = { title: 'Third swarm', paused: 'held by the user', members: { coordinator: lead, cara: member('cara-c') } }
  // The second roster read of the closing run waits until the test lets it go: in between, another run is bound.
  let holdAt: string | undefined
  let reads = 0
  let reached = () => {}
  let release = () => {}
  const atHold = new Promise<void>(resolve => { reached = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  const rosters: Record<string, () => object> = { [OWNED]: () => stateA, [NEXT]: () => stateB, [THIRD]: () => stateC }
  on('command.register', () => ({ value: { command: 'swarm-board' } }))
  on('tool.register', (_, spec) => ({ value: { tool: `mcp__swarm__${spec.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'fixture-conversation' }))
  on('session.cwd', () => ({ value: '/project' }))
  on('fs.exists', () => ({ value: false }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('fs.read', async (_, e) => {
    const dir = e.path.slice(0, -'/members.json'.length)
    if (!e.path.endsWith('/members.json') || !rosters[dir]) return { value: '' }
    if (dir === holdAt && ++reads === 2) {
      reached()
      await held
    }
    return { value: JSON.stringify(rosters[dir]!()) }
  })
  const runOf: Record<string, string> = { 'alice-1': OWNED, 'old-1': OWNED, 'bob-b': NEXT, 'cara-c': THIRD }
  const answer = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('process.run', (_, e) => answer(e.argv[3] === 'agent-run' ? e.argv.slice(5).map(id => runOf[id]).find(Boolean) ?? ''
    : e.argv[3] === 'account' ? JSON.stringify({ title: 't', total: 1, budget: 0, paused: false }) : ''))
  on('agent.list', () => ({ value: ['alice-1', 'old-1', 'bob-b', 'cara-c'].map(id => ({ id, description: id, type: 'swarm:worker', status: 'running' })) as never }))
  on('tool.call', () => ({ result: {} }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  const drive = async (dir: string) => {
    await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${dir}" read coordinator` })
    await clock.advance(2000)
  }
  const usage = { model: 'm', input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  const complete = (turnId: string) => $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId, reason: 'answer', usage })
  const reads$ = (agentId: string) => toolCall($, { tool: 'Read', file_path: '/project/a.ts', agentId })
  // closed with no run taking over: the run's retired member is still refused by name
  await drive(OWNED)
  stateA.closed = true
  await complete('c1')
  expect((await reads$('old-1')).deny).toContain('has been retired')
  // closed while a paused run is bound before its roster is read again: the bound run keeps its pause
  await drive(NEXT)
  stateB.closed = true
  holdAt = NEXT
  const completing = complete('c2')
  try {
    // an end before the held read is a failure here and now, not a wait for the test's time to run out
    await Promise.race([atHold, completing.then(() => { throw new Error('the turn ended before its roster read was held') })])
    await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${THIRD}" read coordinator` })
  } finally {
    release()
  }
  await completing
  expect((await reads$('cara-c')).deny).toContain('paused')
})

test('review: a roster that could not be read is read again on the next call, so a member assigned since is guarded', async ($, on) => {
  const state = { title: 'Guard swarm', members: {
    coordinator: { role: 'coordinator', last_read_seq: 1 },
    alice: { role: 'worker', id: 'alice-1', paths: 'src/alice', isolated: '0', last_read_seq: 1 } as Record<string, unknown>,
  } }
  let isBroken = false
  let rosterReads = 0
  const { answer, board } = owning(on, { board: () => '', roster: () => { rosterReads++; if (isBroken) throw new Error('EIO'); return JSON.stringify(state) } })
  on('process.run', (_, e) => answer(e.argv[3] === 'agent-run' ? OWNED : board(e)))
  on('fs.stat', (_, e) => e.path.endsWith('/members.json') ? { value: { size: 10, mtimeMs: 1 } as never } : { deny: 'none' })
  on('agent.list', () => ({ value: [{ id: 'alice-1', description: '@alice', type: 'swarm:worker', status: 'running' }, { id: 'ghost-1', description: 'a helper', type: 'swarm:worker', status: 'running' }] as never }))
  on('tool.call', () => ({ result: {} }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)
  // the roster's stat answers and its read fails: the agent is no known miss of that stamp
  state.members.alice.id = 'ghost-1'
  isBroken = true
  let before = rosterReads
  expect((await toolCall($, { tool: 'Bash', command: 'git status', agentId: 'ghost-1' })).deny).toBeUndefined()
  expect(rosterReads).toBeGreaterThan(before)  // it was tried, and failed
  // readable again under the same stamp: it is read once more, the agent is now @alice, and its commit is refused
  isBroken = false
  before = rosterReads
  expect((await toolCall($, { tool: 'Bash', command: 'git commit -m x', agentId: 'ghost-1' })).deny).toContain('Shared-checkout writers')
  expect(rosterReads).toBeGreaterThan(before)
})

test('view diff: a READY\'s except leaves those commits out beside its base, and an except that is not all full ids is dropped', async ($, on) => {
  const [sha, base, one, two] = ['c', 'b', 'd', 'e'].map(ch => ch.repeat(40)) as [string, string, string, string]
  const lines = [
    { seq: 1, agent: 'alice', to: ['coordinator'], text: `READY ${sha}\nParser done.`, time: '2026-11-16T14:04:22+0100', kind: 'ready', revision: sha, base, except: [one, two] },
    { seq: 2, agent: 'bob', to: ['coordinator'], text: `READY ${sha}\nLexer done.`, time: '2026-11-16T14:04:22+0100', kind: 'ready', revision: sha, base, except: [one, '--output=/tmp/x'] },
    { seq: 3, agent: 'carol', to: ['coordinator'], text: `READY ${sha}\nRuns done.`, time: '2026-11-16T14:04:22+0100', kind: 'ready', revision: sha, except: [one] },
  ].map(line => JSON.stringify(line)).join('\n') + '\n'
  const state = { title: 'Team', members: { coordinator: { role: 'coordinator', last_read_seq: 3 }, alice: { role: 'worker', id: 'alice-1', last_read_seq: 1, start: sha },
    bob: { role: 'worker', id: 'bob-1', last_read_seq: 1 }, carol: { role: 'worker', id: 'carol-1', last_read_seq: 1 } } }
  const { answer, board } = owning(on, { board: () => lines, roster: () => JSON.stringify(state) })
  const git: string[] = []
  on('process.run', (_, e) => {
    if (e.argv[0] !== 'git') return answer(board(e))
    git.push(e.argv.slice(3).join(' '))
    return answer('commit cccc\n piece.txt | 1 +\n')
  })
  on('agent.list', () => ({ value: [] }))
  on('tool.call', () => ({ result: {} }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const shape = '--first-parent --no-merges --reverse --stat --patch --no-color --no-ext-diff'
  for (const [key, expected] of [['diff-1', `log ${shape} ${sha} --not ${base} ${one} ${two}`], ['diff-2', `log ${shape} ${sha} --not ${base}`]] as const) {
    git.length = 0
    await ui.press({ key })
    expect(git).toEqual([expected])
    expect(await ui.find({ type: 'Text', text: /^First-parent commits since bbbbbbb · merges omitted$/ })).toBeDefined()
  }
  // without a base an except means nothing
  git.length = 0
  await ui.press({ key: 'diff-3' })
  expect(git).toEqual([`diff --stat --patch --no-color --no-ext-diff HEAD...${sha}`])
  expect(await ui.find({ type: 'Text', text: /^What ccccccc changes since it branched from HEAD/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /commits since/ })).toBeUndefined()
  await ui.unmount()
})

test('a run the coordinator\'s read could not bind is said so in the tool result', async ($, on) => {
  const { answer, board, seen } = owning(on, { board: () => '', roster: () => ROSTER })
  on('process.run', (_, e) => e.argv[3] === 'bind' ? { value: { exitCode: 1, stdout: '', stderr: 'owned elsewhere', isStdoutTruncated: false, isStderrTruncated: false } } : answer(board(e)))
  on('agent.list', () => ({ value: [] }))
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  const result = await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  expect(result.context?.join('\n')).toContain('could not be bound to this conversation')
  expect(seen.toasts).toEqual([])
})

test('the run row knows its ends as the pane opens: a step that leads nowhere is text from the first look, with no toast', async ($, on) => {
  const { seen, answer, board } = owning(on, { board: () => BOARD, roster: () => ROSTER })
  on('process.run', (_, e) => answer(board(e)))
  on('tool.call', () => ({ result: {} }))
  on('agent.list', () => ({ value: [] }))
  let listed = [{ name: OWNED.split('/').at(-1)!, kind: 'dir' }]
  on('fs.list', () => ({ value: listed as never }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await clock.advance(0)
  // the only run: neither step leads anywhere, and neither was pressed to find that out
  expect(await ui.find({ type: 'Button', key: 'run-prev' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'run-next' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^‹ Prev run$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Next run ›$/ })).toBeDefined()
  expect(seen.toasts).toEqual([])
  await ui.unmount()
  // an older run beside it: that way is a control
  listed = [{ name: 'older-20261101-090000', kind: 'dir' }, ...listed]
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)
  const again = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await clock.advance(0)
  expect(await again.find({ type: 'Button', key: 'run-prev' })).toBeDefined()
  expect(await again.find({ type: 'Button', key: 'run-next' })).toBeUndefined()
  await again.unmount()
})

test('review: a folder whose roster is no roster is no run to step to, and a pane opened again reads the run row anew', async ($, on) => {
  const { answer, board } = owning(on, {
    board: () => BOARD, roster: () => ROSTER,
    // parses, and holds neither a title nor a coordinator: board.py would not read it either
    read: path => path.includes('/broken-') && path.endsWith('/members.json') ? '{"members":{}}' : undefined,
  })
  on('process.run', (_, e) => answer(board(e)))
  on('tool.call', () => ({ result: {} }))
  on('agent.list', () => ({ value: [] }))
  let listed = [{ name: 'broken-20261001-090000', kind: 'dir' }, { name: OWNED.split('/').at(-1)!, kind: 'dir' }]
  on('fs.list', () => ({ value: listed as never }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await clock.advance(0)
  expect(await ui.find({ type: 'Button', key: 'run-prev' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^‹ Prev run$/ })).toBeDefined()
  await ui.unmount()
  // a run made meanwhile, in the same session: the pane opened again finds it
  listed = [{ name: 'older-20261101-090000', kind: 'dir' }, ...listed]
  await $.command.run({ command: 'swarm-board', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 80 } })
  const again = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await clock.advance(0)
  expect(await again.find({ type: 'Button', key: 'run-prev' })).toBeDefined()
  await again.unmount()
})

test('the graph says in its alt what it draws, and its routes are listed in words a press away, with no attribute the host ignores', async ($, on) => {
  const state = { title: 'Routes', members: { coordinator: { role: 'coordinator', last_read_seq: 2 },
    alice: { role: 'worker', id: 'alice-1', last_read_seq: 2 }, bob: { role: 'worker', id: 'bob-1', last_read_seq: 2 } } }
  const { answer, board } = owning(on, {
    board: () => posts({ agent: 'coordinator', to: ['alice'], text: '@alice BRIEF' }, { agent: 'alice', to: ['bob'], text: '@bob a question' }),
    roster: () => JSON.stringify(state),
  })
  on('process.run', (_, e) => answer(board(e)))
  on('agent.list', () => ({ value: [] }))
  on('tool.call', () => ({ result: {} }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: 120 } })
  await ui.press({ key: 'tab-graph' })
  const graph = (await ui.findAll({ type: 'Svg' })).find(svg => /mention graph/.test(String(svg.props.alt)))
  expect(String(graph?.props.alt)).toBe('Post 2 · @alice to @bob. A mention graph of 3 members: List the routes below for each one in words.')
  expect(String(graph?.props.source)).not.toContain('aria-')
  expect(await ui.find({ type: 'Text', text: /^\S+ 1 {2}@alice → @bob$/ })).toBeUndefined()
  await ui.press({ key: 'graph-routes' })
  expect(await ui.find({ type: 'Text', text: /1 {2}@coordinator → @alice$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 {2}@alice → @bob$/ })).toBeDefined()
  await ui.press({ key: 'graph-routes' })
  expect(await ui.find({ type: 'Text', text: /^\S+ 1 {2}@alice → @bob$/ })).toBeUndefined()
  await ui.unmount()
})

// A conversation that drives no run, in a project whose open run another conversation owns: Swarm stays out of its way.
function strangerTo(on: On, agents: unknown[] = [{ id: 'gp1', description: 'Fix the tests', type: 'general-purpose', status: 'running' }]) {
  const other = '/project/.swarm/other-20261117-090000'
  const seen = { commands: [] as string[], calls: [] as { run: string; action: string }[], reads: [] as string[], placed: [] as string[], opened: [] as string[], toasts: [] as string[], prompts: [] as string[], sends: [] as string[] }
  on('command.register', () => ({ value: { command: 'swarm-board' } }))
  on('tool.register', (_, spec) => ({ value: { tool: `mcp__swarm__${spec.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'this-conversation' }))
  on('session.cwd', () => ({ value: '/project' }))
  on('session.usage', () => ({ value: { context: { tokens: 900_000 } } as never }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.place', (_, e) => { seen.placed.push(e.id); return { value: { isPlaced: true, requestId: e.id } } })
  on('ui.open', (_, e) => { seen.opened.push(e.id); return { value: { isPlaced: true } } })
  on('ui.toast', (_, e) => { seen.toasts.push(e.text); return { value: undefined } })
  on('prompt.submit', (_, e) => { seen.prompts.push(e.text); return { text: e.text } })
  on('session.send', (_, e) => { seen.sends.push(e.text); return { isDelivered: true } })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('fs.exists', () => ({ value: true }))
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } as never }))
  on('fs.read', (_, e) => (seen.reads.push(e.path), {
    value: e.path === '/project/.swarm/current' ? 'other-20261117-090000\n'
      : e.path.endsWith('/members.json') ? JSON.stringify({ title: 'Theirs', binding: 'another-conversation', members: { coordinator: { role: 'coordinator' }, alice: { role: 'worker', id: 'alice-1' } } })
      : e.path.endsWith('/board.jsonl') ? posts({ agent: 'coordinator', to: ['alice'], text: '@alice BRIEF' }) : '',
  }))
  // The board answers as board.py does for a run of another conversation's: nothing restores, locates or binds here.
  on('process.run', (_, e) => {
    const isBoard = e.argv[0] === 'python3'
    if (isBoard) {
      seen.commands.push(e.argv.slice(3).join(' '))
      seen.calls.push({ run: e.argv[2] ?? '', action: e.argv[3] ?? '' })
    }
    const refused = isBoard && e.argv[3] === 'bind'
    return { value: { exitCode: refused ? 1 : 0, stdout: '', stderr: refused ? 'owned by another conversation' : '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('agent.list', () => ({ value: agents as never }))
  on('agent.spawn', (_, e) => ({ model: 'sonnet', agentId: e.resume?.agentId ?? 'started' }))
  on('tool.call', () => ({ result: {} }))
  return { other, seen }
}

test('no run here: a swarm: agent is not started or resumed, and Explore and general-purpose agents start as ever', async ($, on) => {
  const { seen } = strangerTo(on)
  mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  const spawn = {
    tool_use_id: 'fixture', prompt: 'Look around.', description: 'scout the parser', subagentType: 'swarm:explorer',
    provider: { plugin: 'swarm', tier: 'core' as const }, parentModel: 'sonnet', background: true, fork: false,
  }
  // Unnamed, the project's open run is pointed at; named, the name is on no run this conversation could drive.
  expect((await $.agent.spawn(spawn)).deny).toContain('open Swarm run')
  expect((await $.agent.spawn({ ...spawn, description: '@scout: the parser' })).deny).toContain('swarm: agents run only inside a Swarm run the user started with /swarm:swarm')
  expect((await $.agent.spawn({ ...spawn, description: '@alice: the parser', subagentType: 'swarm:worker' })).deny).toContain('swarm: agents run only inside a Swarm run')
  expect((await $.agent.spawn({ ...spawn, resume: { agentId: 'alice-1' } })).deny).toContain('swarm: agents run only inside a Swarm run')
  for (const subagentType of ['Explore', 'general-purpose']) {
    const started = await $.agent.spawn({ ...spawn, subagentType })
    expect(started.deny).toBeUndefined()
    expect(started.agentId).toBe('started')
  }
  expect(seen.commands.filter(command => command.startsWith('bind'))).toEqual([])
})

test('no run here: the board tool refuses in a sentence, and makes, adopts and reads nothing', async ($, on) => {
  const { seen } = strangerTo(on, [
    { id: 'gp1', description: 'Fix the tests', type: 'general-purpose', status: 'running' },
    { id: 'x1', description: '@scout: look', type: 'swarm:explorer', status: 'running' },
  ])
  mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  const before = seen.commands.length
  for (const caller of [{}, { agentId: 'gp1' }, { agentId: 'x1' }]) {
    for (const action of ['read', 'status', 'post'] as const) {
      const answer = await toolCall($, { tool: 'mcp__swarm__board', action, ...(action === 'post' && { text: 'hello' }), ...caller })
      expect(answer.deny).toBe('There is no Swarm run here: the board tool works only inside a Swarm run the user started with /swarm:swarm.')
    }
  }
  // Only lookups that consider no other conversation's run: none reads its board, binds or makes one.
  expect(seen.commands.slice(before).filter(command => !/^(agent-run|locate) /.test(command))).toEqual([])
  expect(seen.placed).toEqual([])
})

test('no run here: tool calls, turns and the chat are left as they are, though another conversation runs one in the project', async ($, on) => {
  const { other, seen } = strangerTo(on)
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'Fix the tests', turnId: 't1' })
  const calls = [
    { tool: 'Bash', command: 'npm test' },
    { tool: 'Bash', command: 'npm run watch', run_in_background: true },
    { tool: 'Monitor', command: 'tail -f log', description: 'watch the log', timeout_ms: 60_000 },
    { tool: 'Edit', file_path: '/project/src/a.ts', old_string: 'a', new_string: 'b', agentId: 'gp1' },
    { tool: 'Write', file_path: '/project/src/b.ts', content: '', agentId: 'gp1' },
    { tool: 'Bash', command: 'git add -A && git commit -m fix', agentId: 'gp1' },
    { tool: 'Bash', command: 'git commit -m fix' },
  ] as const
  for (const call of calls) {
    const answer = await toolCall($, call)
    expect(answer.deny).toBeUndefined()
    expect(answer.context).toBeUndefined()
  }
  await clock.advance(5000)
  await $.turn.complete({ answer: 'Done.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(60_000)
  expect({ placed: seen.placed, opened: seen.opened, toasts: seen.toasts, prompts: seen.prompts, sends: seen.sends }).toEqual({ placed: [], opened: [], toasts: [], prompts: [], sends: [] })
  // by run and by action: nothing was asked of the other run's folder, and nothing bound, read or charged anywhere
  expect(seen.calls.filter(call => call.run === other || ['bind', 'tail', 'account', 'read', 'started'].includes(call.action))).toEqual([])
  expect(seen.reads.filter(path => path === `${other}/board.jsonl`)).toEqual([])
  // Only a board command typed for that run claims it; the board refuses, and the claim that failed is said.
  const claimed = await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${other}" read coordinator` })
  expect(claimed.deny).toBeUndefined()
  expect(claimed.context?.join('\n')).toContain('could not be bound to this conversation')
  expect(seen.placed).toEqual([])
  // Above the prompt the terminal draws nothing of Swarm's; the desktop keeps the button that lets the person look.
  const above = (surface: 'desktop' | 'terminal') => $.ui.mount({
    component: 'AbovePrompt', plugin: 'swarm', surface,
    props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 3, bodyColumns: 60, scroll: { offset: 0, bodyRows: 3 }, view: {} },
  })
  const terminal = await above('terminal')
  expect(await terminal.find({ type: 'Button', text: /Swarm/ })).toBeUndefined()
  await terminal.unmount()
  const desktop = await above('desktop')
  expect(await desktop.find({ type: 'Button', text: 'Swarm: The Board' })).toBeDefined()
  await desktop.unmount()
  expect(seen.opened).toEqual([])
})

test('no run here: a project Swarm never ran in shows no board shortcut on Desktop', async ($, on) => {
  on('ui.panes', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.register', (_, spec) => ({ value: { tool: `mcp__swarm__${spec.name}` } }))
  on('command.register', (_, spec) => ({ value: { command: spec.name } }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', () => { throw new Error('ENOENT') })
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({
    component: 'AbovePrompt', plugin: 'swarm', surface: 'desktop',
    props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 3, bodyColumns: 80, scroll: { offset: 0, bodyRows: 3 }, view: {} },
  })
  expect(await band.find({ key: 'swarm-board-shortcut' })).toBeUndefined()
})

test('review: with its pane down, a conversation follows the run it drove until its close, not whatever run is the project\'s newest by then', async ($, on) => {
  const other = '/project/.swarm/other-20261123-090000'
  const state: Record<string, unknown> = { title: 'Mine', members: { coordinator: { role: 'coordinator', last_read_seq: 1 } } }
  const reads: string[] = []
  const { answer, board } = owning(on, {
    board: () => '', roster: () => JSON.stringify(state),
    read: path => {
      reads.push(path)
      // another conversation started a run since: the project's pointer names it now
      return path.endsWith('/current') ? 'other-20261123-090000\n'
        : path.startsWith(other) ? JSON.stringify({ title: 'Theirs', members: { coordinator: { role: 'coordinator', last_read_seq: 0 } } }) : undefined
    },
    exists: true,
  })
  on('process.run', (_, e) => answer(board(e)))
  on('agent.list', () => ({ value: [] }))
  on('tool.call', () => ({ result: {} }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)
  state.closed = true
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'closing', reason: 'answer', usage: { model: 'm', input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } })
  reads.length = 0
  await clock.advance(10_000)
  expect(reads.filter(path => path.startsWith(other))).toEqual([])
  expect(reads.some(path => path.startsWith(OWNED))).toBe(true)
})

test('/swarm-kill with no run driven from this conversation answers so and runs nothing', async ($, on) => {
  const { seen, answer, board } = owning(on, { board: () => '', roster: () => '{}' })
  on('process.run', (_, e) => answer(board(e)))
  let ran = 0
  on('command.run', () => { ran++; return { text: '' } })
  mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  const killed = await $.command.run({ command: 'swarm-kill', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 80 } })
  expect(killed.text).toContain('No Swarm run is driven from this conversation')
  expect([ran, seen.commands.filter(c => c.startsWith('kill'))]).toEqual([0, []])
})

for (const compaction of ['done', 'skipped'] as const) test(`/swarm-kill retires the run with no model turn, drops what its members send back, and keeps the skill away until a new run (compaction ${compaction})`, async ($, on) => {
  const state: Record<string, unknown> = { title: 'Kill swarm', members: {
    coordinator: { role: 'coordinator', last_read_seq: 1 },
    alice: { role: 'worker', id: 'alice-1', paths: 'src/alice', isolated: '0', last_read_seq: 1 },
    zed: { role: 'worker', id: 'zed-1', paths: 'src/zed', isolated: '0', last_read_seq: 1 },
  } }
  const { seen, answer, board } = owning(on, { board: () => posts({ agent: 'coordinator', to: ['alice'], text: '@alice BRIEF' }), roster: () => JSON.stringify(state) })
  on('process.run', (_, e) => {
    if (e.argv[3] !== 'kill') return answer(board(e))
    board(e)
    state.closed = true
    for (const member of Object.values(state.members as Record<string, Record<string, string>>)) if (member.role !== 'coordinator') member.killed = '1'
    return answer('killed: 2 member(s) retired, run closed\n@alice alice-1\n@zed zed-1\n')
  })
  on('agent.list', () => ({ value: [{ id: 'alice-1', description: '@alice', type: 'swarm:worker', status: 'running' }] as never }))
  on('tool.call', () => ({ result: {} }))
  let ran = 0
  on('command.run', () => { ran++; return { text: '' } })
  const compacted: (string | undefined)[] = []
  on('session.compact', (_, e) => {
    compacted.push(e.instructions)
    return compaction === 'done' ? { messages: [{ role: 'user', text: 'The summary.', toolUses: [] }] as never } : { skip: 'a hook said no' }
  })
  on('skill.prompt', (_, e) => ({ text: e.text }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  // the coordinator's turn that made the read has ended: the kill lands while it is idle
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'c0', reason: 'answer' })
  await clock.advance(2000)
  const run = (command: string, args: string) => $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 80 } })

  const killed = await run('swarm-kill', 'the user changed course')
  // the hook answered in the command's place: no skill prompt, no turn
  expect(ran).toBe(0)
  expect(seen.commands).toContain('kill the user changed course')
  expect(killed.text).toContain('2 member(s) retired')
  expect(killed.text).toContain('Still running: @alice')
  expect(killed.text).toContain('Nothing was committed or reverted')
  // a retired member's next tool call is refused at once, before any poll: a read, an edit and a command alike
  expect((await toolCall($, { tool: 'Read', file_path: '/project/src/alice/a.ts', agentId: 'alice-1' })).deny).toBeDefined()
  expect((await toolCall($, { tool: 'Edit', file_path: '/project/src/alice/a.ts', old_string: 'a', new_string: 'b', agentId: 'alice-1' })).deny).toContain('retired')
  expect((await toolCall($, { tool: 'Bash', command: 'npm test', agentId: 'zed-1' })).deny).toContain('retired')
  await clock.advance(10)
  expect(compacted.length).toBe(1)
  expect(compacted[0]).toContain('no longer a Swarm coordinator')
  expect(seen.toasts.some(text => text.includes('Run /compact'))).toBe(compaction === 'skipped')


  // what its members send back is dropped; another agent's and the user's own go through
  const submit = (text: string, kind: 'task-notification' | 'peer-send-message' | 'peer' | 'composer') => $.prompt.submit({ text, origin: { kind }, wait: false })
  // a background member's hand-back is a peer message framed with its agent id; another session naming the id is not one
  expect((await submit('Another Claude session sent a message:\n<agent-message from="alice-1">\n[Subagent hand-back] done</agent-message>', 'peer')).drop).toBeDefined()
  expect((await submit('Another Claude session sent a message:\n<agent-message from="other">\nalice-1 looks stuck</agent-message>', 'peer')).drop).toBeUndefined()
  expect((await submit('<task-notification><task-id>alice-1</task-id><status>completed</status></task-notification>', 'task-notification')).drop).toBeDefined()
  expect((await submit('Message from zed-1: done', 'peer-send-message')).drop).toBeDefined()
  expect((await submit('<task-notification><task-id>bob-1</task-id></task-notification>', 'task-notification')).drop).toBeUndefined()
  expect((await submit('<task-notification><task-id>alice-12</task-id></task-notification>', 'task-notification')).drop).toBeUndefined()
  expect((await submit('what did alice-1 change?', 'composer')).drop).toBeUndefined()
  // the sender is read from the envelope alone: another agent's notification that mentions a retired one is its own
  expect((await submit('<task-notification><task-id>other-1</task-id><status>completed</status><summary>alice-1 is done</summary></task-notification>', 'task-notification')).drop).toBeUndefined()
  expect((await submit('Message from other-1: alice-1 is stuck', 'peer-send-message')).drop).toBeUndefined()
  expect((await submit('Another Claude session sent a message:\n<agent-message from="other-1">\n<agent-message from="alice-1"></agent-message>', 'peer')).drop).toBeUndefined()

  // the swarm skill's text stays away until a new /swarm:swarm
  const skill = () => $.skill.prompt({ skill: 'swarm', text: 'FULL SKILL', pluginName: 'swarm' })
  expect((await skill()).text).toContain('ended with /swarm-kill')
  await run('swarm:swarm', 'a new task')
  expect((await skill()).text).toBe('FULL SKILL')
  // once another run is bound, a late hand-back from the killed run's member is still dropped
  await toolCall($, { tool: 'Bash', command: 'python3 /p/board.py "/project/.swarm/next-20261122-100000" read coordinator' })
  await clock.advance(10)
  expect(seen.commands.filter(c => c.startsWith('bind ')).length).toBe(2)
  expect((await submit('<task-notification><task-id>alice-1</task-id><status>completed</status></task-notification>', 'task-notification')).drop).toBeDefined()
})

test('/swarm-kill during the coordinator\'s turn retires the run at once, ends that turn, and compacts only after it', async ($, on) => {
  const state: Record<string, unknown> = { title: 'Kill swarm', members: {
    coordinator: { role: 'coordinator', last_read_seq: 1 },
    alice: { role: 'worker', id: 'alice-1', paths: 'src/alice', isolated: '0', last_read_seq: 1 },
  } }
  const { seen, answer, board } = owning(on, { board: () => posts({ agent: 'coordinator', to: ['alice'], text: '@alice BRIEF' }), roster: () => JSON.stringify(state) })
  on('process.run', (_, e) => {
    if (e.argv[3] !== 'kill') return answer(board(e))
    board(e)
    state.closed = true
    ;(state.members as Record<string, Record<string, string>>).alice!.killed = '1'
    return answer('killed: 1 member(s) retired, run closed\n@alice alice-1\n')
  })
  on('agent.list', () => ({ value: [] as never }))
  on('tool.call', () => ({ result: {} }))
  const compacted: (string | undefined)[] = []
  on('session.compact', (_, e) => {
    compacted.push(e.instructions)
    return { messages: [{ role: 'user', text: 'The summary.', toolUses: [] }] as never }
  })
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)
  await $.turn.start({ text: 'Continue coordinating', turnId: 'c1' })
  const killed = await $.command.run({ command: 'swarm-kill', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 80 } })
  // the board kill ran at once, mid-turn
  expect(seen.commands).toContain('kill')
  expect(killed.text).toContain('told to end now')
  // that turn's next tool call is refused with the sentence, and nothing is compacted while it runs
  expect((await toolCall($, { tool: 'Read', file_path: '/project/a.ts' })).deny).toBe('The user ended the Swarm run with /swarm-kill. End your turn now, in one line.')
  await clock.advance(10)
  expect(compacted).toEqual([])
  await $.turn.complete({ answer: 'Stopped.', durationMs: 1, isAborted: false, turnId: 'c1', reason: 'answer' })
  await clock.advance(10)
  expect(compacted.length).toBe(1)
  // a later turn is the ordinary assistant's: its tool calls go through
  await $.turn.start({ text: 'Thanks, now fix the typo', turnId: 'c2' })
  expect((await toolCall($, { tool: 'Read', file_path: '/project/a.ts' })).deny).toBeUndefined()
})

test('a member\'s hand-back that only repeats the board is dropped while others work, and every wake the board owes still comes', async ($, on) => {
  const state: Record<string, unknown> = { title: 'Quiet swarm', members: {
    coordinator: { role: 'coordinator', last_read_seq: 1 },
    parser: { role: 'worker', id: 'a1', last_read_seq: 1 },
    lexer: { role: 'worker', id: 'a2', last_read_seq: 1 },
    quiet: { role: 'worker', id: 'a3', last_read_seq: 1 },
    woke: { role: 'worker', id: 'a4', last_read_seq: 1, last_nudged_seq: 1 },
  } }
  let list = [
    { agent: 'coordinator', to: ['parser', 'lexer', 'quiet'], text: '@parser @lexer @quiet BRIEF' },
    { agent: 'parser', to: ['coordinator'], text: 'READY\nparser done' },
  ]
  const { seen, answer, board } = owning(on, { board: () => posts(...list), roster: () => JSON.stringify(state) })
  on('process.run', (_, e) => e.argv[3] === 'attention' ? answer(JSON.stringify({ items: [], members: {} })) : answer(board(e)))
  let lexer = 'running'
  on('agent.list', () => ({ value: [
    { id: 'a1', description: '@parser', type: 'swarm:worker', status: 'completed' },
    { id: 'a2', description: '@lexer', type: 'swarm:worker', status: lexer },
    { id: 'a3', description: '@quiet', type: 'swarm:worker', status: 'completed' },
    { id: 'a4', description: '@woke', type: 'swarm:worker', status: 'completed' },
  ] as never }))
  on('tool.call', () => ({ result: {} }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'c0', reason: 'answer' })
  await clock.advance(2000)
  const handBack = (id: string, turnId?: string) => $.prompt.submit({ text: `Another Claude session sent a message:\n<agent-message from="${id}">\n[Subagent hand-back] done</agent-message>`, origin: { kind: 'peer' }, wait: false, ...(turnId && { turnId }) })
  const notified = (id: string, status = 'completed', summary = '') => $.prompt.submit({ text: `<task-notification><task-id>${id}</task-id><status>${status}</status>${summary}</task-notification>`, origin: { kind: 'task-notification' }, wait: false })

  // a message parser sends about something new is no turn's end: it goes through
  expect((await $.prompt.submit({ text: 'Another Claude session sent a message:\n<agent-message from="a1">\nthe build broke in src/shared</agent-message>', origin: { kind: 'peer' }, wait: false })).drop).toBeUndefined()
  // a routine READY while lexer works: both of parser's host wakes are dropped, but not a failure since
  expect((await handBack('a1')).drop).toBeDefined()
  expect((await notified('a1', 'failed')).drop).toBeUndefined()
  expect((await notified('a1')).drop).toBeDefined()
  // one post answers for one turn's end: parser ran again and left nothing newer, so this end goes through
  expect((await handBack('a1')).drop).toBeUndefined()
  expect((await notified('a1')).drop).toBeUndefined()
  // the sender is the envelope's: a stranger's notification that mentions a member is the stranger's
  expect((await notified('stranger', 'completed', '<summary>a1 finished</summary>')).drop).toBeUndefined()
  // one delivered into a running turn starts nothing, and is left alone; an agent that is no member, too
  expect((await handBack('a1', 'c1')).drop).toBeUndefined()
  expect((await handBack('stranger')).drop).toBeUndefined()
  // a member that ended without leaving anything on the board is a silent exit: its wake goes through
  expect((await handBack('a3')).drop).toBeUndefined()
  // and so is one that was woken, read what it was woken for, and posted nothing
  expect((await handBack('a4')).drop).toBeUndefined()

  // a question to the coordinator is worth the turn
  list = [...list, { agent: 'lexer', to: ['coordinator'], text: '@coordinator may I edit src/shared.ts?' }]
  await clock.advance(2000)
  expect((await handBack('a1')).drop).toBeUndefined()
  // so is a READY that asks the coordinator to rule on something
  list = [list[0]!, list[1]!, { agent: 'parser', to: ['coordinator'], text: 'READY\nparser done\n@coordinator the slow test was not run' }]
  await clock.advance(2000)
  expect((await handBack('a1')).drop).toBeUndefined()
  // a newer routine READY answers for another turn's end
  list = [list[0]!, list[1]!, { agent: 'parser', to: ['coordinator'], text: 'READY\nparser done again' }]
  await clock.advance(2000)
  // the board woke parser through that post since the poll, and its turn ended with nothing new: a silent exit
  const parser = (state.members as Record<string, Record<string, unknown>>).parser!
  parser.last_nudged_seq = 3
  expect((await notified('a1')).drop).toBeUndefined()
  delete parser.last_nudged_seq
  expect((await notified('a1')).drop).toBeDefined()

  // a paused run delivers nothing itself, so the host's wake goes through
  state.paused = 'waiting for the user'
  await clock.advance(2000)
  expect((await handBack('a1')).drop).toBeUndefined()
  delete state.paused
  await clock.advance(2000)

  // the last member stops: the wake goes through, and the board's own notice still comes for the READY
  lexer = 'completed'
  await clock.advance(2000)
  expect((await handBack('a1')).drop).toBeUndefined()
  await clock.advance(16000)
  expect(seen.prompts.filter(text => /address(?:es)? you/.test(text)).length).toBe(1)

  // a run this conversation no longer drives
  lexer = 'running'
  state.closed = true
  await clock.advance(2000)
  expect((await handBack('a1')).drop).toBeUndefined()
})

for (const hasAgent of [true, false]) test(`the last worker's READY is held while a verifier ${hasAgent ? 'with an agent reviews it' : 'with no agent yet would not'}`, async ($, on) => {
  const state = { title: 'Review swarm', members: {
    coordinator: { role: 'coordinator', last_read_seq: 1 },
    parser: { role: 'worker', id: 'a1', last_read_seq: 1 },
    checker: { role: 'verifier', ...(hasAgent && { id: 'v1' }), last_read_seq: 1 },
  } }
  const list = [
    { agent: 'coordinator', to: ['parser', 'checker'], text: '@parser @checker BRIEF' },
    { agent: 'parser', to: ['coordinator', 'checker'], text: 'READY\nparser done' },
  ]
  const { seen, answer, board } = owning(on, { board: () => posts(...list), roster: () => JSON.stringify(state) })
  on('process.run', (_, e) => e.argv[3] === 'attention' ? answer(JSON.stringify({ items: [], members: {} })) : answer(board(e)))
  on('agent.list', () => ({ value: [
    { id: 'a1', description: '@parser', type: 'swarm:worker', status: 'completed' },
    ...(hasAgent ? [{ id: 'v1', description: '@checker', type: 'swarm:verifier', status: 'completed' }] : []),
  ] as never }))
  on('tool.call', () => ({ result: {} }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'c0', reason: 'answer' })
  await clock.advance(30000)
  expect(seen.prompts.filter(text => text.includes('addresses you')).length).toBe(hasAgent ? 0 : 1)
})

test('a long task is not held twice: the skill\'s copy of it points at the command\'s own message', async ($, on) => {
  owning(on, { board: () => '', roster: () => '{}' })
  on('command.run', (_, e) => ({ text: e.args }))
  on('skill.prompt', (_, e) => ({ text: e.text }))
  mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  const run = (command: string, args: string) => $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 80 } })
  const long = `migrate the parser\n${'detail '.repeat(500)}\nand keep the tests green`
  for (const skill of ['swarm', 'plan']) {
    await run(`swarm:${skill}`, long)
    const text = (await $.skill.prompt({ skill, text: `# Swarm\n\n${long}\n\nIf no task is given above, ask.`, pluginName: 'swarm' })).text
    expect(text).not.toContain('detail detail')
    expect(text).toContain('The task is the text of the user\'s command above.')
  }
  // a short task stays where it is
  await run('swarm:swarm', 'fix the parser')
  expect((await $.skill.prompt({ skill: 'swarm', text: '# Swarm\n\nfix the parser', pluginName: 'swarm' })).text).toBe('# Swarm\n\nfix the parser')
})

test('a coordinator turn that ends while /swarm-kill gathers its diagnostics is not refused afterwards, and the compaction runs once', async ($, on) => {
  const state: Record<string, unknown> = { title: 'Kill swarm', members: {
    coordinator: { role: 'coordinator', last_read_seq: 1 },
    alice: { role: 'worker', id: 'alice-1', paths: 'src/alice', isolated: '0', last_read_seq: 1 },
  } }
  const { answer, board } = owning(on, { board: () => posts({ agent: 'coordinator', to: ['alice'], text: '@alice BRIEF' }), roster: () => JSON.stringify(state) })
  let listing = () => {}
  const listed = new Promise<void>(resolve => { listing = resolve })
  let release = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  on('process.run', async (_, e) => {
    if (e.argv[0] === 'lsof') {
      listing()
      await gate
      return answer('')
    }
    if (e.argv[3] !== 'kill') return answer(board(e))
    board(e)
    state.closed = true
    ;(state.members as Record<string, Record<string, string>>).alice!.killed = '1'
    return answer('killed: 1 member(s) retired, run closed\n@alice alice-1\n')
  })
  on('agent.list', () => ({ value: [] as never }))
  on('tool.call', () => ({ result: {} }))
  const compacted: (string | undefined)[] = []
  on('session.compact', (_, e) => {
    compacted.push(e.instructions)
    return { messages: [{ role: 'user', text: 'The summary.', toolUses: [] }] as never }
  })
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)
  await $.turn.start({ text: 'Continue coordinating', turnId: 'c1' })
  const killing = $.command.run({ command: 'swarm-kill', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 80 } })
  // the turn ends while the kill waits on its process listing; until then its tool calls are refused already
  await listed
  expect((await toolCall($, { tool: 'Read', file_path: '/project/a.ts' })).deny).toContain('/swarm-kill')
  await $.turn.complete({ answer: 'Stopped.', durationMs: 1, isAborted: false, turnId: 'c1', reason: 'answer' })
  release()
  await killing
  await clock.advance(10)
  expect(compacted.length).toBe(1)
  await $.turn.start({ text: 'Now fix the typo', turnId: 'c2' })
  expect((await toolCall($, { tool: 'Read', file_path: '/project/a.ts' })).deny).toBeUndefined()
})

/** A run this conversation drives, whose board's kill retires every member and prints each one's agent. */
function killable(on: On, members: Record<string, Record<string, unknown>>, rosterFails = (_state: Record<string, unknown>) => false,
  more: { hold?: (path: string, state: Record<string, unknown>) => Promise<void> | undefined; read?: (path: string) => string | undefined; failsAfterClosing?: boolean; compact?: () => unknown; lsofFails?: boolean } = {}) {
  const state: Record<string, unknown> = { title: 'Kill swarm', members: { coordinator: { role: 'coordinator', last_read_seq: 1 }, ...members } }
  const fixture = owning(on, {
    board: () => posts({ agent: 'coordinator', to: Object.keys(members), text: 'BRIEF' }),
    roster: () => { if (rosterFails(state)) throw new Error('EIO'); return JSON.stringify(state) },
    hold: path => more.hold?.(path, state),
    read: more.read,
  })
  on('process.run', (_, e) => {
    if (e.argv[0] === 'lsof' && more.lsofFails) return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (e.argv[3] !== 'kill') return fixture.answer(fixture.board(e))
    fixture.board(e)
    state.closed = true
    state.killed = 'killed by the user'
    const retired = Object.entries(state.members as Record<string, Record<string, unknown>>).filter(([name]) => name !== 'coordinator')
    for (const [, member] of retired) member.killed = '1'
    // the roster is saved, then appending the SHUTDOWN post fails: no ids are printed
    if (more.failsAfterClosing) return { value: { exitCode: 1, stdout: '', stderr: 'OSError: disk full', isStdoutTruncated: false, isStderrTruncated: false } }
    return fixture.answer(`killed: ${retired.length} member(s) retired, run closed\n${retired.map(([name, member]) => `@${name} ${String(member.id)}\n`).join('')}`)
  })
  on('tool.call', () => ({ result: {} }))
  const compacted: (string | undefined)[] = []
  on('session.compact', (_, e) => {
    compacted.push(e.instructions)
    return (more.compact?.() ?? { messages: [{ role: 'user', text: 'The summary.', toolUses: [] }] }) as never
  })
  return { ...fixture, compacted }
}
const killCommand = ($: Engine) => $.command.run({ command: 'swarm-kill', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 80 } })
const handedBack = ($: Engine, id: string) => $.prompt.submit({ text: `Another Claude session sent a message:\n<agent-message from="${id}">\n[Subagent hand-back] done</agent-message>`, origin: { kind: 'peer' }, wait: false })

test('the compaction after /swarm-kill waits for a coordinator turn that started before it ran, and comes once', async ($, on) => {
  const { compacted } = killable(on, { alice: { role: 'worker', id: 'alice-1', last_read_seq: 1 } })
  on('agent.list', () => ({ value: [] as never }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'c0', reason: 'answer' })
  await clock.advance(2000)
  await killCommand($)
  await $.turn.start({ text: 'Go on', turnId: 'c1' })
  await clock.advance(10)
  expect(compacted).toEqual([])
  await $.turn.complete({ answer: 'Done.', durationMs: 1, isAborted: false, turnId: 'c1', reason: 'answer' })
  await clock.advance(10)
  expect(compacted.length).toBe(1)
  await $.turn.start({ text: 'More', turnId: 'c2' })
  await $.turn.complete({ answer: 'Done.', durationMs: 1, isAborted: false, turnId: 'c2', reason: 'answer' })
  await clock.advance(10)
  expect(compacted.length).toBe(1)
})

test('the compaction after /swarm-kill is skipped once another session has begun', async ($, on) => {
  const { compacted } = killable(on, { alice: { role: 'worker', id: 'alice-1', last_read_seq: 1 } })
  on('agent.list', () => ({ value: [] as never }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'c0', reason: 'answer' })
  await clock.advance(2000)
  await killCommand($)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await clock.advance(10)
  await $.turn.start({ text: 'Hello', turnId: 'n1' })
  await $.turn.complete({ answer: 'Hi.', durationMs: 1, isAborted: false, turnId: 'n1', reason: 'answer' })
  await clock.advance(10)
  expect(compacted).toEqual([])
})

test('/swarm-kill drops what a native teammate sends under either identity, a teammate gone from the agent list included', async ($, on) => {
  killable(on, {
    alice: { role: 'worker', id: 'alice@team', last_read_seq: 1 },
    bob: { role: 'worker', id: 'bob@team', last_read_seq: 1 },
  })
  // bob has left the agent list: only the mapping saved from an earlier session knows its agent
  const stored: Record<string, unknown> = { teammates: { 'agent-b': 'bob@team' } }
  on('store.get', (_, e) => ({ value: stored[e.key] }))
  on('store.set', (_, e) => { stored[e.key] = e.value; return { value: undefined } })
  on('agent.list', () => ({ value: [{ id: 'agent-a', teammateId: 'alice@team', description: '@alice', type: 'swarm:worker', status: 'running' }] as never }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'c0', reason: 'answer' })
  await clock.advance(2000)
  await killCommand($)
  expect((await handedBack($, 'agent-a')).drop).toBeDefined()
  expect((await handedBack($, 'alice@team')).drop).toBeDefined()
  expect((await $.prompt.submit({ text: '<task-notification><task-id>agent-b</task-id><status>completed</status></task-notification>', origin: { kind: 'task-notification' }, wait: false })).drop).toBeDefined()
  expect((await handedBack($, 'agent-c')).drop).toBeUndefined()
})

test('/swarm-kill takes the retired agents from its own answer when the roster cannot be read after it, and says what it could not check', async ($, on) => {
  // the roster cannot be read from the kill on
  const { seen } = killable(on, { alice: { role: 'worker', id: 'alice-1', last_read_seq: 1 } }, state => state.closed === true)
  on('agent.list', () => ({ value: [] as never }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'c0', reason: 'answer' })
  await clock.advance(2000)
  const ran = seen.commands.length
  const killed = await killCommand($)
  expect(seen.commands.slice(ran)).toContain('kill')
  expect(killed.text).toContain('1 member(s) retired')
  expect(killed.text).toContain('could not be read')
  expect((await handedBack($, 'alice-1')).drop).toBeDefined()
})

test('after a restart, a retired member of the run a kill closed is still refused its edits and commands', async ($, on) => {
  const state = { title: 'Kill swarm', closed: true, killed: 'killed by the user', members: {
    coordinator: { role: 'coordinator', last_read_seq: 2 },
    alice: { role: 'worker', id: 'alice-1', killed: '1', paths: 'src/alice', isolated: '0', last_read_seq: 1 },
  } }
  const { answer, board } = owning(on, { board: () => '', roster: () => JSON.stringify(state) })
  // the conversation drives no run now; the board still finds the closed run its agent belonged to
  on('process.run', (_, e) => answer(e.argv[3] === 'agent-run' ? OWNED : board(e)))
  on('agent.list', () => ({ value: [{ id: 'alice-1', description: '@alice', type: 'swarm:worker', status: 'running' }] as never }))
  on('tool.call', () => ({ result: {} }))
  mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  expect((await toolCall($, { tool: 'Edit', file_path: '/project/src/alice/a.ts', old_string: 'a', new_string: 'b', agentId: 'alice-1' })).deny).toContain('retired')
  expect((await toolCall($, { tool: 'Bash', command: 'npm test', agentId: 'alice-1' })).deny).toContain('retired')
})

/** A gate a test opens: `held` resolves once something waits on it, and `open` lets it go on. */
function gate() {
  let open = () => {}
  let reached = () => {}
  const isOpen = new Promise<void>(resolve => { open = resolve })
  const held = new Promise<void>(resolve => { reached = resolve })
  return { wait: () => { reached(); return isOpen }, held, open }
}
const settle = async (clock: Awaited<ReturnType<typeof mock.clock>>, $: Engine) => {
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'c0', reason: 'answer' })
  await clock.advance(2000)
}

test('/swarm-kill refuses the agents its board named before it reads the roster', async ($, on) => {
  const roster = gate()
  let isHeld = false
  killable(on, { alice: { role: 'worker', id: 'alice-1', paths: 'src/alice', isolated: '0', last_read_seq: 1 } }, undefined, {
    hold: (path, state) => isHeld && state.closed === true && path.endsWith('/members.json') ? roster.wait() : undefined,
  })
  on('agent.list', () => ({ value: [{ id: 'alice-1', description: '@alice', type: 'swarm:worker', status: 'running' }] as never }))
  const clock = mock.clock(on)
  await settle(clock, $)
  isHeld = true
  const killing = killCommand($)
  await roster.held
  expect((await toolCall($, { tool: 'Edit', file_path: '/project/src/alice/a.ts', old_string: 'a', new_string: 'b', agentId: 'alice-1' })).deny).toContain('retired')
  // and its hand-back is dropped from the same moment
  expect((await handedBack($, 'alice-1')).drop).toBeDefined()
  roster.open()
  await killing
})

test('a kill whose session ended while it read the roster leaves the next session alone', async ($, on) => {
  const roster = gate()
  let isHeld = false
  const { compacted } = killable(on, { alice: { role: 'worker', id: 'alice-1', last_read_seq: 1 } }, undefined, {
    hold: (path, state) => isHeld && state.closed === true && path.endsWith('/members.json') ? roster.wait() : undefined,
  })
  on('agent.list', () => ({ value: [] as never }))
  const clock = mock.clock(on)
  await settle(clock, $)
  isHeld = true
  const killing = killCommand($)
  await roster.held
  isHeld = false
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  roster.open()
  await killing
  await clock.advance(10)
  expect(compacted).toEqual([])
  expect((await handedBack($, 'alice-1')).drop).toBeUndefined()
})

test('a teammate address a kill retired is heard again from a live member of the run driven now', async ($, on) => {
  const NEXT = '/project/.swarm/next-20261122-100000'
  const next = { title: 'Next', members: { coordinator: { role: 'coordinator', last_read_seq: 0 }, alice: { role: 'worker', id: 'alice@team', last_read_seq: 0 } } }
  killable(on, { alice: { role: 'worker', id: 'alice@team', last_read_seq: 1 } }, undefined, {
    read: path => path === `${NEXT}/members.json` ? JSON.stringify(next) : path === `${NEXT}/board.jsonl` ? '' : undefined,
  })
  on('agent.list', () => ({ value: [{ id: 'agent-a', teammateId: 'alice@team', description: '@alice', type: 'swarm:worker', status: 'completed' }] as never }))
  const clock = mock.clock(on)
  await settle(clock, $)
  await killCommand($)
  expect((await handedBack($, 'alice@team')).drop).toBeDefined()
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${NEXT}" read coordinator` })
  await clock.advance(2000)
  expect((await handedBack($, 'alice@team')).drop).toBeUndefined()
  // the retired agent's own id stays dropped
  expect((await handedBack($, 'agent-a')).drop).toBeDefined()
})

for (const refusals of [1, 3]) test(`a compaction the host refuses is asked again twice at most (refused ${refusals} time(s))`, async ($, on) => {
  let refused = 0
  const { compacted, seen } = killable(on, { alice: { role: 'worker', id: 'alice-1', last_read_seq: 1 } }, undefined, {
    compact: () => { if (refused++ < refusals) throw new Error('a turn is running'); return undefined },
  })
  on('agent.list', () => ({ value: [] as never }))
  const clock = mock.clock(on)
  await settle(clock, $)
  await killCommand($)
  for (let i = 0; i < 5; i++) await clock.advance(1000)
  expect(compacted.length).toBe(Math.min(refusals + 1, 3))
  expect(seen.toasts.some(text => text.includes('could not be compacted'))).toBe(refusals >= 3)
})

test('a kill the board committed before it failed is finished from the roster', async ($, on) => {
  const { compacted } = killable(on, { alice: { role: 'worker', id: 'alice-1', last_read_seq: 1 } }, undefined, { failsAfterClosing: true })
  on('agent.list', () => ({ value: [] as never }))
  const clock = mock.clock(on)
  await settle(clock, $)
  const killed = await killCommand($)
  expect(killed.text).toContain('1 member(s) retired')
  expect((await handedBack($, 'alice-1')).drop).toBeDefined()
  expect((await toolCall($, { tool: 'Bash', command: 'npm test', agentId: 'alice-1' })).deny).toContain('retired')
  await clock.advance(10)
  expect(compacted.length).toBe(1)
})

test('a poll that read the roster before the kill does not let a retired member go on', async ($, on) => {
  let stale = ''
  killable(on, { alice: { role: 'worker', id: 'alice-1', paths: 'src/alice', isolated: '0', last_read_seq: 1 } }, undefined, {
    read: path => stale && path === `${OWNED}/members.json` ? stale : undefined,
  })
  on('agent.list', () => ({ value: [{ id: 'alice-1', description: '@alice', type: 'swarm:worker', status: 'running' }] as never }))
  const clock = mock.clock(on)
  await settle(clock, $)
  const open = JSON.stringify({ title: 'Kill swarm', members: { coordinator: { role: 'coordinator', last_read_seq: 1 }, alice: { role: 'worker', id: 'alice-1', paths: 'src/alice', isolated: '0', last_read_seq: 1 } } })
  await killCommand($)
  // a read of the roster as it was before the kill lands afterwards
  stale = open
  await clock.advance(2000)
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" status` })
  await clock.advance(2000)
  expect((await toolCall($, { tool: 'Edit', file_path: '/project/src/alice/a.ts', old_string: 'a', new_string: 'b', agentId: 'alice-1' })).deny).toContain('retired')
})

test('a compaction an old kill still owes is cancelled by a new run', async ($, on) => {
  let refused = 0
  const { compacted } = killable(on, { alice: { role: 'worker', id: 'alice-1', last_read_seq: 1 } }, undefined, {
    compact: () => { if (refused++ < 1) throw new Error('a turn is running'); return undefined },
  })
  on('agent.list', () => ({ value: [] as never }))
  on('command.run', () => ({ text: '' }))
  const clock = mock.clock(on)
  await settle(clock, $)
  await killCommand($)
  await clock.advance(10)
  expect(compacted.length).toBe(1)
  await $.command.run({ command: 'swarm:swarm', args: 'a new task', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 80 } })
  for (let i = 0; i < 4; i++) await clock.advance(1000)
  expect(compacted.length).toBe(1)
})

test('/clear leaves nothing of a kill to the next conversation', async ($, on) => {
  const { compacted } = killable(on, { alice: { role: 'worker', id: 'alice-1', last_read_seq: 1 } })
  on('agent.list', () => ({ value: [] as never }))
  const clock = mock.clock(on)
  await settle(clock, $)
  await $.turn.start({ text: 'Continue coordinating', turnId: 'c1' })
  await killCommand($)
  await $.session.end({ reason: 'clear', sessionId: 'fixture-conversation', resume: { id: 'fixture-conversation' } })
  await clock.advance(10)
  expect((await handedBack($, 'alice-1')).drop).toBeUndefined()
  expect((await toolCall($, { tool: 'Read', file_path: '/project/a.ts' })).deny).toBeUndefined()
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'n1', reason: 'answer' })
  await clock.advance(10)
  expect(compacted).toEqual([])
})

test('a process scan that failed with nothing listed is reported as not made', async ($, on) => {
  killable(on, { alice: { role: 'worker', id: 'alice-1', last_read_seq: 1 } }, undefined, { lsofFails: true })
  on('agent.list', () => ({ value: [] as never }))
  const clock = mock.clock(on)
  await settle(clock, $)
  expect((await killCommand($)).text).toContain('the process list could not be read')
})

test('#5: isolated writer cannot edit main checkout, empty cwd falls back to activeDir, and isUnrecorded resume preserves isolated', async ($, on) => {
  let cwdValue = '/project'
  const state = {
    title: 'Isolation swarm',
    members: {
      coordinator: { role: 'coordinator', last_read_seq: 1 },
      alice: { role: 'worker', id: 'alice-1', paths: 'src/alice', isolated: '0', last_read_seq: 1 },
      bob: { role: 'worker', id: 'bob-1', paths: 'src/bob', isolated: '1', last_read_seq: 1 },
      ghost: { role: 'worker', paths: 'src/ghost', isolated: '1', last_read_seq: 0 },
    },
  }
  const startedArgs: string[][] = []
  const { answer, board } = owning(on, {
    board: () => posts({ agent: 'coordinator', to: ['bob'], text: '@bob BRIEF' }),
    roster: () => JSON.stringify(state),
    cwd: () => cwdValue,
  })
  on('process.run', (_, e) => {
    if (e.argv[3] === 'started') startedArgs.push(e.argv.slice(4))
    return answer(board(e))
  })
  on('agent.list', () => ({
    value: [
      { id: 'alice-1', description: '@alice', type: 'swarm:worker', status: 'running' },
      { id: 'bob-1', description: '@bob', type: 'swarm:worker', status: 'running' },
      { id: 'ghost-1', description: '@ghost', type: 'swarm:worker', status: 'completed' },
    ] as never,
  }))
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'ghost-1' }))
  on('tool.call', () => ({ result: {} }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)

  // Isolated writer bob cannot edit its own paths= directly in the shared main checkout
  expect((await toolCall($, { tool: 'Edit', file_path: '/project/src/bob/b.ts', old_string: 'a', new_string: 'b', agentId: 'bob-1' })).deny).toContain('isolated to its own worktree')
  // Inside its own worktree, bob's edit succeeds; inside another unknown or non-agent-* worktree, it is denied
  expect((await toolCall($, { tool: 'Edit', file_path: '/project/.claude/worktrees/agent-bob-1/src/bob/b.ts', old_string: 'a', new_string: 'b', agentId: 'bob-1' })).deny).toBeUndefined()
  expect((await toolCall($, { tool: 'Edit', file_path: '/project/.claude/worktrees/agent-other-1/src/bob/b.ts', old_string: 'a', new_string: 'b', agentId: 'bob-1' })).deny).toContain("another member's worktree")
  // CR-4: non-agent-* folder under .claude/worktrees/ (folder === undefined) is also denied for isolated writers
  expect((await toolCall($, { tool: 'Edit', file_path: '/project/.claude/worktrees/scratch/src/bob/b.ts', old_string: 'a', new_string: 'b', agentId: 'bob-1' })).deny).toContain("another member's worktree")

  // Empty session.cwd() falls back to activeDir parent (/project) instead of failing open
  cwdValue = ''
  expect((await toolCall($, { tool: 'Edit', file_path: '/project/src/bob/b.ts', old_string: 'a', new_string: 'b', agentId: 'alice-1' })).deny).toContain('claimed by @bob')
  expect((await toolCall($, { tool: 'Edit', file_path: '/project/src/bob/b.ts', old_string: 'a', new_string: 'b', agentId: 'bob-1' })).deny).toContain('isolated to its own worktree')
  cwdValue = '/project'

  // Resuming an unrecorded member preserves isolated=1 in the started call
  await $.agent.spawn({
    tool_use_id: 'resume-ghost',
    description: '@ghost: continue',
    subagentType: 'swarm:worker',
    prompt: 'Continue.',
    provider: { plugin: 'swarm', tier: 'core' as const },
    parentModel: 'sonnet',
    background: true,
    fork: false,
    resume: { agentId: 'ghost-1' },
  })
  expect(startedArgs.at(-1)).toEqual(['ghost', 'ghost-1', '', 'isolated=1'])
})

test('#6: member Bash fails closed on guard error except for safe own-member board.py commands', async ($, on) => {
  const state = {
    title: 'Catch guard swarm',
    members: {
      coordinator: { role: 'coordinator', last_read_seq: 1 },
      alice: { role: 'worker', id: 'alice-1', paths: 'src/alice', isolated: '0', last_read_seq: 1 },
    },
  }
  const { answer, board } = owning(on, {
    board: () => posts({ agent: 'coordinator', to: ['alice'], text: '@alice BRIEF' }),
    roster: () => JSON.stringify(state),
  })
  let failState = false
  let B = ''
  on('state.get', (_, e, next) => failState ? { deny: 'state timeout' } : next(e))
  on('process.run', (_, e) => {
    if (!B && e.argv[1]?.endsWith('/board.py')) B = e.argv[1]
    return answer(board(e))
  })
  on('agent.list', () => ({ value: [{ id: 'alice-1', description: '@alice', type: 'swarm:worker', status: 'running' }] as never }))
  on('tool.call', () => ({ result: {} }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)

  // Force tool.call hook to throw into its outer .catch fallback while alice-1 is a known member in ownedRoster
  failState = true
  const bash = (command: string) => toolCall($, { tool: 'Bash', command, agentId: 'alice-1' })
  expect(B).toContain('/skills/swarm/scripts/board.py')

  // Safe own-member board.py commands targeting the installed script (including heredocs and 2>&1) still pass
  expect((await bash(`python3 "${B}" "${OWNED}" read alice`)).deny).toBeUndefined()
  expect((await bash(`python3 "${B}" "${OWNED}" post alice "report > ok"`)).deny).toBeUndefined()
  expect((await bash(`python3 "${B}" "${OWNED}" status 2>&1`)).deny).toBeUndefined()
  expect((await bash(`python3 "${B}" "${OWNED}" post alice <<'EOF'\nhello > world\nEOF`)).deny).toBeUndefined()
  expect((await bash(`python3 "${B}" "${OWNED}" ready alice <<'EOF'\nREADY\nEOF`)).deny).toBeUndefined()
  // CR3-2: a lookalike board.py outside the installed plugin root is denied fail-closed
  expect((await bash(`python3 /tmp/evil/board.py "${OWNED}" status`)).deny).toContain('could not check')
  // CR2-3: file-writing output redirects on board.py are denied fail-closed in the fallback
  expect((await bash(`python3 "${B}" "${OWNED}" status > "${OWNED}/members.json"`)).deny).toContain('could not check')
  expect((await bash(`python3 "${B}" "${OWNED}" status>>"${OWNED}/members.json"`)).deny).toContain('could not check')
  expect((await bash(`python3 "${B}" "${OWNED}" status >| "${OWNED}/members.json"`)).deny).toContain('could not check')
  expect((await bash(`python3 "${B}" "${OWNED}" status &> "${OWNED}/members.json"`)).deny).toContain('could not check')
  expect((await bash(`python3 "${B}" "${OWNED}" status <> "${OWNED}/members.json"`)).deny).toContain('could not check')
  // Coordinator-only board.py commands, verify.py, spoofed member names, and arbitrary Bash are all denied fail-closed
  expect((await bash(`python3 "${B}" "${OWNED}" close`)).deny).toContain('could not check')
  expect((await bash(`python3 "${B}" "${OWNED}" kill`)).deny).toContain('could not check')
  expect((await bash(`python3 "${B}" "${OWNED}" member alice`)).deny).toContain('could not check')
  expect((await bash(`python3 /p/verify.py "${OWNED}" accept alice`)).deny).toContain('could not check')
  expect((await bash(`python3 "${B}" "${OWNED}" post bob "spoof"`)).deny).toContain('could not check')
  expect((await bash('rm -rf /tmp/something')).deny).toContain('could not check')
})

test('spend guards: a read-only member past the context ceiling may only report, a writer is told once, and at 80% of the budget every member is told to post', async ($, on) => {
  const state = {
    title: 'Sweep', limits: { budget: '1000000' }, usage: { tokens: { coordinator: 100 } },
    members: {
      coordinator: { role: 'coordinator', last_read_seq: 1 },
      scout: { role: 'worker', profile: 'investigator', writes: '0', id: 'scout-1', last_read_seq: 1 },
      builder: { role: 'worker', id: 'builder-1', paths: 'src', isolated: '0', last_read_seq: 1 },
      // resumed after a restart: the hooks never saw a step of it, the board kept what its last one read
      old: { role: 'worker', profile: 'investigator', writes: '0', id: 'old-1', held: 250_000, last_read_seq: 1 },
    },
  }
  const mirrored: (string | undefined)[] = []
  let postFails = false
  const { seen, answer, board } = owning(on, {
    board: () => posts({ agent: 'coordinator', to: ['scout', 'builder'], text: '@scout @builder BRIEF' }),
    roster: () => JSON.stringify(state),
  })
  on('process.run', (_, e) => {
    if (e.argv[3] === 'post') {
      if (postFails) return { value: { exitCode: 1, stdout: '', stderr: 'board unreadable', isStdoutTruncated: false, isStderrTruncated: false } }
      mirrored.push(e.init?.stdin)
      return answer('posted #7 -> @coordinator\n')
    }
    return answer(e.argv[3] === 'account' ? JSON.stringify({ title: 'Sweep', total: 0, budget: 1000000, paused: false }) : board(e))
  })
  on('agent.list', () => ({ value: [
    { id: 'scout-1', description: '@scout: sweep', type: 'swarm:investigator', status: 'running' },
    { id: 'builder-1', description: '@builder: build', type: 'swarm:worker', status: 'running' },
  ] as never }))
  on('tool.call', () => ({ result: {} }))
  let read = 0
  let wrote = 1000
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use' as const,
      usage: { model: 'm', input_tokens: 2, output_tokens: 10, cache_creation_input_tokens: wrote, cache_read_input_tokens: read } }
  })
  const step = async (agentId: string, turnId: string, index: number, held: number, cached = 1000) => {
    read = held
    wrote = cached
    for await (const _ of $.turn.step({ turnId, index, model: 'm', messageCount: 1, agentId })) { /* no chunks */ }
  }
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)
  const grep = (agentId: string) => toolCall($, { tool: 'Read', file_path: '/project/src/a.ts', agentId })

  // under 90k nothing is said; from there a read-only member is told once to post as it goes, and past 150k of its context
  await step('scout-1', 's', 0, 80_000)
  expect((await grep('scout-1')).context ?? []).toEqual([])
  await step('scout-1', 's', 0, 100_000)
  expect(String((await grep('scout-1')).context)).toContain('post each finding to the board as soon as its evidence stands')
  expect((await grep('scout-1')).context ?? []).toEqual([])
  await step('scout-1', 's', 1, 160_000)
  expect(String((await grep('scout-1')).context)).toContain('every step reads all of it again')
  expect((await grep('scout-1')).context ?? []).toEqual([])
  // past 200k a read-only member's tools stop, but its report does not; a writer is only told
  await step('scout-1', 's', 2, 210_000)
  expect((await grep('scout-1')).deny).toMatch(/past the ceiling of 200k.*what you covered and what you did not cover/)
  expect((await toolCall($, { tool: 'mcp__swarm__board', action: 'read', agentId: 'scout-1' })).deny ?? '').not.toContain('ceiling')
  expect((await toolCall($, { tool: 'SubagentHandback', message: 'partial', agentId: 'scout-1' } as unknown as ToolInput)).deny).toBeUndefined()
  await step('builder-1', 'b', 0, 210_000)
  const told = await grep('builder-1')
  expect([told.deny, String(told.context)]).toEqual([undefined, expect.stringContaining('every step reads all of it again')])
  expect((await grep('old-1')).deny).toMatch(/holds about 250k tokens, past the ceiling of 200k/)
  // a final report that is in no board post is put there in the member's name, and the coordinator gets its number
  const findings = `Three findings. ${'ST1 restoreBackup loses the edition when the tension write throws. '.repeat(8)}`
  await $.prompt.submit({ text: `Another Claude session sent a message:\n<agent-message from="scout-1">\n[Subagent hand-back] ${findings}</agent-message>`, origin: { kind: 'peer' }, wait: false })
  // the report goes up fenced: the board reads no mention inside it, so a member it names is not woken
  expect(mirrored).toEqual([expect.stringMatching(/^@coordinator HAND-BACK: @scout's turn ended with this report in no board post[^\n]*\n~~~\nThree findings\.[\s\S]*ST1 restoreBackup[\s\S]*\n~~~$/)])
  expect([seen.prompts.at(-1)?.includes("@scout's final report is on the board, whole, in post #7"), seen.prompts.at(-1)?.includes('ST1 restoreBackup')]).toEqual([true, false])
  // a short one, as after a READY, is passed on as it is
  await $.prompt.submit({ text: 'Another Claude session sent a message:\n<agent-message from="scout-1">\n[Subagent hand-back] done</agent-message>', origin: { kind: 'peer' }, wait: false })
  expect(mirrored.length).toBe(1)
  // a report the board did not take reaches the coordinator whole
  postFails = true
  await $.prompt.submit({ text: `Another Claude session sent a message:\n<agent-message from="scout-1">\n[Subagent hand-back] ${findings}</agent-message>`, origin: { kind: 'peer' }, wait: false })
  expect(seen.prompts.at(-1)).toContain('ST1 restoreBackup')
  postFails = false
  // one longer than a post goes up in parts, every character of it, before the pointer stands in for it
  const long = `${'A'.repeat(11_000)}TAIL-FINDING ${'B'.repeat(500)}`
  await $.prompt.submit({ text: `Another Claude session sent a message:\n<agent-message from="scout-1">\n[Subagent hand-back] ${long}</agent-message>`, origin: { kind: 'peer' }, wait: false })
  expect(mirrored.slice(1).map(text => [text?.includes('part 1 of 2'), text?.includes('part 2 of 2'), text?.includes('TAIL-FINDING')])).toEqual([[true, false, false], [false, true, true]])
  expect([seen.prompts.at(-1)?.includes('whole, in posts #7, #7'), seen.prompts.at(-1)?.includes('TAIL-FINDING')]).toEqual([true, false])
  // an agent that is no member of the run is measured but told nothing: it has no board to post on
  await step('outsider', 'o', 0, 210_000)
  const stranger = await grep('outsider')
  expect([stranger.deny, stranger.context ?? []]).toEqual([undefined, []])
  // the coordinator hears of the ceiling with its next tool result
  expect(String((await toolCall($, { tool: 'Bash', command: 'true' })).context)).toContain('@scout reached the context ceiling')
  // a step that takes the run past 80% of its budget: each member is told once with its next result, and the coordinator too
  await step('builder-1', 'b', 1, 210_000, 800_000)
  expect(String((await grep('builder-1')).context)).toContain('spent 80% of its token budget')
  expect((await grep('builder-1')).context ?? []).toEqual([])
  expect(String((await toolCall($, { tool: 'Bash', command: 'true' })).context)).toContain('spent 80% of its token budget of 1.0M')
  // the coordinator's own reading of the repository: two lookups a turn, the run folder and a new turn aside
  await $.turn.start({ text: 'check', turnId: 'c1' })
  const look = (file_path: string) => toolCall($, { tool: 'Read', file_path })
  expect([(await look('/project/src/a.ts')).deny, (await look(`${OWNED}/summary.md`)).deny, (await look('/project/src/b.ts')).deny]).toEqual([undefined, undefined, undefined])
  expect((await look('/project/src/c.ts')).deny).toContain('third or later repository lookup in one turn')
  expect((await toolCall($, { tool: 'Grep', pattern: 'x' } as never)).deny).toContain('ask its author on the board')
  expect((await look('.swarm/sweep-20261123-120000/members.json')).deny).toBeUndefined()
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, reason: 'answer', turnId: 'c1' })
  await $.turn.start({ text: 'again', turnId: 'c2' })
  expect((await look('/project/src/c.ts')).deny).toBeUndefined()
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, reason: 'answer', turnId: 'c2' })
})

test('#7: failed agent.list() does not poison strangers for swarm members', async ($, on) => {
  let listFails = true
  const state = {
    title: 'List fail swarm',
    members: {
      coordinator: { role: 'coordinator', last_read_seq: 1 },
      alice: { role: 'worker', paths: 'src/alice', isolated: '0', last_read_seq: 1 },
      bob: { role: 'worker', id: 'bob-1', paths: 'src/bob', isolated: '0', last_read_seq: 1 },
    },
  }
  const { answer, board } = owning(on, {
    board: () => posts({ agent: 'coordinator', to: ['alice'], text: '@alice BRIEF' }),
    roster: () => JSON.stringify(state),
  })
  on('process.run', (_, e) => answer(board(e)))
  on('agent.list', () => {
    if (listFails) throw new Error('agent list unavailable')
    return { value: [{ id: 'alice-unrec', description: '@alice: work', type: 'swarm:worker', status: 'running' }] as never }
  })
  on('tool.call', () => ({ result: {} }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)

  // First call while agent.list() throws: must NOT poison strangers with 'alice-unrec'
  await toolCall($, { tool: 'Edit', file_path: '/project/src/alice/a.ts', old_string: 'a', new_string: 'b', agentId: 'alice-unrec' })

  // Once agent.list() recovers, alice-unrec is still recognized and guarded against editing bob's path
  listFails = false
  expect((await toolCall($, { tool: 'Edit', file_path: '/project/src/bob/b.ts', old_string: 'a', new_string: 'b', agentId: 'alice-unrec' })).deny).toContain('claimed by @bob')
})

test('#8a & #8c: deleted run stops account retries and concurrent turn.complete dedups per turnId', async ($, on) => {
  let isGone = false
  let accountCalls = 0
  let releaseAccount!: () => void
  let enteredAccount!: () => void
  const accountRelease = new Promise<void>(resolve => { releaseAccount = resolve })
  const accountEntered = new Promise<void>(resolve => { enteredAccount = resolve })
  let holdAccount = false
  const { answer, board } = owning(on, {
    board: () => posts({ agent: 'coordinator', to: [], text: 'plan' }),
    roster: () => {
      if (isGone) throw new Error('ENOENT')
      return JSON.stringify({ title: 'Accounting swarm', members: { coordinator: { role: 'coordinator', last_read_seq: 1 } } })
    },
    exists: path => !(isGone && path.endsWith('/members.json')),
  })
  on('process.run', async (_, e) => {
    if (e.argv[3] === 'account') {
      accountCalls++
      if (holdAccount) {
        enteredAccount()
        await accountRelease
      }
      return answer(JSON.stringify({ title: 'Accounting swarm', total: 100, budget: 0, paused: false }))
    }
    return answer(board(e))
  })
  on('agent.list', () => ({ value: [] }))
  on('tool.call', () => ({ result: {} }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)

  const usage = { model: 'm', input_tokens: 100, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  // #8c: two concurrent turn.complete events for the same turnId only charge once
  holdAccount = true
  const first = $.turn.complete({ answer: '', durationMs: 1, isAborted: false, reason: 'answer', turnId: 'dup-1', usage })
  await accountEntered
  const second = $.turn.complete({ answer: '', durationMs: 1, isAborted: false, reason: 'answer', turnId: 'dup-1', usage })
  await clock.advance(0)
  holdAccount = false
  releaseAccount()
  await Promise.all([first, second])
  expect(accountCalls).toBe(1)

  // #8a: once the run folder is deleted, turn.complete triggers zero account subprocesses
  isGone = true
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, reason: 'answer', turnId: 'after-delete-1', usage })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, reason: 'answer', turnId: 'after-delete-2', usage })
  expect(accountCalls).toBe(1)
})

test('#9: no askStall while all workers unstarted, unmet depends excluded from unaddressed, no duplicate relayNotice', async ($, on) => {
  const state = {
    title: 'Stall & relay swarm',
    members: {
      coordinator: { role: 'coordinator', last_read_seq: 2 },
      builder: { role: 'worker', last_read_seq: 0 } as Record<string, unknown>,
      arch: { role: 'worker', profile: 'architect', depends: 'builder', last_read_seq: 0 },
      scout: { role: 'worker', profile: 'explorer', last_read_seq: 0 } as Record<string, unknown>,
    },
  }
  let boardText = posts({ agent: 'coordinator', to: ['builder', 'arch'], text: '@builder @arch BRIEF' })
  let agents: { id: string; description: string; type: string; status: string }[] = []
  let archBlockedOn: string[] = ['builder']
  const { seen, answer, board } = owning(on, {
    board: () => boardText,
    roster: () => JSON.stringify(state),
  })
  on('process.run', (_, e) => {
    if (e.argv[3] === 'attention') {
      return answer(JSON.stringify({
        items: [],
        members: {
          arch: { type: 'architect', model: 'fable', effort: 'high', depends: ['builder'], owns: '', ready: false, blocked_on: archBlockedOn, asked: 0, unreachable: false },
        },
      }))
    }
    return answer(board(e))
  })
  on('agent.list', () => ({ value: agents as never }))
  on('tool.call', () => ({ result: {} }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, reason: 'answer', turnId: 'init-t' })
  await clock.advance(2000)

  // All workers unstarted (plan approval): even past QUIET_MS (60s), askStall must NOT fire
  await clock.advance(65_000)
  expect(seen.prompts.filter(p => p.includes('Every member is waiting'))).toEqual([])

  // Start builder + scout and address scout; arch has board-reported blocked_on=['builder'] -> must NOT appear in relayNotice
  state.members.builder.id = 'builder-1'
  state.members.scout.id = 'scout-1'
  agents = [
    { id: 'builder-1', description: '@builder', type: 'swarm:worker', status: 'completed' },
    { id: 'scout-1', description: '@scout', type: 'swarm:explorer', status: 'completed' },
  ]
  boardText = posts(
    { agent: 'coordinator', to: ['builder', 'arch'], text: '@builder @arch BRIEF' },
    { agent: 'coordinator', to: ['scout'], text: '@scout check files' },
  )
  await clock.advance(2000)
  const relayPrompt = seen.prompts.find(p => p.includes('Delivering board mentions'))
  expect(relayPrompt).toBeDefined()
  expect(relayPrompt).toContain('@scout')
  expect(relayPrompt).not.toContain('@arch')

  // Later, when askStall fires while the same relay is still pending (keyToRelay === relayPrompted), relayNotice is NOT duplicated
  await clock.advance(65_000)
  const stallPrompt = seen.prompts.find(p => p.includes('Every member is waiting'))
  expect(stallPrompt).toBeDefined()
  expect(stallPrompt).not.toContain('Relay these Swarm board wakes')

  // Once the board clears blocked_on (e.g. coordinator-confirmed finding or retired after= prerequisite), @arch IS included in relayNotice
  archBlockedOn = []
  boardText = posts(
    { agent: 'coordinator', to: ['builder', 'arch'], text: '@builder @arch BRIEF' },
    { agent: 'coordinator', to: ['scout'], text: '@scout check files' },
    { agent: 'builder', to: [], text: 'READY' },
  )
  await clock.advance(12_000)
  const releasedPrompt = seen.prompts.findLast(p => p.includes('Delivering board mentions'))
  expect(releasedPrompt).toBeDefined()
  expect(releasedPrompt).toContain('@arch')
})

test('#13: retired member (including general-purpose stand-in) of closed run is blocked on Read, Grep, and Glob after restart', async ($, on) => {
  const closedState = {
    title: 'Closed swarm',
    closed: true,
    members: {
      coordinator: { role: 'coordinator', last_read_seq: 1 },
      alice: { role: 'worker', id: 'alice-1', killed: '1', last_read_seq: 1 },
      standin: { role: 'worker', id: 'gp-1', killed: '1', last_read_seq: 1 },
    },
  }
  const { answer, board } = owning(on, {
    board: () => '',
    roster: () => JSON.stringify(closedState),
  })
  // After restart: restore returns '' (closed run is not owned), agent-run returns the closed run for registered ids
  on('process.run', (_, e) => answer(e.argv[3] === 'agent-run' ? OWNED : board(e)))
  on('agent.list', () => ({
    value: [
      { id: 'alice-1', description: '@alice', type: 'swarm:worker', status: 'running' },
      { id: 'gp-1', description: '@standin', type: 'general-purpose', status: 'running' },
    ] as never,
  }))
  on('tool.call', () => ({ result: {} }))
  mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })

  expect((await toolCall($, { tool: 'Read', file_path: '/project/src/a.ts', agentId: 'alice-1' } as never)).deny).toContain('retired')
  expect((await toolCall($, { tool: 'Grep', pattern: 'foo', agentId: 'alice-1' } as never)).deny).toContain('retired')
  expect((await toolCall($, { tool: 'Glob', pattern: '**/*.ts', agentId: 'alice-1' } as never)).deny).toContain('retired')
  // A registered general-purpose stand-in marked retired in a killed run is also blocked on Read after restart
  expect((await toolCall($, { tool: 'Read', file_path: '/project/src/a.ts', agentId: 'gp-1' } as never)).deny).toContain('retired')
})

test('token-economy #1 & #2: auto-injects roster model on spawn and registers compressed board schema', async ($, on) => {
  let boardSpec: { description: string; isDeferred?: boolean; inputSchema: { properties: Record<string, { description?: string; enum?: string[] }> } } | undefined
  on('command.register', (_, spec) => ({ value: { command: spec.name } }))
  on('tool.register', (_, spec) => {
    if (spec.name === 'board') boardSpec = spec as unknown as typeof boardSpec
    return { value: { tool: `mcp__swarm__${spec.name}` } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'fixture-conversation' }))
  on('session.cwd', () => ({ value: '/project' }))
  on('process.run', (_, e) => ({
    value: { exitCode: 0, stdout: e.argv.includes('restore') ? OWNED : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('fs.read', () => ({
    value: JSON.stringify({
      title: 'Model swarm',
      members: { coordinator: {}, builder: { role: 'worker', model: 'opus' } },
    }),
  }))
  const spawnedModels: (string | undefined)[] = []
  on('agent.spawn', (_, e) => {
    spawnedModels.push(e.model)
    return { model: e.model ?? 'sonnet', agentId: 'w-1' }
  })
  mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })

  // #2: compressed board schema preserves isDeferred: false, all 10 properties and 18 actions
  expect(boardSpec).toBeDefined()
  expect(boardSpec!.isDeferred).toBe(false)
  expect(Object.keys(boardSpec!.inputSchema.properties).sort()).toEqual(['action', 'commit', 'member', 'name', 'newName', 'options', 'out', 'seq', 'text', 'title'])
  expect(boardSpec!.inputSchema.properties.action!.enum!.length).toBe(18)
  const totalDescLen = boardSpec!.description.length + Object.values(boardSpec!.inputSchema.properties).reduce((n, p) => n + (p.description?.length ?? 0), 0)
  expect(totalDescLen).toBeLessThan(520)

  // #1: omitting model auto-injects roster's opus model; explicit wrong model is still denied
  const baseSpawn = {
    tool_use_id: 'sp-1',
    description: '@builder: build feature',
    subagentType: 'swarm:worker',
    prompt: 'Use the board.',
    provider: { plugin: 'swarm', tier: 'core' as const },
    parentModel: 'sonnet',
    background: true,
    fork: false,
  }
  expect((await $.agent.spawn({ ...baseSpawn, model: 'haiku' })).deny).toContain('model: "opus"')
  expect((await $.agent.spawn(baseSpawn)).agentId).toBe('w-1')
  expect(spawnedModels[0]).toMatch(/^claude-opus-/)
})

test('token-economy #3: the coordinating conversation is compacted after deployment and on regrowth, independent FINDING coalescing, initNotes suppression, single bgWarning, and no refresh churn', async ($, on) => {
  let contextTokens = 10_000
  let boardText = posts({ agent: 'coordinator', to: ['inv1', 'inv2'], text: '@inv1 @inv2 BRIEF' })
  let attentionCalls = 0
  const state = {
    title: 'Economy swarm',
    members: {
      coordinator: { role: 'coordinator', last_read_seq: 1 },
      inv1: { role: 'worker', profile: 'investigator', id: 'inv1-1', last_read_seq: 1 },
      inv2: { role: 'worker', profile: 'investigator', id: 'inv2-1', last_read_seq: 1 },
      impl: { role: 'worker', id: 'impl-1', last_read_seq: 0 } as Record<string, unknown>,
    },
  }
  const { seen, answer, board } = owning(on, {
    board: () => boardText,
    roster: () => JSON.stringify(state),
  })
  on('session.usage', () => ({ value: { context: { tokens: contextTokens }, total: { input: 0, output: 0 } } as never }))
  const compactions: string[] = []
  on('session.compact', (_, e) => {
    compactions.push(String(e.instructions))
    return { messages: [{ role: 'user', text: 'The summary.', toolUses: [] }] as never }
  })
  on('process.run', (_, e) => {
    if (e.argv[3] === 'attention') {
      attentionCalls++
      return answer(JSON.stringify({ items: [], members: {} }))
    }
    return answer(board(e))
  })
  on('agent.list', () => ({
    value: [
      { id: 'inv1-1', description: '@inv1', type: 'swarm:investigator', status: 'completed' },
      { id: 'inv2-1', description: '@inv2', type: 'swarm:investigator', status: 'running' },
      { id: 'impl-1', description: '@impl', type: 'swarm:worker', status: 'completed' },
    ] as never,
  }))
  on('command.run', () => ({ text: '' }))
  on('tool.call', (_, e) => ({ result: { stdout: e.tool === 'Bash' && String(e.command).includes(' init ') ? `${OWNED}\n` : '' } }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })

  // Memory-started init (no /swarm:swarm yet) emits base initNotes mentioning 3,000,000 default
  const memInit = await toolCall($, { tool: 'Bash', command: `python3 /p/board.py /project/.swarm init "Economy swarm"` })
  expect((memInit.context ?? []).some(c => c.includes('3,000,000'))).toBe(true)

  // After /swarm:swarm ran, base initNotes is suppressed
  await $.command.run({ command: 'swarm:swarm', args: 'do work', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 80 } })
  const cmdInit = await toolCall($, { tool: 'Bash', command: `python3 /p/board.py /project/.swarm init "Economy swarm"` })
  expect((cmdInit.context ?? []).some(c => c.includes('A run was made'))).toBe(false)

  await clock.advance(2000)

  // bgWarning emitted at most once per run
  const bg1 = await toolCall($, { tool: 'Bash', command: 'echo build1', run_in_background: true } as never)
  const bg2 = await toolCall($, { tool: 'Bash', command: 'echo build2', run_in_background: true } as never)
  expect((bg1.context ?? []).some(c => c.includes('background Bash'))).toBe(true)
  expect((bg2.context ?? []).some(c => c.includes('background Bash'))).toBe(false)

  // refresh() churn: coordinator turn.start / turn.complete does NOT re-run board.py attention --json
  const attentionBefore = attentionCalls
  await $.turn.start({ text: 'coord turn', turnId: 'ct-1' })
  await clock.advance(2000)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, reason: 'answer', turnId: 'ct-1' })
  await clock.advance(2000)
  expect(attentionCalls).toBe(attentionBefore)

  // The coordinator's conversation is compacted by the hooks once the team is deployed: at 120k the first time, and
  // again only when it has grown back to 180k. The summary keeps coordinating the same run.
  const endTurn = async (turnId: string) => {
    await $.turn.start({ text: 'coord turn', turnId })
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, reason: 'answer', turnId })
    await clock.advance(10)
  }
  contextTokens = 110_000
  await endTurn('ct-light')
  expect(compactions).toEqual([])
  contextTokens = 130_000
  await endTurn('ct-long')
  expect(compactions.length).toBe(1)
  expect(compactions[0]).toContain(`coordinates the Swarm run "Economy swarm" at ${OWNED}, and goes on coordinating it`)
  expect(compactions[0]).toContain('the board is the memory of this run')
  await endTurn('ct-same')
  expect(compactions.length).toBe(1)
  contextTokens = 190_000
  await endTurn('ct-regrown')
  expect(compactions.length).toBe(2)
  contextTokens = 10_000

  // Independent FINDING coalescing: inv1 posts FINDING while inv2 works and nobody depends on inv1 -> deferred past 10s
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, reason: 'answer', turnId: 'ct-idle' })
  boardText = posts(
    { agent: 'coordinator', to: ['inv1', 'inv2'], text: '@inv1 @inv2 BRIEF' },
    { agent: 'inv1', to: ['coordinator'], text: 'FINDING root cause in parser' },
  )
  await clock.advance(2000)
  await clock.advance(12_000)
  expect(seen.prompts.filter(p => p.includes('Unread board mentions'))).toEqual([])

  // The board stores after=inv1 in depends too. That finding wakes the coordinator after the usual grace.
  state.members.impl.depends = 'inv1'
  state.members.impl.after = 'inv1'
  await clock.advance(2000)
  await clock.advance(12_000)
  expect(seen.prompts.filter(p => p.includes('Unread board mentions')).length).toBe(1)
})

test('CR-3: replaying a turn from a closed/released run after a new run starts does not bill the new run', async ($, on) => {
  const RUN_B = '/project/.swarm/run-b-20261123-100000'
  let runAClosed = false
  const charged: string[] = []
  const { answer, board } = owning(on, {
    board: () => posts({ agent: 'coordinator', to: [], text: 'plan' }),
    roster: () => JSON.stringify({ title: 'Run A', closed: runAClosed, members: { coordinator: { role: 'coordinator', last_read_seq: 1 } } }),
    read: path => path === `${RUN_B}/members.json`
      ? JSON.stringify({ title: 'Run B', closed: false, members: { coordinator: { role: 'coordinator', last_read_seq: 1 } } })
      : undefined,
    exists: true,
  })
  on('process.run', (_, e) => {
    if (e.argv[3] === 'account') {
      charged.push(`${e.argv[2]}:${e.argv[6]}`)
      return answer(JSON.stringify({ title: 'x', total: 100, budget: 0, paused: false }))
    }
    return answer(board(e))
  })
  on('agent.list', () => ({ value: [] }))
  on('tool.call', () => ({ result: {} }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })

  // Own Run A and charge turn T to Run A
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)
  const usage = { model: 'm', input_tokens: 300, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, reason: 'answer', turnId: 'turn-T', usage })
  expect(charged).toEqual([`${OWNED}:300`])

  // Close/release Run A (triggered by accounting check on a closed run), then own Run B
  runAClosed = true
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, reason: 'answer', turnId: 'turn-close', usage })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${RUN_B}" read coordinator` })
  await clock.advance(2000)

  // Replay turn-T after Run B is active: Run B must NOT be billed
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, reason: 'answer', turnId: 'turn-T', usage })
  expect(charged).toEqual([`${OWNED}:300`])

  // New turn under Run B still bills Run B normally
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, reason: 'answer', turnId: 'turn-B1', usage })
  expect(charged).toEqual([`${OWNED}:300`, `${RUN_B}:300`])
})

test('CR2-4: isolated writer cannot edit main checkout when coordinator runs inside a worktree', async ($, on) => {
  const COORD_WT = '/project/.claude/worktrees/coord'
  const WT_RUN = `${COORD_WT}/.swarm/demo-20261116-101010`
  const state = {
    title: 'Coord worktree swarm',
    members: {
      coordinator: { role: 'coordinator', last_read_seq: 1 },
      bob: { role: 'worker', id: 'bob-1', paths: 'src/bob', isolated: '1', last_read_seq: 1 },
    },
  }
  const { answer, board } = owning(on, {
    board: () => posts({ agent: 'coordinator', to: ['bob'], text: '@bob BRIEF' }),
    roster: () => JSON.stringify(state),
    cwd: () => COORD_WT,
  })
  on('process.run', (_, e) => answer(board(e)))
  on('agent.list', () => ({ value: [{ id: 'bob-1', description: '@bob', type: 'swarm:worker', status: 'running' }] as never }))
  on('tool.call', () => ({ result: {} }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: COORD_WT, surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${WT_RUN}" read coordinator` })
  await clock.advance(2000)

  // Main checkout (/project/src/bob/b.ts) must be denied for isolated bob even when coordinator runs in /project/.claude/worktrees/coord
  expect((await toolCall($, { tool: 'Edit', file_path: '/project/src/bob/b.ts', old_string: 'a', new_string: 'b', agentId: 'bob-1' })).deny).toContain('isolated to its own worktree')
  // Bob's own worktree under /project/.claude/worktrees/agent-bob-1/ is still allowed
  expect((await toolCall($, { tool: 'Edit', file_path: '/project/.claude/worktrees/agent-bob-1/src/bob/b.ts', old_string: 'a', new_string: 'b', agentId: 'bob-1' })).deny).toBeUndefined()
})

test('CR3-3: linked worktree outside .claude/worktrees still blocks isolated writer from main checkout', async ($, on) => {
  const LINKED = '/work/coord'
  const LINKED_RUN = `${LINKED}/.swarm/demo-20261116-101010`
  const state = {
    title: 'Linked worktree swarm',
    members: {
      coordinator: { role: 'coordinator', last_read_seq: 1 },
      bob: { role: 'worker', id: 'bob-1', paths: 'src/bob', isolated: '1', last_read_seq: 1 },
    },
  }
  let gitdirLine = 'gitdir: /project/.git/worktrees/coord\n'
  const { answer, board } = owning(on, {
    board: () => posts({ agent: 'coordinator', to: ['bob'], text: '@bob BRIEF' }),
    roster: () => JSON.stringify(state),
    cwd: () => LINKED,
    read: path => path === `${LINKED}/.git` ? gitdirLine : undefined,
  })
  on('process.run', (_, e) => answer(board(e)))
  on('agent.list', () => ({ value: [{ id: 'bob-1', description: '@bob', type: 'swarm:worker', status: 'running' }] as never }))
  on('tool.call', () => ({ result: {} }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: LINKED, surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${LINKED_RUN}" read coordinator` })
  await clock.advance(2000)

  expect((await toolCall($, { tool: 'Edit', file_path: '/project/src/bob/b.ts', old_string: 'a', new_string: 'b', agentId: 'bob-1' })).deny).toContain('isolated to its own worktree')
  expect((await toolCall($, { tool: 'Edit', file_path: '/project/.claude/worktrees/agent-bob-1/src/bob/b.ts', old_string: 'a', new_string: 'b', agentId: 'bob-1' })).deny).toBeUndefined()

  // Relative gitdir link resolves against the coordinator worktree too
  gitdirLine = 'gitdir: ../../project/.git/worktrees/coord\n'
  expect((await toolCall($, { tool: 'Edit', file_path: '/project/src/bob/b.ts', old_string: 'a', new_string: 'b', agentId: 'bob-1' })).deny).toContain('isolated to its own worktree')
  expect((await toolCall($, { tool: 'Edit', file_path: '/project/.claude/worktrees/agent-bob-1/src/bob/b.ts', old_string: 'a', new_string: 'b', agentId: 'bob-1' })).deny).toBeUndefined()
})

test('CR3-4 & CR3-5: replay without usage retries failed END charge, and cross-session stale turn.complete does not mutate new session', async ($, on) => {
  let failAccount = true
  let holdAccount = false
  let releaseAccount!: () => void
  const charged: string[] = []
  const newRun = '/project/.swarm/new-session-20261123-120000'
  const { answer, board } = owning(on, {
    board: () => posts({ agent: 'coordinator', to: [], text: 'plan' }),
    roster: () => JSON.stringify({ title: 'Accounting swarm', members: { coordinator: { role: 'coordinator', last_read_seq: 1 } } }),
    exists: true,
  })
  on('process.run', async (_, e) => {
    if (e.argv[3] === 'account') {
      if (holdAccount) await new Promise<void>(resolve => { releaseAccount = resolve })
      if (failAccount) return { value: { exitCode: 1, stdout: '', stderr: 'busy', isStdoutTruncated: false, isStderrTruncated: false } }
      charged.push(`${e.argv[2]}:${e.argv[6]}`)
      return answer(JSON.stringify({ title: 'Accounting swarm', total: 200, budget: 0, paused: false }))
    }
    return answer(board(e))
  })
  on('agent.list', () => ({ value: [] }))
  on('tool.call', () => ({ result: {} }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)

  const usage = { model: 'm', input_tokens: 200, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  // CR3-4: first turn.complete fails -> END charge stored; replay without usage retries and lands it
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, reason: 'answer', turnId: 'retry-end', usage })
  expect(charged).toEqual([])
  failAccount = false
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, reason: 'answer', turnId: 'retry-end' })
  expect(charged).toEqual([`${OWNED}:200`])
  // Subsequent replay without usage sends nothing once settled
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, reason: 'answer', turnId: 'retry-end' })
  expect(charged).toEqual([`${OWNED}:200`])

  // CR3-5: stale turn.complete finishing after session.end + new session.start must not pollute new session's turnRuns
  holdAccount = true
  const stale = $.turn.complete({ answer: '', durationMs: 1, isAborted: false, reason: 'answer', turnId: 'stale-t', usage })
  await clock.advance(0)
  await $.session.end({ reason: 'clear', sessionId: 'fixture-conversation', resume: { id: 'fixture-conversation' } })
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  holdAccount = false
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${newRun}" read coordinator` })
  const fresh = $.turn.complete({ ...ends, turnId: 'stale-t', usage })
  await clock.advance(0)
  const beforeRelease = [...charged]
  releaseAccount()
  await Promise.all([stale, fresh])
  expect(beforeRelease).toEqual([`${OWNED}:200`, `${newRun}:200`])
  // Replaying the new session's end without usage must not charge either run again.
  const before = charged.length
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, reason: 'answer', turnId: 'stale-t' })
  expect(charged.length).toBe(before)
})

test('CR3-6: /swarm-kill compaction resets sawSwarmCommand so a later memory-started init gets initNotes', async ($, on) => {
  // CR3-6: /swarm:swarm -> /swarm-kill (compacted) -> memory-started init gets initNotes again
  killable(on, { alice: { role: 'worker', id: 'alice-1', last_read_seq: 1 } })
  on('agent.list', () => ({ value: [] as never }))
  on('command.run', () => ({ text: '' }))
  const clock = mock.clock(on)
  await settle(clock, $)
  await $.command.run({ command: 'swarm:swarm', args: 'task', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 80 } })
  await killCommand($)
  await clock.advance(10)
  const memInit = await toolCall($, { tool: 'Bash', command: `python3 /p/board.py /project/.swarm init "After kill"` })
  expect((memInit.context ?? []).some(c => c.includes('A run was made'))).toBe(true)
})

test('CR3-7: tailed board does not filter out unaddressed specialist with depends based on incomplete tail', async ($, on) => {
  const state = {
    title: 'Tailed swarm',
    members: {
      coordinator: { role: 'coordinator', last_read_seq: 10 },
      builder: { role: 'worker', id: 'builder-1', last_read_seq: 10 },
      arch: { role: 'worker', profile: 'architect', depends: 'builder', last_read_seq: 0 },
      scout: { role: 'worker', profile: 'explorer', id: 'scout-1', last_read_seq: 0 },
    },
  }
  // Tailed board starting at seq 10 (builder's earlier READY at seq 5 was before the tail)
  let tailedBoard = [
    JSON.stringify({ seq: 10, agent: 'coordinator', to: ['arch', 'scout'], text: '@arch @scout check', time: '2026-11-16T14:03:22+0100' }),
  ].join('\n') + '\n'
  let attentionFailed = true
  let statSize = 5_000_000
  const { seen, answer, board } = owning(on, {
    board: () => tailedBoard,
    roster: () => JSON.stringify(state),
  })
  on('fs.stat', () => ({ value: { size: statSize, mtimeMs: 1 } as never }))
  on('process.run', (_, e) => {
    if (e.argv[3] === 'tail') return answer(tailedBoard)
    if (e.argv[3] === 'attention') {
      if (attentionFailed) return { value: { exitCode: 1, stdout: '', stderr: 'busy', isStdoutTruncated: false, isStderrTruncated: false } }
      return answer(JSON.stringify({
        items: [],
        members: {
          arch: { type: 'architect', model: 'fable', effort: 'high', depends: ['builder'], owns: '', ready: false, blocked_on: [], asked: 0, unreachable: false },
        },
      }))
    }
    return answer(board(e))
  })
  on('agent.list', () => ({
    value: [
      { id: 'builder-1', description: '@builder', type: 'swarm:worker', status: 'completed' },
      { id: 'scout-1', description: '@scout', type: 'swarm:explorer', status: 'completed' },
    ] as never,
  }))
  on('tool.call', () => ({ result: {} }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, reason: 'answer', turnId: 'tail-t' })
  await clock.advance(2000)

  // While attention --json is unavailable, arch (which has depends='builder') must NOT be prematurely suggested
  const firstPrompt = seen.prompts.find(p => p.includes('Delivering board mentions'))
  expect(firstPrompt).toBeDefined()
  expect(firstPrompt).toContain('@scout')
  expect(firstPrompt).not.toContain('@arch')

  // Once attention --json recovers on retry with blocked_on: [], arch IS included even on a tailed board
  attentionFailed = false
  statSize += 100
  tailedBoard += JSON.stringify({ seq: 11, agent: 'coordinator', to: ['arch', 'scout'], text: '@arch @scout update', time: '2026-11-16T14:04:00+0100' }) + '\n'
  await clock.advance(12_000)
  const recoveredPrompt = seen.prompts.findLast(p => p.includes('Delivering board mentions'))
  expect(recoveredPrompt).toBeDefined()
  expect(recoveredPrompt).toContain('@arch')
})

test('P1 delayed member turn.complete across session restart cannot bill new run, and replayed coordinator turn does not clear active busy state', async ($, on) => {
  const RUN_B = '/project/.swarm/run-b-20261123-120000'
  let activeRun = OWNED
  let holdAgentList = false
  let releaseAgentList!: () => void
  const charged: string[] = []
  let boardText = posts({ agent: 'coordinator', to: ['w'], text: '@w BRIEF' })
  const { seen, answer, board } = owning(on, {
    board: () => boardText,
    roster: () => JSON.stringify({
      title: 'Run A',
      members: { coordinator: { role: 'coordinator', last_read_seq: 1 }, w: { role: 'worker', id: 'teammate-addr', last_read_seq: 1 } },
    }),
    read: path => path === `${RUN_B}/members.json`
      ? JSON.stringify({
        title: 'Run B',
        members: { coordinator: { role: 'coordinator', last_read_seq: 1 }, w: { role: 'worker', id: 'teammate-addr', last_read_seq: 1 } },
      })
      : undefined,
    exists: true,
  })
  on('process.run', (_, e) => {
    if (e.argv[3] === 'agent-run') return answer(activeRun)
    if (e.argv[3] === 'account') {
      charged.push(`${e.argv[2]}:${e.argv[6]}`)
      return answer(JSON.stringify({ title: 'Run', total: 500, budget: 500, paused: true }))
    }
    return answer(board(e))
  })
  on('agent.list', async () => {
    if (holdAgentList) await new Promise<void>(resolve => { releaseAgentList = resolve })
    return { value: [{ id: 'old-member', teammateId: 'teammate-addr', description: '@w', type: 'swarm:worker', status: 'completed' }] as never }
  })
  on('tool.call', () => ({ result: {} }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)

  // Hold old member's turn.complete during $.agent.list(), restart session, and start Run B reusing teammate-addr
  const usage = { model: 'm', input_tokens: 500, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  holdAgentList = true
  const delayed = $.turn.complete({ answer: '', durationMs: 1, isAborted: false, reason: 'answer', turnId: 'old-turn', agentId: 'old-member', usage })
  await clock.advance(0)
  holdAgentList = false
  await $.session.end({ reason: 'clear', sessionId: 'fixture-conversation', resume: { id: 'fixture-conversation' } })
  activeRun = RUN_B
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${RUN_B}" read coordinator` })
  await clock.advance(2000)
  releaseAgentList()
  await delayed
  // Run B must receive ZERO charges and ZERO budget-pause prompts from the stale session's delayed completion
  expect(charged).toEqual([])
  expect(seen.prompts.filter(p => p.includes('paused at token budget'))).toEqual([])

  // Replayed coordinator completion for turn A while turn B is active must NOT clear turn B's busy state
  await $.turn.start({ text: 'turn A', turnId: 'coord-A' })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, reason: 'answer', turnId: 'coord-A' })
  await $.turn.start({ text: 'turn B', turnId: 'coord-B' })
  boardText = posts(
    { agent: 'coordinator', to: ['w'], text: '@w BRIEF' },
    { agent: 'w', to: ['coordinator'], text: '@coordinator question?' },
  )
  // Replay turn A while turn B is still running
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, reason: 'answer', turnId: 'coord-A' })
  await clock.advance(2000)
  await clock.advance(12_000)
  // Coordinator is still busy on turn B, so no idle unread prompt may be submitted
  expect(seen.prompts.filter(p => p.includes('Unread board mentions'))).toEqual([])
})

test('P1 same-session run switch cannot bill new run for uncached member, and stale agentRun across restart cannot poison next session Read', async ($, on) => {
  const RUN_B = '/project/.swarm/run-b-20261123-130000'
  let runAClosed = false
  let holdAgentList = false
  let releaseAgentList!: () => void
  let holdAgentRun = false
  let releaseAgentRun!: () => void
  let releaseModel!: () => void
  let enteredModel!: () => void
  const modelRelease = new Promise<void>(resolve => { releaseModel = resolve })
  const modelEntered = new Promise<void>(resolve => { enteredModel = resolve })
  let agentRunDir = OWNED
  const charged: string[] = []
  const rearmed: string[] = []
  const { answer, board } = owning(on, {
    board: () => posts({ agent: 'coordinator', to: ['w'], text: '@w BRIEF' }),
    roster: () => JSON.stringify({
      title: 'Run A',
      closed: runAClosed,
      members: { coordinator: { role: 'coordinator', last_read_seq: 1 }, w: { role: 'worker', id: 'tm-same', last_read_seq: 1 } },
    }),
    read: path => path === `${RUN_B}/members.json`
      ? JSON.stringify({
        title: 'Run B',
        closed: false,
        members: { coordinator: { role: 'coordinator', last_read_seq: 1 }, w: { role: 'worker', id: 'tm-same', last_read_seq: 1 } },
      })
      : undefined,
    exists: true,
  })
  on('process.run', async (_, e) => {
    if (e.argv[3] === 'agent-run') {
      const found = agentRunDir
      if (holdAgentRun) await new Promise<void>(resolve => { releaseAgentRun = resolve })
      return answer(found)
    }
    if (e.argv[3] === 'account') {
      charged.push(`${e.argv[2]}:${e.argv[6]}`)
      return answer(JSON.stringify({ title: 'Run', total: 400, budget: 0, paused: false }))
    }
    if (e.argv[3] === 'rearm') rearmed.push(e.argv[2]!)
    return answer(board(e))
  })
  on('agent.list', async () => {
    if (holdAgentList) await new Promise<void>(resolve => { releaseAgentList = resolve })
    return { value: [{ id: 'uncached-m', teammateId: 'tm-same', description: '@w', type: 'swarm:worker', status: 'completed' }] as never }
  })
  on('tool.call', () => ({ result: {} }))
  const usage = { model: 'm', input_tokens: 400, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  on('turn.step', async function* (_, e) {
    if (e.turnId === 'old-coordinator' && e.index === 0) {
      enteredModel()
      await modelRelease
    }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use' as const, usage }
  })
  const step = async (turnId: string, index: number) => {
    for await (const _ of $.turn.step({ turnId, index, model: 'm', messageCount: 1 })) { /* no chunks */ }
  }
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)

  // Delay uncached member's turn.complete while closing Run A and opening Run B in the SAME session reusing tm-same
  const oldStep = step('old-coordinator', 0)
  await modelEntered
  holdAgentList = true
  const sameSessionDelayed = $.turn.complete({ answer: '', durationMs: 1, isAborted: false, reason: 'answer', turnId: 'same-sess-t', agentId: 'uncached-m', usage })
  await clock.advance(0)
  holdAgentList = false
  runAClosed = true
  await clock.advance(2000)
  agentRunDir = RUN_B
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${RUN_B}" read coordinator` })
  await clock.advance(2000)
  releaseAgentList()
  releaseModel()
  await Promise.all([sameSessionDelayed, oldStep])
  await step('old-coordinator', 1)
  await $.turn.complete({ ...ends, turnId: 'old-coordinator', usage: { ...usage, input_tokens: 800 } })
  expect(charged).toEqual([])
  expect(rearmed).toEqual([])
  await $.turn.complete({ ...ends, turnId: 'same-sess-t', agentId: 'uncached-m', usage })
  expect(charged).toEqual([])
  expect(rearmed).toEqual([])
  await $.turn.complete({ ...ends, turnId: 'new-turn', agentId: 'uncached-m', usage })
  expect(charged).toEqual([`${RUN_B}:400`])
  expect(rearmed).toEqual([RUN_B])
  await step('new-coordinator', 0)
  await $.turn.complete({ ...ends, turnId: 'new-coordinator', usage })
  expect(charged).toEqual([`${RUN_B}:400`, `${RUN_B}:400`])

  // Stale agent-run lookup held across session restart must not poison next session's agentRuns and refuse member Read
  agentRunDir = OWNED
  holdAgentRun = true
  const staleRead = toolCall($, { tool: 'Read', file_path: '/project/a.ts', agentId: 'reused-id' } as never)
  await clock.advance(0)
  holdAgentRun = false
  await $.session.end({ reason: 'clear', sessionId: 'fixture-conversation', resume: { id: 'fixture-conversation' } })
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  agentRunDir = RUN_B
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${RUN_B}" read coordinator` })
  await clock.advance(2000)
  releaseAgentRun()
  await staleRead
  // In the new session driving RUN_B, reused-id (whose current agent-run is RUN_B) must NOT be refused with OVER
  expect((await toolCall($, { tool: 'Read', file_path: '/project/a.ts', agentId: 'reused-id' } as never)).deny).toBeUndefined()
})

test('a delayed retirement read cannot mark a replacement run’s member retired', async ($, on) => {
  const newRun = '/project/.swarm/new-roster-20261123-120000'
  let releaseRoster!: () => void
  let enteredRoster!: () => void
  const rosterRelease = new Promise<void>(resolve => { releaseRoster = resolve })
  const rosterEntered = new Promise<void>(resolve => { enteredRoster = resolve })
  const { answer, board } = owning(on, {
    board: () => '',
    roster: () => JSON.stringify({
      closed: true, title: 'Old run',
      members: { w: { role: 'worker', id: 'shared-address', killed: '1', last_read_seq: 0 } },
    }),
    hold: path => {
      if (path !== `${OWNED}/members.json`) return undefined
      enteredRoster()
      return rosterRelease
    },
    read: path => path === `${newRun}/members.json` ? JSON.stringify({
      title: 'New run',
      members: { coordinator: { role: 'coordinator', last_read_seq: 0 }, w: { role: 'worker', id: 'shared-address', last_read_seq: 0 } },
    }) : undefined,
    exists: true,
  })
  on('process.run', (_, e) => answer(e.argv[3] === 'agent-run' ? OWNED : board(e)))
  on('agent.list', () => ({
    value: [{ id: 'old-member', teammateId: 'shared-address', description: '@w', type: 'swarm:worker', status: 'completed' }] as never,
  }))
  on('tool.call', () => ({ result: {} }))
  mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  const stale = toolCall($, { tool: 'Read', file_path: '/project/a.ts', agentId: 'old-member' } as never)
  await rosterEntered
  await toolCall($, { tool: 'Bash', command: `python3 /p/board.py "${newRun}" read coordinator` })
  releaseRoster()
  await stale
  expect((await toolCall($, { tool: 'Read', file_path: '/project/a.ts', agentId: 'shared-address' } as never)).deny).toBeUndefined()
})
