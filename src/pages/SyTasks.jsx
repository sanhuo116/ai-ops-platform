import { apiFetch, appPath } from '../platform.js'
// SyTasks.jsx —— 私有化规则版话术优化 · 执行结果（任务列表 + 详情四件套 + 质检问题回归发起）
import { useState, useEffect } from 'react'
import { Link, useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, RefreshCw, Download, FileSpreadsheet, FileText, Loader2, CheckCircle2, XCircle, Clock, FlaskConical } from 'lucide-react'

const STAGE_LABEL = {
  pending: '排队中', import: '通话记录导入', bundle: '话术包导出', engine: '引擎构建',
  audit: '全量巡检', fix: '正则优化回归', deliver: '四件套交付', done: '完成', failed: '失败',
}
const STATUS_CLS = {
  queued: 'bg-secondary text-secondary-foreground',
  running: 'bg-info-weak text-info-strong',
  done: 'bg-success-weak text-success-strong',
  failed: 'bg-destructive-weak text-destructive-strong',
}
const DELIV = [
  ['problems', '全量巡检问题表', FileSpreadsheet, 'xlsx · 5 sheet（分支命中错误/走默认未命中/可补样本/优化方案/总览）'],
  ['changes', '正则改动汇总（分bot）', FileSpreadsheet, 'xlsx · 改动总览/每bot明细/验证口径'],
  ['report', '巡检报告', FileText, 'md · 巡检结论/优化方案/剩余问题/文件清单'],
  ['detail', '修改明细', FileText, 'md · 文件级对照/备份回滚/验证口径/平台写入状态'],
]

