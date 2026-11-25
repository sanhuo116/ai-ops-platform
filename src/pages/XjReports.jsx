import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { RefreshCw, Search, Plus, FileText, Download, RotateCcw, Loader2, XCircle, Clock3, CheckCircle2 } from 'lucide-react'

const STATUS_META = {
  processing: { label: '制作中', cls: 'bg-secondary text-muted-foreground', icon: Loader2 },
  success: { label: '成功', cls: 'bg-emerald-50 text-emerald-700', icon: CheckCircle2 },
  failed: { label: '失败', cls: 'bg-red-50 text-red-700', icon: XCircle },
}
const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'processing', label: '制作中' },
  { key: 'success', label: '成功' },
  { key: 'failed', label: '失败' },
]

export default function XjReports() {
  const navigate = useNavigate()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all')
  const [q, setQ] = useState('')
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setErr('')
    try {
      const res = await fetch('/api/xj/requests')
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || '加载失败')
      setRows(data.rows || [])
    } catch (e) { setErr(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])
  // 制作中的任务每 6 秒轮询一次
  useEffect(() => {
    if (!rows.some(r => r.status === 'processing')) return
    const t = setInterval(load, 6000)
    return () => clearInterval(t)
  }, [rows, load])

  const counts = useMemo(() => {
    const c = { all: rows.length, processing: 0, success: 0, failed: 0 }
    rows.forEach(r => { c[r.status] = (c[r.status] || 0) + 1 })
    return c
  }, [rows])

  const filtered = useMemo(() => {
    const k = q.trim().toLowerCase()
    return rows.filter(r =>
      (filter === 'all' || r.status === filter) &&
      (!k || [r.tenant, r.template, r.skill, r.task_name, r.period].some(v => String(v || '').toLowerCase().includes(k))))
  }, [rows, filter, q])

  const retry = async id => {
    await fetch(`/api/xj/requests/${id}/retry`, { method: 'POST' })
    load()
  }
  const download = id => { window.location.href = `/api/xj/requests/${id}/download` }

  return (
    <div className="max-w-[1080px] mx-auto px-6 py-8">
      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="text-[11px] font-semibold tracking-widest text-accent-foreground uppercase">Report Center</div>
          <h1 className="mt-1 text-2xl font-semibold">报告提取</h1>
          <p className="mt-1 text-sm text-muted-foreground">查看巡检任务的生成进度，下载已完成的分析报告。</p>
        </div>
        <button onClick={() => navigate("/xj/submit")}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-4 py-2.5 text-sm font-medium hover:bg-secondary">
          <Plus size={15} />新建需求
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        {[
          ['全部报告', counts.all, '累计提交', 'text-foreground'],
          ['制作中', counts.processing, '正在处理', 'text-muted-foreground'],
          ['已成功', counts.success, '可下载', 'text-emerald-600'],
          ['失败', counts.failed, '需重新提交', 'text-red-600'],
        ].map(([label, n, hint, color]) => (
          <div key={label} className="rounded-xl border border-border bg-card p-4">
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className={`mt-1 text-2xl font-semibold ${color}`}>{n}</div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-border">
          <div className="flex items-center gap-1">
            {FILTERS.map(f => (
              <button key={f.key} onClick={() => setFilter(f.key)}
                className={`rounded-lg px-3 py-1.5 text-sm transition
                  ${filter === f.key ? 'bg-accent text-accent-foreground font-medium' : 'text-muted-foreground hover:bg-secondary'}`}>
                {f.label} <span className="text-xs opacity-70">{counts[f.key] ?? 0}</span>
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <label className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input value={q} onChange={e => setQ(e.target.value)} placeholder="搜索租户、模板或周期"
                className="w-56 rounded-lg border border-input bg-card pl-8 pr-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" />
            </label>
            <button onClick={load} title="刷新"
              className="rounded-lg border border-border p-2 text-muted-foreground hover:bg-secondary"><RefreshCw size={14} /></button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground border-b border-border bg-secondary/40">
                <th className="px-4 py-2.5 font-medium">报告名称</th>
                <th className="px-4 py-2.5 font-medium">业务场景</th>
                <th className="px-4 py-2.5 font-medium">巡检模板</th>
                <th className="px-4 py-2.5 font-medium">报告周期</th>
                <th className="px-4 py-2.5 font-medium">提交时间</th>
                <th className="px-4 py-2.5 font-medium">状态</th>
                <th className="px-4 py-2.5 font-medium text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={7} className="px-4 py-10 text-center text-muted-foreground"><Loader2 size={18} className="mx-auto animate-spin" /></td></tr>
              )}
              {!loading && err && (
                <tr><td colSpan={7} className="px-4 py-10 text-center text-destructive text-sm">{err}（<button onClick={load} className="underline">重试</button>）</td></tr>
              )}
              {!loading && !err && filtered.map(r => {
                const meta = STATUS_META[r.status] || STATUS_META.processing
                const Icon = meta.icon
                return (
                  <tr key={r.id} className="border-b border-border last:border-0 hover:bg-secondary/30">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <FileText size={16} className="text-primary shrink-0" />
                        <div className="min-w-0">
                          <div className="font-medium truncate max-w-[220px]">{r.report_name || `${r.tenant}巡检报告`}</div>
                          <div className="text-xs text-muted-foreground truncate max-w-[220px]">{r.tenant} · {r.id}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{r.scenario || '—'}</td>
                    <td className="px-4 py-3">
                      <div className="font-medium">{r.template}</div>
                      <div className="text-xs text-muted-foreground">{r.skill}</div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{r.period || `${r.period_start} ~ ${r.period_end}`}</td>
                    <td className="px-4 py-3 text-muted-foreground">{String(r.created_at || '').slice(0, 16).replace('T', ' ')}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${meta.cls}`}>
                        <Icon size={12} className={r.status === 'processing' ? 'animate-spin' : ''} />{meta.label}
                      </span>
                      {r.status === 'failed' && (
                        <div className="mt-1 text-[11px] text-destructive max-w-[200px] truncate" title={r.error}>{r.error}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      {r.status === 'success' && (
                        <button onClick={() => download(r.id)}
                          className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-secondary">
                          <Download size={13} />下载
                        </button>
                      )}
                      {r.status === 'failed' && (
                        <button onClick={() => retry(r.id)}
                          className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-secondary">
                          <RotateCcw size={13} />重新生成
                        </button>
                      )}
                      {r.status === 'processing' && (
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Clock3 size={13} />生成中</span>
                      )}
                    </td>
                  </tr>
                )
              })}
              {!loading && !err && !filtered.length && (
                <tr><td colSpan={7} className="px-4 py-12 text-center">
                  <Search size={22} className="mx-auto text-muted-foreground/50" />
                  <div className="mt-2 text-sm font-medium">没有匹配的报告</div>
                  <div className="text-xs text-muted-foreground mt-0.5">提交巡检需求后，报告会出现在这里</div>
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between px-4 py-2.5 text-xs text-muted-foreground border-t border-border bg-secondary/30">
          <span>共 {filtered.length} 条报告</span>
          <span>制作中任务每 6 秒自动刷新</span>
        </div>
      </div>
    </div>
  )
}
