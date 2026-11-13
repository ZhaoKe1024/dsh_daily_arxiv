/**
 * dsh_daily_arxiv — Web UI half.
 *
 * Registers one Settings page. Everything on it is driven by the Host half
 * through the authenticated fetch route `api/dsh-daily-arxiv`; the page keeps
 * no state of its own beyond drafts and the last polled snapshot.
 */
window.__ModuleLoader__.load({
  id: 'dsh-daily-arxiv',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-daily-arxiv'
    const API_PATH = 'api/dsh-daily-arxiv'

    const zh = {
      navLabel: 'arXiv 每日论文',
      title: 'arXiv 每日论文',
      subtitle: '每天 {hour}:00 检索 arXiv → 大模型按摘要判定 → 下载 PDF 与源码 → 生成 Markdown 报告',
      tabOverview: '概览',
      tabKeywords: '关键词库',
      tabModel: '大模型',
      tabManual: '手动任务',
      tabReports: '报告',
      refresh: '刷新',
      runNow: '立即运行每日任务',
      loading: '加载中…',
      schedule: '自动任务',
      scheduleOn: '已启用 · 每天 {hour}:00',
      scheduleOff: '已停用',
      nextRun: '下次执行',
      lastAutoDate: '最近自动执行日期',
      never: '从未',
      lastRun: '最近一次运行',
      idle: '空闲',
      runningNow: '正在运行',
      dataDir: '数据目录',
      pythonScript: '数据脚本',
      pythonPath: 'Python',
      lastError: '最近错误',
      progress: '运行进度',
      logTail: '最近日志',
      paperCount: '论文数',
      statCandidates: '检索命中',
      statSelected: '判定通过',
      statDownloaded: '已下载',
      keywordsHelp: '每行一个关键词短语，空行与 # 开头的行会被忽略。保存后自动任务与手动任务共用这份文件。',
      keywordsCount: '当前 {count} 个关键词',
      save: '保存',
      saving: '保存中…',
      reset: '恢复默认',
      saved: '已保存',
      baseUrl: 'base_url',
      baseUrlHint: 'OpenAI 兼容接口地址，例如 https://api.deepseek.com/v1',
      apiKey: 'api_key',
      apiKeyHint: '留空则保留已保存的密钥',
      modelName: 'model_name',
      modelNameHint: '例如 deepseek-chat / gpt-4o-mini',
      modelStatus: '当前状态',
      configured: '已配置',
      notConfigured: '未配置',
      updatedAt: '更新时间',
      delete: '删除配置',
      test: '测试连通性',
      testing: '测试中…',
      testOk: '连通正常：{reply}',
      securityNote: '密钥保存在本机数据目录的 config/llm.json，仅本机进程与 Python 子进程读取；界面只显示掩码。',
      from: '起始日期',
      to: '结束日期',
      search: '检索候选',
      searching: '检索中…',
      candidates: '候选项（{count}）',
      selectAll: '全选',
      selectNone: '清空选择',
      selectedCount: '已选 {count} 篇',
      process: '判定并下载所选',
      processing: '已提交，正在处理…',
      noCandidates: '还没有候选。选择日期范围后点击「检索候选」。',
      noSelection: '请至少勾选一篇论文',
      report: 'Markdown 报告',
      noReport: '还没有生成报告',
      openReport: '查看报告',
      closeReport: '收起',
      runs: '历史运行',
      runAt: '运行时间',
      errors: '告警',
      emptyRuns: '暂无运行记录',
      copyPath: '复制路径',
      copied: '已复制',
      errPrefix: '出错：{message}',
      unknownError: '未知错误',
      confirmDelete: '确定要删除已保存的大模型配置吗？',
      confirmReset: '确定要用默认关键词覆盖当前关键词库吗？',
      matchedKeywords: '命中关键词',
      abstractLabel: '摘要',
      kindAuto: '自动',
      kindManual: '手动',
      kindSearch: '检索',
      kindTestLlm: '连通性测试',
      startedAt: '开始于',
      duration: '耗时 {seconds}s',
      openDir: '数据目录',
    }

    const en = {
      navLabel: 'arXiv daily',
      title: 'arXiv daily',
      subtitle:
        'Every day at {hour}:00 search arXiv, screen abstracts with your model, download PDF and source, and write a Markdown report',
      tabOverview: 'Overview',
      tabKeywords: 'Keywords',
      tabModel: 'Model',
      tabManual: 'Manual run',
      tabReports: 'Reports',
      refresh: 'Refresh',
      runNow: 'Run today now',
      loading: 'Loading…',
      schedule: 'Schedule',
      scheduleOn: 'Enabled · every day at {hour}:00',
      scheduleOff: 'Disabled',
      nextRun: 'Next run',
      lastAutoDate: 'Last automatic date',
      never: 'Never',
      lastRun: 'Last run',
      idle: 'Idle',
      runningNow: 'Running',
      dataDir: 'Data directory',
      pythonScript: 'Pipeline script',
      pythonPath: 'Python',
      lastError: 'Last error',
      progress: 'Progress',
      logTail: 'Recent log',
      paperCount: 'papers',
      statCandidates: 'Found',
      statSelected: 'Passed screening',
      statDownloaded: 'Downloaded',
      keywordsHelp:
        'One keyword phrase per line. Blank lines and lines starting with # are ignored. Both the daily job and manual runs use this file.',
      keywordsCount: '{count} keywords',
      save: 'Save',
      saving: 'Saving…',
      reset: 'Restore defaults',
      saved: 'Saved',
      baseUrl: 'base_url',
      baseUrlHint: 'OpenAI-compatible endpoint, for example https://api.deepseek.com/v1',
      apiKey: 'api_key',
      apiKeyHint: 'Leave blank to keep the saved key',
      modelName: 'model_name',
      modelNameHint: 'For example deepseek-chat or gpt-4o-mini',
      modelStatus: 'Current',
      configured: 'Configured',
      notConfigured: 'Not configured',
      updatedAt: 'Updated',
      delete: 'Delete config',
      test: 'Test connection',
      testing: 'Testing…',
      testOk: 'Connection OK: {reply}',
      securityNote:
        'The key is stored in config/llm.json inside the local data directory; only this process and its Python child read it, and the page shows a mask.',
      from: 'From',
      to: 'To',
      search: 'Search candidates',
      searching: 'Searching…',
      candidates: 'Candidates ({count})',
      selectAll: 'Select all',
      selectNone: 'Clear selection',
      selectedCount: '{count} selected',
      process: 'Screen and download selected',
      processing: 'Submitted, working…',
      noCandidates: 'No candidates yet. Pick a date range and choose Search candidates.',
      noSelection: 'Select at least one paper',
      report: 'Markdown report',
      noReport: 'No report generated yet',
      openReport: 'View report',
      closeReport: 'Collapse',
      runs: 'Past runs',
      runAt: 'Started',
      errors: 'Warnings',
      emptyRuns: 'No runs yet',
      copyPath: 'Copy path',
      copied: 'Copied',
      errPrefix: 'Error: {message}',
      unknownError: 'Unknown error',
      confirmDelete: 'Delete the saved model configuration?',
      confirmReset: 'Replace the keyword library with the defaults?',
      matchedKeywords: 'Matched keywords',
      abstractLabel: 'Abstract',
      kindAuto: 'Automatic',
      kindManual: 'Manual',
      kindSearch: 'Search',
      kindTestLlm: 'Connection test',
      startedAt: 'Started',
      duration: 'took {seconds}s',
      openDir: 'Data directory',
    }

    const CSS = `
.dsh-arxiv { display: flex; flex-direction: column; gap: 18px; padding: 4px 0 40px; color: var(--dsw-alias-label-primary); }
.dsh-arxiv-head { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-start; justify-content: space-between; }
.dsh-arxiv-title { margin: 0; font-size: 17px; font-weight: 600; letter-spacing: .2px; }
.dsh-arxiv-sub { margin: 4px 0 0; font-size: 12.5px; line-height: 1.5; color: var(--dsw-alias-label-secondary); max-width: 640px; }
.dsh-arxiv-tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--dsw-alias-border-l1); flex-wrap: wrap; }
.dsh-arxiv-tab { appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13px;
  padding: 8px 12px; border-radius: 7px 7px 0 0; cursor: pointer; position: relative; }
.dsh-arxiv-tab:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
.dsh-arxiv-tab.is-active { color: var(--dsw-alias-brand-primary); }
.dsh-arxiv-tab.is-active::after { content: ""; position: absolute; left: 8px; right: 8px; bottom: -1px; height: 2px; border-radius: 2px; background: var(--dsw-alias-brand-primary); }
.dsh-arxiv-card { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); border-radius: 10px; padding: 14px 16px; }
.dsh-arxiv-card + .dsh-arxiv-card { margin-top: 12px; }
.dsh-arxiv-card-title { font-size: 13px; font-weight: 600; margin: 0 0 10px; }
.dsh-arxiv-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; }
.dsh-arxiv-kv { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.dsh-arxiv-k { font-size: 11.5px; text-transform: uppercase; letter-spacing: .04em; color: var(--dsw-alias-label-secondary); }
.dsh-arxiv-v { font-size: 13px; word-break: break-all; }
.dsh-arxiv-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
.dsh-arxiv-btn { appearance: none; font: inherit; font-size: 13px; line-height: 1; padding: 8px 14px; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
.dsh-arxiv-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.dsh-arxiv-btn:disabled { opacity: .45; cursor: not-allowed; }
.dsh-arxiv-btn.is-primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: #fff; }
.dsh-arxiv-btn.is-primary:hover:not(:disabled) { filter: brightness(1.08); }
.dsh-arxiv-btn.is-danger { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.dsh-arxiv-btn.is-small { padding: 5px 10px; font-size: 12px; }
.dsh-arxiv-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-end; }
.dsh-arxiv-row.is-end { justify-content: flex-end; }
.dsh-arxiv-field { display: flex; flex-direction: column; gap: 5px; flex: 1 1 220px; min-width: 180px; }
.dsh-arxiv-field.is-narrow { flex: 0 0 auto; min-width: 150px; }
.dsh-arxiv-label { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dsh-arxiv-input, .dsh-arxiv-textarea { font: inherit; font-size: 13px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base);
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; padding: 8px 10px; width: 100%; box-sizing: border-box; }
.dsh-arxiv-input:focus, .dsh-arxiv-textarea:focus { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -1px; }
.dsh-arxiv-textarea { min-height: 210px; resize: vertical; line-height: 1.55; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; }
.dsh-arxiv-hint { font-size: 11.5px; color: var(--dsw-alias-label-secondary); line-height: 1.5; }
.dsh-arxiv-toast { border-radius: 8px; padding: 9px 12px; font-size: 12.5px; line-height: 1.5; border: 1px solid transparent; }
.dsh-arxiv-toast.is-error { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); background: var(--dsw-alias-bg-layer-1); }
.dsh-arxiv-toast.is-ok { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); background: var(--dsw-alias-bg-layer-1); }
.dsh-arxiv-toast.is-warn { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); background: var(--dsw-alias-bg-layer-1); }
.dsh-arxiv-bar { position: relative; height: 6px; border-radius: 3px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.dsh-arxiv-bar > i { position: absolute; inset: 0 auto 0 0; background: var(--dsw-alias-brand-primary); transition: width .25s ease; }
.dsh-arxiv-bar.is-idle > i { width: 32% !important; animation: dsh-arxiv-slide 1.5s linear infinite; }
@keyframes dsh-arxiv-slide { from { transform: translateX(-100%); } to { transform: translateX(320%); } }
.dsh-arxiv-log { margin: 0; padding: 10px 12px; border-radius: 8px; background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1);
  max-height: 190px; overflow: auto; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; line-height: 1.6;
  color: var(--dsw-alias-label-secondary); white-space: pre-wrap; word-break: break-all; }
.dsh-arxiv-list { display: flex; flex-direction: column; gap: 8px; max-height: 430px; overflow: auto; padding-right: 4px; }
.dsh-arxiv-item { display: flex; gap: 10px; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; background: var(--dsw-alias-bg-base); }
.dsh-arxiv-item.is-selected { border-color: var(--dsw-alias-brand-primary); }
.dsh-arxiv-check { margin-top: 3px; accent-color: var(--dsw-alias-brand-primary); width: 15px; height: 15px; flex: 0 0 auto; }
.dsh-arxiv-item-body { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dsh-arxiv-item-title { font-size: 13px; font-weight: 600; line-height: 1.4; }
.dsh-arxiv-item-title a { color: inherit; text-decoration: none; }
.dsh-arxiv-item-title a:hover { color: var(--dsw-alias-brand-primary); text-decoration: underline; }
.dsh-arxiv-item-meta { font-size: 11.5px; color: var(--dsw-alias-label-secondary); display: flex; flex-wrap: wrap; gap: 8px; }
.dsh-arxiv-chip { border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; padding: 1px 8px; font-size: 11px; }
.dsh-arxiv-abstract { font-size: 12px; line-height: 1.55; color: var(--dsw-alias-label-secondary);
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.dsh-arxiv-runs { display: flex; flex-direction: column; gap: 6px; }
.dsh-arxiv-run { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: space-between; padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; font-size: 12.5px; }
.dsh-arxiv-pre { margin: 0; padding: 12px 14px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base);
  max-height: 460px; overflow: auto; white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px; line-height: 1.6; }
.dsh-arxiv-err { color: var(--dsw-alias-state-error-primary); }
.dsh-arxiv-ok { color: var(--dsw-alias-state-success-primary); }
.dsh-arxiv-muted { color: var(--dsw-alias-label-secondary); }
`

    // -----------------------------------------------------------------------
    // Host calls
    // -----------------------------------------------------------------------
    function apiUrl() {
      try {
        return new URL(API_PATH, document.baseURI).toString()
      } catch {
        return `/${API_PATH}`
      }
    }

    async function call(action, payload) {
      const response = await fetch(apiUrl(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action, payload: payload ?? {} }),
      })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`)
      }
      let body
      try {
        body = await response.json()
      } catch {
        throw new Error('Host 返回了非 JSON 响应')
      }
      if (!body || body.ok !== true) {
        throw new Error(body?.error || 'Host 拒绝了请求')
      }
      return body.data
    }

    function pad2(value) {
      return String(value).padStart(2, '0')
    }

    function isoDay(offsetDays = 0) {
      const day = new Date(Date.now() + offsetDays * 86400000)
      return `${day.getFullYear()}-${pad2(day.getMonth() + 1)}-${pad2(day.getDate())}`
    }

    function formatTime(value) {
      if (!value) return ''
      const parsed = new Date(value)
      if (Number.isNaN(parsed.getTime())) return String(value)
      return `${parsed.getFullYear()}-${pad2(parsed.getMonth() + 1)}-${pad2(parsed.getDate())} ${pad2(parsed.getHours())}:${pad2(parsed.getMinutes())}`
    }

    function Button({ children, onClick, kind, small, disabled, busy }) {
      return h(
        'button',
        {
          type: 'button',
          className: `dsh-arxiv-btn${kind ? ` is-${kind}` : ''}${small ? ' is-small' : ''}`,
          onClick,
          disabled: disabled || busy,
          'aria-busy': busy ? 'true' : undefined,
        },
        children,
      )
    }

    function KeyValue({ label, value, mono }) {
      return h(
        'div',
        { className: 'dsh-arxiv-kv' },
        h('span', { className: 'dsh-arxiv-k' }, label),
        h('span', { className: `dsh-arxiv-v${mono ? ' dsh-arxiv-mono' : ''}` }, value),
      )
    }

    function Progress({ run, t }) {
      if (!run) return null
      const total = Number(run.total) || 0
      const done = Number(run.done) || 0
      const indeterminate = total <= 0
      const percent = indeterminate ? 0 : Math.min(100, Math.round((done / total) * 100))
      return h(
        'div',
        { className: 'dsh-arxiv-card' },
        h('h3', { className: 'dsh-arxiv-card-title' }, t('progress')),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          h(
            'div',
            { className: 'dsh-arxiv-hint' },
            `${t('runningNow')} · ${run.kind} · ${run.phase}${indeterminate ? '' : ` · ${done}/${total}`}${run.message ? ` · ${run.message}` : ''}`,
          ),
          h(
            'div',
            { className: `dsh-arxiv-bar${indeterminate ? ' is-idle' : ''}` },
            h('i', { style: indeterminate ? undefined : { width: `${percent}%` } }),
          ),
          run.log && run.log.length
            ? h('pre', { className: 'dsh-arxiv-log' }, run.log.slice(-14).join('\n'))
            : null,
        ),
      )
    }

    function createTranslator(locale) {
      let bound = null
      if (locale && typeof locale.bind === 'function') {
        try {
          bound = locale.bind(NS)
        } catch {
          bound = null
        }
      }
      let active = 'en'
      if (locale && typeof locale.getLocale === 'function') {
        try {
          active = String(locale.getLocale().active || 'en')
        } catch {
          active = 'en'
        }
      }
      const dict = active.toLowerCase().startsWith('zh') ? zh : en
      return (key, vars) => {
        let out = key
        if (bound) {
          try {
            const translated = bound(key)
            if (typeof translated === 'string') out = translated
          } catch {
            /* fall through to the local dictionary */
          }
        }
        if (out === key) out = dict[key] || en[key] || key
        if (vars) {
          for (const [name, value] of Object.entries(vars)) {
            out = out.split(`{${name}}`).join(String(value))
          }
        }
        return out
      }
    }

    // -----------------------------------------------------------------------
    // Page
    // -----------------------------------------------------------------------
    function ArxivDailyPage() {
      const locale = ArxivDailyPage.locale
      const [localeRev, setLocaleRev] = React.useState(0)
      const [tab, setTab] = React.useState('overview')
      const [status, setStatus] = React.useState(null)
      const [bootError, setBootError] = React.useState('')
      const [toast, setToast] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [keywordsText, setKeywordsText] = React.useState('')
      const [keywordsDirty, setKeywordsDirty] = React.useState(false)
      const [llmForm, setLlmForm] = React.useState({ base_url: '', api_key: '', model_name: '' })
      const [llmTest, setLlmTest] = React.useState('')
      const [manual, setManual] = React.useState({ from: isoDay(0), to: isoDay(0) })
      const [candidates, setCandidates] = React.useState([])
      const [selected, setSelected] = React.useState({})
      const [report, setReport] = React.useState(null)

      const t = React.useMemo(() => createTranslator(locale), [locale, localeRev])

      React.useEffect(() => {
        if (!locale || typeof locale.subscribe !== 'function') return undefined
        return locale.subscribe(() => setLocaleRev((value) => value + 1))
      }, [locale])

      React.useEffect(() => {
        if (!toast) return undefined
        const timer = setTimeout(() => setToast(null), toast.kind === 'error' ? 9000 : 5000)
        return () => clearTimeout(timer)
      }, [toast])

      const refresh = React.useCallback(async () => {
        try {
          const data = await call('status')
          setStatus(data)
          setBootError('')
          return data
        } catch (error) {
          setBootError(error.message)
          return null
        }
      }, [])

      React.useEffect(() => {
        void refresh()
      }, [refresh])

      // Poll while a pipeline run is active.
      const runningId = status?.running?.id
      React.useEffect(() => {
        let cancelled = false
        const tick = async () => {
          if (cancelled) return
          try {
            const data = await call('run.state')
            if (cancelled) return
            setStatus((current) => {
              if (!current) return current
              return {
                ...current,
                running: data.running,
                lastResult: data.lastResult,
                lastError: data.lastError,
                schedule: { ...current.schedule, nextRunAt: data.nextRunAt },
              }
            })
            if (!data.running) {
              void refresh()
            }
          } catch {
            /* a transient poll failure must not clear the panel */
          }
        }
        if (!runningId) return undefined
        const timer = setInterval(tick, 2000)
        return () => {
          cancelled = true
          clearInterval(timer)
        }
      }, [runningId, refresh])

      // Load keyword and model drafts once status arrives.
      React.useEffect(() => {
        if (!status) return
        void (async () => {
          try {
            const data = await call('keywords.get')
            setKeywordsText((current) => (keywordsDirty ? current : data.text || ''))
          } catch {
            /* keep empty */
          }
        })()
        setLlmForm((current) => ({
          base_url: current.base_url || status.llm?.base_url || '',
          api_key: current.api_key || '',
          model_name: current.model_name || status.llm?.model_name || '',
        }))
      }, [status?.dataDir])

      const notify = (kind, message) => setToast({ kind, message })
      const fail = (error) => notify('error', t('errPrefix', { message: error?.message || t('unknownError') }))

      async function saveKeywords() {
        setBusy('keywords-save')
        try {
          const data = await call('keywords.save', { text: keywordsText })
          setKeywordsDirty(false)
          notify('ok', t('saved') + ` · ${t('keywordsCount', { count: data.keywordCount })}`)
          await refresh()
        } catch (error) {
          fail(error)
        } finally {
          setBusy('')
        }
      }

      async function resetKeywords() {
        if (!window.confirm(t('confirmReset'))) return
        setBusy('keywords-reset')
        try {
          const data = await call('keywords.reset')
          setKeywordsText(data.text || '')
          setKeywordsDirty(false)
          notify('ok', t('saved'))
          await refresh()
        } catch (error) {
          fail(error)
        } finally {
          setBusy('')
        }
      }

      async function saveLlm() {
        setBusy('llm-save')
        try {
          await call('llm.save', llmForm)
          setLlmForm((current) => ({ ...current, api_key: '' }))
          notify('ok', t('saved'))
          await refresh()
        } catch (error) {
          fail(error)
        } finally {
          setBusy('')
        }
      }

      async function deleteLlm() {
        if (!window.confirm(t('confirmDelete'))) return
        setBusy('llm-delete')
        try {
          await call('llm.delete')
          setLlmForm({ base_url: '', api_key: '', model_name: '' })
          notify('ok', t('saved'))
          await refresh()
        } catch (error) {
          fail(error)
        } finally {
          setBusy('')
        }
      }

      async function testLlm() {
        setBusy('llm-test')
        setLlmTest('')
        try {
          const data = await call('llm.test')
          setLlmTest(t('testOk', { reply: data?.reply || 'ok' }))
        } catch (error) {
          setLlmTest('')
          fail(error)
        } finally {
          setBusy('')
        }
      }

      async function runNow() {
        setBusy('auto')
        try {
          await call('auto.runNow')
          notify('ok', t('processing'))
          await refresh()
        } catch (error) {
          fail(error)
        } finally {
          setBusy('')
        }
      }

      async function searchCandidates() {
        setBusy('search')
        setCandidates([])
        setSelected({})
        try {
          const data = await call('manual.search', { from: manual.from, to: manual.to })
          setCandidates(Array.isArray(data?.candidates) ? data.candidates : [])
          if (!data?.candidates?.length) notify('warn', t('noCandidates'))
        } catch (error) {
          fail(error)
        } finally {
          setBusy('')
        }
      }

      async function processSelected() {
        const ids = Object.keys(selected).filter((id) => selected[id])
        if (!ids.length) {
          notify('warn', t('noSelection'))
          return
        }
        setBusy('process')
        try {
          await call('manual.process', { ids, from: manual.from, to: manual.to })
          notify('ok', t('processing'))
          setSelected({})
          await refresh()
        } catch (error) {
          fail(error)
        } finally {
          setBusy('')
        }
      }

      async function loadReport(path) {
        try {
          const data = await call('report.read', { path })
          setReport(data)
        } catch (error) {
          fail(error)
        }
      }

      const header = h(
        'div',
        { className: 'dsh-arxiv-head' },
        h(
          'div',
          null,
          h('h2', { className: 'dsh-arxiv-title' }, t('title')),
          h('p', { className: 'dsh-arxiv-sub' }, t('subtitle', { hour: status?.schedule?.hour ?? 10 })),
        ),
        h(Button, { onClick: () => void refresh(), disabled: Boolean(status?.running) }, t('refresh')),
      )

      const tabs = [
        ['overview', t('tabOverview')],
        ['keywords', t('tabKeywords')],
        ['model', t('tabModel')],
        ['manual', t('tabManual')],
        ['reports', t('tabReports')],
      ].map(([id, label]) =>
        h(
          'button',
          {
            key: id,
            type: 'button',
            className: `dsh-arxiv-tab${tab === id ? ' is-active' : ''}`,
            onClick: () => setTab(id),
          },
          label,
        ),
      )

      const body = []
      if (bootError) {
        body.push(h('div', { key: 'boot', className: 'dsh-arxiv-toast is-error' }, bootError))
      }
      if (status?.running) {
        body.push(h(Progress, { key: 'progress', run: status.running, t }))
      }

      if (tab === 'overview') {
        const schedule = status?.schedule || {}
        const last = status?.lastResult
        body.push(
          h(
            'div',
            { key: 'schedule', className: 'dsh-arxiv-card' },
            h('h3', { className: 'dsh-arxiv-card-title' }, t('schedule')),
            h(
              'div',
              { className: 'dsh-arxiv-grid' },
              h(KeyValue, {
                label: t('schedule'),
                value: schedule.enabled
                  ? t('scheduleOn', { hour: schedule.hour ?? 10 })
                  : t('scheduleOff'),
              }),
              h(KeyValue, { label: t('nextRun'), value: formatTime(schedule.nextRunAt) || t('never') }),
              h(KeyValue, { label: t('lastAutoDate'), value: schedule.lastAutoDate || t('never') }),
              h(KeyValue, { label: t('lastRun'), value: formatTime(schedule.lastRunAt) || t('never') }),
            ),
            h(
              'div',
              { className: 'dsh-arxiv-row is-end', style: { marginTop: 12 } },
              h(
                Button,
                { kind: 'primary', onClick: () => void runNow(), busy: busy === 'auto', disabled: Boolean(status?.running) },
                t('runNow'),
              ),
            ),
          ),
          h(
            'div',
            { key: 'env', className: 'dsh-arxiv-card' },
            h('h3', { className: 'dsh-arxiv-card-title' }, t('dataDir')),
            h(
              'div',
              { className: 'dsh-arxiv-grid' },
              h(KeyValue, { label: t('dataDir'), value: status?.dataDir || '-', mono: true }),
              h(KeyValue, { label: t('pythonPath'), value: status?.python || '-', mono: true }),
              h(KeyValue, { label: t('pythonScript'), value: status?.script || '-', mono: true }),
              h(KeyValue, {
                label: t('tabModel'),
                value: status?.llm?.configured
                  ? `${t('configured')} · ${status.llm.model_name}`
                  : t('notConfigured'),
              }),
            ),
          ),
          h(
            'div',
            { key: 'last', className: 'dsh-arxiv-card' },
            h('h3', { className: 'dsh-arxiv-card-title' }, t('lastRun')),
            last
              ? h(
                  'div',
                  { className: 'dsh-arxiv-grid' },
                  h(KeyValue, { label: t('lastRun'), value: last.kind || '-' }),
                  h(KeyValue, { label: t('runAt'), value: formatTime(last.finishedAt) || '-' }),
                  h(KeyValue, { label: t('statCandidates'), value: String(last.counts?.candidates ?? '-') }),
                  h(KeyValue, { label: t('statDownloaded'), value: String(last.counts?.downloaded ?? '-') }),
                  h(KeyValue, { label: t('report'), value: last.report || '-', mono: true }),
                )
              : h('div', { className: 'dsh-arxiv-muted' }, t('idle')),
            status?.lastError
              ? h('div', { className: 'dsh-arxiv-toast is-error', style: { marginTop: 10 } }, status.lastError)
              : null,
          ),
        )
      }

      if (tab === 'keywords') {
        const count = keywordsText
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith('#')).length
        body.push(
          h(
            'div',
            { key: 'kw', className: 'dsh-arxiv-card' },
            h('h3', { className: 'dsh-arxiv-card-title' }, t('tabKeywords')),
            h('p', { className: 'dsh-arxiv-hint', style: { marginTop: 0 } }, t('keywordsHelp')),
            h('textarea', {
              className: 'dsh-arxiv-textarea',
              value: keywordsText,
              spellCheck: false,
              onChange: (event) => {
                setKeywordsText(event.target.value)
                setKeywordsDirty(true)
              },
            }),
            h(
              'div',
              { className: 'dsh-arxiv-row', style: { marginTop: 10, justifyContent: 'space-between', alignItems: 'center' } },
              h('span', { className: 'dsh-arxiv-hint' }, t('keywordsCount', { count })),
              h(
                'div',
                { className: 'dsh-arxiv-row' },
                h(
                  Button,
                  { small: true, onClick: () => void resetKeywords(), busy: busy === 'keywords-reset' },
                  t('reset'),
                ),
                h(
                  Button,
                  {
                    small: true,
                    kind: 'primary',
                    onClick: () => void saveKeywords(),
                    busy: busy === 'keywords-save',
                    disabled: !keywordsDirty,
                  },
                  busy === 'keywords-save' ? t('saving') : t('save'),
                ),
              ),
            ),
          ),
        )
      }

      if (tab === 'model') {
        const llm = status?.llm || {}
        body.push(
          h(
            'div',
            { key: 'model', className: 'dsh-arxiv-card' },
            h('h3', { className: 'dsh-arxiv-card-title' }, t('tabModel')),
            h(
              'div',
              { className: 'dsh-arxiv-row' },
              h(
                'label',
                { className: 'dsh-arxiv-field' },
                h('span', { className: 'dsh-arxiv-label' }, t('baseUrl')),
                h('input', {
                  className: 'dsh-arxiv-input',
                  value: llmForm.base_url,
                  placeholder: 'https://api.deepseek.com/v1',
                  spellCheck: false,
                  onChange: (event) => setLlmForm({ ...llmForm, base_url: event.target.value }),
                }),
              ),
              h(
                'label',
                { className: 'dsh-arxiv-field is-narrow' },
                h('span', { className: 'dsh-arxiv-label' }, t('modelName')),
                h('input', {
                  className: 'dsh-arxiv-input',
                  value: llmForm.model_name,
                  placeholder: 'deepseek-chat',
                  spellCheck: false,
                  onChange: (event) => setLlmForm({ ...llmForm, model_name: event.target.value }),
                }),
              ),
            ),
            h(
              'label',
              { className: 'dsh-arxiv-field', style: { marginTop: 10 } },
              h('span', { className: 'dsh-arxiv-label' }, t('apiKey')),
              h('input', {
                className: 'dsh-arxiv-input',
                type: 'password',
                value: llmForm.api_key,
                placeholder: llm.has_api_key ? `${llm.api_key_masked}` : 'sk-...',
                spellCheck: false,
                autoComplete: 'off',
                onChange: (event) => setLlmForm({ ...llmForm, api_key: event.target.value }),
              }),
              h('span', { className: 'dsh-arxiv-hint' }, t('apiKeyHint')),
            ),
            h(
              'div',
              { className: 'dsh-arxiv-row', style: { marginTop: 12, justifyContent: 'space-between', alignItems: 'center' } },
              h(
                'span',
                { className: 'dsh-arxiv-hint' },
                `${t('modelStatus')}: ${llm.configured ? `${t('configured')} · ${llm.model_name}` : t('notConfigured')}` +
                  (llm.updated_at ? ` · ${t('updatedAt')} ${formatTime(llm.updated_at)}` : ''),
              ),
              h(
                'div',
                { className: 'dsh-arxiv-row' },
                h(
                  Button,
                  { small: true, kind: 'danger', onClick: () => void deleteLlm(), busy: busy === 'llm-delete', disabled: !llm.configured },
                  t('delete'),
                ),
                h(
                  Button,
                  { small: true, onClick: () => void testLlm(), busy: busy === 'llm-test', disabled: !llm.configured },
                  busy === 'llm-test' ? t('testing') : t('test'),
                ),
                h(
                  Button,
                  { small: true, kind: 'primary', onClick: () => void saveLlm(), busy: busy === 'llm-save' },
                  t('save'),
                ),
              ),
            ),
            llmTest ? h('div', { className: 'dsh-arxiv-toast is-ok', style: { marginTop: 10 } }, llmTest) : null,
            h('p', { className: 'dsh-arxiv-hint', style: { marginBottom: 0 } }, t('securityNote')),
          ),
        )
      }

      if (tab === 'manual') {
        const selectedCount = Object.keys(selected).filter((id) => selected[id]).length
        body.push(
          h(
            'div',
            { key: 'manual', className: 'dsh-arxiv-card' },
            h('h3', { className: 'dsh-arxiv-card-title' }, t('tabManual')),
            h(
              'div',
              { className: 'dsh-arxiv-row' },
              h(
                'label',
                { className: 'dsh-arxiv-field is-narrow' },
                h('span', { className: 'dsh-arxiv-label' }, t('from')),
                h('input', {
                  className: 'dsh-arxiv-input',
                  type: 'date',
                  value: manual.from,
                  onChange: (event) => setManual({ ...manual, from: event.target.value }),
                }),
              ),
              h(
                'label',
                { className: 'dsh-arxiv-field is-narrow' },
                h('span', { className: 'dsh-arxiv-label' }, t('to')),
                h('input', {
                  className: 'dsh-arxiv-input',
                  type: 'date',
                  value: manual.to,
                  onChange: (event) => setManual({ ...manual, to: event.target.value }),
                }),
              ),
              h(
                Button,
                { onClick: () => void searchCandidates(), busy: busy === 'search', disabled: Boolean(status?.running) },
                busy === 'search' ? t('searching') : t('search'),
              ),
            ),
          ),
        )

        if (!candidates.length) {
          body.push(h('div', { key: 'nocand', className: 'dsh-arxiv-card dsh-arxiv-muted' }, t('noCandidates')))
        } else {
          body.push(
            h(
              'div',
              { key: 'cands', className: 'dsh-arxiv-card' },
              h(
                'div',
                { className: 'dsh-arxiv-row', style: { justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 } },
                h('h3', { className: 'dsh-arxiv-card-title', style: { margin: 0 } }, t('candidates', { count: candidates.length })),
                h(
                  'div',
                  { className: 'dsh-arxiv-row' },
                  h('span', { className: 'dsh-arxiv-hint' }, t('selectedCount', { count: selectedCount })),
                  h(
                    Button,
                    {
                      small: true,
                      onClick: () => {
                        const next = {}
                        for (const item of candidates) next[item.id] = true
                        setSelected(next)
                      },
                    },
                    t('selectAll'),
                  ),
                  h(Button, { small: true, onClick: () => setSelected({}) }, t('selectNone')),
                  h(
                    Button,
                    {
                      small: true,
                      kind: 'primary',
                      onClick: () => void processSelected(),
                      busy: busy === 'process',
                      disabled: selectedCount === 0 || Boolean(status?.running),
                    },
                    t('process'),
                  ),
                ),
              ),
              h(
                'div',
                { className: 'dsh-arxiv-list' },
                candidates.map((item) =>
                  h(
                    'div',
                    {
                      key: item.id,
                      className: `dsh-arxiv-item${selected[item.id] ? ' is-selected' : ''}`,
                    },
                    h('input', {
                      className: 'dsh-arxiv-check',
                      type: 'checkbox',
                      checked: Boolean(selected[item.id]),
                      onChange: (event) => setSelected({ ...selected, [item.id]: event.target.checked }),
                    }),
                    h(
                      'div',
                      { className: 'dsh-arxiv-item-body' },
                      h(
                        'span',
                        { className: 'dsh-arxiv-item-title' },
                        h('a', { href: item.abs_url, target: '_blank', rel: 'noreferrer' }, item.title || item.id),
                      ),
                      h(
                        'span',
                        { className: 'dsh-arxiv-item-meta' },
                        h('span', { className: 'dsh-arxiv-mono' }, item.id),
                        item.primary_category ? h('span', null, item.primary_category) : null,
                        item.published ? h('span', null, String(item.published).slice(0, 10)) : null,
                        ...(item.matched_keywords || []).map((kw) =>
                          h('span', { key: kw, className: 'dsh-arxiv-chip' }, kw),
                        ),
                      ),
                      item.abstract
                        ? h('span', { className: 'dsh-arxiv-abstract' }, item.abstract)
                        : null,
                    ),
                  ),
                ),
              ),
            ),
          )
        }
      }

      if (tab === 'reports') {
        const runs = status?.runs || []
        body.push(
          h(
            'div',
            { key: 'runs', className: 'dsh-arxiv-card' },
            h('h3', { className: 'dsh-arxiv-card-title' }, t('runs')),
            runs.length
              ? h(
                  'div',
                  { className: 'dsh-arxiv-runs' },
                  runs.map((run) =>
                    h(
                      'div',
                      { key: run.dir, className: 'dsh-arxiv-run' },
                      h(
                        'div',
                        { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
                        h('span', { className: 'dsh-arxiv-mono' }, run.name),
                        h(
                          'span',
                          { className: 'dsh-arxiv-hint' },
                          `${run.mode || '-'} · ${t('statCandidates')} ${run.counts?.candidates ?? '-'} · ${t('statDownloaded')} ${run.counts?.downloaded ?? '-'}` +
                            (run.durationSeconds ? ` · ${t('duration', { seconds: run.durationSeconds })}` : ''),
                        ),
                      ),
                      h(
                        'div',
                        { className: 'dsh-arxiv-row' },
                        run.errors && run.errors.length
                          ? h('span', { className: 'dsh-arxiv-hint dsh-arxiv-err' }, `${t('errors')}: ${run.errors.length}`)
                          : null,
                        h(
                          Button,
                          { small: true, disabled: !run.report, onClick: () => void loadReport(run.report) },
                          t('openReport'),
                        ),
                      ),
                    ),
                  ),
                )
              : h('div', { className: 'dsh-arxiv-muted' }, t('emptyRuns')),
          ),
        )
        if (report) {
          body.push(
            h(
              'div',
              { key: 'report', className: 'dsh-arxiv-card' },
              h(
                'div',
                { className: 'dsh-arxiv-row', style: { justifyContent: 'space-between', marginBottom: 10 } },
                h('h3', { className: 'dsh-arxiv-card-title', style: { margin: 0 } }, t('report')),
                h(Button, { small: true, onClick: () => setReport(null) }, t('closeReport')),
              ),
              h('pre', { className: 'dsh-arxiv-pre' }, report.content),
            ),
          )
        }
      }

      return h(
        'div',
        { className: 'dsh-arxiv' },
        h('style', null, CSS),
        header,
        h('div', { className: 'dsh-arxiv-tabs' }, ...tabs),
        toast ? h('div', { className: `dsh-arxiv-toast is-${toast.kind}` }, toast.message) : null,
        ...body,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined
        ArxivDailyPage.locale = locale
        if (locale && typeof locale.register === 'function') {
          try {
            locale.register(NS, 'zh', zh)
            locale.register(NS, 'en', en)
          } catch {
            /* a second registration attempt is harmless */
          }
        }
        const mount = () =>
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              {
                name: 'settings.section',
                id: 'arxiv-daily',
                order: 40,
                label: () => createTranslator(ArxivDailyPage.locale)('navLabel'),
              },
              ArxivDailyPage,
            ),
          )
        if (typeof ctx.effect === 'function') ctx.effect(() => mount())
        else mount()
      },
    }
  },
})
