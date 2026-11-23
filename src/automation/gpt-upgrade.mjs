import { mkdir, writeFile } from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { join } from 'node:path';
import { startAdsPowerProfile, stopAdsPowerProfile } from './adspower.mjs';
import { startGoogleIncognitoBrowser, stopGoogleIncognitoBrowser } from './google-incognito.mjs';
import { inspectLatestInvoice, inspectInvoiceDownload, downloadInvoicePdf } from './invoice.mjs';
import { inspectBillingProof, setBillingBrowserZoom, readBillingBrowserZoom } from './billing-proof.mjs';
import { screenshotDirectory } from '../temp-screenshots.mjs';
import { resolveProSelection, inspectPricingPage, inspectProPricingCard, inspectProCheckoutOptions, inspectProCheckout, inspectCheckoutSubmitButton } from './pro-plans.mjs';
import { resolveAdditionalOptions, completePostPurchase, initialPostPurchaseResult, interruptedPostPurchaseResult } from './post-purchase.mjs';
import { inspectAuthenticator, configureAuthenticator } from './two-factor.mjs';
import { exportCodexCredential } from './codex-oauth.mjs';
import { createCodexDriver, inspectLoginInput } from './codex-driver.mjs';
import { waitForSubscriptionPayment } from './payment-wait.mjs';
import { LOGIN_SELECTORS, inspectLoginPage, loginStateKind, assertLoginState } from './login-state.mjs';

export const PRODUCTS = ['Pro'];

const DOM_POLL_MILLISECONDS = 250;
const CHECKOUT_WAIT_MILLISECONDS = 45000;
// 以下等待参数只供未进入任务上下文的旧调用兼容；正式任务中的所有等待均使用同一个整行截止时间。
const PRO_CARD_WAIT_MILLISECONDS = 60000;
const PROFILE_AVATAR_WAIT_MILLISECONDS = 60000;
const STRIPE_WAIT_MILLISECONDS = 30000;
// 旧单函数调用保留默认参数；通过任务入口运行时同样被整行剩余预算覆盖。
const SUBSCRIBE_BUTTON_WAIT_MILLISECONDS = 60000;
const SUBSCRIBE_RESULT_WAIT_MILLISECONDS = 90000;
// 单条任务从领取开始最多 10 分钟，包含按钮启用和支付结果等待；到期只结束当前行。
const ROW_TIMEOUT_MILLISECONDS = 600000;
const ROW_STOP_MESSAGE = '用户终止本行，已结束等待';
const ROW_TIMEOUT_MESSAGE = '超过 10 分钟最大处理时间，已终止当前任务';
// 每行只建立一次截止时间；所有页面等待、CDP 命令和附加动作共享它，进入新阶段不得重新计时。
const taskWaitScope = new AsyncLocalStorage();
function runWithTaskBudget(work, isActive, deadline = Date.now() + ROW_TIMEOUT_MILLISECONDS, signal) {
  return taskWaitScope.run({ deadline, isActive, signal }, work);
}
// 手动终止与 10 分钟上限共用同一中断通道；注册表只保存当前行的控制句柄，不保存账号或卡资料。
function createRowInterruption({index, deadline, controller, registerRowControl, onInterrupt}) {
  let finished = false;
  let rejectWait;
  const wait = new Promise((_, reject) => { rejectWait = reject; });
  const interrupt = (manual = false) => {
    if (finished) return false;
    finished = true;
    const error = new Error(manual ? ROW_STOP_MESSAGE : ROW_TIMEOUT_MESSAGE);
    error.code = manual ? 'ROW_STOPPED' : 'ROW_TIMEOUT';
    onInterrupt(error);
    // 先确定整行结束原因，再中断未返回的 CDP/启动请求，避免连接错误覆盖用户终止原因。
    rejectWait(error);
    controller.abort(error);
    return true;
  };
  const timer = setTimeout(() => interrupt(), Math.max(0, deadline - Date.now()));
  const unregister = registerRowControl(index, () => interrupt(true));
  return {wait, finish() { finished = true; clearTimeout(timer); unregister?.(); }};
}
function waitDeadline(legacyMilliseconds) {
  return taskWaitScope.getStore()?.deadline ?? Date.now() + legacyMilliseconds;
}
function assertTaskActive(task = taskWaitScope.getStore()) {
  if (task && (!task.isActive() || task.signal?.aborted || Date.now() >= task.deadline)) {
    throw task.signal?.reason?.code === 'ROW_STOPPED' ? task.signal.reason : new Error(ROW_TIMEOUT_MESSAGE);
  }
}
function commandTimeout(legacyMilliseconds, task = taskWaitScope.getStore()) {
  assertTaskActive(task);
  return task ? Math.max(1, task.deadline - Date.now()) : legacyMilliseconds;
}
// Stripe 2026-09 把 Payment/Address iframe 从 elements-inner-payment / elements-inner-address
// 改成了同一份 elements-inner-accessory-target，只靠 componentName 区分；旧文件名仍要兼容。
const STRIPE_PAYMENT_TARGET_PATTERN = /elements-inner-[\w.-]*.*componentName=payment(?:&|$)/i;
const STRIPE_ADDRESS_TARGET_PATTERN = /elements-inner-[\w.-]*.*componentName=address(?:&|$)/i;
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

let commandSequence = 0;

function connectCdp(webSocketUrl, timeoutMilliseconds = 30000) {
  const task = taskWaitScope.getStore();
  timeoutMilliseconds = commandTimeout(timeoutMilliseconds);
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const pending = new Map();
    const listeners = new Map();
    let connecting = true;
    const failConnection = message => {
      if (!connecting) return;
      connecting = false;
      clearTimeout(connectTimer);
      // 握手超时后必须关闭旧连接，避免局部重连遗留迟到的 WebSocket；错误不带调试地址。
      try { socket.close(); } catch {}
      reject(new Error(message));
    };
    const connectTimer = setTimeout(() => failConnection('连接 CDP 超时'), timeoutMilliseconds);
    const abortConnection = () => {
      failConnection(ROW_TIMEOUT_MESSAGE);
      try { socket.close(); } catch {}
    };
    // 整行结束时同时中断握手和未返回的页面命令，防止迟到的 CDP 工作继续输入或点击。
    task?.signal?.addEventListener('abort', abortConnection, {once:true});

    socket.addEventListener('open', () => {
      if (!connecting) { socket.close(); return; }
      connecting = false;
      clearTimeout(connectTimer);
      resolve({
        socket,
        on(method, listener) {
          if (!listeners.has(method)) listeners.set(method, new Set());
          listeners.get(method).add(listener);
          return () => listeners.get(method)?.delete(listener);
        },
        command(method, params = {}, commandTimeoutMilliseconds = timeoutMilliseconds) {
          commandTimeoutMilliseconds = commandTimeout(commandTimeoutMilliseconds, task);
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
    socket.addEventListener('error', () => failConnection('无法连接 AdsPower 的 CDP 页面'));
    socket.addEventListener('close', () => {
      task?.signal?.removeEventListener('abort', abortConnection);
      failConnection('CDP 连接在握手完成前关闭');
      for (const callback of pending.values()) callback.reject(new Error('CDP 连接已关闭'));
      pending.clear();
      listeners.clear();
    });
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.method) {
        for (const listener of listeners.get(message.method) || []) listener(message.params);
        return;
      }
      const callback = pending.get(message.id);
      if (!callback) return;
      pending.delete(message.id);
      message.error ? callback.reject(new Error(message.error.message)) : callback.resolve(message.result);
    });
  });
}

async function getTargets(debugPort) {
  assertTaskActive();
  const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, {signal:taskWaitScope.getStore()?.signal});
  if (!response.ok) throw new Error(`读取 AdsPower 页面失败：HTTP ${response.status}`);
  return response.json();
}

function isChatGptHomeUrl(url) {
  const href = String(url || '');
  return /chatgpt\.com/i.test(href) && !/\/checkout\//i.test(href) && !/#pricing/i.test(href);
}

function isChatGptHomeTarget(item) {
  return item?.type === 'page' && isChatGptHomeUrl(item.url) && item.webSocketDebuggerUrl;
}

async function connectChatGptPage(debugPort, options = {}) {
  const targets = await getTargets(debugPort);
  const chatPages = targets.filter((item) => item.type === 'page' && /chatgpt\.com/i.test(item.url || ''));
  const homePage = chatPages.find((item) => isChatGptHomeUrl(item.url));
  const target = (options.preferHome && homePage)
    || chatPages[0]
    || targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
  if (!target?.webSocketDebuggerUrl) throw new Error('AdsPower 没有可控制的页面');
  return connectCdp(target.webSocketDebuggerUrl);
}

async function evaluate(client, expression, awaitPromise = false, commandTimeoutMilliseconds) {
  const result = await client.command('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
  }, commandTimeoutMilliseconds);
  if (result.exceptionDetails) throw new Error('页面脚本执行失败');
  return result.result?.value;
}

async function waitForValue(readValue, acceptValue, timeoutMilliseconds, timeoutMessage) {
  const deadline = waitDeadline(timeoutMilliseconds);
  let lastValue;
  while (Date.now() <= deadline) {
    assertTaskActive();
    lastValue = await readValue();
    assertTaskActive();
    if (acceptValue(lastValue)) return lastValue;
    await sleep(DOM_POLL_MILLISECONDS);
  }
  if (taskWaitScope.getStore()) throw new Error(ROW_TIMEOUT_MESSAGE);
  throw new Error(`${timeoutMessage}${lastValue ? `；页面状态：${JSON.stringify(lastValue)}` : ''}`);
}

