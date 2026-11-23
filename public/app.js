import { buildResultsCsv, twoFactorStatusText, cpaStatusText, invoiceStatusText } from './task-export.js';

const $ = (selector) => document.querySelector(selector);
const csvColumns = {
  ads: ['adsPowerSerialNumber', 'email', 'cardNumber', 'expires_at', 'cvv'],
  'google-incognito': ['email', 'password', 'cardNumber', 'expires_at', 'cvv', 'mailAccess'],
};
let rechargeType = 'ads';
let rows = [];
const rowStates = [];
let failedIndexes = [];
let jobRunning = false;
let stopRequested = false;
let activeResultAccess = null;
let resultAccesses = [];
const defaultSettings = { apiBase: 'http://127.0.0.1:50325', apiKey: '' };
function storedSettings() {
  try { return JSON.parse(localStorage.getItem('gpt-upgrade-settings') || '{}'); }
  catch { return {}; }
}
const stored = storedSettings();
const settings = {
  apiBase: stored.apiBase || defaultSettings.apiBase,
  apiKey: typeof stored.apiKey === 'string' ? stored.apiKey : defaultSettings.apiKey,
};
// 用户提供的 OR 地址按整条维护；街道、城市、州、邮编不得拆开随机组合。
const OR_BILLING_ADDRESSES = Object.freeze([
  { street: '2219 School Street', city: 'Salem', state: 'OR', zip: '97463' },
  { street: '819 E 3rd Street', city: 'Eugene', state: 'OR', zip: '97302' },
  { street: '279 Bud View', city: 'Amity', state: 'OR', zip: '97496' },
  { street: '381 Anastacio Lake', city: 'Brookings', state: 'OR', zip: '97063' },
  { street: '839 Riverside Drive', city: 'Salem', state: 'OR', zip: '97431' },
  { street: '13631 Meadow Drive', city: 'Salem', state: 'OR', zip: '97216' },
  { street: '51683 S 1st Avenue', city: 'Adair Village', state: 'OR', zip: '97207' },
  { street: '523 Herman View', city: 'Adrian', state: 'OR', zip: '97286' },
  { street: '7119 Stoney Lane', city: 'Athena', state: 'OR', zip: '97335' },
  { street: '67649 Mills Divide', city: 'Gresham', state: 'OR', zip: '97075' },
  { street: '8228 Carolanne River', city: 'Portland', state: 'OR', zip: '97603' },
  { street: '64341 The Croft', city: 'Brookings', state: 'OR', zip: '97355' },
  { street: '13325 S Division Street', city: 'Athena', state: 'OR', zip: '97135' },
  { street: '4193 Whitney Junctions', city: 'Bandon', state: 'OR', zip: '97343' },
  { street: '553 McDermott Hollow', city: 'Brownsville', state: 'OR', zip: '97389' },
  { street: '80937 Patrick Lakes', city: 'Banks', state: 'OR', zip: '97601' },
  { street: '185 Providenci Fort', city: 'Albany', state: 'OR', zip: '97011' },
  { street: '11667 Spencer Mews', city: 'Arlington', state: 'OR', zip: '97415' },
  { street: '3014 Kuhic Crest', city: 'Astoria', state: 'OR', zip: '97535' },
  { street: '9693 Cronin Ports', city: 'Aumsville', state: 'OR', zip: '97371' },
  { street: '1970 Kub Coves', city: 'Brownsville', state: 'OR', zip: '97031' },
  { street: '363 Amely Falls', city: 'Burns', state: 'OR', zip: '97055' },
  { street: '925 Howard Street', city: 'Aurora', state: 'OR', zip: '97442' },
].map(address => Object.freeze(address)));
const billingStateDirectory = {
  OR: { label: 'Oregon / 俄勒冈州', addresses: OR_BILLING_ADDRESSES },
};
const givenNames = ['James', 'Michael', 'Robert', 'David', 'William', 'John', 'Daniel', 'Matthew', 'Andrew', 'Joseph', 'Christopher', 'Ryan', 'Brian', 'Kevin', 'Jason', 'Eric', 'Mark', 'Thomas', 'Scott', 'Jeffrey', 'Mary', 'Jennifer', 'Linda', 'Patricia', 'Elizabeth', 'Barbara', 'Susan', 'Jessica', 'Sarah', 'Karen', 'Nancy', 'Lisa', 'Betty', 'Margaret', 'Sandra', 'Ashley', 'Kimberly', 'Emily', 'Donna', 'Michelle'];
const familyNames = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Miller', 'Davis', 'Wilson', 'Anderson', 'Taylor', 'Thomas', 'Moore', 'Martin', 'Jackson', 'Thompson', 'White', 'Harris', 'Clark', 'Lewis', 'Walker', 'Hall', 'Allen', 'Young', 'King', 'Wright', 'Scott', 'Green', 'Baker', 'Adams', 'Nelson', 'Hill', 'Ramirez', 'Campbell', 'Mitchell', 'Roberts', 'Carter', 'Phillips', 'Evans', 'Turner', 'Parker'];

