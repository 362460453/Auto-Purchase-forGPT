import { createHash, randomBytes } from 'node:crypto';

// 参数与用户提供的 Codex OAuth 扩展一致；不读取网页 Cookie、session token 或已有扩展存储。
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_CALLBACK = 'http://localhost:1455/auth/callback';
export const CODEX_TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token';
export class CodexAuthorizationError extends Error {}

export function createCodexFlow() {
  const state = randomBytes(24).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  const url = new URL('https://auth.openai.com/oauth/authorize');
  url.search = new URLSearchParams({
    client_id: CODEX_CLIENT_ID, code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256', codex_cli_simplified_flow: 'true', id_token_add_organizations: 'true',
    prompt: 'login', redirect_uri: CODEX_CALLBACK, response_type: 'code',
    scope: 'openid email profile offline_access', state,
  }).toString();
  return { state, verifier, authorizeUrl: url.href, claimed: false };
}

export function claimCodexCallback(flow, url, targetId) {
  // 只接受本条新建标签的精确回调；端口、路径、state 均须匹配，授权码只领取/兑换一次。
  if (!flow.targetId || flow.targetId !== targetId || flow.claimed) return null;
  let callback;
  try { callback = new URL(url); } catch { return null; }
  if (callback.origin !== 'http://localhost:1455' || callback.pathname !== '/auth/callback'
    || callback.username || callback.password || callback.hash) return null;
  flow.claimed = true;
  if (callback.searchParams.getAll('state').length !== 1 || callback.searchParams.get('state') !== flow.state) {
    throw new CodexAuthorizationError('CPA 授权回调 state 不匹配，已停止兑换');
  }
  if (callback.searchParams.has('error')) throw new CodexAuthorizationError('Codex 授权被拒绝或取消');
  const codes = callback.searchParams.getAll('code');
  if (codes.length !== 1 || !codes[0]) throw new CodexAuthorizationError('CPA 授权回调没有唯一授权码');
  return codes[0];
}

export function codexExchangeBody(flow, code) {
  return new URLSearchParams({grant_type:'authorization_code', client_id:CODEX_CLIENT_ID,
    code, code_verifier:flow.verifier, redirect_uri:CODEX_CALLBACK}).toString();
}

export function buildCodexJson(data, expectedEmail, now = Date.now()) {
  if (!data || !['access_token', 'refresh_token', 'id_token'].every(key => typeof data[key] === 'string' && data[key])) {
    throw new CodexAuthorizationError('CPA token 兑换结果缺少完整凭据');
  }
  let claims;
  // claims 来自官方 HTTPS token 兑换响应，只用于导出字段与任务归属核对，不接受外部上传的 JWT。
  try { claims = JSON.parse(Buffer.from(data.id_token.split('.')[1], 'base64url').toString('utf8')); }
  catch { throw new CodexAuthorizationError('CPA id_token 无法解析'); }
  const auth = claims?.['https://api.openai.com/auth'] || {};
  const email = typeof claims?.email === 'string' ? claims.email.trim() : '';
  if (!email || !expectedEmail || email.toLowerCase() !== String(expectedEmail).trim().toLowerCase()) {
    throw new CodexAuthorizationError('CPA 授权账号与当前任务邮箱不一致，未保存凭据');
  }
  const accountId = claims.chatgpt_account_id || claims.account_id || auth.chatgpt_account_id;
  if (typeof accountId !== 'string' || !accountId) throw new CodexAuthorizationError('CPA 凭据缺少 account_id');
  const expiresAt = Number(data.expires_in) > 0 ? now + Number(data.expires_in) * 1000 : Number(claims.exp) * 1000;
  if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > 8640000000000000) {
    throw new CodexAuthorizationError('CPA 凭据过期时间无效');
  }
  const timestamp = new Date(now).toISOString();
  // 保留扩展成功回调的字段和紧凑单行 JSON，CSV 再按 RFC 4180 对引号转义。
  return JSON.stringify({
    access_token:data.access_token, account_id:accountId, disabled:false, email,
    expired:new Date(expiresAt).toISOString(), id_token:data.id_token, last_refresh:timestamp,
    plan_type:claims.chatgpt_plan_type || auth.chatgpt_plan_type || '', priority:0,
    refresh_token:data.refresh_token, type:'codex', provider:'openai', state_matches:true, received_at:timestamp,
  });
}

