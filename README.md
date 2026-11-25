# 政企部AI巡检中心（话术正则优化平台）

提交一个百应 botId，平台自动执行完整流水线：

```
话术包导出(huashubao口径) → 通话记录（平台取数 / 用户上传，二选一） → 巡检(guizeyouhua口径) → 待优化库
```

待优化库三要素：**问题问句 · 原正则 · 优化后正则**（附动作/证据/句次）。

## 通话记录来源（二选一）

| 来源 | 说明 |
|---|---|
| **平台取数** | DLC 只读查询近 N 天通话（外呼/呼入表），需数据租户号与钥匙串凭据 |
| **上传通话记录** | 新建任务表单选择「上传通话记录」，支持 `.xlsx/.csv/.jsonl`：百应后台导出（一通一行，"通话记录id"+"通话记录"列，行内 `AI：…/用户：…`）、DLC 逐轮导出（speaker_type/content 列）、calls jsonl 均可 |

上传接口：`POST /api/upload-calls`（multipart，返回 `{uploadId, calls, turns}` 预检结果）→
`POST /api/tasks/with-upload`（带 uploadId 建任务）。上传任务自动跳过 DLC 取数阶段，
任务详情页显示「上传通话：文件名」来源徽标。

## 巡检报告中心（政企部AI巡检中心 · 已迁移）

来自 codex 平台的「政企部项目自动化巡检」已并入本平台，作为一级入口：

| 路径 | 内容 |
|---|---|
| `/xj/submit`（默认首页） | **需求提交**：业务场景（文本 / 语音-SaaS / 语音-私有化）→ 巡检模板联动 → 租户与报告周期 → 拖拽上传通话记录（xlsx/csv/txt/zip，≤200MB）→ 备注 |
| `/xj/reports` | **报告提取**：状态卡片（全部/制作中/成功/失败）、搜索筛选、制作中任务每 6 秒自动刷新、下载 DOCX、失败一键重试 |

### 执行链路

提交后服务端直接调用本地已安装的 skill 生成报告（数据严格按次隔离，不做跨任务融合）：

| 模板 | skill | 状态 |
|---|---|---|
| 通用模板（语音 SaaS） | `saas-xunjian-tongyong` → generate_report.py | ✅ 已接入 |
| 杭州社保（文本） | `hangzhoushebao-report` | ⏳ 执行器接入中 |
| 文本项目通用模板 | `chatbot-xjbg` | ⏳ 执行器接入中 |
| 余杭社保（语音私有化） | `yuhangshebao-report` | ⏳ 执行器接入中 |

产物落盘 `data/xj-reports/output/<租户>巡检报告_<id>.docx`，执行日志在 `data/xj-reports/runs/<id>/runner.log`。

### API

| 接口 | 说明 |
|---|---|
| `POST /api/xj/requests` | multipart 提交：`payload`（JSON 字符串：tenant/templateId/periodStart/periodEnd/remarks…）+ `files`（多个） |
| `GET /api/xj/requests` | 列表 + 状态计数 |
| `GET /api/xj/requests/:id` | 单条详情 |
| `POST /api/xj/requests/:id/retry` | 失败重试 |
| `GET /api/xj/requests/:id/download` | 下载 DOCX |
| `GET /api/xj/requests/:id/log` | 执行日志 |
| `GET /api/xj/templates` | 模板目录与接入状态 |

服务重启时，中断的 processing 请求自动标记为 failed，可在页面重试。

## 启动

```bash
npm install       # 首次
npm run build     # 构建前端（产物在 dist/）
npm start         # 启动服务 http://localhost:8787
```

开发模式（前端热更）：`npm run dev`（5174 端口，/api 代理到 8787）。

## 页面

| 路径 | 内容 |
|---|---|
| `/` | 巡检任务：新建任务（botId/租户/天数/通话类型/演示模式）、进度、KPI、报告 |
| `/tasks/:id` | 任务详情：走向正确率、分支判定分布、知识库巡检、**待优化库列表**、CSV 导出 |
| `/libs/branch` | **正则库**：67966（公安 SaaS 测试租户）全局分支库 327 组 / 2421 条正则 |
| `/libs/question` | **问题库**：67966 问题库 128 组 / 1012 条正则 |
| `/kw/single` | **关键词生成-单句 · 提交入口**：一句问句 → 15 泛化 + 10 规避 + 三段式正则，可编辑后重跑 |
| `/kw/single/tasks` | **关键词生成-单句 · 任务库**：历史任务与验证结果 |
| `/kw/single/tasks/:id` | 单句任务详情：正则/列表编辑、逐条命中明细、重跑验证 |
| `/kw/batch` | **关键词生成-批量 · 提交入口**：粘贴或上传问句清单，仅展示进度与状态 |
| `/kw/batch/tasks` | **关键词生成-批量 · 任务库**：批次历史 |
| `/kw/batch/tasks/:id` | 批次详情：每条问句的进度与验证结果 |
| `/sy/new` | **私有化话术包直优 · 任务提交入口**：通话记录导入（zip/xlsx/csv/jsonl，后台流式解析）+ botId 提交 |
| `/sy/tasks` | **私有化话术包直优 · 执行结果**：六阶段进度（导入→话术包导出→引擎构建→全量巡检→正则优化回归→四件套交付）、KPI、四件套下载 |

