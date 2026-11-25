import React, { useEffect, useState, useCallback } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { ArrowLeft, Loader2, CheckCircle2, XCircle, Clock, Download, RotateCcw } from 'lucide-react'

const ICONS = {
  queued: { I: Clock, cls: 'text-muted-foreground' },
  running: { I: Loader2, cls: 'text-info-strong animate-spin' },
  done: { I: CheckCircle2, cls: 'text-success-strong' },
  failed: { I: Loader2, cls: 'text-info-strong animate-spin' },
}

export default function KwBatchDetail() {
  const { id } = useParams()
  const [batch, setBatch] = useState(null)
  const [msg, setMsg] = useState('')
  const nav = useNavigate()

  const load = useCallback(async () => {
    const r = await fetch(`/api/kw/batches/${id}`)
    if (!r.ok) return
    setBatch(await r.json())
  }, [id])
  useEffect(() => { load(); const t = setInterval(load, 2500); return () => clearInterval(t) }, [load])

  const retryFailed = async () => {
    setMsg('')
    try {
      const r = await fetch(`/api/kw/batches/${id}/retry-failed`, { method: 'POST' })
      const d = await r.json()
      setMsg(r.ok ? `已提交 ${d.retried} 条失败项重试` : (d.error || '重试失败'))
    } catch (e) { setMsg(String(e.message)) }
  }

  if (!batch) return <div className="p-8 text-sm text-muted-foreground">加载中…</div>
  const finished = (batch.done || 0) + (batch.failed || 0)
  const pct = batch.total ? Math.round((finished / batch.total) * 100) : 0

  return (
    <div className="p-6 lg:p-8 max-w-6xl mx-auto space-y-5">
      <div className="flex items-center gap-3">
        <Link to="/kw/batch/tasks" className="text-muted-foreground hover:text-foreground"><ArrowLeft size={18} /></Link>
        <div className="flex-1">
          <h1>{batch.name}</h1>
          <p className="text-sm text-muted-foreground mt-0.5 mono text-xs">{batch.id} · {batch.filename || '粘贴文本'}</p>
        </div>
        <button onClick={retryFailed} disabled={batch.status === 'running' || !batch.failed}
          title="对失败项换策略重跑（自动排查直到收敛）"
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3.5 py-2 text-sm hover:bg-secondary disabled:opacity-40">
          <RotateCcw size={15} /> 重试失败项{batch.failed ? `（${batch.failed}）` : ''}
        </button>
        <a href={`/api/kw/batches/${id}/export`} download
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">
          <Download size={15} /> 导出结果
        </a>
      </div>
      {msg && <div className="text-sm text-muted-foreground">{msg}</div>}

      <div className="card p-5 space-y-3">
        <div className="flex justify-between text-sm">
          <span>共 {batch.total} 条 · 完成 {batch.done} · 重试中 {batch.failed}</span>
          <span className="text-muted-foreground">{pct}%</span>
        </div>
        <div className="h-2 rounded-full bg-secondary overflow-hidden">
          <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-secondary/50 text-muted-foreground">
            <tr>
              <th className="text-left font-medium px-4 py-2.5">#</th>
              <th className="text-left font-medium px-4 py-2.5">问句</th>
              <th className="text-left font-medium px-4 py-2.5">状态</th>
              <th className="text-left font-medium px-4 py-2.5">验证</th>
              <th className="text-left font-medium px-4 py-2.5">耗时</th>
            </tr>
          </thead>
          <tbody>
            {(batch.tasks || []).map(t => {
              const { I, cls } = ICONS[t.status] || ICONS.queued
              const v = (t.result || {}).verified || {}
              const clickable = (t.status === 'done' || t.status === 'failed') && t.result
              return (
                <tr key={t.id} className={`border-t border-border ${clickable ? 'cursor-pointer hover:bg-secondary/30' : ''}`}
                  onClick={() => clickable && nav(`/kw/single/tasks/${t.id}`)}>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground mono">{t.seq}</td>
                  <td className="px-4 py-2.5 font-medium">
                    {t.question}
                    {(t.result || {}).attempts > 1 && <span className="ml-2 text-xs text-muted-foreground">（重试 {(t.result).attempts} 次后通过）</span>}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`inline-flex items-center gap-1.5 text-xs ${cls}`} title={t.error || ''}>
                      <I size={13} /> {t.status === 'done' ? '完成' : t.status === 'running' ? '生成中' : t.status === 'failed' ? '重试中' : '排队'}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-xs">
                    {t.status === 'done' ? (v.ok
                      ? <span className="text-success-strong font-medium">全通过</span>
                      : <span className="text-destructive-strong font-medium">泛化未中 {(v.general || []).filter(x => !x.hit).length} · 误中 {(v.negatives || []).filter(x => x.hit).length}</span>)
                      : t.status === 'failed' && t.error
                        ? <span className="text-info-strong" title={t.error}>重试中</span>
                        : '—'}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">{(t.result || {}).elapsedMs ? `${((t.result.elapsedMs) / 1000).toFixed(0)}s` : '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
