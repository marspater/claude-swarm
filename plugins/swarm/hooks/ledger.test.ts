import { expect, test } from 'claude-code/testing'
import { ledger } from './roster'

const spent = (overrides: Partial<{
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
}> = {}) => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  ...overrides,
})

test('F08: zero-weight step raw usage is preserved and billed on next weighted step', () => {
  const l = ledger()
  // Step 1: cache_read_input_tokens = 1 -> weight 0.1 -> rounds to 0 (delta = 0)
  const d1 = l.charge('t1', spent({ cache_read_input_tokens: 1 }), 0)
  expect(d1).toBe(0)

  // Step 2: cache_read_input_tokens = 4 -> total 5 -> weight 0.5 -> rounds to 1 (delta = 1)
  const d2 = l.charge('t1', spent({ cache_read_input_tokens: 4 }), 1)
  expect(d2).toBe(1)

  const turn = l.of('t1')!
  expect(l.detail(turn, 1)).toBe('0,0,5,0')

  l.landed(turn, d2, 1)
  expect(turn.taken.cache_read_input_tokens).toBe(5)
  expect(turn.charged).toBe(1)
})

test('F09: pending ended entries are retained past kept until settled, then pruned', () => {
  const l = ledger(2)

  // End 3 turns with pending charges
  for (const id of ['t1', 't2', 't3']) {
    const d = l.charge(id, spent({ input_tokens: 10 }), 0)
    expect(d).toBe(10)
    l.charge(id, undefined)
  }

  // All 3 pending entries must be retained even though kept = 2
  expect(l.owed().map(([id]) => id)).toEqual(['t1', 't2', 't3'])
  expect(l.of('t1')).toBeDefined()
  expect(l.of('t2')).toBeDefined()
  expect(l.of('t3')).toBeDefined()

  // Settle t1 -> it stays while its caller finishes it (a repeated end would charge a turn that is gone whole)
  l.landed(l.of('t1')!, 10, 0)
  expect(l.of('t1')).toBeDefined()
  expect(l.of('t2')).toBeDefined()
  expect(l.of('t3')).toBeDefined()
  expect(l.owed().map(([id]) => id)).toEqual(['t2', 't3'])
  // ...and goes when the next one settles: ended.size > kept, and t1 owes nothing
  l.landed(l.of('t2')!, 10, 0)
  expect(l.of('t1')).toBeUndefined()
  expect(l.of('t2')).toBeDefined()
  expect(l.owed().map(([id]) => id)).toEqual(['t3'])
})

test('F09: settled entry is evicted when ended exceeds kept, leaving pending entries intact', () => {
  const l = ledger(2)

  // t1 is pending
  l.charge('t1', spent({ input_tokens: 10 }), 0)
  l.charge('t1', undefined)

  // t2 is settled
  l.charge('t2', spent({ input_tokens: 20 }), 0)
  l.landed(l.of('t2')!, 20, 0)
  l.charge('t2', undefined)

  // t3 is pending -> exceeds kept=2, should evict t2 (settled), not t1 (pending)
  l.charge('t3', spent({ input_tokens: 30 }), 0)
  l.charge('t3', undefined)

  expect(l.of('t2')).toBeUndefined()
  expect(l.of('t1')).toBeDefined()
  expect(l.of('t3')).toBeDefined()
  expect(l.owed().map(([id]) => id)).toEqual(['t1', 't3'])
})

test('cached reads too few to charge by the end of a turn are reported with the agent\'s next charge', () => {
  const l = ledger()
  const d0 = l.charge('t1', spent({ cache_read_input_tokens: 5 }), 0, 'a1')
  expect(d0).toBe(1)
  expect(l.charge('t1', spent({ cache_read_input_tokens: 1 }), 1, 'a1')).toBe(0)
  l.landed(l.of('t1')!, d0, 0)
  // The end owes nothing more, so no report carries the sixth read: it waits for the agent's next one.
  expect(l.charge('t1', undefined, undefined, 'a1')).toBe(0)
  expect(l.charge('t1', undefined, undefined, 'a1')).toBe(0)  // a repeated end carries it once
  expect(l.charge('t2', spent({ input_tokens: 7 }), 0, 'a1')).toBe(7)
  expect(l.detail(l.of('t2')!, 0)).toBe('7,0,1,0')
  // Another agent's turn takes none of it.
  expect(l.charge('t3', spent({ input_tokens: 7 }), 0, 'a2')).toBe(7)
  expect(l.detail(l.of('t3')!, 0)).toBe('7,0,0,0')
})

