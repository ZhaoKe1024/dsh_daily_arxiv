/**
 * dsh_daily_arxiv — Host half.
 *
 * Responsibilities:
 *  - own the runtime data directory (keywords.txt, config/, src/arxiv_*, logs/)
 *  - schedule the daily 10:00 arXiv run, with catch-up when the process becomes
 *    active after 10:00 and a same-day guard so one day runs once
 *  - spawn python/arxiv_daily.py for search / screening / download / report
 *  - expose one authenticated fetch route so the Web UI can drive everything
 *  - expose the same operations to the agent as the `arxiv_daily` tool
 */
import { spawn } from 'node:child_process'
import { promises as fsp, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const DEFAULT_KEYWORDS = [
  'Operations Research',
  'Optimization Modeling',
  'LLM+Optimization',
  'Agent+Optimization',
  'LLM Modeling Optimization',
  'LLM Formulation',
  'LLM Modeling',
  'LLM Evolutionary',
]

const DEFAULT_KEYWORDS_FILE = `# dsh_daily_arxiv — arXiv 关键词库
# 每行一个关键词短语；空行与 # 开头的行会被忽略。
# 修改后保存即可，下一次检索立即生效（自动任务与手动任务共用此文件）。
#
# 检索方式：把每个短语作为 arXiv 的 all:"<短语>" 全字段短语检索，
# 并用 submittedDate 限定在目标日期窗口内。

${DEFAULT_KEYWORDS.join('\n')}
`

const MAX_LOG_LINES = 300

function localDateKey(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function atHour(base, hour) {
  const next = new Date(base.getTime())
  next.setHours(hour, 0, 0, 0)
  return next
}

function maskKey(key) {
  const text = String(key || '')
  if (!text) return ''
  if (text.length <= 8) return '********'
  return `${text.slice(0, 4)}...${text.slice(-4)}`
}

function text(value, fallback = '') {
  if (value === undefined || value === null) return fallback
  const result = String(value).trim()
  return result || fallback
}

function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** Prefer the plugin-local virtualenv when it exists; an absolute `python` config wins. */
function resolvePython(configured) {
  const explicit = text(configured)
  if (explicit && explicit !== 'python') return explicit
  const candidates = [
    path.join(HERE, '.venv', 'Scripts', 'python.exe'),
    path.join(HERE, '.venv', 'bin', 'python'),
  ]
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      /* ignore */
    }
  }
  return explicit || 'python'
}

/** Run `setup` once the named service exists (via ctx.inject when available). */
function withService(ctx, name, setup) {
  if (typeof ctx.inject === 'function') {
    ctx.inject([name], (scope) => {
      const service = typeof scope.get === 'function' ? scope.get(name) : scope[name]
      if (service !== undefined && service !== null) setup(service, scope)
    })
    return
  }
  const service = typeof ctx.get === 'function' ? ctx.get(name) : undefined
  if (service !== undefined && service !== null) setup(service, ctx)
}

