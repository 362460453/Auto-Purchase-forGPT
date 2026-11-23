# Auto-Purchase-for-GPT 开发说明

本文档是本项目的主要开发约束。任何 AI 编程工具或开发者修改代码前，必须先读完本文档，再阅读将要修改的文件。不要只在旧逻辑后面叠加补丁；先理解完整状态机，再做最小、可验证的修改。

## 1. 项目目标与当前边界

这是一个仅在本机运行的 Node.js + 原生前端工具，用于批量启动指定 AdsPower Profile，并通过 Chrome DevTools Protocol（CDP）把 ChatGPT 个人版升级流程推进到填写支付资料并点击 `Subscribe`。

当前业务边界：

- AdsPower 模式只支持个人版 `Pro`；新版卡片显示 `Frontier intelligence`，规格按钮为 `100`、`200`、`500`，购买按钮是同一卡片内唯一的 `Buy now`、`Upgrade to Pro`、`Get started` 或 `Start now`。
- AdsPower 模式支持 `$100`、`$200`、`$500 / 月`，默认 `$200 / 月`。结账页 `Due today` 必须与所选金额一致，不一致时停止填写卡资料。
- 无痕模式开发暂停，保留现有 `20x` / `5x` 流程，不套用 AdsPower 新规格。
- 自动化填写账号、银行卡和 Billing 地址后，点击 `Subscribe`。
- 若页面出现 `Your payment was declined. Try a different card.` 等拒付或支付异常，只结束当前任务并写入失败原因；其他并发任务继续执行。
- 不实现团队版，不把其他产品强行套用到 Pro 的流程。
- 登录出现邮箱验证码、MFA、CAPTCHA 或风控时，只提示用户在 AdsPower 窗口中人工完成，不绕过验证。

- 时间规则（2026-11-22 最新要求）：一条任务总共 10 分钟，各小阶段不额外设置结束时限。截图、CPA、2FA 和人工登录等待全部共享任务开始时的同一个截止时间；明确的拒付、手机号要求和页面错误仍立即处理。

## 2. 技术结构（用 Java 分层类比）

| 文件 | 职责 | Java 类比 |
| --- | --- | --- |
| `public/index.html` | 页面结构、任务表格、设置弹窗 | View |
| `public/styles.css` | 页面布局和滚动区域 | View 样式 |
| `public/app.js` | CSV 解析、设置、地址绑定、页面状态、API/SSE 交互 | 前端 Controller + ViewModel |
| `server.mjs` | 静态文件、任务 API、SSE、日志读写 | Controller |
| `src/automation/two-factor.mjs` / `totp.mjs` | 2FA 设置状态机、本机 TOTP | 安全附加任务 |
| `src/job-results.mjs` | 凭批次令牌读取内存中的 CPA JSON / Key，剔除广播秘密字段 | 私有任务结果 |
| `src/automation/codex-oauth.mjs` / `codex-driver.mjs` | Codex PKCE 授权、CDP 回调截获、同 Profile 兑换与 JSON 生成 | CPA 附加任务 |
| `src/automation/pro-plans.mjs` | Pro 金额契约、卡片识别、结账金额读取 | 套餐规则 |
| `src/automation/gpt-upgrade.mjs` | GPT 升级状态机、CDP 鼠标键盘、Stripe 表单 | Service |
| `src/automation/adspower.mjs` | AdsPower Local API 启停 Profile | 外部 API Client |
| `src/temp-screenshots.mjs` | 临时截图目录与退出清理 | 临时文件 |
| `dev.mjs` | 轮询源文件并重启服务进程 | 本地开发启动器 |
| `start-mac.command` / `start-local.sh` | Mac 单文件启动器及旧入口兼容，自动下载/更新后运行 | 启动脚本 |
| `start-windows.bat` / `start-windows.ps1` | Windows 两文件启动器，自动安装依赖、下载/更新后运行 | 启动脚本 |
| `data/logs/*.jsonl` | 按天保存执行事件 | 本地审计日志 |

项目无数据库、无框架、无构建步骤，也不要随意引入 React、Vue、Express、Puppeteer 或 Playwright。现有 CDP 实现是核心运行方式。

