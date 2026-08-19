'use strict';

const fs = require('fs-extra');
const path = require('path');
const { logInfo, logSuccess } = require('./logger');
const { installDevDependency } = require('./packageManager');
const { execSync } = require('child_process');

const SONAR_PROPS_FILE = 'sonar-project.properties';
const DEFAULT_SONAR_HOST = process.env.SONAR_HOST_URL || 'http://34.100.239.232:9000';
const DEFAULT_SONAR_TOKEN = process.env.SONAR_TOKEN || 'squ_76811d68e795b642385b1de37dc97fb41a13c252';
const DEFAULT_SONAR_PASSWORD = process.env.SONAR_PASSWORD || 'Creole@123456';

// ─────────────────────────────────────────────────────────────
// HELPER FUNCTIONS
// ─────────────────────────────────────────────────────────────
function getGitEmail() {
  try {
    return execSync('git config user.email').toString().trim();
  } catch {
    return null;
  }
}

function getUsernameFromEmail(email) {
  return email.split('@')[0];
}

async function sonarRequest(apiPath, postData, hostUrl, token) {
  let parsedHost;
  try { parsedHost = new URL(hostUrl); }
  catch { return { statusCode: 0, data: '' }; }

  const http = parsedHost.protocol === 'https:' ? require('https') : require('http');
  const auth = Buffer.from(`${token}:`).toString('base64');

  return new Promise((resolve) => {
    const req = http.request({
      hostname: parsedHost.hostname,
      port: parsedHost.port || (parsedHost.protocol === 'https:' ? 443 : 80),
      path: apiPath,
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ statusCode: res.statusCode, data }));
    });

    req.on('error', () => resolve({ statusCode: 0, data: '' }));
    req.write(postData);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────
// CREATE SONAR PROJECT (existing logic)
// ─────────────────────────────────────────────────────────────
async function ensureProjectExists(projectKey, projectName, hostUrl, token) {
  if (!token) {
    logInfo('SONAR_TOKEN not set — skipping project creation.');
    return;
  }

  const postData = `name=${encodeURIComponent(projectName)}&project=${encodeURIComponent(projectKey)}&visibility=private`;
  const { statusCode, data } = await sonarRequest('/api/projects/create', postData, hostUrl, token);

  if ([200, 201].includes(statusCode)) {
    logSuccess(`Project "${projectKey}" created.`);
  } else if (data.includes('already exists')) {
    logInfo(`Project "${projectKey}" already exists.`);
  }

  // Also ensure existing projects are set to private
  await sonarRequest(
    '/api/projects/update_visibility',
    `project=${encodeURIComponent(projectKey)}&visibility=private`,
    hostUrl,
    token
  );
}

// ─────────────────────────────────────────────────────────────
// CREATE / UPDATE USER
// ─────────────────────────────────────────────────────────────
async function changeUserPassword(email, password, hostUrl, token) {
  const postData = `login=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}`;
  await sonarRequest('/api/users/change_password', postData, hostUrl, token);
}

async function ensureUserExists(email, hostUrl, token, password = DEFAULT_SONAR_PASSWORD) {
  if (!email) return;

  const postData = `login=${encodeURIComponent(email)}&name=${encodeURIComponent(getUsernameFromEmail(email))}&email=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}`;
  const { data } = await sonarRequest('/api/users/create', postData, hostUrl, token);

  if (data.includes('already exists')) {
    await changeUserPassword(email, password, hostUrl, token);
  }
}

// ─────────────────────────────────────────────────────────────
// ASSIGN USER TO PROJECT
// ─────────────────────────────────────────────────────────────
async function assignUserToProject(email, projectKey, hostUrl, token) {
  if (!email) return;

  const permissions = ['admin', 'user', 'codeviewer', 'scan', 'issueadmin', 'securityhotspotadmin'];

  for (const permission of permissions) {
    const postData = `login=${encodeURIComponent(email)}&projectKey=${encodeURIComponent(projectKey)}&permission=${permission}`;
    await sonarRequest('/api/permissions/add_user', postData, hostUrl, token);
  }
}

// ─────────────────────────────────────────────────────────────
// INSTALL SCANNER
// ─────────────────────────────────────────────────────────────
exports.installSonarScanner = async () => {
  logInfo('Installing sonarqube-scanner...');
  await installDevDependency('sonarqube-scanner');
  logSuccess('sonarqube-scanner installed.');
};

// ─────────────────────────────────────────────────────────────
// MAIN SETUP FUNCTION
// ─────────────────────────────────────────────────────────────
exports.setupSonarProperties = async () => {
  const propsPath = path.join(process.cwd(), SONAR_PROPS_FILE);

  let projectKey = 'my-project';
  let projectName = 'My Project';

  const pkgPath = path.join(process.cwd(), 'package.json');
  if (await fs.pathExists(pkgPath)) {
    const pkg = await fs.readJSON(pkgPath);
    if (pkg.name) {
      projectKey = pkg.name.replace(/[^a-zA-Z0-9_\-.:]/g, '_');
      projectName = pkg.name;
    }
  }

  // STEP 1: Create project
  await ensureProjectExists(projectKey, projectName, DEFAULT_SONAR_HOST, DEFAULT_SONAR_TOKEN);

  // STEP 2: Create user + assign access
  const email = getGitEmail();

  if (email) {
    await ensureUserExists(email, DEFAULT_SONAR_HOST, DEFAULT_SONAR_TOKEN);
    await assignUserToProject(email, projectKey, DEFAULT_SONAR_HOST, DEFAULT_SONAR_TOKEN);

    console.log('\n🔐 SonarQube Login');
    console.log(`Username: ${email}`);
    console.log(`Password: ${DEFAULT_SONAR_PASSWORD}`);
    console.log(`${DEFAULT_SONAR_HOST}/dashboard?id=${projectKey}\n`);
  } else {
    logInfo('No git email found — skipping user setup. Run: git config user.email "your@email.com"');
  }

  // STEP 3: Write config
  await fs.writeFile(propsPath, `# Auto-generated by cs-devtest
sonar.host.url=${DEFAULT_SONAR_HOST}
sonar.login=${DEFAULT_SONAR_TOKEN}
sonar.projectKey=${projectKey}
sonar.projectName=${projectName}
sonar.sources=.
sonar.javascript.node.maxspace=4096
sonar.exclusions=**/node_modules/**,**/dist/**,**/build/**,**/.next/**,**/coverage/**,**/.venv/**
`);

  logSuccess(`Created ${propsPath}`);
};
