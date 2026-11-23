import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {AsyncLocalStorage} from 'node:async_hooks';
import * as path from 'node:path';
import {resolveProSelection} from '../src/automation/pro-plans.mjs';
import {resolveAdditionalOptions, completePostPurchase, initialPostPurchaseResult, interruptedPostPurchaseResult} from '../src/automation/post-purchase.mjs';
import {createPaidProfiles} from '../src/paid-profiles.mjs';
import {createJobResults} from '../src/job-results.mjs';

const source=(await readFile(new URL('../src/automation/gpt-upgrade.mjs',import.meta.url),'utf8'))
  .replace(/^import .*;\n/gm,'').replace(/^export /gm,'');
const gate=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const row=index=>({__uiIndex:index,adsPowerSerialNumber:`fixture-${index}`,email:'fixture@example.invalid',cardNumber:'fixture',expires_at:'0931',cvv:'fixture'});
function fixture(overrides={}) {
  const controls=new Map(),events=[],stops=[];
  const context=vm.createContext({AsyncLocalStorage,AbortController,setTimeout,clearTimeout,resolveProSelection,
    resolveAdditionalOptions,completePostPurchase,initialPostPurchaseResult,interruptedPostPurchaseResult,
    startAdsPowerProfile:async()=>({debugPort:1}),stopAdsPowerProfile:async({serialNumber})=>{stops.push(serialNumber);},...overrides});
  vm.runInContext(source,context);
  const common={jobId:'fixture',additionalOptions:[],onEvent:event=>events.push(event),registerRowControl:(index,stop)=>{
    controls.set(index,stop);return ()=>controls.delete(index);
  }};
  return {context,controls,events,stops,common};
}

test('终止卡住的原行号只关闭本行，关闭后补上下一条，其他并发任务继续且迟到事件无效',async()=>{
  const closing=gate(),begun=gate(),next=gate(),other=gate();let stoppedBrowser=false;
  const f=fixture({stopAdsPowerProfile:async({serialNumber})=>{
    if(serialNumber==='fixture-7'){stoppedBrowser=true;await closing.promise;}
  }});
  const started=[];let lateProof,lateStep;
  f.context.openChatGptAndPreparePayment=async(_profile,row,_product,_selection,_status,_plans,step,proof)=>{
    started.push(row.__uiIndex);
    if(row.__uiIndex===7){lateProof=proof;lateStep=step;step('等待金额校验');return new Promise(()=>{});}
    if(row.__uiIndex===9){begun.resolve();await other.promise;}
    else {assert.equal(stoppedBrowser,true);next.resolve();}
    proof.onPaymentConfirmed();return initialPostPurchaseResult([]);
  };
  const work=f.context.runUpgradeJob({...f.common,rows:[row(7),row(9),row(15)],concurrency:2});
  await begun.promise;
  const stop=f.controls.get(7);
  assert.equal(stop(),true);assert.equal(stop(),false);
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(started,[7,9]);
  closing.resolve();await next.promise;
  assert.deepEqual(started,[7,9,15]);assert.ok(f.controls.has(9));
  const count=f.events.length;
  lateStep('迟到步骤');lateProof.onPaymentConfirmed();lateProof.onPostPurchaseProgress({cpaJson:'must-not-appear'});
  assert.equal(f.events.length,count);
  other.resolve();
  const results=await work;
  assert.deepEqual(Array.from(results,r=>r.status),['cancelled','succeeded','succeeded']);
  assert.match(f.events.find(e=>e.type==='row_cancelled').message,/等待金额校验.*用户终止本行/);
  assert.ok(!f.events.some(e=>e.type==='row_failed'));
  assert.equal(f.controls.size,0);
});

test('AdsPower 启动请求卡住时取消会 abort，释放并发位，尚未领取的行正常执行',async()=>{
  const begun=gate();let signal,opens=0;
  const f=fixture({startAdsPowerProfile:async options=>{
    if(options.serialNumber==='fixture-0'){signal=options.signal;begun.resolve();return new Promise(()=>{});}
    return {debugPort:1};
  }});
  f.context.openChatGptAndPreparePayment=async(_p,_r,_product,_selection,_status,_plans,_step,proof)=>{
    opens++;proof.onPaymentConfirmed();return {};
  };
  const work=f.context.runUpgradeJob({...f.common,rows:[row(0),row(1)]});
  await begun.promise;f.controls.get(0)();
  const results=await work;
  assert.equal(signal.aborted,true);assert.equal(signal.reason.code,'ROW_STOPPED');assert.equal(opens,1);
  assert.equal(results[0].status,'cancelled');assert.equal(results[1].status,'succeeded');
  assert.deepEqual(f.stops,['fixture-0','fixture-1']);
});

