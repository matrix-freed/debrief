import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DebriefInstruction, DebriefProfile, DebriefRun } from '../types'
import { readInsights } from './insights'
import { join, places, profileFile, runFile, sessionDir, slugOf } from './paths'
import type { Places } from './paths'
import { DEFAULT_PROFILE, directiveLabels, normalizeProfile } from './profile'
import { report, REPORT_HINT, REPORT_USAGE } from './report'
import {
  addInstruction,
  addStep,
  applySpawn,
  completeTurn,
  emptyRun,
  serialize,
  startTurn,
  statusText,
  summaryText,
} from './record'

// debrief: a metadata-only recorder. One file per process run under
// <root>/runs/<project-slug>/<sessionId>/<runId>.json, rewritten whole.

type $ = EngineInterface

const RUN_REF = { plugin: 'debrief', key: 'run' } as const
const RUN = atom(RUN_REF, null as DebriefRun | null)

const TAG_MAX = 80

// Module state: rebuilt on every load; the record itself lives in $.state.
let profile: DebriefProfile = DEFAULT_PROFILE
let profileSource: DebriefRun['profileSource'] = 'default'
let placesCache: Places | undefined
let early: ((run: DebriefRun) => void)[] = []
// Every change bumps `generation`; a write records the generation it read.
// The record is dirty while the two differ (Codex review 4).
let generation = 0
let writtenGeneration = 0
let rotating: Promise<void> | null = null
// Which run is installed, as this module last set it. `$.state.get` reads one
// moment per dispatch, so a dispatch that waited on a rotation cannot see it
// there; and a /clear starts the session's state over (observed live), so
// the run it ended is only known here.
type Live = { sessionId: string; runId: string; isInteractive: boolean; isEnded: boolean }
let live: Live | null = null
const liveOf = (run: DebriefRun): Live => ({
  sessionId: run.sessionId,
  runId: run.runId,
  isInteractive: run.run.isInteractive,
  isEnded: run.run.endedAt !== undefined,
})
let writing: Promise<void> | null = null
let writeAgain = false
const writes = { ok: 0, failed: 0, lastError: undefined as string | undefined }
let checkpoint: { cancel: () => void } | undefined
// Re-entry kinds are counted where `$` cannot be called (a tool.call .catch)
// and folded into the record later as a fixed batch (Codex review 1, 6).
let reentry: Record<string, number> = {}

const where = async ($: $): Promise<Places> => (placesCache ??= await places($))

const hex4 = () => {
  const bytes = new Uint8Array(2)
  crypto.getRandomValues(bytes)
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
}

const sha = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('')
}

const errorName = (error: unknown) => (error instanceof Error ? error.name : 'unknown')

const isDirty = () => generation !== writtenGeneration

// Recording never stands between an event and the rest of its chain.
const guard = async (work: () => Promise<void>) => {
  try {
    await work()
  } catch {
    // fail-open
  }
}

// Applies fn to the live run. With no run yet (events before session.start,
// P0) the change waits in `early` and is applied when the run is made.
const mutate = async ($: $, fn: (run: DebriefRun) => void) => {
  let isDeferred = false
  await update($, RUN, run => {
    if (run === null) {
      isDeferred = true
      return run
    }
    isDeferred = false
    const copy = structuredClone(run) as DebriefRun
    fn(copy)
    return copy
  })
  if (isDeferred) early.push(fn)
  generation += 1
}

const applyEarly = (run: DebriefRun) => {
  for (const fn of early) fn(run)
  early = []
}

// Applies what arrived while no run was installed, as one fixed batch.
const drainEarly = async ($: $) => {
  if (early.length === 0) return
  const batch = early
  early = []
  await mutate($, run => {
    for (const fn of batch) fn(run)
  })
}

const writeOnce = async ($: $) => {
  const seen = generation
  const run = await read($, RUN)
  if (run === null) return
  const p = await where($)
  const now = await $.clock.now()
  const withWrites: DebriefRun = {
    ...run,
    writes: { ok: writes.ok + 1, failed: writes.failed, ...(writes.lastError ? { lastError: writes.lastError } : {}) },
  }
  const { text } = serialize(withWrites, profile, now)
  try {
    await $.fs.write(runFile(p, run.project.slug, run.sessionId, run.runId), text)
    writes.ok += 1
    writtenGeneration = Math.max(writtenGeneration, seen)
  } catch (error) {
    writes.failed += 1
    writes.lastError = errorName(error)
  }
}

