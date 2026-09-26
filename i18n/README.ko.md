[English](../README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Português](README.pt-BR.md) | [हिन्दी](README.hi.md)

# pi-voicekit

> **[`codexstar69/pi-listen`](https://github.com/codexstar69/pi-listen)의 커뮤니티 후속 프로젝트** (업스트림, MIT — 2026년 5월 v7.2.2를 마지막으로 개발 중단).
> 원작자와는 무관합니다. 이전 이름: `pi-listen`.

<p align="center">
  <img src="../assets/brand/banner-en.png" alt="pi-voicekit — Pi 코딩 에이전트용 음성 입력 및 출력" width="100%" />
</p>

**[Pi](https://github.com/earendil-works/pi-coding-agent)를 위한 음성 입력과 음성 출력.**
누르고 말하는 방식의 STT — Deepgram 스트리밍(클라우드) 또는 21개의 오프라인 모델 — 그리고 에이전트의 응답을 읽어 주는 TTS(Kitten, Kokoro, Piper 또는 Deepgram Aura).

[![npm version](https://img.shields.io/npm/v/pi-voicekit.svg)](https://www.npmjs.com/package/pi-voicekit)
[![license](https://img.shields.io/npm/l/pi-voicekit.svg)](https://github.com/CyFeng16/pi-voicekit/blob/main/LICENSE)
[![original author](https://img.shields.io/badge/original_author-@baanditeagle-1DA1F2?logo=x&logoColor=white)](https://x.com/baanditeagle)

> **v0.1.3 — 현재 릴리스** — `PULSE_SERVER`(SSH 오디오 터널 / 원격 PulseAudio)가 설정되어 있으면
> 오디오 캡처가 `ffmpeg`를 우선 사용하므로 원격 마이크도 안정적으로 녹음됩니다. 음성 입력**과** 음성 출력:
> 21개의 오프라인 STT 모델, 20개의 로컬 TTS 음성에 Deepgram Aura까지, 6개 탭을 갖춘 하나의
> `/voice-settings` 패널로 제어합니다. 0.1.x 버전대는 [변경 로그](../CHANGELOG.md)에 문서화되어 있습니다.

---

## 작동 방식 보기

<p align="center">
  <video src="../assets/demo/pi-voicekit-demo.mp4" controls width="100%"></video>
  <br>
  <em>데모 영상</em>
</p>

---

## 설정 (2분)

### 1. 확장 설치

```bash
# 일반 터미널에서 실행 (Pi 내부가 아닌)
pi install npm:pi-voicekit
```

### 2. 백엔드 선택

pi-voicekit은 두 가지 음성 인식 백엔드를 지원합니다:

|                  | Deepgram (클라우드)                                  | 로컬 모델 (오프라인)                                 |
| ---------------- | ---------------------------------------------------- | ---------------------------------------------------- |
| **작동 방식**    | 라이브 스트리밍 — 말하는 동안 텍스트가 나타남        | 배치 모드 — 녹음이 끝난 뒤에 텍스트로 변환           |
| **설정**         | API 키 필요                                          | API 키 불필요, 첫 사용 시 모델 자동 다운로드         |
| **인터넷**       | 필요                                                 | 모델 다운로드 후에는 불필요                          |
| **지연 시간**    | 실시간 중간 결과                                     | 녹음 중지 후 2–10초                                  |
| **언어**         | 56+개 언어 라이브 스트리밍 지원                      | 모델에 따라 다름 (1–57개 언어)                       |
| **비용**         | $200 무료 크레딧 (대부분의 개발자에게 6–12개월 지속) | 영구 무료                                            |

Pi 안에서 `/voice-settings`를 실행하면 하나의 패널에서 백엔드를 선택하고 모든 것을 구성할 수 있습니다.

#### 옵션 A: Deepgram (라이브 스트리밍에 권장)

[dpgr.am/pi-voice](https://dpgr.am/pi-voice)에서 가입하세요 — $200 무료 크레딧, 카드 등록 불필요.

```bash
export DEEPGRAM_API_KEY="your-key-here"    # ~/.zshrc 또는 ~/.bashrc에 추가
```

#### 옵션 B: 로컬 모델 (완전 오프라인)

별도 설정이 필요 없습니다 — `/voice-settings`를 실행해 백엔드를 Local로 전환하고 모델을 선택하면 자동으로 다운로드됩니다.

> **참고:** 로컬 모델은 배치 모드를 사용합니다 — 말하는 동안이 아니라 녹음이 끝난 뒤에 변환합니다. 말하면서 실시간 스트리밍을 원한다면 Deepgram을 사용하세요.

### 3. Pi 열기

처음 실행하면 pi-voicekit이 설정을 확인하고 준비된 항목을 알려줍니다:

- 백엔드 구성 완료 (Deepgram 키 또는 로컬 모델)
- 오디오 캡처 도구 감지 (sox, ffmpeg 또는 arecord)
- 모든 항목이 정상이라면 음성이 즉시 활성화됩니다

### 오디오 캡처

pi-voicekit은 오디오 도구를 자동으로 감지합니다. sox나 ffmpeg가 이미 설치되어 있다면 수동으로 설치할 필요가 없습니다.

| 우선순위 | 도구            | 플랫폼                | 설치                                                         |
| -------- | --------------- | --------------------- | ------------------------------------------------------------ |
| 1        | **SoX** (`rec`) | macOS, Linux, Windows | `brew install sox` / `apt install sox` / `choco install sox` |
| 2        | **ffmpeg**      | macOS, Linux, Windows | `brew install ffmpeg` / `apt install ffmpeg`                 |
| 3        | **arecord**     | Linux 전용            | 사전 설치됨 (ALSA)                                           |

> `PULSE_SERVER`가 설정되어 있으면(SSH 오디오 터널 또는 원격 PulseAudio) 순서가
> **ffmpeg → sox → arecord**로 바뀝니다 — 네트워크 Pulse 소스에는 ffmpeg가 필요합니다.

---

## 설정 패널

모든 설정은 한곳에 모여 있습니다: `/voice-settings`. 6개 탭이 필요한 모든 것을 다룹니다.

### 일반 — 백엔드, 언어, 범위

<img src="../assets/screenshots/settings-general.png" alt="일반 설정 — 백엔드, 모델, 언어, 범위, 음성 토글" width="600" />

Deepgram(클라우드, 라이브 스트리밍)과 Local(오프라인, 배치 모드)을 전환합니다. 언어와 범위를 바꾸고 음성을 활성화/비활성화하는 것도 모두 키보드 단축키로 할 수 있습니다.

### 모델 — 탐색, 검색, 설치

<img src="../assets/screenshots/settings-models.png" alt="모델 탭 — 정확도/속도 평가가 표시된 21개 모델 탐색" width="600" />

Parakeet, Whisper, Moonshine, SenseVoice, GigaAM, Paraformer, Qwen3의 21개 모델을 탐색할 수 있습니다. 각 모델에는 정확도와 속도 평가(●●●●○/●●●●○), 적합성 배지, 다운로드 상태가 표시됩니다. 퍼지 검색으로 원하는 모델을 빠르게 찾고, Enter를 눌러 활성화 및 다운로드하세요.

### 다운로드됨 — 설치된 모델 관리

<img src="../assets/screenshots/settings-downloaded.png" alt="다운로드됨 탭 — 설치된 모델 관리, 활성화 또는 삭제" width="600" />

설치된 모델, 총 디스크 사용량, 현재 활성화된 모델을 확인할 수 있습니다. Enter로 활성화하고 `x`로 삭제하세요. [Handy](https://github.com/cjpais/handy)의 모델은 자동으로 감지되어 다시 다운로드하지 않고 가져올 수 있습니다.

### 음성 합성 — TTS 모델과 음성

TTS 백엔드(로컬 sherpa-onnx 또는 Deepgram Aura)를 선택하고, 약 13 MB부터 시작하는
20개의 로컬 음성을 살펴보고, 선택하면 다운로드하며, 백엔드별로 음성을 지정할 수 있습니다.
에이전트 응답의 자동 낭독도 여기서 전환합니다.

### 디바이스 — 하드웨어 프로필과 의존성

<img src="../assets/screenshots/settings-device.png" alt="디바이스 탭 — 하드웨어 프로필, 의존성, 디스크 공간" width="600" />

하드웨어 프로필(RAM, CPU, GPU), 의존성 상태(sherpa-onnx 런타임), 사용 가능한 디스크 공간, 다운로드된 모델 총량을 확인할 수 있습니다. 모델 추천은 이 프로필을 기반으로 합니다.

---

## 사용법

### 키 바인딩

| 동작                | 키                         | 비고                                                                     |
| ------------------- | -------------------------- | ------------------------------------------------------------------------ |
| **에디터로 녹음**   | `SPACE` 길게 누르기(≥0.7초) | 놓으면 확정됩니다. 워밍업 중 미리 녹음하므로 첫 단어를 놓치지 않습니다. |
| **녹음 토글**       | `Ctrl+Shift+V`             | 모든 터미널에서 작동 — 눌러서 시작하고 다시 눌러 중지합니다.             |
| **에디터 지우기**   | `Escape` × 2               | 500ms 안에 두 번 누르면 모든 텍스트를 지웁니다.                          |

### 녹음 작동 방식

1. **SPACE 길게 누르기** — 워밍업 카운트다운이 표시되고 오디오 캡처가 즉시 시작됩니다(사전 녹음)
2. **계속 누르고 있기** — 실시간 변환 텍스트가 에디터로 스트리밍되거나(Deepgram) 오디오가 버퍼에 쌓입니다(로컬)
3. **SPACE 놓기** — 마지막 단어까지 잡기 위해 1.5초 동안 녹음을 계속한 뒤(테일 녹음) 확정됩니다
4. 텍스트가 에디터에 나타나며 바로 전송할 수 있습니다

### 명령어

| 명령어                   | 설명                                                  |
| ------------------------ | ----------------------------------------------------- |
| `/voice-settings`        | 설정 패널 — 백엔드, 모델, 언어, 범위, 디바이스        |
| `/voice-models`          | 설정 패널 (모델 탭)                                   |
| `/voice-setup`           | 최초 실행 설정 마법사 실행                            |
| `/voice-language`        | 언어를 변경할 설정 패널 열기                          |
| `/voice-speak <text>`    | 텍스트를 소리 내어 읽기 (TTS)                         |
| `/voice-speak-test`      | 예시 문장을 읽어 주기                                 |
| `/voice-speak-toggle`    | TTS 활성화 / 비활성화                                 |
| `/voice-stream`          | Deepgram 스트리밍 TTS 토글 (클라우드)                 |
| `/voice-speak-stop`      | 재생 중인 TTS 중지                                    |
| `/voice-autosubmit`      | 토글: STT 텍스트를 에이전트에 자동 전송 (`on`/`off`)  |
| `/voice-hold-delay`      | 누르고 말하기 지연 설정 (200-3000 ms, 기본 700)       |
| `/voice-speak-models`    | TTS 음성 모델 탐색 / 설치                             |
| `/voice-speak-info`      | TTS 상태 진단                                         |
| `/voice-help`            | 키보드 + 명령어 참조 (`F1`을 눌러도 열림)             |
| `/voice test`            | 전체 진단 — 오디오 도구, 마이크, API 키               |
| `/voice on` / `off`      | 음성 활성화 또는 비활성화                             |
| `/voice dictate`         | 연속 받아쓰기 (키를 누르고 있지 않아도 됨)            |
| `/voice stop`            | 진행 중인 녹음 또는 받아쓰기 중지                     |
| `/voice history`         | 최근 변환 기록                                        |
| `/voice`                 | 켜기/끄기 토글                                        |

### v7.1 키보드

설정 패널에서:

| 키     | 동작                              |
| ------ | --------------------------------- |
| `← →`  | 탭 전환                           |
| `↑ ↓`  | 행 이동 (그룹 제목은 건너뜀)      |
| `↵`    | 선택 / 활성화                     |
| `esc`  | 메인으로 돌아가기 / 패널 닫기     |
| `type` | 필터링 (검색)                     |
| `bksp` | 검색어의 마지막 글자 지우기       |

설치 위젯이나 재생 표시기가 마운트되어 있을 때(앞에 오버레이가 없는 경우):

| 키   | 동작                                                       |
| ---- | ---------------------------------------------------------- |
| `esc` | 진행 중인 설치 취소(최근 항목부터), 그다음 재생 중지      |
| `F1`  | 도움말 오버레이 열기 (항상 사용 가능)                     |

---

## 로컬 모델

7개 패밀리에 걸친 21개 모델. 품질순으로 정렬되어 있으며 최고 모델이 먼저 옵니다.

### 추천 모델

| 모델                | 정확도 | 속도  | 크기   | 언어           | 비고                 |
| ------------------- | ------ | ----- | ------ | -------------- | -------------------- |
| **Parakeet TDT v3** | ●●●●○  | ●●●●○ | 671 MB | 25 (자동 감지) | 종합 최고. WER 6.3%. |
| **Parakeet TDT v2** | ●●●●●  | ●●●●○ | 661 MB | 영어           | 영어 최고. WER 6.0%. |
| **Whisper Turbo**   | ●●●●○  | ●●○○○ | 1.0 GB | 57             | 가장 폭넓은 언어 지원. |

### 빠르고 가벼운 모델

| 모델                  | 정확도 | 속도  | 크기   | 언어            | 비고                          |
| --------------------- | ------ | ----- | ------ | --------------- | ----------------------------- |
| **Moonshine v2 Tiny** | ●●○○○  | ●●●●● | 43 MB  | 영어            | 34ms 지연. Raspberry Pi에 적합. |
| **Moonshine Base**    | ●●●○○  | ●●●●● | 287 MB | 영어            | 억양을 잘 처리합니다.         |
| **SenseVoice Small**  | ●●●○○  | ●●●●● | 228 MB | zh/en/ja/ko/yue | CJK 언어에 최적.              |

### 전문 모델

| 모델                 | 정확도 | 속도  | 크기   | 언어     | 비고                                    |
| -------------------- | ------ | ----- | ------ | -------- | --------------------------------------- |
| **GigaAM v3**        | ●●●●○  | ●●●●○ | 225 MB | 러시아어 | 러시아어에서 Whisper보다 WER 50% 낮음.  |
| **Whisper Medium**   | ●●●●○  | ●●●○○ | 946 MB | 57       | 정확도 우수, 속도 보통.                 |
| **Whisper Large v3** | ●●●●○  | ●○○○○ | 1.8 GB | 57       | Whisper 최고 정확도. CPU에서는 느림.    |

이 밖에도 일본어, 한국어, 아랍어, 중국어, 우크라이나어, 베트남어, 스페인어를 위한 언어 특화 Moonshine v2 변형 8개가 있습니다.

### 로컬 모델 작동 방식

```
SPACE 길게 누르기 → 오디오가 메모리 버퍼에 캡처됨
                ↓
SPACE 놓기 → 버퍼를 sherpa-onnx로 전송 (인프로세스)
                ↓
         CPU에서 ONNX 추론 (2–10초)
                ↓
         최종 변환 텍스트를 에디터에 삽입
```

모델은 첫 사용 시 자동으로 다운로드됩니다. 다운로드는 이어받기가 가능하고, 완료 후 검증되며, 중복 제거됩니다(같은 모델을 두 번 받지 않습니다). 설정 패널에는 속도와 ETA가 포함된 실시간 다운로드 진행률이 표시됩니다.

[Handy](https://github.com/cjpais/handy)의 모델(`~/Library/Application Support/com.pais.handy/models/`)은 자동으로 감지되며 심볼릭 링크로 가져올 수 있습니다(디스크 중복 없음).

---

## 기능

| 기능                                 | 설명                                                                                     |
| ------------------------------------ | ---------------------------------------------------------------------------------------- |
| **듀얼 백엔드**                      | Deepgram(클라우드, 라이브 스트리밍) 또는 로컬 모델(오프라인, 배치) — 설정에서 전환       |
| **로컬 모델 21개**                   | Parakeet, Whisper, Moonshine, SenseVoice, GigaAM, Paraformer, Qwen3 — 정확도/속도 평가 포함 |
| **통합 설정 패널**                   | 모든 설정을 하나의 오버레이 패널에서 — `/voice-settings`                                 |
| **디바이스 인식 추천**               | 하드웨어를 기준으로 모델을 평가합니다. 동급 최고 모델에만 [recommended]가 표시됩니다.    |
| **엔터프라이즈급 다운로드 파이프라인** | 사전 검사(디스크, 네트워크, 권한), 속도/ETA가 포함된 실시간 진행률, 다운로드 후 검증    |
| **Handy 통합**                       | Handy 앱의 모델을 자동 감지하고 심볼릭 링크로 가져오기                                   |
| **오디오 폴백 체인**                 | sox → ffmpeg → arecord 순서로 시도 — `PULSE_SERVER`가 설정되어 있으면 ffmpeg가 우선     |
| **사전 녹음**                        | 워밍업 중 오디오 캡처가 시작됩니다 — 첫 단어를 절대 놓치지 않습니다                      |
| **테일 녹음**                        | 놓은 뒤에도 1.5초 동안 녹음을 계속해 마지막 단어가 잘리지 않습니다                       |
| **라이브 스트리밍**                  | Deepgram Nova 3 WebSocket(중국어 로케일은 Nova 2) — 실시간 중간 변환 결과                |
| **56+개 언어**                       | Deepgram: 56+개 언어 라이브 스트리밍. 로컬: 모델에 따라 최대 57개.                       |
| **연속 받아쓰기**                    | 키를 누르지 않고 긴 글을 입력하려면 `/voice dictate`                                     |
| **타이핑 쿨다운**                    | 타이핑 후 400ms 이내의 스페이스 길게 누르기는 무시됩니다                                 |
| **소리 피드백**                      | 시작, 중지, 오류 이벤트에 macOS 시스템 사운드 사용                                       |
| **크로스 플랫폼**                    | macOS, Windows, Linux — Kitty 프로토콜 + 비 Kitty 폴백                                   |

---

## 아키텍처

```
# core
extensions/voice.ts                         메인 확장 — 상태 머신, 녹음, UI, 명령 인터페이스
extensions/voice/config.ts                  설정 로딩, 저장, 마이그레이션
extensions/voice/onboarding.ts              최초 실행 마법사, 언어 선택기
extensions/voice/audio-tool.ts              캡처 도구 감지 (sox / ffmpeg / arecord)
extensions/voice/hold-to-talk.ts            길게 누르기 감지, Kitty 및 비 Kitty 터미널
extensions/voice/release-controller.ts      녹음 생명주기, 놓기 처리

# speech-to-text
extensions/voice/deepgram.ts                Deepgram URL 생성, API 키 확인
extensions/voice/local.ts                   모델 카탈로그(21개 모델), 인프로세스 변환
extensions/voice/sherpa-engine.ts           sherpa-onnx 바인딩 — 인식기 생명주기, 추론
extensions/voice/sherpa-loader.ts           네이티브 모듈 지연 로딩
extensions/voice/model-download.ts          다운로드 관리 — 이어받기, 진행률, 검증, Handy 가져오기
extensions/voice/device.ts                  디바이스 프로파일링 — RAM, GPU, CPU, 컨테이너 감지

# text-to-speech
extensions/voice/speak.ts                   읽기 진입점, 자동 낭독 연결
extensions/voice/tts-engine.ts              sherpa-onnx TTS 합성
extensions/voice/tts-deepgram.ts            Deepgram Aura 음성 (클라우드)
extensions/voice/tts-local-models.ts        로컬 TTS 카탈로그 — 20개 음성 (Kitten, Kokoro, Piper)
extensions/voice/tts-playback.ts            재생, 버퍼링, 플레이어 감지
extensions/voice/tts-text-filter.ts         코드 블록 제거, 문장 준비
extensions/voice/tts-onboarding.ts          TTS 온보딩 흐름
extensions/voice/tts-onboarding-overlay.ts  TTS 온보딩 오버레이
extensions/voice/tts-install-progress.ts    모델 설치 진행 위젯
extensions/voice/tts-playback-indicator.ts  낭독 표시기 위젯

# settings and UI
extensions/voice/settings-panel.ts          설정 패널 — 오버레이, 6개 탭
extensions/voice/ui-picker.ts               범용 목록 선택기
extensions/voice/ui-help-overlay.ts         키보드 및 명령어 참조
extensions/voice/ui-aura.ts                 시각 요소 (Liquid Braille, Aurora)
extensions/voice/ui-widget-base.ts          위젯 레지스트리와 기본 클래스
extensions/voice/ui-render-ticker.ts        공용 렌더 티커
extensions/voice/ui-icons.ts                글리프 및 아이콘 세트
extensions/voice/ui-width.ts                CJK 인식 시각 너비 도우미
extensions/voice/ui-locale-labels.ts        네이티브 언어 및 음성 레이블

# types
extensions/voice/sherpa-onnx-node.d.ts      선택적 네이티브 모듈의 타입 선언
```

---

## 구성

설정은 Pi 설정 파일의 `voice` 키 아래에 저장됩니다:

| 범위     | 경로                          |
| -------- | ----------------------------- |
| 전역     | `~/.pi/agent/settings.json`   |
| 프로젝트 | `<project>/.pi/settings.json` |

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

셸의 `DEEPGRAM_API_KEY`는 실행 시에 사용되며 `~/.pi/agent/settings.json`에 다시 기록되지 않습니다.
온보딩 중에 키를 붙여 넣는 것은 명시적 저장이며, 이 경우에도 `~/.env.secrets` 또는
`~/.zshrc`에 기록됩니다.

누르고 말하기 지연은 기본 **700 ms**입니다(`/voice-hold-delay`는 200–3000 ms를 허용).

---

## 문제 해결

Pi 안에서 `/voice test`를 실행하면 전체 진단을 수행할 수 있습니다.

| 문제                                                        | 해결 방법                                                                                                    |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| "DEEPGRAM_API_KEY not set"                                  | [키 발급](https://dpgr.am/pi-voice) → `~/.zshrc`에 `export DEEPGRAM_API_KEY="..."` 추가                      |
| "No audio capture tool found"                               | `brew install sox` 또는 `brew install ffmpeg`                                                                |
| 원격 마이크가 무음으로 녹음됨                               | PulseAudio/SSH로 오디오를 전송하는 환경 — Pi 쪽에 ffmpeg를 설치하세요 (그러면 캡처가 ffmpeg를 우선 사용)      |
| 스페이스바로 음성이 활성화되지 않음                         | `/voice-settings` 실행 — 음성이 비활성화되어 있을 수 있음                                                    |
| 로컬 모델이 변환하지 않음                                   | `/voice-settings` → 디바이스 탭에서 sherpa-onnx 상태 확인                                                    |
| 다운로드 실패                                               | 부분 다운로드는 재시도 시 자동으로 이어받습니다. 디바이스 탭에서 디스크 공간을 확인하세요.                   |
| macOS에서 `dyld: Library not loaded: libsimdjson`           | Homebrew Node ABI 불일치 — `brew reinstall node`를 실행하거나 버전 관리 Node(`mise`, `fnm`, `nvm`)로 전환    |

---

## 보안

- **클라우드 STT** — 오디오가 변환을 위해 Deepgram으로 전송됩니다 (Deepgram 백엔드만 해당)
- **로컬 STT** — 오디오가 기기 밖으로 나가지 않습니다 (로컬 백엔드)
- **텔레메트리 없음** — pi-voicekit은 사용 데이터를 수집하거나 전송하지 않습니다
- **API 키** — 환경 변수 또는 Pi 설정에 저장되며, 로그에 기록되지 않습니다

취약점 보고는 [SECURITY.md](../SECURITY.md)를 참조하세요.

---

## 라이선스

[MIT](../LICENSE) — 원작자 [@baanditeagle](https://x.com/baanditeagle), 현재 [CyFeng16](https://github.com/CyFeng16)이 유지 관리

---

## 링크

- **npm:** [npmjs.com/package/pi-voicekit](https://www.npmjs.com/package/pi-voicekit)
- **GitHub:** [github.com/CyFeng16/pi-voicekit](https://github.com/CyFeng16/pi-voicekit)
- **Deepgram:** [dpgr.am/pi-voice](https://dpgr.am/pi-voice) ($200 무료 크레딧)
- **Pi CLI:** [github.com/earendil-works/pi-coding-agent](https://github.com/earendil-works/pi-coding-agent)
