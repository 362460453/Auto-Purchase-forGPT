import { startAdsPowerProfile, stopAdsPowerProfile } from './adspower.mjs';

export const PRODUCTS = ['Maximum power'];

const MULTIPLIERS = ['20x', '5x'];
const DOM_POLL_MILLISECONDS = 250;
const CHECKOUT_WAIT_MILLISECONDS = 45000;
const STRIPE_WAIT_MILLISECONDS = 30000;
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

let commandSequence = 0;

function connectCdp(webSocketUrl, timeoutMilliseconds = 30000) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const pending = new Map();
    const connectTimer = setTimeout(() => reject(new Error(`连接 CDP 超时：${webSocketUrl}`)), timeoutMilliseconds);

    socket.addEventListener('open', () => {
      clearTimeout(connectTimer);
      resolve({
        socket,
        command(method, params = {}, commandTimeoutMilliseconds = timeoutMilliseconds) {
          const id = ++commandSequence;
          return new Promise((commandResolve, commandReject) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              commandReject(new Error(`CDP 命令超时：${method}`));
            }, commandTimeoutMilliseconds);
            pending.set(id, {
              resolve: (result) => { clearTimeout(timer); commandResolve(result); },
              reject: (error) => { clearTimeout(timer); commandReject(error); },
            });
            socket.send(JSON.stringify({ id, method, params }));
          });
        },
        close() {
          try { socket.close(); } catch {}
        },
      });
    });
    socket.addEventListener('error', () => reject(new Error('无法连接 AdsPower 的 CDP 页面')));
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const callback = pending.get(message.id);
      if (!callback) return;
      pending.delete(message.id);
      message.error ? callback.reject(new Error(message.error.message)) : callback.resolve(message.result);
    });
  });
}

async function getTargets(debugPort) {
  const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
  if (!response.ok) throw new Error(`读取 AdsPower 页面失败：HTTP ${response.status}`);
  return response.json();
}

async function connectChatGptPage(debugPort) {
  const targets = await getTargets(debugPort);
  const target = targets.find((item) => item.type === 'page' && /chatgpt\.com/i.test(item.url || ''))
    || targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
  if (!target?.webSocketDebuggerUrl) throw new Error('AdsPower 没有可控制的页面');
  return connectCdp(target.webSocketDebuggerUrl);
}

async function evaluate(client, expression, awaitPromise = false) {
  const result = await client.command('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error('页面脚本执行失败');
  return result.result?.value;
}

async function waitForValue(readValue, acceptValue, timeoutMilliseconds, timeoutMessage) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastValue;
  while (Date.now() <= deadline) {
    lastValue = await readValue();
    if (acceptValue(lastValue)) return lastValue;
    await sleep(DOM_POLL_MILLISECONDS);
  }
  throw new Error(`${timeoutMessage}${lastValue ? `；页面状态：${JSON.stringify(lastValue)}` : ''}`);
}

async function mouseClick(client, point) {
  await client.command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await client.command('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await client.command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
}

async function clickExactText(client, text, options = {}) {
  const expectedText = JSON.stringify(text);
  const region = options.region || 'any';
  const readPoint = () => evaluate(client, `(() => {
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const visible = (node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== 'hidden';
      };
      const candidates = [...document.querySelectorAll('button,a,[role="button"],[role="radio"],[role="tab"],label')]
        .filter((node) => !node.disabled && visible(node) && normalize(node.innerText || node.textContent || node.getAttribute('aria-label')) === ${expectedText})
        .map((node) => {
          const rect = node.getBoundingClientRect();
          return {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
          };
        });
      const filtered = ${JSON.stringify(region)} === 'top-right'
        ? candidates.filter((item) => item.left > innerWidth * 0.55 && item.top < Math.min(220, innerHeight * 0.35))
        : candidates;
      filtered.sort((left, right) => ${JSON.stringify(region)} === 'top-right'
        ? right.left - left.left
        : left.top - right.top);
      return {
        readyState: document.readyState,
        point: filtered[0] || null,
        viewport: {width: innerWidth, height: innerHeight},
      };
    })()`);
  if (options.scrollIntoView) {
    const deadline = Date.now() + (options.timeoutMilliseconds || 15000);
    while (Date.now() <= deadline) {
      const state = await readPoint();
      const point = state?.point;
      const viewport = state?.viewport;
      const insideViewport = point && viewport
        && point.x >= 0 && point.x <= viewport.width
        && point.y >= 0 && point.y <= viewport.height;
      if (state?.readyState === 'complete' && insideViewport) break;
      if (point && viewport) {
        // 使用真实鼠标滚轮把屏幕外的链接滚入可视区域，不能直接点击屏幕外坐标。
        const deltaY = point.y > viewport.height ? 620 : -620;
        await client.command('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: Math.max(1, viewport.width / 2),
          y: Math.max(1, viewport.height / 2),
          deltaX: 0,
          deltaY,
        });
      }
      await sleep(300);
    }
  }
  const firstState = await waitForValue(
    readPoint,
    (state) => state?.readyState === 'complete' && state?.point
      && state.point.x >= 0 && state.point.x <= state.viewport.width
      && state.point.y >= 0 && state.point.y <= state.viewport.height,
    options.timeoutMilliseconds || 15000,
    options.timeoutMessage || `没有找到可点击的 ${text}`,
  );
  // React 页面可能先画出按钮再二次排版；位置连续稳定后才发送鼠标事件。
  await sleep(options.stabilityMilliseconds || 800);
  const stableState = await readPoint();
  const firstPoint = firstState.point;
  const stablePoint = stableState?.point;
  const moved = !stablePoint || Math.abs(firstPoint.x - stablePoint.x) > 4 || Math.abs(firstPoint.y - stablePoint.y) > 4;
  const clickPoint = moved
    ? (await waitForValue(readPoint, (state) => state?.readyState === 'complete' && state?.point, options.timeoutMilliseconds || 15000, `等待 ${text} 位置稳定超时`)).point
    : stablePoint;
  await mouseClick(client, clickPoint);
}

async function clickAndConfirm(client, text, options, confirmState, confirmTimeoutMilliseconds, confirmMessage) {
  await clickExactText(client, text, options);
  try {
    return await waitForValue(confirmState, Boolean, confirmTimeoutMilliseconds, confirmMessage);
  } catch (firstError) {
    // 只补点当前控件一次：页面完成水合前的鼠标事件可能被吞掉，但不能据此重跑整条任务。
    try {
      await clickExactText(client, text, { ...options, timeoutMilliseconds: Math.min(3000, options.timeoutMilliseconds || 3000) });
    } catch {
      throw firstError;
    }
    try {
      return await waitForValue(confirmState, Boolean, confirmTimeoutMilliseconds, confirmMessage);
    } catch {
      throw firstError;
    }
  }
}

