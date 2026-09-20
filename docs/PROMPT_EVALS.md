# 提示词质量评测

StoryEcho 的提示词测试分为八部分：

1. `npm run check` 中的离线契约测试检查提示词选择、证据边界、关键规则、评测夹具和评分器，不发起网络请求；
2. `npm run eval:prompts` 使用真实 LLM 生成总结，再由 Judge 模型逐项评估事实、因果、不确定性、信息聚焦与禁写结论；
3. `npm run eval:calibrate` 不生成总结，而是让 Judge 盲评已知差异的对照答案，检查判定、分数区分能力与重复稳定性；
4. `npm run eval:pairwise` 同屏比较 A/B 两份总结，交换位置并可重复运行，检查相对优劣与判断稳定性；
5. `npm run eval:chains` 把真实生成的 L1 送入 L2、再送入 L3，在各层检查连续性问题是否仍可回答；
6. `npm run eval:chains:default` 用默认 10/5 合并规则和真实 N+1 触发路径，测试 61 条 L1 的长链。
7. `npm run eval:revise` 对固定 L2 原稿做一次来源核验修订，单独测纠错和误改；仅本地实验，不给插件增加第二次请求。
8. `npm run eval:localize` 对冻结的八份完整稿件定位发言归属扩写与重要表态遗漏，各请求两次；只输出诊断证据，不改写总结，不作为自动质量门禁。

真实模型评测是显式运行的本地工具，不在 `npm run check`、GitHub Actions 或发布构建中执行。结果和基线默认存入被 Git 忽略的 `evals/results/`。

### 固定原稿的来源核验

`eval:revise` 要求 `STORY_ECHO_EVAL_REVISION_INPUTS` 为 1–4 个完整 `eval:generate` 结果路径的 JSON 数组，总共最多 28 份 L2 草稿；用 `STORY_ECHO_EVAL_REVISION_OUTPUT_DIR` 指定新结果目录，已有目录会在调用前被拒绝，不能覆盖旧结果。它使用 `STORY_ECHO_EVAL_*` 生成连接，不使用 Judge 连接。

工具预先校验全部原稿的完整状态、原请求和来源/rubric 指纹；实际核验请求只发来源与草稿，不发评分规则、手工错误标签或原生成 prompt。每稿至多一次修订，无重试、二次自纠或自动模型切换；遇网络/空内容/截断/保存失败停止。结果保留原稿、父结果/协议/请求哈希、修订正文及传输统计，`changed` 不代表纠错成功，`qualityEvaluated=false`，不产出质量分。

首轮 28 份固定稿的同模型核验修掉了额外行动禁令及登记上交，但同居、来源发言和整项遗漏仍有残留，未达到接入生产门槛。具体冻结输入、复现命令、前后来源核查和附加耗时见 [生成后来源核验实验](PROMPT_EVAL_SOURCE_REVISION_EXPERIMENT.md)。

随后用 GPT 5.6 sol 核验同一批原稿（不是 DeepSeek 已修稿），新增 28 次请求。同居、星盘遗漏和咖啡回应均修好，但新增人物发言仅修好 1/3，仍未通过；附加耗时 p95 为 24,305ms，不接入生产。完整固定输入、修复/残留/误删与连接差异说明见 [GPT 来源核验对照](PROMPT_EVAL_SOURCE_REVISION_GPT_EXPERIMENT.md)。工具仍使用生成连接，此次仅在运行子进程中显式映射既有 Judge 环境变量，没有自动改用 Judge 或修改用户配置。

### 固定稿件的错误定位

`eval:localize` 是单独的显式诊断实验。输入目录由 `STORY_ECHO_EVAL_LOCALIZATION_INPUT_DIR` 指定（默认上轮 GPT 核验目录），必须包含三份指纹匹配的冻结存档；输出目录 `STORY_ECHO_EVAL_LOCALIZATION_OUTPUT_DIR` 必须不存在。它要求完整、显式配置的 GPT Judge 连接，不回退生成连接，最多 16 次请求；遇网络、格式、引用或保存错误停止，无重试或自动修订。

