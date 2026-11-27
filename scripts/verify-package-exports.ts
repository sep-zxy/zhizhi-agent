import fs from 'node:fs'
import path from 'node:path'
import { relativeFile, type GateViolation } from './gate-utils.ts'

/**
 * 门禁 5：校验所有 workspace package.json 均为标准 ESM，且 packages 下各库声明了 exports 入口。
 */
export function verifyPackageExports(): GateViolation[] {
  const violations: GateViolation[] = []
  const pkgFiles: string[] = []

  for (const base of ['packages', 'apps']) {
    const root = path.resolve(base)
    if (!fs.existsSync(root)) continue
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const directPkg = path.join(root, entry.name, 'package.json')
      if (fs.existsSync(directPkg)) {
        pkgFiles.push(directPkg)
        continue
      }
      for (const sub of fs.readdirSync(path.join(root, entry.name), { withFileTypes: true })) {
        if (!sub.isDirectory()) continue
        const nestedPkg = path.join(root, entry.name, sub.name, 'package.json')
        if (fs.existsSync(nestedPkg)) pkgFiles.push(nestedPkg)
      }
    }
  }

  for (const pkgPath of pkgFiles) {
    const rel = relativeFile(pkgPath)
    const json = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
      type?: string
      name?: string
      exports?: Record<string, unknown>
    }
    if (json.type !== 'module') {
      violations.push({ file: rel, line: 1, message: 'Workspace package must declare `"type": "module"`.' })
    }
    if (rel.startsWith('packages/') && !json.exports) {
      violations.push({ file: rel, line: 1, message: 'Library package under packages/ must declare `exports`.' })
    }
  }
  return violations
}
