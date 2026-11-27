# 冻结测试与逐案验收

`assets/casebank.example.json` 是虚构结构示例，不能直接当真实 BOT 的政策金标。Agent 需要读本次当前 Prompt/知识、客户问题与历史上下文，生成实际用例。

每案字段：`id`、`category`、`source_refs`、`turns`；每轮 `user`、`expected`、可选 `forbidden`、`expected_action`（none / clarify / transferCall / hangup）。source_refs 链接到本次快照中的完整条目、原文段落或反馈行/通话片段。验收语句说明最小充分答案与例外，不要求逐字复述。

```sh
python3 scripts/regression.py lint --bank work/cases.json
python3 scripts/regression.py freeze --bank work/cases.json --audit work/audit.json --out work/frozen.json
python3 scripts/regression.py run BOTID --frozen work/frozen.json --variables-file work/variables.json --workers 3 --out work/v0
python3 scripts/regression.py review --run work/v0 --case-id CASE_ID --verdict FAIL --rationale '结合原文和本轮回复的明确依据' --reviewer '当前审核者'
python3 scripts/regression.py finalize --run work/v0
```

`audit.json` 需含 lint 输出的 `casebank_sha256`、`approved:true`、`reviewer`、`notes`。这是审核者对条件、时点、例外、跨用例冲突的显式记录。脚本只能识别结构缺失和同输入重复/潜在冲突，不能自动证明政策标准正确。每案阅读原始输出后执行 review；不能按关键词命中自动 PASS。重复 review 保留历史，以最新且指纹一致的结论为准。

全量执行把冻结 bank、变量、前后配置指纹、每案会话与事件、进度及错误分别保存。最多3并发；不自动重试语义错误。确属传输失败恢复：
```sh
python3 scripts/regression.py run BOTID --frozen work/frozen.json --variables-file work/variables.json --workers 3 --out work/v0 --resume
```

resume 核对资源/金标/变量，不覆盖已有完成结果。连续错误批次累计3次失败停止继续调度，先诊断。config-after导出未完成时不能 finalize；恢复后只补资源核验，不能为了好答案重跑已完成案。

finalize 要求：完整执行、全案有效审核、资源一致、回复完成、真实输入顺序一致；应转人工须真实已确认工具。合法转接后的未发续句必须记录 `--terminal-justification`，并由审核者判断当前触发条件确实成立。非预期提前结束不能借工具回执免责。`hangup` 和 clarify 的业务语义仍由审核者结合完整上下文验收，不能把普通文本中的“挂断”作为真实挂断事件。

每次修改前上一轮完整审核；每次修改后新目录完整重跑。FAIL 可以用于下一轮修复，但最终验收要求全 PASS，无 BLOCKED；新增知识另加标准问集；高风险措辞多次重复。三组须资源指纹一致。不能把回归成功等同未见样本准确率、所有历史通话审核完成或线上零错误。
