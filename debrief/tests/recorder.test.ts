import { describe, expect, test } from 'claude-code/testing'

import { ROOT, SLUG, SPAWN, command, install, only, rawFiles, runFiles, start, step, turn, world } from './kit'

const U = (inN: number, out: number, cr: number, cw: number) => ({ in: inN, out, cacheRead: cr, cacheWrite: cw })
const USAGE = (u: ReturnType<typeof U>, steps: number, nullUsageSteps = 0) => ({ ...u, steps, nullUsageSteps })

describe('usage by model and loop, exact', () => {
  test('a turn that mixes two models keeps each model apart', async ($, on) => {
    const w = world()
    install(on, w)
    await start($, w)
    await turn($, w, {
      turnId: 't1',
      steps: [
        { model: 'm-big', usage: U(10, 20, 300, 40) },
        { model: 'm-small', usage: U(1, 2, 30, 4) },
        { model: 'm-big', usage: U(5, 6, 70, 8) },
        { model: 'm-big', usage: null },
      ],
    })
    const run = only(w)
    expect(run.usage).toEqual({
      main: { 'm-big': USAGE(U(15, 26, 370, 48), 3, 1), 'm-small': USAGE(U(1, 2, 30, 4), 1) },
    })
    expect(run.turns).toHaveLength(1)
    expect(run.steps.map(s => s.model)).toEqual(['m-big', 'm-small', 'm-big', 'm-big'])
  })

  test('an agent seen only at its completion is still an agent', async ($, on) => {
    const w = world()
    install(on, w)
    await start($, w)
    await $.turn.complete({ answer: '', durationMs: 700, isAborted: false, turnId: 'ta', reason: 'answer', agentId: 'ag-late' })
    const run = only(w)
    expect(run.agents['ag-late']).toMatchObject({ turns: 1, durationMs: 700, seen: { start: 0, steps: 0, complete: 1, spawn: 0 } })
    expect(run.usage).toEqual({})
    expect(run.turns[0]).toMatchObject({ loop: 'ag-late', durationMs: 700 })
    expect(run.turns[0]?.startedAt).toBeUndefined()
  })

  test('agent steps before the spawn result are merged, a replayed spawn counts once', async ($, on) => {
    const w = world()
    install(on, w)
    w.files.set(`${ROOT}/profile.json`, JSON.stringify({ externalAgentTypes: ['general-purpose'] }))
    await start($, w)
    // the agent's turn starts and steps before its spawn resolves (as observed in P0)
    await turn($, w, { turnId: 'tg', agentId: 'ag-1', steps: [{ model: 'm-sub', usage: U(2, 3, 4, 5) }] })
    await $.agent.spawn({ ...SPAWN })
    await $.agent.spawn({ ...SPAWN })
    await turn($, w, { turnId: 'tg2', agentId: 'ag-1', steps: [{ model: 'm-sub', usage: U(1, 1, 1, 1) }] })
    const run = only(w)
    expect(run.usage['ag-1']).toEqual({ 'm-sub': USAGE(U(3, 4, 5, 6), 2) })
    expect(run.agents['ag-1']).toMatchObject({
      subagentType: 'general-purpose',
      model: 'm-sub',
      parentModel: 'm-main',
      spawnAttempts: 2,
      turns: 2,
      seen: { start: 2, steps: 2, complete: 2, spawn: 2 },
    })
    expect(run.delegation.external).toEqual({ 'general-purpose': 1 })
  })

  test('a resumed agent is marked resumed', async ($, on) => {
    const w = world()
    install(on, w)
    await start($, w)
    w.spawn = { model: 'm-sub', agentId: 'ag-r' }
    await $.agent.spawn({ ...SPAWN, resume: { agentId: 'ag-r' } })
    expect(only(w).agents['ag-r']).toMatchObject({ resumed: true, spawnAttempts: 1 })
  })

  test('a denied spawn is counted and makes no agent', async ($, on) => {
    const w = world()
    install(on, w)
    await start($, w)
    w.spawn = { model: 'm-sub', deny: 'not allowed' }
    await $.agent.spawn({ ...SPAWN })
    const run = only(w)
    expect(run.spawnDenied).toBe(1)
    expect(run.agents).toEqual({})
  })

  test('two loops updating at once lose nothing', async ($, on) => {
    const w = world()
    install(on, w)
    await start($, w)
    const work: Promise<unknown>[] = []
    for (let i = 0; i < 8; i++) {
      work.push(step($, w, { turnId: 'tm', index: i, model: 'm-main', usage: U(1, 10, 100, 1000) }))
      work.push(step($, w, { turnId: 'ts', index: i, model: 'm-sub', usage: U(2, 20, 200, 2000), agentId: 'ag-2' }))
    }
    await Promise.all(work)
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'tm', reason: 'answer' })
    const run = only(w)
    expect(run.usage).toEqual({
      main: { 'm-main': USAGE(U(8, 80, 800, 8000), 8) },
      'ag-2': { 'm-sub': USAGE(U(16, 160, 1600, 16000), 8) },
    })
    expect(run.steps).toHaveLength(16)
  })
})