function Status({ t }) {
  const Icon = t.status === 'done' ? CheckCircle2 : t.status === 'failed' ? XCircle : t.status === 'running' ? Loader2 : Clock
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${STATUS_CLS[t.status] || 'bg-secondary'}`}>
      <Icon size={12} className={t.status === 'running' ? 'animate-spin' : ''} />
      {STAGE_LABEL[t.status] || t.status}
    </span>
  )
}

export default function SyTasks() {
  const [rows, setRows] = useState([])
  const [busy, setBusy] = useState(false)
  const load = () => apiFetch('/api/sy/tasks').then(r => r.json()).then(setRows).catch(() => { })
  useEffect(() => {
    load()
    const t = setInterval(load, 3000)
    return () => clearInterval(t)
  }, [])
  return (
    <div className="p-6 lg:p-8 max-w-5xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
        <div className="page-header">
          <div className="eyebrow">Private Rule Optimizer</div>
          <h1>执行结果</h1>
          <p className="sub">点开任务查看执行阶段、进度与四件套交付清单</p>
        </div>
        <Link to="/sy/new" className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground hover:opacity-90">
          新建任务
        </Link>
      </div>
      <div className="card card-hover divide-y divide-border">
        {rows.length === 0 && <div className="p-8 text-center text-muted-foreground text-sm">暂无任务 · 请先在「提交入口」创建</div>}
        {rows.map(t => (
          <Link key={t.id} to={`/sy/tasks/${t.id}`} className="flex items-center justify-between px-5 py-4 hover:bg-secondary/50 transition">
            <div className="min-w-0">
              <div className="flex items-center gap-2.5">
                <span className="font-medium">bot {t.bot_id}</span>
                <Status t={t} />
                {t.call_count > 0 && <span className="text-xs text-muted-foreground mono">{t.call_count.toLocaleString()} 通</span>}
              </div>
              <div className="text-xs text-muted-foreground mt-1 mono truncate">
                {t.id} · {t.stage_detail || STAGE_LABEL[t.stage] || ''} {t.error ? `· ${t.error.slice(0, 60)}` : ''}
              </div>
            </div>
            <div className="text-xs text-muted-foreground shrink-0">{(t.created_at || '').slice(0, 16).replace('T', ' ')}</div>
          </Link>
        ))}
      </div>
    </div>
  )
}

export function SyTaskDetail() {
  const { id } = useParams()
  const nav = useNavigate()
  const [t, setT] = useState(null)
  const [busy, setBusy] = useState(false)
  const load = () => apiFetch(`/api/sy/tasks/${id}`).then(r => r.json()).then(setT).catch(() => { })
  useEffect(() => {
    load()
    const timer = setInterval(load, 2500)
    return () => clearInterval(timer)
  }, [id])
  if (!t) return <div className="p-8 text-muted-foreground">加载中…</div>
  const result = t.result
  const running = t.status === 'running' || t.status === 'queued'
  const stageOrder = ['import', 'bundle', 'engine', 'audit', 'fix', 'deliver']
  const curStage = stageOrder.indexOf(t.stage)

  return (
    <div className="p-6 lg:p-8 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button onClick={() => nav('/sy/tasks')} className="rounded-lg border border-border p-2 hover:bg-secondary"><ArrowLeft size={16} /></button>
          <div className="page-header">
            <h1>任务 {t.id}</h1>
            <div className="text-sm text-muted-foreground mono">
              bot {t.bot_id}{result?.botName ? ` · ${result.botName}` : ''}{t.call_count ? ` · ${t.call_count.toLocaleString()} 通通话` : ''}
            </div>
          </div>
        </div>
        <Status t={t} />
      </div>

      {/* 阶段进度 */}
      <div className="card p-5 space-y-3 shadow-sm">
        <div className="flex justify-between text-sm">
          <span>{STAGE_LABEL[t.stage] || t.stage} · {t.stage_detail}</span>
          <span className="mono">{t.progress}%</span>
        </div>
        <div className="h-2 rounded-full bg-secondary overflow-hidden">
          <div className={`h-full transition-all ${t.status === 'failed' ? 'bg-destructive' : 'bg-primary'}`} style={{ width: `${t.progress}%` }} />
        </div>
        <div className="grid grid-cols-3 lg:grid-cols-6 gap-2 pt-1">
          {stageOrder.map((s, i) => (
            <div key={s} className={`rounded-lg border px-2 py-1.5 text-xs text-center
              ${i < curStage || t.status === 'done' ? 'border-success/40 bg-success-weak text-success-strong'
                : i === curStage && running ? 'border-info/40 bg-info-weak text-info-strong'
                  : t.status === 'failed' && i === curStage ? 'border-destructive/40 bg-destructive-weak text-destructive-strong'
                    : 'border-border text-muted-foreground'}`}>
              {STAGE_LABEL[s]}
            </div>
          ))}
        </div>
        {t.log?.length > 0 && (
          <div className="rounded-lg bg-muted/60 p-3 font-mono text-xs text-muted-foreground max-h-44 overflow-auto space-y-0.5">
            {t.log.map((l, i) => <div key={i}>{l}</div>)}
          </div>
        )}
        {t.status === 'failed' && (
          <div className="rounded-lg border border-destructive/40 bg-destructive-weak p-3 text-sm text-destructive-strong">{t.error}</div>
        )}
      </div>

      {/* 巡检结论 KPI */}
      {result?.stat && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[
            ['通话记录', result.stat.calls?.toLocaleString()],
            ['可判定用户段', result.stat.judged?.toLocaleString()],
            ['走向正确率', `${(100 * (result.stat.ok + result.stat.okDefault + result.stat.okSemantic + result.stat.okInternalSeq) / Math.max(1, result.stat.judged)).toFixed(1)}%`],
            ['采纳正则改动', `${result.keptChanges} 条`],
            ['分支命中错误', result.stat.errWrong?.toLocaleString()],
            ['走默认未命中', result.stat.errDefault?.toLocaleString()],
            ['未命中(可补)', result.stat.noBranchHit?.toLocaleString()],
            ['badcase 簇', result.clusters],
          ].map(([k, v]) => (
            <div key={k} className="card p-4">
              <div className="text-xs text-muted-foreground">{k}</div>
              <div className="text-lg font-semibold mt-1 mono">{v}</div>
            </div>
          ))}
        </div>
      )}

      {/* 四件套交付 */}
      {t.status === 'done' && result?.deliverables && (
        <div className="card p-5 space-y-3 shadow-sm">
          <div className="font-medium">交付清单（四件套）</div>
          <div className="grid gap-3 sm:grid-cols-2">
            {DELIV.map(([key, name, Icon, desc]) => {
              const file = result.deliverables[key]
              return (
                <a key={key} href={appPath(`/api/sy/tasks/${t.id}/deliverables/${key}`)}
                  className={`flex items-start gap-3 rounded-xl border p-4 transition ${file ? 'border-border hover:bg-secondary/50' : 'border-border opacity-50 pointer-events-none'}`}>
                  <Icon size={20} className="mt-0.5 text-primary shrink-0" />
                  <div className="min-w-0">
                    <div className="text-sm font-medium flex items-center gap-2">
                      {name} <Download size={13} className="text-muted-foreground" />
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">{desc}</div>
                    {file && <div className="text-xs text-muted-foreground mt-1 mono truncate">{file.split('/').pop()}</div>}
                  </div>
                </a>
              )
            })}
          </div>
        </div>
      )}

      {/* 质检问题清单（可发起回归测试） */}
      {t.status === 'done' && <QcProblems taskId={t.id} botId={t.bot_id} />}
    </div>
  )
}

// 质检问题清单：分页加载 + 每行「是否回归测试」
function QcProblems({ taskId, botId }) {
  const [data, setData] = useState(null)
  const [page, setPage] = useState(1)
  const [kind, setKind] = useState('')
  const [kw, setKw] = useState('')
  const [selected, setSelected] = useState({})   // problem key -> true
  const [submitting, setSubmitting] = useState(false)
  const [msg, setMsg] = useState('')
  const load = async () => {
    try {
      const p = new URLSearchParams({ page, size: 15, kind, q: kw })
      const r = await apiFetch(`/api/sy/tasks/${taskId}/problems?${p}`)
      const d = await r.json()
      setData(d.error ? null : d)
    } catch { }
  }
  useEffect(() => { load() }, [taskId, page, kind, kw])
  const selCount = Object.keys(selected).length
  const toggle = key => setSelected(s => ({ ...s, [key]: !s[key] }))
  async function submitRegression() {
    setMsg(''); setSubmitting(true)
    try {
      // 类型预检：回归测试（voiceagent-evidence-driven-optimizer）仅支持大模型 Agent
      const pr = await apiFetch(`/api/bot/type?botId=${encodeURIComponent(String(botId))}`)
      const pd = await pr.json()
      if (pd && (pd.type === 'rule' || pd.type === 'deleted')) { setMsg('✗ ' + (pd.message || '该 bot 不支持回归测试')); setSubmitting(false); return }
      const problems = Object.keys(selected).filter(k => selected[k]).map(k => JSON.parse(k))
      const r = await apiFetch('/api/ao/regressions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botId: String(botId), sourceTaskId: taskId, problems }),
      })
      const d = await r.json()
      if (d.error) throw new Error(d.error)
      setMsg(`✓ 已发起 ${d.created} 条回归测试（Agent自动优化 → 质检回归测试 可查看状态）`)
      setSelected({})
    } catch (e) { setMsg('✗ ' + String(e.message || e)) }
    setSubmitting(false)
  }
  if (!data) return null
  return (
    <div className="card p-5 space-y-3 shadow-sm">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="font-medium flex items-center gap-2"><FlaskConical size={16} className="text-amber-600" />质检问题清单（可发起回归测试）</div>
        <div className="flex items-center gap-2">
          <select className="input w-44 text-xs" value={kind} onChange={e => { setKind(e.target.value); setPage(1) }}>
            <option value="">全部类型（{Object.values(data.kinds || {}).reduce((a, b) => a + b, 0)}）</option>
            {Object.entries(data.kinds || {}).map(([k, n]) => <option key={k} value={k}>{k}（{n}）</option>)}
          </select>
          <input className="input w-44 text-xs" placeholder="搜节点/话术…" value={kw} onChange={e => { setKw(e.target.value); setPage(1) }} />
        </div>
      </div>
      <div className="overflow-x-auto border rounded-lg">
        <table className="w-full text-xs">
          <thead className="bg-slate-50"><tr>
            <th className="w-8"></th>
            {['通话ID', '类型', '节点', '用户话术', '期望→实际', '回归'].map(h => <th key={h} className="text-left px-2 py-1.5 font-medium text-slate-500">{h}</th>)}
          </tr></thead>
          <tbody>
            {(data.rows || []).map((p, i) => {
              const key = JSON.stringify({ id: p.id, kind: p.kind, node: p.node, expected: p.expected, actual: p.actual, detail: p.detail, bot: p.bot })
              return (
                <tr key={i} className={`border-t ${selected[key] ? 'bg-amber-50/50' : ''}`}>
                  <td className="px-2 py-1.5"><input type="checkbox" checked={!!selected[key]} onChange={() => toggle(key)} /></td>
                  <td className="px-2 py-1.5 mono">{p.id}</td>
                  <td className="px-2 py-1.5"><span className="badge bg-slate-100 text-slate-600">{p.kind}</span></td>
                  <td className="px-2 py-1.5">{p.node}</td>
                  <td className="px-2 py-1.5 max-w-[220px] truncate" title={p.text}>{p.text}</td>
                  <td className="px-2 py-1.5 text-slate-500">{p.expected || '-'} → {p.actual || '-'}</td>
                  <td className="px-2 py-1.5">
                    <button className={`text-xs flex items-center gap-1 ${selected[key] ? 'text-amber-600 font-medium' : 'text-slate-400 hover:text-amber-600'}`} onClick={() => toggle(key)}>
                      <FlaskConical className="w-3.5 h-3.5" />{selected[key] ? '已选入' : '是否回归测试'}
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between text-xs text-slate-500">
        <div>共 {data.total} 条 · 已选 {selCount} 条加入优化测试 case 集</div>
        <div className="flex items-center gap-2">
          <button className="btn-ghost text-xs" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>上一页</button>
          <span>第 {page} / {Math.max(1, Math.ceil(data.total / 15))} 页</span>
          <button className="btn-ghost text-xs" disabled={page >= Math.ceil(data.total / 15)} onClick={() => setPage(p => p + 1)}>下一页</button>
          <button className="btn-primary text-xs flex items-center gap-1" disabled={!selCount || submitting} onClick={submitRegression}>
            {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FlaskConical className="w-3.5 h-3.5" />}
            发起回归测试（{selCount}）
          </button>
        </div>
      </div>
      {msg && <div className={`text-sm ${msg.startsWith('✓') ? 'text-emerald-600' : 'text-red-600'}`}>{msg} {msg.startsWith('✓') && <Link className="underline text-blue-600" to="/ao/regression">查看质检回归测试 →</Link>}</div>}
    </div>
  )
}
