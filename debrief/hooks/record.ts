import type { DebriefAgent, DebriefInstruction, DebriefProfile, DebriefRun, DebriefUsage } from '../types'

// Pure record logic: every function takes the run and plain metadata and
// mutates the run in place. No text of prompts, answers, tool inputs or
// command arguments ever reaches these functions.

export const SCHEMA = 3 as const
export const RECORDER = '0.1.0'

export type StepInput = {
  loop: string
  turnId: string
  index: number
  model: string
  effort?: string
  stopReason: string | null
  usage: { in: number; out: number; cacheRead: number; cacheWrite: number } | null
  toolNames: readonly string[]
  serverToolNames: readonly string[]
  directiveLabels: readonly string[]
  at: number
}

export type SpawnInput = {
  agentId?: string
  isDenied: boolean
  subagentType: string
  model?: string
  parentModel: string
  parentAgentId?: string
  background: boolean
  fork: boolean
  teammate: boolean
  workflow?: { runId: string; agentIndex: number }
  resumed: boolean
  at: number
}

export type NewRunInput = {
  sessionId: string
  runId: string
  now: number
  engine: string
  slug: string
  projectId?: string
  parentSessionId?: string
  surface: string | null
  isInteractive: boolean
  usdAtStart?: number
  rotatedFrom?: string
  profileSource: DebriefRun['profileSource']
}

const bump = (counts: Record<string, number>, key: string, by = 1) => {
  counts[key] = (counts[key] ?? 0) + by
}

export const emptyRun = (i: NewRunInput): DebriefRun => ({
  schema: SCHEMA,
  recorder: RECORDER,
  engine: i.engine,
  source: 'mod',
  project: { slug: i.slug, ...(i.projectId ? { id: i.projectId } : {}) },
  sessionId: i.sessionId,
  runId: i.runId,
  ...(i.parentSessionId ? { parentSessionId: i.parentSessionId } : {}),
  run: {
    startedAt: i.now,
    ...(i.rotatedFrom ? { rotatedFrom: i.rotatedFrom } : {}),
    surface: i.surface,
    isInteractive: i.isInteractive,
    reloads: 0,
    lastCheckpointAt: i.now,
    coverage: 'complete',
    dropped: { steps: 0, turns: 0, agents: 0 },
  },
  usage: {},
  effort: {},
  steps: [],
  turns: [],
  openTurns: {},
  cost: { ...(i.usdAtStart === undefined ? {} : { usdAtStart: i.usdAtStart }), provenance: i.usdAtStart === undefined ? 'unknown' : 'engine-ledger' },
  context: {},
  agents: {},
  spawnDenied: 0,
  workflowRuns: [],
  requestedToolCalls: {},
  serverToolUses: {},
  toolCalls: { main: 0, agent: 0, isError: 0, denied: 0, reentry: {} },
  classic: { seen: false, sessionStartSources: [], postToolUseFailures: 0, interrupts: 0, compactions: 0 },
  friction: { aborted: 0, toolErrors: null, rejected: null, compactions: null },
  skills: {},
  commands: {},
  messaging: { sent: {}, received: {} },
  delegation: { external: {}, directives: {} },
  tags: [],
  instructions: [],
  profileSource: i.profileSource,
  writes: { ok: 0, failed: 0 },
})

// An agent is known from its first event: its turn.start and steps can come
// before its spawn's result (P0), so the spawn merges into what is there.
export const ensureAgent = (run: DebriefRun, agentId: string, at: number): DebriefAgent => {
  const found = run.agents[agentId]
  if (found) return found
  const agent: DebriefAgent = {
    resumed: false,
    spawnAttempts: 0,
    turns: 0,
    durationMs: 0,
    firstSeenAt: at,
    seen: { start: 0, steps: 0, complete: 0, spawn: 0 },
  }
  run.agents[agentId] = agent
  return agent
}

const ring = <T>(list: T[], cap: number): number => {
  const over = list.length - cap
  if (over <= 0) return 0
  list.splice(0, over)
  return over
}

export const startTurn = (run: DebriefRun, loop: string, turnId: string, at: number) => {
  run.openTurns[turnId] = at
  if (loop !== 'main') ensureAgent(run, loop, at).seen.start += 1
}

