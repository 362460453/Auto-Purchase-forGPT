import { AsyncLocalStorage } from 'node:async_hooks';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { resolveAdditionalOptions, completePostPurchase, initialPostPurchaseResult, interruptedPostPurchaseResult } from '../src/automation/post-purchase.mjs';
import { resolveProSelection } from '../src/automation/pro-plans.mjs';
import { buildResultsCsv } from '../public/task-export.js';

test('旧客户端默认截图，显式空选项跳过，预留功能不能假成功', () => {
  assert.deepEqual(resolveAdditionalOptions(), ['screenshot']);
  assert.deepEqual(resolveAdditionalOptions([]), []);
  assert.deepEqual(resolveAdditionalOptions(['2fa', 'screenshot']), ['2fa', 'screenshot']);
  assert.deepEqual(resolveAdditionalOptions(['screenshot', 'screenshot']), ['screenshot']);
  for (const value of [null, {}, 'screenshot', ['unknown']]) {
    assert.throws(() => resolveAdditionalOptions(value));
  }
});

test('只执行已选截图，截图失败单独返回', async () => {
  let captures = 0;
  const capture = async () => { captures++; return {screenshotUrl:'/api/screenshots/test.png'}; };
  assert.equal((await completePostPurchase([], capture)).screenshotStatus, 'skipped');
  assert.equal(captures, 0);
  assert.equal((await completePostPurchase(['screenshot'], capture)).screenshotStatus, 'completed');
  assert.equal(captures, 1);
  assert.equal((await completePostPurchase(['screenshot'], async () => { throw Error('截图不可用'); })).screenshotError, '截图不可用');
  assert.equal((await completePostPurchase(['screenshot'], async () => ({}))).screenshotStatus, 'failed');
});

