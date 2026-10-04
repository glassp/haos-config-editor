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
await page.waitForFunction(() => document.title.includes('configuration.yaml'));
check(true, 'opens /config/configuration.yaml by default');
await page.tap('#btn-files');
await page.waitForSelector('#drawer.open .tree-row:has-text("automations.yaml")');
check((await page.locator('.tree-row[data-path="/config"]').count()) === 1 && (await page.locator('.tree-row[data-path="/share"]').count()) === 1, 'explorer root "/" lists /config and /share');
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

// toolbar: undo / redo / indent / outdent only
const keyLabels = await page.$$eval('#keybar button', (bs) => bs.map((b) => b.dataset.tip.split(':')[0].split(' ')[0]));
check(keyLabels.join() === 'Undo,Redo,Indent,Outdent', `toolbar has only undo, redo, indent, outdent (${keyLabels.join()})`);
await page.keyboard.press('Control+End');
await page.keyboard.insertText('\nx: 1');
check((await page.textContent('.cm-content')).includes('x: 1'), 'typed text present');
await page.tap('button[data-tip^="Undo"]');
check(!(await page.textContent('.cm-content')).includes('x: 1'), 'undo button reverts the change');
await page.tap('button[data-tip^="Redo"]');
check((await page.textContent('.cm-content')).includes('x: 1'), 'redo button re-applies it');
await page.tap('button[data-tip^="Indent"]');
check((await page.textContent('.cm-content')).includes('  x: 1'), 'indent button indents the line');
await page.tap('button[data-tip^="Outdent"]');
check(!(await page.textContent('.cm-content')).includes('  x: 1'), 'outdent button outdents the line');

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