export const addStep = (run: DebriefRun, s: StepInput, profile: DebriefProfile) => {
  const byModel = (run.usage[s.loop] ??= {})
  const u: DebriefUsage = (byModel[s.model] ??= { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, steps: 0, nullUsageSteps: 0 })
  u.steps += 1
  if (s.usage === null) u.nullUsageSteps += 1
  else {
    u.in += s.usage.in
    u.out += s.usage.out
    u.cacheRead += s.usage.cacheRead
    u.cacheWrite += s.usage.cacheWrite
  }
  if (s.effort !== undefined) bump((run.effort[s.model] ??= {}), s.effort)
  run.steps.push({
    loop: s.loop,
    turnId: s.turnId,
    index: s.index,
    model: s.model,
    ...(s.effort === undefined ? {} : { effort: s.effort }),
    stopReason: s.stopReason,
    usage: s.usage,
    at: s.at,
  })
  run.run.dropped.steps += ring(run.steps, profile.limits.stepRing)
  const tools = (run.requestedToolCalls[s.loop] ??= {})
  for (const name of s.toolNames) bump(tools, name)
  for (const name of s.serverToolNames) bump(run.serverToolUses, name)
  for (const label of s.directiveLabels) bump(run.delegation.directives, label)
  if (s.loop !== 'main') ensureAgent(run, s.loop, s.at).seen.steps += 1
}

export const completeTurn = (
  run: DebriefRun,
  t: { loop: string; turnId: string; durationMs: number; reason: string; aborted: boolean; at: number },
  profile: DebriefProfile,
) => {
  const startedAt = run.openTurns[t.turnId]
  delete run.openTurns[t.turnId]
  const lastTag = run.tags.length > 0 ? run.tags[run.tags.length - 1] : undefined
  run.turns.push({
    loop: t.loop,
    turnId: t.turnId,
    ...(startedAt === undefined ? {} : { startedAt }),
    durationMs: t.durationMs,
    reason: t.reason,
    aborted: t.aborted,
    ...(lastTag ? { tag: lastTag.label } : {}),
  })
  run.run.dropped.turns += ring(run.turns, profile.limits.turnRing)
  if (t.aborted) run.friction.aborted += 1
  if (t.loop !== 'main') {
    const agent = ensureAgent(run, t.loop, t.at)
    agent.seen.complete += 1
    agent.turns += 1
    agent.durationMs += t.durationMs
  }
}

export const applySpawn = (run: DebriefRun, s: SpawnInput, profile: DebriefProfile) => {
  if (s.isDenied || s.agentId === undefined) {
    run.spawnDenied += 1
    return
  }
  const agent = ensureAgent(run, s.agentId, s.at)
  const isFirstSpawn = agent.seen.spawn === 0
  agent.seen.spawn += 1
  agent.spawnAttempts += 1
  agent.subagentType = s.subagentType
  if (s.model !== undefined) agent.model = s.model
  agent.parentModel = s.parentModel
  if (s.parentAgentId !== undefined) agent.parentAgentId = s.parentAgentId
  agent.background = s.background
  agent.fork = s.fork
  agent.teammate = s.teammate
  if (s.workflow) {
    agent.workflowRunId = s.workflow.runId
    agent.workflowIndex = s.workflow.agentIndex
    if (s.workflow.runId !== '' && !run.workflowRuns.includes(s.workflow.runId)) run.workflowRuns.push(s.workflow.runId)
  }
  agent.resumed = agent.resumed || s.resumed
  // A replayed spawn of the same agent is counted once as a delegation.
  if (isFirstSpawn && profile.externalAgentTypes.includes(s.subagentType)) bump(run.delegation.external, s.subagentType)
}

export const addInstruction = (run: DebriefRun, i: DebriefInstruction) => {
  const isKnown = run.instructions.some(
    x => x.pathHash === i.pathHash && x.contentHash === i.contentHash && x.loadReason === i.loadReason,
  )
  if (!isKnown) run.instructions.push(i)
}

// Friction is derived when the record is written: rejections are tool calls
// that ended in error with no PostToolUseFailure for them (P0). Without the
// classic events the three classic-backed counters stay null (not measured).
export const deriveFriction = (run: DebriefRun) => {
  if (!run.classic.seen) {
    run.friction.toolErrors = null
    run.friction.rejected = null
    run.friction.compactions = null
    return
  }
  run.friction.toolErrors = run.classic.postToolUseFailures - run.classic.interrupts
  run.friction.rejected = Math.max(0, run.toolCalls.isError - run.classic.postToolUseFailures)
  run.friction.compactions = run.classic.compactions
}

const byteLength = (text: string) => new TextEncoder().encode(text).length

