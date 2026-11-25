import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Upload, FileSpreadsheet, X, Building2, CalendarRange, ClipboardList, ArrowRight, Loader2, CheckCircle2, ShieldCheck, FileDown } from 'lucide-react'

// 巡检模板目录：场景 → 可用模板（与后端 TEMPLATE_EXEC 对齐）
const TEMPLATES = [
  {
    id: 'saas-general', scenario: '语音 - SaaS', name: '通用模板',
    desc: '适用于语音 SaaS 场景', skill: 'saas-xunjian-tongyong', ready: true,
  },
  {
    id: 'hangzhou-shebao', scenario: '文本', name: '杭州社保',
    desc: '适用于文本场景（月报模板 + 截图）', skill: 'hangzhoushebao-report', ready: false,
  },
  {
    id: 'text-project', scenario: '文本', name: '文本项目通用模板',
    desc: '适用于文本客服 / 聊天机器人', skill: 'chatbot-xjbg', ready: false,
  },
  {
    id: 'yuhang-shebao', scenario: '语音 - 私有化', name: '余杭社保',
    desc: '适用于语音私有化场景', skill: 'yuhangshebao-report', ready: false,
  },
]

const SCENARIOS = [
  { value: '文本', icon: '文', hint: '适用于文本通话记录' },
  { value: '语音 - SaaS', icon: '语', hint: '百应星球 SaaS 线路' },
  { value: '语音 - 私有化', icon: '私', hint: '私有化部署线路' },
]

const TENANTS = ['鄞州公安', '青田公安', '江北公安', '慈溪公安', '呈贡公安', '浦沿', '晋江公安', '杭州人社', '余杭人社']

