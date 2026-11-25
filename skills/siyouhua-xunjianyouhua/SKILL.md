---
name: siyouhua-xunjianyouhua
description: 私有化反诈/劝阻类百应规则版 bot 的全量巡检与 badcase 正则优化一站式流程：根据用户提供的通话记录 zip + bot id，先下载话术包并理解话术（决策树/分支正则/知识库/变量），再对全部通话记录做分支走向巡检（分支命中错误/走默认未命中/知识库未命中/命中错误四类），然后按 guizeyouhua 规范对全量 badcase 做正则优化（候选式设计→V8 全量回归→误翻转=0 门槛→本地包落地→按授权接口同步平台）。产出物：①全量巡检问题表（Excel 多 sheet）②正则改动汇总（分 bot）③巡检报告 + 修改明细。当用户要求"巡检这些 bot 的通话记录并优化 badcase""全量巡检+正则优化""话术包巡检与优化"时使用。
---

# 私有化巡检+正则优化（siyouhua-xunjianyouhua）

从"通话记录 zip + bot id"出发，一站式完成：话术包下载与理解 → 全量通话记录巡检 → 全量 badcase 正则优化 → 平台/本地同步 → 四件套交付。本 skill 是 `huashubao`（话术包破解）与 `guizeyouhua`（巡检与正则优化规范）的**编排层**，执行时两个底层 skill 的规范全部适用（尤其 guizeyouhua 的 `references/regex-style.md` 五步法与三大陷阱）。

## 前置条件与通道

- **通话记录**：用户上传的 zip（百应线索导出格式），解压后为逐通 JSON/JSONL；多 zip 可合并。
- **bot id**：用户提供（如 2927710）。sceneDefId/sceneRecordId 从部署接口拿，不要猜。
- **浏览器通道**：CDP 9222（Chrome 调试端口），需要有已登录的 `sh.planet.byai.com/byplanet/botlab/bot/{id}` 页签。**所有平台交互只走该页签的 fetch（credentials:'include'）**；cos 域名独立直调会 403 没权限。
- **写通道**：`POST /bygw/decision/api/devDecision/updateTree`（payload: `{decisionNodeVO, sceneDefId, sceneNodeId, unrelationDecisionList:[], hasProhibitedWords:0}`）。**未经用户明确授权严禁调用**；只读接口（decisionTree/sceneNode/list/robot/info/...）随时可用。

## 流程总览（6 阶段）

```
① 话术包下载 → ② 话术理解 → ③ 全量巡检 → ④ 正则优化（三轮迭代） → ⑤ 落地同步 → ⑥ 四件套交付
```

### 阶段① 话术包下载

脚本：`scripts/dump_cos_full.mjs`（改 BOTS 映射与输出目录）。

- 节点清单：`/bygw/decision/api/sceneNode/list?decisionType=0&environment={env}&sceneDefId={SD}`
- 决策树：`/bygw/decision/api/devDecision/decisionTree?environment={env}&sceneDefId={SD}&sceneNodeId={nid}&sceneRecordId={SR}`（2934010 类 bot **必须带 sceneRecordId**，否则返回空树；SR 从 `sceneDeploy/info` 拿）
- dev + prod 双环境都拉；全局侧库用 `scripts/dump_sides.mjs`（`/bygw/api/crm/botlab/regex/side/getSideBySideId` + `/keyword/list`）
- 侧库 ID→名称映射在树字段 `answerRegexSide` 里（JSON：`{"肯定":["省厅-肯定（中性）",...]}`），**按名称取库，不要按分支名模糊匹配**（同名库多个，会取错）
- 产出：`bundles/bot_{id}/{raw,raw_prod}/trees/*.json` + scene_node_list/robot_info/variable_list/agent_base_llm/agent_tts/branch_default_keywords/kb_list + manifest

### 阶段② 话术理解

写一份 `话术包破译_{bot}.md`：每个业务节点一句"什么话术 + 检测什么意图 + 分支去向"，标注：
- 树是**多级子树**（decisionNodeBO.childrenList 递归），巡检单元是"树节点"（一句固定话术+分支集），不是顶层 sceneNode
- 分支去向在 `childrenList[].actionParam` 的 `sceneNodeName`；`target=None` = 树内顺序续说（合法，非兜底）
- 语义分支（`labelInfoIds` 非空且 keyword 空）= 平台语义模型，**优先级高于正则**；统计口径里单独归"语义路由接管"
- `acceptBreak=0` 的 bot：用户语音不打断流程，正则巡检不适用（如 2934010），整 bot 跳过④
- 空跳转节点（nodeType=1）靠 jumpMap 补全；nodeType=4 是变量条件节点

### 阶段③ 全量巡检

脚本：`scripts/audit_full.mjs`（v7 口径）。

- 输入：全部通话（版本混合的通排除：≥2 个未定位 AI 轮次的剔除）、flow_tree.json
- 模拟口径：**逐句×分支顺序首中**（先句序后分支序，first-match）；语义分支跳过正则；SYS 句（系统提示音/复读道歉）与 barge-in 语气词（喂/嗯/对 单独成句）不判定
- 判定：命中分支的 target vs 平台实际下一步 → ok / errWrong / errDefault / noBranchHit
- 无判定分支的 step（纯告知话术）与节点内顺序推进不计错
- 产出：`full_correct/full_problems/full_gaps/full_stat.json`（problems=错误样本，gaps=未命中可补样本）

### 阶段④ 全量 badcase 正则优化（核心）

按 guizeyouhua `references/regex-style.md` 五步法，**每条候选式必须过全量回归**：