describe('runs and files', () => {
  test('/clear ends the run and opens a new one under the new session id', async ($, on) => {
    const w = world()
    const clock = install(on, w)
    await start($, w)
    await turn($, w, { turnId: 't1', steps: [{ model: 'm', usage: U(1, 1, 1, 1) }] })
    await clock.advance(1000)
    await $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: { id: 'sess-1' } as never })
    w.sessionId = 'sess-2'
    await $.classic.SessionStart({ source: 'clear' })
    await turn($, w, { turnId: 't2', steps: [{ model: 'm', usage: U(2, 2, 2, 2) }] })
    const [old, fresh] = runFiles(w)
    expect(old).toMatchObject({ sessionId: 'sess-1', run: { endReason: 'clear' } })
    expect(old?.usage).toEqual({ main: { m: USAGE(U(1, 1, 1, 1), 1) } })
    expect(fresh).toMatchObject({ sessionId: 'sess-2', run: { rotatedFrom: old?.runId } })
    expect(fresh?.classic.sessionStartSources).toEqual(['clear'])
    expect(fresh?.usage).toEqual({ main: { m: USAGE(U(2, 2, 2, 2), 1) } })
    expect([...w.files.keys()].some(k => k.startsWith(`${ROOT}/runs/${SLUG}/sess-2/`))).toBe(true)
  })

  test('a resume writes a new run file and leaves the old one untouched', async ($, on) => {
    const w = world()
    const clock = install(on, w)
    await start($, w)
    await turn($, w, { turnId: 't1', steps: [{ model: 'm', usage: U(1, 1, 1, 1) }] })
    await clock.advance(1000)
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 'sess-1', resume: { id: 'sess-1' } as never })
    const before = new Map(w.files)
    await start($, w)
    await turn($, w, { turnId: 't2', steps: [{ model: 'm', usage: U(5, 5, 5, 5) }] })
    const runs = runFiles(w)
    expect(runs).toHaveLength(2)
    expect(runs[0]?.runId).not.toBe(runs[1]?.runId)
    for (const [path, text] of before) if (path.includes('/runs/')) expect(w.files.get(path)).toBe(text)
    expect(runs[1]?.usage).toEqual({ main: { m: USAGE(U(5, 5, 5, 5), 1) } })
  })

  test('a reload continues the same run without resetting counts', async ($, on) => {
    const w = world()
    install(on, w)
    await start($, w)
    await turn($, w, { turnId: 't1', steps: [{ model: 'm', usage: U(1, 1, 1, 1) }] })
    await start($, w)
    await turn($, w, { turnId: 't2', steps: [{ model: 'm', usage: U(1, 1, 1, 1) }] })
    const run = only(w)
    expect(run.run.reloads).toBe(1)
    expect(run.usage).toEqual({ main: { m: USAGE(U(2, 2, 2, 2), 2) } })
  })

  test('a failed write is counted and the next write carries everything', async ($, on) => {
    const w = world()
    install(on, w)
    await start($, w)
    w.failWrites = 1
    await turn($, w, { turnId: 't1', steps: [{ model: 'm', usage: U(1, 2, 3, 4) }] })
    await turn($, w, { turnId: 't2', steps: [{ model: 'm', usage: U(1, 2, 3, 4) }] })
    const run = only(w)
    expect(run.writes.failed).toBe(1)
    expect(run.writes.lastError).toBeDefined()
    expect(run.usage).toEqual({ main: { m: USAGE(U(2, 4, 6, 8), 2) } })
  })

  test('the byte budget drops oldest steps first and keeps totals exact', async ($, on) => {
    const w = world()
    install(on, w)
    w.files.set(`${ROOT}/profile.json`, JSON.stringify({ limits: { byteBudget: 6000 } }))
    await start($, w)
    const steps = Array.from({ length: 60 }, () => ({ model: 'm', usage: U(1, 1, 1, 1) }))
    await turn($, w, { turnId: 't1', steps })
    const path = [...w.files.keys()].find(k => k.includes('/runs/')) ?? ''
    const text = w.files.get(path) ?? ''
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(6000)
    const run = only(w)
    expect(run.run.coverage).toBe('partial')
    expect(run.run.dropped.steps).toBeGreaterThan(0)
    expect(run.steps.length + run.run.dropped.steps).toBe(60)
    expect(run.usage).toEqual({ main: { m: USAGE(U(60, 60, 60, 60), 60) } })
  })
})

