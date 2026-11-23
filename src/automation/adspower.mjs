const DEFAULT_BASE = 'http://127.0.0.1:50325';
const headers = (apiKey = '') => ({'Content-Type':'application/json',...(apiKey ? {Authorization:`Bearer ${apiKey}`} : {})});
async function json(response) { const text = await response.text(); let body = {}; try { body = JSON.parse(text); } catch {} if (!response.ok || (typeof body.code === 'number' && body.code !== 0)) throw new Error(`AdsPower 请求失败: ${body.msg || response.statusText}`); return body; }
function endpoint(body) { const data = body.data || body; const ws = data.ws?.puppeteer || data.ws?.puppeteer_url || data.ws || ''; const port = data.debug_port || data.debugPort || String(ws).match(/127\.0\.0\.1:(\d+)/)?.[1] || ''; return {debugPort:String(port || ''),browserWs:typeof ws === 'string' ? ws : ''}; }
export async function startAdsPowerProfile({serialNumber,apiBase = DEFAULT_BASE,apiKey = '',signal}) { const profileNo = String(serialNumber || '').trim(); if (!profileNo) throw new Error('缺少 adsPowerSerialNumber'); const base = apiBase.replace(/\/$/,''); const payload = {profile_no:profileNo,last_opened_tabs:'0',proxy_detection:'0',password_filling:'0',password_saving:'0'}; const attempts = [() => fetch(`${base}/api/v2/browser-profile/start`,{method:'POST',headers:headers(apiKey),body:JSON.stringify(payload),signal}),() => fetch(`${base}/api/v1/browser/start?serial_number=${encodeURIComponent(profileNo)}`,{headers:headers(apiKey),signal})]; const errors = []; for (const attempt of attempts) { try { const result = endpoint(await json(await attempt())); if (result.debugPort || result.browserWs) return {serialNumber:profileNo,...result}; } catch (error) { errors.push(error.message); } } throw new Error(`无法启动 AdsPower 编号 ${profileNo}: ${errors.join(' | ')}`); }
export async function stopAdsPowerProfile({serialNumber, apiBase = DEFAULT_BASE, apiKey = ''}) {
  try {
    // 任务已结束后的关闭请求最多等 5 秒，避免 AdsPower API 无响应一直占用并发位；这不是业务阶段时限。
    await json(await fetch(`${apiBase.replace(/\/$/,'')}/api/v1/browser/stop?serial_number=${encodeURIComponent(String(serialNumber).trim())}`, {
      headers:headers(apiKey), signal:AbortSignal.timeout(5000),
    }));
    return true;
  } catch { return false; }
}
