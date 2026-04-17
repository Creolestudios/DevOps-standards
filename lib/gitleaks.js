'use strict';

const fs = require('fs-extra');
const path = require('path');
const execa = require('execa');
const https = require('https');
const { logInfo, logSuccess } = require('./logger');

const VERSION = '8.18.0';

function getPlatformAsset() {
  const archMap = { x64: 'x64', arm64: 'arm64', arm: 'armv7' };
  const arch = archMap[process.arch] || 'x64';

  if (process.platform === 'darwin') {
    return { filename: `gitleaks_${VERSION}_darwin_${arch}.tar.gz`, extract: 'tar', binary: 'gitleaks' };
  }
  if (process.platform === 'win32') {
    return { filename: `gitleaks_${VERSION}_windows_${arch}.zip`, extract: 'zip', binary: 'gitleaks.exe' };
  }
  return { filename: `gitleaks_${VERSION}_linux_${arch}.tar.gz`, extract: 'tar', binary: 'gitleaks' };
}

async function ensureGitignoreEntries(entries, gitRoot) {
  const gitignorePath = path.join(gitRoot || process.cwd(), '.gitignore');
  let content = await fs.pathExists(gitignorePath)
    ? await fs.readFile(gitignorePath, 'utf-8')
    : '';

  const added = [];
  for (const entry of entries) {
    // skip comments and empty lines for duplicate check
    if (entry.startsWith('#') || entry.trim() === '') {
      if (!content.includes(entry)) {
        content += `\n${entry}`;
      }
      continue;
    }
    if (!content.split('\n').some(l => l.trim() === entry.trim())) {
      content += `\n${entry}`;
      added.push(entry);
    }
  }

  if (added.length) {
    await fs.writeFile(gitignorePath, content);
    logInfo(`.gitignore updated — added: ${added.join(', ')}`);
  }
}

async function extractTar(archive, destDir) {
  await execa('tar', ['-xzf', archive, '-C', destDir]);
}

async function extractZip(archive, destDir) {
  if (process.platform === 'win32') {
    await execa('powershell', [
      '-NoProfile', '-Command',
      `Expand-Archive -Force -Path "${archive}" -DestinationPath "${destDir}"`,
    ]);
    return;
  }
  try {
    await execa('unzip', ['-o', archive, '-d', destDir]);
  } catch {
    try {
      await execa('python3', ['-c',
        `import zipfile; zipfile.ZipFile('${archive}').extractall('${destDir}')`]);
    } catch {
      throw new Error('Cannot extract zip — install `unzip` (apt/brew) or Python 3.');
    }
  }
}

exports.installGitleaks = async (gitRoot) => {
  const { filename, extract, binary } = getPlatformAsset();
  const gitleaksDir = path.join(process.cwd(), '.tools', 'gitleaks');
  const binaryPath = path.join(gitleaksDir, binary);

  logInfo('Installing Gitleaks locally (always overwrite)...');
  await fs.ensureDir(gitleaksDir);

  const url = `https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}/${filename}`;
  const destPath = path.join(gitleaksDir, filename);

  logInfo(`Downloading ${filename}...`);
  await downloadFile(url, destPath);

  logInfo(`Extracting...`);
  if (extract === 'tar') await extractTar(destPath, gitleaksDir);
  else await extractZip(destPath, gitleaksDir);

  await fs.remove(destPath);
  if (process.platform !== 'win32') await fs.chmod(binaryPath, 0o755);

await ensureGitignoreEntries([
  '# Dependencies',
  '**/node_modules/',
  '',
  '# Environment files',
  '**/.env',
  '**/.env.*',
  '**/.env.local',
  '',
  '# CS-Setup generated',
  '**/.tools/',
  // Husky hooks SHOULD be committed (do not ignore)
  '!.husky/',
  '!.husky/**',
  // CI pipeline scripts MUST be committed — required for GitHub Actions / CI to run
  '!scripts/',
  '!scripts/**',
  '!.github/scripts/',
  '!.github/scripts/**',
  '**/.gitleaksignore',
  '**/sonar-project.properties',
  '**/.scannerwork/',
  '',
  '# Generated files (reports/coverage only — NOT scripts)',
  '**/newman-report.html',
  '**/newman-reports/',
  '**/coverage/',
  '',
  '# Build outputs',
  '**/dist/',
  '**/build/',
  '',
  '# Logs',
  '**/*.log',
  '**/npm-debug.log*',
  '**/yarn-debug.log*',
  '**/yarn-error.log*',
  '',
  '# OS files',
  '**/.DS_Store',
  '**/Thumbs.db',
  '',
  '# IDE',
  '**/.vscode/',
  '**/.idea/',
], gitRoot);
  logSuccess('Gitleaks installed.');
};

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'node-cs-setup' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', err => { fs.remove(dest).catch(() => { }); reject(err); });
    }).on('error', reject);
  });
}
