# StoryEcho 技术架构

## 1. 总体结构

```text
SillyTavern聊天
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
  vector/
    adapter.ts
    sillytavern-vector-store.ts
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

interface StoryMemory {
  id: string;
  type: MemoryType;
  source: {
    startMessageId: number;
    endMessageId: number;
    sourceHash: string;
  };
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
  memories: StoryMemory[];
  pendingRanges: Array<{ startMessageId: number; endMessageId: number }>;
  pendingVectorHashes: number[];
  vectorFingerprint: string;
  lastInspection?: InspectionRecord;
}
```

## 4. 权威数据与缓存

数据优先级：

1. 原始聊天消息是事实来源。
2. `chatMetadata.story_echo` 是剧情记忆的权威存储。
3. Vector Storage 是可重建索引。
4. 运行时检索结果仅存在内存。

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
- 若希望完全避免浏览器计算，不使用 WebLLM；
- 服务端 `transformers`、Ollama或远程Embedding提供方均可；
- 查询和写入封装在 `VectorStoreAdapter` 后面，避免业务代码依赖内部请求格式。

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

### 6.1 主连接

默认 Provider 调用 `SillyTavern.getContext().generateRaw()`：

- 使用用户当前主连接、模型和密钥；
- 不切换连接配置；
- 使用独立 system prompt；
- 优先启用 JSON Schema结构化输出；
- 抽取调用标记为后台任务，不触发 StoryEcho 自己的生成拦截。

### 6.2 自定义 OpenAI兼容接口

配置：

```ts
interface OpenAiCompatibleConfig {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  fallbackToMain: boolean;
}
```

API Key 单独进入运行时 `SecretVault`：

```ts
interface SecretVault {
  setSessionKey(value: string): void;
  hasSessionKey(): boolean;
  getSessionKey(): string | undefined;
  clear(): void;
}
```

纯 UI 扩展无法安全持久化 Key。第一阶段只在页面内存保存；刷新后重新输入。后续可选服务端插件提供：

```text
POST /api/plugins/story-echo/secrets
POST /api/plugins/story-echo/chat-completions
DELETE /api/plugins/story-echo/secrets
```

服务端插件不是核心运行依赖；没有自定义 Provider需求的用户无需安装。

### 6.3 Base URL规范化

接受：

```text
https://example.com
https://example.com/v1
https://example.com/v1/chat/completions
```

统一转换为唯一的 Chat Completions URL，禁止重复拼接。默认拒绝非 HTTP(S)协议。是否允许局域网 HTTP由用户明确开启。

## 7. 抽取管线

### 7.1 场景切块

初版采用固定轮次加边界提示：

- 最小 2轮；
- 目标 3轮；
- 最大 4轮；
- 前后重叠 1条消息；
- 当前最近窗口内的消息暂不强制抽取。

后续由 LLM或规则检测地点、时间和参与者变化。

### 7.2 候选抽取

输入仅包含：

- 当前历史块；
- 前一块最后一条场景摘要；
- 抽取规则；
- JSON Schema。

输出高召回候选事件，不直接写入存储。

### 7.3 合并整理

对每个候选：

1. 根据实体和候选检索文本找出少量相似旧记忆；
2. 将候选与这些旧记忆交给 LLM；
3. 只允许 `CREATE/MERGE/UPDATE/RESOLVE/SUPERSEDE/IGNORE`；
4. 校验操作引用的记忆 ID；
5. 在单次事务中更新聊天元数据和向量同步队列。

该设计避免每次把全部历史记忆发送给抽取模型。

## 8. 查询与排序

`QueryBuilder` 从当前输入和最近场景生成检索查询文本，保留原始实体名和代词解析结果。

`Retriever` 调用 Vector Storage 获取比最终数量更多的候选，例如最终需要 4条时先取 12条。

`Ranker` 在客户端执行轻量重排：

```text
vectorRankScore
+ exactEntityMatch
+ activeThreadMatch
+ importance
+ sceneContinuity
- resolvedPenalty
- supersededPenalty
- excludedPenalty
```

Vector Storage当前公开响应不保证提供可直接使用的原始相似度分数，因此第一版将返回顺序转换为倒数排名分数。后续若服务端接口开放 score，再替换该部分。

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

1. 根据当前聊天源消息身份确定保留边界；
2. 仅删除匹配到的窗口外聊天消息；
3. 保留系统提示、角色卡、世界书和未知来源注入；
4. 在第一条保留聊天消息前插入一个 StoryEcho系统块；
5. 任何识别歧义都应放弃裁剪并记录警告。

## 11. 消息变更与分支

### 11.1 编辑、删除、Swipe

根据 `source.startMessageId/endMessageId/sourceHash` 找到受影响记忆：

- 标记为 invalid；
- 从 Vector Storage删除旧哈希；
- 将对应范围加入重新抽取队列；
- 保留手工编辑内容供用户决定是否迁移。

### 11.2 分支

聊天元数据可能被复制到新分支。每次 `CHAT_CHANGED` 比较 `ownerChatId`：

- 一致：继续使用现有集合；
- 不一致：生成新的 `chatUuid`和集合 ID；
- 复制有效剧情事件；
- 使用 `retrievalText`后台重建新集合；
- 不与父分支共享可写集合。

## 12. 安全

- 不把 Key写入 `extensionSettings`、`chatMetadata`、角色卡、日志或错误上报。
- 自定义请求只允许 HTTP(S)，默认要求 HTTPS。
- 自定义响应进行大小限制和 JSON校验。
- 所有模型输出按 Schema校验，拒绝未知字段和非法枚举。
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

每次生成保存一个轻量 `InspectionRecord`，不保存 API Key、完整系统提示或不必要原文。

## 14. 兼容策略

- 优先使用 `SillyTavern.getContext()`，减少直接导入内部模块。
- Vector Storage HTTP接口封装在单一 Adapter。
- 主连接调用封装在 LLM Provider。
- manifest固定 `loading_order`，文档说明与其他提示词拦截器的顺序。
- 对不支持的 SillyTavern版本显示明确错误并禁用危险功能，而不是尝试猜测内部结构。
