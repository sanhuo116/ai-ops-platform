import React, { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader2, Clock, CheckCircle2, XCircle, Sparkles, RotateCcw, Trash2, CircleAlert, Check } from 'lucide-react'

const STATUS_META = {
  queued: { label: '排队中', cls: 'bg-secondary text-secondary-foreground', icon: Clock },
  running: { label: '生成中', cls: 'bg-info-weak text-info-strong', icon: Loader2, spin: true },
  done: { label: '已完成', cls: 'bg-success-weak text-success-strong', icon: CheckCircle2 },
  failed: { label: '重试中', cls: 'bg-info-weak text-info-strong', icon: Loader2, spin: true },
}

export function StatusPill({ status, error }) {
  const meta = STATUS_META[status] || STATUS_META.queued
  return (
    <span title={error || ''} className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${meta.cls}`}>
      <meta.icon size={13} className={meta.spin ? 'animate-spin' : ''} />
      {meta.label}
    </span>
  )
}

// 泛化/规避列表：可增删改，带回填
export function ListEditor({ title, hint, items, onChange, positive }) {
  const [draft, setDraft] = useState('')
  const add = () => { const t = draft.trim(); if (!t) return; onChange([...items, t]); setDraft('') }
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div>
          <span className={`text-sm font-medium ${positive ? 'text-success-strong' : 'text-destructive-strong'}`}>{title}</span>
          <span className="text-xs text-muted-foreground ml-2">{hint}</span>
        </div>
        <span className="text-xs text-muted-foreground">{items.length} 条</span>
        </div>
      <div className="space-y-1.5">
        {items.map((s, i) => (
          <div key={i} className="flex items-center gap-2 group">
            <span className={`inline-block h-1.5 w-1.5 rounded-full shrink-0 ${positive ? 'bg-success' : 'bg-destructive'}`} />
            <input value={s} onChange={e => { const v = [...items]; v[i] = e.target.value; onChange(v) }}
              className="flex-1 bg-transparent border-b border-transparent hover:border-border focus:border-primary outline-none text-sm py-1" />
            <button onClick={() => onChange(items.filter((_, j) => j !== i))}
              className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive shrink-0" title="删除">
              <Trash2 size={14} />
            </button>
          </div>
          ))}
      </div>
      <div className="flex gap-2 mt-2.5">
        <input value={draft} onChange={e => setDraft(e.target.value)} placeholder="新增一条…"
          onKeyDown={e => e.key === 'Enter' && add()}
          className="flex-1 rounded-lg border border-border bg-background px-3 py-1.5 text-sm outline-none focus:border-primary" />
        <button onClick={add} className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-secondary">添加</button>
      </div>
    </div>
  )
}

export default function KwSingle() {
  const [question, setQuestion] = useState('')
  const [taskId, setTaskId] = useState(null)
  const [task, setTask] = useState(null)
  const [lists, setLists] = useState(null)     // {general, negatives, regex} 编辑副本
  const [dirty, setDirty] = useState(false)
  const [err, setErr] = useState('')
  const nav = useNavigate()

  const load = useCallback(async (id) => {
    const r = await fetch(`/api/kw/tasks/${id}`)
    if (!r.ok) return
    const d = await r.json()
    setTask(d)
    if ((d.status === 'done' || d.status === 'failed') && d.result) {
      const r2 = d.result
      setLists({ general: [...(r2.general || [])], negatives: [...(r2.negatives || [])], regex: r2.regex || '' })
    }
  }, [])

  const submit = async () => {
    const q = question.trim()
    if (!q) return
    setErr(''); setTask(null); setLists(null); setDirty(false)
    try {
      const r = await fetch('/api/kw/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: q }) })
      const d = await r.json()
      if (!r.ok) { setErr(d.error || '提交失败'); return }
      setTaskId(d.id); load(d.id)
    } catch (e) { setErr(String(e.message)) }
  }

  useEffect(() => {
    if (!taskId) return
    const t = setInterval(() => {
      fetch(`/api/kw/tasks/${taskId}`).then(r => r.json()).then(d => {
        setTask(d)
        if ((d.status === 'done' || d.status === 'failed') && d.result) {
          const r2 = d.result
          setLists(prev => {
            if (prev && dirty) return prev          // 用户正在编辑时不覆盖
            return { general: [...(r2.general || [])], negatives: [...(r2.negatives || [])], regex: r2.regex || '' }
          })
        }
      }).catch(() => { })
    }, 2000)
    return () => clearInterval(t)
  }, [taskId, dirty])

  const rerun = async () => {
    if (!taskId || !lists) return
    setErr('')
    try {
      const r = await fetch(`/api/kw/tasks/${taskId}/rerun`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ general: lists.general, negatives: lists.negatives, regex: lists.regex }),
      })
      const d = await r.json()
      if (!r.ok) setErr(d.error || '重跑失败')
    } catch (e) { setErr(String(e.message)) }
  }

  const rerunAll = async () => {
    if (!taskId) return
    setErr(''); setDirty(false); setLists(null)
    try {
      await fetch(`/api/kw/tasks/${taskId}/rerun`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    } catch (e) { }
    // 全量重跑走轮询刷新
  }

  const v = (task?.result?.verified) || {}
  const hasResult = task && (task.status === 'done' || (task.status === 'failed' && !!task.result))
  const pass = v.ok
  const missCount = (v.general || []).filter(x => !x.hit).length
  const falseCount = (v.negatives || []).filter(x => x.hit).length

  return (
    <div className="p-6 lg:p-8 max-w-6xl mx-auto space-y-6">
      <div className="page-header">
        <div className="eyebrow">Keyword Studio</div>
        <h1>关键词生成 · 单句</h1>
        <p className="sub">一句用户问句 → 15 条泛化问句 + 10 条规避案例 + 三段式正则（可编辑重跑）</p>
      </div>

      <div className="card p-4 space-y-3">
        <div className="flex gap-2">
          <input value={question} onChange={e => setQuestion(e.target.value)} placeholder="例如：我下载了这个app"
            onKeyDown={e => e.key === 'Enter' && submit()}
            className="flex-1 rounded-lg border border-border bg-background px-4 py-2.5 text-sm outline-none focus:border-primary" />
          <button onClick={submit} disabled={!question.trim()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40">
            <Sparkles size={16} /> 生成
          </button>
        </div>
        {err && <div className="text-sm text-destructive flex items-center gap-1.5"><CircleAlert size={14} /> {err}</div>}
      </div>

      {task && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <StatusPill status={task.status} error={task.error} />
              {hasResult && (
                <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${pass ? 'bg-success-weak text-success-strong' : 'bg-destructive-weak text-destructive-strong'}`}>
                  {pass ? <Check size={13} /> : <CircleAlert size={13} />}
                  {pass ? '验证 15/15 + 10/10 全通过' : `未全过：泛化未中 ${missCount} · 规避误中 ${falseCount}`}
                </span>
              )}
              {task.result?.intent && <span className="text-sm text-muted-foreground">{task.result.intent}</span>}
            </div>
          </div>

          {task.status === 'running' && (
            <div className="card p-6 text-sm text-muted-foreground flex items-center gap-2">
              <Loader2 size={16} className="animate-spin" /> 正在生成泛化问句与规避案例（大模型，约 30~90 秒）…
            </div>
          )}

          {lists && (
            <>
              <div className="card p-4">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-sm font-medium">三段式正则</span>
                  <span className="text-xs text-muted-foreground">左环视规避 + 核心词 + 右环视规避</span>
                </div>
                <input value={lists.regex} onChange={e => { setLists({ ...lists, regex: e.target.value }); setDirty(true) }}
                  className="mono w-full rounded-lg border border-border bg-secondary/40 px-3 py-2 text-xs outline-none focus:border-primary" />
              </div>

              <div className="grid lg:grid-cols-2 gap-4">
                <div className="card p-4">
                  <ListEditor title="泛化问句" hint="须全部命中正则" positive items={lists.general}
                    onChange={v2 => { setLists({ ...lists, general: v2 }); setDirty(true) }} />
                </div>
                <div className="card p-4">
                  <ListEditor title="规避案例" hint="须全部不命中正则" items={lists.negatives}
                    onChange={v2 => { setLists({ ...lists, negatives: v2 }); setDirty(true) }} />
                </div>
              </div>

              <div className="flex items-center gap-3">
                <button onClick={rerun} disabled={!dirty}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40">
                  <RotateCcw size={15} /> 重跑验证（按当前编辑）
                </button>
                <button onClick={rerunAll}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border px-4 py-2 text-sm hover:bg-secondary">
                  <RotateCcw size={15} /> 全量重新生成
                </button>
                {dirty && <span className="text-xs text-muted-foreground">列表已修改，可重跑验证</span>}
              </div>

              {hasResult && !pass && (v.general || []).filter(x => !x.hit).map((x, i) => (
                <div key={i} className="text-xs text-destructive">未命中：{x.text}</div>
              ))}
            </>
          )}

          {task.status === 'done' && (
            <button onClick={() => nav(`/kw/single/tasks/${task.id}`)} className="text-sm text-primary hover:underline">
              查看任务详情 →
            </button>
          )}
        </div>
      )}
    </div>
  )
}
