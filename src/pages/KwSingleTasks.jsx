import React, { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, Trash2 } from 'lucide-react'
import { StatusPill } from './KwSingle.jsx'

export default function KwSingleTasks() {
  const [rows, setRows] = useState([])
  const [kw, setKw] = useState('')
  const nav = useNavigate()

  const load = useCallback(async () => {
    const r = await fetch('/api/kw/tasks?mode=single&limit=300')
    const d = await r.json()
    setRows(d.rows || [])
  }, [])
  useEffect(() => { load(); const t = setInterval(load, 4000); return () => clearInterval(t) }, [load])

  const del = async (e, id) => {
    e.stopPropagation()
    if (!confirm('删除该任务？')) return
    await fetch(`/api/kw/tasks/${id}`, { method: 'DELETE' })
    load()
  }

  const filtered = rows.filter(r => !kw || (r.question || '').includes(kw))

  return (
    <div className="p-6 lg:p-8 max-w-6xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">任务库 · 单句</h1>
          <p className="text-sm text-muted-foreground mt-1">历史提交的全部单句生成任务</p>
        </div>
        <div className="relative">
          <Search size={15} className="absolute left-3 top-2.5 text-muted-foreground" />
          <input value={kw} onChange={e => setKw(e.target.value)} placeholder="搜索问句"
            className="rounded-lg border border-border bg-background pl-9 pr-3 py-2 text-sm outline-none focus:border-primary w-56" />
        </div>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-secondary/50 text-muted-foreground">
            <tr>
              <th className="text-left font-medium px-4 py-2.5">问句</th>
              <th className="text-left font-medium px-4 py-2.5">状态</th>
              <th className="text-left font-medium px-4 py-2.5">验证结果</th>
              <th className="text-left font-medium px-4 py-2.5">来源</th>
              <th className="text-left font-medium px-4 py-2.5">耗时</th>
              <th className="text-left font-medium px-4 py-2.5">时间</th>
              <th className="px-4 py-2.5"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">暂无任务，去「提交入口」生成第一个</td></tr>
            )}
            {filtered.map(t => {
              const r = t.result || {}
              const v = r.verified || {}
              const pass = v.ok
              return (
                <tr key={t.id} className="border-t border-border hover:bg-secondary/30 cursor-pointer" onClick={() => nav(`/kw/single/tasks/${t.id}`)}>
                  <td className="px-4 py-3 font-medium">{t.question}</td>
                  <td className="px-4 py-3"><StatusPill status={t.status} error={t.error} /></td>
                  <td className="px-4 py-3">
                    {t.status === 'done' ? (
                      <span className={pass ? 'text-success-strong font-medium' : 'text-destructive-strong font-medium'}>
                        {pass ? '全通过' : `泛化未中 ${(v.general || []).filter(x => !x.hit).length} · 误中 ${(v.negatives || []).filter(x => x.hit).length}`}
                      </span>
                    ) : '—'}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{r.source || '—'}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{r.elapsedMs ? `${(r.elapsedMs / 1000).toFixed(0)}s` : '—'}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground mono">{t.created_at}</td>
                  <td className="px-2">
                    <button onClick={e => del(e, t.id)} className="text-muted-foreground hover:text-destructive" title="删除"><Trash2 size={15} /></button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
