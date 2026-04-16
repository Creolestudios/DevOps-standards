#!/bin/sh

# run-ci-checks.sh — Compulsory DevOps CI Checks
# Used by Husky pre-push
# Smoke tests and Newman tests ALWAYS run — never skipped.

echo ""
echo "=================================================="
echo "🚀 [CI Checks] Starting local CI pipeline"
echo "=================================================="

# ---------------------------------------------------------------
# Detect changed files
# ---------------------------------------------------------------

LOCAL=$(git rev-parse @ 2>/dev/null)
REMOTE=$(git rev-parse @{u} 2>/dev/null)

if [ "$REMOTE" != "" ]; then
  CHANGED=$(git diff --name-only "$REMOTE" "$LOCAL" 2>/dev/null)
else
  if git rev-parse HEAD~1 >/dev/null 2>&1; then
    CHANGED=$(git diff --name-only HEAD~1 HEAD 2>/dev/null)
  else
    EMPTY_TREE="4b825dc642cb6eb9a060e54bf8d69288fbee4904"
    CHANGED=$(git diff-tree --no-commit-id -r --name-only "$EMPTY_TREE" HEAD 2>/dev/null)
    echo "[CI Checks] Initial push detected — scanning all committed files."
  fi
fi

if [ -n "$CHANGED" ]; then
  echo ""
  echo "[CI Checks] Changed files detected:"
  echo "$CHANGED" | sed "s/^/  -> /"
else
  echo "[CI Checks] No changed files detected (informational)."
fi

echo ""
echo "[CI Checks] Starting compulsory checks..."

# ---------------------------------------------------------------
# Find Node project directory
# ---------------------------------------------------------------

find_project_dir() {
  for DIR in . backend server api app src frontend; do
    if [ -f "$DIR/package.json" ]; then
      echo "$DIR"
      return
    fi
  done
  echo "none"
}

PROJECT_DIR=$(find_project_dir)

if [ "$PROJECT_DIR" = "none" ]; then
  echo "⚠️  [CI Checks] No package.json found. Cannot run Node checks."
  echo "[CI Checks] Tip: Ensure your project has a package.json."
  exit 0
fi

echo "[CI Checks] Node project detected in: $PROJECT_DIR"
cd "$PROJECT_DIR" || exit 0

# ---------------------------------------------------------------
# Detect Package Manager (pnpm > yarn > bun > npm)
# ---------------------------------------------------------------
if [ -f "pnpm-lock.yaml" ] || [ -f "../pnpm-lock.yaml" ]; then
  PKG_MANAGER="pnpm"
  PKG_ADD="pnpm add -D"
  PKG_RUN="pnpm run"
  PKG_CI="pnpm install --frozen-lockfile"
elif [ -f "yarn.lock" ] || [ -f "../yarn.lock" ]; then
  PKG_MANAGER="yarn"
  PKG_ADD="yarn add -D"
  PKG_RUN="yarn"
  PKG_CI="yarn install --frozen-lockfile"
elif [ -f "bun.lockb" ] || [ -f "../bun.lockb" ]; then
  PKG_MANAGER="bun"
  PKG_ADD="bun add -d"
  PKG_RUN="bun run"
  PKG_CI="bun install"
else
  PKG_MANAGER="npm"
  PKG_ADD="npm install --save-dev"
  PKG_RUN="npm run"
  PKG_CI="npm ci"
fi
echo "[CI Checks] Detected package manager: $PKG_MANAGER"

# ---------------------------------------------------------------
# Detect scripts dynamically
# ---------------------------------------------------------------

HAS_START=$(node -e "try{const p=require('./package.json');console.log(p.scripts&&p.scripts.start?'yes':'no')}catch(e){console.log('no')}" 2>/dev/null)
HAS_DEV=$(node -e "try{const p=require('./package.json');console.log(p.scripts&&p.scripts.dev?'yes':'no')}catch(e){console.log('no')}" 2>/dev/null)

# ---------------------------------------------------------------
# Smoke Tests — Skip with warning if no test:smoke script found
# ---------------------------------------------------------------

echo ""
echo "=================================================="
echo "🔥 [Smoke Tests] Checking for smoke test script..."
echo "=================================================="

HAS_SMOKE=$(node -e "try{const p=require('./package.json');console.log(p.scripts&&p.scripts['test:smoke']?'yes':'no')}catch(e){console.log('no')}" 2>/dev/null)

