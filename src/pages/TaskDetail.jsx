import React, { useEffect, useState, useCallback } from 'react'
import { useParams, Link } from 'react-router-dom'
import { ArrowLeft, RefreshCw, Loader2, Download, Search } from 'lucide-react'

const STAGE_LABEL = { pending: '排队', export: '话术包导出', fetch: '通话取数', audit: '巡检', optimize: '生成待优化库', done: '完成' }
const ACTION_META = {
  add: { label: '新增', cls: 'bg-success-weak text-success-strong' },
  remove: { label: '移除', cls: 'bg-destructive-weak text-destructive-strong' },
  modify: { label: '修改', cls: 'bg-warning-weak text-warning-strong' },
  keep: { label: '保留', cls: 'bg-secondary text-secondary-foreground' },
  review: { label: '复核', cls: 'bg-info-weak text-info-strong' },
}
const SOURCE_META = { branch: '分支正则库', question: '问题库', kb: '知识库' }

export default function TaskDetail() {
  const { id } = useParams()
  const [task, setTask] = useState(null)
  const [report, setReport] = useState(null)
  const [rows, setRows] = useState([])
  const [total, setTotal] = useState(0)
  const [q, setQ] = useState('')
  const [source, setSource] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const t = await (await fetch(`/api/tasks/${id}`)).json()
    setTask(t)
    if (t.status === 'done') {
      const r = await fetch(`/api/tasks/${id}/report`)
      if (r.ok) setReport(await r.json())
      const o = await (await fetch(`/api/tasks/${id}/optimizations?q=${encodeURIComponent(q)}&source=${source}&limit=500`)).json()
      setRows(o.rows); setTotal(o.total)
    }
  }, [id, q, source])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    const t = setInterval(() => {
      fetch(`/api/tasks/${id}`).then(r => r.json()).then(t2 => {
        setTask(prev => ({ ...t2, optCount: prev?.optCount }))
        if (t2.status === 'done' && !report) load()
        if (t2.status === 'failed') clearInterval(t)
      })
    }, 2500)
    return () => clearInterval(t)
  }, [id, report, load])

  const rerun = async () => {
    setBusy(true)
    await fetch(`/api/tasks/${id}/rerun`, { method: 'POST' })
    setReport(null); await load(); setBusy(false)
  }

  const exportCsv = () => {
    const esc = s => `"${String(s ?? '').replaceAll('"', '""')}"`
    const csv = '\uFEFF' + ['序号,来源,问题问句,所属分支/问题集,原正则,优化后正则,动作,涉及句次,证据,问题类型']
      .concat(rows.map(r => [r.seq, SOURCE_META[r.source] || r.source, r.question, r.branch, r.old_regex, r.new_regex,
        (ACTION_META[r.action] || {}).label || r.action, r.hits, r.evidence, r.problem_type].map(esc).join(',')))
      .join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    a.download = `待优化库_${id}.csv`
    a.click()
  }

  if (!task) return <div className="p-8 text-muted-foreground">加载中…</div>

  const stat = report?.stat
  const kbStat = report?.kbStat
  const correct = stat ? (stat.ok + stat.okDefault + stat.okInternalSeq + (stat.okAmbig || 0)) : 0
  const correctPct = stat && stat.steps ? (100 * correct / stat.steps).toFixed(1) : '—'

  return (
    <div className="p-6 lg:p-8 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link to="/" className="rounded-lg border border-border p-2 hover:bg-secondary"><ArrowLeft size={16} /></Link>
          <div>
            <h1>{task.bot_name || `bot ${task.bot_id}`}</h1>
            <div className="text-sm text-muted-foreground mono">任务 {task.id} · bot {task.bot_id} · {STAGE_LABEL[task.stage]}
              {task.params?.callSource === 'upload' && (
                <span className="ml-2 inline-flex items-center rounded-full bg-info-weak text-info-strong px-2 py-0.5 text-xs" title={`通话来源：上传文件 ${task.params?.uploadName || ''}`}>
                  上传通话{task.params?.uploadName ? `：${task.params.uploadName}` : ''}
                </span>
              )}
              {(!task.params?.callSource || task.params?.callSource === 'fetch') && (
                <span className="ml-2 inline-flex items-center rounded-full bg-secondary text-secondary-foreground px-2 py-0.5 text-xs">平台取数</span>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {task.status === 'done' && (
            <button onClick={exportCsv} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm hover:bg-secondary">
              <Download size={15} /> 导出 CSV
            </button>
          )}
          <button onClick={rerun} disabled={busy || task.status === 'running'}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
            {busy ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} 重跑
          </button>
        </div>
      </div>

      {task.status === 'running' && (
        <div className="card p-5">
          <div className="flex justify-between text-sm mb-2"><span>{STAGE_LABEL[task.stage]} · {task.stage_detail}</span><span>{task.progress}%</span></div>
          <div className="h-2 rounded-full bg-secondary overflow-hidden">
            <div className="h-full bg-primary transition-all" style={{ width: `${task.progress}%` }} />
          </div>
        </div>
      )}
      {task.status === 'failed' && (
        <div className="rounded-lg border border-destructive/40 bg-destructive-weak p-4 text-sm text-destructive-strong">
          任务失败：{task.error}
        </div>
      )}

      {report && (
        <>
          <div className="grid gap-4 md:grid-cols-4">
            <Kpi label="巡检电话数" value={stat?.calls ?? '—'} sub="演示缓存/线上取数" />
            <Kpi label="可判定跳转" value={stat?.steps ?? '—'} sub={`AI 话术定位率 ${stat?.exactPct ?? '—'}%`} />
            <Kpi label="走向正确率" value={`${correctPct}%`} sub={`正确 ${correct} / ${stat?.steps ?? '—'}`} good />
            <Kpi label="待优化库" value={total} sub="问题问句 · 原正则 · 优化后正则" />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="card p-5">
              <div className="text-sm font-medium mb-3">分支走向判定分布</div>
              <div className="space-y-2 text-sm">
                <Bar label="走向正确（含默认/节点内推进）" v={correct} max={stat?.steps} cls="bg-success" />
                <Bar label="命中分支却走错" v={stat?.errWrong} max={stat?.steps} cls="bg-destructive" />
                <Bar label="该走默认却偏离" v={stat?.errDefault} max={stat?.steps} cls="bg-warning" />
                <Bar label="未命中任何分支" v={stat?.noMatch} max={stat?.steps} cls="bg-muted-foreground/40" />
                <Bar label="同文歧义合法（复用话术命中任一来源节点）" v={stat?.okAmbig} max={stat?.steps} cls="bg-primary/30" />
              </div>
            </div>
            <div className="card p-5">
              <div className="text-sm font-medium mb-3">知识库巡检</div>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <Mini label="条目数" v={report?.counts?.kb ?? '—'} />
                <Mini label="死条目" v={kbStat?.deadCount ?? '—'} />
                <Mini label="命中后未按意图走" v={kbStat?.kbHitNoRedirect ?? '—'} />
                <Mini label="框架外意图次数" v={kbStat?.intentNoKb ?? '—'} />
              </div>
              <div className="mt-3 text-xs text-muted-foreground">
                排除三类正常行为：无判定分支 {stat?.skipNoJudge} 次 · 节点内顺序推进 {stat?.okInternalSeq} 次 · 开场白纯接听 {report?.counts?.skipGreet ?? 0} 句
              </div>
            </div>
          </div>
        </>
      )}

      {task.status === 'done' && (
        <div className="card overflow-hidden">
          <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-border">
            <div className="text-sm font-medium">待优化库 <span className="text-muted-foreground font-normal">（{total} 条）</span></div>
            <div className="flex items-center gap-2 ml-auto">
              <select value={source} onChange={e => setSource(e.target.value)}
                className="rounded-lg border border-input bg-card px-2.5 py-1.5 text-sm">
                <option value="">全部来源</option>
                <option value="branch">分支正则库</option>
                <option value="question">问题库</option>
                <option value="kb">知识库</option>
              </select>
              <div className="relative">
                <Search size={14} className="absolute left-2.5 top-2.5 text-muted-foreground" />
                <input value={q} onChange={e => setQ(e.target.value)} placeholder="搜问句/正则/证据"
                  className="w-56 rounded-lg border border-input bg-card pl-8 pr-3 py-1.5 text-sm" />
              </div>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-secondary/50 text-muted-foreground">
                <tr>
                  <th className="text-left font-medium px-3 py-2.5 whitespace-nowrap">#</th>
                  <th className="text-left font-medium px-3 py-2.5">来源</th>
                  <th className="text-left font-medium px-3 py-2.5 min-w-[220px]">问题问句</th>
                  <th className="text-left font-medium px-3 py-2.5">原正则</th>
                  <th className="text-left font-medium px-3 py-2.5 min-w-[240px]">优化后正则</th>
                  <th className="text-left font-medium px-3 py-2.5">动作</th>
                  <th className="text-left font-medium px-3 py-2.5">句次</th>
                  <th className="text-left font-medium px-3 py-2.5 min-w-[240px]">证据</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">无匹配记录</td></tr>}
                {rows.map(r => (
                  <tr key={r.seq} className="border-t border-border align-top hover:bg-secondary/20">
                    <td className="px-3 py-3 mono text-muted-foreground">{r.seq}</td>
                    <td className="px-3 py-3 whitespace-nowrap">
                      <span className="rounded-full bg-secondary px-2 py-0.5 text-xs">{SOURCE_META[r.source] || r.source}</span>
                      <div className="text-xs text-muted-foreground mt-1">{r.problem_type}</div>
                    </td>
                    <td className="px-3 py-3">
                      <div className="max-w-[300px]">{r.question}</div>
                      {r.branch && <div className="text-xs text-muted-foreground mt-1">分支/集合：{r.branch}</div>}
                    </td>
                    <td className="px-3 py-3 text-xs text-muted-foreground regex-text max-w-[220px]">{r.old_regex}</td>
                    <td className="px-3 py-3">
                      {r.new_regex
                        ? <code className="mono text-accent-foreground bg-accent/60 rounded px-1.5 py-0.5 regex-text block max-w-[340px]">{r.new_regex}</code>
                        : <span className="text-xs text-muted-foreground">—（需人工复核）</span>}
                    </td>
                    <td className="px-3 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${(ACTION_META[r.action] || {}).cls || 'bg-secondary'}`}>
                        {(ACTION_META[r.action] || {}).label || r.action}
                      </span>
                    </td>
                    <td className="px-3 py-3 mono">{r.hits || '—'}</td>
                    <td className="px-3 py-3 text-xs text-muted-foreground max-w-[300px]">{r.evidence}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

function Kpi({ label, value, sub, good }) {
  return (
    <div className={`card p-5 ${good ? 'border-l-4 border-l-success' : ''}`}>
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{sub}</div>
    </div>
  )
}

function Bar({ label, v, max, cls }) {
  const pct = max ? Math.round(100 * v / max) : 0
  return (
    <div>
      <div className="flex justify-between text-xs mb-1"><span>{label}</span><span className="mono">{v}（{pct}%）</span></div>
      <div className="h-2 rounded-full bg-secondary overflow-hidden">
        <div className={`h-full ${cls}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function Mini({ label, v }) {
  return (
    <div className="rounded-lg bg-secondary/60 px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold">{v}</div>
    </div>
  )
}
