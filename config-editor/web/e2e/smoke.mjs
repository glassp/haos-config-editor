// Mobile smoke test: node e2e/smoke.mjs  (expects the server on :8099 with a sample config)
import { chromium } from 'playwright-core';

const out = process.env.SHOTS ?? '.';
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const check = (cond, msg) => { if (!cond) { errors.push('FAIL: ' + msg); console.log('FAIL', msg); } else console.log('ok  ', msg); };

await page.goto(process.env.URL ?? 'http://127.0.0.1:8099/');
await page.waitForSelector('#drawer.open');
await page.screenshot({ path: `${out}/1-drawer.png` });

await page.tap('.tree-row:has-text("automations.yaml") .tree-main');
await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent.includes('Kitchen light at sunset'));
check(true, 'file opens with content');
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/2-editor.png` });

// type a typo'd key at the end and check validation + completion
const cm = page.locator('.cm-content');
await cm.click();
await page.keyboard.press('Control+End');
await page.keyboard.insertText('\n  triger: x');
await page.waitForTimeout(900);
check((await page.textContent('#btn-problems')).trim() !== 'OK', 'problem chip shows an error for a typo');
await page.tap('#btn-problems');
check((await page.textContent('.sheet')).includes('did you mean "trigger"'), 'problem message suggests fix');
await page.screenshot({ path: `${out}/3-problems.png` });
await page.keyboard.press('Escape');

// autocomplete: entity ids
await cm.click();
await page.keyboard.press('Control+a');
await page.keyboard.insertText('- action:\n  - service: light.turn_on\n    target:\n      entity_id: light.k');
await page.keyboard.type('i');
await page.waitForSelector('.cm-tooltip-autocomplete');
check((await page.textContent('.cm-tooltip-autocomplete')).includes('light.kitchen'), 'entity autocomplete');
await page.screenshot({ path: `${out}/4-complete.png` });
await page.keyboard.press('Escape');

// service data fields
await page.keyboard.press('Control+a');
await page.keyboard.insertText('- action:\n  - service: light.turn_on\n    data:\n      b');
await page.keyboard.type('r');
await page.waitForSelector('.cm-tooltip-autocomplete');
check((await page.textContent('.cm-tooltip-autocomplete')).includes('brightness_pct'), 'service field autocomplete');
await page.keyboard.press('Escape');

// copy / paste through the toolbar
await page.keyboard.press('Control+a');
await page.tap('button[title="Copy"]');
const clip = await page.evaluate(() => navigator.clipboard.readText());
check(clip.includes('brightness_pct') === false && clip.includes('service: light.turn_on'), 'toolbar copy writes selection to clipboard');
await page.keyboard.press('Control+End');
await page.tap('button[title="Paste"]');
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}/4b-paste.png` });
check((await page.textContent('.cm-content')).split('light.turn_on').length > 2, 'toolbar paste inserts clipboard text');

// save (revert first so the sample stays valid)
await page.tap('#btn-menu');
await page.screenshot({ path: `${out}/5-menu.png` });
await page.keyboard.press('Escape');

await page.tap('#btn-files');
await page.tap('.tree-row:has-text("configuration.yaml") .tree-main');
await page.waitForTimeout(900);
await page.screenshot({ path: `${out}/6-config.png` });
check(!(await page.textContent('#btn-problems')).includes('/') || (await page.textContent('#btn-problems')).trim() === 'OK', 'configuration.yaml has no problems');

console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'all good');
await browser.close();
process.exit(errors.length ? 1 : 0);
