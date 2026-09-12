# ST-StoryEcho

StoryEcho 是一个面向 SillyTavern 长篇角色扮演聊天的上下文管理扩展。它只保留一项产品功能：

> 启用 StoryEcho 上下文管理

启用后，插件用“近期原文 + 递归分层总结”替代无限增长的完整聊天历史。插件不抽取剧情记忆，不生成 Embedding，不访问 Vector Storage，也不执行动态召回。

## 工作方式

设：

- `W`：始终保留的最近原文窗口，默认 10 轮；
- `N`：每条 L1 阶段总结覆盖的完整轮数，默认 10 轮；
- `G1`：L1 的合并组大小，默认 10 条；
- `G+`：L2 及以上层级的合并组大小，默认 5 条。

每次正常生成前，StoryEcho 只会裁剪已经被总结完整覆盖的原文。后台尚未追上、总结失败或来源发生变化时，对应原文继续保留，因此不会用缺失的总结换掉真实聊天内容。

窗口外历史累计满 `N` 个完整“用户 + AI”轮次后生成一条 L1。某一层拥有“组大小 + 1”条总结时，插件把这一层最老的一整组压缩为下一层，保留刚到达的新条目：

```text
L1(1)…L1(10) + L1(11)
→ L2(1-10) + L1(11)

L2(1-10)…L2(41-50) + L2(51-60)
→ L3(1-50) + L2(51-60)
```

压缩始终从最低溢出层开始，并可继续向更高层级级联。当前时间线前沿的全部有效总结都会按时间顺序随角色请求发送；旧历史随着层级升高而逐步变得更紧凑，总结条目总数随聊天长度近似对数增长。

进入新篇章不会清空仍有效的旧 L1；换场景后，旧约定、身份与资源归属等仍由历史总结携带。

L1 和 L2+ 分别使用独立的输出上限，默认 3000 / 8000 Token；接口层统一硬上限为 16000 Token。提示词要求模型按实际信息量自主收束，不把这个接口预算作为目标篇幅告诉模型。