describe('privacy', () => {
  test('known strings in turn text, spawn prompt, tool input, command args and messages never reach a file', async ($, on) => {
    const w = world()
    install(on, w)
    w.files.set(`${ROOT}/profile.json`, JSON.stringify({ directives: [{ label: 'remote', pattern: 'ssh\\s+\\S+.*tmux\\s+send-keys' }] }))
    await start($, w)
    await turn($, w, {
      turnId: 't1',
      text: 'please CANARY-PROMPT now',
      steps: [
        {
          model: 'm',
          usage: U(1, 1, 1, 1),
          tools: [
            { name: 'Bash', input: { command: 'ssh host-x tmux send-keys -t w CANARY-TOOL Enter' } },
            { name: 'Read', input: { file_path: '/secret/CANARY-PATH.txt' } },
          ],
        },
      ],
    })
    await $.agent.spawn({ ...SPAWN })
    await $.tool.call({ tool: 'Bash', command: 'echo CANARY-TOOLCALL' } as never)
    await command($, 'some-command', 'CANARY-ARGS')
    await $.skill.prompt({ skill: 'a-skill', text: 'CANARY-SKILL' })
    await $.session.send({ to: 'peer', text: 'CANARY-SEND', origin: { kind: 'model' } })
    await $.session.receive({ origin: { kind: 'peer' }, text: 'CANARY-RECEIVE' })
    await $.session.end({ reason: 'other', sessionId: 'sess-1', resume: { id: 'sess-1' } as never })
    const all = rawFiles(w)
    expect(all).not.toContain('CANARY')
    expect(all).not.toContain('/secret')
    const run = only(w)
    expect(run.delegation.directives).toEqual({ remote: 1 })
    expect(run.commands).toEqual({ 'some-command': 1 })
    expect(run.skills).toEqual({ 'a-skill': 1 })
    expect(run.messaging).toEqual({ sent: { model: { queued: 1, refused: 0 } }, received: { peer: 1 } })
    expect(run.requestedToolCalls).toEqual({ main: { Bash: 1, Read: 1 } })
  })
})

describe('fingerprints, friction, profile', () => {
  test('an instruction file is fingerprinted by hash, with no path or text kept', async ($, on) => {
    const w = world()
    install(on, w)
    w.files.set('/home/u/proj/CLAUDE.md', 'rule one CANARY-RULE') // precheck: allow (fake home)
    await $.classic.InstructionsLoaded({ file_path: '/home/u/proj/CLAUDE.md', memory_type: 'Project', load_reason: 'session_start' }) // precheck: allow (fake home)
    await start($, w)
    const run = only(w)
    expect(run.instructions).toHaveLength(1)
    expect(run.instructions[0]).toMatchObject({ memoryType: 'Project', loadReason: 'session_start', bytes: 20, mtimeMs: 42 })
    expect(run.instructions[0]?.contentHash).toMatch(/^[0-9a-f]{16}$/)
    expect(rawFiles(w).replace('rule one CANARY-RULE', '')).not.toContain('CANARY')
    expect(JSON.stringify(run)).not.toContain('CLAUDE.md')
  })

  test('without the classic events the scan still fingerprints', async ($, on) => {
    const w = world()
    install(on, w)
    w.ancestors = [{ dir: '/work/proj', name: 'CLAUDE.md', content: 'project rules', parts: [] }]
    await start($, w)
    expect(only(w).instructions).toMatchObject([{ memoryType: 'Project', loadReason: 'scan', bytes: 13 }])
  })

  test('the four friction counters', async ($, on) => {
    const w = world()
    install(on, w)
    await $.classic.SessionStart({ source: 'startup' })
    await start($, w)
    await $.tool.call({ tool: 'Bash', command: 'exit 3' } as never)
    await $.classic.PostToolUseFailure({ tool_name: 'Bash', tool_input: {}, tool_use_id: 'x1', error: 'exit 3' })
    await $.tool.call({ tool: 'Write', file_path: '/x', content: '' } as never)
    await $.classic.PreCompact({ trigger: 'manual', custom_instructions: null })
    await turn($, w, { turnId: 't1', aborted: true, steps: [{ model: 'm', usage: null }] })
    const run = only(w)
    expect(run.friction).toEqual({ aborted: 1, toolErrors: 1, rejected: 1, compactions: 1 })
    expect(run.classic.sessionStartSources).toEqual(['startup'])
  })

  test('without the classic events the classic-backed counters are not measured', async ($, on) => {
    const w = world()
    install(on, w)
    await start($, w)
    await $.tool.call({ tool: 'Bash', command: 'exit 3' } as never)
    await turn($, w, { turnId: 't1', aborted: true, steps: [] })
    expect(only(w).friction).toEqual({ aborted: 1, toolErrors: null, rejected: null, compactions: null })
  })

  test('with no profile and no env beyond a home, it records to the default folder', async ($, on) => {
    const w = world()
    install(on, w, { HOME: '/home/u' }) // precheck: allow (fake home)
    await start($, w)
    await turn($, w, { turnId: 't1', steps: [{ model: 'm', usage: U(1, 1, 1, 1) }] })
    const paths = [...w.files.keys()]
    expect(paths.some(p => p.startsWith(`/home/u/.claude/debrief/runs/${SLUG}/sess-1/`))).toBe(true) // precheck: allow (fake home)
    const run = JSON.parse(w.files.get(paths.find(p => p.includes('/runs/')) ?? '') ?? '{}')
    expect(run.profileSource).toBe('default')
    expect(run.delegation).toEqual({ external: {}, directives: {} })
  })

  test('a Windows home is used when HOME is unset', async ($, on) => {
    const w = world()
    install(on, w, { USERPROFILE: 'C:\\Users\\u' })
    await start($, w)
    const keys = [...w.files.keys()]
    // a macOS engine reads a drive path as relative; the path debrief built is what counts
    expect(keys.some(p => p.includes('C:\\Users\\u\\.claude\\debrief\\runs\\-work-proj\\sess-1\\')), keys.join(' | ')).toBe(true)
  })
})

