import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { buildResultsCsv, twoFactorStatusText, cpaStatusText } from '../public/task-export.js';

const source = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '');
function uiFixture() {
  const elements = new Map();
  const handlers = new Map();
  let downloaded;
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, {value:'', textContent:'', children:[],
      classList:{toggle(){}}, addEventListener(name, callback){handlers.set(`${selector}:${name}`, callback);}, prepend(item){this.children.unshift(item);},
      selectedOptions:[{textContent:'Oregon'}],
    });
    return elements.get(selector);
  };
  element('#product').value = 'Pro';
  element('input[name="planAmount"]:checked').value = '200';
  const options = [{name:'additionalOptions', value:'2fa', checked:true}];
  const reads = [];
  const context = vm.createContext({
    buildResultsCsv, twoFactorStatusText, cpaStatusText, console, setTimeout, Blob,
    URL:{createObjectURL:blob => {downloaded = blob; return 'blob:fixture';}, revokeObjectURL(){}},
    localStorage:{getItem:() => null, setItem:() => {throw Error('不应写入设置');}},
    document:{querySelector:element, querySelectorAll:selector => selector === 'input[name="additionalOptions"]:checked' ? options : [],
      addEventListener(){}, createElement:() => ({textContent:'', click(){}})},
    EventSource:class {},
    fetch:async (url, init) => {
      if (url === '/api/logs') return {ok:true, json:async () => []};
      if (url === '/api/jobs') return {ok:true, json:async () => ({jobId:'fixture-job', resultToken:'fixture-token'})};
      reads.push({url, init});
      return {ok:true, json:async () => [{index:0, twoFactorKey:'JBSWY3DPEHPK3PXP'}]};
    },
  });
  vm.runInContext(source, context);
  return {context, elements, reads, handlers, download:() => downloaded};
}

test('AdsPower 五列模板可直接导入，旧模板按表头忽略密码且不造成银行卡错位', async () => {
  const {context, handlers, download, elements} = uiFixture();
  handlers.get('#download-template:click')({preventDefault(){}});
  const template = await download().text();
  assert.equal(template, await readFile(new URL('../gpt-upgrade-template.csv', import.meta.url), 'utf8'));
  context.csv = template;
  const imported = JSON.parse(vm.runInContext("JSON.stringify(csvRows(csv, 'ads'))", context));
  assert.deepEqual(Object.keys(imported[0]), ['adsPowerSerialNumber', 'email', 'cardNumber', 'expires_at', 'cvv']);
  assert.equal(imported[0].expires_at, '0931');
  context.csv = '\uFEFFcvv,email,password,cardNumber,adsPowerSerialNumber,expires_at\r\n123,name@example.com,"SECRET,IGNORED",4111111111111111,10001,0931\r\n';
  const legacy = JSON.parse(vm.runInContext("JSON.stringify(csvRows(csv, 'ads'))", context));
  assert.deepEqual(legacy, imported);
  vm.runInContext("rows = csvRows(csv, 'ads'); renderRows()", context);
  assert.equal(elements.get('#password-heading').hidden, true);
  assert.ok(!elements.get('#task-body').innerHTML.includes('SECRET'));
  let posted;
  context.fetch = async (_url, init) => {posted = JSON.parse(init.body); return {ok:true, json:async () => ({jobId:'five', resultToken:'fixture'})};};
  await vm.runInContext('startJob(rows)', context);
  assert.deepEqual(posted.rows[0], {...imported[0], __uiIndex:0});
  assert.ok(!template.includes('password'));
});

test('前端从对应批次私有接口取得 Key，完成事件不清空 Key，日志不含 Key，离线仍可导出', async () => {
  const {context, elements, reads} = uiFixture();
  vm.runInContext("rows = [{email:'fixture@example.invalid', password:'fixture', adsPowerSerialNumber:'fixture'}]; rowStates.push({});", context);
  await vm.runInContext('startJob(rows)', context);
  context.payload = {jobId:'fixture-job', index:0, type:'post_purchase_progress',
    twoFactorStatus:'pending', twoFactorKeyAvailable:true, message:'附加任务结果已更新'};
  vm.runInContext('events.onmessage({data:JSON.stringify(payload)})', context);
  await vm.runInContext('refreshPrivateResults()', context);
  assert.equal(vm.runInContext('rowStates[0].twoFactorKey', context), 'JBSWY3DPEHPK3PXP');
  assert.equal(reads[0].url, '/api/jobs/fixture-job/results');
  assert.equal(reads[0].init.headers.Authorization, 'Bearer fixture-token');
  context.payload = {...context.payload, type:'row_succeeded', twoFactorStatus:'completed'};
  vm.runInContext('events.onmessage({data:JSON.stringify(payload)})', context);
  context.fetch = async () => { throw Error('服务已关闭'); };
  await vm.runInContext('refreshPrivateResults()', context);
  const csv = vm.runInContext('buildResultsCsv(rows, rowStates)', context);
  assert.ok(csv.includes('JBSWY3DPEHPK3PXP'));
  assert.ok(csv.includes('已启用，Key 已保存'));
  assert.ok(!elements.get('#events').children.some(item => item.textContent.includes('JBSWY3DPEHPK3PXP')));
  assert.equal(vm.runInContext('canRetryRow(0)', context), false);
});

