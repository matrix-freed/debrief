// debrief: the record contract (schema 3), the profile and the improvement
// ledger. Metadata only: no prompt, answer, tool input, command argument,
// message body or file path text is ever held in a record.

export type DebriefCounts = { [name: string]: number }

export type DebriefUsage = {
  in: number
  out: number
  cacheRead: number
  cacheWrite: number
  steps: number
  nullUsageSteps: number
}

export type DebriefStep = {
  loop: string
  turnId: string
  index: number
  model: string
  effort?: string
  stopReason: string | null
  usage: { in: number; out: number; cacheRead: number; cacheWrite: number } | null
  at: number
}

export type DebriefTurn = {
  loop: string
  turnId: string
  startedAt?: number
  durationMs: number
  reason: string
  aborted: boolean
  tag?: string
}

export type DebriefAgent = {
  subagentType?: string
  model?: string
  parentModel?: string
  parentAgentId?: string
  background?: boolean
  fork?: boolean
  teammate?: boolean
  workflowRunId?: string
  workflowIndex?: number
  resumed: boolean
  spawnAttempts: number
  turns: number
  durationMs: number
  firstSeenAt: number
  seen: { start: number; steps: number; complete: number; spawn: number }
}

export type DebriefInstruction = {
  memoryType: string
  loadReason: string
  pathHash: string
  contentHash: string
  bytes: number
  mtimeMs: number
}

export type DebriefRunInfo = {
  startedAt: number
  endedAt?: number
  endReason?: string
  rotatedFrom?: string
  surface: string | null
  isInteractive: boolean
  reloads: number
  lastCheckpointAt: number
  coverage: 'complete' | 'partial'
  dropped: { steps: number; turns: number; agents: number }
}

export type DebriefFriction = {
  aborted: number
  // null = not measured (the classic hook events did not reach this plugin)
  toolErrors: number | null
  rejected: number | null
  compactions: number | null
}

export type DebriefRun = {
  schema: 3
  recorder: string
  engine: string
  source: 'mod'
  project: { slug: string; id?: string }
  sessionId: string
  runId: string
  parentSessionId?: string
  run: DebriefRunInfo
  usage: { [loop: string]: { [model: string]: DebriefUsage } }
  effort: { [model: string]: DebriefCounts }
  steps: DebriefStep[]
  turns: DebriefTurn[]
  openTurns: { [turnId: string]: number }
  cost: { usdAtStart?: number; usdAtEnd?: number; at?: number; provenance: 'engine-ledger' | 'unknown' }
  context: { percent?: number; window?: number }
  agents: { [agentId: string]: DebriefAgent }
  spawnDenied: number
  workflowRuns: string[]
  requestedToolCalls: { [loop: string]: DebriefCounts }
  serverToolUses: DebriefCounts
  toolCalls: { main: number; agent: number; isError: number; denied: number; reentry: DebriefCounts }
  classic: { seen: boolean; sessionStartSources: string[]; postToolUseFailures: number; interrupts: number; compactions: number }
  friction: DebriefFriction
  skills: DebriefCounts
  commands: DebriefCounts
  messaging: { sent: { [originKind: string]: { queued: number; refused: number } }; received: DebriefCounts }
  delegation: { external: DebriefCounts; directives: DebriefCounts }
  tags: { label: string; at: number; turnIndex: number }[]
  instructions: DebriefInstruction[]
  profileSource: 'default' | 'file' | 'store' | 'invalid'
  writes: { ok: number; failed: number; lastError?: string }
}

// A user's profile: names, patterns and thresholds live here, never in code.
export type DebriefProfile = {
  version: 1
  language: 'en' | 'ko'
  aarUse: 'personal' | 'project' | 'team'
  shareConsent: boolean
  thresholdStyle: 'conservative' | 'standard'
  mainLane?: string
  lanes: { [subagentType: string]: string }
  externalAgentTypes: string[]
  directives: { label: string; pattern: string }[]
  machines: string[]
  limits: { byteBudget: number; stepRing: number; turnRing: number; checkpointMs: number }
}

// The improvement ledger (generation is P2; the shape is fixed here).
export type DebriefLedgerItem = {
  title?: string
  project?: string
  recurrenceOf?: string[]
  id: string
  lever: 'template' | 'skill' | 'hook' | 'setting' | 'statusline' | 'instruction'
  target: string
  metric: string
  status: 'proposed' | 'applied' | 'verified' | 'dropped'
  applyPrompt: string
  evidence?: string[]
  createdAt?: string
  updatedAt?: string
}

export type DebriefLedger = { version: 1; items: DebriefLedgerItem[] }

declare module 'claude-code' {
  interface PluginState {
    debrief: { run: DebriefRun | null }
  }
}
