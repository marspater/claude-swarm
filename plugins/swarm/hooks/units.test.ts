import { expect, test } from 'claude-code/testing'
import type { Post } from '../types'
import { BOARD_CALL, CASE_PATTERN, COORDINATOR_READ, RUN, boardCalls, closesAfter, launches, makesCommit, runsNamed, scanShell, scriptsRun, shellLaunch, shellWords, splitShellSegments, substitutions, UNREAD, unwrap, wakeMessage, wakeSequence } from './command'
import { edgesOf, graphSvg, isBroadcast } from './graph'
import { actsAsAnother, commitsInSharedCheckout, waitsOnLooseMatch } from './guard'
import { BOARD_ACTIONS, hiveArt, memberBee, toolMood, toolSummary } from './hive'
import { DEFAULT_EFFORT, DEFAULT_MODEL, SWARM_AGENTS, familyOf, latestOf, sizedEffort } from './models'
import { progressBar, semanticIcon, statusCss, statusDot, statusKey, swarmEmblem } from './palette'
import { END, budgetOf, contextState, detailOf, heldAt, isWindingDown, findAgent, ledger, mentions, parse, parsePosts, postFields, statusOf, targets, tokensUsed } from './roster'
import { bodyOf, chipped, clean, clip, compact, fenceAfter, fenced, figuresIn, hasQuestion, head, kindOf, openedText, repeatsPosts, stripKind, unquoted, verdictOf } from './text'

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
  // the wake's read asks for the attention items after the name
  expect(COORDINATOR_READ.test('board.py DIR read coordinator --attention')).toBe(true)
  expect(COORDINATOR_READ.test('board.py DIR read coordinator --max-bytes=48000 --attention')).toBe(true)
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
    items: [],
    members: { constructor: { type: 'worker', model: 'sonnet', effort: 'medium', depends: [], owns: '', ready: false, blocked_on: ['x'], asked: 0, unreachable: true } },
  })
  expect(closed.total).toBe(500)
  // a tail of a long board counts only its own posts: the board's whole-journal counts win when it gives them
  expect(closed.members.find(m => m.name === 'constructor')?.posts).toBe(1)
  const counted = parse('/project/.swarm/demo-20261116-101010', tailedBoard, closedRoster, agents, 300, {
    items: [], members: {}, sent: { constructor: 412 }, unread: { constructor: 3 },
  })
  expect(counted.members.find(m => m.name === 'constructor')).toMatchObject({ posts: 412, unread: 3 })
  expect(counted.members.find(m => m.name === 'coordinator')).toMatchObject({ posts: 0, unread: 0 })
  // a name the counts leave out is none, even one Object.prototype answers to
  const uncounted = parse('/project/.swarm/demo-20261116-101010', tailedBoard, closedRoster, agents, 300, { items: [], members: {}, sent: {}, unread: {} })
  expect(uncounted.members.find(m => m.name === 'constructor')).toMatchObject({ posts: 0, unread: 0 })
  // a closed run has no live state: no waiting, no unreachable, nothing waited for; only the last report, or none
  expect(closed.members.find(m => m.name === 'constructor')?.status).toBe('closed')
  expect(closed.members.find(m => m.name === 'constructor')?.detail).toBe('No outcome recorded')
  const sha = 'a'.repeat(40)
  const reports = [
    { seq: 1, agent: 'constructor', text: `READY ${sha}\ndone`, time: 't', revision: sha, base: 'b'.repeat(40) },
    { seq: 2, agent: 'checker', text: 'VERIFIED cand-1 abc', time: 't', partial: true, members: ['constructor', 'x\u001b[31m'] },
    { seq: 3, agent: 'constructor', text: 'READY', time: 't', base: '--output=/tmp/x' },
  ].map(post => JSON.stringify(post)).join('\n')
  const ended = parse('/project/.swarm/demo-20261116-101010', reports, JSON.stringify({
    title: 'Closed', closed: true,
    members: { coordinator: { role: 'coordinator', last_read_seq: 0 }, constructor: { role: 'worker', last_read_seq: 0 },
      checker: { role: 'verifier', last_read_seq: 0 }, old: { role: 'worker', killed: '1', last_read_seq: 0 } },
  }), [], 300)
  expect(ended.members.map(m => [m.name, m.status, m.detail])).toEqual([
    ['coordinator', 'closed', ''], ['constructor', 'closed', 'Last report: READY (#3)'],
    ['checker', 'closed', 'Last report: Partial pass of @constructor, @x (#2)'], ['old', 'killed', ''],
  ])
  // only a full commit id goes on to git's command line
  expect(ended.posts.map(post => (post as { base?: string }).base)).toEqual(['b'.repeat(40), undefined, undefined])
  expect(verdictOf(ended.posts[1]!)).toEqual({ label: 'Partial pass', color: 'warning', covered: ['constructor', 'x'] })
  expect(verdictOf({ ...ended.posts[1]!, partial: false } as never)?.label).toBe('VERIFIED')
})

test('wave 1/2 design, text, hive and palette helpers', async () => {
  expect(toolSummary([{ tool: 'Agent' }])).toBe('Started 1 agent')
  expect(toolSummary([{ tool: 'Agent' }, { tool: 'Agent' }])).toBe('Started 2 agents')

  expect(compact(999_499)).toBe('999k')
  expect(compact(999_500)).toBe('1.0M')

  expect(stripKind('BRIEF\nOwns: a.ts')).toBe('Owns: a.ts')
  expect(stripKind('NOT PASSED: line 4')).toBe('line 4')

  expect(head('a👍🏽b', 3)).toBe('a')
  // a first cluster longer than the cut leaves nothing, never half of it
  expect(head('👨‍👩‍👧‍👦abc', 3)).toBe('')

  // a report repeats the posts only when each of its sentences does: one new line among old ones is news
  const said = ['READY\nThree findings: ST1 restoreBackup loses the edition when the tension write throws.']
  expect(repeatsPosts(said, `Three findings. ${'ST1 restoreBackup loses the edition when the tension write throws. '.repeat(8)}`)).toBe(true)
  expect(repeatsPosts(said, `Three findings. ${'ST1 restoreBackup loses the edition when the tension write throws. '.repeat(8)}\nThe build now fails: TypeError in src/lexer.ts`)).toBe(false)
  expect([repeatsPosts(['READY\nparser done'], 'done'), repeatsPosts(['READY\nparser done'], 'ok.'), repeatsPosts(['READY\nparser done'], 'Build broke.')]).toEqual([true, true, false])
  // a sentence that flips the status the posts gave is news, short as it is
  const passed = ['READY\nBuild passed and the migration is safe to run.']
  expect([repeatsPosts(passed, 'Build passed.'), repeatsPosts(passed, 'Build failed.'), repeatsPosts(passed, 'The migration is not safe to run.'), repeatsPosts(passed, "The migration isn't safe.")]).toEqual([true, false, false, false])
  // a heading, a sign-off or a pointer to the post adds no news
  expect([repeatsPosts(said, `Summary\n${said[0]!.slice(6)}\nDone.`), repeatsPosts(said, 'Done. READY is on the board as #2.')]).toEqual([true, true])
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
    // a wrapper's options, valued or not, are read in linear time
    expect(unwrap('env' + ' -u -u'.repeat(n) + ' "x').text.length).toBeGreaterThan(0)
    expect(unwrap('exec' + ' -a'.repeat(n) + ' \'x').text.length).toBeGreaterThan(0)
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
  // a $'…' delimiter takes its escapes; $"…" bash and zsh read apart, and a body that never closes, are unread
  expect(splitShellSegments("cat <<$'E\\x4fF'\nx\nEOF\ngit commit -m wip")).toEqual(["cat <<$'E\\x4fF'", 'git commit -m wip'])
  expect(scanShell('cat <<$"EOF"\nx\nEOF\ngit commit -m wip')[0]?.unread).toBe(true)
  expect(scanShell('cat <<EOF\nx\nEOX\ngit commit -m wip')[0]?.unread).toBe(true)
  expect(scanShell('cat <<EOF\nx\nEOF\ngit commit -m wip')[0]?.unread).toBeUndefined()
  // a quote or an expansion inside arithmetic holds no close
  expect(splitShellSegments('echo $(( ${x:-"))"} )) ; python3 board.py DIR show')).toEqual(['echo $(( ${x:-"))"} ))', 'python3 board.py DIR show'])
  expect(boardCalls('echo $(( ${x:-"))"} )) ; python3 board.py DIR show').map(call => call.action)).toEqual(['show'])
  expect(splitShellSegments('(( x = $(echo "))") )) && git commit -m wip')).toEqual(['(( x = $(echo "))") ))', 'git commit -m wip'])
  // nested arithmetic that never closes is read again as a substitution: that must not double the work at each level
  const started = performance.now()
  for (const unit of ['$(( ', '(( $(( ', '$(( $( ', '"$(( ', '$(( `']) expect(scanShell(`echo ${unit.repeat(300)}`).length).toBeGreaterThan(0)
  expect(performance.now() - started).toBeLessThan(2000)
  // $'…' escapes read as bash and zsh both read them; a form they read apart is unread
  expect(shellWords("git $'\\x63ommit' $'\\143\\x41' $'a\\tb\\e' $'\\777'")).toEqual(['git', 'commit', 'cA', 'a\tb\x1b', '\xff'])
  for (const form of ["$'\\u0063'", "$'\\U00000063'", "$'\\cA'", "$'\\z'", "$'\\x'", "$'a\\0b'", "$'\\400'"]) {
    expect([form, shellWords(form)[0]!.includes(UNREAD)]).toEqual([form, true])
  }
  expect(shellWords(`"$"'\\x63' \\$'\\x63'`)).toEqual(['$\\x63', '$\\x63'])
  // a wrapper's option takes its value with it: the word after is the command
  for (const [wrapped, command] of [
    ['exec -a foo ./board.py DIR post bob hi', './board.py DIR post bob hi'],
    ['exec -la foo git commit', 'git commit'],
    ['exec -al foo git commit', 'foo git commit'],
    ['env -C /p -u X ./board.py DIR show', './board.py DIR show'],
    ['env -iu X git commit', 'git commit'],
    ["env -S 'a b' --chdir /p git commit", 'git commit'],
    ['env -uX git commit', 'git commit'],
    ['time -o out -f "%e s" git commit', 'git commit'],
  ]) expect([wrapped, unwrap(wrapped!).text]).toEqual([wrapped, command])
  // env's other options take their values before -S: what -S splits still runs
  expect(scriptsRun("env -u FOO -S 'python3 board.py DIR post bob hi'")).toContain('python3 board.py DIR post bob hi')
  expect(scriptsRun("env --unset FOO -C /p -S 'git commit'")).toContain('git commit')
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
    [`python3 -i /p/board.py ${run} status`, 'status'],
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
  for (const options of ['-cpass', '-Bcpass', '-B -c pass', '-mexample', '-Bmexample', '-B -m example']) {
    expect(boardCalls(`python3 ${options} board.py ${run} read coordinator`), options).toEqual([])
  }
  expect(boardCalls(`python3 -BWonce board.py ${run} read coordinator`).map(call => call.action)).toEqual(['read'])
  expect(boardCalls(`cat /p/board.py ${run} read coordinator`)).toEqual([])
  expect(COORDINATOR_READ.test('read "--all" coordinator')).toBe(true)
  // the member `show` names: a flag or a redirection names none
  const shown = (c: string) => boardCalls(`python3 /p/board.py ${run} ${c}`)[0]?.subarg
  expect([shown('show 2>&1'), shown('show --post=3'), shown('show @Parser 2>&1'), shown('show')]).toEqual([undefined, undefined, 'parser', undefined])
  expect(COORDINATOR_READ.test("read '--max-bytes=4000' --headers coordinator>out")).toBe(true)
  expect(COORDINATOR_READ.test('read --all coordinators')).toBe(false)
})

