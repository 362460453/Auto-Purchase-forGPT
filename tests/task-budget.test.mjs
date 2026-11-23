import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {AsyncLocalStorage} from 'node:async_hooks';
import {readFile} from 'node:fs/promises';
import {resolveProSelection} from '../src/automation/pro-plans.mjs';
import {resolveAdditionalOptions, completePostPurchase, initialPostPurchaseResult, interruptedPostPurchaseResult} from '../src/automation/post-purchase.mjs';

const source = (await readFile(new URL('../src/automation/gpt-upgrade.mjs', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');

test('连续小阶段共用原截止时间，超过旧 5/60 秒仍等待，后续阶段不重新获得 10 分钟', async () => {
  let clock = 0;
  const context = vm.createContext({AsyncLocalStorage, Date:{now:()=>clock}, setTimeout:(fn,ms)=>{clock+=ms;fn();}});
  vm.runInContext(source, context);
  await context.runWithTaskBudget(async () => {
    await context.waitForValue(async()=>clock, value=>value>=90000, 5000, '旧 5 秒');
    assert.equal(clock, 90000);
    await context.waitForValue(async()=>clock, value=>value>=210000, 60000, '旧 60 秒');
    assert.equal(clock, 210000);
    assert.equal(context.commandTimeout(2000), 390000);
    await assert.rejects(context.waitForValue(async()=>false, Boolean, 10000, '旧 10 秒'), /超过 10 分钟/);
  }, ()=>clock<600000, 600000);
  assert.equal(clock, 600000);
});

test('并发任务的剩余预算互相隔离，迟启动的任务不借用其他行的截止时间', async () => {
  let clock = 100000;
  const context = vm.createContext({AsyncLocalStorage, Date:{now:()=>clock}});
  vm.runInContext(source, context);
  let release;
  const gate = new Promise(resolve=>{release=resolve;});
  const first = context.runWithTaskBudget(async()=>{
    await gate;
    return context.commandTimeout(15000);
  }, ()=>true, 600000);
  const second = context.runWithTaskBudget(async()=>{
    clock = 200000;
    release();
    await Promise.resolve();
    return context.commandTimeout(15000);
  }, ()=>true, 700000);
  assert.deepEqual(await Promise.all([first,second]), [400000,500000]);
});

test('实际 CDP 连接和命令沿用剩余预算，超过旧命令时限仍返回，整行中止会关闭连接', async () => {
  let clock=100000, socket;
  const delays=[], timers=new Set();
  class FakeSocket {
    handlers=new Map();
    constructor() {socket=this;queueMicrotask(()=>this.emit('open',{}));}
    addEventListener(name,handler) {
      if(!this.handlers.has(name))this.handlers.set(name,[]);
      this.handlers.get(name).push(handler);
    }
    emit(name,event) {for(const handler of this.handlers.get(name)||[])handler(event);}
    send(text) {const {id}=JSON.parse(text);clock+=80000;queueMicrotask(()=>this.emit('message',{data:JSON.stringify({id,result:{}})}));}
    close() {this.closed=true;this.emit('close',{});}
  }
  const controller=new AbortController();
  const context=vm.createContext({AsyncLocalStorage,WebSocket:FakeSocket,Date:{now:()=>clock},
    setTimeout:(fn,ms)=>{delays.push(ms);const timer={fn};timers.add(timer);return timer;},
    clearTimeout:timer=>timers.delete(timer),
  });
  vm.runInContext(source,context);
  await context.runWithTaskBudget(async()=>{
    const page=await context.connectCdp('fixture',3000);
    await page.command('Page.navigate',{},2000);
    await page.command('Runtime.evaluate',{},15000);
    assert.deepEqual(delays,[500000,500000,420000]);
    assert.equal(clock,260000);
    controller.abort();
    assert.equal(socket.closed,true);
    assert.throws(()=>page.command('Input.dispatchMouseEvent',{}),/超过 10 分钟/);
  },()=>true,600000,controller.signal);
  assert.equal(timers.size,0);
});

test('购买、截图、CPA、2FA 累加到同一个 10 分钟，超时保留已付款和已读结果', async () => {
  for (const twoFactorDuration of [80000, 120000]) {
    let clock = 0, timersCreated = 0, stops = 0;
    const timers = new Set(), events = [];
    const context = vm.createContext({AsyncLocalStorage, AbortController, Date:{now:()=>clock},
      resolveProSelection, resolveAdditionalOptions, completePostPurchase, initialPostPurchaseResult, interruptedPostPurchaseResult,
      setTimeout:(fn,ms)=>{timersCreated++;const timer={fn,at:clock+ms};timers.add(timer);return timer;},
      clearTimeout:timer=>timers.delete(timer),
      startAdsPowerProfile:async()=>({debugPort:1}), stopAdsPowerProfile:async()=>{stops++;},
    });
    vm.runInContext(source, context);
    const advance = async ms => {
      const next = [...timers].sort((a,b)=>a.at-b.at)[0];
      if (next && next.at <= clock+ms) {
        clock=next.at;timers.delete(next);next.fn();
        // 整行计时已经结束，模拟尚未返回的外部操作，不能再发布迟到的成功或秘密。
        return new Promise(()=>{});
      }
      clock+=ms;
    };
    context.openChatGptAndPreparePayment = async (_profile,_row,_product,_selection,_status,_plans,step,proof) => {
      step('购买');await advance(400000);proof.onPaymentConfirmed();
      return completePostPurchase(proof.additionalOptions, async()=>{
        step('截图');await advance(20000);return {screenshotUrl:'/fixture.png'};
      },step,{onProgress:proof.onPostPurchaseProgress,
        exportCpa:async()=>{step('CPA');await advance(90000);return {cpaJson:'fixture-json',cpaStatus:'completed'};},
        setupTwoFactor:async update=>{
          step('2FA');update({twoFactorKey:'fixture-key',twoFactorStatus:'pending'});
          await advance(twoFactorDuration);return {twoFactorKey:'fixture-key',twoFactorStatus:'completed'};
        },
      });
    };
    const results = await context.runUpgradeJob({jobId:'fixture',additionalOptions:['screenshot','cpa','2fa'],
      rows:[{adsPowerSerialNumber:'fixture',email:'fixture@example.invalid',cardNumber:'fixture',expires_at:'0931',cvv:'fixture'}],
      onEvent:event=>events.push(event),
    });
    assert.equal(timersCreated,1);
    assert.equal(clock,twoFactorDuration===80000?590000:600000);
    assert.equal(results[0].status,'succeeded');
    assert.equal(results[0].screenshotUrl,'/fixture.png');
    assert.equal(results[0].cpaJson,'fixture-json');
    assert.equal(results[0].twoFactorKey,'fixture-key');
    assert.equal(results[0].twoFactorStatus,twoFactorDuration===80000?'completed':'failed');
    assert.equal(events.filter(event=>event.type==='row_payment_confirmed').length,1);
    assert.ok(!events.some(event=>event.type==='row_failed'));
    assert.ok(stops>=1);
  }
});