export function inspectCodexAuthorization(expectedEmail, action = 'state') {
  const origin = location.origin;
  if (origin !== 'https://auth.openai.com') return {stage:'loading'};
  const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
  const visible = node => {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== 'hidden';
  };
  const label = node => normalize(node.getAttribute('aria-label') || node.innerText || node.textContent);
  const body = normalize(document.body?.innerText);
  // 实机出现 /add-phone + Phone number required 时立即终止 CPA，不点击 Continue 或发送短信。
  if (/^\/(add-phone|phone-verification)(?:\/|$)/.test(location.pathname) || /phone number required|add your phone number|verify your phone|添加手机号|需要.*手机号码/i.test(body)
    || [...document.querySelectorAll('input[type="tel"]')].some(node => visible(node)
      && node.autocomplete !== 'one-time-code' && node.name !== 'code')) return {stage:'phone_required'};
  const inputs = [...document.querySelectorAll('input')].filter(node => visible(node) && !node.disabled && !node.readOnly && node.type !== 'hidden');
  if (inputs.some(node => node.autocomplete === 'one-time-code' || node.name === 'code')
    || /verification code|authenticator app|verify you are human|captcha|验证码|验证您的身份/i.test(body)) return {stage:'verification'};
  const controls = [...document.querySelectorAll('button,a,[role="button"]')].filter(node => visible(node) && !node.disabled && node.getAttribute('aria-disabled') !== 'true');
  const exact = text => {
    const matches = controls.filter(node => label(node) === text);
    return matches.length === 1 ? matches[0] : null;
  };
  const email = String(expectedEmail || '').trim().toLowerCase();
  const emailMatches = text => (String(text).toLowerCase().match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/g) || []).includes(email);
  const emailInput = inputs.find(node => node.type === 'email' || node.name === 'email');
  const passwordInput = inputs.find(node => node.type === 'password');
  let stage = 'loading';
  let node = null;
  const isAccountButton = item => !/^Remove account\b/i.test(label(item))
    && (/^Select account\b/i.test(label(item)) || item.tagName === 'BUTTON' || item.getAttribute('role') === 'button');
  const accountEmailMatches = item => emailMatches([label(item), item.innerText, item.textContent].join(' '));
  if (location.pathname === '/choose-an-account' && /choose an account to continue to Codex/i.test(body)) {
    // 新版账号按钮的可访问名称可能由子节点组合，不能只要求 aria-label 以 Select account 开头。
    const accounts = controls.filter(item => isAccountButton(item) && accountEmailMatches(item));
    if (accounts.length === 1) { stage = 'account'; node = accounts[0]; }
    else { stage = 'another_account'; node = exact('Use another account'); }
  } else if (emailInput) { stage = 'email'; node = emailInput; }
  else if (passwordInput) { stage = 'password'; node = passwordInput; }
  else if (/\bCodex\b/i.test(body) && /sign in|continue|access/i.test(body) && exact('Continue')) {
    stage = emailMatches(body) ? 'consent' : 'identity_required';
    node = stage === 'consent' ? exact('Continue') : null;
  }
  if (action === 'continue' && ['email', 'password'].includes(stage)) node = exact('Continue');
  const rect = node?.getBoundingClientRect();
  return { stage, point:rect ? {x:rect.left + rect.width / 2, y:rect.top + rect.height / 2} : null,
    viewport:{width:innerWidth, height:innerHeight},
    accountCount: location.pathname === '/choose-an-account' ? controls.filter(isAccountButton).length : undefined,
    accountMatched: location.pathname === '/choose-an-account' ? controls.some(item => isAccountButton(item) && accountEmailMatches(item)) : undefined,
    inputLength: ['email', 'password'].includes(stage) && action !== 'continue' ? String(node?.value || '').length : 0 };
}