// One write in flight; a flush asked for meanwhile runs once more after it.
const flush = ($: $): Promise<void> => {
  if (writing) {
    writeAgain = true
    return writing
  }
  writing = (async () => {
    do {
      writeAgain = false
      await writeOnce($)
    } while (writeAgain)
  })()
    .catch(() => undefined)
    .finally(() => {
      writing = null
    })
  return writing
}

const loadProfile = async ($: $, p: Places) => {
  try {
    const path = profileFile(p)
    if (await $.fs.exists(path)) {
      const { profile: loaded, isValid } = normalizeProfile(JSON.parse(await $.fs.read(path)))
      profile = loaded
      profileSource = isValid ? 'file' : 'invalid'
      return
    }
    const stored = await $.store.get('profile')
    if (stored !== undefined) {
      const { profile: loaded, isValid } = normalizeProfile(stored)
      profile = loaded
      profileSource = isValid ? 'store' : 'invalid'
      return
    }
  } catch {
    profileSource = 'invalid'
  }
  profile = DEFAULT_PROFILE
  if (profileSource !== 'invalid') profileSource = 'default'
}

const newRun = async ($: $, surface: string | null, isInteractive: boolean, rotatedFrom?: string): Promise<DebriefRun> => {
  const now = await $.clock.now()
  let usdAtStart: number | undefined
  try {
    usdAtStart = (await $.session.usage()).cost?.usd
  } catch {
    usdAtStart = undefined
  }
  return emptyRun({
    sessionId: await $.session.id(),
    runId: `${now}-${hex4()}`,
    now,
    engine: (await $.session.version()).version,
    slug: slugOf(await $.session.cwd()),
    projectId: (await $.env.get('DEBRIEF_PROJECT')) ?? undefined,
    parentSessionId: (await $.env.get('DEBRIEF_PARENT_SESSION')) ?? undefined,
    surface,
    isInteractive,
    usdAtStart,
    rotatedFrom,
    profileSource,
  })
}

// After a /clear the process goes on under a new session id with no
// session.start: the first sign of it opens a new run.
// One rotation at a time; each caller checks again once the one before it
// is done, so two first signs never install two runs (Codex review 2).
const ensureCurrent = async ($: $) => {
  const isCurrent = async () => {
    if (live === null) {
      const run = await read($, RUN)
      if (run !== null) live = liveOf(run)
    }
    return live !== null && live.sessionId === (await $.session.id()) && !live.isEnded
  }
  for (;;) {
    while (rotating) await rotating
    if (await isCurrent()) return
    // no await between this check and the claim below
    if (rotating === null) break
  }
  rotating = (async () => {
    if (await isCurrent()) return
    const old = live
    const surface = await $.session.surface()
    const next = await newRun($, surface, old?.isInteractive ?? surface !== null, old?.runId)
    applyEarly(next)
    await $.state.set(RUN_REF, next)
    live = liveOf(next)
    generation += 1
  })().finally(() => {
    rotating = null
  })
  await rotating
  await drainEarly($)
  await flush($)
}

// Fingerprints when the engine's InstructionsLoaded did not reach us (an
// organization-managed install): the files the engine would load. Hashes only.
const scanInstructions = async ($: $, p: Places): Promise<DebriefInstruction[]> => {
  const out: DebriefInstruction[] = []
  try {
    const found = await $.fs.ancestors({ names: ['CLAUDE.md', 'CLAUDE.local.md'] })
    const files = found.map(f => ({ path: join(p.sep, f.dir, f.name), text: f.content, memoryType: 'Project' }))
    const userFile = join(p.sep, p.configDir, 'CLAUDE.md')
    if (await $.fs.exists(userFile)) files.push({ path: userFile, text: await $.fs.read(userFile), memoryType: 'User' })
    for (const f of files) {
      const stat = await $.fs.stat(f.path).catch(() => undefined)
      out.push({
        memoryType: f.memoryType,
        loadReason: 'scan',
        pathHash: await sha(f.path),
        contentHash: await sha(f.text),
        bytes: new TextEncoder().encode(f.text).length,
        mtimeMs: stat?.mtimeMs ?? 0,
      })
    }
  } catch {
    // fail-open: no fingerprint is better than a failed session start
  }
  return out
}

