import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
function loader(check) {
  const output = { exports: {} };
  const cloud = { openapi: () => ({ security: { msgSecCheck: check } }) };
  vm.runInNewContext(readFileSync(new URL('../cloudfunctions/worker/tasks/review.js', import.meta.url), 'utf8'), {
    require: (name) => name === 'wx-server-sdk' ? cloud : name.endsWith('/constants') ? require('../shared/constants') : {},
    module: output, process: { env: { MINIPROGRAM_APP_ID: 'test-app' } }, Buffer,
  });
  return output.exports;
}
test('long text checks tail beyond 2500 and preserves boundary overlap', async () => {
  const segments = [];
  const { checkText } = loader(async ({ content }) => {
    segments.push(content);
    return { result: { suggest: content.includes('RISK_AT_TAIL') ? 'risky' : 'pass' } };
  });
  const result = await checkText('光'.repeat(6000) + 'RISK_AT_TAIL', 'test-user');
  assert.equal(result.pass, false);
  assert.equal(segments.length, 3);
  assert.ok(segments.every(x => Array.from(x).length <= 2500));
});
test('text service outage cannot pass or be reported as ordinary clean content', async () => {
  const { checkText } = loader(async () => { throw { errCode: -1, message: 'private content must not be logged' }; });
  await assert.rejects(checkText('正常文字', 'test-user'), { message: 'msgSecCheck failed: -1' });
});
