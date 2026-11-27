// AoTasks.jsx —— Agent自动优化 · 任务库（列表+详情） 与 质检回归测试（清单）
import React, { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { Bot, ChevronLeft, Loader2, RefreshCw, CheckCircle2, XCircle, AlertTriangle, FlaskConical, RotateCcw, FileSearch } from 'lucide-react'

const STAGE_LABEL = { export: '配置基线', evidence: '问题输入', ledger: '政策台账', casebank: '测试集', freeze: '冻结', run: '真实跑测', review: '逐案归因', done: '完成' }
const REG_BADGE = {
  pass: ['bg-emerald-50 text-emerald-700', 'PASS'],
  fail: ['bg-red-50 text-red-700', 'FAIL'],
  blocked: ['bg-amber-50 text-amber-700', 'BLOCKED'],
  error: ['bg-slate-100 text-slate-500', '异常'],
  running: ['bg-blue-50 text-blue-700', '跑测中'],
  pending: ['bg-slate-100 text-slate-500', '排队'],
}
function RegBadge({ status }) {
  const [cls, label] = REG_BADGE[status] || REG_BADGE.pending
  return <span className={`badge ${cls}`}>{label}</span>
}

// ============ 任务库 ============
export default function AoTasks() {
  const [rows, setRows] = useState([])
  const load = async () => { try { const r = await fetch('/api/ao/tasks'); const d = await r.json(); setRows(d.rows || []) } catch { } }
  useEffect(() => { load(); const t = setInterval(load, 3000); return () => clearInterval(t) }, [])
  return (
    <div className="p-6 max-w-6xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2"><Bot className="w-5 h-5 text-blue-600" /><h1 className="text-lg font-bold">Agent自动优化 · 任务库</h1></div>
        <Link to="/ao/new" className="btn-primary text-sm">+ 新建任务</Link>
      </div>
      {!rows.length ? <div className="card p-10 text-center text-slate-400 text-sm">暂无任务，先去 <Link className="text-blue-600 underline" to="/ao/new">任务提交</Link></div> : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50"><tr>{['任务', 'bot', '模式', '阶段', '进度', '状态', '创建时间'].map(h => <th key={h} className="text-left px-3 py-2 text-xs font-medium text-slate-500">{h}</th>)}</tr></thead>
            <tbody>
              {rows.map(t => (
                <tr key={t.id} className="border-t hover:bg-slate-50/60">
                  <td className="px-3 py-2"><Link className="text-blue-700 hover:underline font-medium" to={`/ao/tasks/${t.id}`}>{t.name || t.id}</Link></td>
                  <td className="px-3 py-2 mono text-xs">{t.bot_id}</td>
                  <td className="px-3 py-2"><span className={`badge ${t.mode === 'called' ? 'bg-emerald-50 text-emerald-700' : 'bg-violet-50 text-violet-700'}`}>{t.mode === 'called' ? '已外呼' : '未外呼'}</span></td>
                  <td className="px-3 py-2 text-xs">{STAGE_LABEL[t.stage] || t.stage} · {t.stage_detail}</td>
                  <td className="px-3 py-2"><div className="w-24 h-1.5 bg-slate-100 rounded-full overflow-hidden"><div className="h-full bg-blue-500" style={{ width: `${t.progress || 0}%` }} /></div></td>
                  <td className="px-3 py-2">
                    {t.status === 'done' ? <span className="badge bg-emerald-50 text-emerald-700">完成</span>
                      : t.status === 'failed' ? <span className="badge bg-red-50 text-red-700">失败</span>
                        : t.status === 'running' ? <span className="badge bg-blue-50 text-blue-700">执行中</span> : <span className="badge">排队</span>}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-400">{t.created_at}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ============ 任务详情 ============
export function AoTaskDetail() {
  const { id } = useParams()
  const [t, setT] = useState(null)
  const load = async () => { try { const r = await fetch(`/api/ao/tasks/${id}`); const d = await r.json(); setT(d.error ? null : d) } catch { } }
  useEffect(() => { load(); const timer = setInterval(load, t?.status === 'running' || !t ? 2500 : 10000); return () => clearInterval(timer) }, [id, t?.status])
  if (!t) return <div className="p-6 text-sm text-slate-400">加载中…</div>
  const stat = t.result?.stat
  const stages = ['export', 'evidence', 'ledger', 'casebank', 'freeze', 'run', 'review']
  const curStage = stages.indexOf(t.stage)
  return (
    <div className="p-6 max-w-6xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Link to="/ao/tasks" className="text-slate-400 hover:text-slate-600"><ChevronLeft className="w-5 h-5" /></Link>
          <h1 className="text-lg font-bold">{t.name || t.id}</h1>
          <span className={`badge ${t.mode === 'called' ? 'bg-emerald-50 text-emerald-700' : 'bg-violet-50 text-violet-700'}`}>{t.mode === 'called' ? '已外呼' : '未外呼'}</span>
        </div>
        <span className="mono text-xs text-slate-400">bot {t.bot_id}{t.tenant_id ? ` · 租户 ${t.tenant_id}` : ''}</span>
      </div>

      <div className="card p-5 space-y-3">
        <div className="flex justify-between text-sm"><span>{STAGE_LABEL[t.stage] || t.stage} · {t.stage_detail}</span><span className="mono">{t.progress}%</span></div>
        <div className="h-2 rounded-full bg-secondary overflow-hidden"><div className={`h-full transition-all ${t.status === 'failed' ? 'bg-destructive' : 'bg-primary'}`} style={{ width: `${t.progress}%` }} /></div>
        <div className="grid grid-cols-4 lg:grid-cols-7 gap-2 pt-1">
          {stages.map((s, i) => (
            <div key={s} className={`rounded-lg border px-2 py-1.5 text-xs text-center ${i < curStage || t.status === 'done' ? 'border-success/40 bg-success-weak text-success-strong' : i === curStage && t.status === 'running' ? 'border-info/40 bg-info-weak text-info-strong' : 'border-border text-muted-foreground'}`}>{STAGE_LABEL[s]}</div>
          ))}
        </div>
        {t.status === 'failed' && <div className="rounded-lg border border-destructive/40 bg-destructive-weak p-3 text-sm text-destructive-strong">{t.error}</div>}
        {t.result?.note && <div className="text-xs text-slate-500 bg-slate-50 rounded p-2">{t.result.note}</div>}
      </div>

      {stat && (
        <>
          <div className="grid grid-cols-4 gap-3">
            {[['用例总数', stat.cases], ['PASS', stat.pass], ['FAIL', stat.fail], ['BLOCKED', stat.blocked]].map(([k, v]) => (
              <div key={k} className="card p-4"><div className="text-xs text-slate-400">{k}</div><div className={`text-xl font-bold mt-1 mono ${k === 'PASS' ? 'text-emerald-600' : k === 'FAIL' ? 'text-red-600' : ''}`}>{v}</div></div>
            ))}
          </div>
          <div className="card p-4 space-y-2">
            <div className="font-medium text-sm">逐案审核结果</div>
            <div className="divide-y max-h-96 overflow-auto">
              {(t.result.review || []).map(r => (
                <div key={r.caseId} className="py-2 flex items-start gap-3 text-sm">
                  <RegBadge status={r.verdict.toLowerCase()} />
                  <div className="min-w-0">
                    <div className="font-medium">{r.caseId} <span className="text-xs text-slate-400">({r.category})</span></div>
                    <div className="text-xs text-slate-500 mt-0.5">{r.rationale}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// ============ 质检回归测试 ============
export function AoRegression() {
  const [rows, setRows] = useState([])
  const [statusFilter, setStatusFilter] = useState('')
  const load = async () => {
    try { const r = await fetch(`/api/ao/regressions${statusFilter ? `?status=${statusFilter}` : ''}`); const d = await r.json(); setRows(d.rows || []) } catch { }
  }
  useEffect(() => { load(); const t = setInterval(load, 3000); return () => clearInterval(t) }, [statusFilter])
  return (
    <div className="p-6 max-w-6xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2"><FlaskConical className="w-5 h-5 text-amber-600" />
          <h1 className="text-lg font-bold">质检回归测试</h1>
          <span className="text-xs text-slate-400">质检问题 → LLM 设计回归用例 → freeze → 真实跑测 → PASS/FAIL/BLOCKED</span>
        </div>
        <select className="input w-36 text-sm" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="">全部状态</option>
          {['pending', 'running', 'pass', 'fail', 'blocked', 'error'].map(s => <option key={s} value={s}>{REG_BADGE[s]?.[1] || s}</option>)}
        </select>
      </div>
      {!rows.length ? <div className="card p-10 text-center text-slate-400 text-sm">暂无回归任务——到 私有化话术包直优 → 任务详情 → 质检问题清单，对问题点「是否回归测试」发起</div> : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50"><tr>{['通话ID', 'bot', '问题类型', '回归用例', '跑测状态', '审核结论', '时间', ''].map(h => <th key={h} className="text-left px-3 py-2 text-xs font-medium text-slate-500">{h}</th>)}</tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} className="border-t hover:bg-slate-50/60 align-top">
                  <td className="px-3 py-2 mono text-xs">{r.call_id || '-'}</td>
                  <td className="px-3 py-2 mono text-xs">{r.bot_id}</td>
                  <td className="px-3 py-2"><span className="badge bg-slate-100 text-slate-600">{r.problem_kind || '-'}</span><div className="text-xs text-slate-400 mt-1 max-w-[260px] truncate" title={r.problem_brief}>{r.problem_brief}</div></td>
                  <td className="px-3 py-2 text-xs text-slate-500 max-w-[200px] truncate">{r.case_json ? `${r.case_json.turns?.length || 0} 轮 · ${r.case_json.category || ''}` : '待生成'}</td>
                  <td className="px-3 py-2"><RegBadge status={r.status} /><div className="text-xs text-slate-400 mt-1">{r.stage_detail}</div></td>
                  <td className="px-3 py-2 text-xs max-w-[220px]">
                    {r.verdict && <span className={`font-medium ${r.verdict === 'PASS' ? 'text-emerald-600' : 'text-red-600'}`}>{r.verdict}</span>}
                    {r.rationale && <div className="text-slate-500 mt-0.5">{r.rationale}</div>}
                    {r.error && <div className="text-red-500 mt-0.5">{r.error.slice(0, 120)}</div>}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-400">{r.created_at}</td>
                  <td className="px-3 py-2">{['error', 'fail', 'blocked'].includes(r.status) && (
                    <button className="btn-ghost text-xs flex items-center gap-1" onClick={async () => { await fetch(`/api/ao/regressions/${r.id}/retry`, { method: 'POST' }); load() }}><RotateCcw className="w-3.5 h-3.5" />重试</button>
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
