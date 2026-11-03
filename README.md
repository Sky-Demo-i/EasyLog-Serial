# EasyLog Serial

EasyLogger 配套的 Windows 串口工作台 · **lyg** · **v0.4.1**

Tauri 2 + React + Rust，免安装便携版。

[下载最新版](https://github.com/Sky-Demo-i/EasyLog-Serial/releases/latest) ·
[问题反馈](https://github.com/Sky-Demo-i/EasyLog-Serial/issues) ·
[更新日志](https://github.com/Sky-Demo-i/EasyLog-Serial/releases)

## 下载与运行

从 [GitHub Releases](https://github.com/Sky-Demo-i/EasyLog-Serial/releases/latest) 下载：

```text
EasyLog-Serial-x.y.z-portable.zip
```

解压后双击 `EasyLogSerial.exe` 即可，无需安装。

必须保留同目录下的：

- `EasyLogSerialUpdater.exe`：自动更新替换器
- `WebView2Loader.dll`

需要 WebView2 Runtime；Windows 10/11 一般已自带。

## 主要功能

- **串口 / TCP Server**：串口参数完整配置；TCP 单端口、单客户端，异常断开继续监听
- **串口自动回连**：异常断开后只回连原 COM 名，不跳到其他端口；接收区保留并插入分隔提示
- **EasyLog / 原始**：EasyLog 解析级别、Tag、函数、行号、TICK；原始模式保留 ANSI
- **日志查看**：级别 / Tag / 关键字过滤，关键字着色，`Ctrl+F` 搜索，`Ctrl+A` 全选，右键复制/清空
- **列宽调整**：时间 / 向 / 级 / Tag / 函数 / 行 / TICK 均可拖动
- **发送**：文本 / HEX、AT 前缀、结尾换行、定时发送、连接后发送激活字符
- **快捷指令**：横向分类页、拖动排序、单击手柄快速移动、HEX 切换、序号循环发送、每条延时、导入/导出
- **保存与回放**：手动保存、JSONL 录制、回放、自动保存
- **自动更新**：GitHub Releases 检查、SHA256 校验、退出后替换并重启，保留 `logs` 和配置

## 快速使用

1. 选择串口和波特率，点击 **连接**
2. 在发送框输入内容，按 `Ctrl+Enter` 发送
3. 左侧过滤栏按级别、Tag、关键字筛选
4. 右侧快捷指令双击载入，或点 **发送** 直接下发
5. 保存、录制、自动保存的文件都在工具目录的 `logs` 下

## 自动更新

- 标题栏 **检查更新**：手动检查
- 启动后最多每 6 小时自动检查一次
- 更新源：GitHub Releases 的静态 `latest.json`
- 下载后校验 SHA256，再由 `EasyLogSerialUpdater.exe` 等待程序退出、备份、替换、重启

首次使用更新功能需要 **v0.4.1 或更高版本**；更旧版本请手动下载一次。

发布新版本：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/release.ps1 `
  -Version 0.4.1 `
  -Notes "本次更新说明"
```

然后在 GitHub 创建 Release，上传生成的便携 ZIP 和 `latest.json`。

## 快捷指令导入

支持：

- JSON：`{ "version": 1, "commands": [...] }`
- 文本：一行一条，`名称<TAB>指令` 或 `名称|指令`
- SSCOM：直接选择 `sscom51.ini`

导入会按名称合并，不会重复追加。

## 源码构建

需要 Rust、Node.js、pnpm、WebView2 Runtime。

```powershell
pnpm install
pnpm build

# 主程序
cd src-tauri
cargo build --release --features custom-protocol

# 更新器
cargo build --release --manifest-path updater/Cargo.toml
```

本机 GNU 工具链的详细说明见 [docs/上位机设计方案.md](docs/上位机设计方案.md)。

## 开源协议

本项目采用 **MIT License**，见 [LICENSE](LICENSE)。

你可以自由使用、修改和再分发，但必须：

- 保留原版权声明和 [LICENSE](LICENSE) 文本
- 再分发时保留本项目的协议说明
- 不得移除作者标识后冒充原创

软件按“现状”提供，不附带任何明示或暗示担保。

## 赞赏作者

如果这个工具对你的调试工作有帮助，欢迎扫码请作者喝杯咖啡。

**赞赏完全自愿，不影响任何功能，也不构成商业服务承诺。**

<img src="public/donate-wechat.jpg" width="260" alt="微信赞赏码" />

感谢支持。
