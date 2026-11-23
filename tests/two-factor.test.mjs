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

function domFixture({ selected = true, secrets = [fixtureKey], input = false, origin = 'https://chatgpt.com' } = {}) {
  const node = (text, attrs = {}) => ({
    innerText:text, textContent:text, children:[], tagName:'SPAN',
    getAttribute:name => attrs[name] ?? null,
    getBoundingClientRect:() => ({left:20, top:30, width:100, height:30}),
  });
  const key = node('Key', {'aria-pressed':String(selected)});
  const code = {...node(''), tagName:'INPUT', placeholder:'000000', value:'', maxLength:-1};
  const panel = {...node(''), querySelectorAll:() => secrets.map(value => node(value))};
  const dialog = {...node(input ? 'Enter the 6-digit code shown in your authenticator app to finish setup' : 'Copy and paste the setup key into your authenticator app'),
    contains:() => false,
    querySelectorAll:selector => selector === 'input' ? input ? [code] : []
      : selector.includes('role="tabpanel"') ? [panel]
      : selector.includes('role="alert"') ? [] : input ? [] : [key],
  };
  return {location:{origin}, innerWidth:1000, innerHeight:800, getComputedStyle:() => ({visibility:'visible'}),
    document:{querySelectorAll:selector => selector.includes('role="dialog"') ? [dialog] : [], getElementById:() => null}};
}
const inspect = (action, fixture) => vm.runInNewContext(`(${inspectAuthenticator.toString()})(${JSON.stringify(action)})`, fixture);
test('真实 Key 切换按钮和 Code 占位符识别；状态不带 Key，歧义/未选中/非官方页面不读 Key', () => {
  assert.equal(inspect('secret', domFixture()), fixtureKey);
  assert.equal(inspect('state', domFixture()).keySelected, true);
  assert.ok(!JSON.stringify(inspect('state', domFixture())).includes(fixtureKey));
  assert.equal(inspect('secret', domFixture({selected:false})), '');
  assert.equal(inspect('secret', domFixture({secrets:[fixtureKey, 'JBSWY3DPEHPK3PXP']})), '');
  assert.equal(inspect('state', domFixture({input:true})).stage, 'verify');
  assert.equal(inspect('state', domFixture({origin:'https://example.invalid'})).stage, 'unavailable');
});