模型只看到完整来源和带索引的完整稿件，不看到预设答案或另一份对照。只诊断两类问题，`targetEvidenceHit` 是引用覆盖而非语义质量分，空报告也不是整稿通过。实测新增发言仅 1/4 报出、表态遗漏 2/2 报出，正确对照 0/10 误报，未达到冻结门槛，不接入生产。详见 [来源错误定位实验](PROMPT_EVAL_SOURCE_LOCALIZATION_EXPERIMENT.md)。

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

结果格式 v5 延续 v4 的 `compressionMetric: story-body-codepoints-v1`，新增 Judge 输出模式与脱敏失败诊断。`sourceCharacters` 只统计本次待总结正文的 Unicode 码点：L1 使用生产流程提取后的非系统消息正文，L2+ 使用未删除来源总结的正文，相邻正文以换行连接。世界书、前一条总结、身份说明、JSON 字段、哈希和时间戳均不进入分母。

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

### 评审协议与结构化输出

逐项评分的 rubric 为每条规则显式提供 `criterionIndex` 和 `criterionId`。返回格式以各维度内的编号作为对象键（如 `requiredFacts: {"0": {...}, "1": {...}}`），防止遗漏或重编索引；本地仍会验证规则覆盖、verdict 和精确片段引用。A/B 请求明确使用 `candidate_A_segments`、`candidate_B_segments` 两个字段，差异直接引用规则的 `criterionId`。

支持 OpenAI 严格 JSON Schema 的 Judge 可显式启用：

```bash
STORY_ECHO_EVAL_JUDGE_OUTPUT_MODE=json_schema npm run eval:judge:smoke
STORY_ECHO_EVAL_JUDGE_OUTPUT_MODE=json_schema npm run eval:calibrate
```

冒烟最多 3 次请求：一个已知逐项对照和同一 A/B 对照的两个位置。逐项请求失败或判定不符合对照时停止；通过仅表示这些样本可用，不等于完整校准通过。默认输出 `evals/results/judge-smoke-latest.json`，可用 `STORY_ECHO_EVAL_JUDGE_SMOKE_OUTPUT` 指定新路径。

