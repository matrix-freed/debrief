import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ProbeRun, ProbeUsage } from '../types'
import { bashCommandOf, isCodexCli, isRemoteDirective } from './classify'

// Throwaway P0 probe. Records metadata only: event names, ids, counts, token
// numbers, models. Never prompt/answer text, tool input, command args or paths.

const RUN_REF = { plugin: 'debrief-probe', key: 'run' } as const
const RUN = atom(RUN_REF, null as ProbeRun | null)

const STEP_CAP = 2000
const TURN_CAP = 1000

// Module-local counters for places where `$` cannot be called (a .catch on
// re-entry). Merged into state at each turn end; lost on reload by design.
const pendingToolCalls = { main: 0, agent: 0, reentry: {} as Record<string, number>, byLoop: {} as Record<string, number> }
const writes = { ok: 0, failed: 0, lastError: undefined as string | undefined }
let writeChain: Promise<void> = Promise.resolve()
let dirty = false

type $ = EngineInterface

const bump = (counts: Record<string, number>, key: string, by = 1) => {
  counts[key] = (counts[key] ?? 0) + by
}

const sha = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('')
}

const hex4 = () => {
  const bytes = new Uint8Array(2)
  crypto.getRandomValues(bytes)
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
}

const dataDir = async ($: $): Promise<{ dir: string; fromEnv: boolean }> => {
  const fromEnv = await $.env.get('DEBRIEF_PROBE_DIR')
  if (fromEnv) return { dir: fromEnv.replace(/[\\/]$/, ''), fromEnv: true }
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? '.'
  return { dir: `${home}/.debrief/probe`, fromEnv: false }
}

const freshRun = async ($: $, surface: string | null, isInteractive: boolean, rotatedBy?: string): Promise<ProbeRun> => {
  const now = await $.clock.now()
  const version = await $.session.version()
  const { fromEnv } = await dataDir($)
  return {
    schema: 'probe-1',
    engine: version.version,
    sessionId: await $.session.id(),
    runId: `${now}-${hex4()}`,
    startedAt: now,
    ...(rotatedBy ? { rotatedBy } : {}),
    surface,
    isInteractive,
    reloads: 0,
    lastCheckpointAt: now,
    env: {
      project: (await $.env.get('DEBRIEF_PROJECT')) ?? undefined,
      parentSession: (await $.env.get('DEBRIEF_PARENT_SESSION')) ?? undefined,
      dirFromEnv: fromEnv,
    },
    events: {},
    classicSessionStart: [],
    usage: {},
    steps: [],
    turns: [],
    agents: {},
    spawnDenied: 0,
    toolCall: { main: 0, agent: 0, reentry: {}, byLoop: {} },
    requestedTools: {},
    skills: {},
    commands: {},
    commandArgsChars: 0,
    messaging: { sent: {}, received: {} },
    classify: { remoteDirective: 0, codexCli: 0, bashSteps: 0 },
    friction: {
      abortedTurns: 0,
      toolErrors: 0,
      toolInterrupts: 0,
      permissionDenied: 0,
      compactions: 0,
      compactEvents: 0,
      stopFailures: 0,
    },
    instructions: [],
    cost: { provenance: 'unknown' },
    context: { measures: 0 },
    status: { updates: 0 },
    setup: { asked: 0, answered: 0 },
    insights: { sessionMetaDir: false, facetsDir: false, sessionMetaFiles: 0 },
    writes: { ok: 0, failed: 0 },
  }
}

// Applies fn to the current run (if any) and marks it dirty.
// Events that arrive before session.start made a run (classic SessionStart,
// InstructionsLoaded at startup) wait here and are applied once a run exists.
let early: ((run: ProbeRun) => void)[] = []

const mutate = async ($: $, fn: (run: ProbeRun) => void) => {
  await update($, RUN, run => {
    if (run === null) {
      early.push(fn)
      return run
    }
    const copy = structuredClone(run) as ProbeRun
    fn(copy)
    return copy
  })
  dirty = true
}

const applyEarly = (run: ProbeRun) => {
  for (const fn of early) {
    fn(run)
    bump(run.events, 'early-buffered')
  }
  early = []
}

const flush = ($: $): Promise<void> => {
  writeChain = writeChain.then(async () => {
    const run = await read($, RUN)
    if (run === null) return
    const { dir } = await dataDir($)
    const now = await $.clock.now()
    const out: ProbeRun = {
      ...run,
      lastCheckpointAt: now,
      writes: { ok: writes.ok + 1, failed: writes.failed, ...(writes.lastError ? { lastError: writes.lastError } : {}) },
    }
    try {
      await $.fs.write(`${dir}/${run.sessionId}/${run.runId}.json`, JSON.stringify(out, null, 1))
      writes.ok += 1
      dirty = false
    } catch (error) {
      writes.failed += 1
      writes.lastError = error instanceof Error ? error.name : 'unknown'
    }
  }).catch(() => undefined)
  return writeChain
}

