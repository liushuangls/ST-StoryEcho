# StoryEcho 只读公共 API

公共 API 面向需要复用 StoryEcho 剧情上下文的其他浏览器扩展。API 版本为 `1`，不提供任何写操作，也不会因为一次读取而创建聊天状态或保存元数据。

## 获取接口

Luker 会把接口注册到扩展 API 注册表。普通 SillyTavern 及没有注册表的兼容宿主可以使用全局后备入口：

```js
const context = globalThis.SillyTavern?.getContext?.();
const api = context?.getExtensionApi?.('story-echo')
  ?? globalThis.StoryEcho?.api;

if (!api || api.apiVersion !== 1) {
  // StoryEcho 未加载，或接口版本不受当前调用方支持。
}
```

注册表和全局入口指向同一个冻结对象。StoryEcho 生命周期停用时该对象仍可能存在；调用方应读取 `getCoverage()?.active`，不要只凭对象存在判断扩展正在运行。

## 接口

```ts
interface StoryEchoReadApi {
  readonly apiVersion: 1;
  readonly extensionVersion: string;

  getFrontier(): readonly StoryEchoSummaryView[];
  getCoverage(): StoryEchoCoverageView | null;
  getLastInjection(): StoryEchoLastInjectionView | null;
  onStateChanged(
    listener: (change: StoryEchoPublicChangeView) => void,
  ): () => void;
}
```

### `getFrontier()`

返回当前聊天中所有未删除的总结前沿，顺序与 StoryEcho 发送给模型时的剧情时间顺序一致。没有聊天状态、状态不属于当前聊天或读取失败时返回冻结的空数组。

```ts
interface StoryEchoSummaryView {
  readonly text: string;
  readonly level: number;
  readonly sourceStartMessageId: number;
  readonly sourceEndMessageId: number;
  readonly sourceHash: string;
  readonly updatedAt: string;
  readonly characterCount: number;
  readonly manuallyEdited: boolean;
  readonly outputTruncated: boolean;
  readonly truncatedSourceRanges: readonly {
    readonly sourceStartMessageId: number;
    readonly sourceEndMessageId: number;
  }[];
}
```

### `getCoverage()`

返回当前聊天的覆盖状态；当前没有可识别聊天时返回 `null`。如果聊天存在但尚未创建 StoryEcho 状态，则仍返回对象，其中 `chatUuid` 为 `null`、覆盖位置为 `-1`，且不会创建状态。

```ts
interface StoryEchoCoverageView {
  readonly active: boolean;  // StoryEcho 扩展生命周期是否启用
  readonly enabled: boolean; // “启用 StoryEcho 上下文管理”设置
  readonly chatId: string;
  readonly chatUuid: string | null;
  readonly coveredThroughMessageId: number;
  readonly coveredThroughHash: string;
  readonly updatedAt: string | null;
  readonly frontierEntryCount: number;
  readonly storedEntryCount: number;
  readonly deletedEntryCount: number;
  readonly levelCounts: readonly {
    readonly level: number;
    readonly count: number;
  }[];
  readonly rebuildInProgress: boolean;
  readonly rebuildDraftEntryCount: number;
}
```

### `getLastInjection()`

返回当前页面会话内、当前聊天最近一次实际插入角色请求的 StoryEcho 历史块。`text` 是 StoryEcho 插入的原始文本，不是完整模型请求。聊天切换、页面刷新、扩展停用，或者下一次外部生成没有进行 StoryEcho 注入后返回 `null`。

```ts
interface StoryEchoLastInjectionView {
  readonly chatId: string;
  readonly chatUuid: string;
  readonly createdAt: string;
  readonly generationType: string;
  readonly retainedStartMessageId: number;
  readonly removedMessageCount: number;
  readonly text: string;
  readonly summaries: readonly StoryEchoSummaryView[];
}
```

该快照只保存在页面内存，不写入聊天元数据。并发或排队的旧生成不能覆盖更新生成留下的快照。

### `onStateChanged(listener)`

在以上公开快照实际发生变化时调用监听器；仅有内部指标或队列状态变化时不会重复通知。注册时不会立即调用，调用方应先主动读取一次，再订阅后续变化：

```js
function read() {
  return {
    coverage: api.getCoverage(),
    frontier: api.getFrontier(),
    injection: api.getLastInjection(),
  };
}

let current = read();
const unsubscribe = api.onStateChanged((change) => {
  current = change;
});

// 清理时可安全重复调用。
unsubscribe();
unsubscribe();
```

`change.reason` 是 `chat`、`injection`、`lifecycle`、`settings` 或 `state`。监听器异常会被隔离，不会中断 StoryEcho 或其他监听器。

## 不变式与版本

- 所有返回对象、数组和嵌套范围均已冻结，调用方不会取得 StoryEcho 的内部可变引用；
- API 不返回自定义连接的 Key、Base URL、内部 LLM 请求或未进入总结的聊天原文；
- 新增向后兼容字段不会提升 `apiVersion`；删除字段、改变现有字段语义或修改方法签名时才提升主 API 版本；
- 调用方应忽略未知字段，并在使用前检查自己支持的 `apiVersion`。
