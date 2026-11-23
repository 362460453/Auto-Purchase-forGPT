import { generateTotp, normalizeTotpSecret } from './totp.mjs';

// 在 ChatGPT 页面读取语义控件；普通状态不带文本、URL、密钥或验证码，避免超时错误泄露凭据。
export function inspectAuthenticator(action = 'state') {
  if (!['https://chatgpt.com', 'https://auth.openai.com'].includes(location.origin)) return { stage: 'unavailable' };
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
  // 仅官方二次验证页可使用用户设置的现有密码；秘密和完整 URL 都不返回到普通状态。
  if (location.origin === 'https://auth.openai.com') {
    if (action === 'secret') return '';
    const emailPage = location.pathname === '/email-verification';
    const passwordPage = location.pathname === '/log-in/password';
    if (!emailPage && !passwordPage) return { stage: 'unavailable' };
    const inputs = passwordPage ? controls(document, 'input[type="password"]').filter(node => !node.disabled && !node.readOnly) : [];
    const input = inputs.length === 1 ? inputs[0] : null;
    const node = action === 'password-method' && emailPage ? exact(document, 'Continue with password')
      : action === 'password-input' ? input : action === 'password-continue' && passwordPage ? exact(document, 'Continue') : null;
    return { stage: emailPage ? 'verification_required' : 'password_required', point: point(node),
      viewport: {width:innerWidth, height:innerHeight},
      invalid: Boolean(input?.getAttribute('aria-invalid') === 'true') || controls(document, '[role="alert"]').some(node => /incorrect|invalid|wrong password/i.test(label(node))) };
  }
  const backupPrompt = controls(document, 'h1,h2').some(node => label(node) === 'Authenticator app added');
  if (backupPrompt) {
    return action === 'secret' ? '' : {stage:'backup_prompt',
      point:point(action === 'skip-backup' ? exact(document, 'Not now') : null),
      viewport:{width:innerWidth, height:innerHeight}};
  }
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
    && (node.autocomplete === 'one-time-code' || node.inputMode === 'numeric' || node.maxLength === 6 || node.placeholder === '000000'
      || /^6-digit code$/i.test(normalize(node.getAttribute('aria-label') || [...(node.labels || [])].map(label).join(' '))))) : [];
  const input = inputs.length === 1 ? inputs[0] : null;
  const keyTab = dialog ? exact(dialog, 'Key') : null;
  const manualKey = dialog ? exact(dialog, 'Can’t scan? Enter the code manually') : null;
  const showingKey = dialog ? exact(dialog, 'Show QR code') : null;
  // 新版在同一弹窗展示 Key 和验证码，不能再等待旧版 Continue / Key 标签。
  const inlineSetup = Boolean(input && (manualKey || showingKey) && exact(dialog, 'Verify'));
  const keySelected = inlineSetup ? Boolean(showingKey) : keyTab && (keyTab.getAttribute('aria-selected') === 'true'
    || keyTab.getAttribute('aria-pressed') === 'true' || keyTab.getAttribute('data-state') === 'active'
    || keyTab.getAttribute('data-state') === 'on');
  const stage = dialog ? inlineSetup ? 'setup' : input ? 'verify' : keyTab ? 'setup' : 'intro'
    : toggle && enabled !== null ? enabled ? 'enabled' : 'disabled' : 'unavailable';
  if (action === 'secret') {
    if (!dialog || !keySelected) return '';
    // 仅从已选中的 Key 面板读取。多个候选值时停止，不能从整页猜密钥或使用其他账号资料。
    const panels = controls(dialog, '[role="tabpanel"]');
    const root = panels.length === 1 ? panels[0] : dialog;
    const values = controls(root, 'code,pre,input[readonly],p,span,div')
      // 实机 Key 为大写 Base32；不要把普通英文说明强行转大写后误识别成第二个密钥。
      .flatMap(node => {
        const text = String(node.value || node.textContent || '');
        return [text.replace(/\s/g, ''), ...(text.match(/\b[A-Z2-7]{16,128}={0,6}\b/g) || [])];
      })
      .filter(value => /^[A-Z2-7]{16,128}={0,6}$/.test(value));
    const unique = [...new Set(values)];
    return unique.length === 1 ? unique[0] : '';
  }
  let node;
  if (action === 'toggle') node = stage === 'disabled' ? toggle : null;
  if (action === 'key') node = inlineSetup ? manualKey : keyTab;
  if (action === 'continue') node = dialog ? exact(dialog, inlineSetup ? 'Verify' : 'Continue') : null;
  if (action === 'input') node = input;
  const errors = dialog ? controls(dialog, '[role="alert"],[aria-invalid="true"]') : [];
  return { stage, inlineSetup, keySelected: Boolean(keySelected), point: point(node),
    viewport: { width: innerWidth, height: innerHeight },
    inputLength: input ? String(input.value || '').length : 0,
    invalid: errors.some(node => node.getAttribute('aria-invalid') === 'true' || /invalid|incorrect|expired/i.test(label(node))) };
}

