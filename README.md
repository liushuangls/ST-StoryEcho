# StoryEcho · 剧情回响

StoryEcho 是一个面向 SillyTavern 长剧情聊天的上下文管理扩展。

它只保留最近若干轮原始聊天，并从更早的历史中召回与当前输入相关的关键剧情记忆，在请求发送给 LLM 前将这些记忆插入最近聊天之前。

## 核心目标

- 明确限制每次发送的原始聊天历史长度。
- 将历史对话抽取为可检索、可编辑的结构化剧情记忆，而不是复述原文。
- 使用 SillyTavern Vector Storage 在服务端保存向量和执行语义检索。
- 默认复用 SillyTavern 主连接，也允许使用自定义 OpenAI 兼容接口。
- 与 MVU、世界书和其他状态系统解耦，不重复管理角色状态。
- 让每次裁剪和召回都可见、可解释、可关闭。

## 项目状态

项目处于早期开发阶段。目前已经具备扩展骨架、设置界面、两种 LLM Provider、剧情事件基础抽取、聊天元数据存储、Vector Storage适配、滑动窗口计算和生成拦截链路。事件合并整理、消息失效处理和完整检查器仍在开发中。

## 开发与安装产物

```bash
npm install
npm run check
```

`manifest.json` 加载 `dist/index.js`。SillyTavern 通过 Git 地址安装扩展时不会执行前端构建，因此仓库会提交由源码生成的 `dist/`；修改源码后必须重新运行构建并一起提交产物。

## 文档

- [产品需求](docs/PRODUCT_SPEC.md)
- [技术架构](docs/ARCHITECTURE.md)
- [实现计划](docs/IMPLEMENTATION_PLAN.md)
- [当前实现状态](docs/STATUS.md)
- [安全说明](docs/SECURITY.md)

## 设计边界

StoryEcho 不负责：

- MVU 变量或角色状态管理；
- 世界书内容管理；
- 剧情导演、自动续写或改写用户输入；
- 保存整份原始聊天的副本；
- 把旧消息重新伪装成当前的 user/assistant 对话。

## 参考资料

- [SillyTavern UI Extensions](https://docs.sillytavern.app/for-contributors/writing-extensions/)
- [SillyTavern Chat Vectorization](https://docs.sillytavern.app/extensions/chat-vectorization/)
- [SillyTavern Data Bank / Vector Storage](https://docs.sillytavern.app/usage/core-concepts/data-bank/)