# Detect test files: *.test.js / *.spec.js patterns, OR any .js/.ts inside __tests__ / __test__ dirs
TEST_FILES=$(find . \
  -not -path "*/node_modules/*" -not -path "*/.git/*" \
  \( \
    -name "*.test.js" -o -name "*.spec.js" -o \
    -name "*.test.ts" -o -name "*.spec.ts" -o \
    -name "*.test.tsx" -o -name "*.spec.tsx" -o \
    -name "*.test.jsx" -o -name "*.spec.jsx" -o \
    -name "*.test.mjs" -o -name "*.spec.mjs" -o \
    \( \( -path "*/__tests__/*" -o -path "*/__test__/*" \) \( -name "*.js" -o -name "*.ts" -o -name "*.tsx" -o -name "*.jsx" -o -name "*.mjs" \) \) \
  \) 2>/dev/null)

if [ "$HAS_SMOKE" = "yes" ] && [ -n "$TEST_FILES" ]; then
  echo "[Smoke Tests] Test script and test files detected. Running 'test:smoke'..."
  echo "[Smoke Tests] (output streamed live — this may take a few minutes)"

  # Run with a 5-minute timeout to prevent indefinite blocking
  # Stream output directly so the terminal doesn't appear frozen
  SMOKE_EXIT=0
  if command -v timeout >/dev/null 2>&1; then
    timeout 300 $PKG_RUN test:smoke
    SMOKE_EXIT=$?
    if [ $SMOKE_EXIT -eq 124 ]; then
      echo "⚠️  [Smoke Tests] Timed out after 5 minutes — skipping. Run tests manually."
      SMOKE_EXIT=0
    fi
  else
    $PKG_RUN test:smoke
    SMOKE_EXIT=$?
  fi

  if [ $SMOKE_EXIT -ne 0 ]; then
    echo "✖ [Smoke Tests] Failed. Push blocked."
    exit 1
  fi
  echo "✅ [Smoke Tests] Passed ✔"
elif [ -n "$TEST_FILES" ]; then
  echo ""
  echo "⚠️  ============================================================"
  echo "⚠️  [Smoke Tests] WARNING: Test files found but no 'test:smoke' script in package.json."
  echo "⚠️  Run 'npx cs-setup check-hooks' to auto-add it."
  echo "⚠️  SKIPPING smoke tests — push will continue."
  echo "⚠️  ============================================================"
  echo ""
else
  echo ""
  echo "⚠️  ============================================================"
  echo "⚠️  [Smoke Tests] WARNING: No 'test:smoke' script and no test files found."
  echo "⚠️  SKIPPING smoke tests — push will continue."
  echo "⚠️  ============================================================"
  echo ""
fi

# ---------------------------------------------------------------
# COMPULSORY: Newman API Tests & Server Lifecycle
# Only runs if Postman collections are actually found.
# ---------------------------------------------------------------

echo ""
echo "=================================================="
echo "🧪 [Newman] Checking for API tests..."
echo "=================================================="

# Check if any collections exist first
COLLECTIONS=$(find . -not -path "*/node_modules/*" -not -path "*/.git/*" -name "*.postman_collection.json" 2>/dev/null)

if [ -z "$COLLECTIONS" ]; then

    echo ""
  echo "⚠️  ============================================================"
  echo "⚠️  [Newman] WARNING: No *.postman_collection.json file found."
  echo "⚠️  SKIPPING Newman API tests and server start — push will continue."
  echo "⚠️  To enable: add a Postman collection to your project,"
  echo "⚠️    e.g.  tests/my-api.postman_collection.json"
  echo "⚠️  ============================================================"
  echo ""
