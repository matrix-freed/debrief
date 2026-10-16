// debrief-probe state contract. Metadata only: no prompt, answer, tool input,
// command argument or path text is ever held here.

export type ProbeCounts = { [name: string]: number }

export type ProbeUsage = {
  in: number
  out: number
  cacheRead: number
  cacheWrite: number
  steps: number
  nullUsageSteps: number
}

export type ProbeStep = {
  loop: string
  turnId: string
  index: number
  model: string
  effort?: string
  stopReason: string | null
  usage: { in: number; out: number; cacheRead: number; cacheWrite: number } | null
  tools: string[]
  at: number
}

export type ProbeTurn = {
  loop: string
  turnId: string
  hadStart: boolean
  durationMs: number
  reason: string
  isAborted: boolean
  usageModel?: string
}

export type ProbeAgent = {
  subagentType: string
  model: string
  parentModel: string
  parentAgentId?: string
  background: boolean
  fork: boolean
  teammate: boolean
  workflowRunId?: string
  workflowIndex?: number
  resumed: boolean
  spawnedAt: number
  seen: { start: number; steps: number; complete: number }
}

export type ProbeInstruction = {
  memoryType: string
  loadReason: string
  pathHash: string
  contentHash: string
  bytes: number
  mtimeMs: number
}

export type ProbeRun = {
  schema: 'probe-1'
  engine: string
  sessionId: string
  runId: string
  startedAt: number
  endedAt?: number
  endReason?: string
  rotatedBy?: string
  surface: string | null
  isInteractive: boolean
  reloads: number
  lastCheckpointAt: number
  env: { project?: string; parentSession?: string; dirFromEnv: boolean }
  events: ProbeCounts
  classicSessionStart: string[]
  usage: { [loop: string]: { [model: string]: ProbeUsage } }
  steps: ProbeStep[]
  turns: ProbeTurn[]
  agents: { [agentId: string]: ProbeAgent }
  spawnDenied: number
  toolCall: { main: number; agent: number; reentry: ProbeCounts; byLoop: ProbeCounts }
  requestedTools: { [loop: string]: ProbeCounts }
  skills: ProbeCounts
  commands: ProbeCounts
  commandArgsChars: number
  messaging: { sent: { [kind: string]: { queued: number; refused: number } }; received: ProbeCounts }
  classify: { remoteDirective: number; codexCli: number; bashSteps: number }
  friction: {
    abortedTurns: number
    toolErrors: number
    toolInterrupts: number
    permissionDenied: number
    compactions: number
    compactEvents: number
    stopFailures: number
  }
  instructions: ProbeInstruction[]
  cost: { usd?: number; at?: number; provenance: 'engine-ledger' | 'unknown' }
  context: { measures: number; lastPercent?: number }
  status: { updates: number; last?: string }
  setup: { asked: number; answered: number; answerLabel?: string; error?: string }
  insights: { sessionMetaDir: boolean; facetsDir: boolean; sessionMetaFiles: number; error?: string }
  writes: { ok: number; failed: number; lastError?: string }
}

declare module 'claude-code' {
  interface PluginState {
    'debrief-probe': { run: ProbeRun | null }
  }
}
