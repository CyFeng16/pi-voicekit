[English](../README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Português](README.pt-BR.md) | [हिन्दी](README.hi.md)

# pi-listen

<p align="center">
  <img src="../assets/banner.png" alt="pi-listen — Pi 코딩 에이전트용 음성 입력" width="100%" />
</p>

**[Pi](https://github.com/earendil-works/pi-coding-agent)를 위한 길게 누르기 음성 입력.** Deepgram 클라우드 스트리밍 또는 로컬 모델로 완전 오프라인 지원.

[![npm version](https://img.shields.io/npm/v/pi-voicekit.svg)](https://www.npmjs.com/package/pi-voicekit)
[![license](https://img.shields.io/npm/l/pi-voicekit.svg)](https://github.com/CyFeng16/pi-voicekit/blob/main/LICENSE)
[![author](https://img.shields.io/badge/author-@baanditeagle-1DA1F2?logo=x&logoColor=white)](https://x.com/baanditeagle)

> **v5.0.1 — 보안 패치** — API 키가 프로젝트 설정에 노출되던 문제 수정. 악성 저장소 설정을 통한 마이크 오디오의 원격 서버 리디렉션 차단. API 키 온보딩 시 셸 인젝션 수정. 설정 쓰기가 원자적 작업으로 변경. [전체 변경 로그 →](../CHANGELOG.md)

---

## 작동 방식 보기

<video src="../assets/pi-listen.mp4" controls width="100%"></video>

---

## 설정 (2분)

### 1. 확장 기능 설치

```bash
# 일반 터미널에서 실행 (Pi 내부가 아닌)
pi install npm:pi-voicekit
```

### 2. 백엔드 선택

pi-listen은 두 가지 음성 인식 백엔드를 지원합니다:

|               | Deepgram (클라우드)                                  | 로컬 모델 (오프라인)                         |
| ------------- | ---------------------------------------------------- | -------------------------------------------- |
| **작동 방식** | 라이브 스트리밍 — 말하는 동안 텍스트가 나타남        | 배치 모드 — 녹음 완료 후 텍스트 변환         |
| **설정**      | API 키 필요                                          | API 키 불필요, 첫 사용 시 모델 자동 다운로드 |
| **인터넷**    | 필요                                                 | 모델 다운로드 후 불필요                      |
| **지연 시간** | 실시간 중간 결과                                     | 녹음 중지 후 2~10초                          |
| **언어**      | 56개 이상 라이브 스트리밍 지원                       | 모델에 따라 다름 (1~57개 언어)               |
| **비용**      | $200 무료 크레딧 (대부분의 개발자에게 6~12개월 지속) | 영구 무료                                    |

Pi 내부에서 `/voice-settings`를 실행하여 백엔드를 선택하고 모든 설정을 한 곳에서 구성하세요.

#### 옵션 A: Deepgram (라이브 스트리밍 추천)

[dpgr.am/pi-voice](https://dpgr.am/pi-voice)에서 가입 — $200 무료 크레딧, 카드 불필요.

```bash
export DEEPGRAM_API_KEY="your-key-here"    # ~/.zshrc 또는 ~/.bashrc에 추가
```

#### 옵션 B: 로컬 모델 (완전 오프라인)

추가 설정 불필요 — `/voice-settings`를 실행하고, 백엔드를 Local로 전환한 뒤 모델을 선택하면 자동으로 다운로드됩니다.

> **참고:** 로컬 모델은 배치 모드를 사용합니다 — 말하는 동안이 아닌 녹음이 끝난 후에 텍스트로 변환합니다. 말하면서 실시간 스트리밍을 원하면 Deepgram을 사용하세요.

### 3. Pi 열기

첫 실행 시 pi-listen이 설정을 확인하고 준비 상태를 알려줍니다:

- 백엔드 설정 완료 (Deepgram 키 또는 로컬 모델)
- 오디오 캡처 도구 감지 (sox, ffmpeg 또는 arecord)
- 모든 것이 준비되면 음성이 즉시 활성화

### 오디오 캡처

pi-listen이 오디오 도구를 자동 감지합니다. sox나 ffmpeg가 이미 설치되어 있다면 수동 설치가 필요 없습니다.

| 우선순위 | 도구            | 플랫폼                | 설치                                                         |
| -------- | --------------- | --------------------- | ------------------------------------------------------------ |
| 1        | **SoX** (`rec`) | macOS, Linux, Windows | `brew install sox` / `apt install sox` / `choco install sox` |
| 2        | **ffmpeg**      | macOS, Linux, Windows | `brew install ffmpeg` / `apt install ffmpeg`                 |
| 3        | **arecord**     | Linux 전용            | 사전 설치됨 (ALSA)                                           |

---

## 설정 패널

모든 설정이 한 곳에 모여 있습니다: `/voice-settings`. 네 개의 탭이 필요한 모든 것을 다룹니다.

### 일반 — 백엔드, 언어, 범위

<img src="../assets/settings-general.png" alt="일반 설정 — 백엔드, 모델, 언어, 범위, 음성 토글" width="600" />

Deepgram(클라우드, 라이브 스트리밍)과 Local(오프라인, 배치 모드) 간 전환. 언어, 범위 변경, 음성 활성화/비활성화 — 모두 키보드 단축키로 조작 가능.

### 모델 — 탐색, 검색, 설치

<img src="../assets/settings-models.png" alt="모델 탭 — 정확도/속도 평가가 있는 21개 모델 탐색" width="600" />

Parakeet, Whisper, Moonshine, SenseVoice, GigaAM, Paraformer, Qwen3의 21개 모델을 탐색하세요. 각 모델은 정확도와 속도 평가(●●●●○/●●●●○), 적합성 배지, 다운로드 상태를 표시합니다. 퍼지 검색으로 모델을 빠르게 찾으세요. Enter를 눌러 활성화 및 다운로드.

### 다운로드됨 — 설치된 모델 관리

<img src="../assets/settings-downloaded.png" alt="다운로드됨 탭 — 설치된 모델 관리, 활성화 또는 삭제" width="600" />

설치된 모델, 총 디스크 사용량, 활성 모델을 확인하세요. Enter로 활성화, `x`로 삭제. [Handy](https://github.com/cjpais/handy)의 모델은 자동 감지되어 다시 다운로드하지 않고 가져올 수 있습니다.

### 디바이스 — 하드웨어 프로필 및 의존성

<img src="../assets/settings-device.png" alt="디바이스 탭 — 하드웨어 프로필, 의존성, 디스크 공간" width="600" />

하드웨어 프로필(RAM, CPU, GPU), 의존성 상태(sherpa-onnx 런타임), 사용 가능한 디스크 공간, 다운로드된 모델 총량을 확인하세요. 모델 추천은 이 프로필을 기반으로 합니다.

---

## 사용법

### 키 바인딩

| 동작              | 키                              | 비고                                                            |
| ----------------- | ------------------------------- | --------------------------------------------------------------- |
| **에디터에 녹음** | `SPACE` 길게 누르기(1.2초 이상) | 놓으면 확정. 워밍업 중 사전 녹음으로 첫 단어를 놓치지 않습니다. |
| **녹음 토글**     | `Ctrl+Shift+V`                  | 모든 터미널에서 작동 — 눌러서 시작, 다시 눌러서 중지.           |
| **에디터 지우기** | `Escape` × 2                    | 500ms 이내 더블 탭으로 모든 텍스트 삭제.                        |

### 녹음 작동 방식

1. **SPACE 길게 누르기** — 워밍업 카운트다운 표시, 오디오 캡처 즉시 시작(사전 녹음)
2. **계속 누르고 있기** — 실시간 텍스트 변환이 에디터로 스트리밍(Deepgram) 또는 오디오 버퍼링(로컬)
3. **SPACE 놓기** — 마지막 단어를 잡기 위해 1.5초 동안 녹음 계속(테일 녹음), 이후 확정
4. 텍스트가 에디터에 나타나며 전송 준비 완료

### 명령어

| 명령어              | 설명                                           |
| ------------------- | ---------------------------------------------- |
| `/voice-settings`   | 설정 패널 — 백엔드, 모델, 언어, 범위, 디바이스 |
| `/voice-models`     | 설정 패널 (모델 탭)                            |
| `/voice test`       | 전체 진단 — 오디오 도구, 마이크, API 키        |
| `/voice on` / `off` | 음성 활성화 또는 비활성화                      |
| `/voice dictate`    | 연속 받아쓰기 (키를 누르고 있지 않아도 됨)     |
| `/voice stop`       | 활성 녹음 또는 받아쓰기 중지                   |
| `/voice history`    | 최근 텍스트 변환 기록                          |
| `/voice`            | 켜기/끄기 토글                                 |

---

## 로컬 모델

7개 패밀리에서 21개 모델. 품질순 정렬 — 최고 모델이 먼저.

### 추천 모델

| 모델                | 정확도 | 속도  | 크기   | 언어           | 비고                 |
| ------------------- | ------ | ----- | ------ | -------------- | -------------------- |
| **Parakeet TDT v3** | ●●●●○  | ●●●●○ | 671 MB | 25 (자동 감지) | 종합 최고. WER 6.3%. |
| **Parakeet TDT v2** | ●●●●●  | ●●●●○ | 661 MB | 영어           | 영어 최고. WER 6.0%. |
| **Whisper Turbo**   | ●●●●○  | ●●○○○ | 1.0 GB | 57             | 가장 넓은 언어 지원. |

### 빠르고 가벼운 모델

| 모델                  | 정확도 | 속도  | 크기   | 언어            | 비고                          |
| --------------------- | ------ | ----- | ------ | --------------- | ----------------------------- |
| **Moonshine v2 Tiny** | ●●○○○  | ●●●●● | 43 MB  | 영어            | 34ms 지연. Raspberry Pi 호환. |
| **Moonshine Base**    | ●●●○○  | ●●●●● | 287 MB | 영어            | 억양 처리 우수.               |
| **SenseVoice Small**  | ●●●○○  | ●●●●● | 228 MB | zh/en/ja/ko/yue | CJK 언어에 최적.              |

### 전문 모델

| 모델                 | 정확도 | 속도  | 크기   | 언어     | 비고                                    |
| -------------------- | ------ | ----- | ------ | -------- | --------------------------------------- |
| **GigaAM v3**        | ●●●●○  | ●●●●○ | 225 MB | 러시아어 | 러시아어에서 Whisper 대비 WER 50% 낮음. |
| **Whisper Medium**   | ●●●●○  | ●●●○○ | 946 MB | 57       | 우수한 정확도, 보통 속도.               |
| **Whisper Large v3** | ●●●●○  | ●○○○○ | 1.8 GB | 57       | Whisper 최고 정확도. CPU에서 느림.      |

일본어, 한국어, 아랍어, 중국어, 우크라이나어, 베트남어, 스페인어를 위한 8개의 언어 특화 Moonshine v2 변형도 있습니다.

### 로컬 모델 작동 방식

```
SPACE 길게 누르기 → 오디오가 메모리 버퍼에 캡처
                      ↓
SPACE 놓기 → 버퍼를 sherpa-onnx에 전송 (인프로세스)
                      ↓
               CPU에서 ONNX 추론 (2~10초)
                      ↓
               최종 텍스트 변환이 에디터에 삽입
```

모델은 첫 사용 시 자동 다운로드됩니다. 다운로드는 재개 가능하고, 완료 후 검증되며, 중복 다운로드가 발생하지 않습니다. 설정 패널에 실시간 다운로드 진행률, 속도, ETA가 표시됩니다.

[Handy](https://github.com/cjpais/handy)(`~/Library/Application Support/com.pais.handy/models/`)의 모델은 자동 감지되어 심볼릭 링크로 가져올 수 있습니다(디스크 중복 제로).

---

## 기능

| 기능                                 | 설명                                                                               |
| ------------------------------------ | ---------------------------------------------------------------------------------- |
| **듀얼 백엔드**                      | Deepgram(클라우드, 라이브 스트리밍) 또는 로컬 모델(오프라인, 배치) — 설정에서 전환 |
| **21개 로컬 모델**                   | Parakeet, Whisper, Moonshine, SenseVoice, GigaAM, Paraformer, Qwen3 — 정확도/속도 평가 포함           |
| **통합 설정 패널**                   | 모든 설정을 하나의 오버레이 패널에서 — `/voice-settings`                           |
| **디바이스 인식 추천**               | 하드웨어에 맞춰 모델 점수 평가. 동급 최고 모델만 [recommended] 표시.               |
| **엔터프라이즈 다운로드 파이프라인** | 사전 검사(디스크, 네트워크, 권한), 속도/ETA 포함 실시간 진행률, 다운로드 후 검증   |
| **Handy 통합**                       | Handy 앱의 모델 자동 감지, 심볼릭 링크로 가져오기                                  |
| **오디오 폴백 체인**                 | sox, ffmpeg, arecord 순서로 시도                                                   |
| **사전 녹음**                        | 워밍업 중 오디오 캡처 시작 — 첫 단어를 절대 놓치지 않음                            |
| **테일 녹음**                        | 놓은 후 1.5초간 녹음 계속으로 마지막 단어가 잘리지 않음                            |
| **라이브 스트리밍**                  | Deepgram Nova 3 WebSocket — 말하는 동안 중간 텍스트 변환                           |
| **56개 이상의 언어**                 | Deepgram: 56개 이상 라이브 스트리밍. 로컬: 모델에 따라 최대 57개.                  |
| **연속 받아쓰기**                    | `/voice dictate`로 키를 누르지 않고 긴 텍스트 입력                                 |
| **타이핑 쿨다운**                    | 타이핑 후 400ms 이내의 스페이스 길게 누르기는 무시                                 |
| **소리 피드백**                      | macOS 시스템 사운드로 시작, 중지, 오류 이벤트 알림                                 |
| **크로스 플랫폼**                    | macOS, Windows, Linux — Kitty 프로토콜 + 비 Kitty 폴백                             |

---

## 아키텍처

```
extensions/voice.ts                메인 확장 — 상태 머신, 녹음, UI, 설정 패널
extensions/voice/config.ts         설정 로딩, 저장, 마이그레이션
extensions/voice/onboarding.ts     첫 실행 마법사, 언어 선택기
extensions/voice/deepgram.ts       Deepgram URL 빌더, API 키 리졸버
extensions/voice/local.ts          모델 카탈로그 (21개 모델), 인프로세스 텍스트 변환
extensions/voice/device.ts         디바이스 프로파일링 — RAM, GPU, CPU, 컨테이너 감지
extensions/voice/model-download.ts 다운로드 관리자 — 재개, 진행률, 검증, Handy 가져오기
extensions/voice/sherpa-engine.ts   sherpa-onnx 바인딩 — 인식기 라이프사이클, 추론
extensions/voice/settings-panel.ts  설정 패널 — Component 인터페이스, 오버레이, 4개 탭
```

---

## 설정

Pi의 설정 파일 내 `voice` 키에 저장됩니다:

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

---

## 문제 해결

Pi 내부에서 `/voice test`를 실행하여 전체 진단을 수행하세요.

| 문제                                | 해결 방법                                                                               |
| ----------------------------------- | --------------------------------------------------------------------------------------- |
| "DEEPGRAM_API_KEY not set"          | [키 발급](https://dpgr.am/pi-voice) → `~/.zshrc`에 `export DEEPGRAM_API_KEY="..."` 추가 |
| "No audio capture tool found"       | `brew install sox` 또는 `brew install ffmpeg`                                           |
| 스페이스바로 음성이 활성화되지 않음 | `/voice-settings` 실행 — 음성이 비활성화되어 있을 수 있음                               |
| 로컬 모델이 텍스트 변환하지 않음    | `/voice-settings` → 디바이스 탭에서 sherpa-onnx 상태 확인                               |
| 다운로드 실패                       | 부분 다운로드는 재시도 시 자동 재개됩니다. 디바이스 탭에서 디스크 공간 확인.            |

---

## 보안

- **클라우드 STT** — 오디오가 텍스트 변환을 위해 Deepgram으로 전송됩니다 (Deepgram 백엔드만 해당)
- **로컬 STT** — 오디오가 기기 밖으로 나가지 않습니다 (로컬 백엔드)
- **텔레메트리 없음** — pi-listen은 사용 데이터를 수집하거나 전송하지 않습니다
- **API 키** — 환경 변수 또는 Pi 설정에 저장, 로그에 기록되지 않음

취약점 보고는 [SECURITY.md](../SECURITY.md)를 참조하세요.

---

## 라이선스

[MIT](../LICENSE) © 2026 codexstar69

---

## 링크

- **npm:** [npmjs.com/package/pi-voicekit](https://www.npmjs.com/package/pi-voicekit)
- **GitHub:** [github.com/CyFeng16/pi-voicekit](https://github.com/CyFeng16/pi-voicekit)
- **Deepgram:** [dpgr.am/pi-voice](https://dpgr.am/pi-voice) ($200 무료 크레딧)
- **Pi CLI:** [github.com/earendil-works/pi-coding-agent](https://github.com/earendil-works/pi-coding-agent)
