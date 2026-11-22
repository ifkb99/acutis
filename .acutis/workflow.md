---
# Acutis checking itself. Workers edit a separate clone added as a repo, never the checkout the
# daemon runs from (DESIGN.md, principle 2: agents never edit the factory).
land: bookmark
max_attempts: 2
setup:
  - bun install --frozen-lockfile
gates:
  - name: typecheck
    run: bunx tsc --noEmit
    timeout_s: 300
  - name: tests
    run: bun test
    timeout_s: 1200
# The dashboard with scripted demo data (scripts/preview.ts); its token is fixed, so the link
# always carries #token=preview.
preview:
  run: bun scripts/preview.ts
  path: /#token=preview
  ready_timeout_s: 120
---
