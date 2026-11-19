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
  const board = [
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
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  await clock.advance(4000)
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('addresses you from #2')
  await clock.advance(20000)
  expect(prompts.filter(text => text.includes('addresses you')).length).toBe(1)
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
      if (path === `${older}/members.json`) return JSON.stringify({ title: 'Older swarm', members: { coordinator: { role: 'coordinator', last_read_seq: 1 }, scout: { role: 'worker', id: 'gone', last_read_seq: 1 } } })
      // open, unpaused, and its member owed a mention: live in every way but being this conversation's run
      if (path === `${older}/board.jsonl`) return posts({ agent: 'scout', to: ['coordinator'], text: '@coordinator the old report' }, { agent: 'coordinator', to: ['scout'], text: '@scout go on' })
      return undefined
    },
  })
  on('fs.list', () => ({
    value: ['archive', 'junk-20261001-000000', 'older-20261101-090000', OWNED.slice(OWNED.lastIndexOf('/') + 1), '.bindings']
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
  // exact older ID and Bedrock ID pass when e.model is omitted or matches family
  state1.limits = {} as never
  expect((await $.agent.spawn({ ...base, description: '@exact: test' })).agentId).toBe('id-2')
  expect(spawned.at(-1)?.model).toBe('claude-opus-4-6')
  expect((await $.agent.spawn({ ...base, description: '@bedrock: test', model: 'opus' })).agentId).toBe('id-3')
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
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
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