## 3. 启动与检查

- Mac 单独分发 `start-mac.command`，双击即可；仓库内原来的 `./start-local.sh` 转到此入口。
- Windows 分发 `start-windows.bat` 和 `start-windows.ps1`，同目录放置，只双击 BAT。仓库内旧入口保留转发兼容。
- 两系统统一：Node.js 22+ / Git 检查 → 没有项目下载 main → 已有项目快进更新 → `node dev.mjs`。本机优先用脚本所在项目，单独启动器默认用用户目录 `Auto-Purchase-forGPT`，支持 `GPT_UPGRADE_PROJECT_DIR`。
- Windows 用 winget 安装依赖并显式检查退出码；PowerShell 保留 UTF-8 BOM。Mac 缺 Node 时下载官方 22 LTS、核对 SHA256 并使用用户缓存；缺 Git 时调起苹果 Command Line Tools，等待用户完成系统安装。
- 本地修改、非 main 或分歧必须保留，不得 `reset --hard` 或强制切分支；网络更新失败允许明确提示后使用已有版本。首次下载用临时目录，完整后再移入目标，失败不得污染目标。
- 更新前检查端口；已运行则停止本次启动，防止更新触发进行中任务的热重启。脚本不能清空日志、配置或用户文件；不自动弹浏览器。
- 分发 ZIP 保留 Mac 可执行位；BAT / PS1 使用 CRLF，Mac 脚本使用 LF。启动器回归 `node --test tests/launchers.test.mjs`；没有 pwsh 时 Windows 集成测试会跳过，需如实说明验证边界。

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

AdsPower CSV 使用五列，不读取密码，列名区分大小写：

```text
adsPowerSerialNumber,email,cardNumber,expires_at,cvv
```

约束：

- `adsPowerSerialNumber` 是 AdsPower 的 `serial_number/profile_no`。
- 单次最多导入 100 条。
- CSV 解析支持双引号、逗号、CRLF、LF 和 UTF-8 BOM。
- AdsPower 页面完整展示邮箱、卡号、有效期、CVV，不再展示密码；不要自行增加脱敏。
- 敏感字段只在当前页面内存或浏览器本地设置中使用；用户主动点击“导出 CSV”时允许下载邮箱、密码等结果字段。禁止写入服务端日志、README、AGENTS、示例提交或错误消息。
- AdsPower 模板文件和下载模板保持这五列；旧 CSV 中的 password 及额外列不导入、不传给自动化，不要求用户增加 Billing 字段。无痕模式暂停开发，保留原有密码及 mailAccess 格式。

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
- `product`：当前只能是 `Pro`。
- AdsPower 使用 `planAmount`：`"100"`、`"200"`、`"500"`（也接受同值数字），默认 `"200"`。HTTP 接口在启动任务前校验。
- 未刷新的旧客户端仍可传 `multiplier`：`20x` 映射 `200`，`5x` 映射 `100`；新客户端不再用倍率表示 AdsPower 规格。无痕模式仍传原有 `multiplier`。
- `additionalOptions`：数组，可选 `screenshot`、`cpa`、`2fa`；CPA / 2FA 仅支持 AdsPower。空数组不执行附加任务，缺省兼容旧客户端默认截图。顺序固定为截图 → CPA → 2FA，未勾选的步骤不执行。
- `apiBase`、`apiKey`：AdsPower 设置。

接口校验后立即返回 HTTP 202、`jobId` 和仅当前页面保存的 `resultToken`，任务在后台运行。不要把整条自动化阻塞在 HTTP 请求上。

### `GET /api/jobs/:jobId/results`

用 `Authorization: Bearer <resultToken>` 读取该批次已取得的 CPA JSON 和 2FA Key，禁止把令牌放 URL。只在服务内存保留，响应 `Cache-Control: no-store`；SSE 和磁盘日志均剔除 `cpaJson` 和 `twoFactorKey`。前端收到 `post_purchase_progress` / `row_succeeded` 后拉取并保存到当前页面内存，CSV 导出前补取遗漏的私有结果。已取回的 Key 可在服务关闭后从原页面导出，刷新页面会丢失任务及令牌。