async function mouseClick(client, point) {
  await client.command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await client.command('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await client.command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
}

async function clickExactText(client, text, options = {}) {
  const labels = [text, ...(options.alternateTexts || [])].filter(Boolean);
  const expectedTexts = JSON.stringify(labels);
  const region = options.region || 'any';
  const readPoint = () => evaluate(client, `(() => {
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const labels = ${expectedTexts};
      const visible = (node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== 'hidden';
      };
      const candidates = [...document.querySelectorAll('button,a,[role="button"],[role="link"],[role="menuitem"],[role="radio"],[role="tab"],label')]
        .map((node) => {
          const label = normalize(node.innerText || node.textContent || node.getAttribute('aria-label'));
          if (node.disabled || !visible(node) || !labels.includes(label)) return null;
          const rect = node.getBoundingClientRect();
          if (${Boolean(options.retryNavigation)} && (rect.left + rect.width/2 < 0 || rect.left + rect.width/2 > innerWidth || rect.top + rect.height/2 < 0 || rect.top + rect.height/2 > innerHeight)) return null;
          if (${Boolean(options.retryNavigation)} && typeof document.elementFromPoint === 'function') {
            const hit = document.elementFromPoint(rect.left + rect.width/2, rect.top + rect.height/2);
            if (!hit || (hit !== node && !node.contains(hit))) return null;
          }
          return {
            label,
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
          };
        })
        .filter(Boolean);
      const filtered = ${JSON.stringify(region)} === 'top-right'
        ? candidates.filter((item) => item.left > innerWidth * 0.55 && item.top < Math.min(220, innerHeight * 0.35))
        : ${JSON.stringify(region)} === 'left'
        ? candidates.filter((item) => item.left < innerWidth * 0.45)
        : candidates;
      filtered.sort((left, right) => {
        if (${JSON.stringify(region)} === 'top-right') return right.left - left.left;
        if (right.label.length !== left.label.length) return right.label.length - left.label.length;
        return left.top - right.top;
      });
      return {
        readyState: document.readyState,
        point: filtered[0] || null,
        viewport: {width: innerWidth, height: innerHeight},
      };
    })()`);
  if (options.scrollIntoView) {
    const deadline = waitDeadline(options.timeoutMilliseconds || 15000);
    while (Date.now() <= deadline) {
      const state = await readPoint();
      const point = state?.point;
      const viewport = state?.viewport;
      const insideViewport = point && viewport
        && point.x >= 0 && point.x <= viewport.width
        && point.y >= 0 && point.y <= viewport.height;
      if (state?.readyState === 'complete' && insideViewport) break;
      if (viewport) {
        // 促销价页的 See all plans 可能还没进可视区；没找到目标时也要向下滚，不能停在当前两张卡片上。
        const deltaY = !point || point.y > (viewport.height || 0) ? 620 : -620;
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
  // 设置导航在水合时会插入菜单项；连续两次坐标稳定且仍在视口内才点击，不能复用移动前坐标。
  if (options.retryNavigation) {
    let previous = firstState.point;
    const point = await waitForValue(async () => {
      await sleep(options.stabilityMilliseconds || 600);
      const state = await readPoint(), current = state?.point;
      const inside = current && current.x >= 0 && current.x <= state.viewport.width
        && current.y >= 0 && current.y <= state.viewport.height;
      const stable = inside && previous && Math.abs(previous.x-current.x)<=2 && Math.abs(previous.y-current.y)<=2;
      previous = inside ? current : null;
      return stable ? current : null;
    }, Boolean, options.timeoutMilliseconds || 15000, `等待 ${text} 位置稳定`);
    await mouseClick(client, point);
    return;
  }
  // 其他购买控件保留原有行为，设置导航的补点不能扩大到付款提交。
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

async function waitForSettingsTransition(confirmState, retryClick, timeoutMilliseconds, message, onStep = () => {}) {
  const started = Date.now();
  let retried = false;
  // 8 秒只触发一次当前导航控件的补点，不是阶段超时；之后仍等待原整行截止时间。
  return waitForValue(async () => {
    if (await confirmState()) return true;
    if (!retried && Date.now() - started >= 8000) {
      assertTaskActive();
      // 重试函数必须重新读取当前坐标；目标暂时不存在时继续等，不能点击旧位置。
      if (await retryClick()) {
        retried = true;
        onStep('设置导航尚未跳转，已重新定位并补点一次，继续等待页面变化');
      }
    }
    return false;
  }, Boolean, timeoutMilliseconds, message);
}

async function clickAndConfirm(client, text, options, confirmState, confirmTimeoutMilliseconds, confirmMessage) {
  if (options.retryNavigation && await confirmState()) return true;
  await clickExactText(client, text, options);
  if (options.retryNavigation) return waitForSettingsTransition(confirmState, async () => {
    if (await confirmState()) return false;
    await clickExactText(client, text, options);
    return true;
  }, confirmTimeoutMilliseconds, confirmMessage, options.onStep);
  try {
    return await waitForValue(confirmState, Boolean, confirmTimeoutMilliseconds, confirmMessage);
  } catch (firstError) {
    // 整行预算用尽后不能补点控件；只有未使用任务预算的旧流程保留原局部超时恢复。
    if (taskWaitScope.getStore()) throw firstError;
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
  return evaluate(client, `(${inspectPricingPage.toString()})()`);
}

async function readHomeUpgradeEntry(client) {
  return evaluate(client, `(() => {
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== 'hidden';
    };
    const inTopRight = (rect) => rect.left > innerWidth * 0.55 && rect.top < Math.min(220, innerHeight * 0.35);
    const buttons = [...document.querySelectorAll('button,a,[role="button"]')]
      .filter((node) => !node.disabled && visible(node));
    const findText = (text, region) => buttons.find((node) => {
      const label = normalize(node.innerText || node.textContent || node.getAttribute('aria-label'));
      if (label !== text) return false;
      const rect = node.getBoundingClientRect();
      return region !== 'top-right' || inTopRight(rect);
    });
    if (findText('Upgrade', 'top-right')) return {text:'Upgrade', region:'top-right'};
    if (findText('Free offer', 'top-right')) return {text:'Free offer', region:'top-right'};
    if (findText('Claim offer')) return {text:'Claim offer', region:'any'};
    return null;
  })()`);
}

async function readAllPlansState(client, amount) {
  const card = await readProCard(client, amount);
  return card || false;
}

async function readProCard(client, amount) {
  if (amount) return evaluate(client, `(${inspectProPricingCard.toString()})(${JSON.stringify(amount)})`);
  return evaluate(client, `(() => {
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const marker = [...document.querySelectorAll('body *')]
      .find((node) => /^(ChatGPT Pro|Maximum power)$/i.test(normalize(node.innerText || node.textContent)));
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
        description: 'Pro',
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

async function clickProCard(client, onPlans, amount) {
  const expectedAction = amount ? 'Buy now / Upgrade to Pro / Get started / Start now' : 'Upgrade to Pro';
  const cardWaitMilliseconds = amount ? PRO_CARD_WAIT_MILLISECONDS : 5000;
  // AdsPower 继续按卡片实际加载状态轮询，出现即继续；暂停开发的无痕模式保留 5 秒等待。
  const card = await waitForValue(
    () => readProCard(client, amount),
    Boolean,
    cardWaitMilliseconds,
    `等待 ${cardWaitMilliseconds / 1000} 秒，仍未找到 ChatGPT Pro / ${expectedAction}`,
  );
  const action = card.button;
  onPlans([{ title: card.title, description: card.description, button: card.button }]);
  let visibleCard = card;
  const deadline = waitDeadline(10000);
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
    visibleCard = await readProCard(client, amount);
  }
  assertTaskActive();
  if (!visibleCard?.point || visibleCard.point.y < 0 || visibleCard.point.y > visibleCard.viewport.height) {
    throw new Error(`已识别 Pro，但 ${action} 未滚动到可视区域`);
  }
  // 套餐列表展开后仍会继续排版；按钮稳定一秒后重新读取坐标，避免点击落在旧位置。
  await sleep(1000);
  visibleCard = await readProCard(client, amount);
  if (!visibleCard?.point || visibleCard.point.y < 0 || visibleCard.point.y > visibleCard.viewport.height) {
    throw new Error(`Pro 已识别，但 ${action} 在点击前离开了可视区域`);
  }
  if (amount && visibleCard.selectionStage !== 'checkout' && !visibleCard.selected) throw new Error(`Pro 月费未保持在 $${amount}，停止进入结账`);
  await mouseClick(client, visibleCard.point);

  const readTransition = () => evaluate(client, `(() => {
    const text = document.body?.innerText || '';
    return /\\/checkout\\//.test(location.href) || text.includes('Getting your plan ready');
  })()`);
  try {
    await waitForValue(readTransition, Boolean, 12000, `${action} 已点击，但页面没有进入购买流程`);
  } catch (firstError) {
    if (taskWaitScope.getStore()) throw firstError;
    // React 水合阶段可能吞掉第一次鼠标事件；只重新定位并补点当前 Pro 卡片的购买按钮一次。
    const retryCard = await readProCard(client, amount);
    if (!retryCard?.point || retryCard.point.y < 0 || retryCard.point.y > retryCard.viewport.height) throw firstError;
    if (amount && retryCard.selectionStage !== 'checkout' && !retryCard.selected) throw firstError;
    await mouseClick(client, retryCard.point);
    try {
      await waitForValue(readTransition, Boolean, 12000, `补点 ${action} 后仍未进入购买流程`);
    } catch {
      throw firstError;
    }
  }
  return action;
}

async function selectProAmount(client, amount) {
  const readCard = () => readProCard(client, amount);
  // 等待 Pro 卡片和价格按钮进入视口，共用整行剩余时间；坐标不稳定时不点击，避免选到邻近套餐。
  const deadline = waitDeadline(15000);
  while (Date.now() < deadline) {
    const card = await readCard();
    if (card?.selectionStage === 'checkout') return 'checkout';
    const p = card?.optionPoint;
    if (p && p.x >= 0 && p.x <= card.viewport.width && p.y >= 0 && p.y <= card.viewport.height) {
      await sleep(400);
      const stable = await readCard();
      const next = stable?.optionPoint;
      if (next && Math.abs(next.x - p.x) < 2 && Math.abs(next.y - p.y) < 2
        && next.x >= 0 && next.x <= stable.viewport.width && next.y >= 0 && next.y <= stable.viewport.height) {
        if (!stable.selected) await mouseClick(client, next);
        // 卡片月费及选中态都更新才点购买；正式任务继续等整行剩余时间，不能默认选 $100。
        await waitForValue(readCard, (value) => value?.selected, 5000, `Pro $${amount} 已点击，但卡片月费或选中状态没有更新`);
        return 'pricing';
      }
    } else if (card) {
      await client.command('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: card.viewport.width / 2, y: card.viewport.height / 2,
        deltaX: 0, deltaY: p && p.y < 0 ? -400 : 400,
      });
    }
    await sleep(DOM_POLL_MILLISECONDS);
  }
  assertTaskActive();
  throw new Error(`没有找到稳定可点击的 Pro $${amount} 规格按钮`);
}

async function readProCheckoutOptions(client, amount) {
  return evaluate(client, `(${inspectProCheckoutOptions.toString()})(${JSON.stringify(amount)})`);
}

async function selectProCheckoutAmount(client, amount) {
  const readOptions = () => readProCheckoutOptions(client, amount);
  // 配置页加载、选中属性和布局均等待整行剩余时间；未找到对应金额时绝不沿用默认 $100 填卡。
  const deadline = waitDeadline(CHECKOUT_WAIT_MILLISECONDS);
  const inViewport = state => state?.optionPoint && state.optionPoint.x >= 0 && state.optionPoint.x <= state.viewport.width
    && state.optionPoint.y >= 0 && state.optionPoint.y <= state.viewport.height;
  while (Date.now() < deadline) {
    assertTaskActive();
    const state = await readOptions();
    if (state?.selected) return;
    if (state?.enabled && inViewport(state)) {
      await sleep(400);
      const stable = await readOptions();
      if (stable?.selected) return;
      if (stable?.enabled && inViewport(stable)
        && Math.abs(state.optionPoint.x - stable.optionPoint.x) < 2
        && Math.abs(state.optionPoint.y - stable.optionPoint.y) < 2) {
        await mouseClick(client, stable.optionPoint);
        await waitForValue(readOptions, next => next?.selected, CHECKOUT_WAIT_MILLISECONDS,
          `Pro 配置页 $${amount} 已点击，但单选状态尚未更新`);
        return;
      }
    } else if (state && !inViewport(state)) {
      await client.command('Input.dispatchMouseEvent', {type:'mouseWheel', x:state.viewport.width / 2,
        y:state.viewport.height / 2, deltaX:0, deltaY:state.optionPoint.y < 0 ? -400 : 400});
    }
    await sleep(DOM_POLL_MILLISECONDS);
  }
  assertTaskActive();
  throw new Error(`Pro 配置页尚未出现稳定可点击的 $${amount} 规格`);
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

function summarizeStripeIframeTargets(targets) {
  const seen = [];
  for (const item of targets) {
    if (item.type !== 'iframe' || !/stripe/i.test(item.url || '')) continue;
    const url = String(item.url || '');
    const file = (url.split('#')[0].split('?')[0].split('/').pop() || '')
      .replace(/-[a-f0-9]{8,}.*$/i, '');
    const component = decodeURIComponent(url.match(/componentName=([^&]+)/i)?.[1] || '');
    const elementKind = decodeURIComponent(url.match(/elementId=([^&-]+)/i)?.[1] || '');
    const summary = [file, component && `componentName=${component}`, elementKind && `elementId=${elementKind}`]
      .filter(Boolean)
      .join(' ');
    if (summary && !seen.includes(summary)) seen.push(summary);
    if (seen.length >= 12) break;
  }
  return seen;
}

async function waitForStripeTarget(debugPort, targetPattern, readySelector, label) {
  try {
    return await waitForValue(async () => {
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
  } catch (error) {
    // 超时只记录 iframe 文件名和 componentName，避免把 Stripe URL 里的邮箱或公钥写进日志。
    const observed = summarizeStripeIframeTargets(await getTargets(debugPort).catch(() => []));
    throw new Error(`${error.message}；当前 Stripe iframe：${observed.join(' | ') || '无'}`);
  }
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
    const deadline = waitDeadline(timeoutMilliseconds);
    let state;
    while (Date.now() <= deadline) {
      state = await readState();
      if (isComplete(state)) return state;
      await sleep(DOM_POLL_MILLISECONDS);
    }
    return state;
  };

  // 三项全部输入并失焦后按最终状态等待 Stripe 校验，正式任务共用整行剩余时间。
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
  const deadline = waitDeadline(STRIPE_WAIT_MILLISECONDS);
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
    STRIPE_PAYMENT_TARGET_PATTERN,
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

async function readStripeFieldFilled(client, selector) {
  return evaluate(client, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return {found:false, filled:false};
    const value = String(element.value || '').trim();
    const text = String(element.selectedOptions?.[0]?.textContent || '').trim();
    const placeholder = /^(select|choose|state|province)?$/i.test(value)
      || /^(select|choose|state|province)?$/i.test(text);
    return {found:true, filled: Boolean(value || text) && !placeholder};
  })()`);
}

async function fillStripeAddressFieldIfEmpty(client, selector, value, options = {}) {
  const state = await readStripeFieldFilled(client, selector);
  // 地址被 Stripe 自动填充或上次留下内容时，禁止清空重填，避免把 City / ZIP 等连带冲掉。
  if (state?.filled) {
    options.onSkip?.(`${options.label || '地址字段'} 已有内容，跳过输入`);
    return 'skipped';
  }
  await focusAndType(client, selector, value, options);
  return 'typed';
}

async function chooseStripeSelectIfEmpty(client, selector, searchText, acceptedValues, label, onSkip = () => {}) {
  const state = await readStripeFieldFilled(client, selector);
  if (state?.filled) {
    onSkip(`${label} 已有内容，跳过选择`);
    return 'skipped';
  }
  await chooseSelectWithKeyboard(client, selector, searchText, acceptedValues, label);
  return 'typed';
}

async function readStripeCountryState(address) {
  return evaluate(address, `(() => {
    const element = document.querySelector('#billingAddress-countryInput, select[name="country"], input[name="country"]');
    if (!element) return {found:false, isUnitedStates:false, isSelect:false};
    const value = String(element.value || '').trim();
    const text = String(element.selectedOptions?.[0]?.textContent || '').trim();
    const shown = String(element.innerText || element.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
    const tokens = [value, text, shown].map((item) => item.toLowerCase());
    const isUnitedStates = tokens.some((item) => item === 'us' || item === 'usa' || item.includes('united states'));
    return {found:true, isUnitedStates, isSelect: element.tagName === 'SELECT'};
  })()`);
}

async function ensureStripeCountryUnitedStates(address, onStep = () => {}) {
  const countrySelector = '#billingAddress-countryInput, select[name="country"], input[name="country"]';
  const current = await readStripeCountryState(address);
  if (!current?.found) throw new Error('没有找到账单国家输入框');
  // 国家字段特殊：必须是美国。已是美国才跳过；其他国家即使有值也要替换成 United States。
  if (current.isUnitedStates) {
    onStep('账单国家已是 United States，跳过');
    return;
  }

  onStep('账单国家不是美国，切换为 United States');
  if (current.isSelect) {
    await chooseSelectWithKeyboard(
      address,
      countrySelector,
      'United States',
      ['US', 'USA', 'United States'],
      'Country or region',
    );
  } else {
    await focusAndType(address, countrySelector, 'United States', {
      intervalMilliseconds: 80,
      label: 'Country or region',
    });
  }
  // 切换国家会重绘地址表单；等美国格式稳定后再填后续字段，超时风险由 City/State/ZIP 等待承担。
  await sleep(600);
  const after = await readStripeCountryState(address);
  if (!after?.isUnitedStates) throw new Error('账单国家未能切换为 United States');
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
    '等待 5 秒仍未显示 City、State、ZIP code',
  );
}

async function fillStripeBillingAddress(debugPort, row, onStep = () => {}) {
  const target = await waitForStripeTarget(
    debugPort,
    STRIPE_ADDRESS_TARGET_PATTERN,
    '#billingAddress-nameInput, input[name="name"]',
    'Stripe Billing address 输入框',
  );
  const address = target.frame;
  try {
    const keyboardOptions = { intervalMilliseconds: 100 };
    onStep('先判断账单国家是否为美国');
    await ensureStripeCountryUnitedStates(address, onStep);

    onStep('填写账单姓名和 Address line 1；已有内容则跳过');
    await fillStripeAddressFieldIfEmpty(address, '#billingAddress-nameInput, input[name="name"]', row.billingName, {
      ...keyboardOptions,
      label: 'Full name',
      onSkip: onStep,
    });
    await fillStripeAddressFieldIfEmpty(address, '#billingAddress-addressLine1Input, input[name="addressLine1"]', row.billingAddressLine1, {
      ...keyboardOptions,
      label: 'Address line 1',
      onSkip: onStep,
    });

    onStep('等待 City、State、ZIP code 出现');
    await waitForStripeAddressDetailFields(address);
    if (String(row.billingAddressLine2 || '').trim()) {
      await fillStripeAddressFieldIfEmpty(address, '#billingAddress-addressLine2Input, input[name="addressLine2"]', row.billingAddressLine2, {
        ...keyboardOptions,
        label: 'Address line 2',
        onSkip: onStep,
      });
    }

    onStep('填写 City；已有内容则跳过');
    await fillStripeAddressFieldIfEmpty(address, '#billingAddress-localityInput, input[name="locality"]', row.billingCity, {
      ...keyboardOptions,
      label: 'City',
      onSkip: onStep,
    });
    const fullStateName = stateName(row.billingState);
    onStep('选择 State；已有内容则跳过');
    await chooseStripeSelectIfEmpty(
      address,
      '#billingAddress-administrativeAreaInput, select[name="administrativeArea"]',
      fullStateName,
      [row.billingState, fullStateName],
      'State',
      onStep,
    );
    onStep('填写 ZIP code；已有内容则跳过');
    await fillStripeAddressFieldIfEmpty(address, '#billingAddress-postalCodeInput, input[name="postalCode"]', row.billingPostalCode, {
      ...keyboardOptions,
      label: 'ZIP code',
      onSkip: onStep,
    });
    onStep('账单地址已就绪');
  } finally {
    address.close();
  }
}

async function readSubscribeButtonState(page) {
  return evaluate(page, `(${inspectCheckoutSubmitButton.toString()})()`);
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
    const alertNodes = [...document.querySelectorAll(
      '[role="alert"], [aria-live="assertive"], [aria-live="polite"], [data-sonner-toast], [data-testid*="alert" i], [class*="alert" i], [class*="error" i]',
    )].filter(visible);
    const alertTexts = alertNodes
      .map((node) => normalize(node.innerText || node.textContent))
      .filter(Boolean);
    // 仅明确的支付错误结束等待；普通状态通知、转圈、按钮禁用都不是失败证据。
    const declinedFromBody = (body.match(/Your (?:payment|card) (?:was|has been) declined\\./i) || [])[0] || '';
    const error = alertTexts.find((text) => /declined|try a different card|payment failed|couldn['’]t (be )?process/i.test(text))
      || declinedFromBody;
    const leftCheckout = !/\\/checkout\\//i.test(location.href);
    const successText = /you('re| are) all set|welcome to chatgpt pro|subscription (is )?now active|thanks for subscribing/i.test(body);
    const processing = [...document.querySelectorAll('button,[role="button"]')].some((node) => {
      if (!visible(node)) return false;
      const label = normalize(node.innerText || node.textContent || node.getAttribute('aria-label'));
      const subscribeLike = /\\bSubscribe\\b/i.test(label) || label === 'Upgrade to Pro' || node.getAttribute('aria-busy') === 'true';
      if (!subscribeLike) return false;
      return node.disabled
        || node.getAttribute('aria-disabled') === 'true'
        || node.getAttribute('aria-busy') === 'true';
    });
    return {
      href: location.href,
      error,
      success: !error && (leftCheckout || successText),
      processing,
    };
  })()`);
}

async function readSubscribeProgress(page, debugPort) {
  const targets = await getTargets(debugPort).catch(() => []);
  const chatPages = targets.filter((item) => item?.type === 'page' && /chatgpt\.com/i.test(item.url || ''));
  const checkoutOpen = chatPages.some((item) => /\/checkout\//i.test(item.url || ''));
  const homeOpened = chatPages.some((item) => isChatGptHomeUrl(item.url));
  // 支付成功后同一标签会变成首页；先看 CDP 标签 URL，避免卡在正在卸载的 checkout 文档上做 evaluate。
  if (homeOpened && !checkoutOpen) {
    return { href: '', error: '', success: true, processing: false };
  }
  const fromPage = await readSubscribeOutcome(page).catch(() => null);
  return {
    href: fromPage?.href || '',
    error: fromPage?.error || '',
    success: Boolean(fromPage?.success || (homeOpened && !checkoutOpen)),
    processing: Boolean(fromPage?.processing),
  };
}

function describeSubscribeProgress(state, prefix) {
  if (state?.error) return `${prefix}出现支付结果`;
  if (state?.success) return `${prefix}已离开结账页`;
  return `${prefix}页面已开始处理支付`;
}

async function clickSubscribeAndAwaitResult(page, debugPort, onStep = () => {}, proofContext = {}) {
  if (proofContext.rechargeType === 'ads') {
    return waitForSubscriptionPayment({
      readButton: () => readSubscribeButtonState(page),
      readOutcome: submitted => submitted ? readSubscribeProgress(page, debugPort) : readSubscribeOutcome(page),
      submit: async button => {
        // 稳定后重新读取唯一按钮及坐标；按钮重新禁用或离开视口时继续等，绝不强点。
        await sleep(600);
        const current = await readSubscribeButtonState(page);
        const point = current?.point;
        if (!current?.enabled || current.label !== button.label || !point) return false;
        if (point.y < 0 || point.y > current.viewport.height) {
          await page.command('Input.dispatchMouseEvent', { type: 'mouseWheel', x: current.viewport.width / 2,
            y: current.viewport.height / 2, deltaX: 0, deltaY: point.y < 0 ? -400 : 400 });
          return false;
        }
        if (point.x < 0 || point.x > current.viewport.width) return false;
        if (!button.point || Math.abs(point.x - button.point.x) > 4 || Math.abs(point.y - button.point.y) > 4) return false;
        assertTaskActive();
        // 鼠标提交开始后就可能扣款，中途终止不能当作未支付；结果未确认时禁止直接重跑充值。
        proofContext.onPaymentSubmitted?.();
        await mouseClick(page, point);
        return true;
      },
      wait: () => sleep(DOM_POLL_MILLISECONDS),
      isActive: proofContext.isActive,
      onStep,
    });
  }
  onStep('账单地址已填写，等待结账订阅按钮可点击（最多 60 秒）');
  const button = await waitForValue(
    () => readSubscribeButtonState(page),
    (state) => state?.found && state?.enabled,
    SUBSCRIBE_BUTTON_WAIT_MILLISECONDS,
    '资料填写后已等待 60 秒，但结账订阅按钮（Upgrade to Pro / Subscribe）仍不可点击',
  );
  const clickOptions = {
    timeoutMilliseconds: 10000,
    timeoutMessage: `没有找到可点击的 ${button.label}`,
    stabilityMilliseconds: 600,
  };
  const progressed = async () => {
    const state = await readSubscribeProgress(page, debugPort);
    return (state.error || state.success || state.processing) ? state : false;
  };

  onStep(`第一次点击 ${button.label || 'Subscribe'}`);
  proofContext.onPaymentSubmitted?.();
  await clickExactText(page, button.label || 'Subscribe', clickOptions);
  let state;
  let usedRetry = false;
  try {
    state = await waitForValue(progressed, Boolean, 10000, '第一次点击后页面未开始处理支付');
    onStep(describeSubscribeProgress(state, '第一次点击后'));
  } catch {
    // 第一次点击被吞掉时只补点当前按钮一次，不重跑整条任务。
    usedRetry = true;
    onStep('第一次点击后 10 秒内页面未开始处理，按同一按钮补点一次');
    await clickExactText(page, button.label || 'Subscribe', { ...clickOptions, timeoutMilliseconds: 3000 });
    state = await waitForValue(progressed, Boolean, 10000, '补点后页面仍未开始处理支付');
    onStep(describeSubscribeProgress(state, '补点后'));
  }
  if (state.error) throw new Error(state.error);
  if (state.success) {
    onStep(usedRetry ? '补点后支付已完成，无需再等 90 秒' : '第一次点击后支付已完成，无需再等 90 秒');
    return state;
  }

  const startedAt = Date.now();
  onStep('支付处理中，等待成功或拒付（最多 90 秒）');
  const outcome = await waitForValue(
    () => readSubscribeProgress(page, debugPort),
    (item) => Boolean(item?.error || item?.success),
    SUBSCRIBE_RESULT_WAIT_MILLISECONDS,
    // 支付网关确认可能超过 45 秒；90 秒内既不跳转也不拒付则当前任务失败，整条任务仍受 10 分钟上限约束。
    '已点击 Subscribe，但 90 秒内没有出现支付成功或拒付提示',
  );
  const waitedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
  const clickSource = usedRetry ? '补点后' : '第一次点击后';
  if (outcome.error) {
    onStep(`${clickSource}等待 ${waitedSeconds} 秒后出现拒付`);
    throw new Error(outcome.error);
  }
  onStep(`${clickSource}等待 ${waitedSeconds} 秒后支付成功`);
  return outcome;
}

function hasBillingAddressInRow(row) {
  return ['billingName', 'billingAddressLine1', 'billingCity', 'billingState', 'billingPostalCode']
    .every((field) => String(row[field] || '').trim());
}

async function verifyExistingStripeBillingAddress(debugPort) {
  const target = await waitForStripeTarget(
    debugPort,
    STRIPE_ADDRESS_TARGET_PATTERN,
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

function readBottomLeftProfilePointExpression() {
  return `(() => {
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const visible = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 8 && rect.height > 8 && getComputedStyle(node).visibility !== 'hidden';
    };
    // 只查左下角可点击节点，不要扫整页 DOM；首页侧栏可能晚于页面主体出现，由调用方持续轮询。
    const inBottomLeft = (rect) => rect.left < Math.min(420, innerWidth * 0.45) && rect.bottom > innerHeight * 0.55;
    const blocked = /^(Upgrade|New chat|Search chats|Log out|Settings|Help|Library|Projects|Scheduled|Plugins|More)$/i;
    const storeLike = /GPT Store|Explore GPTs|\\bSora\\b/i;
    const candidates = [...document.querySelectorAll('button,a,[role="button"],[aria-haspopup="menu"],[aria-haspopup="true"]')]
      .filter((node) => {
        if (node.disabled || !visible(node)) return false;
        const rect = node.getBoundingClientRect();
        if (!inBottomLeft(rect)) return false;
        const label = normalize(node.getAttribute('aria-label') || node.innerText || node.textContent || '');
        if (blocked.test(label) || /\\bupgrade\\b/i.test(label) || storeLike.test(label)) return false;
        return /^Open profile menu$/i.test(label) || /\\b(Pro|Plus|Free|Business|Team|Go|Enterprise)\\b/i.test(label);
      })
      .map((node) => {
        const rect = node.getBoundingClientRect();
        const label = normalize(node.getAttribute('aria-label') || node.innerText || node.textContent || '');
        return {
          profileMenu: /^Open profile menu$/i.test(label),
          hasPlan: /\\b(Pro|Plus|Free|Business|Team|Go|Enterprise)\\b/i.test(label),
          x: rect.left + Math.min(28, rect.width / 2),
          y: rect.top + Math.min(rect.height / 2, 28),
          top: rect.top,
          width: rect.width,
        };
      });
    candidates.sort((left, right) => Number(right.profileMenu) - Number(left.profileMenu) || Number(right.hasPlan) - Number(left.hasPlan) || right.width - left.width || right.top - left.top);
    return {
      point: candidates[0] || null,
      viewport: {width: innerWidth, height: innerHeight},
    };
  })()`;
}

async function readSettingsMenuState(page) {
  return evaluate(page, `(() => {
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== 'hidden';
    };
    return [...document.querySelectorAll('button,a,[role="button"],[role="menuitem"]')]
      .some((node) => !node.disabled && visible(node) && /^(Settings|设置)$/i.test(normalize(node.innerText || node.textContent || node.getAttribute('aria-label'))));
  })()`);
}

async function readSettingsPageState(page) {
  return evaluate(page, `(() => {
    const path = location.pathname || '';
    const bodyText = document.body?.innerText || '';
    // Settings 兼容独立页面及弹窗，两种布局均须有设置内容才能继续。
    const settingsVisible = [...document.querySelectorAll('[role="dialog"],dialog')].some(node => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && /Settings|设置/i.test(node.innerText || '')
        && /Security and login|Billing|账单/i.test(node.innerText || '');
    });
    return settingsVisible || ((path === '/settings' || path.startsWith('/settings/'))
      && (/Settings|General|Billing|账单|设置/i.test(bodyText)));
  })()`);
}

async function readBillingPanelState(page) {
  return evaluate(page, `(${inspectBillingProof.toString()})()`);
}

async function saveViewportScreenshot(page, fileName) {
  await page.command('Page.enable').catch(() => {});
  const result = await page.command('Page.captureScreenshot', { format: 'png', fromSurface: true });
  if (!result?.data) throw new Error('CDP 没有返回图片数据');
  await mkdir(screenshotDirectory, { recursive: true });
  const safeName = String(fileName || '').replace(/[^a-zA-Z0-9._-]/g, '');
  if (!safeName.endsWith('.png')) throw new Error('截图文件名无效');
  await writeFile(join(screenshotDirectory, safeName), Buffer.from(result.data, 'base64'));
  return `/api/screenshots/${safeName}`;
}

async function ensureHomePageForBillingProof(page, debugPort, onStep = () => {}) {
  const targets = await getTargets(debugPort).catch(() => []);
  const homeTarget = targets.find(isChatGptHomeTarget);
  const checkoutOpen = targets.some((item) => item?.type === 'page' && /\/checkout\//i.test(item.url || ''));
  // 支付成功后同一标签会变成首页；先看标签 URL，不要卡在旧 checkout 文档的 evaluate 上。
  if (homeTarget && !checkoutOpen) {
    const href = await evaluate(page, 'location.href', false, 2000).catch(() => '');
    if (isChatGptHomeUrl(href)) {
      onStep('ChatGPT 页面已打开，准备进入设置');
      return { page, extra: null };
    }
    onStep('ChatGPT 首页已打开，立即查找左下角头像');
    const homePage = await connectCdp(homeTarget.webSocketDebuggerUrl);
    await homePage.command('Page.enable').catch(() => {});
    await homePage.command('Runtime.enable').catch(() => {});
    return { page: homePage, extra: homePage };
  }
  const href = await evaluate(page, 'location.href', false, 2000).catch(() => '');
  if (isChatGptHomeUrl(href)) {
    onStep('ChatGPT 页面已打开，准备进入设置');
    return { page, extra: null };
  }
  onStep('返回 chatgpt.com 首页');
  const navigation = await page.command('Page.navigate', { url: 'https://chatgpt.com/' });
  if (navigation?.errorText) throw new Error(`返回 ChatGPT 首页失败：${navigation.errorText}`);
  return { page, extra: null };
}

async function openAccountSettings(page, debugPort, onStep = () => {}) {
  const attached = await ensureHomePageForBillingProof(page, debugPort, onStep);
  const homePage = attached.page;
  try {
    // Billing 与 2FA 共用 Settings；支持独立设置页及用户截图中的弹窗，已打开时直接复用。
    await homePage.command('Page.bringToFront');
    if (await readSettingsPageState(homePage).catch(() => false)) return attached;
    onStep('等待首页左下角头像加载，与整行任务共享剩余时间，出现后立即继续');
    const validPoint = state => Boolean(state?.point) && state.point.x >= 0 && state.point.x <= state.viewport.width
      && state.point.y >= 0 && state.point.y <= state.viewport.height;
    const readPoint = () => evaluate(homePage, readBottomLeftProfilePointExpression());
    const menuOrSettings = async () => await readSettingsPageState(homePage) || await readSettingsMenuState(homePage);
    // 账号菜单已打开或 Settings 已由页面跳转时直接接续，避免再次点头像反而关掉菜单。
    let previousPoint;
    const entry = await waitForValue(async () => {
      if (await menuOrSettings()) return {opened:true};
      const state = await readPoint();
      const point = validPoint(state) ? state.point : null;
      const stable = point && previousPoint && Math.abs(point.x-previousPoint.x)<=2 && Math.abs(point.y-previousPoint.y)<=2;
      previousPoint = point;
      return stable ? {point} : null;
    }, Boolean, PROFILE_AVATAR_WAIT_MILLISECONDS, '等待可点击且位置稳定的左下角头像');
    if (!entry.opened) {
      onStep('点击左下角头像，等待账号菜单');
      await mouseClick(homePage, entry.point);
      await waitForSettingsTransition(menuOrSettings, async () => {
        const state = await readPoint();
        if (!validPoint(state)) return false;
        await sleep(250);
        if (await menuOrSettings()) return false;
        const stable = await readPoint();
        if (!validPoint(stable) || Math.abs(state.point.x-stable.point.x)>2 || Math.abs(state.point.y-stable.point.y)>2) return false;
        await mouseClick(homePage, stable.point);
        return true;
      }, PROFILE_AVATAR_WAIT_MILLISECONDS, '头像点击后等待 Settings 菜单', onStep);
    }
    if (await readSettingsPageState(homePage)) return attached;

    onStep('点击 Settings');
    await clickAndConfirm(
      homePage,
      'Settings',
      {
        alternateTexts: ['设置'],
        retryNavigation: true, onStep,
        timeoutMilliseconds: 10000,
        timeoutMessage: '头像菜单里没有找到可点击的 Settings',
        stabilityMilliseconds: 600,
      },
      () => readSettingsPageState(homePage),
      10000,
      'Settings 已点击，但设置页面没有打开',
    );

    return attached;
  } catch (error) {
    attached.extra?.close();
    throw error;
  }
}

async function captureAccountBillingProof(page, { jobId, index, debugPort }, onStep = () => {}) {
  let extra = null;
  let homePage;
  try {
    const attached = await openAccountSettings(page, debugPort, onStep);
    homePage = attached.page;
    extra = attached.extra;
    onStep('点击 Billing');
    await clickAndConfirm(
      homePage,
      'Billing',
      {
        alternateTexts: ['账单'],
        retryNavigation: true, onStep,
        region: 'left',
        timeoutMilliseconds: 10000,
        timeoutMessage: '设置弹窗里没有找到可点击的 Billing',
        stabilityMilliseconds: 600,
      },
      // 进入 Billing 就先缩放，不能以尚在屏幕外的邮箱作为缩放前置条件。
      async () => (await readBillingPanelState(homePage)).billingOpen,
      20000,
      'Billing 已点击，但账单内容没有出现',
    );

    onStep('Billing 浏览器 Zoom 设置为 75%，等待 Billing email 邮箱加载并完整入镜');
    await setBillingBrowserZoom(homePage, waitForValue, process.platform, onStep);
    let stableLayout = '';
    // 网络慢时邮箱值可能晚于标题；只用整行剩余时间等待，未入镜或超时不能保存缺邮箱的截图。
    await waitForValue(async () => {
      const state = await readBillingPanelState(homePage);
      const zoom = await readBillingBrowserZoom(homePage);
      if (!state.screenshotReady || Math.abs(zoom - 0.75) >= 0.005 || !Number.isFinite(zoom)) { stableLayout = ''; return false; }
      if (stableLayout === state.layout) return true;
      stableLayout = state.layout;
      return false;
    }, Boolean, ROW_TIMEOUT_MILLISECONDS, '75% 缩放后，Billing email 邮箱内容或套餐尚未完整显示');
    onStep('75% 缩放下套餐与 Billing email 已显示，保存截图');
    const fileName = `${jobId || 'job'}-${Number(index) || 0}.png`;
    const screenshotUrl = await saveViewportScreenshot(homePage, fileName);
    return { screenshotUrl };
  } catch (error) {
    // 此时 Subscribe 已经成功，截图失败不能把任务打进失败重试列表，否则会重复扣款。
    onStep(`账户 Billing 截图失败：${error.message}`);
    return { screenshotUrl: '', screenshotError: error.message };
  } finally {
    if (extra) extra.close();
  }
}

async function captureAccountInvoice(page, {debugPort}, onStep = () => {}) {
  let extra=null, invoicePage=null, browser=null, targetId=null, stage='打开 Billing';
  try {
    const attached=await openAccountSettings(page,debugPort,onStep);extra=attached.extra;
    const billing=attached.page;
    const read=()=>evaluate(billing,`(${inspectLatestInvoice.toString()})()`);
    onStep('点击 Billing，等待 Transaction history 最新交易');
    await clickAndConfirm(billing,'Billing',{alternateTexts:['账单'],region:'left',stabilityMilliseconds:600},async()=>Boolean((await read())?.ready),20000,'Billing 的交易记录尚未加载');
    let state;
    while(true){
      assertTaskActive();state=await read();
      const inViewport=s=>s?.enabled&&s.point.x>=0&&s.point.x<=s.viewport.width&&s.point.y>=0&&s.point.y<=s.viewport.height;
      if(inViewport(state)){
        await sleep(400);const stable=await read();
        if(inViewport(stable)&&stable.href===state.href&&Math.abs(stable.point.x-state.point.x)<2&&Math.abs(stable.point.y-state.point.y)<2){state=stable;break;}
      }else if(state){await billing.command('Input.dispatchMouseEvent',{type:'mouseWheel',...state.wheel,deltaX:0,deltaY:state.scrollUp?-300:300});}
      await sleep(250);
    }
    const previous=new Set((await getTargets(debugPort)).map(t=>t.id));
    const expected=new URL(state.href);
    stage='打开最新交易发票';onStep('点击 Transaction history 最新交易的发票入口');
    await mouseClick(billing,state.point);
    const target=await waitForValue(async()=> (await getTargets(debugPort)).find(t=>{
      if(t.type!=='page'||previous.has(t.id))return false;
      try{const u=new URL(t.url);return u.origin===expected.origin&&u.pathname===expected.pathname;}catch{return false;}
    }),Boolean,45000,'最新交易的 Stripe 发票页面尚未打开');
    targetId=target.id;invoicePage=await connectCdp(target.webSocketDebuggerUrl);
    await invoicePage.command('Page.enable');await invoicePage.command('Page.bringToFront');
    const response=await fetch(`http://127.0.0.1:${debugPort}/json/version`,{signal:taskWaitScope.getStore()?.signal});
    const endpoint=await response.json();browser=await connectCdp(endpoint.webSocketDebuggerUrl);
    stage='下载发票 PDF';onStep('点击 Download invoice，等待完整 PDF 下载');
    const proof=await downloadInvoicePdf(browser,invoicePage,{read:()=>evaluate(invoicePage,`(${inspectInvoiceDownload.toString()})()`),
      wait:waitForValue,click:mouseClick,pause:sleep,assertActive:assertTaskActive});
    onStep('最新交易发票 PDF 已下载');
    return proof;
  }catch(error){
    return{invoiceFileName:'',invoiceStatus:'failed',invoiceError:`${stage}失败：${/^发票/.test(error.message)?error.message:'浏览器页面或下载连接未就绪，请单独重试'}`};
  }finally{
    if(targetId)await (browser||page).command('Target.closeTarget',{targetId}).catch(()=>{});
    invoicePage?.close();browser?.close();extra?.close();
  }
}

async function configureAccountTwoFactor(page, context, onStep, onProgress) {
  let extra;
  try {
    if (!context.isActive()) throw new Error('任务已结束');
    // 已在验证器向导或二次验证页时直接继续，避免返回首页丢掉当前 Key 和验证进度。
    const resumable = ['enabled', 'disabled', 'intro', 'setup', 'verification_required', 'password_required'];
    const current = await evaluate(page, `(${inspectAuthenticator.toString()})()`, false).catch(() => ({stage:'unavailable'}));
    const attached = resumable.includes(current.stage) ? {page, extra:null} : await openAccountSettings(page, context.debugPort, onStep);
    const securityPage = attached.page;
    extra = attached.extra;
    const read = (action = 'state') => evaluate(securityPage,
      `(${inspectAuthenticator.toString()})(${JSON.stringify(action)})`, false, 3000)
      .catch(() => action === 'secret' ? '' : ({stage:'unavailable'}));
    if (!resumable.includes((await read()).stage)) {
      onStep('打开 Security and login');
      // 安全页等待验证器开关，与整行任务共享剩余时间；未确认开关时不能修改其他安全设置。
      await clickAndConfirm(securityPage, 'Security and login', {
        region: 'left', timeoutMilliseconds: 10000, stabilityMilliseconds: 600,
      }, async () => resumable.includes((await read()).stage), 10000,
      'Security and login 未显示 Authenticator app');
    }
    return await configureAuthenticator({
      read, now: Date.now, sleep, onStep, isActive: context.isActive,
      click: point => mouseClick(securityPage, point),
      scroll: state => securityPage.command('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: Math.min(state.viewport.width - 20, Math.max(1, state.point.x)),
        y: state.viewport.height / 2, deltaX: 0, deltaY: state.point.y < 0 ? -300 : 300,
      }),
      type: async code => {
        await typeWithKeyboard(securityPage, code, { intervalMilliseconds: 100 });
        await dispatchKey(securityPage, 'Tab', 'Tab', 9);
      },
      typePassword: async password => {
        // 仅在官方密码框逐字符输入现有密码，Tab 后精确核对；失败不输出密码或页面原文。
        const inputState = () => evaluate(securityPage, `(${inspectLoginInput.toString()})('password', ${JSON.stringify(password)})`, false);
        const before = await inputState();
        if (!before?.focused) throw new Error('密码输入框未就绪');
        if (before.accepted) return;
        await clearFocusedField(securityPage, before.length);
        await typeWithKeyboard(securityPage, password, {intervalMilliseconds:100});
        await dispatchKey(securityPage, 'Tab', 'Tab', 9);
        if (!(await inputState())?.accepted) throw new Error('密码输入未被页面接受');
      },
    }, onProgress, {verificationPassword:context.verificationPassword});
  } catch {
    // 安全页可能包含 Key 或验证码，禁止传播原始页面异常到日志。
    return { twoFactorStatus: 'failed', twoFactorError: '无法完成 2FA 安全设置，请检查当前账号页面' };
  } finally {
    extra?.close();
  }
}

async function readLoginVerificationState(page) {
  return evaluate(page, `(() => {
    const visible = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== 'hidden';
    };
    const codeInput = [...document.querySelectorAll('input[autocomplete="one-time-code"], input[inputmode="numeric"], input[name="code"]')].find(visible);
    const body = document.body?.innerText || '';
    return {hasCodeInput: Boolean(codeInput), mentionsCode: /verification code|login code|验证码|验证码已发送/i.test(body)};
  })()`);
}

async function readLatestChatGptCode(page) {
  return evaluate(page, `(() => {
    const body = String(document.body?.innerText || '').replace(/\\s+/g, ' ');
    const match = body.match(/(?:enter this code|your code is|验证码)[^0-9]{0,50}(\\d{6})/i);
    return match?.[1] || '';
  })()`);
}

function inferMailType(email) {
  const domain = String(email || '').trim().toLowerCase().split('@').pop() || '';
  if (/^(outlook|hotmail|live|msn)\./.test(domain)) return 'outlook';
  if (/^(gmail|googlemail)\./.test(domain)) return 'gmail';
  throw new Error(`无法根据邮箱域名识别 mail2 类型：${domain || '空邮箱域名'}`);
}

async function chooseMailTypeByDomain(page, email) {
  const kind = inferMailType(email);
  const state = await evaluate(page, `(() => {
    const select = document.querySelector('select');
    if (!select) return null;
    select.scrollIntoView?.({block:'center', inline:'center'});
    select.focus();
    const options = [...select.options].map((option, index) => ({index, text: option.textContent || '', value: option.value || ''}));
    const pattern = ${kind === 'outlook' ? '/outlook|microsoft/i' : '/gmail|google/i'};
    const match = options.find((option) => pattern.test(option.text) || pattern.test(option.value));
    return {active: document.activeElement === select, match, options};
  })()`);
  if (!state?.active || !state.match) throw new Error(`mail2 没有找到与邮箱域名匹配的类型：${kind}`);
  await dispatchKey(page, 'Home', 'Home', 36);
  for (let index = 0; index < state.match.index; index += 1) await dispatchKey(page, 'ArrowDown', 'ArrowDown', 40);
  await dispatchKey(page, 'Enter', 'Enter', 13);
  await dispatchKey(page, 'Tab', 'Tab', 9);
  await sleep(300);
  const selected = await evaluate(page, `(() => {
    const select = document.querySelector('select');
    return select?.selectedOptions?.[0]?.textContent || '';
  })()`);
  if (!String(selected).trim()) throw new Error('mail2 邮箱类型选择失败');
}

async function readMailCode(row, debugPort) {
  const version = await fetch(`http://127.0.0.1:${debugPort}/json/version`).then((response) => response.ok ? response.json() : null).catch(() => null);
  const targetResult = version?.webSocketDebuggerUrl ? await connectCdp(version.webSocketDebuggerUrl).catch(() => null) : null;
  if (!targetResult) throw new Error('无法连接谷歌无痕浏览器以读取邮箱验证码');
  let mailPage;
  try {
    const created = await targetResult.command('Target.createTarget', {url: 'https://mail2.ap1x.xyz/'});
    const deadline = waitDeadline(30000);
    while (Date.now() <= deadline) {
      const targets = await getTargets(debugPort).catch(() => []);
      const target = targets.find((item) => item.id === created.targetId && item.webSocketDebuggerUrl);
      if (target) { mailPage = await connectCdp(target.webSocketDebuggerUrl); break; }
      await sleep(250);
    }
    if (!mailPage) throw new Error('mail2 邮箱页面未打开');
    await mailPage.command('Page.enable');
    await mailPage.command('Runtime.enable');
    await waitForValue(
      () => evaluate(mailPage, `Boolean(document.querySelector('select')) && Boolean(document.querySelector('textarea, input[type="text"], input:not([type])'))`),
      Boolean,
      30000,
      'mail2 页面输入框未加载完成',
    );
    await chooseSelectWithKeyboard(mailPage, 'select', row.mailType, [row.mailType], '邮箱类型');
    await focusAndType(mailPage, 'textarea, input[type="text"], input:not([type])', row.mailAccess, {
      label: 'mail2 邮箱查询字符串',
      validateAfterInput: false,
      intervalMilliseconds: 10,
    });
    await clickExactText(mailPage, '进入邮件列表', {
      alternateTexts: ['Enter mail list'],
      timeoutMilliseconds: 15000,
      stabilityMilliseconds: 300,
    });
    return await waitForValue(
      () => readLatestChatGptCode(mailPage),
      (value) => /^\d{6}$/.test(String(value || '')),
      30000,
      'mail2 最近的 ChatGPT 邮件中没有六位验证码',
    );
  } finally {
    try { if (mailPage) mailPage.close(); } catch {}
    targetResult.close();
  }
}

async function completeEmailVerification(page, row, debugPort, onStatus) {
  const state = await readLoginVerificationState(page);
  if (!state?.hasCodeInput && !state?.mentionsCode) return;
  onStatus('ChatGPT 需要邮箱验证码，正在通过 mail2 读取最近邮件');
  const code = await readMailCode(row, debugPort);
  await focusAndType(page, 'input[autocomplete="one-time-code"], input[inputmode="numeric"], input[name="code"], input[type="text"]', code, {
    label: 'ChatGPT 邮箱验证码',
    normalize: (value) => String(value || '').replace(/\D/g, ''),
  });
  await clickExactText(page, 'Continue', {
    alternateTexts: ['Verify', '验证'],
    timeoutMilliseconds: 10000,
    stabilityMilliseconds: 300,
  }).catch(() => {});
  await waitForValue(
    () => evaluate(page, `(() => !document.querySelector('input[autocomplete="one-time-code"], input[inputmode="numeric"], input[name="code"]'))()`),
    Boolean,
    10000,
    'ChatGPT 验证码已输入，但登录页面没有继续',
  ).catch(() => {});
  onStatus('邮箱验证码已输入，已继续 ChatGPT 登录');
}

async function fillLoginIfNeeded(page, row, onStatus, rechargeType, debugPort, isActive = () => true) {
  if (rechargeType !== 'google-incognito') {
    // AdsPower 优先复用登录状态，不读取密码；人工登录等待计入整行 10 分钟，未回到首页绝不进入充值。
    const deadline = waitDeadline(ROW_TIMEOUT_MILLISECONDS);
    const submitted = new Set();
    const notified = new Set();
    while (isActive() && Date.now() < deadline) {
      const state = assertLoginState(await evaluate(page, `(${inspectLoginPage.toString()})(${JSON.stringify(LOGIN_SELECTORS)})`));
      const kind = loginStateKind(state);
      if (kind === 'home') return;
      if (['password', 'manual', 'code'].includes(kind) && !notified.has(kind)) {
        onStatus('ChatGPT 需要登录验证，请在 AdsPower 窗口手动完成密码/验证码或安全验证；本程序不读取密码');
        notified.add(kind);
      }
      if (kind === 'email' && !submitted.has(kind)) {
        await focusAndType(page, LOGIN_SELECTORS.email, row.email, {label:'ChatGPT 登录邮箱'});
        await clickExactText(page, 'Continue', {timeoutMilliseconds:20000, timeoutMessage:'没有找到登录邮箱后的 Continue'});
        submitted.add(kind);
      } else if (kind === 'entry' && !submitted.has(kind)) {
        await clickExactText(page, state.loginLabel, {timeoutMilliseconds:20000, timeoutMessage:'没有找到 ChatGPT 登录入口'});
        submitted.add(kind);
      }
      await sleep(DOM_POLL_MILLISECONDS);
    }
    throw new Error('等待 ChatGPT 人工登录超时，尚未确认登录成功');
  }
  const entryState = await waitForValue(
    () => evaluate(page, `(() => {
      const visible = (node) => { if (!node) return false; const rect = node.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; };
      const emailInput = document.querySelector('input[type="email"], input[name="email"]');
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const inTopRight = (rect) => rect.left > innerWidth * 0.55 && rect.top < Math.min(220, innerHeight * 0.35);
      const homeEntry = [...document.querySelectorAll('button,a,[role="button"]')].some((node) => {
        const rect = node.getBoundingClientRect();
        const text = normalize(node.innerText || node.textContent || node.getAttribute('aria-label'));
        if (!visible(node) || node.disabled) return false;
        if (text === 'Upgrade' && inTopRight(rect)) return true;
        if (text === 'Free offer' && inTopRight(rect)) return true;
        return text === 'Claim offer';
      });
      return {hasEmailInput: visible(emailInput), homeEntry};
    })()`),
    (state) => state?.hasEmailInput || state?.homeEntry,
    45000,
    'ChatGPT 首页已打开，但既没有出现登录框，也没有出现右上角 Upgrade / Free offer 或 Claim offer',
  );
  if (!entryState.hasEmailInput) return;

  await focusAndType(page, 'input[type="email"], input[name="email"]', row.email, { label: 'ChatGPT 登录邮箱' });
  await clickExactText(page, 'Continue', { timeoutMilliseconds: 20000, timeoutMessage: '没有找到登录邮箱后的 Continue' });
  const nextStep = await waitForValue(
    () => evaluate(page, `(() => ({
      hasPassword: Boolean(document.querySelector('input[type="password"], input[name="password"]')),
      verification: Boolean(document.querySelector('input[autocomplete="one-time-code"], input[inputmode="numeric"], input[name="code"]')),
    }))()`),
    (state) => state?.hasPassword || state?.verification,
    20000,
    '等待 ChatGPT 密码或邮箱验证码输入框超时',
  );
  if (nextStep.hasPassword) {
    await focusAndType(page, 'input[type="password"], input[name="password"]', row.password, { label: 'ChatGPT 登录密码' });
    await clickExactText(page, 'Continue', { timeoutMilliseconds: 20000, timeoutMessage: '没有找到登录密码后的 Continue' });
    onStatus('已用键盘输入账号密码，等待 ChatGPT 登录结果');
  }
  if (rechargeType === 'google-incognito') await completeEmailVerification(page, row, debugPort, onStatus);
}

async function openChatGptAndPreparePayment(profile, row, product, selection, onStatus, onPlans, onStep, proofContext = {}) {
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
    await fillLoginIfNeeded(page, row, onStatus, proofContext.rechargeType || 'ads', profile.debugPort, proofContext.isActive);

    onStep('等待 ChatGPT 首页完全加载并稳定');
    await sleep(1200);

    onStep('识别首页升级入口');
    // 优先右上角 Upgrade，没有则 Free offer，再没有则 Claim offer；超时说明入口未出现，当前任务失败。
    const entry = await waitForValue(
      () => readHomeUpgradeEntry(page),
      Boolean,
      45000,
      'ChatGPT 首页已打开，但没有找到右上角 Upgrade、Free offer 或 Claim offer',
    );
    onStep(`点击${entry.region === 'top-right' ? '右上角 ' : ''}${entry.text}`);
    await clickAndConfirm(
      page,
      entry.text,
      {
        region: entry.region,
        timeoutMilliseconds: 20000,
        timeoutMessage: `没有找到可点击的 ${entry.text}`,
        stabilityMilliseconds: 1000,
        scrollIntoView: entry.region !== 'top-right',
      },
      () => readPricingModalState(page),
      10000,
      `${entry.text} 已点击，但未确认套餐页（/plans 或 #pricing）及套餐内容加载完成`,
    );
    onStep(`${entry.text} 已点击，套餐弹窗已加载`);

    const cardWaitMilliseconds = selection.amount ? PRO_CARD_WAIT_MILLISECONDS : 5000;
    // 新版可能直接显示三档 Pro 或进入配置页的 Pro 卡片；已识别入口就跳过 See all plans。
    if (!selection.amount || !await readProCard(page, selection.amount)) {
      onStep('向下滚动到套餐页面底部，寻找 See all plans');
      onStep('点击 See all plans');
      await clickAndConfirm(
        page,
        'See all plans',
        {
          alternateTexts: ['See all'],
          timeoutMilliseconds: 20000,
          timeoutMessage: '滚动套餐页面后仍没有找到可见的 See all plans',
          stabilityMilliseconds: 800,
          scrollIntoView: true,
        },
        () => readAllPlansState(page, selection.amount),
        cardWaitMilliseconds,
        `See all plans 已点击，但等待 ${cardWaitMilliseconds / 1000} 秒仍未显示完整 Pro 卡片`,
      );
      onStep('See all plans 已点击，完整套餐列表已加载');
    }

    onStep('等待并识别 Pro，与整行任务共享剩余时间');
    if (product !== 'Pro') throw new Error(`当前流程不支持产品：${product}`);
    let selectionStage;
    if (selection.amount) {
      onStep(`识别 Pro ${selection.label} 的选档位置`);
      selectionStage = await selectProAmount(page, selection.amount);
      if (selectionStage === 'checkout') onStep(`Pro 卡片没有规格按钮，先进入配置页再选择 ${selection.label}`);
    }
    onStep('Pro 已识别，点击同一卡片内的购买按钮');
    const buyAction = await clickProCard(page, onPlans, selection.amount);
    onStep(`${buyAction} 已点击，正在进入购买页面`);

    onStep('等待 ChatGPT Pro 支付页');
    if (selection.amount) {
      const configureAtCheckout = selectionStage === 'checkout';
      if (configureAtCheckout) {
        onStep(`等待 Pro 配置页，选择 ${selection.label} 并核对单选状态`);
        await selectProCheckoutAmount(page, selection.amount);
      }
      // 两条路径都必须核对最终 Due today；配置页选档还要重新核对选中态，不能把默认价当成目标规格。
      await waitForValue(
        async () => ({...await evaluate(page, `(${inspectProCheckout.toString()})(${JSON.stringify(selection.amount)})`),
          selectionConfirmed: !configureAtCheckout || Boolean((await readProCheckoutOptions(page, selection.amount))?.selected)}),
        (state) => state?.checkout && state.pro && state.amountMatches && state.selectionConfirmed,
        CHECKOUT_WAIT_MILLISECONDS,
        `Pro 结账页未就绪或 Due today 不等于 $${selection.amount}.00，已停止支付流程`,
      );
      onStep(`Pro ${selection.label} 已确认，Due today 为 $${selection.amount}.00`);
    } else {
      await waitForCheckout(page);
      onStep(`选择 ${selection.multiplier} 套餐并等待价格更新`);
      await selectMultiplier(page, selection.multiplier);
    }

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
    await clickSubscribeAndAwaitResult(page, profile.debugPort, onStep, proofContext);
    // 仅明确支付成功后才进入附加任务，点击/处理中/拒付都不能当作成功。
    proofContext.onPaymentConfirmed();
    onStep('支付成功，开始处理已勾选的附加选项');
    return await runPostPurchaseActions(page, profile, row, proofContext, onStep, onStatus);
  } finally {
    page.close();
  }
}

