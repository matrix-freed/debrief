import type { EngineInterface } from 'claude-code'

import { join } from './paths'
import type { Places } from './paths'

// Adapter: the built-in /insights output, if this machine has it. Optional
// and fail-open: a missing or unreadable folder answers `available: false`.
// Only allowlisted numeric and boolean fields are read out of each file; the
// free-text fields (first_prompt, brief_summary, friction_detail and the
// like) are never copied, returned or stored.

export type InsightsSummary = {
  available: boolean
  sessions: number
  taskAgentSessions: number
  toolErrors: number
  interruptions: number
}

const NONE: InsightsSummary = { available: false, sessions: 0, taskAgentSessions: 0, toolErrors: 0, interruptions: 0 }

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export async function readInsights($: EngineInterface, p: Places, limit = 40): Promise<InsightsSummary> {
  const candidates = [join(p.sep, p.configDir, 'usage-data', 'session-meta'), join(p.sep, p.home, '.claude', 'usage-data', 'session-meta')]
  for (const dir of candidates) {
    try {
      if (!(await $.fs.exists(dir))) continue
      const entries = (await $.fs.list(dir))
        .filter(e => e.kind === 'file' && e.name.endsWith('.json'))
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, limit)
      const out = { ...NONE, available: true }
      for (const entry of entries) {
        try {
          const row: unknown = JSON.parse(await $.fs.read(join(p.sep, dir, entry.name)))
          if (typeof row !== 'object' || row === null) continue
          const r = row as Record<string, unknown>
          out.sessions += 1
          out.taskAgentSessions += r.uses_task_agent === true ? 1 : 0
          out.toolErrors += num(r.tool_errors)
          out.interruptions += num(r.user_interruptions)
        } catch {
          continue
        }
      }
      return out
    } catch {
      continue
    }
  }
  return NONE
}
