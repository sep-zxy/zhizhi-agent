import fs from 'node:fs'
import { collectTsFiles, relativeFile, type GateViolation } from './gate-utils.ts'

/**
 * 门禁 1：禁止新增 `as unknown` 或 `<unknown>` 强转（对标 DSH verify-no-unknown-casts）。
 */
export function verifyNoUnknownCasts(): GateViolation[] {
  const files = collectTsFiles(['packages', 'apps'])
  const violations: GateViolation[] = []
  const pattern = /\bas\s+unknown\b|<unknown>/

  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? ''
      if (pattern.test(line)) {
        violations.push({
          file: relativeFile(file),
          line: i + 1,
          message: 'Forbidden cast to unknown (`as unknown` / `<unknown>`); use typed narrowing or Zod validation instead.',
        })
      }
    }
  }
  return violations
}
