[English](../README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Português](README.pt-BR.md) | [हिन्दी](README.hi.md)

# pi-voicekit

> **Continuação comunitária do [`codexstar69/pi-listen`](https://github.com/codexstar69/pi-listen)** (upstream, MIT — dormente desde a v7.2.2, em maio de 2026).
> Sem vínculo com o autor original. Nome antigo: `pi-listen`.

<p align="center">
  <img src="../assets/brand/banner-en.png" alt="pi-voicekit — Entrada e saída de voz para o agente de programação Pi" width="100%" />
</p>

**Voz de entrada e voz de saída para o [Pi](https://github.com/earendil-works/pi-coding-agent).**
STT segure-para-falar — streaming do Deepgram (nuvem) ou 21 modelos offline — mais TTS que
fala as respostas do agente (Kitten, Kokoro, Piper ou Deepgram Aura).

[![npm version](https://img.shields.io/npm/v/pi-voicekit.svg)](https://www.npmjs.com/package/pi-voicekit)
[![license](https://img.shields.io/npm/l/pi-voicekit.svg)](https://github.com/CyFeng16/pi-voicekit/blob/main/LICENSE)
[![original author](https://img.shields.io/badge/original_author-@baanditeagle-1DA1F2?logo=x&logoColor=white)](https://x.com/baanditeagle)

> **v0.1.3 — versão atual** — a captura de áudio prefere o `ffmpeg` quando o
> `PULSE_SERVER` está definido (túnel de áudio SSH / PulseAudio remoto), então
> microfones remotos gravam de forma confiável. Voz de entrada **e** de saída: 21 modelos
> de STT offline, 20 vozes de TTS locais mais o Deepgram Aura, tudo controlado por um único
> painel `/voice-settings` com 6 abas. A linha 0.1.x está documentada no [changelog](../CHANGELOG.md).

---

## Veja como funciona

<p align="center">
  <video src="../assets/demo/pi-voicekit-demo.mp4" controls width="100%"></video>
  <br>
  <em>Vídeo de demonstração</em>
</p>

---

## Configuração (2 minutos)

### 1. Instalar a extensão

```bash
# Em um terminal normal (não dentro do Pi)
pi install npm:pi-voicekit
```

### 2. Escolha seu backend

O pi-voicekit suporta dois backends de transcrição:

|                   | Deepgram (nuvem)                                                 | Modelos locais (offline)                                         |
| ----------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------- |
| **Como funciona** | Streaming ao vivo — o texto aparece enquanto você fala           | Modo em lote — transcreve depois que você termina a gravação     |
| **Configuração**  | Chave de API necessária                                          | Sem chave de API, os modelos baixam automaticamente no 1º uso    |
| **Internet**      | Necessária                                                       | Não necessária depois de baixar o modelo                         |
| **Latência**      | Resultados intermediários em tempo real                          | 2–10 segundos após parar a gravação                              |
| **Idiomas**       | 56+ com streaming ao vivo                                        | Depende do modelo (1–57 idiomas)                                 |
| **Custo**         | $200 de crédito grátis (dura 6–12 meses para a maioria dos devs) | Grátis para sempre                                               |

Execute `/voice-settings` dentro do Pi para escolher seu backend e configurar tudo em um único painel.

#### Opção A: Deepgram (recomendado para streaming ao vivo)

Cadastre-se em [dpgr.am/pi-voice](https://dpgr.am/pi-voice) — $200 de crédito grátis, sem cartão.

```bash
export DEEPGRAM_API_KEY="your-key-here"    # adicione ao ~/.zshrc ou ao ~/.bashrc
```

#### Opção B: Modelos locais (totalmente offline)

Nenhuma configuração necessária — execute `/voice-settings`, mude o backend para Local e selecione um modelo. Ele baixa automaticamente.

> **Nota:** os modelos locais usam modo em lote — eles transcrevem depois que você termina a gravação, não enquanto você fala. Para streaming ao vivo enquanto fala, use o Deepgram.

### 3. Abra o Pi

Na primeira inicialização, o pi-voicekit verifica sua configuração e informa o que está pronto:

- Backend configurado (chave do Deepgram ou modelo local)
- Ferramenta de captura de áudio detectada (sox, ffmpeg ou arecord)
- Se tudo estiver certo, a voz é ativada imediatamente

### Captura de áudio

O pi-voicekit detecta sua ferramenta de áudio automaticamente. Não é preciso instalar nada manualmente se você já tem sox ou ffmpeg.

| Prioridade | Ferramenta      | Plataformas           | Instalação                                                   |
| ---------- | --------------- | --------------------- | ------------------------------------------------------------ |
| 1          | **SoX** (`rec`) | macOS, Linux, Windows | `brew install sox` / `apt install sox` / `choco install sox` |
| 2          | **ffmpeg**      | macOS, Linux, Windows | `brew install ffmpeg` / `apt install ffmpeg`                 |
| 3          | **arecord**     | Apenas Linux          | Pré-instalado (ALSA)                                         |

> Quando o `PULSE_SERVER` está definido (túnel de áudio SSH ou PulseAudio remoto), a ordem
> passa a ser **ffmpeg → sox → arecord** — fontes Pulse de rede precisam do ffmpeg.

---

## Painel de configurações

Toda a configuração fica em um só lugar: `/voice-settings`. Seis abas cobrem tudo o que você precisa.

### Geral — backend, idioma, escopo

<img src="../assets/screenshots/settings-general.png" alt="Configurações gerais — backend, modelo, idioma, escopo, alternância de voz" width="600" />

Alterne entre Deepgram (nuvem, streaming ao vivo) e Local (offline, modo em lote). Mude o idioma, o escopo e ative/desative a voz — tudo com atalhos de teclado.

### Modelos — navegar, buscar, instalar

<img src="../assets/screenshots/settings-models.png" alt="Aba Modelos — navegue por 21 modelos com avaliações de precisão/velocidade" width="600" />

Navegue por 21 modelos de Parakeet, Whisper, Moonshine, SenseVoice, GigaAM, Paraformer e Qwen3. Cada modelo mostra avaliações de precisão e velocidade (●●●●○/●●●●○), selos de aptidão e status de download. Busca difusa para encontrar modelos rápido. Pressione Enter para ativar e baixar.

### Baixados — gerenciar os modelos instalados

<img src="../assets/screenshots/settings-downloaded.png" alt="Aba Baixados — gerencie os modelos instalados, ativar ou excluir" width="600" />

Veja o que está instalado, o uso total de disco e qual modelo está ativo. Pressione Enter para ativar, `x` para excluir. Modelos do [Handy](https://github.com/cjpais/handy) são detectados automaticamente e podem ser importados sem baixar de novo.

### Fala — modelos e vozes de TTS

Escolha um backend de TTS (sherpa-onnx local ou Deepgram Aura), navegue por 20 vozes
locais a partir de ~13 MB, baixe ao selecionar e escolha uma voz por backend. A fala
automática das respostas do agente é ativada aqui.

### Dispositivo — perfil de hardware e dependências

<img src="../assets/screenshots/settings-device.png" alt="Aba Dispositivo — perfil de hardware, dependências, espaço em disco" width="600" />

Veja o perfil do seu hardware (RAM, CPU, GPU), o status das dependências (runtime sherpa-onnx), o espaço em disco disponível e o total de modelos baixados. As recomendações de modelos se baseiam nesse perfil.

---

## Uso

### Atalhos de teclado

| Ação                  | Tecla                   | Notas                                                                                    |
| --------------------- | ----------------------- | ---------------------------------------------------------------------------------------- |
| **Gravar no editor**  | Segure `SPACE` (≥0.7s)  | Solte para finalizar. Pré-grava durante o aquecimento para você não perder palavras.     |
| **Alternar gravação** | `Ctrl+Shift+V`          | Funciona em todos os terminais — pressione para iniciar, pressione de novo para parar.   |
| **Limpar editor**     | `Escape` × 2            | Toque duplo em até 500ms para limpar todo o texto.                                       |

### Como a gravação funciona

1. **Segure SPACE** — a contagem regressiva de aquecimento aparece e a captura de áudio começa na hora (pré-gravação)
2. **Continue segurando** — a transcrição ao vivo é enviada ao editor (Deepgram) ou o áudio vai para um buffer (local)
3. **Solte SPACE** — a gravação continua por 1.5s (gravação de cauda) para pegar sua última palavra e então finaliza
4. O texto aparece no editor, pronto para enviar

### Comandos

| Comando                  | Descrição                                                               |
| ------------------------ | ----------------------------------------------------------------------- |
| `/voice-settings`        | Painel de configurações — backend, modelos, idioma, escopo, dispositivo |
| `/voice-models`          | Painel de configurações (aba Modelos)                                   |
| `/voice-setup`           | Executa o assistente de configuração da primeira execução               |
| `/voice-language`        | Abre o painel de configurações para mudar o idioma                      |
| `/voice-speak <text>`    | Fala um texto em voz alta (TTS)                                         |
| `/voice-speak-test`      | Fala uma frase de exemplo                                               |
| `/voice-speak-toggle`    | Ativa / desativa o TTS                                                  |
| `/voice-stream`          | Alterna o TTS em streaming do Deepgram (nuvem)                          |
| `/voice-speak-stop`      | Para a reprodução de TTS em andamento                                   |
| `/voice-autosubmit`      | Alterna: texto do STT enviado automaticamente ao agente (`on`/`off`)    |
| `/voice-hold-delay`      | Define o atraso do segure-para-falar (200-3000 ms, padrão 700)          |
| `/voice-speak-models`    | Navega / instala modelos de voz de TTS                                   |
| `/voice-speak-info`      | Diagnostica o estado do TTS                                             |
| `/voice-help`            | Referência de teclado + comandos (ou pressione `F1`)                    |
| `/voice test`            | Diagnóstico completo — ferramenta de áudio, microfone, chave de API     |
| `/voice on` / `off`      | Ativa ou desativa a voz                                                 |
| `/voice dictate`         | Ditado contínuo (sem segurar tecla)                                     |
| `/voice stop`            | Para a gravação ou o ditado em andamento                                |
| `/voice history`         | Transcrições recentes                                                   |
| `/voice`                 | Liga/desliga                                                            |

### Teclado da v7.1

Enquanto estiver no painel de configurações:

| Tecla  | Ação                                         |
| ------ | -------------------------------------------- |
| `← →`  | trocar de aba                                |
| `↑ ↓`  | navegar pelas linhas (pula os títulos de grupo) |
| `↵`    | selecionar / ativar                          |
| `esc`  | voltar ao principal / fechar o painel        |
| `type` | filtrar (buscar)                             |
| `bksp` | apagar o último caractere da busca           |

Enquanto um widget de instalação ou indicador de reprodução estiver montado (sem
overlay na frente):

| Tecla | Ação                                                          |
| ----- | ------------------------------------------------------------- |
| `esc` | cancelar a instalação em andamento (a mais recente primeiro) e depois parar a reprodução |
| `F1`  | abrir o overlay de ajuda (sempre disponível)                  |

---

## Modelos locais

21 modelos em 7 famílias. Ordenados por qualidade — os melhores primeiro.

### Melhores escolhas

| Modelo              | Precisão | Velocidade | Tamanho | Idiomas                  | Notas                         |
| ------------------- | -------- | ---------- | ------- | ------------------------ | ----------------------------- |
| **Parakeet TDT v3** | ●●●●○    | ●●●●○      | 671 MB  | 25 (detecção automática) | Melhor no geral. WER 6.3%.    |
| **Parakeet TDT v2** | ●●●●●    | ●●●●○      | 661 MB  | Inglês                   | Melhor em inglês. WER 6.0%.   |
| **Whisper Turbo**   | ●●●●○    | ●●○○○      | 1.0 GB  | 57                       | Maior suporte a idiomas.      |

### Rápidos e leves

| Modelo                | Precisão | Velocidade | Tamanho | Idiomas         | Notas                                          |
| --------------------- | -------- | ---------- | ------- | --------------- | ---------------------------------------------- |
| **Moonshine v2 Tiny** | ●●○○○    | ●●●●●      | 43 MB   | Inglês          | 34ms de latência. Amigável para Raspberry Pi.  |
| **Moonshine Base**    | ●●●○○    | ●●●●●      | 287 MB  | Inglês          | Lida bem com sotaques.                         |
| **SenseVoice Small**  | ●●●○○    | ●●●●●      | 228 MB  | zh/en/ja/ko/yue | Melhor para idiomas CJK.                       |

### Especialistas

| Modelo               | Precisão | Velocidade | Tamanho | Idiomas | Notas                                    |
| -------------------- | -------- | ---------- | ------- | ------- | ---------------------------------------- |
| **GigaAM v3**        | ●●●●○    | ●●●●○      | 225 MB  | Russo   | WER 50% menor que o Whisper em russo.    |
| **Whisper Medium**   | ●●●●○    | ●●●○○      | 946 MB  | 57      | Boa precisão, velocidade média.          |
| **Whisper Large v3** | ●●●●○    | ●○○○○      | 1.8 GB  | 57      | Maior precisão do Whisper. Lento na CPU. |

Além disso, 8 variantes do Moonshine v2 especializadas por idioma para japonês, coreano, árabe, chinês, ucraniano, vietnamita e espanhol.

### Como os modelos locais funcionam

```
Segure SPACE → áudio capturado no buffer de memória
                 ↓
Solte SPACE → buffer enviado ao sherpa-onnx (em processo)
                 ↓
         Inferência ONNX na CPU (2–10 segundos)
                 ↓
         Transcrição final inserida no editor
```

Os modelos baixam automaticamente no primeiro uso. Os downloads são retomáveis, verificados após a conclusão e deduplicados (sem downloads duplicados). O painel de configurações mostra o progresso do download em tempo real, com velocidade e ETA.

Modelos do [Handy](https://github.com/cjpais/handy) (`~/Library/Application Support/com.pais.handy/models/`) são detectados automaticamente e podem ser importados por link simbólico (zero duplicação de disco).

---

## Funcionalidades

| Funcionalidade                                | Descrição                                                                                     |
| --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **Backend duplo**                             | Deepgram (nuvem, streaming ao vivo) ou modelos locais (offline, em lote) — alterne nas configurações |
| **21 modelos locais**                         | Parakeet, Whisper, Moonshine, SenseVoice, GigaAM, Paraformer, Qwen3 — com avaliações de precisão/velocidade |
| **Painel de configurações unificado**         | Um único painel overlay para toda a configuração — `/voice-settings`                          |
| **Recomendações por dispositivo**             | Pontua os modelos de acordo com o seu hardware. Só os melhores da categoria recebem [recommended]. |
| **Pipeline de download de nível empresarial** | Pré-verificações (disco, rede, permissões), progresso ao vivo com velocidade/ETA, verificação pós-download |
| **Integração com o Handy**                    | Detecta automaticamente os modelos do app Handy e os importa por link simbólico               |
| **Cadeia de fallback de áudio**               | Tenta sox → ffmpeg → arecord nessa ordem — ffmpeg primeiro quando o `PULSE_SERVER` está definido |
| **Pré-gravação**                              | A captura de áudio começa durante o aquecimento — você nunca perde a primeira palavra         |
| **Gravação de cauda**                         | Continua gravando 1.5s após soltar para que sua última palavra não seja cortada                |
| **Streaming ao vivo**                         | Deepgram Nova 3 WebSocket (Nova 2 para idiomas chineses) — transcrições intermediárias ao vivo |
| **56+ idiomas**                               | Deepgram: 56+ com streaming ao vivo. Local: até 57 dependendo do modelo.                      |
| **Ditado contínuo**                           | `/voice dictate` para entrada de texto longa sem segurar teclas                                |
| **Cooldown de digitação**                     | Pressões da barra de espaço em até 400ms após digitar são ignoradas                           |
| **Feedback sonoro**                           | Sons do sistema do macOS para eventos de início, parada e erro                                |
| **Multiplataforma**                           | macOS, Windows, Linux — protocolo Kitty + fallback sem Kitty                                   |

---

## Arquitetura

```
# core
extensions/voice.ts                         Extensão principal — máquina de estados, gravação, UI, superfície de comandos
extensions/voice/config.ts                  Carregamento, salvamento e migração da configuração
extensions/voice/onboarding.ts              Assistente de primeira execução, seletor de idioma
extensions/voice/audio-tool.ts              Detecção da ferramenta de captura (sox / ffmpeg / arecord)
extensions/voice/hold-to-talk.ts            Detecção do segurar, terminais Kitty e não-Kitty
extensions/voice/release-controller.ts      Ciclo de vida da gravação, tratamento da soltura

# speech-to-text
extensions/voice/deepgram.ts                Construtor de URL do Deepgram, resolvedor de chave de API
extensions/voice/local.ts                   Catálogo de modelos (21 modelos), transcrição em processo
extensions/voice/sherpa-engine.ts           Bindings do sherpa-onnx — ciclo de vida do reconhecedor, inferência
extensions/voice/sherpa-loader.ts           Carregamento tardio (lazy) do módulo nativo
extensions/voice/model-download.ts          Gerenciador de downloads — retomada, progresso, verificação, importação do Handy
extensions/voice/device.ts                  Perfil do dispositivo — RAM, GPU, CPU, detecção de contêiner

# text-to-speech
extensions/voice/speak.ts                   Ponto de entrada da fala, integração da fala automática
extensions/voice/tts-engine.ts              Síntese de TTS do sherpa-onnx
extensions/voice/tts-deepgram.ts            Vozes do Deepgram Aura (nuvem)
extensions/voice/tts-local-models.ts        Catálogo de TTS local — 20 vozes (Kitten, Kokoro, Piper)
extensions/voice/tts-playback.ts            Reprodução, buffering, detecção de player
extensions/voice/tts-text-filter.ts         Remoção de blocos de código, preparação de frases
extensions/voice/tts-onboarding.ts          Fluxo de onboarding do TTS
extensions/voice/tts-onboarding-overlay.ts  Overlay de onboarding do TTS
extensions/voice/tts-install-progress.ts    Widget de progresso da instalação de modelos
extensions/voice/tts-playback-indicator.ts  Widget indicador de fala

# settings and UI
extensions/voice/settings-panel.ts          Painel de configurações — overlay, 6 abas
extensions/voice/ui-picker.ts               Seletor de lista genérico
extensions/voice/ui-help-overlay.ts         Referência de teclado e comandos
extensions/voice/ui-aura.ts                 Primitivas visuais (Liquid Braille, Aurora)
extensions/voice/ui-widget-base.ts          Registro de widgets e classe base
extensions/voice/ui-render-ticker.ts        Ticker de renderização compartilhado
extensions/voice/ui-icons.ts                Conjunto de glifos e ícones
extensions/voice/ui-width.ts                Utilitários de largura visual com suporte a CJK
extensions/voice/ui-locale-labels.ts        Rótulos nativos de idioma e de voz

# types
extensions/voice/sherpa-onnx-node.d.ts      Declarações de tipo para o módulo nativo opcional
```

---

## Configuração

As configurações ficam nos arquivos de configuração do Pi, sob a chave `voice`:

| Escopo  | Caminho                       |
| ------- | ----------------------------- |
| Global  | `~/.pi/agent/settings.json`   |
| Projeto | `<project>/.pi/settings.json` |

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

O `DEEPGRAM_API_KEY` do seu shell é usado em tempo de execução e não é copiado de volta
para `~/.pi/agent/settings.json`. Se você colar uma chave durante o onboarding, isso é
um salvamento explícito e ela ainda vai para `~/.env.secrets` ou `~/.zshrc`.

O atraso do segure-para-falar é **700 ms** por padrão (`/voice-hold-delay` aceita 200–3000 ms).

---

## Solução de problemas

Execute `/voice test` dentro do Pi para um diagnóstico completo.

| Problema                                         | Solução                                                                                                         |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| "DEEPGRAM_API_KEY not set"                       | [Obtenha uma chave](https://dpgr.am/pi-voice) → `export DEEPGRAM_API_KEY="..."` no `~/.zshrc`                   |
| "No audio capture tool found"                    | `brew install sox` ou `brew install ffmpeg`                                                                     |
| Microfone remoto grava silêncio                  | Áudio via PulseAudio/SSH — instale o ffmpeg no lado do Pi (a captura passa a preferir o ffmpeg)                  |
| A barra de espaço não ativa a voz                | Execute `/voice-settings` — a voz pode estar desativada                                                         |
| Modelo local não transcreve                      | Verifique `/voice-settings` → aba Dispositivo para o status do sherpa-onnx                                      |
| Falha no download                                | Downloads parciais são retomados automaticamente na nova tentativa. Verifique o espaço em disco na aba Dispositivo. |
| `dyld: Library not loaded: libsimdjson` no macOS | Incompatibilidade de ABI do Node do Homebrew — execute `brew reinstall node` ou mude para um Node gerenciado por versão (`mise`, `fnm`, `nvm`) |

---

## Segurança

- **STT na nuvem** — o áudio é enviado ao Deepgram para transcrição (apenas no backend Deepgram)
- **STT local** — o áudio nunca sai da sua máquina (backend local)
- **Sem telemetria** — o pi-voicekit não coleta nem transmite dados de uso
- **Chave de API** — armazenada em variável de ambiente ou nas configurações do Pi, nunca registrada em log

Consulte [SECURITY.md](../SECURITY.md) para reportar vulnerabilidades.

---

## Licença

[MIT](../LICENSE) — original de [@baanditeagle](https://x.com/baanditeagle), mantido por [CyFeng16](https://github.com/CyFeng16)

---

## Links

- **npm:** [npmjs.com/package/pi-voicekit](https://www.npmjs.com/package/pi-voicekit)
- **GitHub:** [github.com/CyFeng16/pi-voicekit](https://github.com/CyFeng16/pi-voicekit)
- **Deepgram:** [dpgr.am/pi-voice](https://dpgr.am/pi-voice) ($200 de crédito grátis)
- **Pi CLI:** [github.com/earendil-works/pi-coding-agent](https://github.com/earendil-works/pi-coding-agent)