test('支付提交后终止只能记录待核实，明确支付成功后终止保留全部已有附加结果',async()=>{
  for(const paid of [false,true]) {
    const begun=gate(),f=fixture();
    f.context.openChatGptAndPreparePayment=async(_p,_r,_product,_selection,_status,_plans,step,proof)=>{
      proof.onPaymentSubmitted();
      if(paid){proof.onPaymentConfirmed();proof.onPostPurchaseProgress({screenshotUrl:'/proof.png',screenshotStatus:'completed',cpaJson:'fixture-cpa',cpaStatus:'completed',twoFactorKey:'fixture-key'});}
      step(paid?'等待 2FA 确认':'等待支付结果');begun.resolve();return new Promise(()=>{});
    };
    const work=f.context.runUpgradeJob({...f.common,rows:[row(3)],additionalOptions:['screenshot','cpa','2fa']});
    await begun.promise;f.controls.get(3)();const [result]=await work;
    assert.equal(result.status,paid?'succeeded':'payment_review');
    if(paid){assert.equal(result.twoFactorKey,'fixture-key');assert.equal(result.twoFactorStatus,'failed');assert.equal(result.cpaJson,'fixture-cpa');assert.equal(result.screenshotUrl,'/proof.png');assert.match(result.twoFactorError,/用户终止本行/);}
    else {const event=f.events.find(e=>e.type==='row_cancelled');assert.equal(event.paymentReviewRequired,true);assert.equal(event.serialNumber,'fixture-3');}
  }
});

test('独立截图 CPA 2FA 均可终止，保留本项已取得的秘密，不污染其他项或付款',async()=>{
  for(const option of ['screenshot','cpa','2fa']) {
    const begun=gate(),f=fixture();let closed=0;
    f.context.connectChatGptPage=async()=>({command:async()=>{},close(){closed++;}});
    f.context.runPostPurchaseActions=async(_p,_profile,_row,proof)=>{
      if(option==='2fa')proof.onPostPurchaseProgress({twoFactorKey:'fixture-key'});
      begun.resolve();return new Promise(()=>{});
    };
    const work=f.context.runAdditionalJob({...f.common,row:row(6),option});
    await begun.promise;f.controls.get(6)();const [result]=await work;
    const prefix=option==='2fa'?'twoFactor':option;
    assert.equal(result[`${prefix}Status`],'failed');assert.match(result[`${prefix}Error`],/用户终止本行/);
    if(option==='2fa')assert.equal(result.twoFactorKey,'fixture-key');
    assert.ok(!f.events.some(e=>['row_failed','row_cancelled'].includes(e.type)));
    assert.equal(closed,1);assert.equal(f.controls.size,0);
  }
});

test('停止排队与终止本行分别生效，当前行取消后不领取已停止的队列',async()=>{
  const begun=gate(),f=fixture();let stopQueue=false,opens=0;
  f.context.openChatGptAndPreparePayment=async()=>{opens++;begun.resolve();return new Promise(()=>{});};
  const work=f.context.runUpgradeJob({...f.common,rows:[row(0),row(1)],shouldStop:()=>stopQueue});
  await begun.promise;stopQueue=true;f.controls.get(0)();const results=await work;
  assert.equal(opens,1);assert.deepEqual(Array.from(results,r=>r.status),['cancelled','cancelled']);
  assert.equal(f.events.filter(e=>e.type==='row_cancelled').length,2);
});

test('待核实付款从日志恢复且不会被当作支付成功，后续明确成功解除待核实',()=>{
  const event={type:'row_cancelled',serialNumber:'fixture',paymentReviewRequired:true,subscriptionType:'Pro / $200 / 月'};
  const paid=createPaidProfiles([event]);assert.equal(paid.has('fixture'),false);assert.equal(paid.needsReview('fixture'),true);
  assert.equal(paid.list()[0].paymentReviewRequired,true);
  paid.capture({type:'row_payment_confirmed',serialNumber:'fixture',timestamp:'fixture'});
  assert.equal(paid.has('fixture'),true);assert.equal(paid.needsReview('fixture'),false);
  paid.capture(event);assert.equal(paid.needsReview('fixture'),false);
});

test('终止接口按批次令牌和原行号定位，拒绝错误令牌/排队/结束行，待核实日志不丢保护',async()=>{
  let serverSource=(await readFile(new URL('../server.mjs',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'');
  serverSource=serverSource.replace("fileURLToPath(new URL('.', import.meta.url))","'/tmp/fixture'");
  const context=vm.createContext({...path,createPaidProfiles,createJobResults,process:{env:{},on(){}},
    readdir:async()=>[],mkdir:async()=>{},http:{createServer:()=>({listen(){}})},console});
  await vm.runInContext(`(async()=>{${serverSource}\nglobalThis.handle=handleRequest;globalThis.persist=persistedEvent;globalThis.addJob=(id,controls)=>{jobs.set(id,{rowControls:controls});return privateResults.create(id);};})()`,context);
  let stops=0;
  const token=context.addJob('one',new Map([[7,()=>{stops++;return true;}]]));
  async function request(url,authorization){let status,body;await context.handle({method:'POST',url,headers:{authorization}},
    {writeHead:code=>{status=code;},end:text=>{body=JSON.parse(text);}});return {status,body};}
  assert.equal((await request('/api/jobs/one/rows/7/stop','Bearer wrong')).status,403);
  assert.equal((await request('/api/jobs/one/rows/8/stop',`Bearer ${token}`)).status,409);
  assert.equal((await request('/api/jobs/one/rows/100/stop',`Bearer ${token}`)).status,400);
  assert.equal((await request('/api/jobs/other/rows/7/stop',`Bearer ${token}`)).status,404);
  assert.equal(stops,0);
  assert.equal((await request('/api/jobs/one/rows/7/stop',`Bearer ${token}`)).status,202);assert.equal(stops,1);
  const event=context.persist({type:'row_cancelled',serialNumber:'fixture',paymentReviewRequired:true,cpaJson:'secret'});
  assert.equal(event.paymentReviewRequired,true);assert.equal(event.serialNumber,'fixture');assert.ok(!('cpaJson'in event));
});