## 私有化话术包直优（siyouhua-xunjianyouhua）

面向私有化部署 bot 的「通话记录 zip + botId」一站式巡检与正则优化（参考任务：黔南规则版优化）。六阶段流水线：

1. **通话记录导入**：百应线索导出 zip/xlsx（`通话详情` 列 AI:/ME: 逐轮）流式 SAX 解析，支持 30 万+ 通
2. **话术包导出**：CDP 9222 已登录 `sh.planet.byai.com` 页签抓取（sceneDeploy → sceneNode/list → devDecision/decisionTree dev+prod 双环境 + answerRegexSide 具名侧库）；CDP 不可用时可用本地夹具 `referenceBundle`（cos 后台导出 zip）回退
3. **引擎构建**：decisionNodeBO 递归解析 → 巡检单元（一句固定话术+分支集），树方言 `{0<>N}`、语义分支（labelInfoIds 优先）、acceptBreak=0 节点整节点跳过
4. **全量巡检**（v7 口径）：逐句×分支顺序首中；版本混合通话整通剔除；SYS 句/barge-in 语气词不判定；ok/okDefault/okSemantic/errWrong/errDefault/noBranchHit 六桶
5. **正则优化**：badcase 聚类 → 候选式设计（学库内范本：否定环视族/限量间隔/后向排除，树方言输出）→ 三语料回归（pos 误翻转=0 一票否决 / neg 修复>破坏 / gap 增益>0）→ 同式跨簇去重
6. **四件套交付**：①全量巡检问题表 xlsx（分支命中错误/走默认未命中/可补样本/优化方案汇总/巡检总览）②正则改动汇总 xlsx（分 bot：改动总览/每 bot 明细/验证口径）③巡检报告 md ④修改明细 md

**验收（黔南 bot 2927710，284,598 通）**：可判定 475,919 段，正确率 84.0%，问题簇 437 个，候选式 88 条回归后采纳 5 条（误翻全 0），四件套齐全。写入平台（updateTree）须用户明确授权，任务仅产出本地清单。

## 关键词生成（单句 / 批量）

把一句用户问句沉淀成「15 条泛化问句 + 10 条规避案例 + 三段式正则」，交付标准：**泛化 15/15 命中、规避 10/10 不命中**（本地逐条验证）。方法沉淀见技能 `zhengze-shengcheng`（`~/.agents/skills/zhengze-shengcheng/`）。

架构：**LLM 只做语义**（意图/泛化列表/规避列表/词元），**正则由引擎确定性组装**（左环视规避 + 核心词 + 右环视规避，风格对齐 `(?<!(没|不|现))在[呢呀啊的](?!.{0,8}[哪没])`），变体搜索 + 自动修复轮保证验证通过；LLM 不可用时走本地兜底（同管线，来源标记 fallback）。

LLM 配置：provider `byai`，baseURL `https://model.indata.cc/v1`，模型 `deepseek-v4.1-flash`；凭据链 = 环境变量 `BYAI_API_KEY` → 钥匙串 `dsh-llm/BYAI_API_KEY`（密钥不落代码不进日志）。

| 接口 | 说明 |
|---|---|
| `POST /api/kw/tasks` | 单句提交 `{question}`，异步生成 |
| `GET /api/kw/tasks?mode=single&q=` | 任务库列表 |
| `GET /api/kw/tasks/:id` | 任务详情（含 verified 逐条结果） |
| `POST /api/kw/tasks/:id/rerun` | 重跑：带 `{general,negatives,regex}` 按编辑重验；空 body 全量重新生成 |
| `DELETE /api/kw/tasks/:id` | 删除任务 |
| `POST /api/kw/batches` | 批量导入：multipart 文件（.txt/.csv/.xlsx/.jsonl，每行一条）或 `{questions:[...]}`；≤200 条自动串行执行 |
| `GET /api/kw/batches` / `GET /api/kw/batches/:id` | 批次列表 / 详情（含子任务进度） |
| `POST /api/kw/batches/:id/retry-failed` | 重试批次失败项（自动排查换策略，直到收敛才交付） |
| `GET /api/kw/batches/:id/export` | 导出批次结果 xlsx（批次汇总 + 逐条验证明细双表） |