### `POST /api/jobs/stop`

请求终止当前任务批次的排队项。已经领取并正在执行的任务继续跑完；尚未领取的任务标记为取消，不再启动 AdsPower。接口立即返回 HTTP 202。

### `GET /api/events`

SSE 实时推送任务事件。关键类型：

- `job_started`、`job_stop_requested`、`job_finished`、`job_failed`
- `row_started`、`browser_started`、`step_started`
- `login_verification_required`
- `plans_discovered`
- `payment_confirmation_required`
- `post_purchase_progress`（附加项状态，不带 CPA JSON / Key）
- `row_succeeded`
- `row_failed`
- `row_cancelled`

### `GET /api/logs`

- 执行事件按天追加到 `data/logs/events-YYYY-MM-DD.jsonl`。
- 不自动清理日志。只有用户明确要求时才手动删除。
- API/页面最多读取或展示最新 1000 条，这是展示上限，不是磁盘保留期限。
- 日志必须带时间、任务行号、AdsPower 编号、当前步骤和具体失败原因。
- 日志不得包含 API-Key、密码、完整卡资料、完整 Billing 地址、2FA Key、验证码、OAuth 授权码、verifier、完整授权 URL 或 token。

## 6. 单条任务的完整 SOP

不要跳步，也不要仅因为元素刚渲染出来就立即判断成功或失败。每一步都要等待并校验下一状态。