// Takes the re-entry counts out as a fixed batch, so a retried state update
// reads the same numbers, and puts them back if the update fails.
const foldReentry = async ($: $) => {
  if (Object.keys(reentry).length === 0) return
  const batch = reentry
  reentry = {}
  try {
    await mutate($, run => {
      for (const [kind, n] of Object.entries(batch)) run.toolCalls.reentry[kind] = (run.toolCalls.reentry[kind] ?? 0) + n
    })
  } catch {
    for (const [kind, n] of Object.entries(batch)) reentry[kind] = (reentry[kind] ?? 0) + n
  }
}

const commandOf = (input: unknown): string | undefined => {
  if (typeof input !== 'object' || input === null) return undefined
  const command = (input as { command?: unknown }).command
  return typeof command === 'string' ? command : undefined
}

const sessionSummary = async ($: $): Promise<string> => {
  const current = await read($, RUN)
  const now = await $.clock.now()
  if (current === null) return summaryText([], now)
  const runs: DebriefRun[] = []
  try {
    const p = await where($)
    const dir = sessionDir(p, current.project.slug, current.sessionId)
    for (const entry of await $.fs.list(dir)) {
      if (!entry.name.endsWith('.json') || entry.name === `${current.runId}.json`) continue
      try {
        runs.push(JSON.parse(await $.fs.read(join(p.sep, dir, entry.name))) as DebriefRun)
      } catch {
        continue
      }
    }
  } catch {
    // only the live run
  }
  runs.push(current)
  runs.sort((a, b) => a.run.startedAt - b.run.startedAt)
  return summaryText(runs, now)
}

