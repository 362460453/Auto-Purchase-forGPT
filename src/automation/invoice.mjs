import {mkdir, mkdtemp, readFile, rename, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const invoiceDirectory = fileURLToPath(new URL('../../data/invoices/', import.meta.url));

// 14651 实机：交易表按 aria-label 定位，点击当前交易自己的 Open invoice 链接，不能点 Expense this。
export function inspectLatestInvoice() {
  if (location.origin !== 'https://chatgpt.com') return null;
  const visible = n => {const r=n.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(n).visibility!=='hidden';};
  const tables=[...document.querySelectorAll('table[aria-label="Transaction history"]')].filter(visible);
  if(tables.length!==1)return null;
  const rows=[...tables[0].querySelectorAll('tbody tr')];
  const candidates=[];
  for(const row of rows){
    const cells=[...row.querySelectorAll('td')];
    const links=[...row.querySelectorAll('a[aria-label^="Open invoice"]')];
    if(links.length!==1)continue;
    const date=(cells[1]?.textContent||'').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if(!date)return null;
    const stamp=Date.UTC(Number(date[3]),Number(date[1])-1,Number(date[2]));
    const parsed=new Date(stamp);
    if(parsed.getUTCMonth()!==Number(date[1])-1||parsed.getUTCDate()!==Number(date[2]))return null;
    let url;try{url=new URL(links[0].href);}catch{continue;}
    if(url.origin!=='https://invoice.stripe.com')continue;
    candidates.push({link:links[0],stamp,href:url.href});
  }
  candidates.sort((a,b)=>b.stamp-a.stamp);
  const latest=candidates[0];if(!latest)return null;
  const r=latest.link.getBoundingClientRect();
  let panel=tables[0];while(panel&&!(panel.scrollHeight>panel.clientHeight&&/auto|scroll/.test(getComputedStyle(panel).overflowY)))panel=panel.parentElement;
  const area=panel?.getBoundingClientRect()||{left:0,top:0,right:innerWidth,bottom:innerHeight};
  return{ready:true,href:latest.href,enabled:visible(latest.link)&&r.top>=Math.max(0,area.top)&&r.bottom<=Math.min(innerHeight,area.bottom),scrollUp:r.top<Math.max(0,area.top),point:{x:r.left+r.width/2,y:r.top+r.height/2},
    wheel:{x:Math.max(1,Math.min(innerWidth-20,(area.left+area.right)/2)),y:Math.max(1,Math.min(innerHeight-20,(area.top+area.bottom)/2))},viewport:{width:innerWidth,height:innerHeight}};
}

export function inspectInvoiceDownload() {
  if(location.origin!=='https://invoice.stripe.com')return null;
  const buttons=[...document.querySelectorAll('button')].filter(n=>n.innerText.trim()==='Download invoice'&&!n.disabled&&n.getAttribute('aria-disabled')!=='true');
  if(buttons.length!==1)return null;
  const r=buttons[0].getBoundingClientRect();if(r.width<=0||r.height<=0||getComputedStyle(buttons[0]).visibility==='hidden')return null;
  return{point:{x:r.left+r.width/2,y:r.top+r.height/2},viewport:{width:innerWidth,height:innerHeight}};
}

export async function downloadInvoicePdf(browser, page, {directory=invoiceDirectory, read, wait, click, pause, assertActive}) {
  await mkdir(directory,{recursive:true});
  const temporary=await mkdtemp(join(directory,'.download-'));
  let frame;
  let download=null, completed=false;
  const removeBegin=browser.on('Browser.downloadWillBegin',event=>{
    if(event.frameId!==frame||download)return;
    // 实机 PDF 来自 Stripe 的此 S3 域名；只接受当前发票标签的下载，不收其他标签的文件。
    let origin;try{origin=new URL(event.url).origin;}catch{}
    download={guid:event.guid,error:origin!=='https://stripe-upload-api.s3.us-west-1.amazonaws.com'||!event.suggestedFilename?.toLowerCase().endsWith('.pdf')?'发票下载来源或格式无法确认':''};
  });
  const removeProgress=browser.on('Browser.downloadProgress',event=>{
    if(event.guid===download?.guid&&event.state!=='inProgress')download.state=event.state;
  });
  try{
    frame=(await page.command('Page.getFrameTree')).frameTree.frame.id;
    await browser.command('Browser.setDownloadBehavior',{behavior:'allowAndName',downloadPath:temporary,eventsEnabled:true});
    const inViewport=s=>s?.point&&s.point.x>=0&&s.point.x<=s.viewport.width&&s.point.y>=0&&s.point.y<=s.viewport.height;
    let state;
    while(true){
      assertActive();state=await read();
      if(inViewport(state)){
        await pause(400);const next=await read();
        if(inViewport(next)&&Math.abs(next.point.x-state.point.x)<2&&Math.abs(next.point.y-state.point.y)<2){state=next;break;}
      }else if(state){await page.command('Input.dispatchMouseEvent',{type:'mouseWheel',x:state.viewport.width/2,y:state.viewport.height/2,deltaX:0,deltaY:state.point.y<0?-300:300});}
      await pause(250);
    }
    await click(page,state.point);
    // 必须等浏览器下载 completed；按钮已点或文件刚出现都不能算成功，等待共用整行预算。
    await wait(()=>Promise.resolve(download),d=>Boolean(d?.error||d?.state),45000,'发票下载未完成');
    if(download.error)throw new Error(download.error);
    if(download.state!=='completed')throw new Error('发票下载被取消或中断');
    completed=true;assertActive();
    if(!/^[a-zA-Z0-9-]+$/.test(download.guid))throw new Error('发票下载标识无效');
    const source=join(temporary,download.guid);const bytes=await readFile(source);
    if(bytes.subarray(0,5).toString()!=='%PDF-'||!bytes.subarray(Math.max(0,bytes.length-1024)).includes(Buffer.from('%%EOF')))throw new Error('发票文件不是完整 PDF');
    const invoiceFileName=`invoice-${randomUUID()}.pdf`;
    await rename(source,join(directory,invoiceFileName));
    return{invoiceFileName,invoiceStatus:'completed',invoiceError:''};
  }finally{
    removeBegin();removeProgress();
    if(download?.guid&&!completed)await browser.command('Browser.cancelDownload',{guid:download.guid}).catch(()=>{});
    await browser.command('Browser.setDownloadBehavior',{behavior:'default'}).catch(()=>{});
    await rm(temporary,{recursive:true,force:true});
  }
}
