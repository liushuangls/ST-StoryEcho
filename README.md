# StoryEcho · 剧情回响

StoryEcho 是一个面向 SillyTavern 长剧情聊天的上下文管理扩展。

它把长聊天整理成“滚动阶段总结 + 近期原文 + 按需剧情召回”：较早历史被压缩成有界的阶段总结和可检索的关键剧情事件，正常生成至少保留最近若干完整轮次原文，并在最新用户输入之前临时注入与本轮相关的历史事实。

## 核心目标

- 明确限制每次发送的原始聊天历史长度；
- 使用有覆盖游标的滚动阶段总结维持长期剧情脉络；
- 将历史对话抽取为结构化剧情记忆，而不是复制原文；
- 使用 SillyTavern Vector Storage 在服务端保存向量和执行语义检索；
- 默认复用 SillyTavern 主连接和当前向量来源；
- 可分别配置自定义 OpenAI 兼容 LLM、OpenAI 兼容 Embedding 与火山方舟多模态 Embedding；
- 与 MVU、世界书和其他状态系统解耦；
- 让裁剪、抽取、整理和召回可统计、可调试、可关闭。

## 请求与存储方案

StoryEcho 采用无需额外服务端插件的组合方案：

```text
自定义 LLM
浏览器扩展 -> SillyTavern自带Chat Completions后端 -> 外部LLM

自定义 Embedding
浏览器扩展 -> SillyTavern内置/proxy -> 外部Embedding接口
             -> 预生成向量 -> SillyTavern Vector Storage
                                （服务端保存和检索）
```

- 自定义 LLM 使用酒馆自带的 `/api/backends/chat-completions/generate` 转发，外部请求由 SillyTavern 服务端发出；
- 自定义 Embedding 自动把外部地址路由到 SillyTavern 内置 `/proxy/`，由酒馆服务端请求，因此不要求外部接口允许浏览器 CORS；
- 浏览器只负责生成自定义向量，不在前端维护向量数据库或执行余弦检索；
- 向量仍交给 SillyTavern Vector Storage，因而可随酒馆数据在多端共用。

## 项目状态

项目处于 Alpha 测试阶段。目前已有两种 LLM Provider、OpenAI 兼容与火山方舟多模态两种外部 Embedding、剧情事件抽取、候选质量门槛、六类事件整理动作、LLM 查询改写与规则降级、聊天元数据存储、Vector Storage 增量同步、滑动窗口、生成拦截、运行统计和调试报告。合并记忆会按完整 `sourceHistory` 判断是否越过窗口边界，避免“最新确认仍在窗口内”时漏召回更早的关键状态。

主连接用于后台总结、抽取、整理和查询改写时会临时采用轻量推理设置，不改变正常角色聊天的推理预设，避免推理模型把整个后台输出预算消耗在隐藏思考中。召回注入使用结构化事件、当前结果、状态变化、实体和知情范围重新渲染，不直接依赖模型生成的第一人称摘要。

正常角色请求中的顺序固定为：

```text
角色卡、世界书、系统提示
历史阶段总结
尚未总结的近期原文（至少保留配置的 N 个完整轮次）
本轮动态召回（请求级 system，不写入聊天记录）
当前用户原始输入
```

冲突时使用“当前用户输入 > 近期原文 > 动态召回 > 阶段总结”的新旧优先级。当前用户消息本身不会被修改。

消息编辑、删楼、Swipe 与分支切换已经采用保守失效重建；记忆编辑器和完整可视化检查器仍在开发中。

## 安装

只需在 SillyTavern“扩展程序 → 安装扩展程序”中安装：

```text
https://github.com/liushuangls/ST-StoryEcho
```

不需要安装或启用 SillyTavern Server Plugin。

使用自定义 Embedding 前，需要在 SillyTavern 的 `config.yaml` 中启用内置代理并重启：

```yaml
enableCorsProxy: true
```

StoryEcho 会在请求时自动添加 `/proxy/`；设置中仍填写正常的外部 Base URL，不要手动添加代理前缀。默认继承 Vector Storage 来源时不需要开启此选项。

## 自定义接口与 Key

LLM 与 Embedding 的 Base URL、模型和 API Key 都保存在当前 SillyTavern 用户的 `extensionSettings` 中，并由酒馆的设置同步机制持久化。刷新页面后会自动恢复；使用同一酒馆用户数据的其他客户端也能读取。

这带来的安全边界必须明确：Key 是明文设置，不是 SecretManager 密钥。它对同页面的其他 UI 扩展和能读取用户设置的人可见。建议使用限额、限权、可撤销的独立 Key。调试报告、聊天元数据和 Vector Storage 不记录 Key。

### 火山方舟 Embedding

在 StoryEcho 设置中选择“火山方舟多模态Embedding”，填写：

```text
Base URL: https://ark.cn-beijing.volces.com/api/v3
模型: doubao-embedding-vision-251215 或多模态推理接入点 ep-m-…
API Key: 方舟API Key
```

StoryEcho 会调用 `/api/v3/embeddings/multimodal`，把每段剧情文本作为独立的 `{ type: "text" }` 输入，最多并发 4 个请求，并从 `data.embedding` 读取向量。点击“测试火山Embedding连接”验证酒馆代理与方舟配置；测试成功后，生成的向量仍写入当前聊天的 Vector Storage 集合。

方舟 Coding Plan 的 `https://ark.cn-beijing.volces.com/api/coding/v3` 属于 OpenAI 兼容协议，应继续选择“自定义OpenAI兼容接口”，并使用套餐提供的模型名。

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