export function apply(ctx, config = {}) {
  const settings = {
    dataDir: text(config.dataDir, '.'),
    keywordsFile: text(config.keywordsFile, 'keywords.txt'),
    pythonExe: resolvePython(config.python),
    scheduleHour: Number.isFinite(Number(config.scheduleHour)) ? Number(config.scheduleHour) : 10,
    enableSchedule: config.enableSchedule !== false,
    maxResults: Number(config.maxResults) > 0 ? Number(config.maxResults) : 200,
    maxDownloads: Number(config.maxDownloads) > 0 ? Number(config.maxDownloads) : 40,
    minScore: Number.isFinite(Number(config.minScore)) ? Number(config.minScore) : 60,
    requestDelaySeconds: Number.isFinite(Number(config.requestDelaySeconds))
      ? Number(config.requestDelaySeconds)
      : 3,
    runTimeoutMinutes: Number(config.runTimeoutMinutes) > 0 ? Number(config.runTimeoutMinutes) : 90,
  }

  const dataDir = path.resolve(HERE, settings.dataDir)
  const scriptPath = path.join(HERE, 'python', 'arxiv_daily.py')
  const keywordsPath = path.resolve(dataDir, settings.keywordsFile)
  const configDir = path.join(dataDir, 'config')
  const llmPath = path.join(configDir, 'llm.json')
  const statePath = path.join(configDir, 'state.json')
  const logsDir = path.join(dataDir, 'logs')

  /** Runtime snapshot shared by the UI and the tool. */
  const runtime = {
    running: null,
    lastResult: null,
    lastError: '',
    nextRunAt: '',
    logTail: [],
    startedAt: new Date().toISOString(),
  }

  let queue = Promise.resolve()
  let state = { lastAutoDate: '', lastRunAt: '', lastResult: null }

  // -------------------------------------------------------------------------
  // Files
  // -------------------------------------------------------------------------
  async function ensureScaffold() {
    await fsp.mkdir(configDir, { recursive: true })
    await fsp.mkdir(logsDir, { recursive: true })
    try {
      await fsp.access(keywordsPath)
    } catch {
      await fsp.writeFile(keywordsPath, DEFAULT_KEYWORDS_FILE, 'utf8')
    }
    try {
      await fsp.access(statePath)
    } catch {
      await fsp.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8')
    }
  }

  async function loadState() {
    try {
      const raw = await fsp.readFile(statePath, 'utf8')
      const parsed = JSON.parse(raw)
      state = {
        lastAutoDate: text(parsed.lastAutoDate),
        lastRunAt: text(parsed.lastRunAt),
        lastResult: parsed.lastResult ?? null,
      }
    } catch {
      state = { lastAutoDate: '', lastRunAt: '', lastResult: null }
    }
    return state
  }

  async function saveState() {
    await fsp.mkdir(configDir, { recursive: true })
    await fsp.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8')
  }

  function parseKeywords(raw) {
    const list = []
    for (const line of String(raw || '').split(/\r?\n/)) {
      const value = line.trim()
      if (!value || value.startsWith('#')) continue
      if (!list.includes(value)) list.push(value)
    }
    return list
  }

  async function readKeywordsText() {
    try {
      return await fsp.readFile(keywordsPath, 'utf8')
    } catch {
      return DEFAULT_KEYWORDS_FILE
    }
  }

  async function readLlm() {
    try {
      const parsed = JSON.parse(await fsp.readFile(llmPath, 'utf8'))
      return {
        base_url: text(parsed.base_url),
        api_key: text(parsed.api_key),
        model_name: text(parsed.model_name || parsed.model),
        updated_at: text(parsed.updated_at),
      }
    } catch {
      return null
    }
  }

  async function listRuns(limit = 12) {
    const srcRoot = path.join(dataDir, 'src')
    let entries = []
    try {
      entries = await fsp.readdir(srcRoot, { withFileTypes: true })
    } catch {
      return []
    }
    const dirs = entries
      .filter((item) => item.isDirectory() && item.name.startsWith('arxiv_'))
      .map((item) => item.name)
      .sort()
      .reverse()
      .slice(0, limit)
    const runs = []
    for (const name of dirs) {
      const dir = path.join(srcRoot, name)
      const runFile = path.join(dir, 'run.json')
      const reportFile = path.join(dir, 'report.md')
      let manifest = null
      try {
        manifest = JSON.parse(await fsp.readFile(runFile, 'utf8'))
      } catch {
        // 只有 candidates.json 的目录（纯检索）不算一次运行，不列进报告列表
        continue
      }
      let reportExists = false
      try {
        await fsp.access(reportFile)
        reportExists = true
      } catch {
        reportExists = false
      }
      runs.push({
        dir,
        name,
        report: reportExists ? reportFile : '',
        mode: manifest?.mode ?? '',
        date: manifest?.date ?? '',
        counts: manifest?.counts ?? null,
        durationSeconds: manifest?.duration_seconds ?? null,
        errors: Array.isArray(manifest?.errors) ? manifest.errors.slice(0, 5) : [],
        createdAt: manifest?.started_at ?? '',
      })
    }
    return runs
  }

  // -------------------------------------------------------------------------
  // Python runner
  // -------------------------------------------------------------------------
  function pushLog(line) {
    const entry = `${new Date().toLocaleTimeString()} ${line}`
    runtime.logTail.push(entry)
    if (runtime.logTail.length > 60) runtime.logTail.shift()
    if (!runtime.running) return
    runtime.running.log.push(line)
    if (runtime.running.log.length > MAX_LOG_LINES) runtime.running.log.shift()
  }

  function runPython(pythonArgs, kind) {
    return new Promise((resolve, reject) => {
      const args = [scriptPath, ...pythonArgs]
      let child
      try {
        child = spawn(settings.pythonExe, args, {
          cwd: dataDir,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
          windowsHide: true,
        })
      } catch (error) {
        reject(new Error(`无法启动 python（${settings.pythonExe}）：${error.message}`))
        return
      }

      let buffer = ''
      let result = null
      const tail = []
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        try {
          child.kill()
        } catch {
          /* ignore */
        }
        runtime.lastError = '运行超时，已终止 python 子进程'
        pushLog(runtime.lastError)
      }, settings.runTimeoutMinutes * 60 * 1000)

      const handleLine = (line) => {
        const trimmed = line.trimEnd()
        if (!trimmed) return
        if (trimmed.startsWith('@@PROGRESS ')) {
          try {
            const progress = JSON.parse(trimmed.slice(11))
            if (runtime.running) {
              runtime.running.phase = text(progress.phase, runtime.running.phase)
              runtime.running.done = Number(progress.done) || 0
              runtime.running.total = Number(progress.total) || 0
              runtime.running.message = text(progress.message)
            }
          } catch {
            /* ignore malformed progress */
          }
          return
        }
        if (trimmed.startsWith('@@RESULT ')) {
          try {
            result = JSON.parse(trimmed.slice(9))
          } catch (error) {
            tail.push(`结果解析失败：${error.message}`)
          }
          return
        }
        tail.push(trimmed)
        if (tail.length > 40) tail.shift()
        pushLog(trimmed)
      }

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        buffer += chunk
        let index = buffer.indexOf('\n')
        while (index >= 0) {
          handleLine(buffer.slice(0, index))
          buffer = buffer.slice(index + 1)
          index = buffer.indexOf('\n')
        }
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => {
        for (const line of String(chunk).split(/\r?\n/)) {
          const value = line.trim()
          if (!value) continue
          tail.push(value)
          if (tail.length > 40) tail.shift()
          pushLog(value)
        }
      })
      child.on('error', (error) => {
        settled = true
        clearTimeout(timer)
        reject(new Error(`python 启动失败：${error.message}`))
      })
      child.on('close', (code) => {
        settled = true
        clearTimeout(timer)
        if (buffer.trim()) handleLine(buffer)
        resolve({ code, result, tail, kind })
      })
    })
  }

  function baseArgs(extra) {
    const llmArgs = []
    return [
      '--data-dir', dataDir,
      '--keywords-file', keywordsPath,
      '--llm-config', llmPath,
      '--max-results', String(settings.maxResults),
      '--max-downloads', String(settings.maxDownloads),
      '--min-score', String(settings.minScore),
      '--delay', String(settings.requestDelaySeconds),
      ...llmArgs,
      ...extra,
    ]
  }

  /** One pipeline run at a time; later calls queue behind the active one. */
  function enqueue(task) {
    const next = queue.then(task, task)
    queue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  /** Claim the single run slot and publish it so the UI can poll immediately. */
  function createRun(kind, meta) {
    if (runtime.running) {
      throw new Error(`已有任务在运行（${runtime.running.kind}），请等待完成`)
    }
    const now = new Date()
    const run = {
      id: `${now.getTime()}`,
      kind,
      startedAt: now.toISOString(),
      phase: 'starting',
      done: 0,
      total: 0,
      message: '正在启动',
      log: [],
      meta,
    }
    runtime.running = run
    runtime.lastError = ''
    runtime.running.log.push(`[${kind}] 开始运行 ${now.toLocaleString()}`)
    return run
  }

  async function perform(run, pythonArgs) {
    const kind = run.kind
    try {
      const outcome = await runPython(pythonArgs, kind)
      const payload = outcome.result
      if (!payload) {
        const reason = outcome.tail.slice(-4).join(' | ')
        throw new Error(`python 未返回结构化结果（退出码 ${outcome.code}）${reason ? `：${reason}` : ''}`)
      }
      if (!payload.ok) {
        throw new Error(payload.error || '运行失败')
      }
      // Keep a compact summary in memory/state: a search response can carry
      // hundreds of candidates and must not bloat every status call.
      const summary = {
        kind,
        ok: true,
        mode: payload.mode ?? kind,
        out_dir: payload.out_dir ?? '',
        report: payload.report ?? '',
        counts: payload.counts ?? null,
        duration_seconds: payload.duration_seconds ?? null,
        llm_configured: Boolean(payload.llm_configured),
        errors: Array.isArray(payload.errors) ? payload.errors.slice(0, 10) : [],
        finishedAt: new Date().toISOString(),
      }
      runtime.lastResult = summary
      state.lastRunAt = summary.finishedAt
      if (kind === 'auto' && run.meta?.date) state.lastAutoDate = run.meta.date
      state.lastResult = {
        kind,
        ok: true,
        out_dir: summary.out_dir,
        report: summary.report,
        counts: summary.counts,
        duration_seconds: summary.duration_seconds,
        finishedAt: summary.finishedAt,
      }
      await saveState()
      const elapsed = payload.duration_seconds
      pushLog(`[${kind}] 完成${elapsed === undefined ? '' : `，耗时 ${elapsed}s`}`)
      return payload
    } catch (error) {
      runtime.lastError = error?.message ?? String(error)
      state.lastRunAt = new Date().toISOString()
      state.lastResult = {
        kind,
        ok: false,
        error: runtime.lastError,
        finishedAt: state.lastRunAt,
      }
      await saveState().catch(() => undefined)
      pushLog(`[${kind}] 失败：${runtime.lastError}`)
      throw error
    } finally {
      runtime.running = null
    }
  }

  /** Long jobs return immediately; the UI follows them through `run.state`. */
  function startInBackground(kind, pythonArgs, meta) {
    const run = createRun(kind, meta)
    enqueue(() => perform(run, pythonArgs)).catch(() => undefined)
    return { started: true, id: run.id, kind }
  }

  async function executeAndWait(kind, pythonArgs, meta) {
    const run = createRun(kind, meta)
    return await enqueue(() => perform(run, pythonArgs))
  }

  async function runAuto(dateKey, options = {}) {
    const target = dateKey || localDateKey()
    const pythonArgs = baseArgs(['--mode', 'auto', '--date', target])
    if (options.background) {
      return startInBackground('auto', pythonArgs, { date: target })
    }
    return await executeAndWait('auto', pythonArgs, { date: target })
  }

  function runSearch(from, to) {
    return executeAndWait('search', baseArgs(['--mode', 'search', '--from', from, '--to', to]), {
      from,
      to,
    })
  }

  function runProcess(ids, from, to) {
    return startInBackground(
      'process',
      baseArgs(['--mode', 'process', '--ids', JSON.stringify(ids), '--from', from, '--to', to]),
      { from, to, count: ids.length },
    )
  }

  function runTestLlm() {
    return executeAndWait('test-llm', baseArgs(['--mode', 'test-llm']), {})
  }

  // -------------------------------------------------------------------------
  // Scheduler: 10:00 local, catch-up when the process wakes up later.
  //
  // Native timers are deliberate: `ctx.timeout()` registers its effect on the
  // timer plugin's context, so a restart of that service silently cancels the
  // one-shot. A short watchdog interval makes the schedule self-healing even
  // after a lost timer, a sleep/resume, or a service restart.
  // -------------------------------------------------------------------------
  let boundaryTimer = null
  let watchdog = null

  function clearTimer() {
    if (boundaryTimer) {
      clearTimeout(boundaryTimer)
      if (typeof boundaryTimer.unref === 'function') boundaryTimer.unref()
      boundaryTimer = null
    }
  }

  /** What the scheduler should do right now. */
  function computePlan(now) {
    const todayKey = localDateKey(now)
    const tenToday = atHour(now, settings.scheduleHour)
    const doneToday = state.lastAutoDate === todayKey
    if (!doneToday && now.getTime() >= tenToday.getTime()) {
      return { mode: 'catch-up', todayKey }
    }
    const target = doneToday
      ? atHour(new Date(now.getTime() + 24 * 60 * 60 * 1000), settings.scheduleHour)
      : tenToday
    return { mode: 'at', target, todayKey }
  }

  async function trigger(dateKey) {
    if (runtime.running) return
    // Claim the day before starting, so a second instance of this plugin (or a
    // restart racing this run) sees the claim instead of running it again.
    await loadState()
    if (state.lastAutoDate === dateKey) {
      pushLog(`[schedule] ${dateKey} 已执行过，跳过`)
      armTimer('after-run')
      return
    }
    state.lastAutoDate = dateKey
    await saveState().catch(() => undefined)
    pushLog(`[schedule] 触发自动任务：${dateKey}`)
    try {
      await runAuto(dateKey)
    } catch (error) {
      runtime.lastError = runtime.lastError || error?.message || String(error)
      pushLog(`[schedule] 自动任务失败：${error?.message ?? error}`)
    } finally {
      state.lastAutoDate = dateKey
      await saveState().catch(() => undefined)
      armTimer('after-run')
    }
  }

  function armTimer(reason = '') {
    clearTimer()
    if (!settings.enableSchedule) {
      runtime.nextRunAt = ''
      return
    }
    const now = new Date()
    const plan = computePlan(now)
    if (plan.mode === 'catch-up') {
      const delay = reason === 'activation' ? 4000 : 1500
      runtime.nextRunAt = new Date(now.getTime() + delay).toISOString()
      pushLog(`[schedule] 今日（${plan.todayKey}）已过 ${settings.scheduleHour}:00，${delay / 1000}s 后补跑`)
      boundaryTimer = setTimeout(() => {
        boundaryTimer = null
        void trigger(plan.todayKey)
      }, delay)
    } else {
      const delay = Math.max(1000, plan.target.getTime() - now.getTime())
      runtime.nextRunAt = plan.target.toISOString()
      pushLog(`[schedule] 下一次自动任务：${plan.target.toLocaleString()}`)
      boundaryTimer = setTimeout(() => {
        boundaryTimer = null
        void trigger(localDateKey())
      }, delay)
    }
    if (typeof boundaryTimer.unref === 'function') boundaryTimer.unref()
  }

  function startWatchdog() {
    if (watchdog) clearInterval(watchdog)
    watchdog = setInterval(() => {
      if (!settings.enableSchedule || runtime.running) return
      const plan = computePlan(new Date())
      if (plan.mode === 'catch-up') {
        void trigger(plan.todayKey)
      } else if (!boundaryTimer) {
        // 定时器丢失（例如系统休眠或服务重启）时重新排程
        armTimer('watchdog')
      }
    }, 60 * 1000)
    if (typeof watchdog.unref === 'function') watchdog.unref()
  }


  // -------------------------------------------------------------------------
  // Public operations (shared by the UI route and the agent tool)
  // -------------------------------------------------------------------------
  async function status() {
    const keywordsText = await readKeywordsText()
    const keywords = parseKeywords(keywordsText)
    const llm = await readLlm()
    const runs = await listRuns()
    return {
      ok: true,
      data: {
        dataDir,
        keywordsFile: keywordsPath,
        keywords,
        keywordCount: keywords.length,
        llm: llm
          ? {
              configured: Boolean(llm.base_url && llm.model_name),
              base_url: llm.base_url,
              model_name: llm.model_name,
              api_key_masked: maskKey(llm.api_key),
              has_api_key: Boolean(llm.api_key),
              updated_at: llm.updated_at,
            }
          : { configured: false, base_url: '', model_name: '', api_key_masked: '', has_api_key: false, updated_at: '' },
        schedule: {
          enabled: settings.enableSchedule,
          hour: settings.scheduleHour,
          nextRunAt: runtime.nextRunAt,
          lastAutoDate: state.lastAutoDate,
          lastRunAt: state.lastRunAt,
        },
        running: runtime.running
          ? {
              id: runtime.running.id,
              kind: runtime.running.kind,
              startedAt: runtime.running.startedAt,
              phase: runtime.running.phase,
              done: runtime.running.done,
              total: runtime.running.total,
              message: runtime.running.message,
              log: runtime.running.log.slice(-40),
            }
          : null,
        lastResult: runtime.lastResult ?? state.lastResult ?? null,
        lastError: runtime.lastError,
        runs,
        python: settings.pythonExe,
        script: scriptPath,
        logTail: runtime.logTail.slice(-25),
        startedAt: runtime.startedAt,
      },
    }
  }

  const actions = {
    status,

    async 'keywords.get'() {
      return {
        ok: true,
        data: { text: await readKeywordsText(), keywords: parseKeywords(await readKeywordsText()) },
      }
    },

    async 'keywords.save'(payload) {
      const raw = String(payload?.text ?? '')
      const keywords = parseKeywords(raw)
      if (!keywords.length) throw new Error('关键词库不能为空，请至少保留一个关键词')
      await fsp.mkdir(path.dirname(keywordsPath), { recursive: true })
      await fsp.writeFile(keywordsPath, raw.endsWith('\n') ? raw : `${raw}\n`, 'utf8')
      return { ok: true, data: { keywords, keywordCount: keywords.length } }
    },

    async 'keywords.reset'() {
      await fsp.writeFile(keywordsPath, DEFAULT_KEYWORDS_FILE, 'utf8')
      return { ok: true, data: { text: DEFAULT_KEYWORDS_FILE, keywords: parseKeywords(DEFAULT_KEYWORDS_FILE) } }
    },

    async 'llm.get'() {
      const llm = await readLlm()
      if (!llm || !llm.base_url) {
        return {
          ok: true,
          data: {
            configured: false,
            base_url: '',
            model_name: '',
            api_key_masked: '',
            has_api_key: false,
            updated_at: '',
          },
        }
      }
      return {
        ok: true,
        data: {
          configured: Boolean(llm.base_url && llm.model_name),
          base_url: llm.base_url,
          model_name: llm.model_name,
          api_key_masked: maskKey(llm.api_key),
          has_api_key: Boolean(llm.api_key),
          updated_at: llm.updated_at,
        },
      }
    },

    async 'llm.save'(payload) {
      const baseUrl = text(payload?.base_url)
      const modelName = text(payload?.model_name)
      let apiKey = text(payload?.api_key)
      if (!baseUrl) throw new Error('base_url 不能为空')
      if (!/^https?:\/\//i.test(baseUrl)) throw new Error('base_url 必须以 http:// 或 https:// 开头')
      if (!modelName) throw new Error('model_name 不能为空')
      const existing = await readLlm()
      if (!apiKey && existing?.api_key) apiKey = existing.api_key
      if (!apiKey) throw new Error('api_key 不能为空')
      await fsp.mkdir(configDir, { recursive: true })
      const record = {
        base_url: baseUrl.replace(/\/+$/, ''),
        api_key: apiKey,
        model_name: modelName,
        model: modelName,
        updated_at: new Date().toISOString(),
      }
      await fsp.writeFile(llmPath, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 })
      return {
        ok: true,
        data: {
          configured: true,
          base_url: record.base_url,
          model_name: record.model_name,
          api_key_masked: maskKey(record.api_key),
          has_api_key: true,
          updated_at: record.updated_at,
        },
      }
    },

    async 'llm.delete'() {
      try {
        await fsp.unlink(llmPath)
      } catch {
        /* already absent */
      }
      return { ok: true, data: { configured: false } }
    },

    async 'llm.test'() {
      const llm = await readLlm()
      if (!llm?.base_url || !llm?.model_name) throw new Error('请先保存大模型配置')
      try {
        const payload = await runTestLlm()
        return { ok: true, data: payload }
      } catch (error) {
        throw new Error(`连通性测试失败：${error?.message ?? error}`)
      }
    },

    async 'manual.search'(payload) {
      const from = text(payload?.from)
      const to = text(payload?.to)
      if (!from || !to) throw new Error('请填写起止日期')
      if (from > to) throw new Error('起始日期不能晚于结束日期')
      const result = await runSearch(from, to)
      return { ok: true, data: result }
    },

    async 'manual.process'(payload) {
      const ids = Array.isArray(payload?.ids) ? payload.ids.map((id) => text(id)).filter(Boolean) : []
      if (!ids.length) throw new Error('请至少勾选一篇论文')
      const from = text(payload?.from, localDateKey())
      const to = text(payload?.to, from)
      const result = await runProcess(ids, from, to)
      return { ok: true, data: result }
    },

    async 'auto.runNow'() {
      const result = await runAuto(localDateKey())
      return { ok: true, data: result }
    },

    async 'run.state'() {
      return {
        ok: true,
        data: {
          running: runtime.running
            ? {
                id: runtime.running.id,
                kind: runtime.running.kind,
                phase: runtime.running.phase,
                done: runtime.running.done,
                total: runtime.running.total,
                message: runtime.running.message,
                startedAt: runtime.running.startedAt,
                log: runtime.running.log.slice(-40),
              }
            : null,
          lastResult: runtime.lastResult ?? state.lastResult ?? null,
          lastError: runtime.lastError,
          nextRunAt: runtime.nextRunAt,
        },
      }
    },

    async 'report.read'(payload) {
      const target = text(payload?.path)
      let reportPath = target
      if (!reportPath) {
        const runs = await listRuns(1)
        reportPath = runs[0]?.report ?? ''
      }
      if (!reportPath) throw new Error('还没有生成任何报告')
      const resolved = path.resolve(reportPath)
      if (!resolved.startsWith(path.resolve(dataDir))) {
        throw new Error('只能读取插件数据目录内的报告')
      }
      const content = await fsp.readFile(resolved, 'utf8')
      return { ok: true, data: { path: resolved, content: content.slice(0, 400000) } }
    },
  }

  // -------------------------------------------------------------------------
  // Fetch route for the Web UI: POST api/dsh-daily-arxiv {action, payload}
  // -------------------------------------------------------------------------
  async function handleApi(request) {
    if (request.method !== 'POST') {
      return json(405, { ok: false, error: '只支持 POST' })
    }
    let body
    try {
      body = await request.json()
    } catch {
      return json(400, { ok: false, error: '请求体必须是 JSON' })
    }
    const action = text(body?.action)
    const handler = Object.prototype.hasOwnProperty.call(actions, action) ? actions[action] : undefined
    if (!handler) {
      return json(404, { ok: false, error: `未知操作：${action}` })
    }
    try {
      const result = await handler(body?.payload ?? {})
      return json(200, result)
    } catch (error) {
      return json(200, { ok: false, error: error?.message ?? String(error) })
    }
  }

  withService(ctx, 'connection', (connection, scope) => {
    const effect = typeof scope.effect === 'function' ? scope.effect.bind(scope) : ctx.effect.bind(ctx)
    effect(() => {
      const dispose = connection.fetch.register({
        path: '/dsh-daily-arxiv',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: (request) => handleApi(request),
      })
      return () => {
        void Promise.resolve(dispose()).catch(() => undefined)
      }
    })
  })

  // -------------------------------------------------------------------------
  // Agent tool — the same operations, callable from a conversation
  // -------------------------------------------------------------------------
  withService(ctx, 'tools', (tools, scope) => {
    const effect = typeof scope.effect === 'function' ? scope.effect.bind(scope) : ctx.effect.bind(ctx)
    effect(() =>
      tools.register({
        name: 'arxiv_daily',
        description:
          'Manage the daily arXiv pipeline: inspect scheduler/run status, read or replace the keyword ' +
          'library, save/delete/test the OpenAI-compatible model used for abstract screening and report ' +
          'writing, search arXiv over a date range, process (screen + download PDF/source + report) chosen ' +
          'papers, trigger the daily run immediately, and read a generated Markdown report.',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: [
                'status',
                'list_keywords',
                'set_keywords',
                'get_llm_config',
                'set_llm_config',
                'delete_llm_config',
                'test_llm',
                'search',
                'process',
                'run_auto',
                'read_report',
              ],
              description: 'Operation to perform.',
            },
            keywords: {
              type: 'string',
              description: 'set_keywords: full keywords.txt content, one keyword per line, # starts a comment.',
            },
            base_url: { type: 'string', description: 'set_llm_config: OpenAI-compatible base URL.' },
            api_key: { type: 'string', description: 'set_llm_config: API key. Omit to keep the saved key.' },
            model_name: { type: 'string', description: 'set_llm_config: model name.' },
            from: { type: 'string', description: 'search/process: inclusive start date, YYYY-MM-DD.' },
            to: { type: 'string', description: 'search/process: inclusive end date, YYYY-MM-DD.' },
            ids: {
              type: 'array',
              items: { type: 'string' },
              description: 'process: arXiv ids chosen from a previous search.',
            },
            path: { type: 'string', description: 'read_report: report.md path; omit for the newest run.' },
          },
          required: ['action'],
          additionalProperties: false,
        },
        output: {
          schema: { type: 'object' },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        async execute(args) {
          const action = text(args?.action)
          switch (action) {
            case 'status':
              return await status()
            case 'list_keywords':
              return await actions['keywords.get']()
            case 'set_keywords':
              return await actions['keywords.save']({ text: args?.keywords })
            case 'get_llm_config':
              return await actions['llm.get']()
            case 'set_llm_config':
              return await actions['llm.save']({
                base_url: args?.base_url,
                api_key: args?.api_key,
                model_name: args?.model_name,
              })
            case 'delete_llm_config':
              return await actions['llm.delete']()
            case 'test_llm':
              return await actions['llm.test']()
            case 'search':
              return await actions['manual.search']({ from: args?.from, to: args?.to })
            case 'process':
              return await actions['manual.process']({ ids: args?.ids, from: args?.from, to: args?.to })
            case 'run_auto':
              return await actions['auto.runNow']()
            case 'read_report':
              return await actions['report.read']({ path: args?.path })
            default:
              throw new Error(`未知 action：${action}`)
          }
        },
      }),
    )
  })

  // -------------------------------------------------------------------------
  // Activation
  // -------------------------------------------------------------------------
  ctx.effect(() => {
    let disposed = false
    void (async () => {
      try {
        await ensureScaffold()
        await loadState()
        if (disposed) return
        startWatchdog()
        armTimer('activation')
      } catch (error) {
        runtime.lastError = `初始化失败：${error?.message ?? error}`
      }
    })()
    return () => {
      disposed = true
      clearTimer()
      if (watchdog) {
        clearInterval(watchdog)
        watchdog = null
      }
    }
  })

  ctx.logger?.info?.('dsh_daily_arxiv ready — data %s, schedule %s:00', dataDir, settings.scheduleHour)
}
