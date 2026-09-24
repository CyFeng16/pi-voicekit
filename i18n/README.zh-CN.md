[English](../README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Português](README.pt-BR.md) | [हिन्दी](README.hi.md)

# pi-voicekit

> **基于 [`codexstar69/pi-listen`](https://github.com/codexstar69/pi-listen) 的社区延续项目**（上游，MIT — 自 2026 年 5 月 v7.2.2 起停止维护）。
> 与原作者无隶属关系。旧名称：`pi-listen`。

<p align="center">
  <img src="../assets/banner.png" alt="pi-voicekit — Pi 编程智能体的语音输入工具" width="100%" />
</p>

**为 [Pi](https://github.com/earendil-works/pi-coding-agent) 打造的语音输入与语音输出。**
按住说话式语音转文字 — 可选 Deepgram 云端流式传输或 21 个离线模型 — 外加能把智能体回复朗读出来的 TTS（Kitten、Kokoro、Piper 或 Deepgram Aura）。

[![npm version](https://img.shields.io/npm/v/pi-voicekit.svg)](https://www.npmjs.com/package/pi-voicekit)
[![license](https://img.shields.io/npm/l/pi-voicekit.svg)](https://github.com/CyFeng16/pi-voicekit/blob/main/LICENSE)
[![original author](https://img.shields.io/badge/original_author-@baanditeagle-1DA1F2?logo=x&logoColor=white)](https://x.com/baanditeagle)

> **v0.1.3 — 当前版本** — 当设置了 `PULSE_SERVER`（SSH 音频隧道 / 远端 PulseAudio）时，
> 音频采集会优先使用 `ffmpeg`，因此远程麦克风能稳定录音。语音输入**和**语音输出：
> 21 个离线语音识别模型、20 个本地 TTS 音色，外加 Deepgram Aura，全部由同一个
> `/voice-settings` 面板（5 个标签页）驱动。0.1.x 版本线记录在[更新日志](../CHANGELOG.md)中。

---

## 看看它是如何工作的

<p align="center">
  <video src="../assets/pi-listen.mp4" controls width="100%"></video>
  <br>
  <em>演示视频</em>
</p>

---

## 安装配置（2 分钟）

### 1. 安装扩展

```bash
# 在普通终端中运行（不要在 Pi 内部运行）
pi install npm:pi-voicekit
```

### 2. 选择转录后端

pi-voicekit 支持两种转录后端：

|                  | Deepgram（云端）                                         | 本地模型（离线）                                    |
| ---------------- | -------------------------------------------------------- | --------------------------------------------------- |
| **工作方式**     | 实时流式传输 — 边说边出文字                              | 批量模式 — 录完后再转录                             |
| **设置**         | 需要 API 密钥                                            | 无需 API 密钥，模型首次使用时自动下载               |
| **网络**         | 需要联网                                                 | 模型下载后无需联网                                  |
| **延迟**         | 实时中间结果                                             | 停止录音后 2–10 秒                                  |
| **语言**         | 56+ 种语言支持实时流式传输                               | 取决于模型（1–57 种语言）                           |
| **费用**         | $200 免费额度（大多数开发者可用 6–12 个月）              | 永久免费                                            |

在 Pi 内运行 `/voice-settings`，即可在一个面板中选择后端并完成全部配置。

#### 方案 A：Deepgram（推荐用于实时流式传输）

前往 [dpgr.am/pi-voice](https://dpgr.am/pi-voice) 注册 — $200 免费额度，无需绑卡。

```bash
export DEEPGRAM_API_KEY="your-key-here"    # 写入 ~/.zshrc 或 ~/.bashrc
```

#### 方案 B：本地模型（完全离线）

无需任何设置 — 运行 `/voice-settings`，把后端切到「本地」，再选一个模型，它会自动下载。

> **注意：** 本地模型使用批量模式 — 录完后再转录，不是边说边转。如需边说边转的实时流式体验，请使用 Deepgram。

### 3. 打开 Pi

首次启动时，pi-voicekit 会检查你的配置并告知就绪状态：

- 后端已配置（Deepgram 密钥或本地模型）
- 已检测到音频采集工具（sox、ffmpeg 或 arecord）
- 一切就绪时，语音功能会立即激活

### 音频捕获

pi-voicekit 会自动检测你的音频工具。如果你已安装 sox 或 ffmpeg，就无需手动安装。

| 优先级 | 工具            | 支持平台              | 安装方式                                                     |
| ------ | --------------- | --------------------- | ------------------------------------------------------------ |
| 1      | **SoX** (`rec`) | macOS、Linux、Windows | `brew install sox` / `apt install sox` / `choco install sox` |
| 2      | **ffmpeg**      | macOS、Linux、Windows | `brew install ffmpeg` / `apt install ffmpeg`                 |
| 3      | **arecord**     | 仅 Linux              | 预装（ALSA）                                                 |

> 当设置了 `PULSE_SERVER`（SSH 音频隧道或远端 PulseAudio）时，优先级会变为
> **ffmpeg → sox → arecord** — 网络 Pulse 音源必须使用 ffmpeg。

---

## 设置面板

所有配置集中在一处：`/voice-settings`。五个标签页覆盖你需要的全部内容。

### 通用 — 后端、语言、作用域

<img src="../assets/settings-general.png" alt="常规设置 — 后端、模型、语言、作用域、语音开关" width="600" />

在 Deepgram（云端，实时流式传输）与本地（离线，批量模式）之间切换。还能用键盘快捷键修改语言、作用域，以及启用/禁用语音。

### 模型 — 浏览、搜索、安装

<img src="../assets/settings-models.png" alt="模型标签页 — 浏览 21 个模型及其准确度/速度评分" width="600" />

浏览来自 Parakeet、Whisper、Moonshine、SenseVoice、GigaAM、Paraformer 和 Qwen3 的 21 个模型。每个模型都会显示准确度与速度评分（●●●●○/●●●●○）、适配徽章和下载状态。支持模糊搜索，快速定位模型。按回车即可激活并下载。

### 已下载 — 管理已安装的模型

<img src="../assets/settings-downloaded.png" alt="已下载标签页 — 管理已安装模型、激活或删除" width="600" />

查看已安装的模型、总磁盘占用，以及当前激活的模型。按回车激活，按 `x` 删除。来自 [Handy](https://github.com/cjpais/handy) 的模型会被自动检测，并可导入而无需重新下载。

### 朗读 — TTS 模型与音色

选择 TTS 后端（本地 sherpa-onnx 或 Deepgram Aura），浏览 20 个本地音色
（最小约 13 MB），选中即下载，并可分别为每个后端选择音色。智能体回复的自动朗读
也在这里开关。

### 设备 — 硬件信息和依赖项

<img src="../assets/settings-device.png" alt="设备标签页 — 硬件信息、依赖项、磁盘空间" width="600" />

查看硬件信息（内存、CPU、GPU）、依赖状态（sherpa-onnx 运行时）、可用磁盘空间和已下载模型总量。模型推荐会基于这份硬件信息生成。

---

## 使用方法

### 快捷键

| 操作             | 按键                    | 说明                                                     |
| ---------------- | ----------------------- | -------------------------------------------------------- |
| **录音到编辑器** | 按住 `SPACE`（≥0.7 秒） | 松开后完成转录。预热期间预录音频，确保不会错过第一个字。 |
| **切换录音**     | `Ctrl+Shift+V`          | 适用于所有终端 — 按一次开始，再按一次停止。              |
| **清空编辑器**   | `Escape` × 2            | 500 毫秒内双击清空所有文字。                             |

### 录音工作原理

1. **按住 SPACE** — 出现预热倒计时，音频采集立即开始（预录音）
2. **继续按住** — 实时转录流入编辑器（Deepgram），或音频写入缓冲区（本地）
3. **松开 SPACE** — 录音再持续 1.5 秒（尾部录音）以捕捉最后一个字，然后结束
4. 文本出现在编辑器中，随时可以发送

### 命令

| 命令                     | 说明                                          |
| ------------------------ | --------------------------------------------- |
| `/voice-settings`        | 设置面板 — 后端、模型、语言、作用域、设备     |
| `/voice-models`          | 设置面板（模型标签页）                        |
| `/voice-setup`           | 运行首次使用向导                              |
| `/voice-language`        | 打开设置面板以切换语言                        |
| `/voice-speak <text>`    | 朗读给定文本（TTS）                           |
| `/voice-speak-test`      | 朗读一句示例文本                              |
| `/voice-speak-toggle`    | 启用 / 禁用 TTS                               |
| `/voice-stream`          | 切换 Deepgram 流式 TTS（云端）                |
| `/voice-speak-stop`      | 停止正在播放的 TTS                            |
| `/voice-autosubmit`      | 开关：转录文本自动发送给智能体（`on`/`off`）  |
| `/voice-hold-delay`      | 设置长按触发延迟（200-3000 毫秒，默认 700）   |
| `/voice-speak-models`    | 浏览 / 安装 TTS 音色模型                      |
| `/voice-speak-info`      | 诊断 TTS 状态                                 |
| `/voice-help`            | 键盘与命令速查（也可按 `F1`）                 |
| `/voice test`            | 完整诊断 — 音频工具、麦克风、API 密钥         |
| `/voice on` / `off`      | 启用或禁用语音                                |
| `/voice dictate`         | 连续听写（无需按住按键）                      |
| `/voice stop`            | 停止当前录音或听写                            |
| `/voice history`         | 最近的转录记录                                |
| `/voice`                 | 开关切换                                      |

### v7.1 键盘操作

在设置面板中：

| 按键   | 操作                     |
| ------ | ------------------------ |
| `← →`  | 切换标签页               |
| `↑ ↓`  | 移动光标（跳过分组标题） |
| `↵`    | 选择 / 激活              |
| `esc`  | 返回主界面 / 关闭面板    |
| `type` | 输入关键字以搜索         |
| `bksp` | 删除搜索的最后一个字符   |

当安装进度挂件或播放指示器挂载时（前方没有浮层）：

| 按键  | 操作                                                    |
| ----- | ------------------------------------------------------- |
| `esc` | 取消正在进行的安装（从最近一个开始），然后停止播放      |
| `F1`  | 打开帮助浮层（始终可用）                                |

---

## 本地模型

21 个模型，覆盖 7 个家族。按质量排序 — 最好的在前。

### 推荐首选

| 模型                | 准确度 | 速度  | 大小   | 语言           | 说明                 |
| ------------------- | ------ | ----- | ------ | -------------- | -------------------- |
| **Parakeet TDT v3** | ●●●●○  | ●●●●○ | 671 MB | 25（自动检测） | 综合最佳。WER 6.3%。 |
| **Parakeet TDT v2** | ●●●●●  | ●●●●○ | 661 MB | 英语           | 英语最佳。WER 6.0%。 |
| **Whisper Turbo**   | ●●●●○  | ●●○○○ | 1.0 GB | 57             | 语言支持最广泛。     |

### 快速轻量

| 模型                  | 准确度 | 速度  | 大小   | 语言           | 说明                        |
| --------------------- | ------ | ----- | ------ | -------------- | --------------------------- |
| **Moonshine v2 Tiny** | ●●○○○  | ●●●●● | 43 MB  | 英语           | 34ms 延迟。适合树莓派。     |
| **Moonshine Base**    | ●●●○○  | ●●●●● | 287 MB | 英语           | 口音识别表现良好。          |
| **SenseVoice Small**  | ●●●○○  | ●●●●● | 228 MB | 中/英/日/韩/粤 | 中日韩语言最佳选择。        |

### 专项模型

| 模型                 | 准确度 | 速度  | 大小   | 语言 | 说明                                 |
| -------------------- | ------ | ----- | ------ | ---- | ------------------------------------ |
| **GigaAM v3**        | ●●●●○  | ●●●●○ | 225 MB | 俄语 | 俄语识别 WER 比 Whisper 低 50%。     |
| **Whisper Medium**   | ●●●●○  | ●●●○○ | 946 MB | 57   | 准确度好，速度适中。                 |
| **Whisper Large v3** | ●●●●○  | ●○○○○ | 1.8 GB | 57   | Whisper 系列最高准确度。CPU 上较慢。 |

此外还有 8 个面向特定语言的 Moonshine v2 变体：日语、韩语、阿拉伯语、中文、乌克兰语、越南语和西班牙语。

### 本地模型工作原理

```
按住 SPACE → 音频写入内存缓冲区
                ↓
松开 SPACE → 缓冲区送入 sherpa-onnx（进程内）
                ↓
         CPU 上运行 ONNX 推理（2–10 秒）
                ↓
         最终转录文本写入编辑器
```

模型首次使用时会自动下载。下载可续传、完成后会校验，并会去重（不会重复下载）。设置面板会实时显示下载进度、速度和预计剩余时间。

来自 [Handy](https://github.com/cjpais/handy) 的模型（`~/Library/Application Support/com.pais.handy/models/`）会被自动检测，并可通过符号链接导入（零磁盘重复占用）。

---

## 功能特性

| 功能               | 说明                                                                     |
| ------------------ | ------------------------------------------------------------------------ |
| **双后端**         | Deepgram（云端，实时流式传输）或本地模型（离线，批量模式）— 在设置中切换 |
| **21 个本地模型**  | Parakeet、Whisper、Moonshine、SenseVoice、GigaAM、Paraformer、Qwen3 — 带准确度/速度评分 |
| **统一设置面板**   | 所有配置集中在一个覆盖面板中 — `/voice-settings`                         |
| **设备感知推荐**   | 根据你的硬件为模型评分。只有同类最优模型才会标记 [recommended]。         |
| **企业级下载流程** | 预检查（磁盘、网络、权限），实时进度显示速度/ETA，下载后校验             |
| **Handy 集成**     | 自动检测 Handy 应用的模型，通过符号链接导入                              |
| **音频回退链**     | 依次尝试 sox → ffmpeg → arecord；设置了 `PULSE_SERVER` 时 ffmpeg 优先    |
| **预录音**         | 预热期间即开始音频捕获 — 你永远不会错过第一个字                          |
| **尾部录音**       | 松开后继续录音 1.5 秒，确保最后一个字不被截断                            |
| **实时流式传输**   | Deepgram Nova 3 WebSocket（中文语种使用 Nova 2）— 边说边出中间转录结果   |
| **56+ 种语言**     | Deepgram：56+ 种语言实时流式传输。本地：最多 57 种（取决于模型）。       |
| **连续听写**       | `/voice dictate` 用于长文本输入，无需按住按键                            |
| **打字冷却**       | 打字后 400 毫秒内的空格按住会被忽略                                      |
| **声音反馈**       | macOS 系统声音用于开始、停止和错误事件提示                               |
| **跨平台**         | macOS、Windows、Linux — Kitty 协议 + 非 Kitty 回退方案                   |

---

## 架构

```
# core
extensions/voice.ts                         主扩展 — 状态机、录音、UI、命令面
extensions/voice/config.ts                  配置加载、保存、迁移
extensions/voice/onboarding.ts              首次使用向导、语言选择器
extensions/voice/audio-tool.ts              采集工具检测（sox / ffmpeg / arecord）
extensions/voice/hold-to-talk.ts            长按检测，Kitty 与非 Kitty 终端
extensions/voice/release-controller.ts      录音生命周期、松手处理

# speech-to-text
extensions/voice/deepgram.ts                Deepgram URL 构造、API 密钥解析
extensions/voice/local.ts                   模型目录（21 个模型）、进程内转录
extensions/voice/sherpa-engine.ts           sherpa-onnx 绑定 — 识别器生命周期、推理
extensions/voice/sherpa-loader.ts           原生模块懒加载
extensions/voice/model-download.ts          下载管理 — 续传、进度、校验、Handy 导入
extensions/voice/device.ts                  设备画像 — 内存、GPU、CPU、容器检测

# text-to-speech
extensions/voice/speak.ts                   朗读入口、自动朗读接线
extensions/voice/tts-engine.ts              sherpa-onnx TTS 合成
extensions/voice/tts-deepgram.ts            Deepgram Aura 音色（云端）
extensions/voice/tts-local-models.ts        本地 TTS 目录 — 20 个音色（Kitten、Kokoro、Piper）
extensions/voice/tts-playback.ts            播放、缓冲、播放器检测
extensions/voice/tts-text-filter.ts         代码块过滤、分句预处理
extensions/voice/tts-onboarding.ts          TTS 引导流程
extensions/voice/tts-onboarding-overlay.ts  TTS 引导浮层
extensions/voice/tts-install-progress.ts    模型安装进度挂件
extensions/voice/tts-playback-indicator.ts  朗读指示器挂件

# settings and UI
extensions/voice/settings-panel.ts          设置面板 — 浮层、5 个标签页
extensions/voice/ui-picker.ts               通用列表选择器
extensions/voice/ui-help-overlay.ts         键盘与命令速查
extensions/voice/ui-aura.ts                 视觉基元（Liquid Braille、Aurora）
extensions/voice/ui-widget-base.ts          挂件注册表与基类
extensions/voice/ui-render-ticker.ts        共享渲染定时器
extensions/voice/ui-icons.ts                字形与图标集
extensions/voice/ui-width.ts                中日韩宽字符感知的宽度工具
extensions/voice/ui-locale-labels.ts        本地语言名与音色标签

# types
extensions/voice/sherpa-onnx-node.d.ts      可选原生模块的类型声明
```

---

## 配置

设置在 Pi 的设置文件中，位于 `voice` 键下：

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

来自 Shell 的 `DEEPGRAM_API_KEY` 在运行时使用，**不会**被回写到
`~/.pi/agent/settings.json`。如果你在引导流程中粘贴密钥，那是一次显式保存，
它会写入 `~/.env.secrets` 或 `~/.zshrc`。

长按触发延迟默认 **700 毫秒**（`/voice-hold-delay` 接受 200–3000 毫秒）。

---

## 故障排除

在 Pi 内运行 `/voice test` 可获得完整诊断。

| 问题                                             | 解决方案                                                                                                        |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| "DEEPGRAM_API_KEY not set"                       | [获取密钥](https://dpgr.am/pi-voice) → 在 `~/.zshrc` 中添加 `export DEEPGRAM_API_KEY="..."`                     |
| "No audio capture tool found"                    | `brew install sox` 或 `brew install ffmpeg`                                                                     |
| 远程麦克风录不到声音                             | 音频经 PulseAudio/SSH 传输 — 请在 Pi 一侧安装 ffmpeg（设置了 `PULSE_SERVER` 时采集优先用 ffmpeg）                |
| 空格键不能激活语音                               | 运行 `/voice-settings` — 语音功能可能已禁用                                                                     |
| 本地模型无法转录                                 | 检查 `/voice-settings` → 设备标签页中的 sherpa-onnx 状态                                                        |
| 下载失败                                         | 部分下载会在重试时自动续传。在设备标签页中检查磁盘空间。                                                        |
| macOS 上出现 `dyld: Library not loaded: libsimdjson` | Homebrew Node ABI 不匹配 — 运行 `brew reinstall node`，或改用版本管理的 Node（`mise`、`fnm`、`nvm`）         |

---

## 安全性

- **云端语音转文字** — 音频发送到 Deepgram 进行转录（仅 Deepgram 后端）
- **本地语音转文字** — 音频不会离开你的设备（本地后端）
- **无遥测** — pi-voicekit 不收集或传输任何使用数据
- **API 密钥** — 存储在环境变量或 Pi 设置中，从不记录日志

漏洞报告请参阅 [SECURITY.md](../SECURITY.md)。

---

## 许可证

[MIT](../LICENSE) — 原作者 [@baanditeagle](https://x.com/baanditeagle)，现由 [CyFeng16](https://github.com/CyFeng16) 维护

---

## 链接

- **npm:** [npmjs.com/package/pi-voicekit](https://www.npmjs.com/package/pi-voicekit)
- **GitHub:** [github.com/CyFeng16/pi-voicekit](https://github.com/CyFeng16/pi-voicekit)
- **Deepgram:** [dpgr.am/pi-voice](https://dpgr.am/pi-voice)（$200 免费额度）
- **Pi CLI:** [github.com/earendil-works/pi-coding-agent](https://github.com/earendil-works/pi-coding-agent)
