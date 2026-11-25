import React, { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Loader2, Play, Clock, CheckCircle2, XCircle } from 'lucide-react'

const STAGE_LABEL = { pending: '排队', export: '话术包导出', fetch: '通话取数', audit: '巡检', optimize: '生成待优化库', done: '完成' }
const STATUS_META = {
  queued: { label: '排队中', cls: 'bg-secondary text-secondary-foreground', icon: Clock },
  running: { label: '执行中', cls: 'bg-info-weak text-info-strong', icon: Loader2, spin: true },
  done: { label: '已完成', cls: 'bg-success-weak text-success-strong', icon: CheckCircle2 },
  failed: { label: '重试中', cls: 'bg-info-weak text-info-strong', icon: Loader2, spin: true },
}

export default function Tasks() {
  const [tasks, setTasks] = useState([])
  const [showForm, setShowForm] = useState(false)
  const nav = useNavigate()

  const load = useCallback(async () => {
    const r = await fetch('/api/tasks'); setTasks(await r.json())
  }, [])
  useEffect(() => { load(); const t = setInterval(load, 3000); return () => clearInterval(t) }, [load])

  return (
    <div className="p-6 lg:p-8 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">巡检任务</h1>
          <p className="text-sm text-muted-foreground mt-1">提交 botId，自动完成 话术包导出 → 近一月通话取数 → 巡检 → 待优化库</p>
        </div>
        <button onClick={() => setShowForm(s => !s)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">
          <Plus size={16} /> 新建巡检任务
        </button>
      </div>

      {showForm && <NewTask onDone={() => { setShowForm(false); load() }} />}

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-secondary/50 text-muted-foreground">
            <tr>
              <th className="text-left font-medium px-4 py-2.5">任务</th>
              <th className="text-left font-medium px-4 py-2.5">Bot</th>
              <th className="text-left font-medium px-4 py-2.5">状态</th>
              <th className="text-left font-medium px-4 py-2.5">当前阶段</th>
              <th className="text-left font-medium px-4 py-2.5">待优化库</th>
              <th className="text-left font-medium px-4 py-2.5">创建时间</th>
              <th className="px-4 py-2.5"></th>
            </tr>
          </thead>
          <tbody>
            {tasks.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">暂无任务，点右上角「新建巡检任务」开始</td></tr>
            )}
            {tasks.map(t => {
              const meta = STATUS_META[t.status] || STATUS_META.queued
              return (
                <tr key={t.id} className="border-t border-border hover:bg-secondary/30 cursor-pointer" onClick={() => nav(`/tasks/${t.id}`)}>
                  <td className="px-4 py-3 mono">{t.id}</td>
                  <td className="px-4 py-3">
                    <div className="font-medium">{t.bot_name || `bot ${t.bot_id}`}</div>
                    <div className="text-xs text-muted-foreground mono">{t.bot_id}{t.company_id ? ` · 数据租户 ${t.company_id}` : ''}</div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${meta.cls}`}>
                      <meta.icon size={13} className={meta.spin ? 'animate-spin' : ''} />
                      {meta.label}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-xs">{STAGE_LABEL[t.stage] || t.stage}{t.stage_detail ? ` · ${t.stage_detail.slice(0, 42)}` : ''}</div>
                    {t.status === 'running' && (
                      <div className="mt-1.5 h-1.5 w-40 rounded-full bg-secondary overflow-hidden">
                        <div className="h-full bg-primary transition-all" style={{ width: `${t.progress}%` }} />
                      </div>
                    )}
                    {t.status === 'failed' && <div className="text-xs text-destructive mt-1">{(t.error || '').slice(0, 60)}</div>}
                  </td>
                  <td className="px-4 py-3 font-medium">{t.status === 'done' ? `${t.optCount ?? '—'} 条` : '—'}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground mono">{t.created_at}</td>
                  <td className="px-4 py-3 text-right">
                    {t.status === 'done' && (
                      <button className="text-xs text-accent-foreground hover:underline"
                        onClick={e => { e.stopPropagation(); nav(`/tasks/${t.id}`) }}>查看</button>
                    )}
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

function NewTask({ onDone }) {
  const [botId, setBotId] = useState('')
  const [companyId, setCompanyId] = useState('')
  const [botTenant, setBotTenant] = useState('')
  const [days, setDays] = useState(30)
  const [table, setTable] = useState('outbound')
  const [useSeed, setUseSeed] = useState(false)
  const [minDuration, setMinDuration] = useState(90)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const submit = async e => {
    e.preventDefault()
    setErr('')
    if (!/^\d+$/.test(botId)) { setErr('botId 必须是数字（如 420469）'); return }
    setBusy(true)
    try {
      const payload = { botId, companyId, botTenant, days, table, useSeed, minDuration: table === 'outbound' ? minDuration : 0 }
      const r = await fetch('/api/tasks', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || '创建失败')
      onDone()
    } catch (e2) { setErr(e2.message) } finally { setBusy(false) }
  }

  return (
    <form onSubmit={submit} className="card p-5 space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <label className="block">
          <span className="text-sm font-medium">Bot ID <span className="text-destructive">*</span></span>
          <input value={botId} onChange={e => setBotId(e.target.value)} placeholder="如 420469"
            className="mt-1 w-full rounded-lg border border-input bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
        </label>
        <label className="block">
          <span className="text-sm font-medium">数据租户 company_id</span>
          <input value={companyId} onChange={e => setCompanyId(e.target.value)} placeholder="如 90867（线上取数必填）"
            className="mt-1 w-full rounded-lg border border-input bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
        </label>
        <label className="block">
          <span className="text-sm font-medium">话术租户号（botTenant）</span>
          <input value={botTenant} onChange={e => setBotTenant(e.target.value)} placeholder="8 位数字，如 23190920（话术包导出用，Chrome 已登录可自动识别）"
            className="mt-1 w-full rounded-lg border border-input bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
        </label>
        <label className="block">
          <span className="text-sm font-medium">通话类型</span>
          <select value={table} onChange={e => setTable(e.target.value)}
            className="mt-1 w-full rounded-lg border border-input bg-card px-3 py-2 text-sm">
            <option value="outbound">外呼（dwd_call_call_instance_sh_di）</option>
            <option value="inbound">呼入（byrobotprod_inbound_instance_log_di）</option>
          </select>
        </label>
        <div className="md:col-span-2 text-xs text-muted-foreground rounded-lg bg-secondary/50 px-3 py-2">
          通话记录来源：平台取数（DLC 近 N 天，需数据租户号）。上传方式已移至「私有化话术包直优 · 任务提交入口」。
        </div>
        <label className="block">
          <span className="text-sm font-medium">回看天数</span>
          <input type="number" value={days} min={1} max={90} onChange={e => setDays(e.target.value)}
            className="mt-1 w-full rounded-lg border border-input bg-card px-3 py-2 text-sm" />
        </label>
        {table === 'outbound' && (
          <label className="block">
            <span className="text-sm font-medium">最短通话时长（秒，滤短通）</span>
            <input type="number" value={minDuration} min={0} onChange={e => setMinDuration(e.target.value)}
              className="mt-1 w-full rounded-lg border border-input bg-card px-3 py-2 text-sm" />
          </label>
        )}
        <label className="flex items-center gap-2 md:col-span-2">
          <input type="checkbox" checked={useSeed} onChange={e => setUseSeed(e.target.checked)}
            className="h-4 w-4 rounded border-input" />
          <span className="text-sm">演示模式（使用内置缓存数据，不联网）</span>
        </label>
      </div>
      {err && <div className="rounded-lg bg-destructive-weak text-destructive-strong px-3 py-2 text-sm">{err}</div>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onDone} className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-secondary">取消</button>
        <button disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />} 提交任务
        </button>
      </div>
    </form>
  )
}
