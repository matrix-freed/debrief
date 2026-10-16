import type { DebriefProfile } from '../types'

// Neutral defaults: no lane, vendor, machine or team name. A profile file or
// the store fills these in; everything works without either.
export const DEFAULT_PROFILE: DebriefProfile = {
  version: 1,
  language: 'en',
  aarUse: 'project',
  shareConsent: false,
  thresholdStyle: 'conservative',
  lanes: {},
  externalAgentTypes: [],
  directives: [],
  machines: [],
  limits: { byteBudget: 3 * 1024 * 1024, stepRing: 2000, turnRing: 1000, checkpointMs: 30000 },
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback

const positive = (v: unknown, fallback: number, min: number): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= min ? Math.floor(v) : fallback

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [])

const compiles = (pattern: string): boolean => {
  try {
    new RegExp(pattern)
    return true
  } catch {
    return false
  }
}

// Reads any JSON value into a full profile; unknown or bad fields fall back.
export const normalizeProfile = (raw: unknown): { profile: DebriefProfile; isValid: boolean } => {
  if (!isObject(raw)) return { profile: DEFAULT_PROFILE, isValid: false }
  const d = DEFAULT_PROFILE
  const limits = isObject(raw.limits) ? raw.limits : {}
  const lanes: Record<string, string> = {}
  if (isObject(raw.lanes)) for (const [k, v] of Object.entries(raw.lanes)) if (typeof v === 'string') lanes[k] = v
  const directives = Array.isArray(raw.directives)
    ? raw.directives
        .filter(isObject)
        .filter(x => typeof x.label === 'string' && typeof x.pattern === 'string' && compiles(x.pattern))
        .map(x => ({ label: String(x.label), pattern: String(x.pattern) }))
    : []
  return {
    isValid: true,
    profile: {
      version: 1,
      language: pick(raw.language, ['en', 'ko'] as const, d.language),
      aarUse: pick(raw.aarUse, ['personal', 'project', 'team'] as const, d.aarUse),
      shareConsent: raw.shareConsent === true,
      thresholdStyle: pick(raw.thresholdStyle, ['conservative', 'standard'] as const, d.thresholdStyle),
      ...(typeof raw.mainLane === 'string' && raw.mainLane !== '' ? { mainLane: raw.mainLane } : {}),
      lanes,
      externalAgentTypes: strings(raw.externalAgentTypes),
      directives,
      machines: strings(raw.machines),
      limits: {
        byteBudget: positive(limits.byteBudget, d.limits.byteBudget, 1024),
        stepRing: positive(limits.stepRing, d.limits.stepRing, 1),
        turnRing: positive(limits.turnRing, d.limits.turnRing, 1),
        checkpointMs: positive(limits.checkpointMs, d.limits.checkpointMs, 1000),
      },
    },
  }
}

// Labels of the profile's directive patterns that match a shell command.
// The command text is only tested, never kept.
export const directiveLabels = (profile: DebriefProfile, command: string): string[] =>
  profile.directives.filter(d => new RegExp(d.pattern).test(command)).map(d => d.label)
