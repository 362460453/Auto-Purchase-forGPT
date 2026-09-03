# Auto-Purchase-for-GPT 开发说明

本文档是本项目的主要开发约束。任何 AI 编程工具或开发者修改代码前，必须先读完本文档，再阅读将要修改的文件。不要只在旧逻辑后面叠加补丁；先理解完整状态机，再做最小、可验证的修改。

## 1. 项目目标与当前边界

这是一个仅在本机运行的 Node.js + 原生前端工具，用于批量启动指定 AdsPower Profile，并通过 Chrome DevTools Protocol（CDP）把 ChatGPT 个人版升级流程推进到填写支付资料并点击 `Subscribe`。

当前业务边界：

- 只支持个人版 `Maximum power`，页面实际按钮文案是 `Upgrade to Pro`。
- 只支持 `20x` 和 `5x`，默认 `20x`；对应页面 `Due today` 应分别为 `$200.00` 和 `$100.00`。
- 自动化填写账号、银行卡和 Billing 地址后，点击 `Subscribe`。
- 若页面出现 `Your payment was declined. Try a different card.` 等拒付或支付异常，只结束当前任务并写入失败原因；其他并发任务继续执行。
- 不实现团队版，不把其他产品强行套用到 Maximum power 的流程。
- 登录出现邮箱验证码、MFA、CAPTCHA 或风控时，只提示用户在 AdsPower 窗口中人工完成，不绕过验证。

## 2. 技术结构（用 Java 分层类比）

| 文件 | 职责 | Java 类比 |
| --- | --- | --- |
| `public/index.html` | 页面结构、任务表格、设置弹窗 | View |
| `public/styles.css` | 页面布局和滚动区域 | View 样式 |
| `public/app.js` | CSV 解析、设置、地址绑定、页面状态、API/SSE 交互 | 前端 Controller + ViewModel |
| `server.mjs` | 静态文件、任务 API、SSE、日志读写 | Controller |
| `src/automation/gpt-upgrade.mjs` | GPT 升级状态机、CDP 鼠标键盘、Stripe 表单 | Service |
| `src/automation/adspower.mjs` | AdsPower Local API 启停 Profile | 外部 API Client |
| `dev.mjs` | 轮询源文件并重启服务进程 | 本地开发启动器 |
| `start-local.sh` | 启动检查、运行热更新服务，不自动弹浏览器 | 启动脚本 |
| `data/logs/*.jsonl` | 按天保存执行事件 | 本地审计日志 |

项目无数据库、无框架、无构建步骤，也不要随意引入 React、Vue、Express、Puppeteer 或 Playwright。现有 CDP 实现是核心运行方式。

## 3. 启动与检查

```bash
./start-local.sh
```

- 默认地址：`http://127.0.0.1:4173`
- 启动脚本只启动服务，不自动打开浏览器页面。
- `dev.mjs` 每 600ms 检查 `.mjs`、`.js`、`.html`、`.css`，修改后自动重启服务，不需要用户手动重启。
- `AGENTS.md`、`README.md` 不在热更新监听范围内，因为它们不影响运行。

每次代码修改后至少执行：

```bash
npm run check
```

该命令只做 JavaScript 语法检查，不等于真实 AdsPower、ChatGPT 或 Stripe 流程已经验证。涉及浏览器状态机的修改，还需要在用户授权的 AdsPower 环境中做一次实机验证。

## 4. CSV 与设置数据契约

CSV 必须保持六列，列名区分大小写：

```text
adsPowerSerialNumber,email,password,cardNumber,expires_at,cvv
```

约束：

- `adsPowerSerialNumber` 是 AdsPower 的 `serial_number/profile_no`。
- 单次最多导入 100 条。
- CSV 解析支持双引号、逗号、CRLF、LF 和 UTF-8 BOM。
- 页面按用户要求完整展示邮箱、密码、卡号、有效期、CVV；不要自行增加脱敏。
- 敏感字段只能保存在当前页面内存或浏览器本地设置中，禁止写入日志、README、AGENTS、示例提交或错误消息。
- 模板文件和下载模板始终保持这六列，不要求用户在 CSV 增加 Billing 字段。

右上角“设置”保存在浏览器 `localStorage` 的 `gpt-upgrade-settings`：