test('旧批次仍在拉取 Key 时开始新批次，不把旧行号的 Key 写入新任务', async () => {
  const {context} = uiFixture();
  vm.runInContext("rows = [{email:'fixture@example.invalid'}]; rowStates.push({jobId:'old', twoFactorKeyAvailable:true}); resultAccesses = [{jobId:'old', resultToken:'token'}];", context);
  let deliver;
  let ready;
  const reading = new Promise(resolve => { ready = resolve; });
  context.fetch = async () => ({ok:true, json:() => new Promise(resolve => {deliver = resolve; ready();})});
  const refresh = vm.runInContext('refreshPrivateResults()', context);
  await reading;
  vm.runInContext("rowStates[0] = {jobId:'new'}", context);
  deliver([{index:0, twoFactorKey:'JBSWY3DPEHPK3PXP'}]);
  await refresh;
  assert.equal(vm.runInContext('rowStates[0].twoFactorKey', context), undefined);
});

test('前端补取 CPA 保留已有 Key，结果不进入 DOM 日志且可离线导出', async () => {
  const {context, elements} = uiFixture();
  vm.runInContext("rows = [{email:'fixture@example.invalid'}]; rowStates.push({jobId:'a', twoFactorKey:'fixture-key', cpaJsonAvailable:true, cpaStatus:'completed'}); resultAccesses = [{jobId:'a', resultToken:'token'}];", context);
  const cpaJson = JSON.stringify({access_token:'fixture-access'});
  context.fetch = async () => ({ok:true, json:async () => [{index:0, cpaJson}]});
  await vm.runInContext('refreshPrivateResults()', context);
  assert.equal(vm.runInContext('rowStates[0].cpaJson', context), cpaJson);
  assert.equal(vm.runInContext('rowStates[0].twoFactorKey', context), 'fixture-key');
  assert.ok(!elements.get('#task-body').innerHTML.includes('fixture-access'));
  context.fetch = async () => { throw Error('服务已关闭'); };
  await vm.runInContext('refreshPrivateResults()', context);
  assert.ok(vm.runInContext('buildResultsCsv(rows, rowStates)', context).includes('fixture-access'));
});

test('独立 CPA 重试不传卡资料、不清空其他结果，失败保留旧秘密，成功替换当前 CPA', async () => {
  const {context} = uiFixture();
  vm.runInContext("rows = [{adsPowerSerialNumber:'paid',email:'fixture@example.invalid',password:'fixture',cardNumber:'MUST-NOT-SEND',billingCity:'MUST-NOT-SEND'}]; rowStates.push({status:'已完成',paymentConfirmed:true,jobId:'old',twoFactorKey:'old-key',cpaJson:'old-cpa',screenshotUrl:'/old.png'});",context);
  let posted;
  context.fetch = async (url,init) => {
    if (url === '/api/jobs/additional') { posted = JSON.parse(init.body); return {ok:true,json:async()=>({jobId:'extra',resultToken:'token'})}; }
    return {ok:true,json:async()=>[{index:0,cpaJson:'new-cpa'}]};
  };
  await vm.runInContext("startAdditional(0,'cpa')",context);
  assert.ok(!JSON.stringify(posted).includes('MUST-NOT-SEND'));
  assert.ok(!('password' in posted.row));
  context.payload={type:'additional_finished',jobId:'extra',index:0,option:'cpa',cpaStatus:'failed',cpaError:'授权未完成',cpaJsonAvailable:false};
  vm.runInContext('events.onmessage({data:JSON.stringify(payload)})',context);
  assert.equal(vm.runInContext('rowStates[0].cpaJson',context),'old-cpa');
  assert.equal(vm.runInContext('rowStates[0].twoFactorKey',context),'old-key');
  assert.equal(vm.runInContext('rowStates[0].screenshotUrl',context),'/old.png');
  assert.equal(vm.runInContext('rowStates[0].status',context),'已完成');
  context.payload={...context.payload,cpaStatus:'completed',cpaError:'',cpaJsonAvailable:true};
  vm.runInContext('events.onmessage({data:JSON.stringify(payload)})',context);
  await vm.runInContext('refreshPrivateResults()',context);
  assert.equal(vm.runInContext('rowStates[0].cpaJson',context),'new-cpa');
  assert.equal(vm.runInContext('canRetryRow(0)',context),false);
});