// Serializes within the byte budget: oldest steps go first, then oldest
// turns, then the oldest agents fold into one `other` entry. What was dropped
// is counted and the coverage marked partial.
export const serialize = (source: DebriefRun, profile: DebriefProfile, now: number): { text: string; run: DebriefRun } => {
  const run = structuredClone(source) as DebriefRun
  run.run.lastCheckpointAt = now
  deriveFriction(run)
  const budget = profile.limits.byteBudget
  let text = JSON.stringify(run)
  while (byteLength(text) > budget) {
    if (run.steps.length > 0) {
      const n = Math.max(1, Math.ceil(run.steps.length / 4))
      run.steps.splice(0, n)
      run.run.dropped.steps += n
    } else if (run.turns.length > 0) {
      const n = Math.max(1, Math.ceil(run.turns.length / 4))
      run.turns.splice(0, n)
      run.run.dropped.turns += n
    } else {
      const ids = Object.keys(run.agents)
        .filter(id => id !== 'other')
        .sort((a, b) => (run.agents[a]?.firstSeenAt ?? 0) - (run.agents[b]?.firstSeenAt ?? 0))
      const victim = ids[0]
      if (victim === undefined) break
      const gone = run.agents[victim]
      delete run.agents[victim]
      const other = ensureAgent(run, 'other', gone?.firstSeenAt ?? now)
      other.turns += gone?.turns ?? 0
      other.durationMs += gone?.durationMs ?? 0
      run.run.dropped.agents += 1
    }
    run.run.coverage = 'partial'
    text = JSON.stringify(run)
  }
  return { text, run }
}

export type Totals = { in: number; out: number; cacheRead: number; cacheWrite: number; mainShare: number }

export const totals = (runs: readonly DebriefRun[]): Totals => {
  let all = 0
  let main = 0
  const t = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 }
  for (const run of runs)
    for (const [loop, byModel] of Object.entries(run.usage))
      for (const u of Object.values(byModel)) {
        t.in += u.in
        t.out += u.out
        t.cacheRead += u.cacheRead
        t.cacheWrite += u.cacheWrite
        const sum = u.in + u.out + u.cacheRead + u.cacheWrite
        all += sum
        if (loop === 'main') main += sum
      }
  return { ...t, mainShare: all === 0 ? 0 : main / all }
}

const k = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

const minutes = (ms: number) => `${Math.max(0, Math.round(ms / 60000))}m`

// The status line: input (all input kinds) and output tokens, run wall time,
// main-loop share. A guard is shown, never raised as a warning.
export const statusText = (run: DebriefRun, now: number): string => {
  const t = totals([run])
  return `in ${k(t.in + t.cacheRead + t.cacheWrite)} out ${k(t.out)} · ${minutes(now - run.run.startedAt)} · main ${Math.round(t.mainShare * 100)}%`
}

export const summaryText = (runs: readonly DebriefRun[], now: number): string => {
  if (runs.length === 0) return 'nothing recorded for this session yet.'
  const t = totals(runs)
  const models = new Map<string, number>()
  let agents = 0
  let turns = 0
  let usdStart: number | undefined
  let usdEnd: number | undefined
  for (const run of runs) {
    agents += Object.keys(run.agents).length
    turns += run.turns.length
    for (const byModel of Object.values(run.usage))
      for (const [model, u] of Object.entries(byModel)) models.set(model, (models.get(model) ?? 0) + u.out)
    if (usdStart === undefined && run.cost.usdAtStart !== undefined) usdStart = run.cost.usdAtStart
    if (run.cost.usdAtEnd !== undefined) usdEnd = run.cost.usdAtEnd
  }
  const first = runs[0]
  const last = runs[runs.length - 1]
  const wall = first && last ? (last.run.endedAt ?? now) - first.run.startedAt : 0
  const modelList = [...models.entries()].map(([m, out]) => `${m} out ${k(out)}`).join(', ')
  const cost =
    usdEnd === undefined ? 'cost: not reported' : `cost (engine ledger, API-equivalent, session cumulative): $${usdEnd.toFixed(2)}`
  return [
    `${runs.length} run(s), ${turns} turns, ${agents} agents, ${minutes(wall)} wall.`,
    `tokens: in ${k(t.in)} + cache read ${k(t.cacheRead)} + cache write ${k(t.cacheWrite)}, out ${k(t.out)}; main loop ${Math.round(t.mainShare * 100)}%.`,
    `models: ${modelList || 'none'}.`,
    cost + (usdStart !== undefined && usdStart > 0 ? ` (was $${usdStart.toFixed(2)} when this record began)` : '') + '.',
  ].join('\n')
}
