// Regression tests for the Codex first-pass review findings.
import { expect, test } from 'claude-code/testing'

import { install, only, runFiles, start, step, turn, world } from './kit'

const U = { in: 1, out: 1, cacheRead: 1, cacheWrite: 1 }

test('review 2: a clear signal and a turn start racing install one new run', async ($, on) => {
  const w = world()
  const clock = install(on, w)
  await start($, w)
  await turn($, w, { turnId: 't1', steps: [{ model: 'm', usage: U }] })
  await $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: { id: 'sess-1' } as never })
  await clock.advance(1000)
  w.sessionId = 'sess-2'
  await Promise.all([$.classic.SessionStart({ source: 'clear' }), $.turn.start({ text: '', turnId: 't2' })])
  for (let i = 0; i < 3; i++) await step($, w, { turnId: 't2', index: i, model: 'm', usage: U })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
  const runs = runFiles(w)
  expect(runs).toHaveLength(2)
  expect(runs[1]).toMatchObject({ sessionId: 'sess-2', turns: [{ turnId: 't2', startedAt: expect.any(Number) }] })
  expect(runs[1]?.usage.main?.m?.steps).toBe(3)
  expect(runs[1]?.classic.sessionStartSources).toEqual(['clear'])
})

test('review 1 and 6: tool calls racing steps are all counted, in the record at once', async ($, on) => {
  const w = world()
  install(on, w)
  await start($, w)
  const work: Promise<unknown>[] = []
  for (let i = 0; i < 6; i++) {
    work.push($.tool.call({ tool: 'Bash', command: 'false' } as never))
    work.push(step($, w, { turnId: 'tm', index: i, model: 'm', usage: U }))
  }
  await Promise.all(work)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'tm', reason: 'answer' })
  const run = only(w)
  expect(run.toolCalls).toMatchObject({ main: 6, agent: 0, isError: 6, denied: 0 })
  expect(run.usage.main?.m?.steps).toBe(6)
})

test('review 4: a change left unwritten by a failed write is written at the next checkpoint', async ($, on) => {
  const w = world()
  const clock = install(on, w)
  await start($, w)
  w.failWrites = 1
  await turn($, w, { turnId: 't1', steps: [{ model: 'm', usage: { in: 7, out: 7, cacheRead: 7, cacheWrite: 7 } }] })
  expect(only(w).usage).toEqual({})
  await clock.advance(30000)
  await clock.settle()
  expect(only(w).usage.main?.m).toMatchObject({ in: 7, steps: 1 })
  expect(only(w).writes.failed).toBe(1)
})