1. 校验 AdsPower 当前行五个 CSV 字段，校验 Billing 国家只允许美国。
2. 调用 AdsPower Local API 启动当前 `adsPowerSerialNumber`。
3. 优先调用 `/api/v2/browser-profile/start`，失败后兼容 `/api/v1/browser/start`。
4. 连接 AdsPower 返回的 CDP 调试端口，找到 ChatGPT 页面；没有 ChatGPT 页面时使用可控制的普通页面。
5. 检查当前 URL。若上次任务遗留在 `#pricing`、checkout 或其他页面，必须先导航到 `https://chatgpt.com/`，每条任务从首页重新开始。
6. 等待首页或登录入口加载。AdsPower 优先复用已登录状态；若出现邮箱输入框，逐字符输入邮箱并点击 `Continue`。遇密码框或验证码只提示人工处理，不读取密码；确认回到已登录首页再继续。人工等待计入整行 10 分钟上限。
7. 若出现邮箱验证码、MFA、CAPTCHA 或风控，记录提示并等待用户人工处理；不要尝试规避。
8. 等待 ChatGPT 首页稳定。优先精确点击右上角文字为 `Upgrade` 的按钮；没有 Upgrade 时改点右上角 `Free offer`，再没有则点可见的 `Claim offer`。不要点左下角头像、账号菜单里的 Upgrade。
9. 必须确认 URL 进入 `#pricing`。标准弹窗会出现 `Upgrade your plan`；右上角 `Free offer` 可能打开 `plus-1-month-free` 促销价页（`Claim free offer`），这也算套餐页已打开。新版也识别 `Frontier intelligence` 和 `Buy now` / `Upgrade to Pro` / `Get started` / `Start now`。不要点促销页里的 `Claim free offer`，那是 Plus 试用，不是 Maximum power。
10. AdsPower 模式先检查是否已显示含三档金额的 Pro 卡片；已出现则直接处理。未出现时用真实鼠标滚轮向下滚动，把 `See all plans` 滚入可视区域。
11. 精确点击 `See all plans`（页面若只显示 `See all` 也可以）。不要点 `See billing help`。轮询同一卡片内的 Pro、100/200/500 和唯一购买按钮，出现完整卡片才继续。所有等待只使用整行剩余时间，不设独立的 5 秒或 60 秒阶段上限；未确认完整卡片不能进入购买。
12. 在 Pro 卡片内用真实鼠标选择 `100`、`200` 或 `500`，等卡片月费及可读取的选中属性更新。随后将同一卡片的购买按钮（`Buy now`、`Upgrade to Pro`、`Get started` 或 `Start now`）滚入可视区域，等待布局稳定并重新读坐标；点击前再次校验所选月费。
13. 确认进入 `/checkout/` 或出现 `Getting your plan ready`，最终等待结账页显示 Pro 和 `Due today`。
14. AdsPower 已在卡片上选好月费，持续等待结账页 Pro 和 Due today 等于所选金额，使用整行剩余时间；不匹配时禁止填卡和提交支付。无痕模式保留原有 checkout 倍率选择。
15. 等待 Stripe Payment iframe；如果当前是其他支付方式且能看到 `Card`，用真实鼠标点击 `Card`，并等到卡号、有效期、CVV 都刷新出来且布局稳定后，才能开始输入卡号。
16. 严格依次填写：银行卡号 -> 有效期 -> CVV。一个输入框完整输入、Tab 失焦、确认位数后，才能输入下一个。卡号被 Stripe 刷新打断时，等待 Card 表单重新出现后继续输入剩余位数，不能因此结束当前字段。
17. 三项全部输入完成后再统一读取 Stripe 的错误状态。输入过程中的 `incomplete` 提示属于临时状态，不能提前判失败。
18. 等待 Stripe Address iframe。先判断国家是不是 `United States`。国家字段特殊：必须是美国；已经是美国才跳过，其他国家即使有值也必须替换成美国。不要把“输入框已有值就跳过”套用到国家字段。
19. 严格依次填写 Full name 和 Address line 1。某个地址输入框里已经有值时，不要清空或覆盖，直接跳过该字段。Address line 1 输入后，按整行剩余时间等待 City、State、ZIP code 动态出现。
20. 有 Address line 2 才填写；随后依次处理 City、State、ZIP code。这些字段若已被自动填充或已有内容，同样跳过，禁止替换。不要把真实地址写入日志。
21. ZIP code 输入完成后等待结账页含 `Subscribe` 的订阅按钮可点击（不按产品名精确匹配），用和其他按钮相同的真实鼠标点击。AdsPower 提交后页面没有变化时继续等待，不自动补点；无痕模式保留 10 秒内未开始处理时补点一次的原流程。不要点 `Unsubscribe` 或条款长文里的 Subscribe。
22. 点击后持续等待成功或明确失败，使用整行剩余时间，不设单独的 90 秒时限。若出现 `Your payment was declined. Try a different card.` 等拒付或支付异常，当前任务失败并关闭该条 Profile，失败原因写入任务列表；其他并发任务继续。整条任务仍受 10 分钟上限约束。
23. 必须等支付结果确认成功，不能把已点击或支付处理中当作成功。未勾选附加选项时直接标记已完成并关闭 Profile；勾选截图执行第 24–26 步，随后执行所选 CPA（见第 17 节），最后执行所选 2FA（第 27 步）。支付成功后，ChatGPT 常会自动跳回 `https://chatgpt.com/`。一旦 CDP 标签已经离开 checkout，立刻进入 Billing 截图，不要再对旧结账页做长时间 evaluate。若已经在首页，不要再强制刷新。
24. 返回首页后使用整行剩余时间轮询，等待侧栏左下角头像可点击且坐标在视口内；出现后立即用真实鼠标点击，打开账号菜单后点击 `Settings`，不固定空等。等待计入整行 10 分钟，超时只记当前附加项异常，保留付款成功。这里点击头像只为打开 Settings，不要点账号菜单里的 Upgrade，也不要点右侧 Store 图标。
25. 设置弹窗打开后点击左侧 `Billing`。Billing 内容在 `tabpanel` 里，用真实鼠标滚轮稍微滑动（每次约原先三分之一），让订阅套餐和邮箱同时进入画面后截图。不要把邮箱写入日志。对齐不完美也要截图，不能因此把已扣款任务打进失败重试。
26. 仅勾选截图时，截图写入 `data/screenshots/` 作为当前服务会话的临时文件，不写入执行日志。任务表格在操作列后提供“复制”，把图片写入系统剪贴板。关闭本地服务（不是热更新重启）后删除这些临时文件。截图完成后再把该行标为 `已完成`，然后关闭当前 Profile。截图失败不能把已扣款任务打进失败重试列表。

