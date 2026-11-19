import { expect, test } from 'claude-code/testing'
import type { Post } from '../types'
import { BOARD_CALL, COORDINATOR_READ, RUN, boardCalls, runsNamed, splitShellSegments, wakeMessage, wakeSequence } from './command'
import { edgesOf, graphSvg, isBroadcast } from './graph'
import { toolMood, toolSummary } from './hive'
import { DEFAULT_EFFORT, DEFAULT_MODEL, SWARM_AGENTS, familyOf, latestOf } from './models'
import { statusCss, statusDot, statusKey } from './palette'
import { detailOf, findAgent, parse, statusOf, targets, tokensUsed } from './roster'
import { bodyOf, clean, clip, compact, head, kindOf, openedText, stripKind } from './text'

const post = (text: string, to: string[] = []): Post => ({ seq: 1, agent: 'parser', to, text, time: '2026-11-16T14:03:22+0100' })

test('a board command is recognised in the forms a coordinator types it', async () => {
  const run = '/project/.swarm/demo-20261116-101010'
  for (const command of [
    `python3 /p/board.py "${run}" read coordinator`,
    `python3 -B /p/board.py ${run} read coordinator`,
    `python3 '/p/board.py' '${run}/' read --all coordinator`,
  ]) {
    const match = BOARD_CALL.exec(command)
    const dir = (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').replace(/\/+$/, '')
    expect([dir, match?.[4], COORDINATOR_READ.test(command), RUN.test(dir)]).toEqual([run, 'read', true, true])
  }
  expect(COORDINATOR_READ.test('board.py DIR read --headers --max-bytes=4000 coordinator')).toBe(true)
  expect(COORDINATOR_READ.test('board.py DIR read parser')).toBe(false)
  // the board takes a name with its @
  expect(COORDINATOR_READ.test('board.py DIR read --all @coordinator')).toBe(true)
  expect(runsNamed(`a ${run} b demo-20261116-101010 .swarm/other-20261117-090000x logs/crash-20261116-143022.log`)).toEqual(['demo-20261116-101010', 'other-20261117-090000x'])
  expect(wakeSequence(wakeMessage(12))).toBe(12)
  expect(Number.isSafeInteger(wakeSequence('hello'))).toBe(false)
})

test('every member type starts on the newest model of its family', async () => {
  expect([latestOf('opus'), latestOf('haiku'), latestOf('claude-opus-4-6'), latestOf(undefined)])
    .toEqual(['claude-opus-5-5', 'claude-haiku-5-5', 'claude-opus-4-6', undefined])
  expect(familyOf('claude-fable-5-2')).toBe('fable')
  // a family name is read in any case, as familyOf reads it
  expect([latestOf('Opus'), familyOf('Opus')]).toEqual(['claude-opus-5-5', 'opus'])
  expect([DEFAULT_MODEL.verifier, DEFAULT_EFFORT.verifier]).toEqual(['claude-sonnet-5-5', 'medium'])
  for (const type of SWARM_AGENTS) expect(DEFAULT_MODEL[type.slice('swarm:'.length)]).toMatch(/^claude-/)
})

test('the hive reads a tool call by what it does, the board by its subcommand', async () => {
  expect(toolMood('Bash', 'python3 /p/board.py /r read coordinator')).toBe('inspect')
  expect(toolMood('Bash', 'python3 /p/board.py /r post coordinator "read the tests and check them"')).toBe('relay')
  expect(toolMood('Bash', 'python3 /p/verify.py /r /project test abc verifier')).toBe('verify')
  expect(toolMood('Bash', 'npm test -- parser')).toBe('verify')
  expect(toolMood('Bash', 'git status')).toBe('inspect')
  expect(toolMood('LSP')).toBe('inspect')
  expect(toolMood('Edit')).toBe('build')
  expect(toolMood('Agent')).toBe('relay')
  expect(toolMood('Other')).toBe('forage')
  // a run of calls reads as one line
  expect(toolSummary([{ tool: 'Grep' }, { tool: 'Read' }, { tool: 'Read' }, { tool: 'Edit' }, { tool: 'Bash', input: { command: 'npm test' }, isError: true },
    { tool: 'Bash', input: { command: 'python3 /p/board.py /r post parser' } }, { tool: 'SendMessage' }]))
    .toBe('Searched code, read 2 files, edited 1 file, ran 1 check, used the board, sent 1 message, 1 failed')
  expect([statusKey('unreachable'), statusKey('working'), statusKey('not started'), statusKey('killed')]).toEqual(['failed', 'working', 'inactive', 'inactive'])
})

test('board text is cleaned, labelled and cut without breaking a character', async () => {
  expect(clean('a\r\nb\rc \u001b[1;31mred\u001b[0m\u0007\u0000 \ttab')).toBe('a\nb\nc red \ttab')
  expect(kindOf('@coordinator, @parser NOT PASSED: line 4')?.label).toBe('NOT PASSED')
  expect(kindOf('@coordinator FINDING awaiting review')?.label).toBe('FINDING')
  expect(kindOf('a plain note that mentions READY later')).toBeUndefined()
  expect(bodyOf(post('@coordinator @parser done at 0123456789abcdef0123456789abcdef01234567', ['coordinator']))).toBe('done at 01234567')
  // 479 letters and one emoji: a cut inside the emoji's two halves would leave a lone surrogate
  const cut = clip(`${'a'.repeat(479)}😀${'b'.repeat(40)}`)
  expect(cut.endsWith(' …')).toBe(true)
  expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(cut)).toBe(false)
  const long = openedText(post(`${'word '.repeat(6000)}\n\n\n\n\nend`))
  expect(long.length).toBeLessThan(20_200)
  expect(long).toMatch(/more characters\. The board's `show --post=1` prints the whole post\.\)$/)
  expect(openedText(post('short\n\n\n\nbody'))).toBe('short\n\nbody')
})

test('the roster is read with its posts cleaned and its tokens summed', async () => {
  const roster = JSON.stringify({
    title: 'Demo\u0007 run', usage: { tokens: { coordinator: 10, a: 5 } }, limits: { budget: '100' },
    members: { coordinator: { role: 'coordinator', last_read_seq: 0 }, parser: { role: 'worker', profile: 'designer', effort: 'high', last_read_seq: 0 } },
  })
  const board = `${JSON.stringify({ seq: 1, agent: 'parser', text: '@coordinator hi\r\nthere', time: 't' })}\n{"seq": 2, "agent": "par`
  const shown = parse('/project/.swarm/demo-20261116-101010', board, roster, [])
  expect(shown.title).toBe('Demo run')
  expect(shown.posts.map(p => [p.seq, p.text, p.to])).toEqual([[1, '@coordinator hi\nthere', ['coordinator']]])
  expect(shown.members.find(member => member.name === 'parser')?.type).toBe('designer')
  // with no attention report the roster's own effort is shown
  expect(shown.members.find(member => member.name === 'parser')?.effort).toBe('high')
  expect([shown.budget, tokensUsed(shown.tokens)]).toEqual([100, 15])
  // a member that has not started is drawn with one class, not two
  const svg = graphSvg(shown, 1, new Set(), false, true)
  expect(svg).not.toMatch(/class="presence not started"/)
})

test('multi-segment board calls, wakeSequence bounds, and roster status/closed-run guards', async () => {
  const falseRead = boardCalls('python3 /p/board.py /project/.swarm/demo-20261116-101010 read parser && echo "read coordinator"')
  expect(falseRead.length).toBe(1)
  expect(COORDINATOR_READ.test(falseRead[0]!.rest)).toBe(false)

  const chained = boardCalls('cd /project && VAR=1 python3.12 -X utf8 /p/board.py ./.swarm/demo-20261116-101010 read "Coordinator" && python3 board.py $RUN pause')
  expect(chained.map(c => [c.dir, c.action])).toEqual([['./.swarm/demo-20261116-101010', 'read'], ['$RUN', 'pause']])
  expect(COORDINATOR_READ.test(chained[0]!.rest)).toBe(true)
  expect(RUN.test('.swarm/demo-20261116-101010')).toBe(true)

  expect(wakeSequence(`  ${wakeMessage(7)}\n`)).toBe(7)
  expect(Number.isSafeInteger(wakeSequence(wakeMessage(0)))).toBe(false)

  const agents = [
    { id: 'a1', teammateId: 'art@team', description: '@art', type: 'swarm:worker', status: 'killed' },
    { id: 'a2', teammateId: 'art@team', description: '@art', type: 'swarm:worker', status: 'waiting' },
  ] as never
  expect(findAgent(agents, 'art@team')?.id).toBe('a2')
  expect(statusOf('worker', { id: 'art@team', last_read_seq: 0 }, agents)).toBe('working')
  expect(detailOf('failed', { type: 'worker', model: 'sonnet', effort: 'medium', depends: [], owns: '', ready: true, blocked_on: [], asked: 0, unreachable: false }, false)).toBe('')

  const closedRoster = JSON.stringify({
    title: 'Closed', closed: true,
    members: {
      coordinator: { role: 'coordinator', last_read_seq: 0 },
      constructor: { role: 'worker', id: 'art@team', last_read_seq: 0 },
    },
  })
  const tailedBoard = `${JSON.stringify({ seq: 500, agent: 'constructor', text: 'done', time: 't' })}\n`
  const closed = parse('/project/.swarm/demo-20261116-101010', tailedBoard, closedRoster, agents, 300, {
    items: [], limits: {},
    members: { art: { type: 'worker', model: 'sonnet', effort: 'medium', depends: [], owns: '', ready: false, blocked_on: ['x'], asked: 0, unreachable: true } },
  })
  expect(closed.total).toBe(500)
  expect(closed.members.find(m => m.name === 'constructor')?.status).toBe('waiting')
  expect(closed.members.find(m => m.name === 'constructor')?.detail).toBe('')
})

test('wave 1/2 design, text, hive and palette helpers', async () => {
  expect(toolSummary([{ tool: 'Agent' }])).toBe('Started 1 agent')
  expect(toolSummary([{ tool: 'Agent' }, { tool: 'Agent' }])).toBe('Started 2 agents')

  expect(compact(999_499)).toBe('999k')
  expect(compact(999_500)).toBe('1.0M')

  expect(stripKind('BRIEF\nOwns: a.ts')).toBe('Owns: a.ts')
  expect(stripKind('NOT PASSED: line 4')).toBe('line 4')

  expect(head('a👍🏽b', 3)).toBe('a')
  expect(clean('hi\u001b]0;title\u0007\u202e\u2066there\u2069')).toBe('hithere')

  const fenced = clip(`\`\`\`ts\n${'x'.repeat(480)}\n\`\`\``)
  expect((fenced.match(/```/g) ?? []).length).toBe(2)

  expect(statusCss).toContain('@media(prefers-color-scheme:dark)')
  expect(statusDot('coordinating')).toContain('<path d="M6 1.2L10.8 6 6 10.8 1.2 6z"')
  expect(statusDot('failed')).toContain('<path d="M2.8 2.8L9.2 9.2M9.2 2.8L2.8 9.2"')
  expect(statusDot('waiting')).toContain('stroke-width="1.5"')
  expect(statusDot('inactive')).toContain('fill="none"')
})

test('wave 3 command, graph, roster, text and hive edge cases', async () => {
  // multi-space separator between action and subarg preserves full action in rest
  const multiSpace = boardCalls('python3 /p/board.py /project/.swarm/demo-20261116-101010 read   coordinator')
  expect(multiSpace[0]?.rest).toBe('read   coordinator')
  expect(COORDINATOR_READ.test(multiSpace[0]!.rest)).toBe(true)
  // a run folder ending in a letter is not taken for part of the subcommand
  expect(boardCalls('python3 /p/board.py /project/.swarm/demo-20261116-101010x show --post=3')[0]?.rest).toBe('show --post=3')
  expect(boardCalls('python3 /p/board.py /tmp/rundir show')[0]?.rest).toBe('show')
  expect(boardCalls('python3 /p/board.py /tmp/rundir read\t "@coordinator"')[0]?.rest).toBe('read\t "@coordinator"')

  // splitShellSegments splits on single pipe | while ignoring || and >|
  expect(splitShellSegments('python3 board.py /r show | head -n 5 && echo a >| out || true')).toEqual([
    'python3 board.py /r show',
    'head -n 5',
    'echo a >| out',
    'true',
  ])
  expect(boardCalls('echo hi | python3 /p/board.py /project/.swarm/demo-20261116-101010 read coordinator').map(c => c.action)).toEqual(['read'])

  // runsNamed matches inside backticks and parentheses
  expect(runsNamed('Run `python3 board.py /project/.swarm/backtick-20261116-101010 read a` or (.swarm/paren-20261116-101011)')).toEqual([
    'backtick-20261116-101010',
    'paren-20261116-101011',
  ])

  // graph.ts stripCode strips multi-backtick inline spans like ``@all``
  expect(isBroadcast(post('Note about ``@all`` in code', ['coordinator']))).toBe(false)
  expect(edgesOf([post('Note about ``@all`` in code', ['coordinator'])])).toEqual({ 'parser>coordinator': 1 })

  // roster.ts targets() ignores @mentions inside code blocks, inline code, and URLs
  const roster = {
    coordinator: { role: 'coordinator', last_read_seq: 0 },
    parser: { role: 'worker', last_read_seq: 0 },
    all: { role: 'worker', last_read_seq: 0 },
  }
  expect(targets('See https://github.com/@parser and ``@all`` or ```\n@coordinator\n```', roster)).toEqual([])

  // stripKind handles optional leading @mention tokens, bodyOf preserves line 2 indentation, clip tracks tilde/4-backtick fences
  expect(stripKind('@coordinator, @parser READY: all good')).toBe('all good')
  expect(bodyOf(post('@coordinator\n  indented line', ['coordinator']))).toBe('  indented line')
  const tildeClip = clip(`~~~py\n${'x'.repeat(480)}\n~~~`)
  expect(tildeClip.endsWith('\n~~~\n…')).toBe(true)
  const inlineTicks = clip(`Here is \`\`\`inline\`\`\` text ${'x'.repeat(480)}`)
  expect(inlineTicks.endsWith(' …')).toBe(true)

  // toolMood handles quoted board.py paths and run dirs with spaces via boardCalls
  expect(toolMood('Bash', 'python3 "/path with spaces/board.py" "/my project/.swarm/demo-20261116-101010" read coordinator')).toBe('inspect')
  expect(toolMood('Bash', 'python3 "/path with spaces/board.py" "/my project/.swarm/demo-20261116-101010" post coordinator')).toBe('relay')
})

test('heredoc bodies, escaped board.py paths, and zombie retired-running attention', () => {
  // Heredoc bodies with apostrophes and && / ; must not split segments or corrupt quote tracking
  const withHeredoc = [
    "python3 /p/board.py /repo/.swarm/r-20261116-101010 post parser <<'EOF'",
    "don't split && git commit -m 'nope'",
    'EOF',
    'echo after',
  ].join('\n')
  const segs = splitShellSegments(withHeredoc)
  expect(segs).toEqual([
    "python3 /p/board.py /repo/.swarm/r-20261116-101010 post parser <<'EOF'",
    'echo after',
  ])
  expect(boardCalls(withHeredoc).map(c => c.action)).toEqual(['post'])

  // Escaped spaces in unquoted board.py path
  const escaped = boardCalls('python3 /my\\ path/board.py /repo/.swarm/r-20261116-101010 member parser')
  expect(escaped).toHaveLength(1)
  expect(escaped[0]?.action).toBe('member')
  expect(escaped[0]?.subarg).toBe('parser')
  for (const name of ['release-docs-2', '"@RELEASE-docs-2"', "'release-docs-2'"]) {
    expect(boardCalls('python3 board.py run replace ' + name + ' next')[0]?.subarg).toBe('release-docs-2')
  }

  // Zombie retired-running attention & detail in roster.parse()
  const rosterJson = JSON.stringify({
    title: 'Demo',
    members: {
      coordinator: { role: 'coordinator', last_read_seq: 0 },
      parser: { role: 'worker', id: 'old-1', killed: '1', paths: 'src/a.ts', isolated: '0', last_read_seq: 0 },
    },
  })
  const parsed = parse(
    '/repo/.swarm/r-20261116-101010',
    '',
    rosterJson,
    [{ id: 'old-1', description: '@parser', type: 'swarm:worker', status: 'waiting' }] as never,
  )
  const parser = parsed.members.find(m => m.name === 'parser')!
  expect(parser.status).toBe('killed')
  expect(parser.detail).toBe('still waiting (old-1)')
  expect(parsed.attention).toContainEqual({
    kind: 'retired-running',
    member: 'parser',
    seq: 0,
    text: '@parser was retired, but agent old-1 is still waiting. Stop it before reusing its files.',
  })
})
