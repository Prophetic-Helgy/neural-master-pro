# Neural Master Pro 2.2

专业级的 AI 驱动音频母带处理套件。具有高级诊断、参考轨道匹配以及带有硬件监控的完整导出功能。

## 主要功能
- AI 母带处理与参考匹配
- 深入检查：LUFS、峰值、RMS 和相位
- 支持音频和视频格式的时间轴修剪和导出
- 多语言支持，以及硬件显示：CPU/GPU 徽章展示设备真实名称，传感器可用时显示实际温度（否则「--°C」）


---
**免责声明**: 本软件免费提供，但作者不拒绝点赞、订阅和捐赠！❤️

**作者:** Oleg Abezov
**Telegram:** [@DunkanMcLeod](https://t.me/DunkanMcLeod)
**Instagram:** [@only_monochrome](https://instagram.com/only_monochrome)


## 安装 (Windows)

1. 下载并提取存储库到您所需的文件夹，例如：`C:\您的\路径\至\Neural_Master_Pro`。
2. 打开 **Windows PowerShell**（建议以管理员身份运行，以便获得准确的硬件传感器数据）。
3. 导航到该文件夹：`cd C:\您的\路径\至\Neural_Master_Pro`
4. 安装依赖项：`npm install`
5. 构建可执行文件：`npm run build:exe`
6. 安装文件（例如 `Neural Master Pro 2.2 Setup 2.2.0.exe`）将在 `release` 文件夹中生成。