27. 勾选 2FA 时，在 Settings 点击 `Security and login`，找到 `Authenticator app` 开关。原已开启则不修改、不重置，返回“原已启用，未取得 Key”。未开启则点开关 → `Continue` → `Key` → 读取并立即在内存保留密钥 → `Continue` → 本机 SHA-1 / 30 秒 / 6 位 TOTP → 逐字符填入 `Code` → `Tab` → `Continue`。只有验证弹窗退出且开关明确已开启，才记录 2FA 成功；拒绝、超时或未确认时保留已读 Key 并标注异常。一个附加项失败不阻止另一个，整行仍遵守 10 分钟上限，已付款不能进入充值重试。

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

- Payment iframe URL 匹配：`elements-inner-` 文件名（旧版 `elements-inner-payment`，现版 `elements-inner-accessory-target`）且 `componentName=payment`。不要匹配同文件名的 `componentName=expressCheckout`。
- Address iframe URL 匹配：同样是 `elements-inner-` 文件名，且 `componentName=address`。
- 卡字段：`#payment-numberInput`、`#payment-expiryInput`、`#payment-cvcInput`。
- 地址字段可能在 Address line 1 输入后动态出现，不能在输入前就判断 City、State、ZIP 缺失。
- 页面可能改版。选择器失效时应先读取当前 DOM、可见文字和 Target 列表，再小范围更新；不要加入大量无证据的备用选择器。

## 9. 异常、并发和重试

- 每条任务维护 `currentStep`。任何异常都要形成“当前步骤失败：具体原因”。
- 每条任务从开始执行起一共最多 10 分钟，浏览器启动、登录、选套餐、支付、截图、CPA 和 2FA 共用一次截止时间。各小阶段不另设业务超时，不重置计时。超时立即关闭该条 AdsPower Profile，按当前步骤发送 `row_failed`，并释放并发空位；其他正在执行的任务不受影响。Subscribe 点击后页面转圈也算在这 10 分钟内。
- 一条任务失败后，立即停止并关闭该条 AdsPower Profile，发送 `row_failed`；其他并发任务继续执行。
- `runWithConcurrency` 使用共享游标组成固定大小的执行池，并发限制 1-10。并发为 5 时先同时领取列表前 5 条；任意一条完成或失败后，立刻按列表顺序领取下一条，始终保持同时执行数为设定并发（剩余任务不足时自然减少）。结果仍按输入顺序保存。一条失败只关闭该条 Profile，不减少其他空位、不中断其他正在执行的任务。
- 页面“终止所有任务”只停止领取排队项：正在执行的任务继续跑完，尚未开始的任务标记为 `已取消`，不进入失败重试列表。
- 不实现“自动重试三次”或整行自动重跑。
- 页面底部“重试”只重新提交全部失败行；每一行操作列的“重试”只重新提交该行。两种重试都通过 `__uiIndex` 映射回原表格行，并复用该行首次绑定的账号、卡和地址。
- 单个 UI 控件因页面水合被吞点击时，可以仅补点该控件一次；有效期和 CVV 吞键时，可以仅慢速重输该字段一次；卡号被 Stripe 刷新打断时，等待 Card 表单出现后继续输入剩余位数。这些局部恢复不能扩大成整条任务自动重试。
- 达到 `row_succeeded` 后不再算失败，也不进入“重试”列表；单行重试和重新启动整批也跳过已完成行。
- 仅在支付成功回调后设置 `paymentConfirmed`，不得用步骤文字（如第一次点击、支付处理中）推断成功。未确认成功时拒付/超时仍为失败；确认成功后的截图异常单独记入 `screenshotError`，CPA 异常记入 `cpaError`，2FA 异常记入 `twoFactorError`；总超时保留已有截图、CPA JSON 和 Key，不得重跑充值。

## 10. AdsPower 生命周期

- 启动请求关闭 AdsPower 自带密码填充/保存，并设置不恢复旧标签；即使 AdsPower 恢复了旧页面，GPT 状态机仍必须主动返回首页。
- 启动成功后必须同时解析 `debug_port` 或 Puppeteer WebSocket 地址。
- 失败路径必须调用 `stopAdsPowerProfile`，关闭当前浏览器后再结束该行。
- 点击 `Subscribe` 后无论成功还是拒付，都关闭当前 Profile；不要因为一条失败而关闭其他并发任务的 Profile。

