---
"@grepline/cli": patch
---

migrate the cli test suite to bun's native runner so effect assertions run without vitest-specific helpers and the workspace no longer depends on vitest.
