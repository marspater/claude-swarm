import { expect, test } from 'claude-code/testing'
import type { Post } from '../types'
import { BOARD_CALL, COORDINATOR_READ, RUN, boardCalls, runsNamed, scanShell, shellWords, splitShellSegments, substitutions, unwrap, wakeMessage, wakeSequence } from './command'
import { edgesOf, graphSvg, isBroadcast } from './graph'
import { hiveArt, toolMood, toolSummary } from './hive'
import { DEFAULT_EFFORT, DEFAULT_MODEL, SWARM_AGENTS, familyOf, latestOf } from './models'
import { statusCss, statusDot, statusKey } from './palette'
import { budgetOf, detailOf, findAgent, mentions, parse, parsePosts, statusOf, targets, tokensUsed } from './roster'
import { bodyOf, chipped, clean, clip, compact, fenceAfter, hasQuestion, head, kindOf, openedText, stripKind, unquoted } from './text'

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
    members: { constructor: { type: 'worker', model: 'sonnet', effort: 'medium', depends: [], owns: '', ready: false, blocked_on: ['x'], asked: 0, unreachable: true } },
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

test('shell splitting: here-strings, arithmetic, comments, background, piped, trailing period', () => {
  expect(splitShellSegments('cat <<< "x"\ngit commit -m wip')).toEqual(['cat <<< "x"', 'git commit -m wip'])
  expect(splitShellSegments('echo $((1<<4))\ngit commit -m wip')).toEqual(['echo $((1<<4))', 'git commit -m wip'])
  expect(splitShellSegments("# don't push yet\ngit add -A\ngit commit -m wip")).toEqual(['git add -A', 'git commit -m wip'])
  expect(splitShellSegments('git add -A # note; git push\ngit commit -m wip')).toEqual(['git add -A', 'git commit -m wip'])
  expect(splitShellSegments('echo $# ${#x} a#b')).toEqual(['echo $# ${#x} a#b'])
  expect(splitShellSegments('sleep 1 & git push')).toEqual(['sleep 1', 'git push'])
  expect(splitShellSegments('a >&2; b 2>&1; c &> f; d <&3; e |& f')).toEqual(['a >&2', 'b 2>&1', 'c &> f', 'd <&3', 'e', 'f'])

  const call = (c: string) => boardCalls(`python3 board.py /r/.swarm/x-20261116-101010 ${c}`)[0]?.piped
  expect(call('show | tail -1')).toBe(true)
  expect(call('show')).toBe(false)
  expect(call('show || true')).toBe(false)
  expect(call('show > out.txt')).toBe(true)
  expect(call('show >> out.txt')).toBe(true)
  expect(call('show 1> out.txt')).toBe(true)
  expect(call('show &> out.txt')).toBe(true)
  expect(call('show 2> err.txt')).toBe(false)
  expect(call('show 2>&1')).toBe(false)
  expect(call('show >& out.txt')).toBe(true)
  expect(call('show >&out.txt')).toBe(true)
  expect(call('show 1>&-')).toBe(true)
  expect(call('show >&2')).toBe(false)
  expect(scanShell('a && b || c; d | e & f').map(s => s.next)).toEqual(['&&', '||', ';', '|', '&', ''])

  expect(runsNamed('see .swarm/demo-20261116-101010.')).toEqual(['demo-20261116-101010'])
  expect(runsNamed('see .swarm/demo-20261116-101010.log')).toEqual([])
})

// The tests below are named for the findings of the 2026-11-21 bug analysis they pin.

test('F1: a board command of repeated escapes is refused in linear time', () => {
  const started = Date.now()
  for (const n of [200, 2000]) {
    expect(BOARD_CALL.exec('python3 board.py ' + '\\a'.repeat(n))).toBeNull()
    expect(BOARD_CALL.exec('python3 ' + '\\a'.repeat(n) + ' x y')).toBeNull()
    expect(boardCalls('python3 -c ' + '\\a'.repeat(n))).toEqual([])
  }
  expect(Date.now() - started).toBeLessThan(500)
})

