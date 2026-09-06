# 提示词质量评测

StoryEcho 的提示词测试分为四部分：

1. `npm run check` 中的离线契约测试检查提示词选择、证据边界、关键规则、评测夹具和评分器，不发起网络请求；
2. `npm run eval:prompts` 使用真实 LLM 生成总结，再由 Judge 模型逐项评估事实、因果、不确定性、信息聚焦与禁写结论；
3. `npm run eval:calibrate` 不生成总结，而是让 Judge 盲评已知差异的对照答案，检查判定、分数区分能力与重复稳定性；
4. `npm run eval:chains` 把真实生成的 L1 送入 L2、再送入 L3，在各层检查连续性问题是否仍可回答。

真实模型评测是显式运行的本地工具，不在 `npm run check`、GitHub Actions 或发布构建中执行。结果和基线默认存入被 Git 忽略的 `evals/results/`。

## 评测用例

当前包含十二个完全脱敏、按真实酒馆长篇 RP 模式编写的合成用例，每层四个：

- L1：物证归属、化名与旧结论修正、校园暧昧边界、秘密身份/仪式同意/医疗限制；
- L2：关系破裂与修复、十条并行任务线、校园群像慢热关系、修仙境界/资源/誓约；
- L3+：长期阵营因果、历史误认、跨代家族旧账、太空殖民地身份与生命维持资源。

这些用例刻意混入酒馆对话中常见的难点：角色说法与客观事实、公开关系与私下关系、谁知道秘密、讨论/承诺/执行的区别、临时授权、条件计划、资源所有权与保管人、伤势与能力限制、已结束支线和仍会影响后文的共同经历。世界书只提供背景，不能替剧情证明事件。

模型仍输出正常的自然语言总结。用例另行定义：

- `requiredFacts`：必须保留的事实；
- `requiredCausalChains`：必须保持连续的因果链；
- `uncertaintyRules`：不能被错误确定化的信息；
- `focusRules`：总结是否把篇幅留给真正影响后续扮演的状态和转折；
- `forbiddenClaims`：来源不支持或已经被修正的结论。

Judge 必须为每条规则返回独立 verdict，并用 `evidenceIds` 引用程序从候选总结划分的片段。程序按原文顺序还原证据，Judge 不必重抄长引文；无效、重复编号或缺少必要证据会使评审无效。旧式直接引文仍须每个片段逐字、顺序匹配，只忽略空白，不再允许“几个字相同”就通过，也不删除负号或小数点。评分由本地代码计算，而不是直接采用 Judge 给出的总分：

- 正向规则使用 `complete / mostly / partial / missing / contradicted` 五档，不再把“提到相近关键词”直接当成完整保留；
- 各条规则按后续影响赋予 1–5 权重，关键规则若低于 `mostly` 会直接失败；
- 综合分只衡量语义质量，保留原五维相对权重 `28:20:16:13:13`，除以 90 后归一化；
- 压缩率独立报告，不参与综合分或通过门槛。原十二个短而密集的夹具没有经过人工标定的长度参考区间，`compressionEfficiency` 为 `null`，而不是默认送 100 分。显式提供区间时仍可计算密度参考分，但不能用“短”证明保真或用“长”证明低质量；冗余和聚焦问题应通过实际内容规则评判；
- 幻觉和时序错误按 `minor / major / critical` 额外扣分，互相矛盾的正向 verdict 也会扣分；
- 通过要求综合分至少 80，同时要求事实至少 76、因果至少 72、不确定性至少 80、聚焦至少 65、禁写安全至少 90，且没有关键规则失败或 major/critical 错误；
- 生成响应若以 `length`、`max_tokens` 等原因结束，本用例直接失败。

完整结果同时记录用例的维度均分、通过数和平均错误扣分。满分仍可能出现；尤其对于短素材，满分不证明长篇实际使用也没有遗漏。应先校准 Judge，不能仅因报告细分了很多维度，就把单次小分差当作可靠的模型排名。

### 压缩率口径

结果格式 v4 使用 `compressionMetric: story-body-codepoints-v1`。`sourceCharacters` 只统计本次待总结正文的 Unicode 码点：L1 使用生产流程提取后的非系统消息正文，L2+ 使用未删除来源总结的正文，相邻正文以换行连接。世界书、前一条总结、身份说明、JSON 字段、哈希和时间戳均不进入分母。

