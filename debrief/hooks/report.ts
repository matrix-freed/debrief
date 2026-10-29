import type { EngineInterface, ProcessRunResult, PromptOrigin } from 'claude-code'
import { join, places, sepOf, slugOf } from './paths'

export const REPORT_HINT = '[tag <label> | setup | aar [--from ISO] [--to ISO] [--cards PATH] [--no-ledger] | backfill [--days N] | compact [--dry-run] | ledger [list [--status S] | set ID STATUS]]'
export const REPORT_USAGE = `사용법: /debrief ${REPORT_HINT}`
const STATUSES = ['proposed', 'applied', 'verified', 'dropped']
const TIMEOUTS: Record<string, number> = { aar: 600000, backfill: 600000, compact: 300000, ledger: 30000 }
const SWITCHES = ['--dry-run', '--no-ledger']

export type ReportAnswer = { text: string; context?: string[] }
// What the person sees after an AAR that ran without cards, the transcript
// line if the asking turn could not be submitted, and the line the plugin
// submits to start that turn (it shows under the plugin's name).
export const CARDS_EMPTY = '리뷰 카드가 비어 있습니다 — 확인 창을 요청합니다'
export const CARDS_EMPTY_QUIET = '리뷰 카드가 비어 있습니다 — Claude에게 카드 작성을 요청하거나 --cards로 다시 생성하세요'
export const CARDS_FAILED = 'debrief: 확인 창을 띄우지 못했습니다 — Claude에게 카드 작성을 요청하거나 --cards로 다시 생성하세요'
export const CARDS_PROMPT = 'AAR 리뷰 카드가 비어 있습니다. 직전 /debrief 메모대로 확인 창을 띄워 주세요.'

// Quotes group a value that has spaces; backslashes and shell syntax are not interpreted.
const tokens = (text: string): string[] | undefined => {
  const out: string[] = []
  let value = '', quote = '', active = false
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = ''
      else value += char
    } else if (char === '"' || char === "'") {
      quote = char
      active = true
    } else if (/\s/.test(char)) {
      if (active) out.push(value)
      value = ''
      active = false
    } else {
      value += char
      active = true
    }
  }
  if (quote) return undefined
  if (active) out.push(value)
  return out
}

const allowed = (sub: string, args: string[]): boolean => {
  if (sub === 'ledger') {
    if (args[0] === 'set') return args.length === 3 && /^[a-z0-9][a-z0-9-]{2,63}$/.test(args[1] ?? '') && STATUSES.includes(args[2] ?? '')
    return args[0] === 'list' && (args.length === 1 || (args.length === 3 && args[1] === '--status' && STATUSES.includes(args[2] ?? '')))
  }
  const flags = sub === 'aar' ? ['--from', '--to', '--cards', '--no-ledger'] : sub === 'backfill' ? ['--days'] : ['--dry-run']
  const seen = new Set<string>()
  for (let i = 0; i < args.length; i++) {
    const flag = args[i] ?? ''
    if (!flags.includes(flag) || seen.has(flag)) return false
    seen.add(flag)
    if (SWITCHES.includes(flag)) continue
    const value = args[++i]
    if (!value || value.startsWith('-')) return false
    if (flag === '--days' && (!Number.isFinite(Number(value)) || Number(value) <= 0)) return false
  }
  return true
}

