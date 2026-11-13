# 设计说明

本文记录 `dsh_daily_arxiv` 的内部契约，供后续维护或二次开发参考。使用说明见 [README](../README.md)。

---

## 1. 两个半边

| 半边 | 文件 | 运行位置 | 职责 |
| --- | --- | --- | --- |
| Host | `index.js` | Harness 主进程（Node） | 调度、配置与文件、Python 子进程、HTTP 路由、Agent 工具 |
| Client | `client.js` | 浏览器 | 设置页 UI，所有数据经 Host 路由获取 |
| 数据面 | `python/arxiv_daily.py` | Python 子进程 | 网络检索、下载、大模型调用、报告生成 |

Client 不读文件、不访问网络，只调用一个 Host 路由；Host 不实现业务算法，只做编排。

---

## 2. HTTP 契约

路由在 `connection` 通道上注册为 `POST /api/dsh-daily-arxiv`，浏览器侧以**文档相对路径**调用：

```
POST api/dsh-daily-arxiv
content-type: application/json

{ "action": "<动作名>", "payload": { ... } }
```

响应恒为 JSON：

```json
{ "ok": true,  "data": { ... } }
{ "ok": false, "error": "人类可读的失败原因" }
```

- HTTP 状态码只表达传输层结果：200 = 请求已被处理（`ok` 决定业务成败），400 = 请求体不是 JSON，404 = 未知 `action`，405 = 非 POST。
- 鉴权、Host/Origin 校验、浏览器 Cookie 校验全部由 `@deepseek-ai/dsh-client-connection` 完成，插件不重复实现；非 owner 的 Peer 由 Connection 直接回 403。

### 动作表

| `action` | `payload` | `data` |
| --- | --- | --- |
| `status` | — | 完整快照：`dataDir`、`keywords`、`keywordCount`、`llm`、`schedule`、`running`、`lastResult`、`lastError`、`runs`、`python`、`script` |
| `keywords.get` | — | `{ text, keywords }` |
| `keywords.save` | `{ text }` | `{ keywords, keywordCount }` |
| `keywords.reset` | — | `{ text, keywords }` |
| `llm.get` | — | `{ base_url, model_name, api_key_masked, has_api_key, updated_at }`（**永不返回明文密钥**） |
| `llm.save` | `{ base_url, api_key?, model_name }` | 同 `llm.get` |
| `llm.delete` | — | `{ configured: false }` |
| `llm.test` | — | `{ ok, model, base_url, reply }` |
| `manual.search` | `{ from, to }` | Python `search` 结果：`{ count, keywords, candidates[] }` |
| `manual.process` | `{ ids[], from, to }` | `{ started: true, id, kind }`（**立即返回**） |
| `auto.runNow` | — | `{ started: true, id, kind }`（**立即返回**） |
| `run.state` | — | `{ running, lastResult, lastError, nextRunAt }`，供 2 秒轮询 |
| `report.read` | `{ path? }` | `{ path, content }`；省略 `path` 时取最新一次运行 |

`manual.process` 与 `auto.runNow` 是长任务：它们**不等待**管线跑完，只为运行槽位建好记录后返回，UI 通过 `run.state` 跟踪进度。

### 为什么不用 Session Command 做 RPC

Session Command 会把命令生命周期写进会话日志，且必须绑定一个 Agent；本插件的 UI 是跨会话的配置面板，与任何会话无关，因此选择 Connection 提供的 exact Fetch 路由——它同样经过完整鉴权，且不产生会话事件。

---

## 3. 运行槽位与状态机

```
idle ──createRun()──► running ──perform() 结束──► idle
                        │
                        └─ 期间任何新的 createRun() 抛错
```

- `runtime.running` 既是互斥锁，也是 UI 的进度数据源。
- 同一个槽位只允许一条管线；第二个请求在进入 `createRun` 时就被拒绝（而不是排队后静默覆盖）。
- `enqueue()` 用一条 promise 链串行化所有 `perform`，保证 python 子进程不会并发写同一个数据目录。

### 进度来源

Python 在 stdout 上逐行输出结构化标记，Host 逐行解析：

```
@@PROGRESS {"phase":"screen","done":2,"total":4,"message":"摘要判定中"}
@@RESULT   {"ok":true,"out_dir":"...","report":"...","counts":{...}}
```

- `@@PROGRESS` 覆盖 `runtime.running` 的 `phase/done/total/message`
- `@@RESULT` 是唯一的结构化结果；缺失即视为失败（附 stderr 尾部作为诊断）
- 其余 stdout/stderr 行进入 `runtime.running.log`（保留最近 300 行）

