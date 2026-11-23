import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {inspectBillingProof, setBillingBrowserZoom, readBillingBrowserZoom} from '../src/automation/billing-proof.mjs';

function fixture({email = 'fixture@example.invalid', clipped = false, covered = false, loading = false} = {}) {
  const nodes = [];
  function node(tag, text, top, parent, extra = {}) {
    const n = {tag, textContent:text, parentElement:parent,
      rect:{left:100, right:400, top, bottom:top+24, width:300, height:24},
      style:{display:'block', visibility:'visible', overflowX:'visible', overflowY:'visible'}, ...extra};
    n.getBoundingClientRect = () => n.rect;
    n.contains = other => {for(let p=other; p; p=p.parentElement) if(p===n) return true; return false;};
    n.querySelectorAll = selector => nodes.filter(other => other!==n && n.contains(other) && selector.split(',').includes(other.tag));
    nodes.push(n);
    return n;
  }
  const root = node('html', '', 0, null);
  const body = node('body', '', 0, root, {innerText:loading?'Loading transactions':''});
  const panel = node('section', '', 0, body, {
    rect:{left:0,right:800,top:0,bottom:clipped?200:600,width:800,height:clipped?200:600},
    style:{overflowY:'auto'},
  });
  node('h2', 'ChatGPT Pro', 40, panel);
  const field = node('section', '', 180, panel);
  node('div', 'Billing email', 180, field);
  const value = node('div', email, 220, field);
  const context = vm.createContext({location:{origin:'https://chatgpt.com'},innerWidth:800,innerHeight:600,
    getComputedStyle:n=>n.style,
    document:{body,documentElement:root,querySelectorAll:selector=>nodes.filter(n=>selector.split(',').includes(n.tag)),
      elementFromPoint:(x,y)=>covered?body:[...nodes].reverse().find(n=>n.rect.top<=y && n.rect.bottom>=y)},
  });
  return {context, value, inspect:()=>vm.runInContext(`(${inspectBillingProof.toString()})()`,context)};
}

test('Billing 标题出现但邮箱未加载时不截图，完整值可见后才就绪且不返回邮箱', () => {
  const f=fixture({email:''});
  assert.equal(f.inspect().ready,true);
  assert.equal(f.inspect().screenshotReady,false);
  f.value.textContent='fixture@example.invalid';
  const state=f.inspect();
  assert.equal(state.screenshotReady,true);
  assert.ok(!JSON.stringify(state).includes('fixture@example.invalid'));
});

test('已进入 Billing 时先允许缩放，邮箱尚未渲染不阻塞进入缩放阶段', () => {
  const f=fixture({email:''});
  f.context.location.pathname='/settings/billing';
  f.context.document.querySelectorAll=()=>[];
  assert.equal(f.inspect().billingOpen,true);
  assert.equal(f.inspect().screenshotReady,false);
});

test('邮箱被滚动容器裁切、遮挡或仍加载中时不能误判截图就绪', () => {
  for(const options of [{clipped:true},{covered:true},{loading:true},{email:'Loading…'}]) {
    assert.equal(fixture(options).inspect().screenshotReady,false,JSON.stringify(options));
  }
  const f=fixture();f.context.location.origin='https://example.invalid';
  assert.equal(f.inspect().screenshotReady,false);
});


test('浏览器 Zoom 使用原生快捷键，Mac/Windows 分别使用 Cmd/Ctrl，并核对每档实际缩放', async () => {
  for (const platform of ['darwin','win32']) {
    let zoom=1.25;
    const events=[], expectedZoom=[];
    const page={command:async(method,event)=>{
      if(method==='Input.dispatchKeyEvent') {
        events.push(event);
        if(event.type==='rawKeyDown') zoom=event.key==='0'?1:({1:0.9,0.9:0.8,0.8:0.75}[zoom]);
      } else if(method==='Page.getLayoutMetrics') return {cssVisualViewport:{zoom,scale:1}};
      else assert.equal(method,'Page.bringToFront');
    }};
    await setBillingBrowserZoom(page,async(read,accept)=>{
      const actual=await read();assert.equal(accept(actual),true);expectedZoom.push(actual);
    },platform);
    assert.deepEqual(expectedZoom,[1,0.9,0.8,0.75]);
    assert.deepEqual(events.map(e=>e.type),Array(4).fill(['rawKeyDown','keyUp']).flat());
    assert.deepEqual(events.filter(e=>e.type==='rawKeyDown').map(e=>e.key),['0','-','-','-']);
    assert.ok(events.every(e=>e.modifiers===(platform==='darwin'?4:2)));
    assert.ok(events.every(e=>e.text===e.key && e.unmodifiedText===e.key));
    assert.equal(events[0].nativeVirtualKeyCode,platform==='darwin'?29:48);
    assert.equal(events[2].nativeVirtualKeyCode,platform==='darwin'?27:189);
  }
});

test('已有 75% 不重复缩放；快捷键无效或缺少浏览器 Zoom 时不能继续截图', async () => {
  const page={command:async(method)=>{
    if(method==='Page.getLayoutMetrics') return {cssVisualViewport:{zoom:0.75}};
    assert.equal(method,'Page.bringToFront');
  }};
  await setBillingBrowserZoom(page,()=>assert.fail('已有 75% 不应等待'),'darwin');
  // pinch scale 不能作为原生 Zoom 证据。
  assert.ok(Number.isNaN(await readBillingBrowserZoom({command:async()=>({cssVisualViewport:{scale:0.75}})})));
  let keys=0;
  await assert.rejects(setBillingBrowserZoom({command:async(method)=>{
    if(method==='Input.dispatchKeyEvent') keys++;
    return {cssVisualViewport:{zoom:1.25}};
  }},async(read,accept)=>{
    assert.equal(accept(await read()),false);throw Error('整行超时');
  },'darwin'),/整行超时/);
  assert.equal(keys,2);
});
