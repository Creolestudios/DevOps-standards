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

// ─────────────────────────────────────────────────────────────
// CREATE SONAR PROJECT (existing logic)
// ─────────────────────────────────────────────────────────────
async function ensureProjectExists(projectKey, projectName, hostUrl, token) {
  if (!token) {
    logInfo('SONAR_TOKEN not set — skipping project creation.');
    return;
  }

  let parsedHost;
  try { parsedHost = new URL(hostUrl); }
  catch { logInfo(`Invalid SonarQube URL "${hostUrl}" — skipping.`); return; }

  const http = parsedHost.protocol === 'https:' ? require('https') : require('http');

  const auth = Buffer.from(`${token}:`).toString('base64');
  const postData = `name=${encodeURIComponent(projectName)}&project=${encodeURIComponent(projectKey)}&visibility=private`;

  return new Promise((resolve) => {
    const req = http.request({
      hostname: parsedHost.hostname,
      port: parsedHost.port || (parsedHost.protocol === 'https:' ? 443 : 80),
      path: '/api/projects/create',
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if ([200, 201].includes(res.statusCode)) {
          logSuccess(`Project "${projectKey}" created.`);
        } else if (data.includes('already exists')) {
          logInfo(`Project "${projectKey}" already exists.`);
        }
        resolve();
      });
    });

    req.on('error', () => resolve());
    req.write(postData);
    req.end();
  });

  // Also ensure existing projects are set to private
  await new Promise((resolve) => {
    const updateReq = http.request({
      hostname: parsedHost.hostname,
      port: parsedHost.port || (parsedHost.protocol === 'https:' ? 443 : 80),
      path: '/api/projects/update_visibility',
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(`project=${encodeURIComponent(projectKey)}&visibility=private`),
      }
    }, (res) => {
      res.on('data', () => {});
      res.on('end', resolve);
    });
    updateReq.on('error', () => resolve());
    updateReq.write(`project=${encodeURIComponent(projectKey)}&visibility=private`);
    updateReq.end();
  });
}

// ─────────────────────────────────────────────────────────────
// CREATE / UPDATE USER
// ─────────────────────────────────────────────────────────────
function changeUserPassword(email, password, parsedHost, auth) {
  const http = parsedHost.protocol === 'https:' ? require('https') : require('http');
  const postData = `login=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}`;

  return new Promise((resolve) => {
    const req = http.request({
      hostname: parsedHost.hostname,
      port: parsedHost.port || (parsedHost.protocol === 'https:' ? 443 : 80),
      path: '/api/users/change_password',
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, () => resolve());

    req.on('error', () => resolve());
    req.write(postData);
    req.end();
  });
}

async function ensureUserExists(email, hostUrl, token, password = DEFAULT_SONAR_PASSWORD) {
  if (!email) return;

  let parsedHost;
  try { parsedHost = new URL(hostUrl); }
  catch { return; }

  const http = parsedHost.protocol === 'https:' ? require('https') : require('http');
  const auth = Buffer.from(`${token}:`).toString('base64');
  const postData = `login=${encodeURIComponent(email)}&name=${encodeURIComponent(getUsernameFromEmail(email))}&email=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}`;

  return new Promise((resolve) => {
    const req = http.request({
      hostname: parsedHost.hostname,
      port: parsedHost.port || (parsedHost.protocol === 'https:' ? 443 : 80),
      path: '/api/users/create',
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', async () => {
        if (data.includes('already exists')) {
          await changeUserPassword(email, password, parsedHost, auth);
        }
        resolve();
      });
    });

    req.on('error', () => resolve());
    req.write(postData);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────
// ASSIGN USER TO PROJECT
// ─────────────────────────────────────────────────────────────
async function assignUserToProject(email, projectKey, hostUrl, token) {
  if (!email) return;

  let parsedHost;
  try { parsedHost = new URL(hostUrl); }
  catch { return; }

  const http = parsedHost.protocol === 'https:' ? require('https') : require('http');
  const auth = Buffer.from(`${token}:`).toString('base64');

  const permissions = ['admin', 'user', 'codeviewer', 'scan', 'issueadmin', 'securityhotspotadmin'];

  for (const permission of permissions) {
    const postData = `login=${encodeURIComponent(email)}&projectKey=${encodeURIComponent(projectKey)}&permission=${permission}`;
    
    await new Promise((resolve) => {
      const req = http.request({
        hostname: parsedHost.hostname,
        port: parsedHost.port || (parsedHost.protocol === 'https:' ? 443 : 80),
        path: '/api/permissions/add_user',
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData),
        }
      }, (res) => {
        // Drain response
        res.on('data', () => {});
        res.on('end', resolve);
      });

      req.on('error', () => resolve());
      req.write(postData);
      req.end();
    });
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
