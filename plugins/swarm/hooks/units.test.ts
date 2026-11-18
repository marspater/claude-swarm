import { expect, test } from 'claude-code/testing'
import type { Post } from '../types'
import { BOARD_CALL, COORDINATOR_READ, RUN, runsNamed, wakeMessage, wakeSequence } from './command'
import { graphSvg } from './graph'
import { toolMood } from './hive'
import { DEFAULT_MODEL, SWARM_AGENTS, familyOf, latestOf } from './models'
import { statusKey } from './palette'
import { parse, tokensUsed } from './roster'
import { bodyOf, clean, clip, kindOf, openedText } from './text'

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
  expect(runsNamed(`a ${run} b demo-20261116-101010 other-20261117-090000x`)).toEqual(['demo-20261116-101010', 'other-20261117-090000x'])
  expect(wakeSequence(wakeMessage(12))).toBe(12)
  expect(Number.isSafeInteger(wakeSequence('hello'))).toBe(false)
})

test('every member type starts on the newest model of its family', async () => {
  expect([latestOf('opus'), latestOf('haiku'), latestOf('claude-opus-4-6'), latestOf(undefined)])
    .toEqual(['claude-opus-5-5', 'claude-haiku-5-5', 'claude-opus-4-6', undefined])
  expect(familyOf('claude-fable-5-2')).toBe('fable')
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
    members: { coordinator: { role: 'coordinator', last_read_seq: 0 }, parser: { role: 'worker', profile: 'designer', last_read_seq: 0 } },
  })
  const board = `${JSON.stringify({ seq: 1, agent: 'parser', text: '@coordinator hi\r\nthere', time: 't' })}\n{"seq": 2, "agent": "par`
  const shown = parse('/project/.swarm/demo-20261116-101010', board, roster, [])
  expect(shown.title).toBe('Demo run')
  expect(shown.posts.map(p => [p.seq, p.text, p.to])).toEqual([[1, '@coordinator hi\nthere', ['coordinator']]])
  expect(shown.members.find(member => member.name === 'parser')?.type).toBe('designer')
  expect([shown.budget, tokensUsed(shown.tokens)]).toEqual([100, 15])
  // a member that has not started is drawn with one class, not two
  const svg = graphSvg(shown, 1, new Set(), false, true)
  expect(svg).not.toMatch(/class="presence not started"/)
})