describe('commands, status, cost', () => {
  test('tag marks later turns, the summary reads numbers, setup skips without a person', async ($, on) => {
    const w = world()
    w.isInteractive = false
    install(on, w)
    await start($, w)
    const tagged = await command($, 'debrief', 'tag phase-a')
    expect(tagged.text).toContain('phase-a')
    await turn($, w, { turnId: 't1', steps: [{ model: 'm', usage: U(1000, 2000, 3000, 4000) }] })
    const run = only(w)
    expect(run.tags).toMatchObject([{ label: 'phase-a', turnIndex: 0 }])
    expect(run.turns[0]?.tag).toBe('phase-a')
    expect((await command($, 'debrief', '')).text).toContain('out 2k')
    expect((await command($, 'debrief', 'setup')).text).toContain('skipped')
  })

  test('setup speaks the terminal locale before a profile chooses: ko_KR answers Korean, LC_ALL wins', async ($, on) => {
    const w = world()
    w.isInteractive = false
    install(on, w, { HOME: '/home/u', DEBRIEF_DIR: ROOT, LANG: 'ko_KR.UTF-8' }) // precheck: allow (fake home)
    await start($, w)
    const skipped = (await command($, 'debrief', 'setup')).text
    expect(skipped).toContain('건너뜁니다')
    expect(skipped).toContain('skipped')
  })

  test('setup falls back to English for a non-Korean locale and cancels in that language when nobody answers', async ($, on) => {
    const w = world()
    install(on, w, { HOME: '/home/u', DEBRIEF_DIR: ROOT, LC_ALL: 'en_US.UTF-8', LANG: 'ko_KR.UTF-8' }) // precheck: allow (fake home)
    await start($, w)
    // The harness fails every tool call, so the first question rejects and setup cancels.
    const text = (await command($, 'debrief', 'setup')).text
    expect(text).toContain('cancelled')
    expect(w.files.has(`${ROOT}/profile.json`)).toBe(false)
  })

  test('the status line shows totals and the main share, and cost keeps start and end', async ($, on) => {
    const w = world()
    w.usd = 1.5
    install(on, w)
    await start($, w)
    await turn($, w, { turnId: 't1', steps: [{ model: 'm', usage: U(100, 200, 300, 400) }] })
    await $.session.measure({ context: { window: 200000, percent: 12 }, rateLimits: [], cost: { usd: 1.75 }, changed: ['cost'] })
    const run = only(w)
    expect(w.statuses.at(-1)).toBe('in 800 out 200 · 0m · main 100%')
    expect(run.cost).toMatchObject({ usdAtStart: 1.5, usdAtEnd: 1.75, provenance: 'engine-ledger' })
    expect(run.context).toEqual({ percent: 12, window: 200000 })
  })
})
