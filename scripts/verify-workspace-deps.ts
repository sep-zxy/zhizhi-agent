import fs from 'node:fs'
import { collectTsFiles, relativeFile, type GateViolation } from './gate-utils.ts'

const FORBIDDEN_FOR_CLIENT = [
  '@zhizhi/db',
  '@zhizhi/storage',
  '@zhizhi/jobs',
  '@zhizhi/agent-runtime',
  '@zhizhi/plugin-sdk',
  'node:',
]

const FORBIDDEN_FOR_SHARED = [
  '@zhizhi/db',
  '@zhizhi/storage',
  '@zhizhi/jobs',
  '@zhizhi/agent-runtime',
  '@zhizhi/plugin-sdk',
  '@zhizhi/client-core',
]

/**
 * 门禁 3：强制分层依赖边界（防止 Client 误引 Node/后端包，防止 Shared 反向依赖）。
 */
export function verifyWorkspaceDeps(): GateViolation[] {
  const violations: GateViolation[] = []
  const files = collectTsFiles(['packages/shared', 'packages/client', 'apps/web/src'])
  const importPattern = /(?:from|import)\s+['"]([^'"]+)['"]/g

  for (const file of files) {
    const rel = relativeFile(file)
    const isClient = rel.startsWith('packages/client/') || rel.startsWith('apps/web/')
    const isShared = rel.startsWith('packages/shared/')
    const blocked = isClient ? FORBIDDEN_FOR_CLIENT : isShared ? FORBIDDEN_FOR_SHARED : []
    if (blocked.length === 0) continue

    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? ''
      let match: RegExpExecArray | null = importPattern.exec(line)
      while (match !== null) {
        const spec = match[1] ?? ''
        for (const forbidden of blocked) {
          if (spec === forbidden || spec.startsWith(forbidden)) {
            violations.push({
              file: rel,
              line: i + 1,
              message: `Layer boundary violation: "${rel}" cannot import "${spec}".`,
            })
          }
        }
        match = importPattern.exec(line)
      }
      importPattern.lastIndex = 0
    }
  }
  return violations
}
