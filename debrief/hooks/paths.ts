import type { EngineInterface } from 'claude-code'

// Where debrief keeps its files, on macOS, Linux and Windows alike: the
// home is HOME, else USERPROFILE; the separator is the one the home uses.

export type Places = { home: string; configDir: string; root: string; sep: string }

export const sepOf = (path: string): string => (path.includes('\\') && !path.includes('/') ? '\\' : '/')

export const join = (sep: string, ...parts: string[]): string =>
  parts
    .filter(p => p !== '')
    .map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, '') : p.replace(/^[\\/]+|[\\/]+$/g, '')))
    .join(sep)

// The project key, as Claude Code names its per-project transcript folders.
export const slugOf = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')

export async function places($: EngineInterface): Promise<Places> {
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? '.'
  const sep = sepOf(home)
  const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? join(sep, home, '.claude')
  const root = (await $.env.get('DEBRIEF_DIR')) ?? join(sep, configDir, 'debrief')
  return { home, configDir, root, sep: sepOf(root) }
}

export const runFile = (p: Places, slug: string, sessionId: string, runId: string): string =>
  join(p.sep, p.root, 'runs', slug, sessionId, `${runId}.json`)

export const sessionDir = (p: Places, slug: string, sessionId: string): string =>
  join(p.sep, p.root, 'runs', slug, sessionId)

export const profileFile = (p: Places): string => join(p.sep, p.root, 'profile.json')
