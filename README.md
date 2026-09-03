# Auto-Purchase-for-GPT

本地 AdsPower 并发 GPT 升级控制台。

## CSV 字段

```text
adsPowerSerialNumber,email,password,cardNumber,expires_at,cvv
```

首列是 AdsPower 的 `serial_number`，页面最多接受 100 条任务；并发数限制为 1-10。并发为 5 时会同时执行列表中的 5 条，完成一条就按原列表顺序立刻补上下一条，始终保持 5 条在跑（剩余不足 5 条时自然减少）。当前只处理个人版 `Maximum power`，倍率可选择 `20x` 或 `5x`，默认 `20x`。启动后会从 ChatGPT 当前个人套餐页读取并展示实际识别到的套餐，团队版和其他升级产品暂不进入此流程。任务失败后可点击页面主操作区的“重试”，只重新执行失败行。

CSV 继续保持六列。页面提供“Billing 地址州”下拉框，默认 `Oregon / 俄勒冈州`。导入 CSV 时，每条任务会按当前所选州随机生成一个 Billing 地址，并在 CVV 后面的“Billing 地址”列展示。任务重试复用首次导入时绑定的地址，不会临时更换。

## 启动

```bash
./start-local.sh
```

AdsPower Local API 默认地址是 `http://127.0.0.1:50325`。启动后，每条任务会：

右上角“设置”可以填写 AdsPower 地址和 API-Key；配置保存在当前浏览器本地。AdsPower 地址默认值为 `http://127.0.0.1:50325`，也可以通过 `ADSPOWER_API_BASE` 或 `ADSPOWER_API_KEY` 提供备用值。

1. 启动对应的 AdsPower profile；
2. 通过 CDP 打开 `https://chatgpt.com/`；
3. 用真实鼠标事件点击右上角 `Upgrade`；
4. 点击 `See all plans`，最多等待 5 秒识别 `ChatGPT Pro / Maximum power`；
5. 点击该卡片的 `Upgrade to Pro`，进入支付页后选择 `20x` 或 `5x`；
6. 确认 `Card`，用逐字符键盘事件填写当前 CSV 行的银行卡和账单地址；
7. 填写完最后一个地址字段后点击 `Subscribe`。若出现拒付等支付异常，只结束当前任务并把失败原因写入任务列表，其他并发任务继续。

如果 ChatGPT 要求登录，程序会填入 CSV 中的邮箱和密码；邮箱验证码、MFA、验证码拦截等步骤需要在 AdsPower 窗口中人工完成。页面文案发生变化时，任务会记录失败原因，不会假装已完成。

银行卡只从当前本地导入任务读取，不跨行复用，也不写入日志。账单地址在导入时按所选州为每条任务生成并固定绑定。填写完地址后会点击 `Subscribe`；拒付只结束当前任务。

执行事件写入 `data/logs/events-YYYY-MM-DD.jsonl`，不会自动清理，需要时可手动删除。页面重新打开后会加载最新最多 1000 条日志；任务列表或执行状态超过 10 条时使用固定高度滚动区域。
