# EasyLog Serial

EasyLogger 配套的 Windows 串口工作台 · **lyg** · **v0.4.2**

Tauri 2 + React + Rust · Windows 10/11 · 免安装便携版

[下载最新版](https://github.com/Sky-Demo-i/EasyLog-Serial/releases/latest) ·
[问题反馈](https://github.com/Sky-Demo-i/EasyLog-Serial/issues) ·
[更新日志](https://github.com/Sky-Demo-i/EasyLog-Serial/releases)

<img src="docs/feature-overview.png" width="760" alt="EasyLog Serial 三个核心动作" />

## 实际界面

<img src="docs/screenshot-main.png" width="920" alt="EasyLog Serial 实际界面" />

## 功能一览

### 日志查看与搜索

- EasyLog / 原始模式互斥切换，原始模式保留 ANSI
- 级别、Tag、关键字过滤；关键字命中整行着色
- `Ctrl+F` 在接收框内搜索，高亮命中并可直接跳转
- `Ctrl+A` 全选、`Ctrl+C` 复制、右键菜单复制选中/全部/清除
- 时间 / 向 / 级 / Tag / 函数 / 行 / TICK 列宽均可拖动

### 串口与 TCP

- 串口参数完整配置，支持 AT 前缀、HEX、定时发送、连接后发送激活字符
- 串口异常断开自动回连**原 COM 名**，不跳到其他端口；接收区保留并插入分隔提示
- TCP Server 单端口、单客户端；异常断开继续监听，手动停止才关闭

### 快捷指令

- 横向分类页，每页独立全选/取消
- 行尾 `⋮⋮` 拖动排序，拖到边缘自动滚动；也可点击手柄快速置顶/置底
- HEX / 文本切换；序号循环发送、序号清零、每条发送后延时
- 支持文本、JSON、SSCOM `sscom51.ini` 导入

### 保存与回放

- 手动保存、JSONL 录制、会话回放
- 自动保存同时写 JSONL 和可读 `.log`，文件都在工具目录 `logs`

## 自动更新

- 标题栏 **检查更新**：手动检查
- 启动后最多每 6 小时自动检查一次
- 更新源：GitHub Releases 静态 `latest.json`
- 下载校验 SHA256 后，由 `EasyLogSerialUpdater.exe` 等待程序退出、备份、替换并重启
- 保留 `logs` 和本地配置

首次使用自动更新需要 **v0.4.0 或更高版本**。旧版请手动下载一次。

## 下载与运行

从 [GitHub Releases](https://github.com/Sky-Demo-i/EasyLog-Serial/releases/latest) 下载便携 ZIP，解压后运行 `EasyLogSerial.exe`。

同目录需保留：

- `EasyLogSerialUpdater.exe`：自动更新替换器
- `WebView2Loader.dll`

## 源码构建

```powershell
pnpm install
pnpm build

cd src-tauri
cargo build --release --features custom-protocol
cargo build --release --manifest-path updater/Cargo.toml
```

发布脚本：`scripts/release.ps1`。

## 开源协议

本项目采用 **MIT License**，见 [LICENSE](LICENSE)。

允许使用、修改和再分发，但必须保留版权声明和 LICENSE 文本；不得移除作者标识后冒充原创。

软件按“现状”提供，不附带任何明示或暗示担保。

## 赞赏作者

如果这个工具对你的调试工作有帮助，欢迎扫码请作者喝杯咖啡。

**赞赏完全自愿，不影响任何功能，也不构成商业服务承诺。**

<img src="public/donate-wechat-qr.png" width="240" alt="微信赞赏码" />

感谢支持。
