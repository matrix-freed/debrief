import { describe, expect, test } from 'claude-code/testing'

import { DEFAULT_PROFILE, directiveLabels, normalizeProfile } from '../hooks/profile'

describe('profile', () => {
  test('defaults are neutral: no lane, vendor, machine or pattern', async () => {
    expect(DEFAULT_PROFILE.lanes).toEqual({})
    expect(DEFAULT_PROFILE.externalAgentTypes).toEqual([])
    expect(DEFAULT_PROFILE.directives).toEqual([])
    expect(DEFAULT_PROFILE.machines).toEqual([])
    expect(DEFAULT_PROFILE.shareConsent).toBe(false)
  })
  test('bad fields fall back, bad patterns are dropped', async () => {
    const { profile, isValid } = normalizeProfile({
      language: 'xx',
      shareConsent: 'yes',
      directives: [{ label: 'ok', pattern: 'a+b' }, { label: 'bad', pattern: '(' }, { pattern: 'x' }],
      limits: { byteBudget: 10, stepRing: 50 },
    })
    expect(isValid).toBe(true)
    expect(profile.language).toBe('en')
    expect(profile.shareConsent).toBe(false)
    expect(profile.directives).toEqual([{ label: 'ok', pattern: 'a+b' }])
    expect(profile.limits).toEqual({ byteBudget: DEFAULT_PROFILE.limits.byteBudget, stepRing: 50, turnRing: 1000, checkpointMs: 30000 })
    expect(normalizeProfile('nope').isValid).toBe(false)
  })
  test('directive labels come from the profile, the command is only tested', async () => {
    const { profile } = normalizeProfile({ directives: [{ label: 'remote', pattern: 'ssh\\s+\\S+.*tmux\\s+send-keys' }] })
    expect(directiveLabels(profile, 'ssh box tmux send-keys -t a x Enter')).toEqual(['remote'])
    expect(directiveLabels(profile, 'tmux send-keys -t a x')).toEqual([])
    expect(directiveLabels(DEFAULT_PROFILE, 'ssh box tmux send-keys')).toEqual([])
  })
})
