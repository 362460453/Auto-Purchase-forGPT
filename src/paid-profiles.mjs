// 仅记录 Profile、套餐和付款时间；不保存账号、支付资料或附加任务秘密。
export function createPaidProfiles(events = []) {
  const paid = new Map();
  const review = new Map();
  const capture = event => {
    if (event.type === 'row_cancelled' && event.paymentReviewRequired && event.serialNumber) {
      const key = String(event.serialNumber).trim();
      // 人工终止不能撤销已提交的付款，刷新或热更新后也必须阻止误充值。
      if (!paid.has(key)) review.set(key, {serialNumber:key, subscriptionType:event.subscriptionType || '', paymentReviewRequired:true});
      return;
    }
    if (!['row_payment_confirmed', 'row_succeeded'].includes(event.type)) return;
    const legacy = /^第 \d+ 条 \/ AdsPower ([^：]+)：(.*?) 支付成功[；]/.exec(event.message || '');
    const serial = event.serialNumber || legacy?.[1];
    if (!serial) return;
    const key = String(serial).trim();
    review.delete(key);
    paid.set(key, {serialNumber:key, subscriptionType:event.subscriptionType || legacy?.[2] || paid.get(key)?.subscriptionType || '',
      paidAt:paid.get(key)?.paidAt || event.timestamp});
  };
  events.forEach(capture);
  return {capture, has:serial => paid.has(String(serial).trim()), needsReview:serial => review.has(String(serial).trim()),
    list:() => [...paid.values(), ...review.values()]};
}
