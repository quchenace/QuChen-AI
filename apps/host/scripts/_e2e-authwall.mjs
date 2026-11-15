/**
 * End-to-end proof that an installed window cannot see the app before signing in.
 *
 *   node scripts/_e2e-authwall.mjs <baseUrl> <outDir>
 *
 * Drives the same Edge/Chrome that ships on the machine through playwright-core.
 * Checks three things a user would notice: the wall is drawn, the app behind it
 * is not, and the sign-in form is the first thing on screen.
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
if (!executablePath) throw new Error('no browser to drive');

mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });
const problems = [];
page.on('pageerror', error => problems.push(`pageerror: ${error.message}`));

await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.authwall', { timeout: 15000 });

const report = await page.evaluate(() => {
  const wall = document.querySelector('.authwall');
  const text = wall?.textContent ?? '';
  return {
    wall: Boolean(wall),
    title: document.querySelector('.authwall__title')?.textContent ?? '',
    tabs: [...document.querySelectorAll('.authwall__tab')].map(node => node.textContent),
    inputs: [...document.querySelectorAll('.authwall__input')].map(node => node.type),
    submit: document.querySelector('.authwall__panel button[type="submit"]')?.textContent ?? '',
    sidebar: Boolean(document.querySelector('.sidebar, .app-shell, nav')),
    // The app must not be reachable behind the wall: no chat composer, no monitor tabs.
    appMarkers: document.querySelectorAll('.composer, .monitor, [data-screen]').length,
  };
});
await page.screenshot({ path: join(outDir, 'authwall-login.png') });

// The register tab has to offer a verification code, or the wall is a dead end for new users.
await page.click('.authwall__tab:nth-child(2)');
await page.waitForTimeout(250);
const register = await page.evaluate(() => ({
  inputs: [...document.querySelectorAll('.authwall__input')].map(node => node.type),
  send: document.querySelector('.authwall__send')?.textContent ?? '',
}));
await page.screenshot({ path: join(outDir, 'authwall-register.png') });

// A wrong password must surface the account service's refusal in the panel, not in the console.
await page.click('.authwall__tab:nth-child(1)');
await page.fill('.authwall__input[type="email"]', 'nobody@quchen.dev');
await page.fill('.authwall__input[type="password"]', 'wrong-password-1');
await page.click('.authwall__panel button[type="submit"]');
const error = await page.waitForSelector('.authwall__error', { timeout: 15000 }).then(node => node.textContent()).catch(() => '');
await page.screenshot({ path: join(outDir, 'authwall-error.png') });

console.log(JSON.stringify({ report, register, error, problems }, null, 2));
await browser.close();
const ok = report.wall && report.tabs.length === 3 && report.appMarkers === 0 && register.inputs.length === 4 && Boolean(error);
process.exit(ok ? 0 : 1);
