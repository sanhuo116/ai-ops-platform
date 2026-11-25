import React, { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { FolderOpen, Loader2, CheckCircle2, XCircle, Download } from 'lucide-react'

export default function KwBatchTasks() {
  const [rows, setRows] = useState([])
  const nav = useNavigate()

  const load = useCallback(async () => {
    const r = await fetch('/api/kw/batches')
    const d = await r.json()
    setRows(d.rows || [])
  }, [])
  useEffect(() => { load(); const t = setInterval(load, 3000); return () => clearInterval(t) }, [load])

  return (
    <div className="p-6 lg:p-8 max-w-6xl mx-auto space-y-5">
      <div className="page-header">
        <h1>任务库 · 批量</h1>
        <p className="text-sm text-muted-foreground mt-1">历史全部批量任务批次，点开查看每条问句的进度与结果</p>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-secondary/50 text-muted-foreground">
            <tr>
              <th className="text-left font-medium px-4 py-2.5">批次</th>
              <th className="text-left font-medium px-4 py-2.5">来源</th>
              <th className="text-left font-medium px-4 py-2.5">状态</th>
              <th className="text-left font-medium px-4 py-2.5">进度</th>
              <th className="text-left font-medium px-4 py-2.5">创建时间</th>
              <th className="px-4 py-2.5"></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">暂无批次，去「提交入口」导入问句清单</td></tr>
            )}
            {rows.map(b => {
              const Icon = b.status === 'done' ? CheckCircle2 : Loader2
              const cls = b.status === 'done' ? 'bg-success-weak text-success-strong' : 'bg-info-weak text-info-strong'
              const finished = (b.done || 0) + (b.failed || 0)
              const pct = b.total ? Math.round((finished / b.total) * 100) : 0
              return (
                <tr key={b.id} className="border-t border-border hover:bg-secondary/30 cursor-pointer" onClick={() => nav(`/kw/batch/tasks/${b.id}`)}>
                  <td className="px-4 py-3">
                    <div className="font-medium">{b.name}</div>
                    <div className="text-xs text-muted-foreground mono">{b.id}</div>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{b.filename || '粘贴文本'}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${cls}`}>
                      <Icon size={13} className={b.status === 'running' ? 'animate-spin' : ''} />
                      {b.status === 'done' ? '已完成' : '执行中'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-xs">{b.done || 0}/{b.total} 完成{b.failed ? ` · ${b.failed} 条重试中` : ''}</div>
                    <div className="mt-1.5 h-1.5 w-40 rounded-full bg-secondary overflow-hidden">
                      <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground mono">{b.created_at}</td>
                  <td className="px-2">
                    <a href={`/api/kw/batches/${b.id}/export`} download onClick={e => e.stopPropagation()}
                      className="text-muted-foreground hover:text-primary" title="导出结果 xlsx"><Download size={15} /></a>
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
