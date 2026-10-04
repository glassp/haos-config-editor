// Tab switcher test: node e2e/tabs.mjs
import { chromium } from 'playwright-core';
const out = process.env.SHOTS ?? '.';
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
let fails = 0;
const check = (c, m) => { console.log(c ? 'ok  ' : 'FAIL', m); if (!c) fails++; };

async function openFiles(page, names) {
  for (const n of names) {
    if (!(await page.locator('#drawer.open').count())) await page.locator('#btn-files').click();
    await page.locator(`.tree-row:has-text("${n}") .tree-main`).first().click();
    await page.waitForFunction((n) => document.title.includes(n), n);
  }
}

// ---- mobile
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto('http://127.0.0.1:8099/');
  await page.waitForFunction(() => document.title.includes('configuration.yaml'));
  await openFiles(page, ['f1.yaml', 'f2.yaml', 'f3.yaml']);
  check(await page.locator('.tabstrip').isHidden(), 'mobile: no tab strip');
  check((await page.textContent('#title-name')) === 'f3.yaml', 'mobile: title shows current file');
  check((await page.textContent('#tabs-count')) === '4', 'mobile: tab count badge (config + 3)');
  await page.tap('#btn-tabs');
  check((await page.locator('.tab-row').count()) === 4, 'popup lists all open tabs');
  await page.locator('.tab-row', { hasText: 'f1.yaml' }).locator('.pin-btn').tap();
  await page.waitForTimeout(100);
  const headings = await page.locator('.tabs-list h3').allTextContents();
  check(headings[0] === 'Pinned', 'pinned section on top');
  check((await page.locator('.tab-row').first().textContent()).includes('f1.yaml'), 'pinned tab listed first');
  await page.screenshot({ path: `${out}/t1-mobile-popup.png` });
  await page.locator('.tab-row', { hasText: 'f2.yaml' }).locator('.tab-row-main').tap();
  check((await page.textContent('#title-name')) === 'f2.yaml', 'tap row switches tab');
  await page.screenshot({ path: `${out}/t2-mobile-editor.png` });
  await ctx.close();
}
// ---- desktop
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto('http://127.0.0.1:8099/');
  await page.waitForFunction(() => document.title.includes('configuration.yaml'));
  await openFiles(page, ['f1.yaml', 'f2.yaml', 'f3.yaml', 'f4.yaml', 'f5.yaml', 'f6.yaml']);
  check((await page.locator('.tabstrip .tab').count()) === 5, 'desktop: quick strip shows 5 tabs');
  await page.locator('#btn-tabs').click();
  check((await page.locator('.tab-row').count()) === 7, 'desktop: popup shows all 7');
  await page.locator('.tab-row', { hasText: 'f1.yaml' }).locator('.pin-btn').click();
  await page.keyboard.press('Escape');
  check((await page.locator('.tabstrip .tab').first().textContent()).includes('f1.yaml') && (await page.locator('.tabstrip .tab').count()) === 5, 'desktop: pinned tab stays in quick strip');
  await page.screenshot({ path: `${out}/t3-desktop.png` });
  await ctx.close();
}
await browser.close();
process.exit(fails ? 1 : 0);
