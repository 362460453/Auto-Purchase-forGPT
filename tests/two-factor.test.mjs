import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { generateTotp, normalizeTotpSecret } from '../src/automation/totp.mjs';
import { configureAuthenticator, inspectAuthenticator } from '../src/automation/two-factor.mjs';
import { completePostPurchase, interruptedPostPurchaseResult } from '../src/automation/post-purchase.mjs';
import { createJobResults } from '../src/job-results.mjs';
import { buildResultsCsv } from '../public/task-export.js';

// RFC 6238 的公开测试密钥，不是真实账号资料。
const fixtureKey = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
test('本机 TOTP 与 RFC 6238 SHA-1 向量的六位结果一致，包括前导零', () => {
  for (const [seconds, expected] of [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'],
    [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130']]) {
    assert.equal(generateTotp(fixtureKey, seconds * 1000), expected);
  }
  assert.equal(normalizeTotpSecret('gezd gnbv gy3t qojq'), 'GEZDGNBVGY3TQOJQ');
  assert.throws(() => generateTotp('not-valid-key-019'));
});

function driverFixture({ alreadyEnabled = false, rejected = false, stuck = false, cancelAfterKey = false, now = 1000 } = {}) {
  let stage = alreadyEnabled ? 'enabled' : 'disabled';
  let keySelected = false;
  let inputLength = 0;
  let invalid = false;
  let active = true;
  const actions = [];
  const progress = [];
  const driver = {
    now: () => now, sleep: async ms => { now += ms; }, isActive: () => active && now < 600000,
    onStep: message => actions.push(message), scroll: async () => {},
    read: async action => action === 'secret' ? fixtureKey : ({ stage, keySelected, inputLength, invalid,
      point: {x:10, y:10, action}, viewport:{width:100, height:100} }),
    click: async ({action}) => {
      actions.push(action);
      if (action === 'toggle') stage = 'intro';
      if (action === 'key') keySelected = true;
      if (action === 'continue') {
        if (stage === 'intro') stage = 'setup';
        else if (stage === 'setup') stage = 'verify';
        else if (stage === 'verify') {
          if (rejected) invalid = true;
          else if (!stuck) stage = 'enabled';
        }
      }
    },
    type: async code => {
      assert.match(code, /^\d{6}$/);
      assert.equal(code, generateTotp(fixtureKey, now));
      inputLength = code.length;
    },
  };
  return {driver, actions, progress, onProgress: value => {
    progress.push({...value});
    if (cancelAfterKey) active = false;
  }};
}

test('按真实步骤启用，只在开关确认开启后成功，提交前已保留 Key', async () => {
  const fixture = driverFixture();
  const result = await configureAuthenticator(fixture.driver, fixture.onProgress);
  assert.equal(result.twoFactorStatus, 'completed');
  assert.equal(result.twoFactorKey, fixtureKey);
  assert.equal(fixture.progress[0].twoFactorStatus, 'pending');
  assert.equal(fixture.progress[0].twoFactorKey, fixtureKey);
  assert.deepEqual(fixture.actions.filter(a => ['toggle', 'continue', 'key', 'input'].includes(a)),
    ['toggle', 'continue', 'key', 'continue', 'input', 'continue']);
  assert.ok(!fixture.actions.join('').includes(fixtureKey));
});

test('原已启用不点击或重置，不假造可导出的 Key', async () => {
  const fixture = driverFixture({alreadyEnabled:true});
  const result = await configureAuthenticator(fixture.driver, fixture.onProgress);
  assert.equal(result.twoFactorStatus, 'already_enabled');
  assert.equal(result.twoFactorKey, '');
  assert.equal(fixture.actions.length, 0);
});

test('2FA 每个页面晚于旧 10 秒才出现仍完成，所有阶段使用同一任务活跃状态', async () => {
  const fixture = driverFixture();
  const read = fixture.driver.read;
  let lastStage, readyAt = 0;
  fixture.driver.read = async action => {
    const state = await read(action);
    if (typeof state === 'string') return state;
    if (state.stage !== lastStage) {lastStage=state.stage;readyAt=fixture.driver.now()+15000;}
    return fixture.driver.now()<readyAt ? {...state,stage:'unavailable',point:null,keySelected:false} : state;
  };
  const result = await configureAuthenticator(fixture.driver,fixture.onProgress);
  assert.equal(result.twoFactorStatus,'completed');
  assert.equal(result.twoFactorKey,fixtureKey);
  assert.ok(fixture.driver.now()>75000);
});

test('拒绝验证码、未出现成功状态、取消任务都保留 Key 且不宣称启用成功', async () => {
  for (const options of [{rejected:true}, {stuck:true}, {cancelAfterKey:true}]) {
    const fixture = driverFixture(options);
    const result = await configureAuthenticator(fixture.driver, fixture.onProgress);
    assert.equal(result.twoFactorStatus, 'failed');
    assert.equal(result.twoFactorKey, fixtureKey);
    assert.ok(!result.twoFactorError.includes(fixtureKey));
    assert.ok(!fixture.progress.some(value => value.twoFactorStatus === 'completed'));
    if (options.cancelAfterKey) assert.ok(!fixture.actions.includes('input'));
  }
});

test('验证码周期末尾等待新周期，外部异常不泄露 Key', async () => {
  const fixture = driverFixture({now:26000});
  const result = await configureAuthenticator(fixture.driver, fixture.onProgress);
  assert.equal(result.twoFactorStatus, 'completed');
  assert.ok(fixture.driver.now() >= 30000);
  const broken = driverFixture();
  broken.driver.type = async () => { throw Error(`unsafe ${fixtureKey}`); };
  assert.ok(!(await configureAuthenticator(broken.driver)).twoFactorError.includes(fixtureKey));
});

test('先截图再做 2FA；截图失败不拦截 2FA；总超时不丢失已完成项', async () => {
  const order = [];
  const result = await completePostPurchase(['2fa', 'screenshot'], async () => {
    order.push('screenshot'); throw Error('截图失败');
  }, () => {}, {setupTwoFactor: async update => {
    order.push('2fa');
    update({twoFactorKey:fixtureKey, twoFactorStatus:'pending'});
    return {twoFactorKey:fixtureKey, twoFactorStatus:'completed'};
  }});
  assert.deepEqual(order, ['screenshot', '2fa']);
  assert.equal(result.screenshotStatus, 'failed');
  assert.equal(result.twoFactorStatus, 'completed');
  const timeout = interruptedPostPurchaseResult({...result, screenshotUrl:'/proof.png', screenshotStatus:'completed', twoFactorStatus:'pending'});
  assert.equal(timeout.screenshotUrl, '/proof.png');
  assert.equal(timeout.screenshotStatus, 'completed');
  assert.equal(timeout.twoFactorKey, fixtureKey);
  assert.equal(timeout.twoFactorStatus, 'failed');
});

test('Key 不进入 SSE/日志载荷，只凭对应批次令牌读取，不串行号', () => {
  const store = createJobResults();
  const tokenA = store.create('a');
  const tokenB = store.create('b');
  const safe = store.capture({jobId:'a', index:7, type:'post_purchase_progress', twoFactorKey:fixtureKey});
  const finished = store.capture({jobId:'a', type:'job_finished', results:[{index:7, twoFactorKey:fixtureKey}]});
  assert.ok(!JSON.stringify([safe, finished]).includes(fixtureKey));
  assert.deepEqual(store.read('a', tokenA), [{index:7, twoFactorKey:fixtureKey}]);
  assert.equal(store.read('a', tokenB), null);
  assert.equal(store.read('a', ''), null);
  assert.deepEqual(store.read('b', tokenB), []);
});

test('CSV 的 2fa 是本次保存的 Key，未确认状态明确；忽略导入文件中的伪造值', () => {
  const csv = buildResultsCsv([{email:'fixture@example.invalid', password:'fixture', '2fa':'UNTRUSTED'}],
    [{twoFactorKey:fixtureKey, twoFactorStatus:'failed', twoFactorError:'未确认启用', status:'已完成'}]);
  assert.ok(csv.includes(`"","${fixtureKey}"`));
  assert.ok(csv.includes('"2FA状态"'));
  assert.ok(csv.includes('未完成：未确认启用'));
  assert.ok(!csv.includes('UNTRUSTED'));
});

function domFixture({ selected = true, secrets = [fixtureKey], input = false, inline = false, origin = 'https://chatgpt.com' } = {}) {
  const node = (text, attrs = {}) => ({
    innerText:text, textContent:text, children:[], tagName:'SPAN',
    getAttribute:name => attrs[name] ?? null,
    getBoundingClientRect:() => ({left:20, top:30, width:100, height:30}),
  });
  const key = node('Key', {'aria-pressed':String(selected)});
  const manual = node(selected ? 'Show QR code' : 'Can’t scan? Enter the code manually');
  const verify = node('Verify');
  const code = {...node('', inline ? {'aria-label':'6-digit code'} : {}), tagName:'INPUT', placeholder:inline ? '' : '000000', value:'', maxLength:-1};
  const panel = {...node(''), querySelectorAll:() => secrets.map(value => node(value))};
  const dialog = {...node(input ? 'Enter the 6-digit code shown in your authenticator app to finish setup' : 'Copy and paste the setup key into your authenticator app'),
    contains:() => false,
    querySelectorAll:selector => selector === 'input' ? input || inline ? [code] : []
      : selector.includes('role="tabpanel"') ? [panel]
      : selector.includes('role="alert"') ? [] : inline ? [manual, verify] : input ? [] : [key],
  };
  return {location:{origin}, innerWidth:1000, innerHeight:800, getComputedStyle:() => ({visibility:'visible'}),
    document:{querySelectorAll:selector => selector.includes('role="dialog"') ? [dialog] : [], getElementById:() => null}};
}
const inspect = (action, fixture) => vm.runInNewContext(`(${inspectAuthenticator.toString()})(${JSON.stringify(action)})`, fixture);
test('14626 官方邮箱二次验证只返回等待状态，不读取页面秘密', () => {
  const fixture = domFixture({origin:'https://auth.openai.com'});
  fixture.location.pathname = '/email-verification';
  assert.equal(inspect('state', fixture).stage, 'verification_required');
  assert.equal(inspect('secret', fixture), '');
  assert.equal(inspect('state', {location:{origin:'https://example.invalid', pathname:'/email-verification'}}).stage, 'unavailable');
});

test('开关后的人工邮箱验证共享总时限，返回不同设置状态时继续且只提示一次', async () => {
  for (const returnStage of ['disabled', 'intro', 'setup', 'enabled', 'never']) {
    const fixture = driverFixture();
    const read = fixture.driver.read;
    const click = fixture.driver.click;
    let verificationAt = null;
    let resumed = false;
    let toggles = 0;
    fixture.driver.click = async point => {
      await click(point);
      if (point.action === 'toggle' && ++toggles === 1) verificationAt = fixture.driver.now();
    };
    fixture.driver.read = async action => {
      if (verificationAt !== null) {
        if (returnStage === 'never' || fixture.driver.now() - verificationAt < 20000) {
          return {stage:'verification_required'};
        }
        if (!resumed) {
          resumed = true;
          verificationAt = null;
          if (returnStage === 'setup') await click({action:'continue'});
          const state = await read(action);
          return {...state, stage:returnStage};
        }
      }
      return read(action);
    };
    const result = await configureAuthenticator(fixture.driver, fixture.onProgress);
    assert.equal(fixture.actions.filter(message => message.includes('请在当前 AdsPower')).length, 1);
    assert.equal(result.twoFactorStatus, returnStage === 'never' ? 'failed' : returnStage === 'enabled' ? 'already_enabled' : 'completed');
    assert.equal(toggles, returnStage === 'disabled' ? 2 : 1);
    assert.equal(result.twoFactorKey, ['never', 'enabled'].includes(returnStage) ? '' : fixtureKey);
    if (returnStage === 'never') {
      assert.match(result.twoFactorError, /人工邮箱验证/);
      assert.ok(!fixture.actions.includes('input'));
      assert.ok(fixture.driver.now() >= 600000);
    }
  }
});

test('真实 Key 切换按钮和 Code 占位符识别；状态不带 Key，歧义/未选中/非官方页面不读 Key', () => {
  assert.equal(inspect('secret', domFixture()), fixtureKey);
  assert.equal(inspect('state', domFixture()).keySelected, true);
  assert.ok(!JSON.stringify(inspect('state', domFixture())).includes(fixtureKey));
  assert.equal(inspect('secret', domFixture({selected:false})), '');
  assert.equal(inspect('secret', domFixture({secrets:[fixtureKey, 'JBSWY3DPEHPK3PXP']})), '');
  assert.equal(inspect('state', domFixture({input:true})).stage, 'verify');
  assert.equal(inspect('state', domFixture({origin:'https://example.invalid'})).stage, 'unavailable');
});

test('新版同页密钥与验证码：展开手动 Key、保留 Key、仅点击一次 Verify', async () => {
  for (const selected of [true, false]) {
    const dom = domFixture({inline:true, selected});
    const state = inspect('state', dom);
    assert.equal(state.stage, 'setup');
    assert.equal(state.inlineSetup, true);
    assert.equal(state.keySelected, selected);
    assert.equal(inspect('secret', dom), selected ? fixtureKey : '');
    assert.ok(inspect('input', dom).point);
    assert.ok(inspect('continue', dom).point);
  }
  const fixture = driverFixture();
  const read = fixture.driver.read;
  const click = fixture.driver.click;
  let opened = false;
  fixture.driver.click = async point => {
    if (point.action === 'toggle') {opened = true; await click(point); await click({action:'continue'}); return;}
    if (point.action === 'continue') {await click(point); await click(point); return;}
    await click(point);
  };
  fixture.driver.read = async action => {
    const state = await read(action);
    return opened && state.stage === 'setup' ? {...state, inlineSetup:true} : state;
  };
  const result = await configureAuthenticator(fixture.driver, fixture.onProgress);
  assert.equal(result.twoFactorStatus, 'completed');
  assert.equal(result.twoFactorKey, fixtureKey);
  assert.ok(fixture.actions.indexOf('key') < fixture.actions.indexOf('input'));
  assert.equal(fixture.progress[0].twoFactorStatus, 'pending');
});

test('二次验证用已设置的密码，只提交一次；拒绝或异常不泄密，不提交验证码', async () => {
  for (const failure of ['', 'rejected', 'type']) {
    const fixture = driverFixture();
    const read = fixture.driver.read;
    const click = fixture.driver.click;
    let auth = '', invalid = false, submitted = 0, typed = 0;
    fixture.driver.read = async action => auth ? {stage:auth, invalid, point:{x:10,y:10,action}, viewport:{width:100,height:100}} : read(action);
    fixture.driver.click = async point => {
      if (point.action === 'password-method') {auth = 'password_required'; return;}
      if (point.action === 'password-input') return;
      if (point.action === 'password-continue') {submitted++; if (failure === 'rejected') invalid = true; else auth = ''; return;}
      await click(point);
      if (point.action === 'toggle') auth = 'verification_required';
    };
    fixture.driver.typePassword = async value => {
      assert.equal(value, 'fixture-password'); typed++;
      if (failure === 'type') throw Error(value);
    };
    const result = await configureAuthenticator(fixture.driver, fixture.onProgress, {verificationPassword:'fixture-password'});
    assert.equal(result.twoFactorStatus, failure ? 'failed' : 'completed');
    assert.equal(typed, 1);
    assert.equal(submitted, failure === 'type' ? 0 : 1);
    assert.ok(!JSON.stringify([result, fixture.actions, fixture.progress]).includes('fixture-password'));
    if (failure) assert.ok(!fixture.actions.includes('input'));
  }
});

test('启用后跳过可选短信备份，仍须等开关开启；只跳过一次，不添加手机号', async () => {
  const fixture = driverFixture();
  const read=fixture.driver.read, click=fixture.driver.click;
  let backup=false, skipped=0;
  fixture.driver.read=async action=>backup?{stage:'backup_prompt',point:{x:10,y:10,action},viewport:{width:100,height:100}}:read(action);
  fixture.driver.click=async point=>{
    if(point.action==='skip-backup'){skipped++;backup=false;return;}
    const before=await read();
    await click(point);
    if(point.action==='continue'&&before.stage==='verify')backup=true;
  };
  const result=await configureAuthenticator(fixture.driver,fixture.onProgress);
  assert.equal(result.twoFactorStatus,'completed');assert.equal(skipped,1);
  assert.equal(result.twoFactorKey,fixtureKey);
});