export async function exportCodexCredential(driver, row, onProgress = () => {}) {
  const flow = createCodexFlow();
  let code;
  let callbackError;
  let phase = '打开 Codex 授权';
  let finished = false;
  const active = () => driver.isActive() && !finished;
  const check = () => { if (!active()) throw new CodexAuthorizationError('CPA 任务已结束'); };
  const step = message => { phase = message; driver.onStep(`CPA：${message}`); };
  const receive = (url, targetId) => {
    if (!active()) return;
    try { const claimed = claimCodexCallback(flow, url, targetId); if (claimed) code = claimed; }
    catch (error) { callbackError = error; }
  };
  const click = async (state, action) => {
    if (!state.point) return false;
    const {x, y} = state.point;
    if (x < 0 || y < 0 || x > state.viewport.width || y > state.viewport.height) return false;
    await driver.sleep(300);
    const latest = await driver.read(row.email, action);
    if (latest.stage !== state.stage || !latest.point || Math.abs(latest.point.x - x) > 2 || Math.abs(latest.point.y - y) > 2) return false;
    check();
    await driver.click(latest.point);
    return true;
  };
  try {
    step(phase);
    await driver.open(flow, receive);
    check();
    // 页面加载、人工登录和授权回调共用整行剩余时间；进入 CPA 后不重新建立阶段截止时间。
    const submitted = new Set();
    const attempts = new Map();
    let pending;
    let lastStage;
    let verificationNotified = false;
    while (!code && active()) {
      check();
      if (callbackError) throw callbackError;
      const state = await driver.read(row.email);
      if (state.stage !== lastStage) {
        const stageNames = {loading:'页面加载中', account:'已匹配当前任务账号', another_account:'账号选择页需使用其他账号', email:'邮箱输入页', password:'密码输入页', consent:'授权确认页', verification:'人工验证页', identity_required:'需核对账号', phone_required:'手机号要求页'};
        driver.onStep(`CPA：${stageNames[state.stage] || '等待下一状态'}${state.accountCount === undefined ? '' : `（账号按钮 ${state.accountCount} 个，匹配 ${state.accountMatched ? '是' : '否'}）`}`);
        lastStage = state.stage;
      }
      if (pending && state.stage !== pending.stage && state.stage !== 'loading') pending = null;
      // 8 秒只触发同控件的一次局部补点，不作为 CPA 失败时限；补点后继续等到下一状态或整行结束。
      if (pending && state.stage === pending.stage && driver.now() - pending.at >= 8000) {
        if (pending.count < 2) {
          driver.onStep('CPA：点击后页面未变化，重新定位并补点当前控件一次');
          submitted.delete(state.stage);
          pending = null;
        }
      }
      if (state.stage === 'phone_required') throw new CodexAuthorizationError('Codex 要求添加手机号，已终止 CPA 授权');
      // AdsPower 不再读取密码；即使旧客户端传入密码，也只等待用户在授权页手动完成登录。
      if (['password', 'verification', 'identity_required'].includes(state.stage)) {
        if (!verificationNotified) {
          driver.onVerification('CPA 授权需要人工完成密码/邮箱验证码/MFA/CAPTCHA 或核对账号，请在 AdsPower 窗口处理');
          verificationNotified = true;
        }
      } else if (['account', 'another_account', 'email', 'consent'].includes(state.stage) && !submitted.has(state.stage)) {
        const messages = {account:'选择当前任务账号', another_account:'使用当前任务账号登录', email:'输入当前行邮箱', consent:'确认 Codex 授权'};
        step(messages[state.stage]);
        if (!await click(state)) { await driver.sleep(250); continue; }
        if (state.stage === 'email') {
          check();
          await driver.type('email', row.email, state.inputLength);
          const submit = await driver.read(row.email, 'continue');
          if (!await click(submit, 'continue')) throw new CodexAuthorizationError('CPA 登录 Continue 未就绪');
        }
        // 记录点击并轮询下一状态；仅等待 8 秒仍无变化才允许同控件补点一次，禁止整条授权自动重跑。
        submitted.add(state.stage);
        const count = (attempts.get(state.stage) || 0) + 1;
        attempts.set(state.stage, count);
        pending = {stage:state.stage, count, at:driver.now()};
      }
      await driver.sleep(250);
    }
    check();
    if (callbackError) throw callbackError;
    if (!code) throw new CodexAuthorizationError('整行任务结束前未取得有效 CPA 回调');
    step('校验回调并兑换 Codex 凭据');
    const tokens = await driver.exchange(flow, code);
    check();
    const cpaJson = buildCodexJson(tokens, row.email, driver.now());
    const result = {cpaJson, cpaStatus:'completed', cpaError:''};
    onProgress(result);
    return result;
  } catch (error) {
    // OAuth URL、code、verifier、接口原文及 token 都不得出现在失败原因或日志中。
    const cpaError = error instanceof CodexAuthorizationError ? error.message : `${phase}失败，请检查授权页面或网络`;
    driver.onStep(`CPA：${cpaError}`);
    return {cpaJson:'', cpaStatus:'failed', cpaError};
  } finally {
    finished = true;
    flow.verifier = '';
    code = '';
    await driver.close().catch(() => {});
  }
}
