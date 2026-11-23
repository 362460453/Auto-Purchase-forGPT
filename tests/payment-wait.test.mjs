import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForSubscriptionPayment } from '../src/automation/payment-wait.mjs';

test('按钮长期禁用、提交后长期转圈或没有变化都持续等待，只提交一次', async () => {
  let seconds = 0;
  let clicks = 0;
  const steps = [];
  const outcome = await waitForSubscriptionPayment({
    readButton: async () => ({found:true, enabled:seconds >= 240}),
    readOutcome: async submitted => ({
      processing:submitted && seconds > 360 && seconds < 900,
      success:submitted && seconds >= 1200,
    }),
    submit: async () => { clicks++; return true; },
    wait: async () => { seconds++; },
    onStep: step => steps.push(step),
  });
  assert.equal(outcome.success, true);
  assert.equal(seconds, 1200);
  assert.equal(clicks, 1);
  assert.equal(steps.length, 4, '持续等待不能每轮刷日志');
});

test('提交前或提交后的明确拒付都停止等待，不进行额外提交', async () => {
  for (const afterSubmit of [false, true]) {
    let clicks = 0;
    await assert.rejects(waitForSubscriptionPayment({
      readButton: async () => ({found:true, enabled:true}),
      readOutcome: async submitted => ({error:submitted === afterSubmit ? 'Your card has been declined.' : ''}),
      submit: async () => { clicks++; return true; }, wait: async () => {},
    }), /declined/);
    assert.equal(clicks, afterSubmit ? 1 : 0);
  }
});

test('按钮消失或布局稳定期间重新禁用时继续等，未提交的页面变化不当付款成功', async () => {
  let reads = 0;
  let attempts = 0;
  const outcome = await waitForSubscriptionPayment({
    readButton: async () => ({found:++reads > 2, enabled:true}),
    readOutcome: async () => ({success:true}),
    submit: async () => ++attempts > 1,
    wait: async () => {},
  });
  assert.equal(reads, 4);
  assert.equal(attempts, 2);
  assert.equal(outcome.success, true);
});
