# 判定口径与产出结构

## 判定链路（主巡检 audit_tree.mjs）

```
逐通电话：
  1. 识别话术包（按开场白文本指纹分流：2161410 / 420469 / 420445）
  2. AI 每轮 → 归一化后精确匹配话术包原文 → 定位 step（构建 stepOf[i]）
  3. 对每个 ME 轮：
     a. ci = 前一个有 step 的 AI 轮（cur）
        若 cur 无可判定分支（只有默认/原地）→ skipNoJudge++，跳过   ← 不回溯！
     b. ni = 下一个有 step 的 AI 轮（next）
        同 step 重复时向后看是否有"后来不同 step"：
          有 → 说明是 TTS 分段，继续找；无 → 是真·原地，ni 生效
     c. 用 cur 的各分支正则跑用户话术 → matched[]
     d. 判定：
        matched 空：
           有默认且默认有 target → next==target ? okDefault : errDefault
           有默认但无 target     → 同节点顺序推进 ? okInternalSeq : noMatchNoDef
           无默认               → 同节点推进 ? okInternalSeq : noMatchNoDef
        matched 非空：
           targets 全为 None → 同节点推进/原地 ? ok : okInternalSeq
           targets 含 next.node → ok
           否则 → errWrong（记录 expected vs actual）
```

## 统计口径（tree_stat.json）

| 字段 | 含义 | 处理 |
|---|---|---|
| steps | 可判定跳转总数 | 分母 |
| ok | 跳对 | 正确 |
| okDefault | 该默认走默认 | 正确 |
| okInternalSeq | 节点内顺序续说 | 正确（设计如此）|
| errWrong | 命中分支走错 | 缺陷 |
| errDefault | 该默认偏离 | 缺陷 |
| noMatch | 未命中任何分支 | 多为叶子话术后应答，**不是缺陷** |
| skipNoJudge | 无判定分支的纯告知 step | 正常排除（实测 72.6% step）|
| noStep | AI 前文无 step 可定位 | 反推失败 |
| lastTurn | 通话结束无下一句 | 无法判定 |
| sysLike | 系统提示音 | 排除 |

走向正确率 = (ok + okDefault + okInternalSeq) / (ok + okDefault + okInternalSeq + errWrong + errDefault)

## 六类问题（build_v9.py 输出）

| 类 | 名称 | 来源 | 处置 |
|---|---|---|---|
| 1 | 命中分支却走错去向 | tree_problems errWrong | 查节点配置/正则 |
| 2 | 该走默认却偏离 | tree_problems errDefault | 查默认分支 target |
| 3 | 该命中分支却未命中 | tree_gaps（AI 实际已按分支推进但正则没中）| 候选补词 |
| 4 | 分支语义疑似配错 | gap 组语义相符率 <35% | **不补词**，报业务确认 |
| 5 | 知识库命中却未按意图走 | kb_inframe2 | 查知识库/分支优先级 |
| 6 | 框架外意图 | kb_outframe2 | 新建知识条目 |

## 补词建议的三道门槛（宁缺毋滥）

1. **纯语气占比 >55%** → 跳过（用户只是应了一声，AI 走哪个分支都不算错）
2. **语义相符率 <35%** → 改报"分支语义疑似配错"
3. **V8 回测命中率 <40%** → 剔除

实测教训：某轮挖出 87 条候选方案，逐条核验后只剩 2 条成立。

## Excel 产出结构

### 巡检表（make_xlsx_v9.py，9 张）
```
概览                        统计 + 口径
问题明细                    序号/问题类型/话术/节点/问题描述/出现次数/错误问句
分支关键词-原版本与优化后    空时写说明行（为何不补词）
分支配置缺口-需业务定义      两侧全空且有去向
全局库规则缺陷-弱肯定误判    分支/误判话术/次数/建议
框架外意图明细              按节点聚合 + 高频原话
知识库死条目                标"有去向却永不可能命中"标红
优化效果回归                改动前后对比
方法说明                    判定逻辑六步
```

### 全局库对照表（build_libs.py，6 张）
```
0-说明与统计
A-原版分支库   327 条，正则英文逗号合并一列
B-原版问题库   128 条
C1-优化后-分支库   全量行 + 操作列（删/增/保留），改动精确到分支 ID
C2-优化后-问题库   死条目逐条"补/建"
C-改动汇总     212 行，一眼看全
```

## 交付时必须声明的限制

1. 通话记录无节点轨迹字段，节点序列靠 AI 话术反推（精确命中率 94.9%）
2. "走向正确率"不含无法判定段（lastTurn/noStep）
3. 框架外意图的"意图明显"由语言学标记界定，陈述式意图抓不到 → 数字是下界
4. 同名全局分支跨场景合并会污染规则集，必须走 answerRegexSide