`sourceEvidenceCharacters` 单独记录供 Judge 使用的完整证据大小，`requestCharacters` 记录生成请求 system/user 文本总大小；实际请求 Token 仍查看 generation 中供应商返回的 usage。压缩率大于 1 表示正文扩写，不是压缩。

旧版结果把完整证据 JSON 算进分母，v3 又仍使用未经正文口径校准的长度区间，均不能与当前分数直接比较。指定旧基线会在付费请求前报错，请用新文件名建立基线。当前额外记录评分/Judge 协议、来源与 rubric 的指纹，防止把改量尺误报为生产提示词退化。生产生成提示词本次未变。

## 基本用法

最低需要提供 API Key 和模型名。Base URL 默认是 `https://api.openai.com/v1`，也可以替换为其他 OpenAI Chat Completions 兼容接口：

```bash
export STORY_ECHO_EVAL_API_KEY='...'
export STORY_ECHO_EVAL_MODEL='your-model'
export STORY_ECHO_EVAL_BASE_URL='https://api.openai.com/v1'
npm run eval:prompts
```

Key 只从进程环境读取，不会写入结果、基线、日志或仓库。非本机 HTTP 地址会被拒绝；本机的 `http://localhost`、`127.0.0.1` 和 `::1` 可用于本地代理。

当模型名或官方地址可识别为 DeepSeek 时，评测请求会显式发送
`thinking: { type: "disabled" }`，与 StoryEcho 的生产总结请求保持一致，避免思考
Token 占满总结或 Judge 的输出预算。其他 OpenAI 兼容模型不会收到这个供应商专用字段。

## 独立 Judge

默认由同一个模型评审。推荐在比较重要的提示词变更时使用另一条稳定连接或更强模型作为 Judge：

```bash
export STORY_ECHO_EVAL_JUDGE_API_KEY='...'
export STORY_ECHO_EVAL_JUDGE_MODEL='judge-model'
export STORY_ECHO_EVAL_JUDGE_BASE_URL='https://judge.example.com/v1'
npm run eval:prompts
```

未提供 Judge 专用变量时，继承生成连接配置；但若单独把 Judge Base URL 改到另一个站点，必须同时显式提供 Judge Key，避免把生成连接的 Key 误发到其他站点。工具会在生成模型与 Judge 相同时提示自评局限。比较不同生成模型时，应固定经校准的独立 Judge、接口和评分集，只替换生成模型。

## 先校准 Judge

```bash
npm run eval:calibrate
```

三个剧情场景分别提供完整、关键遗漏、事实反转、更长但夹带错误四种答案，共 12 个对照。它们是开发者编写的合成对照，**不是用户真人标注的金标准，也不是从当前被测模型输出中挑出的高分答案**。预期通过状态和具体 verdict 断言只由本地程序使用，不发送给 Judge。

默认重复两轮、第二轮反向排列请求顺序；每次请求独立，不把上一轮评分发回模型。这不是同屏 A/B 位置偏差实验。检查项目为：

- 每个对照的预期通过状态和指定缺失/错误 verdict 是否符合；
- 好稿是否比同组最高分坏稿至少高 10 分；
- 评审无效数量、错误放行数、错误拒绝数；
- 同一答案跨轮最大分差，暂定不得超过 10 分。

`classificationPassed` 表示所有对照判定正确且有足够分差；总 `passed` 还要求至少两轮且重复分差不超门槛。评审格式错误不当作候选质量 0 分，而单列为 Judge 错误。默认 24 次请求，无自动重试；`STORY_ECHO_EVAL_CALIBRATION_REPEATS` 可设 1–5（1 轮只做冒烟，不代表稳定性通过），`STORY_ECHO_EVAL_CALIBRATION_OUTPUT` 默认 `evals/results/calibration-latest.json`。

