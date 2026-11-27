import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ShieldCheck, Upload, FileText, Plus, Trash2, Loader2, Send, MessageSquareText, BookOpen } from 'lucide-react'

// AI大模型质检 · 需求提交：通用规则展示 + botId/提示词/知识库 + 自定义规则
const SAMPLE_FALLBACK = ['抱歉，这个问题我还需要确认一下']

export default function ZjNew() {
  const nav = useNavigate()
  const [rules, setRules] = useState({ generic: [], custom: [], feishuPush: true })
  const [botId, setBotId] = useState('')
  const [botName, setBotName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [kbName, setKbName] = useState('')
  const [kbB64, setKbB64] = useState('')
  const [kbParsing, setKbParsing] = useState(false)
  const [customRules, setCustomRules] = useState([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [toast, setToast] = useState('')

  useEffect(() => { fetch('/api/zj/rules').then(r => r.json()).then(setRules).catch(() => { }) }, [])
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(''), 2500); return () => clearTimeout(t) }, [toast])

  const pickKb = async e => {
    const f = e.target.files?.[0]
    if (!f) return
    if (!/\.(xlsx|xls|csv)$/i.test(f.name)) { setErr('知识库支持 xlsx/csv（问答两列）'); return }
    setKbParsing(true); setErr('')
    try {
      const b64 = await new Promise((res, rej) => {
        const r = new FileReader()
        r.onload = () => res(String(r.result).split(',')[1])
        r.onerror = rej
        r.readAsDataURL(f)
      })
      setKbB64(b64); setKbName(f.name)
    } catch { setErr('知识库读取失败') }
    setKbParsing(false)
  }

  const addRule = () => setCustomRules(rs => [...rs, { name: '', pattern: '', denyPattern: '', level: '扣分', score: 25, desc: '' }])
  const updRule = (i, k, v) => setCustomRules(rs => rs.map((r, idx) => idx === i ? { ...r, [k]: v } : r))
  const delRule = i => setCustomRules(rs => rs.filter((_, idx) => idx !== i))

  const submit = async () => {
    if (!/^\d+$/.test(botId.trim())) { setErr('botId 必须是数字'); return }
    if (!prompt.trim() && !kbB64) { setErr('提示词与知识库至少提供一项（质检依据）'); return }
    for (const r of customRules) {
      if (r.name || r.pattern) {
        if (!r.name.trim() || !r.pattern.trim()) { setErr('自定义规则需同时填写名称与触发正则'); return }
        try { new RegExp(r.pattern) } catch { setErr(`自定义规则「${r.name}」正则无效`); return }
      }
    }
    setErr(''); setBusy(true)
    try {
      const body = {
        botId: botId.trim(), botName: botName.trim(), prompt: prompt,
        knowledgeBase: kbB64 || undefined, customRules: customRules.filter(r => r.name && r.pattern),
      }
      const r = await fetch('/api/zj/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const d = await r.json()
      if (!r.ok || d.error) { setErr(d.error || '提交失败'); setBusy(false); return }
      nav('/zj/tasks')
    } catch (e) { setErr(String(e)); setBusy(false) }
  }

  return (
    <div className="p-6 lg:p-8 max-w-[1080px] mx-auto space-y-6">
      <div className="page-header">
        <div className="eyebrow">AI Quality Inspection</div>
        <h1>AI大模型质检 · 需求提交</h1>
        <p className="sub">提交 botId 与提示词/知识库，基于 zhijian-all 通用规则集对全部通话做质检；报告按天产出并自动推送飞书</p>
      </div>

      <div className="grid lg:grid-cols-[1fr_300px] gap-6 items-start">
        <div className="space-y-6">
          {/* 基本信息 */}
          <div className="card p-5 space-y-4">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <ShieldCheck size={15} className="text-primary" /> 质检对象
            </div>
            <div className="grid sm:grid-cols-2 gap-4">
              <label className="block">
                <span className="text-sm font-medium">botId <span className="text-destructive">*</span></span>
                <input value={botId} onChange={e => setBotId(e.target.value)} placeholder="如 6090720"
                  className="mt-1.5 w-full rounded-lg border border-input bg-card px-3 py-2 text-sm outline-none focus:border-primary" />
              </label>
              <label className="block">
                <span className="text-sm font-medium">机器人名称 <span className="ml-1 text-[10px] rounded-full bg-secondary px-1.5 py-0.5 text-muted-foreground">选填</span></span>
                <input value={botName} onChange={e => setBotName(e.target.value)} placeholder="留空将自动从话术包/数据侧补齐"
                  className="mt-1.5 w-full rounded-lg border border-input bg-card px-3 py-2 text-sm outline-none focus:border-primary" />
              </label>
            </div>
            <p className="text-xs text-muted-foreground">通话范围：该 bot 近 7 天全部通话（平台取数，DLC 只读）；如需指定时间段请前往「任务库」查看取数说明。</p>
          </div>

          {/* 质检依据 */}
          <div className="card p-5 space-y-4">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <FileText size={15} className="text-primary" /> 质检依据材料 <span className="text-destructive">*</span>
            </div>
            <label className="block">
              <span className="text-sm font-medium">大模型提示词</span>
              <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={5}
                placeholder="粘贴该 bot 的大模型提示词全文（用于事实依据库：金额/日期/知识边界判定）"
                className="mt-1.5 w-full rounded-lg border border-input bg-card px-3 py-2 text-sm outline-none focus:border-primary font-mono leading-relaxed" />
            </label>
            <div>
              <span className="text-sm font-medium">知识库表 <span className="ml-1 text-[10px] rounded-full bg-secondary px-1.5 py-0.5 text-muted-foreground">xlsx/csv · 问答两列</span></span>
              <label className="mt-1.5 flex items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-secondary/30 px-4 py-3 text-sm text-muted-foreground cursor-pointer hover:border-primary hover:text-foreground transition">
                {kbParsing ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />}
                {kbName ? `已选择：${kbName}` : '点击上传知识库（与提示词至少一项）'}
                <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={pickKb} />
              </label>
            </div>
          </div>

          {/* 自定义规则 */}
          <div className="card p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Plus size={15} className="text-primary" /> 自定义质检规则
                <span className="text-[10px] rounded-full bg-secondary px-1.5 py-0.5 text-muted-foreground">选填 · 最多 10 条</span>
              </div>
              <button onClick={addRule} className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-secondary">
                <Plus size={13} /> 新增规则
              </button>
            </div>
            {customRules.length === 0 && (
              <p className="text-xs text-muted-foreground">按业务口径追加正则规则：命中即计分/判罚，支持否定语境放行（守卫先于判罚）。</p>
            )}
            {customRules.map((r, i) => (
              <div key={i} className="rounded-lg border border-border p-3.5 space-y-2.5 bg-secondary/20">
                <div className="flex items-center gap-2">
                  <span className="mono text-xs text-muted-foreground">C{String(i + 1).padStart(2, '0')}</span>
                  <input value={r.name} onChange={e => updRule(i, 'name', e.target.value)} placeholder="规则名称，如：禁止承诺退款"
                    className="flex-1 rounded-md border border-input bg-card px-2.5 py-1.5 text-sm outline-none focus:border-primary" />
                  <select value={r.level} onChange={e => updRule(i, 'level', e.target.value)}
                    className="rounded-md border border-input bg-card px-2 py-1.5 text-sm outline-none">
                    <option>扣分</option><option>红线</option>
                  </select>
                  <input type="number" min={5} max={100} value={r.score} onChange={e => updRule(i, 'score', Number(e.target.value))}
                    className="w-16 rounded-md border border-input bg-card px-2 py-1.5 text-sm outline-none" title="分值" />
                  <button onClick={() => delRule(i)} className="rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-destructive"><Trash2 size={14} /></button>
                </div>
                <div className="grid md:grid-cols-2 gap-2.5">
                  <input value={r.pattern} onChange={e => updRule(i, 'pattern', e.target.value)} placeholder="触发正则，如 保证|一定能|肯定退"
                    className="mono w-full rounded-md border border-input bg-card px-2.5 py-1.5 text-xs outline-none focus:border-primary" />
                  <input value={r.denyPattern} onChange={e => updRule(i, 'denyPattern', e.target.value)} placeholder="放行正则（选填），如 无法保证|不能保证"
                    className="mono w-full rounded-md border border-input bg-card px-2.5 py-1.5 text-xs outline-none focus:border-primary" />
                </div>
                <input value={r.desc} onChange={e => updRule(i, 'desc', e.target.value)} placeholder="判定说明（写入报告）"
                  className="w-full rounded-md border border-input bg-card px-2.5 py-1.5 text-xs outline-none focus:border-primary" />
              </div>
            ))}
          </div>

          {err && <div className="text-sm text-destructive flex items-center gap-1.5">⚠ {err}</div>}
          <button onClick={submit} disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground shadow-sm hover:opacity-90 disabled:opacity-40">
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
            提交质检任务
          </button>
        </div>

        {/* 侧栏：通用规则 */}
        <aside className="space-y-4">
          <div className="card p-4">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <BookOpen size={15} className="text-primary" /> 通用质检规则
              <span className="ml-auto text-[10px] rounded-full bg-primary/10 text-primary px-2 py-0.5 font-medium">默认全部启用</span>
            </div>
            <p className="text-[11px] text-muted-foreground mt-1.5">zhijian-all 通用 10 条规则随每单自动写入，无需勾选。</p>
            <div className="mt-3 space-y-1.5">
              {rules.generic.map(r => (
                <div key={r.id} className="rounded-lg border border-border px-2.5 py-2">
                  <div className="flex items-center gap-1.5">
                    <span className="mono text-[11px] text-muted-foreground">{r.id}</span>
                    <span className="text-xs font-medium">{r.name}</span>
                    <span className={`ml-auto text-[10px] rounded-full px-1.5 py-0.5 font-medium ${r.level === '红线' ? 'bg-destructive-weak text-destructive-strong' : 'bg-warning-weak text-warning-strong'}`}>{r.level}</span>
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">{r.desc}</div>
                </div>
              ))}
            </div>
          </div>
          <div className="card p-4">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <MessageSquareText size={15} className="text-primary" /> 飞书推送
            </div>
            <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
              {rules.feishuPush
                ? '已开启：任务完成后按天推送质检摘要与 Word 报告至飞书群（默认「客户成功」，可在 data/zj-config.json 配置目标群）。'
                : '推送已关闭（data/zj-config.json feishuPush=false）。'}
            </p>
          </div>
        </aside>
      </div>

      {toast && <div className="fixed bottom-6 right-6 rounded-lg bg-foreground text-background px-4 py-2.5 text-sm shadow-lg">{toast}</div>}
    </div>
  )
}
