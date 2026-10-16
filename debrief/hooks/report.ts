import type { EngineInterface, ProcessRunResult } from 'claude-code'
import { join, places, sepOf, slugOf } from './paths'

export const REPORT_HINT = '[tag <label> | setup | aar [--from ISO] [--to ISO] [--cards PATH] | backfill [--days N] | compact [--dry-run] | ledger [list [--status S] | set ID STATUS]]'
export const REPORT_USAGE = `사용법: /debrief ${REPORT_HINT}`
const STATUSES = ['proposed', 'applied', 'verified', 'dropped']
const TIMEOUTS: Record<string, number> = { aar: 600000, backfill: 600000, compact: 300000, ledger: 30000 }

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
  const flags = sub === 'aar' ? ['--from', '--to', '--cards'] : sub === 'backfill' ? ['--days'] : ['--dry-run']
  const seen = new Set<string>()
  for (let i = 0; i < args.length; i++) {
    const flag = args[i] ?? ''
    if (!flags.includes(flag) || seen.has(flag)) return false
    seen.add(flag)
    if (flag === '--dry-run') continue
    const value = args[++i]
    if (!value || value.startsWith('-')) return false
    if (flag === '--days' && (!Number.isFinite(Number(value)) || Number(value) <= 0)) return false
  }
  return true
}

export async function report($: EngineInterface, text: string): Promise<string | undefined> {
  const sub = text.split(/\s/, 1)[0] ?? ''
  if (!Object.hasOwn(TIMEOUTS, sub)) return undefined
  const parsed = tokens(text)
  if (!parsed) return '허용되지 않은 인자입니다. ' + REPORT_USAGE
  const args = parsed.slice(1)
  if (sub === 'ledger' && args.length === 0) args.push('list')
  if (!allowed(sub, args)) return '허용되지 않은 인자입니다. ' + REPORT_USAGE
  const p = await places($)
  const programDir = (await $.env.get('DEBRIEF_REPORT_DIR')) ?? join(p.sep, $.plugin.root, 'tools', 'debrief_report')
  const fixed = ['--root', p.root]
  if (sub === 'aar' || sub === 'backfill') {
    const slug = slugOf(await $.session.cwd())
    fixed.push('--project', slug, '--config', p.configDir)
    if (sub === 'backfill') fixed.push('--exclude-session', await $.session.id())
    else {
      const date = new Date(await $.clock.now())
      const pad = (n: number) => String(n).padStart(2, '0')
      const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
      fixed.push('--out', join(p.sep, p.root, 'aar', slug, `${stamp}.html`))
    }
  }
  // The program runs with the data root as cwd, so a relative --cards path is
  // resolved against the session's working directory here.
  const cards = args.indexOf('--cards')
  const cardsPath = cards >= 0 ? args[cards + 1] : undefined
  if (cardsPath !== undefined && /^[A-Za-z]:(?![\\/])/.test(cardsPath)) return '허용되지 않은 인자입니다(드라이브 상대 경로). ' + REPORT_USAGE
  if (cardsPath !== undefined && !/^([\\/]|[A-Za-z]:[\\/])/.test(cardsPath)) {
    const cwd = await $.session.cwd()
    args[cards + 1] = join(sepOf(cwd), cwd, cardsPath)
  }
  const argv = [programDir, sub, ...fixed, ...args]
  const init = { cwd: p.root, timeoutMs: TIMEOUTS[sub] }
  let result: ProcessRunResult
  try {
    result = await $.process.run(['python3', ...argv], init)
  } catch {
    try {
      result = await $.process.run(['py', '-3', ...argv], init)
    } catch {
      return 'python3가 필요합니다 — 설치 안내: https://www.python.org/downloads/'
    }
  }
  const lines = result.exitCode !== 0
    ? [`실패(exit ${result.exitCode})`, ...result.stderr.split(/\r?\n/).slice(0, 20)]
    : result.stdout.split(/\r?\n/).filter(line => line.startsWith('RESULT '))
  if (result.exitCode === 0 && lines.length === 0) lines.push('완료했으나 RESULT 줄이 없습니다.')
  if (result.isStdoutTruncated) lines.push('출력 잘림')
  return lines.join('\n')
}
