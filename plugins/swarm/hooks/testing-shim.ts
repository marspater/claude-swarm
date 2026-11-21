// @ts-nocheck: bun's own module types are not installed here; tsc checks the hooks, not this test-only file.
// `bun test hooks/units.test.ts hooks/graph.test.tsx` runs the pure tests without the claude CLI: bunfig.toml
// preloads this, and 'claude-code/testing' is served from bun:test. Under the claude binary, which brings the real
// kit and its `$`, nothing is replaced.
import { plugin } from 'bun'

if (/(?:^|[\\/])bun(?:\.exe)?$/.test(process.execPath)) {
  const { expect, test } = await import('bun:test')
  plugin({
    name: 'claude-code/testing from bun:test',
    setup(build) {
      build.module('claude-code/testing', () => ({ exports: { expect, test }, loader: 'object' }))
    },
  })
}