test('a grouped command in process substitution stays inside its parameter word', () => {
  const word = '${source:-<( { printf ok; } )}'
  expect(shellWords(`echo ${word} tail`)).toEqual(['echo', word, 'tail'])
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
  const shown = parse('/p/.swarm/x-20261116-101010', '', roster, killed, 300, { items: [], members: { art: hint } })
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
  const none = parse('/p/.swarm/x-20261116-101010', board, roster, [], 0, { items: [], members: { art: { type: 'worker' } } } as never)
  expect(none.posts).toEqual([])
  expect(none.earlierEdges).toEqual({ 'art>coordinator': 3 })
  expect(none.members.map(m => m.name)).toEqual(['coordinator', 'art'])
  expect(none.tokens).toEqual({ a: 7, b: 0 })
  expect(parse('/p/.swarm/x-20261116-101010', board, roster, [], 2).posts.map(p => p.seq)).toEqual([2, 3])
  // members or token counts that are no plain object make no members and no actors
  const shapeless = parse('/p/.swarm/x-20261116-101010', '', JSON.stringify({ title: 'T', usage: { tokens: 'abc' }, members: [{ role: 'worker', last_read_seq: 0 }] }), [])
  expect([shapeless.members, shapeless.tokens]).toEqual([[], {}])
  expect([tokensUsed('abc' as never), tokensUsed([5] as never)]).toEqual([0, 0])
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
  // an optional type before a default, an arrow, or `or nil` states a type and asks nothing
  expect(hasQuestion('the field is now String? = nil')).toBe(false)
  expect(hasQuestion('it maps Int? -> Bool')).toBe(false)
  expect(hasQuestion('it returns Date? or nil when unset')).toBe(false)
  expect(hasQuestion('it returns Date? null when unset')).toBe(false)
  expect(hasQuestion('may I change Date? or keep it')).toBe(true)
  // an optional type is masked only in a clause that asks nothing: one opened by may, which, is and their like still asks
  expect(hasQuestion('May I edit ListView? and its tests too.')).toBe(true)
  expect(hasQuestion('@coordinator May I edit ListView? is it outside my paths')).toBe(true)
  expect(hasQuestion('inferred String? because guid takes String?; now typed')).toBe(false)
  expect(hasQuestion('it takes Date? and returns nil')).toBe(false)
  expect(hasQuestion('@xmay ListView? and more')).toBe(false)
  // a dot inside a path ends no clause; one before a blank does
  expect(hasQuestion('Can I make src/config.ts return Config? or nil on lookup failure')).toBe(true)
  expect(hasQuestion('Can I go. The return value is Config? or nil')).toBe(false)
})

// The cases board.py and these hooks must read alike, kept by the Python side in tests/parity.json. The claude kit
// reads no files and refuses a dynamic import, so only `bun test` (see bunfig.toml) checks them; anywhere else, and
// while the file is absent, the test passes with nothing checked. `kind` compares kindOf's label, '' for none.
test('the hooks read targets, quoting, questions, kinds, board subcommands and type defaults exactly as board.py does', async () => {
  type Parity = {
    targets?: { text: string; members: Record<string, { last_read_seq?: number }>; sender?: string; expect: string[] }[]
    quoted?: { text: string; expect: string }[]
    question?: { text: string; expect: boolean }[]
    kind?: { text: string; expect: string }[]
    actions?: string[]
    defaults?: Record<string, [string, string]>
    effort?: [string, string, string][]
  }
  const bun = (globalThis as { Bun?: { file: (path: string) => { exists: () => Promise<boolean>; json: () => Promise<unknown> } } }).Bun
  if (bun === undefined) return
  const file = bun.file(`${decodeURIComponent((import.meta as unknown as { url: string }).url.replace(/^file:\/\//, '').replace(/\/[^/]*$/, ''))}/../tests/parity.json`)
  if (!(await file.exists())) return
  const parity = await file.json() as Parity
  // A kind of case this test does not read would pass unchecked: it fails instead.
  expect(Object.keys(parity).filter(kind => !['targets', 'quoted', 'question', 'kind', 'actions', 'defaults', 'effort'].includes(kind))).toEqual([])
  for (const [kind, size, expected] of parity.effort ?? []) expect([kind, size, sizedEffort(kind, size || undefined)]).toEqual([kind, size, expected])
  if (parity.actions) expect([...BOARD_ACTIONS].sort()).toEqual(parity.actions)
  for (const [type, [family, effort]] of Object.entries(parity.defaults ?? {})) {
    expect([type, familyOf(DEFAULT_MODEL[type]!), DEFAULT_EFFORT[type]]).toEqual([type, family, effort])
  }
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
  // many optional types: each clause is searched once
  const typed = Date.now()
  expect(hasQuestion('it takes Date? and '.repeat(30_000))).toBe(false)
  expect(hasQuestion('may I keep ' + 'Date? and '.repeat(30_000))).toBe(true)
  expect(Date.now() - typed).toBeLessThan(500)
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
  const shown = parse('/r', '', roster, [], 300, { items: [], members: { a: { owns: 123, blocked_on: 'b' } as never } })
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
  // an escaped backtick inside a backtick substitution nests one: the inner command is listed whole
  expect(substitutions('cat <<EOF\n`echo \\`git commit -m x\\``\nEOF')).toEqual(['echo `git commit -m x`', 'git commit -m x'])
  // what a body substitutes belongs to the statement that opened it, and each body is read as its own heredoc
  expect(scanShell('cat <<EOF; cd /tmp || exit; echo hi\n$(git commit -m x)\nEOF').map(s => s.inner)).toEqual([['git commit -m x'], undefined, undefined, undefined])
  expect(scanShell("cat <<'A' <<B\n$(git commit -m x)\nA\n$(git push)\nB")[0]?.inner).toEqual(['git push'])
  expect(scanShell("cat <<A <<'B'\n$(git commit -m x)\nA\n$(git push)\nB")[0]?.inner).toEqual(['git commit -m x'])
})

test('a case is read as patterns and arms: a pattern\'s | and ) split and close nothing, and ;; ends an arm', () => {
  const arms = (c: string) => scanShell(c).map(s => [s.text, s.next])
  expect(arms('case $x in a|b) git status ;; (c) echo commit ;& *) true ;;& esac | head')).toEqual([
    ['case $x in a|b) git status', ';;'], ['(c) echo commit', ';&'], ['*) true', ';&'], ['esac', '|'], ['head', ''],
  ])
  // an arm ended on a line of its own still ends there
  expect(arms('case $x in\n a)\n git status\n ;;\nesac')).toEqual([['case $x in', ';'], ['a)', ';'], ['git status', ';;'], ['esac', '']])
  // a subshell inside an arm is one
  expect(arms('(case x in a) (cd y) ;; esac); z').map(([text]) => text)).toEqual(['(case x in a) (cd y)', 'esac)', 'z'])
  expect(CASE_PATTERN.exec('a|"b c") git status')?.[0]).toBe('a|"b c") ')
  expect(CASE_PATTERN.exec('(*.ts) cmd')?.[0]).toBe('(*.ts) ')
})

