'use strict';

const fs = require('fs-extra');
const path = require('path');
const { logInfo, logSuccess } = require('./logger');
const { installDevDependency } = require('./packageManager');
const { execSync } = require('child_process');

const SONAR_PROPS_FILE = 'sonar-project.properties';
const DEFAULT_SONAR_HOST = process.env.SONAR_HOST_URL || 'http://34.93.109.104:9000';
const DEFAULT_SONAR_TOKEN = process.env.SONAR_TOKEN || 'squ_317447c9e39d75ab10e7c1efa29c3bfb423a869e';

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
  const postData = `name=${encodeURIComponent(projectName)}&project=${encodeURIComponent(projectKey)}`;

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
}

// ─────────────────────────────────────────────────────────────
// CREATE USER
// ─────────────────────────────────────────────────────────────
async function ensureUserExists(email, hostUrl, token) {
  if (!email) return;

  let parsedHost;
  try { parsedHost = new URL(hostUrl); }
  catch { return; }

  const http = parsedHost.protocol === 'https:' ? require('https') : require('http');

  const postData = `login=${encodeURIComponent(email)}&name=${encodeURIComponent(getUsernameFromEmail(email))}&email=${encodeURIComponent(email)}&password=creole@123`;

  const auth = Buffer.from(`${token}:`).toString('base64');

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
    }, () => resolve());

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

  const postData = `login=${encodeURIComponent(email)}&projectKey=${encodeURIComponent(projectKey)}&permission=admin`;

  const auth = Buffer.from(`${token}:`).toString('base64');

  return new Promise((resolve) => {
    const req = http.request({
      hostname: parsedHost.hostname,
      port: parsedHost.port || (parsedHost.protocol === 'https:' ? 443 : 80),
      path: '/api/permissions/add_user',
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

  if (email && email.endsWith('@creolestudios.com')) {
    await ensureUserExists(email, DEFAULT_SONAR_HOST, DEFAULT_SONAR_TOKEN);
    await assignUserToProject(email, projectKey, DEFAULT_SONAR_HOST, DEFAULT_SONAR_TOKEN);

    console.log('\n🔐 SonarQube Login');
    console.log(`Username: ${email}`);
    console.log(`Password: Creole@123`);
    console.log(`${DEFAULT_SONAR_HOST}/dashboard?id=${projectKey}\n`);
  } else {
    logInfo('Company email not found — skipping user setup.');
  }

  // STEP 3: Write config
  await fs.writeFile(propsPath, `# Auto-generated by cs-setup
sonar.host.url=${DEFAULT_SONAR_HOST}
sonar.login=${DEFAULT_SONAR_TOKEN}
sonar.projectKey=${projectKey}
sonar.projectName=${projectName}
sonar.sources=.
`);

  logSuccess(`Created ${propsPath}`);
};