test('F2: the shell scanner reads arithmetic, $\'…\' quoting, substitutions and joined heredoc delimiters', () => {
  // (( … )) is arithmetic: its << is a shift, not a heredoc that swallows the next line
  expect(splitShellSegments('(( 1 << 4 ))\ngit commit -m wip')).toEqual(['(( 1 << 4 ))', 'git commit -m wip'])
  expect(splitShellSegments('for ((i=0; i<3; i++)); do echo $i; done')).toEqual(['for ((i=0; i<3; i++))', 'do echo $i', 'done'])
  // \' inside $'…' does not end the string
  expect(splitShellSegments("echo $'\\'' && git commit -m wip")).toEqual(["echo $'\\''", 'git commit -m wip'])
  expect(splitShellSegments("echo $'a\\'b; c' ; git commit")).toEqual(["echo $'a\\'b; c'", 'git commit'])
  // a substitution stays whole in its statement, quotes inside it and all, and its commands are listed with it
  const quoted = scanShell('echo "$(cd /x && git commit -m "a; b")" && echo done')
  expect(quoted.map(s => s.text)).toEqual(['echo "$(cd /x && git commit -m "a; b")"', 'echo done'])
  expect(quoted[0]?.inner).toEqual(['cd /x && git commit -m "a; b"'])
  expect(quoted[0]?.plain).toBe('echo "_"')
  expect(scanShell('x=`git commit -m wip`')[0]?.inner).toEqual(['git commit -m wip'])
  expect(scanShell('echo $((1 + $(git commit -m wip)))')[0]?.inner).toEqual(['git commit -m wip'])
  expect(scanShell('diff <(git commit -m wip) b')[0]?.inner).toEqual(['git commit -m wip'])
  expect(scanShell('echo $(echo $(git commit))')[0]?.inner).toEqual(['echo $(git commit)'])
  expect(scanShell("echo '$(git commit)'")[0]?.inner).toBeUndefined()
  // a heredoc delimiter is one word: its quoted and bare pieces join
  for (const opener of ["<<'EO'F", "<<E'O'F", '<<""EOF', '<<\\EOF', '<<-EOF']) {
    expect(splitShellSegments(`cat ${opener}\nx && git commit -m wip\nEOF\necho after`), opener).toEqual([`cat ${opener}`, 'echo after'])
  }
  // what stands before a command, and the words of it as the shell runs them
  expect(unwrap('if ! env -u X git commit')).toEqual({ text: 'git commit', negated: true })
  expect(shellWords(`"git" \\commit -m 'a b' $'c\\'d' e\\ f`)).toEqual(['git', 'commit', '-m', 'a b', "c'd", 'e f'])
  // a board call inside a substitution is not a top-level call, and is found where the fallback looks for it
  const made = 'R=$(python3 /p/board.py /project/.swarm/demo init "Demo swarm")'
  expect(boardCalls(made)).toEqual([])
  expect(substitutions(made)).toEqual(['python3 /p/board.py /project/.swarm/demo init "Demo swarm"'])
  expect(substitutions('echo $(echo `uv run board.py x init y`)')).toEqual(['echo `uv run board.py x init y`', 'uv run board.py x init y'])
  expect(substitutions("cat <<'EOF'\nR=$(board.py x init y)\nEOF\necho 'R=$(board.py x init y)'")).toEqual([])
})

