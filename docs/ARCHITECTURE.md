# StoryEcho 架构

## 1. 数据流

```text
SillyTavern 聊天
      │
      ├─ 回复完成事件 ─> BackgroundProcessingScheduler
      │                     ├─ StageSummaryService
      │                     └─ StorySkeletonService
      │
      └─ 角色生成 ─────> storyEchoGenerateInterceptor
                            ├─ 校验总结与骨架
                            ├─ 选择安全原文窗口
                            ├─ 注入骨架与最近总结
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
    render.ts                   骨架/总结协议块
    window.ts                   窗口与原地数组裁剪
  reference/context.ts          世界书背景
  runtime/
    task-coordinator.ts         前台/手动/后台优先级与租约
    task-cancellation.ts        AbortSignal 取消边界
  settings/                     单功能设置与归一化
  state/repository.ts           聊天派生状态
  summary/
    service.ts                  阶段总结
    skeleton-service.ts         全局骨架
    skeleton-state.ts           归档、到期与来源哈希
  ui/                           设置、骨架/总结编辑与诊断
```

## 3. 持久化模型

设置 Schema 版本为 10：

```ts
interface StoryEchoSettings {
  enabled: boolean;
  debug: boolean;
  recentWindow: { size: number; unit: 'turns' | 'messages' };
  summary: {
    targetTurnsPerUpdate: number;
    windowSize: number;
    maxTokens: number;
    skeletonMaxTokens: number;
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

聊天状态 Schema 版本为 2：

```ts
interface StoryEchoChatState {
  chatUuid: string;
  ownerChatId: string;
  stageSummary: {
    entries: StageSummaryEntry[];
    coveredThroughMessageId: number;
    coveredThroughHash: string;
  };
  storySkeleton: StorySkeleton;
  metrics: StoryEchoMetrics;
  debugTraces: StoryEchoDebugTrace[];
  lastInspection?: InspectionRecord;
}
```

升级时只复制这些已知字段，其他旧字段被丢弃。状态仅在下一次保存时写回精简结构。

## 4. 一致性协议

阶段总结提交同时检查：

1. 请求前源消息快照哈希；
2. LLM 返回后的当前源消息哈希；
3. 真正提交前重新读取的实时聊天哈希；
4. 当前聊天所有权；
5. 生成期间已有总结是否变化。

完整重建先在内存构建全部条目，验证聊天、旧总结和骨架修订均未变化后再原子替换。

骨架使用它所吸收的阶段总结前缀哈希。任何条目正文、删除状态、来源哈希、Token 上限或覆盖边界变化都会使缓存失配；无效骨架不会参与角色请求。

## 5. 裁剪不变量

设用户配置希望从 `minimumRetainedStart` 开始保留。实际起点为：

```text
min(minimumRetainedStart, summaryCoveredThrough + 1)
```

按轮次计数时再向前对齐到完整用户轮次。请求数组和真实聊天数组可能不同，因此先从真实聊天计算安全范围，再转换成请求数组中的非 system 消息数量。system 消息不计入窗口，也不会被删除。

## 6. 并发与取消

协调器维护三个队列和一个生成后租约。任务优先级为前台、手动、后台。后台在空响应重试、超时重试和自定义 Provider 回退前检查是否需要给前台让行。

Provider 统一接受 `AbortSignal`：

- Main Provider 将信号与可选请求超时合并；
- 自定义 Provider 使用独立 AbortController；
- 所有临时事件监听器和计时器都在 `finally` 中清理；
- 取消后的未提交总结或骨架不会写入状态。

## 7. 性能特征

- 窗口选择与来源校验对聊天长度是 `O(N)`；
- 请求数组裁剪使用单次压缩，不逐项 splice；
- 大范围 Token 诊断最多均匀采样 200 条消息；
- 最近提示词明细反向读取最新有效记录，常见路径为 `O(1)`；
- 来源修订缓存让纯追加聊天避免每轮重复计算相同前缀哈希；
- 阶段总结与骨架只处理新增批次，模型成本随新增剧情近似线性增长；
- 全部可审计阶段总结会随聊天增长，骨架负责把实际请求中的长期历史保持有界。
