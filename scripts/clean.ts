import fs from 'node:fs'
import path from 'node:path'

const targets = ['packages', 'apps']
const removable = new Set(['dist', 'lib'])

function walk(dir: string): void {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (removable.has(entry.name)) {
        fs.rmSync(full, { recursive: true, force: true })
        console.log(`removed ${full}`)
      } else {
        walk(full)
      }
    } else if (entry.name.endsWith('.tsbuildinfo')) {
      fs.rmSync(full, { force: true })
      console.log(`removed ${full}`)
    }
  }
}

for (const root of targets) {
  walk(path.resolve(root))
}
