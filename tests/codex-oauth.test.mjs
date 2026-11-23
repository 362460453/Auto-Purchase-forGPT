import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createCodexFlow, claimCodexCallback, codexExchangeBody, buildCodexJson, inspectCodexAuthorization, exportCodexCredential, CODEX_CALLBACK } from '../src/automation/codex-oauth.mjs';
import { createCodexDriver } from '../src/automation/codex-driver.mjs';
import { completePostPurchase, resolveAdditionalOptions, interruptedPostPurchaseResult } from '../src/automation/post-purchase.mjs';
import { createJobResults } from '../src/job-results.mjs';
import { buildResultsCsv } from '../public/task-export.js';

const email = 'fixture@example.invalid';
const now = 1800000000000;
function tokens(overrides = {}) {
  const claims = {email, exp:now / 1000 + 3600, 'https://api.openai.com/auth':{chatgpt_account_id:'fixture-account', chatgpt_plan_type:'pro'}, ...overrides};
  return {access_token:'fixture-access', refresh_token:'fixture-refresh', id_token:`header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`, expires_in:3600};
}
const callback = (flow, code = 'fixture-code') => `${CODEX_CALLBACK}?state=${flow.state}&code=${code}`;

test('独立 PKCE、扩展参数一致、兑换表单绑定 verifier', () => {
  const a = createCodexFlow(), b = createCodexFlow();
  assert.notEqual(a.state, b.state);
  assert.notEqual(a.verifier, b.verifier);
  const url = new URL(a.authorizeUrl);
  assert.equal(url.origin, 'https://auth.openai.com');
  assert.equal(url.searchParams.get('redirect_uri'), CODEX_CALLBACK);
  assert.equal(url.searchParams.get('scope'), 'openid email profile offline_access');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(a.verifier).digest('base64url'));
  const body = new URLSearchParams(codexExchangeBody(a, 'fixture-code'));
  assert.equal(body.get('code_verifier'), a.verifier);
  assert.equal(body.get('code'), 'fixture-code');
});

test('精确绑定回调地址、标签和 state，同一授权码只领取一次', () => {
  const flow = {...createCodexFlow(), targetId:'a'};
  assert.equal(claimCodexCallback(createCodexFlow(), callback(flow), undefined), null);
  for (const url of [callback(flow).replace('localhost', 'localhost.evil.invalid'), callback(flow).replace('/auth/callback', '/auth/callback/extra'), callback(flow).replace('1455', '1456'), callback(flow) + '#secret']) {
    assert.equal(claimCodexCallback(flow, url, 'a'), null);
  }
  assert.equal(claimCodexCallback(flow, callback(flow), 'b'), null);
  assert.equal(claimCodexCallback(flow, callback(flow), 'a'), 'fixture-code');
  assert.equal(claimCodexCallback(flow, callback(flow), 'a'), null);
  for (const query of ['state=wrong&code=secret-code', 'state=STATE&state=STATE&code=secret-code', 'state=STATE&error=secret-error', 'state=STATE', 'state=STATE&code=x&code=y']) {
    const next = {...createCodexFlow(), targetId:'a'};
    assert.throws(() => claimCodexCallback(next, `${CODEX_CALLBACK}?${query.replaceAll('STATE', next.state)}`, 'a'), error => !/secret-|fixture-code/.test(error.message));
  }
});

test('CPA JSON 保持扩展字段与单行格式，拒绝错账号/缺 token/无效过期时间', () => {
  const data = tokens();
  const json = buildCodexJson(data, email.toUpperCase(), now);
  const output = JSON.parse(json);
  assert.equal(output.account_id, 'fixture-account');
  assert.equal(output.type, 'codex');
  assert.equal(output.provider, 'openai');
  assert.equal(output.state_matches, true);
  assert.equal(output.plan_type, 'pro');
  assert.equal(output.disabled, false);
  assert.equal(output.priority, 0);
  assert.equal(output.expired, new Date(now + 3600000).toISOString());
  assert.ok(!json.includes('\n'));
  for (const invalid of [tokens({email:'other@example.invalid'}), {...data, refresh_token:''}, {...data, id_token:'secret-malformed'}, tokens({'https://api.openai.com/auth':{}}), {...tokens({exp:0}), expires_in:0}]) {
    assert.throws(() => buildCodexJson(invalid, email, now), error => !/fixture-access|fixture-refresh|secret-malformed/.test(error.message));
  }
});