test('F16: board calls are recognised quoted, wrapped, flagged and run directly, and python -c is none', () => {
  const run = '/project/.swarm/demo-20261116-101010'
  for (const [command, action] of [
    [`python3 "board.py" ${run} read coordinator`, 'read'],
    [`python3 'board.py' ${run} read coordinator`, 'read'],
    [`python3 /p/board.py ${run} pause>/dev/null`, 'pause'],
    [`python3 /p/board.py ${run} resume;`, 'resume'],
    [`python3 /p/board.py /project/.swarm agent-run key id`, 'agent-run'],
    [`python3 -Xutf8 /p/board.py ${run} status`, 'status'],
    [`python3 -B -- /p/board.py ${run} status`, 'status'],
    [`env PYTHONUTF8=1 python3 /p/board.py ${run} plan`, 'plan'],
    [`nohup python3 /p/board.py ${run} wake`, 'wake'],
    [`( python3 /p/board.py ${run} show )`, 'show'],
    [`if python3 /p/board.py ${run} status; then echo ok; fi`, 'status'],
    [`./board.py ${run} read coordinator`, 'read'],
    [`/p/board.py ${run} read coordinator`, 'read'],
  ] as const) {
    expect(boardCalls(command).map(c => c.action), command).toEqual([action])
  }
  expect(boardCalls(`python3 -c "a/board.py" ${run} read coordinator`)).toEqual([])
  expect(boardCalls(`python3 -m "a/board.py" ${run} read coordinator`)).toEqual([])
  expect(boardCalls(`cat /p/board.py ${run} read coordinator`)).toEqual([])
  expect(COORDINATOR_READ.test('read "--all" coordinator')).toBe(true)
  // the member `show` names: a flag or a redirection names none
  const shown = (c: string) => boardCalls(`python3 /p/board.py ${run} ${c}`)[0]?.subarg
  expect([shown('show 2>&1'), shown('show --post=3'), shown('show @Parser 2>&1'), shown('show')]).toEqual([undefined, undefined, 'parser', undefined])
  expect(COORDINATOR_READ.test("read '--max-bytes=4000' --headers coordinator>out")).toBe(true)
  expect(COORDINATOR_READ.test('read --all coordinators')).toBe(false)
})

test('F17: only stdout sent away from the tool result counts as piped', () => {
  const call = (c: string) => boardCalls(`python3 board.py /r/.swarm/x-20261116-101010 ${c}`)[0]?.piped
  expect([call('show >&1.log'), call('show 1>&3'), call('show >&3')]).toEqual([true, true, true])
  expect([call('show 10>out'), call('show <>in'), call('show >&1'), call('show 1>&2'), call('show 2>out')]).toEqual([false, false, false, false, false])
})

test('F18: a member whose agent was killed is stopped, not retired, and a newer failure is not hidden by an older idle agent', () => {
  const agents = [
    { id: 'a1', description: '@art', type: 'swarm:worker', status: 'idle' },
    { id: 'a1', description: '@art', type: 'swarm:worker', status: 'failed' },
  ] as never
  expect(findAgent(agents, 'a1')?.status).toBe('failed')
  expect(statusOf('worker', { id: 'a1', last_read_seq: 0 }, agents)).toBe('failed')
  const killed = [{ id: 'k1', description: '@art', type: 'swarm:worker', status: 'killed' }] as never
  expect(statusOf('worker', { id: 'k1', last_read_seq: 0 }, killed)).toBe('stopped')
  expect([detailOf('stopped', undefined, false), statusKey('stopped')]).toEqual(['its agent was stopped', 'failed'])
  expect(statusOf('worker', { id: 'k1', killed: '1', last_read_seq: 0 }, killed)).toBe('killed')
  const roster = JSON.stringify({ title: 'T', members: { coordinator: { role: 'coordinator', last_read_seq: 0 }, art: { role: 'worker', id: 'k1', last_read_seq: 0 } } })
  const hint = { type: 'worker', model: 'sonnet', effort: 'medium', depends: [], owns: '', ready: false, blocked_on: [], asked: 0, unreachable: true }
  const shown = parse('/p/.swarm/x-20261116-101010', '', roster, killed, 300, { items: [], limits: {}, members: { art: hint } })
  expect(shown.members.find(m => m.name === 'art')?.status).toBe('unreachable')
})

