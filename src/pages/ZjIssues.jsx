import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ScanSearch, ChevronRight, Loader2, RefreshCw } from 'lucide-react'

// Agent质检 · 质检问题清单：按 bot 维度汇总问题，点查看进入证据明细
export default function ZjIssues() {
  const [tasks, setTasks] = useState([])
  const [loading, setLoading] = useState(true)

  const load = () => { setLoading(true); fetch('/api/zj/tasks').then(r => r.json()).then(setTasks).catch(() => { }).finally(() => setLoading(false)) }
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t) }, [])

  const done = tasks.filter(t => t.status === 'done')
  const totalIssues = done.reduce((n, t) => n + (t.result?.issues?.length || 0), 0)
  const totalFail = done.reduce((n, t) => n + (t.result?.summary?.fail || 0), 0)

  return (
    <div className="p-6 lg:p-8 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div className="page-header">
          <div className="eyebrow">AI Quality Inspection</div>
          <h1>质检问题清单</h1>
          <p className="sub">按 bot 维度汇总质检发现的问题；点「查看」看每类问题的通话证据原话</p>
        </div>
        <button onClick={load} title="刷新"
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-sm text-muted-foreground hover:bg-secondary">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> 刷新
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {[
          ['已质检 bot 数', done.length, '累计完成任务'],
          ['问题类型总数', totalIssues, '按规则聚合'],
          ['不合格通话', totalFail, '全部任务累计'],
        ].map(([label, n, hint]) => (
          <div key={label} className="card card-hover p-4">
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="mt-1 text-2xl font-semibold">{n}</div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>
          </div>
        ))}
      </div>

      <div className="card card-hover divide-y divide-border">
        {done.length === 0 && (
          <div className="p-8 text-center text-sm text-muted-foreground">
            暂无质检结果 · 请先在「需求提交」创建任务
          </div>
        )}
        {done.map(t => {
          const issues = t.result?.issues || []
          const sm = t.result?.summary || {}
          return (
            <div key={t.id} className="px-5 py-4">
              <div className="flex items-center justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <span className="font-semibold">{t.bot_name || `bot ${t.bot_id}`}</span>
                    <span className="mono text-xs text-muted-foreground">bot {t.bot_id}</span>
                    {t.tenant_name && <span className="text-xs text-muted-foreground">· {t.tenant_name}</span>}
                    <span className="text-[11px] rounded-full bg-secondary px-2 py-0.5 text-muted-foreground">{t.call_count?.toLocaleString()} 通</span>
                  </div>
                  <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                    <span>不合格 <b className="text-destructive">{sm.fail ?? 0}</b> 通</span>
                    <span>红线 <b className="text-destructive">{sm.redline_calls ?? 0}</b> 通</span>
                    <span>均分 <b className="text-foreground">{sm.avg_score ?? '—'}</b></span>
                    <span>问题类型 <b className="text-foreground">{issues.length}</b> 类</span>
                  </div>
                </div>
                <Link to={`/zj/tasks/${t.id}`} className="view-btn">
                  查看 <ChevronRight size={14} />
                </Link>
              </div>
              {issues.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {issues.slice(0, 6).map(i => (
                    <span key={i.rule_id} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${i.level === '红线' ? 'bg-destructive-weak text-destructive-strong' : 'bg-warning-weak text-warning-strong'}`}>
                      {i.rule_id} {i.rule_name} · {i.calls} 通
                    </span>
                  ))}
                  {issues.length > 6 && <span className="text-[11px] text-muted-foreground self-center">+{issues.length - 6} 类</span>}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
