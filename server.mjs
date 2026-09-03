import http from 'node:http';
import {appendFile, mkdir, readFile, readdir} from 'node:fs/promises';
import {extname, join, normalize} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runUpgradeJob} from './src/automation/gpt-upgrade.mjs';

const projectDirectory = fileURLToPath(new URL('.', import.meta.url));
const root = join(projectDirectory, 'public');
const logDirectory = join(projectDirectory, 'data', 'logs');
const port = Number(process.env.PORT || 4173);
const clients = new Set();
const types = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8'};
const send = (response, status, body) => { response.writeHead(status, {'Content-Type':'application/json; charset=utf-8'}); response.end(JSON.stringify(body)); };
const parseBody = async (request) => { let text = ''; for await (const chunk of request) text += chunk; return JSON.parse(text || '{}'); };

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

const publish = (payload) => {
  const event = {timestamp:new Date().toISOString(), ...payload};
  for (const response of clients) response.write(`data: ${JSON.stringify(event)}\n\n`);
  // 日志只保存流程状态和失败原因，不落盘 CSV、API-Key、完整卡资料或地址内容。
  void appendEventLog(event).catch((error) => console.error(`写入任务日志失败：${error.message}`));
};

http.createServer(async (request, response) => {
  if (request.url === '/api/events') { response.writeHead(200, {'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache',Connection:'keep-alive'}); clients.add(response); request.on('close', () => clients.delete(response)); return; }
  if (request.method === 'GET' && request.url === '/api/logs') {
    try { send(response, 200, await recentEventLogs()); } catch (error) { send(response, 500, {error:error.message}); }
    return;
  }
  if (request.method === 'POST' && request.url === '/api/jobs') {
    try { const input = await parseBody(request); if (!Array.isArray(input.rows) || !input.rows.length) throw new Error('请先导入 CSV'); if (input.rows.length > 100) throw new Error('单次最多支持 100 条记录'); const jobId = crypto.randomUUID(); publish({type:'job_started',jobId,message:`任务已启动：${input.rows.length} 条，并发 ${input.concurrency || 1}`}); runUpgradeJob({...input,apiBase:input.apiBase || process.env.ADSPOWER_API_BASE,apiKey:input.apiKey || process.env.ADSPOWER_API_KEY,onEvent:(payload) => publish({jobId,...payload})}).then((results) => publish({type:'job_finished',jobId,results})).catch((error) => publish({type:'job_failed',jobId,message:error.message})); send(response, 202, {jobId}); } catch (error) { send(response, 400, {error:error.message}); }
    return;
  }
  const requested = request.url === '/' ? '/index.html' : request.url.split('?')[0]; const filePath = normalize(join(root, requested));
  if (!filePath.startsWith(root)) { response.writeHead(404); response.end('Not found'); return; }
  try { response.writeHead(200, {'Content-Type':types[extname(filePath)] || 'application/octet-stream'}); response.end(await readFile(filePath)); } catch { response.writeHead(404); response.end('Not found'); }
}).listen(port, '127.0.0.1', () => console.log(`GPT upgrade console: http://127.0.0.1:${port}`));
