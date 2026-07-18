# StoryEcho 安全说明

## API Key 的真实存储边界

为了做到无需额外服务端插件且能跟随 SillyTavern 用户设置多端同步，StoryEcho 将自定义 LLM 与 Embedding 的 API Key 保存在 `extensionSettings.story_echo`。

这是一种方便优先的设计，不是安全密钥库：

- Key 会由 SillyTavern 持久化和同步，刷新页面后无需重填；
- Key 以明文存在于用户设置中；
- 同页面运行的其他 UI 扩展可以读取它；
- 能访问用户设置文件、备份或同步数据的人也可能读取它；
- Key 不写入聊天元数据、角色卡、Vector Storage、日志或调试报告；
- 重置 StoryEcho 设置会清除这两个 Key。

建议使用额度受限、权限最小、可随时撤销的独立 Key，不要复用高价值主账号密钥。

参考：[SillyTavern UI Extensions - Security](https://docs.sillytavern.app/for-contributors/writing-extensions/)

## 两条请求链路

### 自定义 LLM

- 浏览器把模型、提示、Base URL 和 Authorization Header 配置发送给同源的 SillyTavern 后端；
- SillyTavern 自带的 Chat Completions 后端再请求外部 LLM；
- 浏览器不直接跨域连接 LLM 接口，但 Key 仍会经过前端运行时和浏览器到酒馆服务器的请求；
- HTTP 部署下，浏览器到 SillyTavern 服务器这一段没有 TLS，局域网内仍可能被监听。

### 自定义 Embedding

- 浏览器向同源的 SillyTavern `/proxy/` 发送 `{ model, input }` 和可选 Bearer Key；
- SillyTavern 内置代理再请求外部 Embedding Endpoint，因此外部接口不需要允许浏览器 CORS；
- 使用自定义 Embedding 必须在 `config.yaml` 启用 `enableCorsProxy` 并重启酒馆；
- 返回向量在浏览器校验数量、有限数值和统一维度；
- 向量随后交给 SillyTavern Vector Storage，保存和相似度检索仍在酒馆服务端完成；
- StoryEcho 不在浏览器持久化独立向量索引。

## 自定义端点

- 仅允许 `http:` 和 `https:`；
- Base URL 拒绝内嵌用户名、密码和查询参数，避免凭据混入 URL；
- 默认要求 HTTPS；HTTP 必须显式开启，仅建议可信局域网服务；
- LLM 和 Embedding 请求都有超时；响应大小受限；
- 错误消息会裁剪，并在可能时移除当前 Key；
- Embedding Base URL 只在请求时自动加同源 `/proxy/` 前缀，持久化设置中不保存代理地址；
- SillyTavern 内置代理会处理外部重定向；仅应连接可信的 Embedding Endpoint；
- 修改 Embedding 端点或模型会触发向量集合重建，修改 Key 或超时不会。

## 模型输出

- 结构化输出执行 Schema 校验；
- LLM 查询改写只发送最新用户发言和最近 3 条有界非系统上下文，不发送完整聊天；
- 查询改写 Prompt 把聊天内容视为不可信剧情数据；
- 改写结果只用于检索，不覆盖用户输入，也不直接作为剧情事实注入；
- 非法输出不会写入聊天元数据；
- 不执行模型返回的代码、HTML 或命令。

## 调试数据

- 调试模式默认关闭，每个聊天最多保留最近 50 条运行轨迹；
- 调试报告不包含 API Key 和自定义 LLM Base URL；
- 报告会包含检索查询、事件 ID 和召回剧情文本，分享前应检查聊天隐私；
- 重置统计会删除累计指标、调试轨迹和最近一次检查记录，不影响剧情记忆。

## 第三方扩展边界

所有 UI 扩展运行在同一个页面信任域。StoryEcho 无法阻止恶意扩展读取设置、截获请求或滥用已配置接口，因此只应安装可信扩展。若需要更强的密钥隔离，应改用专门的服务端 SecretManager 方案；这会增加一次独立安装与维护成本，不是当前默认架构。
