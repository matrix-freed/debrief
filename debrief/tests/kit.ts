// Test harness: the engine beneath debrief, answered from memory. A fake
// file system, session, clock and model stream; nothing touches disk.
import { mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { DebriefRun } from '../types'

export const ROOT = '/data/debrief'
export const CWD = '/work/proj'
export const SLUG = '-work-proj'

export type Usage4 = { in: number; out: number; cacheRead: number; cacheWrite: number }

export type World = {
  files: Map<string, string>
  failWrites: number
  sessionId: string
  usd: number
  isInteractive: boolean
  statuses: string[]
  ancestors: { dir: string; name: string; content: string; parts: [] }[]
  stepPlan: Map<string, { model: string; usage: Usage4 | null; tools?: { name: string; input: unknown }[] }>
  spawn: { model: string; agentId?: string; deny?: string }
}

export const world = (): World => ({
  files: new Map(),
  failWrites: 0,
  sessionId: 'sess-1',
  usd: 0,
  isInteractive: true,
  statuses: [],
  ancestors: [],
  stepPlan: new Map(),
  spawn: { model: 'm-sub', agentId: 'ag-1' },
})

const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/'))

export const install = (on: On, w: World, env: Record<string, string> = { HOME: '/home/u', DEBRIEF_DIR: ROOT }) => { // precheck: allow (fake home)
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, env)
  mock.store(on)
  on('fs.write', ($, e) => {
    if (w.failWrites > 0) {
      w.failWrites -= 1
      throw new Error('disk full')
    }
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', ($, e) => {
    const text = w.files.get(e.path)
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.exists', ($, e) => ({ value: w.files.has(e.path) || [...w.files.keys()].some(k => k.startsWith(e.path + '/')) }))
  on('fs.list', ($, e) => ({
    value: [...w.files.keys()]
      .filter(k => parentOf(k) === e.path)
      .map(k => ({ name: k.slice(e.path.length + 1), kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false })),
  }))
  on('fs.stat', ($, e) => {
    if (!w.files.has(e.path)) throw new Error('ENOENT')
    return { value: { kind: 'file' as const, size: 1, mtimeMs: 42, isLink: false } }
  })
  on('fs.ancestors', () => ({ value: w.ancestors }))
  on('session.id', () => ({ value: w.sessionId }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.surface', () => ({ value: w.isInteractive ? ('terminal' as const) : null }))
  on('session.version', () => ({ value: { version: '2.1.300' } }))
  on('session.usage', () => ({ value: { startedAt: 1_000_000, context: { window: 200000 }, rateLimits: [], cost: { usd: w.usd } } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.status', ($, e) => {
    if (e.text !== undefined) w.statuses.push(e.text)
    return { value: undefined }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* ($, e) {
    const plan = w.stepPlan.get(`${e.turnId}:${e.index}`)
    const usage = plan?.usage ?? null
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'model text CANARY-ANSWER',
      toolUses: plan?.tools ?? [],
      stopReason: 'end_turn' as const,
      usage:
        usage === null
          ? null
          : {
              model: plan?.model ?? e.model,
              input_tokens: usage.in,
              output_tokens: usage.out,
              cache_read_input_tokens: usage.cacheRead,
              cache_creation_input_tokens: usage.cacheWrite,
            },
    }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('agent.spawn', () => (w.spawn.deny !== undefined ? { deny: w.spawn.deny } : { model: w.spawn.model, ...(w.spawn.agentId ? { agentId: w.spawn.agentId } : {}) }))
  on('session.send', () => ({ isDelivered: true as const }))
  on('session.receive', () => ({ consumed: 'no' }))
  on('skill.prompt', ($, e) => ({ text: e.text }))
  on('command.run', ($, e) => ({ text: `ran ${e.command}` }))
  on('tool.call', () => ({ result: 'failed', isError: true }))
  on('classic.SessionStart', () => ({}))
  on('classic.InstructionsLoaded', () => ({}))
  on('classic.PostToolUseFailure', () => ({}))
  on('classic.PreCompact', () => ({}))
  return clock
}

export const start = async ($: Engine, w: World) => {
  await $.session.start({ cwd: CWD, surface: w.isInteractive ? 'terminal' : null, isInteractive: w.isInteractive })
}

export const step = async (
  $: Engine,
  w: World,
  s: { turnId: string; index: number; model: string; usage: Usage4 | null; agentId?: string; tools?: { name: string; input: unknown }[] },
) => {
  w.stepPlan.set(`${s.turnId}:${s.index}`, { model: s.model, usage: s.usage, ...(s.tools ? { tools: s.tools } : {}) })
  const stream = $.turn.step({
    turnId: s.turnId,
    index: s.index,
    model: s.model,
    messageCount: 1,
    ...(s.agentId ? { agentId: s.agentId } : {}),
  })
  for await (const _ of stream) void _
  return stream.result
}

export const turn = async (
  $: Engine,
  w: World,
  t: { turnId: string; agentId?: string; text?: string; steps: { model: string; usage: Usage4 | null; tools?: { name: string; input: unknown }[] }[]; aborted?: boolean },
) => {
  await $.turn.start({ text: t.text ?? '', turnId: t.turnId, ...(t.agentId ? { agentId: t.agentId } : {}) })
  let i = 0
  for (const s of t.steps) await step($, w, { turnId: t.turnId, index: i++, ...s, ...(t.agentId ? { agentId: t.agentId } : {}) })
  await $.turn.complete({
    answer: 'final CANARY-ANSWER',
    durationMs: 1000,
    isAborted: t.aborted === true,
    turnId: t.turnId,
    reason: t.aborted ? 'aborted' : 'answer',
    ...(t.agentId ? { agentId: t.agentId } : {}),
  })
}

export const runFiles = (w: World): DebriefRun[] =>
  [...w.files.entries()]
    .filter(([k]) => k.startsWith(`${ROOT}/runs/`) && k.endsWith('.json'))
    .map(([, v]) => JSON.parse(v) as DebriefRun)
    .sort((a, b) => a.run.startedAt - b.run.startedAt || a.runId.localeCompare(b.runId))

export const only = (w: World): DebriefRun => {
  const runs = runFiles(w)
  if (runs.length !== 1) throw new Error(`expected one run file, found ${runs.length}`)
  return runs[0] as DebriefRun
}

export const rawFiles = (w: World): string => [...w.files.values()].join('\n')

export const SPAWN = {
  tool_use_id: 'tu-1',
  prompt: 'do the thing CANARY-SPAWN',
  description: 'probe task',
  subagentType: 'general-purpose',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'm-main',
  background: true,
  fork: false,
} as const

export const PRESENT = { isFullscreen: false, columns: 100 }

export const command = ($: Engine, name: string, args: string) =>
  $.command.run({ command: name, args, origin: { kind: 'composer' } as never, presentation: PRESENT })
