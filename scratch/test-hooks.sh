#!/bin/bash
# Test script to validate pre-commit and pre-push hook generation

set -e
source ~/.nvm/nvm.sh 2>/dev/null || true

cd /mnt/g/Office/pkg

echo "=== 1. Syntax check all lib files ==="
node -e "require('./lib/hooks.js'); console.log('hooks.js: OK')"
node -e "require('./lib/ci.js'); console.log('ci.js: OK')"
node -e "require('./lib/eslint.js'); console.log('eslint.js: OK')"
node -e "require('./lib/packageManager.js'); console.log('packageManager.js: OK')"
node -e "require('./lib/lintScripts.js'); console.log('lintScripts.js: OK')"
node -e "require('./lib/husky.js'); console.log('husky.js: OK')"
node -e "require('./lib/sonarqube.js'); console.log('sonarqube.js: OK')"
node -e "require('./lib/gitleaks.js'); console.log('gitleaks.js: OK')"
node -e "require('./lib/git.js'); console.log('git.js: OK')"
node -e "require('./lib/fixer.js'); console.log('fixer.js: OK')"
node -e "require('./lib/logger.js'); console.log('logger.js: OK')"
node -e "require('./lib/utils.js'); console.log('utils.js: OK')"

echo ""
echo "=== 2. Generate pre-commit hook and check shell syntax ==="
node -e "
const { setupPreCommitHook } = require('./lib/hooks.js');
const fs = require('fs-extra');
const path = require('path');
// Simulate buildHookScript by requiring the module and calling internal
const mod = require('./lib/hooks.js');
// Write hook to temp file
const hookContent = require('fs').readFileSync('/tmp/test-pre-commit', 'utf8') || '';
" 2>/dev/null || true

# Generate hook via node
node -e "
const fs = require('fs');
// Inline the buildHookScript logic by loading hooks.js and monkey-patching
const hooks = require('./lib/hooks.js');
// We need to call setupPreCommitHook but with a temp dir
const fsExtra = require('fs-extra');
const path = require('path');
const tmpDir = '/tmp/cs-test-hooks';
fsExtra.ensureDirSync(tmpDir + '/.husky');
// Temporarily chdir to a fake project
const orig = process.cwd();
process.chdir(tmpDir);
// Create minimal package.json
fs.writeFileSync(tmpDir + '/package.json', JSON.stringify({name:'test',scripts:{lint:'eslint .'}}));
hooks.setupPreCommitHook(tmpDir).then(() => {
  const hook = fs.readFileSync(tmpDir + '/.husky/pre-commit', 'utf8');
  fs.writeFileSync('/tmp/generated-pre-commit.sh', hook);
  console.log('Pre-commit hook generated: ' + hook.length + ' bytes');
  process.chdir(orig);
}).catch(e => { console.error('Error:', e.message); process.chdir(orig); });
"

echo ""
echo "=== 3. Shell syntax check on generated pre-commit hook ==="
if [ -f /tmp/generated-pre-commit.sh ]; then
  bash -n /tmp/generated-pre-commit.sh && echo "pre-commit: SYNTAX OK" || echo "pre-commit: SYNTAX ERROR"
else
  echo "pre-commit hook not generated"
fi

echo ""
echo "=== 4. Generate pre-push hook and check shell syntax ==="
node -e "
const fs = require('fs');
const ci = require('./lib/ci.js');
const fsExtra = require('fs-extra');
const tmpDir = '/tmp/cs-test-hooks';
fsExtra.ensureDirSync(tmpDir + '/.husky');
const orig = process.cwd();
process.chdir(tmpDir);
ci.setupPrePushHook(tmpDir).then(() => {
  const hook = fs.readFileSync(tmpDir + '/.husky/pre-push', 'utf8');
  fs.writeFileSync('/tmp/generated-pre-push.sh', hook);
  console.log('Pre-push hook generated: ' + hook.length + ' bytes');
  process.chdir(orig);
}).catch(e => { console.error('Error:', e.message); process.chdir(orig); });
"

echo ""
echo "=== 5. Shell syntax check on generated pre-push hook ==="
if [ -f /tmp/generated-pre-push.sh ]; then
  bash -n /tmp/generated-pre-push.sh && echo "pre-push: SYNTAX OK" || echo "pre-push: SYNTAX ERROR"
else
  echo "pre-push hook not generated"
fi

echo ""
echo "=== 6. Check run-ci-checks.sh shell syntax ==="
bash -n /mnt/g/Office/pkg/templates/run-ci-checks.sh && echo "run-ci-checks.sh: SYNTAX OK" || echo "run-ci-checks.sh: SYNTAX ERROR"

echo ""
echo "=== 7. Check for hardcoded npm/npx in hook scripts ==="
echo "--- pre-commit hardcoded 'npm ' occurrences (should be 0 outside node -e blocks) ---"
grep -n "^npm " /tmp/generated-pre-commit.sh 2>/dev/null | head -5 || echo "None found (good)"

echo ""
echo "=== 8. Check ESLINT_USE_FLAT_CONFIG logic ==="
grep -n "ESLINT_USE_FLAT_CONFIG" /tmp/generated-pre-commit.sh 2>/dev/null | head -10

echo ""
echo "=== 9. Check incompatible plugin detection in pre-commit ==="
grep -n "INCOMPATIBLE\|incompatible\|flowtype\|react-hooks" /tmp/generated-pre-commit.sh 2>/dev/null | head -10

echo ""
echo "=== 10. Check pre-push deletion detection ==="
grep -n "0000000000000000000000000000000000000000" /tmp/generated-pre-push.sh 2>/dev/null && echo "Deletion detection: OK" || echo "Deletion detection: MISSING"

echo ""
echo "=== ALL TESTS COMPLETE ==="
