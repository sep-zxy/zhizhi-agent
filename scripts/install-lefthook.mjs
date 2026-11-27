import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

if (!fs.existsSync(path.resolve('.git'))) {
  process.exit(0)
}

try {
  execFileSync('pnpm', ['exec', 'lefthook', 'install'], { stdio: 'ignore', shell: process.platform === 'win32' })
} catch (_err) {
  // Hook installation is best-effort in CI or sandbox environments without git hook write permissions.
}