async function waitForPageText(client, text, timeoutMilliseconds, timeoutMessage) {
  return waitForValue(
    () => evaluate(client, `(() => ({
      href: location.href,
      found: (document.body?.innerText || '').includes(${JSON.stringify(text)})
    }))()`),
    (state) => state?.found,
    timeoutMilliseconds,
    timeoutMessage,
  );
}

async function readPricingModalState(client) {
  return evaluate(client, `(() => {
    const bodyText = document.body?.innerText || '';
    return /#pricing$/.test(location.href) && bodyText.includes('Upgrade your plan');
  })()`);
}

async function readAllPlansState(client) {
  const card = await readMaximumPowerCard(client);
  return card || false;
}

async function readMaximumPowerCard(client) {
  return evaluate(client, `(() => {
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const marker = [...document.querySelectorAll('body *')]
      .find((node) => normalize(node.innerText || node.textContent) === 'Maximum power');
    if (!marker) return null;
    let card = marker;
    for (let depth = 0; card && depth < 10; depth += 1, card = card.parentElement) {
      const button = [...card.querySelectorAll('button,a,[role="button"]')]
        .find((node) => !node.disabled && normalize(node.innerText || node.textContent || node.getAttribute('aria-label')) === 'Upgrade to Pro');
      if (!button) continue;
      const rect = button.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      return {
        title: 'ChatGPT Pro',
        description: 'Maximum power',
        button: 'Upgrade to Pro',
        point: {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          top: rect.top,
          bottom: rect.bottom,
        },
        viewport: {width: innerWidth, height: innerHeight},
      };
    }
    return null;
  })()`);
}

async function clickMaximumPowerCard(client, onPlans) {
  // See all plans 点击后最多等待 5 秒；在 5 秒内发现 Maximum power 即立即继续。
  const card = await waitForValue(
    () => readMaximumPowerCard(client),
    Boolean,
    5000,
    '点击 See all plans 后等待 5 秒，仍未找到 ChatGPT Pro / Maximum power / Upgrade to Pro',
  );
  onPlans([{ title: card.title, description: card.description, button: card.button }]);
  let visibleCard = card;
  const deadline = Date.now() + 10000;
  while (Date.now() <= deadline) {
    const point = visibleCard?.point;
    const viewport = visibleCard?.viewport;
    if (point && viewport && point.x >= 0 && point.x <= viewport.width && point.y >= 0 && point.y <= viewport.height) break;
    if (point && viewport) {
      await client.command('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: viewport.width / 2,
        y: viewport.height / 2,
        deltaX: 0,
        deltaY: point.y > viewport.height ? 620 : -620,
      });
    }
    await sleep(300);
    visibleCard = await readMaximumPowerCard(client);
  }
  if (!visibleCard?.point || visibleCard.point.y < 0 || visibleCard.point.y > visibleCard.viewport.height) {
    throw new Error('已识别 Maximum power，但 Upgrade to Pro 未滚动到可视区域');
  }
  // 套餐列表展开后仍会继续排版；按钮稳定一秒后重新读取坐标，避免点击落在旧位置。
  await sleep(1000);
  visibleCard = await readMaximumPowerCard(client);
  if (!visibleCard?.point || visibleCard.point.y < 0 || visibleCard.point.y > visibleCard.viewport.height) {
    throw new Error('Maximum power 已识别，但 Upgrade to Pro 在点击前离开了可视区域');
  }
  await mouseClick(client, visibleCard.point);

  const readTransition = () => evaluate(client, `(() => {
    const text = document.body?.innerText || '';
    return /\\/checkout\\//.test(location.href) || text.includes('Getting your plan ready');
  })()`);
  try {
    await waitForValue(readTransition, Boolean, 12000, 'Upgrade to Pro 已点击，但页面没有进入购买流程');
  } catch (firstError) {
    // React 水合阶段可能吞掉第一次鼠标事件；只重新定位并补点当前 Upgrade to Pro 一次。
    const retryCard = await readMaximumPowerCard(client);
    if (!retryCard?.point || retryCard.point.y < 0 || retryCard.point.y > retryCard.viewport.height) throw firstError;
    await mouseClick(client, retryCard.point);
    try {
      await waitForValue(readTransition, Boolean, 12000, '补点 Upgrade to Pro 后仍未进入购买流程');
    } catch {
      throw firstError;
    }
  }
}

async function waitForCheckout(client) {
  return waitForValue(
    () => evaluate(client, `(() => ({
      href: location.href,
      configurePlan: (document.body?.innerText || '').includes('Configure your plan')
    }))()`),
    (state) => /\/checkout\//.test(state?.href || '') && state?.configurePlan,
    CHECKOUT_WAIT_MILLISECONDS,
    '点击 Upgrade to Pro 后支付页面未加载完成',
  );
}

async function selectMultiplier(client, multiplier) {
  const label = `${multiplier} more usage than Plus`;
  const point = await waitForValue(
    () => evaluate(client, `(() => {
      const label = ${JSON.stringify(label)};
      const visible = (node) => { const rect = node.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; };
      const node = [...document.querySelectorAll('[role="radio"],input[type="radio"],label,button')]
        .find((item) => visible(item) && (item.innerText || item.textContent || item.getAttribute('aria-label') || '').includes(label));
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
    })()`),
    Boolean,
    15000,
    `没有找到 ${multiplier} 套餐选项`,
  );
  await mouseClick(client, point);

  const expectedAmount = multiplier === '20x' ? '$200.00' : '$100.00';
  await waitForValue(
    () => evaluate(client, `(() => {
      const label = ${JSON.stringify(label)};
      const radios = [...document.querySelectorAll('[role="radio"],input[type="radio"]')];
      const selected = radios.some((node) => {
        const text = node.innerText || node.textContent || node.getAttribute('aria-label') || '';
        return text.includes(label) && (node.checked || node.getAttribute('aria-checked') === 'true');
      });
      const bodyText = (document.body?.innerText || '').replace(/\\s+/g, ' ');
      return {
        selected,
        // 单选卡片本身也显示价格，必须校验右侧 Due today 已更新，不能把旧价格当成功。
        amountReady: new RegExp('Due today\\\\s*' + ${JSON.stringify(expectedAmount.replace('$', '\\$'))}).test(bodyText),
      };
    })()`),
    (state) => state?.selected && state?.amountReady,
    10000,
    `${multiplier} 已点击，但价格没有更新为 ${expectedAmount}`,
  );
}

