[English](../README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Português](README.pt-BR.md) | [हिन्दी](README.hi.md)

# pi-voicekit

<p align="center">
  <img src="../assets/banner.png" alt="pi-voicekit — Pi 编程智能体的语音输入工具" width="100%" />
</p>

**为 [Pi](https://github.com/earendil-works/pi-coding-agent) 打造的按住即说语音输入。** 支持 Deepgram 云端流式传输或本地模型完全离线使用。

[![npm version](https://img.shields.io/npm/v/pi-voicekit.svg)](https://www.npmjs.com/package/pi-voicekit)
[![license](https://img.shields.io/npm/l/pi-voicekit.svg)](https://github.com/CyFeng16/pi-voicekit/blob/main/LICENSE)
[![author](https://img.shields.io/badge/author-@baanditeagle-1DA1F2?logo=x&logoColor=white)](https://x.com/baanditeagle)

> **v5.0.1 — 安全补丁** — API 密钥不再泄露到项目配置中。麦克风音频无法通过恶意仓库设置重定向到远程服务器。API 密钥引导流程中的 Shell 注入漏洞已修复。配置写入现在是原子操作。[完整更新日志 →](../CHANGELOG.md)

---

## 看看它是如何工作的

<video src="../assets/pi-listen.mp4" controls width="100%"></video>

---

## 安装配置（2 分钟）

### 1. 安装扩展

```bash
# 在普通终端中运行（不要在 Pi 内部运行）
pi install npm:pi-voicekit
```

### 2. 选择转录后端

pi-voicekit 支持两种转录后端：

|              | Deepgram（云端）                            | 本地模型（离线）                      |
| ------------ | ------------------------------------------- | ------------------------------------- |
| **工作方式** | 实时流式传输 — 边说边出文字                 | 批量模式 — 录完后再转录               |
| **设置**     | 需要 API 密钥                               | 无需 API 密钥，模型首次使用时自动下载 |
| **网络**     | 需要联网                                    | 模型下载后无需联网                    |
| **延迟**     | 实时中间结果                                | 停止录音后 2–10 秒                    |
| **语言**     | 56+ 种语言支持实时流式传输                  | 取决于模型（1–57 种语言）             |
| **费用**     | $200 免费额度（大多数开发者可用 6–12 个月） | 永久免费                              |

在 Pi 内运行 `/voice-settings` 选择后端并一站式完成所有配置。

#### 方案 A：Deepgram（推荐用于实时流式传输）

前往 [dpgr.am/pi-voice](https://dpgr.am/pi-voice) 注册 — $200 免费额度，无需绑卡。

```bash
export DEEPGRAM_API_KEY="your-key-here"    # 添加到 ~/.zshrc 或 ~/.bashrc
```

#### 方案 B：本地模型（完全离线）

无需额外设置 — 运行 `/voice-settings`，将后端切换为 Local，选择模型即可自动下载。

> **注意：** 本地模型使用批量模式 — 录完后再转录，不是边说边转。如需边说边转的实时流式体验，请使用 Deepgram。

### 3. 打开 Pi

首次启动时，pi-voicekit 会检查你的配置并告知就绪状态：

- 后端已配置（Deepgram 密钥或本地模型）
- 检测到音频捕获工具（sox、ffmpeg 或 arecord）
- 如果一切就绪，语音功能立即激活

### 音频捕获

pi-voicekit 自动检测你的音频工具。如果你已安装 sox 或 ffmpeg，无需手动安装。

| 优先级 | 工具            | 支持平台              | 安装方式                                                     |
| ------ | --------------- | --------------------- | ------------------------------------------------------------ |
| 1      | **SoX** (`rec`) | macOS、Linux、Windows | `brew install sox` / `apt install sox` / `choco install sox` |
| 2      | **ffmpeg**      | macOS、Linux、Windows | `brew install ffmpeg` / `apt install ffmpeg`                 |
| 3      | **arecord**     | 仅 Linux              | 预装（ALSA）                                                 |

---

## 设置面板

所有配置集中在一个地方：`/voice-settings`。四个标签页涵盖你需要的一切。

### 通用 — 后端、语言、作用域

<img src="../assets/settings-general.png" alt="通用设置 — 后端、模型、语言、作用域、语音开关" width="600" />

在 Deepgram（云端，实时流式传输）和 Local（离线，批量模式）之间切换。更改语言、作用域，启用/禁用语音 — 全部支持键盘快捷键操作。

### 模型 — 浏览、搜索、安装

<img src="../assets/settings-models.png" alt="模型标签页 — 浏览 21 个模型，带准确度/速度评分" width="600" />

浏览来自 Parakeet、Whisper、Moonshine、SenseVoice、GigaAM、Paraformer 和 Qwen3 的 21 个模型。每个模型显示准确度和速度评分（●●●●○/●●●●○）、适用性标签和下载状态。支持模糊搜索快速查找模型。按 Enter 激活并下载。

### 已下载 — 管理已安装的模型

<img src="../assets/settings-downloaded.png" alt="已下载标签页 — 管理已安装模型，激活或删除" width="600" />

查看已安装的模型、总磁盘占用和当前激活的模型。按 Enter 激活，按 `x` 删除。来自 [Handy](https://github.com/cjpais/handy) 的模型会被自动检测，可直接导入无需重新下载。

### 设备 — 硬件信息和依赖项

<img src="../assets/settings-device.png" alt="设备标签页 — 硬件信息、依赖项、磁盘空间" width="600" />

查看硬件信息（内存、CPU、GPU）、依赖项状态（sherpa-onnx 运行时）、可用磁盘空间和已下载模型总大小。模型推荐基于你的硬件配置。

---

## 使用方法

### 快捷键

| 操作             | 按键                    | 说明                                                     |
| ---------------- | ----------------------- | -------------------------------------------------------- |
| **录音到编辑器** | 按住 `SPACE`（≥1.2 秒） | 松开后完成转录。预热期间预录音频，确保不会错过第一个字。 |
| **切换录音**     | `Ctrl+Shift+V`          | 适用于所有终端 — 按一次开始，再按一次停止。              |
| **清空编辑器**   | `Escape` × 2            | 500 毫秒内双击清空所有文字。                             |

### 录音工作原理

1. **按住 SPACE** — 显示预热倒计时，音频捕获立即开始（预录音）
2. **持续按住** — 实时转录流入编辑器（Deepgram）或缓冲音频（本地模型）
3. **松开 SPACE** — 继续录音 1.5 秒（尾部录音）捕获你的最后一个字，然后完成转录
4. 文字出现在编辑器中，随时可以发送

### 命令

| 命令                | 说明                                      |
| ------------------- | ----------------------------------------- |
| `/voice-settings`   | 设置面板 — 后端、模型、语言、作用域、设备 |
| `/voice-models`     | 设置面板（模型标签页）                    |
| `/voice test`       | 完整诊断 — 音频工具、麦克风、API 密钥     |
| `/voice on` / `off` | 启用或禁用语音                            |
| `/voice dictate`    | 连续听写（无需按住按键）                  |
| `/voice stop`       | 停止当前录音或听写                        |
| `/voice history`    | 最近的转录记录                            |
| `/voice`            | 开关切换                                  |

---

## 本地模型

21 个模型，涵盖 7 个系列。按质量排序 — 最佳模型排在前面。

### 推荐首选

| 模型                | 准确度 | 速度  | 大小   | 语言           | 说明                 |
| ------------------- | ------ | ----- | ------ | -------------- | -------------------- |
| **Parakeet TDT v3** | ●●●●○  | ●●●●○ | 671 MB | 25（自动检测） | 综合最佳。WER 6.3%。 |
| **Parakeet TDT v2** | ●●●●●  | ●●●●○ | 661 MB | 英语           | 英语最佳。WER 6.0%。 |
| **Whisper Turbo**   | ●●●●○  | ●●○○○ | 1.0 GB | 57             | 语言支持最广泛。     |

### 快速轻量

| 模型                  | 准确度 | 速度  | 大小   | 语言           | 说明                    |
| --------------------- | ------ | ----- | ------ | -------------- | ----------------------- |
| **Moonshine v2 Tiny** | ●●○○○  | ●●●●● | 43 MB  | 英语           | 34ms 延迟。适合树莓派。 |
| **Moonshine Base**    | ●●●○○  | ●●●●● | 287 MB | 英语           | 口音识别表现良好。      |
| **SenseVoice Small**  | ●●●○○  | ●●●●● | 228 MB | 中/英/日/韩/粤 | 中日韩语言最佳选择。    |

### 专项模型

| 模型                 | 准确度 | 速度  | 大小   | 语言 | 说明                                 |
| -------------------- | ------ | ----- | ------ | ---- | ------------------------------------ |
| **GigaAM v3**        | ●●●●○  | ●●●●○ | 225 MB | 俄语 | 俄语识别 WER 比 Whisper 低 50%。     |
| **Whisper Medium**   | ●●●●○  | ●●●○○ | 946 MB | 57   | 准确度好，速度适中。                 |
| **Whisper Large v3** | ●●●●○  | ●○○○○ | 1.8 GB | 57   | Whisper 系列最高准确度。CPU 上较慢。 |

另有 8 个语言专用 Moonshine v2 变体，支持日语、韩语、阿拉伯语、中文、乌克兰语、越南语和西班牙语。

### 本地模型工作原理

```
按住 SPACE → 音频捕获到内存缓冲区
                ↓
松开 SPACE → 缓冲区发送给 sherpa-onnx（进程内）
                ↓
         ONNX 在 CPU 上推理（2–10 秒）
                ↓
         最终转录结果插入编辑器
```

模型首次使用时自动下载。下载支持断点续传，完成后自动校验，且不会重复下载。设置面板实时显示下载进度、速度和预计完成时间。

来自 [Handy](https://github.com/cjpais/handy)（`~/Library/Application Support/com.pais.handy/models/`）的模型会被自动检测，可通过符号链接导入（零磁盘重复占用）。

---

## 功能特性

| 功能               | 说明                                                                     |
| ------------------ | ------------------------------------------------------------------------ |
| **双后端**         | Deepgram（云端，实时流式传输）或本地模型（离线，批量模式）— 在设置中切换 |
| **21 个本地模型**  | Parakeet、Whisper、Moonshine、SenseVoice、GigaAM、Paraformer、Qwen3 — 带准确度/速度评分     |
| **统一设置面板**   | 所有配置集中在一个覆盖面板中 — `/voice-settings`                         |
| **设备感知推荐**   | 根据你的硬件为模型评分。只有同类最优模型才会标记 [recommended]。         |
| **企业级下载流程** | 预检查（磁盘、网络、权限），实时进度显示速度/ETA，下载后校验             |
| **Handy 集成**     | 自动检测 Handy 应用的模型，通过符号链接导入                              |
| **音频回退链**     | 依次尝试 sox、ffmpeg、arecord                                            |
| **预录音**         | 预热期间即开始音频捕获 — 你永远不会错过第一个字                          |
| **尾部录音**       | 松开后继续录音 1.5 秒，确保最后一个字不被截断                            |
| **实时流式传输**   | Deepgram Nova 3 WebSocket — 边说边出中间转录结果                         |
| **56+ 种语言**     | Deepgram：56+ 种语言实时流式传输。本地：最多 57 种（取决于模型）。       |
| **连续听写**       | `/voice dictate` 用于长文本输入，无需按住按键                            |
| **打字冷却**       | 打字后 400 毫秒内的空格按住会被忽略                                      |
| **声音反馈**       | macOS 系统声音用于开始、停止和错误事件提示                               |
| **跨平台**         | macOS、Windows、Linux — Kitty 协议 + 非 Kitty 回退方案                   |

---

## 架构

```
extensions/voice.ts                主扩展 — 状态机、录音、UI、设置面板
extensions/voice/config.ts         配置加载、保存、迁移
extensions/voice/onboarding.ts     首次运行向导、语言选择器
extensions/voice/deepgram.ts       Deepgram URL 构建器、API 密钥解析
extensions/voice/local.ts          模型目录（21 个模型）、进程内转录
extensions/voice/device.ts         设备信息采集 — 内存、GPU、CPU、容器检测
extensions/voice/model-download.ts 下载管理器 — 断点续传、进度、校验、Handy 导入
extensions/voice/sherpa-engine.ts   sherpa-onnx 绑定 — 识别器生命周期、推理
extensions/voice/settings-panel.ts  设置面板 — Component 接口、覆盖层、4 个标签页
```

---

## 配置

设置存储在 Pi 的设置文件中，位于 `voice` 键下：

| 作用域 | 路径                          |
| ------ | ----------------------------- |
| 全局   | `~/.pi/agent/settings.json`   |
| 项目   | `<project>/.pi/settings.json` |

```json
{
	"voice": {
		"version": 2,
		"enabled": true,
		"language": "en",
		"backend": "local",
		"localModel": "parakeet-v3",
		"scope": "global",
		"onboarding": { "completed": true, "schemaVersion": 2 }
	}
}
```

---

## 故障排除

在 Pi 内运行 `/voice test` 获取完整诊断信息。

| 问题                          | 解决方案                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------- |
| "DEEPGRAM_API_KEY not set"    | [获取密钥](https://dpgr.am/pi-voice) → 在 `~/.zshrc` 中添加 `export DEEPGRAM_API_KEY="..."` |
| "No audio capture tool found" | `brew install sox` 或 `brew install ffmpeg`                                                 |
| 空格键不能激活语音            | 运行 `/voice-settings` — 语音功能可能已禁用                                                 |
| 本地模型无法转录              | 检查 `/voice-settings` → 设备标签页中的 sherpa-onnx 状态                                    |
| 下载失败                      | 部分下载会在重试时自动续传。在设备标签页中检查磁盘空间。                                    |

---

## 安全性

- **云端语音转文字** — 音频发送到 Deepgram 进行转录（仅 Deepgram 后端）
- **本地语音转文字** — 音频不会离开你的设备（本地后端）
- **无遥测** — pi-voicekit 不收集或传输任何使用数据
- **API 密钥** — 存储在环境变量或 Pi 设置中，从不记录日志

漏洞报告请参阅 [SECURITY.md](../SECURITY.md)。

---

## 许可证

[MIT](../LICENSE) © 2026 codexstar69

---

## 链接

- **npm:** [npmjs.com/package/pi-voicekit](https://www.npmjs.com/package/pi-voicekit)
- **GitHub:** [github.com/CyFeng16/pi-voicekit](https://github.com/CyFeng16/pi-voicekit)
- **Deepgram:** [dpgr.am/pi-voice](https://dpgr.am/pi-voice)（$200 免费额度）
- **Pi CLI:** [github.com/earendil-works/pi-coding-agent](https://github.com/earendil-works/pi-coding-agent)
