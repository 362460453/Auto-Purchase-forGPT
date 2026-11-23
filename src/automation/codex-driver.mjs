import { CODEX_CALLBACK, CODEX_TOKEN_ENDPOINT, CodexAuthorizationError, codexExchangeBody, inspectCodexAuthorization } from './codex-oauth.mjs';

// 只返回输入状态与坐标，不返回账号或密码；同名隐藏字段不参与判断。
export function inspectLoginInput(stage, expected) {
  if (location.origin !== 'https://auth.openai.com') return null;
  const selector = stage === 'email' ? 'input[type="email"],input[name="email"]' : 'input[type="password"]';
  const inputs = [...document.querySelectorAll(selector)].filter(input => {
    const r = input.getBoundingClientRect();
    return !input.disabled && r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight
      && r.left >= 0 && r.right <= innerWidth && getComputedStyle(input).visibility !== 'hidden';
  });
  if (inputs.length !== 1) return null;
  const input = inputs[0];
  const r = input.getBoundingClientRect();
  return {accepted:input.value === expected && input.getAttribute('aria-invalid') !== 'true',
    focused:document.activeElement === input, length:input.value.length, invalid:input.getAttribute('aria-invalid') === 'true',
    point:{x:r.left + r.width / 2, y:r.top + r.height / 2}};
}

