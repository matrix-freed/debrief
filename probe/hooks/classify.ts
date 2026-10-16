// Pure classifiers over a Bash command string. The caller keeps only the
// boolean; the command text is dropped right after the test.

const REMOTE_DIRECTIVE = /\bssh\s+(?:-\S+\s+)*remote-host\b[\s\S]*\btmux\s+send-keys\b/
const CODEX_CLI = /(?:^|[\s;&|(])codex(?:-companion)?\s+(?:exec|e|review)\b/

export const isRemoteDirective = (command: string): boolean => REMOTE_DIRECTIVE.test(command)

export const isCodexCli = (command: string): boolean => CODEX_CLI.test(command)

export const bashCommandOf = (input: unknown): string | undefined => {
  if (typeof input !== 'object' || input === null) return undefined
  const command = (input as { command?: unknown }).command
  return typeof command === 'string' ? command : undefined
}
