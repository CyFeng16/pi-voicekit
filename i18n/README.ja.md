[English](../README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Português](README.pt-BR.md) | [हिन्दी](README.hi.md)

# pi-voicekit

<p align="center">
  <img src="../assets/banner.png" alt="pi-voicekit — Pi コーディングエージェント用の音声入力" width="100%" />
</p>

**[Pi](https://github.com/earendil-works/pi-coding-agent) 向けの長押しトーク音声入力。** Deepgram によるクラウドストリーミング、またはローカルモデルによる完全オフライン対応。

[![npm version](https://img.shields.io/npm/v/pi-voicekit.svg)](https://www.npmjs.com/package/pi-voicekit)
[![license](https://img.shields.io/npm/l/pi-voicekit.svg)](https://github.com/CyFeng16/pi-voicekit/blob/main/LICENSE)
[![author](https://img.shields.io/badge/author-@baanditeagle-1DA1F2?logo=x&logoColor=white)](https://x.com/baanditeagle)

> **v5.0.1 — セキュリティパッチ** — API キーがプロジェクト設定に漏洩する問題を修正。悪意のあるリポジトリ設定によるマイク音声のリモートサーバーへのリダイレクトを防止。API キーオンボーディング時のシェルインジェクションを修正。設定の書き込みがアトミック操作に。[完全な変更履歴 →](../CHANGELOG.md)

---

## 動作デモ

<video src="../assets/pi-listen.mp4" controls width="100%"></video>

---

## セットアップ（2分）

### 1. 拡張機能のインストール

```bash
# 通常のターミナルで実行（Pi の内部ではなく）
pi install npm:pi-voicekit
```

### 2. バックエンドの選択

pi-voicekit は2つの文字起こしバックエンドに対応しています：

|                    | Deepgram（クラウド）                                  | ローカルモデル（オフライン）                       |
| ------------------ | ----------------------------------------------------- | -------------------------------------------------- |
| **仕組み**         | ライブストリーミング — 話しながらテキストが表示される | バッチモード — 録音終了後に文字起こし              |
| **セットアップ**   | API キーが必要                                        | API キー不要、モデルは初回使用時に自動ダウンロード |
| **インターネット** | 必要                                                  | モデルダウンロード後は不要                         |
| **レイテンシ**     | リアルタイムの中間結果                                | 録音停止後 2〜10 秒                                |
| **言語**           | 56以上のライブストリーミング対応言語                  | モデルにより異なる（1〜57言語）                    |
| **費用**           | $200 の無料クレジット（多くの開発者で6〜12ヶ月持続）  | 永久無料                                           |

Pi 内で `/voice-settings` を実行して、バックエンドの選択とすべての設定を一箇所で行えます。

#### オプション A：Deepgram（ライブストリーミング推奨）

[dpgr.am/pi-voice](https://dpgr.am/pi-voice) でサインアップ — $200 の無料クレジット、クレジットカード不要。

```bash
export DEEPGRAM_API_KEY="your-key-here"    # ~/.zshrc または ~/.bashrc に追加
```

#### オプション B：ローカルモデル（完全オフライン）

追加セットアップ不要 — `/voice-settings` を実行し、バックエンドを Local に切り替えてモデルを選択すると自動でダウンロードされます。

> **注意：** ローカルモデルはバッチモードで動作します — 話しながらではなく、録音終了後に文字起こしを行います。リアルタイムのライブストリーミングには Deepgram をご利用ください。

### 3. Pi を開く

初回起動時、pi-voicekit はセットアップを確認し、準備状況を通知します：

- バックエンドの設定済み（Deepgram キーまたはローカルモデル）
- 音声キャプチャツールの検出（sox、ffmpeg、または arecord）
- すべて問題なければ、音声機能が即座に有効化

### 音声キャプチャ

pi-voicekit は音声ツールを自動検出します。sox または ffmpeg がインストール済みなら手動インストールは不要です。

| 優先度 | ツール          | 対応プラットフォーム  | インストール                                                 |
| ------ | --------------- | --------------------- | ------------------------------------------------------------ |
| 1      | **SoX** (`rec`) | macOS、Linux、Windows | `brew install sox` / `apt install sox` / `choco install sox` |
| 2      | **ffmpeg**      | macOS、Linux、Windows | `brew install ffmpeg` / `apt install ffmpeg`                 |
| 3      | **arecord**     | Linux のみ            | プリインストール（ALSA）                                     |

---

## 設定パネル

すべての設定は一箇所に集約：`/voice-settings`。4つのタブですべてをカバーします。

### 全般 — バックエンド、言語、スコープ

<img src="../assets/settings-general.png" alt="全般設定 — バックエンド、モデル、言語、スコープ、音声トグル" width="600" />

Deepgram（クラウド、ライブストリーミング）と Local（オフライン、バッチモード）を切り替え。言語、スコープの変更、音声の有効/無効化 — すべてキーボードショートカットで操作可能。

### モデル — 閲覧、検索、インストール

<img src="../assets/settings-models.png" alt="モデルタブ — 21モデルを精度/速度評価付きで閲覧" width="600" />

Parakeet、Whisper、Moonshine、SenseVoice、GigaAM、Paraformer、Qwen3 の21モデルを閲覧。各モデルには精度と速度の評価（●●●●○/●●●●○）、適性バッジ、ダウンロード状態が表示されます。ファジー検索でモデルを素早く検索。Enter キーで有効化とダウンロード。

### ダウンロード済み — インストール済みモデルの管理

<img src="../assets/settings-downloaded.png" alt="ダウンロード済みタブ — インストール済みモデルの管理、有効化または削除" width="600" />

インストール済みのモデル、合計ディスク使用量、アクティブなモデルを確認。Enter で有効化、`x` で削除。[Handy](https://github.com/cjpais/handy) のモデルは自動検出され、再ダウンロードなしでインポートできます。

### デバイス — ハードウェアプロファイルと依存関係

<img src="../assets/settings-device.png" alt="デバイスタブ — ハードウェアプロファイル、依存関係、ディスク容量" width="600" />

ハードウェアプロファイル（RAM、CPU、GPU）、依存関係の状態（sherpa-onnx ランタイム）、利用可能なディスク容量、ダウンロード済みモデルの合計を確認。モデルの推奨はこのプロファイルに基づきます。

---

## 使い方

### キーバインド

| 操作                 | キー                        | 備考                                                                       |
| -------------------- | --------------------------- | -------------------------------------------------------------------------- |
| **エディタに録音**   | `SPACE` 長押し（1.2秒以上） | 離すと確定。ウォームアップ中もプリレコーディングで最初の言葉を逃しません。 |
| **録音の切り替え**   | `Ctrl+Shift+V`              | すべてのターミナルで動作 — 押して開始、もう一度押して停止。                |
| **エディタをクリア** | `Escape` × 2                | 500ms 以内にダブルタップですべてのテキストをクリア。                       |

### 録音の仕組み

1. **SPACE を長押し** — ウォームアップのカウントダウンが表示され、音声キャプチャが即座に開始（プリレコーディング）
2. **押し続ける** — リアルタイム文字起こしがエディタにストリーミング（Deepgram）、または音声がバッファリング（ローカル）
3. **SPACE を離す** — 最後の言葉をキャッチするため 1.5 秒間録音を継続（テールレコーディング）、その後確定
4. テキストがエディタに表示され、送信可能な状態に

### コマンド

| コマンド            | 説明                                                        |
| ------------------- | ----------------------------------------------------------- |
| `/voice-settings`   | 設定パネル — バックエンド、モデル、言語、スコープ、デバイス |
| `/voice-models`     | 設定パネル（モデルタブ）                                    |
| `/voice test`       | 完全診断 — 音声ツール、マイク、API キー                     |
| `/voice on` / `off` | 音声の有効化/無効化                                         |
| `/voice dictate`    | 連続ディクテーション（キー長押し不要）                      |
| `/voice stop`       | アクティブな録音またはディクテーションを停止                |
| `/voice history`    | 最近の文字起こし履歴                                        |
| `/voice`            | オン/オフ切り替え                                           |

---

## ローカルモデル

7つのファミリーから21モデル。品質順に並べています — 最良のモデルが最初です。

### おすすめ

| モデル              | 精度  | 速度  | サイズ | 言語           | 備考                   |
| ------------------- | ----- | ----- | ------ | -------------- | ---------------------- |
| **Parakeet TDT v3** | ●●●●○ | ●●●●○ | 671 MB | 25（自動検出） | 総合ベスト。WER 6.3%。 |
| **Parakeet TDT v2** | ●●●●● | ●●●●○ | 661 MB | 英語           | 英語ベスト。WER 6.0%。 |
| **Whisper Turbo**   | ●●●●○ | ●●○○○ | 1.0 GB | 57             | 最も広い言語サポート。 |

### 高速・軽量

| モデル                | 精度  | 速度  | サイズ | 言語           | 備考                                 |
| --------------------- | ----- | ----- | ------ | -------------- | ------------------------------------ |
| **Moonshine v2 Tiny** | ●●○○○ | ●●●●● | 43 MB  | 英語           | 34ms レイテンシ。Raspberry Pi 対応。 |
| **Moonshine Base**    | ●●●○○ | ●●●●● | 287 MB | 英語           | アクセントの処理が得意。             |
| **SenseVoice Small**  | ●●●○○ | ●●●●● | 228 MB | 中/英/日/韓/粤 | CJK 言語に最適。                     |

### スペシャリスト

| モデル               | 精度  | 速度  | サイズ | 言語     | 備考                                    |
| -------------------- | ----- | ----- | ------ | -------- | --------------------------------------- |
| **GigaAM v3**        | ●●●●○ | ●●●●○ | 225 MB | ロシア語 | ロシア語で Whisper より WER が50%低い。 |
| **Whisper Medium**   | ●●●●○ | ●●●○○ | 946 MB | 57       | 良好な精度、中程度の速度。              |
| **Whisper Large v3** | ●●●●○ | ●○○○○ | 1.8 GB | 57       | Whisper 最高精度。CPU では低速。        |

日本語、韓国語、アラビア語、中国語、ウクライナ語、ベトナム語、スペイン語向けの言語特化型 Moonshine v2 バリアントが8つあります。

### ローカルモデルの仕組み

```
SPACE を長押し → 音声がメモリバッファにキャプチャ
                    ↓
SPACE を離す → バッファを sherpa-onnx に送信（インプロセス）
                    ↓
             CPU で ONNX 推論（2〜10 秒）
                    ↓
             最終的な文字起こしがエディタに挿入
```

モデルは初回使用時に自動ダウンロードされます。ダウンロードはレジューム可能で、完了後に検証され、重複ダウンロードはありません。設定パネルにはリアルタイムのダウンロード進捗、速度、ETAが表示されます。

[Handy](https://github.com/cjpais/handy)（`~/Library/Application Support/com.pais.handy/models/`）のモデルは自動検出され、シンボリックリンクでインポートできます（ディスク重複ゼロ）。

---

## 機能一覧

| 機能                                           | 説明                                                                                                 |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **デュアルバックエンド**                       | Deepgram（クラウド、ライブストリーミング）またはローカルモデル（オフライン、バッチ）— 設定で切り替え |
| **21のローカルモデル**                         | Parakeet、Whisper、Moonshine、SenseVoice、GigaAM、Paraformer、Qwen3 — 精度/速度評価付き                                 |
| **統合設定パネル**                             | すべての設定を一つのオーバーレイパネルで — `/voice-settings`                                         |
| **デバイス対応の推奨**                         | ハードウェアに対してモデルをスコアリング。ベストインクラスのモデルのみ [recommended] 表示。          |
| **エンタープライズ級ダウンロードパイプライン** | 事前チェック（ディスク、ネットワーク、権限）、速度/ETA 付きライブ進捗、ダウンロード後の検証          |
| **Handy 統合**                                 | Handy アプリのモデルを自動検出、シンボリックリンクでインポート                                       |
| **音声フォールバックチェーン**                 | sox、ffmpeg、arecord を順に試行                                                                      |
| **プリレコーディング**                         | ウォームアップ中に音声キャプチャ開始 — 最初の言葉を逃さない                                          |
| **テールレコーディング**                       | リリース後 1.5 秒間録音を継続、最後の言葉がカットされない                                            |
| **ライブストリーミング**                       | Deepgram Nova 3 WebSocket — 話しながら中間文字起こし                                                 |
| **56以上の言語**                               | Deepgram：56以上のライブストリーミング対応言語。ローカル：モデルにより最大57言語。                   |
| **連続ディクテーション**                       | `/voice dictate` で長文入力、キー長押し不要                                                          |
| **タイピングクールダウン**                     | タイピング後 400ms 以内のスペース長押しは無視                                                        |
| **サウンドフィードバック**                     | macOS システムサウンドで開始、停止、エラーイベントを通知                                             |
| **クロスプラットフォーム**                     | macOS、Windows、Linux — Kitty プロトコル + 非 Kitty フォールバック                                   |

---

## アーキテクチャ

```
extensions/voice.ts                メイン拡張 — ステートマシン、録音、UI、設定パネル
extensions/voice/config.ts         設定の読み込み、保存、マイグレーション
extensions/voice/onboarding.ts     初回実行ウィザード、言語ピッカー
extensions/voice/deepgram.ts       Deepgram URL ビルダー、API キーリゾルバー
extensions/voice/local.ts          モデルカタログ（21モデル）、インプロセス文字起こし
extensions/voice/device.ts         デバイスプロファイリング — RAM、GPU、CPU、コンテナ検出
extensions/voice/model-download.ts ダウンロードマネージャー — レジューム、進捗、検証、Handy インポート
extensions/voice/sherpa-engine.ts   sherpa-onnx バインディング — リコグナイザーライフサイクル、推論
extensions/voice/settings-panel.ts  設定パネル — Component インターフェース、オーバーレイ、4タブ
```

---

## 設定

Pi の設定ファイル内の `voice` キーに保存されます：

| スコープ     | パス                          |
| ------------ | ----------------------------- |
| グローバル   | `~/.pi/agent/settings.json`   |
| プロジェクト | `<project>/.pi/settings.json` |

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

## トラブルシューティング

Pi 内で `/voice test` を実行して完全な診断を行います。

| 問題                               | 解決策                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------- |
| "DEEPGRAM_API_KEY not set"         | [キーを取得](https://dpgr.am/pi-voice) → `~/.zshrc` に `export DEEPGRAM_API_KEY="..."` を追加 |
| "No audio capture tool found"      | `brew install sox` または `brew install ffmpeg`                                               |
| スペースキーで音声が起動しない     | `/voice-settings` を実行 — 音声が無効になっている可能性があります                             |
| ローカルモデルが文字起こしされない | `/voice-settings` → デバイスタブで sherpa-onnx の状態を確認                                   |
| ダウンロード失敗                   | 部分的なダウンロードはリトライ時に自動レジュームされます。デバイスタブでディスク容量を確認。  |

---

## セキュリティ

- **クラウド STT** — 音声は文字起こしのために Deepgram に送信されます（Deepgram バックエンドのみ）
- **ローカル STT** — 音声はマシンの外に出ません（ローカルバックエンド）
- **テレメトリなし** — pi-voicekit は利用データの収集・送信を行いません
- **API キー** — 環境変数または Pi 設定に保存、ログには記録されません

脆弱性の報告については [SECURITY.md](../SECURITY.md) をご覧ください。

---

## ライセンス

[MIT](../LICENSE) © 2026 codexstar69

---

## リンク

- **npm:** [npmjs.com/package/pi-voicekit](https://www.npmjs.com/package/pi-voicekit)
- **GitHub:** [github.com/CyFeng16/pi-voicekit](https://github.com/CyFeng16/pi-voicekit)
- **Deepgram:** [dpgr.am/pi-voice](https://dpgr.am/pi-voice)（$200 無料クレジット）
- **Pi CLI:** [github.com/earendil-works/pi-coding-agent](https://github.com/earendil-works/pi-coding-agent)
