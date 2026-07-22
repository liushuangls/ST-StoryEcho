# StoryEcho 技术架构

## 1. 总体结构

```text
SillyTavern聊天
  |
  +--> StageSummaryService --> 独立阶段总结条目
  |            |
  |            v
  |      StorySkeletonService --> 全局剧情骨架
  |
  +--> ChunkPlanner ---------> 待处理历史块
  |                               |
  |                               v
  |                         MemoryExtractor
  |                               |
  |                               v
  |                         MemoryReconciler
  |                               |
  |                  +------------+-------------+
  |                  |                          |
  |                  v                          v
  |            chatMetadata              Vector Storage
  |            剧情事件本体              检索文本和向量
  |                  |                          |
  +--> QueryBuilder -+--------------------------+
                            |
                            v
                         Retriever
                            |
                            v
                      ContextBudgeter
                            |
                            v
                      PromptInterceptor
                            |
                            v
                         主LLM请求
```

### 1.1 功能分层与依赖

运行时分为两个明确层级：

```text
StoryEcho 上下文管理（settings.enabled）
  依赖：LLM
  能力：最小原文窗口 + 阶段总结 + 全局剧情骨架 + 安全裁剪

剧情记忆与召回（settings.memory.enabled）
  前提：上下文管理已开启
  额外依赖：Embedding + Vector Storage
  能力：自动抽取 + 整理/取代 + 向量同步 + 查询改写 + 动态召回注入
```

阶段总结拥有独立覆盖游标和来源哈希，不得依赖剧情索引游标才能推进。提示词裁剪边界按模式计算：

```text
基础模式：min(最小原文窗口边界, 阶段总结覆盖边界)
记忆模式：min(最小原文窗口边界, 阶段总结覆盖边界, 剧情索引覆盖边界)
```

关闭剧情记忆层只停止该层的自动任务和请求级使用，不清空 `chatMetadata` 中的记忆，也不清理服务端向量集合。再次开启时沿用现有来源指纹执行分支/编辑校验和 Embedding 指纹校验，再从未覆盖位置追赶。

设置模型内部可以继续保持抽取、向量和召回模块解耦，但产品层只暴露一个 `memory.enabled` 开关，避免用 `maxEvents=0` 等参数隐式表示功能关闭。

## 2. 模块划分

建议源码结构：

```text
src/
  index.ts
  core/
    types.ts
    errors.ts
    logger.ts
  settings/
    defaults.ts
    repository.ts
  llm/
    provider.ts
    main-provider.ts
    openai-compatible-provider.ts
    prompts.ts
    schemas.ts
  memory/
    repository.ts
    chunk-planner.ts
    extractor.ts
    reconciler.ts
    invalidation.ts
  summary/
    service.ts
    prompts.ts
    skeleton-service.ts
    skeleton-state.ts
    skeleton-prompts.ts
  vector/
    adapter.ts
    openai-compatible-embedding.ts
    sillytavern-vector-store.ts
    url.ts
  retrieval/
    query-builder.ts
    retriever.ts
    ranker.ts
    budgeter.ts
  prompt/
    window.ts
    interceptor.ts
    renderer.ts
  ui/
    settings-panel.ts
    inspector.ts
```

核心层不直接访问 DOM，也不直接依赖 SillyTavern 内部模块。所有平台能力通过 Adapter 注入。

## 3. 数据模型

```ts
type MemoryType =
  | 'event'
  | 'state_change'
  | 'relationship_change'
  | 'commitment'
  | 'revelation'
  | 'clue'
  | 'conflict';

type TruthStatus = 'confirmed' | 'claimed' | 'inferred' | 'uncertain';
type MemoryStatus = 'active' | 'resolved' | 'superseded' | 'invalid';
type ConsolidationOperation = 'CREATE' | 'MERGE' | 'UPDATE' | 'RESOLVE' | 'SUPERSEDE' | 'IGNORE';

interface StoryMemorySource {
  startMessageId: number;
  endMessageId: number;
  sourceHash: string;
}

interface StoryMemory {
  id: string;
  type: MemoryType;
  source: StoryMemorySource;
  sourceMessageIds: number[];
  sourceHistory: StoryMemorySource[];
  scene: {
    location?: string;
    time?: string;
    participants: string[];
  };
  event: string;
  cause?: string;
  consequence?: string;
  entities: string[];
  aliases: string[];
  stateChanges: Array<{
    entity: string;
    attribute: string;
    before?: string;
    after: string;
  }>;
  unresolvedThreads: string[];
  knownBy: string[];
  truthStatus: TruthStatus;
  importance: number;
  status: MemoryStatus;
  retrievalText: string;
  injectionText: string;
  vectorHash: number;
  retrievalHash: string;
  pinned: boolean;
  excluded: boolean;
  manuallyEdited: boolean;
  supersedesMemoryIds: string[];
  replacedByMemoryId?: string;
  lastOperation: ConsolidationOperation;
  createdAt: string;
  updatedAt: string;
}
```

聊天级元数据：

```ts
interface StoryEchoChatState {
  schemaVersion: 1;
  chatUuid: string;
  ownerChatId: string;
  vectorCollectionId: string;
  indexedThroughMessageId: number;
  indexedThroughHash: string;
  indexedPrefixHash: string;
  stageSummary: {
    entries: Array<{
      text: string;
      sourceStartMessageId: number;
      sourceEndMessageId: number;
      sourceHash: string;
      updatedAt: string;
      manuallyEdited?: boolean;
      deleted?: boolean;
    }>;
    coveredThroughMessageId: number;
    coveredThroughHash: string;
    updatedAt?: string;
  };
  storySkeleton: {
    text: string;
    coveredThroughMessageId: number;
    sourceHash: string;
    updatedAt?: string;
    manuallyEdited?: boolean;
    stale?: boolean;
  };
  memories: StoryMemory[];
  pendingRanges: Array<{ startMessageId: number; endMessageId: number }>;
  pendingVectorHashes: number[];
  pendingVectorDeleteHashes: number[];
  vectorFingerprint: string;
  metrics: StoryEchoMetrics;
  debugTraces: StoryEchoDebugTrace[];
  lastInspection?: InspectionRecord;
}
```