```json
{
  "apiBase": "http://127.0.0.1:50325",
  "apiKey": ""
}
```

Billing 地址规则：

- 页面通过“Billing 地址州”下拉框选州，默认 `OR / Oregon`。
- 导入 CSV 时，为每条任务按当前所选州立即随机生成一条 Billing 地址并固定绑定。
- Billing 地址显示在任务表格 CVV 后面。
- 执行和手动重试必须复用该行第一次绑定的地址，禁止跨行借用卡、账号或地址，禁止在重试时临时换地址。
- `billingCountry` 固定为 `US`。

## 5. HTTP 与事件契约

### `POST /api/jobs`

请求体主要字段：

- `rows`：已绑定 Billing 地址的任务行。
- `concurrency`：1-10，服务层再次限制边界。
- `product`：当前只能是 `Maximum power`。
- `multiplier`：`20x` 或 `5x`。
- `apiBase`、`apiKey`：AdsPower 设置。

接口校验后立即返回 HTTP 202 和 `jobId`，任务在后台运行。不要把整条自动化阻塞在 HTTP 请求上。

### `GET /api/events`

SSE 实时推送任务事件。关键类型：

- `job_started`、`job_finished`、`job_failed`
- `row_started`、`browser_started`、`step_started`
- `login_verification_required`
- `plans_discovered`
- `payment_confirmation_required`
- `row_succeeded`
- `row_failed`

### `GET /api/logs`

- 执行事件按天追加到 `data/logs/events-YYYY-MM-DD.jsonl`。
- 不自动清理日志。只有用户明确要求时才手动删除。
- API/页面最多读取或展示最新 1000 条，这是展示上限，不是磁盘保留期限。
- 日志必须带时间、任务行号、AdsPower 编号、当前步骤和具体失败原因。
- 日志不得包含 API-Key、密码、完整卡资料或完整 Billing 地址。

## 6. 单条任务的完整 SOP

不要跳步，也不要仅因为元素刚渲染出来就立即判断成功或失败。每一步都要等待并校验下一状态。

1. 校验当前行六个 CSV 字段，校验 Billing 国家只允许美国。
2. 调用 AdsPower Local API 启动当前 `adsPowerSerialNumber`。
3. 优先调用 `/api/v2/browser-profile/start`，失败后兼容 `/api/v1/browser/start`。
4. 连接 AdsPower 返回的 CDP 调试端口，找到 ChatGPT 页面；没有 ChatGPT 页面时使用可控制的普通页面。
5. 检查当前 URL。若上次任务遗留在 `#pricing`、checkout 或其他页面，必须先导航到 `https://chatgpt.com/`，每条任务从首页重新开始。
6. 等待首页或登录入口加载。若出现邮箱输入框：逐字符键盘输入邮箱，点击 `Continue`；等待密码框，逐字符输入密码，再点击 `Continue`。
7. 若出现邮箱验证码、MFA、CAPTCHA 或风控，记录提示并等待用户人工处理；不要尝试规避。
8. 等待 ChatGPT 首页稳定，然后精确点击页面右上角文字为 `Upgrade` 的按钮。不要点左下角头像、账号菜单或其他 Upgrade。
9. 必须确认 URL 进入 `#pricing` 且页面出现 `Upgrade your plan`，否则当前点击不算成功。
10. 用真实鼠标滚轮向下滚动，把 `See all plans` 滚入可视区域。
11. 精确点击 `See all plans`，然后最多等待 5 秒查找同一卡片内的 `Maximum power` 和 `Upgrade to Pro`。5 秒内找到即成功，不能刚展开页面就失败或关闭浏览器。
12. 将 `Upgrade to Pro` 滚入可视区域，等待布局稳定后重新读取坐标，再用真实鼠标点击。
13. 确认进入 `/checkout/` 或出现 `Getting your plan ready`，最终等待 `Configure your plan` 完整加载。
14. 选择 `20x more usage than Plus` 或 `5x more usage than Plus`，同时校验单选状态和右侧 `Due today` 金额已经更新。
15. 等待 Stripe Payment iframe；如果当前是其他支付方式且能看到 `Card`，用真实鼠标点击 `Card`，并等到卡号、有效期、CVV 都刷新出来且布局稳定后，才能开始输入卡号。
16. 严格依次填写：银行卡号 -> 有效期 -> CVV。一个输入框完整输入、Tab 失焦、确认位数后，才能输入下一个。卡号被 Stripe 刷新打断时，等待 Card 表单重新出现后继续输入剩余位数，不能因此结束当前字段。
17. 三项全部输入完成后再统一读取 Stripe 的错误状态。输入过程中的 `incomplete` 提示属于临时状态，不能提前判失败。
18. 等待 Stripe Address iframe。确认国家是 `United States`；不是美国时用键盘选择美国。
19. 严格依次填写 Full name 和 Address line 1。Address line 1 输入后，最多等待 5 秒让 City、State、ZIP code 动态出现。
20. 有 Address line 2 才填写；随后依次输入 City、用键盘选择 State、输入 ZIP code。
21. ZIP code 输入完成后等待 `Subscribe` 可点击，用真实鼠标点击一次 `Subscribe`，不得因结果未返回而补点第二次。
22. 点击后等待支付结果。若出现 `Your payment was declined. Try a different card.` 等拒付或支付异常，当前任务失败并关闭该条 Profile，失败原因写入任务列表；其他并发任务继续。
23. 未出现拒付且已离开 checkout 或出现订阅成功文案时，当前任务记为已完成并关闭该条 Profile。

