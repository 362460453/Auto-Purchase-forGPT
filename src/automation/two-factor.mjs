import { generateTotp, normalizeTotpSecret } from './totp.mjs';

// 在 ChatGPT 页面读取语义控件；普通状态不带文本、URL、密钥或验证码，避免超时错误泄露凭据。
export function inspectAuthenticator(action = 'state') {
  if (location.origin !== 'https://chatgpt.com') return { stage: 'unavailable' };
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const visible = (node) => {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== 'hidden';
  };
  const label = (node) => normalize(node.innerText || node.textContent || node.getAttribute('aria-label'));
  const controls = (root, selector) => [...root.querySelectorAll(selector)].filter(visible);
  const point = (node) => {
    if (!node || node.disabled || node.getAttribute('aria-disabled') === 'true') return null;
    const rect = node.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  };
  const buttons = 'button,a,[role="button"],[role="tab"]';
  const exact = (root, text) => {
    const matches = controls(root, buttons).filter(node => label(node) === text);
    return matches.length === 1 ? matches[0] : null;
  };
  const dialogs = controls(document, '[role="dialog"],dialog')
    .filter(node => /authenticator app/i.test(label(node)));
  const dialog = dialogs.find(node => !dialogs.some(other => other !== node && node.contains(other)));
  const switches = controls(document, '[role="switch"],input[type="checkbox"]');
  const matchingSwitches = switches.filter(node => {
    if (/^Authenticator app$/i.test(node.getAttribute('aria-label') || '')) return true;
    const labelled = (node.getAttribute('aria-labelledby') || '').split(/\s+/)
      .map(id => document.getElementById(id)?.textContent || '').join(' ');
    if (/^Authenticator app$/i.test(normalize(labelled))) return true;
    let parent = node.parentElement;
    for (let depth = 0; parent && depth < 4; depth++, parent = parent.parentElement) {
      if (parent.querySelectorAll('[role="switch"],input[type="checkbox"]').length !== 1) break;
      if (controls(parent, 'span,p,div,label').some(item => label(item) === 'Authenticator app')) return true;
    }
    return false;
  });
  const toggle = matchingSwitches.length === 1 ? matchingSwitches[0] : null;
  const checked = toggle?.getAttribute('aria-checked');
  // 未知开关状态不能当作关闭，否则可能误关账号原有的 2FA。
  const enabled = checked === 'true' ? true : checked === 'false' ? false
    : typeof toggle?.checked === 'boolean' ? toggle.checked : null;
  const inputs = dialog ? controls(dialog, 'input').filter(node => !node.readOnly && !node.disabled
    && (node.autocomplete === 'one-time-code' || node.inputMode === 'numeric' || node.maxLength === 6 || node.placeholder === '000000')) : [];
  const input = inputs.length === 1 ? inputs[0] : null;
  const keyTab = dialog ? exact(dialog, 'Key') : null;
  const keySelected = keyTab && (keyTab.getAttribute('aria-selected') === 'true'
    || keyTab.getAttribute('aria-pressed') === 'true' || keyTab.getAttribute('data-state') === 'active'
    || keyTab.getAttribute('data-state') === 'on');
  const stage = dialog ? input ? 'verify' : keyTab ? 'setup' : 'intro'
    : toggle && enabled !== null ? enabled ? 'enabled' : 'disabled' : 'unavailable';
  if (action === 'secret') {
    if (!dialog || !keySelected) return '';
    // 仅从已选中的 Key 面板读取。多个候选值时停止，不能从整页猜密钥或使用其他账号资料。
    const panels = controls(dialog, '[role="tabpanel"]');
    const root = panels.length === 1 ? panels[0] : dialog;
    const values = controls(root, 'code,pre,input[readonly],p,span,div')
      .filter(node => node.tagName === 'INPUT' || node.children.length === 0)
      // 实机 Key 为大写 Base32；不要把普通英文说明强行转大写后误识别成第二个密钥。
      .map(node => String(node.value || node.textContent || '').replace(/\s/g, ''))
      .filter(value => /^[A-Z2-7]{16,128}={0,6}$/.test(value));
    const unique = [...new Set(values)];
    return unique.length === 1 ? unique[0] : '';
  }
  let node;
  if (action === 'toggle') node = stage === 'disabled' ? toggle : null;
  if (action === 'key') node = keyTab;
  if (action === 'continue') node = dialog ? exact(dialog, 'Continue') : null;
  if (action === 'input') node = input;
  const errors = dialog ? controls(dialog, '[role="alert"],[aria-invalid="true"]') : [];
  return { stage, keySelected: Boolean(keySelected), point: point(node),
    viewport: { width: innerWidth, height: innerHeight },
    inputLength: input ? String(input.value || '').length : 0,
    invalid: errors.some(node => node.getAttribute('aria-invalid') === 'true' || /invalid|incorrect|expired/i.test(label(node))) };
}

