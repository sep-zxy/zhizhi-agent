import fs from 'node:fs'
import { collectTsFiles, relativeFile, type GateViolation } from './gate-utils.ts'

/**
 * 门禁 4（知枝专属）：扫描业务域与受保护接口中的数据库查询，确保通过 withTenant 或 userId 执行。
 */
export function verifyTenantScope(): GateViolation[] {
  const files = collectTsFiles(['packages/domain', 'packages/infra/jobs/src'])
  const violations: GateViolation[] = []
  const dbQueryPattern = /\b(db|tx)\.(select|update|delete|insert)\b/

  for (const file of files) {
    const rel = relativeFile(file)
    const content = fs.readFileSync(file, 'utf8')
    if (!dbQueryPattern.test(content)) continue
    if (!content.includes('withTenant') && !content.includes('userId')) {
      violations.push({
        file: rel,
        line: 1,
        message: 'Database access detected without `withTenant` or explicit `userId` tenant scope.',
      })
    }
  }
  return violations
}