`stageSummary.entries` 保存按来源范围连续排列的独立总结条目。每个条目生成后不再被后续批次重写；`coveredThroughMessageId` 和 `coveredThroughHash` 指向最后一段已压缩来源。人工编辑保留来源范围和哈希。删除最新条目会移除物理尾部并回退覆盖游标；删除更老条目会保留 `deleted=true`、空正文的覆盖墓碑，注入和状态影子计算都跳过它，但裁剪仍把该来源视为已压缩。0.8.x 的单份滚动总结升级时会保留为第一条兼容条目，不丢失已压缩历史。

`storySkeleton` 保存由阶段总结维护的全局剧情骨架。`coveredThroughMessageId` 与 `sourceHash` 精确标记已经折叠进骨架的阶段总结前缀；人工正文可编辑但不可删除或置空。来源哈希、配置上限或聊天分支不再匹配时设置 `stale=true`：正文继续保留供用户核对，但拦截器停止注入，并在满足归档触发条件后从当前阶段总结干净重建。

## 4. 权威数据与缓存

数据优先级：

1. 原始聊天消息是事实来源。
2. `chatMetadata.story_echo` 是全局剧情骨架、阶段总结与剧情记忆的权威存储。
3. Vector Storage 是可重建索引。
4. 运行时检索结果仅存在内存。

设置页的元数据管理器只通过 `MemoryRepository` 修改权威数据。保存时执行与 LLM 输出相同的枚举、长度和结构校验，重新计算 `logicalKey`；`retrievalText` 变化时分配新向量哈希并排队删除旧哈希。人工编辑项设置 `manuallyEdited=true`，自动整理不会覆盖。删除操作先移除权威记忆并把旧哈希加入删除队列；“重建自动元数据”先成功清空服务端集合，再删除自动项、保留人工项并从窗口外原文重新抽取。

Vector Storage 丢失、损坏或更换模型时，使用每条记忆的 `retrievalText` 重建。不得从向量索引反向恢复剧情记忆。

`vectorFingerprint` 是来源、模型和有效端点参数的 SHA-256，不保存这些参数原文。指纹变化时先记录全部待同步哈希，再清空当前聊天集合并重建，避免同一集合混用不同维度或模型的向量。

## 5. Vector Storage适配

每个聊天分支使用独立集合：

```text
story_echo_<chatUuid>_v<schemaVersion>
```

写入项：

```ts
interface VectorItem {
  hash: number;  // StoryMemory.vectorHash
  text: string;  // StoryMemory.retrievalText
  index: number; // source.endMessageId
}
```

使用服务端接口：

- `POST /api/vector/insert`
- `POST /api/vector/query`
- `POST /api/vector/list`
- `POST /api/vector/delete`
- `POST /api/vector/purge`

由于当前接口只支持有限元数据，`vectorHash -> StoryMemory.id` 映射保存在聊天元数据。生成哈希时必须检测当前聊天内碰撞，发生碰撞则加入稳定盐后重算。

向量来源选择原则：

- 默认复用 SillyTavern Vector Storage设置；
- 可选择StoryEcho自定义OpenAI兼容Embedding，或火山方舟多模态Embedding；
- 自定义模式由浏览器通过SillyTavern内置`/proxy/`请求远程Embedding API并校验返回向量；
- 远程API返回的预生成向量通过SillyTavern现有WebLLM输入通道交给Vector Storage，`insert/query/list/delete/purge`仍由酒馆服务端完成；
- 自定义模式使用独立模型作用域，不与用户真正的WebLLM集合混用；
- 服务端 `transformers`、Ollama或远程Embedding提供方均可；
- 查询和写入封装在 `VectorStoreAdapter` 后面，避免业务代码依赖内部请求格式。

### 5.1 自定义OpenAI兼容Embedding

```text
剧情检索文本
  -> 浏览器调用同源/proxy/<自定义embedding endpoint>
  -> SillyTavern服务端请求外部Embedding API
  -> OpenAI兼容API返回预生成向量
  -> POST /api/vector/insert 或 /api/vector/query
  -> SillyTavern Vector Storage保存/检索
```

请求使用标准 `{ input: string[], model }`，Bearer Key可选，并校验返回数量、顺序、有限数值和统一维度。Base URL会规范化为 `/embeddings`：空路径默认补 `/v1/embeddings`，已有路径（例如方舟 `/api/v3`）直接补 `/embeddings`。外部地址只在请求时自动添加酒馆 `/proxy/` 前缀；同源地址保持直连以避免循环代理。

### 5.2 火山方舟多模态Embedding

火山方舟 `/embeddings/multimodal` 不使用OpenAI Embeddings的批量结构：多个`input`成员表示一份多模态内容，而不是多条独立文本。因此StoryEcho为每段剧情文本分别发送一次`{ type: "text", text }`请求，以最多4个并发请求取得`data.embedding`，再按原输入顺序交给同一套Vector Storage预生成向量通道。模型、Endpoint ID、Base URL和Key独立于OpenAI兼容来源保存。

API Key保存在SillyTavern当前用户的 `extensionSettings.story_echo`，以明文换取持久化和多端同步。Key和超时不进入向量配置指纹；端点或模型变化会改变 `vectorFingerprint` 并触发当前聊天集合重建，单纯轮换Key或调整超时不会重建。

## 6. LLM Provider

统一接口：

```ts
interface LlmRequest {
  system: string;
  prompt: string;
  jsonSchema?: object;
  signal?: AbortSignal;
}

interface LlmProvider {
  readonly id: 'main' | 'openai-compatible';
  complete(request: LlmRequest): Promise<string>;
  testConnection(): Promise<void>;
}
```