// 购买与独立补做共用附加动作；此函数不包含套餐、卡资料或支付提交逻辑。
async function runPostPurchaseActions(page, profile, row, proofContext, onStep, onStatus) {
  return await completePostPurchase(proofContext.additionalOptions,
      () => captureAccountBillingProof(page, { ...proofContext, debugPort: profile.debugPort }, onStep), onStep, {
        exportCpa: onProgress => exportCodexCredential(createCodexDriver({
          manager:page, debugPort:profile.debugPort, isActive:proofContext.isActive, onStep, onVerification:onStatus,
          connectCdp, getTargets, evaluate, mouseClick, clearFocusedField, typeWithKeyboard, dispatchKey, sleep,
        }), row, onProgress),
        downloadInvoice: () => captureAccountInvoice(page, {debugPort:profile.debugPort}, onStep),
        setupTwoFactor: onProgress => configureAccountTwoFactor(page, { ...proofContext, debugPort: profile.debugPort }, onStep, onProgress),
        onProgress: proofContext.onPostPurchaseProgress,
      });
}

const additionalFields = {screenshot:['screenshotUrl','screenshotError','screenshotStatus'], invoice:['invoiceFileName','invoiceError','invoiceStatus'], cpa:['cpaJson','cpaError','cpaStatus'], '2fa':['twoFactorKey','twoFactorError','twoFactorStatus']};

