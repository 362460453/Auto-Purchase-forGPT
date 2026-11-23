import http from 'node:http';
import {appendFile, mkdir, readFile, readdir} from 'node:fs/promises';
import {extname, isAbsolute, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runUpgradeJob, runAdditionalJob, runAdditionalBatch} from './src/automation/gpt-upgrade.mjs';
import {resolveProSelection} from './src/automation/pro-plans.mjs';
import {resolveAdditionalOptions} from './src/automation/post-purchase.mjs';
import {createPaidProfiles} from './src/paid-profiles.mjs';
import {createJobResults} from './src/job-results.mjs';
import {invoiceDirectory} from './src/automation/invoice.mjs';
import {screenshotDirectory, clearTemporaryScreenshots} from './src/temp-screenshots.mjs';

const projectDirectory = fileURLToPath(new URL('.', import.meta.url));
const root = join(projectDirectory, 'public');
const logDirectory = join(projectDirectory, 'data', 'logs');
const port = Number(process.env.PORT || 4173);
const clients = new Set();
const types = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8'};
const send = (response, status, body) => {
  if (response.headersSent) return;
  response.writeHead(status, {'Content-Type':'application/json; charset=utf-8'});
  response.end(JSON.stringify(body));
};
const sendText = (response, status, body, headers = {}) => {
  if (response.headersSent) return;
  response.writeHead(status, headers);
  response.end(body);
};
const parseBody = async (request) => { let text = ''; for await (const chunk of request) text += chunk; return JSON.parse(text || '{}'); };

function publicFilePath(urlPath) {
  const pathname = decodeURIComponent(String(urlPath || '/').split('?')[0]);
  const relativeName = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (!relativeName || relativeName.includes('\0') || relativeName.split(/[\\/]/).includes('..')) return null;
  const filePath = resolve(root, relativeName);
  const rel = relative(root, filePath);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return filePath;
}

function logFileName(timestamp) {
  return `events-${timestamp.slice(0, 10)}.jsonl`;
}

function persistedEvent(payload) {
  const event = {
    timestamp: payload.timestamp,
    type: payload.type,
    jobId: payload.jobId,
    index: Number.isInteger(payload.index) ? payload.index : undefined,
    message: payload.message,
  };
  if (payload.type === 'row_payment_confirmed' || payload.paymentReviewRequired) {
    event.serialNumber = payload.serialNumber; event.subscriptionType = payload.subscriptionType;
    if (payload.paymentReviewRequired) event.paymentReviewRequired = true;
  }
  if (Array.isArray(payload.plans)) event.plans = payload.plans.map((plan) => ({title: plan.title}));
  return event;
}

async function appendEventLog(payload) {
  await mkdir(logDirectory, {recursive:true});
  await appendFile(join(logDirectory, logFileName(payload.timestamp)), `${JSON.stringify(persistedEvent(payload))}\n`, 'utf8');
}

async function recentEventLogs(limit = 1000) {
  await mkdir(logDirectory, {recursive:true});
  const events = [];
  for (const name of (await readdir(logDirectory)).filter((item) => item.endsWith('.jsonl')).sort()) {
    const content = await readFile(join(logDirectory, name), 'utf8');
    for (const line of content.split('\n').filter(Boolean)) {
      try {
        const event = JSON.parse(line);
        events.push(event);
      } catch {
        // 单行日志损坏不影响其余任务日志读取。
      }
    }
  }
  return limit ? events.slice(-limit) : events;
}

const jobs = new Map();
const privateResults = createJobResults();
// 从全部本地成功事件恢复付款记录，热更新或重新导入后仍禁止重复充值。
const paidProfiles = createPaidProfiles(await recentEventLogs(0));
const busyProfiles = new Set();

const publish = (payload) => {
  const event = privateResults.capture({timestamp:new Date().toISOString(), ...payload});
  paidProfiles.capture(event);
  for (const client of [...clients]) {
    try { client.write(`data: ${JSON.stringify(event)}\n\n`); }
    catch { clients.delete(client); }
  }
  // 日志只保存流程状态和失败原因，不落盘 CSV、API-Key、完整卡资料或地址内容。
  void appendEventLog(event).catch((error) => console.error(`写入任务日志失败：${error.message}`));
};

http.createServer(async (request, response) => {
  try {
    await handleRequest(request, response);
  } catch (error) {
    console.error(`请求处理失败：${error.message}`);
    sendText(response, 500, 'Internal Server Error');
  }
}).listen(port, '127.0.0.1', () => console.log(`GPT upgrade console: http://127.0.0.1:${port}`));

