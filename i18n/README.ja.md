[English](../README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Português](README.pt-BR.md) | [हिन्दी](README.hi.md)

# pi-voicekit

> **[`codexstar69/pi-listen`](https://github.com/codexstar69/pi-listen) のコミュニティ継続プロジェクト**（アップストリーム、MIT — 2026年5月の v7.2.2 以降は休眠状態）。
> 原作者との関係はありません。旧名称：`pi-listen`。

<p align="center">
  <img src="../assets/brand/banner-en.png" alt="pi-voicekit — Pi コーディングエージェント用の音声入力と出力" width="100%" />
</p>

**[Pi](https://github.com/earendil-works/pi-coding-agent) への音声入力と、Pi からの音声出力。**
長押しトークの STT — Deepgram ストリーミング（クラウド）または 21 個のオフラインモデル — に加えて、
エージェントの返答を読み上げる TTS（Kitten、Kokoro、Piper、Deepgram Aura）。

[![npm version](https://img.shields.io/npm/v/pi-voicekit.svg)](https://www.npmjs.com/package/pi-voicekit)
[![license](https://img.shields.io/npm/l/pi-voicekit.svg)](https://github.com/CyFeng16/pi-voicekit/blob/main/LICENSE)
[![original author](https://img.shields.io/badge/original_author-@baanditeagle-1DA1F2?logo=x&logoColor=white)](https://x.com/baanditeagle)

> **v0.1.3 — 最新リリース** — `PULSE_SERVER`（SSH 音声トンネル / リモート PulseAudio）が
> 設定されている場合、音声キャプチャは `ffmpeg` を優先するため、リモートマイクでも
> 安定して録音できます。音声入力**と**音声出力：21 個のオフライン STT モデル、
> 20 個のローカル TTS 音声、さらに Deepgram Aura を、6 つのタブを持つ
> `/voice-settings` パネルひとつで操作できます。0.1.x 系は[変更履歴](../CHANGELOG.md)に記載されています。

---

## 動作デモ

<p align="center">
  <video src="../assets/demo/pi-voicekit-demo.mp4" controls width="100%"></video>
  <br>
  <em>デモ動画</em>
</p>

---

## セットアップ（2分）

### 1. 拡張機能のインストール

```bash
# 通常のターミナルで実行（Pi の内部ではなく）
pi install npm:pi-voicekit
```

### 2. バックエンドの選択

pi-voicekit は 2 つの文字起こしバックエンドに対応しています：

|                    | Deepgram（クラウド）                                    | ローカルモデル（オフライン）                       |
| ------------------ | ------------------------------------------------------- | -------------------------------------------------- |
| **仕組み**         | ライブストリーミング — 話しながらテキストが表示されます | バッチモード — 録音終了後に文字起こしします        |
| **セットアップ**   | API キーが必要                                          | API キー不要、モデルは初回使用時に自動ダウンロード |
| **インターネット** | 必要                                                    | モデルのダウンロード後は不要                       |
| **レイテンシ**     | リアルタイムの中間結果                                  | 録音停止後 2–10 秒                                 |
| **言語**           | ライブストリーミングで 56+ 言語                         | モデルにより異なります（1–57 言語）                |
| **費用**           | $200 の無料クレジット（多くの開発者で 6–12 か月持続）   | 永久無料                                           |

Pi 内で `/voice-settings` を実行すると、バックエンドの選択とすべての設定をひとつのパネルで行えます。

#### オプション A：Deepgram（ライブストリーミング推奨）

[dpgr.am/pi-voice](https://dpgr.am/pi-voice) でサインアップ — $200 の無料クレジット、カード登録は不要です。

```bash
export DEEPGRAM_API_KEY="your-key-here"    # ~/.zshrc または ~/.bashrc に追記
```

#### オプション B：ローカルモデル（完全オフライン）

セットアップは不要です — `/voice-settings` を実行してバックエンドを Local に切り替え、モデルを選ぶと自動でダウンロードされます。

> **注意：** ローカルモデルはバッチモードです — 話している最中ではなく、録音を終えてから文字起こしします。話しながらのライブストリーミングには Deepgram をご利用ください。

### 3. Pi の起動

初回起動時に、pi-voicekit がセットアップを確認して準備状況を知らせます：

- バックエンドが設定済み（Deepgram キーまたはローカルモデル）
- 音声キャプチャツールを検出済み（sox、ffmpeg、arecord のいずれか）
- すべて問題なければ、音声機能はその場で有効になります

### 音声キャプチャ

pi-voicekit は音声ツールを自動検出します。sox または ffmpeg がすでにあれば、手動インストールは不要です。

| 優先度 | ツール          | 対応プラットフォーム  | インストール                                                 |
| ------ | --------------- | --------------------- | ------------------------------------------------------------ |
| 1      | **SoX** (`rec`) | macOS、Linux、Windows | `brew install sox` / `apt install sox` / `choco install sox` |
| 2      | **ffmpeg**      | macOS、Linux、Windows | `brew install ffmpeg` / `apt install ffmpeg`                 |
| 3      | **arecord**     | Linux のみ            | プリインストール（ALSA）                                     |

> `PULSE_SERVER`（SSH 音声トンネルまたはリモート PulseAudio）が設定されている場合、順序は
> **ffmpeg → sox → arecord** になります — ネットワーク経由の Pulse 音源には ffmpeg が必要です。

---

## 設定パネル

すべての設定はひとつの場所に集約されています：`/voice-settings`。6 つのタブで必要なものをすべてカバーします。

### 全般 — バックエンド、言語、スコープ

<img src="../assets/screenshots/settings-general.png" alt="全般設定 — バックエンド、モデル、言語、スコープ、音声トグル" width="600" />

Deepgram（クラウド、ライブストリーミング）と Local（オフライン、バッチモード）を切り替えます。言語とスコープの変更、音声の有効化/無効化も、すべてキーボードショートカットで操作できます。

### モデル — 閲覧、検索、インストール

<img src="../assets/screenshots/settings-models.png" alt="モデルタブ — 精度/速度の評価付きで 21 モデルを閲覧" width="600" />

Parakeet、Whisper、Moonshine、SenseVoice、GigaAM、Paraformer、Qwen3 の 21 モデルを閲覧できます。各モデルには精度と速度の評価（●●●●○/●●●●○）、適性バッジ、ダウンロード状況が表示されます。ファジー検索でモデルをすばやく見つけられます。Enter を押すと有効化してダウンロードします。

### ダウンロード済み — インストール済みモデルの管理

<img src="../assets/screenshots/settings-downloaded.png" alt="ダウンロード済みタブ — インストール済みモデルの管理、有効化や削除" width="600" />

インストール済みのモデル、合計ディスク使用量、現在アクティブなモデルを確認できます。Enter で有効化、`x` で削除します。[Handy](https://github.com/cjpais/handy) のモデルは自動検出され、再ダウンロードなしでインポートできます。

### 読み上げ — TTS モデルと音声

TTS バックエンド（ローカルの sherpa-onnx または Deepgram Aura）を選択し、最小 ~13 MB の
20 個のローカル音声を閲覧、選択時にダウンロードして、バックエンドごとに音声を選べます。
エージェントの返答の自動読み上げもここで切り替えます。

### デバイス — ハードウェアプロファイルと依存関係

<img src="../assets/screenshots/settings-device.png" alt="デバイスタブ — ハードウェアプロファイル、依存関係、ディスク容量" width="600" />

ハードウェアプロファイル（RAM、CPU、GPU）、依存関係の状態（sherpa-onnx ランタイム）、利用可能なディスク容量、ダウンロード済みモデルの合計を確認できます。モデルの推奨はこのプロファイルに基づきます。

---

## 使い方

### キーバインド

| 操作                 | キー                    | 備考                                                                              |
| -------------------- | ----------------------- | --------------------------------------------------------------------------------- |
| **エディタに録音**   | `SPACE` 長押し（≥0.7s） | 離すと確定します。ウォームアップ中にプリレコーディングするため、最初の言葉を逃しません。 |
| **録音の切り替え**   | `Ctrl+Shift+V`          | すべてのターミナルで動作 — 押して開始、もう一度押して停止します。                  |
| **エディタをクリア** | `Escape` × 2            | 500ms 以内に 2 回押すと、すべてのテキストをクリアします。                         |

### 録音の仕組み

1. **SPACE を長押し** — ウォームアップのカウントダウンが表示され、音声キャプチャが即座に始まります（プリレコーディング）
2. **押し続ける** — リアルタイムの文字起こしがエディタに流れ込む（Deepgram）か、音声がバッファに蓄積されます（ローカル）
3. **SPACE を離す** — 最後の言葉を取りこぼさないよう 1.5 秒間録音を続け（テールレコーディング）、その後確定します
4. テキストがエディタに現れ、そのまま送信できる状態になります

### コマンド

| コマンド                 | 説明                                                         |
| ------------------------ | ------------------------------------------------------------ |
| `/voice-settings`        | 設定パネル — バックエンド、モデル、言語、スコープ、デバイス  |
| `/voice-models`          | 設定パネル（モデルタブ）                                     |
| `/voice-setup`           | 初回セットアップウィザードを実行                             |
| `/voice-language`        | 設定パネルを開いて言語を変更                                 |
| `/voice-speak <text>`    | テキストを音読する（TTS）                                    |
| `/voice-speak-test`      | サンプル文を読み上げる                                       |
| `/voice-speak-toggle`    | TTS の有効化 / 無効化                                        |
| `/voice-stream`          | Deepgram ストリーミング TTS（クラウド）の切り替え            |
| `/voice-speak-stop`      | 再生中の TTS を停止                                          |
| `/voice-autosubmit`      | 切り替え：STT テキストをエージェントへ自動送信（`on`/`off`） |
| `/voice-hold-delay`      | 長押しトーク遅延を設定（200-3000 ms、デフォルト 700）        |
| `/voice-speak-models`    | TTS 音声モデルの閲覧 / インストール                          |
| `/voice-speak-info`      | TTS の状態を診断                                             |
| `/voice-help`            | キーボードとコマンドの早見表（または `F1` を押す）           |
| `/voice test`            | 総合診断 — 音声ツール、マイク、API キー                      |
| `/voice on` / `off`      | 音声の有効化または無効化                                     |
| `/voice dictate`         | 連続ディクテーション（キー長押し不要）                       |
| `/voice stop`            | 実行中の録音またはディクテーションを停止                     |
| `/voice history`         | 最近の文字起こし                                             |
| `/voice`                 | オン/オフの切り替え                                          |

### v7.1 キーボード操作

設定パネル内でのキー操作：

| キー   | 操作                                 |
| ------ | ------------------------------------ |
| `← →`  | タブを切り替え                       |
| `↑ ↓`  | 行を移動（グループ見出しはスキップ） |
| `↵`    | 選択 / 有効化                        |
| `esc`  | メインに戻る / パネルを閉じる        |
| `type` | 絞り込み（検索）                     |
| `bksp` | 検索文字を 1 文字削除                |

インストールウィジェットまたは再生インジケーターがマウントされている間（前面にオーバーレイがない場合）：

| キー  | 操作                                                           |
| ----- | -------------------------------------------------------------- |
| `esc` | 進行中のインストールをキャンセル（直近のものから）、次に再生を停止 |
| `F1`  | ヘルプオーバーレイを開く（常に利用可能）                       |

---

## ローカルモデル

7 つのファミリーにまたがる 21 モデル。品質順に並んでいます — 最良のモデルが先頭です。

### トップピック

| モデル              | 精度  | 速度  | サイズ | 言語           | 備考                   |
| ------------------- | ----- | ----- | ------ | -------------- | ---------------------- |
| **Parakeet TDT v3** | ●●●●○ | ●●●●○ | 671 MB | 25（自動検出） | 総合ベスト。WER 6.3%。 |
| **Parakeet TDT v2** | ●●●●● | ●●●●○ | 661 MB | 英語           | 英語ベスト。WER 6.0%。 |
| **Whisper Turbo**   | ●●●●○ | ●●○○○ | 1.0 GB | 57             | 最も広い言語サポート。 |

### 高速・軽量

| モデル                | 精度  | 速度  | サイズ | 言語           | 備考                                     |
| --------------------- | ----- | ----- | ------ | -------------- | ---------------------------------------- |
| **Moonshine v2 Tiny** | ●●○○○ | ●●●●● | 43 MB  | 英語           | 34ms のレイテンシ。Raspberry Pi に最適。 |
| **Moonshine Base**    | ●●●○○ | ●●●●● | 287 MB | 英語           | アクセントの処理が得意。                 |
| **SenseVoice Small**  | ●●●○○ | ●●●●● | 228 MB | 中/英/日/韓/粤 | CJK 言語に最適。                         |

### スペシャリスト

| モデル               | 精度  | 速度  | サイズ | 言語     | 備考                                        |
| -------------------- | ----- | ----- | ------ | -------- | ------------------------------------------- |
| **GigaAM v3**        | ●●●●○ | ●●●●○ | 225 MB | ロシア語 | ロシア語では Whisper より WER が 50% 低い。 |
| **Whisper Medium**   | ●●●●○ | ●●●○○ | 946 MB | 57       | 精度は良好、速度は中程度。                  |
| **Whisper Large v3** | ●●●●○ | ●○○○○ | 1.8 GB | 57       | Whisper シリーズ最高の精度。CPU では低速。  |

さらに、日本語、韓国語、アラビア語、中国語、ウクライナ語、ベトナム語、スペイン語向けの言語特化型 Moonshine v2 バリアントが 8 つ用意されています。

### ローカルモデルの仕組み

```
SPACE を長押し → 音声をメモリバッファに取り込み
                    ↓
SPACE を離す → バッファを sherpa-onnx に送信（インプロセス）
                    ↓
         CPU 上で ONNX 推論（2–10 秒）
                    ↓
         最終的な文字起こしをエディタに挿入
```

モデルは初回使用時に自動ダウンロードされます。ダウンロードは途中再開に対応し、完了後に検証され、重複排除も行われます（二重ダウンロードはありません）。設定パネルには速度と ETA を含むリアルタイムの進捗が表示されます。

[Handy](https://github.com/cjpais/handy)（`~/Library/Application Support/com.pais.handy/models/`）のモデルは自動検出され、シンボリックリンク経由でインポートできます（ディスクの重複ゼロ）。

---

## 機能

| 機能                                     | 説明                                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **デュアルバックエンド**                 | Deepgram（クラウド、ライブストリーミング）またはローカルモデル（オフライン、バッチ）— 設定で切り替え |
| **21 のローカルモデル**                  | Parakeet、Whisper、Moonshine、SenseVoice、GigaAM、Paraformer、Qwen3 — 精度/速度評価付き          |
| **統合設定パネル**                       | すべての設定をひとつのオーバーレイパネルに — `/voice-settings`                                   |
| **デバイス対応の推奨**                   | ハードウェアに照らしてモデルを採点。最高クラスのモデルだけが [recommended] になります。           |
| **エンタープライズ級のダウンロード基盤** | 事前チェック（ディスク、ネットワーク、権限）、速度/ETA 付きのライブ進捗、完了後の検証            |
| **Handy 連携**                           | Handy アプリのモデルを自動検出し、シンボリックリンクでインポート                                 |
| **音声フォールバックチェーン**           | sox → ffmpeg → arecord の順に試行 — `PULSE_SERVER` 設定時は ffmpeg が最優先                      |
| **プリレコーディング**                   | ウォームアップ中から音声キャプチャを開始 — 最初の言葉を逃しません                                |
| **テールレコーディング**                 | 離してから 1.5 秒間録音を続け、最後の言葉が切れないようにします                                  |
| **ライブストリーミング**                 | Deepgram Nova 3 WebSocket（中国語ロケールでは Nova 2）— リアルタイムの中間文字起こし             |
| **56+ 言語**                             | Deepgram：ライブストリーミングで 56+ 言語。ローカル：モデルにより最大 57 言語。                   |
| **連続ディクテーション**                 | `/voice dictate` でキーを押し続けずに長文入力                                                    |
| **タイピングクールダウン**               | タイピング後 400ms 以内の SPACE 長押しを無視                                                     |
| **サウンドフィードバック**               | 開始・停止・エラーの各イベントを macOS のシステムサウンドで通知                                   |
| **クロスプラットフォーム**               | macOS、Windows、Linux — Kitty プロトコル + 非 Kitty フォールバック                               |

---

## アーキテクチャ

```
# core
extensions/voice.ts                         メイン拡張 — ステートマシン、録音、UI、コマンド群
extensions/voice/config.ts                  設定の読み込み、保存、マイグレーション
extensions/voice/onboarding.ts              初回起動ウィザード、言語ピッカー
extensions/voice/audio-tool.ts              キャプチャツールの検出（sox / ffmpeg / arecord）
extensions/voice/hold-to-talk.ts            長押し検出、Kitty と非 Kitty のターミナル
extensions/voice/release-controller.ts      録音ライフサイクル、離したときの処理

# speech-to-text
extensions/voice/deepgram.ts                Deepgram URL ビルダー、API キーリゾルバー
extensions/voice/local.ts                   モデルカタログ（21 モデル）、インプロセス文字起こし
extensions/voice/sherpa-engine.ts           sherpa-onnx バインディング — リコグナイザーのライフサイクル、推論
extensions/voice/sherpa-loader.ts           ネイティブモジュールの遅延読み込み
extensions/voice/model-download.ts          ダウンロード管理 — 再開、進捗、検証、Handy インポート
extensions/voice/device.ts                  デバイスプロファイリング — RAM、GPU、CPU、コンテナ検出

# text-to-speech
extensions/voice/speak.ts                   読み上げのエントリポイント、自動読み上げの配線
extensions/voice/tts-engine.ts              sherpa-onnx による TTS 合成
extensions/voice/tts-deepgram.ts            Deepgram Aura の音声（クラウド）
extensions/voice/tts-local-models.ts        ローカル TTS カタログ — 20 音声（Kitten、Kokoro、Piper）
extensions/voice/tts-playback.ts            再生、バッファリング、プレーヤー検出
extensions/voice/tts-text-filter.ts         コードブロックの除去、文の整形
extensions/voice/tts-onboarding.ts          TTS オンボーディングフロー
extensions/voice/tts-onboarding-overlay.ts  TTS オンボーディングのオーバーレイ
extensions/voice/tts-install-progress.ts    モデルインストール進捗ウィジェット
extensions/voice/tts-playback-indicator.ts  読み上げインジケーターウィジェット

# settings and UI
extensions/voice/settings-panel.ts          設定パネル — オーバーレイ、6 タブ
extensions/voice/ui-picker.ts               汎用リストピッカー
extensions/voice/ui-help-overlay.ts         キーボードとコマンドの早見表
extensions/voice/ui-aura.ts                 視覚プリミティブ（Liquid Braille、Aurora）
extensions/voice/ui-widget-base.ts          ウィジェットレジストリと基底クラス
extensions/voice/ui-render-ticker.ts        共有レンダーティッカー
extensions/voice/ui-icons.ts                グリフとアイコンセット
extensions/voice/ui-width.ts                CJK 対応の表示幅ヘルパー
extensions/voice/ui-locale-labels.ts        母語名と音声のラベル

# types
extensions/voice/sherpa-onnx-node.d.ts      オプションのネイティブモジュール用の型宣言
```

---

## 設定

設定は Pi の設定ファイル内の `voice` キーの下に保存されます：

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

シェルから渡した `DEEPGRAM_API_KEY` は実行時に使用され、`~/.pi/agent/settings.json` に
書き戻されることは**ありません**。オンボーディング中にキーを貼り付けた場合は明示的な
保存とみなされ、`~/.env.secrets` または `~/.zshrc` に書き込まれます。

長押しトークの遅延はデフォルトで **700 ms** です（`/voice-hold-delay` は 200–3000 ms を受け付けます）。

---

## トラブルシューティング

Pi 内で `/voice test` を実行すると総合的な診断ができます。

| 問題                                                    | 解決策                                                                                                                |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| "DEEPGRAM_API_KEY not set"                              | [キーを取得](https://dpgr.am/pi-voice) → `~/.zshrc` に `export DEEPGRAM_API_KEY="..."` を追記                          |
| "No audio capture tool found"                           | `brew install sox` または `brew install ffmpeg`                                                                       |
| リモートマイクが無音になる                              | PulseAudio/SSH 経由の音声 — Pi 側に ffmpeg をインストールしてください（設定時はキャプチャが ffmpeg を優先します）      |
| スペースキーで音声が起動しない                          | `/voice-settings` を実行 — 音声が無効になっている可能性があります                                                     |
| ローカルモデルが文字起こししない                        | `/voice-settings` → デバイスタブで sherpa-onnx の状態を確認                                                           |
| ダウンロードに失敗する                                  | 途中までのダウンロードは再試行時に自動で再開します。デバイスタブでディスク容量を確認してください。                    |
| macOS で `dyld: Library not loaded: libsimdjson` が出る | Homebrew の Node ABI 不一致 — `brew reinstall node` を実行するか、バージョン管理された Node（`mise`、`fnm`、`nvm`）に切り替えてください |

---

## セキュリティ

- **クラウド STT** — 音声は文字起こしのために Deepgram へ送信されます（Deepgram バックエンドのみ）
- **ローカル STT** — 音声がマシンの外部に出ることはありません（ローカルバックエンド）
- **テレメトリなし** — pi-voicekit は利用データを収集・送信しません
- **API キー** — 環境変数または Pi 設定に保存され、ログに記録されることはありません

脆弱性の報告については [SECURITY.md](../SECURITY.md) を参照してください。

---

## ライセンス

[MIT](../LICENSE) — 原作者 [@baanditeagle](https://x.com/baanditeagle)、現メンテナー [CyFeng16](https://github.com/CyFeng16)

---

## リンク

- **npm:** [npmjs.com/package/pi-voicekit](https://www.npmjs.com/package/pi-voicekit)
- **GitHub:** [github.com/CyFeng16/pi-voicekit](https://github.com/CyFeng16/pi-voicekit)
- **Deepgram:** [dpgr.am/pi-voice](https://dpgr.am/pi-voice)（$200 の無料クレジット）
- **Pi CLI:** [github.com/earendil-works/pi-coding-agent](https://github.com/earendil-works/pi-coding-agent)
