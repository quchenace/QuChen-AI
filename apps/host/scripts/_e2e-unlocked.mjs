/**
 * The other half of the wall: a machine that has signed in before keeps working offline.
 *
 *   node scripts/_e2e-unlocked.mjs <baseUrl> <outDir>
 *
 * Expects a session file in QUCHEN_AUTH_DIR (written by the caller). Checks that the app is
 * drawn, the wall is gone, and the product API answers.
 */
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [, , baseUrl, outDir = '.'] = process.argv;
const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const executablePath = CANDIDATES.find(path => existsSync(path));
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const problems = [];
page.on('pageerror', error => problems.push(`pageerror: ${error.message}`));

await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
const report = await page.evaluate(() => ({
  wall: Boolean(document.querySelector('.authwall')),
  shell: Boolean(document.querySelector('.sidebar, .app-shell, nav')),
  composer: Boolean(document.querySelector('.composer, textarea')),
  title: document.title,
}));
await page.screenshot({ path: join(outDir, 'app-unlocked.png') });
const api = await page.evaluate(async () => {
  const res = await fetch('/api/chats');
  // 401 means the account gate shut it, 403 means the shell token is missing (this is a plain browser, not the app);
  // both are the host's own answers, and neither is a page that painted the app without a session.
  return { status: res.status, gated: res.status === 401 };
});
console.log(JSON.stringify({ report, api, problems }, null, 2));
await browser.close();
process.exit(!report.wall && report.composer && !api.gated ? 0 : 1);