function fakeDriver(stages, options = {}) {
  let clock = now, cursor = 0, receive, flow;
  const calls = {clicks:0, exchanges:0, closes:0, prompts:0, types:[], progress:[]};
  const state = () => ({stage:stages[cursor] || 'loading', point:{x:20, y:20}, viewport:{width:100, height:100}, inputLength:0});
  const driver = {
    isActive:() => clock < now + 600000 && (!options.cancel || clock === now),
    now:() => clock, sleep:async ms => { clock += ms; }, onStep:() => {}, onVerification:() => {calls.prompts++;},
    open:async (value, notify) => {flow = value; flow.targetId = 'own'; receive = notify; if (options.immediate) receive(callback(flow), 'own');},
    read:async () => { if (options.error) throw Error('secret-network-error'); return state(); },
    click:async () => {
      calls.clicks++;
      if (['email', 'password'].includes(stages[cursor]) && calls.types.length <= cursor) return;
      cursor++;
      if (!stages[cursor]) { receive(callback(flow), 'own'); receive(callback(flow), 'own'); }
    },
    type:async (stage, value) => calls.types.push({stage, value}),
    exchange:async () => {calls.exchanges++; return tokens(options.claims);},
    close:async () => {calls.closes++;},
  };
  return {driver, calls, completeManual:() => {cursor++;}};
}

test('手机号要求立即结束 CPA，不点击、不发短信、不兑换，并清理自己的标签', async () => {
  const f = fakeDriver(['phone_required']);
  const result = await exportCodexCredential(f.driver, {email});
  assert.equal(result.cpaStatus, 'failed');
  assert.match(result.cpaError, /手机号/);
  assert.equal(result.cpaJson, '');
  assert.equal(f.calls.clicks, 0);
  assert.equal(f.calls.exchanges, 0);
  assert.equal(f.calls.closes, 1);
});

test('授权成功只兑换一次；人工验证超时、取消和底层异常均不泄密或假成功', async () => {
  const success = fakeDriver(['account', 'consent']);
  const result = await exportCodexCredential(success.driver, {email}, value => success.calls.progress.push(value));
  assert.equal(result.cpaStatus, 'completed');
  assert.equal(success.calls.exchanges, 1);
  assert.equal(success.calls.closes, 1);
  assert.equal(success.calls.progress[0].cpaJson, result.cpaJson);
  for (const options of [{}, {cancel:true}, {error:true}]) {
    const failure = fakeDriver(['verification'], options);
    const failed = await exportCodexCredential(failure.driver, {email});
    assert.equal(failed.cpaStatus, 'failed');
    assert.equal(failure.calls.exchanges, 0);
    assert.equal(failure.calls.closes, 1);
    assert.ok(!failed.cpaError.includes('secret-network-error'));
    if (!options.cancel && !options.error) assert.equal(failure.calls.prompts, 1);
  }
  const mismatch = fakeDriver([], {immediate:true, claims:{email:'other@example.invalid'}});
  assert.equal((await exportCodexCredential(mismatch.driver, {email})).cpaJson, '');
});

function inspectFixture({path = '/choose-an-account', body = 'Choose an account to continue to Codex', controls = [], inputs = [], origin = 'https://auth.openai.com'} = {}) {
  const node = ({text = '', aria = '', ...rest}) => ({innerText:text, textContent:text, ...rest,
    getAttribute:key => key === 'aria-label' ? aria : null,
    getBoundingClientRect:() => ({left:10, top:10, width:60, height:30}),
  });
  return vm.runInNewContext(`(${inspectCodexAuthorization})(${JSON.stringify(email)})`, {
    location:{origin, pathname:path}, innerWidth:800, innerHeight:600, getComputedStyle:() => ({visibility:'visible'}),
    document:{body:{innerText:body}, querySelectorAll:selector => selector === 'input' ? inputs.map(node)
      : selector === 'input[type="tel"]' ? inputs.filter(item => item.type === 'tel').map(node) : controls.map(node)},
  });
}

