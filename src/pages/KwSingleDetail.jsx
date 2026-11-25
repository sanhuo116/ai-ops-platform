import React, { useEffect, useState, useCallback } from 'react'
import { useParams, Link } from 'react-router-dom'
import { ArrowLeft, RotateCcw, Loader2, Check, CircleAlert } from 'lucide-react'
import { StatusPill, ListEditor } from './KwSingle.jsx'

export default function KwSingleDetail() {
  const { id } = useParams()
  const [task, setTask] = useState(null)
  const [lists, setLists] = useState(null)
  const [dirty, setDirty] = useState(false)
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    const r = await fetch(`/api/kw/tasks/${id}`)
    if (!r.ok) return
    const d = await r.json()
    setTask(d)
    if ((d.status === 'done' || d.status === 'failed') && d.result) {
      const r2 = d.result
      setLists(prev => (prev && dirtyRef.current) ? prev
        : { general: [...(r2.general || [])], negatives: [...(r2.negatives || [])], regex: r2.regex || '' })
    }
  }, [id])

  const dirtyRef = React.useRef(false)
  useEffect(() => { dirtyRef.current = dirty }, [dirty])

  useEffect(() => { load(); const t = setInterval(load, 2500); return () => clearInterval(t) }, [load])

  const rerun = async () => {
    setErr('')
    try {
      const r = await fetch(`/api/kw/tasks/${id}/rerun`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ general: lists.general, negatives: lists.negatives, regex: lists.regex }),
      })
      if (!r.ok) { const d = await r.json(); setErr(d.error || '重跑失败'); return }
      // 提交成功：清掉本地编辑态，轮询会在适配完成后加载新正则与验证结果
      setDirty(false)
      setLists(null)
    } catch (e) { setErr(String(e.message)) }
  }

  const rerunAll = async () => {
    setErr(''); setDirty(false); setLists(null)
    try { await fetch(`/api/kw/tasks/${id}/rerun`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }) } catch (e) { }
  }

  if (!task) return <div className="p-8 text-sm text-muted-foreground">加载中…</div>
  const r = task.result || {}
  const hasResult = task.status === 'done' || (task.status === 'failed' && !!task.result)
  const v = r.verified || {}
  const pass = v.ok

  return (
    <div className="p-6 lg:p-8 max-w-6xl mx-auto space-y-5">
      <div className="flex items-center gap-3">
        <Link to="/kw/single/tasks" className="text-muted-foreground hover:text-foreground"><ArrowLeft size={18} /></Link>
        <div className="flex-1">
          <h1 className="text-xl font-semibold">{task.question}</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {r.intent || '—'} · <span className="mono text-xs">{task.id}</span>
          </p>
        </div>
        <StatusPill status={task.status} error={task.error} />
      </div>

      {hasResult && (
        <div className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium ${pass ? 'bg-success-weak text-success-strong' : 'bg-destructive-weak text-destructive-strong'}`}>
          {pass ? <Check size={13} /> : <CircleAlert size={13} />}
          {pass ? `验证全部通过：泛化 ${(v.general || []).length}/${(v.general || []).length} · 规避 ${(v.negatives || []).length}/${(v.negatives || []).length}` : `未全过：泛化未中 ${(v.general || []).filter(x => !x.hit).length} · 规避误中 ${(v.negatives || []).filter(x => x.hit).length}`}
          {r.rounds ? <span className="opacity-70">· 修复 {r.rounds} 轮</span> : null}
          {r.elapsedMs ? <span className="opacity-70">· {(r.elapsedMs / 1000).toFixed(0)}s</span> : null}
          {r.source && <span className="opacity-70">· {r.source}</span>}
        </div>
      )}

      {task.status === 'failed' && <div className="text-sm text-destructive">{task.error}</div>}

      {lists ? (
        <>
          <div className="card p-4">
            <div className="text-sm font-medium mb-1.5">三段式正则</div>
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
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40"
              title="新增/修改句子后重跑：引擎按当前列表自动适配正则，直到全部泛化命中、全部规避不命中才交付">
              <RotateCcw size={15} /> 重跑验证（新增句子自动适配）
            </button>
            <button onClick={rerunAll} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-4 py-2 text-sm hover:bg-secondary">
              <RotateCcw size={15} /> 全量重新生成
            </button>
            {dirty && <span className="text-xs text-muted-foreground">列表已修改</span>}
            {err && <span className="text-xs text-destructive">{err}</span>}
          </div>

          {hasResult && !pass && (
            <div className="card p-4 space-y-1.5">
              <div className="text-sm font-medium text-destructive-strong">验证明细</div>
              {(v.general || []).filter(x => !x.hit).map((x, i) => (
                <div key={`g${i}`} className="text-xs text-destructive">泛化未命中：{x.text}</div>
              ))}
              {(v.negatives || []).filter(x => x.hit).map((x, i) => (
                <div key={`n${i}`} className="text-xs text-destructive">规避误中：{x.text}（片段 {x.seg}）</div>
              ))}
            </div>
          )}

          {hasResult && (
            <div className="card p-4">
              <div className="text-sm font-medium mb-2">逐条命中情况</div>
              <div className="space-y-1">
                {(v.general || []).map((x, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <span className={x.hit ? 'text-success-strong' : 'text-destructive-strong'}>{x.hit ? '✓' : '✗'}</span>
                    <span>{x.text}</span>
                    {x.hit && x.seg && <span className="mono text-muted-foreground">命中「{x.seg}」</span>}
                  </div>
                ))}
                {(v.negatives || []).map((x, i) => (
                  <div key={`n${i}`} className="flex items-center gap-2 text-xs">
                    <span className={!x.hit ? 'text-success-strong' : 'text-destructive-strong'}>{!x.hit ? '✓' : '✗'}</span>
                    <span>{x.text}</span>
                    {x.hit && x.seg && <span className="mono text-destructive">误中「{x.seg}」</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="card p-6 text-sm text-muted-foreground flex items-center gap-2">
          <Loader2 size={16} className="animate-spin" /> 生成中…
        </div>
      )}
    </div>
  )
}
