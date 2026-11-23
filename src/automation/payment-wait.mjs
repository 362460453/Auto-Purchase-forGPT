// AdsPower 付款等待不设单独阶段超时，但受整条任务 10 分钟上限控制：按钮启用才提交，提交后只等待成功或明确失败，不能因页面暂时不变重复扣款。
export async function waitForSubscriptionPayment({ readButton, readOutcome, submit, wait, isActive = () => true, onStep = () => {} }) {
  let submitted = false;
  let processingReported = false;
  onStep('账单地址已填写，持续等待结账订阅按钮启用或明确失败提示');
  while (isActive()) {
    const outcome = await readOutcome(submitted);
    if (outcome?.error) throw new Error(outcome.error);
    if (submitted && outcome?.success) {
      onStep('已确认支付成功');
      return outcome;
    }
    if (!submitted) {
      const button = await readButton();
      if (button?.found && button.enabled) {
        // submit 返回 false 表示布局稳定期间按钮又被禁用，未发送鼠标事件，可以继续等待。
        submitted = await submit(button);
        if (submitted) onStep('已点击结账订阅按钮，持续等待支付结果；不自动重复提交');
      }
    } else if (outcome?.processing && !processingReported) {
      processingReported = true;
      onStep('支付处理中，持续等待成功或明确失败提示');
    }
    await wait();
  }
  throw new Error('付款等待已中止');
}