// POSIX single quotes: the regeneration line is run by the model through its shell.
const shellQuote = (arg: string): string => (/^[A-Za-z0-9_\/.:=+,@%-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`)

// The model's note after an AAR without cards: ask the person, and if they
// want cards, write them to `cardsFile` and run `regenerate` (the same AAR plus --cards).
const askCards = (cardsFile: string, regenerate: string[], out: string): string =>
  [
    'debrief: 방금 만든 AAR의 리뷰 카드(계획·실제·차이·개선)가 비어 있다. 사람의 다음 입력을 기다리지 말고 곧바로 AskUserQuestion으로 물어라.',
    '- 질문: "AAR \'계획·실제·차이·개선\' 칸이 비어 있습니다. 어떻게 할까요?" (header: "AAR 카드")',
    '- 선택지: ① "이 세션 내용으로 카드 작성 후 다시 생성 (권장)" ② "숫자만 두기". Other(직접 입력)는 도구가 자동으로 붙이므로 따로 넣지 않는다.',
    `- ①이면: 이 세션의 맥락으로 카드 JSON을 Write로 ${cardsFile} 에 쓴다. 형식: {"cards":[{"k":"plan","title":"...","body":"...","evidence":["..."]}, ...]} — k는 plan·actual·gap·improve 각 하나, evidence는 문자열 목록, "improvements"는 넣지 않는다. 비밀값·개인정보는 쓰지 않는다.`,
    `- 그다음 Bash로 그대로 실행한다: ${regenerate.map(shellQuote).join(' ')}`,
    '- stderr에 "경고: 선택 입력을 읽지 못했습니다"가 나오면 JSON 형식을 고쳐 다시 실행한다. 성공(RESULT에 output)하면 macOS에서는 open으로 새 HTML을 연다: ' + `open ${shellQuote(out)} (다른 OS는 경로만 알린다).`,
    '- ②이면 아무것도 쓰지 않고 HTML 경로만 알린다. Other로 직접 입력한 답이면 그 뜻대로 카드를 쓰거나 멈춘다.',
  ].join('\n')

// Only a person's own gesture gets a submitted turn; a plugin's or the
// model's run of the command, and a session with nothing to ask on, get the note alone.
const PERSON = ['composer', 'bridge']

export async function report($: EngineInterface, text: string, origin?: PromptOrigin, isInteractive = false): Promise<ReportAnswer | undefined> {
  const sub = text.split(/\s/, 1)[0] ?? ''
  if (!Object.hasOwn(TIMEOUTS, sub)) return undefined
  const parsed = tokens(text)
  if (!parsed) return { text: '허용되지 않은 인자입니다. ' + REPORT_USAGE }
  const args = parsed.slice(1)
  if (sub === 'ledger' && args.length === 0) args.push('list')
  if (!allowed(sub, args)) return { text: '허용되지 않은 인자입니다. ' + REPORT_USAGE }
  const p = await places($)
  const programDir = (await $.env.get('DEBRIEF_REPORT_DIR')) ?? join(p.sep, $.plugin.root, 'tools', 'debrief_report')
  const fixed = ['--root', p.root]
  let out = ''
  if (sub === 'aar' || sub === 'backfill') {
    const slug = slugOf(await $.session.root())
    fixed.push('--project', slug, '--config', p.configDir)
    if (sub === 'backfill') fixed.push('--exclude-session', await $.session.id())
    else {
      const date = new Date(await $.clock.now())
      const pad = (n: number) => String(n).padStart(2, '0')
      const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
      out = join(p.sep, p.root, 'aar', slug, `${stamp}.html`)
      fixed.push('--out', out)
    }
  }
  // The program runs with the data root as cwd, so a relative --cards path is
  // resolved against the session root here (the shell cwd moves with every cd).
  const cards = args.indexOf('--cards')
  const cardsPath = cards >= 0 ? args[cards + 1] : undefined
  if (cardsPath !== undefined && /^[A-Za-z]:(?![\\/])/.test(cardsPath)) return { text: '허용되지 않은 인자입니다(드라이브 상대 경로). ' + REPORT_USAGE }
  if (cardsPath !== undefined && !/^([\\/]|[A-Za-z]:[\\/])/.test(cardsPath)) {
    const base = await $.session.root()
    args[cards + 1] = join(sepOf(base), base, cardsPath)
  }
  const argv = [programDir, sub, ...fixed, ...args]
  const init = { cwd: p.root, timeoutMs: TIMEOUTS[sub] }
  let result: ProcessRunResult
  let launcher = ['python3']
  try {
    result = await $.process.run([...launcher, ...argv], init)
  } catch {
    launcher = ['py', '-3']
    try {
      result = await $.process.run([...launcher, ...argv], init)
    } catch {
      return { text: 'python3가 필요합니다 — 설치 안내: https://www.python.org/downloads/' }
    }
  }
  // On failure show the program's RESULT line (its error field) and up to 20 stderr lines.
  const lines = result.exitCode !== 0
    ? [`실패(exit ${result.exitCode})`, ...result.stdout.split(/\r?\n/).filter(line => line.startsWith('RESULT ')), ...result.stderr.split(/\r?\n/).filter(line => line !== '').slice(0, 20)]
    : result.stdout.split(/\r?\n/).filter(line => line.startsWith('RESULT '))
  if (result.exitCode === 0 && lines.length === 0) lines.push('완료했으나 RESULT 줄이 없습니다.')
  if (result.isStdoutTruncated) lines.push('출력 잘림')
  const made = result.exitCode === 0 && lines.some(line => {
    try {
      return line.startsWith('RESULT ') && typeof JSON.parse(line.slice(7)).output === 'string'
    } catch {
      return false
    }
  })
  if (sub !== 'aar' || cardsPath !== undefined || !made) return { text: lines.join('\n') }
  // An AAR without cards: its stamp names the cards file beside it, so the
  // data root holds both and neither the repository nor the session folder is touched.
  const cardsFile = out.replace(/\.html$/, '.cards.json')
  const context = [askCards(cardsFile, [...launcher, ...argv, '--cards', cardsFile], out)]
  const ask = isInteractive && origin !== undefined && PERSON.includes(origin.kind)
  // The engine refuses a submit from inside a command.run hook (it would wait
  // on the turn the hook holds), so a timer (clock.after) submits once the hook has returned;
  // the turn then starts when the session is idle, after this command's rows.
  // A submit that throws or is dropped starts no turn: say so in the transcript.
  if (ask) {
    $.clock.after(0, async () => {
      try {
        if ((await $.prompt.submit({ text: CARDS_PROMPT })).drop === undefined) return
      } catch {
        // reported below
      }
      $.ui.log(CARDS_FAILED)
    })
  }
  return { text: [...lines, ask ? CARDS_EMPTY : CARDS_EMPTY_QUIET].join('\n'), context }
}
