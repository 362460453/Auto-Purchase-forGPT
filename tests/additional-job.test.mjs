import { AsyncLocalStorage } from 'node:async_hooks';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {createPaidProfiles} from '../src/paid-profiles.mjs';
import {initialPostPurchaseResult,interruptedPostPurchaseResult,resolveAdditionalOptions} from '../src/automation/post-purchase.mjs';
import {inspectLoginInput} from '../src/automation/codex-driver.mjs';
import {LOGIN_SELECTORS, inspectLoginPage, loginStateKind, assertLoginState} from '../src/automation/login-state.mjs';
const source=(await readFile(new URL('../src/automation/gpt-upgrade.mjs',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace(/^export /gm,'');

test('Settings 实际发给浏览器的脚本可执行，兼容弹窗和独立页面', async()=>{
  const context=vm.createContext({AsyncLocalStorage, AbortController,});vm.runInContext(source,context);
  for(const [pathname,dialog,expected] of [['/',false,false],['/settings',false,true],['/',true,true]]){
    context.evaluate=async(_page,expression)=>vm.runInNewContext(expression,{
      location:{pathname},document:{body:{innerText:'Settings Billing'},querySelectorAll:()=>dialog?[{getBoundingClientRect:()=>({width:1,height:1}),innerText:'Settings Billing'}]:[]}
    });
    assert.equal(await context.readSettingsPageState({}),expected);
  }
});

test('付款记录只接受明确支付成功，兼容旧日志且不限展示窗口',()=>{
  const paid=createPaidProfiles([{type:'row_failed',serialNumber:'a',message:'支付失败'},
    {type:'row_succeeded',message:'第 2 条 / AdsPower 14622：Pro / $200 / 月 支付成功；附加任务有未完成项',timestamp:'fixture'}]);
  assert.equal(paid.has('a'),false);assert.equal(paid.has('14622'),true);
  paid.capture({type:'row_payment_confirmed',serialNumber:'b',subscriptionType:'Pro / $100 / 月',timestamp:'time'});
  assert.equal(paid.has('b'),true);assert.equal(paid.list()[0].subscriptionType,'Pro / $200 / 月');
});

test('四个附加入口不调用付款，不需卡资料，只返回本项；超时保留已取得 Key',async()=>{
  for(const option of ['screenshot','invoice','cpa','2fa']){
    const events=[];let stops=0,closes=0,delay;
    const context=vm.createContext({AsyncLocalStorage, AbortController,initialPostPurchaseResult,interruptedPostPurchaseResult,resolveAdditionalOptions,Date:{now:()=>1000},
      setTimeout:(fn,ms)=>{delay=ms;return setTimeout(fn,25);},clearTimeout,
      startAdsPowerProfile:async()=>({debugPort:1}),stopAdsPowerProfile:async()=>{stops++;}});
    vm.runInContext(source,context);
    context.connectChatGptPage=async()=>({command:async()=>{},close:()=>{closes++;}});
    context.openChatGptAndPreparePayment=()=>{throw Error('必须禁止调用购买');};
    context.runPostPurchaseActions=async(_page,_profile,_row,proof)=>{
      assert.deepEqual([...proof.additionalOptions],[option]);
      if(option==='2fa') {proof.onPostPurchaseProgress({twoFactorKey:'fixture-key'});return new Promise(()=>{});}
      return {...initialPostPurchaseResult([option]),...(option==='screenshot'?{screenshotStatus:'completed',screenshotUrl:'/test.png'}:option==='invoice'?{invoiceStatus:'completed',invoiceFileName:'fixture.pdf'}:{cpaStatus:'failed',cpaError:'手机号要求'})};
    };
    const result=await context.runAdditionalJob({jobId:'fixture',row:{adsPowerSerialNumber:'paid',email:'fixture@example.invalid',__uiIndex:2},option,onEvent:event=>events.push(event)});
    assert.equal(delay,600000);assert.ok(stops>=1);assert.equal(closes,1);
    assert.ok(!events.some(e=>e.type==='row_failed'||e.type==='row_succeeded'));
    assert.equal(result[0].index,2);
    if(option==='2fa'){assert.equal(result[0].twoFactorKey,'fixture-key');assert.equal(result[0].twoFactorStatus,'failed');assert.ok(!('cpaJson'in result[0]));}
    else assert.ok(!('twoFactorKey'in result[0]));
  }
});

test('AdsPower 无密码行通过校验，密码页只等人工登录并确认首页后继续',async()=>{
  const context=vm.createContext({AsyncLocalStorage, AbortController,LOGIN_SELECTORS,inspectLoginPage,loginStateKind,assertLoginState,setTimeout:fn=>{fn();}});
  vm.runInContext(source,context);
  const row={adsPowerSerialNumber:'fixture',email:'fixture@example.invalid',cardNumber:'fixture',expires_at:'0931',cvv:'fixture'};
  context.validatePaymentRow(row,'ads');
  assert.throws(()=>context.validatePaymentRow(row,'google-incognito'),/password/);
  const states=[{ready:true,hasPasswordInput:true},{ready:true,manualVerification:true},{ready:true,home:true}];
  const notices=[];
  let reads=0;
  context.evaluate=async()=>{reads++;return states.shift();};
  context.focusAndType=async()=>{throw Error('不得读取或输入密码');};
  context.clickExactText=async()=>{throw Error('人工密码页不得自动提交');};
  Object.defineProperty(row,'password',{get(){throw Error('不得读取密码');}});
  await context.fillLoginIfNeeded({},row,message=>notices.push(message),'ads',1);
  assert.equal(reads,3);
  assert.ok(notices.some(message=>message.includes('手动')));
  context.evaluate=async()=>({ready:true,error:'account_deactivated'});
  await assert.rejects(context.fillLoginIfNeeded({},row,()=>{},'ads',1),/account_deactivated/);
  await assert.rejects(context.fillLoginIfNeeded({},row,()=>{},'ads',1,()=>false),/登录超时/);
});

test('CPA 输入校验忽略同名隐藏字段并检查可见框焦点',()=>{
  const visible={value:'fixture',disabled:false,getAttribute:()=>null,getBoundingClientRect:()=>({left:0,right:100,top:0,bottom:20,width:100,height:20})};
  const hidden={...visible,value:'',getBoundingClientRect:()=>({width:0,height:0})};
  const state=vm.runInNewContext(`(${inspectLoginInput.toString()})('email','fixture')`,{
    location:{origin:'https://auth.openai.com'},innerWidth:800,innerHeight:600,getComputedStyle:()=>({visibility:'visible'}),
    document:{activeElement:visible,querySelectorAll:()=>[hidden,visible]}});
  assert.equal(state.accepted,true);assert.equal(state.focused,true);
  assert.ok(!JSON.stringify(state).includes('fixture'));
});

test('头像定位精确选 Open profile menu，不误选宽大的首页建议按钮',async()=>{
  const context=vm.createContext({AsyncLocalStorage, AbortController,});vm.runInContext(source,context);
  const node=(label,width,top)=>({disabled:false,innerText:label,getAttribute:name=>name==='aria-label'?label:null,
    getBoundingClientRect:()=>({left:10,top,bottom:top+32,width,height:32})});
  const result=vm.runInNewContext(context.readBottomLeftProfilePointExpression(),{
    innerWidth:1200,innerHeight:800,getComputedStyle:()=>({visibility:'visible'}),
    document:{querySelectorAll:()=>[node('Help me organize my notes',400,650),node('Open profile menu',32,740)]}});
  assert.equal(result.point.profileMenu,true);assert.equal(result.point.top,740);
});

test('付款后头像晚于旧 60 秒仍继续，未出现只在整行上限记录截图异常',async()=>{
  for(const delay of [0,90000,Infinity]){
    let clock=0,clickedAt,settingsClicks=0,reads=0;
    const context=vm.createContext({AsyncLocalStorage, AbortController,Date:{now:()=>clock},setTimeout:(fn,ms)=>{clock+=ms;fn();}});
    vm.runInContext(source,context);
    const page={command:async()=>({})};
    context.ensureHomePageForBillingProof=async()=>({page,extra:null});
    context.readSettingsPageState=async()=>false;
    context.evaluate=async()=>{
      reads++;
      return {point:clock>=delay?{x:26,y:700}:null,viewport:{width:1200,height:740}};
    };
    context.mouseClick=async(_page,point)=>{
      assert.ok(clock>=delay);assert.equal(point.y,700);clickedAt=clock;
    };
    context.readSettingsMenuState=async()=>clickedAt!==undefined;
    context.clickAndConfirm=async(_page,text)=>{assert.equal(text,'Settings');settingsClicks++;};
    if(delay===Infinity){
      const result=await context.runWithTaskBudget(() => context.captureAccountBillingProof(page,{debugPort:1}), () => clock < 600000, 600000);
      assert.equal(result.screenshotUrl,'');
      assert.match(result.screenshotError,/超过 10 分钟/);
      assert.equal(clickedAt,undefined);assert.equal(settingsClicks,0);
      assert.ok(clock>=600000&&clock<=600250);
    }else{
      const result=await context.runWithTaskBudget(() => context.openAccountSettings(page,1), () => clock < 600000, 600000);
      assert.equal(result.page,page);assert.equal(settingsClicks,1);
      assert.equal(clickedAt,delay+250);
    }
    assert.ok(reads>0);
  }
});

test('Billing 缩放到 75%，等待慢加载邮箱完整入镜后截图；超时不截图',async()=>{
 for(const readyAt of [90000,Infinity]){
  let clock=0,zoomed=false,captures=0;
  const context=vm.createContext({AsyncLocalStorage,AbortController,Date:{now:()=>clock},
   setTimeout:(fn,ms)=>{clock+=ms;fn();},process:{platform:'darwin'},setBillingBrowserZoom:async()=>{zoomed=true;},readBillingBrowserZoom:async()=>zoomed?0.75:1});
  vm.runInContext(source,context);
  const page={command:async()=>({})};
  context.openAccountSettings=async()=>({page,extra:null});
  context.readBillingPanelState=async()=>({billingOpen:true,ready:zoomed,screenshotReady:zoomed&&clock>=readyAt,layout:'stable'});
  context.clickAndConfirm=async(_page,label,_options,confirm)=>{assert.equal(label,'Billing');assert.equal(await confirm(),true);};
  context.saveViewportScreenshot=async()=>{assert.ok(zoomed&&clock>=readyAt);captures++;return '/api/screenshots/fixture.png';};
  const result=await context.runWithTaskBudget(()=>context.captureAccountBillingProof(page,{jobId:'fixture',index:0,debugPort:1}),()=>clock<600000,600000);
  assert.equal(captures,readyAt===Infinity?0:1);
  if(readyAt===Infinity)assert.match(result.screenshotError,/超过 10 分钟/);
  else{assert.equal(result.screenshotUrl,'/api/screenshots/fixture.png');assert.ok(clock>=90250);}
 }
});


test('设置导航第一次点击无效时 8 秒补点一次，仍使用原整行截止时间',async()=>{
 for(const completesAt of [90000,Infinity]){
  let clock=0,clicks=0;
  const context=vm.createContext({AsyncLocalStorage,AbortController,Date:{now:()=>clock},setTimeout:(fn,ms)=>{clock+=ms;fn();}});
  vm.runInContext(source,context);
  context.clickExactText=async()=>{clicks++;};
  const action=()=>context.clickAndConfirm({},'Billing',{retryNavigation:true},async()=>clock>=completesAt,10000,'等待账单');
  if(completesAt===Infinity)await assert.rejects(context.runWithTaskBudget(action,()=>clock<600000,600000),/超过 10 分钟/);
  else await context.runWithTaskBudget(action,()=>clock<600000,600000);
  assert.equal(clicks,2);
  assert.equal(clock,completesAt===Infinity?600000:completesAt);
 }
});

test('设置已打开或菜单已打开时直接接续，不重复点击头像关闭菜单',async()=>{
 for(const settingsOpen of [true,false]){
  const context=vm.createContext({AsyncLocalStorage,AbortController});vm.runInContext(source,context);
  const page={command:async()=>{}};
  context.ensureHomePageForBillingProof=async()=>({page});
  context.readSettingsPageState=async()=>settingsOpen;
  context.readSettingsMenuState=async()=>true;
  context.evaluate=()=>assert.fail('已有菜单不再找头像');
  let settingsClicks=0;
  context.clickAndConfirm=async(_page,label)=>{assert.equal(label,'Settings');settingsClicks++;};
  await context.openAccountSettings(page,1);
  assert.equal(settingsClicks,settingsOpen?0:1);
 }
});

test('设置导航坐标连续移动时等待稳定后再点，不点击旧坐标',async()=>{
 let clock=0,reads=0,clicked;
 const context=vm.createContext({AsyncLocalStorage,AbortController,Date:{now:()=>clock},setTimeout:(fn,ms)=>{clock+=ms;fn();}});
 vm.runInContext(source,context);
 context.evaluate=async()=>({readyState:'complete',viewport:{width:1200,height:800},point:{x:100,y:[300,340,380,380][Math.min(reads++,3)]}});
 context.mouseClick=async(_page,point)=>{clicked=point;};
 await context.runWithTaskBudget(()=>context.clickExactText({},'Billing',{retryNavigation:true}),()=>clock<600000,600000);
 assert.equal(reads,4);assert.equal(clicked.y,380);
});
