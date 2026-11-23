export const PRO_AMOUNTS = ['100', '200', '500'];

export function inspectPricingPage() {
  // 14627 实机已切换到 /plans；仍兼容旧 #pricing，且必须等套餐内容加载，不能只凭 URL 继续。
  if (location.origin !== 'https://chatgpt.com') return false;
  const pricingRoute = /^\/plans\/?$/.test(location.pathname) || location.hash === '#pricing';
  if (!pricingRoute) return false;
  const text = String(document.body?.innerText || '').replace(/\s+/g, ' ').trim();
  return text.includes('Upgrade your plan')
    || (text.includes('Frontier intelligence') && ['Buy now', 'Upgrade to Pro', 'Get started', 'Start now'].some(label => text.includes(label)))
    || text.includes('Claim free offer')
    || text.includes('See all plans')
    || /\bSee all\b/.test(text);
}

export function resolveProSelection({ rechargeType = 'ads', planAmount, multiplier } = {}) {
  if (rechargeType === 'google-incognito') {
    const value = multiplier ?? '20x';
    if (!['20x', '5x'].includes(value)) throw new Error('无痕模式只支持原有 20x / 5x 规格');
    return { multiplier: value, label: value };
  }
  // 兼容尚未刷新的旧控制台：20x 对应 $200，5x 对应 $100；未知值不能默认为便宜档。
  const amount = planAmount == null
    ? (multiplier == null ? '200' : { '20x': '200', '5x': '100' }[multiplier])
    : String(planAmount);
  if (!PRO_AMOUNTS.includes(amount)) throw new Error('AdsPower Pro 规格只支持 $100、$200、$500 / 月');
  return { amount, label: `$${amount} / 月` };
}

// 根据当前 Pro 卡片读取控件坐标和月费；不点击整页其他产品的 Buy now。
export function inspectProPricingCard(expectedAmount) {
  if (!['100', '200', '500'].includes(String(expectedAmount))) return null;
  const normalize = (text) => String(text || '').replace(/\s+/g, ' ').trim();
  const visible = (node) => {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== 'hidden';
  };
  const label = (node) => normalize(node.getAttribute('aria-label') || node.innerText || node.textContent);
  const point = (node) => {
    const rect = node.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  };
  // 实机页面提供明确的套餐边界；不能从 Pro 标题向上爬到包含 Plus/Go 的整张价格表。
  const cards = [...document.querySelectorAll('[data-pricing-plan="pro"]')].filter(visible);
  if (cards.length !== 1) return null;
  for (const card of cards) {
    const enabled = (node) => visible(node) && !node.disabled && node.getAttribute('aria-disabled') !== 'true';
    // 14649 使用 Start now，14650 使用 Get started；四种购买文案都必须限定当前 Pro 卡片且唯一，不能误点 Plus/Go 的同名按钮。
    const buyButtons = [...card.querySelectorAll('button,a,[role="button"]')]
      .filter((node) => enabled(node) && ['Buy now', 'Upgrade to Pro', 'Get started', 'Start now'].includes(label(node)));
    const radios = [...card.querySelectorAll('[role="radiogroup"][aria-label="Pro usage"] [role="radio"]')].filter(enabled);
    const options = ['100', '200', '500'].map((amount) => radios.find((node) => label(node) === amount));
    // 14643 的 Pro 入口没有规格控件，要进入 Configure your plan 才能选档。
    // 有控件但尚未加载完整时继续等待，不能把半加载或禁用的规格误当成这种入口。
    const configureAtCheckout = card.querySelectorAll('[role="radiogroup"], [role="radio"], input[type="radio"]').length === 0;
    if ((!configureAtCheckout && options.some((node) => !node)) || buyButtons.length !== 1) continue;
    // 新版价格同时含读屏金额和动画数字，innerText 会重复数字；只读当前价格槽的完整读屏金额。
    const priceSlot = card.querySelector('[data-testid="pro-pricing-column-cost"]');
    const price = priceSlot?.querySelector('[data-testid="pricing-column-cost"] .sr-only');
    const frequency = priceSlot?.querySelector('[data-pricing-price-frequency]');
    const priceMatch = normalize(price?.textContent).match(/^\$\s*(100|200|500)(?:\.00)?$/);
    // 新版同时保留横排 / month 和隐藏的竖排 Per month；textContent 会连成 monthPer，必须读实际渲染文案。
    const monthly = /^(?:\/\s*month|Per month)$/i.test(normalize(frequency?.innerText));
    if (!priceSlot || !visible(priceSlot) || !priceMatch || !monthly) continue;
    const selectedIndex = ['100', '200', '500'].indexOf(String(expectedAmount));
    const selected = options[selectedIndex];
    const priceMatches = priceMatch?.[1] === String(expectedAmount);
    const selectedState = selected?.getAttribute('aria-checked') === 'true'
      && options.filter((node) => node.getAttribute('aria-checked') === 'true').length === 1;
    return {
      title: 'ChatGPT Pro', description: 'Frontier intelligence', button: label(buyButtons[0]),
      point: point(buyButtons[0]), optionPoint: selected ? point(selected) : null,
      amount: priceMatch?.[1] || '',
      selectionStage: configureAtCheckout ? 'checkout' : 'pricing',
      // 单选状态与当前月费必须一致，切换动画中暂时不一致时继续等待。
      selected: !configureAtCheckout && priceMatches && selectedState,
      viewport: { width: innerWidth, height: innerHeight },
    };
  }
  return null;
}

