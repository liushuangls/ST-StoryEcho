# L1 自然长篇 RP 验证

## 用户调整与目标

用户于 2026-09-08 明确表示生成长度“不用卡太死”。从本轮起，L1 候选长度仅作诊断，不再使用“比 production 长 10%”作为淘汰条件。事实反转、主体/对象错绑、知情与授权范围扩大、请求/计划升级为完成、关键因果倒置和世界书覆盖原文仍是硬门槛。

本轮不继续修改 `l1-lean-evidence-contract-v2`，而是补充更接近 StoryEcho 实际批次的自然长对话，验证之前观察到的语义收益是否能跨题材复现。方法参考 [OpenAI 官方 Evaluation Best Practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices)：评测数据应代表真实使用分布，并包含边缘情况；生成长度、延迟和 Token 只有在最终质量满足要求时才作为优化指标。

## 请求前冻结方案

新增三个独立场景，每个恰好 15 个用户/角色往返、30 条消息，不使用“这段没有改变状态”“这是无关闲聊”等元叙述告诉生成模型哪些内容应省略：

1. 校园短片：公开许可、未决告白、条件见面、作品署名、音乐授权、素材保管和待处理删除申请。
2. 沙漠商队：世界书传说被现场证据推翻、星盘权属与损伤、候选路线、资源清点、嫌疑撤回和施法限制。
3. 轨道打捞：临时旁路、无人机任务、黑匣权属、内鬼指控撤回、未明样本、求救来源和条件许可。

每例不配置 `idealCompressionRatio`，因此自动评分中的 `compressionEfficiency` 应为 `null`。仍记录来源/输出字符、供应商报告 Token、延迟和正文是否被低价值细节主导。

### 对照方法

- 冻结 production 与 `l1-lean-evidence-contract-v2`，来源、previous summary、世界书、rubric、硬断言、3,000 Token 上限、temperature 0、DeepSeek Flash 生成连接和 GPT-5.6 Sol Judge全部相同。
- 每个 arm 运行两轮，共 12 次生成与 12 次 Judge；不自动重试。先完整运行 production 两轮，再运行 candidate 两轮，不根据中间输出改 prompt 或 rubric。
- 自动总分和 PASS 只作辅助。逐来源检查所有 hallucination、chronology error、critical rubric 和硬断言；任何 major/critical 新错误都否决候选。
- 长度允许自然浮动。若 candidate 更长，只报告增加了哪些有价值信息或哪些冗余；若更短，也不能补偿事实错误。

### 请求前冻结指纹

- 三例均为 30 条消息；计入压缩率的正文分别为 2,307、2,076、2,101 Unicode 码点，约为此前 546–617 字开发例的 3.4–4.2 倍。
- 数据与 rubric：`evals/l1-natural-validation-cases.ts` SHA-256 `9738625a71acdb5879112a2917cb92e5b63a2082bbb455cd553a91288a38a59e`。
- 候选载体：`evals/variants.ts` SHA-256 `2b22cab4883639364a1b00d5e5627e04ff81a03c5e7326c01e5b5a0383994198`；实际 v2 prompt 文本继续使用已冻结的 SHA-256 `80fbaf870f951a055f8eddb83875a92e9ac79b0623c8939d4e88f7a2995808ff`。
- Judge 与计分实现：`evals/evaluator.ts` SHA-256 `4182bc4674347147973fa28186d58f154ba1ffe6cedca44bde6a936a83d9fcb5`。
- 评测协议实现：`evals/protocol.ts` SHA-256 `7c6a449f8ed2ab89bdc2c443403a534a4531d367f22f4d9a8081b7a9aaa153a1`。

以上内容在第一条真实请求前冻结。四轮全部结束前不修改数据、rubric、候选、评分协议或硬断言。

## 实测结果

四轮共完成 12 次生成与 12 次独立 Judge 请求，无空响应、截断、网络错误或协议错误。三例每轮的 source/evaluation hash 在 production 与 candidate 间一致；候选实际 prompt 文本仍是冻结的 v2。

| 指标（两轮六例平均/合计） | Production | v2 candidate |
| --- | ---: | ---: |
| 逐来源语义通过 | 4 / 6 | 6 / 6 |
| Judge 综合均分 | 96.1 | 98.3 |
| 事实保留 | 92.0 | 98.8 |
| 因果连续 | 97.6 | 98.8 |
| 不确定性精度 | 96.5 | 100.0 |
| 聚焦与可用性 | 98.2 | 94.8 |
| 每轮平均输出字符 | 3,008 | 3,595 |
| 每轮生成输入 Token | 10,437 | 9,618 |
| 每轮生成输出 Token | 2,094 | 2,500.5 |
| 每轮生成输入+输出 Token | 12,531 | 12,118.5 |

候选正文平均长 19.5%，但这是用户已明确允许的诊断性变化；候选同时把事实保留提高 6.8 分、不确定性提高 3.5 分，两轮没有 major/critical 幻觉、时序错误、关系升级或行动阶段升级。更短的系统 Prompt 抵消了部分输出增长，单次生成输入加输出总 Token 仍少约 3.3%；不过更长总结会在后续聊天中重复注入，此项代价继续保留在验收判断中。

Production 第二轮沙漠例遗漏 T-6 保管状态、可正常步行和永久损伤不确定性；轨道例整组遗漏十一小时氧气、四只两小时应急瓶和 B-3 冻结状态。候选两轮唯一重复遗漏是漏水坛已移到门外，当前有效水量仍完整。候选第一轮轨道例被旧硬断言判失败，但正文明确写出“是否取得耦合器尚未确认”，属于同义词未覆盖的机械误报，不回写历史结果。

校园场景四份稿均把“同路去地铁口”的计划压成已经共伞走到地铁口；Judge 只在候选第二轮标为 minor 完成阶段扩写。该问题并非候选独有，且不改变授权、关系或后续决定，但说明 production 与候选都仍可能把紧邻的计划写成完成。候选第二轮还因保留较多完整状态而在聚焦维度下降；没有用长度替代质量判断。

结果 SHA-256：

- `l1-natural-production-r1.json`：`bdc4bd642117f8c847a12ad554a2c032c4e9712e2e66fd6708297f64ccb19643`
- `l1-natural-production-r2.json`：`2a92d2df425bf7d79458fad77bb8cc1562a1b3f01d458d7ea8996a1a1b267b24`
- `l1-natural-lean-contract-v2-r1.json`：`4af8a4e5276ea0232f42c52d278b020894270d19787ae90f91a6cb62240c3cc7`
- `l1-natural-lean-contract-v2-r2.json`：`2ffd947159befee8e7d51209269f899fce4cff14ddda6bc3397e4400d569a4f5`

结论：放宽固定长度门槛后，v2 在三种自然长场景中显示出一致的事实与不确定性收益，具备进入既有四例隔离 holdout 的资格。随后按冻结方案完成的四例隔离 holdout 也未出现 major/critical 回归；完整结果与生产晋级记录见 [L1 精简证据契约实验](PROMPT_EVAL_L1_LEAN_CONTRACT_EXPERIMENT.md)。