test('重新导入按已付款记录恢复独立操作，并阻止再次充值', async () => {
  const {context}=uiFixture();
  vm.runInContext("rows=[{adsPowerSerialNumber:'paid'}];rowStates.push({});",context);
  context.fetch=async()=>({ok:true,json:async()=>[{serialNumber:'paid',subscriptionType:'Pro / $200 / 月',paidAt:'fixture'}]});
  await vm.runInContext('recoverPaidRows()',context);
  assert.equal(vm.runInContext('canRetryRow(0)',context),false);
  assert.equal(vm.runInContext('canRunAdditional(0)',context),true);
  assert.equal(vm.runInContext('rowStates[0].subscriptionType',context),'Pro / $200 / 月');
});

test('从本行继续按顺序提交当前及后续可执行行，保留原行号和绑定资料，跳过付款成功', async () => {
  const {context,elements}=uiFixture();
  context.fixtureRows=Array.from({length:7},(_,index)=>({adsPowerSerialNumber:String(100+index),
    email:`fixture-${index}@example.invalid`,cardNumber:`card-${index}`,expires_at:'0931',cvv:'fixture',
    billingAddressLine1:`address-${index}`,billingCity:`city-${index}`,billingCountry:'US'}));
  vm.runInContext("rows=fixtureRows;rowStates.push({status:'失败'}, {status:'已完成'}, {status:'失败'}, {status:'已完成',cpaJson:'saved-cpa'}, {status:'已取消'}, {}, {status:'失败',paymentConfirmed:true,twoFactorKey:'saved-key'});renderRows();",context);
  vm.runInContext("$('#concurrency').value='3'",context);
  let posted;
  context.fetch=async(url,init)=>url==='/api/jobs'
    ? (posted=JSON.parse(init.body),{ok:true,json:async()=>({jobId:'continued',resultToken:'fixture'})})
    : {ok:true,json:async()=>[]};
  await vm.runInContext('startFromRow(2)',context);
  assert.deepEqual(posted.rows.map(row=>row.__uiIndex),[2,4,5]);
  assert.equal(posted.concurrency,3);
  assert.equal(posted.planAmount,'200');
  for(const row of posted.rows) assert.deepEqual(row,{...context.fixtureRows[row.__uiIndex],__uiIndex:row.__uiIndex});
  assert.equal(vm.runInContext('rowStates[0].status',context),'失败');
  assert.equal(vm.runInContext('rowStates[3].cpaJson',context),'saved-cpa');
  assert.equal(vm.runInContext('rowStates[6].twoFactorKey',context),'saved-key');
  assert.equal(vm.runInContext('canContinueFromRow(2)',context),false);
});

test('从本行继续紧跟重试；本行完成仍可从后续开始，没有可执行行或执行中则禁用', async () => {
  const {context,elements,handlers}=uiFixture();
  vm.runInContext("rows=[{adsPowerSerialNumber:'paid'},{adsPowerSerialNumber:'pending'},{adsPowerSerialNumber:'done'}];rowStates.push({status:'已完成',paymentConfirmed:true},{},{status:'已完成'});renderRows();",context);
  assert.equal(vm.runInContext('canContinueFromRow(0)',context),true);
  assert.equal(vm.runInContext('canContinueFromRow(2)',context),false);
  const html=elements.get('#task-body').innerHTML;
  assert.match(html,/data-retry-index="0"[^>]*>重试<\/button><button[^>]*data-continue-index="0"[^>]*>从本行继续/);
  assert.match(html,/data-continue-index="2"[^>]* disabled/);
  for(const index of [-1,3,NaN,1.5]) {
    context.index=index;
    assert.equal(vm.runInContext('canContinueFromRow(index)',context),false);
  }
  let clicked;
  context.startFromRow=index=>{clicked=index;};
  const button={disabled:false,getAttribute:()=> '1'};
  const target={closest:selector=>selector==='[data-continue-index]'?button:null};
  handlers.get('#task-body:click')({target,stopPropagation(){}});
  assert.equal(clicked,1);
  button.disabled=true;clicked=undefined;
  handlers.get('#task-body:click')({target,stopPropagation(){}});
  assert.equal(clicked,undefined);
  vm.runInContext('jobRunning=true;renderRows()',context);
  assert.equal(vm.runInContext('canContinueFromRow(0)',context),false);
  assert.match(elements.get('#task-body').innerHTML,/data-continue-index="0"[^>]* disabled/);
});