test('F19: a malformed roster, token count or report draws what it can, and no limit keeps no post', () => {
  expect(tokensUsed(null)).toBe(0)
  expect(tokensUsed({ a: '5', b: NaN, c: 3, d: -2, e: null } as never)).toBe(8)
  expect([budgetOf({ limits: { budget: '-100' } }), budgetOf({ limits: { budget: 'Infinity' } }), budgetOf({ limits: { budget: 'x' } }), budgetOf({ limits: { budget: '100' } })]).toEqual([0, 0, 0, 100])
  const empty = parse('/p/.swarm/x-20261116-101010', '', '{}', [])
  expect([empty.title, empty.members, empty.posts]).toEqual(['', [], []])
  const roster = JSON.stringify({ title: 'T', usage: { tokens: { a: '7', b: 'x' } }, members: { coordinator: { role: 'coordinator', last_read_seq: 0 }, bad: null, art: { role: 'worker', last_read_seq: 0 } } })
  const board = [1, 2, 3].map(seq => JSON.stringify({ seq, agent: 'art', text: '@coordinator hi', time: 't' })).join('\n') + '\nnull\n'
  const none = parse('/p/.swarm/x-20261116-101010', board, roster, [], 0, { items: [], limits: {}, members: { art: { type: 'worker' } } } as never)
  expect(none.posts).toEqual([])
  expect(none.earlierEdges).toEqual({ 'art>coordinator': 3 })
  expect(none.members.map(m => m.name)).toEqual(['coordinator', 'art'])
  expect(none.tokens).toEqual({ a: 7, b: 0 })
  expect(parse('/p/.swarm/x-20261116-101010', board, roster, [], 2).posts.map(p => p.seq)).toEqual([2, 3])
  expect(detailOf('waiting', { type: 'worker' } as never, false)).toBe('')
})

test('F21: a kind word on line two stays in the body, as the board reads it', () => {
  const second = post('@parser\nNOT PASSED: line 4 fails', ['parser'])
  expect(kindOf(second.text)).toBeUndefined()
  expect(chipped(second)).toBe('NOT PASSED: line 4 fails')
  const first = post('@parser NOT PASSED: line 4 fails', ['parser'])
  expect([kindOf(first.text)?.label, chipped(first)]).toEqual(['NOT PASSED', 'line 4 fails'])
  expect(chipped(first, openedText(first))).toBe('line 4 fails')
})

test('F22: a line of ```code``` opens no fence, and a cut inside a fence closes it before the footer', () => {
  expect(fenceAfter(null, '```foo```')).toBeNull()
  expect(fenceAfter(null, '```ts')).toEqual({ ch: '`', len: 3 })
  expect(fenceAfter({ ch: '`', len: 4 }, '```')).toEqual({ ch: '`', len: 4 })
  expect(fenceAfter({ ch: '`', len: 3 }, '````')).toBeNull()
  expect(clip(`\`\`\`foo\`\`\` and ${'word '.repeat(120)}`).endsWith(' …')).toBe(true)
  const long = openedText(post(`intro\n\`\`\`ts\n${'x = 1\n'.repeat(5000)}\`\`\`\nend`))
  expect(long).toMatch(/\n```\n…\n\n\(\d+ more characters\./)
  expect((long.match(/^```/gm) ?? []).length).toBe(2)
})

test('code and URLs carry no mention: longer fences, tilde fences, and a span between two words', () => {
  const roster = { coordinator: { role: 'coordinator', last_read_seq: 0 }, parser: { role: 'worker', last_read_seq: 0 }, lexer: { role: 'worker', last_read_seq: 0 } }
  expect(targets('````\n```\n@parser\n```\n````\n@lexer', roster)).toEqual(['lexer'])
  expect(targets('~~~\n@parser\n~~~\n@lexer', roster)).toEqual(['lexer'])
  expect(targets('a ~~~ b @parser', roster)).toEqual(['parser'])
  // the span is replaced by a space, as board.py replaces it: the words on either side stay apart
  expect(targets('foo`x`@parser', roster)).toEqual(['parser'])
  expect(unquoted('see https://x.dev/@parser, then')).toBe('see  , then')
  expect([...mentions('@All and `@lexer` and @parser-')]).toEqual(['all', 'parser-', 'parser'])
  // an @all that reached nobody is an @all post, not a post with no mention
  expect(edgesOf([post('@all anyone here', [])])).toEqual({ 'parser>@all': 1 })
  expect(edgesOf([post('just a note', [])])).toEqual({ 'parser>@none': 1 })
})