所有 JSON 任务通过统一的结构化调用层执行三级协商：`deepseek-*` 优先 JSON Object，其他自定义模型优先 JSON Schema，两种结构化模式之后才是普通模式 + 明文 Schema/示例。Provider 异常、空输出、JSON 解析失败或本地校验失败时进入下一层；自定义 Provider 三层均失败后，才按设置回退主连接。详细顺序见 [PIPELINE_V2.md](PIPELINE_V2.md)。

### 6.1 主连接

默认 Provider 调用 `SillyTavern.getContext().generateRaw()`：

- 使用用户当前主连接、模型和密钥；
- 不切换连接配置；
- 使用独立 system prompt；
- 只把 StoryEcho 提供的 system prompt 和任务 prompt 交给 `generateRaw`，不走正常角色上下文组装；
- 不携带角色卡 system/jailbreak、作者注释、示例对话、欢迎语、主提示词或 Prompt Manager 提示内容；
- 继续使用当前连接/模型/采样参数，文本补全 API 仍使用当前 instruct 格式；
- 从酒馆上下文的 `mainApi`、`chatCompletionSettings` 与 `getChatCompletionModel()` 读取当前来源和精确模型名；`deepseek-*` 主连接优先 JSON Object，其他模型优先 JSON Schema，能力不匹配的层级会跳过，最后使用普通 JSON；
- 酒馆的 raw prompt 事件仍会触发，因此其他扩展若主动监听并改写该事件，可能影响后台请求；
- 抽取调用标记为后台任务，不触发 StoryEcho 自己的生成拦截。

### 6.2 自定义 OpenAI兼容接口

配置：

```ts
interface OpenAiCompatibleConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
  fallbackToMain: boolean;
}
```

自定义Provider复用SillyTavern自带的Custom Chat Completions后端：

```text
浏览器扩展
  -> POST /api/backends/chat-completions/generate
  -> SillyTavern服务端
  -> <Base URL>/chat/completions
```

StoryEcho向同源后端提交 `chat_completion_source: "custom"`、模型、消息、规范化Base URL和可选Authorization Header；SillyTavern负责拼接 `/chat/completions`并请求外部接口。JSON Object 通过 `custom_include_body` 透传 `response_format.type=json_object`；`deepseek-*` 优先使用它，其他模型则优先酒馆的 `json_schema` 格式，最后都退回明文 JSON。Key保存在扩展设置中并会经过前端运行时，不具备SecretManager隔离，但无需额外安装服务端插件。

### 6.3 Base URL规范化

接受：

```text
https://example.com
https://example.com/v1
https://example.com/v1/chat/completions
```

统一转换为SillyTavern Custom后端所需的唯一Base URL，禁止重复拼接 `/chat/completions`。默认拒绝非 HTTP(S)协议。是否允许局域网 HTTP由用户明确开启。

### 6.4 分批阶段总结

`StageSummaryService` 顺序读取尚未覆盖、且已经离开最小原文窗口的连续消息。默认累计 10 个完整“用户 + AI”轮次后，向当前 LLM Provider发送：

```text
紧邻上一条总结末尾（最多 5000 字符，仅作连续性参考）
下一批原始聊天（本批较新事实的最高依据）
-> 一条只描述这一批历史的新阶段总结
```

输出是按原作题材组织的自然剧情纪要，不承担精确实体检索，也不要求固定标题或栏目。模型可按时间、因果、人物成长、关系或势力线自由分段；常规批次约 `1000–1600` 个中文字符，多线复杂批次可扩展到约 `2200` 字符。修仙或玄幻剧情优先保留境界、功法、突破、传承、资源、宗门和师徒同伴关系。Assistant推断、反问、角色主张和未证实解释在自然文本中保持来源与确定程度。紧邻上一条总结只提供跨批次的时间、人物、目标和未完因果，既有条目本身保持不可变，全局骨架也不会进入阶段总结请求。每批总结原文以 `100000` 字符为目标上限，只在完整轮次边界提前收束，单个超过上限的完整轮次仍会整体保留并记录调试轨迹。每批还通过与骨架共用的历史世界书构建器加入蓝灯常驻完整条目（最多 `20000` 字符）和仅由本批清洗后原文命中的绿灯完整条目（最多 `10000` 字符）；两组独立裁剪、不受抽取参考 Token 预算再次缩短，并作为设定背景。总结请求会从本批已有结构化记忆中构造最多 4000 字符的 `authoritative_facts`：只纳入当前版本来源完整落在本批内的 active/resolved confirmed User/Mixed状态、承诺、关系或揭示，以及Assistant明确给出 `before → after` 的剧情推进；累积来源中的旧版本、superseded记录和普通Assistant猜测不进入账本。空间不足时先选择明确转移、较高来源权威和较新事实，选完再按时间顺序呈现。该块只用于消解批内冲突，原始楼层仍是叙事来源。保存新条目前必须再次计算本批原文哈希；哈希不一致、输出为空、过长或请求失败时不追加条目，也不推进覆盖游标。调试模式记录原文字符数、蓝灯/绿灯条目数与字符数、上一条总结字符数、截断状态及最终请求的字符数和估算 Token。AI 回复写入聊天后，后台队列最多处理一批抽取和一批总结；下一次生成不进行同步追赶，任何未覆盖范围都继续保留原文。主动处理历史可持续追赶所有完整批次，但不足 `N` 轮的尾段继续保留原文。

设置页的“重建全部阶段总结与骨架”从消息 `0` 开始按当前 `N`、显式阶段边界与来源上限重新生成全部可归档阶段总结。草稿阶段不改写聊天元数据；所有总结批次成功且旧总结、旧骨架与聊天来源快照均未变化后，才一次性替换总结集合并把旧骨架标为过期。任一批失败会保留完整旧集合。随后使用新总结执行骨架干净重建。

