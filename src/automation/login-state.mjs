export const LOGIN_SELECTORS = {
  email: 'input[type="email"], input[name="email"]',
  password: 'input[type="password"], input[name="password"]',
  code: 'input[autocomplete="one-time-code"], input[name="code"], input[inputmode="numeric"]',
};

// 只读取可见 UI；不返回邮箱、输入值或带认证参数的 URL，避免超时诊断泄露凭据。
export function inspectLoginPage(selectors) {
  const visible = (node) => {
    if (!node) return false;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const editable = (selector) => [...document.querySelectorAll(selector)]
    .some((node) => visible(node) && !node.disabled && !node.readOnly);
  const normalize = (text) => String(text || '').replace(/\s+/g, ' ').trim();
  const body = normalize(document.body?.innerText);
  const buttons = [...document.querySelectorAll('button,a,[role="button"]')].filter(visible);
  const label = (node) => normalize(node.innerText || node.textContent || node.getAttribute('aria-label'));
  const loginButton = buttons.find((node) => !node.disabled && /^(Log in|Login|登录)$/i.test(label(node)));
  const profileMenu = buttons.some((node) => /^(Open profile menu|打开个人资料菜单)$/i.test(node.getAttribute('aria-label') || ''));
  const upgradeEntry = buttons.some((node) => {
    const text = label(node);
    const rect = node.getBoundingClientRect();
    return /^(Claim offer|获取优惠)$/.test(text)
      || (/^(Upgrade|Free offer|免费优惠)$/.test(text) && rect.left > innerWidth * 0.55 && rect.top < Math.min(220, innerHeight * 0.35));
  });
  let error = '';
  if (/account_deactivated|account (?:has been|was) (?:deleted|deactivated)|账户已被删除或停用|账号已被删除或停用/i.test(body)) error = 'account_deactivated';
  else if (/wrong email or password|incorrect email (?:address )?or password|电子邮箱地址或密码不正确/i.test(body)) error = 'invalid_credentials';
  else if (/invalid (?:verification )?code|incorrect code|code (?:has )?expired|验证码.{0,8}(?:不正确|无效|过期)/i.test(body)) error = 'invalid_code';
  const hasCodeInput = editable(selectors.code);
  const emailVerification = location.hostname === 'auth.openai.com'
    && /email-verification/.test(location.pathname) && hasCodeInput;
  const manualVerification = /authenticator|security key|passkey|验证器|安全密钥|通行密钥|verify (?:that )?you are human|确认你是人类|验证您是人类/i.test(body)
    || (hasCodeInput && !emailVerification)
    || /phone-verification|\/mfa(?:\/|$)/.test(location.pathname);
  return {
    origin: location.origin,
    path: location.pathname,
    ready: document.readyState !== 'loading',
    error,
    emailVerification,
    manualVerification,
    hasEmailInput: editable(selectors.email),
    hasPasswordInput: editable(selectors.password),
    loginLabel: loginButton ? label(loginButton) : '',
    home: location.origin === 'https://chatgpt.com' && location.pathname === '/'
      && !loginButton && (profileMenu || upgradeEntry),
  };
}

export function loginStateKind(state) {
  if (state?.error) return 'error';
  if (!state?.ready) return 'loading';
  if (state.manualVerification) return 'manual';
  if (state.emailVerification) return 'code';
  if (state.hasPasswordInput) return 'password';
  if (state.hasEmailInput) return 'email';
  if (state.home) return 'home';
  if (state.loginLabel) return 'entry';
  return 'loading';
}

export function assertLoginState(state) {
  const messages = {
    account_deactivated: 'OpenAI 返回 account_deactivated：账号已删除或停用，无法继续登录或订阅',
    invalid_credentials: 'OpenAI 提示电子邮箱地址或密码不正确',
    invalid_code: 'OpenAI 提示邮箱验证码不正确或已过期',
  };
  if (state?.error) throw new Error(messages[state.error] || 'OpenAI 登录失败');
  return state;
}
