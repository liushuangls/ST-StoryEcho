# 提示词质量评测

StoryEcho 的提示词测试分为两层：

1. `npm run check` 中的离线契约测试检查提示词选择、证据边界、关键规则、评测夹具和评分器，不发起网络请求；
2. `npm run eval:prompts` 使用真实 LLM 生成总结，再由 Judge 模型逐项评估事实、因果、不确定性、信息聚焦与禁写结论。

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

Judge 必须为每条规则返回独立 verdict，并引用候选总结中的可定位证据片段；不连续证据可以用省略号连接。证据与候选完全无关、规则遗漏或索引重复都会使评测失败。评分由本地代码计算，而不是直接采用 Judge 给出的总分：

- 正向规则使用 `complete / mostly / partial / missing / contradicted` 五档，不再把“提到相近关键词”直接当成完整保留；
- 各条规则按后续影响赋予 1–5 权重，关键规则若低于 `mostly` 会直接失败；
- 综合分由事实 28%、因果 20%、不确定性 16%、聚焦与可用性 13%、禁写安全 13%、压缩效率 10% 组成；
- 压缩效率使用按层级设定的理想压缩比区间：区间内不扣分，过长按冗余风险降分，过短按信息缺失风险降分；它不会覆盖事实与因果门槛，因此不能靠删掉关键内容刷分；
- 幻觉和时序错误按 `minor / major / critical` 额外扣分，互相矛盾的正向 verdict 也会扣分；
- 通过要求综合分至少 80，同时要求事实至少 76、因果至少 72、不确定性至少 80、聚焦至少 65、禁写安全至少 90、压缩效率至少 60，且没有关键规则失败或 major/critical 错误；
- 生成响应若以 `length`、`max_tokens` 等原因结束，本用例直接失败。

完整结果同时记录 12 个用例的维度均分、通过数和平均错误扣分，方便在固定 Judge 下比较不同提示词版本或生成模型。满分仍然可以获得，但要求每个加权原子事实和状态链都明确存在、所有聚焦规则均满足且没有任何错误，因此不再是默认结果。

### 压缩率口径

结果格式 v3 使用 `compressionMetric: story-body-codepoints-v1`。`sourceCharacters` 只统计本次待总结正文的 Unicode 码点：L1 使用生产流程提取后的非系统消息正文，L2+ 使用未删除来源总结的正文，相邻正文以换行连接。世界书、前一条总结、身份说明、JSON 字段、哈希和时间戳均不进入分母。

`sourceEvidenceCharacters` 单独记录供 Judge 使用的完整证据大小，`requestCharacters` 记录生成请求 system/user 文本总大小；实际请求 Token 仍查看 generation 中供应商返回的 usage。压缩率大于 1 表示正文扩写，不是压缩。

旧版结果把完整证据 JSON 算进分母，不能与新版分数直接比较；指定旧基线会在请求模型前报错，请用新文件名重建基线。本次没有调整各层理想区间、质量权重或生成提示词，因此旧用例的压缩效率可能显著下降；区间仍需结合正文信息密度和人工评审校准，不能为了压缩分数删掉重要事实。此做法遵循 [OpenAI 的任务专用评估与人工校准建议](https://developers.openai.com/api/docs/guides/evaluation-best-practices#how-to-read-evals)。

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

未提供 Judge 专用变量时，分别继承生成连接的 Key、模型、Base URL、超时和 Token 字段。工具会在生成模型与 Judge 相同时明确提示：这种配置适合检查同一环境下的提示词回归，但自评可能偏高。比较不同生成模型时，应固定一个独立 Judge、接口和评分集，只替换生成模型。

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

结果还会记录 StoryEcho 版本及每个用例实际 system/user 提示词的 SHA-256，便于确认比较的确实是不同提示词版本。模型或 Judge 与基线不一致时工具会给出警告。正式比较提示词版本时应固定生成模型、Judge、接口和用例集合；真实模型仍可能存在少量波动，因此默认允许 5 分以内变化。
