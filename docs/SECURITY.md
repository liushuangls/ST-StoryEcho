# StoryEcho 安全说明

## API Key

SillyTavern官方文档明确说明：UI扩展的 `extensionSettings` 对其他扩展可见并以明文保存，不能用于存储 API Key。

因此 StoryEcho 遵循以下规则：

- 默认使用 SillyTavern主连接，不接触主连接的 Key；
- 自定义 Provider的 Base URL和模型可以持久化；
- 自定义 API Key在纯 UI扩展中仅保存在页面运行内存；
- 页面刷新或关闭后 Key消失；
- Key不写入设置、聊天元数据、Vector Storage、日志和错误消息；
- 未来持久化 Key只能由可选服务端插件实现。

参考：[SillyTavern UI Extensions - Security](https://docs.sillytavern.app/for-contributors/writing-extensions/)

## 自定义端点

- 仅允许 `http:`和 `https:`协议；
- Base URL拒绝内嵌用户名、密码和查询参数，避免把凭据写入设置；
- 默认要求 HTTPS；
- 允许 HTTP必须由用户显式开启，仅建议局域网本地服务；
- 限制响应大小和请求超时；
- 不自动跟随把 Key发送到不同Origin的重定向；
- 错误信息不得包含 Authorization Header。

## 模型输出

- 所有结构化输出执行 Schema校验；
- 非法输出不会写入聊天元数据；
- 不执行模型返回的代码、HTML或命令；
- UI展示前转义或净化模型文本。

## 第三方扩展边界

UI扩展运行在同一个浏览器页面，无法防止其他恶意扩展读取页面内存。使用自定义 Key前，用户必须信任当前安装的所有第三方扩展。对于高价值 Key，应使用权限受限、额度受限且可随时撤销的独立密钥。
