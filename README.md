# EasyLog Serial

EasyLogger 配套的 Windows 串口工作台 · **lyg** · **v0.4.10**

[下载最新版](https://gitee.com/sky_demo_lu/EasyLog-Serial/releases/tag/v0.4.10) ·
[GitHub 备用](https://github.com/Sky-Demo-i/EasyLog-Serial/releases/latest) ·
[问题反馈](https://github.com/Sky-Demo-i/EasyLog-Serial/issues)

<img src="docs/feature-overview.png" width="760" alt="EasyLog Serial 三个核心动作" />

## 实际界面

<img src="docs/screenshot-main.png" width="920" alt="EasyLog Serial 实际界面" />

## 核心功能

### 日志查看与搜索

- EasyLog / 原始模式自由切换，原始模式保留 ANSI
- 级别、Tag、关键字过滤，关键字命中整行着色
- `Ctrl+F` 接收框内搜索，高亮命中并直接跳转
- `Ctrl+A` 全选、`Ctrl+C` 复制，右键复制选中/全部/清除
- 时间 / 向 / 级 / Tag / 函数 / 行 / TICK 列宽可拖动

### 串口与 TCP

- 串口参数完整配置，支持 AT 前缀、HEX、定时发送、连接后发送
- 串口异常断开可手动开启自动回连原 COM 名（默认关闭）
- TCP Server 单端口、单客户端，异常断开继续监听

### 快捷指令

- 横向分类页，每页独立全选/取消
- `⋮⋮` 拖动排序，拖到边缘自动滚动；单击手柄可快速置顶/置底
- HEX / 文本切换、序号循环发送、序号清零、每条发送后延时
- 支持文本、JSON、SSCOM `sscom51.ini` 导入

### 保存与查看

- 手动保存带完整时间戳和收发方向的 `.txt`
- 自动保存只写时间戳 `.log`，一个启用周期一个主文件，断开重连继续追加
- 自动保存大小可选“不限”，一直叠加不分段；有限大小仅在单文件超过上限时续写同周期编号文件
- 打开已保存的 `.log` / `.jsonl` 文件，直接搜索和查看，不进入回放

## 赞赏作者

如果这个工具对你的调试工作有帮助，欢迎扫码请作者喝杯咖啡。

**赞赏完全自愿，不影响任何功能，也不构成商业服务承诺。**

<img src="public/donate-wechat-qr.png" width="240" alt="微信赞赏码" />

感谢支持。
