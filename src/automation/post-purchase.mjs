export function resolveAdditionalOptions(value, rechargeType = 'ads') {
  // 旧客户端没有此字段时保留截图；显式空数组表示付款成功后直接结束。
  if (value === undefined) return ['screenshot'];
  if (!Array.isArray(value)) throw new Error('附加选项必须为数组');
  for (const option of value) {
    if (!['screenshot', 'invoice', 'cpa', '2fa'].includes(option)) throw new Error('不支持的附加选项');
    if (['invoice', 'cpa', '2fa'].includes(option) && rechargeType !== 'ads') throw new Error('下载发票 / CPA / 2FA 附加选项当前仅支持 AdsPower 模式');
  }
  return [...new Set(value)];
}

export function initialPostPurchaseResult(options) {
  return { invoiceFileName:'', invoiceError:'', invoiceStatus:options.includes('invoice')?'pending':'skipped', screenshotUrl: '', screenshotError: '', screenshotStatus: options.includes('screenshot') ? 'pending' : 'skipped',
    cpaJson: '', cpaError: '', cpaStatus: options.includes('cpa') ? 'pending' : 'skipped',
    twoFactorKey: '', twoFactorError: '', twoFactorStatus: options.includes('2fa') ? 'pending' : 'skipped' };
}

export function interruptedPostPurchaseResult(result, reason = '任务结束前未完成') {
  const next = { ...result };
  // 保留已完成的截图和已读取的 Key；只有尚未完成的附加步骤标异常，禁止重跑支付。
  if (next.screenshotStatus === 'pending') Object.assign(next, { screenshotStatus: 'failed', screenshotError: `${reason}：截图未完成` });
  if (next.invoiceStatus === 'pending') Object.assign(next,{invoiceStatus:'failed',invoiceError:`${reason}：发票下载未完成`});
  if (next.cpaStatus === 'pending') Object.assign(next, { cpaStatus: 'failed', cpaError: `${reason}：CPA 授权未完成` });
  if (next.twoFactorStatus === 'pending') Object.assign(next, { twoFactorStatus: 'failed', twoFactorError: `${reason}：未确认 2FA 启用，请核对账号安全设置` });
  return next;
}

export async function completePostPurchase(options, capture, onStep = () => {}, { exportCpa, setupTwoFactor, downloadInvoice, onProgress = () => {} } = {}) {
  const result = initialPostPurchaseResult(options);
  const update = patch => { Object.assign(result, patch); onProgress({ ...result }); };
  if (!options.length) onStep('支付成功，未勾选附加选项，直接完成任务');
  // 先截图和下载发票、再 CPA、最后启用验证器，避免新启用的 MFA 阻塞本次授权；各附加项独立记录。
  if (options.includes('screenshot')) {
    try {
      const proof = await capture();
      if (!proof?.screenshotUrl) throw new Error(proof?.screenshotError || 'Billing 截图未完成');
      update({ ...proof, screenshotError: '', screenshotStatus: 'completed' });
    } catch (error) {
      update({ screenshotError: error.message, screenshotStatus: 'failed' });
    }
  }
  if (options.includes('invoice')) {
    try {
      if (!downloadInvoice) throw new Error('下载发票未配置');
      const invoice=await downloadInvoice();
      if (!invoice?.invoiceFileName) throw new Error(invoice?.invoiceError || '发票 PDF 未下载完成');
      update({...invoice,invoiceStatus:'completed',invoiceError:''});
    } catch (error) { update({invoiceStatus:'failed',invoiceError:error.message}); }
  }
  if (options.includes('cpa')) {
    try {
      if (!exportCpa) throw new Error('CPA 未配置');
      update(await exportCpa(update));
    } catch {
      update({ cpaStatus: 'failed', cpaError: 'CPA 授权未完成，请检查授权页面' });
    }
  }
  if (options.includes('2fa')) {
    try {
      if (!setupTwoFactor) throw new Error('2FA 未配置');
      update(await setupTwoFactor(update));
    } catch {
      update({ twoFactorStatus: 'failed', twoFactorError: '2FA 配置未完成，请核对账号安全设置' });
    }
  }
  return result;
}