User 明确结束上一剧情阶段并开始新阶段时，总结规划器会在边界前提前收束上一批，即使该批不足 `N` 轮也不会跨阶段混合。当前阶段请求默认省略边界前的自动总结；User 明确回顾较早阶段时才恢复。该判断只依赖 User 的显式阶段转换，不把普通换场、时间推进或新增线索当作边界。

三个配置互相独立：`W` 是最小原文窗口，`N` 是每条总结覆盖的目标轮数，`S` 是正常角色请求最多携带的最近总结条数。所有条目保存在聊天元数据中；`S` 只限制请求注入，不删除较早条目。

实际可裁剪边界是以下三项的最小安全覆盖范围：阶段总结游标、剧情抽取游标、配置的最小原文窗口。任何一个后台管线落后，都扩大本次原文窗口而不是丢失未处理历史。

### 6.5 全局剧情骨架

`StorySkeletonService` 维护一份始终可见的长期剧情史与剧情大纲。新聊天在首次出现归档条目（第 `S + 1` 条有效总结）时立即构建；已有长聊天在加载稳定约 3 秒后自动补建。首次构建从旧到新读取当时全部有效阶段总结，不使用 `S` 过滤来源。已有有效骨架每当一条尚未覆盖的阶段总结首次滑出最近 `S` 条窗口时立即更新；自动任务每次吸收最老的一条，手动“处理窗口外历史”和“立即更新”依次处理全部积压。

增量请求严格包含当前旧骨架和一条首次归档、尚未覆盖的阶段总结。首次生成与显式重新生成都从全部有效阶段总结开始，按旧到新分成每批最多 `80000` 字符；第一批从空骨架生成，后一批使用前一批的临时输出继续折叠。显式重新生成以当前阶段总结作为内容来源，所有批次成功且来源快照未变化后才原子提交，因此中途失败仍保留原骨架。该上限与阶段总结生成自身的 `100000` 字符来源上限相互独立。每批骨架只请求一次 LLM：主提示词同时要求题材自适应、长期事件筛选、实体与能力归属核对、确定程度保持、关系事件化和全篇语义去重。本地在提交前只校验非空、Token 上限、聊天所有者、阶段总结来源快照和人工骨架修订是否变化，不再追加第二次事实校对或文风润色请求。输出按原作题材自然组织重要历史事件、篇章和主线发展、重大因果、成长与关系转折、资源流转、揭示修正与未决伏笔；人物只以推动事件的参与者出现，NPC档案、当前数值与即时状态由世界书、MVU变量和后续近期上下文承担。

阶段总结与骨架共用同一历史世界书策略。骨架首次生成、增量更新和重新生成的每一批都会从当前聊天关联世界书中加入蓝灯常驻条目（完整条目合计最多 `20000` 字符）以及本批来源直接命中的绿灯条目（完整条目合计最多 `10000` 字符）。两组独立裁剪，不受剧情处理参考 Token 预算再次缩短；是否启用仍由剧情处理参考模式控制，绿灯条目数量仍服从对应配置。阶段总结的关键词匹配只扫描本批清洗后原文；骨架匹配只扫描本批阶段总结；两者都不用旧骨架、临时草稿或其他批次关键词激活条目。背景只解释规则、专名、人物身份、地点和能力体系，不作为历史事件或当前状态的证据。默认骨架输出上限 5000 Token，配置范围 512–10000；主连接和自定义Provider的请求上限同步允许 10000，避免设置层与实际响应预算不一致。空输出、超限、聊天切换或来源变化都拒绝提交。

骨架每次提交记录它连续覆盖的最后一条阶段总结消息 ID，以及该阶段总结前缀的 SHA-256。首次生成和重建会覆盖当时全部有效阶段总结；覆盖游标保证这些总结日后进入归档时不会重复吸收。最近 `S` 条始终作为近期层直接注入，尚未合并的归档总结也继续直接注入，直到后续成功合并后才移除，因此后台失败和前台让行不会造成信息空洞。阶段总结编辑、删除、Swipe、删楼、分支变化或下调骨架上限会把现有骨架标记为过期；过期正文保留且可编辑，但不参与请求，等待按当前来源从阶段总结干净重建。

人工编辑必须通过与自动输出相同的非空和Token上限校验，可自由改写与分段。人工版本设置 `manuallyEdited=true`，自动增量更新把它作为权威基线；没有单独的删除操作。

## 7. 抽取管线

### 7.1 场景切块

当前按用户消息计数切块：

- 每批目标轮数可在设置中调整，默认 5轮；
- 只有累计满配置数量的完整“用户 + AI”轮次才调用抽取 LLM；不足一批不推进游标，原文继续保留；
- 单块目标上限 32,000字符，并且只在完整轮次边界截断；单个超长轮次整体保留；
- 当前最小原文窗口内的消息暂不强制抽取；
- 索引游标确保每条消息只进入一个成功提交的分块，失败范围保留待重试。

后续由 LLM或规则检测地点、时间和参与者变化。

### 7.2 候选抽取

输入仅包含：

- 当前历史块；
- 抽取规则；
- JSON Schema。

历史块过滤聊天数组里的 system 消息，并在其前加入独立的 `story_echo_reference_context`。Assistant 消息会先删除 `<think>/<analysis>`、思考详情和 HTML 注释；存在 `<正文>`、`<now_plot>` 或 `<content>` 时只取可见剧情正文。该清洗只作用于后台请求副本，不修改聊天记录；User 原文保持最高权威且不做标签清洗。参考上下文默认总预算 3000 Token，角色卡最多优先使用 1200 Token，只读取身份、Persona、描述、性格与场景；其余预算用于当前聊天实际关联世界书中被该历史批次直接命中的最多 5 条。匹配使用清洗后的待抽取快照而不是当前聊天末尾，且不纳入 constant/强制条目。角色卡 system/jailbreak、作者注释、示例对话、欢迎语、主提示词、阶段总结、动态召回和 Prompt Manager 预设不在输入中。