function keyDescriptor(character) {
  const value = String(character || '');
  if (/^\d$/.test(value)) return { key: value, code: `Digit${value}`, keyCode: value.charCodeAt(0) };
  if (/^[a-z]$/i.test(value)) {
    const upper = value.toUpperCase();
    return { key: value, code: `Key${upper}`, keyCode: upper.charCodeAt(0) };
  }
  if (value === ' ') return { key: ' ', code: 'Space', keyCode: 32 };
  return { key: value, code: '', keyCode: value.charCodeAt(0) || 0 };
}

async function dispatchKey(client, key, code, keyCode) {
  await client.command('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
  await client.command('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
}

async function typeWithKeyboard(client, text, options = {}) {
  const intervalMilliseconds = Math.max(20, Number(options.intervalMilliseconds) || 35);
  for (const character of String(text || '')) {
    const descriptor = keyDescriptor(character);
    await client.command('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: descriptor.key,
      code: descriptor.code,
      windowsVirtualKeyCode: descriptor.keyCode,
      nativeVirtualKeyCode: descriptor.keyCode,
    });
    await client.command('Input.dispatchKeyEvent', {
      type: 'char',
      key: descriptor.key,
      code: descriptor.code,
      text: character,
      unmodifiedText: character,
      windowsVirtualKeyCode: descriptor.keyCode,
      nativeVirtualKeyCode: descriptor.keyCode,
    });
    await client.command('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: descriptor.key,
      code: descriptor.code,
      windowsVirtualKeyCode: descriptor.keyCode,
      nativeVirtualKeyCode: descriptor.keyCode,
    });
    // 外部表单对连续输入较敏感，保留按键间隔，避免字符被 Stripe 等页面吞掉。
    await sleep(intervalMilliseconds);
  }
}

async function clearFocusedField(client, currentLength) {
  await dispatchKey(client, 'End', 'End', 35);
  for (let index = 0; index < Math.max(8, Number(currentLength || 0) + 4); index += 1) {
    await dispatchKey(client, 'Backspace', 'Backspace', 8);
  }
}

async function focusAndType(client, selector, value, options = {}) {
  const initial = await evaluate(client, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    element.scrollIntoView?.({block:'center', inline:'center'});
    element.focus();
    return {active: document.activeElement === element, length: String(element.value || '').length};
  })()`);
  if (!initial?.active) throw new Error(`输入框不存在或不能聚焦：${options.label || selector}`);

  // 所有输入都逐字符发送 keyDown/char/keyUp，随后 Tab 失焦，让页面自己的校验逻辑生效。
  await clearFocusedField(client, initial.length);
  await typeWithKeyboard(client, value, { intervalMilliseconds: options.intervalMilliseconds });
  await dispatchKey(client, 'Tab', 'Tab', 9);
  await sleep(300);

  // 银行卡三个字段会联动校验。填写过程中出现 incomplete 属于临时状态，必须等整组输入完成后再判断。
  if (options.validateAfterInput === false) return;

  const state = await evaluate(client, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    return {value: element.value || '', invalid: element.getAttribute('aria-invalid') === 'true'};
  })()`);
  const normalize = options.normalize || ((item) => String(item || '').trim());
  if (!state || normalize(state.value) !== normalize(value) || state.invalid) {
    throw new Error(`${options.label || selector} 的键盘输入未被页面接受`);
  }
}

async function chooseSelectWithKeyboard(client, selector, searchText, acceptedValues, label) {
  const initial = await evaluate(client, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    element.scrollIntoView?.({block:'center', inline:'center'});
    element.focus();
    return {active: document.activeElement === element};
  })()`);
  if (!initial?.active) throw new Error(`下拉框不存在或不能聚焦：${label}`);
  await dispatchKey(client, 'Home', 'Home', 36);
  await typeWithKeyboard(client, searchText);
  await dispatchKey(client, 'Enter', 'Enter', 13);
  await dispatchKey(client, 'Tab', 'Tab', 9);
  await sleep(300);
  const selected = await evaluate(client, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    return element ? {value: element.value || '', text: element.selectedOptions?.[0]?.textContent || ''} : null;
  })()`);
  const normalized = [selected?.value, selected?.text].map((item) => String(item || '').trim().toLowerCase());
  if (!acceptedValues.some((item) => normalized.includes(String(item).trim().toLowerCase()))) {
    throw new Error(`${label} 的键盘选择未被页面接受`);
  }
}

function readStripeCardFormExpression() {
  return `(() => {
    const visible = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && !node.disabled;
    };
    const number = document.querySelector('#payment-numberInput');
    const expiry = document.querySelector('#payment-expiryInput');
    const cvc = document.querySelector('#payment-cvcInput');
    const cardTab = [...document.querySelectorAll('button,[role="tab"]')]
      .find((node) => visible(node) && String(node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim() === 'Card');
    const cardRect = cardTab?.getBoundingClientRect();
    const numberRect = number?.getBoundingClientRect();
    return {
      numberReady: visible(number),
      expiryReady: visible(expiry),
      cvcReady: visible(cvc),
      cardTabVisible: Boolean(cardTab),
      cardSelected: Boolean(cardTab && (
        cardTab.getAttribute('aria-selected') === 'true'
        || cardTab.getAttribute('aria-checked') === 'true'
        || cardTab.getAttribute('data-state') === 'selected'
      )),
      cardPoint: cardRect ? {x: cardRect.left + cardRect.width / 2, y: cardRect.top + cardRect.height / 2} : null,
      signature: [
        visible(number),
        visible(expiry),
        visible(cvc),
        Math.round(numberRect?.left || 0),
        Math.round(numberRect?.top || 0),
        Math.round(numberRect?.width || 0),
        Math.round(numberRect?.height || 0),
      ].join(','),
    };
  })()`;
}

async function readStripeCardFormState(payment) {
  return evaluate(payment, readStripeCardFormExpression());
}

function isStripeCardFormReady(state) {
  return Boolean(state?.numberReady && state?.expiryReady && state?.cvcReady);
}

