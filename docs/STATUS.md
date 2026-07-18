# 当前实现状态

更新时间：2026-07-18

## 已完成

- SillyTavern 第三方扩展 manifest、TypeScript 构建和 Git 安装产物；
- 分区卡片式设置面板和响应式操作按钮；
- 最近窗口按轮次或消息计算；
- 默认主连接 LLM Provider；
- 自定义 OpenAI 兼容 LLM，经 SillyTavern 自带后端转发；
- 自定义 LLM 失败后可回退主连接；
- 自定义 OpenAI 兼容 Embedding，包括火山方舟 Base URL；
- 自定义 Embedding 自动经 SillyTavern 内置代理转发、连接测试和响应校验；
- LLM 与 Embedding Key 通过 `extensionSettings` 持久化和同步；
- 远程预生成向量写入 Vector Storage，继续由酒馆服务端保存和检索；
- 剧情抽取 Prompt、JSON Schema 和响应校验；
- 历史切块和手动处理窗口外历史；
- 剧情事件写入 `chatMetadata`；
- CREATE/MERGE/UPDATE/RESOLVE/SUPERSEDE/IGNORE 六类事件整理；
- LLM 整理失败时的保守规则回退和手工编辑保护；
- 记忆更新后的旧向量删除与新向量增量同步；
- 每聊天/分支独立 Vector Storage 集合；
- Embedding 来源、端点或模型变化检测与自动重建；
- 生成前安全检查、单分块追赶索引、窗口裁剪和记忆块注入；
- LLM 结合最近 3 条上下文生成检索查询、页面内存缓存和本地规则回退；
- 用户意图与 AI 场景尾部双路召回、弱语义检测、实体降级匹配和轻量重排；
- 抽取、整理、向量、裁剪、召回统计和脱敏调试报告；
- 设置、查询改写、整理、向量、Embedding、LLM 代理、哈希、URL、切块、解析、窗口和排序测试。

## 尚未完成

- 消息编辑、删除和 Swipe 的来源哈希失效处理；
- 记忆列表、编辑器和完整上下文检查器；
- Vector Storage 全部来源的参数适配；
- 后台低优先级自动抽取调度；
- 精确 Token 计数；
- 使用真实外部 LLM/Embedding 凭据的兼容性测试；
- 正式发布、许可证和升级迁移策略。

## 当前安全默认值

- 扩展默认关闭；
- LLM 默认使用主连接；
- 自定义 Key 明文保存在当前用户扩展设置中，以换取持久化和多端同步；
- Key 不进入聊天数据、Vector Storage 或调试报告；
- 自定义 LLM 由 SillyTavern Chat Completions 后端转发；自定义 Embedding 由内置 `/proxy/` 转发；
- 索引没有覆盖裁剪边界时保留完整聊天；
- 单次正常生成最多同步执行一个抽取分块；
- 检索、抽取或自定义 Provider 失败时优先放行正常生成或按设置回退。