// 复用项目的 CDP 输入方式；只管理当前任务自己创建的授权标签，不读取其他标签的回调。
export function createCodexDriver({ manager, debugPort, isActive, onStep, onVerification,
  connectCdp, getTargets, evaluate, mouseClick, clearFocusedField, typeWithKeyboard, dispatchKey, sleep }) {
  let page;
  let rawPage;
  let targetId;
  let unsubscribe;
  let callbackCompletion = Promise.resolve();
  let callbackFailure = false;
  let closed = false;
  const check = () => {
    if (closed || !isActive()) throw new CodexAuthorizationError('CPA 任务已结束');
  };
  const read = async (email, action = 'state') => {
    check();
    if (callbackFailure) throw new CodexAuthorizationError('CPA 本地回调处理失败');
    // 跳转时执行上下文会销毁，短暂读不到 DOM 只能视为加载中；最终由整行期限终止。
    return evaluate(page, `(${inspectCodexAuthorization.toString()})(${JSON.stringify(email)}, ${JSON.stringify(action)})`, false)
      .catch(() => ({stage:'loading'}));
  };
  return {
    isActive: () => !closed && isActive(), now:Date.now, sleep, onStep, onVerification, read,
    async open(flow, receive) {
      check();
      onStep('CPA：创建独立授权标签');
      let created;
      try { created = await manager.command('Target.createTarget', {url:'about:blank'}); }
      catch { throw new CodexAuthorizationError('CPA 创建授权标签失败，AdsPower 已启动但 CDP 未能新建页面'); }
      if (!created?.targetId) throw new CodexAuthorizationError('CPA 新建授权标签未返回标识');
      targetId = created.targetId;
      flow.targetId = targetId;
      check();
      onStep('CPA：等待授权标签的 CDP 连接');
      // 新标签及 CDP 就绪共用整行剩余时间；这里只连接本条标签，不重建标签或重跑账号任务。
      while (isActive()) {
        check();
        const targets = await getTargets(debugPort).catch(() => []);
        const target = targets.find(item => item.id === targetId && item.webSocketDebuggerUrl);
        if (target) {
          rawPage = await connectCdp(target.webSocketDebuggerUrl).catch(() => null);
          if (rawPage) break;
        }
        await sleep(100);
      }
      check();
      if (!rawPage) throw new CodexAuthorizationError('整行任务结束前 CPA 授权标签的 CDP 未就绪');
      // 生产 CDP 命令使用整行剩余时间，不能从握手参数继承一个独立的小阶段时限。
      page = {command: (method, params = {}, timeout) => { check(); return rawPage.command(method, params, timeout); }};
      const prepare = async (label, method, params = {}) => {
        onStep(`CPA：${label}`);
        try { return await page.command(method, params); }
        catch { throw new CodexAuthorizationError(`CPA ${label}失败（${method}），请检查该授权标签的 CDP 连接`); }
      };
      await prepare('启用授权标签控制', 'Page.enable');
      unsubscribe = rawPage.on('Fetch.requestPaused', event => {
        callbackCompletion = (async () => {
          // 回调在浏览器内截获并返回固定页面，不占用 1455 端口，不把授权码发给本机其他进程。
          await page.command('Fetch.fulfillRequest', {requestId:event.requestId, responseCode:200,
            responseHeaders:[{name:'Content-Type', value:'text/html; charset=utf-8'}, {name:'Cache-Control', value:'no-store'}],
            body:Buffer.from('<!doctype html><title>Codex</title><p>Authorization received. You can close this tab.</p>').toString('base64')});
          check();
          receive(event.request.url, targetId);
        })().catch(() => { callbackFailure = true; });
      });
      await prepare('绑定本地授权回调', 'Fetch.enable', {patterns:[{urlPattern:`${CODEX_CALLBACK}*`, requestStage:'Request'}]});
      await prepare('显示授权标签', 'Page.bringToFront');
      onStep('CPA：加载 auth.openai.com 授权页');
      // 导航与授权状态机共享整行剩余时间；浏览器明确拒绝导航才提前失败，绝不重复导航。
      try {
        const navigation = await page.command('Page.navigate', {url:flow.authorizeUrl});
        if (navigation?.errorText) throw new CodexAuthorizationError('CPA 授权页导航被浏览器拒绝，请检查该 Profile 的代理或网络');
      } catch (error) {
        if (error?.message === 'CDP 命令超时：Page.navigate') onStep('CPA：导航命令仍未返回，继续等待授权页面或回调');
        else if (error instanceof CodexAuthorizationError) throw error;
        else throw new CodexAuthorizationError('CPA 授权页导航连接中断（Page.navigate），请检查该授权标签');
      }
    },
    click: point => mouseClick(page, point),
    async type(stage, value, length) {
      check();
      if (typeof value !== 'string' || !value) throw new CodexAuthorizationError('CPA 登录资料不完整');
      const inputState = () => evaluate(page,
        `(${inspectLoginInput.toString()})(${JSON.stringify(stage)}, ${JSON.stringify(value)})`, false);
      // 页面水合可能吞掉焦点或按键；最多重输当前字段一次，不重跑授权或提交。
      for (let attempt = 0; attempt < 2; attempt++) {
        check();
        let state = await inputState();
        if (!state) throw new CodexAuthorizationError('CPA 登录输入框未就绪');
        if (state.accepted) return;
        await mouseClick(page, state.point);
        state = await inputState();
        if (!state?.focused) { onStep('CPA：登录框尚未取得焦点，等待当前字段'); await sleep(300); continue; }
        await clearFocusedField(page, state.length ?? length);
        await typeWithKeyboard(page, value, {intervalMilliseconds:attempt ? 150 : 80});
        await dispatchKey(page, 'Tab', 'Tab', 9);
        // Tab 后短暂防抖再按实际输入内容校验，位数不完整时仅慢速重输当前字段一次，不建立阶段超时。
        await sleep(300);
        check();
        const final = await inputState();
        if (final?.accepted) return;
        onStep(`CPA：${stage === 'email' ? '邮箱' : '密码'}字段校验未通过（输入长度 ${final?.length ?? 0} / ${value.length}，页面标记无效 ${final?.invalid ? '是' : '否'}）`);
      }
      throw new CodexAuthorizationError('CPA 登录输入未被页面完整接受');
    },
    async exchange(flow, code) {
      check();
      await callbackCompletion;
      if (callbackFailure) throw new CodexAuthorizationError('CPA 本地回调处理失败');
      await page.command('Fetch.disable');
      // 兑换在同一个 Profile 的官方同源页面进行，沿用其代理；不从 Node 直连绕过浏览器代理。
      await page.command('Page.navigate', {url:'https://auth.openai.com/'});
      // 等待官方同源上下文共用整行剩余时间，未确认同源就不传递授权码和 verifier。
      let ready = false;
      while (isActive()) {
        check();
        ready = await evaluate(page, "location.origin === 'https://auth.openai.com' && document.readyState === 'complete'", false).catch(() => false);
        if (ready) break;
        await sleep(200);
      }
      check();
      if (!ready) throw new CodexAuthorizationError('整行任务结束前 CPA token 兑换页面未就绪');
      // 兑换只发送一次；不另设 20 秒请求时限，整行结束会关闭 Profile 中止请求。HTTP 错误不外传秘密原文。
      const result = await evaluate(page, `(async () => {
        if (location.origin !== 'https://auth.openai.com') return {ok:false};
        try {
          const response = await fetch(${JSON.stringify(CODEX_TOKEN_ENDPOINT)}, {
            method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
            body:${JSON.stringify(codexExchangeBody(flow, code))}, credentials:'omit', redirect:'error', cache:'no-store',
          });
          if (!response.ok) return {ok:false};
          return {ok:true, data:await response.json()};
        } catch { return {ok:false}; }
      })()`, true);
      check();
      if (!result?.ok) throw new CodexAuthorizationError('CPA token 兑换失败或超时，未保存凭据');
      return result.data;
    },
    async close() {
      closed = true;
      unsubscribe?.();
      rawPage?.close();
      if (targetId) await manager.command('Target.closeTarget', {targetId}, 2000).catch(() => {});
    },
  };
}
