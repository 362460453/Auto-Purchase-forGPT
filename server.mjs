import http from 'node:http';
import {appendFile, mkdir, readFile, readdir} from 'node:fs/promises';
import {extname, isAbsolute, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runUpgradeJob} from './src/automation/gpt-upgrade.mjs';
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
  if (Array.isArray(payload.plans)) event.plans = payload.plans.map((plan) => ({title: plan.title}));
  return event;
}

async function appendEventLog(payload) {
  await mkdir(logDirectory, {recursive:true});
  await appendFile(join(logDirectory, logFileName(payload.timestamp)), `${JSON.stringify(persistedEvent(payload))}\n`, 'utf8');
}

async function recentEventLogs() {
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
  return events.slice(-1000);
}

const jobs = new Map();

const publish = (payload) => {
  const event = {timestamp:new Date().toISOString(), ...payload};
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
  if (request.method === 'POST' && request.url === '/api/jobs') {
    try { const input = await parseBody(request); if (!Array.isArray(input.rows) || !input.rows.length) throw new Error('请先导入 CSV'); if (input.rows.length > 100) throw new Error('单次最多支持 100 条记录'); const jobId = crypto.randomUUID(); const job = {stopped:false}; jobs.set(jobId, job); publish({type:'job_started',jobId,message:`任务已启动：${input.rows.length} 条，并发 ${input.concurrency || 1}`}); runUpgradeJob({...input,jobId,apiBase:input.apiBase || process.env.ADSPOWER_API_BASE,apiKey:input.apiKey || process.env.ADSPOWER_API_KEY,shouldStop:() => job.stopped,onEvent:(payload) => publish({jobId,...payload})}).then((results) => publish({type:'job_finished',jobId,results})).catch((error) => publish({type:'job_failed',jobId,message:error.message})).finally(() => jobs.delete(jobId)); send(response, 202, {jobId}); } catch (error) { send(response, 400, {error:error.message}); }
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