test('the hive reads a lookup by its command, and draws whatever mood and time it is given', () => {
  expect(toolMood('Bash', 'git diff skills/swarm/scripts/board.py HEAD main')).toBe('inspect')
  expect(toolMood('Bash', 'cat test.py')).toBe('inspect')
  expect(toolMood('Bash', 'grep -n check src')).toBe('inspect')
  expect(toolMood('Bash', 'vim scripts/board.py notes later')).toBe('build')
  expect(toolMood('Bash', '$PY "$S"/board.py "$RUN" post coordinator hi')).toBe('relay')
  for (const elapsed of [-5, NaN, Infinity, 12.7]) {
    const art = hiveArt('forage', elapsed)
    expect(art).not.toMatch(/NaN|Infinity|--\d|\d\.\d+ms/)
  }
  expect(hiveArt('unknown' as never)).toBe(hiveArt('sleep'))
  expect(graphSvg({ title: 'T', dir: 'd', isClosed: false, posts: [post('@coordinator hi', ['coordinator'])], members: [], attention: [], budget: 0, tokens: {} }, 1, new Set(), true, true, true, NaN)).not.toContain('NaN')
})

test('@verifiers reaches every live verifier and @dependents whoever waits for the sender, as board.py reads them', () => {
  const roster = {
    coordinator: { role: 'coordinator', last_read_seq: 0 },
    parser: { role: 'worker', last_read_seq: 0 },
    lexer: { role: 'worker', depends: 'parser', last_read_seq: 0 },
    docs: { role: 'worker', depends: 'lexer,parser', last_read_seq: 0 },
    ver: { role: 'verifier', last_read_seq: 0 },
    old: { role: 'verifier', killed: '1', last_read_seq: 0 },
  }
  expect(targets('@verifiers please look', roster, 'parser')).toEqual(['ver'])
  expect(targets('@dependents rebase on me', roster, 'parser')).toEqual(['lexer', 'docs'])
  expect(targets('@dependents rebase on me', roster, 'lexer')).toEqual(['docs'])
  // without a sender nobody depends on it; in code it is no mention at all
  expect(targets('@dependents', roster)).toEqual([])
  expect(targets('`@verifiers`', roster, 'parser')).toEqual([])
  // a board written before `to` was recorded is read with its sender
  expect(parsePosts(JSON.stringify({ seq: 1, agent: 'parser', text: '@dependents go', time: 't' }), roster)[0]?.to).toEqual(['lexer', 'docs'])
})

test('a READY keeps its commit only when it is a full id, and a member paused on its own budget says so', () => {
  const line = (revision: unknown) => JSON.stringify({ seq: 1, agent: 'parser', text: 'READY', time: 't', to: [], revision })
  expect(parsePosts(line('a'.repeat(40)), {})[0]?.revision).toBe('a'.repeat(40))
  expect(parsePosts(line('b'.repeat(64)), {})[0]?.revision).toBe('b'.repeat(64))
  for (const bad of [null, 'HEAD', 'abc123', '--output=/tmp/x', 'A'.repeat(40)]) expect('revision' in parsePosts(line(bad), {})[0]!).toBe(false)
  expect(detailOf('waiting', undefined, false, true)).toBe('its token budget is spent')
  expect(detailOf('working', undefined, true, true)).toBe('its token budget is spent')
  expect(detailOf('working', undefined, false, false)).toBe('')
  const roster = JSON.stringify({ title: 'T', members: { coordinator: { role: 'coordinator', last_read_seq: 0 }, parser: { role: 'worker', id: 'a1', paused: 'budget', last_read_seq: 0 } } })
  expect(parse('/r', '', roster, []).members.find(member => member.name === 'parser')?.detail).toBe('its token budget is spent')
  expect(hasQuestion('which file? `a ?? b`')).toBe(true)
  expect(hasQuestion('`which file?` and c ? a : b')).toBe(false)
})