const mergePendingToolCalls = (run: ProbeRun) => {
  run.toolCall.main += pendingToolCalls.main
  run.toolCall.agent += pendingToolCalls.agent
  for (const [k, n] of Object.entries(pendingToolCalls.reentry)) bump(run.toolCall.reentry, k, n)
  for (const [k, n] of Object.entries(pendingToolCalls.byLoop)) bump(run.toolCall.byLoop, k, n)
  pendingToolCalls.main = 0
  pendingToolCalls.agent = 0
  pendingToolCalls.reentry = {}
  pendingToolCalls.byLoop = {}
}

// Opens a new run when none is live for the current session id (after /clear).
const ensureCurrent = async ($: $, why: string) => {
  const run = await read($, RUN)
  const sid = await $.session.id()
  if (run !== null && run.sessionId === sid && run.endedAt === undefined) return
  const surface = await $.session.surface()
  const next = await freshRun($, surface, run?.isInteractive ?? surface !== null, why)
  applyEarly(next)
  await $.state.set(RUN_REF, next)
  await flush($)
}

const statusText = (run: ProbeRun): string => {
  let total = 0
  let main = 0
  for (const [loop, byModel] of Object.entries(run.usage)) {
    for (const u of Object.values(byModel)) {
      const t = u.in + u.out + u.cacheRead + u.cacheWrite
      total += t
      if (loop === 'main') main += t
    }
  }
  const share = total === 0 ? 0 : Math.round((main / total) * 100)
  return `probe ${Math.round(total / 1000)}k tok, main ${share}%`
}

const insightsCheck = async ($: $, run: ProbeRun) => {
  // Fail-open: the /insights output is another tool's; read listings only.
  try {
    const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? '.'
    const base = `${home}/.claude/usage-data`
    run.insights.sessionMetaDir = await $.fs.exists(`${base}/session-meta`)
    run.insights.facetsDir = await $.fs.exists(`${base}/facets`)
    if (run.insights.sessionMetaDir) {
      const list = await $.fs.list(`${base}/session-meta`)
      run.insights.sessionMetaFiles = list.filter(f => f.name.endsWith('.json')).length
    }
  } catch (error) {
    run.insights.error = error instanceof Error ? error.name : 'unknown'
  }
}

