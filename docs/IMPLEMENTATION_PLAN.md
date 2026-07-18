# StoryEcho 实现计划

## 阶段0：项目基础

- TypeScript 构建、扩展 manifest、设置仓库、日志、错误边界和单元测试；
- 可通过 Git 地址直接安装的 `dist/` 产物；
- 基础设置面板和响应式布局。

状态：已完成。

## 阶段1：LLM Provider

- 主连接 Provider；
- 自定义 OpenAI 兼容 Provider；
- Base URL 规范化；
- 自定义请求经 SillyTavern 自带 Chat Completions 后端转发；
- Key 通过扩展设置持久化和同步；
- 超时、取消、结构化输出、连接测试和可选回退。

状态：已完成核心链路，等待更多真实接口样本。

## 阶段2：聊天记忆存储

- `StoryMemory` Schema 和 `chatMetadata` Repository；
- Schema 版本、聊天 UUID 和分支隔离；
- 来源哈希与失效检测；
- 记忆查看、编辑和删除。

状态：权威存储和分支隔离已完成；失效检测与编辑器待完成。

## 阶段3：Vector Storage 与自定义 Embedding

- Vector Storage insert/list/query/delete/purge；
- 哈希碰撞处理、增量同步和完整重建；
- Embedding 来源、端点和模型变化检测；
- 自定义 OpenAI 兼容 Embedding 浏览器直连；
- 响应校验、连接测试、Key 设置同步；
- 预生成向量继续由 Vector Storage 保存与检索。

状态：核心链路已完成，等待火山方舟等真实接口和 CORS 兼容测试。

## 阶段4：剧情抽取

- 固定轮次切块；
- 候选事件提取 Prompt 与 Schema；
- JSON 解析和修复重试；
- 手动抽取与窗口边界自动追赶；
- 后台抽取队列。

状态：同步核心链路已完成；后台低优先级队列待完成。

## 阶段5：事件整理

- 相似旧事件预检索；
- CREATE/MERGE/UPDATE/RESOLVE/SUPERSEDE/IGNORE；
- 原子事务更新、向量同步队列和手工修改保护。

状态：核心链路已完成，等待真实聊天样本调优。

## 阶段6：滑动窗口与召回

- 按轮次/消息计算保留边界；
- LLM 上下文查询改写、缓存与本地规则回退；
- 双路召回、轻量重排和 Token 预算；
- 记忆块渲染和 Prompt Interceptor；
- 后台调用与正常生成隔离。

状态：已完成核心链路。

## 阶段7：检查器与稳定性

- 本次上下文检查器；
- 消息编辑、删除和 Swipe 失效；
- 分支索引复制/重建；
- 重建进度和取消；
- 导入导出验证、大聊天性能测试；
- 与世界书、MVU 和常见扩展兼容测试。

状态：基础统计、最近检查和调试报告已完成；其余持续开发。
