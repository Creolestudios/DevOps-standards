#!/bin/bash
source ~/.nvm/nvm.sh 2>/dev/null || true
cd /mnt/g/Office/pkg

# Generate fresh hook
node -e "
const fs = require('fs');
const ci = require('./lib/ci.js');
const fsExtra = require('fs-extra');
const tmpDir = '/tmp/cs-test-pp2';
fsExtra.ensureDirSync(tmpDir + '/.husky');
fs.writeFileSync(tmpDir + '/package.json', JSON.stringify({name:'test',scripts:{}}));
const orig = process.cwd();
process.chdir(tmpDir);
ci.setupPrePushHook(tmpDir).then(() => {
  const hook = fs.readFileSync(tmpDir + '/.husky/pre-push', 'utf8');
  fs.writeFileSync('/tmp/new-pre-push.sh', hook);
  console.log('Generated: ' + hook.length + ' bytes');
  process.chdir(orig);
}).catch(e => { console.error(e.message); process.chdir(orig); });
"

sleep 1

echo "=== Syntax check ==="
bash -n /tmp/new-pre-push.sh && echo "SYNTAX OK" || echo "SYNTAX ERROR"

echo ""
echo "=== Check embedded content present ==="
grep -c "CI Checks" /tmp/new-pre-push.sh && echo "CI script content embedded OK" || echo "CI script content MISSING"

echo ""
echo "=== Check node restore block ==="
grep -n "node -e\|writeFileSync\|run-ci-checks" /tmp/new-pre-push.sh | head -10