// The cases board.py and these hooks must read alike, kept by the Python side in tests/parity.json. The claude kit
// reads no files and refuses a dynamic import, so only `bun test` (see bunfig.toml) checks them; anywhere else, and
// while the file is absent, the test passes with nothing checked. `kind` compares kindOf's label, '' for none.
test('the hooks read targets, quoting, questions and kinds exactly as board.py does', async () => {
  type Parity = {
    targets?: { text: string; members: Record<string, { last_read_seq?: number }>; sender?: string; expect: string[] }[]
    quoted?: { text: string; expect: string }[]
    question?: { text: string; expect: boolean }[]
    kind?: { text: string; expect: string }[]
  }
  const bun = (globalThis as { Bun?: { file: (path: string) => { exists: () => Promise<boolean>; json: () => Promise<unknown> } } }).Bun
  if (bun === undefined) return
  const file = bun.file(`${decodeURIComponent((import.meta as unknown as { url: string }).url.replace(/^file:\/\//, '').replace(/\/[^/]*$/, ''))}/../tests/parity.json`)
  if (!(await file.exists())) return
  const parity = await file.json() as Parity
  for (const one of parity.targets ?? []) {
    const members = Object.fromEntries(Object.entries(one.members).map(([name, member]) => [name, { last_read_seq: 0, ...member }]))
    expect([one.text, targets(one.text, members, one.sender ?? undefined)]).toEqual([one.text, one.expect])
  }
  for (const one of parity.quoted ?? []) expect([one.text, unquoted(one.text)]).toEqual([one.text, one.expect])
  for (const one of parity.question ?? []) expect([one.text, hasQuestion(one.text)]).toEqual([one.text, one.expect])
  for (const one of parity.kind ?? []) expect([one.text, kindOf(one.text)?.label ?? '']).toEqual([one.text, one.expect])
})

test('F23: a question mark before a long run of blanks is read in linear time', () => {
  const started = Date.now()
  expect(hasQuestion('a ?' + ' '.repeat(5000) + 'b')).toBe(true)
  expect(hasQuestion('c ?' + ' '.repeat(5000) + ': b')).toBe(false)
  expect(Date.now() - started).toBeLessThan(200)
})

test('F24: a heredoc or a case inside a substitution keeps it whole, and its commands are listed', () => {
  // an apostrophe or a `1)` in a heredoc body is text, not a quote or a close
  const hd = scanShell("x=\"$(git commit -m y; cat <<'EOF'\ndon't 1)\nEOF\n)\"\necho after")
  expect(hd.map(s => s.text)).toEqual(["x=\"$(git commit -m y; cat <<'EOF'\ndon't 1)\nEOF\n)\"", 'echo after'])
  expect(hd[0]?.inner).toEqual(["git commit -m y; cat <<'EOF'\ndon't 1)\nEOF\n"])
  expect(boardCalls("x=$(cat <<'EOF'\na 1)\npython3 board.py .swarm/r-20260101-000000 show\nEOF\n)")).toEqual([])
  // `EOF)` ends the body and the substitution, so what follows is read
  expect(splitShellSegments("x=$(cat <<'EOF'\nit's\nEOF)\ngit commit -m y")).toEqual(["x=$(cat <<'EOF'\nit's\nEOF)", 'git commit -m y'])
  // arithmetic's << is a shift, a here-string opens no body
  expect(splitShellSegments('echo $(echo $((1<<4)) <<< x)\ngit commit')).toEqual(['echo $(echo $((1<<4)) <<< x)', 'git commit'])
  // a case pattern's `)` closes nothing, and the clause's command is read through the case
  const run = (c: string) => scanShell(c).flatMap(s => [s, ...(s.inner ?? []).flatMap(body => scanShell(body))]).map(s => shellWords(unwrap(s.text).text).join(' '))
  expect(run('echo "$(case x in a) git commit -m x;; esac)" ; echo b')).toContain('git commit -m x')
  expect(run('x=$(if true; then case x in (a|b) true;; *) git commit;; esac; fi) && b')).toContain('git commit')
  expect(run('case x in *) git commit -m x ;; esac')).toEqual(['git commit -m x', 'esac'])
  expect(run('case "$v" in a) true ;; b) git commit ;; esac')).toEqual(['true', 'git commit', 'esac'])
  // `case` is a keyword only where a command starts
  expect(scanShell('x=$(echo case in a) && git commit')[0]?.inner).toEqual(['echo case in a'])
})

