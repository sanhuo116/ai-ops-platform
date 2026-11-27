// XsNew.jsx —— 相似问泛化 · 任务提交
// 流程：上传知识库表格(xlsx/csv/txt) → 校验解析 → 填租户/bot/场景/每条数量 → 提交
import React, { useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Sparkles, Upload, FileSpreadsheet, Trash2, Send } from 'lucide-react'

const SCENES = [
  { key: 'wenlv', label: '文旅景区' },
  { key: 'ranqi', label: '燃气' },
  { key: 'yiyuan', label: '医院' },
  { key: 'shebao', label: '社保' },
  { key: 'fanzha', label: '反诈外呼' },
  { key: 'yibao', label: '医保' },
  { key: 'xinfang', label: '信访' },
  { key: 'yunyingshang', label: '运营商' },
  { key: 'yinhang', label: '银行' },
  { key: 'other', label: '其他' },
]

export default function XsNew() {
  const nav = useNavigate()
  const fileRef = useRef(null)
  const [kb, setKb] = useState([])
  const [kbName, setKbName] = useState('')
  const [uploading, setUploading] = useState(false)
  const [uploadErr, setUploadErr] = useState('')
  const [tenantId, setTenantId] = useState('')
  const [botId, setBotId] = useState('')
  const [scene, setScene] = useState('other')
  const [perKb, setPerKb] = useState(10)
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState('')

  async function onFile(e) {
    const f = e.target.files?.[0]
    if (!f) return
    setUploading(true); setUploadErr(''); setKb([]); setKbName('')
    try {
      const fd = new FormData(); fd.append('file', f)
      const r = await fetch('/api/xs/upload', { method: 'POST', body: fd })
      const d = await r.json()
      if (d.error) throw new Error(d.error)
      setKb(d.items || []); setKbName(d.name || f.name)
    } catch (ex) { setUploadErr(String(ex.message || ex)) }
    setUploading(false)
    if (fileRef.current) fileRef.current.value = ''
  }

  async function submit() {
    setErr('')
    if (!kb.length) return setErr('请先上传知识库表格')
    if (!tenantId.trim()) return setErr('请填写租户 ID')
    if (!/^\d+$/.test(botId.trim())) return setErr('botId 必须是数字')
    setSubmitting(true)
    try {
      const r = await fetch('/api/xs/tasks', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, tenantId, botId, scene, perKb, kb }),
      })
      const d = await r.json()
      if (d.error) throw new Error(d.error)
      nav(`/xs/tasks/${d.id}`)
    } catch (ex) { setErr(String(ex.message || ex)); setSubmitting(false) }
  }

  const needTotal = kb.length * Number(perKb || 0)

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-5">
      <div className="flex items-center gap-2">
        <Sparkles className="w-5 h-5 text-violet-600" />
        <h1 className="text-lg font-bold">相似问泛化 · 任务提交</h1>
        <span className="text-xs text-slate-400">知识库表格 → 按九大场景规范生成相似问 → 全局唯一校验 → 三件套交付</span>
      </div>

      {/* ① 知识库表格 */}
      <section className="card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-sm">① 知识库表格 <span className="text-slate-400 font-normal">（xlsx / csv / txt；需含「知识库名称/标准问」列，可选「分组」「知识库答案」列）</span></h2>
          {kb.length > 0 && (
            <button className="btn-ghost text-xs flex items-center gap-1" onClick={() => { setKb([]); setKbName('') }}>
              <Trash2 className="w-3.5 h-3.5" />清空
            </button>
          )}
        </div>
        <label className="flex flex-col items-center justify-center gap-2 border-2 border-dashed rounded-lg py-7 cursor-pointer hover:border-violet-400 hover:bg-violet-50/40 transition">
          <Upload className="w-7 h-7 text-violet-500" />
          <span className="text-sm text-slate-500">{uploading ? '解析中…' : '点击选择知识库表格文件'}</span>
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv,.txt" className="hidden" onChange={onFile} disabled={uploading} />
        </label>
        {uploadErr && <div className="text-xs text-red-600">✗ {uploadErr}</div>}
        {kb.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm">
              <FileSpreadsheet className="w-4 h-4 text-emerald-600" />
              <span className="font-medium">{kbName}</span>
              <span className="badge bg-emerald-50 text-emerald-700">{kb.length} 条</span>
              {needTotal > 0 && <span className="text-xs text-slate-400">预计生成 {needTotal} 条相似问</span>}
            </div>
            <div className="border rounded-lg max-h-44 overflow-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 sticky top-0"><tr><th className="text-left px-2 py-1.5">#</th><th className="text-left px-2 py-1.5">标准问</th><th className="text-left px-2 py-1.5">分组</th><th className="text-left px-2 py-1.5">答案（截断）</th></tr></thead>
                <tbody>
                  {kb.slice(0, 50).map((it, i) => (
                    <tr key={i} className="border-t">
                      <td className="px-2 py-1 text-slate-400">{i + 1}</td>
                      <td className="px-2 py-1">{it.title}</td>
                      <td className="px-2 py-1 text-slate-500">{it.group || '-'}</td>
                      <td className="px-2 py-1 text-slate-400 max-w-[280px] truncate">{it.answer || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {kb.length > 50 && <div className="text-xs text-slate-400">仅预览前 50 条，共 {kb.length} 条</div>}
          </div>
        )}
      </section>

      {/* ② 任务参数 */}
      <section className="card p-4 space-y-4">
        <h2 className="font-semibold text-sm">② 任务参数</h2>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-xs text-slate-500 block mb-1">租户 ID <span className="text-red-500">*</span></label>
            <input className="input w-full" value={tenantId} onChange={e => setTenantId(e.target.value)} placeholder="如 67966" />
          </div>
          <div>
            <label className="text-xs text-slate-500 block mb-1">botId <span className="text-red-500">*</span></label>
            <input className="input w-full" value={botId} onChange={e => setBotId(e.target.value)} placeholder="如 2927710" />
          </div>
          <div>
            <label className="text-xs text-slate-500 block mb-1">场景 <span className="text-slate-400">（决定句式配比与俗称规范）</span></label>
            <select className="input w-full" value={scene} onChange={e => setScene(e.target.value)}>
              {SCENES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-slate-500 block mb-1">每条知识库生成相似问数 <span className="text-red-500">*</span></label>
            <input className="input w-full" type="number" min="1" max="50" value={perKb} onChange={e => setPerKb(e.target.value)} />
          </div>
          <div className="col-span-2">
            <label className="text-xs text-slate-500 block mb-1">任务名称 <span className="text-slate-400">（可选）</span></label>
            <input className="input w-full" value={name} onChange={e => setName(e.target.value)} placeholder="不填则自动命名" />
          </div>
        </div>
        <div className="text-xs text-slate-500 bg-slate-50 rounded p-3 leading-5">
          <b>生成纪律</b>：数量精确到条 · <b>全局唯一</b>（同 bot 历史任务产出/线上已有/标准问全部进黑名单，撞车即剔除）· 不编造价格/日期/证件 · 场景句式配比（确认问为主）+ 俗称双轨 + 代问句式按《相似问写作要点指南》执行
        </div>
      </section>

      {err && <div className="text-sm text-red-600">✗ {err}</div>}
      <div className="flex justify-end">
        <button className="btn-primary flex items-center gap-2" onClick={submit} disabled={submitting || uploading || !kb.length}>
          <Send className="w-4 h-4" />{submitting ? '提交中…' : `提交任务（${kb.length} 条 × ${perKb} = ${needTotal} 条相似问）`}
        </button>
      </div>
    </div>
  )
}
