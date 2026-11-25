import React, { useEffect, useState, useCallback } from 'react'
import { useParams } from 'react-router-dom'
import { Search, ChevronRight, Wrench, FileStack } from 'lucide-react'

export default function Libs() {
  const { kind = 'branch' } = useParams()
  const [rows, setRows] = useState([])
  const [total, setTotal] = useState(0)
  const [stats, setStats] = useState(null)
  const [q, setQ] = useState('')
  const [openId, setOpenId] = useState(null)
  const [kw, setKw] = useState([])

  const load = useCallback(async () => {
    const r = await (await fetch(`/api/lib/${kind}?q=${encodeURIComponent(q)}&limit=300`)).json()
    setRows(r.rows); setTotal(r.total)
    const s = await (await fetch('/api/lib/stats')).json()
    setStats(s)
  }, [kind, q])

  useEffect(() => { load() }, [load])

  const open = async id => {
    if (openId === id) { setOpenId(null); return }
    const r = await (await fetch(`/api/lib/${kind}/${id}`)).json()
    setKw(r.keywords); setOpenId(id)
  }

  const meta = kind === 'branch'
    ? { title: '正则库（全局分支库）', desc: '节点分支引用的具名正则集合，巡检取词与补词建议的基准库', icon: Wrench }
    : { title: '问题库', desc: '按用户问题语义组织的正则集合（标准问法 + 触发正则）', icon: FileStack }

  return (
    <div className="p-6 lg:p-8 max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-semibold">{meta.title}</h1>
        <p className="text-sm text-muted-foreground mt-1">{meta.desc}</p>
        {stats && (
          <div className="mt-3 flex gap-3 text-sm">
            <span className="rounded-lg bg-secondary px-3 py-1.5">{kind === 'branch' ? '分组' : '分组'} <b className="mono">{stats[kind]?.groups}</b></span>
            <span className="rounded-lg bg-secondary px-3 py-1.5">正则条数 <b className="mono">{stats[kind]?.kws}</b></span>
            <span className="rounded-lg bg-secondary px-3 py-1.5 text-muted-foreground">来源：67966 公安 SaaS 测试租户</span>
          </div>
        )}
      </div>

      <div className="card overflow-hidden">
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
          <div className="relative flex-1 max-w-md">
            <Search size={14} className="absolute left-3 top-2.5 text-muted-foreground" />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="搜索分组名 / 标签"
              className="w-full rounded-lg border border-input bg-card pl-9 pr-3 py-2 text-sm" />
          </div>
          <span className="ml-auto text-sm text-muted-foreground">共 {total} 组</span>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-secondary/50 text-muted-foreground">
            <tr>
              <th className="text-left font-medium px-4 py-2.5">名称</th>
              <th className="text-left font-medium px-4 py-2.5">标签</th>
              <th className="text-left font-medium px-4 py-2.5">关联场景</th>
              <th className="text-left font-medium px-4 py-2.5">正则数</th>
              <th className="text-left font-medium px-4 py-2.5">最近修改</th>
              <th className="px-4 py-2.5"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <React.Fragment key={`${r.kind}-${r.id}`}>
                <tr className="border-t border-border hover:bg-secondary/30 cursor-pointer" onClick={() => open(r.id)}>
                  <td className="px-4 py-3 font-medium">{r.name}</td>
                  <td className="px-4 py-3">
                    <span className="rounded-full bg-secondary px-2 py-0.5 text-xs">{r.label || '未分类'}</span>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground max-w-[260px] truncate">{(parseScenes(r.scenes) || ['—']).join('、')}</td>
                  <td className="px-4 py-3 mono">{r.kw_n}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground mono">{r.gmt_modified}</td>
                  <td className="px-4 py-3 text-right text-muted-foreground">
                    <ChevronRight size={15} className={`inline transition-transform ${openId === r.id ? 'rotate-90' : ''}`} />
                  </td>
                </tr>
                {openId === r.id && (
                  <tr className="bg-secondary/30">
                    <td colSpan={6} className="px-6 py-4">
                      <div className="text-xs text-muted-foreground mb-2">正则关键词 {kw.length} 条</div>
                      <div className="space-y-1.5 max-h-72 overflow-auto">
                        {kw.map(k => (
                          <code key={k.id} className="mono block rounded bg-card border border-border px-2.5 py-1.5 text-accent-foreground regex-text">{k.text}</code>
                        ))}
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
            {rows.length === 0 && <tr><td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">无匹配分组</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function parseScenes(s) {
  try { return JSON.parse(s) } catch { return [] }
}
