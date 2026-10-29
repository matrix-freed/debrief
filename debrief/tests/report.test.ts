import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, ProcessRunInit } from 'claude-code'
import { slugOf } from '../hooks/paths'
import { CARDS_EMPTY, CARDS_EMPTY_QUIET, CARDS_FAILED, CARDS_PROMPT } from '../hooks/report'
import { CWD, PRESENT, ROOT, SLUG, command, install, start, turn, world } from './kit'
import type { World } from './kit'

const OK = { exitCode: 0, stdout: '요약\nRESULT {"output":"/data/result.html"}\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
const ENV = { HOME: '/home/u', DEBRIEF_DIR: ROOT, DEBRIEF_REPORT_DIR: '/program/report', CLAUDE_CONFIG_DIR: '/config' } // precheck: allow (fake home)

for (const sub of ['aar', 'backfill', 'compact', 'ledger']) {
  test(`${sub} 고정 argv와 타임아웃`, async ($, on) => {
    const w = world()
    const clock = install(on, w, ENV)
    const now = new Date(2026, 9, 15, 9, 7).getTime()
    await clock.advance(now - clock.now())
    const calls: { argv: readonly string[]; init?: ProcessRunInit }[] = []
    on('process.run', (_, e) => {
      calls.push(e)
      return { value: OK }
    })
    await start($, w)
    const user = sub === 'aar' ? '--from 2026-07-01 --to 2026-10-15 --cards "cards file.json"' : sub === 'backfill' ? '--days 7' : sub === 'compact' ? '--dry-run' : 'set item-1 verified'
    const result = await command($, 'debrief', `${sub} ${user}`)
    const fixed = ['python3', '/program/report', sub, '--root', ROOT]
    if (sub === 'aar' || sub === 'backfill') fixed.push('--project', SLUG, '--config', '/config')
    if (sub === 'aar') fixed.push('--out', `${ROOT}/aar/${SLUG}/2026-10-15-0907.html`, '--from', '2026-07-01', '--to', '2026-10-15', '--cards', `${CWD}/cards file.json`)
    if (sub === 'backfill') fixed.push('--exclude-session', 'sess-1', '--days', '7')
    if (sub === 'compact') fixed.push('--dry-run')
    if (sub === 'ledger') fixed.push('set', 'item-1', 'verified')
    expect(calls).toEqual([{ argv: fixed, init: { cwd: ROOT, timeoutMs: sub === 'compact' ? 300000 : sub === 'ledger' ? 30000 : 600000 } }])
    expect(result.text).toBe('RESULT {"output":"/data/result.html"}')
  })
}

test('aar는 이 세션의 기록 파일을 먼저 쓴 뒤 리포트 프로그램을 실행하고, 실패 때 RESULT 줄을 보여 준다', async ($, on) => {
  const w = world()
  install(on, w, ENV)
  const seen: string[] = []
  on('process.run', () => {
    // At this moment the run file must be complete JSON that already holds the turn below.
    const path = [...w.files.keys()].find(k => k.startsWith(`${ROOT}/runs/`))
    seen.push(path === undefined ? 'missing' : JSON.parse(w.files.get(path) ?? '').turns.length)
    return { value: { ...OK, exitCode: 2, stdout: 'RESULT {"error":"입력 또는 출력 오류","cause":"JSONDecodeError"}\n', stderr: 'JSONDecodeError: Unterminated string\n' } }
  })
  await start($, w)
  await turn($, w, { turnId: 't1', steps: [{ model: 'm', usage: { in: 1, out: 1, cacheRead: 0, cacheWrite: 0 } }] })
  const text = (await command($, 'debrief', 'aar')).text
  expect(seen).toEqual([1])
  expect(text).toContain('실패(exit 2)')
  expect(text).toContain('JSONDecodeError')
  expect(text).toContain('RESULT {"error"')
})

test('허용되지 않은 플래그와 잘못된 값은 실행하지 않는다', async ($, on) => {
  const w = world()
  install(on, w, ENV)
  let calls = 0
  on('process.run', () => { calls += 1; return { value: OK } })
  await start($, w)
  for (const args of ['aar --root /other', 'aar --out /other', 'aar --cards', 'aar --cards "open', 'backfill --days 0', 'backfill --days -1', 'backfill --days NaN', 'backfill --exclude-session other', 'compact --yes', 'compact --days 2', 'ledger set ab applied', 'ledger set ITEM-1 applied', 'ledger set item-1 unknown', 'ledger list --status unknown', 'ledger set item-1 applied extra', 'aar --from --to', 'compact --dry-run extra', 'aar --cards C:cards.json']) {
    expect((await command($, 'debrief', args)).text).toContain('허용되지 않은 인자')
  }
  expect(calls).toBe(0)
})

test('ledger 기본 list와 상태 필터', async ($, on) => {
  const w = world()
  install(on, w, ENV)
  const calls: (readonly string[])[] = []
  on('process.run', (_, e) => { calls.push(e.argv); return { value: OK } })
  await start($, w)
  await command($, 'debrief', 'ledger')
  await command($, 'debrief', 'ledger list --status proposed')
  expect(calls).toEqual([
    ['python3', '/program/report', 'ledger', '--root', ROOT, 'list'],
    ['python3', '/program/report', 'ledger', '--root', ROOT, 'list', '--status', 'proposed'],
  ])
})

test('exit 실패는 대체 실행 없이 stderr 20줄과 잘림을 표시한다', async ($, on) => {
  const w = world()
  install(on, w, ENV)
  let calls = 0
  on('process.run', () => {
    calls += 1
    return { value: { ...OK, exitCode: 1, stderr: Array.from({ length: 22 }, (_, i) => `line-${i + 1}`).join('\n'), isStdoutTruncated: true } }
  })
  await start($, w)
  const text = (await command($, 'debrief', 'compact')).text
  expect(text).toContain('실패(exit 1)')
  expect(text).toContain('line-20')
  expect(text).not.toContain('line-21')
  expect(text).toContain('출력 잘림')
  expect(calls).toBe(1)
})

test('두 실행기 시작 실패는 안내로 끝난다', async ($, on) => {
  const w = world()
  install(on, w, ENV)
  const calls: (readonly string[])[] = []
  on('process.run', (_, e) => { calls.push(e.argv); throw new Error('start failed') })
  await start($, w)
  expect((await command($, 'debrief', 'compact')).text).toBe('python3가 필요합니다 — 설치 안내: https://www.python.org/downloads/')
  expect(calls).toEqual([
    ['python3', '/program/report', 'compact', '--root', ROOT],
    ['py', '-3', '/program/report', 'compact', '--root', ROOT],
  ])
})

test('python3 시작 실패 후 py -3 성공', async ($, on) => {
  const w = world()
  install(on, w, ENV)
  const calls: (readonly string[])[] = []
  on('process.run', (_, e) => {
    calls.push(e.argv)
    if (e.argv[0] === 'python3') throw new Error('start failed')
    return { value: { ...OK, isStdoutTruncated: true } }
  })
  await start($, w)
  expect((await command($, 'debrief', 'compact --dry-run')).text).toBe('RESULT {"output":"/data/result.html"}\n출력 잘림')
  expect(calls).toEqual([
    ['python3', '/program/report', 'compact', '--root', ROOT, '--dry-run'],
    ['py', '-3', '/program/report', 'compact', '--root', ROOT, '--dry-run'],
  ])
})

test('기본 프로그램 경로는 플러그인 아래이며 slug는 점과 밑줄도 치환한다', async ($, on) => {
  const w = world()
  install(on, w)
  let program = ''
  on('process.run', (_, e) => { program = e.argv[1] ?? ''; return { value: OK } })
  await start($, w)
  await command($, 'debrief', 'compact')
  expect(program).toMatch(/[/\\]tools[/\\]debrief_report$/)
  expect(slugOf('/work/project.one_two')).toBe('-work-project-one-two')
})

// P4: an AAR made without cards asks the person, through a turn the plugin submits.
const NOW = new Date(2026, 9, 15, 9, 7).getTime()
const OUT = `${ROOT}/aar/${SLUG}/2026-10-15-0907.html`
const CARDS = `${ROOT}/aar/${SLUG}/2026-10-15-0907.cards.json`

const asking = async ($: Engine, on: On, w: World = world(), env: Record<string, string> = ENV, answer = OK) => {
  const clock = install(on, w, env)
  await clock.advance(NOW - clock.now())
  const calls: (readonly string[])[] = []
  const submits: { text: string; origin: unknown }[] = []
  on('process.run', (_, e) => { calls.push(e.argv); return { value: answer } })
  const logs: string[] = []
  on('prompt.submit', (_, e) => { submits.push({ text: e.text, origin: e.origin }); return { text: e.text } })
  on('ui.log', (_, e) => { logs.push(e.text); return { value: undefined } })
  await start($, w)
  return { calls, submits, clock, logs }
}



test('카드 없이 만든 AAR은 질문 지시를 모델 메모로 남기고 질문 턴을 제출한다', async ($, on) => {
  const { calls, submits, clock } = await asking($, on)
  const result = await command($, 'debrief', 'aar --from 2026-07-01 --to 2026-10-15')
  await clock.advance(1)
  expect(result.text).toBe(`RESULT {"output":"/data/result.html"}\n${CARDS_EMPTY}`)
  expect(result.context?.length).toBe(1)
  const note = result.context?.[0] ?? ''
  expect(note).toContain('AskUserQuestion')
  expect(note).toContain("AAR '계획·실제·차이·개선' 칸이 비어 있습니다. 어떻게 할까요?")
  expect(note).toContain('이 세션 내용으로 카드 작성 후 다시 생성 (권장)')
  expect(note).toContain('숫자만 두기')
  expect(note).toContain(`Write로 ${CARDS} 에 쓴다`)
  expect(note).toContain('"improvements"는 넣지 않는다')
  // The regeneration line is the same run plus --cards, ready to paste into a shell.
  const run = ['python3', '/program/report', 'aar', '--root', ROOT, '--project', SLUG, '--config', '/config', '--out', OUT, '--from', '2026-07-01', '--to', '2026-10-15']
  expect(calls).toEqual([run])
  expect(note).toContain(`Bash로 그대로 실행한다: ${[...run, '--cards', CARDS].join(' ')}`)
  expect(note).toContain(`open ${OUT}`)
  expect(submits).toEqual([{ text: CARDS_PROMPT, origin: { kind: 'plugin', name: 'debrief' } }])
})

test('--cards를 준 실행, 실패한 실행, 다른 하위 명령은 묻지 않는다', async ($, on) => {
  const w = world()
  const { submits, clock } = await asking($, on, w)
  for (const args of ['aar --cards cards.json', 'backfill', 'compact', 'ledger']) {
    const result = await command($, 'debrief', args)
    expect(result.context).toBeUndefined()
    expect(result.text).not.toContain(CARDS_EMPTY)
  }
  await clock.advance(1)
  expect(submits).toEqual([])
})

test('실패한 aar와 output 없는 RESULT는 묻지 않는다', async ($, on) => {
  const { submits, clock } = await asking($, on, world(), ENV, { ...OK, exitCode: 2, stdout: 'RESULT {"error":"입력 또는 출력 오류"}\n' })
  const failed = await command($, 'debrief', 'aar')
  expect(failed.text).toContain('실패(exit 2)')
  expect(failed.context).toBeUndefined()
  await clock.advance(1)
  expect(submits).toEqual([])
})

test('exit 0이어도 RESULT에 output이 없으면 묻지 않는다', async ($, on) => {
  const { submits, clock } = await asking($, on, world(), ENV, { ...OK, stdout: 'RESULT {"error":"x"}\n' })
  expect((await command($, 'debrief', 'aar')).context).toBeUndefined()
  await clock.advance(1)
  expect(submits).toEqual([])
})

test('비대화형 세션과 사람이 아닌 출처는 메모만 남기고 턴을 제출하지 않는다', async ($, on) => {
  const w = world()
  w.isInteractive = false
  const { submits, clock } = await asking($, on, w)
  const quiet = await command($, 'debrief', 'aar')
  expect(quiet.text).toBe(`RESULT {"output":"/data/result.html"}\n${CARDS_EMPTY_QUIET}`)
  expect(quiet.context?.[0]).toContain('AskUserQuestion')
  await clock.advance(1)
  expect(submits).toEqual([])
})

test('플러그인이 실행한 aar는 턴을 제출하지 않는다', async ($, on) => {
  const { submits, clock } = await asking($, on)
  const result = await $.command.run({ command: 'debrief', args: 'aar', origin: { kind: 'plugin', name: 'other' } as never, presentation: PRESENT })
  expect(result.text).toContain(CARDS_EMPTY_QUIET)
  expect(result.context?.length).toBe(1)
  await clock.advance(1)
  expect(submits).toEqual([])
})

test('--no-ledger는 aar에만 허용되고 재생성 명령에도 그대로 실린다', async ($, on) => {
  const { calls } = await asking($, on)
  const result = await command($, 'debrief', 'aar --no-ledger --from 2026-07-01')
  const run = ['python3', '/program/report', 'aar', '--root', ROOT, '--project', SLUG, '--config', '/config', '--out', OUT, '--no-ledger', '--from', '2026-07-01']
  expect(calls).toEqual([run])
  expect(result.context?.[0]).toContain(`실행한다: ${[...run, '--cards', CARDS].join(' ')}`)
  const before = calls.length
  for (const args of ['aar --no-ledger --no-ledger', 'aar --no-ledger yes', 'compact --no-ledger', 'backfill --no-ledger']) {
    expect((await command($, 'debrief', args)).text).toContain('허용되지 않은 인자')
  }
  expect(calls.length).toBe(before)
  await command($, 'debrief', 'aar --cards c.json --no-ledger')
  expect(calls.at(-1)).toEqual(['python3', '/program/report', 'aar', '--root', ROOT, '--project', SLUG, '--config', '/config', '--out', OUT, '--cards', `${CWD}/c.json`, '--no-ledger'])
})

test('재생성 명령은 공백과 작은따옴표가 든 경로를 셸 따옴표로 감싸고 실제 실행기를 쓴다', async ($, on) => {
  const root = "/data/it's here"
  const w = world()
  const clock = install(on, w, { ...ENV, DEBRIEF_DIR: root })
  await clock.advance(NOW - clock.now())
  on('process.run', (_, e) => {
    if (e.argv[0] === 'python3') throw new Error('start failed')
    return { value: OK }
  })
  await start($, w)
  const note = (await command($, 'debrief', 'aar')).context?.[0] ?? ''
  const out = `'/data/it'\\''s here/aar/${SLUG}/2026-10-15-0907.html'`
  expect(note).toContain(`실행한다: py -3 /program/report aar --root '/data/it'\\''s here' --project ${SLUG} --config /config --out ${out} --cards '/data/it'\\''s here/aar/${SLUG}/2026-10-15-0907.cards.json'`)
  expect(note).toContain(`open ${out}`)
})

// Codex 1차: a submit that throws or is dropped leaves the person a visible line
// with the manual way, not just the "asking" line.
for (const [kind, answer] of [['예외', 'throw'], ['drop', 'drop']] as const) {
  test(`질문 턴 제출이 ${kind}로 실패하면 사람에게 실패와 수동 방법을 알린다`, async ($, on) => {
    const w = world()
    const clock = install(on, w, ENV)
    await clock.advance(NOW - clock.now())
    const logs: string[] = []
    on('process.run', () => ({ value: OK }))
    on('prompt.submit', () => {
      if (answer === 'throw') throw new Error('queue closed')
      return { drop: 'blocked by a hook' }
    })
    on('ui.log', (_, e) => { logs.push(e.text); return { value: undefined } })
    await start($, w)
    const result = await command($, 'debrief', 'aar')
    // The command answers before the submit settles: its line says it asked, not that a dialog is up.
    expect(result.text).toBe(`RESULT {"output":"/data/result.html"}\n${CARDS_EMPTY}`)
    expect(logs).toEqual([])
    await clock.advance(1)
    expect(logs).toEqual([CARDS_FAILED])
  })
}

test('질문 턴 제출이 성공하면 실패 안내를 남기지 않는다', async ($, on) => {
  const { clock, logs, submits } = await asking($, on)
  await command($, 'debrief', 'aar')
  await clock.advance(1)
  expect(submits.length).toBe(1)
  expect(logs).toEqual([])
})
