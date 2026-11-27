import { apiFetch } from '../platform.js'
// PlanetQr.jsx —— 星球扫码验证（飞书 SSO 二维码页面内展示）
// 复刻星球登录页机制：LarkSSOSDKWebQRCode 渲染二维码 → 扫码后 passport 回调本平台
// /planet/qr/callback?code=xxx → 后端代理换 cookie 写入星球 CLI 会话 → 页面轮询状态自动确认
import React, { useEffect, useRef, useState } from 'react'
import { ShieldCheck, Loader2, CheckCircle2, XCircle, RefreshCw } from 'lucide-react'

const QR_SDK = 'https://lf-package-cn.feishucdn.com/obj/feishu-static/lark/passport/qrcode/LarkSSOSDKWebQRCode-1.0.3.js'

function loadSdk() {
  return new Promise((resolve, reject) => {
    if (window.QRLogin) return resolve()
    const s = document.createElement('script')
    s.src = QR_SDK
    s.onload = resolve
    s.onerror = () => reject(new Error('飞书二维码 SDK 加载失败'))
    document.head.appendChild(s)
  })
}

export default function PlanetQr() {
  const boxRef = useRef(null)
  const qrRef = useRef(null)
  const [phase, setPhase] = useState('loading') // loading | needscan | checking | ok | error
  const [msg, setMsg] = useState('')
  const [cfg, setCfg] = useState(null)

  // 会话状态探测 + 轮询（扫码成功后 status.valid 变 true 即完成）
  useEffect(() => {
    let stop = false
    const poll = async () => {
      try {
        const r = await apiFetch('/api/planet/qr/status')
        const d = await r.json()
        if (stop) return
        if (d.valid) { setPhase('ok'); return true }
        setPhase(d.auth_required ? 'needscan' : 'error')
        setMsg(d.detail || '会话无效')
      } catch { }
      return false
    }
    poll().then(done => {
      if (done) return
      const t = setInterval(async () => { if (await poll()) clearInterval(t) }, 3000)
    })
    return () => { stop = true }
  }, [])

  // 渲染飞书二维码（与星球登录页同款 SDK/参数）
  useEffect(() => {
    if (phase !== 'needscan' || !cfg) return
    let cancelled = false
    loadSdk().then(() => {
      if (cancelled || !boxRef.current) return
      boxRef.current.innerHTML = ''
      qrRef.current = window.QRLogin({
        id: 'planet-qr-box',
        goto: cfg.authorizeUrl,
        width: 260,
        height: 260,
        style: 'display:inline-block;margin:0 auto;border:none',
      })
    }).catch(e => { setPhase('error'); setMsg(String(e.message || e)) })
    return () => { cancelled = true }
  }, [phase, cfg])

  // 拿回调地址（后端按当前 host 生成）
  useEffect(() => {
    apiFetch('/api/planet/qr/start').then(r => r.json()).then(d => {
      if (!d.error) setCfg(d)
      else { setPhase('error'); setMsg(d.error) }
    }).catch(() => { })
  }, [])

  const redo = () => {
    setPhase('loading'); setMsg('')
    // 强制重探测 + 重新渲染二维码
    apiFetch('/api/planet/qr/status').then(r => r.json()).then(d => {
      if (d.valid) setPhase('ok')
      else { setPhase('needscan'); setMsg(d.detail || '') }
      // 重渲染二维码
      if (boxRef.current && window.QRLogin && cfg) {
        boxRef.current.innerHTML = ''
        qrRef.current = window.QRLogin({ id: 'planet-qr-box', goto: cfg.authorizeUrl, width: 260, height: 260, style: 'display:inline-block;margin:0 auto;border:none' })
      }
    }).catch(() => setPhase('needscan'))
  }

  return (
    <div className="p-6 max-w-md mx-auto">
      <div className="card p-6 text-center space-y-4">
        <div className="flex items-center justify-center gap-2">
          <ShieldCheck className="w-5 h-5 text-blue-600" />
          <h1 className="text-base font-bold">星球扫码验证</h1>
        </div>

        {phase === 'loading' && <div className="py-10 text-slate-400 text-sm flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />正在检测会话状态…</div>}

        {phase === 'ok' && (
          <div className="py-8 space-y-2">
            <CheckCircle2 className="w-12 h-12 text-emerald-500 mx-auto" />
            <div className="font-semibold">会话有效，无需验证</div>
            <div className="text-xs text-slate-400">星球 CLI 已登录，Agent自动优化/质检可直接执行</div>
          </div>
        )}

        {phase === 'error' && (
          <div className="py-8 space-y-2">
            <XCircle className="w-12 h-12 text-red-500 mx-auto" />
            <div className="font-semibold">状态检测异常</div>
            <div className="text-xs text-slate-400">{msg}</div>
            <button onClick={redo} className="btn-ghost text-sm inline-flex items-center gap-1"><RefreshCw className="w-3.5 h-3.5" />重试</button>
          </div>
        )}

        {phase === 'needscan' && (
          <>
            {msg && <div className="text-xs text-amber-600 bg-amber-50 rounded px-3 py-2">{msg}</div>}
            {/* 飞书二维码容器（QRLogin SDK 渲染 iframe） */}
            <div id="planet-qr-box" ref={boxRef} className="flex justify-center py-2 min-h-[260px]" />
            <div className="text-xs text-slate-500 space-y-1">
              <div>请使用<b>飞书 App</b> 扫码，确认后本页面会自动完成验证</div>
              <div className="text-slate-400">扫码成功后会话写入本机星球 CLI（~/.local/share/byai-planet-cli），任务自动继续</div>
            </div>
            <button onClick={redo} className="btn-ghost text-xs inline-flex items-center gap-1"><RefreshCw className="w-3 h-3" />刷新二维码</button>
            {/* 兜底：若平台回调域名不在星球飞书应用白名单（扫码确认后飞书拒绝跳转），手动粘贴星球登录页回调链接完成兑换 */}
            <ManualExchange />
          </>
        )}
      </div>
    </div>
  )
}

// 手动兑换：粘贴星球登录页的回调链接（…/login-loading?code=xxx 或平台回调 ?code=xxx）
function ManualExchange() {
  const [txt, setTxt] = useState('')
  const [st, setSt] = useState('')
  const submit = async () => {
    setSt('')
    const m = String(txt).match(/[?&]code=([A-Za-z0-9._-]+)/)
    if (!m) return setSt('✗ 链接中未找到 code 参数')
    try {
      // 走回调页同款兑换逻辑
      const r = await apiFetch(`/api/planet/qr/exchange?code=${encodeURIComponent(m[1])}`)
      const d = await r.json()
      if (d.error) throw new Error(d.error)
      if (d.ok) setSt(`✓ 验证成功（${d.name || d.userId || ''}），会话已写入`)
      else setSt('✗ ' + (d.message || '兑换失败'))
    } catch (e) { setSt('✗ ' + String(e.message || e)) }
  }
  return (
    <details className="text-left">
      <summary className="text-[11px] text-slate-400 cursor-pointer hover:text-slate-600">扫码后没有自动跳转？手动粘贴回调链接 →</summary>
      <div className="mt-2 space-y-2">
        <textarea className="input w-full text-xs" rows={2} placeholder="粘贴浏览器地址栏中含 code= 的完整链接" value={txt} onChange={e => setTxt(e.target.value)} />
        <div className="flex items-center gap-2">
          <button className="btn-primary text-xs" onClick={submit}>提交兑换</button>
          {st && <span className={`text-xs ${st.startsWith('✓') ? 'text-emerald-600' : 'text-red-600'}`}>{st}</span>}
        </div>
      </div>
    </details>
  )
}