const fmt = n => !n ? '0 KB' : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`

export default function XjSubmit() {
  const navigate = useNavigate()
  const [scenario, setScenario] = useState('语音 - SaaS')
  const [templateId, setTemplateId] = useState('saas-general')
  const [tenant, setTenant] = useState('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [remarks, setRemarks] = useState('')
  const [files, setFiles] = useState([])
  const [submitting, setSubmitting] = useState(false)
  const [toast, setToast] = useState(null)
  const [drag, setDrag] = useState(false)
  const fileRef = useRef(null)
  const toastTimer = useRef(null)

  const showToast = (msg, type = 'ok') => {
    setToast({ msg, type })
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 2800)
  }

  const scenarioTemplates = TEMPLATES.filter(t => t.scenario === scenario)
  useEffect(() => {
    if (!scenarioTemplates.some(t => t.id === templateId)) setTemplateId(scenarioTemplates[0]?.id || '')
  }, [scenario]) // eslint-disable-line

  const addFiles = list => {
    const incoming = Array.from(list || [])
    setFiles(prev => {
      const seen = new Set(prev.map(f => `${f.name}-${f.size}`))
      return [...prev, ...incoming.filter(f => !seen.has(`${f.name}-${f.size}`))]
    })
  }

  const submit = async e => {
    e.preventDefault()
    if (submitting) return
    if (!files.length) return showToast('请先上传至少一份通话记录', 'err')
    const tpl = TEMPLATES.find(t => t.id === templateId)
    if (!tpl) return showToast('请选择巡检模板', 'err')
    if (tpl.scenario !== scenario) return showToast('模板与业务场景不匹配', 'err')
    if (!tenant.trim()) return showToast('请填写租户名称', 'err')
    if (!start || !end) return showToast('请选择报告周期', 'err')

    const payload = {
      tenant: tenant.trim(), scenario, templateId: tpl.id, template: tpl.name,
      skill: tpl.skill, taskName: `${tpl.name}巡检`,
      periodStart: start, periodEnd: end, remarks: remarks.trim(),
    }
    const fd = new FormData()
    fd.append('payload', JSON.stringify(payload))
    files.forEach(f => fd.append('files', f))

    setSubmitting(true)
    try {
      const res = await fetch('/api/xj/requests', { method: 'POST', body: fd })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `提交失败（${res.status}）`)
      showToast(`需求已提交，任务编号 ${data.id}`)
      setFiles([]); setRemarks('')
      navigate('/xj/reports')
    } catch (err) {
      showToast(err.message || '提交失败', 'err')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="max-w-[1080px] mx-auto px-6 py-8">
      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="text-[11px] font-semibold tracking-widest text-accent-foreground uppercase">New Request</div>
          <h1 className="mt-1 text-2xl font-semibold text-foreground">提交巡检需求</h1>
          <p className="mt-1 text-sm text-muted-foreground">填写巡检基础信息并上传通话记录，提交后系统调用对应 skill 自动生成报告。</p>
        </div>
        <div className="flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-sm text-muted-foreground">
          <span className="h-2 w-2 rounded-full bg-success inline-block" />服务运行正常
        </div>
      </div>

      <div className="grid lg:grid-cols-[1fr_280px] gap-6 items-start">
        <form onSubmit={submit} className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-border">
            <div>
              <h2 className="text-[15px] font-semibold">需求信息</h2>
              <p className="text-xs text-muted-foreground mt-0.5">带 <span className="text-destructive">*</span> 的字段为必填项</p>
            </div>
            <span className="text-xs text-muted-foreground rounded-md bg-secondary px-2 py-1">01 / 01</span>
          </div>

          <div className="p-5 space-y-6">
            {/* 业务场景 */}
            <fieldset>
              <legend className="text-sm font-medium mb-2.5">业务场景 <span className="text-destructive">*</span></legend>
              <div className="grid sm:grid-cols-3 gap-2.5">
                {SCENARIOS.map(s => (
                  <button key={s.value} type="button" onClick={() => setScenario(s.value)}
                    className={`relative rounded-xl border p-3.5 text-left transition
                      ${scenario === s.value ? 'border-primary bg-accent ring-1 ring-primary' : 'border-border bg-card hover:border-input'}`}>
                    <div className="flex items-center gap-2.5">
                      <span className={`h-8 w-8 rounded-lg flex items-center justify-center text-sm font-semibold
                        ${scenario === s.value ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground'}`}>{s.icon}</span>
                      <div>
                        <div className="text-sm font-medium leading-tight">{s.value}</div>
                        <div className="text-[11px] text-muted-foreground mt-0.5">{s.hint}</div>
                      </div>
                    </div>
                    {scenario === s.value && <CheckCircle2 size={16} className="absolute top-2.5 right-2.5 text-primary" />}
                  </button>
                ))}
              </div>
            </fieldset>

            {/* 巡检模板 */}
            <fieldset>
              <legend className="text-sm font-medium mb-2.5">选择巡检模板 <span className="text-destructive">*</span></legend>
              <div className="space-y-2.5">
                {scenarioTemplates.map(t => {
                  const active = templateId === t.id
                  return (
                    <button key={t.id} type="button" onClick={() => setTemplateId(t.id)}
                      className={`w-full flex items-center gap-3 rounded-xl border p-3.5 text-left transition
                        ${active ? 'border-primary bg-accent ring-1 ring-primary' : 'border-border hover:border-input'}`}>
                      <span className={`h-9 w-9 shrink-0 rounded-lg flex items-center justify-center text-sm font-bold
                        ${active ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground'}`}>
                        {t.name.slice(0, 1)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium">{t.name}</span>
                          {!t.ready && <span className="text-[10px] rounded-full bg-amber-100 text-amber-700 px-1.5 py-0.5">执行器接入中</span>}
                        </div>
                        <div className="text-xs text-muted-foreground mt-0.5">{t.desc}</div>
                        <code className="inline-block mt-1 text-[11px] text-accent-foreground bg-secondary rounded px-1.5 py-0.5">{t.skill}</code>
                      </div>
                      {active && <CheckCircle2 size={16} className="text-primary shrink-0" />}
                    </button>
                  )
                })}
              </div>
              <p className="text-xs text-muted-foreground mt-2">选择后，系统将按照对应 skill 生成巡检报告。</p>
            </fieldset>

            {/* 租户 + 周期 */}
            <div className="grid sm:grid-cols-2 gap-4">
              <label className="block">
                <span className="text-sm font-medium">租户名称 <span className="text-destructive">*</span></span>
                <div className="relative mt-2">
                  <Building2 size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <input list="xj-tenants" value={tenant} onChange={e => setTenant(e.target.value)}
                    placeholder="请输入或选择租户名称"
                    className="w-full rounded-lg border border-input bg-card pl-9 pr-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-ring" />
                  <datalist id="xj-tenants">{TENANTS.map(t => <option key={t} value={t} />)}</datalist>
                </div>
              </label>
              <label className="block">
                <span className="text-sm font-medium">报告周期 <span className="text-destructive">*</span></span>
                <div className="flex items-center gap-2 mt-2">
                  <CalendarRange size={15} className="text-muted-foreground shrink-0" />
                  <input type="date" value={start} onChange={e => setStart(e.target.value)}
                    className="flex-1 min-w-0 rounded-lg border border-input bg-card px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-ring" />
                  <span className="text-xs text-muted-foreground">至</span>
                  <input type="date" value={end} onChange={e => setEnd(e.target.value)}
                    className="flex-1 min-w-0 rounded-lg border border-input bg-card px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-ring" />
                </div>
              </label>
            </div>

            {/* 上传 */}
            <div>
              <div className="text-sm font-medium mb-2">通话记录 / 巡检资料上传 <span className="text-destructive">*</span></div>
              <div
                onDragOver={e => { e.preventDefault(); setDrag(true) }}
                onDragLeave={() => setDrag(false)}
                onDrop={e => { e.preventDefault(); setDrag(false); addFiles(e.dataTransfer.files) }}
                onClick={() => fileRef.current?.click()}
                className={`rounded-xl border border-dashed p-8 text-center cursor-pointer transition
                  ${drag ? 'border-primary bg-accent' : 'border-border bg-secondary/40 hover:border-input'}`}>
                <input ref={fileRef} type="file" multiple hidden
                  accept=".xlsx,.xls,.csv,.txt,.zip"
                  onChange={e => { addFiles(e.target.files); e.target.value = '' }} />
                <Upload size={26} className="mx-auto text-muted-foreground" />
                <div className="mt-2 text-sm font-medium">点击上传或将文件拖拽至此处</div>
                <div className="mt-1 text-xs text-muted-foreground">支持 Excel、CSV、TXT、ZIP，单个文件不超过 200MB</div>
              </div>
              {files.length > 0 && (
                <ul className="mt-2.5 space-y-1.5">
                  {files.map((f, i) => (
                    <li key={`${f.name}-${f.size}`} className="flex items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2">
                      <FileSpreadsheet size={15} className="text-primary shrink-0" />
                      <span className="text-sm truncate flex-1">{f.name}</span>
                      <span className="text-xs text-muted-foreground shrink-0">{fmt(f.size)}</span>
                      <button type="button" onClick={() => setFiles(prev => prev.filter((_, j) => j !== i))}
                        className="text-muted-foreground hover:text-destructive shrink-0"><X size={15} /></button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* 备注 */}
            <label className="block">
              <span className="text-sm font-medium">备注 <span className="ml-1 text-[10px] rounded-full bg-secondary px-1.5 py-0.5 text-muted-foreground">选填</span></span>
              <textarea value={remarks} maxLength={500} onChange={e => setRemarks(e.target.value)}
                placeholder="补充本次巡检的特殊要求，例如：重点关注转人工失败的通话记录……"
                className="mt-2 w-full rounded-lg border border-input bg-card px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-ring min-h-[84px] resize-y" />
              <div className="mt-1 flex justify-between text-xs text-muted-foreground">
                <span>可自定义编辑</span><span>{remarks.length} / 500</span>
              </div>
            </label>
          </div>

          <div className="flex items-center justify-between px-5 py-4 border-t border-border bg-secondary/40">
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <ShieldCheck size={14} />数据仅用于本次巡检分析
            </span>
            <button type="submit" disabled={submitting}
              className="inline-flex items-center gap-2 rounded-lg bg-primary text-primary-foreground px-5 py-2.5 text-sm font-medium hover:opacity-90 disabled:opacity-60">
              {submitting ? <><Loader2 size={15} className="animate-spin" />正在提交...</> : <>提交巡检需求<ArrowRight size={15} /></>}
            </button>
          </div>
        </form>

        {/* 侧栏 */}
        <aside className="space-y-4">
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">提交流程</h3>
              <span className="text-[10px] tracking-wider text-muted-foreground">3 STEPS</span>
            </div>
            <ol className="mt-3 space-y-3">
              {[
                ['填写需求', '完善巡检的基本信息'],
                ['系统制作', '调用对应 skill 自动生成'],
                ['下载报告', '在报告提取中查看结果'],
              ].map(([t, d], i) => (
                <li key={t} className="flex gap-3">
                  <span className="h-6 w-6 shrink-0 rounded-full bg-accent text-accent-foreground text-xs font-semibold flex items-center justify-center">{i + 1}</span>
                  <div><div className="text-sm font-medium leading-tight">{t}</div><div className="text-xs text-muted-foreground mt-0.5">{d}</div></div>
                </li>
              ))}
            </ol>
          </div>
          <div className="rounded-xl border border-border bg-card p-4">
            <h3 className="text-sm font-semibold">执行说明</h3>
            <ul className="mt-2 space-y-1.5 text-xs text-muted-foreground">
              <li>· 语音 SaaS 模板由 saas-xunjian-tongyong 生成 DOCX</li>
              <li>· 报告周期取上传记录的覆盖范围核对后写入</li>
              <li>· 失败任务可在报告提取中一键重试</li>
            </ul>
          </div>
        </aside>
      </div>

      {toast && (
        <div className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 rounded-lg px-4 py-2.5 text-sm text-white shadow-lg
          ${toast.type === 'err' ? 'bg-destructive' : 'bg-foreground'}`}>
          {toast.msg}
        </div>
      )}
    </div>
  )
}
