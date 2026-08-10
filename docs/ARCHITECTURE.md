# StoryEcho 架构

## 1. 数据流

```text
SillyTavern 聊天
      │
      ├─ 回复完成事件 ─> BackgroundProcessingScheduler
      │                     ├─ StageSummaryService：原文 → L1
      │                     └─ SummaryCompactionService：Ln → Ln+1
      │
      └─ 角色生成 ─────> storyEchoGenerateInterceptor
                            ├─ 校验总结来源
                            ├─ 选择安全原文窗口
                            ├─ 注入当前分层总结前沿
                            └─ 仅删除已总结原文

设置 ────────────────> extensionSettings.story_echo
派生上下文与诊断 ─────> chatMetadata.story_echo
```

## 2. 模块

```text
src/
  background/scheduler.ts       回复后单批调度与生命周期事件
  content/story-content.ts      后台使用的可见剧情正文清洗
  history/
    chunk-planner.ts            完整轮次切块
    source-revision-cache.ts    来源校验缓存
    story-phase.ts              显式篇章边界识别
  llm/
    complete.ts                 空响应/超时重试与主连接回退
    main-provider.ts            SillyTavern 主连接
    openai-compatible-provider.ts
    internal-generation.ts      内部请求 nonce 与递归拦截防护
  prompt/
    interceptor.ts              请求期安全裁剪与注入
    itemization.ts              最近请求 Token 分类
    render.ts                   分层总结协议块
    window.ts                   窗口与原地数组裁剪
  reference/context.ts          世界书背景
  runtime/
    task-coordinator.ts         前台/手动/后台优先级与租约
    task-cancellation.ts        AbortSignal 取消边界
  settings/                     单功能设置与归一化
  state/repository.ts           聊天派生状态与迁移
  summary/
    service.ts                  原文阶段总结（L1）
    source.ts                   原文来源序列化
    compaction-state.ts         层级阈值、候选选择与前沿比较
    compaction-prompts.ts       高层压缩提示词
    compaction-service.ts       同层递归压缩、提交与重新生成
  ui/                           设置、分层总结管理与诊断
```

## 3. 持久化模型

设置 Schema 版本为 12：

```ts
interface StoryEchoSettings {
  enabled: boolean;
  debug: boolean;
  recentWindow: { size: number; unit: 'turns' | 'messages' };
  summary: {
    targetTurnsPerUpdate: number;
    level1EntriesPerGroup: number;       // 默认 10
    higherLevelEntriesPerGroup: number; // 默认 5
    level1MaxTokens: number;             // 默认 3000
    higherLevelMaxTokens: number;        // 默认 8000
    reference: {
      enabled: boolean;
      maxWorldInfoEntries: number;
    };
  };
  llm: {
    provider: 'main' | 'openai-compatible';
    custom: {
      baseUrl: string;
      model: string;
      apiKey: string;
      timeoutMs: number;
      allowInsecureHttp: boolean;
      fallbackToMain: boolean;
    };
  };
}
```

聊天状态 Schema 版本为 3。所有层级共用一个按剧情时间排列的前沿数组：

```ts
interface StageSummaryEntry {
  text: string;
  level: number;
  sourceStartMessageId: number;
  sourceEndMessageId: number;
  sourceHash: string;
  updatedAt: string;
  compaction?: {
    sourceLevel: number;
    sourceEntryCount: number;
    inputHash: string;
    sources: SummaryCompactionSource[]; // 仅直接子节点
  };
  manuallyEdited?: boolean;
  deleted?: boolean;
}

interface StoryEchoChatState {
  schemaVersion: 3;
  chatUuid: string;
  ownerChatId: string;
  stageSummary: {
    entries: StageSummaryEntry[];
    coveredThroughMessageId: number;
    coveredThroughHash: string;
    rebuildCheckpoint?: StageSummaryRebuildCheckpoint;
  };
  metrics: StoryEchoMetrics;
  debugTraces: StoryEchoDebugTrace[];
  recentInternalLlmAttempts: InternalLlmAttempt[];
  lastInspection?: InspectionRecord;
}
```

升级只复制已知字段。旧总结迁移为 L1，旧全局骨架不进入 Schema 3。

## 4. 分层压缩不变量

每一层有独立容量：L1 使用 `level1EntriesPerGroup`，L2+ 使用 `higherLevelEntriesPerGroup`。某层数量超过容量时：

1. 选择最低的溢出层；
2. 选择该层最老且时间连续的一整组；
3. 校验每个子总结及其原文来源；
4. 生成一条 `level + 1` 总结；
5. 再次校验原文、聊天所有权和完整总结前沿；
6. 用父总结原子替换该组子总结。

替换后继续检查下一层，因此进位可以级联。稳定状态下 L1 不超过其配置容量，每个 L2+ 层不超过高层容量；总条目数随历史长度为 `O(log N)`。

高层条目保存直接子总结快照与输入哈希，用于安全重新生成。只保存直接子节点，避免持久化数据随层级重复膨胀。

## 5. L1 与来源一致性

L1 提交同时检查：

1. 请求前源消息快照哈希；
2. LLM 返回后的当前源消息哈希；
3. 真正提交前重新读取的实时聊天哈希；
4. 当前聊天所有权；
5. 生成期间总结前沿是否变化。

完整重建先在草稿中生成全部 L1，验证原文与旧前沿修订后一次性替换；随后高层压缩逐组原子提交。高层失败不会破坏已经完成的 L1 或父节点。

## 6. 裁剪与注入

设用户配置希望从 `minimumRetainedStart` 开始保留。实际起点为：

```text
min(minimumRetainedStart, summaryCoveredThrough + 1)
```

按轮次计数时再向前对齐到完整用户轮次。请求数组和真实聊天数组可能不同，因此先从真实聊天计算安全范围，再转换成请求数组中的非 system 消息数量。system 消息不计入窗口，也不会被删除。

所有未删除前沿条目按来源时间顺序合并进一条临时 system/narrator 消息。显式新篇章边界只过滤边界前的 L1 细节；L2+ 继续提供长期连续性。若用户明确询问较早阶段，则恢复携带较早 L1。

## 7. 并发与取消

协调器维护前台、手动、后台三个队列和一个生成后租约。后台在空响应重试、超时重试和自定义 Provider 回退前检查是否需要给前台让行。

Provider 统一接受 `AbortSignal`：

- Main Provider 将信号与请求超时合并；
- 自定义 Provider 使用独立 AbortController；
- 所有临时事件监听器和计时器都在 `finally` 中清理；
- 取消后的未提交 L1 或高层总结不会写入状态。

## 8. 性能特征

- 窗口选择与来源校验对聊天长度是 `O(N)`；
- 请求数组裁剪使用单次压缩，不逐项 `splice`；
- 大范围 Token 诊断最多均匀采样 200 条消息；
- 最近提示词明细反向读取最新有效记录，常见路径为 `O(1)`；
- 来源修订缓存让纯追加聊天避免每轮重复计算相同前缀哈希；
- L1 模型成本随新增剧情近似线性增长；高层压缩是固定扇入的进位操作；
- 注入的总结前沿为 `O(log N)` 条，而不是随聊天长度线性累积。
