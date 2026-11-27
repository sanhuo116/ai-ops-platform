// SyNew.jsx —— 私有化规则版话术优化 · 任务提交入口
// 通话记录导入（zip/xlsx/csv/jsonl）+ botId 提交 → 任务执行（阶段+进度实时展示）
import { useState, useRef } from 'react'
import { Upload, Play, Loader2, CheckCircle2, AlertCircle, Phone, Bot, FileArchive } from 'lucide-react'

const STAGES = [
  ['import', '通话记录导入'],
  ['bundle', '话术包导出（CDP）'],
  ['engine', '引擎构建'],
  ['audit', '全量巡检'],
  ['fix', '正则优化回归'],
  ['deliver', '四件套交付'],
]

export default function SyNew() {
  const [file, setFile] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [upload, setUpload] = useState(null)   // {uploadId, calls, turns, name}
  const [botId, setBotId] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [taskId, setTaskId] = useState('')
  const fileRef = useRef(null)

  const pickFile = f => {
    setError('')
    setUpload(null)
    setFile(f)
  }

  const doUpload = async () => {
    if (!file) return
    setUploading(true); setError('')
    try {
      const fd = new FormData()
      fd.append('file', file)
      const r = await fetch('/api/sy/upload', { method: 'POST', body: fd })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || '上传失败')
      // 上传即返回（只落盘原始文件）；解析在任务「通话记录导入」阶段进行，进度见执行结果页
      setUpload({ uploadId: d.uploadId, status: 'received', calls: 0, name: file.name })
    } catch (e) { setError(e.message); setUpload(null) }
    setUploading(false)
  }

  const submit = async () => {
    if (!upload || !botId) return
    setSubmitting(true); setError('')
    try {
      const r = await fetch('/api/sy/tasks', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botId, uploadId: upload.uploadId, uploadName: upload.name }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || '提交失败')
      setTaskId(d.id)
    } catch (e) { setError(e.message) }
    setSubmitting(false)
  }

  return (
    <div className="p-6 lg:p-8 max-w-3xl mx-auto space-y-6">
      <div className="page-header">
        <div className="eyebrow">Private Rule Optimizer</div>
        <h1>私有化规则版话术优化 · 任务提交</h1>
        <p className="sub">上传通话记录（zip/xlsx/jsonl）+ botId：自动完成 话术包导出 → 引擎构建 → 全量巡检 → 正则优化回归 → 四件套交付</p>
      </div>

      {taskId ? (
        <div className="card card-hover p-5 space-y-3">
          <div className="flex items-center gap-2 text-success">
            <CheckCircle2 size={18} />
            <span className="font-medium">任务已创建：{taskId}</span>
          </div>
          <p className="text-sm text-muted-foreground">执行进度请前往「执行结果」查看该任务详情。</p>
          <a href={`#/sy/tasks`} className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground hover:opacity-90">
            前往执行结果 →
          </a>
        </div>
      ) : (
        <>
          {/* 通话记录导入 */}
          <div className="card p-5 space-y-4">
            <div className="flex items-center gap-2 font-medium">
              <Phone size={16} className="text-primary" /> 第一步：通话记录导入
            </div>
            <div
              onClick={() => fileRef.current?.click()}
              className="border-2 border-dashed border-border rounded-xl p-8 text-center cursor-pointer hover:bg-secondary/50 transition"
            >
              <input ref={fileRef} type="file" className="hidden" accept=".zip,.xlsx,.csv,.jsonl"
                onChange={e => pickFile(e.target.files?.[0])} />
              <FileArchive size={28} className="mx-auto text-muted-foreground mb-2" />
              {file ? (
                <div>
                  <div className="text-sm font-medium">{file.name}</div>
                  <div className="text-xs text-muted-foreground mt-1">{(file.size / 1048576).toFixed(1)} MB · 点击可重新选择</div>
                </div>
              ) : (
                <div>
                  <div className="text-sm text-muted-foreground">点击选择文件：zip / xlsx / csv / jsonl</div>
                  <div className="text-xs text-muted-foreground mt-1">百应线索导出格式（含「通话详情」列：AI:/ME: 逐轮）</div>
                </div>
              )}
            </div>
            {file && !upload && (
              <button onClick={doUpload} disabled={uploading}
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50">
                {uploading ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />}
                {uploading ? '解析中（大文件需数分钟）…' : '上传并解析'}
              </button>
            )}
            {upload && (
              <div className="flex items-center gap-2 text-sm text-success">
                <CheckCircle2 size={15} />
                已接收：{upload.name}（{((file?.size || 0) / 1048576).toFixed(1)} MB）· 解析在任务「通话记录导入」阶段执行
              </div>
            )}
          </div>

          {/* botId 提交 */}
          <div className="card p-5 space-y-4">
            <div className="flex items-center gap-2 font-medium">
              <Bot size={16} className="text-primary" /> 第二步：botId 提交
            </div>
            <input value={botId} onChange={e => setBotId(e.target.value.replace(/\D/g, ''))}
              placeholder="如 2927710（规则版话术 bot）"
              className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm mono focus:outline-none focus:ring-2 focus:ring-primary/30" />
            <div className="text-xs text-muted-foreground space-y-1">
              <div>· 话术包导出：优先本机 Chrome（CDP 9222）已登录的 sh.planet.byai.com 页签在线导出；不可用时可用本地夹具（referenceBundle 参数）</div>
              <div>· 正则改动仅产出本地清单与建议，写入平台（updateTree）需另行明确授权</div>
            </div>
            <button onClick={submit} disabled={!upload || !botId || submitting}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
              {submitting ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />}
              开始任务
            </button>
          </div>
        </>
      )}

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive-weak p-4 text-sm text-destructive-strong flex items-start gap-2">
          <AlertCircle size={16} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}
    </div>
  )
}
