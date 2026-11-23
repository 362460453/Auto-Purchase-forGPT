// 账单截图只返回加载状态和几何信息，不将邮箱或账单正文写入日志。
export function inspectBillingProof() {
  if (location.origin !== 'https://chatgpt.com') return {ready:false, screenshotReady:false};
  const text = node => String(node.value || node.textContent || '').trim();
  const rendered = node => {
    const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const inView = node => {
    if (!node || !rendered(node)) return false;
    const rect = node.getBoundingClientRect();
    if (rect.top < 0 || rect.left < 0 || rect.bottom > innerHeight || rect.right > innerWidth) return false;
    // 设置弹窗内部滚动区域也可能裁掉邮箱，不能仅检查顶层 viewport。
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY) && (rect.top < bounds.top || rect.bottom > bounds.bottom)) return false;
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX) && (rect.left < bounds.left || rect.right > bounds.right)) return false;
    }
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return Boolean(hit && (node === hit || node.contains(hit)));
  };
  const labels = [...document.querySelectorAll('h1,h2,h3,p,span,div')].filter(rendered);
  const billingOpen = location.pathname === '/settings/billing' || labels.some(node => /^Billing$/.test(text(node)) && /^H[1-3]$/.test(node.tagName || ''));
  const emailLabel = labels.find(node => text(node) === 'Billing email');
  const plan = labels.find(node => /^ChatGPT (Pro|Plus|Team|Business|Go)(?: \d+)?$/.test(text(node)));
  let email;
  // 只在 Billing email 附近找完整邮箱，标题先出现、值仍为空或加载中时继续等待。
  for (let root = emailLabel?.parentElement, depth = 0; root && root !== document.body && depth < 4; root = root.parentElement, depth++) {
    const matches = [...root.querySelectorAll('p,span,div,a,input')]
      .filter(node => rendered(node) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text(node)));
    const values = new Set(matches.map(text));
    if (values.size > 1) break;
    email = matches.find(node => !matches.some(other => other !== node && node.contains(other)));
    if (email) break;
  }
  const ready = Boolean(emailLabel && plan) && !/Loading (settings|transactions)/i.test(document.body?.innerText || '');
  const emailVisible = inView(emailLabel) && inView(email);
  const planVisible = inView(plan);
  const positions = [plan, emailLabel, email].map(node => {
    if (!node) return null;
    const r = node.getBoundingClientRect();
    return [r.left, r.top, r.width, r.height].map(n => Math.round(n));
  });
  return {billingOpen, ready, emailLoaded:Boolean(email), emailVisible, planVisible,
    screenshotReady:ready && emailVisible && planVisible, layout:JSON.stringify(positions)};
}

// 浏览器原生 Zoom：Mac 用 Cmd，Windows/Linux 用 Ctrl；不使用 CSS 或设备模拟缩放。
export async function setBillingBrowserZoom(page, waitForValue, platform = process.platform, onStep = () => {}) {
  const mac = platform === 'darwin';
  const shortcut = async (key, code, windowsVirtualKeyCode, macKeyCode) => {
    // macOS 的 CDP 原生 NSEvent 从 text 构造 characters；缺失时 Cmd+- 不会被菜单快捷键识别。
    const event = {key, code, text:key, unmodifiedText:key, modifiers:mac ? 4 : 2, windowsVirtualKeyCode,
      nativeVirtualKeyCode:mac ? macKeyCode : windowsVirtualKeyCode};
    await page.command('Input.dispatchKeyEvent', {type:'rawKeyDown', ...event});
    await page.command('Input.dispatchKeyEvent', {type:'keyUp', ...event});
  };
  const waitZoom = expected => waitForValue(
    () => readBillingBrowserZoom(page), zoom => Math.abs(zoom - expected) < 0.005,
    // 原生快捷键可能被浏览器吞掉；共用整行剩余时间，不能把发送快捷键当作缩放成功。
    600000, `等待浏览器 Zoom 到达 ${Math.round(expected * 100)}%`);
  await page.command('Page.bringToFront');
  const initialZoom = await readBillingBrowserZoom(page);
  onStep(`浏览器实际 Zoom：${Number.isFinite(initialZoom) ? Math.round(initialZoom * 100) + '%' : '未返回缩放值'}`);
  if (Math.abs(initialZoom - 0.75) < 0.005) return;
  // 先回到 100%，再按 Chrome 固定档位降到 90%、80%、75%，避免在未知缩放上盲减。
  await shortcut('0', 'Digit0', 48, 29);
  await waitZoom(1);
  onStep('浏览器 Zoom 已重置到 100%，开始缩小');
  for (const zoom of [0.9, 0.8, 0.75]) {
    await shortcut('-', 'Minus', 189, 27);
    await waitZoom(zoom);
    onStep(`浏览器 Zoom 已确认 ${Math.round(zoom * 100)}%`);
  }
}

export async function readBillingBrowserZoom(page) {
  const metrics = await page.command('Page.getLayoutMetrics');
  // cssVisualViewport.zoom 是浏览器页面缩放；scale 是 pinch zoom，不能用它或 DPR 冒充。
  return metrics.cssVisualViewport?.zoom ?? NaN;
}
