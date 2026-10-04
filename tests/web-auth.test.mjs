import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const auth = require('../server/web-auth.js');

test('password hashes have unique salts and reject wrong or malformed passwords', async () => {
  const first = await auth.hashPassword('correct horse battery');
  const second = await auth.hashPassword('correct horse battery');
  assert.notEqual(first, second);
  assert.equal(await auth.verifyPassword('correct horse battery', first), true);
  assert.equal(await auth.verifyPassword('wrong horse battery', first), false);
  assert.equal(await auth.verifyPassword('correct horse battery', 'broken'), false);
  assert.equal(await auth.verifyPassword('correct horse battery', first.replace('scrypt', 'plaintext')), false);
  await assert.rejects(auth.hashPassword('short'), /10/);
});

test('username normalization prevents casing ambiguity and prototype-shaped accounts', () => {
  assert.equal(auth.normalizeUsername(' Reader_01 '), 'reader_01');
  for (const value of ['a', '读者', 'a@b', 'a'.repeat(33), {}, '__proto__']) {
    assert.throws(() => auth.normalizeUsername(value));
  }
});

test('production cookies are host scoped and browser identity is never stored in localStorage', () => {
  const cookie = auth.buildCookie('a'.repeat(43), { secure: true });
  assert.match(cookie, /^__Host-blacklight_web=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /Path=\//);
  assert.doesNotMatch(cookie, /Domain=/);
  assert.match(auth.buildCookie('', { secure: false, clear: true }), /Max-Age=0/);
});

test('CSRF tokens depend on cookie secret and origin must match configured origin', () => {
  const token = 'b'.repeat(43);
  assert.equal(auth.validCsrf(token, auth.csrfFor(token)), true);
  assert.equal(auth.validCsrf(token, auth.csrfFor('c'.repeat(43))), false);
  assert.equal(auth.validCsrf(token, []), false);
  assert.equal(auth.sameOrigin('https://club.example', 'https://club.example'), true);
  for (const value of [undefined, 'null', 'https://evil.example', 'https://club.example.evil', 'https://club.example/path']) {
    assert.equal(auth.sameOrigin(value, 'https://club.example'), false);
  }
});

test('interaction flags permit resonance on comments-disabled posts and deny private or guest interactions', () => {
  const policies = require('../shared/policies.js');
  const member = policies.buildViewer({ userId: 'reader', role: 'member', memberStatus: 'active', clubId: 'heiguang' });
  const post = { clubId: 'heiguang', ownerId: 'writer', status: 'published', visibility: 'club', commentsEnabled: false };
  const flags = policies.computePostViewerFlags(member, post);
  assert.equal(flags.canComment, false);
  assert.equal(flags.canReact, true);
  assert.equal(flags.canBookmark, true);
  assert.equal(policies.computePostViewerFlags(member, { ...post, visibility: 'private' }).canReact, false);
  assert.equal(policies.computePostViewerFlags(policies.buildViewer({ clubId: 'heiguang' }), post).canReact, false);
});

test('manual text review and website identities never call WeChat or auto-approve text', async (t) => {
  const previous = process.env.REVIEW_PROVIDER;
  t.after(() => { if (previous === undefined) delete process.env.REVIEW_PROVIDER; else process.env.REVIEW_PROVIDER = previous; });
  const { checkText } = require('../cloudfunctions/worker/tasks/review.js');
  process.env.REVIEW_PROVIDER = 'manual';
  assert.deepEqual(await checkText('待审文字', 'legacy-openid', 'heiguang'), { pass: false, suspect: true, label: 'manual-review' });
  process.env.REVIEW_PROVIDER = 'wechat';
  assert.deepEqual(await checkText('网站身份的文字', 'web:server-issued-reference', 'heiguang'), { pass: false, suspect: true, label: 'manual-review' });
});