## 11. 前端状态规则

- 充值前提供多选附加项：截图默认勾选；启用并导出 2FA、导出 CPA 可选（仅 AdsPower）。启动时固定本批选项，执行中不可改动或重新导入。
- 导入成功后立即在下方展示完整任务列表和绑定地址。
- “导出 CSV”下载当前所有任务，包含邮箱、密码（保留兼容列，AdsPower 新导入任务为空）、订阅类型、cpa、2fa、AdsPower编号、任务状态、失败原因、截图状态、结束时间、2FA状态、CPA状态。cpa 为本次有效授权后得到的紧凑 JSON，2fa 为本次读取的 Key，失败/未确认也保留 Key 并在状态列注明；不导出卡资料和完整地址。已提交任务的订阅类型取本行执行快照，不被后续全局规格覆盖。导出用 UTF-8 BOM、CRLF 和标准引号转义，只在浏览器生成文件，不经服务端日志。
- 任务超过 10 条时表格固定高度滚动；执行日志超过 10 条时日志区固定高度滚动。
- 每行状态至少区分：`待执行`、`执行中`、`失败`、`已完成`、`已取消`。
- 任务表格操作列提供单行“重试”，其后紧跟“从本行继续”。后者按列表顺序提交本行及后续待执行、失败、已取消行，保留原 __uiIndex 及首次绑定资料，跳过已付款/已完成行，沿用当前并发、套餐和附加选项。整批执行期间禁用；本行及后续没有可执行行时禁用。
- 操作列后面是“复制”：只有该行已有 Billing 截图时才能点，把图片复制到剪贴板。截图是当前服务会话的临时文件，关闭本地服务后删除，不长期保留。
- 扣款成功后的 Billing 截图显示在任务行最后一列；单元格显示缩略图，单击放大，再单击页面其他位置取消放大。
- 失败原因独立一列完整保存，不要只显示“失败”。单元格显示不下时，单击该单元格放大全文；弹窗支持选中文字和“复制全文”，点击弹窗内部不关闭，点击外部才关闭。
- 执行日志使用本地时间展示，并保留服务端事件时间戳。
- AdsPower 展示 `Pro` 三档月费；`Frontier intelligence` 是营销标题，不能把其他卡片的 `Buy now` / `Upgrade to Pro` / `Get started` / `Start now` 当作 Pro。
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
  -> 右上角 Upgrade，没有则 Free offer / Claim offer
  -> 确认 #pricing（Upgrade your plan 或促销价页）
  -> 滚动并点击 See all plans，不要点 Claim free offer / See billing help
  -> 识别 Pro 三档金额卡片（已直接显示时跳过 See all plans）
  -> 选择 $100/$200/$500 并核对卡片月费
  -> 点击同一卡片唯一的 Buy now / Upgrade to Pro / Get started / Start now
  -> 等待 checkout 完整加载并核对 Pro / Due today
  -> 等待 Card 支付表单刷新稳定
  -> Card 三字段逐个键盘输入；卡号被打断则继续补齐
  -> 三字段统一最终校验
  -> 账单地址先确认国家是美国，其余字段已有值则跳过
  -> ZIP 完成后点击含 Subscribe 的结账订阅按钮（只点一次）
  -> 拒付则当前任务失败；确认成功后检查附加选项
  -> 未勾选则直接已完成；先按勾选项点头像 -> Settings -> Billing -> 截图，再按勾选项授权并导出 CPA，最后配置 2FA
  -> 附加步骤结束后标记已完成并关闭 Profile；截图、CPA 或 2FA 失败单独记录，不重跑充值
