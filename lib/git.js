const fs = require('fs');
const path = require('path');

// Walks up directory tree to find .git folder
// Returns { found, gitRoot, projectRoot }
// gitRoot    = where .git is (where husky installs hooks)
// projectRoot = where package.json is (where scripts/sonar/tools live)
exports.isGitRepo = async () => {
  const projectRoot = process.cwd();
  let dir = projectRoot;

  while (true) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      return { found: true, gitRoot: dir, projectRoot };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }

  return { found: false, gitRoot: null, projectRoot };
};