export async function configureAuthenticator(driver, onProgress = () => {}) {
  class SetupError extends Error {}
  let secret = '';
  let stage = '打开 Authenticator app';
  const assertActive = () => { if (!driver.isActive()) throw new Error('任务已结束'); };
  const wait = async (read, accept, message) => {
    // 所有设置状态共享整行剩余时间；Key 读取后立即保留，不能因独立的 10 秒阶段时限提前结束。
    do {
      assertActive();
      const value = await read();
      if (accept(value)) return value;
      await driver.sleep(250);
    } while (driver.isActive());
    throw new SetupError(message);
  };
  const click = async (action) => {
    await wait(async () => {
      const before = await driver.read(action);
      if (!before.point) return false;
      const { x, y } = before.point;
      if (x < 0 || y < 0 || x > before.viewport.width || y > before.viewport.height) {
        assertActive();
        await driver.scroll(before);
        return false;
      }
      await driver.sleep(250);
      const after = await driver.read(action);
      if (!after.point || Math.abs(after.point.x - x) > 2 || Math.abs(after.point.y - y) > 2) return false;
      assertActive();
      await driver.click(after.point);
      return true;
    }, Boolean, '控件未出现或位置不稳定');
  };
  const step = (message) => { stage = message; driver.onStep(`2FA：${message}`); };
  try {
    let state = await wait(() => driver.read(), value => ['enabled', 'disabled'].includes(value.stage), '未找到 Authenticator app 开关');
    if (state.stage === 'enabled') {
      return { twoFactorKey: '', twoFactorStatus: 'already_enabled', twoFactorError: '账号已开启 2FA，无法读取原 Key；未重置' };
    }
    step('打开 Authenticator app');
    await click('toggle');
    await wait(() => driver.read(), value => value.stage === 'intro', '设置介绍未打开');
    step('点击 Continue，等待 Key 标签');
    await click('continue');
    state = await wait(() => driver.read(), value => value.stage === 'setup', 'Key 标签未出现');
    if (!state.keySelected) await click('key');
    await wait(() => driver.read(), value => value.keySelected, 'Key 标签未选中');
    step('读取 Key 并保留到当前任务');
    secret = normalizeTotpSecret(await wait(() => driver.read('secret'), Boolean, 'Key 面板没有唯一有效密钥'));
    assertActive();
    onProgress({ twoFactorKey: secret, twoFactorStatus: 'pending', twoFactorError: '' });
    await click('continue');
    await wait(() => driver.read(), value => value.stage === 'verify', '六位验证码输入框未出现');
    step('本机生成并输入六位验证码');
    // 留出至少 8 秒填写及提交，避免在 30 秒周期末尾使用即将过期的验证码。
    await wait(async () => 30000 - driver.now() % 30000, remaining => remaining >= 8000, '等待新的验证码周期超时');
    await click('input');
    assertActive();
    await driver.type(generateTotp(secret, driver.now()));
    state = await driver.read();
    if (state.stage !== 'verify' || state.inputLength !== 6) throw new SetupError('验证码输入未完成');
    step('提交验证并确认 Authenticator app 已开启');
    await click('continue');
    await wait(async () => {
      const value = await driver.read();
      if (value.invalid) throw new SetupError('验证码被拒绝，请核对本机时间和账号设置');
      return value;
    }, value => value.stage === 'enabled', '页面未确认 Authenticator app 已开启');
    assertActive();
    const result = { twoFactorKey: secret, twoFactorStatus: 'completed', twoFactorError: '' };
    onProgress(result);
    return result;
  } catch (error) {
    // 不拼接 DOM、CDP 或库的原始异常，任何阶段都不能把 Key/验证码写进日志。
    return { twoFactorKey: secret, twoFactorStatus: 'failed',
      twoFactorError: `${stage}未完成：${error instanceof SetupError ? error.message : '请在当前账号安全设置中核对'}` };
  }
}
