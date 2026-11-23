import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {AsyncLocalStorage} from 'node:async_hooks';
import * as plans from '../src/automation/pro-plans.mjs';

const amounts = ['100', '200', '500'];
const values = ['chatgptprolite', 'chatgptpro', 'chatgptpromax'];
function checkoutFixture({selected='100', due=selected, label='Pro plan', origin='https://chatgpt.com', path='/checkout/example', duplicateGroup=false, available=true, disabled=false, entries=amounts, wrongValue=false, checked=selected ? [selected] : []} = {}) {
  const node = (text, x, attrs={}) => ({innerText:text, textContent:text,
    getAttribute:key=>attrs[key] ?? null,
    getBoundingClientRect:()=>({left:x,top:100,width:80,height:40})});
  const radios = entries.map((amount,i)=>node(`$${amount}\n${['Standard','More usage','Max usage'][i]}`,100+i*100,
    {value:wrongValue ? 'other-product' : values[amounts.indexOf(amount)], 'aria-checked':String(checked.includes(amount)), 'aria-disabled':String(disabled)}));
  const group = {...node('',100,{'aria-labelledby':'pro-plan-label'}), querySelectorAll:selector=>{
    assert.equal(selector,'[role="radio"]'); // 实机还有隐藏 input 镜像，不能混进可点击控件。
    return radios;
  }};
  return {location:{origin,pathname:path},innerWidth:1200,innerHeight:800,getComputedStyle:()=>({visibility:'visible'}),document:{
    body:{innerText:`Configure your plan Pro plan Due today $${due}.00`},
    getElementById:id=>id==='pro-plan-label'?node(label,100):null,
    querySelectorAll:selector=>selector==='[role="radiogroup"]'&&available?[group,...(duplicateGroup?[group]:[])]:[],
  }};
}
const inspect = (amount, options) => vm.runInNewContext(`(${plans.inspectProCheckoutOptions.toString()})(${JSON.stringify(amount)})`,checkoutFixture(options));

test('14643 的 Pro plan 结账单选组识别三档，精确校验 value、金额和选中态',()=>{
  for(const amount of amounts){
    const state=inspect(amount,{selected:amount});
    assert.equal(state.selected,true);
    assert.equal(state.enabled,true);
    assert.equal(state.optionPoint.x,140+amounts.indexOf(amount)*100);
    assert.equal(inspect(amount,{selected:amount==='100'?'200':'100'}).selected,false);
    assert.equal(inspect(amount,{checked:['100','200','500']}).selected,false);
    assert.equal(inspect(amount,{disabled:true}).enabled,false);
  }
  for(const options of [{label:'Plus plan'},{origin:'https://example.com'},{path:'/plans'}, {duplicateGroup:true}, {entries:['100','200']},{entries:['100','200','200']},{wrongValue:true}]){
    assert.equal(inspect('200',options),null);
  }
  assert.equal(inspect('20'),null);
});

function entryFixture(){
  const node=(text,x)=>({innerText:text,textContent:text,getAttribute:()=>null,getBoundingClientRect:()=>({left:x,top:100,width:100,height:40})});
  const price={...node('$100',100),querySelector:s=>s.includes('sr-only')?node('$100',100):node('/ month',100)};
  const card={...node('Pro Frontier intelligence',100),querySelectorAll:s=>s==='button,a,[role="button"]'?[node('Get started',400)]:[],querySelector:()=>price};
  return{document:{querySelectorAll:s=>s==='[data-pricing-plan="pro"]'?[card]:[]},getComputedStyle:()=>({visibility:'visible'}),innerWidth:1200,innerHeight:800};
}
const source=(await readFile(new URL('../src/automation/gpt-upgrade.mjs',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace(/^export /gm,'');

async function runFlow(amount,{wrongDue=false,ignoreSelection=false}={}){
  let clock=0, phase='home', enteredAt, changedAt, selected='100', filled=false, entryClicks=0, optionClicks=0, seeAllClicks=0;
  const context=vm.createContext({...plans,AsyncLocalStorage,AbortController,Date:{now:()=>clock},setTimeout:(fn,ms)=>{clock+=ms;fn();}});
  vm.runInContext(source,context);
  const page={close(){},command:async(method,params)=>{
    if(method!=='Input.dispatchMouseEvent'||params.type!=='mouseReleased')return{};
    if(phase==='pricing'&&params.x===450){entryClicks++; phase='checkout';enteredAt=clock;return{};}
    const index=[140,240,340].indexOf(params.x);
    assert.ok(phase==='checkout'&&index>=0,'不能点击套餐以外或付款控件');
    optionClicks++;changedAt=clock;if(!ignoreSelection)selected=amounts[index];return{};
  }};
  context.connectChatGptPage=async()=>page;
  context.fillLoginIfNeeded=async()=>{};
  context.readHomeUpgradeEntry=async()=>({text:'Upgrade',region:'top-right'});
  context.clickAndConfirm=async(_page,text)=>{if(text==='See all plans')seeAllClicks++;else phase='pricing';};
  context.evaluate=async(_page,expression)=>{
    if(expression.includes('inspectProPricingCard'))return vm.runInNewContext(expression,entryFixture());
    if(expression.includes('inspectProCheckout')){
      const due=wrongDue?'500.01':changedAt!==undefined&&clock-changedAt<120000?'100':selected;
      return vm.runInNewContext(expression,checkoutFixture({selected,due,available:phase==='checkout'&&clock-enteredAt>=90000}));
    }
    if(expression.includes('Getting your plan ready'))return phase==='checkout';
    return{origin:'https://chatgpt.com',pathname:'/',hash:'',ready:true};
  };
  context.fillStripeCard=async()=>{filled=true;assert.equal(selected,amount);throw Error('verified-stop-before-card');};
  const flow=()=>context.runWithTaskBudget(()=>context.openChatGptAndPreparePayment({debugPort:1},{},'Pro',{amount,label:`$${amount} / 月`},()=>{},()=>{},()=>{}),()=>clock<600000,600000);
  await assert.rejects(flow,wrongDue||ignoreSelection?/超过 10 分钟/:/verified-stop-before-card/);
  assert.equal(filled,!(wrongDue||ignoreSelection));
  assert.equal(entryClicks,1);
  assert.equal(seeAllClicks,0);
  assert.equal(optionClicks,amount==='100'?0:1);
  assert.ok(clock>=90000,'配置页延迟 90 秒仍使用整行剩余预算');
  if(!wrongDue&&!ignoreSelection&&amount!=='100')assert.ok(clock-changedAt>=120000,'等待 Due today 更新后才到填卡边界');
  return clock;
}

test('无规格 Pro → Get started → 延迟配置页 → 目标金额与 Due today 同步后才进入填卡',async()=>{
  for(const amount of amounts)await runFlow(amount);
});
test('配置页金额不匹配或单选未生效时等待整行上限，不填写卡且不重复购买',async()=>{
  assert.ok(await runFlow('200',{wrongDue:true})>=600000);
  assert.ok(await runFlow('200',{ignoreSelection:true})>=600000);
});