export async function configureAuthenticator(driver, onProgress = () => {}, {verificationPassword = ''} = {}) {
  class SetupError extends Error {}
  let secret = '';
  let stage = '打开 Authenticator app';
  let verificationPending = false;
  let verificationSeen = false;
  let passwordAttempted = false;
  const verificationStages = ['verification_required', 'password_required'];
  const codePage = value => value.stage === 'verify' || (value.stage === 'setup' && value.inlineSetup);
  const assertActive = () => { if (!driver.isActive()) throw new Error('任务已结束'); };
  const wait = async (read, accept, message) => {
    // 所有设置状态共享整行剩余时间；Key 读取后立即保留，不能因独立的 10 秒阶段时限提前结束。
    do {
      assertActive();
      const value = await read();
      if (verificationStages.includes(value?.stage)) {
        verificationSeen = true;
        if (verificationPassword && !passwordAttempted) {
          // 每次任务只提交一次现有密码；错误不反复尝试，验证码和风控仍由用户处理。
          passwordAttempted = true;
          verificationPending = true;
          step('使用设置中的密码完成身份验证');
          if (value.stage === 'verification_required') {
            await click('password-method');
            await wait(() => driver.read(), state => state.stage === 'password_required', '密码验证页未出现');
          }
          await click('password-input');
          assertActive();
          await driver.typePassword(verificationPassword);
          await click('password-continue');
          continue;
        }
        if (passwordAttempted && value.invalid) throw new SetupError('密码验证被拒绝，请检查设置中的密码');
        if (!verificationPending) driver.onStep('2FA：请在当前 AdsPower 窗口完成人工身份验证，完成后自动继续');
        verificationPending = true;
      } else if (verificationPending && ['disabled', 'enabled', 'intro', 'setup', 'verify'].includes(value?.stage)) {
        verificationPending = false;
        driver.onStep(`2FA：邮箱验证已返回，继续${stage}`);
      }
      if (accept(value)) return value;
      await driver.sleep(250);
    } while (driver.isActive());
    throw new SetupError(verificationPending ? '等待人工邮箱验证超过任务剩余时间' : message);
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
    let state = await wait(() => driver.read(), value => ['enabled', 'disabled', 'intro', 'setup'].includes(value.stage), '未找到 Authenticator app 开关');
    if (state.stage === 'enabled') {
      return { twoFactorKey: '', twoFactorStatus: 'already_enabled', twoFactorError: '账号已开启 2FA，无法读取原 Key；未重置' };
    }
    if (state.stage === 'disabled') {
      step('打开 Authenticator app');
      await click('toggle');
      state = await wait(() => driver.read(), value => ['intro', 'setup', 'enabled'].includes(value.stage)
        || (verificationSeen && value.stage === 'disabled'), '设置介绍未打开');
    }
    // 二次验证返回后可能只显示关闭的开关；仅重新打开当前控件一次，不重跑任务、不重置计时。
    if (state.stage === 'disabled') {
      await click('toggle');
      state = await wait(() => driver.read(), value => ['intro', 'setup', 'enabled'].includes(value.stage), '邮箱验证后设置介绍未打开');
    }
    if (state.stage === 'enabled') {
      return { twoFactorKey: '', twoFactorStatus: 'already_enabled', twoFactorError: '账号已开启 2FA，无法读取原 Key；未重置' };
    }
    if (state.stage === 'intro') {
      step('点击 Continue，等待 Key 标签');
      await click('continue');
      state = await wait(() => driver.read(), value => value.stage === 'setup', 'Key 标签未出现');
    }
    if (!state.keySelected) await click('key');
    await wait(() => driver.read(), value => value.keySelected, 'Key 标签未选中');
    step('读取 Key 并保留到当前任务');
    secret = normalizeTotpSecret(await wait(() => driver.read('secret'), Boolean, 'Key 面板没有唯一有效密钥'));
    assertActive();
    onProgress({ twoFactorKey: secret, twoFactorStatus: 'pending', twoFactorError: '' });
    if (!state.inlineSetup) await click('continue');
    await wait(() => driver.read(), codePage, '六位验证码输入框未出现');
    step('本机生成并输入六位验证码');
    // 留出至少 8 秒填写及提交，避免在 30 秒周期末尾使用即将过期的验证码。
    await wait(async () => 30000 - driver.now() % 30000, remaining => remaining >= 8000, '等待新的验证码周期超时');
    await click('input');
    assertActive();
    await driver.type(generateTotp(secret, driver.now()));
    state = await driver.read();
    if (!codePage(state) || state.inputLength !== 6) throw new SetupError('验证码输入未完成');
    step('提交验证并确认 Authenticator app 已开启');
    await click('continue');
    let backupSkipped = false;
    await wait(async () => {
      const value = await driver.read();
      if (value.invalid) throw new SetupError('验证码被拒绝，请核对本机时间和账号设置');
      // 新版启用后推荐短信备份；只跳过可选推荐，不添加手机号，回安全页核对开关才算成功。
      if (value.stage === 'backup_prompt' && !backupSkipped) {
        await click('skip-backup');
        backupSkipped = true;
      }
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
