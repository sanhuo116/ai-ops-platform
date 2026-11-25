// SyTasks.jsx —— 私有化话术包直优 · 执行结果（任务列表 + 详情四件套）
import { useState, useEffect } from 'react'
import { Link, useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, RefreshCw, Download, FileSpreadsheet, FileText, Loader2, CheckCircle2, XCircle, Clock } from 'lucide-react'

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
  const load = () => fetch('/api/sy/tasks').then(r => r.json()).then(setRows).catch(() => { })
  useEffect(() => {
    load()
    const t = setInterval(load, 3000)
    return () => clearInterval(t)
  }, [])
  return (
    <div className="p-6 lg:p-8 max-w-5xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">私有化话术包直优 · 执行结果</h1>
          <p className="text-sm text-muted-foreground mt-1">点开任务查看执行阶段、进度与四件套交付清单</p>
        </div>
        <Link to="/sy/new" className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground hover:opacity-90">
          新建任务
        </Link>
      </div>
      <div className="card divide-y divide-border">
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
  const load = () => fetch(`/api/sy/tasks/${id}`).then(r => r.json()).then(setT).catch(() => { })
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
          <div>
            <h1 className="text-xl font-semibold">任务 {t.id}</h1>
            <div className="text-sm text-muted-foreground mono">
              bot {t.bot_id}{result?.botName ? ` · ${result.botName}` : ''}{t.call_count ? ` · ${t.call_count.toLocaleString()} 通通话` : ''}
            </div>
          </div>
        </div>
        <Status t={t} />
      </div>

      {/* 阶段进度 */}
      <div className="card p-5 space-y-3">
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
        <div className="card p-5 space-y-3">
          <div className="font-medium">交付清单（四件套）</div>
          <div className="grid gap-3 sm:grid-cols-2">
            {DELIV.map(([key, name, Icon, desc]) => {
              const file = result.deliverables[key]
              return (
                <a key={key} href={`/api/sy/tasks/${t.id}/deliverables/${key}`}
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
    </div>
  )
}
