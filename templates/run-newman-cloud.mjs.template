import newman from 'newman';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const apiKey = process.env.POSTMAN_API_KEY;
const collectionUid = process.env.COLLECTION_UID;
const reportPath = path.join(__dirname, '../newman-report.html');

if (!apiKey || !collectionUid) {
  console.error('Error: POSTMAN_API_KEY and COLLECTION_UID must be set in .env file or environment variables');
  process.exit(1);
}

const collectionUrl = `https://api.getpostman.com/collections/${collectionUid}?apikey=${apiKey}`;

console.log('--- Starting Newman Cloud Test ---');
console.log(`Fetching collection: ${collectionUrl.split('?')[0]}...`);

newman.run({
  collection: collectionUrl,
  reporters: ['cli', 'htmlextra'],
  reporter: {
    htmlextra: {
      export: reportPath
    }
  }
}, function (err, summary) {
  if (err) {
    console.error('Newman run failed:', err);
    process.exit(1);
  }

  console.log('Newman run complete!');
  console.log(`HTML Report generated at: ${reportPath}`);

  process.exit(summary.run.stats.assertions.failed > 0 ? 1 : 0);
});