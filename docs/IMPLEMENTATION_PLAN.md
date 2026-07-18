# StoryEcho 实现计划

## 阶段0：项目基础

- TypeScript构建；
- SillyTavern扩展 manifest；
- 设置加载与迁移；
- 日志和错误边界；
- 基础设置面板；
- 单元测试框架。

完成标准：扩展可安装、加载、保存普通设置，不影响正常聊天。

## 阶段1：LLM Provider

- 主连接 Provider；
- 自定义 OpenAI兼容 Provider；
- Base URL规范化；
- SillyTavern服务端 SecretManager持久化；
- Key绑定端点的服务端请求代理；
- 超时、取消和可选回退；
- 测试连接。

完成标准：同一结构化抽取请求可以通过两种 Provider完成；Key只由服务端保管且外部请求不经过浏览器。

## 阶段2：聊天记忆存储

- `StoryMemory` Schema；
- `chatMetadata` Repository；
- schema版本与迁移；
- 聊天 UUID和分支检测；
- 来源哈希与失效检测；
- 记忆查看、编辑和删除。

完成标准：每个聊天独立保存可导出的剧情事件，切换聊天不会串数据。

## 阶段3：Vector Storage

- Vector Storage Adapter；
- 集合初始化；
- insert/list/query/delete/purge；
- 哈希碰撞处理；
- 增量同步和完整重建；
- Embedding来源/模型变化检测。
- 自定义OpenAI兼容Embedding、服务端Key和连接测试；
- 预生成向量复用Vector Storage存储与检索；

完成标准：剧情事件可以写入服务端索引，并通过当前输入召回对应事件。

## 阶段4：剧情抽取

- 固定轮次切块；
- 候选事件提取 Prompt与 Schema；
- JSON解析和修复重试；
- 事件重要度规则；
- 手动抽取指定范围；
- 后台抽取队列。

完成标准：长对话片段能稳定生成原子化事件，且不直接复述整段原文。

## 阶段5：事件整理

状态：核心链路已完成，等待真实聊天样本调优。

- 相似旧事件预检索；
- CREATE/MERGE/UPDATE/RESOLVE/SUPERSEDE/IGNORE；
- 原子事务更新；
- 向量同步队列；
- 用户手工修改保护。

完成标准：持续状态和伏笔不会堆积成相互矛盾的重复记忆。

## 阶段6：滑动窗口与召回

- 按轮次/消息计算保留边界；
- 查询构造；
- 可选 LLM上下文查询改写、缓存与本地规则回退；
- 轻量重排；
- Token预算；
- 记忆块渲染；
- Prompt Interceptor；
- quiet/background调用隔离。

完成标准：最终请求只包含最近窗口原文和预算内相关剧情记忆，不误删系统内容。

## 阶段7：检查器与稳定性

状态：基础统计、最近生成检查和调试报告已完成；记忆编辑与消息失效仍待实现。

- 本次上下文检查器；
- 消息编辑、删除和 Swipe失效；
- 分支索引复制/重建；
- 重建进度和取消；
- 导入导出验证；
- 大聊天性能测试；
- 与世界书、MVU和常见扩展兼容测试。

## 阶段8：服务端密钥插件

状态：已完成核心链路，等待真实部署兼容性测试。

- 服务端保存自定义 LLM与Embedding Key；
- 代理 OpenAI兼容Chat Completions与Embedding请求；
- 用户隔离；
- 删除和轮换 Key；
- 威胁模型与安装说明。

该阶段不是使用默认主连接与酒馆默认Embedding的必要条件；选择任一自定义接口时必须安装。