子进程超时（`runTimeoutMinutes`）后被杀掉，`lastError` 写入「运行超时」。

---

## 4. 调度器

```
armTimer(reason)
  ├─ enableSchedule=false ─────────────► 不排程
  ├─ 今天未跑 且 now >= 今日 scheduleHour ─► 立即（补跑）
  ├─ 今天未跑 且 now <  今日 scheduleHour ─► 今日 scheduleHour
  └─ 今天已跑 ─────────────────────────► 明日 scheduleHour
```

- 触发后执行 `runAuto(今天)`，完成后无论成败都重新 `armTimer()`。
- `lastAutoDate` 只在运行**结束后**写入 `config/state.json`；失败也写入，避免反复重试刷屏，失败原因进入 `state.lastResult.error`。
- 真正触发前会**先重新读一次状态并把当天日期写进 `state.json`**（抢占式认领），这样即使插件被重复实例化、或在运行前后重启，同一天也不会跑第二遍。
- 定时器用原生 `setTimeout` 而不是 Cordis 的 `ctx.timeout()`：后者把 effect 注册在 timer 插件的上下文里，该服务一旦重启（例如安装/升级插件时重载插件图），我们的一次性定时器会被静默清掉。另外每 60 秒跑一次看门狗，发现「今日应跑但未跑」或「定时器丢失」时自动补跑/重排，用于覆盖系统休眠、服务重启等场景。
- 定时器与看门狗都 `unref()`，不会阻止进程退出。

---

## 5. 数据文件

| 路径 | 写入者 | 说明 |
| --- | --- | --- |
| `keywords.txt` | UI / 工具 / 首次激活 | 关键词库，UTF-8，支持 `#` 注释 |
| `config/llm.json` | `llm.save` | `{ base_url, api_key, model, model_name, updated_at }`，POSIX 下 0600 |
| `config/state.json` | Host | `{ lastAutoDate, lastRunAt, lastResult }` |
| `src/arxiv_*/` | Python | 每次运行的下载与报告 |
| `logs/` | 预留 | 目前日志只进内存与界面 |

模型配置**不写**进 `cordis.patch.yml`：那里是用户与其他插件共享的配置层，写密钥既会泄漏到会话可见的配置里，也无法用 UI 增删改。代价是该文件是明文（README 已声明），需要更强保护时应改用系统凭据存储。

---

## 6. Python 侧契约

```
python arxiv_daily.py --mode {auto|search|process|test-llm} \
  --data-dir DIR --keywords-file FILE --llm-config FILE \
  --date YYYY-MM-DD | --from YYYY-MM-DD --to YYYY-MM-DD \
  [--ids '["id1","id2"]'] [--max-results N] [--max-downloads N] \
  [--min-score N] [--delay SECONDS] [--force]
```

- 退出码：`0` = 结果 `ok:true`；`1` = 失败（同时输出带 `error` 的 `@@RESULT`）。
- `--force` 强制重下已存在的 PDF/源码；默认按文件名与大小短路跳过。
- 大模型不可用时退化：按关键词命中判定、导读用模板，**不中断下载**，并在 `run.json.errors` 里说明。
- 大模型返回非法 JSON 时按批重试（最多 3 次），单批失败只影响该批，缺失条目按关键词命中兜底。

### 反爬与限速

- 所有 arXiv 请求共享一把全局锁 + 最小间隔（默认 3s，官方建议值），与线程数无关。
- HTTP 4xx 立即放弃；5xx / 网络错误按 3、6、9 秒退避重试，最多 3 次。
- HTTPS 优先使用 `certifi` 的 CA 包并叠加系统根证书，规避 Conda 环境 `CERTIFICATE_VERIFY_FAILED`。

---

## 7. 扩展点

- **换模型服务**：任何 OpenAI 兼容端点都可以，只要 `base_url` 写到 `/v1` 且 `model_name` 可用；无需改代码。
- **换判定口径**：改 `python/arxiv_daily.py` 的 `TARGET_PROFILE` 与 `SCREEN_PROMPT`；`min_score` 留在配置里。
- **换报告结构**：改 `write_report()`；导读结构由 `REPORT_PROMPT` 约束。
- **换下载产物**：`download_one()` 是单篇管线的唯一入口，新增产物（如 HTML、摘要图）加在这里。
- **换调度时刻**：`scheduleHour`；需要多时段时可把 `armTimer` 的单一目标改为数组。