test('a loop, an if and a case piped onward pipe what they run, and a word that only looks like their close does not', () => {
  const piped = (c: string) => scanShell(c).map(s => [s.text, s.piped])
  expect(piped('for f in a; do echo $f; done | head')).toEqual([['for f in a', true], ['do echo $f', true], ['done', true], ['head', false]])
  expect(piped('if a; then b; else c; fi > out; d')).toEqual([['if a', true], ['then b', true], ['else c', true], ['fi > out', true], ['d', false]])
  expect(piped('case x in a) b ;; esac | head').map(([, isPiped]) => isPiped)).toEqual([true, true, false])
  expect(piped('while a; do b; done 2>&1; c').map(([, isPiped]) => isPiped)).toEqual([false, false, false, false])
  expect(boardCalls('if true; then python3 board.py DIR show; fi | head')[0]?.piped).toBe(true)
  expect(boardCalls('for x in 1; do python3 board.py DIR show; done')[0]?.piped).toBe(false)
  // `done` as a word of another command closes nothing
  expect(piped('for f in a; do echo done | head; done; x').map(([, isPiped]) => isPiped)).toEqual([false, true, false, false, false])
})

test('a comment inside a substitution may hold a quote, and its commands are still listed', () => {
  expect(scanShell("x=$(echo a # it's fine\n git commit -m x)")[0]?.inner).toEqual(["echo a # it's fine\n git commit -m x"])
  expect(scanShell('x=$(echo a # (not a group\n git status) && echo b').map(s => s.text)).toEqual(['x=$(echo a # (not a group\n git status)', 'echo b'])
  // `$#`, `${#a}` and `a#b` open no comment
  expect(scanShell("x=$(echo $# ${#a} a#b 'it''s') && y")[0]?.inner).toEqual(["echo $# ${#a} a#b 'it''s'"])
  // an escaped blank is part of the word, so the `#` after it opens no comment; an escaped backslash leaves the blank real
  expect(scanShell('echo "$(git commit -m a\\ #b)"')[0]?.inner).toEqual(['git commit -m a\\ #b'])
  expect(scanShell('git commit -m a\\ #b').map(s => s.text)).toEqual(['git commit -m a\\ #b'])
  expect(scanShell('echo a\\\\ #b').map(s => s.text)).toEqual(['echo a\\\\'])
  // one that never closes is flagged: what it runs is not listed
  expect(scanShell('echo "$(git commit -m x"')[0]?.unread).toBe(true)
  expect(scanShell('echo `git status').map(s => s.unread)).toEqual([true])
  expect(scanShell('echo "$(git status)"')[0]?.unread).toBeUndefined()
})

test('a launcher\'s options are read with their values: python\'s -W, a shell\'s -o, and a program given inline or on its input', () => {
  const words = (c: string) => shellWords(c)
  expect(launches(words('python3 -Wonce /p/board.py R close'), 'board.py')).toBe('script')
  expect(launches(words('python3 -W once -X dev -B /p/board.py R close'), 'board.py')).toBe('script')
  expect(launches(words('python3 -Bc pass /p/board.py'), 'board.py')).toBe('other')
  expect(launches(words('python3 -c "exec(open(\'/p/board.py\').read())"'), 'board.py')).toBe('other')
  expect(launches(words('python3 -c "print(1)"'), 'board.py')).toBeUndefined()
  expect(launches(words('python3 -m py_compile /p/board.py'), 'board.py')).toBeUndefined()
  expect(launches(words('python3 -m runpy /p/board.py'), 'board.py')).toBe('other')
  expect(launches(words('python3 tool.py /p/board.py'), 'board.py')).toBeUndefined()
  expect(launches(words('python3'), 'board.py', 'python3 <<EOF\nboard.py\nEOF')).toBe('other')
  expect(launches(words('perl -e "system(\'board.py\')"'), 'board.py')).toBe('other')
  expect(launches(words('echo perl'), 'board.py', 'board.py')).toBeUndefined()
  expect(launches(words('bash -o pipefail'), 'board.py', 'echo board.py | bash -o pipefail')).toBe('other')
  expect(launches(words('bash -o pipefail x.sh'), 'board.py', 'board.py')).toBeUndefined()
  expect(shellLaunch(words('-o pipefail -ec "git status" _ a'))).toEqual({ code: 'git status', operands: ['_', 'a'], stdin: false })
  expect(shellLaunch(words('-O cdspell script.sh'))).toEqual({ operands: ['script.sh'], file: 'script.sh', stdin: false })
  expect(shellLaunch(words('<<< "git status"'))).toEqual({ operands: [], stdin: true, fed: 'git status' })
  expect(scriptsRun("env -S 'git commit -m x'")).toContain('git commit -m x')
})

test('the git commands that make a commit, and the options that make them make none', () => {
  for (const [sub, args] of [['commit', []], ['commit-tree', ['HEAD^{tree}']], ['merge', ['main']], ['merge', ['--continue']], ['cherry-pick', ['abc']],
    ['revert', ['HEAD']], ['am', ['x.patch']], ['rebase', ['main']], ['pull', []], ['pull', ['--rebase', '--ff-only']], ['filter-branch', []], ['subtree', ['add']]] as const) {
    expect(makesCommit(sub, args), `${sub} ${args.join(' ')}`).toBe(true)
  }
  for (const [sub, args] of [['merge', ['--abort']], ['merge', ['--no-commit', 'main']], ['cherry-pick', ['-n', 'abc']], ['cherry-pick', ['-xn', 'abc']],
    ['revert', ['--no-commit', 'HEAD']], ['am', ['--abort']], ['rebase', ['--abort']], ['pull', ['--ff-only']], ['stash', []], ['stash', ['pop']],
    ['reset', ['--hard']], ['update-ref', ['HEAD', 'abc']], ['status', []]] as const) {
    expect(makesCommit(sub, args), `${sub} ${args.join(' ')}`).toBe(false)
  }
  // a value-taking option is read with its value, in either form, and the last of two opposite options wins
  const reads = (line: string) => makesCommit(line.split(' ')[0]!, line.split(' ').slice(1))
  for (const line of ['cherry-pick -Xignore-space-change abc', 'cherry-pick -X ignore-space-change abc', 'cherry-pick -mn abc',
    'cherry-pick --strategy-option -n abc', 'cherry-pick --strategy-opt -n abc', 'cherry-pick -n --commit abc', 'revert -Sn HEAD',
    'merge --no-commit --commit --no-ff --no-edit topic', 'merge -m --no-commit topic', 'merge -n topic', 'merge -- --no-commit',
    'merge --no-commit --comm topic', 'pull --ff-only --ff', 'pull --ff-only --rebase', 'pull --ff-only -r', 'pull --ff-only --reb',
    'am --directory --abort x.patch', 'rebase --exec --abort main', 'rebase -x --abort main']) expect(reads(line), line).toBe(true)
  for (const line of ['cherry-pick -m 1 -n abc', 'cherry-pick --commit -n abc', 'merge --commit --no-commit topic', 'pull --ff --ff-only',
    'pull --ff-only --rebase=false', 'pull --rebase --ff-only --no-rebase', 'pull -X ours --ff-only', 'am --show-current-patch=diff',
    'rebase --edit-todo', 'revert -n HEAD']) expect(reads(line), line).toBe(false)
  expect(closesAfter('git commit -m "a)" ) > out')).toEqual({ text: 'git commit -m "a)"  > out', closes: 1 })
  expect(closesAfter('a=(1 2) b\\))')).toEqual({ text: 'a=(1 2) b\\)', closes: 1 })
})

test('a post keeps the fields board.py adds only in their own shape, and an except only beside a base with full ids', () => {
  const [a, b, c] = ['a', 'b', 'c'].map(ch => ch.repeat(40))
  expect(postFields({ revision: a, base: b, except: [c], partial: true, members: ['x', 3], rejects: ['y'], candidate: 'k1' }))
    .toEqual({ revision: a, base: b, except: [c], partial: true, members: ['x'], rejects: ['y'], candidate: 'k1' })
  expect(postFields({ revision: a, base: b, except: [c, '--output=x'] })).toEqual({ revision: a, base: b })
  expect(postFields({ revision: a, except: [c] })).toEqual({ revision: a })
  expect(postFields({ base: b, except: [] })).toEqual({ base: b })
  expect(postFields({ base: 'HEAD', partial: 'yes', members: 'x', candidate: 4 })).toEqual({})
  // parsePosts goes through the same check
  const line = JSON.stringify({ seq: 1, agent: 'w', text: 'READY', time: 't', to: [], revision: a, base: b, except: [c, 'x'], conflicts: {} })
  expect(parsePosts(line, {})[0]).toEqual({ seq: 1, agent: 'w', text: 'READY', time: 't', to: [], revision: a, base: b })
})