export async function runAdditionalJob({jobId, row, option, options, paymentConfirmed = false, apiBase, apiKey, verificationPassword = '', onEvent = () => {}, registerRowControl = () => {}}) {
  const selectedOptions=resolveAdditionalOptions(options ?? [option]);
  if(!selectedOptions.length)throw new Error('至少选择一个附加功能');
  const label=selectedOptions.join(' + ');
  option=selectedOptions.length===1?selectedOptions[0]:undefined;
  const serialNumber = String(row?.adsPowerSerialNumber || '').trim();
  if (!serialNumber || (selectedOptions.includes('cpa') && !row.email)) throw new Error('附加任务账号资料不完整');
  const index = row.__uiIndex;
  if (!Number.isInteger(index) || index < 0 || index >= 100) throw new Error('任务行号无效');
  const prefix = `第 ${index + 1} 条 / AdsPower ${serialNumber}`;
  let active = true;
  const deadline = Date.now() + ROW_TIMEOUT_MILLISECONDS;
  const controller = new AbortController();
  let page;
  let interruptionError;
  let currentStep = '启动 AdsPower';
  let result = initialPostPurchaseResult(selectedOptions);
  const fields = selectedOptions.flatMap(item=>additionalFields[item]);
  // 只发布本次选中的附加项，避免空默认值覆盖其他已取得的结果。
  const selected = () => Object.fromEntries(fields.map(key => [key, result[key]]));
  const emit = payload => { if (active) onEvent({index, option, additionalOptions:selectedOptions, paymentConfirmed, purchase:false, ...payload}); };
  const stop = () => stopAdsPowerProfile({serialNumber, apiBase, apiKey}).catch(() => {});
  const step = message => { currentStep = message; emit({type:'step_started', message:`${prefix}：${message}`}); };
  const interruption = createRowInterruption({index, deadline, controller, registerRowControl, onInterrupt:error => {
    interruptionError = error;
    if (error.code === 'ROW_STOPPED') emit({type:'row_stop_requested', message:`${prefix}：正在终止本行`});
    active = false;
  }});
  emit({type:'additional_started', ...selected(), message:`${prefix}：执行所选附加功能：${label}`});
  const work = runWithTaskBudget(async () => {
    assertTaskActive();
    const profile = await startAdsPowerProfile({serialNumber, apiBase, apiKey, signal:controller.signal});
    if (!active) { await stop(); throw new Error(ROW_TIMEOUT_MESSAGE); }
    page = await connectChatGptPage(profile.debugPort, {preferHome:true});
    if (!active) { page.close(); throw new Error(ROW_TIMEOUT_MESSAGE); }
    await page.command('Page.enable');
    await page.command('Runtime.enable');
    return runPostPurchaseActions(page, profile, row, {
      jobId, index, verificationPassword, additionalOptions:selectedOptions, isActive:() => active && Date.now() < deadline,
      onPostPurchaseProgress: patch => {
        if (!active) return;
        result = {...result, ...patch};
        emit({type:'additional_progress', ...selected(), message:`${prefix}：${label} 结果已更新`});
      },
    }, step, message => emit({type:'login_verification_required', message:`${prefix}：${message}`}));
  }, () => active, deadline, controller.signal);
  try {
    result = await Promise.race([work, interruption.wait]);
  } catch {
    const reason = interruptionError?.message || '浏览器未就绪或连接中断，请单独重试';
    const pending=selectedOptions.filter(item=>result[`${item==='2fa'?'twoFactor':item}Status`]==='pending');
    result = interruptedPostPurchaseResult(result, reason);
    for(const item of pending)result[`${item==='2fa'?'twoFactor':item}Error`]=`${currentStep}未完成：${reason}`;
  } finally {
    interruption.finish();
    active = false;
    controller.abort();
    page?.close();
    await stop();
  }
  const proof = selected();
  const additionalStatus=interruptionError?.code==='ROW_STOPPED'?'cancelled':fields.some(key=>key.endsWith('Error')&&proof[key])?'failed':'completed';
  onEvent({type:'additional_finished', index, option, additionalOptions:selectedOptions, paymentConfirmed, purchase:false, additionalStatus, ...proof,
    message:`${prefix}：${label} ${additionalStatus==='completed'?'已完成':'有未完成项，请查看附加结果'}${paymentConfirmed?'；付款成功状态保留':''}`});
  return [{index, paymentConfirmed, additionalStatus, ...proof}];
}

