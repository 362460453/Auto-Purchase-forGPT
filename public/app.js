const $ = (selector) => document.querySelector(selector);
const requiredColumns = ['adsPowerSerialNumber', 'email', 'password', 'cardNumber', 'expires_at', 'cvv'];
let rows = [];
const rowStates = [];
let failedIndexes = [];
let jobRunning = false;
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
const billingStateDirectory = {
  OR: {
    label: 'Oregon / 俄勒冈州',
    cities: [
      { city: 'Portland', zips: ['97201', '97202', '97203', '97204', '97205', '97206', '97209', '97210', '97211', '97212', '97213', '97214', '97215', '97217', '97219', '97220', '97221', '97229', '97232', '97239'] },
      { city: 'Beaverton', zips: ['97005', '97006', '97007', '97008'] },
      { city: 'Salem', zips: ['97301', '97302', '97304', '97305', '97306'] },
      { city: 'Eugene', zips: ['97401', '97402', '97403', '97404', '97405'] },
      { city: 'Bend', zips: ['97701', '97702', '97703'] },
      { city: 'Medford', zips: ['97501', '97504'] },
      { city: 'Hillsboro', zips: ['97123', '97124'] },
      { city: 'Gresham', zips: ['97030', '97080'] },
      { city: 'Corvallis', zips: ['97330', '97331', '97333'] },
      { city: 'Springfield', zips: ['97477', '97478'] },
      { city: 'Albany', zips: ['97321', '97322'] },
      { city: 'Lake Oswego', zips: ['97034', '97035'] },
      { city: 'Tigard', zips: ['97223', '97224'] },
      { city: 'Oregon City', zips: ['97045'] },
      { city: 'Grants Pass', zips: ['97526', '97527'] },
      { city: 'Tualatin', zips: ['97062'] },
      { city: 'West Linn', zips: ['97068'] },
      { city: 'McMinnville', zips: ['97128'] },
      { city: 'Keizer', zips: ['97303'] },
      { city: 'Ashland', zips: ['97520'] },
    ],
  },
};
const givenNames = ['James', 'Michael', 'Robert', 'David', 'William', 'John', 'Daniel', 'Matthew', 'Andrew', 'Joseph', 'Christopher', 'Ryan', 'Brian', 'Kevin', 'Jason', 'Eric', 'Mark', 'Thomas', 'Scott', 'Jeffrey', 'Mary', 'Jennifer', 'Linda', 'Patricia', 'Elizabeth', 'Barbara', 'Susan', 'Jessica', 'Sarah', 'Karen', 'Nancy', 'Lisa', 'Betty', 'Margaret', 'Sandra', 'Ashley', 'Kimberly', 'Emily', 'Donna', 'Michelle'];
const familyNames = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Miller', 'Davis', 'Wilson', 'Anderson', 'Taylor', 'Thomas', 'Moore', 'Martin', 'Jackson', 'Thompson', 'White', 'Harris', 'Clark', 'Lewis', 'Walker', 'Hall', 'Allen', 'Young', 'King', 'Wright', 'Scott', 'Green', 'Baker', 'Adams', 'Nelson', 'Hill', 'Ramirez', 'Campbell', 'Mitchell', 'Roberts', 'Carter', 'Phillips', 'Evans', 'Turner', 'Parker'];
const streetNames = ['Main', 'Oak', 'Maple', 'Cedar', 'Pine', 'Elm', 'Washington', 'Lincoln', 'Lake', 'Hill', 'Park', 'River', 'Sunset', 'Valley', 'Forest', 'Highland', 'Broadway', 'Church', 'Mill', 'Spring', 'Walnut', 'Chestnut', 'Madison', 'Jefferson', 'Franklin', 'Jackson', 'Monroe', 'Adams', 'Grant', 'Wilson'];
const streetSuffixes = ['St', 'Ave', 'Rd', 'Blvd', 'Ln', 'Dr', 'Ct', 'Way', 'Pl', 'Ter'];

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
function csvRows(text) {
  const records = parseCsv(text);
  const header = (records.shift() || []).map((value, index) => index === 0 ? value.replace(/^\uFEFF/, '') : value);
  const missing = requiredColumns.filter((column) => !header.includes(column));
  if (missing.length) throw new Error(`CSV 缺少字段：${missing.join('、')}`);
  return records.map((values) => Object.fromEntries(header.map((key, index) => [key, values[index] || ''])));
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
  const city = pick(directory.cities);
  return {
    billingName: `${pick(givenNames)} ${pick(familyNames)}`,
    billingAddressLine1: `${100 + randomInt(9900)} ${pick(streetNames)} ${pick(streetSuffixes)}`,
    billingAddressLine2: '',
    billingCity: city.city,
    billingState: state,
    billingPostalCode: pick(city.zips),
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
    // 地址在导入时按所选州生成并固定到当前任务行，执行和手动重试都复用同一地址，禁止跨行临时换地址。
    return {...row, ...address, billingRegionLabel: billingStateDirectory[state]?.label || state};
  });
}
function billingAddressText(row) {
  return [row.billingName, row.billingAddressLine1, row.billingAddressLine2, row.billingCity, row.billingState, row.billingPostalCode, 'United States']
    .filter(Boolean)
    .join(', ');
}
function renderRows() {
  $('#task-body').innerHTML = rows.map((row, index) => {
    const state = rowStates[index] || {};
    const reason = state.reason || '';
    const reasonAttr = reason ? ` class="reason-cell" data-reason="${escapeHtml(reason)}" title="单击放大"` : '';
    return `<tr><td>${escapeHtml(row.adsPowerSerialNumber)}</td><td>${escapeHtml(row.email)}</td><td>${escapeHtml(row.password)}</td><td>${escapeHtml(row.cardNumber)}</td><td>${escapeHtml(row.expires_at)}</td><td>${escapeHtml(row.cvv)}</td><td title="${escapeHtml(billingAddressText(row))}">${escapeHtml(billingAddressText(row))}</td><td>${escapeHtml(state.status || '待执行')}</td><td${reasonAttr}>${escapeHtml(reason)}</td></tr>`;
  }).join('');
  $('#task-count').textContent = `${rows.length} 条`;
  $('#task-table-wrap').classList.toggle('scrollable', rows.length > 10);
  $('#task-list').hidden = false; $('#start').disabled = jobRunning || rows.length === 0; $('#retry-failed').disabled = jobRunning || failedIndexes.length === 0;
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
$('#csv-file').addEventListener('change', async (event) => { try { const importedRows = csvRows(await event.target.files[0].text()); if (!importedRows.length) throw new Error('CSV 没有账号记录'); if (importedRows.length > 100) throw new Error('单次最多支持 100 条记录'); rows = bindBillingAddresses(importedRows, $('#billing-state').value); rowStates.length = rows.length; rowStates.fill({}); failedIndexes = []; $('#file-name').textContent = `${event.target.files[0].name} · ${rows.length} 条 · ${$('#billing-state').selectedOptions[0].textContent}`; $('#validation').hidden = true; renderRows(); } catch (error) { rows = []; $('#validation').hidden = false; $('#validation').textContent = error.message; $('#start').disabled = true; } });
$('#download-template').addEventListener('click', (event) => {
  event.preventDefault();
  // 导入模板保持原有六列，避免已有任务文件需要跟着修改。
  const header = requiredColumns.join(',');
  const example = '10001,name@example.com,填入邮箱密码,4111111111111111,0931,123';
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
const events = new EventSource('/api/events'); events.onmessage = (event) => { const payload = JSON.parse(event.data); $('#activity').textContent = payload.message || payload.type; if (payload.type === 'job_finished' || payload.type === 'job_failed') { jobRunning = false; renderRows(); } if (Number.isInteger(payload.index) && rowStates[payload.index]) { if (payload.type === 'row_started' || payload.type === 'browser_started') rowStates[payload.index] = {status:'执行中', reason:''}; if (payload.type === 'row_failed') { rowStates[payload.index] = {status:'失败', reason:payload.message || '未知异常'}; failedIndexes = [...new Set([...failedIndexes, payload.index])]; } if (payload.type === 'row_succeeded') { rowStates[payload.index] = {status:'已完成', reason:''}; failedIndexes = failedIndexes.filter((index) => index !== payload.index); } if (payload.type === 'payment_confirmation_required') { rowStates[payload.index] = {status:'待人工支付', reason:''}; failedIndexes = failedIndexes.filter((index) => index !== payload.index); } renderRows(); } if (payload.type === 'plans_discovered' && Array.isArray(payload.plans)) { $('#discovered-plans').hidden = false; $('#discovered-plans').innerHTML = `<span>浏览器识别到的个人版套餐：</span> ${payload.plans.map((plan) => `<b>${escapeHtml(plan.title)}</b>`).join(' · ')}`; } appendEventLog(payload); };
function hideReasonZoom() {
  const zoom = $('#reason-zoom');
  zoom.hidden = true;
  zoom.textContent = '';
}
function showReasonZoom(text) {
  const zoom = $('#reason-zoom');
  zoom.hidden = false;
  zoom.textContent = text;
}
$('#task-body').addEventListener('click', (event) => {
  const cell = event.target.closest('[data-reason]');
  if (!cell) return;
  event.stopPropagation();
  showReasonZoom(cell.getAttribute('data-reason') || '');
});
document.addEventListener('click', (event) => {
  if (event.target.closest('[data-reason]')) return;
  hideReasonZoom();
});
async function startJob(taskRows) { jobRunning = true; renderRows(); $('#activity').textContent = '正在启动任务'; const response = await fetch('/api/jobs', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({rows:taskRows, concurrency:Number($('#concurrency').value), product:$('#product').value, multiplier:document.querySelector('input[name="multiplier"]:checked').value, apiBase:settings.apiBase, apiKey:settings.apiKey})}); if (!response.ok) { const body = await response.json(); jobRunning = false; $('#validation').hidden = false; $('#validation').textContent = body.error || '任务启动失败'; renderRows(); } }
$('#start').addEventListener('click', () => startJob(rows));
$('#retry-failed').addEventListener('click', () => { const retryRows = failedIndexes.map((index) => ({...rows[index], __uiIndex:index})); if (retryRows.length) startJob(retryRows); });
renderBillingStates();