参考块被标记为不可信只读数据，只能辅助实体、别名、地点和专名消歧。抽取 Schema 要求每个候选返回 `sourceMessageIds`；质量门只接受当前 `history_messages` 范围内的非 system 消息 ID，随后将精确楼层写入记忆元数据。没有有效聊天来源的候选不进入整理和向量管线。主连接的连接/模型仍然生效；Chat Completion 设置可用时后台任务关闭高强度推理并将 temperature 设为 0、top_p 设为 1，文本补全 API 仍可能套用 instruct 格式。其他扩展也可能通过酒馆公开的 raw prompt 事件修改请求。

输出分类候选，不直接写入存储。根结构按剧情、状态、关系、承诺、揭示和线索分类；剧情与冲突保持完整场景及因果链，不再按实体或标点通用原子化。状态只按“完整实体 + 规范状态槽”拆分，关系只按关系边拆分，承诺只按稳定承诺键拆分。位置和持有者禁止合成一个“保管状态”；若模型仍返回“存放于X，由Y保管”，本地会拆为位置与持有者两槽。唯一的字母数字编号（如 `R-1/G17/DO23`）会成为稳定主体键，从而统一编号简称与带描述全名，同时不影响“青石/青石台”这类普通完整专名。模型不再重复生成三份相似的事件、检索和注入文本；后两者由本地按类型确定性构造。

类型归一化后先在本地展开最多60条供质量门评估：无持续结构、低重要度的普通事件会被拒绝；带原因、结果、状态变化、未解决线索或明确知情范围的事件会获得最低重要度校正。`unresolvedThreads`还必须能在源片段中找到明确疑问、未解状态或待办目标信号；模型仅因信息缺失而杜撰的“去向不明”“内容未知”会被移除。最后才从合格项按“显式before→after转移、记忆类型、事实状态、重要度、证据来源”稳定排序并取整理Schema可安全处理的最多20条；每种已出现的合格记忆类型先保留一条，避免密集状态事实挤掉解释变化原因的剧情/冲突。解析数量、分类数量、质检合格数量、候选上限、拒绝数量、移除的伪线索和拒绝原因写入调试轨迹。

质量门还会按候选自己的`sourceMessageIds`核验具体人物专名与编号。专名可以由引用正文、Assistant角色名或此前已有直接来源的同一实体建立，但不能仅从参考块给匿名人物新增姓名；核心实体不落地则拒绝候选，别名/参与者/知情名单里的无依据专名则删除。Assistant推断、怀疑、假设与开放式反问被误标为confirmed时会本地降为inferred，明确行动、直接观察和状态推进不受影响。相同检查以只读方式作用于旧版记忆，并统一覆盖召回、实体消歧和跨阶段当前状态校正三条注入路径；人工编辑项受保护。

结构化抽取按模型选择 JSON Object 或 JSON Schema 为首选，最后使用普通 JSON。每次模型输出先经过仅修语法的本地JSON恢复，再交给同一Parser/Validator；只有本地仍失败才进入下一个付费模式。三种模式均失败时按完整轮次自适应拆批，任何失败范围都不推进游标。角色正常回复的 8K 输出设置与内部抽取预算互相独立。

### 7.3 合并整理

对每个候选先执行确定性整理：

1. 同一状态槽的同值确认直接合并，新值直接取代全部活跃旧值；
2. 同一关系槽按关系变化更新；
3. 同一承诺按稳定逻辑键推进并在完成时解决；
4. 明确纠正或否定使被纠正事实失效；
5. 只有本地已找到可合并目标、但具体应为MERGE/UPDATE/RESOLVE等仍语义含糊的叙事候选进入 LLM 整理；已确定的独立CREATE不调用模型。

LLM 整理阶段：

1. 根据实体和候选检索文本找出少量相似旧记忆；
2. 将候选与这些旧记忆交给 LLM；
3. 只允许 `CREATE/MERGE/UPDATE/RESOLVE/SUPERSEDE/IGNORE`；
4. 校验操作引用的记忆 ID；
5. 在单次事务中更新聊天元数据和向量同步队列。

该设计避免每次把全部历史记忆发送给抽取模型。

当前实现使用 Vector Storage与实体/状态槽匹配生成最多 16 条旧记忆候选，再进行一次结构化 LLM整理。模型失败时采用保守规则：检索文本完全相同则 `IGNORE`；同一实体同一属性值不变则 `MERGE`；值变化则 `SUPERSEDE`；其余 `CREATE`。叙事相似度必须共享参与者之外的核心实体，或达到严格文本阈值；两个明确且不同的地点在没有转移/纠正信号时直接隔离，仅共享主角不能把不同场景合并。确定性结果为 `CREATE` 时，LLM不能把它改成修改旧记忆或丢弃候选的操作。手工编辑的记忆不得被自动修改。

`MERGE/UPDATE/RESOLVE` 原地保留记忆 ID并追加 `sourceHistory`；`MERGE` 会合并而非覆盖双方的原因、结果和补充文本。每条记忆还保存本地推导的 `logicalKey`，承诺在提出到完成期间沿用同一键。完成承诺时保留一个权威 `resolved` 记录并清空旧待办。

`SUPERSEDE` 将旧记忆标为 `superseded`、记录新旧 ID关系并创建最新有效记忆。应用主决策后，本地还会按规范化状态槽扫描全部候选旧记忆：位置/当前位置/存放地点、持有/保管者、知情范围、承诺状态、真伪状态等近义属性归入同一槽，一次更新可取代多个旧目标。实体必须按完整规范名匹配，因此“白塔药铺”和“北境白塔”不会仅因共享“白塔”而串线。每条记忆保存直接证据来自 User、Assistant 或两者；Assistant 无时间推进依据的裸冲突不能覆盖 User 明确确认的状态，但来源楼层严格更晚、事实状态为 confirmed 且包含同槽状态转移的叙事属于正式剧情推进，可以更新旧状态。后续 User 修正仍可覆盖 Assistant 叙事，已完成承诺也是允许的低权威状态推进。对于旧版本遗留的复合记忆，若只取代其中一个实体，系统还会从不含被改实体的独立分句生成残余记忆，避免另一个事实随整条旧记忆一起丢失；不能安全拆分时宁可不猜。任何检索文本变化都会分配新向量哈希，同时把旧哈希放入 `pendingVectorDeleteHashes`，防止旧事实继续被语义召回。