test('counts carried over several turns that charge nothing all reach the next charge', () => {
  const l = ledger()
  for (const turn of ['t1', 't2', 't3', 't4', 't5']) {
    expect(l.charge(turn, spent({ cache_read_input_tokens: 4 }), 0, 'a1')).toBe(0)
    expect(l.charge(turn, undefined, undefined, 'a1')).toBe(0)
  }
  expect(l.charge('t6', spent({ input_tokens: 7 }), 0, 'a1')).toBe(7)
  expect(l.detail(l.of('t6')!, 0)).toBe('7,0,20,0')
  // Or the end of a turn that charges something, when no step of it did.
  expect(l.charge('t7', spent({ cache_read_input_tokens: 4 }), 0, 'a2')).toBe(0)
  expect(l.charge('t7', undefined, undefined, 'a2')).toBe(0)
  expect(l.charge('t8', spent({ input_tokens: 3 }), undefined, 'a2')).toBe(3)
  expect(l.detail(l.of('t8')!, -1)).toBe('3,0,4,0')
})

test('counts a report took over stay with the agent when that report is never sent', () => {
  const l = ledger()
  expect(l.charge('t1', spent({ cache_read_input_tokens: 4 }), 0, 'a1')).toBe(0)
  expect(l.charge('t1', undefined, undefined, 'a1')).toBe(0)
  expect(l.charge('t2', spent({ input_tokens: 7 }), 0, 'a1')).toBe(7)
  l.landed(l.of('t2')!, 0, 0)  // never sent: its own tokens go under the turn's end, the four it took over under no turn
  expect(l.charge('t3', spent({ input_tokens: 2 }), 0, 'a1')).toBe(2)
  expect(l.detail(l.of('t3')!, 0)).toBe('2,0,4,0')
})

test('counts a report took over are not taken off its own turn\'s remainder', () => {
  const l = ledger()
  expect(l.charge('a', spent({ cache_read_input_tokens: 4 }), 0, 'a1')).toBe(0)
  expect(l.charge('a', undefined, undefined, 'a1')).toBe(0)
  const d = l.charge('b', spent({ cache_read_input_tokens: 5 }), 0, 'a1')
  expect([d, l.detail(l.of('b')!, 0)]).toEqual([1, '0,0,9,0'])
  l.landed(l.of('b')!, d, 0)
  expect(l.charge('b', spent({ cache_read_input_tokens: 4 }), 1, 'a1')).toBe(0)
  expect(l.charge('b', undefined, undefined, 'a1')).toBe(0)
  // Nine reported so far of thirteen: the turn's last four wait for the next report.
  expect(l.charge('c', spent({ input_tokens: 7 }), 0, 'a1')).toBe(7)
  expect(l.detail(l.of('c')!, 0)).toBe('7,0,4,0')
})

test('settling a charge never evicts the turn it belongs to', () => {
  const l = ledger(1)
  const first = l.charge('t1', spent({ input_tokens: 10 }), 0)
  l.charge('t1', undefined, undefined)
  l.charge('t2', spent({ input_tokens: 10 }), 0)
  l.charge('t2', undefined, undefined)
  // More ended turns with a charge pending than are kept: the one settled now is still the caller's to finish.
  l.landed(l.of('t1')!, first, 0)
  expect(l.of('t1')).toBeDefined()
  expect(l.charge('t1', undefined, undefined)).toBe(0)
})

test('what the coordinator\'s turns left in one run is not reported in the next', () => {
  const l = ledger()
  expect(l.charge('t1', spent({ cache_read_input_tokens: 4 }), 0)).toBe(0)
  expect(l.charge('t1', undefined, undefined)).toBe(0)
  expect(l.charge('t2', spent({ cache_read_input_tokens: 4 }), 0, 'a1')).toBe(0)
  expect(l.charge('t2', undefined, undefined, 'a1')).toBe(0)
  l.unbind()  // another run is bound
  expect(l.charge('t3', spent({ input_tokens: 7 }), 0)).toBe(7)
  expect(l.detail(l.of('t3')!, 0)).toBe('7,0,0,0')
  // An agent is one run's from start to end: its own counts stay with it.
  expect(l.charge('t4', spent({ input_tokens: 7 }), 0, 'a1')).toBe(7)
  expect(l.detail(l.of('t4')!, 0)).toBe('7,0,4,0')
})
