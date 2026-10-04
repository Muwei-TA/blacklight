/* global document, window, history, localStorage */
// Product-manager acceptance scenarios against the isolated loopback test site.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
const base = process.env.WEB_BROWSER_BASE;
if (!base || !['127.0.0.1', 'localhost'].includes(new URL(base).hostname)) throw new Error('WEB_BROWSER_BASE must use the isolated loopback test server');
if (!process.env.PLAYWRIGHT_MODULE) throw new Error('PLAYWRIGHT_MODULE is required');
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const out = process.env.WEB_BROWSER_EVIDENCE || '/workspace/artifacts/product-review/acceptance';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const results = [], errors = [];
async function ready(page) {
  await page.locator('.page-layout').waitFor();
  await page.locator('.loading').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.error-panel').count(), 0);
}
async function route(page, hash) { await page.goto(base + '/' + hash); await ready(page); }
async function screenshot(page, name) {
  // Full-page captures place sticky controls at the current scroll offset.
  // Start at the top so evidence shows the normal reading layout.
  await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
  await page.screenshot({ path: out + '/' + name + '.png', fullPage: true });
}
async function login(page, username = 'browser_reader', password = 'local browser password') {
  await page.locator('[name=username]').fill(username);
  await page.locator('[name=password]').fill(password);
  await page.locator('form button[type=submit]').click();
  await page.waitForURL(url => !['login', 'register'].some(name => url.hash.startsWith('#/' + name)));
  await ready(page);
}
async function check(name, fn) {
  try { await fn(); results.push({ name, passed: true }); process.stdout.write('PASS ' + name + '\n'); }
  catch (error) { results.push({ name, passed: false, error: error.message }); process.stdout.write('FAIL ' + name + ': ' + error.message.split('\n')[0] + '\n'); }
}
try {
  const guest = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await check('Privacy opens separately and preserves registration fields', async () => {
    const p = await guest.newPage();
    try {
      await route(p, '#/register?next=%23%2Fjoin');
      await p.locator('[name=username]').fill('pm_acceptance_draft');
      await p.locator('[name=displayName]').fill('测试读者');
      await p.locator('[name=password]').fill('local PM acceptance password');
      await p.locator('[name=confirmPassword]').fill('local PM acceptance password');
      const popupPromise = p.waitForEvent('popup');
      await p.locator('form a[href="#/privacy"]').click();
      const popup = await popupPromise; await popup.waitForLoadState();
      assert.equal(await p.locator('[name=username]').inputValue(), 'pm_acceptance_draft');
      assert.equal(await p.locator('[name=password]').inputValue(), 'local PM acceptance password');
      assert.equal(await p.locator('[name=confirmPassword]').inputValue(), 'local PM acceptance password');
      assert.equal(await p.locator('form').evaluate(form => form.checkValidity()), false, 'Consent remains required');
      assert.deepEqual(await p.evaluate(() => Object.keys(localStorage).filter(key => /password|draft|token/i.test(key))), []);
      await screenshot(p, 'registration-preserved');
      await popup.close();
    } finally { await p.close(); }
  });
  await check('Login resumes bookmarks instead of resetting to the home feed', async () => {
    const p = await guest.newPage();
    try {
      await route(p, '#/contents/bookmark'); await p.locator('form[data-form=login]').waitFor();
      await login(p); assert.equal(new URL(p.url()).hash, '#/contents/bookmark');
      await screenshot(p, 'login-resumes-bookmarks');
    } finally { await p.close(); }
  });
  const member = guest;
  await check('Guest login continues joining the selected club', async () => {
    const c = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await c.addInitScript(() => localStorage.setItem('blacklight.selectedClub', 'browser-heiguang'));
    const p = await c.newPage();
    try {
      await route(p, '#/join');
      assert.equal(await p.locator('form[data-form=join]').count(), 0);
      await p.locator('#content a[href^="#/login?next="]').click();
      await p.locator('form[data-form=login]').waitFor();
      await login(p, 'screenshots_visitor', 'local screenshot password');
      assert.equal(new URL(p.url()).hash, '#/join');
      await p.locator('form[data-form=join]').waitFor();
      await screenshot(p, 'login-resumes-join');
    } finally { await c.close(); }
  });
  await check('Browser Back cancellation preserves draft and approved departure confirms once', async () => {
    const p = await member.newPage(); const dialogs = [];
    const dismiss = async dialog => { dialogs.push(dialog.type()); await dialog.dismiss(); };
    try {
      await route(p, '#/home'); await p.locator('.hero a.button').click();
      await p.locator('form[data-form=write]').waitFor();
      await p.locator('[name=kind]').selectOption('article');
      await p.locator('[name=title]').fill('保留下来的标题');
      await p.locator('[name=visibility]').selectOption('private');
      await p.locator('[name=identityMode]').selectOption('anonymous');
      await p.locator('[name=body]').fill('不能因浏览器后退而丢失的草稿。');
      p.on('dialog', dismiss);
      await p.evaluate(() => new Promise(resolve => { window.addEventListener('hashchange', () => resolve(), { once: true }); history.back(); }));
      assert.equal(dialogs.length, 1);
      assert.equal(new URL(p.url()).hash, '#/write');
      assert.equal(await p.locator('[name=body]').inputValue(), '不能因浏览器后退而丢失的草稿。');
      assert.equal(await p.locator('[name=title]').inputValue(), '保留下来的标题');
      assert.equal(await p.locator('[name=visibility]').inputValue(), 'private');
      assert.equal(await p.locator('[name=identityMode]').inputValue(), 'anonymous');
      await screenshot(p, 'draft-preserved');
      p.off('dialog', dismiss);
      p.on('dialog', async dialog => { dialogs.push(dialog.type()); await dialog.accept(); });
      await p.locator('.mobile-brand').click(); await p.waitForURL('**/#/home'); await ready(p);
      assert.equal(dialogs.length, 2, 'Accepted link departure must not ask twice');
    } finally { await p.close(); }
  });
  await check('Private article reports only-self saved status and test content is removed', async () => {
    const p = await member.newPage(); let created = false;
    try {
      await route(p, '#/write');
      await p.locator('[name=kind]').selectOption('article');
      await p.locator('[name=visibility]').selectOption('private');
      await p.locator('[name=identityMode]').selectOption('anonymous');
      await p.locator('[name=title]').fill('pm-review 验收 '+Date.now());
      await p.locator('[name=body]').fill('仅用于隔离测试库的私密状态回归。');
      await p.locator('form button[type=submit]').click(); await p.waitForURL('**/#/post/**'); await ready(p); created = true;
      assert.equal(await p.locator('.reading .scope-label').innerText(), '仅自己可见');
      assert.equal(await p.locator('.reading .post-meta a[href*="profile"]').count(), 0);
      assert.match(await p.locator('#toast').innerText(), /已保存.*仅自己可见/);
      assert.doesNotMatch(await p.locator('#toast').innerText(), /审核/);
      await screenshot(p, 'private-saved');
    } finally {
      if (created) {
        await p.locator('[data-action=post-delete]').click(); await p.locator('dialog[open]').waitFor();
        await p.locator('dialog button[type=submit]').click(); await p.waitForURL('**/#/contents/**');
      }
      await p.close();
    }
  });
  await check('Reply target can be cancelled without losing the response draft', async () => {
    const p = await member.newPage();
    try {
      await route(p, '#/post/browser-post1');
      await p.locator('[data-action=reply-to]').first().click();
      await p.locator('form[data-form=comment] [name=body]').fill('保留这段未发送的回应。');
      await p.locator('form[data-form=comment] [name=anonymous]').check();
      assert.equal(await p.locator('[data-action=cancel-reply]').isVisible(), true, 'Selected reply target needs a cancel control');
      await screenshot(p, 'reply-target-control');
      await p.locator('[data-action=cancel-reply]').click(); await ready(p);
      assert.equal(await p.locator('[name=replyToId]').inputValue(), '');
      assert.equal(await p.locator('form[data-form=comment] [name=body]').inputValue(), '保留这段未发送的回应。');
      assert.equal(await p.locator('form[data-form=comment] [name=anonymous]').isChecked(), true);
      assert.equal(await p.locator('#reply-context').isHidden(), true);
      await screenshot(p, 'reply-target-cancelled');
    } finally { await p.close(); }
  });
  await check('Bookmarks and notification detail return to their originating list/tab', async () => {
    const p = await member.newPage();
    try {
      for (const source of ['#/contents/bookmark', '#/messages/reply']) {
        await route(p, source);
        const entry = p.locator('#content a[href^="#/post/"]').first(); await entry.click();
        await p.locator('.reading').waitFor(); await ready(p);
        assert.equal(await p.locator('.back-link').getAttribute('href'), source);
        await screenshot(p, source.includes('bookmark') ? 'bookmark-return' : 'notification-return');
        await p.locator('.back-link').click(); await p.waitForURL(url => url.hash === source); await ready(p);
      }
    } finally { await p.close(); }
  });
  await check('Changed pages fit desktop and phone, and anonymous authors remain unlinked', async () => {
    const p = await member.newPage();p.on('pageerror', error => errors.push(error.message));
    try {
      for (const width of [360, 390, 768, 1440]) {
        await p.setViewportSize({ width, height: 1000 });
        for (const hash of ['#/home', '#/write', '#/post/browser-post1', '#/contents/bookmark', '#/messages/reply']) {
          await route(p, hash); assert.equal(await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, hash + ' at ' + width);
        }
      }
      await route(p, '#/post/browser-post3');assert.equal(await p.locator('.reading .post-meta a[href*="profile"]').count(), 0);
    } finally { await p.close(); }
  });
  assert.deepEqual(errors, []);
} finally {
  await writeFile(out + '/results.json', JSON.stringify({ results, errors, date: new Date().toISOString() }, null, 2));
  await browser.close();
}
assert.equal(results.filter(r => !r.passed).length, 0, 'Product experience acceptance failures');