test('实机账号 aria-label 正确匹配，不误点删除/其他邮箱；手机号页面优先终止', () => {
  const controls = [{text:'Fixture', aria:`Select account Fixture ${email}`}, {text:'', aria:`Remove account: ${email}`}];
  assert.equal(inspectFixture({controls}).stage, 'account');
  assert.equal(inspectFixture({controls:[{text:'Other', aria:'Select account Other wrong@example.invalid'}, {text:'Use another account'}]}).stage, 'another_account');
  assert.equal(inspectFixture({path:'/add-phone', body:'Phone number required', inputs:[{type:'tel'}]}).stage, 'phone_required');
  assert.equal(inspectFixture({path:'/anything', body:'', inputs:[{type:'tel'}]}).stage, 'phone_required');
  assert.equal(inspectFixture({path:'/anything', body:'', inputs:[{type:'tel', autocomplete:'one-time-code'}]}).stage, 'verification');
  assert.equal(inspectFixture({origin:'https://untrusted.invalid', path:'/add-phone'}).stage, 'loading');
  assert.equal(inspectFixture({path:'/consent', body:'Continue to Codex', controls:[{text:'Continue'}]}).stage, 'identity_required');
});

test('截图 → CPA → 2FA；手机号终止不拦截 2FA；超时保留完成的 CPA', async () => {
  assert.deepEqual(resolveAdditionalOptions(['cpa', 'cpa']), ['cpa']);
  assert.throws(() => resolveAdditionalOptions(['cpa'], 'google-incognito'));
  const sequence = [];
  const result = await completePostPurchase(['2fa', 'cpa', 'screenshot'], async () => {sequence.push('screenshot'); return {screenshotUrl:'/proof.png'};}, () => {}, {
    exportCpa:async () => {sequence.push('cpa'); return exportCodexCredential(fakeDriver(['phone_required']).driver, {email});},
    setupTwoFactor:async () => {sequence.push('2fa'); return {twoFactorStatus:'completed', twoFactorKey:'fixture-key'};},
  });
  assert.deepEqual(sequence, ['screenshot', 'cpa', '2fa']);
  assert.equal(result.cpaStatus, 'failed');
  assert.equal(result.twoFactorStatus, 'completed');
  const saved = interruptedPostPurchaseResult({...result, cpaStatus:'completed', cpaJson:'fixture-json', twoFactorStatus:'pending'});
  assert.equal(saved.cpaJson, 'fixture-json');
  assert.equal(saved.cpaStatus, 'completed');
  assert.equal(saved.twoFactorStatus, 'failed');
});

test('CPA 与 Key 分别合并、批次隔离、SSE 剔除，CSV JSON 引号可无损往返', async () => {
  const store = createJobResults();
  const token = store.create('one');
  const otherToken = store.create('two');
  const json = buildCodexJson(tokens(), email, now);
  store.capture({jobId:'one', index:0, twoFactorKey:'fixture-key'});
  const progress = store.capture({jobId:'one', index:0, cpaJson:json});
  const final = store.capture({jobId:'one', results:[{index:0, cpaJson:json, twoFactorKey:'fixture-key'}]});
  assert.equal(progress.cpaJsonAvailable, true);
  assert.ok(!JSON.stringify([progress, final]).includes('fixture-access'));
  assert.ok(!JSON.stringify([progress, final]).includes('fixture-key'));
  assert.equal(store.read('one', otherToken), null);
  const saved = store.read('one', token)[0];
  assert.equal(saved.twoFactorKey, 'fixture-key');
  assert.equal(saved.cpaJson, json);
  const csv = buildResultsCsv([{email, password:'fixture'}], [{...saved, cpaStatus:'completed'}]);
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const parser = app.slice(app.indexOf('function parseCsv('), app.indexOf('function csvRows('));
  const records = vm.runInNewContext(`${parser}; parseCsv(csv)`, {csv});
  assert.equal(records[1][3], json);
  assert.equal(records[1][4], 'fixture-key');
  assert.equal(records[1].at(-1), '已导出');
});