async function waitForStripeTarget(debugPort, targetPattern, readySelector, label) {
  return waitForValue(async () => {
    const targets = await getTargets(debugPort);
    const candidates = targets.filter((item) => item.type === 'iframe' && targetPattern.test(item.url || '') && item.webSocketDebuggerUrl);
    for (const target of candidates) {
      const frame = await connectCdp(target.webSocketDebuggerUrl, 5000);
      try {
        await frame.command('Runtime.enable');
        const waitForCardForm = readySelector === '#payment-numberInput';
        const state = waitForCardForm
          ? await readStripeCardFormState(frame)
          : await evaluate(frame, `(() => {
              const element = document.querySelector(${JSON.stringify(readySelector)});
              if (!element) return {ready:false};
              const rect = element.getBoundingClientRect();
              return {ready: rect.width > 0 && rect.height > 0 && !element.disabled};
            })()`);
        const ready = waitForCardForm ? isStripeCardFormReady(state) : Boolean(state?.ready);
        if (ready) return { frame, targetUrl: target.url };
        // Stripe 偶尔保留 PayPal 等其它方式；必须先点 Card，并等到卡号/有效期/CVV 都刷新出来，才能开始打字。
        if (waitForCardForm && state?.cardPoint && !state.cardSelected) await mouseClick(frame, state.cardPoint);
      } catch {
        frame.close();
      }
      frame.close();
    }
    return null;
  }, Boolean, STRIPE_WAIT_MILLISECONDS, `等待 ${label} 超时`);
}

async function waitForStripeCardPaymentReady(payment, onStep = () => {}) {
  onStep('等待 Card 支付表单刷新完成');
  await waitForValue(
    () => readStripeCardFormState(payment),
    isStripeCardFormReady,
    STRIPE_WAIT_MILLISECONDS,
    // 等待卡号、有效期、CVV 都出现；超时说明 Card 区块还在重绘，这时打字会被打断并关闭当前 Profile。
    '已进入支付页，但 Card 卡号/有效期/CVV 输入框仍未刷新完成',
  );
  // 套餐切换或点 Card 后 Stripe 会重建输入框；签名连续稳定后才允许输入卡号。
  const stable = await waitForValue(
    async () => {
      const before = await readStripeCardFormState(payment);
      await sleep(800);
      const after = await readStripeCardFormState(payment);
      return { before, after };
    },
    (state) => isStripeCardFormReady(state?.before)
      && isStripeCardFormReady(state?.after)
      && state.before.signature === state.after.signature,
    12000,
    'Card 支付表单仍在刷新，输入框位置尚未稳定',
  );
  return stable.after;
}

function normalizeDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function stripeExpiryKeyboardValue(value) {
  const expiresAt = normalizeDigits(value);
  // CSV 使用 MMYY（如 0931）；Stripe 的当前输入框会自行补齐单数月份前面的 0，因此键盘只输入 931。
  return expiresAt.length === 4 && expiresAt.startsWith('0') ? expiresAt.slice(1) : expiresAt;
}

async function waitForCompletedStripeCard(payment, row) {
  const expectedLengths = {
    cardNumber: normalizeDigits(row.cardNumber).length,
    // 键盘输入 931 后 Stripe 会显示为 09/31，因此最终读取值仍应按 CSV 的 4 位 MMYY 校验。
    expiresAt: normalizeDigits(row.expires_at).length,
    cvv: normalizeDigits(row.cvv).length,
  };
  const readState = () => evaluate(payment, `(() => {
    const digitsLength = (selector) => String(document.querySelector(selector)?.value || '').replace(/\\D/g, '').length;
    const invalid = (selector) => document.querySelector(selector)?.getAttribute('aria-invalid') === 'true';
    const visibleText = (node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 ? String(node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim() : '';
    };
    const errors = [...document.querySelectorAll('[role="alert"], .p-FieldError, [id$="-error"]')]
      .map(visibleText)
      .filter(Boolean)
      .filter((value, index, values) => values.indexOf(value) === index);
    return {
      cardNumberLength: digitsLength('#payment-numberInput'),
      expiresAtLength: digitsLength('#payment-expiryInput'),
      cvvLength: digitsLength('#payment-cvcInput'),
      cardNumberInvalid: invalid('#payment-numberInput'),
      expiresAtInvalid: invalid('#payment-expiryInput'),
      cvvInvalid: invalid('#payment-cvcInput'),
      errors,
    };
  })()`);

  const isComplete = (state) => state
      && state.cardNumberLength === expectedLengths.cardNumber
      && state.expiresAtLength === expectedLengths.expiresAt
      && state.cvvLength === expectedLengths.cvv
      && !state.cardNumberInvalid
      && !state.expiresAtInvalid
      && !state.cvvInvalid
      && state.errors.length === 0;
  const waitForFinalState = async (timeoutMilliseconds) => {
    const deadline = Date.now() + timeoutMilliseconds;
    let state;
    while (Date.now() <= deadline) {
      state = await readState();
      if (isComplete(state)) return state;
      await sleep(DOM_POLL_MILLISECONDS);
    }
    return state;
  };

  // 三项全部输入并失焦后，再给 Stripe 最多 3 秒完成格式化与最终校验。
  const state = await waitForFinalState(3000);
  if (!isComplete(state)) {
    // 状态只保留位数和 Stripe 错误文本，禁止把完整卡资料写入任务日志。
    throw new Error(`银行卡三项已完成键盘输入，但 Stripe 最终校验未通过；页面状态：${JSON.stringify(state || {})}`);
  }
  return state;
}

async function readStripeFieldDigits(payment, selector) {
  return evaluate(payment, `String(document.querySelector(${JSON.stringify(selector)})?.value || '').replace(/\\D/g, '')`);
}

