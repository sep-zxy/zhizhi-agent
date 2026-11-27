import { verifyNoUnknownCasts } from './verify-no-unknown-casts.ts'
import { verifyEmptyCatch } from './verify-empty-catch.ts'
import { verifyWorkspaceDeps } from './verify-workspace-deps.ts'
import { verifyTenantScope } from './verify-tenant-scope.ts'
import { verifyPackageExports } from './verify-package-exports.ts'
import type { GateViolation } from './gate-utils.ts'

const gates: ReadonlyArray<{ readonly name: string; readonly run: () => GateViolation[] }> = [
  { name: 'verify-no-unknown-casts', run: verifyNoUnknownCasts },
  { name: 'verify-empty-catch', run: verifyEmptyCatch },
  { name: 'verify-workspace-deps', run: verifyWorkspaceDeps },
  { name: 'verify-tenant-scope', run: verifyTenantScope },
  { name: 'verify-package-exports', run: verifyPackageExports },
]

let totalViolations = 0
for (const gate of gates) {
  const violations = gate.run()
  if (violations.length === 0) {
    console.log(`[PASS] ${gate.name}`)
  } else {
    totalViolations += violations.length
    console.error(`[FAIL] ${gate.name} (${violations.length} violation(s))`)
    for (const v of violations) {
      console.error(`  - ${v.file}:${v.line} ${v.message}`)
    }
  }
}

if (totalViolations > 0) {
  process.exit(1)
}
console.log(`All ${gates.length} repository gates passed.`)