export async function runAdditionalBatch({rows, additionalOptions, concurrency=1, shouldStop=()=>false, isPaid=()=>false, ...common}) {
  const options=resolveAdditionalOptions(additionalOptions);
  if(!options.length)throw new Error('至少选择一个附加功能');
  const bounded=Math.max(1,Math.min(10,Math.floor(Number(concurrency)||1)));
  // 每行只启动一次 Profile，所有所选附加功能共用该行 10 分钟；从不进入购买状态机。
  const results=await runWithConcurrency(rows,bounded,async(row,index)=>{
    const clean={adsPowerSerialNumber:row.adsPowerSerialNumber,email:row.email,__uiIndex:row.__uiIndex??index};
    try{return (await runAdditionalJob({...common,row:clean,options,paymentConfirmed:isPaid(clean.adsPowerSerialNumber)}))[0];}
    catch{
      const proof=interruptedPostPurchaseResult(initialPostPurchaseResult(options),'附加任务校验或启动失败');
      const selected=Object.fromEntries(options.flatMap(item=>additionalFields[item]).map(key=>[key,proof[key]]));
      common.onEvent?.({type:'additional_finished',index:clean.__uiIndex,additionalOptions:options,purchase:false,paymentConfirmed:isPaid(clean.adsPowerSerialNumber),additionalStatus:'failed',...selected,message:`第 ${clean.__uiIndex+1} 条 / AdsPower ${clean.adsPowerSerialNumber}：附加任务校验或启动失败`});
      return{index:clean.__uiIndex,additionalStatus:'failed',...selected};
    }
  },shouldStop);
  for(let index=0;index<rows.length;index++)if(!results[index]){
    const uiIndex=rows[index].__uiIndex??index;
    results[index]={index:uiIndex,status:'cancelled'};
    common.onEvent?.({type:'row_cancelled',index:uiIndex,purchase:false,message:`第 ${uiIndex+1} 条 / AdsPower ${rows[index].adsPowerSerialNumber}：排队任务已终止，未开始执行`});
  }
  return results;
}