test('CDP 驱动先监听再导航，回调本地拦截，兑换沿用 Profile 同源，关闭只影响自建标签', async () => {
  const calls = [];
  let paused, received;
  const raw = {
    on:(name, listener) => {calls.push(name); paused = listener; return () => calls.push('unsubscribe');},
    command:async (method, params) => {calls.push({method, params}); return {};},
    close:() => calls.push('socket-close'),
  };
  const manager = {command:async (method, params) => {calls.push({method, params}); return {targetId:'own'};}};
  const flow = createCodexFlow();
  const driver = createCodexDriver({manager, debugPort:1, isActive:() => true, onStep:() => {}, onVerification:() => {},
    connectCdp:async () => raw, getTargets:async () => [{id:'own', webSocketDebuggerUrl:'fixture'}], sleep:async () => {},
    evaluate:async (_page, expression) => {
      calls.push({expression});
      if (expression.includes('const response = await fetch')) return {ok:true, data:tokens()};
      return true;
    },
  });
  await driver.open(flow, (url, id) => {received = claimCodexCallback(flow, url, id);});
  assert.equal(flow.targetId, 'own');
  const enableIndex = calls.findIndex(call => call.method === 'Fetch.enable');
  const navIndex = calls.findIndex(call => call.method === 'Page.navigate');
  assert.ok(enableIndex < navIndex);
  paused({requestId:'fixture-request', request:{url:callback(flow)}});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(received, 'fixture-code');
  const response = await driver.exchange(flow, received);
  assert.equal(response.access_token, 'fixture-access');
  assert.ok(calls.some(call => call.expression?.includes("credentials:'omit', redirect:'error'")));
  await driver.close();
  assert.deepEqual(calls.filter(call => call.method === 'Target.closeTarget').map(call => call.params.targetId), ['own']);
});

test('CPA 只填邮箱，密码步骤等待人工完成，旧客户端密码也不读取', async () => {
  const f = fakeDriver(['email', 'password', 'consent']);
  f.driver.onVerification = () => {f.calls.prompts++; f.completeManual();};
  const row = {email};
  Object.defineProperty(row, 'password', {get(){throw Error('不得读取密码');}});
  const result = await exportCodexCredential(f.driver, row);
  assert.equal(result.cpaStatus, 'completed');
  assert.deepEqual(f.calls.types, [{stage:'email', value:email}]);
  assert.equal(f.calls.prompts, 1);
  assert.equal(f.calls.exchanges, 1);
});

test('CPA 密码页无人处理时正常超时，只提示一次且不输入或点击', async () => {
  const f = fakeDriver(['password']);
  const result = await exportCodexCredential(f.driver, {email});
  assert.equal(result.cpaStatus, 'failed');
  assert.match(result.cpaError, /任务已结束/);
  assert.equal(f.calls.prompts, 1);
  assert.equal(f.calls.types.length, 0);
  assert.equal(f.calls.clicks, 0);
  assert.equal(f.calls.exchanges, 0);
  assert.equal(f.calls.closes, 1);
});

test('CPA 等待人工验证超过旧 60 秒后仍可授权，在共享任务结束时才停止等待', async () => {
  const f = fakeDriver(['consent']);
  const read = f.driver.read;
  f.driver.read = async () => f.driver.now() < now + 120000
    ? {stage:'verification', point:null, viewport:{width:100,height:100}}
    : read();
  const result = await exportCodexCredential(f.driver,{email});
  assert.equal(result.cpaStatus,'completed');
  assert.ok(f.driver.now() >= now + 120000);
  assert.equal(f.calls.prompts,1);
  assert.equal(f.calls.exchanges,1);
});