// `/debrief setup`: show what was detected, ask what cannot be detected
// (six questions at most), save the profile to the store and the profile file.
const setup = async ($: $): Promise<string> => {
  const run = await read($, RUN)
  if (run === null || !run.run.isInteractive) return 'setup needs an interactive session; skipped.'
  const p = await where($)
  const insights = await readInsights($, p)
  const models = Object.keys(Object.assign({}, ...Object.values(run.usage)))
  const os = p.sep === '\\' ? 'Windows' : 'macOS/Linux'
  const detected = [
    `system ${os}`,
    `models this session: ${models.length > 0 ? models.join(', ') : 'none yet'}`,
    `subagents this session: ${Object.keys(run.agents).length}`,
    insights.available ? `${insights.sessions} recent sessions on file, ${insights.taskAgentSessions} used subagents` : 'no /insights data found',
  ].join('; ')
  const next: DebriefProfile = structuredClone(profile)
  try {
    const keep = await $.ui.ask(`debrief detected: ${detected}. Keep the current profile as the starting point?`, {
      options: ['Keep', 'Start neutral'],
      header: 'debrief',
    })
    if (keep === 'Start neutral') Object.assign(next, structuredClone(DEFAULT_PROFILE))
    const language = await $.ui.ask('Which language should reports use?', { options: ['en', 'ko'], header: 'Language' })
    if (language === 'en' || language === 'ko') next.language = language
    const use = await $.ui.ask('What are the after-action reviews mainly for?', { options: ['personal', 'project', 'team'], header: 'AAR use' })
    if (use === 'personal' || use === 'project' || use === 'team') next.aarUse = use
    const share = await $.ui.ask('May reports you pick be exported to share? (records stay on this machine either way)', {
      options: ['No', 'Yes'],
      header: 'Sharing',
    })
    next.shareConsent = share === 'Yes'
    const style = await $.ui.ask('How eager should hypothesis cards be?', { options: ['conservative', 'standard'], header: 'Thresholds' })
    if (style === 'conservative' || style === 'standard') next.thresholdStyle = style
    const lane = await $.ui.ask('What do you call your main session lane? Type a name under Other, or skip.', {
      options: ['main', 'Skip'],
      header: 'Main lane',
    })
    if (lane !== 'Skip' && lane.trim() !== '') next.mainLane = lane.trim().slice(0, 40)
  } catch {
    return 'setup cancelled; the profile is unchanged.'
  }
  try {
    await $.store.set('profile', next)
    await $.fs.write(profileFile(p), JSON.stringify(next, null, 2))
  } catch (error) {
    return `setup could not save the profile (${errorName(error)}).`
  }
  profile = next
  profileSource = 'file'
  await mutate($, r => {
    r.profileSource = 'file'
  })
  return 'profile saved. Edit lanes, directives and machines in the profile file; run /debrief setup again any time.'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await guard(async () => {
      const p = await where($)
      await loadProfile($, p)
      const sid = await $.session.id()
      const current = await read($, RUN)
      if (current !== null && current.sessionId === sid && current.run.endedAt === undefined) {
        writes.ok = current.writes.ok
        writes.failed = current.writes.failed
        live = liveOf(current)
        await mutate($, run => {
          run.run.reloads += 1
        })
      } else {
        // Install the run first, then fingerprint: events that arrive meanwhile
        // land on the installed run, not in a buffer nobody drains (Codex review 5).
        const run = await newRun($, e.surface, e.isInteractive)
        applyEarly(run)
        await $.state.set(RUN_REF, run)
        live = liveOf(run)
        generation += 1
        await drainEarly($)
        if (run.instructions.length === 0) {
          const found = await scanInstructions($, p)
          if (found.length > 0)
            await mutate($, r => {
              if (r.instructions.length === 0) for (const i of found) addInstruction(r, i)
            })
        }
      }
    })
    await guard(async () => {
      await $.command.register({
        name: 'debrief',
        description: '세션 요약, 태그, 프로필 설정, AAR, 백필, 압축 및 개선 장부',
        argumentHint: REPORT_HINT,
        immediate: true,
      })
      checkpoint?.cancel()
      checkpoint = $.clock.every(profile.limits.checkpointMs, () => {
        if (isDirty()) void flush($)
      })
      await flush($)
    })
    return next(e)
  })

  on('classic.SessionStart', async ($, e, next) => {
    await guard(async () => {
      if (e.source === 'clear') await ensureCurrent($)
      await mutate($, run => {
        run.classic.seen = true
        run.classic.sessionStartSources.push(e.source)
      })
    })
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.InstructionsLoaded', async ($, e, next) => {
    await guard(async () => {
      let entry: DebriefInstruction | undefined
      try {
        const [text, stat] = await Promise.all([$.fs.read(e.file_path), $.fs.stat(e.file_path)])
        entry = {
          memoryType: e.memory_type,
          loadReason: e.load_reason,
          pathHash: await sha(e.file_path),
          contentHash: await sha(text),
          bytes: new TextEncoder().encode(text).length,
          mtimeMs: stat.mtimeMs,
        }
      } catch {
        entry = undefined
      }
      await mutate($, run => {
        run.classic.seen = true
        if (entry) addInstruction(run, entry)
      })
    })
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    await guard(async () => {
      if (e.agentId === undefined) await ensureCurrent($)
      const now = await $.clock.now()
      await mutate($, run => startTurn(run, e.agentId ?? 'main', e.turnId, now))
    })
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    await guard(async () => {
      const now = await $.clock.now()
      const labels: string[] = []
      for (const use of result.toolUses) {
        const command = commandOf(use.input)
        if (command !== undefined) labels.push(...directiveLabels(profile, command))
      }
      let status: string | undefined
      await mutate($, run => {
        addStep(
          run,
          {
            loop: e.agentId ?? 'main',
            turnId: e.turnId,
            index: e.index,
            model: result.usage?.model ?? e.model,
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
            toolNames: result.toolUses.map(t => t.name),
            serverToolNames: (result.serverToolUses ?? []).map(t => t.name),
            directiveLabels: labels,
            at: now,
          },
          profile,
        )
        if (run.run.isInteractive) status = statusText(run, now)
      })
      if (status !== undefined) $.ui.status(status)
    })
    return result
  })

  on('turn.complete', async ($, e, next) => {
    await guard(async () => {
      const now = await $.clock.now()
      await foldReentry($)
      await mutate($, run =>
        completeTurn(
          run,
          { loop: e.agentId ?? 'main', turnId: e.turnId, durationMs: e.durationMs, reason: e.reason, aborted: e.isAborted, at: now },
          profile,
        ),
      )
      await flush($)
    })
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    await guard(async () => {
      const now = await $.clock.now()
      await mutate($, run =>
        applySpawn(
          run,
          {
            ...(result.agentId === undefined ? {} : { agentId: result.agentId }),
            isDenied: result.deny !== undefined,
            subagentType: e.subagentType,
            ...(result.model === undefined ? {} : { model: result.model }),
            parentModel: e.parentModel,
            ...(e.parentAgentId === undefined ? {} : { parentAgentId: e.parentAgentId }),
            background: e.background,
            fork: e.fork,
            teammate: e.isTeammate === true,
            ...(e.workflow ? { workflow: e.workflow } : {}),
            resumed: e.resume !== undefined,
            at: now,
          },
          profile,
        ),
      )
      await flush($)
    })
    return result
  }).catch(($, e, next) => next(e))

  // Counts go straight into the record once the call settled, so a reload
  // between a call and its turn's end loses nothing (Codex review 6).
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    await guard(() =>
      mutate($, run => {
        if (e.agentId === undefined) run.toolCalls.main += 1
        else run.toolCalls.agent += 1
        if (ran.deny !== undefined) run.toolCalls.denied += 1
        else if (ran.isError === true) run.toolCalls.isError += 1
      }),
    )
    return ran
  }).catch(($, e, next) => {
    reentry[next.error.kind] = (reentry[next.error.kind] ?? 0) + 1
    return next(e)
  })

  on('classic.PostToolUseFailure', async ($, e, next) => {
    await guard(() =>
      mutate($, run => {
        run.classic.seen = true
        run.classic.postToolUseFailures += 1
        if (e.is_interrupt === true) run.classic.interrupts += 1
      }),
    )
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.PreCompact', async ($, e, next) => {
    await guard(() =>
      mutate($, run => {
        run.classic.seen = true
        run.classic.compactions += 1
      }),
    )
    return next(e)
  }).catch(($, e, next) => next(e))

  on('skill.prompt', async ($, e, next) => {
    await guard(() =>
      mutate($, run => {
        run.skills[e.skill] = (run.skills[e.skill] ?? 0) + 1
      }),
    )
    return next(e)
  })

  on('command.run', async ($, e, next) => {
    await guard(() =>
      mutate($, run => {
        run.commands[e.command] = (run.commands[e.command] ?? 0) + 1
      }),
    )
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'debrief' }, async ($, e) => {
    // Arguments are read by debrief's own command only; a tag label is the
    // one piece of typed text debrief keeps (local only, never exported).
    const args = e.args.trim()
    if (args === '') return { text: await sessionSummary($) }
    if (args === 'setup') return { text: await setup($) }
    const tag = /^tag\s+(\S[\s\S]*)$/.exec(args)
    if (tag?.[1] !== undefined) {
      const label = tag[1].trim().slice(0, TAG_MAX)
      const now = await $.clock.now()
      await mutate($, run => {
        run.tags.push({ label, at: now, turnIndex: run.turns.length })
      })
      await flush($)
      return { text: `phase tagged "${label}".` }
    }
    return { text: (await report($, args)) ?? REPORT_USAGE }
  })

  on('session.send', async ($, e, next) => {
    const result = await next(e)
    await guard(() =>
      mutate($, run => {
        const slot = (run.messaging.sent[e.origin.kind] ??= { queued: 0, refused: 0 })
        if (result.isDelivered) slot.queued += 1
        else slot.refused += 1
      }),
    )
    return result
  }).catch(($, e, next) => next(e))

  on('session.receive', async ($, e, next) => {
    await guard(() =>
      mutate($, run => {
        run.messaging.received[e.origin.kind] = (run.messaging.received[e.origin.kind] ?? 0) + 1
      }),
    )
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    await guard(async () => {
      const now = await $.clock.now()
      await mutate($, run => {
        if (e.context.percent !== undefined) run.context.percent = e.context.percent
        run.context.window = e.context.window
        if (e.cost !== undefined) {
          run.cost.usdAtEnd = e.cost.usd
          run.cost.at = now
          run.cost.provenance = 'engine-ledger'
        }
      })
      if (e.changed.includes('cost')) await flush($)
    })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await guard(async () => {
      const now = await $.clock.now()
      let usd: number | undefined
      try {
        usd = (await $.session.usage()).cost?.usd
      } catch {
        usd = undefined
      }
      await foldReentry($)
      if (live !== null) live = { ...live, isEnded: true }
      await mutate($, run => {
        run.run.endedAt = now
        run.run.endReason = e.reason
        if (usd !== undefined) {
          run.cost.usdAtEnd = usd
          run.cost.at = now
          run.cost.provenance = 'engine-ledger'
        }
      })
      await flush($)
    })
    return next(e)
  })
}