`json_schema` 只应用于逐项 Judge 和 A/B Judge，不应用于生产总结、评测中的总结生成或长链问答探针。兼容接口默认使用 `text`；不支持 schema 时会明确失败，**不会自动降级、切换模型或重试**。JSON Schema 约束规则键、枚举和引用范围，不证明语义正确，也不替代校准或人工检查。这一用法参考 [OpenAI Structured Outputs 指南](https://developers.openai.com/api/docs/guides/structured-outputs#supported-schemas)。用户代理对同名模型的实际支持须以冒烟结果为准。

失败记录包含脱敏响应预览（最多 24,000 个 UTF-16 代码单元）、脱敏正文哈希、长度/截断标记及可获得的结束原因、usage、耗时和请求哈希；不记录认证头、其他非白名单头或明文连接配置。非 JSON、HTTP 错误、拒绝、截断、解析与引用错误均保留可用诊断。逐项对照误判，以及 A/B 位置不一致、`inconclusive` 或不符合已知对照时，也保留已返回响应的预览。先替换环境中的已知敏感值及 Bearer 凭据再截取，但这不是任意未知秘密检测器。默认结果目录被 Git 忽略；自行指定目录时也不要提交含评测文本的诊断。

新协议与旧协议分数不能直接比较。输出模式纳入 Judge 连接指纹，防止混用 text/json_schema 的评分基线；来源/rubric 指纹不变，所以可以复用已生成正文再盲评，不必重新花费生成请求。

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

### 串行同文诊断与输入回显

当 Judge 把相同候选判出差异，或声称输入字段不存在时，先做固定的小规模诊断。不要与其他实测进程并行启动：

```bash
STORY_ECHO_EVAL_JUDGE_OUTPUT_MODE=json_schema npm run eval:judge:serial
# 等上一个命令完全结束后，按需运行：
npm run eval:judge:receipt
```

`eval:judge:serial` 固定三组完全相同的 A/B 文本、两个位置、两轮，共 12 次请求。沿用当前 A/B Judge system、用户消息和 schema，不发送“这是同文对照”的预期标签；逐次等待网络及结果保存，保留每次返回的脱敏原文、开始/结束时间和传输诊断。保存失败后不再花费下一次请求。返回 `passed` 只表示这组同文对照通过，不是完整质量校准；失败不被后续重复样本覆盖。

传输诊断只保存实际 JSON 请求体的 SHA-256 / UTF-8 字节数、HTTP 状态、客户端 UUID、服务端 `x-request-id`、响应 `id` / `model` / `system_fingerprint`（如果提供）及脱敏响应体哈希。客户端 UUID 放在 `X-Client-Request-Id` 头中，不进入 prompt 或请求体。该做法参考 [OpenAI 请求调试说明](https://developers.openai.com/api/reference/overview#debugging-requests)。服务端返回的模型名和 ID 只是该连接的自报信息，不能验证实际模型身份、上游接收内容或排除代理内部缓存。

`eval:judge:receipt` 固定对钥匙保管、殖民地两组同文输入各请求一次，串行共 2 次。保持原 A/B 用户消息不变，但改用字面回显 system 与独立 JSON schema，要求逐项原样复制 A/B 片段。本地校验每个 id、text、顺序与条数，不计质量分，不自动重试；该诊断始终要求接口支持 `json_schema`。通过只能说明这些回显请求能正确读出数据，不能证明原评审请求在代理中未变化，也不能当作 Judge 校准通过。

默认结果分别为 `evals/results/judge-serial-latest.json` 和 `evals/results/judge-receipt-latest.json`，可用 `STORY_ECHO_EVAL_JUDGE_SERIAL_OUTPUT` / `STORY_ECHO_EVAL_JUDGE_RECEIPT_OUTPUT` 指定新文件。两个命令均仅本地使用，不进入正常检查或 GitHub CI。

### Judge 输入布局对照（本地实验）

```bash
STORY_ECHO_EVAL_JUDGE_OUTPUT_MODE=json_schema \
STORY_ECHO_EVAL_JUDGE_LAYOUT_OUTPUT=evals/results/judge-layout-local.json \
npm run eval:judge:layout
```

固定使用原有三组同文对照，比较两种输入布局，每组每布局交换 A/B 位置各请求一次，共 **12 次串行请求**。相邻运行新旧布局，并在不同用例间轮换谁先运行。每个组合只有一轮双向判断；结果中的 `repetition` 用于轮换位置顺序，不代表独立重复了三轮。

- `segments-json`：原有 JSON 片段布局，system、用户消息保持原协议字节不变，也是其他评测命令的默认布局。
- `full-text-with-index`：在前面增加分别标记的完整 A/B 正文，原 JSON 来源、rubric、片段索引原样保留在后面。system 只替换读取位置说明，评分规则、输出 schema 和 5,000 Token 输出预算不变。正文会重复出现，因此请求体更大；这是“顺序 + 分隔 + 完整正文 + 导航说明”的组合实验，不能将结果归因于其中一个因素。

只有新布局的六次同文标签全部正确、三个双向比较均通过，才追加三组完整稿/遗漏稿的双向判断（6 次），**单次命令最多 18 次请求**。同文筛查失败则停止在 12 次，不自动重试、不切换模型、不启动生成模型。进度逐请求保存；保存失败后停止付费调用。

`passed` 只代表这批已用于校准的样本通过筛查，不是留出集验证或完整 Judge 校准，仍需人工检查判断理由。保存两种协议指纹、请求布局/位置、schema 指纹、脱敏响应及传输诊断；不保存 Key 或明文连接地址。复跑应更换输出文件名。该命令不进入正常检查或 GitHub CI，不修改生产总结 prompt，也不会把新布局自动设为默认。

## 链式压缩与问答探针

```bash
npm run eval:chains
```

两个脱敏合成场景各 32 条消息、约 4.5k 汉字/符号：校园群像覆盖公开录音许可、知情边界、感情答复、退款与保管；奇幻远征覆盖化名、救援违约、伤势、灵晶账、镜钥所有权和限时停战。它们比原短夹具更长，但**不是数万字长聊天压力测试**，且当前存在复述最新状态的剧情片段。

每个场景依次执行：原文问答对照 → 生成 4 条 L1 → L1 问答 → 合并成 2 条 L2 → L2 问答 → 合并成 1 条 L3 → L3 问答。L1 使用生产 prompt 和真实前一条 L1；高层只接收实际生成的子总结及相同世界书，不注入原文、理想子总结或答案。

为限制本地请求量，测试合并数固定为 2/2，**不改变插件的默认 10/5，也不测试调度器的第 N+1 条触发机制**。输出上限沿用 L1 3000、L2+ 8000；最多 22 次请求，无自动重试。结果默认写入 `evals/results/chains-latest.json`，可用 `STORY_ECHO_EVAL_CHAIN_OUTPUT` 指定新路径。

每个场景有 8 个固定选项问题，答案标签不发给阅读模型。答对且引用有效片段才计通过；原文对照若不能全部答对，停止该场景，避免把阅读器问题误算成压缩丢失。结果记录首次观测到回答失败的层级。

**探针分数只表示这组问题的可回答性，不是总体质量分。** 片段编号只能证明引文存在，不能机械证明该引文支持整项选项；选择题也可能有猜测偏差，首次答错层级需要人工核对，不能自动认定为该层丢事实。后续应补充更长、较少重复、不同人物/数值的留出集，并固定独立阅读器或 Judge。

### 默认 10/5 长链

```bash
npm run eval:chains:default
```

独立、显式运行的较大用例，不会随短链命令自动执行。海港修复场景含 61 个 L1 批次、366 条消息、约 3.9 万 Unicode 码点；涵盖低重复的早期借物承诺、伤势限制、身份知情边界、账目更正、合作暂停与恢复、跨章未决事项。

测试调用生产 `findSummaryCompactionCandidate`，阈值和输出预算读取 `DEFAULT_SETTINGS`：第 11 条 L1 出现时合并最早 10 条；第 61 条 L1 出现时先产生第 6 条 L2，再合并最早 5 条 L2 为 L3。最终活动条目为覆盖前 50 批的 L3、随后 10 批的 L2、最后 1 批的 L1。最多 68 次生成 + 4 次探针请求，无自动重试；响应截断或请求失败立即停止，结果保留已完成节点与最后有效活动条目。

探针检查原文、首次 L2 合并后、首次 L3 合并前后。早期检查只询问当时已有最终答案的事项，不把尚未发生的更新误判为丢失。高层始终只接收真实子总结和相同世界书；问答探针不把正确答案标签发给模型。

这是**合并默认值**测试，不是完整插件实机：L1 每批为测试用的 3 轮，不是默认 10 轮；不模拟网络流式、队列、原文窗口裁剪或元数据保存。剧情为开发者合成，没有读取用户聊天；气氛与过场采用重复模板，主要事实没有最终全量复述。因此仍不能代表所有真实长篇 RP。默认结果为 `evals/results/default-chain-latest.json`，可用 `STORY_ECHO_EVAL_DEFAULT_CHAIN_OUTPUT` 覆盖。

## A/B 盲评

先检查已知差异和位置偏差：

```bash
STORY_ECHO_EVAL_PAIRWISE_REPEATS=2 npm run eval:pairwise
```

默认 `controls` 模式：9 对完整稿与坏稿、3 对相同稿，每对在两个位置各请求一次；一轮 24 次，两轮最多 48 次。默认重复 1 轮是冒烟检查，不会获得完整校准的 `passed=true`；`STORY_ECHO_EVAL_PAIRWISE_REPEATS` 可设 1–3。两种位置之间的胜方和双方合格判定必须一致；跨轮也检查胜方及合格标签一致性。第二轮反向排列用例并轮换先请求的位置。没有自动重试；一轮中任一对照失败，不开启下一轮，保留该轮全部结果。

### 可用于候选比较的扩展校准

```bash
STORY_ECHO_EVAL_JUDGE_OUTPUT_MODE=json_schema \
STORY_ECHO_EVAL_PAIRWISE_LAYOUT=inline-segments \
STORY_ECHO_EVAL_PAIRWISE_CONTROLS=extended \
STORY_ECHO_EVAL_PAIRWISE_REPEATS=2 \
STORY_ECHO_EVAL_PAIRWISE_OUTPUT=evals/results/pairwise-calibration-local.json \
npm run eval:pairwise
```

扩展集由原 12 对、3 对等价改写及 3 个独立新剧情组成，共 18 对（7 对预期平局，11 对预期完整稿胜出）。新剧情覆盖录音用途的有限追加授权、退款后的净余额与条件性引见、化名与角色知情边界；也包含较长文本夹带无依据后续结局的反例。所有预期在首次运行前写好，不发给 Judge。它们仍是开发者合成对照，而非人工金标准；参与调试后不能再当作未见留出集。

`STORY_ECHO_EVAL_PAIRWISE_LAYOUT` 支持：

- `segments-json`：历史默认，保留原协议，未自动切换。
- `full-text-with-index`：完整正文与后置 JSON 索引分离的实验布局。
- `inline-segments`：将原片段文本按顺序逐条展示，编号直接放在相应正文旁，不再复制一份正文或另设引用索引。编号仍映射同一份 `candidateEvidenceSegments`，来源/rubric、评分标准和输出 schema 不变。仅改变评审输入，不影响生成 prompt。

两轮扩展校准最多 72 次串行请求；全部对照在两轮的胜负和双方合格标签都正确，且无格式/引用/网络错误，才能放行候选比较。程序逐请求保存脱敏返回、传输诊断和时间；保存失败立即阻止后续付费调用。来源/rubric/候选/预期标签进入对照集指纹；生产生成 prompt 不进入该指纹，因此后续修改生成 prompt 不会无意义地使 Judge 校准过期。

新布局的 `compare` 模式必须通过 `STORY_ECHO_EVAL_PAIRWISE_CALIBRATION` 指定有效扩展校准文件。读取后重新检查连接、布局、输出协议、对照集指纹、至少两轮完整记录及逐位置标签，不只信任顶层 `passed`。预检失败不调用模型。这个门槛仅证明当前 A/B 协议在校准集上可靠，不认证逐项数值评分，也不证明未来所有样本都可靠。

比较两次 `eval:prompts` 已保存的输出：

```bash
STORY_ECHO_EVAL_PAIRWISE_MODE=compare \
STORY_ECHO_EVAL_JUDGE_OUTPUT_MODE=json_schema \
STORY_ECHO_EVAL_PAIRWISE_LAYOUT=inline-segments \
STORY_ECHO_EVAL_PAIRWISE_CALIBRATION=evals/results/pairwise-calibration-local.json \
STORY_ECHO_EVAL_PAIRWISE_LEFT=evals/results/production.json \
STORY_ECHO_EVAL_PAIRWISE_RIGHT=evals/results/candidate.json \
STORY_ECHO_EVAL_PAIRWISE_REPEATS=2 \
npm run eval:pairwise
```

两侧必须有相同非空用例集合，来源及 rubric 指纹与当前夹具一致，生成正文不为空且未截断；预检失败不发付费请求。旧的逐项 Judge 报错不妨碍比较已成功生成的正文，因为会重新做成对评审。模型名、新旧版本身份、预期胜方及文件路径不发给 Judge。

Judge 可返回 A、B、平局或无法判断，且两份都可判不合格。事实、因果、状态和证据边界优先于长度；每个胜出判断必须有可定位的差异，纯遗漏一侧可无引文。程序校验引用存在，但语义支持仍需审阅。默认结果 `evals/results/pairwise-latest.json`，可用 `STORY_ECHO_EVAL_PAIRWISE_OUTPUT` 覆盖。

**compare 模式的 `passed` 只表示这些判断在交换位置/重复中一致，不表示右侧候选更优或可以发布。** 同模型生成与评审仍属于自评；使用独立 Judge、更多重复或更多维度本身都不能替代对照校准和人工复核。

## 实验提示词（不影响插件）

候选生成与评审可分开运行，推荐用于已校准的 A/B 工作流：

```bash
STORY_ECHO_EVAL_CASES='l2-relationship-reversal,l2-ten-source-parallel-arcs,l2-campus-ensemble-and-slow-burn,l2-cultivation-resources-and-oaths' \
STORY_ECHO_EVAL_VARIANT=production \
STORY_ECHO_EVAL_OUTPUT=evals/results/generated-production.json \
npm run eval:generate
```

`eval:generate` 只读取生成连接的环境变量，不调用 Judge，不创建数值评分或质量通过标记；结果明确记录 `qualityEvaluated=false`，`generationSucceeded` 仅表示选中用例全部成功生成。默认最多调用现有 12 个用例，可用 `STORY_ECHO_EVAL_CASES` 精确选择。未知/重复 ID 在付费前拒绝，空响应、截断、网络或落盘错误后停止，不自动重试。已生成正文和来源指纹逐条保存，可直接交给 `eval:pairwise`；默认结果为 `evals/results/generated-latest.json`，不进入 CI。

另外提供三个**显式选择**的合成验证案例：`validation-l2-touring-theatre`（巡演与署名）、`validation-l2-polar-expedition`（科考与样本许可）、`validation-l2-city-state-truce`（和谈与条件盟约）。它们不扩大默认 12 例，也不改变旧 Judge 校准来源；仅 `eval:generate` 和保存结果的 `eval:pairwise` 支持这些 ID。每例含 8 条 L1，仍使用生产 L2 的 8,000 Token 预算。它们不出现在教学示例中，但一旦用于候选分析，就不再是未来实验的未见留出集；不是专家人工金标准。

使用另一个 `STORY_ECHO_EVAL_VARIANT` 和新输出路径生成候选，再通过上节的有效校准文件进行成对比较。原 `eval:prompts` 仍保留生成 + 逐项评分的旧流程，但 A/B 校准通过不代表逐项评分也通过，不应混用两套结论。

`STORY_ECHO_EVAL_VARIANT` 默认 `production`。本地候选各自独立，不互相叠加：

- 历史组织实验已归档：候选组织规则已撤回，临时 `l1-pre-history-structure` 通用变体入口已移除。`npm run eval:history-structure` 只通过 `evals/history-structure-prompts.ts` 读取 v0.21.20 对照与失败候选两份冻结历史提示词，不随当前生产的事实取舍或证据边界调整而变化。工具使用原样总结和独立阅读器做两场景、两轮对照，最多 18 次串行请求，无重试，拒绝覆盖已有输出目录或静默改变提示词哈希。2026-09-20 实测两版各答对 32/32，但候选有一处事实确定性扩大，未通过验收；见[测试记录](PROMPT_EVAL_L1_HISTORY_STRUCTURE_EXPERIMENT.md)。该实验衡量整条组织规则，不能把结果单独归因于标题符号。
- `l1-lean-evidence-contract-v2`：冻结的历史 L1 证据契约，不包含后来加入的中性归档规则，因此与当前生产提示词不同；用于读取或复核旧结果。`l1-lean-evidence-contract` 保留冻结 v1，供历史消融复现。`l1-event-transition`、`l1-source-order` 与 `l1-adjacent-order-edges` 基于旧生产段落，名称仍可解析，但对 L1 用例会显式报“已归档”，防止误叠加。
- `l2-state-dedup`：L2 跨段状态去重；相同条件与状态只完整交代一次，更正、反转、条件变化及关键因果仍保留。当前证据不支持推广。
- `l2-evidence-boundaries`：L2 证据粒度与强度；防止把暗示、未交代和概括状态扩写为更具体事实，同时不删除或模糊来源已明确的信息。不包含评测剧情的专名或答案。
- `l2-relationship-process`：仅改写 L2“保留变化过程”那一条原则，把来源中行为/表态、对方回应、边界/承诺及其条件明确列为需保留的关系推进；不以最终关系标签代替过程，也不补全人物内心。生产段落变化、重复或已替换时拒绝继续实验。
- `l2-source-faithful`：仅改写 L2 写作方式原则，优先沿用来源的关键事实与限定条件，用删除重复、合并更新完成压缩，减少重新概括和额外衔接。前面的覆盖要求与其他候选均不变；生产段落变化、重复或已替换时同样拒绝实验。
- `l2-binding-examples`：在完整生产 L2 prompt 后附两个独立的局部正反例，示范实体关系绑定和条件/完成阶段保留。示例不是本次剧情证据，也不规定整篇结构、字数或输出格式；不含开发/验证剧情答案，不与其他候选叠加。实测方案与结果见 [事实绑定实验](PROMPT_EVAL_BINDING_EXPERIMENT.md)。
- `l2-binding-scope`：以上一项为基础，只追加“约定与知情边界”短段，优先保留关键约定的原有限定，不补额外禁令或未指定的听者。两个教学示例、来源、rubric 与预算均保持不变；这是显式定义的后继候选，仍拒绝向已经变更的 system 二次叠加。见 [范围边界实验](PROMPT_EVAL_SCOPE_EXPERIMENT.md)。
- `l2-binding-contract` / `l2-binding-audience`：新一组独立对照。前者只保留原有两个示例和范围段落中的约定约束；后者再加一个“未指定听者、旁白事实、后来明确告知”的局部正反例。两组重新生成，唯一差别为这个示例块，不把上一轮同时更改两类约束的结果当成单因素对照。28 次生成后，候选的额外禁令重新出现，听者问题未改善，按预定门槛停止，不进入 Judge/长链或生产。见 [听者示例实验](PROMPT_EVAL_AUDIENCE_EXPERIMENT.md)。
- `l2-contract-only`：最小消融，只在生产 L2 追加原样保留的约定范围句及小标题，不包含任何教学示例；与 `l2-binding-contract` 是不同候选，不改变历史名字的含义或保存指纹。28 次生成后目标错误未改善，另出现星盘遗漏和同居断言，未进入 Judge/长链，不采用。见 [约定范围最小消融](PROMPT_EVAL_CONTRACT_ONLY_EXPERIMENT.md)。
- `l2-statement-events`：只追加“重要实际表态/回应不能被内心感受、最终标签或客观结果替代”的通用段落，并禁止补写未说明的听者和表达方式。七例各两轮均保留目标表态，但固定生产基线也全部保留；候选两轮仍把客观证明边界写成人物发言，并有范围、因果和动机扩写，未进入 Judge/长链，不采用。见 [重要表态保留实验](PROMPT_EVAL_STATEMENT_EVENTS_EXPERIMENT.md)。
- `l2-integrated-evidence-events`：不追加段落，只把生产 L2 的前两条保真原则替换为等行数、略短的结果导向规则；保留原覆盖契约，并把重要表态、回应与“旁白事实不能变成人物发言”纳入同一证据边界。实验方案与结果见 [L2 整合证据规则实验](PROMPT_EVAL_L2_INTEGRATED_PRINCIPLES_EXPERIMENT.md)。

各变体仅修改目标层级的提示词，其他层级、Token 硬上限及来源/rubric 不变。变体选择逻辑只在 `evals/` 内使用，不导入浏览器 bundle。候选或对照存在不代表已通过质量验收。

```bash
STORY_ECHO_EVAL_CASES='l2-relationship-reversal,l2-ten-source-parallel-arcs,l2-campus-ensemble-and-slow-burn,l2-cultivation-resources-and-oaths' \
STORY_ECHO_EVAL_VARIANT=l2-state-dedup \
STORY_ECHO_EVAL_OUTPUT=evals/results/candidate.json \
npm run eval:prompts
```

随后使用相同用例与 `production` 生成另一份结果，做 A/B 盲评。候选标识和实际提示词哈希会写入结果，评测不会自行修改生产 prompt。默认长链与 A/B 的本次实测见 [推进记录](PROMPT_EVAL_NEXT_STEPS.md)。

## 可选环境变量

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `STORY_ECHO_EVAL_TIMEOUT_MS` | `300000` | 单次生成请求超时 |
| `STORY_ECHO_EVAL_JUDGE_TIMEOUT_MS` | 生成请求超时 | 单次 Judge 请求超时 |
| `STORY_ECHO_EVAL_MAX_TOKEN_FIELD` | `max_tokens` | 可改为 `max_completion_tokens` |
| `STORY_ECHO_EVAL_JUDGE_MAX_TOKEN_FIELD` | 继承生成连接 | Judge 使用的 Token 字段 |
| `STORY_ECHO_EVAL_JUDGE_OUTPUT_MODE` | `text` | `json_schema` 为逐项和 A/B Judge 启用严格结构化输出；不支持时不回退 |
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
