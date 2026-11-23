export function invoiceStatusText(state = {}) {
  if(state.invoiceStatus==='completed')return state.invoiceFileName?'已下载':'已下载，文件待读取';
  if(state.invoiceStatus==='failed')return `未完成：${state.invoiceError||'下载未完成'}`;
  return state.invoiceStatus==='pending'||state.additionalOptions?.includes('invoice')?'待处理':'未勾选';
}

export function cpaStatusText(state = {}) {
  if (state.cpaStatus === 'completed') return state.cpaJson ? '已导出' : '已授权，结果待读取';
  if (state.cpaStatus === 'failed') return `未完成：${state.cpaError || '授权未完成'}`;
  return state.cpaStatus === 'pending' || state.additionalOptions?.includes('cpa') ? '待处理' : '未勾选';
}

export function twoFactorStatusText(state = {}) {
  if (state.twoFactorStatus === 'completed') return state.twoFactorKey ? '已启用，Key 已保存' : '已启用，Key 待读取';
  if (state.twoFactorStatus === 'already_enabled') return '原已启用，未取得 Key';
  if (state.twoFactorStatus === 'failed') return `未完成：${state.twoFactorError || '请核对账号安全设置'}`;
  if (state.twoFactorStatus === 'pending') return state.twoFactorKey ? 'Key 已保存，待确认启用' : '待处理';
  return state.additionalOptions?.includes('2fa') ? '待处理' : '未勾选';
}

export function buildResultsCsv(rows, states, pendingSubscriptionType = '') {
  const header = ['邮箱', '密码', '订阅类型', 'cpa', '2fa', 'AdsPower编号', '任务状态', '失败原因', '截图状态', '结束时间', '2FA状态', 'CPA状态', '发票状态'];
  const records = rows.map((row, index) => {
    const state = states[index] || {};
    const screenshotStatus = state.screenshotUrl ? '已完成'
      : state.screenshotError ? `未完成：${state.screenshotError}`
      : state.screenshotStatus === 'skipped' ? '未勾选'
      : state.additionalOptions?.includes('screenshot') ? '未完成' : '';
    // 只导出本次流程读取的 Key，绝不从导入文件伪造；未确认启用时由独立状态列明确标记。
    return [row.email, row.password, state.subscriptionType || (state.executionMode==='additional'?'':pendingSubscriptionType), state.cpaJson || '', state.twoFactorKey || '',
      row.adsPowerSerialNumber, state.status || '待执行', state.reason || '', screenshotStatus, state.completedAt || '', twoFactorStatusText(state), cpaStatusText(state), invoiceStatusText(state)];
  });
  // UTF-8 BOM 便于 Excel/WPS 识别中文；RFC 4180 转义保留密码中的逗号、引号和换行。
  const cell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  return '\uFEFF' + [header, ...records].map((record) => record.map(cell).join(',')).join('\r\n') + '\r\n';
}
