import fs from 'fs';
import path from 'path';

const summaryPath = path.resolve('coverage', 'coverage-summary.json');
if (!fs.existsSync(summaryPath)) {
  console.error(`Coverage summary not found at ${summaryPath}`);
  process.exit(1);
}

const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf-8'));

const thresholds = [
  { suffix: path.join('src', 'acp', 'sessionCoordinator.ts'), minLines: 80 },
  { suffix: path.join('src', 'acp', 'interactionBridge.ts'), minLines: 80 },
  { suffix: path.join('src', 'acp', 'pathPolicy.ts'), minLines: 80 },
  { suffix: path.join('src', 'webview', 'sendMessagePipeline.ts'), minLines: 80 },
  { suffix: path.join('src', 'store.ts'), minLines: 80 },
  { suffix: path.join('src', 'authService.ts'), minLines: 40 },
  { suffix: path.join('src', 'thinkingParser.ts'), minLines: 80 },
  { suffix: path.join('src', 'webviewHandler.ts'), minLines: 45 },
  { suffix: path.join('src', 'cliDiscovery.ts'), minLines: 60 },
  { suffix: path.join('src', 'process', 'portDiscovery.ts'), minLines: 60 },
  { suffix: path.join('src', 'shared', 'jsonFileStore.ts'), minLines: 60 },
];

let hasFailure = false;

for (const rule of thresholds) {
  const key = Object.keys(summary).find((entry) => entry.endsWith(rule.suffix));

  if (!key) {
    const expectedPath = path.resolve(rule.suffix);
    if (!fs.existsSync(expectedPath)) {
      console.warn(`Skipping removed file threshold: ${rule.suffix}`);
      continue;
    }
    console.error(`Missing coverage entry: ${rule.suffix}`);
    hasFailure = true;
    continue;
  }

  const pct = summary[key]?.lines?.pct;
  if (typeof pct !== 'number') {
    console.error(`Coverage data missing lines.pct for ${rule.suffix}`);
    hasFailure = true;
    continue;
  }

  if (pct < rule.minLines) {
    console.error(`Coverage below threshold for ${rule.suffix}: ${pct}% < ${rule.minLines}%`);
    hasFailure = true;
    continue;
  }

  console.log(`Coverage OK ${rule.suffix}: ${pct}%`);
}

const totalLinesPct = summary?.total?.lines?.pct;
const totalMinLines = 80;
if (typeof totalLinesPct !== 'number') {
  console.error('Coverage data missing total.lines.pct');
  hasFailure = true;
} else if (totalLinesPct < totalMinLines) {
  console.error(
    `Coverage below total threshold: ${totalLinesPct}% < ${totalMinLines}%`,
  );
  hasFailure = true;
} else {
  console.log(`Coverage OK total: ${totalLinesPct}%`);
}

if (hasFailure) {
  process.exit(1);
}
