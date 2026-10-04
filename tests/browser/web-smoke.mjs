/* global document, innerWidth, localStorage */
// Runs against an explicitly supplied isolated loopback server. It writes test
// content and account fixtures, so it deliberately rejects public hosts.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
const base = process.env.WEB_BROWSER_BASE;
if (!base || !['127.0.0.1', 'localhost'].includes(new URL(base).hostname)) throw new Error('WEB_BROWSER_BASE must point to your isolated loopback test server');
const modulePath = process.env.PLAYWRIGHT_MODULE;
if (!modulePath) throw new Error('Set PLAYWRIGHT_MODULE to installed playwright/index.mjs');
const { chromium } = await import(pathToFileURL(modulePath));
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const errors = [];
const evidence = process.env.WEB_BROWSER_EVIDENCE || 'docs/evidence/2026-10-04-web';
await mkdir(evidence, { recursive: true });
const checks = [];
function record(value) { checks.push(value); process.stdout.write(`${value}\n`); }
async function ready(page) { await page.locator('.loading').waitFor({ state: 'hidden' }); await page.waitForTimeout(100); assert.equal(await page.locator('.error-panel').count(), 0, await page.locator('body').innerText()); }
async function route(page, hash) { await page.goto(base + hash); await ready(page); }
async function action(page, name, payload = {}) {
  return page.evaluate(async ({ name, payload }) => {
    const session = (await (await fetch('/v1/web/session')).json()).data;
    const result = await (await fetch('/v1/web/action', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken }, body: JSON.stringify({ action: name, clubId: 'browser-heiguang', payload }) })).json();
    if (result.code !== 0) throw new Error(result.message);
    return result.data;
  }, { name, payload });
}
try {
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await desktop.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await route(page, '/#/login');
  await page.locator('[name=username]').fill('browser_editor');
  await page.locator('[name=password]').fill(process.env.WEB_BROWSER_TEST_PASSWORD || 'local browser password');
  await page.locator('form button[type=submit]').click();
  await page.waitForURL('**/#/home');
  await ready(page);
  assert.equal(await page.locator('.hero h1').innerText(), '留一盏灯，\n给每一种表达。');
  assert.ok(await page.locator('.post-card').count() >= 3);
  await page.waitForFunction(() => !document.querySelector('#toast').textContent);
  await page.screenshot({ path: `${evidence}/desktop-home.png`, fullPage: true });
  record('desktop login, scoped feed and screenshot passed');
  await route(page, '/#/post/browser-post1');
  await page.locator('form[data-form=comment] textarea').fill('在灯下认真写下的一次回应');
  await page.locator('[data-action=reaction]').click();
  await ready(page);
  // The user's unfinished reply must survive a separate interaction.
  assert.equal(await page.locator('form[data-form=comment] textarea').inputValue(), '在灯下认真写下的一次回应');
  await page.locator('form[data-form=comment] button[type=submit]').click();
  await ready(page);
  await page.locator('#toast').filter({ hasText: '等待审核' }).waitFor();
  record('resonance and reply submission preserve unfinished reply');
  await route(page, '/#/write');
  await page.locator('[name=visibility]').selectOption('private');
  await page.locator('[name=body]').fill('这是一段只属于自己的浏览器测试文字。');
  await page.locator('form button[type=submit]').click();
  await page.waitForURL('**/#/post/**');
  await ready(page);
  assert.match(await page.locator('.post-body').innerText(), /只属于自己/);
  assert.equal(await page.locator('.reading .scope-label').innerText(), '仅自己可见');
  record('private browser composition and post detail passed');
  for (const name of ['topics', 'boards', 'collections', 'contents/pending', 'messages', 'settings', 'confirmations']) { await route(page, `/#/${name}`); }
  await route(page, '/admin/');
  await page.locator('.shell').waitFor();
  assert.match(await page.locator('body').innerText(), /概览与审核/);
  await page.screenshot({ path: `${evidence}/desktop-admin.png`, fullPage: true });
  record('website cookie enters existing governance console');
  await route(page, '/#/home');
  const invite = await action(page, 'admin/invites/create', { mode: 'application', maxUses: 2, ttlSeconds: 3600, reason: '浏览器自动化验证成员入社申请流程' });
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const phone = await mobile.newPage();
  phone.on('pageerror', (error) => errors.push(error.message));
  await route(phone, '/#/register');
  const account = `phone_${Date.now().toString(36)}`;
  await phone.locator('[name=username]').fill(account);
  await phone.locator('[name=displayName]').fill('手机读者');
  await phone.locator('[name=password]').fill('local mobile password');
  await phone.locator('[name=confirmPassword]').fill('local mobile password');
  await phone.locator('[name=agreement]').check();
  await phone.locator('form button[type=submit]').click();
  await phone.waitForURL('**/#/clubs');
  await ready(phone);
  await phone.locator('[data-action=select-club][data-id=browser-heiguang]').click();
  await ready(phone);
  await route(phone, '/#/join');
  await phone.locator('[name=inviteCode]').fill(invite.code);
  await phone.locator('form[data-form=join] input[type=checkbox]').check();
  await phone.locator('form[data-form=join] button[type=submit]').click();
  await phone.locator('.notice').filter({ hasText: '等待审核' }).waitFor();
  const mine = await action(phone, 'membership/mine');
  await action(page, 'admin/membership/decide', { id: mine.applicationId, decision: 'approve', expectedVersion: mine.version });
  await route(phone, '/#/home');
  assert.ok(await phone.locator('.post-card').count() >= 3);
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await phone.waitForFunction(() => !document.querySelector('#toast').textContent);
  await phone.screenshot({ path: `${evidence}/mobile-home.png`, fullPage: false });
  record('mobile registration, invitation, admin approval, scoped feed and no overflow passed');
  await route(phone, '/#/post/browser-post3');
  assert.equal(await phone.locator('.post-meta a[href*="profile"]').count(), 0);
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  record('anonymous author has no profile link on mobile');
  await route(phone, '/#/settings');
  await phone.locator('[data-action=logout]').click();
  await phone.waitForURL('**/#/login');
  await ready(phone);
  assert.equal(await phone.evaluate(() => Object.keys(localStorage).some((key) => /token|draft|password/.test(key))), false);
  assert.deepEqual(errors, []);
  record('logout, no persistent sensitive browser state and no JavaScript errors passed');
  await writeFile(`${evidence}/browser-results.json`, JSON.stringify({ checks, errors, date: new Date().toISOString() }, null, 2));
} finally { await browser.close(); }
