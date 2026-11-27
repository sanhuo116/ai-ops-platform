import { apiFetch, appPath } from '../platform.js'
// XsTasks.jsx —— 相似问泛化 · 任务清单 + 详情（预览生成情况 / 下载三件套）
import React, { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { Sparkles, RefreshCw, Download, FileSpreadsheet, FileText, ChevronLeft, CheckCircle2, AlertTriangle, Clock, Loader2 } from 'lucide-react'

const STATUS_BADGE = {
  done: ['bg-emerald-50 text-emerald-700', '完成'],
  running: ['bg-blue-50 text-blue-700', '执行中'],
  pending: ['bg-slate-100 text-slate-500', '排队中'],
  failed: ['bg-red-50 text-red-700', '失败'],
}
function Badge({ status }) {
  const [cls, label] = STATUS_BADGE[status] || STATUS_BADGE.pending
  return <span className={`badge ${cls}`}>{label}</span>
}

export default function XsTasks() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const load = async () => {
    try { const r = await apiFetch('/api/xs/tasks'); const d = await r.json(); setRows(d.rows || []) } catch { }
    setLoading(false)
  }
  useEffect(() => { load(); const t = setInterval(load, 3000); return () => clearInterval(t) }, [])

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-violet-600" />
          <h1 className="text-lg font-bold">相似问泛化 · 任务清单</h1>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-slate-400 flex items-center gap-1"><Clock className="w-3 h-3" />每 3 秒自动刷新</span>
          <Link to="/xs/new" className="btn-primary text-sm">+ 新建任务</Link>
        </div>
      </div>
      {loading ? <div className="text-sm text-slate-400">加载中…</div> : !rows.length ? (
        <div className="card p-10 text-center text-slate-400 text-sm">暂无任务，先去 <Link className="text-violet-600 underline" to="/xs/new">任务提交</Link></div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50"><tr>
              {['任务', '租户/bot', '场景', '条目×数量', '生成进度', '状态', '时间', ''].map(h => <th key={h} className="text-left px-3 py-2 text-xs font-medium text-slate-500">{h}</th>)}
            </tr></thead>
            <tbody>
              {rows.map(t => (
                <tr key={t.id} className="border-t hover:bg-slate-50/60">
                  <td className="px-3 py-2"><Link className="text-violet-700 hover:underline font-medium" to={`/xs/tasks/${t.id}`}>{t.name || t.id}</Link></td>
                  <td className="px-3 py-2 text-xs text-slate-500">{t.tenant_id} / {t.bot_id}</td>
                  <td className="px-3 py-2"><span className="badge bg-violet-50 text-violet-700">{t.scene_label}</span></td>
                  <td className="px-3 py-2 text-xs">{t.kb_count} × {t.per_kb}</td>
                  <td className="px-3 py-2">
                    {t.status === 'done' && t.result ? (
                      <span className="text-xs font-medium">{t.result.stat?.gotTotal ?? '-'}/{t.need_total}</span>
                    ) : (
                      <div className="flex items-center gap-2"><div className="w-24 h-1.5 bg-slate-100 rounded-full overflow-hidden"><div className="h-full bg-violet-500" style={{ width: `${t.progress || 0}%` }} /></div><span className="text-xs text-slate-400">{t.progress || 0}%</span></div>
                    )}
                  </td>
                  <td className="px-3 py-2"><Badge status={t.status} /></td>
                  <td className="px-3 py-2 text-xs text-slate-400">{t.created_at}</td>
                  <td className="px-3 py-2 text-xs text-slate-500 max-w-[180px] truncate">{t.status === 'failed' ? (t.error || '') : (t.stage_detail || '')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export function XsTaskDetail() {
  const { id } = useParams()
  const [t, setT] = useState(null)
  const [notFound, setNotFound] = useState(false)
  const [tab, setTab] = useState('preview')
  const load = async () => {
    try {
      const r = await apiFetch(`/api/xs/tasks/${id}`)
      if (r.status === 404) { setNotFound(true); return }
      const d = await r.json(); setT(d)
    } catch { }
  }
  useEffect(() => { load(); const timer = setInterval(load, t?.status === 'running' || !t ? 2500 : 10000); return () => clearInterval(timer) }, [id, t?.status])
  if (notFound) return <div className="p-6 text-sm text-slate-500">任务不存在</div>
  if (!t) return <div className="p-6 text-sm text-slate-400">加载中…</div>

  const stat = t.result?.stat
  const items = t.result?.preview || t.result?.items || []
  const verify = t.result && null // 校验明细在 xlsx 里
  const fullPass = t.result?.fullPass

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Link to="/xs/tasks" className="text-slate-400 hover:text-slate-600"><ChevronLeft className="w-5 h-5" /></Link>
          <h1 className="text-lg font-bold">{t.name || t.id}</h1>
          <Badge status={t.status} />
        </div>
        {t.status === 'done' && (
          <div className="flex items-center gap-2">
            <a className="btn-ghost text-xs flex items-center gap-1" href={appPath(`/api/xs/tasks/${id}/download/tpl`)}><Download className="w-3.5 h-3.5" />导入模板</a>
            <a className="btn-ghost text-xs flex items-center gap-1" href={appPath(`/api/xs/tasks/${id}/download/txt`)}><FileText className="w-3.5 h-3.5" />文本版</a>
            <a className="btn-primary text-xs flex items-center gap-1" href={appPath(`/api/xs/tasks/${id}/download/xlsx`)}><FileSpreadsheet className="w-3.5 h-3.5" />下载 Excel 结果</a>
          </div>
        )}
      </div>

      {/* 概要 */}
      <div className="grid grid-cols-6 gap-3">
        {[
          ['知识库条目', t.kb_count ?? '-'],
          ['每条数量', t.per_kb ?? '-'],
          ['目标总数', t.need_total ?? '-'],
          ['实际生成', stat?.gotTotal ?? '-'],
          ['黑名单撞车剔除', stat?.blacklistHit ?? '-'],
          ['批内重复剔除', stat?.dupRemoved ?? '-'],
        ].map(([k, v]) => (
          <div key={k} className="card p-3">
            <div className="text-xs text-slate-400">{k}</div>
            <div className="text-lg font-bold mt-1">{v}</div>
          </div>
        ))}
      </div>

      {/* 进行中 */}
      {(t.status === 'running' || t.status === 'pending') && (
        <div className="card p-4 space-y-2">
          <div className="flex items-center gap-2 text-sm"><Loader2 className="w-4 h-4 animate-spin text-violet-600" />{t.stage_detail || '执行中…'}</div>
          <div className="h-2 bg-slate-100 rounded-full overflow-hidden"><div className="h-full bg-violet-500 transition-all" style={{ width: `${t.progress || 0}%` }} /></div>
        </div>
      )}
      {t.status === 'failed' && <div className="card p-4 text-sm text-red-600">✗ {t.error || '任务失败'}</div>}

      {/* 完成：结果区 */}
      {t.status === 'done' && (
        <>
          <div className={`card p-3 text-sm flex items-center gap-2 ${fullPass ? 'text-emerald-700 bg-emerald-50/60' : 'text-amber-700 bg-amber-50/60'}`}>
            {fullPass ? <CheckCircle2 className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
            {fullPass
              ? `全局唯一性校验通过：${stat.gotTotal}/${stat.needTotal} 条，黑名单撞车 0，红线拦截 ${stat.redlineCount}`
              : `部分达标：生成 ${stat.gotTotal}/${stat.needTotal}（黑名单撞车 ${stat.blacklistHit}、红线 ${stat.redlineCount}），缺口条目见 Excel 校验报告 sheet`}
            <span className="ml-auto text-xs text-slate-400">场景：{stat?.scene}</span>
          </div>
          <div className="flex gap-2">
            {['preview', 'items'].map(k => (
              <button key={k} onClick={() => setTab(k)} className={`btn-ghost text-xs ${tab === k ? 'ring-1 ring-violet-400 text-violet-700' : 'text-slate-500'}`}>
                {k === 'preview' ? '生成预览' : '全部条目'}
              </button>
            ))}
          </div>
          <div className="card divide-y max-h-[560px] overflow-auto">
            {items.length === 0 && <div className="p-6 text-sm text-slate-400">暂无数据</div>}
            {items.map((it, i) => (
              <div key={i} className="p-3">
                <div className="text-sm font-medium">{it.title}{it.group && <span className="badge bg-slate-100 text-slate-500 ml-2">{it.group}</span>}</div>
                {it.answer && <div className="text-xs text-slate-400 mt-0.5 line-clamp-1">答案：{it.answer}</div>}
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {(it.sims || []).map((q, j) => <span key={j} className="badge bg-violet-50 text-violet-700 font-normal">{q}</span>)}
                </div>
                <div className="text-xs text-slate-400 mt-1.5">{(it.sims || []).length} 条</div>
              </div>
            ))}
          </div>
          {t.result?.items?.length > 50 && tab === 'preview' && <div className="text-xs text-slate-400">预览前 50 条，完整 {t.result.items.length} 条请下载 Excel</div>}
        </>
      )}
    </div>
  )
}