## 7. 鼠标、键盘与等待的硬规则

### 鼠标

- 外部页面按钮使用 CDP `Input.dispatchMouseEvent` 的 `mouseMoved -> mousePressed -> mouseReleased`。
- 不用 `element.click()` 代替真实鼠标操作。
- 点击前必须确认元素可见、未禁用、坐标位于当前 viewport 内。
- React 页面可能水合或重新排版。读取坐标后要等待稳定，再重新读取坐标。
- 只有当前控件点击后没有发生预期状态变化时，允许重新定位并补点当前控件一次；这不等于重跑整条任务。

### 键盘

- 所有外部输入框必须使用 CDP `rawKeyDown -> char -> keyUp` 逐字符输入。
- 每个字段输入后必须发送 `Tab` 触发页面原生格式化和校验。
- 不得通过 JavaScript 直接设置 `element.value`，不得一次性注入整个值。
- 外部表单可能吞键。每个卡字段按最终数字位数校验。有效期和 CVV 只允许慢速重输当前字段一次；卡号被 Stripe 刷新打断时，等待 Card 表单重新出现后继续输入剩余位数。这两种局部恢复都不能扩大成整条任务自动重试。
- CSV 有效期采用 `MMYY`。例如 `0931` 在 Stripe 中键盘输入 `931`，页面会格式化为 `09/31`；最终仍按四位数字校验。

### 等待

- 固定 `sleep` 只能用于防抖、布局稳定或按键间隔，不能作为业务完成证据。
- 业务步骤必须轮询明确状态：URL、页面文字、元素可见性、选中状态、输入位数或最终错误状态。
- 页面加载需要时间，不得因为按钮或套餐暂时未出现而立即关闭浏览器。
- 修改超时时间时必须写中文注释说明等待哪个业务状态以及超时后的风险。

## 8. Stripe iframe 约束

Stripe 的银行卡和 Billing 地址位于独立 iframe Target，不在 ChatGPT 主页面 DOM 中：

- Payment iframe URL 匹配：`elements-inner-payment` 且 `componentName=payment`。
- Address iframe URL 匹配：`elements-inner-address` 且 `componentName=address`。
- 卡字段：`#payment-numberInput`、`#payment-expiryInput`、`#payment-cvcInput`。
- 地址字段可能在 Address line 1 输入后动态出现，不能在输入前就判断 City、State、ZIP 缺失。
- 页面可能改版。选择器失效时应先读取当前 DOM、可见文字和 Target 列表，再小范围更新；不要加入大量无证据的备用选择器。

## 9. 异常、并发和重试