async function handleRequest(request, response) {
  const resultMatch = request.url.match(/^\/api\/jobs\/([a-zA-Z0-9-]+)\/results$/);
  if (request.method === 'GET' && resultMatch) {
    const result = privateResults.read(resultMatch[1], String(request.headers.authorization || '').replace(/^Bearer /, ''));
    response.setHeader('Cache-Control', 'no-store');
    send(response, result ? 200 : 403, result || {error:'无权读取本批任务结果'});
    return;
  }
  const invoiceMatch=request.url.match(/^\/api\/jobs\/([a-zA-Z0-9-]+)\/invoices\/(\d+)$/);
  if(request.method==='GET'&&invoiceMatch){
    const result=privateResults.read(invoiceMatch[1],String(request.headers.authorization||'').replace(/^Bearer /,''));
    response.setHeader('Cache-Control','no-store');
    if(!result){send(response,403,{error:'无权读取本批发票'});return;}
    const file=result.find(row=>row.index===Number(invoiceMatch[2]))?.invoiceFileName;
    if(!/^invoice-[0-9a-f-]{36}\.pdf$/.test(file||'')){send(response,404,{error:'本行尚无已下载发票'});return;}
    try{sendText(response,200,await readFile(join(invoiceDirectory,file)),{'Content-Type':'application/pdf','Content-Disposition':'attachment; filename="invoice.pdf"','Cache-Control':'no-store'});}
    catch{send(response,404,{error:'发票文件不存在，请单独重新下载'});}
    return;
  }
  if (request.url === '/api/events') {
    response.writeHead(200, {'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache',Connection:'keep-alive'});
    clients.add(response);
    request.on('close', () => clients.delete(response));
    return;
  }
  if (request.method === 'GET' && request.url === '/api/logs') {
    try { send(response, 200, await recentEventLogs()); } catch (error) { send(response, 500, {error:error.message}); }
    return;
  }
  if (request.method === 'GET' && request.url === '/api/paid-profiles') {
    response.setHeader('Cache-Control', 'no-store');
    send(response, 200, paidProfiles.list());
    return;
  }
  if (request.method === 'POST' && ['/api/jobs', '/api/jobs/additional'].includes(request.url)) {
    try {
      const input = await parseBody(request);
      const additional = request.url.endsWith('/additional');
      if(input.purchase!==undefined&&typeof input.purchase!=='boolean')throw new Error('充值选项必须是布尔值');
      const purchase=!additional&&input.purchase!==false;
      if(!purchase&&input.rechargeType&&input.rechargeType!=='ads')throw new Error('仅 AdsPower 支持独立附加任务');
      const taskRows = additional ? [input.row] : input.rows;
      if (!Array.isArray(taskRows) || !taskRows.length || taskRows.some(row => !row || typeof row !== 'object')) throw new Error('请先导入 CSV');
      if (taskRows.length > 100) throw new Error('单次最多支持 100 条记录');
      // 兼容旧控制台：AdsPower 任务不接收密码，登录失效时改为等待人工处理。
      if (!additional && input.rechargeType !== 'google-incognito') {
        input.rows = taskRows.map(({password: _ignored, ...row}) => row);
      }
      if (additional) {
        if (!['screenshot', 'invoice', 'cpa', '2fa'].includes(input.option)) throw new Error('请选择一个附加功能');
        if (!Number.isInteger(input.row.__uiIndex) || input.row.__uiIndex < 0 || input.row.__uiIndex >= 100) throw new Error('任务行号无效');
      } else {
        const indexes = taskRows.map((row, index) => row.__uiIndex ?? index);
        if (indexes.some(index => !Number.isInteger(index) || index < 0 || index >= 100) || new Set(indexes).size !== indexes.length) {
          throw new Error('任务行号无效或重复');
        }
        if(purchase)resolveProSelection(input);
        input.additionalOptions = resolveAdditionalOptions(input.additionalOptions, input.rechargeType);
      }
      if(!purchase){
        const options=additional?[input.option]:input.additionalOptions;
        if(!options.length)throw new Error('请至少选择充值或一个附加功能');
        if(options.includes('cpa')&&taskRows.some(row=>!row.email))throw new Error('CPA 需要当前行邮箱');
        if(!additional)input.rows=taskRows.map((row,index)=>({adsPowerSerialNumber:row.adsPowerSerialNumber,email:row.email,__uiIndex:row.__uiIndex??index}));
      }
      const serials = !purchase || input.rechargeType !== 'google-incognito'
        ? taskRows.map(row => String(row.adsPowerSerialNumber || '').trim()) : [];
      if (serials.some(serial => !serial)) throw new Error('AdsPower 编号不能为空');
      if (new Set(serials).size !== serials.length) throw new Error('同一批次不能重复使用同一个 Profile');
      if (serials.some(serial => busyProfiles.has(serial))) throw new Error('该 Profile 正在执行任务，请等待结束');
      if (purchase && serials.some(serial => paidProfiles.has(serial))) throw new Error('存在已付款的 Profile，请取消勾选充值后运行附加功能');
      if (purchase && serials.some(serial => paidProfiles.needsReview(serial))) throw new Error('存在支付结果待核实的 Profile，请先核对账单，不能直接重复充值');
      const jobId = crypto.randomUUID();
      const resultToken = privateResults.create(jobId);
      const job = {stopped:false, rowControls:new Map()};
      jobs.set(jobId, job);
      serials.forEach(serial => busyProfiles.add(serial));
      const common = {jobId, apiBase:input.apiBase || process.env.ADSPOWER_API_BASE,
        apiKey:input.apiKey || process.env.ADSPOWER_API_KEY, onEvent:payload => publish({jobId, ...payload}),
        registerRowControl:(index, stop) => {
          job.rowControls.set(index, stop);
          return () => { if (job.rowControls.get(index) === stop) job.rowControls.delete(index); };
        }};
      publish({type:'job_started',jobId,purchase,message:additional ? '独立附加任务已启动' : `${purchase?'充值任务':'附加任务'}已启动：${taskRows.length} 条，并发 ${input.concurrency || 1}`});
      // 独立入口只传账号与 Profile，根本不进入购买服务，也不传银行卡或账单地址。
      const work = additional
        ? runAdditionalJob({...common, option:input.option, row:{adsPowerSerialNumber:input.row.adsPowerSerialNumber,
          email:input.row.email, __uiIndex:input.row.__uiIndex}, paymentConfirmed:paidProfiles.has(input.row.adsPowerSerialNumber)})
        : purchase ? runUpgradeJob({...input, ...common, shouldStop:() => job.stopped})
        : runAdditionalBatch({...common, rows:input.rows, additionalOptions:input.additionalOptions, concurrency:input.concurrency, shouldStop:()=>job.stopped, isPaid:serial=>paidProfiles.has(serial)});
      work.then(results => publish({type:'job_finished',jobId,results}))
        .catch(() => publish({type:'job_failed',jobId,message:'任务执行异常，请检查当前附加结果及浏览器状态'}))
        .finally(() => { jobs.delete(jobId); serials.forEach(serial => busyProfiles.delete(serial)); });
      send(response, 202, {jobId, resultToken});
    } catch (error) { send(response, 400, {error:error.message}); }
    return;
  }
  const stopRowMatch = request.url.match(/^\/api\/jobs\/([a-zA-Z0-9-]+)\/rows\/(\d+)\/stop$/);
  if (request.method === 'POST' && stopRowMatch) {
    const [, jobId, rawIndex] = stopRowMatch;
    const index = Number(rawIndex);
    if (!Number.isInteger(index) || index < 0 || index >= 100) { send(response, 400, {error:'任务行号无效'}); return; }
    const job = jobs.get(jobId);
    if (!job) { send(response, 404, {error:'该批任务已结束'}); return; }
    const token = String(request.headers.authorization || '').replace(/^Bearer /, '');
    if (!privateResults.read(jobId, token)) { send(response, 403, {error:'无权终止本批任务'}); return; }
    // 只查当前批次的原 UI 行号；取消不会修改停止排队标记，也不会中止其他并发 Profile。
    const stop = job.rowControls.get(index);
    if (!stop) { send(response, 409, {error:'该行尚未执行或已经结束'}); return; }
    send(response, 202, {accepted:stop()});
    return;
  }
  if (request.method === 'POST' && request.url === '/api/jobs/stop') {
    // 只停止领取排队任务，已经在跑的条目继续跑完，不强制关闭其他并发 Profile。
    let stopped = 0;
    for (const job of jobs.values()) {
      if (!job.stopped) {
        job.stopped = true;
        stopped += 1;
      }
    }
    if (stopped) publish({type:'job_stop_requested',message:'已终止排队任务，正在运行的任务会继续跑完'});
    send(response, 202, {stopped});
    return;
  }
  if (request.method === 'GET' && request.url.startsWith('/api/screenshots/')) {
    const name = decodeURIComponent(request.url.slice('/api/screenshots/'.length).split('?')[0]);
    if (!/^[a-zA-Z0-9._-]+$/.test(name) || !name.endsWith('.png')) {
      sendText(response, 404, 'Not found');
      return;
    }
    try {
      const image = await readFile(join(screenshotDirectory, name));
      sendText(response, 200, image, {'Content-Type':'image/png','Cache-Control':'no-store'});
    } catch {
      sendText(response, 404, 'Not found');
    }
    return;
  }
  const pathname = String(request.url || '/').split('?')[0];
  if (pathname === '/favicon.ico') {
    sendText(response, 204, '');
    return;
  }
  const filePath = publicFilePath(pathname);
  if (!filePath) {
    sendText(response, 404, 'Not found');
    return;
  }
  try {
    const body = await readFile(filePath);
    sendText(response, 200, body, {'Content-Type':types[extname(filePath)] || 'application/octet-stream'});
  } catch {
    sendText(response, 404, 'Not found');
  }
}

process.on('SIGINT', () => {
  // 直接跑 server.mjs 时，Ctrl+C 视为关闭项目，删掉本次临时截图。
  void clearTemporaryScreenshots().finally(() => process.exit(0));
});
