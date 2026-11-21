import type { McpToolInputs } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { wakeMessage } from './command'

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
    await ui.press({ key: 'agent-1' })
    expect(viewed).toEqual(['a2', undefined])

    await ui.press({ key: 'tab-members' })
    expect(await ui.find({ type: 'Text', text: /working · 1 post$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 unread/ })).toBeDefined()
    // every member is a card of its own with the same rows in the same order: who it is, then how it is doing
    const cards = (await ui.findAll({ type: 'Box' })).filter(box => box.props.borderStyle === 'round')
    expect(cards.length).toBeGreaterThan(2)
    for (const card of cards) {
      const [identity, state] = card.children as { type: string; props: Record<string, unknown>; text?: string }[]
      expect(identity?.type).toBe('Text')
      expect(String(card.text)).toMatch(new RegExp(`^@${card.key}\\b`))
      expect(state?.type).toBe('Box')
      expect(state?.props.flexDirection).toBe('row')
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
      const focusedGraph = String((await findSvg(ui, /^Post 3 · @verifier to @parser$/))?.props.source)
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
  await ui.press({ key: 'tab-board' })
  await clock.advance(431)
  await ui.press({ key: 'tab-graph' })
  const routeAfter = String((await findSvg(ui, /^Post /))?.props.source)
  expect(routeAfter).not.toBe(routeBefore)
  expect(routeAfter).toMatch(/animateMotion begin="-[1-9][0-9]*ms"/)
  board = BOARD.slice(0, BOARD.lastIndexOf('\n') + 1) + JSON.stringify({
    seq: 4, agent: 'parser', to: ['later'], text: '@verifier quoted in a follow-up',
    time: '2026-11-16T14:03:23+0100',
  }) + '\n' + JSON.stringify({
    seq: 5, agent: 'later', to: ['verifier'], text: 'Checked the patch.',
    time: '2026-11-16T14:03:23+0100',
  }) + '\n'
  await clock.advance(2000 - clock.now() % 2000)
  expect(String((await findSvg(ui, /^Post /))?.props.source)).toContain('animateMotion')
  expect(await findSvg(ui, /^Post /).then(svg => svg?.props.alt)).toBe('Post 4 · @parser to @later')
  await clock.advance(1200)
  expect(await findSvg(ui, /^Post /).then(svg => svg?.props.alt)).toBe('Post 5 · @later to @verifier')
  expect(String((await findSvg(ui, /^Post /))?.props.source)).toContain('animateMotion')
  await clock.advance(1200)
  expect(String((await findSvg(ui, /^Post /))?.props.source)).toContain('repeatCount="indefinite"')
  await ui.press({ key: 'tab-board' })
  await ui.press({ key: 'graph-post-4' })
  expect(await findSvg(ui, /^Post /).then(svg => svg?.props.alt)).toBe('Post 4 · @parser to @later')
  parserStatus = 'idle'
  await clock.advance(2000)
  expect(await findSvg(ui, /^Post /).then(svg => svg?.props.alt)).toBe('Post 4 · @parser to @later')
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
  expect(await ui.find({ type: 'Text', text: /waiting · 2 posts/ })).toBeDefined()
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
  await $.tool.call({ tool: 'Bash', command: `python3 /p/board.py "${RUN}" read coordinator` })
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

test('the board command opens immediately and only opens the pane', async ($, on) => {
  on('ui.panes', () => ({ value: [] }))
  const actions: string[] = []
  let immediate: true | undefined
  on('tool.register', (_, spec) => ({ value: { tool: `mcp__swarm__${spec.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, spec) => {
    immediate = spec.immediate

    return { value: { command: spec.name } }
  })
  on('session.cwd', () => {
    actions.push('poll')

    return { value: '/project' }
  })
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

  expect(immediate).toBe(true)
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

  const band = await $.ui.mount({ component: 'AbovePrompt', plugin: 'swarm', surface: 'desktop', props })
  // One row: the shortcut first on the crab's line, Swarm's own row left out.
  expect(keys(await band.drawn() as Tree)).toEqual(['swarm-board-shortcut', 'crab-band', 'crab-fill', 'crab-text', 'crab-buddy'])
  expect(await band.find({ type: 'Button', text: 'Swarm: The Board' })).toBeDefined()
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
  expect(tails).toBeGreaterThan(0)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
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
  expect((await $.agent.spawn(spawn)).agentId).toBe('started')
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
  expect((await $.tool.call({ ...call, action: 'read' })).deny).toBeUndefined()
  // The board cuts a post longer than a page; how to open it whole is said in the tool's words, not the shell's.
  isTooLong = true
  const paged = await $.tool.call({ ...call, action: 'read' })
  expect(String(paged.result)).toContain('[cut to fit the page. The whole post: action "show" with seq 3]')
  // `show` is cut to a page too, keeping the newest posts whole
  const history = String((await $.tool.call({ ...call, action: 'show' })).result)
  expect(history.length).toBeLessThan(48200)
  expect(history).toMatch(/^Earlier posts are left out/)
  expect(history).toMatch(/\n#2000 @parser x+$/)
  expect(history.split('\n')[1]).toMatch(/^#\d+ @parser/)
  isTooLong = false
  // A member filter is taken as a member would write the name.
  expect((await $.tool.call({ ...call, action: 'show', member: '@Scout' })).deny).toBeUndefined()
  expect(processed.at(-1)?.args.slice(-2)).toEqual(['show', 'scout'])
  processed.length = 1  // the assertions below count the calls from the first read on
  expect((await $.tool.call({ ...call, action: 'ready', text: 'Parser is in src/parser.ts.' })).deny).toBeUndefined()
  expect((await $.tool.call({ ...call, action: 'post', member: 'other', text: 'Spoofed' })).deny).toBeDefined()
  expect((await $.tool.call({ ...call, action: 'post', agentId: 'other-address', text: 'Retired' })).deny).toBeDefined()
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
  await $.tool.call({ tool: 'Bash', command: `python3 /p/board.py "${RUN}" read coordinator` })
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
  expect(runs.filter(run => run.startsWith('account')).length).toBe(3)
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
  // the roster says sonnet; a call that forgets the model would start on the type's default, opus
  expect((await $.agent.spawn(probe)).deny).toContain('model: "sonnet"')
  expect((await $.agent.spawn({ ...probe, model: 'sonnet' })).agentId).toBe('started')
  // a family name on the call starts the newest model of that family
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
  // a closed run starts none of its members, and stops policing agents that are not its members
  closed = true
  expect((await $.agent.spawn(parser)).deny).toContain('is closed')
  expect((await $.agent.spawn({ ...parser, description: 'no name', isTeammate: true })).agentId).toBe('started')
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
  on('fs.read', () => ({
    value: JSON.stringify({ members: { coordinator: {}, parser: {}, probe: { role: 'worker', profile: 'investigator', writes: '0' } } }),
  }))
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'started' }))
  on('tool.call', () => ({ result: 'unused' }))
  mock.clock(on)

  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  expect(placed).toEqual([])
  const spawn = {
    tool_use_id: 'fixture', prompt: 'Use the board.', subagentType: 'swarm:worker',
    provider: { plugin: 'swarm', tier: 'core' as const }, parentModel: 'sonnet', background: true, fork: false,
  }
  // an unknown name adopts nothing, so the call passes as before; a registered one binds the run
  expect((await $.agent.spawn({ ...spawn, description: '@ghost: anything' })).agentId).toBe('started')
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
  const reply = await $.ui.mount({
    component: 'AssistantMessage', plugin: 'swarm', surface: 'desktop',
    props: { text: 'Swarm deployed.\n\nParser is checking date.ts.', isFirstOfReply: true },
  })
  expect(await reply.find({ type: 'Text', text: /Parser is checking date\.ts/ })).toBeDefined()
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
      exitCode: 0, stderr: '', isStdoutTruncated: false, isStderrTruncated: false,
      stdout: event.argv.includes('locate') ? (isRegistered ? run : '') : event.argv.includes('read') ? 'brief for probe' : '',
    },
  }))
  on('fs.read', () => ({
    value: JSON.stringify({ members: { coordinator: {}, probe: { role: 'worker', profile: 'investigator', writes: '0' } } }),
  }))
  mock.clock(on)

  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  const call = { tool: 'mcp__swarm__board' as const, tool_use_id: 'fixture', agentId: 'probe-address', action: 'read' as const }
  expect((await $.tool.call(call)).deny).toContain('No Swarm run is bound')
  isRegistered = true
  expect((await $.tool.call(call)).result).toBe('brief for probe')
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
  const bound = await $.tool.call({ tool: 'Bash', command: `python3 /p/board.py "${RUN}" read coordinator` })
  expect(bound.context).toBeUndefined()
  await clock.advance(2000)
  const told = await $.tool.call({ tool: 'Read', file_path: '/project/a.ts' })
  expect(told.context?.join(' ')).toContain('1 board post addresses you from #2')
  expect(told.context?.join(' ')).toContain(`'${RUN}' read coordinator`)
  // once per newest unread post, not on every call
  expect((await $.tool.call({ tool: 'Read', file_path: '/project/a.ts' })).context).toBeUndefined()
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
    expect(images.some(el => el.props.alt === 'coordinating')).toBe(coordinating)
  }
  await check('sleep', false)
  await $.turn.start({ text: 'Work', turnId: 'c' })
  await check('forage', true)
  await $.tool.call({ tool: 'Read', file_path: '/project/a' })
  await check('inspect', true)
  worker = 'running'
  await $.tool.call({ tool: 'Bash', command: 'npm test', agentId: 'a1' })
  await check('verify', true)
  await $.tool.call({ tool: 'Bash', command: 'touch scratch', agentId: 'outsider' })
  await check('verify', true)
  await $.tool.call({ tool: 'Write', file_path: '/project/a', content: '', agentId: 'a1' })
  await check('build', true)
  await $.tool.call({ tool: 'Bash', command: 'python3 board.py run post worker', agentId: 'a1' })
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
function owning(on: On, files: { board: () => string; roster: () => string; session?: () => string; read?: (path: string) => string | undefined; end?: () => Promise<void> }) {
  const seen = { commands: [] as string[], prompts: [] as string[], toasts: [] as string[], isDeaf: false, restore: '' }
  on('command.register', () => ({ value: { command: 'swarm-board' } }))
  on('tool.register', (_, spec) => ({ value: { tool: `mcp__swarm__${spec.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: files.session?.() ?? 'fixture-conversation' }))
  on('session.cwd', () => ({ value: '/project' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', (_, e) => ({ value: files.read?.(e.path) ?? (e.path.endsWith('/board.jsonl') ? files.board() : e.path.endsWith('/members.json') ? files.roster() : '') }))
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
  await $.tool.call({ tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
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
  await $.tool.call({ tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
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
  expect((await $.tool.call({ tool: 'Read', file_path: '/project/a.ts' })).context).toBeUndefined()
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
  await $.tool.call({ tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
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
  expect((await $.tool.call({ tool: 'Read', file_path: '/project/a.ts', agentId: 'a1' })).deny).toBeUndefined()

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
  const refused = await $.tool.call({ tool: 'Read', file_path: '/project/a.ts', agentId: 'a1' })
  expect(refused.deny).toMatch(/run is paused \(token budget of 1k spent\).*end your turn now/)
  expect((await $.tool.call({ tool: 'mcp__swarm__board', action: 'read', agentId: 'a1' })).deny).toContain('run is paused')
  expect((await $.tool.call({ tool: 'Bash', command: `python3 /p/board.py "${OWNED}" status` })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Read', file_path: '/project/a.ts', agentId: 'outsider' })).deny).toBeUndefined()
  // a resume with a raised budget lets it through again
  state.paused = undefined
  state.limits.budget = '5000'
  await clock.advance(2000)
  expect((await $.tool.call({ tool: 'Read', file_path: '/project/a.ts', agentId: 'a1' })).deny).toBeUndefined()

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
  await $.tool.call({ tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  expect(binds()).toBe(2)
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
  const bash = (command: string) => $.tool.call({ tool: 'Bash', command })

  // planning done before the run is bound is charged to it at the turn's end: no step's usage is lost on the way
  let spent = { model: 'm', input_tokens: 250, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use' as const, usage: spent }
  })
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  for await (const _ of $.turn.step({ turnId: 'plan', index: 0, model: 'm', messageCount: 1 })) { /* no chunks */ }
  await bash('python3 /p/board.py /project/.swarm/demo init "Demo swarm"')
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, reason: 'answer', turnId: 'plan', usage: spent })
  expect(seen.commands.filter(command => command.startsWith('account')).map(command => command.split(' ').at(-1))).toEqual(['250'])

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
  const charged = seen.commands.filter(command => command.startsWith('account')).map(command => Number(command.split(' ').at(-1)))
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
  const read = () => $.tool.call({ tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
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
    members: {}, limits: {},
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
  await $.tool.call({ tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
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
  await $.tool.call({ tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
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
  // the folder with no roster and `archive` are no runs: nothing lies further back
  await ui.press({ key: 'run-prev' })
  expect(seen.toasts).toEqual(['No earlier run in this project.'])
  // one press back to the live run, by the button or by stepping forward onto it
  await ui.press({ key: 'run-live' })
  expect(await ui.find({ type: 'Text', text: /^Demo swarm$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /read-only/ })).toBeUndefined()
  await ui.press({ key: 'run-prev' })
  await ui.press({ key: 'run-next' })
  expect(await ui.find({ type: 'Text', text: /^Demo swarm$/ })).toBeDefined()
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
  const bash = (command: string) => $.tool.call({ tool: 'Bash', command })
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
  expect((await $.tool.call({ tool: 'Read', file_path: '/project/a.ts' })).context?.join(' ')).toContain('is paused: @art failed verification 4 times')
  expect((await $.tool.call({ tool: 'Read', file_path: '/project/a.ts' })).context).toBeUndefined()
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
  const state: { members: Record<string, unknown>; paused?: string; closed?: boolean; limits?: Record<string, string>; usage?: { tokens: Record<string, number> } } = {
    members: {
      coordinator: { backend: 'native', last_read_seq: 0 },
      scout: { role: 'worker', profile: 'explorer', writes: '0', id: 'scout@team', last_read_seq: 0 },
    },
  }
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
    if (args[0] === 'claim') return { value: { exitCode: 0, stdout: '0123456789abcdef0123456789abcdef', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.send', () => ({ isDelivered: true }))
  mock.clock(on)

  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  const res = await $.session.send({ to: 'scout', text: `  ${wakeMessage(4)}\n`, origin: { kind: 'model' } } as never)
  expect(res.isDelivered).toBe(true)
  expect(commands).toContain('claim scout scout@team 4')
  expect(commands).toContain('woke scout 4 0123456789abcdef0123456789abcdef')

  state.paused = 'awaiting coordinator'
  const blocked = await $.session.send({ to: 'scout', text: wakeMessage(5), origin: { kind: 'model' } } as never)
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
  await $.tool.call({ tool: 'Agent', tool_use_id: 'eff-1', effort: 'high' } as never)
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
      return { value: { exitCode: 0, stdout: JSON.stringify({ items: attentionItems, members: {}, limits: {} }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
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
  expect(firstVisit).toContain('animateMotion begin="-0ms"')
  await ui.press({ key: 'tab-board' })
  await clock.advance(400)
  await ui.press({ key: 'tab-graph' })
  const returnVisit = String((await ui.findAll({ type: 'Svg' })).find(el => /^Post /.test(String(el.props.alt)))?.props.source)
  expect(returnVisit).toContain('animateMotion begin="-400ms"')

  // Dimmed Replay Next button at the newest post does not exit Live mode
  await ui.press({ key: 'replay-next' })
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
  const made = await $.tool.call({ tool: 'Bash', command: 'python3 /p/board.py /project/.swarm/demo init "Demo swarm" && echo ok' })
  expect(made.context?.join(' ')).toContain('skills/swarm/SKILL.md')
  expect(made.context?.join(' ')).toContain('already holds about 300k tokens')
  held = 20_000
  const again = await $.tool.call({ tool: 'Bash', command: 'python3 /p/board.py /project/.swarm/demo init "Demo swarm"' })
  expect(again.context?.join(' ')).toContain('name the token budget')
  expect(again.context?.join(' ')).not.toContain('already holds')
  await clock.advance(2000)
  // one member's posts were shown: the other member's post is still owed, and said so on that very result
  const some = await $.tool.call({ tool: 'Bash', command: `python3 /p/board.py ${RUN} show parser` })
  expect(some.context?.join(' ')).toContain('1 board post addresses you from #3')
  // a show piped to `head` or redirected to a file was not seen: the post stays owed
  await $.tool.call({ tool: 'Bash', command: `python3 /p/board.py ${RUN} show --post=3 | head -1` })
  await $.tool.call({ tool: 'Bash', command: `python3 /p/board.py ${RUN} show --post=3 > /tmp/x` })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't0', reason: 'answer' })
  await clock.advance(30000)
  expect(prompts.filter(text => text.includes('addresses you')).length).toBeGreaterThan(0)
  prompts.length = 0
  // opening that post is reading it: no reminder then, and no prompt when idle
  const shown = await $.tool.call({ tool: 'Bash', command: `python3 /p/board.py ${RUN} show --post=3` })
  expect(shown.context).toBeUndefined()
  expect((await $.tool.call({ tool: 'Read', file_path: '/project/a.ts' })).context).toBeUndefined()
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  await clock.advance(30000)
  expect(prompts.filter(text => text.includes('addresses you'))).toEqual([])
  // the run folder is deleted under the pane: the next polls are quiet and a tool call is not disturbed
  isGone = true
  await clock.advance(6000)
  const after = await $.tool.call({ tool: 'Read', file_path: '/project/a.ts' })
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
      : e.path === '/project/.swarm/current' ? 'demo-20261116-101010\n' : '',
  }))
  on('agent.list', () => ({ value: [
    { id: 'a1', description: '@parser', type: 'swarm:worker', status: 'completed' },
    { id: 'a2', description: '@lexer', type: 'swarm:worker', status: lexer },
  ] as never }))
  on('tool.call', () => ({ result: { stdout: '', stderr: '' } }))
  on('turn.complete', () => ({ text: '' }))
  on('process.run', (_, e) => {
    const [, , directory, action] = e.argv
    commands.push(`${action} ${directory}`)
    const stdout = action === 'attention' ? JSON.stringify({ items: [], members: {}, limits: {} }) : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })

  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  // the folder never reaches the output and no board call can be read off the command: the pointer names the run
  const made = await $.tool.call({ tool: 'Bash', command: 'R=$(python3 /p/board.py /project/.swarm/demo init "Demo swarm")' })
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
  const showSeq = await $.tool.call({ tool: 'mcp__swarm__board', tool_use_id: 'b1', agentId: 's1', action: 'show', member: '  ', seq: 2 } as never)
  expect(showSeq.result).toBe('shown:--post=2')
  failReady = true
  const readyErr = await $.tool.call({ tool: 'mcp__swarm__board', tool_use_id: 'b2', agentId: 's1', action: 'ready', text: 'done' } as never)
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
  const pausedCall = await $.tool.call({ tool: 'mcp__swarm__board', tool_use_id: 'b3', agentId: 's1', action: 'read' } as never)
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

test('an agent outside the roster neither joins the run by resuming nor pauses its members by spending', async ($, on) => {
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
  const reads = (agentId: string) => $.tool.call({ tool: 'Read', file_path: '/project/a.ts', agentId })

  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)
  expect((await reads('a1')).deny).toBeUndefined()

  // An unrelated agent is resumed while the run is open: it is let through, and is no member for that.
  const resumed = await $.agent.spawn({
    tool_use_id: 'again', prompt: 'Go on.', description: 'Continue previous work', subagentType: 'swarm:worker',
    provider: { plugin: 'swarm', tier: 'core' as const }, parentModel: 'sonnet', background: true, fork: false,
    resume: { agentId: 'outsider' },
  } as never)
  expect(resumed.deny).toBeUndefined()
  // Its model step would cross the budget, were it the run's: nothing is charged and no member is stopped.
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
  await $.tool.call({ tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
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
  await $.tool.call({ tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)
  expect((await $.tool.call({ tool: 'Bash', command: './test.sh', agentId: 'old' })).deny).toContain('has been retired')
  expect((await $.tool.call({ tool: 'Bash', command: './test.sh', agentId: 'new' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).toBeUndefined()
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
  await $.tool.call({ tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
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
  await $.tool.call({ tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  expect((await $.tool.call({ tool: 'Bash', command: 'echo hi', agentId: 'tm-1' })).deny).toContain('has been retired')

  // Coordinator replace immediately syncs retired and attaches zombie notice when w-1 is waiting.
  const rep = await $.tool.call({ tool: 'Bash', command: `python3 /p/board.py "${OWNED}" replace worker worker-2` })
  expect(rep.context?.join('\n')).toContain('@worker was retired, but agent w-1 is still waiting')
  expect((await $.tool.call({ tool: 'Bash', command: 'echo hi', agentId: 'w-1' })).deny).toContain('has been retired')
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
  await $.tool.call({ tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })

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
  await $.tool.call({
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
  await $.tool.call({ tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)

  // File edit guards inside cwd
  expect((await $.tool.call({ tool: 'Edit', file_path: '/project/.swarm/r/board.jsonl', old_string: 'a', new_string: 'b', agentId: 'alice-1' })).deny).toContain('.swarm/')
  expect((await $.tool.call({ tool: 'Write', file_path: '/project/src/alice/a.ts', content: 'x', agentId: 'ver-1' })).deny).toContain('read-only')
  expect((await $.tool.call({ tool: 'Edit', file_path: '/project/src/bob/b.ts', old_string: 'a', new_string: 'b', agentId: 'alice-1' })).deny).toContain('claimed by @bob')
  expect((await $.tool.call({ tool: 'Edit', file_path: '/project/README.md', old_string: 'a', new_string: 'b', agentId: 'alice-1' })).deny).toContain('claimed paths')
  expect((await $.tool.call({ tool: 'Edit', file_path: '/project/src/alice/a.ts', old_string: 'a', new_string: 'b', agentId: 'alice-1' })).deny).toBeUndefined()
  // Outside cwd (/tmp and worktrees) are untouched
  expect((await $.tool.call({ tool: 'Write', file_path: '/tmp/design.html', content: '<html/>', agentId: 'ver-1' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Edit', file_path: '/worktrees/wt1/src/bob/b.ts', old_string: 'a', new_string: 'b', agentId: 'bob-1' })).deny).toBeUndefined()

  // Shared git commit guard
  for (const command of ['git -C . commit', 'cd . && git commit', 'cd /tmp/wt && git -C /project commit']) {
    expect((await $.tool.call({ tool: 'Bash', command, agentId: 'alice-1' })).deny).toContain('Shared-checkout writers')
  }
  expect((await $.tool.call({ tool: 'Bash', command: 'git commit -m "wip"', agentId: 'alice-1' })).deny).toContain('Shared-checkout writers must not run `git commit`')
  expect((await $.tool.call({ tool: 'Bash', command: 'git -C /tmp/wt commit -m "wip"', agentId: 'alice-1' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: 'cd /tmp/wt && git commit -m "wip"', agentId: 'alice-1' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: 'git commit -m "wip"', agentId: 'bob-1' })).deny).toBeUndefined()

  // Coordinator Monitor & background Bash guards
  expect((await $.tool.call({ tool: 'Monitor', command: 'tail -f log' } as never)).deny).toContain('Monitor')
  expect((await $.tool.call({ tool: 'Bash', command: 'sleep 10 && echo hi', run_in_background: true })).deny).toContain('background watcher')
  const bgOk = await $.tool.call({ tool: 'Bash', command: 'bun test', run_in_background: true })
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
  await $.tool.call({ tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)
  const bash = (command: string, agentId = 'alice-1') => $.tool.call({ tool: 'Bash', command, agentId })
  const edit = (file_path: string, agentId = 'alice-1') => $.tool.call({ tool: 'Edit', file_path, old_string: 'a', new_string: 'b', agentId })

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
  expect((await edit('/project/.claude/worktrees/bob/src/bob/b.ts', 'bob-1')).deny).toBeUndefined()
  expect((await edit('/project/.claude/worktrees/bob/src/alice/a.ts', 'bob-1')).deny).toContain('claimed by @alice')
  expect((await edit('/project/.claude/worktrees/bob/.swarm/x', 'bob-1')).deny).toContain('.swarm/')

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
  await $.tool.call({ tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  const gone = await $.tool.call({ tool: 'Bash', command: `python3 /p/board.py "${OWNED}" member parser killed=1` })
  expect(gone.context?.join('\n')).toContain('@parser was retired, but 2 processes it started are still running in its worktree: 202 (xcodebuild), 404 (zsh)')
  expect(gone.context?.join('\n')).toContain('kill 202 404')
  expect(gone.context?.join('\n')).not.toContain('303')
  // a shared writer's build cannot be attributed: said when it is replaced, and not when it is simply removed
  const removed = await $.tool.call({ tool: 'Bash', command: `python3 /p/board.py "${OWNED}" member shared killed=1` })
  expect(removed.context?.join('\n') ?? '').not.toContain('@shared was retired')
  const other = await $.tool.call({ tool: 'Bash', command: `python3 /p/board.py "${OWNED}" replace shared shared-2` })
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
        members: { quiet: hint(), asker: hint(), busy: hint(), done: hint(true) }, limits: {},
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
  const told = async () => (await $.tool.call({ tool: 'Bash', command: 'ls' })).context?.join('\n') ?? ''

  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
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
  await $.tool.call({ tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)
  const bash = (command: string) => $.tool.call({ tool: 'Bash', command, agentId: 'alice-1' })
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
  await $.tool.call({ tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)
  const edit = async (file_path: string, agentId: string) => (await $.tool.call({ tool: 'Edit', file_path, old_string: 'a', new_string: 'b', agentId })).deny
  const own = '/main/.claude/worktrees/agent-bob-1'
  // F4: beside the coordinator's worktree, under the main checkout, the roster's rules still hold
  expect(await edit(`${own}/src/bob/b.ts`, 'bob-1')).toBeUndefined()
  expect(await edit(`${own}/src/alice/a.ts`, 'bob-1')).toContain('claimed by @alice')
  expect(await edit(`${own}/README.md`, 'bob-1')).toContain('claimed paths')
  expect(await edit(`${own}/src/bob/b.ts`, 'ver-1')).toContain('read-only')
  // the main checkout itself, and any other folder, is no member's worktree
  expect(await edit('/main/src/bob/b.ts', 'bob-1')).toBeUndefined()
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
  await $.tool.call({ tool: 'Bash', command: `python3 /p/board.py "${other}" pause` })
  expect((await $.tool.call({ tool: 'Read', file_path: '/project/a.ts', agentId: 'zed-1' } as never)).deny).toBeUndefined()
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
  await $.tool.call({ tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
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
  await $.tool.call({ tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await clock.advance(2000)
  const read = async (agentId: string) => (await $.tool.call({ tool: 'Read', file_path: '/project/a.ts', agentId } as never)).deny
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
  await $.tool.call({ tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
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
  const { seen, answer, board } = owning(on, {
    board: () => posts({ agent: 'coordinator', to: [], text: 'done' }),
    read: path => (path === '/project/.swarm/current' ? 'next-20261117-101010\n' : undefined),
    roster: () => JSON.stringify({ title: 'Demo swarm', closed: isClosed, members: { coordinator: { role: 'coordinator', last_read_seq: 1 } } }),
  })
  on('process.run', (_, e) => answer(board(e)))
  on('agent.list', () => ({ value: [] }))
  on('tool.call', () => ({ result: { stdout: '', stderr: '' } }))
  mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  expect(seen.restore).toBe(OWNED)
  // text that only mentions an init, in a quoted string or a heredoc, makes no run
  const noted = await $.tool.call({ tool: 'Bash', command: `cat <<'EOF'\nR=$(python3 /p/board.py /project/.swarm/next init "Next")\nEOF\necho 'board.py x init y'` })
  expect(noted.context ?? []).toEqual([])
  // while the owned run is open, a run made in a substitution does not take the conversation from it
  await $.tool.call({ tool: 'Bash', command: 'R=$(python3 /p/board.py /project/.swarm/next init "Next")' })
  expect(seen.restore).toBe(OWNED)
  isClosed = true
  await $.tool.call({ tool: 'Bash', command: `python3 /p/board.py "${OWNED}" close` })
  // however the script is run inside the substitution
  const made = await $.tool.call({ tool: 'Bash', command: 'R=$(uv run /p/board.py /project/.swarm/next init "Next")' })
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
  const tool = (input: McpToolInputs['mcp__swarm__board']) => $.tool.call({ tool: 'mcp__swarm__board', ...input })
  const last = (action: string) => ran.findLast(one => one.args.split(' ')[0] === action)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })

  // nothing to drive before a run is made; a field an action does not take is refused before the board runs
  expect((await tool({ action: 'status' })).deny).toContain('No Swarm run is bound')
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
  expect(last('read')?.args).toBe('read coordinator --max-bytes=48000')
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
  expect((await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' })).deny).toContain('retired')
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
  await $.tool.call({ tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  ran.length = 0
  const as = (agentId: string, input: McpToolInputs['mcp__swarm__board']) => $.tool.call({ tool: 'mcp__swarm__board', agentId, ...input })

  expect((await as('alice-1', { action: 'read' })).deny).toBeUndefined()
  expect((await as('alice-1', { action: 'status' })).deny).toBeUndefined()
  const sha = 'a'.repeat(40)
  expect((await as('alice-1', { action: 'ready', text: 'Parser done.', commit: sha })).deny).toBeUndefined()
  expect((await as('des-1', { action: 'revise', text: 'fixing the spacing' })).deny).toBeUndefined()
  expect((await as('ver-1', { action: 'post', text: '@coordinator NOT VERIFIED: no candidate yet' })).deny).toBeUndefined()
  expect(ran).toEqual([
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
  const report = { items: [] as unknown[], members: {}, limits: {} }
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
  await $.tool.call({ tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'coordinator-turn', reason: 'answer' })
  await clock.advance(2000)

  const usage = { model: 'm', input_tokens: 600, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'alice-turn', reason: 'answer', agentId: 'alice-1', usage })
  // refused from its next tool call on, before any poll reads the roster
  expect((await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'alice-1' })).deny).toContain('spent its own token budget')
  expect((await $.tool.call({ tool: 'mcp__swarm__board', agentId: 'alice-1', action: 'read' })).deny).toContain('spent its own token budget')
  expect((await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'bob-1' })).deny).toBeUndefined()
  // an idle coordinator is told by a prompt, once
  await clock.advance(2000)
  await clock.advance(12_000)
  expect(seen.prompts.filter(text => text.startsWith('Swarm: Member paused\n@alice has spent its own token budget'))).toHaveLength(1)
  // a busy one with its next tool call, once
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).context ?? []).toEqual([])
  spender = 'bob'
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'bob-turn', reason: 'answer', agentId: 'bob-1', usage })
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).context?.join(' ')).toContain('@bob has spent its own token budget')
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).context?.join(' ') ?? '').not.toContain('@bob')
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
  expect((await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'alice-1' })).deny).toBeUndefined()
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
  await $.tool.call({ tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
  const [before, after] = ['a'.repeat(40), 'b'.repeat(40)]

  heads = [before, after]
  const moved = await $.tool.call({ tool: 'Bash', command: './scripts/release.sh', agentId: 'alice-1' })
  expect(reads).toEqual(['git -C /project rev-parse HEAD', 'git -C /project rev-parse HEAD'])
  expect(moved.deny).toBeUndefined()
  expect(moved.context?.join(' ')).toContain(`HEAD of the shared checkout moved from ${before.slice(0, 12)} to ${after.slice(0, 12)} during this command`)
  expect(moved.context?.join(' ')).toContain('Tell the coordinator in your report that HEAD moved')
  const told = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(told.context?.join(' ')).toContain('while @alice ran a Bash command. Another actor may have moved it')
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).context ?? []).toEqual([])
  // a command that commits and then fails is told too
  heads = [after, before]
  const failed = await $.tool.call({ tool: 'Bash', command: './commit-then-fail.sh', agentId: 'alice-1' })
  expect(failed.isError).toBe(true)
  expect(failed.context?.join(' ')).toContain('HEAD of the shared checkout moved')
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).context?.join(' ')).toContain('while @alice ran a Bash command')

  // a HEAD that stayed, a read that failed, a background command and an isolated writer change nothing
  reads.length = 0
  heads = [before, before]
  expect((await $.tool.call({ tool: 'Bash', command: 'make', agentId: 'alice-1' })).context ?? []).toEqual([])
  heads = []
  expect((await $.tool.call({ tool: 'Bash', command: 'make', agentId: 'alice-1' })).context ?? []).toEqual([])
  expect(reads).toHaveLength(3)
  reads.length = 0
  await $.tool.call({ tool: 'Bash', command: 'make', agentId: 'alice-1', run_in_background: true })
  await $.tool.call({ tool: 'Bash', command: 'make', agentId: 'bob-1' })
  expect(reads).toEqual([])
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).context ?? []).toEqual([])
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
  await $.tool.call({ tool: 'Bash', command: `python3 /p/board.py "${OWNED}" read coordinator` })
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
  const told = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(told.context?.join(' ')).toContain('The user posted #3 to the board in your name from the Swarm pane')
  expect(told.context?.join(' ')).toContain("the board's show --post=3")
  await ui.unmount()
})