1. **聚类定位**：把 problems/gaps 按 (bot, node, path, actual) 合并成簇（同簇同修），按规模排序，挑正则可修簇（排除语义接管/多意图/acceptBreak=0）
2. **候选式设计**（学库内范本）：
   - 否定词族 lookbehind `(?<![没不么无否未木…].{0,N})`、限量间隔、后向排除 `(?!.{0,N}…)`、柔性分隔
   - **树方言铁律**：树内 keyword 按**半角逗号分元素** → 正则里禁半角逗号；量词写 `{0<>N}`；字符类内的逗号删掉（全角，可保留）。side 库无此限制（用 `{0,N}`）
   - 短句补式必须锚定 `^...$`；疑问/澄清式必须带疑问尾或疑问核心（防误抓陈述句）
   - 多意图段（「有，但是我没理他」）正则结构性不可修——补式**不得抢 leading 肯定**
3. **回归验证**（`scripts/reg_firstmatch_sim.mjs` 改造）：三语料 A/B
   - pos=抽样正确走向段（必须保持）：**误翻转 ≠ 0 一票否决**
   - neg=错误段（`next||actual`）：统计修复/破坏；破坏逐例核验，「默认重问→具体追问」为改善型改道可接受
   - gap=未命中段：统计增益
   - 作用域实验必做：同一式在不同节点语义不同（确认节点「好的/是的」是肯定证据 → R2 类收尾式必须从确认节点撤出）
4. **迭代否决**：回归不过就收窄作用域/删词/加守卫，宁缺毋滥；数据不支持的词（如裸「哪位」）坚决删
5. **落地**：本地包 keyword + answerKeywordDef **双字段同写**（平台冗余存储，漏一个回读不一致）；每轮改动前备份 `backup_before_optimize_vN/`（manifest 记 src+sha1，**同 nid 多环境文件名要带环境后缀**，否则覆盖）
6. **平台同步**（须授权）：`scripts/platform_tree_write.mjs`（单点）+ field2（akd 补刀）改造为批处理；GET 备份 → 元素级替换/追加 → POST → 回读**元素级**比对（子串 contains 会因 JSON 转义误报）；平台历史残留（akd 里的旧式）也要清，与本地包对齐

### 阶段⑤ 交付物（四件套）

1. **全量巡检问题表** `黔南{项目}bot话术巡检_正则优化_全量.xlsx`：按错误类型多 sheet（分支命中错误/走默认未命中/知识库未命中/知识库命中错误/优化方案汇总/巡检总览），脚本 `scripts/build_excel.py`
2. **正则改动汇总（分bot）**：Excel（4 sheet：改动总览/每 bot 明细/全局侧库）+ 可选云表格；每条含完整新旧式、动作（替换/追加）、回归效果
3. **巡检报告**（云文档）：巡检总览表、优化方案汇总表、正则明细、剩余不可修问题（语义接管/多意图）、修改文件清单
4. **修改明细**（云文档）：文件级修改对照表、备份体系与回滚路径、平台写入状态、验证口径

飞书交付：`lark-cli docs +create --doc-format markdown`（表格用 GFM）、`drive +import --type sheet`（xlsx→云表格）、`im +messages-send --as user --file`（原文件，需 `im:resource` scope；`im:resource:upload` 可能被平台禁用，发消息用前者即可）。收件人 open_id 可从群 `+chat-members-list` 找（`contact:+search-user` 常缺 scope）。

## 已验证的教训（必读）

| # | 教训 | 处理 |
|---|---|---|
| 1 | 树 keyword 半角逗号分元素，正则含逗号会被拆碎（N2 `.{0,8}` 曾拆成 2 个非法碎片） | 树方言 `{0<>N}`、类内删逗号；写入后做**元素级**核验 |
| 2 | Python re 编译不了变长 lookbehind | 所有行为测试用 V8/Node |
| 3 | `answerRegexSide` 同名库多个，按分支名模糊匹配会取错库 | 只按 answerRegexSide 声明的具名库取 |
| 4 | 语义分支优先级高于正则（语义路由接管 8,159 段） | 统计口径单列，不做正则修复 |
| 5 | 确认节点「好的/是的」是肯定证据，收尾式进去会误翻转 19 例 | 式的作用域按节点拆分 |
| 6 | 回读用子串 contains 因 `\\s` JSON 转义误报 | 元素级比对（split(',') 后 ==） |
| 7 | 备份同名文件覆盖（raw 与 raw_prod 同 nid） | manifest 记 sha1，文件名带环境后缀 |
| 8 | 平台 answerKeywordDef 与 keyword 冗余双存 | 双字段同写，回读双验 |
| 9 | updateTree 回读树里可能残留历史旧式（akd 深层/root 级） | 全树递归清残留，与本地对齐后终验 |
| 10 | 2934010 类 bot 不带 sceneRecordId 拉树为空 | 部署接口先取 SR |

## 快速启动（agent 执行清单）

```bash
# ① 解压通话记录 + 导出话术包（改脚本内 BOTS/OUT）
node scripts/dump_cos_full.mjs
node scripts/dump_sides.mjs
# ② 建引擎配置 flow_tree.json（bots→steps+edges，lib=侧库，jumpMap，acceptBreak）
# ③ 全量巡检
node --max-old-space-size=4096 scripts/audit_full.mjs
# ④ 候选式回归（改造 reg_firstmatch_sim.mjs 的 news/ADDS/SCOPE）
node --max-old-space-size=4096 scripts/reg_firstmatch_sim.mjs
# ⑤ 本地包写入 + 备份 + flow_tree 同步（元素级、双字段、树方言）
# ⑥ 平台同步（须授权）+ 回读元素级终验
# ⑦ build_excel.py 出问题表 + 生成汇总 xlsx + lark-cli 四件套交付
```
