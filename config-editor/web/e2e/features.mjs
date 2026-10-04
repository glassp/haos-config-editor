// Tooltips, settings page, explorer visibility and parse_config: node e2e/features.mjs
import { chromium } from 'playwright-core';
const out = process.env.SHOTS ?? '.';
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
let fails = 0;
const check = (c, m) => { console.log(c ? 'ok  ' : 'FAIL', m); if (!c) fails++; };
const BASE = 'http://127.0.0.1:8099/';

// ---------- desktop: hover tooltips, settings, visibility
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.waitForFunction(() => document.title.includes('configuration.yaml'));

  // every toolbar control has a tooltip text
  const missing = await page.evaluate(() => [...document.querySelectorAll('#topbar button, #keybar button, .drawer-head button')].filter((b) => !b.dataset.tip && !b.hidden).map((b) => b.id || b.className));
  check(missing.length === 0, `all toolbar buttons have tooltips (missing: ${missing.join(', ') || 'none'})`);

  await page.hover('#btn-save');
  await page.waitForSelector('#tooltip.show');
  check((await page.textContent('#tooltip')).startsWith('Save this file'), 'desktop: tooltip on hover');
  await page.mouse.move(600, 400);
  await page.waitForFunction(() => !document.querySelector('#tooltip.show'));
  check(true, 'desktop: tooltip hides when the pointer leaves');
  await page.hover('button.key[data-tip^="Undo"]');
  await page.waitForSelector('#tooltip.show');
  await page.screenshot({ path: `${out}/f1-tooltip.png` });

  // settings page
  await page.click('#btn-files');
  await page.click('#btn-settings');
  await page.waitForSelector('.page.open');
  check((await page.textContent('.page')).includes('By default everything under "/" is shown'), 'settings page opens');
  await page.click('button:has-text("Add rule")');
  await page.fill('.rule input', '/config/secrets.yaml');
  await page.fill('input[aria-label="Path to test"]', '/config/secrets.yaml');
  check((await page.textContent('.test-result')).includes('Hidden'), 'test-a-path reports hidden');
  await page.screenshot({ path: `${out}/f2-settings.png` });
  await page.click('button:has-text("Save rules")');
  await page.waitForFunction(() => document.getElementById('toast')?.textContent.includes('saved'));
  await page.click('.page-head .icon-btn');
  await page.waitForFunction(() => !document.querySelector('.page'));
  await page.click('#btn-files').catch(() => {});
  await page.waitForSelector('#drawer.open .tree-row');
  check((await page.locator('.tree-row:has-text("secrets.yaml")').count()) === 0, 'hidden file disappears from the explorer');
  check((await page.locator('.tree-row:has-text("configuration.yaml")').count()) === 1, 'other files stay visible');
  // still reachable by the app: the !secret check keeps working
  await page.goto(BASE);
  await page.waitForFunction(() => document.title.includes('configuration.yaml'));
  await page.waitForTimeout(1200);
  check((await page.textContent('#btn-problems')).trim() === 'OK', 'hidden secrets.yaml is still used for validation');
  // reset rules for later runs
  await page.evaluate(() => fetch('api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-HA-Editor': '1' }, body: JSON.stringify({ visibility: [] }) }));
  await ctx.close();
}

// ---------- mobile: long-press tooltips, parse_config
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.waitForFunction(() => document.title.includes('configuration.yaml'));

  // long press on a toolbar button: tooltip, and the action must NOT run
  const box = await page.locator('button.key[data-tip^="Select the whole file"]').boundingBox();
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts });
  const pt = [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }];
  await touch('touchStart', pt);
  await page.waitForSelector('#tooltip.show', { timeout: 3000 });
  await touch('touchEnd', []);
  await page.waitForTimeout(150);
  check((await page.textContent('#tooltip')).startsWith('Select the whole'), 'mobile: long-press shows the tooltip');
  const selected = await page.evaluate(() => getSelection().toString().length);
  check(selected === 0, 'mobile: long-press does not trigger the action');
  await page.screenshot({ path: `${out}/f3-longpress.png` });
  await page.waitForFunction(() => !document.querySelector('#tooltip.show'), null, { timeout: 4000 });
  // a quick tap still runs the action
  await page.tap('button.key[data-tip^="Select the whole file"]');
  check(await page.evaluate(() => getSelection().toString().length > 10), 'mobile: normal tap still works');

  // parse_config fragment: opens with no problems, and typos are caught against the logger.logs schema
  await page.tap('#btn-files');
  await page.tap('.tree-row:has-text("logger_logs.yaml") .tree-main');
  await page.waitForFunction(() => document.title.includes('logger_logs.yaml'));
  await page.waitForTimeout(900);
  check((await page.textContent('#btn-problems')).trim() === 'OK', 'parse_config: valid fragment has no problems');
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('\nfoo.bar: shouting');
  await page.waitForTimeout(900);
  await page.tap('#btn-problems');
  check((await page.textContent('.sheet')).includes('Must be one of'), 'parse_config: value validated against logger.logs schema');
  await page.screenshot({ path: `${out}/f4-parse-config.png` });
  await ctx.close();
}
await browser.close();
console.log(fails ? `${fails} FAILED` : 'all good');
process.exit(fails ? 1 : 0);
