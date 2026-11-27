import fs from 'node:fs'
import path from 'node:path'

export interface GateViolation {
  readonly file: string
  readonly line: number
  readonly message: string
}

export function collectTsFiles(roots: readonly string[]): string[] {
  const results: string[] = []
  function visit(dir: string): void {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'lib') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        visit(full)
      } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
        results.push(full)
      }
    }
  }
  for (const r of roots) visit(path.resolve(r))
  return results
}

export function relativeFile(fullPath: string): string {
  return path.relative(process.cwd(), fullPath).replaceAll('\\', '/')
}
