import React, { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Loader2, Clock, CheckCircle2, XCircle, ChevronRight, Plus, FileText, Send, ArrowLeft } from 'lucide-react'

const STAGE_LABEL = { pending: '排队', export: '话术包导出', fetch: '通话取数', inspect: '质检执行', deliver: '报告生成', notify: '飞书推送', done: '完成' }
const STATUS_META = {
  queued: { label: '排队中', cls: 'bg-secondary text-secondary-foreground', icon: Clock },
  running: { label: '执行中', cls: 'bg-info-weak text-info-strong', icon: Loader2, spin: true },
  done: { label: '已完成', cls: 'bg-success-weak text-success-strong', icon: CheckCircle2 },
  failed: { label: '失败', cls: 'bg-destructive-weak text-destructive-strong', icon: XCircle },
}

// Agent质检 · 任务库：任务列表 + 按天报告（报告以天为维度）
export default function ZjTasks() {
  const [tasks, setTasks] = useState([])

  const load = () => fetch('/api/zj/tasks').then(r => r.json()).then(setTasks).catch(() => { })
  useEffect(() => { load(); const t = setInterval(load, 2500); return () => clearInterval(t) }, [])

  return (
    <div className="p-6 lg:p-8 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div className="page-header">
          <div className="eyebrow">AI Quality Inspection</div>
          <h1>任务库</h1>
          <p className="sub">提交的质检任务执行进度；点「查看」进入该 bot 的按天质检报告</p>
        </div>
        <Link to="/zj/new" className="btn-primary">
          <Plus size={16} /> 新建质检任务
        </Link>
      </div>

      <div className="card card-hover divide-y divide-border">
        {tasks.length === 0 && (
          <div className="p-8 text-center text-sm text-muted-foreground">暂无任务 · 请先在「需求提交」创建</div>
        )}
        {tasks.map(t => {
          const meta = STATUS_META[t.status] || STATUS_META.queued
          const result = t.result
          return (
            <div key={t.id} className="px-5 py-4">
              <div className="flex items-center justify-between">
                <Link to={`/zj/tasks/${t.id}`} className="min-w-0 flex-1 group">
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <span className="font-semibold group-hover:text-primary transition-colors">{t.bot_name || `bot ${t.bot_id}`}</span>
                    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${meta.cls}`}>
                      <meta.icon size={13} className={meta.spin ? 'animate-spin' : ''} />{meta.label}
                    </span>
                    <span className="mono text-xs text-muted-foreground">{t.id}</span>
                    {t.call_count > 0 && <span className="text-xs text-muted-foreground">{t.call_count.toLocaleString()} 通</span>}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1.5">
                    {t.stage_detail || STAGE_LABEL[t.stage] || t.stage}
                    {t.error ? <span className="text-destructive"> · {t.error.slice(0, 80)}</span> : ''}
                  </div>
                </Link>
                <Link to={`/zj/tasks/${t.id}`} className="view-btn shrink-0">
                  查看 <ChevronRight size={14} />
                </Link>
              </div>
              {t.status === 'running' && (
                <div className="mt-2.5 h-1.5 w-56 rounded-full bg-secondary overflow-hidden">
                  <div className="h-full bg-primary transition-all" style={{ width: `${t.progress}%` }} />
                </div>
              )}
              {/* 已完成：按天报告直达行 */}
              {result?.days && Object.keys(result.days).length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {Object.entries(result.days).map(([day, d]) => (
                    <a key={day} href={`/api/zj/tasks/${t.id}/reports/${day}`}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-secondary/40 px-2.5 py-1.5 text-xs hover:border-primary hover:text-primary transition-colors">
                      <FileText size={12} /> {day} 报告
                      <span className="text-muted-foreground">({d.summary?.total ?? 0} 通{d.summary?.fail ? ` · 不合格 ${d.summary.fail}` : ''})</span>
                    </a>
                  ))}
                  {result.notify && (
                    <span className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs ${result.notify.skipped ? 'bg-secondary text-muted-foreground' : result.notify.ok ? 'bg-success-weak text-success-strong' : 'bg-warning-weak text-warning-strong'}`}>
                      <Send size={12} />
                      {result.notify.skipped ? '推送已关闭' : result.notify.ok ? `飞书已推送 ${result.notify.sent} 天` : `推送失败 ${result.notify.fails?.length || 0} 天`}
                    </span>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// 质检任务详情：按天报告 + 问题证据明细
export function ZjTaskDetail() {
  const { id } = useParams()
  const [t, setT] = useState(null)
  const [issues, setIssues] = useState([])
  const load = () => fetch(`/api/zj/tasks/${id}`).then(r => r.json()).then(setT).catch(() => { })
  useEffect(() => {
    load()
    fetch(`/api/zj/tasks/${id}/issues`).then(r => r.json()).then(d => setIssues(d.issues || [])).catch(() => { })
    const timer = setInterval(load, 2500)
    return () => clearInterval(timer)
  }, [id])
  if (!t) return <div className="p-8 text-muted-foreground text-sm">加载中…</div>
  const result = t.result
  const sm = result?.summary
  const running = t.status === 'running' || t.status === 'queued'
  const openDay = Object.entries(result?.days || {})

  return (
    <div className="p-6 lg:p-8 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button onClick={() => history.back()} className="rounded-lg border border-border p-2 hover:bg-secondary"><ArrowLeft size={16} /></button>
          <div className="page-header">
            <h1>{t.bot_name || `bot ${t.bot_id}`} 质检详情</h1>
            <p className="sub mono">{t.id}{t.tenant_name ? ` · ${t.tenant_name}` : ''}{t.call_count ? ` · ${t.call_count.toLocaleString()} 通` : ''}</p>
          </div>
        </div>
        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${(STATUS_META[t.status] || STATUS_META.queued).cls}`}>
          {(STATUS_META[t.status] || STATUS_META.queued).icon && React.createElement((STATUS_META[t.status] || STATUS_META.queued).icon, { size: 13, className: (STATUS_META[t.status] || STATUS_META.queued).spin ? 'animate-spin' : '' })}
          {(STATUS_META[t.status] || STATUS_META.queued).label}
        </span>
      </div>

      {running && (
        <div className="card p-5">
          <div className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2"><Loader2 size={15} className="animate-spin text-primary" /> {t.stage_detail || STAGE_LABEL[t.stage]}</span>
            <span className="text-muted-foreground mono">{t.progress}%</span>
          </div>
          <div className="mt-2.5 h-2 rounded-full bg-secondary overflow-hidden">
            <div className="h-full bg-primary transition-all" style={{ width: `${t.progress}%` }} />
          </div>
        </div>
      )}

      {t.status === 'failed' && (
        <div className="card p-5 text-sm text-destructive">{t.error}</div>
      )}

      {sm && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {[
            ['通话总量', sm.total, ''],
            ['合格', sm.pass, 'text-success-strong'],
            ['不合格', sm.fail, 'text-destructive-strong'],
            ['触碰红线', sm.redline_calls, 'text-destructive-strong'],
            ['平均得分', sm.avg_score, ''],
          ].map(([label, n, cls]) => (
            <div key={label} className="card card-hover p-4">
              <div className="text-xs text-muted-foreground">{label}</div>
              <div className={`mt-1 text-2xl font-semibold ${cls}`}>{n}</div>
            </div>
          ))}
        </div>
      )}

      {/* 按天报告 */}
      {openDay.length > 0 && (
        <div className="card overflow-hidden">
          <div className="px-5 py-3.5 border-b border-border text-sm font-semibold">按天质检报告</div>
          <div className="divide-y divide-border">
            {openDay.map(([day, d]) => (
              <div key={day} className="flex items-center justify-between px-5 py-3">
                <div>
                  <div className="text-sm font-medium">{day}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {d.summary?.total} 通 · 合格 {d.summary?.pass} · 不合格 <span className="text-destructive">{d.summary?.fail}</span> · 均分 {d.summary?.avg_score}
                  </div>
                </div>
                <a href={`/api/zj/tasks/${id}/reports/${day}`} className="view-btn">
                  <FileText size={13} /> 下载报告
                </a>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 问题证据 */}
      {issues.length > 0 && (
        <div className="card overflow-hidden">
          <div className="px-5 py-3.5 border-b border-border text-sm font-semibold">质检问题（{issues.length} 类）</div>
          <div className="divide-y divide-border">
            {issues.map(g => (
              <details key={g.rule_id} className="group">
                <summary className="flex items-center justify-between px-5 py-3 cursor-pointer hover:bg-secondary/40">
                  <div className="flex items-center gap-2.5">
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${g.level === '红线' ? 'bg-destructive-weak text-destructive-strong' : 'bg-warning-weak text-warning-strong'}`}>
                      {g.rule_id} {g.rule_name}
                    </span>
                    <span className="text-xs text-muted-foreground">{g.calls} 通命中</span>
                  </div>
                  <ChevronRight size={14} className="text-muted-foreground transition-transform group-open:rotate-90" />
                </summary>
                <div className="px-5 pb-4 space-y-2.5">
                  {g.samples.map((s, i) => (
                    <div key={i} className="rounded-lg bg-secondary/30 p-3">
                      <div className="text-xs text-muted-foreground mono">{s.call_id} · 轮次 {s.turn}</div>
                      <div className="text-sm mt-1">「{s.evidence}」</div>
                      {s.detail && <div className="text-xs text-muted-foreground mt-1">{s.detail}</div>}
                    </div>
                  ))}
                </div>
              </details>
            ))}
          </div>
        </div>
      )}

      {result?.notify && (
        <div className="text-xs text-muted-foreground">
          飞书推送：{result.notify.skipped ? '已关闭' : result.notify.ok ? `已推送 ${result.notify.sent} 天报告至飞书群` : `推送失败（${result.notify.fails?.join('、')}）`}
        </div>
      )}
    </div>
  )
}