相关模块：`server/gen.mjs`（生成+验证+修复引擎）、`server/llm.mjs`（LLM 适配：超时重试/思考泄漏对策/parseJSONLoose）、`server/kwrunner.mjs`（串行执行器）、`server/qfile.mjs`（问句文件解析）、`server/store.mjs`（kw_tasks/kw_batches 表）。

## 流水线四阶段

1. **话术包导出**：经本机 Chrome（CDP 9222）打开 `https://{botTenant}.cos.byai.com/voice-bot/bot-gui/{bot}/flow/dev`
   （编辑端 iframe 无验证码），抓 `x-bind-token` 后拉取 决策树(主流程+多轮) / 知识库(必须带 categoryIds=1,2,3) / 变量 / TTS 等全量配置。
   要求：本机 Chrome 以调试端口启动并已登录百应后台。
2. **通话取数**：DLC 只读查询（腾讯云凭据取自本机钥匙串，由 data-sanhuo 技能脚本执行）：
   - 外呼 `byai_bigdata.dwd_call_call_instance_sh_di`（一通一行，content 数组）
   - 呼入 `byai_bigdata.dwd_call_byrobotprod_inbound_instance_log_di`（一行一轮，按 `inbound_instance_log_id` 排序，关联实例表补属性）
   - 凭据未录入时任务会明确提示录入命令（不会静默返回空数据）
3. **巡检**（决策树口径）：
   - AI 话术与话术包原文**精确匹配**定位 step（规则版话术写死），真实定位率 ~94%
   - 用户回复跑当前 step 各分支正则 → 命中分支去向 vs AI 下一句实际位置
   - 排除三类正常行为：无判定分支的告知话术、节点内顺序推进、开场白纯接听
   - 百应正则方言：`{0<>N}`→`{0,N}`；变长 lookbehind 由 V8 编译
4. **待优化库**（宁缺毋滥，全部带证据与参考正则，**无纯复核行**——最终由业务复核采纳）：
   - `add` 补词：高频漏判句 → 核心词提取 → 锚定正则 → **回测命中率 ≥40% 才入选**；纯语气词占比 >55% 的组不补
   - `add` 默认分支兜底：纯语气应答被线上过宽规则导航走 → 给默认分支补「语气兜底正则」（双向回测：节点语料守准率 + 本组抓取率）
   - `remove` 弱肯定/纯语气肇事规则：定位到具体规则（如 `^嗯。$`）→ 建议移除并给实义肯定替换写法
   - `modify` 走错定位：宽通配肇事正则给收窄写法；知识库未按意图走给知识点参考正则（本组样本 + 节点语料双向回测）
   - `add` 问题库新增正则：框架外意图（什么/哪位/怎么了…知识库无一匹配）
   - 知识库死条目：按标准问法生成锚定参考正则使其可命中

## 正则库与巡检的关系

巡检取词优先级（与 guizeyouhua 技能一致）：

```
节点本地正则(answerKeywordDef) 有 → 用本地（并叠加 regex_side）
本地无 → 按 answerRegexSide 具名分支逐个取正则库
正则库也无 → 才按分支名退化取同名组
```

平台内置的 67966 正则库与实战巡检所用全局分支库**完全一致**（301 组交集全等，已校验），
同名分组被合并展示，但巡检内部仍按具名分支精确取词。

## 数据来源说明

- 种子正则库/问题库：`work/byai-branch/`（2026-11 抓取的全量，companyId=67966）
- 演示任务通话：`work/byai-calls/dialogue_turns.jsonl` 中 bot 420469（宜昌劝阻-投资理财）的 8000 通
- 演示任务话术包：`work/byai-scripts/bot_420469_bundle.json`

## 已知边界

- `spagent.indata.cc:5173` 参考后台有飞书登录墙，本平台 UI 按其设计规范仿建
  （主色 #2563eb / 底色 #f8fafc / 白卡片 / 侧边栏 / shadcn 风格圆角与徽标）。
- 线上模式需要：Chrome(CDP 9222) 登录百应后台 + 钥匙串 DLC 凭据 + 数据租户 company_id + 话术租户号 botTenant。
- 节点命中轨迹依赖 AI 话术反推（通话记录无节点轨迹字段），系统提示音已排除。