使用主连接时，StoryEcho在单次后台请求的 `CHAT_COMPLETION_SETTINGS_READY` 生命周期内把已有的推理强度降为 `low`，请求结束立即移除监听器；用户正常角色生成的预设不被修改。主连接按其暴露的实际能力加入 JSON Object、JSON Schema 和普通 JSON 协商。

### 7.4 前后台任务协调

前台生成、手动处理与回复后后台维护共用单一协调器。后台运行期间到来的前台任务会取消可中断的后台请求；如果当前结构化模式失败、空响应准备重试或Provider准备回退，后台也会在这个未提交安全边界主动结束并重新排队，使前台无需等待完整降级链。前台上下文准备取得租约，租约持续到真实回复完成，期间不得启动新的后台 LLM；租约释放后后台从同一未提交块重试。新的真实前台生成会主动淘汰上一轮未被酒馆结束事件释放的陈旧租约，且只有最新一轮前台任务可以在完成准备后取得新租约，避免空响应、异常停止或快速重试把后续发送锁到 watchdog 超时。内部 `generateRaw` 使用请求标记识别，不能再以全局内部生成深度跳过并发到来的用户请求。队列执行前重新核对聊天与历史修订，失败时扩大安全原文窗口而不是裁掉未覆盖历史。回复完成后的自动后台启动另有3秒短延迟，减少连续操作与停止/切分支后的争用。

## 8. 查询与排序

默认模式下，`QueryRewriteService` 把最新用户发言和最近 3 条非系统消息交给当前 LLM Provider，要求模型输出一句不超过 240 字的结构化检索查询。每条上下文最多取末尾 1200 字；模型必须解析明确指代、保留当前目标和可能需要回忆的剧情实体，不得续写或添加事实。结果以“聊天 UUID + Provider + 模型 + 输入 Prompt”的 SHA-256 为键，在页面内存中缓存最近 50 项，避免 Swipe或重试重复调用。

LLM改写成功时，`Retriever` 使用改写后的一句话执行一次 Vector Storage查询，同时保留原始用户输入用于实体精确匹配；改写器明确禁止把无关 AI 续写、猜测或自我说明带入自包含问题。改写失败或用户选择本地模式时，`QueryBuilder` 始终以当前用户输入为主查询：自包含输入不建立场景向量通道；“继续”“然后呢”等弱语义输入加入上一条 AI 回复末尾最多 500 字并使用 `0.25 / 1.0` 权重；含“那把、那里、刚才”等指代的具体输入使用 `1.0 / 0.55`。

每个向量通道至少获取 24 条候选，显式询问多个实体时在 Token 预算内先保证每个实体各有一个最佳结果；普通查询仍服从配置上限，多实体“分别/各自/逐一/分成N项”及编号列表查询最多可临时扩展到 8 条。覆盖阶段先从已重排结果选择；明确点名但被相对阈值裁掉的实体，可从其余合资格窗口外记忆中按证据权威、状态类型、时间与重要度补回最佳一条。调试轨迹记录这些 `exactEntityRescues`。任一路失败不影响其他通道、固定记忆和实体关键词降级召回。

`Ranker` 在客户端执行轻量重排：

```text
intentVectorRankScore * intentWeight
+ sceneVectorRankScore * sceneWeight
+ weightedExactEntityMatch
+ currentStateIntentBonus
+ importance
```

Vector Storage当前公开响应不保证提供可直接使用的原始相似度分数，因此当前将返回顺序转换为倒数排名分数；本地双路模式再进行加权融合。查询包含“现在、位置、状态、持有者”等当前状态意图时，只有实体命中或位于向量结果前列的状态记忆获得额外加权，避免给所有“状态变化”候选无差别加分。

重排前会对旧版本可能遗留的“同一规范状态槽有多条单槽active记忆”执行只读去重：人工编辑项受保护；其余优先采用可从旧值明确推进的新confirmed状态，再按User/Mixed证据权威、来源时间和重要度选当前项。置顶只影响正常排序，不锁定旧状态值；含多个状态槽的旧复合记忆不在这里整条丢弃。随后保留固定记忆，并过滤综合分低于 2 或低于本轮最佳非固定结果 40% 的尾部候选，再应用“最多召回事件”和 Token 预算。默认最多召回 3 条，因此结果数是 0～3，而不是强行填满 3 条。`resolved`表示已完成承诺、已核验线索或已否定传言等当前有效事实，不统一降权；只有`superseded`和`invalid`记忆会在排序前排除。后续若服务端接口开放 score，再替换该部分。

用户明确要求只回答当前/已确认事实，或询问封闭的当前位置、持有者、知情者等事实时，拦截器进入事实核验模式：候选、实体补回与当前状态块只接受confirmed；自由格式阶段总结与全局骨架都不注入，精确回答只依赖confirmed结构化记忆、当前状态校正和近期原文。普通续写与开放推理仍可使用claimed/inferred/uncertain及自然剧情纪要，避免为了严格问答牺牲叙事连续性。

## 9. Token预算

预算器按以下顺序选取：

1. 用户固定且与当前聊天有效的事件；
2. 高排名 active事件；
3. 被选事件的必要因果前置；
4. 明确追溯过去时所需的 resolved事件。

超出预算时优先删除低排名事件，不截断单条事件到语义残缺。最终按来源时间排序。