async function focusStripeField(payment, selector, label) {
  const initial = await evaluate(payment, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    element.scrollIntoView?.({block:'center', inline:'center'});
    element.focus();
    return {active: document.activeElement === element, length: String(element.value || '').replace(/\\D/g, '').length};
  })()`);
  if (!initial?.active) throw new Error(`输入框不存在或不能聚焦：${label}`);
  return initial;
}

async function fillStripeCardFieldStep(payment, { selector, value, expectedDigitsLength, label }) {
  const typeField = async (intervalMilliseconds) => {
    await focusAndType(payment, selector, value, { validateAfterInput: false, intervalMilliseconds, label });
    // 每个字段完整输入并失焦后停顿，等待 Stripe 格式化完成，再处理下一个输入框。
    await sleep(800);
    return (await readStripeFieldDigits(payment, selector)).length;
  };

  let receivedDigitsLength = await typeField(140);
  if (receivedDigitsLength !== expectedDigitsLength) {
    // 只重输当前发生吞键的字段一次；其他已完成字段不动，也不重跑整条任务。
    receivedDigitsLength = await typeField(180);
  }
  if (receivedDigitsLength !== expectedDigitsLength) {
    throw new Error(`${label} 未完整输入：页面只接收到 ${receivedDigitsLength} 位，预期 ${expectedDigitsLength} 位`);
  }
}

async function fillStripeCardNumberStep(payment, cardNumber, onStep = () => {}) {
  const selector = '#payment-numberInput';
  const expectedDigits = normalizeDigits(cardNumber);
  const expectedDigitsLength = expectedDigits.length;
  // 卡号输入可能被 Stripe 刷新打断；在当前字段内继续补齐剩余位数，超时后才失败并关闭当前 Profile。
  const deadline = Date.now() + STRIPE_WAIT_MILLISECONDS;
  let intervalMilliseconds = 140;
  let waitForRefresh = false;

  const currentDigits = async () => normalizeDigits(await readStripeFieldDigits(payment, selector));

  while (Date.now() <= deadline) {
    if (waitForRefresh) await waitForStripeCardPaymentReady(payment, onStep);
    waitForRefresh = false;
    let typed = '';
    try {
      typed = await currentDigits();
    } catch {
      onStep('卡号输入被页面刷新打断，等待 Card 支付表单出现后继续输入');
      intervalMilliseconds = 180;
      waitForRefresh = true;
      continue;
    }
    if (typed === expectedDigits) break;
    await focusStripeField(payment, selector, '银行卡号');
    typed = await currentDigits();
    if (typed && !expectedDigits.startsWith(typed)) {
      await clearFocusedField(payment, typed.length);
      typed = '';
    }
    const remaining = expectedDigits.slice(typed.length);
    for (const character of remaining) {
      if (Date.now() > deadline) break;
      try {
        await typeWithKeyboard(payment, character, { intervalMilliseconds });
        let after = await currentDigits();
        if (after.length === typed.length) {
          await sleep(120);
          after = await currentDigits();
        }
        if (!after || !expectedDigits.startsWith(after) || after.length <= typed.length) {
          // 页面刷新会丢掉后续按键；等 Card 表单重新出现后从已接收前缀继续输入，不重跑整条任务。
          onStep('卡号输入被页面刷新打断，等待 Card 支付表单出现后继续输入');
          intervalMilliseconds = 180;
          waitForRefresh = true;
          break;
        }
        typed = after;
      } catch {
        onStep('卡号输入被页面刷新打断，等待 Card 支付表单出现后继续输入');
        intervalMilliseconds = 180;
        waitForRefresh = true;
        break;
      }
    }
    if (!waitForRefresh && typed === expectedDigits) break;
    if (!waitForRefresh && typed !== expectedDigits) waitForRefresh = true;
  }

  const receivedDigitsLength = (await currentDigits()).length;
  if (receivedDigitsLength !== expectedDigitsLength) {
    throw new Error(`银行卡号 未完整输入：页面只接收到 ${receivedDigitsLength} 位，预期 ${expectedDigitsLength} 位`);
  }
  await dispatchKey(payment, 'Tab', 'Tab', 9);
  await sleep(800);
}

function stateName(state) {
  const names = {
    AL:'Alabama', AK:'Alaska', AZ:'Arizona', AR:'Arkansas', CA:'California', CO:'Colorado', CT:'Connecticut', DE:'Delaware', FL:'Florida', GA:'Georgia', HI:'Hawaii', ID:'Idaho', IL:'Illinois', IN:'Indiana', IA:'Iowa', KS:'Kansas', KY:'Kentucky', LA:'Louisiana', ME:'Maine', MD:'Maryland', MA:'Massachusetts', MI:'Michigan', MN:'Minnesota', MS:'Mississippi', MO:'Missouri', MT:'Montana', NE:'Nebraska', NV:'Nevada', NH:'New Hampshire', NJ:'New Jersey', NM:'New Mexico', NY:'New York', NC:'North Carolina', ND:'North Dakota', OH:'Ohio', OK:'Oklahoma', OR:'Oregon', PA:'Pennsylvania', RI:'Rhode Island', SC:'South Carolina', SD:'South Dakota', TN:'Tennessee', TX:'Texas', UT:'Utah', VT:'Vermont', VA:'Virginia', WA:'Washington', WV:'West Virginia', WI:'Wisconsin', WY:'Wyoming', DC:'District of Columbia',
  };
  const value = String(state || '').trim();
  return names[value.toUpperCase()] || value;
}

async function fillStripeCard(debugPort, row, onStep = () => {}) {
  const target = await waitForStripeTarget(
    debugPort,
    /elements-inner-payment.*componentName=payment/i,
    '#payment-numberInput',
    'Stripe Card 输入框',
  );
  const payment = target.frame;
  try {
    const expiryKeyboardValue = stripeExpiryKeyboardValue(row.expires_at);
    await waitForStripeCardPaymentReady(payment, onStep);
    onStep('Card 支付表单已稳定，逐字符输入银行卡号');
    await fillStripeCardNumberStep(payment, row.cardNumber, onStep);
    onStep('银行卡号已完整输入，逐字符输入有效期');
    await fillStripeCardFieldStep(payment, {
      selector: '#payment-expiryInput',
      value: expiryKeyboardValue,
      expectedDigitsLength: normalizeDigits(row.expires_at).length,
      label: '银行卡有效期',
    });
    onStep('有效期已完整输入，逐字符输入 CVV');
    await fillStripeCardFieldStep(payment, {
      selector: '#payment-cvcInput',
      value: row.cvv,
      expectedDigitsLength: normalizeDigits(row.cvv).length,
      label: 'CVV',
    });
    onStep('CVV 已完整输入，统一执行 Stripe 最终校验');
    await waitForCompletedStripeCard(payment, row);
  } finally {
    payment.close();
  }
}

async function ensureStripeCountryUnitedStates(address) {
  const countrySelector = '#billingAddress-countryInput, select[name="country"]';
  const country = await evaluate(address, `(() => {
    const element = document.querySelector(${JSON.stringify(countrySelector)});
    return element ? {
      value: String(element.value || '').trim(),
      text: String(element.selectedOptions?.[0]?.textContent || '').trim(),
    } : null;
  })()`);
  const currentValues = [country?.value, country?.text].map((value) => String(value || '').toLowerCase());
  if (currentValues.includes('us') || currentValues.includes('united states')) return;

  // 只有页面当前不是美国时才操作国家下拉框，避免重复选择导致地址字段被清空或重绘。
  await chooseSelectWithKeyboard(
    address,
    countrySelector,
    'United States',
    ['US', 'United States'],
    'Country or region',
  );
}

async function waitForStripeAddressDetailFields(address) {
  return waitForValue(
    () => evaluate(address, `(() => {
      const visible = (selector) => {
        const element = document.querySelector(selector);
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && !element.disabled;
      };
      return {
        city: visible('#billingAddress-localityInput, input[name="locality"]'),
        state: visible('#billingAddress-administrativeAreaInput, select[name="administrativeArea"]'),
        postalCode: visible('#billingAddress-postalCodeInput, input[name="postalCode"]'),
      };
    })()`),
    (state) => state?.city && state?.state && state?.postalCode,
    5000,
    'Address line 1 已输入，但等待 5 秒仍未显示 City、State、ZIP code',
  );
}

async function fillStripeBillingAddress(debugPort, row, onStep = () => {}) {
  const target = await waitForStripeTarget(
    debugPort,
    /elements-inner-address.*componentName=address/i,
    '#billingAddress-nameInput, input[name="name"]',
    'Stripe Billing address 输入框',
  );
  const address = target.frame;
  try {
    const keyboardOptions = { intervalMilliseconds: 100 };
    onStep('检查账单国家；不是 United States 时切换为 United States');
    await ensureStripeCountryUnitedStates(address);

    onStep('逐字符输入账单姓名和 Address line 1');
    await focusAndType(address, '#billingAddress-nameInput, input[name="name"]', row.billingName, { ...keyboardOptions, label: 'Full name' });
    await focusAndType(address, '#billingAddress-addressLine1Input, input[name="addressLine1"]', row.billingAddressLine1, { ...keyboardOptions, label: 'Address line 1' });

    onStep('Address line 1 已输入，等待 City、State、ZIP code 动态出现');
    await waitForStripeAddressDetailFields(address);
    if (String(row.billingAddressLine2 || '').trim()) {
      await focusAndType(address, '#billingAddress-addressLine2Input, input[name="addressLine2"]', row.billingAddressLine2, { ...keyboardOptions, label: 'Address line 2' });
    }

    onStep('逐字符输入 City');
    await focusAndType(address, '#billingAddress-localityInput, input[name="locality"]', row.billingCity, { ...keyboardOptions, label: 'City' });
    const fullStateName = stateName(row.billingState);
    onStep('用键盘选择 State');
    await chooseSelectWithKeyboard(
      address,
      '#billingAddress-administrativeAreaInput, select[name="administrativeArea"]',
      fullStateName,
      [row.billingState, fullStateName],
      'State',
    );
    onStep('逐字符输入 ZIP code');
    await focusAndType(address, '#billingAddress-postalCodeInput, input[name="postalCode"]', row.billingPostalCode, { ...keyboardOptions, label: 'ZIP code' });
    onStep('ZIP code 已输入，账单地址填写完成');
  } finally {
    address.close();
  }
}

async function readSubscribeButtonState(page) {
  return evaluate(page, `(() => {
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== 'hidden';
    };
    const button = [...document.querySelectorAll('button,a,[role="button"]')]
      .find((node) => visible(node) && normalize(node.innerText || node.textContent || node.getAttribute('aria-label')) === 'Subscribe');
    if (!button) return {found:false, enabled:false};
    return {
      found: true,
      enabled: !button.disabled && button.getAttribute('aria-disabled') !== 'true',
    };
  })()`);
}

async function readSubscribeOutcome(page) {
  return evaluate(page, `(() => {
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const visible = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const body = normalize(document.body?.innerText || '');
    const alertTexts = [...document.querySelectorAll('[role="alert"], [aria-live="assertive"], [aria-live="polite"]')]
      .filter(visible)
      .map((node) => normalize(node.innerText || node.textContent))
      .filter(Boolean);
    const declinedFromBody = (body.match(/Your payment was declined\\.[^.]{0,80}\\./i) || body.match(/Your payment was declined\\. Try a different card\\./i) || [])[0] || '';
    const error = alertTexts.find((text) => /declined|try a different card|payment failed|couldn['’]t (be )?process|card was declined/i.test(text))
      || (body.includes('Your payment was declined') ? (declinedFromBody || 'Your payment was declined. Try a different card.') : '');
    const leftCheckout = !/\\/checkout\\//i.test(location.href);
    const successText = /you('re| are) all set|welcome to chatgpt pro|subscription (is )?now active|thanks for subscribing/i.test(body);
    return {
      href: location.href,
      error,
      success: !error && (leftCheckout || successText),
    };
  })()`);
}

async function clickSubscribeAndAwaitResult(page, onStep = () => {}) {
  onStep('账单地址已填写，等待 Subscribe 可点击');
  await waitForValue(
    () => readSubscribeButtonState(page),
    (state) => state?.found && state?.enabled,
    15000,
    // 等待 Stripe 完成地址校验并点亮 Subscribe；超时后点击会无效，当前任务失败，其他并发任务继续。
    'ZIP 已输入，但 Subscribe 仍不可点击',
  );
  onStep('点击 Subscribe');
  // Subscribe 会产生真实扣款，只点一次，不能因为结果还没返回就补点第二次。
  await clickExactText(page, 'Subscribe', {
    timeoutMilliseconds: 10000,
    timeoutMessage: '没有找到可点击的 Subscribe',
    stabilityMilliseconds: 600,
  });
  onStep('已点击 Subscribe，等待支付成功或拒付结果');
  const outcome = await waitForValue(
    () => readSubscribeOutcome(page),
    (state) => Boolean(state?.error || state?.success),
    45000,
    // 等待拒付横幅或离开 checkout；超时后当前任务失败并关闭该 Profile，不影响其他并发任务。
    '已点击 Subscribe，但 45 秒内没有出现支付成功或拒付提示',
  );
  if (outcome.error) throw new Error(outcome.error);
  return outcome;
}

function hasBillingAddressInRow(row) {
  return ['billingName', 'billingAddressLine1', 'billingCity', 'billingState', 'billingPostalCode']
    .every((field) => String(row[field] || '').trim());
}

async function verifyExistingStripeBillingAddress(debugPort) {
  const target = await waitForStripeTarget(
    debugPort,
    /elements-inner-address.*componentName=address/i,
    '#billingAddress-nameInput, input[name="name"]',
    'Stripe Billing address 输入框',
  );
  const address = target.frame;
  try {
    await ensureStripeCountryUnitedStates(address);
    const state = await evaluate(address, `(() => {
      const fieldState = (selector) => {
        const element = document.querySelector(selector);
        if (!element) return {visible:false, filled:false};
        const rect = element.getBoundingClientRect();
        return {
          visible: rect.width > 0 && rect.height > 0,
          filled: Boolean(String(element.value || '').trim()),
        };
      };
      const fields = {
        name: fieldState('#billingAddress-nameInput, input[name="name"]'),
        addressLine1: fieldState('#billingAddress-addressLine1Input, input[name="addressLine1"]'),
        city: fieldState('#billingAddress-localityInput, input[name="locality"]'),
        state: fieldState('#billingAddress-administrativeAreaInput, select[name="administrativeArea"]'),
        postalCode: fieldState('#billingAddress-postalCodeInput, input[name="postalCode"]'),
        country: fieldState('#billingAddress-countryInput, select[name="country"]'),
      };
      return {
        complete: Object.values(fields).every((field) => field.visible && field.filled),
        // 只返回字段是否可见、是否填写，禁止把真实地址内容写入任务日志。
        visible: Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.visible])),
        filled: Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.filled])),
      };
    })()`);
    if (!state?.complete) {
      const fieldLabels = {
        name: 'Full name',
        addressLine1: 'Address line 1',
        city: 'City',
        state: 'State',
        postalCode: 'ZIP code',
        country: 'Country or region',
      };
      const unavailableFields = Object.entries(state?.visible || {})
        .filter(([, visible]) => !visible)
        .map(([field]) => fieldLabels[field] || field);
      const emptyFields = Object.entries(state?.filled || {})
        .filter(([field, filled]) => state?.visible?.[field] && !filled)
        .map(([field]) => fieldLabels[field] || field);
      if (unavailableFields.length) {
        throw new Error(`账单地址区域已加载，但没有找到这些输入框：${unavailableFields.join('、')}`);
      }
      throw new Error(`账单地址输入框均已找到，但任务没有可填写的账单地址数据；当前为空：${emptyFields.join('、')}`);
    }
  } finally {
    address.close();
  }
}

async function fillLoginIfNeeded(page, row, onStatus) {
  const entryState = await waitForValue(
    () => evaluate(page, `(() => {
      const visible = (node) => { if (!node) return false; const rect = node.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; };
      const emailInput = document.querySelector('input[type="email"], input[name="email"]');
      const topRightUpgrade = [...document.querySelectorAll('button,a,[role="button"]')].some((node) => {
        const rect = node.getBoundingClientRect();
        const text = (node.innerText || node.textContent || node.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
        return visible(node) && text === 'Upgrade' && rect.left > innerWidth * 0.55 && rect.top < Math.min(220, innerHeight * 0.35);
      });
      return {hasEmailInput: visible(emailInput), topRightUpgrade};
    })()`),
    (state) => state?.hasEmailInput || state?.topRightUpgrade,
    45000,
    'ChatGPT 首页已打开，但既没有出现登录框，也没有出现右上角 Upgrade',
  );
  if (!entryState.hasEmailInput) return;

  await focusAndType(page, 'input[type="email"], input[name="email"]', row.email, { label: 'ChatGPT 登录邮箱' });
  await clickExactText(page, 'Continue', { timeoutMilliseconds: 20000, timeoutMessage: '没有找到登录邮箱后的 Continue' });
  await waitForValue(
    () => evaluate(page, `Boolean(document.querySelector('input[type="password"], input[name="password"]'))`),
    Boolean,
    20000,
    '等待 ChatGPT 密码输入框超时',
  );
  await focusAndType(page, 'input[type="password"], input[name="password"]', row.password, { label: 'ChatGPT 登录密码' });
  await clickExactText(page, 'Continue', { timeoutMilliseconds: 20000, timeoutMessage: '没有找到登录密码后的 Continue' });
  onStatus('已用键盘输入账号密码；若出现邮箱验证码或 MFA，请在 AdsPower 中人工完成');
}

async function openChatGptAndPreparePayment(profile, row, product, multiplier, onStatus, onPlans, onStep) {
  const page = await connectChatGptPage(profile.debugPort);
  try {
    await page.command('Page.enable');
    await page.command('Runtime.enable');

    const initialPageState = await evaluate(page, `(() => ({
      origin: location.origin,
      pathname: location.pathname,
      hash: location.hash,
    }))()`);
    const isChatGptHome = initialPageState?.origin === 'https://chatgpt.com'
      && initialPageState?.pathname === '/'
      && !initialPageState?.hash;

    if (!isChatGptHome) {
      // AdsPower 会恢复上次关闭时的 checkout/#pricing 页面；每条任务必须从首页重新开始状态机。
      onStep('检测到上次残留页面，先返回 chatgpt.com 首页');
      const navigation = await page.command('Page.navigate', { url: 'https://chatgpt.com/' });
      if (navigation?.errorText) throw new Error(`返回 ChatGPT 首页失败：${navigation.errorText}`);
    } else {
      onStep('AdsPower 当前已在 chatgpt.com 首页');
    }

    onStep('等待 chatgpt.com 首页或登录入口加载完成');
    await waitForValue(
      () => evaluate(page, `(() => {
        const emailInput = document.querySelector('input[type="email"], input[name="email"]');
        return {
          ready: document.readyState !== 'loading',
          origin: location.origin,
          pathname: location.pathname,
          hash: location.hash,
          hasEmailInput: Boolean(emailInput),
        };
      })()`),
      (state) => state?.ready
        && state?.origin === 'https://chatgpt.com'
        && ((state.pathname === '/' && !state.hash) || state.hasEmailInput),
      30000,
      '已请求返回 chatgpt.com，但 30 秒内没有进入首页或登录入口',
    );

    onStep('处理 ChatGPT 登录');
    await fillLoginIfNeeded(page, row, onStatus);

    onStep('等待 ChatGPT 首页完全加载并稳定');
    await sleep(1200);

    onStep('点击右上角 Upgrade');
    await clickAndConfirm(
      page,
      'Upgrade',
      { region: 'top-right', timeoutMilliseconds: 45000, timeoutMessage: '没有找到右上角 Upgrade', stabilityMilliseconds: 1000 },
      () => readPricingModalState(page),
      10000,
      '右上角 Upgrade 已点击，但 URL 和套餐弹窗都没有变化',
    );
    onStep('右上角 Upgrade 已点击，套餐弹窗已加载');

    onStep('向下滚动到套餐页面底部，寻找 See all plans');
    onStep('点击 See all plans');
    await clickAndConfirm(
      page,
      'See all plans',
      {
        timeoutMilliseconds: 20000,
        timeoutMessage: '滚动套餐页面后仍没有找到可见的 See all plans',
        stabilityMilliseconds: 800,
        scrollIntoView: true,
      },
      () => readAllPlansState(page),
      5000,
      'See all plans 已点击，但等待 5 秒仍未显示 Maximum power',
    );
    onStep('See all plans 已点击，完整套餐列表已加载');

    onStep('等待并识别 Maximum power（最多 5 秒）');
    if (product !== 'Maximum power') throw new Error(`当前流程不支持产品：${product}`);
    onStep('Maximum power 已识别，点击 Upgrade to Pro');
    await clickMaximumPowerCard(page, onPlans);
    onStep('Upgrade to Pro 已点击，正在进入购买页面');

    onStep('等待 ChatGPT Pro 支付页');
    await waitForCheckout(page);

    onStep(`选择 ${multiplier} 套餐并等待价格更新`);
    await selectMultiplier(page, multiplier);

    onStep('确认 Card 并用键盘输入当前行银行卡');
    await fillStripeCard(profile.debugPort, row, onStep);
    onStep('银行卡号、有效期和 CVV 已全部输入，Stripe 最终校验通过');

    if (hasBillingAddressInRow(row)) {
      onStep('选择美国并用键盘输入当前行账单地址');
      await fillStripeBillingAddress(profile.debugPort, row, onStep);
    } else {
      onStep('检查付款页已有账单地址');
      await verifyExistingStripeBillingAddress(profile.debugPort);
    }

    onStep('账单地址已填写，点击 Subscribe');
    await clickSubscribeAndAwaitResult(page, onStep);
    onStep('Subscribe 已提交，未出现拒付');
  } finally {
    page.close();
  }
}

async function runWithConcurrency(rows, concurrency, worker) {
  const results = new Array(rows.length);
  let cursor = 0;
  const poolSize = Math.min(rows.length, concurrency);
  const takeNextIndex = () => {
    // 领取下标必须同步完成，不能在 await 之后再加游标，否则会超过设定并发。
    if (cursor >= rows.length) return -1;
    const index = cursor;
    cursor += 1;
    return index;
  };
  const workers = Array.from({ length: poolSize }, async () => {
    // 启动时一次占满并发空位；任意一条结束就按列表顺序领取下一条，保持同时运行数等于 concurrency，剩余不足时自然减少。
    for (;;) {
      const index = takeNextIndex();
      if (index < 0) return;
      try {
        results[index] = await worker(rows[index], index);
      } catch (error) {
        // 单条任务异常不能让这个空位退出，否则实际并发会低于设定值；其他空位继续跑。
        results[index] = { index, status: 'failed', error: error.message };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function validatePaymentRow(row) {
  const requiredFields = ['adsPowerSerialNumber', 'email', 'password', 'cardNumber', 'expires_at', 'cvv'];
  const missingFields = requiredFields.filter((field) => !String(row[field] || '').trim());
  if (missingFields.length) throw new Error(`当前任务缺少字段：${missingFields.join('、')}`);
  if (!/^(US|USA|United States)?$/i.test(String(row.billingCountry || 'US').trim())) {
    throw new Error('当前流程的 billingCountry 只允许 US / United States');
  }
}

export async function runUpgradeJob({
  rows,
  concurrency = 1,
  product = 'Maximum power',
  multiplier = '20x',
  apiBase,
  apiKey,
  onEvent = () => {},
}) {
  if (!PRODUCTS.includes(product)) throw new Error(`不支持的 GPT 产品：${product}`);
  if (!MULTIPLIERS.includes(multiplier)) throw new Error(`不支持的倍率：${multiplier}`);

  const boundedConcurrency = Math.max(1, Math.min(10, Number(concurrency) || 1));
  return runWithConcurrency(rows, boundedConcurrency, async (row, index) => {
    const serialNumber = String(row.adsPowerSerialNumber || '').trim();
    const uiIndex = Number.isInteger(row.__uiIndex) ? row.__uiIndex : index;
    const prefix = `第 ${uiIndex + 1} 条 / AdsPower ${serialNumber}`;
    let profile;
    let currentStep = '任务校验';
    try {
      // 卡、账号和账单地址始终来自同一任务行，禁止跨行借用。
      validatePaymentRow(row);
      currentStep = '启动 AdsPower';
      onEvent({ type: 'row_started', index: uiIndex, message: `${prefix}：启动 AdsPower` });
      profile = await startAdsPowerProfile({ serialNumber, apiBase, apiKey });
      onEvent({ type: 'browser_started', index: uiIndex, message: `${prefix}：已打开 AdsPower，进入 chatgpt.com` });

      await openChatGptAndPreparePayment(profile, row, product, multiplier, (message) => {
        onEvent({ type: 'login_verification_required', index: uiIndex, message: `${prefix}：${message}` });
      }, (plans) => onEvent({ type: 'plans_discovered', index: uiIndex, plans }), (step) => {
        currentStep = step;
        onEvent({ type: 'step_started', index: uiIndex, message: `${prefix}：${step}` });
      });

      // 支付结果已确定后关闭当前 Profile；拒付或成功都只影响这一条，不关闭其他并发任务。
      if (profile) await stopAdsPowerProfile({ serialNumber, apiBase, apiKey }).catch(() => {});
      onEvent({ type: 'row_succeeded', index: uiIndex, message: `${prefix}：${product} / ${multiplier} 已点击 Subscribe，未出现拒付` });
      return { index: uiIndex, serialNumber, status: 'succeeded' };
    } catch (error) {
      const reason = `${currentStep}失败：${error.message}`;
      if (profile) await stopAdsPowerProfile({ serialNumber, apiBase, apiKey }).catch(() => {});
      onEvent({ type: 'row_failed', index: uiIndex, message: `${prefix}：${reason}；已终止该条任务并关闭浏览器` });
      return { index: uiIndex, serialNumber, status: 'failed', error: reason };
    } finally {
      if (row.stopProfile && profile) await stopAdsPowerProfile({ serialNumber, apiBase, apiKey }).catch(() => {});
    }
  });
}