else
  echo "[Newman] Postman collections detected. Preparing server environment..."

  # 1. Start the Server
  SERVER_PID=""
  PORT=""
  START_CMD=""
  if [ "$HAS_START" = "yes" ]; then START_CMD="$PKG_RUN start"; elif [ "$HAS_DEV" = "yes" ]; then START_CMD="$PKG_RUN dev"; fi

  if [ -n "$START_CMD" ]; then
    # Port Detection
    DETECTED_PORT=""
    if [ -f ".env" ]; then DETECTED_PORT=$(grep -E "^PORT=" .env 2>/dev/null | cut -d= -f2 | tr -d "\t\r\n "); fi
    if [ -z "$DETECTED_PORT" ]; then DETECTED_PORT=$(node -e 'try{const p=require("./package.json");const s=JSON.stringify(p.scripts||{});const m=s.match(/PORT=([0-9]+)/);if(m)process.stdout.write(m[1])}catch(e){}' 2>/dev/null); fi
    if [ -z "$DETECTED_PORT" ]; then DETECTED_PORT=$(grep -rE "\.listen\([0-9]" --include="*.js" --include="*.ts" --exclude-dir=node_modules --exclude-dir=.git . 2>/dev/null | grep -oE "[0-9]{4,5}" | head -1); fi
    
    KILL_PORT=${DETECTED_PORT:-3000}
    echo "[Server] Auto-killing any process on port $KILL_PORT to avoid conflicts..."
    # Use Node to kill the port (cross-platform, no extra deps needed)
    node -e "
      const net = require('net');
      const s = net.createConnection({port:$KILL_PORT, host:'127.0.0.1'});
      s.on('connect', () => { s.destroy(); process.exit(0); });
      s.on('error', () => { process.exit(0); });
      setTimeout(() => process.exit(0), 2000);
    " 2>/dev/null || true
    # Also try npx kill-port as a best-effort
    npx --yes kill-port $KILL_PORT >/dev/null 2>&1 || true

    echo "[Server] Starting server with: $START_CMD"
    $START_CMD </dev/null > /tmp/ci-server.log 2>&1 &
    SERVER_PID=$!

    PORT_LIST="$DETECTED_PORT 3000 3001 4000 8000 8080"

    echo "[Server] Waiting for server to be ready..."
    SERVER_UP=0
    for i in $(seq 1 30); do
      # Check if the server process is still alive
      if ! kill -0 $SERVER_PID 2>/dev/null; then
        echo "✖ [Server] Process exited early. Showing logs below:"
        echo "--------------------------------------------------"
        cat /tmp/ci-server.log 2>/dev/null || echo "(no log file)"
        echo "--------------------------------------------------"
        exit 1
      fi
      # Use Node.js TCP probe instead of curl (works on Windows + Linux)
      for PORT_TRY in $PORT_LIST; do
        if node -e "
          const net = require('net');
          const s = net.createConnection({port:$PORT_TRY, host:'127.0.0.1'});
          s.on('connect', () => { s.destroy(); process.exit(0); });
          s.on('error', () => { process.exit(1); });
          setTimeout(() => process.exit(1), 1000);
        " 2>/dev/null; then
          PORT=$PORT_TRY
          SERVER_UP=1
          echo "✅ [Server] Running on port $PORT"
          break 2
        fi
      done
      sleep 1
    done

    if [ $SERVER_UP -eq 0 ]; then
      echo "⚠️  [Server] Did not start within 30s — Newman tests might fail."
      echo "    Server logs:"
      cat /tmp/ci-server.log 2>/dev/null || echo "    (no log file)"
    fi
  fi

  # 2. Run the Newman Tests
  HAS_NEWMAN_SCRIPT=$(node -e "try{const p=require('./package.json');console.log(p.scripts&&p.scripts['test:newman']?'yes':'no')}catch(e){console.log('no')}" 2>/dev/null)

  if [ "$HAS_NEWMAN_SCRIPT" = "yes" ]; then
    echo "[Newman] Running standardized 'test:newman' script..."
    if ! $PKG_RUN test:newman; then
      if [ -n "$SERVER_PID" ]; then kill $SERVER_PID 2>/dev/null; fi
      echo "✖ [Newman] API tests failed. Push blocked."
      exit 1
    fi
  else
    echo "[Newman] Running local collections directly..."
    mkdir -p newman-reports
    ENV_FILE=$(find . -not -path "*/node_modules/*" -not -path "*/.git/*" -name "*.postman_environment.json" 2>/dev/null | head -1)
    NEWMAN_FAIL=0

    for COLLECTION in $COLLECTIONS; do
      NAME=$(basename "$COLLECTION" .json)
      echo "[Newman] Executing: $COLLECTION"
      ENV_FLAG=""; [ -n "$ENV_FILE" ] && ENV_FLAG="--environment $ENV_FILE"

      newman run "$COLLECTION" $ENV_FLAG --env-var "baseUrl=http://localhost:${PORT:-3000}" --reporters cli,htmlextra --reporter-htmlextra-export "newman-reports/${NAME}-report.html" --bail
      if [ $? -ne 0 ]; then NEWMAN_FAIL=1; fi
    done

    if [ $NEWMAN_FAIL -ne 0 ]; then
      if [ -n "$SERVER_PID" ]; then kill $SERVER_PID 2>/dev/null; fi
      echo "✖ [Newman] API tests failed. Push blocked."
      exit 1
    fi
  fi

  # 3. Cleanup: Kill server after tests finish
  if [ -n "$SERVER_PID" ]; then
    kill $SERVER_PID 2>/dev/null
    echo "[Server] Stopped."
  fi
  echo "✅ [Newman] All API tests completed ✔"
fi

echo ""
echo "=================================================="
echo "✅ [CI Checks] All checks completed."
echo "=================================================="

exit 0