第一版可使用字符数近似，后续接入 SillyTavern token计数能力。

## 10. 提示词拦截

使用 `generate_interceptor`，只处理正常用户生成和明确支持的 regenerate/swipe场景。忽略：

- StoryEcho自己的抽取请求；
- quiet/background请求；
- 工具调用的内部生成；
- 用户关闭插件时的所有请求。

拦截器必须区分原始聊天消息与系统/世界书/其他扩展注入。不得简单截取最终数组最后 `N` 项。

处理原则：

1. 根据当前聊天源消息身份确定“至少 W 轮”的最小原文边界；
2. 实际原文边界取阶段总结覆盖游标、剧情索引游标和最小原文边界三者中最保守的位置；
3. 仅删除同时已被阶段总结与剧情索引覆盖、并位于实际边界之外的聊天消息；
4. 保留角色卡、世界书、已有系统提示和未知来源注入；
5. 校验全局剧情骨架；有效时在第一条保留原文之前插入独立 narrator/system 块，过期时不注入；
6. 在骨架之后按时间顺序插入尚未并入骨架的归档总结和最近 S 条阶段总结；没有有效骨架时保留全部归档总结；
7. 若结构化记忆中存在跨阶段更新，在总结之后插入最多 600 Token 的当前状态校正块，只列出变更过的状态槽；
8. 在当前用户消息之前插入本轮动态召回 narrator/system 块，当前用户消息内容和对象均保持不变；
9. 保证发送数组最后一条仍为当前 User；
10. 任何识别歧义都应放弃裁剪并记录警告。

最终时序：

```text
静态系统区
<story_echo_skeleton>有效的全局剧情骨架</story_echo_skeleton>
<story_echo_summary>尚未合并的归档总结 + 最近 S 条独立阶段总结</story_echo_summary>
<story_echo_current_state>跨阶段变更后的当前状态</story_echo_current_state>
尚未满 N 轮总结批次的窗口外原文
近期原文（至少 W 个完整轮次）
<story_echo_recall>本轮动态召回</story_echo_recall>  # 请求级 system
当前用户原始输入                            # User，必须保持最后
```

SillyTavern 在 `generate_interceptor` 之前已经从持久聊天构造了请求级 `coreChat`。StoryEcho只修改这个临时数组；新增消息使用 SillyTavern narrator 类型以获得真正的 system 语义，不能只设置 `is_system: true`，因为部分 Chat Completion 转换路径会把后者按 assistant 处理。不得调用保存聊天接口。

提示中的冲突规则为“当前用户输入 > 近期原文 > 动态召回 > 当前状态校正 > 最近阶段总结 > 全局剧情骨架”。召回块必须声明内容是背景数据而非指令，近期原文出现更新时不得用较老记忆覆盖。近期窗口内若已有 User 对同一状态槽的明确更新，窗口外旧记忆会在排序前被遮蔽；单纯提问不会误触发遮蔽。

记忆是否位于窗口外按全部 `sourceHistory` 判断，而不只看最近一次合并的 `source`。只要复合记忆中仍有一个有效事实来源已经离开窗口，该记忆仍可召回。注入文本由结构化的事件、场景、原因、当前结果、状态变化、缺失实体和知情范围统一渲染，避免模型生成摘要中的“我/你”在脱离原场景后产生歧义。

## 11. 消息变更与分支

### 11.1 编辑、删除、Swipe

每次成功提交分块后，除分块哈希外还保存从消息 0 到当前索引游标的 `indexedPrefixHash`。正常生成、重新生成或 Swipe进入拦截器时，重新计算同一前缀并比较：

- 哈希一致：继续增量抽取，不做额外写入；
- 已索引游标超过当前聊天末尾，或前缀哈希不一致：判定已发生编辑、删楼、Swipe变更或历史截断；
- 立即 `purge` 当前向量集合，清空派生记忆、索引游标和待同步队列；
- 同时清空阶段总结文本与覆盖游标；
- 从仍然存在的原始聊天重新按分块抽取；重建尚未覆盖裁剪边界前保留完整聊天，不冒险注入旧事实。

这是保守的全派生索引重建，而不是只猜测受影响记忆。编辑和删楼属于低频操作，优先保证被删除的事实、旧分支事实和旧向量不会泄漏；原始聊天仍是唯一事实来源。

### 11.2 分支

聊天元数据可能被 SillyTavern复制到新分支。读取分支时先比较 `ownerChatId`：

- 一致：继续使用现有集合；
- 不一致：立即生成新的 `chatUuid`和集合 ID，不与父分支共享可写集合；
- 随后的前缀一致性检查会发现分支历史被截断，清空复制来的派生记忆并从分支实际存在的原始消息重建；
- 父分支集合保持不变，新分支不会继承分叉点之后的事实或向量。

## 12. 安全

- 自定义 Key仅写入当前用户的 `extensionSettings.story_echo`以实现持久化和多端同步；不写入 `chatMetadata`、角色卡、Vector Storage、日志或错误上报。
- 自定义请求只允许 HTTP(S)，默认要求 HTTPS。
- 自定义响应进行大小限制和 JSON校验。
- 自定义接口可使用 JSON Schema约束输出；所有提供方的返回仍须经过本地解析、字段白名单、枚举与长度边界校验，未知字段不会写入记忆。
- UI渲染用户与模型内容前使用 DOM API或 DOMPurify，不拼接未转义 HTML。
- 不使用 `eval`或动态函数执行。
- Vector Storage集合 ID只使用 UUID和固定前缀。

详见 [SECURITY.md](SECURITY.md)。

## 13. 可观测性

日志分级：

- `error`：功能失败但应放行生成；
- `warn`：降级、索引过期、边界识别不确定；
- `info`：手动重建、迁移完成；
- `debug`：候选、排名和 Token明细，默认关闭。

