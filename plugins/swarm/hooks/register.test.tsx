import { expect, mock, test } from 'claude-code/testing'

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
      expect(String(badge?.props.source)).toContain('dur="4s"')
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
  await ui.press({ key: 'tab-graph' })
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
  roster.paused = 'waiting for the user'
  await clock.advance(40000)
  expect(prompts.length).toBe(1)
  roster.closed = true
  await clock.advance(40000)
  expect(prompts.length).toBe(1)
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
    if (isTooLong && args.includes('read') && !args.includes('--headers')) {
      return { value: { exitCode: 1, stdout: '', stderr: 'post #3 exceeds the read page. Ask the coordinator.', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return {
      value: { exitCode: 0, stdout: restored ? directory : 'ok', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  mock.clock(on)
  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  const call = { tool: 'mcp__swarm__board' as const, agentId: 'scout-address' }
  expect((await $.tool.call({ ...call, action: 'read' })).deny).toBeUndefined()
  // One post longer than a page does not block the specialist: it is read as headers, and told how to open the post.
  isTooLong = true
  const paged = await $.tool.call({ ...call, action: 'read' })
  expect(String(paged.result)).toContain('too long to show whole')
  expect(processed.at(-1)?.args).toContain('--headers')
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
  await ui.press({ key: 'attention-open-0' })
  expect(await ui.find({ type: 'Markdown', text: /Details for the next pass/ })).toBeDefined()
  // the coordinator is asked to recover an unreachable member with its brief and history
  await ui.press({ key: 'tab-attention' })
  await ui.press({ key: 'attention-recover-1' })
  expect(prompts.at(-1)).toContain('replace command')

  // members: the plan (type, model, effort, ownership, order) and what each one waits for
  await ui.press({ key: 'tab-members' })
  expect(await ui.find({ type: 'Text', text: /cannot be woken/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /waiting for an answer to #3/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /waiting for @parser/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /owns date\.ts/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /sonnet medium/ })).toBeDefined()

  // tokens are counted per agent; cache reads are not; the budget pauses the run once
  const turn = { answer: '', durationMs: 1, isAborted: false, turnId: 't', agentId: 'a1', reason: 'answer' } as const
  const spend = (turnId: string) =>
    $.turn.complete({ ...turn, turnId, usage: { model: 'm', input_tokens: 477, output_tokens: 100, cache_creation_input_tokens: 23, cache_read_input_tokens: 90000 } })
  // an agent of this conversation that is no member of the run spends none of its budget
  await $.turn.complete({ ...turn, agentId: 'outsider', turnId: 'elsewhere', usage: { model: 'm', input_tokens: 5000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } })
  expect(runs.filter(run => run.startsWith('account'))).toEqual([])
  expect(state.paused).toBeUndefined()
  await spend('first')
  await clock.advance(1)
  expect(state.paused).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /600 of 1k tokens/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /600 tokens/ })).toBeDefined()
  await spend('second')
  await spend('second')
  expect(Object.values(state.usage.tokens)).toEqual([1200])
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
  await ui.press({ key: 'attention-open-0' })
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
  expect(told.context?.join(' ')).toContain('1 board post(s) address you from #2')
  expect(told.context?.join(' ')).toContain(`'${RUN}' read coordinator`)
  // once per newest unread post, not on every call
  expect((await $.tool.call({ tool: 'Read', file_path: '/project/a.ts' })).context).toBeUndefined()
  // mid-turn nothing is submitted; once the turn ends with the post still unread, one prompt is
  await clock.advance(20000)
  expect(prompts).toEqual([])
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  await clock.advance(4000)
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('address you from #2')
  await clock.advance(20000)
  expect(prompts.filter(text => text.includes('address you')).length).toBe(1)
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
