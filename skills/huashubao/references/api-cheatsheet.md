# 百应 bygw 接口速查表（huashubao）

Base：`https://{tenantId}.cos.byai.com/bygw`
tenantId 为 8 位数字，随租户不同而不同（如 98269720、33023910）。

## 鉴权（全部接口必带）

```
x-bind-token: crm_pc_bind_token_{32位hex}     # 会话级，失效后从编辑器页面真实请求重抓
x-bind-robot: 7_{botDefId}
Cookie: INDATA-SESSIONID=...; JSESSIONID=...; __byuuid=...
Accept: application/json
```

- 缺 token → `{"code":404,"resultMsg":"用户不存在或者重新登录"}`
- token 错误（如页面裸 fetch 不带头）→ `{"code":400,"message":"用户未登录"}`
- 获取方式：CDP 打开 `https://{tenant}.cos.byai.com/voice-bot/bot-gui/{bot}/flow/dev?...&hidelayout=true`（无验证码），抓任意 `/bygw/` 请求头

## 一、机器人与全局配置

| 接口 | 说明 |
|---|---|
| `GET /decision/api/robot/info?robotDefId={bot}` | 机器人基础信息（名称/类型/挂机参数/断句词等） |
| `GET /decision/api/sceneDeploy/info?robotDefId={bot}` | 场景部署信息，含 **sceneDefId**、sceneRecordId 线索、审核时间 |
| `GET /decision/api/agent/info?anchors=base%2Cllm&environment=dev&robotDefId={bot}` | Agent 基础 + LLM 参数（temperature/maxToken/rounds/vad…） |
| `GET /decision/api/agent/info?anchors=tts&environment=dev&robotDefId={bot}` | TTS 音色/语速/音量/AB 实验组 |
| `GET /decision/api/robot/getVisibleTTSConfig?robotDefId={bot}` | TTS 全局配置 |
| `GET /decision/api/sceneNode/list?decisionType=0&environment=dev&sceneDefId={sd}` | **全部子流程清单**（每项一棵决策树） |
| `GET /decision/api/scene/variable/list?environment=dev&robotDefId={bot}` | 变量槽位（isSystem==0 为自定义） |
| `GET /decision/api/devDecision/getBranchDefaultKeywords` | 默认意图词（肯定/否定/拒绝） |
| `GET /decision/api/robot/getDevResultList?environment=dev&sceneDefId={sd}` | 通话后分析结果标签 |
| `GET /decision/api/crm/botlab/entity/listForRobotDefId?robotDefId={bot}` | 实体类型 |
| `GET /decision/api/crm/botlab/scene/getByRobotId?robotDefId={bot}` | 所属场景（botSceneId/nlpType/公司） |
| `GET /decision/api/agent/verify_config/info?robotDefId={bot}` | 核验配置 |
| `GET /decision/api/responseType/list?environment=dev&robotDefId={bot}` | 响应类型 |

## 二、决策树

```
GET /decision/api/devDecision/decisionTree?environment=dev&sceneDefId={sd}&sceneNodeId={nid}&sceneRecordId={sr}
```

- sceneNodeId 来自 sceneNode/list，每个都是一棵树
- sceneRecordId 可从编辑器抓包 URL 或 sceneDeploy/info 获得
- 返回 `data.decisionNodeBO`（根节点，childrenList 递归）
- 关键节点字段：
  - `decisionItemList[].knowledge` — 播报话术
  - `keyword` — 跳转关键词（逗号分隔的正则）
  - `answerKeywordDef` — JSON 字符串，本地分支正则 `{"肯定":[...],"否定":[...]}`
  - `answerRegexSide` — JSON 字符串，**外部正则集引用** `{"肯定":["集名",...]}`（只存名称！）
  - `answerSimilarDef` — 相似问正则
  - `childrenAnswerIds` vs `childrenList` — 长度差 = 声明了但未配置的分支
  - `nodeType`：0=普通节点，1=跳转节点；`action`：2=播报等答，3=跳转，1=挂机类

## 三、知识库

```
GET /decision/api/knowledgeBase/list?categoryIds=1%2C2%2C3&environment=dev&robotDefId={bot}
GET /decision/api/knowledgeBase/info?environment=dev&knowledgeBaseId={id}&robotDefId={bot}   # 单条详情
```

- **不带 `categoryIds` 必返回 `code:500 未知错误`**（不是 404）
- 缺鉴权头 → `code:400 用户未登录`
- 字段：standardQuestion / similarQuestionList / knowledgeBaseAnswerList[].answer / keyword（命中正则）/ knowledgeType（1 标准问答、0 自定义问法、3 短语）/ sceneNodeId（null=全局）
- 相似问单条可达 51 条，**导出时不要截断**

## 四、外部正则系统（全局分支库）

前缀：`/api/crm/botlab/regex/`（注意是 `/api/` 不是 `/decision/api/`）