每次生成保存一个轻量 `InspectionRecord`，并累计抽取、抽取参考、整理、向量和裁剪指标。调试模式额外在聊天元数据中保留最近 50 条有界轨迹，包括抽取参考字段、命中世界书标识、Token 数、有界预览、合资格记忆 ID、各向量通道的哈希与排名以及最终选中 ID。设置面板会显示当前有效抽取批次和窗口外待处理轮数，并提供完整元数据查看/编辑/删除；可复制报告展示实际结构化注入文本，而不是仅展示原始 `injectionText`。报告明确排除 API Key和自定义 Base URL，但包含定位问题所需的角色/世界书参考预览、剧情查询、整理动作和召回文本。

最近请求 Token 卡片不从拦截器收到的 `contextSize` 推断总量：该参数是生成前的可用上下文预算，且拦截器运行时世界书和最终 Prompt 尚未完成组装。卡片在角色请求结束后只读加载 SillyTavern 当前聊天的 `itemizedPrompts` 最新有效记录，忽略消息 ID 尚未落入聊天的中止请求；Chat Completion 优先使用酒馆保存的分类总量和 conversation/system/examples 等桶，再用 `<story_echo_skeleton>`、`<story_echo_summary>`、`<story_echo_current_state>`、`<story_echo_recall>` 标签细分 StoryEcho 内容。骨架与阶段总结共同计入 StoryEcho 总结分类。Text Completion 使用酒馆保存的 story/examples/chat 字符串分段。若分类计数缺失，只对最终提示词中可识别的来源文本计数，其余归入未分类，最近原文显示未知。读取按聊天 ID 与提示词修订缓存，后台诊断刷新不会反复 Tokenize 大 Prompt；聊天切换、Swipe、完成/停止生成及提示词明细加载后自动刷新。

## 14. 兼容策略

- 优先使用 `SillyTavern.getContext()`，减少直接导入内部模块。
- Vector Storage HTTP接口封装在单一 Adapter。
- 主连接调用封装在 LLM Provider。
- manifest固定 `loading_order`，文档说明与其他提示词拦截器的顺序。
- 对不支持的 SillyTavern版本显示明确错误并禁用危险功能，而不是尝试猜测内部结构。

## 15. 长聊天性能

连续聊天不会把完整历史反复发送给后台模型：阶段总结读取下一批尚未覆盖的原文和紧邻上一条总结末尾最多 5000 字符，默认每 10轮新增一次且不重写旧条目；首次骨架生成完成后，每条新阶段总结只在首次进入归档时与旧骨架合并一次。骨架每个逻辑批次只使用一次 LLM 请求，实体归属、行动、确定程度和历史表达由主提示词一次完成。启用剧情记忆后，抽取只处理尚未索引的新分块，并在窗口外累计满默认 5个完整轮次后才调用一次。

AI 回复完成事件会延迟触发后台队列：基础模式每次最多处理一个总结分块和一条到期的骨架增量；记忆模式再最多处理一个抽取分块并重试待同步向量，避免无界费用。生成前不执行这些写任务。已有长聊天加载稳定后会自动补建一次缺失骨架；首次生成与手动重建按每批最多 80000 字符从旧到新处理，并通过队列让行。仅记忆模式会按配置执行检索查询改写，读取最新用户输入和最近 3条经过正文清洗的非系统消息；正常角色生成只保留未总结尾段、至少 W轮近期原文、有效骨架、最近 S条有界总结和尚未合并的少量归档总结，以及记忆模式下最多 600 Token 的变更状态校正和有限条召回记忆。因此 LLM 与 Embedding 总成本随新增剧情线性增长；后台落后时，未处理原文或总结会临时扩大安全输入而不丢失。全部阶段总结元数据仍随批次数线性增长，骨架只提供请求层的长期有界表示，不自动删除这些可审计条目。

本地路径的主要复杂度如下：

- 窗口定位和提示数组压缩为 `O(N)`，`N`是本次 SillyTavern交给拦截器的消息数；实现使用单次反向边界扫描和单次稳定压缩，不逐条 `splice`；
- 已移除原文的 Token统计只均匀采样最多 200条消息，避免调试指标扫描数千万字符；
- 召回重排和整理前结构化候选匹配为 `O(M)`，`M`是当前聊天的结构化记忆数；实际向量相似度检索仍由 Vector Storage执行；
- 为发现任意旧楼层编辑、删楼和分支截断，生成前的已索引前缀校验为 `O(N)`；它只在本地序列化并计算 SHA-256，不调用 LLM或 Embedding。回复后的后台队列监听聊天切换、编辑、删楼和Swipe事件：纯追加聊天复用最近一次已验证前缀，不再每轮重复全量哈希；发生历史变更后则恢复一次完整校验。几千楼时生成前校验成本仍随聊天文本线性增长，若真实超长聊天中成为瓶颈，可进一步使用分段 Merkle 哈希；
- 待写入或待删除向量只在回复后后台任务与手动处理路径同步；前台生成只使用已保存向量和实体关键词降级。设置面板也只在初次打开、手动刷新和处理历史后读取向量总数。

`tests/long-chat-performance.test.ts`使用 501条消息、300条记忆和23条阶段总结的高密度样本覆盖窗口裁剪、Token估算、轻量重排、整理候选、总结窗口切片和元数据体积。2026-07-19一次独立测试进程中的代表结果为：窗口定位加数组压缩约 0.10ms、采样Token估算约 1.31ms、300条记忆重排约 0.99ms、整理候选约 6.49ms、最近4条总结切片低于 0.01ms，聊天元数据约 274KiB；计时会随机器负载波动。聊天元数据仍随记忆数和总结批次数线性增长，这是几千楼以后比本地算法更值得关注的瓶颈；按该高密度样本线性外推，3000条记忆加数百条短总结约为数 MB。后续可增加已取代记忆归档和长期记忆分层，但当前不应在没有真实数据前主动丢弃剧情事实。