- 每条任务维护 `currentStep`。任何异常都要形成“当前步骤失败：具体原因”。
- 一条任务失败后，立即停止并关闭该条 AdsPower Profile，发送 `row_failed`；其他并发任务继续执行。
- `runWithConcurrency` 使用共享游标组成固定大小的执行池，并发限制 1-10。并发为 5 时先同时领取列表前 5 条；任意一条完成或失败后，立刻按列表顺序领取下一条，始终保持同时执行数为设定并发（剩余任务不足时自然减少）。结果仍按输入顺序保存。一条失败只关闭该条 Profile，不减少其他空位、不中断其他正在执行的任务。
- 不实现“自动重试三次”或整行自动重跑。
- 页面“重试”按钮只重新提交失败行，并通过 `__uiIndex` 映射回原表格行。
- 重试必须使用原任务行的账号、卡和已绑定地址。
- 单个 UI 控件因页面水合被吞点击时，可以仅补点该控件一次；有效期和 CVV 吞键时，可以仅慢速重输该字段一次；卡号被 Stripe 刷新打断时，等待 Card 表单出现后继续输入剩余位数。这些局部恢复不能扩大成整条任务自动重试。
- 达到 `row_succeeded` 后不再算失败，也不进入“重试”列表。

## 10. AdsPower 生命周期

- 启动请求关闭 AdsPower 自带密码填充/保存，并设置不恢复旧标签；即使 AdsPower 恢复了旧页面，GPT 状态机仍必须主动返回首页。
- 启动成功后必须同时解析 `debug_port` 或 Puppeteer WebSocket 地址。
- 失败路径必须调用 `stopAdsPowerProfile`，关闭当前浏览器后再结束该行。
- 点击 `Subscribe` 后无论成功还是拒付，都关闭当前 Profile；不要因为一条失败而关闭其他并发任务的 Profile。

## 11. 前端状态规则

- 导入成功后立即在下方展示完整任务列表和绑定地址。
- 任务超过 10 条时表格固定高度滚动；执行日志超过 10 条时日志区固定高度滚动。
- 每行状态至少区分：`待执行`、`执行中`、`失败`、`已完成`。
- 失败原因独立一列完整保存，不要只显示“失败”。单元格显示不下时，单击该单元格放大全文；再单击页面其他位置取消放大。
- 执行日志使用本地时间展示，并保留服务端事件时间戳。
- 当前只展示 `Maximum power`，不要根据营销标题猜测其他产品流程。
- 设置保存在当前浏览器本地，不得擅自清空、迁移或覆盖用户已有配置。

## 12. 修改代码时的检查清单

修改前：

1. 阅读本文件、README 和受影响模块的完整实现。
2. 用 `rg` 找到相关方法、事件类型、选择器和调用方。
3. 确认修改影响的是 View、Controller、Service 还是 AdsPower Client。

修改中：

1. 沿用现有原生 JS 和函数式结构，避免无关重构。
2. 删除被新逻辑替代的旧分支，不要无限叠加 fallback。
3. 并发、支付、时间、状态、外部 API 和日志逻辑必须添加简洁中文注释，解释业务口径和风险。
4. 不记录或提交任何真实秘密和支付资料。

修改后：

1. 运行 `npm run check`。
2. 用 `rg` 检查废弃常量、旧文案和无调用方法。
3. 对状态机改动列出“点击动作 -> 成功判据 -> 超时原因”。
4. 明确说明只做了静态检查，还是完成了 AdsPower 实机验证。
5. 不擅自推送远程，不删除日志，不清空本地设置。

## 13. 已知易变点

ChatGPT 和 Stripe 都是外部页面，英文文案、DOM 层级、iframe URL 与字段 ID 可能变化。出现失败时，应优先查看带时间的当前步骤日志，并检查实际页面与 CDP Target；不要把“元素暂时没加载”“点错区域”“输入还没完成”误判为产品不存在、银行卡无效或地址缺失。

最关键的状态链如下：

```text
AdsPower 启动
  -> 强制回 ChatGPT 首页
  -> 登录或等待人工验证
  -> 右上角 Upgrade
  -> 确认 #pricing 弹窗
  -> 滚动并点击 See all plans
  -> 5 秒内识别 Maximum power
  -> 点击 Upgrade to Pro
  -> 等待 checkout 完整加载
  -> 选择 20x/5x 并校验 Due today
  -> 等待 Card 支付表单刷新稳定
  -> Card 三字段逐个键盘输入；卡号被打断则继续补齐
  -> 三字段统一最终校验
  -> 美国 Billing 地址逐个键盘输入
  -> ZIP 完成后点击 Subscribe（只点一次）
  -> 拒付则当前任务失败；成功则记为已完成
  -> 关闭当前 Profile，不影响其他并发任务
```
