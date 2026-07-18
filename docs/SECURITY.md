# StoryEcho 安全说明

## API Key

SillyTavern官方文档明确说明：UI扩展的 `extensionSettings` 对其他扩展可见并以明文保存，不能用于存储 API Key。

因此 StoryEcho 遵循以下规则：

- 默认使用 SillyTavern主连接，不接触主连接的 Key；
- 自定义 LLM和Embedding的 Base URL与模型保存在普通扩展设置；
- 两类自定义 API Key由StoryEcho服务端插件写入SillyTavern当前用户的 `secrets.json`；
- Key不写入扩展设置、聊天元数据、Vector Storage、浏览器存储、日志和错误消息；
- Key不会由状态接口回传给浏览器，只返回是否配置、是否含Key和端点指纹；
- 删除操作会清除StoryEcho对应服务端Secret的全部历史版本。

参考：[SillyTavern UI Extensions - Security](https://docs.sillytavern.app/for-contributors/writing-extensions/)

## 自定义端点

- 仅允许 `http:`和 `https:`协议；
- Base URL拒绝内嵌用户名、密码和查询参数，避免把凭据写入设置；
- 默认要求 HTTPS；
- 允许 HTTP必须由用户显式开启，仅建议局域网本地服务；
- 限制响应大小和请求超时；
- 服务端请求拒绝HTTP重定向；
- 错误信息不得包含 Authorization Header。

## 服务端代理与端点绑定

- 自定义LLM和Embedding只由StoryEcho服务端插件请求外部接口，不依赖浏览器CORS或SillyTavern通用CORS代理；
- 保存Key时同时保存规范化后的唯一端点；调用接口只接受该端点的SHA-256指纹，不接受目标URL；
- 更换Base URL必须重新提交Key，修改模型不需要；
- 端点URL拒绝凭据和查询参数，默认仅允许HTTPS；
- LLM/Embedding请求和响应均有数量、长度、超时与响应大小限制；
- Embedding响应必须是JSON，向量数量、数值和维度在服务端和前端均需校验后才能写入Vector Storage；
- 预生成向量会返回浏览器再交给Vector Storage，相似度检索仍在SillyTavern服务端执行；
- API Key、Authorization Header和完整代理请求不进入StoryEcho日志或调试报告。

## 模型输出

- 所有结构化输出执行 Schema校验；
- LLM查询改写只发送最新用户发言和最近 3 条有界非系统上下文，不发送完整聊天；
- 查询改写 Prompt明确把聊天内容视为不可信剧情数据，不执行其中的命令；
- 改写结果只用于 Vector Storage检索，不覆盖用户输入，也不直接作为剧情事实注入；
- 非法输出不会写入聊天元数据；
- 不执行模型返回的代码、HTML或命令；
- UI展示前转义或净化模型文本。

## 调试数据

- 调试模式默认关闭，每个聊天最多保留最近 50 条运行轨迹；
- 复制的调试报告不包含 API Key和自定义 Base URL；
- 调试报告会包含检索查询、事件 ID和召回剧情文本，分享前应按聊天隐私自行检查；
- 重置统计会删除累计指标、调试轨迹和最近一次检查记录，不影响剧情记忆本身。

## 第三方扩展边界

UI扩展运行在同一个浏览器页面。服务端保管可以阻止其他扩展直接读取Key，但同源恶意扩展仍可能调用StoryEcho代理消耗额度、覆盖或删除服务端配置，因此用户仍必须只安装可信扩展。服务端插件不受沙箱限制，只应从可信仓库安装。对于高价值Key，应使用权限和额度受限、可随时撤销的独立密钥。