```


## 14. 2026-11-20 实机套餐识别修正

- 2026-11-22：14649 的 Pro 卡片使用 `Start now`，旧识别因缺少该文案把已显示的 100/200/500 卡片判为未加载。现在四种购买文案均限定在 Pro 卡片内且要求唯一，继续核对三档单选状态和月费。已用生产 CDP 套餐函数实机验证 100、200、500 三档切换及各自 `Due today` 金额；止于结账，未填卡、未提交付款。模拟回归覆盖四种文案 × 三档金额及跨套餐同名按钮隔离。

- 2026-11-22：14650 的 Pro 三档卡片购买按钮为 `Get started`，Plus/Go 也使用相同文案。仅在 `[data-pricing-plan="pro"]` 内当时接受唯一的三种购买文案，并继续核对 `Pro usage`、月费和选中状态。实机选择 500 → 点击 Pro 的 Get started → ChatGPT Pro / Due today $500.00，止于结账，未填卡、未扣款；连续两条不同文案的自动状态推进另有模拟回归测试。
- AdsPower 新版 Pro 卡片限定在 `[data-pricing-plan="pro"]`；金额按钮来自 `Pro usage` 单选组，必须核对 `aria-checked`。
- 价格含动画数字和读屏文字，禁止用整张卡片 `innerText` 拼接匹配月费。读取 `pro-pricing-column-cost` 内 `pricing-column-cost` 的 `.sr-only` 完整金额，并核对月付频率。
- 结账主按钮兼容 `Upgrade to Pro` 与旧 `Subscribe`；仅在 ChatGPT `/checkout/` 内识别，多个匹配按钮时停止，避免点错。
- 本次用户明确要求验证到结账为止，不填写银行卡、不提交扣款。

## 15. 附加任务与结果导出验证

`node --test tests/*.test.mjs` 包含无截图、截图成功/失败、支付拒付、附加阶段超时、旧客户端默认选项、未知选项拒绝及 CSV 特殊字符/套餐快照测试。模拟状态机测试不代表真实付费成功后已实机验证。

## 16. 2FA 附加任务验证口径

2026-11-21：已核对 AdsPower 实机的 Key 切换按钮、`Copy setup key`、`Enter the code`、`Code`（占位 `000000`）和 `Continue`。未通过本次实机操作确认最终启用；不能把 DOM/模拟状态机测试称为全流程实机通过。

`tests/two-factor.test.mjs` 使用 RFC 6238 公开向量测试 TOTP，覆盖开关原已开启、拒绝验证码、超时保留 Key、异常不泄密、CSV 和批次令牌隔离。读 Key 不使用系统剪贴板，避免并发账号相互覆盖；本机生成验证码，不访问第三方验证码站点。

## 17. CPA 授权与手机号终止

- 使用用户提供扩展相同的官方 Codex OAuth 参数和 PKCE，不读取 Cookie/session token，不安装扩展。每条任务独立 state、verifier 与授权标签。
- 从当前 Profile 新建空白标签，先绑定回调拦截再导航授权地址。只接受当前标签精确的 `http://localhost:1455/auth/callback`、唯一匹配 state 和唯一 code，code 只兑换一次。回调由 CDP 本地响应，无需监听固定端口，不影响其他 Codex 进程或并发 Profile。
- 只选择与任务邮箱一致的账号；无匹配则 Use another account，按当前行邮箱逐字符登录，不读取密码；密码、验证码、MFA、CAPTCHA 等等待人工完成；遇到 `/add-phone`、Phone number required 或可见手机号输入框立即结束当前 CPA，关闭自建授权标签，不输入手机号、不发送短信。其他附加项和其他行继续。
- 在当前 Profile 的官方 auth.openai.com 同源上下文 POST `/oauth/token`，沿用浏览器代理。校验三种 token、账号 ID、邮箱与过期时间后生成扩展兼容单行 JSON。CSV `cpa` 保存该 JSON 字符串，失败保持为空并独立显示 CPA 状态/原因。
- 动作 → 判据 → 上限：新标签导航授权 → 官方登录/账号选择/授权页面；点击 Continue → 下一状态或有效回调；回调 → 唯一 state/标签匹配并进入官方同源上下文；兑换 → 凭据完整且邮箱匹配。全部步骤共用整行 10 分钟剩余时间，取消独立的 60/15/20 秒上限。8 秒只用于当前控件的一次补点，补点后仍等待共享上限；不因此提前判失败。整行结束保留已有 CPA、截图和 Key，已付款不得进入充值重试。
- `cpaJson` 和 `twoFactorKey` 只存在服务/当前页面内存及用户主动下载的 CSV，广播仅提供 `cpaJsonAvailable` / `twoFactorKeyAvailable`。私有结果按 jobId + index 分别合并，不能互相覆盖。
- 2026-11-21 已在 AdsPower 13963 手动核对账号选择 → Phone number required，按用户要求关闭授权标签，未填写手机号、未获得真实 token。成功授权/同源兑换的完整自动流程尚未实机验证；测试用模拟回调/接口响应验证，不能称为真实 CPA 导出成功。

## 18. 独立附加任务与付款保护

- 每次任务从开始执行起一共 10 分钟，包含浏览器启动。购买任务内的截图 → CPA → 2FA 与购买过程共用原截止时间，不增加任何附加时长。用户单独发起一个附加任务时，该次任务也只建立一次 10 分钟截止时间，内部小阶段同样共享。
- `runAdditionalJob` 与购买服务分离，仅调用共用附加动作。`POST /api/jobs/additional` 每次只接收一个 `option` 和 Profile/账号/行号，不传银行卡及地址，不进入充值状态机。
- 服务从完整本地日志恢复已付款 Profile（兼容旧 `row_succeeded` 及新 `row_payment_confirmed`），`GET /api/paid-profiles` 用于导入时恢复付款状态和套餐。已有付款记录禁止再走购买接口；同一 Profile 跨批次互斥。付款记录按 Profile 编号匹配，不能用于换绑其他账号后的重复购买。
- 已付款行始终禁用充值重试；操作列单独提供截图、CPA、2FA。独立执行发 `additional_started` / `additional_progress` / `additional_finished`，只更新当前项字段，失败不进入充值失败列表。
- 秘密按字段及批次来源读取，新失败的空结果不能擦掉上次已取回的 Key/CPA；其他附加项结果不受影响。刷新页面只能恢复付款记录，不能恢复秘密，仍需先导出。
- 返回首页 → 可点击头像 → Settings 菜单 → 设置内容 → Billing 套餐与邮箱完整。所有页面等待共用本次任务剩余时间，不再单独使用 60/8/10/20 秒结束阶段。新版主页优先精确识别 Open profile menu，继续使用 CDP 鼠标。CPA 输入逐字符及 Tab 后按实际内容校验，最多慢速重输当前字段一次，不另设 1.5 秒阶段超时。
- 2026-11-22 已在 14622 实机确认独立截图从启动到关闭 Profile 成功，Paid / Pro 200 与 Billing email 同时入镜；CPA 输入修复和独立 2FA 入口仅模拟验证，没有新增实际授权或启用结果。
- CPA 新标签握手、控制命令、授权导航、同源加载及 token 请求全部使用本次任务剩余时间。整行结束统一中止未返回的 CDP/请求并关闭当前 Profile；不重复导航、不重复兑换。浏览器明确导航失败立即结束 CPA，诊断不包含授权 URL、code、verifier 或 token。

- 2026-11-22 12:37（本地时间）已在 AdsPower 14622 实机完成独立 CPA：精确匹配已登录账号 → 点击账号（第一次点击未生效，8 秒后局部补点一次）→ 有效回调 → 官方同源兑换 → 凭据完整且邮箱匹配 → 任务行显示已导出并关闭 Profile。付款及已有截图保留；没有重新充值。新版账号按钮匹配必须同时读取标签和子节点邮箱，排除 Remove account；不能只要求 aria-label 前缀。

2026-11-22 在 AdsPower 14621 实机定位到相同 Pro 三档卡片使用 Upgrade to Pro，而非 Buy now。旧识别只接受 Buy now，导致卡片已出现仍误报超时；现兼容卡片内唯一的两种购买文案，并保留金额和选中状态校验。已将修正后的生产识别函数直接用于该页面，返回 amount=200、selected=true、button=Upgrade to Pro；随后实机选择 $200 并点击该按钮，确认 ChatGPT Pro / Due today $200.00。验证止于结账，未填写卡资料、未提交扣款；未运行整条充值任务。