// S16a fallback: fingerprint the instruction files the engine would load,
// without waiting for InstructionsLoaded. Hashes only; no path or text kept.
const scanInstructions = async ($: $, run: ProbeRun) => {
  try {
    const found = await $.fs.ancestors({ names: ['CLAUDE.md', 'CLAUDE.local.md'] })
    const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? '.'}/.claude`
    const files = found.map(f => ({ path: `${f.dir}/${f.name}`, text: f.content, memoryType: 'Project' }))
    const userPath = `${configDir}/CLAUDE.md`
    if (await $.fs.exists(userPath)) files.push({ path: userPath, text: await $.fs.read(userPath), memoryType: 'User' })
    for (const f of files) {
      const stat = await $.fs.stat(f.path).catch(() => undefined)
      run.instructions.push({
        memoryType: f.memoryType,
        loadReason: 'probe-scan',
        pathHash: await sha(f.path),
        contentHash: await sha(f.text),
        bytes: new TextEncoder().encode(f.text).length,
        mtimeMs: stat?.mtimeMs ?? 0,
      })
    }
  } catch (error) {
    bump(run.events, `instructions-scan-failed:${error instanceof Error ? error.name : 'unknown'}`)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const sid = await $.session.id()
    const current = await read($, RUN)
    if (current !== null && current.sessionId === sid && current.endedAt === undefined) {
      const run = structuredClone(current) as ProbeRun
      run.reloads += 1
      bump(run.events, 'session.start')
      if (run.instructions.length === 0) await scanInstructions($, run)
      await $.state.set(RUN_REF, run)
    } else {
      const run = await freshRun($, e.surface, e.isInteractive)
      bump(run.events, 'session.start')
      applyEarly(run)
      await scanInstructions($, run)
      await insightsCheck($, run)
      await $.state.set(RUN_REF, run)
    }
    await $.command.register({ name: 'probe-status', description: 'debrief probe: show this run (metadata only)' })
    await $.command.register({ name: 'probe-setup', description: 'debrief probe: ask one structured question and store the answer' })
    $.clock.every(15000, () => {
      if (dirty) void flush($)
    })
    await flush($)
    return next(e)
  })

  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'clear') await ensureCurrent($, 'classic-clear')
    await mutate($, run => {
      bump(run.events, 'classic.SessionStart')
      run.classicSessionStart.push(e.source)
    })
    return next(e)
  })

  on('classic.InstructionsLoaded', async ($, e, next) => {
    try {
      const [text, stat] = await Promise.all([$.fs.read(e.file_path), $.fs.stat(e.file_path)])
      const entry = {
        memoryType: e.memory_type,
        loadReason: e.load_reason,
        pathHash: await sha(e.file_path),
        contentHash: await sha(text),
        bytes: new TextEncoder().encode(text).length,
        mtimeMs: stat.mtimeMs,
      }
      await mutate($, run => {
        bump(run.events, 'classic.InstructionsLoaded')
        run.instructions.push(entry)
      })
    } catch {
      await mutate($, run => bump(run.events, 'classic.InstructionsLoaded.unreadable'))
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) await ensureCurrent($, 'turn-start-mismatch')
    await mutate($, run => {
      bump(run.events, 'turn.start')
      const agent = e.agentId === undefined ? undefined : run.agents[e.agentId]
      if (agent) agent.seen.start += 1
    })
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const loop = e.agentId ?? 'main'
    const now = await $.clock.now()
    let remote = 0
    let codex = 0
    let bash = 0
    for (const use of result.toolUses) {
      if (use.name !== 'Bash') continue
      const command = bashCommandOf(use.input)
      if (command === undefined) continue
      bash += 1
      if (isRemoteDirective(command)) remote += 1
      if (isCodexCli(command)) codex += 1
    }
    let status: string | undefined
    await mutate($, run => {
      bump(run.events, 'turn.step')
      const model = result.usage?.model ?? e.model
      const byModel = (run.usage[loop] ??= {})
      const u: ProbeUsage = (byModel[model] ??= { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, steps: 0, nullUsageSteps: 0 })
      u.steps += 1
      if (result.usage === null) u.nullUsageSteps += 1
      else {
        u.in += result.usage.input_tokens
        u.out += result.usage.output_tokens
        u.cacheRead += result.usage.cache_read_input_tokens
        u.cacheWrite += result.usage.cache_creation_input_tokens
      }
      run.steps.push({
        loop,
        turnId: e.turnId,
        index: e.index,
        model,
        ...(e.effort === undefined ? {} : { effort: String(e.effort) }),
        stopReason: result.stopReason,
        usage:
          result.usage === null
            ? null
            : {
                in: result.usage.input_tokens,
                out: result.usage.output_tokens,
                cacheRead: result.usage.cache_read_input_tokens,
                cacheWrite: result.usage.cache_creation_input_tokens,
              },
        tools: result.toolUses.map(t => t.name),
        at: now,
      })
      if (run.steps.length > STEP_CAP) run.steps.splice(0, run.steps.length - STEP_CAP)
      const tools = (run.requestedTools[loop] ??= {})
      for (const t of result.toolUses) bump(tools, t.name)
      run.classify.bashSteps += bash
      run.classify.remoteDirective += remote
      run.classify.codexCli += codex
      const agent = e.agentId === undefined ? undefined : run.agents[e.agentId]
      if (agent) agent.seen.steps += 1
      status = statusText(run)
      run.status.updates += 1
      run.status.last = status
    })
    if (status !== undefined) $.ui.status(status)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    await mutate($, run => {
      bump(run.events, 'turn.complete')
      mergePendingToolCalls(run)
      const loop = e.agentId ?? 'main'
      run.turns.push({
        loop,
        turnId: e.turnId,
        hadStart: run.steps.some(s => s.turnId === e.turnId),
        durationMs: e.durationMs,
        reason: e.reason,
        isAborted: e.isAborted,
        ...(e.usage ? { usageModel: e.usage.model } : {}),
      })
      if (run.turns.length > TURN_CAP) run.turns.splice(0, run.turns.length - TURN_CAP)
      if (e.isAborted) run.friction.abortedTurns += 1
      const agent = e.agentId === undefined ? undefined : run.agents[e.agentId]
      if (agent) agent.seen.complete += 1
    })
    await flush($)
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    // P0 test switch: a `.force-fg` file in the data dir asks for a foreground run.
    const { dir } = await dataDir($)
    const forceForeground = e.background && e.workflow === undefined && (await $.fs.exists(`${dir}/.force-fg`))
    const result = await next(forceForeground ? { ...e, background: false } : e)
    if (forceForeground) await mutate($, run => bump(run.events, 'agent.spawn.forcedForeground'))
    const now = await $.clock.now()
    await mutate($, run => {
      bump(run.events, 'agent.spawn')
      if (result.deny !== undefined || result.agentId === undefined) {
        run.spawnDenied += 1
        return
      }
      const prior = run.agents[result.agentId]
      run.agents[result.agentId] = {
        subagentType: e.subagentType,
        model: result.model,
        parentModel: e.parentModel,
        ...(e.parentAgentId ? { parentAgentId: e.parentAgentId } : {}),
        background: e.background,
        fork: e.fork,
        teammate: e.isTeammate === true,
        ...(e.workflow ? { workflowRunId: e.workflow.runId, workflowIndex: e.workflow.agentIndex } : {}),
        resumed: e.resume !== undefined,
        spawnedAt: now,
        seen: prior?.seen ?? { start: 0, steps: 0, complete: 0 },
      }
    })
    await flush($)
    return result
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined) pendingToolCalls.main += 1
    else pendingToolCalls.agent += 1
    bump(pendingToolCalls.byLoop, e.agentId === undefined ? 'main' : 'agent')
    const ran = await next(e)
    if (ran.deny !== undefined) bump(pendingToolCalls.byLoop, 'result:deny')
    else if (ran.isError === true) bump(pendingToolCalls.byLoop, 'result:error')
    return ran
  }).catch(($, e, next) => {
    bump(pendingToolCalls.reentry, next.error.kind)
    return next(e)
  })

  on('skill.prompt', async ($, e, next) => {
    await mutate($, run => bump(run.skills, e.skill))
    return next(e)
  })

  on('command.run', async ($, e, next) => {
    await mutate($, run => {
      bump(run.commands, e.command)
      run.commandArgsChars += e.args.length
    })
    return next(e)
  })

  on('command.run', { command: 'probe-status' }, async $ => {
    const run = await read($, RUN)
    if (run === null) return { text: 'debrief probe: no run.' }
    const loops = Object.keys(run.usage).length
    return {
      text: `debrief probe run ${run.runId}: ${run.steps.length} steps, ${run.turns.length} turns, ${loops} loops, ${Object.keys(run.agents).length} agents, reloads ${run.reloads}. ${statusText(run)}`,
    }
  })

  on('command.run', { command: 'probe-setup' }, async $ => {
    await mutate($, run => {
      run.setup.asked += 1
    })
    try {
      const label = await $.ui.ask('debrief probe: which test label should be stored?', {
        options: ['alpha', 'beta'],
        header: 'probe',
      })
      const stored = label === 'alpha' || label === 'beta' ? label : 'other'
      await $.store.set('setupAnswer', stored)
      await mutate($, run => {
        run.setup.answered += 1
        run.setup.answerLabel = stored
      })
      await flush($)
      return { text: `debrief probe: stored ${stored}.` }
    } catch (error) {
      await mutate($, run => {
        run.setup.error = error instanceof Error ? error.name : 'rejected'
      })
      await flush($)
      return { text: 'debrief probe: no answer.' }
    }
  })

  on('session.send', async ($, e, next) => {
    const result = await next(e)
    await mutate($, run => {
      bump(run.events, 'session.send')
      const slot = (run.messaging.sent[e.origin.kind] ??= { queued: 0, refused: 0 })
      if (result.isDelivered) slot.queued += 1
      else slot.refused += 1
    })
    return result
  })

  on('session.receive', async ($, e, next) => {
    await mutate($, run => {
      bump(run.events, 'session.receive')
      bump(run.messaging.received, e.origin.kind)
    })
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const now = await $.clock.now()
    await mutate($, run => {
      bump(run.events, 'session.measure')
      run.context.measures += 1
      if (e.context.percent !== undefined) run.context.lastPercent = e.context.percent
      if (e.cost !== undefined) run.cost = { usd: e.cost.usd, at: now, provenance: 'engine-ledger' }
    })
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    await mutate($, run => {
      run.friction.compactEvents += 1
    })
    return next(e)
  })

  on('classic.PreCompact', async ($, e, next) => {
    await mutate($, run => {
      run.friction.compactions += 1
    })
    return next(e)
  })

  on('classic.PostToolUseFailure', async ($, e, next) => {
    await mutate($, run => {
      run.friction.toolErrors += 1
      if (e.is_interrupt === true) run.friction.toolInterrupts += 1
    })
    return next(e)
  })

  on('classic.PermissionDenied', async ($, e, next) => {
    await mutate($, run => {
      run.friction.permissionDenied += 1
    })
    return next(e)
  })

  on('classic.StopFailure', async ($, e, next) => {
    await mutate($, run => {
      run.friction.stopFailures += 1
    })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    const now = await $.clock.now()
    let cost: number | undefined
    try {
      cost = (await $.session.usage()).cost?.usd
    } catch {
      cost = undefined
    }
    await mutate($, run => {
      bump(run.events, 'session.end')
      mergePendingToolCalls(run)
      run.endedAt = now
      run.endReason = e.reason
      if (cost !== undefined) run.cost = { usd: cost, at: now, provenance: 'engine-ledger' }
    })
    await flush($)
    return next(e)
  })
}
