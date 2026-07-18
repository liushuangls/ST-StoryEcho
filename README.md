# StoryEcho · 剧情回响

StoryEcho 是一个面向 SillyTavern 长剧情聊天的上下文管理扩展。

它只向 LLM 保留最近若干轮原始聊天，把更早的历史抽取成可检索的关键剧情事件，并在生成前召回与当前输入相关的事件，插入最近聊天之前。

## 核心目标

- 明确限制每次发送的原始聊天历史长度；
- 将历史对话抽取为结构化剧情记忆，而不是复制原文；
- 使用 SillyTavern Vector Storage 在服务端保存向量和执行语义检索；
- 默认复用 SillyTavern 主连接和当前向量来源；
- 可分别配置自定义 OpenAI 兼容 LLM 与 Embedding，包括火山方舟；
- 与 MVU、世界书和其他状态系统解耦；
- 让裁剪、抽取、整理和召回可统计、可调试、可关闭。

## 请求与存储方案

StoryEcho 采用无需额外服务端插件的组合方案：

```text
自定义 LLM
浏览器扩展 -> SillyTavern自带Chat Completions后端 -> 外部LLM

自定义 Embedding
浏览器扩展 -> 外部Embedding接口
             -> 预生成向量 -> SillyTavern Vector Storage
                                （服务端保存和检索）
```

- 自定义 LLM 使用酒馆自带的 `/api/backends/chat-completions/generate` 转发，外部请求由 SillyTavern 服务端发出；
- 自定义 Embedding 沿用脚本化数据库插件的做法，由浏览器直接请求，因此接口必须允许当前酒馆网页跨域访问（CORS）；
- 浏览器只负责生成自定义向量，不在前端维护向量数据库或执行余弦检索；
- 向量仍交给 SillyTavern Vector Storage，因而可随酒馆数据在多端共用。

## 项目状态

项目处于 Alpha 测试阶段。目前已有两种 LLM Provider、自定义 OpenAI 兼容 Embedding、剧情事件抽取、六类事件整理动作、LLM 查询改写与规则降级、聊天元数据存储、Vector Storage 增量同步、滑动窗口、生成拦截、运行统计和调试报告。

消息编辑/删除失效处理、记忆编辑器和完整可视化检查器仍在开发中。

## 安装

只需在 SillyTavern“扩展程序 → 安装扩展程序”中安装：

```text
https://github.com/liushuangls/ST-StoryEcho
```

不需要安装或启用 SillyTavern Server Plugin。

## 自定义接口与 Key

LLM 与 Embedding 的 Base URL、模型和 API Key 都保存在当前 SillyTavern 用户的 `extensionSettings` 中，并由酒馆的设置同步机制持久化。刷新页面后会自动恢复；使用同一酒馆用户数据的其他客户端也能读取。

这带来的安全边界必须明确：Key 是明文设置，不是 SecretManager 密钥。它对同页面的其他 UI 扩展和能读取用户设置的人可见。建议使用限额、限权、可撤销的独立 Key。调试报告、聊天元数据和 Vector Storage 不记录 Key。

### 火山方舟 Embedding

在 StoryEcho 设置中选择“自定义 OpenAI 兼容接口（支持火山方舟）”，填写：

```text
Base URL: https://ark.cn-beijing.volces.com/api/v3
模型: doubao-embedding-text-… 或方舟推理接入点 ep-…
API Key: 方舟API Key
```

方舟 Coding Plan 可使用专属 Base URL `https://ark.cn-beijing.volces.com/api/coding/v3` 和对应模型名。点击“测试 Embedding 连接”验证浏览器网络与 CORS；测试成功后，生成的向量仍写入当前聊天的 Vector Storage 集合。

## 开发与安装产物

```bash
npm install
npm run check
```

`manifest.json` 加载 `dist/index.js`。SillyTavern 通过 Git 地址安装扩展时不会执行前端构建，因此仓库会提交由源码生成的 `dist/`；修改源码后必须重新构建并一起提交产物。

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
- 剧情导演、自动续写或修改实际发送的用户输入；
- 保存整份原始聊天的副本；
- 把旧消息重新伪装成当前的 user/assistant 对话。

## 参考资料

- [SillyTavern UI Extensions](https://docs.sillytavern.app/for-contributors/writing-extensions/)
- [SillyTavern Chat Vectorization](https://docs.sillytavern.app/extensions/chat-vectorization/)
- [SillyTavern Data Bank / Vector Storage](https://docs.sillytavern.app/usage/core-concepts/data-bank/)
