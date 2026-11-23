import { AsyncLocalStorage } from 'node:async_hooks';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import { resolveProSelection, inspectPricingPage, inspectProPricingCard, inspectProCheckout, inspectCheckoutSubmitButton } from '../src/automation/pro-plans.mjs';

const upgradeSource = (await readFile(new URL('../src/automation/gpt-upgrade.mjs', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');

test('See all plans 后 Pro 延迟 90 秒仍继续，未加载只在整行上限结束且不进入购买', async () => {
  for (const delay of [90000, Infinity]) {
    let clock = 0, clickedAt, clicks = 0, selected = false;
    const context = vm.createContext({AsyncLocalStorage, AbortController,Date:{now:() => clock}, setTimeout:(fn, ms) => {clock += ms; fn();}});
    vm.runInContext(upgradeSource, context);
    const page = {command:async () => ({}), close(){}};
    context.connectChatGptPage = async () => page;
    context.evaluate = async () => ({origin:'https://chatgpt.com', pathname:'/', hash:'', ready:true});
    context.fillLoginIfNeeded = async () => {};
    context.readHomeUpgradeEntry = async () => ({text:'Upgrade', region:'top-right'});
    context.readPricingModalState = async () => true;
    context.clickExactText = async (_page, text) => {
      if (text === 'See all plans') {clicks++; clickedAt ??= clock;}
    };
    context.readProCard = async () => clickedAt !== undefined && clock - clickedAt >= delay ? {title:'Pro'} : null;
    context.selectProAmount = async () => {selected = true; throw Error('fixture-stop-before-purchase');};
    await assert.rejects(context.runWithTaskBudget(() => context.openChatGptAndPreparePayment({debugPort:1}, {}, 'Pro', {amount:'200'}, () => {}, () => {}, () => {}), () => clock < 600000, 600000),
      delay < Infinity ? /fixture-stop-before-purchase/ : /超过 10 分钟/);
    assert.equal(selected, delay < Infinity);
    assert.equal(clicks, 1);
    assert.ok(delay < Infinity ? clock - clickedAt >= delay : clock >= 600000);
  }
});

test('购买前 Pro 卡片重新渲染 90 秒时继续等待，卡片就绪后才点击并返回实际按钮名', async () => {
  for (const button of ['Buy now', 'Upgrade to Pro', 'Get started', 'Start now']) {
    let clock = 0, clickedAt;
    const context = vm.createContext({AsyncLocalStorage, AbortController,Date:{now:() => clock}, setTimeout:(fn, ms) => {clock += ms; fn();}});
    vm.runInContext(upgradeSource, context);
    context.readProCard = async () => clock < 90000 ? null : {title:'Pro', button, selected:true,
      point:{x:20, y:20}, viewport:{width:100, height:100}};
    context.mouseClick = async () => {clickedAt = clock;};
    context.evaluate = async () => true;
    assert.equal(await context.runWithTaskBudget(() => context.clickProCard({}, () => {}, '200'), () => clock < 600000, 600000), button);
    assert.ok(clickedAt >= 90000);
  }
});

test('升级入口兼容新版 /plans 和旧 #pricing，加载中及非套餐页不能通过', () => {
  const inspect = (path, text, origin = 'https://chatgpt.com') => {
    const url = new URL(path, origin);
    return vm.runInNewContext(`(${inspectPricingPage.toString()})()`, {
      location: url, document: { body: { innerText: text } },
    });
  };
  assert.equal(inspect('/plans?plus_checkout_rerun_return=fixture', 'Upgrade your plan'), true);
  assert.equal(inspect('/plans/', 'Pro Frontier intelligence Buy now'), true);
  assert.equal(inspect('/#pricing', 'Pro Frontier intelligence Upgrade to Pro'), true);
  assert.equal(inspect('/#pricing', 'Pro Frontier intelligence Get started'), true);
  assert.equal(inspect('/#pricing', 'Pro Frontier intelligence Start now'), true);
  assert.equal(inspect('/plans', 'Pro Frontier intelligence Start now'), true);
  assert.equal(inspect('/#pricing', 'Upgrade your plan'), true);
  assert.equal(inspect('/?promo=plus-1-month-free#pricing', 'Claim free offer See all plans'), true);
  assert.equal(inspect('/plans', 'Loading…'), false);
  assert.equal(inspect('/', 'Upgrade your plan'), false);
  assert.equal(inspect('/checkout/example', 'Frontier intelligence Buy now'), false);
  assert.equal(inspect('/plans-other', 'Upgrade your plan'), false);
  assert.equal(inspect('/plans', 'Upgrade your plan', 'https://example.com'), false);
});

test('AdsPower 三档金额、默认值和旧客户端映射', () => {
  for (const amount of ['100', '200', '500']) {
    assert.equal(resolveProSelection({ planAmount: amount }).amount, amount);
    assert.equal(resolveProSelection({ planAmount: Number(amount) }).amount, amount);
  }
  assert.equal(resolveProSelection().amount, '200');
  assert.equal(resolveProSelection({ multiplier: '20x' }).amount, '200');
  assert.equal(resolveProSelection({ multiplier: '5x' }).amount, '100');
  for (const planAmount of ['50', '1000', '', '5x', '200.01']) {
    assert.throws(() => resolveProSelection({ planAmount }), /只支持/);
  }
  assert.throws(() => resolveProSelection({ multiplier: '50x' }), /只支持/);
});

test('无痕模式维持原规格，与 AdsPower 金额分离', () => {
  assert.deepEqual(resolveProSelection({ rechargeType: 'google-incognito', multiplier: '5x', planAmount: '500' }), { multiplier: '5x', label: '5x' });
  assert.throws(() => resolveProSelection({ rechargeType: 'google-incognito', multiplier: '500' }));
});

function pricingFixture({ price = '100', selected = price, unrelatedBuy = true, unrelatedLabel = 'Buy now', proHasBuy = true, buyLabel = 'Buy now', duplicateBuy = false, frequency = '/ month', frequencyText = frequency, hiddenPrice = false, optionAmounts = ['100', '200', '500'], disabledOptions = false, duplicateCard = false } = {}) {
  const rect = (x) => ({ left: x, top: 50, width: 60, height: 30 });
  const control = (text, x, attrs = {}) => ({
    innerText: text, textContent: text, getBoundingClientRect: () => rect(x),
    getAttribute: (key) => attrs[key] ?? null,
  });
  const options = optionAmounts.map((amount, i) => control(amount, 100 + 80 * i,
    { 'aria-checked': String(selected === amount), 'aria-disabled': String(disabledOptions) }));
  const buy = control(buyLabel, 400);
  const priceSlot = {
    ...control(`$${price} $${price}${price} / month`, 100),
    getBoundingClientRect: () => hiddenPrice ? { width: 0, height: 0 } : rect(100),
    querySelector: (selector) => selector === '[data-testid="pricing-column-cost"] .sr-only'
      ? control(`$${price}`, 100) : selector === '[data-pricing-price-frequency]'
        ? { ...control(frequency, 100), textContent: frequencyText } : null,
  };
  const pro = {
    ...control(`Pro 100 200 500 Frontier intelligence ${buyLabel} $${price} $${price}${price} / month`, 100),
    querySelectorAll: (selector) => selector.includes('radiogroup') ? options : proHasBuy ? [buy, ...(duplicateBuy ? [control('Upgrade to Pro', 500)] : [])] : [],
    querySelector: (selector) => selector === '[data-testid="pro-pricing-column-cost"]' ? priceSlot : null,
  };
  const plus = {
    ...control(`Plus $20 / month ${unrelatedLabel}`, 900),
    querySelectorAll: () => [control(unrelatedLabel, 900)],
  };
  return {
    document: { querySelectorAll: (selector) => selector === '[data-pricing-plan="pro"]' ? [pro, ...(duplicateCard ? [pro] : [])] : [pro, ...(unrelatedBuy ? [plus] : [])] },
    getComputedStyle: () => ({ visibility: 'visible' }), innerWidth: 1200, innerHeight: 800,
  };
}

const readPricing = (amount, fixture) => vm.runInNewContext(`(${inspectProPricingCard.toString()})(${JSON.stringify(amount)})`, fixture);

test('三档选择以 Pro 卡片的实际月费为依据，购买按钮限制在该卡片', () => {
  for (const amount of ['100', '200', '500']) {
    const state = readPricing(amount, pricingFixture({ price: amount }));
    assert.equal(state.selected, true);
    assert.equal(state.amount, amount);
    assert.equal(state.point.x, 430);
  }
});

test('14621 三档 Pro 的 Upgrade to Pro 被识别；保留金额校验且不接受多个购买按钮', () => {
  const initial = readPricing('200', pricingFixture({buyLabel:'Upgrade to Pro'}));
  assert.equal(initial.button, 'Upgrade to Pro');
  assert.equal(initial.amount, '100');
  assert.equal(initial.selected, false);
  const selected = readPricing('200', pricingFixture({buyLabel:'Upgrade to Pro', price:'200'}));
  assert.equal(selected.selected, true);
  assert.equal(selected.point.x, 430);
  assert.equal(readPricing('200', pricingFixture({duplicateBuy:true})), null);
  assert.equal(readPricing('200', pricingFixture({proHasBuy:false, buyLabel:'Upgrade to Pro'})), null);
});

test('14650 的 Get started 仅匹配 Pro 卡片，支持 500 档且不借用其他套餐同名按钮', () => {
  const fixture = options => pricingFixture({buyLabel:'Get started', unrelatedLabel:'Get started', ...options});
  const initial = readPricing('500', fixture());
  assert.equal(initial.button, 'Get started');
  assert.equal(initial.amount, '100');
  assert.equal(initial.selected, false);
  const selected = readPricing('500', fixture({price:'500'}));
  assert.equal(selected.selected, true);
  assert.equal(selected.point.x, 430);
  assert.equal(readPricing('500', fixture({price:'500', selected:'100'})).selected, false);
  assert.equal(readPricing('500', fixture({proHasBuy:false})), null);
  assert.equal(readPricing('500', fixture({duplicateBuy:true})), null);
});

test('14649 的 Start now 兼容三档金额，只接受 Pro 自己的唯一按钮及一致选中态', () => {
  const fixture = options => pricingFixture({buyLabel:'Start now', unrelatedLabel:'Start now', ...options});
  for (const price of ['100', '200', '500']) {
    const state = readPricing(price, fixture({price}));
    assert.equal(state.button, 'Start now');
    assert.equal(state.amount, price);
    assert.equal(state.selected, true);
    assert.equal(state.point.x, 430);
    const other = price === '100' ? '200' : '100';
    assert.equal(readPricing(price, fixture({price, selected:other})).selected, false);
    assert.equal(readPricing(price, fixture({price:other, selected:price})).selected, false);
  }
  assert.equal(readPricing('200', fixture({proHasBuy:false})), null);
  assert.equal(readPricing('200', fixture({duplicateBuy:true})), null);
});

test('连续任务使用四种购买文案时，每档金额仍可自动选择并进入结账', async () => {
  let clock = 0, buyLabel, price, purchased;
  const context = vm.createContext({AsyncLocalStorage, AbortController,inspectProPricingCard, Date:{now:()=>clock}, setTimeout:(fn,ms)=>{clock+=ms;fn();}});
  vm.runInContext(upgradeSource, context);
  context.evaluate = async (_page, expression) => expression.includes('Getting your plan ready')
    ? purchased : vm.runInNewContext(expression, pricingFixture({buyLabel, price, unrelatedLabel:buyLabel}));
  let expectedAmount;
  const page = {command:async (method, params) => {
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') {
      const optionIndex = [130, 210, 290].indexOf(params.x);
      if (optionIndex >= 0) price = ['100', '200', '500'][optionIndex];
      if (params.x === 430) {assert.equal(price, expectedAmount); purchased = true;}
    }
  }};
  for (buyLabel of ['Buy now', 'Upgrade to Pro', 'Get started', 'Start now']) {
    for (expectedAmount of ['100', '200', '500']) {
      price = expectedAmount === '100' ? '500' : '100'; purchased = false;
      assert.ok(await context.readAllPlansState(page, expectedAmount));
      await context.selectProAmount(page, expectedAmount);
      assert.equal(await context.clickProCard(page, ()=>{}, expectedAmount), buyLabel);
      assert.equal(purchased, true);
    }
  }
});

test('价格未更新或控件选中态不符时，不允许进入结账', () => {
  assert.equal(readPricing('500', pricingFixture({ price: '100', selected: '500' })).selected, false);
  assert.equal(readPricing('500', pricingFixture({ price: '500', selected: '100' })).selected, false);
  assert.equal(readPricing('500', pricingFixture({ price: '500', selected: '500' })).selected, true);
});

test('Pro 没有自己的购买按钮时不能爬到其他产品的购买按钮', () => {
  assert.equal(readPricing('100', pricingFixture({ proHasBuy: false })), null);
});

const readCheckout = (amount, text, path = '/checkout/example') => vm.runInNewContext(
  `(${inspectProCheckout.toString()})(${JSON.stringify(amount)})`,
  { document: { body: { innerText: text } }, location: { pathname: path } },
);

test('核对 Due today 而非侧边月费，错误金额及其他页面不得满足结账条件', () => {
  for (const amount of ['100', '200', '500']) {
    const state = readCheckout(amount, `ChatGPT Pro $${amount} / month Due today $${amount}.00`);
    assert.ok(state.checkout && state.pro && state.amountMatches);
  }
  assert.equal(readCheckout('500', 'Pro $500 / month Due today $100.00').amountMatches, false);
  assert.equal(readCheckout('500', 'Pro $500 / month').amountMatches, false);
  assert.equal(readCheckout('500', 'Pro Due today $500.01').amountMatches, false);
  assert.equal(readCheckout('500', 'Plus Due today $500.00').pro, false);
  assert.equal(readCheckout('500', 'Pro Due today $500.00', '/').checkout, false);
});

test('实机价格重复读屏及动画数字时仍读取唯一月费，非月付和隐藏价格不通过', () => {
  assert.equal(readPricing('200', pricingFixture({ price: '200' })).amount, '200');
  assert.equal(readPricing('200', pricingFixture({ price: '200', frequency: '/ year' })), null);
  assert.equal(readPricing('200', pricingFixture({ price: '200', hiddenPrice: true })), null);
});

test('实机月付节点含隐藏的响应式文案，不把 monthPer 拼接误判成非月付', () => {
  for (const frequency of ['/ month', 'Per month']) {
    assert.equal(readPricing('200', pricingFixture({ price: '200', frequency, frequencyText: '/ monthPer month ' })).selected, true);
  }
  assert.equal(readPricing('200', pricingFixture({ price: '200', frequency: '/ year', frequencyText: '/ yearPer month ' })), null);
});

const readSubmit = (labels, path = '/checkout/example', disabled = false) => vm.runInNewContext(
  `(${inspectCheckoutSubmitButton.toString()})()`, {
    location: { origin: 'https://chatgpt.com', pathname: path },
    document: { querySelectorAll: () => labels.map((text) => ({
      innerText: text, disabled, getAttribute: () => null,
      getBoundingClientRect: () => ({ left: 50, top: 100, width: 120, height: 40 }),
    })) }, getComputedStyle: () => ({ visibility: 'visible' }), innerWidth: 1200, innerHeight: 800,
  },
);
test('新旧提交按钮仅在结账页识别，歧义和取消订阅均不点击', () => {
  assert.equal(readSubmit(['Upgrade to Pro']).label, 'Upgrade to Pro');
  assert.equal(readSubmit(['Subscribe to Pro']).enabled, true);
  assert.equal(readSubmit(['Upgrade to Pro'], '/').found, false);
  assert.equal(readSubmit(['Unsubscribe']).found, false);
  assert.equal(readSubmit(['Upgrade to Pro', 'Subscribe']).found, false);
  assert.equal(readSubmit(['Upgrade to Pro'], '/checkout/example', true).enabled, false);
});


test('14643 无规格按钮的 Pro 入口转到配置页，部分加载或禁用控件不能误判', () => {
  for (const amount of ['100', '200', '500']) {
    const state = readPricing(amount, pricingFixture({optionAmounts:[], buyLabel:'Get started'}));
    assert.equal(state.selectionStage, 'checkout');
    assert.equal(state.selected, false);
    assert.equal(state.optionPoint, null);
    assert.equal(state.button, 'Get started');
    assert.equal(readPricing(amount, pricingFixture({optionAmounts:['100']})), null);
    assert.equal(readPricing(amount, pricingFixture({disabledOptions:true})), null);
    assert.equal(readPricing(amount, pricingFixture({optionAmounts:[], proHasBuy:false})), null);
    assert.equal(readPricing(amount, pricingFixture({optionAmounts:[], duplicateBuy:true})), null);
    assert.equal(readPricing(amount, pricingFixture({optionAmounts:[], duplicateCard:true})), null);
    assert.equal(readPricing(amount, pricingFixture({optionAmounts:[], frequency:'/ year'})), null);
  }
});
