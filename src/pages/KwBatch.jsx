import React, { useEffect, useState, useCallback, useRef } from 'react'
import { Upload, Loader2, Clock, CheckCircle2, XCircle, Inbox } from 'lucide-react'

const STATUS_META = {
  running: { label: '执行中', cls: 'bg-info-weak text-info-strong', icon: Loader2, spin: true },
  done: { label: '已完成', cls: 'bg-success-weak text-success-strong', icon: CheckCircle2 },
  failed: { label: '重试中', cls: 'bg-info-weak text-info-strong', icon: Loader2, spin: true },
}

export default function KwBatch() {
  const [text, setText] = useState('')
  const [file, setFile] = useState(null)
  const [batchId, setBatchId] = useState(null)
  const [batch, setBatch] = useState(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const fileRef = useRef(null)

  const load = useCallback(async (id) => {
    const r = await fetch(`/api/kw/batches/${id}`)
    if (!r.ok) return
    setBatch(await r.json())
  }, [])

  const submit = async () => {
    setErr(''); setBusy(true); setBatch(null)
    try {
      let res
      if (file) {
        const fd = new FormData()
        fd.append('file', file)
        res = await fetch('/api/kw/batches', { method: 'POST', body: fd })
      } else {
        const questions = text.split('\n').map(s => s.trim()).filter(Boolean)
        if (!questions.length) { setErr('请粘贴问句或选择文件'); setBusy(false); return }
        res = await fetch('/api/kw/batches', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ questions }),
        })
      }
      const d = await res.json()
      if (!res.ok) { setErr(d.error || '提交失败'); setBusy(false); return }
      setBatchId(d.batchId)
    } catch (e) { setErr(String(e.message)) }
    setBusy(false)
  }

  useEffect(() => {
    if (!batchId) return
    const t = setInterval(() => load(batchId), 2000)
    return () => clearInterval(t)
  }, [batchId, load])

  const meta = batch ? (STATUS_META[batch.status] || STATUS_META.running) : null
  const pct = batch && batch.total ? Math.round(((batch.done + batch.failed) / batch.total) * 100) : 0

  return (
    <div className="p-6 lg:p-8 max-w-6xl mx-auto space-y-6">
      <div className="page-header">
        <h1>关键词生成 · 批量</h1>
        <p className="text-sm text-muted-foreground mt-1">导入问句清单（每行一条，支持 .txt / .csv / .xlsx / .jsonl），自动逐条生成并验证；此处仅展示任务进度与状态。</p>
      </div>

      <div className="card p-4 space-y-3">
        <textarea value={text} onChange={e => setText(e.target.value)} rows={5} disabled={!!file}
          placeholder={'每行一条问句，例如：\n我下载了这个app\n医保缴费了吗\n我要投诉'}
          className="w-full rounded-lg border border-border bg-background px-4 py-3 text-sm outline-none focus:border-primary disabled:opacity-40" />
        <div className="flex items-center gap-3">
          <input ref={fileRef} type="file" accept=".txt,.csv,.xlsx,.jsonl" className="hidden"
            onChange={e => { setFile(e.target.files[0] || null); setText('') }} />
          <button onClick={() => fileRef.current?.click()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3.5 py-2 text-sm hover:bg-secondary">
            <Upload size={15} /> {file ? file.name : '选择问句文件'}
          </button>
          {file && <button onClick={() => { setFile(null); if (fileRef.current) fileRef.current.value = '' }} className="text-xs text-muted-foreground hover:text-destructive">清除</button>}
          <div className="flex-1" />
          <button onClick={submit} disabled={busy || (!text.trim() && !file)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-5 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40">
            <Inbox size={16} /> {busy ? '提交中…' : '批量提交'}
          </button>
        </div>
        {err && <div className="text-sm text-destructive">{err}</div>}
      </div>

      {batch && (
        <div className="card p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${meta.cls}`}>
                <meta.icon size={13} className={meta.spin ? 'animate-spin' : ''} />
                {meta.label}
              </span>
              <span className="text-sm font-medium">{batch.name}</span>
              <span className="text-xs text-muted-foreground mono">{batch.id}</span>
            </div>
            <span className="text-sm text-muted-foreground">共 {batch.total} 条 · 完成 {batch.done} · 失败 {batch.failed}</span>
          </div>
          <div className="h-2 rounded-full bg-secondary overflow-hidden">
            <div className={`h-full transition-all ${batch.failed && batch.done === 0 ? 'bg-destructive' : 'bg-primary'}`} style={{ width: `${pct}%` }} />
          </div>
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{batch.filename ? `文件：${batch.filename}` : '粘贴文本'}</span>
            <span>{pct}%</span>
          </div>
        </div>
      )}
    </div>
  )
}
