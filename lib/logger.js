const chalk = require('chalk');

exports.logInfo = (msg) => console.log(chalk.blue(`ℹ ${msg}`));
exports.logSuccess = (msg) => console.log(chalk.green(`✔ ${msg}`));
exports.logError = (msg) => console.log(chalk.red(`✖ ${msg}`));