function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (character) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character])); }
function parseCsv(text) {
  const records = [];
  let record = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') { field += '"'; index += 1; }
      else quoted = !quoted;
    } else if (character === ',' && !quoted) {
      record.push(field.trim()); field = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      record.push(field.trim()); field = '';
      if (record.some(Boolean)) records.push(record);
      record = [];
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error('CSV 存在未闭合的双引号');
  if (field || record.length) { record.push(field.trim()); if (record.some(Boolean)) records.push(record); }
  return records;
}
function csvRows(text, type) {
  const records = parseCsv(text);
  const header = (records.shift() || []).map((value, index) => index === 0 ? value.replace(/^\uFEFF/, '') : value);
  const requiredColumns = csvColumns[type] || csvColumns.ads;
  const missing = requiredColumns.filter((column) => !header.includes(column));
  if (missing.length) throw new Error(`CSV 缺少字段：${missing.join('、')}`);
  // AdsPower 只按五列表头取值，旧模板里的密码及其他附加列不进入任务内存或请求。
  const importedColumns = type === 'google-incognito' ? header : requiredColumns;
  return records.map((values) => Object.fromEntries(importedColumns.map((key) => [key, values[header.indexOf(key)] || ''])));
}
function randomInt(maxExclusive) {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return values[0] % maxExclusive;
}
function pick(list) {
  return list[randomInt(list.length)];
}
function generateBillingAddress(state) {
  const directory = billingStateDirectory[state];
  if (!directory) throw new Error(`不支持的 Billing 地址州：${state}`);
  const address = pick(directory.addresses);
  return {
    billingName: `${pick(givenNames)} ${pick(familyNames)}`,
    billingAddressLine1: address.street,
    billingAddressLine2: '',
    billingCity: address.city,
    billingState: address.state,
    billingPostalCode: address.zip,
    billingCountry: 'US',
  };
}
function renderBillingStates() {
  const select = $('#billing-state');
  const currentState = select.value || 'OR';
  const states = Object.keys(billingStateDirectory);
  select.innerHTML = states.map((state) => `<option value="${escapeHtml(state)}">${escapeHtml(billingStateDirectory[state].label)}</option>`).join('');
  select.value = states.includes(currentState) ? currentState : 'OR';
}
function bindBillingAddresses(taskRows, state) {
  return taskRows.map((row) => {
    const address = generateBillingAddress(state);
    // 地址在导入时从所选州常量池整条抽取并固定到当前任务行，执行和手动重试都复用同一地址，禁止跨行临时换地址。
    return {...row, ...address, billingRegionLabel: billingStateDirectory[state]?.label || state};
  });
}
function billingAddressText(row) {
  return [row.billingName, row.billingAddressLine1, row.billingAddressLine2, row.billingCity, row.billingState, row.billingPostalCode, 'United States']
    .filter(Boolean)
    .join(', ');
}
function canRetryRow(index) {
  const state = rowStates[index] || {};
  return !jobRunning && !state.paymentConfirmed && !state.paymentReviewRequired && !['执行中', '已完成', '待核实'].includes(state.status);
}
function canStopRow(index) {
  const state = rowStates[index];
  return Boolean(jobRunning && activeResultAccess && state?.jobId === activeResultAccess.jobId
    && (state.status === '执行中' || state.additionalRunning) && !state.rowStopRequested);
}
async function stopRow(index) {
  if (!Number.isInteger(index) || !canStopRow(index)) return;
  const access = activeResultAccess;
  const state = rowStates[index];
  state.rowStopRequested = true;
  renderRows();
  try {
    const response = await fetch(`/api/jobs/${access.jobId}/rows/${index}/stop`, {
      method:'POST', headers:{Authorization:`Bearer ${access.resultToken}`},
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || '终止本行失败');
    // 等待终态事件再解锁；HTTP 202 只表示中断已受理，不能提前允许同一个 Profile 再次启动。
  } catch (error) {
    if (activeResultAccess !== access) return;
    rowStates[index].rowStopRequested = false;
    $('#activity').textContent = error.message || '终止本行失败，请重试';
    renderRows();
  }
}
function canContinueFromRow(index) {
  return Number.isInteger(index) && index >= 0 && index < rows.length
    && rows.slice(index).some((_, offset) => canRetryRow(index + offset));
}
function startFromRow(index) {
  if (!canContinueFromRow(index)) return;
  // 从本行向下按原列表顺序提交，保留原行号及首次绑定资料；已付款/已完成行不重复充值。
  const taskRows = rows.slice(index)
    .map((row, offset) => ({...row, __uiIndex:index + offset}))
    .filter((row) => canRetryRow(row.__uiIndex));
  return startJob(taskRows);
}
const additionalLabels = {screenshot:'截图', invoice:'下载发票', cpa:'CPA', '2fa':'2FA'};
function canRunAdditional(index) {
  return rechargeType === 'ads' && !jobRunning && (rowStates[index]?.paymentConfirmed || rowStates[index]?.status === '已完成');
}
async function recoverPaidRows() {
  if (rechargeType !== 'ads') return;
  const snapshot = rows;
  const response = await fetch('/api/paid-profiles', {cache:'no-store'});
  if (!response.ok) throw new Error('付款记录读取失败，请稍后重试');
  const records = await response.json();
  if (snapshot !== rows) return;
  const paid = new Map(records.map(record => [record.serialNumber, record]));
  rows.forEach((row, index) => {
    const record = paid.get(String(row.adsPowerSerialNumber).trim());
    if (!record) return;
    if (record.paymentReviewRequired) {
      rowStates[index] = {...rowStates[index], paymentReviewRequired:true, status:'待核实',
        reason:'付款已提交但结果未确认，请先核对账单，禁止直接重复充值', subscriptionType:record.subscriptionType};
      failedIndexes = failedIndexes.filter(item => item !== index);
      return;
    }
    rowStates[index] = {...rowStates[index], paymentConfirmed:true, status:'已完成', reason:'',
      subscriptionType:record.subscriptionType || rowStates[index]?.subscriptionType || 'Pro / 历史付款记录',
      completedAt:rowStates[index]?.completedAt || record.paidAt};
    failedIndexes = failedIndexes.filter(item => item !== index);
  });
}
function renderRows() {
  $('#password-heading').hidden = rechargeType === 'ads';
  $('#task-body').innerHTML = rows.map((row, index) => {
    const state = rowStates[index] || {};
    const reason = state.reason || [state.screenshotError, state.invoiceError, state.cpaError, state.twoFactorError].filter(Boolean).join('；');
    const reasonAttr = reason ? ` class="reason-cell" data-reason="${escapeHtml(reason)}" title="单击放大"` : '';
    const retryDisabled = canRetryRow(index) ? '' : ' disabled';
    const continueDisabled = canContinueFromRow(index) ? '' : ' disabled';
    const stopButton = state.status === '执行中' || state.additionalRunning
      ? `<button type="button" class="row-stop" data-stop-index="${index}" title="结束本行等待并关闭浏览器，后续排队任务继续；不能撤销已提交的支付"${canStopRow(index) ? '' : ' disabled'}>${state.rowStopRequested ? '终止中…' : '终止本行'}</button>` : '';
    const screenshot = state.screenshotUrl
      ? `<button type="button" class="row-shot" data-screenshot="${escapeHtml(state.screenshotUrl)}" title="单击放大"><img src="${escapeHtml(state.screenshotUrl)}" alt="Billing 截图"></button>`
      : escapeHtml(state.screenshotError ? '截图失败' : '');
    const copyDisabled = state.screenshotUrl ? '' : ' disabled';
    const additionalButtons = rechargeType === 'ads' ? Object.entries(additionalLabels).map(([option, label]) =>
      `<button type="button" class="row-additional" data-additional="${option}" data-row-index="${index}" title="单独执行${label}，保留付款结果"${canRunAdditional(index) ? '' : ' disabled'}>${state.additionalRunning === option ? `${label}中…` : label}</button>`).join('') : '';
    const passwordCell = rechargeType === 'google-incognito' ? `<td>${escapeHtml(row.password)}</td>` : '';
    return `<tr><td>${escapeHtml(row.adsPowerSerialNumber)}</td><td>${escapeHtml(row.email)}</td>${passwordCell}<td>${escapeHtml(row.cardNumber)}</td><td>${escapeHtml(row.expires_at)}</td><td>${escapeHtml(row.cvv)}</td><td title="${escapeHtml(billingAddressText(row))}">${escapeHtml(billingAddressText(row))}</td><td>${escapeHtml(state.rowStopRequested ? '终止中…' : state.status || '待执行')}</td><td>${escapeHtml(twoFactorStatusText(state))}</td><td>${escapeHtml(cpaStatusText(state))}</td><td>${escapeHtml(invoiceStatusText(state))}${state.invoiceFileName ? `<button type="button" class="secondary" data-save-invoice="${index}">保存发票</button>` : ''}</td><td${reasonAttr}>${escapeHtml(reason)}</td><td class="row-actions"><button type="button" class="row-retry" data-retry-index="${index}"${retryDisabled}>重试</button><button type="button" class="row-continue" data-continue-index="${index}" title="从本行往下执行，跳过已完成或已付款行"${continueDisabled}>从本行继续</button>${stopButton}${additionalButtons}</td><td><button type="button" class="row-copy" data-copy-screenshot="${escapeHtml(state.screenshotUrl || '')}"${copyDisabled}>复制</button></td><td>${screenshot}</td></tr>`;
  }).join('');
  $('#export-results').disabled = rows.length === 0;
  for (const control of document.querySelectorAll('#csv-file, #recharge-type, #billing-state, #concurrency, input[name=planAmount], input[name=multiplier], input[name=additionalOptions]')) control.disabled = jobRunning || (control.name === 'additionalOptions' && ['invoice', 'cpa', '2fa'].includes(control.value) && rechargeType !== 'ads');
  $('#task-count').textContent = `${rows.length} 条`;
  $('#task-table-wrap').classList.toggle('scrollable', rows.length > 10);
  $('#task-list').hidden = false; $('#start').disabled = jobRunning || rows.length === 0 || !rows.some((_, index) => canRetryRow(index)); $('#retry-failed').disabled = jobRunning || failedIndexes.length === 0; $('#stop-all').disabled = !jobRunning || stopRequested;
}
function loadSettingsForm() { $('#adspower-api-base').value = settings.apiBase; $('#adspower-api-key').value = settings.apiKey; }
$('#settings-open').addEventListener('click', () => { loadSettingsForm(); $('#settings-dialog').showModal(); });
$('#settings-cancel').addEventListener('click', () => $('#settings-dialog').close());
$('#settings-form').addEventListener('submit', (event) => {
  event.preventDefault();
  settings.apiBase = $('#adspower-api-base').value.trim().replace(/\/$/, '');
  settings.apiKey = $('#adspower-api-key').value.trim();
  localStorage.setItem('gpt-upgrade-settings', JSON.stringify({ apiBase: settings.apiBase, apiKey: settings.apiKey }));
  $('#settings-dialog').close();
  $('#activity').textContent = 'AdsPower 设置已保存';
});
$('#recharge-type').addEventListener('change', (event) => {
  activeResultAccess = null;
  resultAccesses = [];
  rechargeType = event.target.value;
  for (const option of document.querySelectorAll('input[name=additionalOptions]')) {
    option.disabled = ['invoice', 'cpa', '2fa'].includes(option.value) && rechargeType !== 'ads';
    if (option.disabled) option.checked = false;
  }
  $('#ads-plan-options').hidden = rechargeType !== 'ads';
  $('#incognito-plan-options').hidden = rechargeType === 'ads';
  rows = [];
  rowStates.length = 0;
  failedIndexes = [];
  $('#csv-file').value = '';
  $('#file-name').textContent = '尚未选择文件';
  $('#validation').hidden = true;
  $('#task-list').hidden = true;
  $('#start').disabled = true;
  $('#export-results').disabled = true;
  $('#activity').textContent = rechargeType === 'ads' ? '当前为 AdsPower 充值' : '当前为谷歌无痕模式充值';
});
$('#csv-file').addEventListener('change', async (event) => { try { const importedRows = csvRows(await event.target.files[0].text(), rechargeType); if (!importedRows.length) throw new Error('CSV 没有账号记录'); if (importedRows.length > 100) throw new Error('单次最多支持 100 条记录'); activeResultAccess = null; resultAccesses = []; rows = bindBillingAddresses(importedRows, $('#billing-state').value); rowStates.length = rows.length; rowStates.fill({}); failedIndexes = []; await recoverPaidRows(); $('#file-name').textContent = `${event.target.files[0].name} · ${rows.length} 条 · ${rechargeType === 'ads' ? 'AdsPower' : '谷歌无痕模式'} · ${$('#billing-state').selectedOptions[0].textContent}`; $('#validation').hidden = true; renderRows(); } catch (error) { rows = []; rowStates.length = 0; failedIndexes = []; renderRows(); $('#validation').hidden = false; $('#validation').textContent = error.message; $('#start').disabled = true; } });
$('#download-template').addEventListener('click', (event) => {
  event.preventDefault();
  const columns = csvColumns[rechargeType] || csvColumns.ads;
  const header = columns.join(',');
  const example = rechargeType === 'ads'
    ? '10001,name@example.com,4111111111111111,0931,123'
    : 'name@example.com,填入邮箱密码,4111111111111111,0931,123,name@example.com----client_id----refresh_token';
  const blob = new Blob([`${header}\n${example}\n`], {type:'text/csv'});
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'gpt-upgrade-template.csv';
  link.click();
  URL.revokeObjectURL(link.href);
});
function appendEventLog(payload) {
  const timestamp = new Date(payload.timestamp || Date.now()).toLocaleString('zh-CN', {hour12:false});
  const item = document.createElement('li');
  item.textContent = `[${timestamp}] ${payload.message || payload.type}`;
  $('#events').prepend(item);
  while ($('#events').children.length > 1000) $('#events').lastElementChild.remove();
  $('#events').classList.toggle('scrollable', $('#events').children.length > 10);
}
fetch('/api/logs').then((response) => response.ok ? response.json() : []).then((logs) => logs.forEach(appendEventLog)).catch(() => {});
async function refreshPrivateResults() {
  const accesses = resultAccesses;
  for (const access of accesses) {
    // 已缓存在页面的结果服务关闭后仍可导出；只补取通知中存在但尚未收到的秘密。
    const needs = (state, key) => (state?.[`${key}JobId`] || state?.jobId) === access.jobId
      && state?.[`${key}Available`] && state?.[`${key}LoadedJobId`] !== access.jobId;
    if (!rowStates.some(state => ['twoFactorKey', 'cpaJson', 'invoiceFileName'].some(key => needs(state, key)))) continue;
    // 令牌只留在当前页面内存，Key 不经过广播、URL、localStorage 或执行日志。
    const response = await fetch(`/api/jobs/${access.jobId}/results`, {
      headers: {Authorization:`Bearer ${access.resultToken}`}, cache:'no-store',
    });
    if (!response.ok) throw new Error('CPA / 2FA 私有结果读取失败，请勿刷新页面，稍后再次导出');
    const results = await response.json();
    if (accesses !== resultAccesses) return;
    for (const result of results) {
      const state = rowStates[result.index];
      if (!state) continue;
      for (const key of ['twoFactorKey', 'cpaJson', 'invoiceFileName']) {
        if (!needs(state, key)) continue;
        // 新的独立任务可以替换同项结果；空失败结果不得抹掉上次已拿到的秘密。
        if (typeof result[key] === 'string' && result[key]) state[key] = result[key];
        state[`${key}LoadedJobId`] = access.jobId;
      }
    }
  }
  renderRows();
}
const events = new EventSource('/api/events');
events.onmessage = (event) => {
  const payload = JSON.parse(event.data);
  if (activeResultAccess && payload.jobId && payload.jobId !== activeResultAccess.jobId) return;
  $('#activity').textContent = payload.message || payload.type;
  if (payload.type === 'job_stop_requested') { stopRequested = true; renderRows(); }
  if (payload.type === 'job_finished' || payload.type === 'job_failed') {
    jobRunning = false; stopRequested = false;
    for (const state of rowStates) {
      state.rowStopRequested = false;
      if (state.additionalRunning) {
        const prefix = state.additionalRunning === '2fa' ? 'twoFactor' : state.additionalRunning;
        state[`${prefix}Status`] = 'failed'; state[`${prefix}Error`] = '附加任务中断，请单独重试';
        state.additionalRunning = '';
      }
    }
    renderRows();
  }
  if (Number.isInteger(payload.index) && rowStates[payload.index]) {
    const previous = rowStates[payload.index];
    if (payload.type === 'row_stop_requested') previous.rowStopRequested = true;
    if (['row_succeeded', 'row_failed', 'row_cancelled', 'additional_finished'].includes(payload.type)) previous.rowStopRequested = false;
    if (payload.type === 'row_payment_confirmed') {
      previous.paymentConfirmed = true;
      previous.subscriptionType = payload.subscriptionType || previous.subscriptionType;
    }
    if (['additional_started', 'additional_progress', 'additional_finished'].includes(payload.type)) {
      const prefix = payload.option === '2fa' ? 'twoFactor' : payload.option;
      const key = payload.option === '2fa' ? 'twoFactorKey' : payload.option === 'cpa' ? 'cpaJson' : payload.option === 'invoice' ? 'invoiceFileName' : 'screenshotUrl';
      const patch = {jobId:payload.jobId, paymentConfirmed:true, status:'已完成', reason:'',
        additionalRunning:payload.type === 'additional_finished' ? '' : payload.option};
      for (const field of [`${prefix}Status`, `${prefix}Error`]) if (field in payload) patch[field] = payload[field];
      if (key === 'screenshotUrl') { if (payload[key]) patch[key] = payload[key]; }
      else if (payload[`${key}Available`]) {
        patch[`${key}Available`] = true; patch[`${key}JobId`] = payload.jobId;
      }
      rowStates[payload.index] = {...previous, ...patch};
    }
    // 保留每行本次执行的套餐快照，后续修改全局规格不能改写已完成账号的导出结果。
    if (payload.type === 'row_started' || payload.type === 'browser_started') {
      rowStates[payload.index] = {...previous, jobId:payload.jobId, status:'执行中', reason:'', screenshotUrl:'', screenshotError:'', invoiceFileName:'', invoiceError:'', invoiceStatus:'', completedAt:'',
        subscriptionType:payload.subscriptionType || previous.subscriptionType,
        additionalOptions:payload.additionalOptions || previous.additionalOptions};
    }
    if (payload.type === 'row_failed') {
      rowStates[payload.index] = {...previous, status:'失败', reason:payload.message || '未知异常', completedAt:payload.timestamp};
      failedIndexes = [...new Set([...failedIndexes, payload.index])];
    }
    if (payload.type === 'post_purchase_progress') {
      rowStates[payload.index] = {...previous, screenshotUrl:payload.screenshotUrl || '',
        screenshotError:payload.screenshotError || '', screenshotStatus:payload.screenshotStatus,
        invoiceStatus:payload.invoiceStatus, invoiceError:payload.invoiceError || '', invoiceFileNameAvailable:payload.invoiceFileNameAvailable,
        twoFactorStatus:payload.twoFactorStatus, twoFactorError:payload.twoFactorError || '',
        cpaStatus:payload.cpaStatus, cpaError:payload.cpaError || '', cpaJsonAvailable:payload.cpaJsonAvailable,
        twoFactorKeyAvailable:payload.twoFactorKeyAvailable};
    }
    if (payload.type === 'row_succeeded') {
      rowStates[payload.index] = {...previous, paymentConfirmed:true, status:'已完成', reason:'', screenshotUrl:payload.screenshotUrl || '',
        screenshotError:payload.screenshotError || '', screenshotStatus:payload.screenshotStatus,
        invoiceStatus:payload.invoiceStatus, invoiceError:payload.invoiceError || '', invoiceFileNameAvailable:payload.invoiceFileNameAvailable, completedAt:payload.timestamp,
        twoFactorStatus:payload.twoFactorStatus, twoFactorError:payload.twoFactorError || '',
        cpaStatus:payload.cpaStatus, cpaError:payload.cpaError || '', cpaJsonAvailable:payload.cpaJsonAvailable,
        twoFactorKeyAvailable:payload.twoFactorKeyAvailable};
      failedIndexes = failedIndexes.filter((index) => index !== payload.index);
    }
    if (payload.type === 'row_cancelled') {
      rowStates[payload.index] = {...previous, paymentReviewRequired:Boolean(payload.paymentReviewRequired), status:payload.paymentReviewRequired ? '待核实' : '已取消', reason:payload.message || '排队任务已终止，未开始执行', completedAt:payload.timestamp};
      failedIndexes = failedIndexes.filter((index) => index !== payload.index);
    }
    if (payload.type === 'payment_confirmation_required') {
      rowStates[payload.index] = {...previous, status:'待人工支付', reason:''};
      failedIndexes = failedIndexes.filter((index) => index !== payload.index);
    }
    renderRows();
  }
  if (['post_purchase_progress', 'row_succeeded', 'additional_progress', 'additional_finished', 'job_finished'].includes(payload.type)) {
    void refreshPrivateResults().catch(error => { $('#activity').textContent = error.message; });
  }
  if (payload.type === 'plans_discovered' && Array.isArray(payload.plans)) {
    $('#discovered-plans').hidden = false;
    $('#discovered-plans').innerHTML = `<span>浏览器识别到的个人版套餐：</span> ${payload.plans.map((plan) => `<b>${escapeHtml(plan.title)}</b>`).join(' · ')}`;
  }
  appendEventLog(payload);
};

function hideReasonZoom() {
  const zoom = $('#reason-zoom');
  zoom.hidden = true;
  $('#reason-text').textContent = '';
  $('#reason-copy-status').textContent = '';
}
function hideScreenshotZoom() {
  const zoom = $('#screenshot-zoom');
  zoom.hidden = true;
  const image = zoom.querySelector('img');
  if (image) image.removeAttribute('src');
}
function showReasonZoom(text) {
  hideScreenshotZoom();
  const zoom = $('#reason-zoom');
  zoom.hidden = false;
  $('#reason-text').textContent = text;
  $('#reason-copy-status').textContent = '';
}
$('#copy-reason').addEventListener('click', async () => {
  const text = $('#reason-text').textContent;
  try {
    await navigator.clipboard.writeText(text);
    if ($('#reason-text').textContent === text) $('#reason-copy-status').textContent = '已复制';
  } catch {
    if ($('#reason-text').textContent === text) $('#reason-copy-status').textContent = '复制失败，请选中文字后按 Ctrl+C / ⌘C';
  }
});
function showScreenshotZoom(url) {
  hideReasonZoom();
  const zoom = $('#screenshot-zoom');
  const image = zoom.querySelector('img');
  image.src = url;
  zoom.hidden = false;
}
async function copyScreenshot(url, button) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error('截图已失效，请使用该行的截图按钮重新截图');
    const blob = await response.blob();
    const png = blob.type === 'image/png' ? blob : new Blob([blob], { type: 'image/png' });
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    button.textContent = '已复制';
    $('#activity').textContent = '截图已复制到剪贴板';
    setTimeout(() => { button.textContent = '复制'; }, 1600);
  } catch (error) {
    button.textContent = '复制失败';
    $('#activity').textContent = error.message || '复制截图失败';
    setTimeout(() => { button.textContent = '复制'; }, 1600);
  }
}
$('#task-body').addEventListener('click', (event) => {
  const stopButton = event.target.closest('[data-stop-index]');
  if (stopButton) {
    event.stopPropagation();
    if (!stopButton.disabled) void stopRow(Number(stopButton.getAttribute('data-stop-index')));
    return;
  }
  const additionalButton = event.target.closest('[data-additional]');
  if (additionalButton) {
    event.stopPropagation();
    if (!additionalButton.disabled) void startAdditional(Number(additionalButton.dataset.rowIndex), additionalButton.dataset.additional);
    return;
  }
  const retryButton = event.target.closest('[data-retry-index]');
  if (retryButton) {
    event.stopPropagation();
    const index = Number(retryButton.getAttribute('data-retry-index'));
    if (!Number.isInteger(index) || !rows[index] || !canRetryRow(index)) return;
    // 单行重试只提交当前行，复用首次绑定的账号、卡和地址，不借用其他行。
    startJob([{...rows[index], __uiIndex:index}]);
    return;
  }
  const continueButton = event.target.closest('[data-continue-index]');
  if (continueButton) {
    event.stopPropagation();
    if (!continueButton.disabled) void startFromRow(Number(continueButton.getAttribute('data-continue-index')));
    return;
  }
  const invoiceButton=event.target.closest('[data-save-invoice]');
  if(invoiceButton){void saveInvoice(Number(invoiceButton.getAttribute('data-save-invoice')));return;}
  const copyButton = event.target.closest('[data-copy-screenshot]');
  if (copyButton) {
    event.stopPropagation();
    const url = copyButton.getAttribute('data-copy-screenshot') || '';
    if (!url || copyButton.disabled) return;
    copyScreenshot(url, copyButton);
    return;
  }
  const shot = event.target.closest('[data-screenshot]');
  if (shot) {
    event.stopPropagation();
    showScreenshotZoom(shot.getAttribute('data-screenshot') || '');
    return;
  }
  const cell = event.target.closest('[data-reason]');
  if (!cell) return;
  event.stopPropagation();
  showReasonZoom(cell.getAttribute('data-reason') || '');
});
document.addEventListener('click', (event) => {
  if (event.target.closest('#reason-zoom') || event.target.closest('[data-reason]') || event.target.closest('[data-screenshot]') || event.target.closest('[data-copy-screenshot]') || event.target.closest('#screenshot-zoom')) return;
  hideReasonZoom();
  hideScreenshotZoom();
});
function selectedPlan() {
  return rechargeType === 'ads'
    ? {planAmount:document.querySelector('input[name="planAmount"]:checked').value}
    : {multiplier:document.querySelector('input[name="multiplier"]:checked').value};
}
function selectedSubscriptionType() {
  const plan = selectedPlan();
  return `${$('#product').value} / ${plan.planAmount ? `$${plan.planAmount} / 月` : plan.multiplier}`;
}
$('#export-results').addEventListener('click', async () => {
  if (!rows.length) return;
  try { await refreshPrivateResults(); }
  catch (error) { $('#activity').textContent = error.message; return; }
  const blob = new Blob([buildResultsCsv(rows, rowStates, selectedSubscriptionType())], {type:'text/csv;charset=utf-8'});
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `gpt-results-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  $('#activity').textContent = `已导出 ${rows.length} 条任务，CPA / 2FA 列包含已取得的结果，请同时查看各项状态`;
});
async function saveInvoice(index) {
  const state=rowStates[index];
  const jobId=state?.invoiceFileNameLoadedJobId||state?.invoiceFileNameJobId||state?.jobId;
  const access=resultAccesses.find(item=>item.jobId===jobId);
  if(!access||!state?.invoiceFileName)return;
  try{
    const response=await fetch(`/api/jobs/${jobId}/invoices/${index}`,{headers:{Authorization:`Bearer ${access.resultToken}`},cache:'no-store'});
    if(!response.ok)throw new Error('发票读取失败，请单独重新下载');
    const url=URL.createObjectURL(await response.blob());const link=document.createElement('a');
    link.href=url;link.download=`invoice-${rows[index].adsPowerSerialNumber}.pdf`;link.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
    $('#activity').textContent='发票 PDF 已保存';
  }catch(error){$('#activity').textContent=error.message;}
}

async function startAdditional(index, option) {
  if (!canRunAdditional(index) || !additionalLabels[option]) return;
  // 先补取旧批次的秘密再开始新任务，跨批次结果按字段分别归属。
  try { await refreshPrivateResults(); }
  catch (error) { $('#activity').textContent = error.message; return; }
  if (!canRunAdditional(index)) return;
  const row = rows[index];
  const previousAccess = activeResultAccess;
  jobRunning = true;
  activeResultAccess = null;
  rowStates[index] = {...rowStates[index], paymentConfirmed:true, additionalRunning:option};
  renderRows();
  try {
    const response = await fetch('/api/jobs/additional', {method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({option, row:{adsPowerSerialNumber:row.adsPowerSerialNumber, email:row.email, __uiIndex:index},
        apiBase:settings.apiBase, apiKey:settings.apiKey})});
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || '附加任务启动失败');
    activeResultAccess = {jobId:body.jobId, resultToken:body.resultToken};
    resultAccesses.push(activeResultAccess);
    rowStates[index].jobId = body.jobId;
    void refreshPrivateResults().catch(error => { $('#activity').textContent = error.message; });
  } catch (error) {
    activeResultAccess = previousAccess;
    jobRunning = false;
    rowStates[index].additionalRunning = '';
    $('#activity').textContent = error.message;
    renderRows();
  }
}

async function startJob(taskRows) {
  if (jobRunning || !taskRows.length) return;
  activeResultAccess = null;
  const additionalOptions = [...document.querySelectorAll('input[name="additionalOptions"]:checked')].map((input) => input.value);
  const subscriptionType = selectedSubscriptionType();
  // 本批选项在启动时固定，重试按本次选择执行；已成功的行不重复充值。
  taskRows = taskRows.map((row, index) => ({...row, __uiIndex:row.__uiIndex ?? index}))
    .filter((row) => canRetryRow(row.__uiIndex));
  if (!taskRows.length) return;
  for (const row of taskRows) rowStates[row.__uiIndex] = {status:'待执行', subscriptionType, additionalOptions};
  const input = {rows:taskRows, concurrency:Number($('#concurrency').value), product:$('#product').value,
    rechargeType, ...selectedPlan(), additionalOptions, apiBase:settings.apiBase, apiKey:settings.apiKey};
  jobRunning = true;
  stopRequested = false;
  renderRows();
  $('#activity').textContent = '正在启动任务';
  try {
    const response = await fetch('/api/jobs', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(input)});
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || '任务启动失败');
    activeResultAccess = {jobId:body.jobId, resultToken:body.resultToken};
    resultAccesses.push(activeResultAccess);
    for (const row of taskRows) rowStates[row.__uiIndex] = {...rowStates[row.__uiIndex], jobId:body.jobId};
    void refreshPrivateResults().catch(error => { $('#activity').textContent = error.message; });
  } catch (error) {
    jobRunning = false;
    stopRequested = false;
    $('#validation').hidden = false;
    $('#validation').textContent = error.message || '任务启动失败';
    renderRows();
  }
}

$('#start').addEventListener('click', () => startJob(rows));
$('#retry-failed').addEventListener('click', () => { const retryRows = failedIndexes.map((index) => ({...rows[index], __uiIndex:index})); if (retryRows.length) startJob(retryRows); });
$('#stop-all').addEventListener('click', async () => {
  stopRequested = true;
  renderRows();
  const response = await fetch('/api/jobs/stop', {method:'POST'});
  if (!response.ok) {
    stopRequested = false;
    renderRows();
    $('#validation').hidden = false;
    $('#validation').textContent = '终止排队任务失败';
  }
});
renderBillingStates();
