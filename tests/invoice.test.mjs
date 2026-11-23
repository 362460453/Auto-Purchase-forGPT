import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {mkdtemp,rm,readdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {inspectLatestInvoice,inspectInvoiceDownload,downloadInvoicePdf} from '../src/automation/invoice.mjs';
import {completePostPurchase,resolveAdditionalOptions,interruptedPostPurchaseResult} from '../src/automation/post-purchase.mjs';
import {createJobResults} from '../src/job-results.mjs';

const rect={left:200,top:300,right:220,bottom:320,width:20,height:20};
function transactionFixture(entries, duplicate=false){
 const rows=entries.map(([date,path])=>({querySelectorAll:s=>s==='td'?[{}, {textContent:date}]:[{href:'https://invoice.stripe.com/'+path,getBoundingClientRect:()=>rect}]}));
 const table={scrollHeight:500,clientHeight:400,getBoundingClientRect:()=>({left:100,top:0,right:1000,bottom:700,width:900,height:700}),querySelectorAll:()=>rows};
 return{location:{origin:'https://chatgpt.com'},URL,Date,innerWidth:1200,innerHeight:800,getComputedStyle:()=>({visibility:'visible',overflowY:'auto'}),document:{querySelectorAll:()=>duplicate?[table,table]:[table]}};
}
test('最新交易按日期排序，只使用 Transaction history 的发票入口',()=>{
 const read=options=>vm.runInNewContext(`(${inspectLatestInvoice.toString()})()`,options);
 const latest=read(transactionFixture([['11/01/2026','old'],['11/22/2026','latest'],['11/12/2026','middle']]));
 assert.equal(latest.href,'https://invoice.stripe.com/latest');assert.equal(latest.point.x,210);
 const clipped=transactionFixture([['11/22/2026','latest']]);clipped.document.querySelectorAll()[0].getBoundingClientRect=()=>({left:100,top:400,right:1000,bottom:700,width:900,height:300});
 const hidden=read(clipped);assert.equal(hidden.enabled,false);assert.equal(hidden.scrollUp,true);
 assert.equal(read(transactionFixture([['bad','unknown']])),null);
 assert.equal(read(transactionFixture([['11/22/2026','latest']],true)),null);
});
test('Download invoice 与 receipt 分开，非官方或重复按钮不得点击',()=>{
 const read=(names,origin='https://invoice.stripe.com')=>vm.runInNewContext(`(${inspectInvoiceDownload.toString()})()`,{location:{origin},innerWidth:1200,innerHeight:800,getComputedStyle:()=>({visibility:'visible'}),document:{querySelectorAll:()=>names.map(innerText=>({innerText,getAttribute:()=>null,getBoundingClientRect:()=>rect}))}});
 assert.equal(read(['Download invoice','Download receipt']).point.x,210);
 assert.equal(read(['Download receipt']),null);assert.equal(read(['Download invoice','Download invoice']),null);
 assert.equal(read(['Download invoice'],'https://example.com'),null);
});

test('等真实 completed 后保存 PDF；错误来源、取消或非 PDF 均失败并清理自身下载',async t=>{
 for(const mode of ['success','origin','cancel','invalid']){
  const directory=await mkdtemp(join(tmpdir(),'gpt-invoice-test-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const listeners=new Map(),commands=[];let downloadPath,clicks=0;
  const browser={on:(event,listener)=>{listeners.set(event,listener);return()=>listeners.delete(event);},command:async(method,args)=>{commands.push({method,args});if(args?.downloadPath)downloadPath=args.downloadPath;return{};}};
  const page={command:async()=>({frameTree:{frame:{id:'own'}}})};
  const invoke=()=>downloadInvoicePdf(browser,page,{directory,read:async()=>({point:{x:10,y:10},viewport:{width:100,height:100}}),pause:async()=>{},assertActive:()=>{},
   click:async()=>{
    clicks++;listeners.get('Browser.downloadWillBegin')({frameId:'other',guid:'other',url:'https://example.com/x',suggestedFilename:'other.pdf'});
    listeners.get('Browser.downloadWillBegin')({frameId:'own',guid:'own-download',url:mode==='origin'?'https://example.com/x':'https://stripe-upload-api.s3.us-west-1.amazonaws.com/x',suggestedFilename:'invoice.pdf'});
    await writeFile(join(downloadPath,'own-download'),mode==='invalid'?'html':'%PDF-1.4\nfixture\n%%EOF');
   },wait:async(read,accept)=>{
    assert.equal(Boolean(accept(await read())),mode==='origin','仅文件存在还不能算下载成功');
    listeners.get('Browser.downloadProgress')({guid:'own-download',state:mode==='cancel'?'canceled':'completed'});
    const state=await read();assert.equal(Boolean(accept(state)),true);return state;
   }});
  if(mode==='success'){
   const result=await invoke();assert.equal(result.invoiceStatus,'completed');assert.ok((await readFile(join(directory,result.invoiceFileName))).subarray(0,5).equals(Buffer.from('%PDF-')));
   assert.equal((await readdir(directory)).length,1);
  }else{await assert.rejects(invoke,/发票/);assert.deepEqual(await readdir(directory),[]);}
  assert.equal(clicks,1);assert.equal(commands.at(-1).args.behavior,'default');
 }
});
test('发票失败不阻止 CPA/2FA，已下载文件在后续超时中保留；默认不勾选',async()=>{
 assert.deepEqual(resolveAdditionalOptions(),['screenshot']);assert.throws(()=>resolveAdditionalOptions(['invoice'],'google-incognito'));
 const order=[];const result=await completePostPurchase(['invoice','screenshot','cpa','2fa'],async()=>{order.push('screenshot');return{screenshotUrl:'fixture'};},()=>{},
  {downloadInvoice:async()=>{order.push('invoice');throw Error('PDF未完成');},exportCpa:async()=>{order.push('cpa');return{cpaStatus:'completed',cpaJson:'fixture'};},setupTwoFactor:async()=>{order.push('2fa');return{twoFactorStatus:'already_enabled'};}});
 assert.deepEqual(order,['screenshot','invoice','cpa','2fa']);assert.equal(result.invoiceStatus,'failed');assert.equal(result.cpaStatus,'completed');
 const saved=interruptedPostPurchaseResult({...result,invoiceStatus:'completed',invoiceFileName:'fixture.pdf',twoFactorStatus:'pending'});
 assert.equal(saved.invoiceFileName,'fixture.pdf');assert.equal(saved.invoiceStatus,'completed');
});
test('发票文件名只凭正确批次令牌读取，不进入 SSE，也不跨行或批次',()=>{
 const store=createJobResults(),token=store.create('one'),other=store.create('two');
 const event=store.capture({jobId:'one',index:3,invoiceFileName:'fixture-private.pdf',invoiceStatus:'completed'});
 assert.equal(event.invoiceFileNameAvailable,true);assert.ok(!JSON.stringify(event).includes('fixture-private.pdf'));
 assert.equal(store.read('one',other),null);assert.equal(store.read('one',token)[0].index,3);assert.equal(store.read('one',token)[0].invoiceFileName,'fixture-private.pdf');
});

test('发票 HTTP 只接受正确批次令牌及原行号，文件路径和下载链接不进磁盘日志',async()=>{
 const path=await import('node:path');const {createPaidProfiles}=await import('../src/paid-profiles.mjs');
 let source=(await readFile(new URL('../server.mjs',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace("fileURLToPath(new URL('.', import.meta.url))","'/tmp/fixture'");
 const name='invoice-00000000-0000-0000-0000-000000000000.pdf';let fileReads=0;
 const context=vm.createContext({...path,invoiceDirectory:'/tmp/invoice-fixture',createPaidProfiles,createJobResults,process:{env:{},on(){}},
  readdir:async()=>[],mkdir:async()=>{},http:{createServer:()=>({listen(){}})},console,readFile:async p=>{assert.equal(p,'/tmp/invoice-fixture/'+name);fileReads++;return Buffer.from('%PDF-fixture');}});
 await vm.runInContext(`(async()=>{${source}\nglobalThis.handle=handleRequest;globalThis.persist=persistedEvent;globalThis.seed=()=>{const token=privateResults.create('one');privateResults.capture({jobId:'one',index:3,invoiceFileName:'${name}'});return token;};})()`,context);
 const token=context.seed();
 async function request(index,authorization){let status,body;await context.handle({method:'GET',url:'/api/jobs/one/invoices/'+index,headers:{authorization}},{setHeader(){},writeHead:code=>{status=code;},end:bytes=>{body=bytes;}});return{status,body};}
 assert.equal((await request(3,'Bearer wrong')).status,403);assert.equal((await request(0,'Bearer '+token)).status,404);assert.equal(fileReads,0);
 const success=await request(3,'Bearer '+token);assert.equal(success.status,200);assert.ok(success.body.toString().startsWith('%PDF'));assert.equal(fileReads,1);
 assert.ok(!JSON.stringify(context.persist({type:'additional_progress',invoiceFileName:name,invoiceUrl:'fixture-private-url',message:'已下载'})).includes(name));
});