test('F25: a backslash-newline joins the lines, outside single quotes and comments', () => {
  expect(shellWords('git \\\ncommit -m x')).toEqual(['git', 'commit', '-m', 'x'])
  expect(shellWords('echo "a\\\nb" \'c\\\nd\' \\\\\ne')).toEqual(['echo', 'ab', 'c\\\nd', '\\', 'e'])
  expect(unwrap('if \\\n git commit').text).toBe('git commit')
  const call = boardCalls('python3 board.py .swarm/r-20260101-000000 \\\nread coordinator')
  expect(call.map(c => [c.action, c.subarg, c.rest])).toEqual([['read', 'coordinator', 'read coordinator']])
  // a comment's backslash continues nothing; a `#` the join puts inside a word starts none
  expect(splitShellSegments('echo a # note \\\ngit commit')).toEqual(['echo a', 'git commit'])
  expect(splitShellSegments('echo x\\\n#; git commit -m y')).toEqual(['echo x#', 'git commit -m y'])
})

test('F26: what a group writes goes where its close sends it', () => {
  const piped = (c: string) => scanShell(c).map(s => [s.text, s.piped])
  expect(boardCalls('{ python3 board.py DIR show; } | head')[0]?.piped).toBe(true)
  expect(boardCalls('(python3 board.py DIR show; echo) > out')[0]?.piped).toBe(true)
  expect(boardCalls('{ python3 board.py DIR show; } 2>&1; x')[0]?.piped).toBe(false)
  // a redirect inside the group sends only its own statement away
  expect(piped('(a; b > x) ; c')).toEqual([['(a', false], ['b > x)', true], ['c', false]])
  expect(piped('{ { a; } ; b; } | c')).toEqual([['{ { a', true], ['}', true], ['b', true], ['}', true], ['c', false]])
})

test('F27: a malformed attention report, the board subcommands, and a kind word after a no-break space', () => {
  const roster = JSON.stringify({ members: { a: { role: 'worker', id: 'x', last_read_seq: 0 } } })
  const shown = parse('/r', '', roster, [], 300, { items: [], limits: {}, members: { a: { owns: 123, blocked_on: 'b' } as never } })
  expect(shown.members[0]?.owns).toBe('')
  expect(toolMood('Bash', '$PY "$S"/board.py "$RUN" export')).toBe('inspect')
  expect(toolMood('Bash', '$PY "$S"/board.py "$RUN" sync parser')).toBe('relay')
  expect(toolSummary([{ tool: 'Bash', input: { command: 'git diff board.py' } }])).toBe('Ran 1 command')
  expect(toolSummary([{ tool: 'Bash', input: { command: '$PY "$S"/board.py "$RUN" export' } }])).toBe('Used the board')
  // board.py's REPORT_WORD takes blanks and tabs after a mention, so a no-break space makes no kind
  const nbsp = post('@coordinator READY all good', ['coordinator'])
  expect([kindOf(nbsp.text), chipped(nbsp)]).toEqual([undefined, ' READY all good'])
  expect(kindOf('@coordinator\tREADY')?.label).toBe('READY')
})

test('an unquoted heredoc body runs its substitutions; a quoted one is text', () => {
  expect(scanShell('cat <<EOF\n$(git commit -m x) and `git push`\nEOF\necho done')[0]?.inner).toEqual(['git commit -m x', 'git push'])
  expect(scanShell("cat <<'EOF'\n$(git commit -m x)\nEOF")[0]?.inner).toBeUndefined()
  expect(scanShell('cat <<EOF\n\\$(git commit -m x)\nEOF')[0]?.inner).toBeUndefined()
})
