import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route, NavLink, Navigate, useLocation } from 'react-router-dom'
import { Wrench, FileStack, LayoutDashboard, KeyRound, MessageSquarePlus, Library, Layers, Inbox, FolderOpen, Package, Upload, FileCheck, ClipboardList, FileBarChart2, ChevronDown, ScanSearch, SlidersHorizontal, Sparkles, ListChecks, ShieldCheck, FileText, Bot, FilePlus2, FlaskConical } from 'lucide-react'
import AoNew from './pages/AoNew.jsx'
import AoTasks, { AoTaskDetail, AoRegression } from './pages/AoTasks.jsx'
import PlanetQr from './pages/PlanetQr.jsx'
import Tasks, { TaskSubmit } from './pages/Tasks.jsx'
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
import ZjNew from './pages/ZjNew.jsx'
import ZjIssues from './pages/ZjIssues.jsx'
import ZjTasks, { ZjTaskDetail } from './pages/ZjTasks.jsx'
import XsNew from './pages/XsNew.jsx'
import XsTasks, { XsTaskDetail } from './pages/XsTasks.jsx'
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
    label: 'Saas规则版话术优化',
    icon: SlidersHorizontal,
    items: [
      { to: '/', label: '任务提交', icon: ClipboardList, end: true },
      { to: '/tasks', label: '任务库', icon: Library },
      { to: '/libs/branch', label: '垒土-分支正则库', icon: Wrench },
      { to: '/libs/question', label: '垒土-问题正则库', icon: FileStack },
    ],
  },
  {
    label: '关键词生成',
    icon: KeyRound,
    items: [
      { to: '/kw/single', label: '单句 · 提交入口', icon: MessageSquarePlus, end: true },
      { to: '/kw/single/tasks', label: '单句 · 任务库', icon: Library },
      { to: '/kw/batch', label: '批量 · 提交入口', icon: Inbox, end: true },
      { to: '/kw/batch/tasks', label: '批量 · 任务库', icon: FolderOpen },
    ],
  },
  {
    label: '相似问泛化',
    icon: Sparkles,
    items: [
      { to: '/xs/new', label: '任务提交', icon: Sparkles, end: true },
      { to: '/xs/tasks', label: '任务清单', icon: ListChecks },
    ],
  },
  {
    label: 'Agent质检',
    icon: ShieldCheck,
    items: [
      { to: '/zj/new', label: '需求提交', icon: FileText, end: true },
      { to: '/zj/issues', label: '质检问题清单', icon: ScanSearch },
      { to: '/zj/tasks', label: '任务库', icon: Library },
    ],
  },
  {
    label: 'Agent自动优化',
    icon: Bot,
    items: [
      { to: '/ao/new', label: '任务提交', icon: FilePlus2, end: true },
      { to: '/ao/tasks', label: '任务库', icon: Library },
      { to: '/ao/regression', label: '质检回归测试', icon: FlaskConical },
    ],
  },
  {
    label: '私有化规则版话术优化',
    icon: Package,
    items: [
      { to: '/sy/new', label: '任务提交', icon: Upload, end: true },
      { to: '/sy/tasks', label: '执行结果', icon: FileCheck },
    ],
  },
]

function Shell({ children }) {
  const location = useLocation()
  // 分组折叠：默认全部展开；点击标题切换
  const [openSet, setOpenSet] = useState(() => {
    const init = {}
    for (const g of navGroups) init[g.label] = true
    return init
  })
  const toggle = label => setOpenSet(prev => ({ ...prev, [label]: !prev[label] }))

  return (
    <div className="flex h-full">
      <aside className="w-56 shrink-0 border-r border-sidebar-border bg-sidebar hidden lg:flex flex-col">
        <div className="flex items-center gap-2.5 px-5 py-[18px] border-b border-sidebar-border">
          <img src="/favicon.svg" alt="logo" className="h-8 w-8 rounded-[10px] shadow-sm" />
          <div className="min-w-0">
            <div className="text-[14px] font-semibold leading-tight tracking-tight">政企部AI运营中心</div>
            <div className="text-[11px] text-muted-foreground truncate">话术质量运营平台</div>
          </div>
        </div>
        <nav className="flex-1 px-3 py-3 space-y-3 overflow-auto">
          {navGroups.map(g => (
            <div key={g.label}>
              {/* 一级分组标题：小字号常显，点击折叠/展开 */}
              <button onClick={() => toggle(g.label)}
                className="group w-full flex items-center gap-1.5 px-3 py-1 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition">
                {g.icon && <g.icon size={12} className="shrink-0" />}
                <span className="flex-1 truncate">{g.label}</span>
                <ChevronDown size={12}
                  className={`shrink-0 opacity-60 transition-transform duration-200 ${openSet[g.label] ? '' : '-rotate-90'}`} />
              </button>
              {/* 二级菜单：可折叠 */}
              {openSet[g.label] && (
                <div className="mt-0.5 ml-[14px] space-y-px border-l border-sidebar-border pl-1.5">
                  {g.items.map(n => (
                    <NavLink key={n.to} to={n.to} end={n.end}
                      className={({ isActive }) => `relative flex items-center gap-2 rounded-lg px-2.5 py-[6px] text-[12.5px] transition
                        ${isActive
                          ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                          : 'text-muted-foreground hover:bg-secondary hover:text-foreground'}`}>
                      {({ isActive }) => (
                        <>
                          {isActive && <span className="absolute -left-[7px] top-1/2 -translate-y-1/2 h-3.5 w-[2px] rounded-full bg-primary" />}
                          <n.icon size={12.5} className="shrink-0" />
                          <span className="truncate">{n.label}</span>
                        </>
                      )}
                    </NavLink>
                  ))}
                </div>
              )}
            </div>
          ))}
        </nav>
        <div className="px-5 py-3 text-[11px] leading-relaxed text-muted-foreground/80 border-t border-sidebar-border">
          <div className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-success inline-block" />
            正则库：租户 67966（公安 SaaS 测试）
          </div>
        </div>
      </aside>
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 border-b border-border bg-card/85 backdrop-blur flex items-center justify-between px-6">
          <div className="text-[13px] text-muted-foreground">政企 AI 外呼 · 话术质量运营</div>
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
        <Route path="/" element={<TaskSubmit />} />
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
        <Route path="/zj/new" element={<ZjNew />} />
        <Route path="/zj/issues" element={<ZjIssues />} />
        <Route path="/zj/tasks" element={<ZjTasks />} />
        <Route path="/zj/tasks/:id" element={<ZjTaskDetail />} />
        <Route path="/xs/new" element={<XsNew />} />
        <Route path="/xs/tasks" element={<XsTasks />} />
        <Route path="/xs/tasks/:id" element={<XsTaskDetail />} />
        <Route path="/ao/new" element={<AoNew />} />
        <Route path="/ao/tasks" element={<AoTasks />} />
        <Route path="/ao/tasks/:id" element={<AoTaskDetail />} />
        <Route path="/ao/regression" element={<AoRegression />} />
        <Route path="/planet/qr" element={<PlanetQr />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  </BrowserRouter>
)