// 14643 实机：结账页 Pro plan 单选组用 aria-labelledby 关联标题，隐藏 input 只是表单镜像。
export function inspectProCheckoutOptions(expectedAmount) {
  const amounts = ['100', '200', '500'];
  if (location.origin !== 'https://chatgpt.com' || !/^\/checkout\//.test(location.pathname)
    || !amounts.includes(String(expectedAmount))) return null;
  const normalize = text => String(text || '').replace(/\s+/g, ' ').trim();
  const visible = node => {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== 'hidden';
  };
  const groupLabel = group => normalize(group.getAttribute('aria-label')
    || (group.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' '));
  const groups = [...document.querySelectorAll('[role="radiogroup"]')]
    .filter(group => visible(group) && groupLabel(group) === 'Pro plan');
  if (groups.length !== 1) return null;
  const radios = [...groups[0].querySelectorAll('[role="radio"]')].filter(visible);
  const values = ['chatgptprolite', 'chatgptpro', 'chatgptpromax'];
  const options = amounts.map((amount, index) => radios.filter(node =>
    node.getAttribute('value') === values[index]
    && new RegExp('^\\$' + amount + '(?:\\.00)?(?:\\s|$)').test(normalize(node.innerText))));
  if (radios.length !== 3 || options.some(matches => matches.length !== 1)) return null;
  const option = options[amounts.indexOf(String(expectedAmount))][0];
  const rect = option.getBoundingClientRect();
  return {
    optionPoint: {x:rect.left + rect.width / 2, y:rect.top + rect.height / 2},
    selected: option.getAttribute('aria-checked') === 'true'
      && radios.filter(node => node.getAttribute('aria-checked') === 'true').length === 1,
    enabled: !option.disabled && option.getAttribute('aria-disabled') !== 'true'
      && groups[0].getAttribute('aria-disabled') !== 'true',
    viewport: {width:innerWidth, height:innerHeight},
  };
}

export function inspectProCheckout(expectedAmount) {
  const text = String(document.body?.innerText || '').replace(/\s+/g, ' ').trim();
  const due = text.match(/Due today\s*(?:USD\s*)?\$\s*([\d,]+(?:\.\d{2})?)/i);
  // 只校验 Due today，不拿侧边套餐价格代替实际本次应付；不一致时禁止进入卡资料填写。
  return {
    checkout: /\/checkout\//.test(location.pathname),
    pro: /\bPro\b/.test(text),
    dueToday: due ? Number(due[1].replace(/,/g, '')) : null,
    amountMatches: Boolean(due && Number(due[1].replace(/,/g, '')) === Number(expectedAmount)),
  };
}

export function inspectCheckoutSubmitButton() {
  // Upgrade to Pro 在套餐页也可能出现；只有 ChatGPT 结账页才将其视为支付提交按钮。
  const absent = { found: false, enabled: false, label: '' };
  if (location.origin !== 'https://chatgpt.com' || !/^\/checkout\//.test(location.pathname)) return absent;
  const normalize = (text) => String(text || '').replace(/\s+/g, ' ').trim();
  const candidates = [...document.querySelectorAll('button,[role="button"]')].filter((node) => {
    const rect = node.getBoundingClientRect();
    const label = normalize(node.innerText || node.textContent || node.getAttribute('aria-label'));
    return rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== 'hidden'
      && (label === 'Upgrade to Pro' || (/\bSubscribe\b/i.test(label) && !/\bUnsubscribe\b/i.test(label) && label.length <= 48));
  });
  if (candidates.length !== 1) return absent;
  const button = candidates[0];
  const rect = button.getBoundingClientRect();
  return { found: true, enabled: !button.disabled && button.getAttribute('aria-disabled') !== 'true',
    point: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
    viewport: { width: innerWidth, height: innerHeight },
    label: normalize(button.innerText || button.textContent || button.getAttribute('aria-label')) };
}
