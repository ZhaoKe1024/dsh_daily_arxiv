# dsh_daily_arxiv

一个 DeepSeek Harness 插件：**每天上午 10:00 自动检索 arXiv，用你自己的大模型按摘要判定主题相关性，把通过判定的论文 PDF 与 LaTeX 源码下载到本地，并生成一篇 Markdown 介绍报告**；同时提供设置页 UI 与手动任务（按日期范围检索 → 勾选候选 → 判定下载）。

> English summary: a DeepSeek Harness plugin that screens new arXiv submissions against a user-maintained keyword library and a user-supplied OpenAI-compatible model, downloads PDF + LaTeX source, and writes a Markdown digest. It ships a Settings page, a daily 10:00 schedule with catch-up, a manual date-range workflow, and an `arxiv_daily` agent tool.

---

## 目录

- [功能一览](#功能一览)
- [目录结构](#目录结构)
- [环境要求](#环境要求)
- [安装](#安装)
- [第一次使用](#第一次使用)
- [界面说明](#界面说明)
- [每日自动任务的时间语义](#每日自动任务的时间语义)
- [手动任务](#手动任务)
- [数据目录与产物](#数据目录与产物)
- [配置项](#配置项)
- [给 Agent 用的工具](#给-agent-用的工具)
- [工作原理](#工作原理)
- [常见问题](#常见问题)
- [开发与自测](#开发与自测)
- [许可证与致谢](#许可证与致谢)

---

## 功能一览

| 能力 | 说明 |
| --- | --- |
| 关键词库 | `keywords.txt` 一行一个短语，支持 `#` 注释与空行；界面内可编辑、保存、恢复默认 |
| arXiv 检索 | 按 `submittedDate` 日期窗口检索，多个关键词 OR 组合，自动翻页与去重 |
| 大模型判定 | 用 `openai.OpenAI` 兼容接口，把标题+摘要分批送模型，返回相关性、分数、主题标签与理由 |
| 论文下载 | 抓取 abs 页面解析元信息、保存 JSON、下载 PDF、下载 LaTeX 源码包并解压 |
| Markdown 报告 | 模型生成「今日概览 / 主题分布 / 优先阅读 / 趋势观察」+ 逐篇分析 + 文件索引 |
| 每日自动任务 | 本地时间 10:00 触发；10:00 之后才启动则立即补跑；同一天只跑一次 |
| 手动任务 | 选定日期范围 → 检索候选 → 勾选 → 判定并下载所选项 |
| UI 面板 | 设置页 `arXiv 每日论文`，五个标签页：概览 / 关键词库 / 大模型 / 手动任务 / 报告 |
| Agent 工具 | `arxiv_daily`，把同一批操作暴露给对话中的模型 |
| 中英双语 | 界面文本走 Client locale 服务，提供 `zh` / `en` 两套字典 |

---

## 目录结构

```
dsh_daily_arxiv/
├── package.json            # bundle 清单：Host 入口、Client 入口、locale、icon
├── cordis.patch.yml        # 插入插件行并给出默认配置
├── index.js                # Host 半边：调度、文件、Python 子进程、HTTP 路由、Agent 工具
├── client.js               # Web 半边：设置页 React 组件（无构建，直接由 __ModuleLoader__ 加载）
├── locale/{zh,en}.json     # 插件管理页显示用的标题与描述
├── icon.svg                # 插件图标
├── python/
│   └── arxiv_daily.py      # 数据面：检索 / 判定 / 下载 / 报告
├── requirements.txt        # Python 依赖（openai）
├── keywords.example.txt    # 关键词库示例与格式说明
├── docs/design.md          # 架构、数据流、API 契约
├── README.md
└── LICENSE

# 首次运行后自动生成（已在 .gitignore 中忽略）
├── keywords.txt            # 实际使用中的关键词库
├── .venv/                  # 可选的插件内 Python 虚拟环境
├── config/llm.json         # base_url / api_key / model_name
├── config/state.json       # 最近自动执行日期等持久状态
├── logs/                   # 预留日志目录
└── src/arxiv_{yyMMdd_HHmm}/ # 每次任务的下载与报告目录
```

---

## 环境要求

- DeepSeek Harness（Web 版，需要有 `connection` 服务以提供 UI 路由）
- Python **3.8+**，且可被 `python` 命令调用（或在配置里指定绝对路径）
- Python 包：`openai >= 1.0`（用于「摘要判定」与「报告生成」）
- 可访问 `arxiv.org` 与 `export.arxiv.org`
- 一个 OpenAI 兼容的模型服务：`base_url` + `api_key` + `model_name`

---

## 安装

### 1. 安装插件包

在 DeepSeek Harness 里把这个目录作为本地 bundle 安装（插件管理器会链接该目录，改动即时生效）：

```
plugin_manager(action: "install_bundle", target: "<本目录的绝对路径>")
```

也可以让 Agent 代劳：

> 把 `C:\path\to\dsh_daily_arxiv` 作为 bundle 安装到当前 profile，并启用。

安装后：

- 侧边栏 **设置** 里多出一页 **arXiv 每日论文**（中英随界面语言切换）
- 插件列表里多出 `dsh-daily-arxiv` 一行，显示本仓库的图标与描述

### 2. 安装 Python 依赖

推荐做法是在插件目录里建一个隔离环境（插件会自动优先使用它）：

```powershell
cd dsh_daily_arxiv
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

或者装到全局 Python（插件默认使用 `python` 命令）：

```powershell
python -m pip install -r requirements.txt
```

> 插件解析 Python 的顺序：`cordis.patch.yml` 里的 `python` 配置（非 `python` 时优先）→ 插件目录下 `.venv` 里的解释器 → `python` 命令。
> 用 `python --version` 与 `.venv\Scripts\python.exe -c "import openai"` 可以确认环境是否就绪。

### 3. 配置大模型

打开 **设置 → arXiv 每日论文 → 大模型**，填写：

| 字段 | 示例 | 说明 |
| --- | --- | --- |
| `base_url` | `https://api.deepseek.com/v1` | OpenAI 兼容的 API 根地址，只写到 `/v1` |
| `api_key` | `sk-...` | 保存在本机 `config/llm.json`，界面只显示掩码 |
| `model_name` | `deepseek-chat` | 该服务上可用的模型名 |

点 **保存** → **测试连通性**，成功后即完成配置。三个按钮分别负责 **保存 / 删除配置 / 测试连通性**。

---

## 第一次使用

1. **设置 → arXiv 每日论文 → 关键词库**：确认关键词（默认就是下面 8 条），按需增删后点 **保存**。
   ```
   Operations Research
   Optimization Modeling
   LLM+Optimization
   Agent+Optimization
   LLM Modeling Optimization
   LLM Formulation
   LLM Modeling
   LLM Evolutionary
   ```
2. **大模型**页：填写并保存 `base_url / api_key / model_name`，点一次 **测试连通性**。
3. **概览**页：确认「自动任务 · 已启用 · 每天 10:00」和「下次执行」时间。
4. 想立刻看效果，点 **立即运行每日任务**，或在 **手动任务** 页选日期范围先试检索。

---

## 界面说明

设置页共五个标签页。

### 概览

- 自动任务开关状态、下次执行时间、最近自动执行日期、最近一次运行时间
- **立即运行每日任务**：立刻跑当天的自动流程（不受「今天已跑过」限制）
- 运行中显示实时进度条与最近日志（阶段、已处理/总数、当前论文）
- 数据目录、Python 解释器、数据脚本、大模型配置状态
- 最近一次运行结果（检索命中数、下载数、报告路径）与最近错误

### 关键词库

- 一个大文本框直接编辑 `keywords.txt` 原文，支持 `#` 注释与空行
- **保存** 写入文件并立即对后续检索生效
- **恢复默认** 用内置的 8 条默认关键词覆盖
- 底部实时显示当前有效关键词数量

### 大模型

- `base_url` / `api_key` / `model_name` 三个输入框
- **保存**：校验 URL 与模型名后写入 `config/llm.json`（`api_key` 留空表示沿用已保存的密钥）
- **删除配置**：删除文件并回到未配置状态
- **测试连通性**：发送一条最小请求，把模型回复显示在页面上
- 密钥只以掩码形式回显（`sk-a...cdef`）

### 手动任务

1. 选择 **起始日期** 与 **结束日期**（含首尾）
2. 点 **检索候选**：只做检索、不调用大模型、不下载
3. 候选列表显示标题、arXiv 编号、分类、提交日期、命中关键词、摘要
4. 逐条勾选，或用 **全选 / 清空选择**
5. 点 **判定并下载所选**：立刻返回，进度转到顶部的实时进度条
6. 完成后到 **报告** 页查看本次 Markdown 报告

### 报告

- 列出 `src/arxiv_*` 下的历史运行（模式、命中数、下载数、耗时、告警数）
- **查看报告** 在页面内直接渲染 Markdown 原文

---

## 每日自动任务的时间语义

需求里定义的三条规则，实现方式如下（本地时区）：

| 程序何时活跃 | 行为 |
| --- | --- |
| 09:00 启动，今天还没跑过 | 等到今天 10:00 执行 |
| 11:00 启动，今天还没跑过 | **立即**补跑（延迟 4 秒等插件就绪） |
| 任意时刻启动，今天已跑过 | 直接排到明天 10:00 |

- 每次自动任务只取 **当天**（00:00–23:59）提交的论文。
- 「今天是否已跑过」记在 `config/state.json` 的 `lastAutoDate`：运行结束（无论成功失败）都会写入当天日期，避免失败后反复重试刷屏；失败原因在概览页可见，也可随时手动补跑。
- 触发时刻可用 `cordis.patch.yml` 的 `scheduleHour` 改（默认 10）；`enableSchedule: false` 可只保留 UI/工具而不自动跑。
- 调度器依赖 Harness 后台进程存活；进程关闭期间不会执行，重新活跃时按上表补跑。

---

## 手动任务

与自动任务共用同一条 Python 管线，区别只在入口：

- 自动：`--mode auto --date YYYY-MM-DD`（检索当天 → 判定 → 下载 → 报告）
- 手动检索：`--mode search --from ... --to ...`（**只检索**，输出候选 JSON）
- 手动执行：`--mode process --ids '["2401.00001", ...]'`（对勾选项判定 → 下载 → 报告）

因此手动任务同样会走「大模型判定」和「下载 PDF + 源码 + 生成报告」的完整流程，产物落在新的 `src/arxiv_{yyMMdd_HHmm}/` 目录里，互不覆盖。

---

## 数据目录与产物

每次任务创建一个 `src/arxiv_{yyMMdd_HHmm}/`（如 `src/arxiv_261113_1500/`），内含：

| 文件 | 内容 |
| --- | --- |
| `<16字符标题>_<arxiv_id>.json` | 标题、作者、摘要、分类、命中关键词、相关性分数、主题标签、判定理由、六段分析 |
| `<16字符标题>_<arxiv_id>.pdf` | 论文 PDF |
| `<16字符标题>_<arxiv_id>.zip` | arXiv LaTeX 源码包（`/src/` 端点原件） |
| `<16字符标题>_<arxiv_id>/` | 源码解压目录（含 `.tex`、图、`.bbl`） |
| `candidates.json` | 本次检索到的全部候选（含摘要与命中关键词） |
| `report.md` | Markdown 介绍报告 |
| `run.json` | 运行清单：模式、日期区间、计数、耗时、大模型信息、逐篇结果、告警 |

文件名沿用参考实现 `arxiv_download.py` 的规则：`sanitize_title()` 只保留 ASCII 字母数字与 `_ - ` 空格，截断到 16 字符，再拼 `_{arxiv_id}`。

---

## 配置项

`cordis.patch.yml` 中该插件行的 `config`：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `scheduleHour` | `10` | 每日自动任务的小时（本地时区，0–23） |
| `enableSchedule` | `true` | 关掉后不会自动跑，UI 与工具照常可用 |
| `maxResults` | `200` | 单次向 arXiv API 请求的最大条数 |
| `maxDownloads` | `40` | 单次实际下载的最大篇数（防止一次下载过多） |
| `minScore` | `60` | 摘要判定的通过阈值（0–100） |
| `requestDelaySeconds` | `3` | 两次 arXiv 请求的最小间隔（官方建议 3 秒） |
| `paperIntervalSeconds` | `5` | **两篇论文之间**的固定等待，用于压低整批下载速率（反爬主力旋钮） |
| `runTimeoutMinutes` | `90` | 单次运行超时，超时后终止 Python 子进程 |
| `dataDir` | `.` | 数据根目录，相对路径以插件目录为基准 |
| `keywordsFile` | `keywords.txt` | 关键词库文件名（相对 `dataDir`） |
| `python` | `python` | Python 解释器；填绝对路径可强制指定 |

模型配置**不放**在这里（它是密钥，且需要 UI 增删改），而是 `config/llm.json`。

---

## 给 Agent 用的工具

插件注册了 `arxiv_daily` 工具，UI 上的每个操作都有对应的 `action`：

| `action` | 参数 | 作用 |
| --- | --- | --- |
| `status` | — | 调度、运行、数据目录、模型状态 |
| `list_keywords` | — | 读取关键词库原文 |
| `set_keywords` | `keywords` | 覆盖关键词库 |
| `get_llm_config` | — | 读取模型配置（密钥掩码） |
| `set_llm_config` | `base_url` / `api_key` / `model_name` | 保存模型配置（`api_key` 省略则保留旧值） |
| `delete_llm_config` | — | 删除模型配置 |
| `test_llm` | — | 连通性测试 |
| `search` | `from` / `to` | 按日期范围检索候选 |
| `process` | `ids` / `from` / `to` | 判定并下载所选论文 |
| `run_auto` | — | 立刻执行当天自动流程 |
| `read_report` | `path`（可选） | 读取 Markdown 报告 |

---

## 工作原理

```
┌──────────────── 浏览器（client.js）────────────────┐
│ 设置页 React 组件：fetch POST api/dsh-daily-arxiv   │
│ 每 2 秒轮询 run.state，直到 running 变空             │
└───────────────────────┬─────────────────────────────┘
                        │  同一来源、带浏览器 Cookie
┌───────────────────────▼─────────────────────────────┐
│ Host（index.js）                                     │
│  · connection.fetch.register('/dsh-daily-arxiv')     │
│    └ Connection 负责 Host/Origin 校验与浏览器鉴权     │
│  · 单一运行槽位 + 队列，一次只跑一条管线              │
│  · 10:00 调度器（timer 服务），失败/成功后重排        │
│  · spawn(python, arxiv_daily.py --mode ...)          │
│  · 解析 @@PROGRESS / @@RESULT 行                     │
└───────────────────────┬─────────────────────────────┘
                        │  stdout 结构化行
┌───────────────────────▼─────────────────────────────┐
│ Python（python/arxiv_daily.py）                      │
│  检索 → 摘要判定(openai.OpenAI) → abs/PDF/src 下载    │
│  → 解压 → 逐篇分析 → 导读 → report.md / run.json      │
└─────────────────────────────────────────────────────┘
```

设计要点：

- **一次运行一个槽位**：`runtime.running` 同时是互斥锁和 UI 数据源，第二个任务会排到队列里。
- **长任务不阻塞 HTTP**：手动执行与「立即运行」立即返回，进度靠 `run.state` 轮询。
- **UI 不直接读文件**：所有数据都经过 Host 的操作层，Agent 工具调用同一批函数，两条入口共享一套逻辑。
- **UTF-8 全链路**：Python 侧 `PYTHONUTF8=1` + `reconfigure`，JSON 读取容忍 BOM（记事本保存的关键词库也能用）。

更细的契约（API 请求/响应、状态机、失败语义）见 [docs/design.md](docs/design.md)。

---

## 常见问题

**Q: 概览页一直显示「加载中」，或提示 HTTP 404？**
A: 说明 UI 没找到 Host 路由（`/api/dsh-daily-arxiv`）。先刷新页面重试；仍然 404 说明 Host 侧注册没成功——确认插件行 `dsh-daily-arxiv` 已启用、该 profile 是 Web 版（有 `connection` 服务），并且**改过 `index.js` 后必须重启 Host**（旧的 Host 进程里没有新代码）。让 Agent 调用 `arxiv_daily status` 可以看到 `apiRouteRegistered` 与 `apiError` 两个自查字段。

**Q: 运行失败，日志里是 `CERTIFICATE_VERIFY_FAILED`？**
A: 某些 Conda/嵌入式 Python 没有把系统根证书放进默认路径。脚本会优先使用 `certifi` 的 CA 包（已随 openai/httpx 安装），若仍失败可 `python -m pip install certifi`，或设置环境变量 `SSL_CERT_FILE` 指向一个 `cacert.pem`。

**Q: 提示「未安装 openai 包」或 `No module named 'openai'`？**
A: Python 环境没装依赖。按 [安装](#安装) 第 2 步在 `.venv` 里装，或给插件的 `python` 配置指向一个已装 `openai` 的解释器。可用 `概览 → Python` 查看当前实际使用的解释器路径。

**Q: 报告里写「未配置（使用规则兜底）」？**
A: 说明模型配置缺失或初始化失败，此时按关键词命中决定取舍、导读为模板生成，不会中断下载。到大模型页保存配置并测试通过即可。

**Q: 检索结果很少？**
A: 检索是「`all:"短语"` 关键词 + 当天日期窗口」的交集，短语越长命中越少。可以把关键词拆短、增加同义词，或用手动任务放宽日期范围。

**Q: 会不会被 arXiv 限流／判定成爬虫？源码同步已按官方建议做了两层节流。**
A: 两层控制，都能手动改：

1. **请求间隔**（`requestDelaySeconds`，默认 3 秒）：所有 arXiv 请求共享一把全局锁，任意两次请求之间至少等这么久。官方建议「每 3 秒最多一个请求」，这也是默认值。
2. **每篇论文间隔**（`paperIntervalSeconds`，默认 5 秒）：一篇论文的 abs 页面、PDF、源码包都处理完后，固定等待这么久再处理下一篇。

所以一篇论文至少耗时 `3 个请求 × 3 秒 + 5 秒 ≈ 14 秒`，一批 40 篇大约 9 分钟——慢是有意的。两个值都可以在 **设置 → arXiv 每日论文 → 概览 → 下载节流** 里直接改并保存（写入 `config/settings.json`），也可以改 `cordis.patch.yml` 的默认值。候选项特别多时，建议把每篇间隔调到 8–15 秒。

除此之外：请求串行执行（没有并发）、HTTP 4xx 立即放弃不重试、5xx 与网络错误按 3/6/9 秒退避、User-Agent 标明工具与「每 3 秒一次」。

**Q: 源码下载失败，但 PDF 正常？**
A: 部分论文没有可用的 LaTeX 源（或只提供 PDF 源）。失败信息写进该篇的 `json`（`src_error`）与 `run.json` 的 `errors`，不影响其余论文。

---

## 开发与自测

```powershell
# 语法检查
node --check index.js
node --check client.js

# 只检索，验证 arXiv API 与关键词（不调用模型、不下载）
.\.venv\Scripts\python.exe python\arxiv_daily.py --mode search `
  --from 2026-11-10 --to 2026-11-10 --max-results 15 --delay 1 --data-dir .

# 对指定论文走完整流程（判定 → 下载 → 报告）
.\.venv\Scripts\python.exe python\arxiv_daily.py --mode process `
  --ids '["2611.14426"]' --min-score 0 --delay 1 --data-dir .

# 连通性测试
.\.venv\Scripts\python.exe python\arxiv_daily.py --mode test-llm `
  --llm-config config\llm.json --data-dir .
```

Python 侧用结构化行通信，便于单独调试：

- `@@PROGRESS {...}`：阶段、进度、消息
- `@@RESULT {...}`：最终结果（`ok`/`error`/`out_dir`/`report`/`counts`）

修改 `index.js` 后需要重启 Host 进程；`client.js` 在 `pnpm run dev:web` 运行时可由 HMR 热更新，否则刷新页面即可（插件重装或 Host 重启后生效）。

---

## 许可证与致谢

- 许可证：[MIT](LICENSE)
- arXiv 访问遵循其[使用条款](https://info.arxiv.org/help/api/tou.html)：全局 3 秒节流、失败退避、只取公开页面与 `/pdf`、`/src` 端点。
- `python/arxiv_daily.py` 的 abs 页面解析、源码解压、限速节流与 JSON 落盘部分参考了本地技能脚本 `arxiv_download.py`，并在此基础上补充了 arXiv API 批量检索、PDF 下载、摘要判定与报告生成。