const source = (await readFile(new URL('../src/automation/gpt-upgrade.mjs', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
async function runScenario({options = [], decline = false, captureError = false, timeout = false, paymentPending = false, twoFactorPending = false, cpaPending = false, cpaFailure = false} = {}) {
  const events = [];
  let captures = 0;
  let stops = 0;
  const context = vm.createContext({AsyncLocalStorage, AbortController,
    resolveAdditionalOptions, completePostPurchase, initialPostPurchaseResult, interruptedPostPurchaseResult, resolveProSelection,
    setTimeout: (fn, delay) => setTimeout(fn, timeout ? 25 : delay), clearTimeout,
    startAdsPowerProfile: async () => ({debugPort:1}),
    stopAdsPowerProfile: async () => { stops++; },
  });
  vm.runInContext(source, context);
  // 仅替换外部浏览器工作，实际并发池、超时、成功/失败事件与 Profile 清理由生产代码执行。
  context.openChatGptAndPreparePayment = async (_profile, _row, _product, _selection, _status, _plans, step, proof) => {
    step('第一次点击后出现支付结果');
    if (decline) throw Error('Your card was declined.');
    if (paymentPending) return new Promise(() => {});
    proof.onPaymentConfirmed();
    return completePostPurchase(proof.additionalOptions, async () => {
      captures++;
      if (timeout && !twoFactorPending && !cpaPending) return new Promise(() => {});
      if (captureError) throw Error('截图不可用');
      return {screenshotUrl:'/api/screenshots/test.png'};
    }, step, {onProgress:proof.onPostPurchaseProgress, exportCpa:async () => {
      if (cpaPending) return new Promise(() => {});
      if (cpaFailure) return {cpaStatus:'failed', cpaError:'Codex 要求添加手机号，已终止 CPA 授权', cpaJson:''};
      return {cpaStatus:'completed', cpaJson:'fixture-json'};
    }, setupTwoFactor:async update => {
      update({twoFactorKey:'JBSWY3DPEHPK3PXP', twoFactorStatus:'pending'});
      if (twoFactorPending) return new Promise(() => {});
      return {twoFactorKey:'JBSWY3DPEHPK3PXP', twoFactorStatus:'completed'};
    }});
  };
  const results = await context.runUpgradeJob({jobId:'test', additionalOptions:options,
    rows:[{adsPowerSerialNumber:'test', email:'test@example.invalid', cardNumber:'fixture', expires_at:'0931', cvv:'fixture', __uiIndex:7}],
    onEvent:event => events.push(event),
  });
  return {events, results, captures, stops};
}

test('支付成功且未选截图直接完成，保留原行号并关闭当前 Profile', async () => {
  const result = await runScenario();
  assert.equal(result.captures, 0);
  assert.equal(result.stops, 1);
  assert.equal(result.results[0].status, 'succeeded');
  const success = result.events.find(e => e.type === 'row_succeeded');
  assert.equal(success.index, 7);
  assert.equal(success.screenshotStatus, 'skipped');
});

test('点击后拒付仍失败，不执行截图、不发送成功事件', async () => {
  const result = await runScenario({options:['screenshot'], decline:true});
  assert.equal(result.results[0].status, 'failed');
  assert.equal(result.captures, 0);
  assert.equal(result.stops, 1);
  assert.ok(result.events.some(e => e.type === 'row_failed' && e.message.includes('declined')));
  assert.ok(!result.events.some(e => e.type === 'row_succeeded'));
});

test('选中截图等待完成，失败及超时均保留已付款成功状态', async () => {
  for (const extra of [{}, {captureError:true}, {timeout:true}]) {
    const result = await runScenario({options:['screenshot'], ...extra});
    assert.equal(result.captures, 1);
    assert.equal(result.results[0].status, 'succeeded');
    assert.ok(!result.events.some(e => e.type === 'row_failed'));
    const success = result.events.find(e => e.type === 'row_succeeded');
    assert.equal(success.screenshotStatus, extra.captureError || extra.timeout ? 'failed' : 'completed');
  }
});

test('结果 CSV 保留套餐快照和特殊字符，空 CPA/2FA，不包含支付资料', () => {
  const csv = buildResultsCsv([
    {email:'test@example.invalid', password:'a,"b\nc', cardNumber:'CARD-MUST-NOT-EXPORT', billingAddressLine1:'ADDRESS-MUST-NOT-EXPORT', cpa:'DO-NOT-INVENT', '2fa':'DO-NOT-INVENT'},
    {email:'pending@example.invalid', password:'plain'},
  ], [{status:'已完成', subscriptionType:'Pro / $100 / 月', screenshotStatus:'skipped', completedAt:'2026-11-20T00:00:00Z'}], 'Pro / $500 / 月');
  assert.ok(csv.startsWith('\uFEFF"邮箱","密码","订阅类型","cpa","2fa"'));
  assert.ok(csv.includes('"a,""b\nc","Pro / $100 / 月","",""'));
  assert.ok(csv.includes('"pending@example.invalid","plain","Pro / $500 / 月"'));
  assert.ok(csv.includes('"已完成","","未勾选"'));
  assert.ok(!/MUST-NOT-EXPORT|DO-NOT-INVENT/.test(csv));
  assert.ok(csv.endsWith('\r\n'));
});

test('付款未确认时也受整条任务 10 分钟上限限制，不能因步骤文字标成成功', async () => {
  const result = await runScenario({options:[], timeout:true, paymentPending:true});
  assert.equal(result.results[0].status, 'failed');
  assert.equal(result.captures, 0);
  assert.ok(result.events.some(e => e.type === 'row_failed' && e.message.includes('超过 10 分钟')));
  assert.ok(!result.events.some(e => e.type === 'row_succeeded'));
});

test('2FA 阶段总超时保留 Key 和已完成截图，不进入充值失败重试', async () => {
  const result = await runScenario({options:['screenshot', '2fa'], timeout:true, twoFactorPending:true});
  const success = result.events.find(e => e.type === 'row_succeeded');
  assert.equal(success.screenshotStatus, 'completed');
  assert.equal(success.screenshotUrl, '/api/screenshots/test.png');
  assert.equal(success.twoFactorStatus, 'failed');
  assert.equal(success.twoFactorKey, 'JBSWY3DPEHPK3PXP');
  assert.equal(result.results[0].status, 'succeeded');
  assert.ok(!result.events.some(e => e.type === 'row_failed'));
});

test('只勾选 2FA 时不截图，支付成功之后才启用并导出', async () => {
  const success = await runScenario({options:['2fa']});
  assert.equal(success.captures, 0);
  assert.equal(success.results[0].twoFactorStatus, 'completed');
  const declined = await runScenario({options:['2fa'], decline:true});
  assert.equal(declined.results[0].status, 'failed');
  assert.ok(!declined.events.some(e => e.twoFactorKey));
});

test('CPA 要求手机号或总超时不重跑支付，保留截图；后续 2FA 超时不丢失 CPA', async () => {
  for (const options of [{cpaFailure:true}, {timeout:true, cpaPending:true}]) {
    const result = await runScenario({options:['screenshot', 'cpa'], ...options});
    assert.equal(result.results[0].status, 'succeeded');
    assert.equal(result.results[0].cpaStatus, 'failed');
    assert.equal(result.results[0].screenshotStatus, 'completed');
    assert.ok(!result.events.some(e => e.type === 'row_failed'));
    assert.ok(result.stops >= 1);
  }
  const result = await runScenario({options:['screenshot', 'cpa', '2fa'], timeout:true, twoFactorPending:true});
  assert.equal(result.results[0].cpaJson, 'fixture-json');
  assert.equal(result.results[0].cpaStatus, 'completed');
  assert.equal(result.results[0].twoFactorStatus, 'failed');
});
