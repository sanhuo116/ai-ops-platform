# 星球 CLI 命令与接口边界

以下从技能目录运行。`BOTID`、`NODEID`、`KNOWLEDGE_ID` 均替换为本次实际读取的数字。不是字面参数。输出目录由任务指定，保留各轮独立目录。

```sh
python3 scripts/planet.py auth status
python3 scripts/planet.py export BOTID --environment dev --out work/baseline
python3 scripts/planet.py export BOTID --environment prod --out work/prod-readonly
python3 scripts/planet.py prepare BOTID --out work/preparation.json
python3 scripts/planet.py test BOTID --messages-file work/messages.json --variables '{"queue_count":"0"}' --out work/result.json
python3 scripts/planet.py prompt-plan BOTID --node-id NODEID --variant 1 --file work/proposed-prompt.txt --out work/prompt-plan.json
python3 scripts/knowledge.py plan BOTID --knowledge-id KNOWLEDGE_ID --answer-file work/answer.txt --source '本次snapshot中的政策条目与原文位置' --out work/faq-plan.json
python3 scripts/knowledge.py plan BOTID --knowledge-id KNOWLEDGE_ID --similar-additions-file work/aliases.json --source '真实失败输入及现有知识来源' --out work/alias-plan.json
python3 scripts/iteration.py --kind prompt --plan work/prompt-plan.json --baseline-run work/v0 --out work/v1-apply.json
python3 scripts/iteration.py --kind knowledge --plan work/faq-plan.json --baseline-run work/v1 --out work/v2-apply.json
```

`messages.json` 为非空字符串数组，`aliases.json` 为新增相似问字符串数组（每条最多100字，不能与原有重复）。`--variant` 是平台真实 sortIndex，不是随意给出的版本号；多 Prompt 节点必须显式选择。`--state-dir` 可在 planet.py 子命令前指定；知识和迭代脚本也支持该参数。

低层接口用于排障或明确的单次变更，不代替完整验收：
```sh
python3 scripts/planet.py prompt-apply --plan work/prompt-plan.json
python3 scripts/planet.py prompt-apply --plan work/prompt-plan.json --rollback
python3 scripts/knowledge.py apply --plan work/faq-plan.json --out work/faq-apply.json
python3 scripts/knowledge.py apply --plan work/faq-plan.json --rollback --out work/faq-rollback.json
```

计划保存前后内容及语义指纹；目标不符、计划被改、当前内容漂移时拒绝写入。回滚只允许当前仍是该计划的 after 状态；不能覆盖别人后续修改。知识回读会检查其它知识未变，保存可能重建生成语音引用；发现不一致立即停，保留原计划排查，不自动重试写入。`iteration.py` 在写入前留下 started 文件，避免结果不确定时盲重试。

## 读取范围与真实性

`export` 导出全局配置、Prompt节点/版本、知识列表/答案/相似问、变量、短信、接口查询和对话上下文。manifest 报告总数、重复ID校验、未支持节点和附加项 unresolved。不会把用户状态中的 Cookie、绑定 token 写入快照。

内部使用 BOT identity → 获授权的公司服务域名 → BOT内容页启动信息 → 绑定请求头。内部路由信息自动取得，业务入口无需租户 ID。只允许平台返回的 `*.cos.byai.com` 域名；绑定BOT必须一致；不向任意主机发送登录态。

测试使用真实 SockJS/STOMP：唯一会话ID、独立订阅、当前用户输入回显与模型完成事件，结束时 stop/unsubscribe/disconnect。不是浏览器 React 注入，不重放预制答案。

INNER 的 `synKnowledge` 请求完成只代表准备请求完成，另需检查真实召回。经典 `publishTest` 仅同步开发测试资源，必须轮询状态2；不是正式发布。状态9、null或异常不能统一称“索引成功”。

错误分类：HTTP/应用错误不得解释成空内容；bootstrap302只说明启动失败，不能单凭一次结果认定凭据过期。先看 auth status 和后续只读回执。真实传输异常保存 partial；语义不正确保留 FAIL。文本测试不证明语音ASR/TTS、SIP接通或后台最终模型请求正确。

## 包内验证证据

`scripts/test_planet.py`：授权、目标/域名、防串会话、真实工具结束、计划完整性与回滚。`test_workflow.py`：知识修改、用例冲突结构检查、审核指纹、未答轮/假转接拒绝、写前资源漂移门禁。fixture 仅保留匿名化协议结构；不含客户原始记录。验证结果见包内 `VALIDATION.json`，区分离线测试与真实在线烟测。