test('终止本行只对运行行开放，使用当前批次及原行号，重复点击只发送一次请求',async()=>{
  const {context,elements}=uiFixture();
  vm.runInContext("rows=[{},{},{}];rowStates.push({status:'待执行',jobId:'run'},{status:'执行中',jobId:'run'},{status:'已完成',jobId:'run'});jobRunning=true;activeResultAccess={jobId:'run',resultToken:'token'};renderRows();",context);
  assert.equal(vm.runInContext('canStopRow(0)',context),false);
  assert.equal(vm.runInContext('canStopRow(1)',context),true);
  assert.equal(vm.runInContext('canStopRow(2)',context),false);
  assert.match(elements.get('#task-body').innerHTML,/从本行继续<\/button><button[^>]*data-stop-index="1"[^>]*>终止本行/);
  let posted,deliver;
  context.fetch=async(url,init)=>{posted={url,init};await new Promise(resolve=>{deliver=resolve;});return {ok:true,json:async()=>({accepted:true})};};
  const stopping=vm.runInContext('stopRow(1)',context);
  assert.equal(vm.runInContext('canStopRow(1)',context),false);
  assert.equal(vm.runInContext('rowStates[1].rowStopRequested',context),true);
  await vm.runInContext('stopRow(1)',context);
  assert.equal(posted.url,'/api/jobs/run/rows/1/stop');assert.equal(posted.init.headers.Authorization,'Bearer token');
  deliver();await stopping;
  assert.match(elements.get('#task-body').innerHTML,/终止中…/);
  context.payload={jobId:'run',type:'row_cancelled',index:1,message:'用户终止本行'};
  vm.runInContext('events.onmessage({data:JSON.stringify(payload)})',context);
  assert.equal(vm.runInContext('rowStates[1].status',context),'已取消');
  assert.equal(vm.runInContext('rowStates[1].rowStopRequested',context),false);
  assert.equal(vm.runInContext('jobRunning',context),true);
  assert.equal(vm.runInContext('failedIndexes.length',context),0);
});

test('终止请求网络失败允许重新操作，独立 CPA 终止保留付款和旧秘密',async()=>{
  const {context,elements,handlers}=uiFixture();
  vm.runInContext("rows=[{}];rowStates.push({status:'已完成',paymentConfirmed:true,jobId:'extra',additionalRunning:'cpa',twoFactorKey:'saved',cpaJson:'old'});jobRunning=true;activeResultAccess={jobId:'extra',resultToken:'token'};renderRows();",context);
  context.fetch=async()=>{throw Error('网络中断');};
  await vm.runInContext('stopRow(0)',context);
  assert.equal(vm.runInContext('canStopRow(0)',context),true);assert.match(elements.get('#activity').textContent,/网络中断/);
  let clicked;context.stopRow=index=>{clicked=index;};
  const button={disabled:false,getAttribute:()=> '0'},target={closest:selector=>selector==='[data-stop-index]'?button:null};
  handlers.get('#task-body:click')({target,stopPropagation(){}});assert.equal(clicked,0);
  context.payload={jobId:'extra',type:'additional_finished',index:0,option:'cpa',cpaStatus:'failed',cpaError:'用户终止本行'};
  vm.runInContext('events.onmessage({data:JSON.stringify(payload)})',context);
  assert.equal(vm.runInContext('rowStates[0].status',context),'已完成');
  assert.equal(vm.runInContext('rowStates[0].twoFactorKey',context),'saved');assert.equal(vm.runInContext('rowStates[0].cpaJson',context),'old');
  assert.equal(vm.runInContext('canStopRow(0)',context),false);
});

test('支付待核实行不能单行重试、全量启动或从本行继续，重新导入仍保留保护',async()=>{
  const {context}=uiFixture();
  vm.runInContext("rows=[{adsPowerSerialNumber:'review'},{adsPowerSerialNumber:'next'}];rowStates.push({status:'待核实',paymentReviewRequired:true},{});",context);
  assert.equal(vm.runInContext('canRetryRow(0)',context),false);
  let posted;
  context.fetch=async(url,init)=>url==='/api/jobs'
    ? (posted=JSON.parse(init.body),{ok:true,json:async()=>({jobId:'new',resultToken:'token'})})
    : {ok:true,json:async()=>[{serialNumber:'review',paymentReviewRequired:true}]};
  await vm.runInContext('startFromRow(0)',context);assert.deepEqual(posted.rows.map(row=>row.__uiIndex),[1]);
  vm.runInContext('jobRunning=false;rowStates[0]={}',context);
  await vm.runInContext('recoverPaidRows()',context);
  assert.equal(vm.runInContext('rowStates[0].status',context),'待核实');assert.equal(vm.runInContext('canRunAdditional(0)',context),false);
  assert.equal(vm.runInContext('canRetryRow(0)',context),false);
});
