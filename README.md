# StoryEcho · 剧情回响

StoryEcho 是一个面向 SillyTavern 长剧情聊天的上下文管理扩展。

它只保留最近若干轮原始聊天，并从更早的历史中召回与当前输入相关的关键剧情记忆，在请求发送给 LLM 前将这些记忆插入最近聊天之前。

## 核心目标

- 明确限制每次发送的原始聊天历史长度。
- 将历史对话抽取为可检索、可编辑的结构化剧情记忆，而不是复述原文。
- 使用 SillyTavern Vector Storage 在服务端保存向量和执行语义检索。
- Embedding默认复用酒馆当前来源，也可由StoryEcho服务端插件调用自定义OpenAI兼容接口（包括火山方舟）生成向量；不会另建数据库。
- 默认复用 SillyTavern 主连接完成剧情抽取、事件整理和检索查询改写，也允许使用自定义 OpenAI 兼容接口。
- 与 MVU、世界书和其他状态系统解耦，不重复管理角色状态。
- 让每次裁剪和召回都可见、可解释、可关闭。

## 项目状态

项目处于 Alpha 测试阶段。目前已经具备两种 LLM Provider、自定义OpenAI兼容Embedding、服务端密钥保管与请求代理、剧情事件抽取、六类事件整理动作、LLM检索查询改写、规则降级、聊天元数据存储、Vector Storage增量同步、滑动窗口、生成拦截、运行统计和调试报告。消息编辑/删除失效处理、记忆编辑器和完整可视化检查器仍在开发中。

## 安装

StoryEcho使用同一个仓库同时提供UI扩展和服务端插件。UI扩展负责设置与上下文管理；服务端插件只负责自定义LLM/Embedding的密钥保管和外部请求。使用主连接和酒馆默认Embedding时，服务端插件不会接触任何Key。

先在SillyTavern“扩展程序 → 安装扩展程序”中安装：

```text
https://github.com/liushuangls/ST-StoryEcho
```

再在运行SillyTavern的服务器目录执行：

```bash
node plugins.js install https://github.com/liushuangls/ST-StoryEcho
```

将 `config.yaml` 中的 `enableServerPlugins` 设置为 `true`，然后重启SillyTavern。服务端插件启动成功时终端会显示 `StoryEcho Server plugin 0.5.0 loaded`，设置面板也会显示已连接版本。

## 火山方舟 Embedding

在StoryEcho设置中选择“自定义OpenAI兼容接口（支持火山方舟）”，然后填写：

```text
Base URL: https://ark.cn-beijing.volces.com/api/v3
模型: doubao-embedding-text-… 或方舟推理接入点 ep-…
API Key: 方舟API Key
```

方舟Coding Plan可使用专属Base URL `https://ark.cn-beijing.volces.com/api/coding/v3` 和对应模型名。

点击“保存到服务端”后，Key会按SillyTavern用户保存在酒馆自己的 `secrets.json` 中。Embedding请求由StoryEcho服务端插件直接发送，不依赖浏览器CORS，也无需开启通用CORS代理。Key与规范化后的Base URL绑定；更换Base URL必须重新输入并保存Key，修改模型不需要。生成的向量仍写入当前聊天的SillyTavern Vector Storage集合，存储和相似度检索没有迁移到浏览器。

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
- 剧情导演、自动续写或修改实际发送的用户输入；检索查询改写只用于搜索剧情记忆。
- 保存整份原始聊天的副本；
- 把旧消息重新伪装成当前的 user/assistant 对话。

## 参考资料

- [SillyTavern UI Extensions](https://docs.sillytavern.app/for-contributors/writing-extensions/)
- [SillyTavern Server Plugins](https://docs.sillytavern.app/for-contributors/server-plugins/)
- [SillyTavern Chat Vectorization](https://docs.sillytavern.app/extensions/chat-vectorization/)
- [SillyTavern Data Bank / Vector Storage](https://docs.sillytavern.app/usage/core-concepts/data-bank/)
