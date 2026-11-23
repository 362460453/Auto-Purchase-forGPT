import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile}from'node:fs/promises';
import {AsyncLocalStorage}from'node:async_hooks';
import * as path from 'node:path';
import {randomUUID}from'node:crypto';
import {resolveAdditionalOptions,completePostPurchase,initialPostPurchaseResult,interruptedPostPurchaseResult}from'../src/automation/post-purchase.mjs';
import {resolveProSelection}from'../src/automation/pro-plans.mjs';
import {createPaidProfiles}from'../src/paid-profiles.mjs';
import {createJobResults}from'../src/job-results.mjs';
const source=(await readFile(new URL('../src/automation/gpt-upgrade.mjs',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace(/^export /gm,'');
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
function fixture(overrides={}){
 const events=[],starts=[],stops=[],controls=new Map();
 const c=vm.createContext({AsyncLocalStorage,AbortController,setTimeout,clearTimeout,resolveAdditionalOptions,completePostPurchase,initialPostPurchaseResult,interruptedPostPurchaseResult,
  startAdsPowerProfile:async({serialNumber})=>{starts.push(serialNumber);return{debugPort:1};},stopAdsPowerProfile:async({serialNumber})=>stops.push(serialNumber),...overrides});
 vm.runInContext(source,c);c.connectChatGptPage=async()=>({command:async()=>{},close(){}});c.openChatGptAndPreparePayment=()=>{throw Error('附加执行不得进入购买');};
 return{c,events,starts,stops,controls,common:{jobId:'fixture',onEvent:e=>events.push(e),registerRowControl:(index,stop)=>{controls.set(index,stop);return()=>controls.delete(index);}}};
}
test('截图+发票整批按并发补位，每行仅启动一次，无支付资料也可执行且不生成付款记录',async()=>{
 const f=fixture(),first=gate(),second=gate(),third=gate(),opened=gate();
 const rows=[7,9,15].map(index=>({__uiIndex:index,adsPowerSerialNumber:String(index),email:'fixture@example.invalid'}));
 rows.forEach(row=>Object.defineProperty(row,'cardNumber',{get(){throw Error('不得读取卡资料');}}));
 f.c.runPostPurchaseActions=async(_page,_profile,row,proof)=>{
  assert.deepEqual([...proof.additionalOptions],['screenshot','invoice']);assert.equal('cardNumber'in row,false);
  if(row.__uiIndex===7)await first.promise;
  if(row.__uiIndex===9){opened.resolve();await second.promise;}
  if(row.__uiIndex===15)third.resolve();
  return completePostPurchase(proof.additionalOptions,async()=>({screenshotUrl:'/fixture.png'}),()=>{}, {downloadInvoice:async()=>({invoiceFileName:'fixture.pdf'}),onProgress:proof.onPostPurchaseProgress});
 };
 const work=f.c.runAdditionalBatch({...f.common,rows,additionalOptions:['screenshot','invoice'],concurrency:2});
 await opened.promise;assert.deepEqual(f.starts,['7','9']);second.resolve();await third.promise;assert.deepEqual(f.starts,['7','9','15']);first.resolve();
 const results=await work;assert.deepEqual(Array.from(results,r=>r.index),[7,9,15]);assert.ok(results.every(r=>r.additionalStatus==='completed'&&r.paymentConfirmed===false));
 assert.equal(f.events.some(e=>['row_succeeded','row_payment_confirmed'].includes(e.type)),false);
 const paid=createPaidProfiles(f.events);assert.equal(paid.list().length,0);assert.equal(f.stops.length,3);
});
test('附加组合共用一次 10 分钟，超时保留截图和发票，不调用充值',async()=>{
 let budget;const f=fixture({Date:{now:()=>1000},setTimeout:(fn,ms)=>{budget=ms;return setTimeout(fn,20);}});
 f.c.runPostPurchaseActions=async(_a,_b,_row,proof)=>{proof.onPostPurchaseProgress({screenshotStatus:'completed',screenshotUrl:'/saved.png',invoiceStatus:'completed',invoiceFileName:'saved.pdf'});return new Promise(()=>{});};
 const results=await f.c.runAdditionalBatch({...f.common,rows:[{adsPowerSerialNumber:'fixture',__uiIndex:7,email:'fixture@example.invalid'}],additionalOptions:['screenshot','invoice','cpa','2fa']});
 assert.equal(budget,600000);assert.equal(results[0].screenshotUrl,'/saved.png');assert.equal(results[0].invoiceFileName,'saved.pdf');assert.equal(results[0].cpaStatus,'failed');assert.equal(results[0].twoFactorStatus,'failed');
});
test('批量附加任务可终止本行并继续下一行，停止排队不会启动未领取 Profile',async()=>{
 const f=fixture(),begun=gate();let stopped=false;
 f.c.runPostPurchaseActions=async(_a,_b,row)=>{if(row.__uiIndex===7){begun.resolve();return new Promise(()=>{});}return{...initialPostPurchaseResult(['screenshot']),screenshotStatus:'completed',screenshotUrl:'/fixture.png'};};
 const work=f.c.runAdditionalBatch({...f.common,rows:[7,9,15].map(index=>({adsPowerSerialNumber:String(index),__uiIndex:index})),additionalOptions:['screenshot'],concurrency:1,shouldStop:()=>stopped});
 await begun.promise;stopped=true;f.controls.get(7)();const results=await work;
 assert.deepEqual(f.starts,['7']);assert.equal(results[0].additionalStatus,'cancelled');assert.equal(results[1].status,'cancelled');assert.equal(results[2].status,'cancelled');
});

test('HTTP 明确区分充值与附加执行，默认兼容旧客户端；附加不要求付款记录、不接收卡资料',async()=>{
 let server=(await readFile(new URL('../server.mjs',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace("fileURLToPath(new URL('.', import.meta.url))","'/tmp/fixture'");
 const calls=[];const c=vm.createContext({...path,createPaidProfiles,createJobResults,resolveProSelection,resolveAdditionalOptions,process:{env:{},on(){}},crypto:{randomUUID},readdir:async()=>[],mkdir:async()=>{},appendFile:async()=>{},http:{createServer:()=>({listen(){}})},console,
  runUpgradeJob:async input=>{calls.push({kind:'purchase',input});return[];},runAdditionalJob:async input=>{calls.push({kind:'single',input});return[];},runAdditionalBatch:async input=>{calls.push({kind:'additional',input});return[];}});
 await vm.runInContext(`(async()=>{${server}\nglobalThis.handle=handleRequest;globalThis.markPaid=serial=>paidProfiles.capture({type:'row_payment_confirmed',serialNumber:serial});})()`,c);
 async function request(input,url='/api/jobs'){
  let code,body;const req={method:'POST',url,headers:{},async *[Symbol.asyncIterator](){yield Buffer.from(JSON.stringify(input));}};
  await c.handle(req,{writeHead:n=>code=n,end:text=>body=JSON.parse(text)});await new Promise(r=>setImmediate(r));return{code,body};
 }
 const row={adsPowerSerialNumber:'unrecorded',email:'fixture@example.invalid',__uiIndex:7,cardNumber:'DO-NOT-PASS',billingAddressLine1:'DO-NOT-PASS'};
 assert.equal((await request({rows:[row],purchase:false,additionalOptions:['screenshot','invoice'],planAmount:'invalid'})).code,202);
 const addons=calls.at(-1);assert.equal(addons.kind,'additional');assert.deepEqual(Object.keys(addons.input.rows[0]),['adsPowerSerialNumber','email','__uiIndex']);assert.equal(addons.input.isPaid('unrecorded'),false);
 assert.equal((await request({rows:[row],purchase:true,additionalOptions:[]})).code,202);assert.equal(calls.at(-1).kind,'purchase');
 assert.equal((await request({rows:[row],additionalOptions:['invoice']})).code,202);assert.equal(calls.at(-1).kind,'purchase');
 assert.equal((await request({rows:[row],purchase:false,additionalOptions:[]})).code,400);
 assert.equal((await request({rows:[row],purchase:'false',additionalOptions:[]})).code,400);
 c.markPaid('paid');assert.equal((await request({rows:[{...row,adsPowerSerialNumber:'paid'}],purchase:true,additionalOptions:[]})).code,400);
 assert.equal((await request({rows:[{...row,adsPowerSerialNumber:'paid'}],purchase:false,additionalOptions:['screenshot']})).code,202);
 assert.equal((await request({row,option:'screenshot'},'/api/jobs/additional')).code,202);assert.equal(calls.at(-1).input.paymentConfirmed,false);
 for(const mode of ['single','additional','purchase']){
  const input=mode==='single'?{row,option:'2fa'}:{rows:[row],purchase:mode==='purchase',additionalOptions:['2fa']};
  assert.equal((await request({...input,verificationPassword:'fixture-password'},mode==='single'?'/api/jobs/additional':'/api/jobs')).code,202);
  assert.equal(calls.at(-1).input.verificationPassword,'fixture-password');
 }
 assert.equal((await request({row,option:'screenshot',verificationPassword:'fixture-password'},'/api/jobs/additional')).code,202);
 assert.equal(calls.at(-1).input.verificationPassword,'');
 assert.equal((await request({row,option:'2fa',verificationPassword:{}},'/api/jobs/additional')).code,400);
});
