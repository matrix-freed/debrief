import { expect, test } from 'claude-code/testing'
import type { ProcessRunInit } from 'claude-code'
import { slugOf } from '../hooks/paths'
import { CWD, ROOT, SLUG, command, install, start, world } from './kit'

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
