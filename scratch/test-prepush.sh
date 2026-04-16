#!/bin/bash
source ~/.nvm/nvm.sh 2>/dev/null || true
cd /mnt/g/Office/pkg

echo "=== Generate and syntax-check pre-push hook ==="
node -e "
const fs = require('fs');
const ci = require('./lib/ci.js');
const fsExtra = require('fs-extra');
const tmpDir = '/tmp/cs-test-prepush';
fsExtra.ensureDirSync(tmpDir + '/.husky');
fs.writeFileSync(tmpDir + '/package.json', JSON.stringify({name:'test',scripts:{}}));
const orig = process.cwd();
process.chdir(tmpDir);
ci.setupPrePushHook(tmpDir).then(() => {
  const hook = fs.readFileSync(tmpDir + '/.husky/pre-push', 'utf8');
  fs.writeFileSync('/tmp/test-pre-push.sh', hook);
  console.log('Generated pre-push: ' + hook.length + ' bytes');
  process.chdir(orig);
}).catch(e => { console.error(e.message); process.chdir(orig); });
"

sleep 1

echo ""
echo "=== Shell syntax check ==="
bash -n /tmp/test-pre-push.sh && echo "SYNTAX OK" || echo "SYNTAX ERROR"

echo ""
echo "=== Check working directory resolution ==="
grep -n "PROJECT_ROOT\|cd.*PROJECT\|HOOK_DIR" /tmp/test-pre-push.sh | head -10

echo ""
echo "=== Check CI script execution ==="
grep -n "CI_SCRIPT\|run-ci-checks\|sh.*CI" /tmp/test-pre-push.sh | head -10

echo ""
echo "=== Check deletion detection ==="
grep -n "0000000000000000000000000000000000000000" /tmp/test-pre-push.sh

echo ""
echo "=== Full hook content ==="
cat /tmp/test-pre-push.sh
