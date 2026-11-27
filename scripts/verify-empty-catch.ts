import fs from 'node:fs'
import { collectTsFiles, relativeFile, type GateViolation } from './gate-utils.ts'

/**
 * 门禁 2：禁止无解释吞错的空 catch 块（对标 DSH verify-empty-catch）。
 */
export function verifyEmptyCatch(): GateViolation[] {
  const files = collectTsFiles(['packages', 'apps', 'scripts'])
  const violations: GateViolation[] = []
  const bareEmptyCatch = /catch\s*(?:\([^)]*\))?\s*\{\s*\}/g

  for (const file of files) {
    const rel = relativeFile(file)
    if (rel === 'scripts/verify-empty-catch.ts') continue
    const content = fs.readFileSync(file, 'utf8')
    let match: RegExpExecArray | null = bareEmptyCatch.exec(content)
    while (match !== null) {
      const prefix = content.slice(0, match.index)
      const line = prefix.split(/\r?\n/).length
      violations.push({
        file: rel,
        line,
        message: 'Empty catch block without explanation comment is forbidden.',
      })
      match = bareEmptyCatch.exec(content)
    }
  }
  return violations
}