选择 Gemini 模型时，L1 会优先完整覆盖本批独有的重要剧情，并在原文后重申起因、关键互动、结果和未决事项的交付要求，减少只保留总体走向或最新状态的过度压缩。此适配按实际接收请求的模型选择，支持主连接、自定义连接及失败回退；L2+ 的合并提示词不受此适配影响。它不设固定最低字数，也不因短总结自动重试，实际覆盖改善仍需用原始剧情核验。[Gemini 提示建议](https://ai.google.dev/gemini-api/docs/prompting-strategies#gemini-3)

各层总结都使用中性归档规则：成人自愿亲密剧情保留必要事件、关系变化、边界、承诺和后果，以非露骨措辞概述，省略身体细节、动作过程和感官描写；年龄、同意与关系性质不从来源外补写。该规则用于明确归档任务，不保证所有模型或代理都接受原始输入，目前尚未针对具体模型完成拒绝率对照实测。

明确的接口拒绝／内容过滤标记（包括 Gemini 的 `promptFeedback.blockReason`、`SAFETY`）及常见的模型拒绝开场会作为失败处理，不保存为总结、不推进覆盖游标，也不替换已有高层来源。失败时未覆盖原文继续保留。纯文本拒绝识别是保守规则，无法覆盖所有模型措辞；普通剧情中的拒绝、边界和不确定性仍是有效事实。

总结可以选择参考：

- 蓝灯常驻条目优先选择，剩余容量再用于当前批次直接命中的绿灯条目；
- 蓝灯与绿灯合计最多 50000 字符，绿灯条数可配置、默认最多 20 条。

世界书只作为设定背景，不证明剧情已经发生。

世界书按蓝灯优先、绿灯使用剩余预算选取。装不下的整条内容会跳过并记录原因，继续尝试后面的条目，不占用最终绿灯条数名额。世界书读取超过 5 秒会降级为仅使用剧情来源，任务取消会立即让行；参考 Token 数使用本地估算，不等待宿主 Tokenizer。

## 请求结构

StoryEcho 在请求期临时插入一条中立的 system/narrator 消息，不写入聊天记录。消息中按剧情时间排列当前总结前沿：

```text
<story_echo_summary>
总结层级：L3
来源消息：0～499
较早历史的高层总结
</story_echo_summary>

<story_echo_summary>
总结层级：L1
来源消息：500～519
较近历史的阶段总结
</story_echo_summary>

近期原文
当前用户输入
```

发生冲突时，采用时间更近且证据更明确的内容：

```text
当前用户输入 > 近期原文 / MVU 变量 > 较近或较低层总结 > 较早或较高层总结
```

## 设置与管理

- 启用 StoryEcho 上下文管理；
- 最近原文窗口及单位；
- 每条 L1 覆盖的轮数；
- L1 与 L2+ 的合并组大小；
- L1 与 L2+ 的输出 Token 上限；
- 世界书参考开关与绿灯条目上限；
- SillyTavern / Luker 主连接、已保存的连接插头或自定义 OpenAI 兼容 LLM；
- 调试记录。

设置页还提供手动处理窗口外历史、立即整理层级、完整重建，以及各层总结的搜索、分页、编辑、删除和重新生成。诊断区域展示最近一次真实角色请求的输入 Token 构成、运行统计、裁剪记录和已脱敏报告。

达到输出上限的总结仍会保存并显示红框。新合并会向高层传递来源截断风险，区分“输出截断”与“来源可能不完整”，并列出可能受影响的消息范围；高层重新生成正常结束也不会自动消除来源风险。此元数据不发送给模型，最多保留 32 段范围（超出后保守合并尾部范围）。旧高层快照未记录的历史截断原因无法追溯恢复。

## LLM 连接

默认复用 SillyTavern 当前主连接。后台总结会在酒馆公开相应设置钩子时临时关闭高成本思考并使用低推理，不修改用户预设。普通模型沿用确定性采样；Gemini 3.x 按官方建议省略 `temperature`、`top_p` 和 `top_k`，交由模型默认值处理，避免强制温度 0。这是请求参数适配，不代表已证明某次短总结的具体原因。[Gemini 3.x 参数建议](https://ai.google.dev/gemini-api/docs/whats-new-gemini-3.5#sampling-parameters-no-longer-recommended)

也可以配置自定义 OpenAI 兼容接口。请求仍由 SillyTavern 的 Chat Completions 后端转发，浏览器不会直接把 API Key 发给第三方域名。自定义连接失败时可选择回退主连接。

“连接来源”还会列出宿主已保存的全部连接插头，可直接选择聊天补全或文本补全连接独立用于 L1 与高层总结，不会切换当前聊天的主连接。StoryEcho 只保存插头 ID，凭据由宿主连接管理器解析；插头重命名、更新或删除后列表会刷新。向量、重排、未知接口或不可用插头会显示但不能选用，已选插头删除后会明确报错，不自动回退。

独立插头请求使用宿主 `ConnectionManagerRequestService` 的非流式接口，避免受影响 Luker 版本共享流式解析器的推理状态缺失问题；不载入角色扮演生成预设，文本补全保留该插头的 instruct 格式。主连接流式路径则补齐 OpenRouter 推理详情与 Anthropic 思考块状态。两种路径均保留超时与取消处理。

自定义 Key 明文保存在当前 SillyTavern 用户的 `extensionSettings.story_echo` 中，以便刷新和多端同步。请使用限额、限权、可撤销的独立 Key。同页面其他扩展以及能读取酒馆用户设置的人可能看到它；Key 不会进入聊天元数据或诊断报告。

## 数据与一致性

每个聊天在 `chatMetadata.story_echo` 中独立保存：

- 各层总结及其层级、来源范围、来源哈希、直接子总结快照和更新时间；
- 覆盖游标、完整重建草稿；
- 运行统计、最近检查记录和有界调试轨迹。

编辑、删楼、Swipe、分支切换或聊天重命名时，插件会重新校验派生内容。来源不一致时，从第一个受影响范围起失效并重新处理；生成期间只要原文或总结前沿变化，本次结果就不会提交。

从旧版本升级时，旧阶段总结迁移为 L1；旧全局骨架直接丢弃。旧的记忆、向量队列及 Embedding 配置同样不会保留。

## 只读公共 API

其他扩展可以读取 StoryEcho 当前聊天的总结前沿、覆盖状态和最近一次实际注入，但不能通过该接口修改任何状态。Luker 会将接口注册为 `story-echo`；普通 SillyTavern 可以使用同一个全局后备入口：

```js
const context = globalThis.SillyTavern?.getContext?.();
const api = context?.getExtensionApi?.('story-echo')
  ?? globalThis.StoryEcho?.api;

const frontier = api?.getFrontier() ?? [];
const coverage = api?.getCoverage() ?? null;
const lastInjection = api?.getLastInjection() ?? null;

const unsubscribe = api?.onStateChanged((change) => {
  console.log(change.reason, change.frontier);
});
```

- `getFrontier()` 返回当前有效、按剧情时间排列且可能随请求携带的总结；
- `getCoverage()` 返回当前聊天、覆盖游标、层级数量及重建状态；读取尚无 StoryEcho 状态的聊天不会创建状态或写入元数据；
- `getLastInjection()` 返回当前页面会话中、当前聊天最近一次真正插入请求的 StoryEcho 文本；刷新页面或切换聊天后为 `null`，不把重复正文写入聊天元数据；
- `onStateChanged()` 在上述公开快照发生变化时通知调用者，并返回可重复调用的取消订阅函数。

所有返回对象及数组都是冻结的防御性副本。API 版本见 `api.apiVersion`，StoryEcho 版本见 `api.extensionVersion`。

## 开发

```bash
npm install
npm run typecheck
npm test
npm run build
npm run test:coverage
```

构建产物是 `dist/index.js` 和 `dist/index.js.map`。发布时需同步更新 `package.json`、`manifest.json`、源码常量及静态资源查询参数中的版本号。

提示词质量评测使用独立的本地真实 LLM 命令，不属于 `check` 或 GitHub CI。API Key、模型和 OpenAI Chat Completions 兼容接口均从环境变量读取：

```bash
STORY_ECHO_EVAL_API_KEY='...' \
STORY_ECHO_EVAL_MODEL='your-model' \
STORY_ECHO_EVAL_BASE_URL='https://api.openai.com/v1' \
npm run eval:prompts
```

生成模型与 Judge 可以分别配置。另有 `npm run eval:calibrate` 检查 Judge 对好坏对照的判定及分数稳定性，`npm run eval:chains` 检查真实生成的 L1→L2→L3 是否仍能回答连续性问题。评测夹具、评分阈值、用例筛选和本地基线用法见[提示词质量评测](docs/PROMPT_EVALS.md)。这些命令仅用于本地，结果默认写入被 Git 忽略的 `evals/results/`。

## 设计文档

- [产品规格](docs/PRODUCT_SPEC.md)
- [架构说明](docs/ARCHITECTURE.md)
- [安全边界](docs/SECURITY.md)
- [只读公共 API](docs/PUBLIC_API.md)
- [当前状态](docs/STATUS.md)
- [提示词质量评测](docs/PROMPT_EVALS.md)

## License

MIT