### 分支库（side）— 完整 30 个接口

```
side/list                    # 列表，?pageNum=&pageSize=&name=（按本租户过滤）
side/getSideBySideId         # ?botSideId=  → 详情+keywordList（跨租户可读）
side/keyword/list            # ?botSideId=&pageNum=&pageSize=1000 → 全部正则
side/botReference            # ?botSideId= → 引用该集的 bot 列表（重名集判定）
side/sceneReference          # ?botSideId= → 引用该集的场景列表
side/listHistory             # 历史版本
side/getSideAudit            # 审核信息
side/add / addBatch / edit / delete / batchDelete / apply / batchApply / audit
side/importToScene           # 导入到场景
side/exportRegSideTemplate   # 导出模板
side/fail/reason             # 失败原因
side/test/case / test/list / test/batch / test/result/list / scene/test / sceneTestResult
side/case/add / case/addBatch / case/edit / case/delete / case/list / case/test/result/list
```

### 问题库（question）— 同构 30 个

```
question/list / getQuestionByQuestionId / keyword/list / botReference / sceneReference / ...
```

### 取用链路

```
树节点 answerRegexSide → 集名称
→ side/list?name={名称}        （本租户库）
→ getSideBySideId?botSideId=   （跨租户共享库，用已知 id）
→ keyword/list?botSideId=      （全部正则）
→ botReference/sceneReference  （重名集判定实际绑定）
```

**坑**：
1. 不同租户同名集并存（如 `肯定(中性)` 有 id 110 和 376），按名称匹配会取错，必须用引用接口判定
2. `botReference` 对部分集返回 500"未知错误"（大集慢），超时换 `sceneReference`（返回场景名，可与 `scene/getByRobotId` 的 name 对照）
3. 集所属 `companyId` 与本租户不同也属正常（跨租户共享），但要如实记录

## 五、其他已探明接口

| 接口 | 说明 |
|---|---|
| `GET /api/accountInfo/get` | 当前账号（验证登录态） |
| `GET /api/task/getCompanyInfo` | 租户信息 |
| `GET /decision/api/robot/list?pageNum=1&pageSize=50` | **本租户 bot 清单（租户归属校验用）** |
| `GET /api/boss/robot/copy/differ?robotDefId={id}` | 复制差异预览（field/path/pathNum） |
| `POST /decision/api/robot/copy?sourceRobotDefId=&robotType=&newRobotName=&environment=dev&isCustomizeScene=true` | **复制 bot（参数走 query！）**，返回 `data=新botId`，异步执行约 30-90 秒 |
| `POST /decision/api/robot/delete`（JSON body `{"robotDefId":id}`） | 删除 bot（清理测试副本用） |
| `GET /decision/api/crm/botlab/prohibitedwords/getByIndustryTwoId?industryTwoId={id}` | 行业禁语 |
| `GET /decision/api/record/list?pageNum=1&pageSize=20&robotId={bot}` | 调试通话记录 |
| `GET /datacenter/speech/decisions/statistics?...&nodeId={nid}&sceneId={sd}` | 节点命中统计 |
| `POST /decision/api/devDecision/updateTree` | **写接口**（改话术用，本 skill 不用） |

### 租户与复制要点（实测验证）

- **bot 真实归属**：不看 URL 的 `planetCompanyId`，看 token 生效租户域名下 `robot/list` 是否含该 botId
- **公安 SaaS 测试账号**：`https://33023910.cos.byai.com`（companyId=67966）
- **复制去向由 token 决定**：副本永远落在执行复制所用 token 的租户；跨租户源 bot 可直接复制，无需源租户授权
- **`isCustomizeScene` 必传**，缺失时一直 `code:500 未知错误`
- `environment=PROD` 校验名称唯一（重复报 413），`dev` 不校验
- 异步锁：复制中重试返回 `code:404 当前正在进行复制操作，请稍候`
- 清理副本：`POST /decision/api/robot/delete`，JSON body `{"robotDefId":id}`

## 六、前端结构速记

- 外层：`https://sh.planet.byai.com/byplanet/botlab/bot/{bot}` — qiankun 微前端 + 腾讯滑块验证码
- 编辑端 iframe：`https://{tenant}.cos.byai.com/voice-bot/bot-gui/{bot}/flow/dev?agentScope=AGENT&currentPlatform=BYXQ&currentRobotDefId={bot}&currentUserId={uid}&hidelayout=true&singlespa=false` — Next.js + voice-bot 独立 bundle（CDN：`cdn.byai.com/nano-cdn/{yyyymm}/voice-bot-prod/static/js/`）
- webpack 全局：`webpackChunk_N_E`（壳）、`webpackJsonp_voice-bot`（编辑器）
- 编辑器接口层集中在 async chunk `941.*.js`（搜 `regex/side`）
