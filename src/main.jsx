import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route, NavLink, Navigate, useLocation } from 'react-router-dom'
import { Bot, Wrench, FileStack, LayoutDashboard, KeyRound, MessageSquarePlus, Library, Layers, Inbox, FolderOpen, Package, Upload, FileCheck, ClipboardList, FileBarChart2, ChevronDown, ScanSearch, SlidersHorizontal } from 'lucide-react'
import Tasks from './pages/Tasks.jsx'
import TaskDetail from './pages/TaskDetail.jsx'
import Libs from './pages/Libs.jsx'
import KwSingle from './pages/KwSingle.jsx'
import KwSingleTasks from './pages/KwSingleTasks.jsx'
import KwSingleDetail from './pages/KwSingleDetail.jsx'
import KwBatch from './pages/KwBatch.jsx'
import KwBatchTasks from './pages/KwBatchTasks.jsx'
import KwBatchDetail from './pages/KwBatchDetail.jsx'
import XjSubmit from './pages/XjSubmit.jsx'
import XjReports from './pages/XjReports.jsx'
import SyNew from './pages/SyNew.jsx'
import SyTasks, { SyTaskDetail } from './pages/SyTasks.jsx'
import './index.css'

// 导航：分组 + 二级菜单
const navGroups = [
  {
    label: '巡检报告中心',
    icon: ScanSearch,
    items: [
      { to: '/xj/submit', label: '需求提交', icon: ClipboardList },
      { to: '/xj/reports', label: '报告提取', icon: FileBarChart2 },
    ],
  },
  {
    label: 'saas巡检优化',
    icon: SlidersHorizontal,
    items: [
      { to: '/', label: '巡检任务', icon: LayoutDashboard, end: true },
      { to: '/libs/branch', label: '分支正则库', icon: Wrench },
      { to: '/libs/question', label: '问题关键词库', icon: FileStack },
    ],
  },
  {
    label: '关键词生成-单句',
    icon: KeyRound,
    items: [
      { to: '/kw/single', label: '提交入口', icon: MessageSquarePlus, end: true },
      { to: '/kw/single/tasks', label: '任务库', icon: Library },
    ],
  },
  {
    label: '关键词生成-批量',
    icon: Layers,
    items: [
      { to: '/kw/batch', label: '提交入口', icon: Inbox, end: true },
      { to: '/kw/batch/tasks', label: '任务库', icon: FolderOpen },
    ],
  },
  {
    label: '私有化话术包直优',
    icon: Package,
    items: [
      { to: '/sy/new', label: '任务提交入口', icon: Upload, end: true },
      { to: '/sy/tasks', label: '执行结果', icon: FileCheck },
    ],
  },
]

// 判断某分组是否包含当前路径（用于默认展开）
function groupHasPath(g, pathname) {
  return g.items.some(n => (n.end ? pathname === n.to : pathname.startsWith(n.to)))
}

function Shell({ children }) {
  // 折叠状态：默认展开包含当前路由的分组；首次渲染以路径初始化
  const [openSet, setOpenSet] = useState(() => {
    const init = {}
    for (const g of navGroups) init[g.label] = groupHasPath(g, window.location.pathname)
    // 若没有任何分组命中（如 404），全展开
    if (!Object.values(init).some(Boolean)) for (const g of navGroups) init[g.label] = true
    return init
  })
  const location = useLocation()
  // 路由变化时自动展开当前分组（其余保持不变）
  React.useEffect(() => {
    setOpenSet(prev => {
      const next = { ...prev }
      for (const g of navGroups) if (groupHasPath(g, location.pathname)) next[g.label] = true
      return next
    })
  }, [location.pathname])
  const toggle = label => setOpenSet(prev => ({ ...prev, [label]: !prev[label] }))

  return (
    <div className="flex h-full">
      <aside className="w-56 shrink-0 border-r border-sidebar-border bg-sidebar hidden lg:flex flex-col">
        <div className="flex items-center gap-2.5 px-5 py-5 border-b border-sidebar-border">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Bot size={18} />
          </div>
          <div>
            <div className="text-[15px] font-semibold leading-tight">政企部AI巡检中心</div>
            <div className="text-xs text-muted-foreground">巡检报告 · 话术优化 · 关键词生成</div>
          </div>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-3 overflow-auto">
          {navGroups.map(g => (
            <div key={g.label}>
              {/* 一级分组：可点击折叠/展开，字体放大加粗 */}
              <button onClick={() => toggle(g.label)}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[15px] font-bold text-foreground hover:opacity-80 transition">
                {g.icon && <g.icon size={15} className="shrink-0" />}
                <span className="flex-1 truncate">{g.label}</span>
                <ChevronDown size={14}
                  className={`shrink-0 text-muted-foreground transition-transform ${openSet[g.label] ? '' : '-rotate-90'}`} />
              </button>
              {/* 二级菜单：折叠动画 + 字体缩小 */}
              {openSet[g.label] && (
                <div className="mt-0.5 space-y-0.5 pl-1">
                  {g.items.map(n => (
                    <NavLink key={n.to} to={n.to} end={n.end}
                      className={({ isActive }) => `flex items-center gap-2 rounded-lg px-3 py-1.5 text-[13px] transition
                        ${isActive ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium' : 'text-muted-foreground hover:bg-secondary hover:text-foreground'}`}>
                      <n.icon size={14} />
                      {n.label}
                    </NavLink>
                  ))}
                </div>
              )}
            </div>
          ))}
        </nav>
        <div className="px-5 py-4 text-xs text-muted-foreground border-t border-sidebar-border">
          <div>正则库来源：租户 67966（公安 SaaS 测试）</div>
          <div className="mt-1">巡检执行：本地 skill 自动生成 DOCX</div>
          <div className="mt-1">流水线：话术包 → 取数 → 巡检 → 待优化库</div>
        </div>
      </aside>
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 border-b border-border bg-card flex items-center justify-between px-6">
          <div className="text-sm text-muted-foreground">政企 AI 外呼 · 话术质量运营</div>
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-success inline-block" />
              服务正常
            </span>
          </div>
        </header>
        <main className="flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <Shell>
      <Routes>
        <Route path="/" element={<Tasks />} />
        <Route path="/xj/submit" element={<XjSubmit />} />
        <Route path="/xj/reports" element={<XjReports />} />
        <Route path="/tasks" element={<Tasks />} />
        <Route path="/tasks/:id" element={<TaskDetail />} />
        <Route path="/libs/:kind" element={<Libs />} />
        <Route path="/kw/single" element={<KwSingle />} />
        <Route path="/kw/single/tasks" element={<KwSingleTasks />} />
        <Route path="/kw/single/tasks/:id" element={<KwSingleDetail />} />
        <Route path="/kw/batch" element={<KwBatch />} />
        <Route path="/kw/batch/tasks" element={<KwBatchTasks />} />
        <Route path="/kw/batch/tasks/:id" element={<KwBatchDetail />} />
        <Route path="/sy/new" element={<SyNew />} />
        <Route path="/sy/tasks" element={<SyTasks />} />
        <Route path="/sy/tasks/:id" element={<SyTaskDetail />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  </BrowserRouter>
)