test('a turn that runs past any count keeps what its steps were charged until it ends; only an ended agent\'s turn goes', () => {
  const book = ledger(4, 1000)
  const used = { input_tokens: 100, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  // two thousand turns that all run at once, each charged one step
  for (let i = 0; i < 2000; i++) {
    expect(book.charge(`t${i}`, used, 0, `agent-${i % 3}`, i)).toBe(100)
    book.landed(book.of(`t${i}`)!, 100, 0)
  }
  // each one's end charges only what its step did not: nothing, the first turn's included
  for (let i = 0; i < 2000; i++) expect(book.charge(`t${i}`, used)).toBe(0)
  // an end counts as charged only once the board took it
  for (let i = 0; i < 2000; i++) {
    const owed = book.charge(`t${i}`, used)
    book.landed(book.of(`t${i}`)!, owed, END)
  }
  // the turns of an agent that ended are dropped only once it has been gone a while
  book.charge('live', used, 0, 'agent-0', 5000)
  book.charge('dead', used, 0, 'agent-9', 5000)
  book.prune(id => id === 'agent-0', 5500)
  expect(book.running).toBe(2)
  book.prune(id => id === 'agent-0', 6000)
  // the dead agent's turn left the running ones, and an end it still reports finds what its step was charged
  for (const turnId of ['live', 'dead']) book.landed(book.of(turnId)!, 100, 0)
  expect([book.running, book.charge('live', used), book.charge('dead', used)]).toEqual([1, 0, 0])
})

test('an ended turn the board still owes an answer for outlasts settled ones', () => {
  const book = ledger(2)
  const ten = { input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  book.charge('a', ten, 0)
  for (const turnId of ['a', 'b', 'c', 'd']) book.charge(turnId, undefined)
  expect(book.owed().map(([turnId]) => turnId)).toEqual(['a'])
})

test('a member is told of its context at 150k and a read-only one stopped at 200k, and a run winds down at 80% of its budget', () => {
  // the investigator seen live: step 14 read 147k and wrote 11k, step 20 read 195k and wrote 13k
  expect(heldAt({ input_tokens: 2, cache_creation_input_tokens: 11_332, cache_read_input_tokens: 147_269 })).toBe(158_603)
  expect([heldAt(undefined), heldAt({ input_tokens: -5, cache_read_input_tokens: Number.NaN })]).toEqual([0, 0])
  expect([0, 149_999, 150_000, 199_999, 200_000, 290_000].map(contextState)).toEqual(['ok', 'ok', 'note', 'note', 'stop', 'stop'])
  expect([isWindingDown(2_399_999, 3_000_000), isWindingDown(2_400_000, 3_000_000), isWindingDown(5, 0)]).toEqual([false, true, false])
})

test('a long unbroken token is read for questions in linear time', () => {
  // Quadratic before, as in board.py: a scheme was tried from every letter of the token.
  const started = performance.now()
  expect([unquoted(`${'x'.repeat(300_000)} is that so?`).endsWith(' is that so?'), hasQuestion(`${'x'.repeat(300_000)} is that so?`)]).toEqual([true, true])
  expect(performance.now() - started).toBeLessThan(2000)
})

test('the usage detail follows each charge: each step for itself, and at the end what the board does not hold yet', () => {
  const book = ledger()
  const step = { input_tokens: 3, output_tokens: 4, cache_creation_input_tokens: 5, cache_read_input_tokens: 100 }
  book.charge('t', step, 0)
  book.charge('t', step, 1)
  const turn = book.of('t')!
  expect(book.detail(turn, 0)).toBe('3,5,100,4')
  // the first lands, the second was never sent: the end carries the second step's and what no step reported
  book.landed(turn, 22, 0)
  book.landed(turn, 0, 1)
  const owed = book.charge('t', { input_tokens: 7, output_tokens: 8, cache_creation_input_tokens: 10, cache_read_input_tokens: 200 })
  book.held(turn, owed)
  expect([book.detail(turn, 0), book.detail(turn, END)]).toEqual(['', '4,5,100,4'])
  // a step still pending keeps its own detail, and the end leaves it out
  const late = ledger()
  late.charge('u', step, 0)
  late.charge('u', undefined)
  expect([late.detail(late.of('u')!, 0), late.detail(late.of('u')!, END)]).toEqual(['3,5,100,4', '0,0,0,0'])
})

test('a turn\'s end the board did not take stays owed under the turn\'s own report', () => {
  const book = ledger()
  const ten = { input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  expect(book.charge('t', ten)).toBe(10)
  book.held(book.of('t')!, 10)
  expect([book.owed().map(([turnId]) => turnId), book.charge('t', ten)]).toEqual([['t'], 0])
  book.landed(book.of('t')!, 10, END)
  expect([book.owed().length, book.charge('t', ten)]).toEqual([0, 0])
  // a repeated end that carries no usage leaves the pending end's detail as it was
  const twice = ledger()
  twice.charge('d', ten)
  twice.held(twice.of('d')!, 10)
  twice.charge('d', undefined)
  expect(twice.detail(twice.of('d')!, END)).toBe('10,0,0,0')
})

test('a turn\'s end charges its whole usage less what the board took and what its steps still owe, cached reads rounded once over the turn', () => {
  const cached = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 5 }
  const both = { ...cached, cache_read_input_tokens: 10 }
  // two steps of five cached reads: a charge of 1, then 0; the first write fails, so it stays pending under its own report
  const failed = ledger()
  expect([failed.charge('t', cached, 0), failed.charge('t', cached, 1)]).toEqual([1, 0])
  expect([...failed.of('t')!.pending]).toEqual([[0, 1]])
  expect(failed.charge('t', both)).toBe(0)
  // its retry lands
  failed.landed(failed.of('t')!, 1, 0)
  expect([failed.of('t')!.pending.size, failed.charge('t', both)]).toEqual([0, 0])
  // the first write lands: the end owes nothing
  const landed = ledger()
  expect(landed.charge('t', cached, 0)).toBe(1)
  landed.landed(landed.of('t')!, 1, 0)
  expect([landed.charge('t', cached, 1), landed.charge('t', both)]).toEqual([0, 0])
  // a step reported twice is charged once
  expect(landed.charge('u', cached, 0)).toBe(1)
  expect(landed.charge('u', cached, 0)).toBe(0)
  // an end that carries no usage owes what its steps reported
  const steps = ledger()
  steps.charge('w', { ...cached, input_tokens: 7 }, 0)
  steps.landed(steps.of('w')!, 8, 0)
  steps.charge('w', { ...cached, input_tokens: 3 }, 1)
  steps.landed(steps.of('w')!, 3, 1)
  expect(steps.charge('w', undefined)).toBe(0)
  // a step never sent falls to its turn's end, and a step settled twice counts once
  const unsent = ledger()
  expect(unsent.charge('x', { ...cached, input_tokens: 5 }, 0)).toBe(6)
  unsent.landed(unsent.of('x')!, 0, 0)
  unsent.landed(unsent.of('x')!, 6, 0)
  expect(unsent.charge('x', undefined)).toBe(6)
  // an end whose write failed is owed again; once it landed, it is charged once, for a turn with steps and for one with none
  const bare = ledger()
  const whole = bare.charge('v', both)
  expect(whole).toBeGreaterThan(0)
  expect(bare.charge('v', both)).toBe(whole)
  bare.held(bare.of('v')!, whole)
  bare.landed(bare.of('v')!, whole, END)
  expect(bare.charge('v', both)).toBe(0)
  // a step that reports after its turn's end was charged with the end
  expect(bare.charge('v', cached, 0)).toBe(0)
})

test('review: redirections are read whole and only where they are redirections, a squash merge commits nothing, and a runner runs the program after it', () => {
  const words = (c: string) => shellWords(c)
  // the longer operators are read first, attached or apart, and take their target with them
  for (const line of ['bash -c "git status" >> log', 'bash -c "git status" >>log', 'bash -c "git status" >| log', 'bash -c "git status" &>> log', 'bash 2>&1 -c "git status"']) {
    expect([line, shellLaunch(words(line).slice(1)).code, shellLaunch(words(line).slice(1)).operands]).toEqual([line, 'git status', []])
  }
  // a quoted program that begins with a redirection is the program, not a redirection of the shell
  expect(shellLaunch(words("bash -c '>out printf ok'").slice(1)).code).toBe('>out printf ok')
  expect(shellLaunch(words("bash -c '>out;git commit -m x'").slice(1)).code).toBe('>out;git commit -m x')
  expect(scriptsRun("bash -c '>out git commit -m x'")).toContain('>out git commit -m x')
  // a redirection whose target is quoted is still a redirection: the program after it is read
  for (const line of [`bash >'out file' -c "git commit -m x"`, `bash > "out file" -c "git commit -m x"`, `bash 2>'err log' -c "git commit -m x"`]) {
    expect([line, shellLaunch(words(line).slice(1)).code]).toEqual([line, 'git commit -m x'])
    expect(scriptsRun(line)).toContain('git commit -m x')
  }
  // and a word quoted from its start is an argument whatever it looks like, as its own text
  expect(shellLaunch(words(`bash -c '>out;git commit -m x' '>arg'`).slice(1)).operands).toEqual(['>arg'])
  expect(shellLaunch(words(`bash <<< '>out; git commit -m x'`).slice(1)).fed).toBe('>out; git commit -m x')
  expect(scriptsRun(`eval '>out; git commit -m x'`).some(script => scanShell(script).some(statement => /^git commit/.test(statement.text.trim())))).toBe(true)
  // only what feeds descriptor 0 is a program the shell may read
  expect(shellLaunch(words('bash <<< "git commit -m x"').slice(1)).fed).toBe('git commit -m x')
  expect(shellLaunch(words('bash 0<<< "git commit -m x"').slice(1)).fed).toBe('git commit -m x')
  expect(shellLaunch(words('bash 3<<< "git commit -m x" script.sh').slice(1)).fed).toBeUndefined()
  // a squash merge stages its result and commits nothing; the last of --squash and --no-squash holds
  expect(makesCommit('merge', words('--squash topic'))).toBe(false)
  expect(makesCommit('merge', words('--squash --no-squash topic'))).toBe(true)
  expect(makesCommit('merge', words('--no-squash --squash topic'))).toBe(false)
  expect(makesCommit('merge', words('topic'))).toBe(true)
  // a runner followed by another program runs that program; one whose own words come first keeps the script as run
  expect(launches(words('env grep -n close /p/board.py'), 'board.py')).toBeUndefined()
  expect(launches(words('sudo cat /p/board.py'), 'board.py')).toBeUndefined()
  expect(launches(words('env nice /p/board.py R close'), 'board.py')).toBe('script')
  expect(launches(words('env -u X /p/board.py R close'), 'board.py')).toBe('script')
  expect(launches(words('env A=1 /p/board.py R close'), 'board.py')).toBe('script')
  expect(launches(words('timeout 5 /p/board.py R close'), 'board.py')).toBe('script')
  // a compound command after a joined line is still one command, piped onward as a whole
  expect(boardCalls('if true; then \\\n  python3 /p/board.py /project/.swarm/demo-20261116-101010 read coordinator; fi | head').map(call => call.piped)).toEqual([true])
  expect(boardCalls('\\\nif true; then python3 /p/board.py /project/.swarm/demo-20261116-101010 read coordinator; fi | head').map(call => call.piped)).toEqual([true])
})

const mockGuardEngine = () => ({
  fs: {
    stat: async (path: string) => ({ realPath: path }),
    read: async () => '',
  },
  process: {
    run: async () => ({ exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }),
  },
}) as never

test('guard regressions (#1-#4): parameter-expansion quote flip, unclosed quotes, verify redirect shift, env/unlisted-runner sh -c, and attached -c', async () => {
  const $ = mockGuardEngine()

  // #1: nested quotes inside "${...}" must not flip outer quote state; unclosed quotes mark unread and fail closed
  expect(splitShellSegments('echo "${x:-"a\'b"}" && git commit -m pwn')).toEqual(['echo "${x:-"a\'b"}"', 'git commit -m pwn'])
  expect(splitShellSegments('echo "${x:-${y:-"a\'b"}}" && git commit -m pwn')).toEqual(['echo "${x:-${y:-"a\'b"}}"', 'git commit -m pwn'])
  expect(splitShellSegments('echo "$(echo "${x:-"a)b"}")" && git commit -m pwn')).toEqual(['echo "$(echo "${x:-"a)b"}")"', 'git commit -m pwn'])
  expect(scanShell('echo "${x:-$(git commit -m pwn)}"')[0]?.inner).toEqual(['git commit -m pwn'])
  expect(scanShell('echo "unclosed && git commit -m pwn')[0]?.unread).toBe(true)
  expect(scanShell("echo 'unclosed")[0]?.unread).toBe(true)
  expect(scanShell('echo "${x:-unclosed')[0]?.unread).toBe(true)
  expect(shellWords('env X="${a:-"b\'"}" git commit -m pwn')).toEqual(['env', 'X=${a:-"b\'"}', 'git', 'commit', '-m', 'pwn'])
  for (const cmd of [
    'echo "${x:-"a\'b"}" && git commit -m pwn',
    'echo "${x:-\'a}"\'}" && git commit -m pwn',
    'env X="${a:-"b\'"}" git commit -m pwn',
    'echo "unclosed && git commit -m pwn',
  ]) {
    expect(await commitsInSharedCheckout($, cmd, '/project'), cmd).toBe(true)
  }
  expect(await commitsInSharedCheckout($, 'echo "${x:-"a\'b"}" && git status', '/project')).toBe(false)

  // CR-1: single quotes inside double-quoted "${...}" are literal and do not hide $(...) / `...`, while unquoted ${...} single quotes stay literal
  expect(scanShell('printf \'%s\\n\' "${missing:-\'$(git commit -am mixed)\'}"')[0]?.inner).toEqual(['git commit -am mixed'])
  expect(scanShell('printf \'%s\\n\' "${missing:-\'`git commit -am mixed`\'}"')[0]?.inner).toEqual(['git commit -am mixed'])
  expect(scanShell('printf \'%s\\n\' ${missing:-\'$(git commit -am mixed)\'}')[0]?.inner).toBeUndefined()
  expect(await commitsInSharedCheckout($, 'printf \'%s\\n\' "${missing:-\'$(git commit -am mixed)\'}"', '/project')).toBe(true)
  expect(await commitsInSharedCheckout($, 'printf \'%s\\n\' ${missing:-\'$(git commit -am mixed)\'}', '/project')).toBe(false)

  // CR-2: process substitution inside unquoted ${...} runs and is detected, while double-quoted "<(...)" / "${v/x/<(...)}" stays literal
  expect(scanShell('v=x; printf \'%s\\n\' ${v/x/<(git commit -am mixed)}')[1]?.inner).toEqual(['git commit -am mixed'])
  expect(scanShell('printf \'%s\\n\' <(git commit -am mixed)')[0]?.inner).toEqual(['git commit -am mixed'])
  expect(scanShell('printf \'%s\\n\' "<(git commit -am mixed)"')[0]?.inner).toBeUndefined()
  expect(scanShell('v=x; printf \'%s\\n\' "${v/x/<(git commit -am mixed)}"')[1]?.inner).toBeUndefined()
  expect(await commitsInSharedCheckout($, 'v=x; printf \'%s\\n\' ${v/x/<(git commit -am mixed)}', '/project')).toBe(true)
  expect(await commitsInSharedCheckout($, 'printf \'%s\\n\' "<(git commit -am mixed)"', '/project')).toBe(false)
  expect(await commitsInSharedCheckout($, 'v=x; printf \'%s\\n\' "${v/x/<(git commit -am mixed)}"', '/project')).toBe(false)

  // CR2-1: closesAfter respects $'...' escapes so escaped apostrophes do not corrupt subshell close counts
  expect(closesAfter("echo $'a\\')'")).toEqual({ text: "echo $'a\\')'", closes: 0 })
  expect(closesAfter("echo $'a\\')')")).toEqual({ text: "echo $'a\\')'", closes: 1 })

  // CR2-2: shellWords inside double-quoted "${...}" passes inDouble=true so apostrophes stay literal
  expect(shellWords('printf "%s" "${label:-it\'s fine}" extra')).toEqual(['printf', '%s', "${label:-it's fine}", 'extra'])

  // CR3-1: escaped \$' inside ${...} or $(...) is not treated as an ANSI-C quote opener
  expect(shellWords("echo ${x:-\\$'a\\'} python board.py")).toEqual(['echo', "${x:-\\$'a\\'}", 'python', 'board.py'])
  expect(splitShellSegments("echo $(echo \\$'a\\') && git commit -m pwn")).toEqual(["echo $(echo \\$'a\\')", 'git commit -m pwn'])

  // a variable inside the word that is run fills in too: `./$S` is the script
  for (const typed of ['S=board.py; ./$S .swarm/r-20260101-000000 init T', 'S=verify; "./${S}.py" . .swarm/r-20260101-000000 accept c1']) {
    expect([typed, actsAsAnother(typed, 'parser', { role: 'worker', last_read_seq: 0 }) !== undefined]).toEqual([typed, true])
  }
  // more fillings than are tried one by one: the word is refused, not read from the first few
  const many = `for S in ${Array.from({ length: 65 }, (_, index) => `n${index}`).join(' ')} oard; do :; done; P=b; "./\${P}\${S}.py" .swarm/r-20260101-000000 init T`
  expect(actsAsAnother(many, 'parser', { role: 'worker', last_read_seq: 0 })).toBeDefined()
  // #2: verify.py redirections before operands cannot shift action index; invalid actions fail closed
  expect(actsAsAnother('python3 /p/verify.py >a 2> b .swarm/r-20260101-000000 app accept cand-1', 'parser', { role: 'worker', last_read_seq: 0 })).toContain("the coordinator's")
  expect(actsAsAnother('python3 /p/verify.py >a 2> b .swarm/r-20260101-000000 app accept cand-1', 'vera', { role: 'verifier', last_read_seq: 0 })).toContain("the coordinator's")
  expect(actsAsAnother('python3 /p/verify.py .swarm/r-20260101-000000 app unknown cand-1', 'parser', { role: 'worker', last_read_seq: 0 })).toContain('checked only when')
  expect(actsAsAnother('python3 /p/verify.py --help', 'parser', { role: 'worker', last_read_seq: 0 })).toContain('checked only when')

  // #3: unknown env flags and unlisted runners wrapping sh/bash -c commit are blocked, while safe sh -c and prose pass
  for (const cmd of [
    'env --default-signal bash -c "git commit -m pwn"',
    'flock /tmp/lk sh -c "git commit -m pwn"',
    'doas sh -c "git commit -m pwn"',
    'setsid sh -c "git commit -m pwn"',
    'ionice -c3 sh -c "git commit -m pwn"',
    'taskset -c 0 bash -c "git commit -m pwn"',
  ]) {
    expect(await commitsInSharedCheckout($, cmd, '/project'), cmd).toBe(true)
  }
  for (const cmd of [
    'flock /tmp/lk sh -c "git status"',
    'env --default-signal bash -c "git status"',
    'python3 /p/board.py DIR post alice "See git log for commit details"',
  ]) {
    expect(await commitsInSharedCheckout($, cmd, '/project'), cmd).toBe(false)
  }

  expect(await commitsInSharedCheckout($, 'git -c alias.x=commit x -m example', '/project')).toBe(true)
  expect(await commitsInSharedCheckout($, 'git -c alias.x=status x', '/project')).toBe(false)
  expect(await commitsInSharedCheckout($, 'git -calias.x=status x', '/project')).toBe(false)
  expect(await commitsInSharedCheckout($, 'git -ccolor.ui=never commit -m example', '/project')).toBe(false)
  expect(await commitsInSharedCheckout($, 'git --config-env=alias.x=GIT_ACTION x', '/project')).toBe(true)

  // heredoc delimiters, nested backticks, $'…' escapes, a body's owner and a function's body hide no commit
  for (const cmd of [
    "cat <<$'EOF'\nhello\nEOF\ngit commit -m x",
    'cat <<$"EOF"\nhello\nEOF\ngit commit -m x',
    'cat <<EOF\n`echo \\`git commit -m x\\``\nEOF',
    "git $'\\x63ommit' -m hi",
    "git $'\\U00000063'ommit -m hi",
    "$'\\U00000067'it status",
    "X=git; Y=$'\\U00000063'ommit; $X $Y",
    'cat <<EOF; cd /tmp || exit; echo hi\n$(git commit -m x)\nEOF',
    'f() if true; then cd /tmp || exit; else cd /tmp || exit; fi; git commit -m x',
    'f() while cd /tmp; do exit; done; git commit -m x',
    'f() case a in *) cd /tmp || exit;; esac; git commit -m x',
    // a redirection between git and its command is read past, and the command is still a commit
    'git >/tmp/out commit -m x',
    'git 2>/dev/null commit -m x',
    'git 2> /dev/null -C . commit -m x',
    "git '>x' status",
  ]) expect([cmd, await commitsInSharedCheckout($, cmd, '/project')]).toEqual([cmd, true])
  for (const cmd of ['git 2>/dev/null status', 'git >/tmp/out diff', 'git 2> /dev/null log', "echo $'\\cA'"]) {
    expect([cmd, await commitsInSharedCheckout($, cmd, '/project')]).toEqual([cmd, false])
  }
})

test('guard and roster regressions (#5-#8): BOARD_CALL/actsAsAnother false positives, silent read-only exclusion, and duplicate landed accounting', () => {
  // #5: python without 3, --check-hash-based-pycs, and quoted case patterns in WRAPPER
  expect(boardCalls('python /p/board.py /r/.swarm/x-20260101-000000 show').map(c => c.action)).toEqual(['show'])
  expect(boardCalls('python3 --check-hash-based-pycs always /p/board.py /r/.swarm/x-20260101-000000 show').map(c => c.action)).toEqual(['show'])
  expect(boardCalls('python3 --check-hash-based-pycs=never /p/board.py /r/.swarm/x-20260101-000000 read parser').map(c => [c.action, c.subarg])).toEqual([['read', 'parser']])
  expect(actsAsAnother('python /p/board.py DIR read parser', 'parser', { role: 'worker', last_read_seq: 0 })).toBeUndefined()
  expect(actsAsAnother('python3 --check-hash-based-pycs always /p/board.py DIR show', 'parser', { role: 'worker', last_read_seq: 0 })).toBeUndefined()
  expect(actsAsAnother('case "$x" in "a b") python3 /p/board.py DIR read parser ;; esac', 'parser', { role: 'worker', last_read_seq: 0 })).toBeUndefined()
  expect(actsAsAnother('case "$x" in ("a|b") python3 /p/board.py DIR show ;; esac', 'parser', { role: 'worker', last_read_seq: 0 })).toBeUndefined()

  // a board or verify command hidden behind a heredoc, an escape, a wrapper's value, a dynamic script or a variable is refused
  const worker = { role: 'worker' as const, last_read_seq: 0 }
  for (const cmd of [
    "cat <<$'EOF'\nhello\nEOF\npython3 board.py .swarm/run post bob hi",
    'cat <<EOF\n`echo \\`python3 board.py .swarm/run post bob hi\\``\nEOF',
    "python3 $'\\x62oard.py' .swarm/run post bob hi",
    "python3 board.py .swarm/run post $'\\x62ob' hi",
    "python3 $'\\U00000062'oard.py .swarm/run post bob hi",
    "B=$'\\U00000062'oard.py; python3 \"$B\" .swarm/run post bob hi",
    'exec -a foo ./board.py .swarm/run post bob hi',
    'exec -a foo ./verify.py .swarm/run . accept cand1',
    'env -C /path ./board.py .swarm/run post bob hi',
    "env -u FOO -S 'python3 board.py .swarm/run post bob hi'",
    'python3 "$(echo board.py)" .swarm/run post bob hi',
    'python3 $(echo board.py) .swarm/run post bob hi',
    'B=board; python3 "${B}.py" .swarm/run post bob hi',
    'B=board.py; python3 "$B" .swarm/run post bob hi; B=harmless.py',
    'declare B=board.py; python3 "$B" .swarm/run post bob hi',
    'local -r B=board.py; python3 "$B" .swarm/run post bob hi',
    'export -- B=board.py; python3 "$B" .swarm/run post bob hi',
    'for B in harmless.py board.py; do python3 "$B" .swarm/run post bob hi; done',
    'P=python3; S=board.py; $P "$S" .swarm/run post bob hi; S=x',
    // a python launched by a search that runs what it finds, or by a wrapper this does not list, is still read
    'find . -exec python3 board.py .swarm/run post bob hi \\;',
    'f() { python3 board.py .swarm/run post bob hi; }; f',
    'coproc python3 board.py .swarm/run post bob hi',
    "flock /tmp/lk python3 -c 'exec(open(\"board.py\").read())'",
    'git bisect run python3 board.py .swarm/run post bob hi',
    '/usr/bin/grep x; python3 board.py .swarm/run post bob hi',
    'grep -n x board.py && python3 board.py .swarm/run post bob hi',
  ]) expect([cmd, actsAsAnother(cmd, 'parser', worker) !== undefined]).toEqual([cmd, true])
  for (const cmd of [
    'grep -n python3 scripts/board.py',
    'git log -S python3 -- board.py',
    'git grep -e python3 board.py',
    'python3 "${CLAUDE_PLUGIN_ROOT}/skills/swarm/scripts/board.py" DIR post parser hi',
    'python3 "$R/board.py" DIR post parser hi',
    "python3 board.py DIR post $'\\x70arser' hi",
    'exec -a foo ./board.py DIR read parser',
  ]) expect([cmd, actsAsAnother(cmd, 'parser', worker)]).toEqual([cmd, undefined])

  // #6: < file before member name in board.py and --timeout 60 before operands in verify.py
  expect(actsAsAnother('python3 /p/board.py DIR ready < report.txt parser', 'parser', { role: 'worker', last_read_seq: 0 })).toBeUndefined()
  expect(actsAsAnother('python3 /p/board.py DIR ready < report.txt other', 'parser', { role: 'worker', last_read_seq: 0 })).toContain('acts only as itself')
  expect(actsAsAnother('python3 /p/verify.py DIR proj test --timeout 60 cand-1 v', 'v', { role: 'verifier', last_read_seq: 0 })).toBeUndefined()
  expect(actsAsAnother('python3 /p/verify.py DIR proj test --timeout=60 cand-1 v', 'v', { role: 'verifier', last_read_seq: 0 })).toBeUndefined()
  expect(actsAsAnother('python3 /p/verify.py DIR proj test --timeout 60 cand-1 other', 'v', { role: 'verifier', last_read_seq: 0 })).toContain('tests only as itself')

  // #7: read-only profiles (explorer, architect) and consultants (consult=1) are excluded from silent checks
  const rosterJson = JSON.stringify({
    title: 'Demo',
    members: {
      coordinator: { role: 'coordinator', last_read_seq: 1 },
      scout: { role: 'worker', profile: 'explorer', id: 's1', last_read_seq: 1 },
      arch: { role: 'worker', profile: 'architect', id: 'a1', last_read_seq: 1 },
      cons: { role: 'worker', consult: '1', id: 'c1', last_read_seq: 1 },
      dev: { role: 'worker', id: 'd1', last_read_seq: 1 },
    },
  })
  const boardJsonl = JSON.stringify({ seq: 1, agent: 'coordinator', text: '@all check in', time: 't' })
  const agents = ['s1', 'a1', 'c1', 'd1'].map(id => ({ id, description: '', type: 'swarm:worker', status: 'idle' })) as never
  const idleHint = { type: 'worker', model: 'sonnet', effort: 'medium', depends: [], owns: '', ready: false, blocked_on: [], asked: 0, unreachable: false }
  const parsed = parse('/r/.swarm/x-20260101-000000', boardJsonl, rosterJson, agents, 300, {
    items: [],
    members: { scout: idleHint, arch: idleHint, cons: idleHint, dev: idleHint },
  })
  expect(parsed.attention.filter(item => item.kind === 'silent').map(item => item.member)).toEqual(['dev'])
  // a worker the attention report says is paused on its own budget is not silent, whatever the roster says yet
  const paused = parse('/r/.swarm/x-20260101-000000', boardJsonl, rosterJson, agents, 300, { items: [], members: { dev: { ...idleHint, paused: true } } })
  expect(paused.attention.filter(item => item.kind === 'silent')).toEqual([])

  // #8: duplicate/concurrent turn.complete charge/landed calls do not double-count in-memory turn.charged
  const book = ledger()
  const whole = { input_tokens: 100, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  const part = { input_tokens: 40, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  const owed1 = book.charge('dup', whole)
  book.held(book.of('dup')!, owed1)
  const owed2 = book.charge('dup', whole)
  expect([owed1, owed2]).toEqual([100, 0])
  book.landed(book.of('dup')!, owed1, END)
  book.landed(book.of('dup')!, owed1, END)
  expect(book.of('dup')!.charged).toBe(100)
  expect(book.charge('dup', whole)).toBe(0)

  expect(book.charge('dup2', part, 0)).toBe(40)
  const rem1 = book.charge('dup2', whole)
  book.held(book.of('dup2')!, rem1)
  const rem2 = book.charge('dup2', whole)
  expect([rem1, rem2]).toEqual([60, 0])
  book.landed(book.of('dup2')!, rem1, END)
  book.landed(book.of('dup2')!, rem1, END)
  expect(book.of('dup2')!.charged).toBe(60)
  book.landed(book.of('dup2')!, 40, 0)
  expect(book.of('dup2')!.charged).toBe(100)

  // The first acknowledgment after a restart can describe a larger amount than the replay requested.
  const replayed = book.charge('replayed', part)
  book.held(book.of('replayed')!, replayed)
  book.landed(book.of('replayed')!, 100, END)
  expect(book.charge('replayed', whole)).toBe(0)
})

test('visual polish: animated emblems, progress bars, semantic icons, status dots, and graph animations', () => {
  // Swarm emblems for every state: active states animate and respect reduced motion; bad elapsed never produces NaN
  for (const state of ['working', 'coordinating', 'paused', 'attention', 'idle', 'closed'] as const) {
    for (const elapsed of [0, 350, -10, NaN]) {
      const svg = swarmEmblem(state, elapsed)
      expect(svg).toContain('viewBox="0 0 20 20"')
      expect(svg).not.toContain('NaN')
    }
  }
  expect(swarmEmblem('working', 200)).toContain('emb-ring')
  expect(swarmEmblem('working', 200)).toContain('prefers-reduced-motion:reduce')
  expect(swarmEmblem('closed')).not.toContain('emb-ring')
  expect(swarmEmblem('paused')).toContain('<rect ')

  // Progress bar clamps ratios safely, animates shimmer only when requested and wide enough
  expect(progressBar(0, 'accent', true)).not.toContain('shimmer')
  expect(progressBar(-5, 'accent')).toContain('viewBox="0 0 200 6"')
  expect(progressBar(NaN, 'warning')).not.toContain('NaN')
  expect(progressBar(0.65, 'success', true, 120)).toContain('class="shimmer"')
  expect(progressBar(1.8, 'error', false)).toContain('width="200"')

  // Semantic icons render distinct shapes across light/dark Display P3 themes
  for (const kind of ['pass', 'ready', 'warn', 'error', 'info', 'paused'] as const) {
    const icon = semanticIcon(kind)
    expect(icon).toContain('viewBox="0 0 12 12"')
    expect(icon).toContain('prefers-color-scheme:dark')
  }

  // Animated statusDot keeps safe elapsed handling and reduced-motion guards
  expect(statusDot('working', NaN)).not.toContain('NaN')
  expect(statusDot('working', 500)).toContain('sw-pulse')
  expect(statusDot('working', 500)).toContain('prefers-reduced-motion:reduce')
  expect(statusDot('coordinating', 500)).toContain('sw-aura')

  // Hive art uses smooth animations + soft radial aura when active, none when sleeping
  expect(hiveArt('build', 400)).toContain('radialGradient id="hg"')
  const asleep = hiveArt('sleep', 400)
  expect(asleep).not.toContain('radialGradient')
  expect(asleep).toContain('translate(30 8)"><path class="sleep-mark"')
  expect(asleep).toContain('translate(38 5)"><path class="sleep-mark sleep-mark-small"')
  expect(asleep).toContain('prefers-reduced-motion:no-preference')
  expect(asleep).not.toContain('prop-echo')
  expect(hiveArt('verify', 400)).toContain('var(--ok)')

  // Graph SVG emits live presence pulse & comet tail only in live repeat mode, never indefinite in replay
  const sample = {
    title: 'T', dir: '/r', isClosed: false, attention: [], budget: 0, tokens: {},
    posts: [post('@verifier READY', ['verifier'])],
    members: [
      { name: 'coordinator', role: 'coordinator', type: 'coordinator', model: 'opus', effort: 'high', status: 'coordinating', detail: '', owns: '', depends: [], posts: 0, unread: 0 },
      { name: 'parser', role: 'worker', type: 'worker', model: 'sonnet', effort: 'medium', status: 'working', detail: '', owns: '', depends: [], posts: 1, unread: 0 },
      { name: 'verifier', role: 'verifier', type: 'verifier', model: 'sonnet', effort: 'medium', status: 'waiting', detail: '', owns: '', depends: [], posts: 0, unread: 0 },
    ],
  }
  const liveGraph = graphSvg(sample, 1, new Set(), false, true, true, 250)
  expect(liveGraph).toContain('packet-tail')
  expect(liveGraph).toContain('p-ping')
  expect(liveGraph).toContain('filter id="sh"')
  expect(liveGraph).not.toContain('id="hub"')
  expect(liveGraph).not.toContain('url(#hub)')
  expect(liveGraph).not.toContain('pattern')
  expect(liveGraph).not.toContain('class="surface"')
  const replayGraph = graphSvg(sample, 1, new Set(), true, false, false, 0)
  expect(replayGraph).toContain('packet-tail')
  expect(replayGraph).not.toContain('indefinite')
  expect(replayGraph).not.toContain('p-ping')
  const remounted = graphSvg(sample, 1, new Set(), true, false, false, 370)
  expect(remounted).toContain('animateMotion begin="-370ms" dur="0.84s"')
  expect(remounted).toContain('stroke-dashoffset" from="102" to="0" begin="-370ms" dur="0.84s"')
  expect(remounted).toContain('begin="436ms" dur="0.34s"')

  // Graph SVG legend reflects @all post counts and Expand @all toggle state
  expect(graphSvg(sample, 1, new Set(), false, true, false, 0, false)).toContain('no @all posts yet')
  const withAll = { ...sample, posts: [...sample.posts, { seq: 2, agent: 'coordinator', to: ['parser', 'verifier'], text: '@all sync', time: 't' }] }
  expect(graphSvg(withAll, 2, new Set(), false, true, false, 0, false)).toContain('>@all 1<')
  expect(graphSvg(withAll, 2, new Set(), false, true, false, 0, false)).toContain('@all posts, drawn by Expand @all')
  expect(graphSvg(withAll, 2, new Set(), false, true, false, 0, true)).toContain('@all posts, drawn as dashed arrows')
  expect(graphSvg(withAll, 1, new Set(), false, false, false, 0, false)).toContain('no @all posts yet')
})

test('member bees keep their wings, antennae, and striped body across statuses and energize when working', () => {
  const accent = '#628fd2'
  const outline = (svg: string) => svg.match(/<path class="(?:bee-body|bee-antennae|bee-band|wing-front|wing-back)"[^>]+>/g)
  const active = memberBee(accent, 'working', 300)
  const coord = memberBee(accent, 'coordinating', 300)
  expect(active).toContain(`class="bee-body" fill="${accent}"`)
  expect(active).toContain('viewBox="0 0 20 12"')
  expect(active).toContain('shape-rendering="crispEdges"')
  expect(active).toContain('@media(prefers-reduced-motion:no-preference)')
  expect(active).toContain('@keyframes flutter')
  expect(active).toContain('@keyframes hover')
  expect(active).toContain('class="spark s3"')
  expect(active).toContain('animation:flutter 150ms')
  expect(coord).toContain('animation:flutter 220ms')
  expect(coord).not.toContain('class="spark s3"')
  expect(outline(active)).toHaveLength(6)
  expect(outline(coord)).toEqual(outline(active))
  for (const status of ['waiting', 'not started', 'failed', 'unreachable', 'stopped', 'closed', 'killed']) {
    const resting = memberBee(accent, status, 300)
    expect(outline(resting)).toEqual(outline(active))
    expect(resting).not.toContain('@keyframes flutter')
    expect(resting).not.toContain('@keyframes hover')
    expect(resting).not.toContain('class="spark')
    expect(resting).not.toContain('radialGradient')
    // only a member that never started or was retired is faded, whole, as its grey status dot says
    expect(resting.includes('svg{opacity:.5}')).toBe(status === 'not started' || status === 'killed')
  }
  // one family with the hive bees: the same wing and honey in both themes
  for (const shared of ['--wing-back:#4b8f91', '--wing-back:#99c8c8', '--honey:#e9ac55']) expect(active).toContain(shared)
  expect(hiveArt('sleep')).toContain('--wing:#4b8f91;--honey:#e9ac55')
  // a paused run is the waiting tone in its icon as in its emblem, not a colour of its own
  expect(semanticIcon('paused')).toContain(semanticIcon('warn').match(/--ic:#[0-9a-f]{6}/)![0])
})

test('a wait on a substring process match is caught; an exact match or a single look is not', () => {
  // the stall this guards: `xcodebuild` also matches a running `xcodebuildmcp` server, so the loop never breaks
  for (const stuck of [
    'for i in $(seq 1 55); do pgrep -f "[x]codebuild" >/dev/null || break; sleep 10; done; ls build.sh',
    'while pgrep -f xcodebuild >/dev/null; do sleep 10; done',
    'until ! pgrep -lf xcodebuild; do :; done',
    'sleep 30; pgrep -u me -f xcodebuild',
    // an -x in a comment, in the pattern or in a later command excuses nothing
    "while pgrep -f '[x]codebuild' # use -x later\ndo sleep 10; done",
    'while pgrep -f "xcodebuild -exportArchive"; do sleep 5; done',
    'while pgrep -f xcodebuild; do sleep 5; done; tar -xf a.tar',
    'while pgrep --full xcodebuild; do sleep 5; done',
    // a long option's value is no pattern: the -f after it still counts
    'sleep 1; pgrep --uid 1000 -f xcodebuild',
    'P=pgrep; while $P -f xcodebuild; do sleep 5; done; echo pgrep -f done',
    `sh -c 'while pgrep -f xcodebuild; do sleep 5; done'`,
    // a later value does not undo an earlier one, and a wrapper's own value is no command
    'P=pgrep; while $P -f xcodebuild; do sleep 1; done; P=true',
    'while true; do exec -a foo pgrep -f xcodebuild; sleep 1; done',
    // an -x inside a valued option's attached value is no -x
    'while pgrep -ux -f xcodebuild; do sleep 1; done',
    'while pgrep -Gx -f xcodebuild; do sleep 1; done',
  ]) expect([stuck, waitsOnLooseMatch(stuck)]).toEqual([stuck, true])
  for (const fine of [
    'while pgrep -x xcodebuild >/dev/null; do sleep 10; done',
    'while pgrep -fx "xcodebuild -quiet" >/dev/null; do sleep 10; done',
    'pgrep -fl "xcodebuild -" | head -2; ./build.sh',
    'while kill -0 "$pid" 2>/dev/null; do sleep 5; done',
    'sleep 1; pgrep xcodebuild',
    // `sleep` as the pattern looked for is no wait
    'pgrep -fl sleep',
    'pgrep -f "while true" | head -1',
    'while pgrep -u me -x xcodebuild; do sleep 5; done',
    'while pgrep --full --exact "xcodebuild -quiet"; do sleep 5; done',
    // an f inside a valued option's attached value is no -f
    'while pgrep -ufoo xcodebuild; do sleep 1; done',
    'while pgrep -xu foo -f xcodebuild; do sleep 1; done',
  ]) expect([fine, waitsOnLooseMatch(fine)]).toEqual([fine, false])
})

test('a fenced report wakes nobody it names, whatever tildes it holds', () => {
  const members = { coordinator: { role: 'coordinator', last_read_seq: 0 }, parser: { role: 'worker', last_read_seq: 0 }, api: { role: 'worker', last_read_seq: 0 } }
  const report = '  @parser has no findings\n~~~\n@api closed F1\n~~~~~\n@parser again'
  expect(targets(`@coordinator HAND-BACK: put here.\n${report}`, members, 'api')).toEqual(['coordinator', 'parser'])
  expect(targets(`@coordinator HAND-BACK: put here.\n${fenced(report)}`, members, 'api')).toEqual(['coordinator'])
  expect(fenced('plain')).toBe('~~~\nplain\n~~~')
})

test('guard handles ambiguous commands, parent repositories and arithmetic shifts', async () => {
  const $ = mockGuardEngine()
  for (const command of [
    'git -C .. commit -m x',
    '$(echo git commit -am x)',
    'eval "$(echo git commit -am x)"',
    'python3 -c "git commit"',
    'git fast-import', 'git quiltimport',
    'GIT_CONFIG_GLOBAL=/tmp/config git publish',
    'git -c include.path=/tmp/config publish',
    'printf config > /tmp/gitconfig; git publish',
    'echo $[1<<2]\ngit commit -m x',
  ]) expect(await commitsInSharedCheckout($, command, '/project/sub'), command).toBe(true)
  const member = { role: 'worker' as const, last_read_seq: 0 }
  expect(actsAsAnother('python3 /p/board.py DIR post parser "I checked board*.py"', 'parser', member)).toBeUndefined()
  expect(substitutions('echo $[$(printf 1)]')).toEqual(['printf 1'])
  expect(actsAsAnother('B=/p/board.py; python3 "$B" DIR close', 'parser', member)).toBeDefined()
  expect(actsAsAnother('echo $[1<<2]\npython3 /p/board.py DIR close', 'parser', member)).toBeDefined()
  expect(waitsOnLooseMatch('while pkill -0 -f "build -x"; do sleep 1; done')).toBe(true)
  expect(waitsOnLooseMatch('while pgrep --full "build -x"; do sleep 1; done')).toBe(true)
  expect(waitsOnLooseMatch("printf '%s\\n' pgrep -f build; sleep 1")).toBe(false)
  expect(waitsOnLooseMatch('while timeout 2 /usr/bin/pgrep -f build; do sleep 1; done')).toBe(true)
  const roots = {
    fs: { stat: async (path: string) => ({ realPath: path }) },
    process: { run: async (args: string[]) => ({
      exitCode: 0, stdout: args[2] === '/repo/sandbox' ? '/repo/sandbox\n' : '/repo\n',
    }) },
  } as never
  expect(await commitsInSharedCheckout(roots, 'git -C ../sandbox commit', '/repo/app')).toBe(false)
  expect(await commitsInSharedCheckout(roots, 'git -C ../sibling commit', '/repo/app')).toBe(true)
})

test('a glob that names the board script and inline code that names a commit are read as what they run', async () => {
  const $ = mockGuardEngine()
  const worker = { role: 'worker', last_read_seq: 0 }
  for (const hidden of ['python3 /p/board.p? DIR close', 'python3 /p/boar* DIR close', 'python3 /p/[b]oard.py DIR close', 'python3 /p/verify.p[xy] DIR app accept c1',
    // a variable that holds the command and the glob, and too many ways to fill the words in to try one by one
    "for P in 'python3 /p/boar*'; do $P DIR close; done", "for P in 'env /p/[b]oard.p?'; do $P DIR close; done",
    'for X in a b c d e; do python3 /p/boar* DIR close $X $X $X; done', "for X in a b c d e; do python3 /p/bo''ard.py DIR close $X $X $X; done"]) {
    expect([hidden, actsAsAnother(hidden, 'parser', worker) !== undefined]).toEqual([hidden, true])
  }
  for (const plain of ['python3 /p/board.py DIR read parser', 'ls /p/*.md', 'python3 /p/bored.p? DIR close', "for P in 'python3 /p/boar*'; do echo $P; done", 'for X in a b c d e; do ls *.md $X $X $X; done']) {
    expect([plain, actsAsAnother(plain, 'parser', worker)]).toEqual([plain, undefined])
  }
  for (const commits of [`python3 -c "import subprocess; subprocess.run(['git','commit','-am','x'])"`, `node -e "require('child_process').execFileSync('git', ['commit', '-am', 'x'])"`]) {
    expect([commits, await commitsInSharedCheckout($, commits, '/project')]).toEqual([commits, true])
  }
  expect(await commitsInSharedCheckout($, 'python3 -c "print(1)"', '/project')).toBe(false)
})

test('figuresIn reads the token figures a message names, however written', () => {
  expect(figuresIn('give it 3M, or 2.5 mln; not 500k but 3,000,000 or 1 250 000 or 660000')).toEqual([3_000_000, 2_500_000, 500_000, 3_000_000, 1_250_000, 660_000])
  expect(figuresIn('0.125M and 2,5 mln')).toEqual([125_000, 2_500_000])
  expect(figuresIn('wait 5 minutes, use 3 workers on #1361 and 0.7 lambda')).toEqual([])
})