这些阈值是项目的初始工程门槛，不是统计置信区间；通过合成对照仍需真人审阅，才能支撑正式的提示词/模型优劣结论。本流程参考 [OpenAI 官方对明确量尺、偏差检查和人工校准的建议](https://developers.openai.com/api/docs/guides/evaluation-best-practices#llm-as-a-judge-and-model-graders)。本次实测与未通过项见 [校准记录](PROMPT_EVAL_CALIBRATION.md)。

## 链式压缩与问答探针

```bash
npm run eval:chains
```

两个脱敏合成场景各 32 条消息、约 4.5k 汉字/符号：校园群像覆盖公开录音许可、知情边界、感情答复、退款与保管；奇幻远征覆盖化名、救援违约、伤势、灵晶账、镜钥所有权和限时停战。它们比原短夹具更长，但**不是数万字长聊天压力测试**，且当前存在复述最新状态的剧情片段。

每个场景依次执行：原文问答对照 → 生成 4 条 L1 → L1 问答 → 合并成 2 条 L2 → L2 问答 → 合并成 1 条 L3 → L3 问答。L1 使用生产 prompt 和真实前一条 L1；高层只接收实际生成的子总结及相同世界书，不注入原文、理想子总结或答案。

为限制本地请求量，测试合并数固定为 2/2，**不改变插件的默认 10/5，也不测试调度器的第 N+1 条触发机制**。输出上限沿用 L1 3000、L2+ 8000；最多 22 次请求，无自动重试。结果默认写入 `evals/results/chains-latest.json`，可用 `STORY_ECHO_EVAL_CHAIN_OUTPUT` 指定新路径。

每个场景有 8 个固定选项问题，答案标签不发给阅读模型。答对且引用有效片段才计通过；原文对照若不能全部答对，停止该场景，避免把阅读器问题误算成压缩丢失。结果记录首次观测到回答失败的层级。

**探针分数只表示这组问题的可回答性，不是总体质量分。** 片段编号只能证明引文存在，不能机械证明该引文支持整项选项；选择题也可能有猜测偏差，首次答错层级需要人工核对，不能自动认定为该层丢事实。后续应补充更长、较少重复、不同人物/数值的留出集，并固定独立阅读器或 Judge。

## 可选环境变量

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `STORY_ECHO_EVAL_TIMEOUT_MS` | `300000` | 单次生成请求超时 |
| `STORY_ECHO_EVAL_JUDGE_TIMEOUT_MS` | 生成请求超时 | 单次 Judge 请求超时 |
| `STORY_ECHO_EVAL_MAX_TOKEN_FIELD` | `max_tokens` | 可改为 `max_completion_tokens` |
| `STORY_ECHO_EVAL_JUDGE_MAX_TOKEN_FIELD` | 继承生成连接 | Judge 使用的 Token 字段 |
| `STORY_ECHO_EVAL_CASES` | 全部 | 用逗号分隔的精确用例 ID |
| `STORY_ECHO_EVAL_OUTPUT` | `evals/results/latest.json` | 完整 JSON 结果路径 |
| `STORY_ECHO_EVAL_BASELINE` | 无 | 要比较或覆盖的本地基线文件 |
| `STORY_ECHO_EVAL_MAX_REGRESSION` | `5` | 相对基线允许的综合分下降 |
| `STORY_ECHO_EVAL_WRITE_BASELINE` | 无 | 设为 `1` 时在全部通过后写入基线 |

例如只运行十条 L1 合并用例：

```bash
STORY_ECHO_EVAL_CASES='l2-ten-source-parallel-arcs' npm run eval:prompts
```

## 建立与比较本地基线

第一次确认模型、Judge 和提示词表现正常后，可以写入本地基线：

```bash
STORY_ECHO_EVAL_WRITE_BASELINE=1 npm run eval:prompts
```

默认文件名包含生成模型名。后续显式指定该文件进行比较：

```bash
STORY_ECHO_EVAL_BASELINE='evals/results/baseline-your-model.json' npm run eval:prompts
```

以下任一情况会使本次结果失败：

- 基线通过而本次未通过；
- 综合分下降超过 `STORY_ECHO_EVAL_MAX_REGRESSION`；
- 当前绝对质量阈值未通过；
- 请求、响应或 Judge JSON 解析失败。

结果记录 StoryEcho 版本、生产 system/user 提示词哈希、评分/Judge 协议哈希、每例来源与 rubric 哈希，以及不含明文连接信息的 Judge 连接哈希。Judge 模型/连接、评分协议、来源或规则不同、或基线缺少选中用例时，在请求前拒绝比较；生成模型变化仍可比较并给出提示。默认 5 分回归阈值只是可配置检查线，不代表当前 Judge 已具备 5 分级别精度，应先查看校准的跨轮波动。