async function runWithConcurrency(rows, concurrency, worker, shouldStop = () => false) {
  const results = new Array(rows.length);
  let cursor = 0;
  const poolSize = Math.min(rows.length, concurrency);
  const takeNextIndex = () => {
    // 领取下标必须同步完成，不能在 await 之后再加游标，否则会超过设定并发。
    if (shouldStop()) return -1;
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

function validatePaymentRow(row, rechargeType) {
  const requiredFields = rechargeType === 'google-incognito'
    ? ['email', 'password', 'cardNumber', 'expires_at', 'cvv']
    : ['adsPowerSerialNumber', 'email', 'cardNumber', 'expires_at', 'cvv'];
  const missingFields = requiredFields.filter((field) => !String(row[field] || '').trim());
  if (missingFields.length) throw new Error(`当前任务缺少字段：${missingFields.join('、')}`);
  if (rechargeType === 'google-incognito' && !String(row.mailAccess || '').trim()) throw new Error('当前任务缺少 mailAccess');
  if (!/^(US|USA|United States)?$/i.test(String(row.billingCountry || 'US').trim())) {
    throw new Error('当前流程的 billingCountry 只允许 US / United States');
  }
}

export async function runUpgradeJob({
  jobId,
  rows,
  concurrency = 1,
  product = 'Pro',
  multiplier,
  planAmount,
  additionalOptions,
  rechargeType = 'ads',
  apiBase,
  apiKey,
  verificationPassword = '',
  onEvent = () => {},
  shouldStop = () => false,
  registerRowControl = () => {},
}) {
  if (!PRODUCTS.includes(product)) throw new Error(`不支持的 GPT 产品：${product}`);
  const selection = resolveProSelection({ rechargeType, planAmount, multiplier });
  const selectedOptions = resolveAdditionalOptions(additionalOptions, rechargeType);
  if (!['ads', 'google-incognito'].includes(rechargeType)) throw new Error(`不支持的充值类型：${rechargeType}`);

  const boundedConcurrency = Math.max(1, Math.min(10, Number(concurrency) || 1));
  const results = await runWithConcurrency(rows, boundedConcurrency, async (row, index) => {
    const serialNumber = String(row.adsPowerSerialNumber || '').trim();
    const uiIndex = Number.isInteger(row.__uiIndex) ? row.__uiIndex : index;
    const prefix = `第 ${uiIndex + 1} 条 / ${rechargeType === 'google-incognito' ? '谷歌无痕模式' : `AdsPower ${serialNumber}`}`;
    let profile;
    let currentStep = '任务校验';
    let active = true;
    const deadline = Date.now() + ROW_TIMEOUT_MILLISECONDS;
    const controller = new AbortController();
    let interruptionError;
    let paymentSubmitted = false;
    let paymentConfirmed = false;
    let postPurchaseResult = initialPostPurchaseResult(selectedOptions);
    const stopBrowser = () => rechargeType === 'google-incognito'
      ? stopGoogleIncognitoBrowser(profile)
      : stopAdsPowerProfile({ serialNumber, apiBase, apiKey }).catch(() => {});
    const emit = (payload) => {
      if (!active) return;
      onEvent(payload);
    };

    const runRow = async () => {
      // 卡、账号和账单地址始终来自同一任务行，禁止跨行借用。
      validatePaymentRow(row, rechargeType);
      currentStep = rechargeType === 'google-incognito' ? '启动谷歌无痕浏览器' : '启动 AdsPower';
      emit({ type: 'row_started', index: uiIndex, subscriptionType: `${product} / ${selection.label}`, additionalOptions: selectedOptions, message: `${prefix}：${currentStep}` });
      assertTaskActive();
      profile = rechargeType === 'google-incognito'
        ? await startGoogleIncognitoBrowser()
        : await startAdsPowerProfile({ serialNumber, apiBase, apiKey, signal:controller.signal });
      if (!active) { await stopBrowser(); throw new Error(ROW_TIMEOUT_MESSAGE); }
      emit({ type: 'browser_started', index: uiIndex, message: `${prefix}：已打开${rechargeType === 'google-incognito' ? '谷歌无痕浏览器' : 'AdsPower'}，进入 chatgpt.com` });

      const proof = await openChatGptAndPreparePayment(profile, row, product, selection, (message) => {
        emit({ type: 'login_verification_required', index: uiIndex, message: `${prefix}：${message}` });
      }, (plans) => emit({ type: 'plans_discovered', index: uiIndex, plans }), (step) => {
        if (!active) return;
        currentStep = step;
        emit({ type: 'step_started', index: uiIndex, message: `${prefix}：${step}` });
      }, { jobId, index: uiIndex, rechargeType, verificationPassword, additionalOptions: selectedOptions,
        isActive: () => active && Date.now() < deadline,
        onPaymentSubmitted: () => { if (active) paymentSubmitted = true; },
        onPaymentConfirmed: () => {
          if (!active) return;
          paymentConfirmed = true;
          emit({type:'row_payment_confirmed', index:uiIndex, serialNumber, subscriptionType:`${product} / ${selection.label}`,
            message:`${prefix}：已确认支付成功`});
        },
        onPostPurchaseProgress: progress => {
          if (!active) return;
          postPurchaseResult = { ...postPurchaseResult, ...progress };
          emit({ type: 'post_purchase_progress', index: uiIndex, ...postPurchaseResult, message: `${prefix}：附加任务结果已更新${progress.cpaError ? `；${progress.cpaError}` : ''}` });
        },
      });
      if (!active) throw new Error(ROW_TIMEOUT_MESSAGE);
      return proof || {};
    };

    const interruption = createRowInterruption({index:uiIndex, deadline, controller, registerRowControl, onInterrupt:error => {
      interruptionError = error;
      if (error.code === 'ROW_STOPPED') emit({type:'row_stop_requested', index:uiIndex, message:`${prefix}：正在终止本行`});
      active = false;
    }});
    const work = runWithTaskBudget(runRow, () => active, deadline, controller.signal);
    work.catch(() => {});
    try {
      const proof = await Promise.race([work, interruption.wait]);
      interruption.finish();
      if (!active) throw new Error(ROW_TIMEOUT_MESSAGE);
      if (!paymentConfirmed) throw new Error('尚未确认支付成功');
      active = false;
      controller.abort();
      await stopBrowser();
      // 支付与附加结果分别保存；附加项失败也不能重跑已付款任务。
      onEvent({
        type: 'row_succeeded',
        index: uiIndex,
        ...proof,
        message: `${prefix}：${product} / ${selection.label} 支付成功；${proof.screenshotError || proof.invoiceError || proof.cpaError || proof.twoFactorError ? '附加任务有未完成项，请查看任务结果' : '已完成所选附加任务'}`,
      });
      return { index: uiIndex, serialNumber, status: 'succeeded', ...proof };
    } catch (error) {
      interruption.finish();
      const stopped = interruptionError?.code === 'ROW_STOPPED';
      const cause = interruptionError?.message || error.message;
      active = false;
      controller.abort();
      await stopBrowser();
      if (paymentConfirmed) {
        // 已付款时只结束附加项，截图、CPA 和已读取的 Key 原样保留，禁止进入充值重试。
        const proof = interruptedPostPurchaseResult(postPurchaseResult, stopped ? ROW_STOP_MESSAGE : undefined);
        onEvent({ type: 'row_succeeded', index: uiIndex, ...proof,
          message: `${prefix}：${product} / ${selection.label} 支付成功；${stopped ? '用户终止剩余附加任务' : '附加任务中断'}，请查看任务结果`,
        });
        return { index: uiIndex, serialNumber, status: 'succeeded', ...proof };
      }
      const paymentReviewRequired = stopped && paymentSubmitted;
      const reason = `${currentStep}${stopped ? '已终止' : '失败'}：${cause}${paymentReviewRequired ? '；付款已提交但结果未确认，请先核对账单，禁止直接重复充值' : ''}`;
      // 排队取消和主动终止都不计入批量失败重试；支付已提交时单独保留待核实记录。
      onEvent({ type: stopped ? 'row_cancelled' : 'row_failed', index: uiIndex, serialNumber,
        paymentReviewRequired, subscriptionType:`${product} / ${selection.label}`,
        message: `${prefix}：${reason}；已结束本行并请求关闭浏览器` });
      return { index: uiIndex, serialNumber, status: paymentReviewRequired ? 'payment_review' : stopped ? 'cancelled' : 'failed', error: reason };
    } finally {
      interruption.finish();
      active = false;
      controller.abort();
    }
  }, shouldStop);

  // 终止后只取消尚未领取的排队任务；已在跑的条目会正常写进 results。
  for (let index = 0; index < rows.length; index += 1) {
    if (results[index]) continue;
    const row = rows[index];
    const serialNumber = String(row.adsPowerSerialNumber || '').trim();
    const uiIndex = Number.isInteger(row.__uiIndex) ? row.__uiIndex : index;
    const prefix = `第 ${uiIndex + 1} 条 / ${rechargeType === 'google-incognito' ? '谷歌无痕模式' : `AdsPower ${serialNumber}`}`;
    results[index] = { index: uiIndex, serialNumber, status: 'cancelled' };
    onEvent({ type: 'row_cancelled', index: uiIndex, message: `${prefix}：排队任务已终止，未开始执行` });
  }
  return results;
}
