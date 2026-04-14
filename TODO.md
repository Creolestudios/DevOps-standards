# TODO: Fix ESLint Root Scan Crash in cs-setup

## Steps:
- [x] Understand error: ESLint 9 + @next plugin crashes in legacy mode during root scan
- [x] Plan approved by user
- [x] Step 1: Edit lib/hooks.js - add guard to skip root scan for Next.js/ESLint9 legacy
- [x] Step 2: Run npx cs-setup check-hooks (hooks regenerated)
- [x] Step 3: Test confirmed - new guard skips incompatible Next.js/ESLint9 root scan (no crash)
- [ ] Step 4: Update TODO.md with completion
- [ ] Complete task