test('CPA 不给命令增加阶段时限，导航迟到时仍只发送一次', async () => {
  for (const delayedReply of [false, true]) {
    const calls=[], steps=[];
    let handshakes=0;
    const raw={on:()=>()=>{},close(){},command:async(method,params,timeout)=>{
      calls.push({method,timeout});
      if(method==='Page.navigate') {
        assert.equal(timeout,undefined);
        if(delayedReply) throw Error('CDP 命令超时：Page.navigate');
      } else assert.equal(timeout,undefined);
      return {};
    }};
    const driver=createCodexDriver({manager:{command:async()=>({targetId:'own'})},debugPort:1,isActive:()=>true,
      onStep:s=>steps.push(s),connectCdp:async(_url,timeout)=>{assert.equal(timeout,undefined);if(++handshakes===1)throw Error('fixture-handshake');return raw;},
      getTargets:async()=>[{id:'own',webSocketDebuggerUrl:'fixture'}],sleep:async()=>{}});
    await driver.open(createCodexFlow(),()=>{});
    assert.equal(handshakes,2);
    assert.equal(calls.filter(c=>c.method==='Page.navigate').length,1);
    assert.ok(calls.findIndex(c=>c.method==='Fetch.enable')<calls.findIndex(c=>c.method==='Page.navigate'));
    if(delayedReply)assert.ok(steps.some(s=>s.includes('继续等待')));
    await driver.close();
  }
});

test('CPA 启动失败指出具体 CDP 阶段，不泄露底层 URL 或凭据',async()=>{
  for(const method of ['Page.enable','Fetch.enable','Page.navigate']){
    const steps=[];
    const raw={on:()=>()=>{},close(){},command:async m=>{if(m===method)throw Error('fixture-secret-url-and-token');return {};}};
    const driver=createCodexDriver({manager:{command:async()=>({targetId:'own'})},debugPort:1,isActive:()=>true,onStep:s=>steps.push(s),
      connectCdp:async()=>raw,getTargets:async()=>[{id:'own',webSocketDebuggerUrl:'fixture'}],sleep:async()=>{}});
    const result=await exportCodexCredential(driver,{email});
    assert.equal(result.cpaStatus,'failed');assert.ok(result.cpaError.includes(method));
    assert.ok(!JSON.stringify({result,steps}).includes('fixture-secret'));
  }
});

test('浏览器明确拒绝授权导航不能被当成加载中',async()=>{
  const raw={on:()=>()=>{},close(){},command:async method=>method==='Page.navigate'?{errorText:'net::ERR_PROXY_CONNECTION_FAILED'}:{}};
  const driver=createCodexDriver({manager:{command:async()=>({targetId:'own'})},debugPort:1,isActive:()=>true,onStep:()=>{},
    connectCdp:async()=>raw,getTargets:async()=>[{id:'own',webSocketDebuggerUrl:'fixture'}],sleep:async()=>{}});
  const result=await exportCodexCredential(driver,{email});
  assert.match(result.cpaError,/导航被浏览器拒绝/);assert.equal(result.cpaJson,'');
});

test('新版账号按钮只在子节点显示邮箱时仍精确选择，排除删除和其他账号',()=>{
  const state=inspectFixture({controls:[{tagName:'BUTTON',text:`slidjn ${email}`,aria:'Select account'},
    {tagName:'BUTTON',text:email,aria:`Remove account: ${email}`},{tagName:'BUTTON',text:'other wrong@example.invalid'}]});
  assert.equal(state.stage,'account');assert.equal(state.accountMatched,true);
  const computed=inspectFixture({controls:[{tagName:'BUTTON',text:`slidjn ${email}`}]});
  assert.equal(computed.stage,'account');
});

test('CPA 点击被页面水合吞掉时仅补点当前控件一次并确认下一状态',async()=>{
  const f=fakeDriver(['account','consent']);
  const original=f.driver.click;
  let swallowed=true;
  f.driver.click=async point=>{if(swallowed){swallowed=false;return;}return original(point);};
  const result=await exportCodexCredential(f.driver,{email});
  assert.equal(result.cpaStatus,'completed');assert.equal(f.calls.exchanges,1);
});

test('CPA 同一控件仅补点一次，之后等待共享任务上限，不反复点击或兑换',async()=>{
  const f=fakeDriver(['account']);let clicks=0;
  f.driver.click=async()=>{clicks++;};
  const result=await exportCodexCredential(f.driver,{email});
  assert.equal(clicks,2);assert.equal(result.cpaStatus,'failed');assert.match(result.cpaError,/任务已结束/);
  assert.equal(f.calls.exchanges,0);assert.equal(f.calls.closes,1);
});
