import { apiFetch } from '../platform.js'
// AoNew.jsx —— Agent自动优化 · 任务提交
// 第一步选择：是否外呼/呼入过 → 已外呼(botId+租户ID) / 未外呼(botId+知识库/需求文档多份上传)
import React, { useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bot, Upload, PhoneCall, FilePlus2, Send, X } from 'lucide-react'

export default function AoNew() {
  const nav = useNavigate()
  const fileRef = useRef(null)
  const [mode, setMode] = useState(null) // called | draft
  const [botId, setBotId] = useState('')
  const [tenantId, setTenantId] = useState('')
  const [files, setFiles] = useState([])   // {stored,name,brief}
  const [uploading, setUploading] = useState(false)
  const [requirementBrief, setRequirementBrief] = useState('')
  const [name, setName] = useState('')
  const [err, setErr] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function onFile(e) {
    const fs = [...(e.target.files || [])]
    if (!fs.length) return
    setUploading(true); setErr('')
    try {
      for (const f of fs) {
        const fd = new FormData(); fd.append('file', f)
        const r = await apiFetch('/api/ao/upload', { method: 'POST', body: fd })
        const d = await r.json()
        if (d.error) throw new Error(d.error)
        setFiles(prev => [...prev, { stored: d.stored, name: d.name, brief: d.brief || '' }])
      }
    } catch (ex) { setErr(String(ex.message || ex)) }
    setUploading(false)
    if (fileRef.current) fileRef.current.value = ''
  }

  async function submit() {
    setErr('')
    if (!/^\d+$/.test(botId.trim())) return setErr('botId 必须是数字')
    if (mode === 'called' && !tenantId.trim()) return setErr('已外呼模式需要租户 ID')
    if (mode === 'draft' && !files.length) return setErr('未外呼模式需要至少上传一份知识库或需求文档')
    setSubmitting(true)
    setErr('')
    try {
      // 先做类型预检：质检与 Agent自动优化仅支持大模型 Agent，规则版引导至私有化话术包直优
      const pr = await apiFetch(`/api/bot/type?botId=${encodeURIComponent(botId.trim())}`)
      const pd = await pr.json()
      if (pd && pd.type === 'rule') { setErr(pd.message || '该 bot 是规则版，不属于大模型 Agent'); setSubmitting(false); return }
      if (pd && pd.error) { setErr(pd.error); setSubmitting(false); return }
      const r = await apiFetch('/api/ao/tasks', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, mode, botId, tenantId, files, requirementBrief }),
      })
      const d = await r.json()
      if (d.error) throw new Error(d.error)
      nav(`/ao/tasks/${d.id}`)
    } catch (ex) { setErr(String(ex.message || ex)); setSubmitting(false) }
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-5">
      <div className="flex items-center gap-2">
        <Bot className="w-5 h-5 text-blue-600" />
        <h1 className="text-lg font-bold">Agent自动优化 · 任务提交</h1>
        <span className="text-xs text-slate-400">voiceagent-evidence-driven-optimizer：配置基线 → 政策台账 → 测试集 → 真实跑测 → 逐案归因</span>
      </div>

      {/* ① 是否外呼过 */}
      <section className="card p-4 space-y-3">
        <h2 className="font-semibold text-sm">① 该 bot 是否已外呼/呼入过？</h2>
        <div className="grid grid-cols-2 gap-3">
          <button onClick={() => setMode('called')}
            className={`flex items-center gap-3 rounded-xl border p-4 text-left transition ${mode === 'called' ? 'border-blue-500 bg-blue-50/60 ring-1 ring-blue-400' : 'border-border hover:bg-secondary/50'}`}>
            <PhoneCall className="w-6 h-6 text-emerald-600" />
            <div>
              <div className="font-medium text-sm">已外呼/呼入过</div>
              <div className="text-xs text-slate-500 mt-0.5">提交 botId + 租户 ID：从数仓取历史通话做质检问题输入</div>
            </div>
          </button>
          <button onClick={() => setMode('draft')}
            className={`flex items-center gap-3 rounded-xl border p-4 text-left transition ${mode === 'draft' ? 'border-blue-500 bg-blue-50/60 ring-1 ring-blue-400' : 'border-border hover:bg-secondary/50'}`}>
            <FilePlus2 className="w-6 h-6 text-violet-600" />
            <div>
              <div className="font-medium text-sm">未外呼/呼入过</div>
              <div className="text-xs text-slate-500 mt-0.5">提交 botId + 知识库与需求文档（可多份）：按知识拆解政策设计用例</div>
            </div>
          </button>
        </div>
      </section>

      {mode && (
        <>
          {/* ② 基本信息 */}
          <section className="card p-4 space-y-4">
            <h2 className="font-semibold text-sm">② {mode === 'called' ? '通话来源信息' : '知识来源信息'}</h2>
            <div className={`grid gap-4 ${mode === 'called' ? 'grid-cols-2' : 'grid-cols-1'}`}>
              <div>
                <label className="text-xs text-slate-500 block mb-1">botId <span className="text-red-500">*</span></label>
                <input className="input w-full" value={botId} onChange={e => setBotId(e.target.value)} placeholder="如 2927710" />
              </div>
              {mode === 'called' && (
                <div>
                  <label className="text-xs text-slate-500 block mb-1">租户 ID <span className="text-red-500">*</span></label>
                  <input className="input w-full" value={tenantId} onChange={e => setTenantId(e.target.value)} placeholder="如 67966" />
                </div>
              )}
            </div>

            {mode === 'draft' && (
              <div className="space-y-3">
                <div>
                  <label className="text-xs text-slate-500 block mb-1">知识库 / 需求文档 <span className="text-red-500">*</span> <span className="text-slate-400">（支持多份：xlsx/csv/txt/md/docx/pdf/json）</span></label>
                  <label className="flex flex-col items-center justify-center gap-1.5 border-2 border-dashed rounded-lg py-6 cursor-pointer hover:border-violet-400 hover:bg-violet-50/40 transition">
                    <Upload className="w-6 h-6 text-violet-500" />
                    <span className="text-sm text-slate-500">{uploading ? '上传解析中…' : '点击选择文件（可多选）'}</span>
                    <input ref={fileRef} type="file" multiple accept=".xlsx,.xls,.csv,.txt,.md,.docx,.pdf,.json" className="hidden" onChange={onFile} disabled={uploading} />
                  </label>
                </div>
                {files.length > 0 && (
                  <div className="space-y-1.5">
                    {files.map((f, i) => (
                      <div key={i} className="flex items-center gap-2 text-sm border rounded-lg px-3 py-2">
                        <span className="font-medium flex-1 truncate">{f.name}</span>
                        {f.brief && <span className="badge bg-emerald-50 text-emerald-700">已解析 {f.brief.length} 字摘要</span>}
                        <button onClick={() => setFiles(files.filter((_, j) => j !== i))} className="text-slate-400 hover:text-red-500"><X className="w-4 h-4" /></button>
                      </div>
                    ))}
                  </div>
                )}
                <div>
                  <label className="text-xs text-slate-500 block mb-1">需求补充说明 <span className="text-slate-400">（可选，粘贴业务规则/政策要点）</span></label>
                  <textarea className="input w-full min-h-[90px]" value={requirementBrief} onChange={e => setRequirementBrief(e.target.value)} placeholder="例如：新政策要点、重点验证的业务边界…" />
                </div>
              </div>
            )}

            {mode === 'called' && (
              <div className="text-xs text-slate-500 bg-slate-50 rounded p-3 leading-5">
                提交后将按 voiceagent-evidence-driven-optimizer 流程执行：星球 CLI 导出配置基线 → 数仓/历史通话整理问题输入 → 政策台账 → 全面测试集（含质检问题复现）→ freeze → <b>真实文本跑测</b>（独立会话）→ 逐案 PASS/FAIL/BLOCKED 归因。修复写入（prompt/知识变更）需另行明确授权。
              </div>
            )}
            <div>
              <label className="text-xs text-slate-500 block mb-1">任务名称 <span className="text-slate-400">（可选）</span></label>
              <input className="input w-full" value={name} onChange={e => setName(e.target.value)} placeholder="不填则自动命名" />
            </div>
          </section>

          {err && <div className="text-sm text-red-600">✗ {err}</div>}
          <div className="flex justify-end">
            <button className="btn-primary flex items-center gap-2" onClick={submit} disabled={submitting || uploading}>
              <Send className="w-4 h-4" />{submitting ? '提交中…' : '提交任务，开始跑测'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
