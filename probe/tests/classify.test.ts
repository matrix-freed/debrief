import { describe, expect, test } from 'claude-code/testing'

import { bashCommandOf, isCodexCli, isRemoteDirective } from '../hooks/classify'

describe('classify (fake command strings only)', () => {
  test('a tmux directive to the remote-host host is classified', async () => {
    expect(isRemoteDirective("ssh remote-host tmux send-keys -t lane 'hi' Enter")).toBe(true)
    expect(isRemoteDirective('ssh -t remote-host "tmux send-keys -t w1 x Enter"')).toBe(true)
  })
  test('other ssh or tmux use is not', async () => {
    expect(isRemoteDirective('ssh remote-host ls')).toBe(false)
    expect(isRemoteDirective('tmux send-keys -t local x')).toBe(false)
  })
  test('codex cli calls are classified', async () => {
    expect(isCodexCli('codex exec "fix it"')).toBe(true)
    expect(isCodexCli('echo codex')).toBe(false)
  })
  test('bash input shape', async () => {
    expect(bashCommandOf({ command: 'ls' })).toBe('ls')
    expect(bashCommandOf(null)).toBe(undefined)
  })
})
