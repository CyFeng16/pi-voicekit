[English](../README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Português](README.pt-BR.md) | [हिन्दी](README.hi.md)

# pi-listen

<p align="center">
  <img src="../assets/banner.png" alt="pi-listen — Entrada de voz para o agente de programação Pi" width="100%" />
</p>

**Entrada de voz segure-para-falar para o [Pi](https://github.com/earendil-works/pi-coding-agent).** Streaming na nuvem via Deepgram ou totalmente offline com modelos locais.

[![npm version](https://img.shields.io/npm/v/pi-voicekit.svg)](https://www.npmjs.com/package/pi-voicekit)
[![license](https://img.shields.io/npm/l/pi-voicekit.svg)](https://github.com/CyFeng16/pi-voicekit/blob/main/LICENSE)
[![author](https://img.shields.io/badge/author-@baanditeagle-1DA1F2?logo=x&logoColor=white)](https://x.com/baanditeagle)

> **v5.0.1 — Correção de segurança** — Chaves de API não vazam mais para a configuração do projeto. O áudio do microfone não pode ser redirecionado para servidores remotos por configurações maliciosas de repositório. Injeção de shell corrigida no processo de integração de chaves de API. Escritas de configuração agora são atômicas. [Changelog completo →](../CHANGELOG.md)

---

## Veja como funciona

<video src="../assets/pi-listen.mp4" controls width="100%"></video>

---

## Configuração (2 minutos)

### 1. Instalar a extensão

```bash
# Em um terminal normal (não dentro do Pi)
pi install npm:pi-voicekit
```

### 2. Escolha seu backend

O pi-listen suporta dois backends de transcrição:

|                   | Deepgram (nuvem)                                                 | Modelos locais (offline)                                         |
| ----------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------- |
| **Como funciona** | Streaming ao vivo — o texto aparece enquanto você fala           | Modo em lote — transcreve após terminar a gravação               |
| **Configuração**  | Chave de API necessária                                          | Sem chave de API, modelos baixam automaticamente no primeiro uso |
| **Internet**      | Necessária                                                       | Não necessária após o download do modelo                         |
| **Latência**      | Resultados intermediários em tempo real                          | 2–10 segundos após parar a gravação                              |
| **Idiomas**       | 56+ com streaming ao vivo                                        | Depende do modelo (1–57 idiomas)                                 |
| **Custo**         | $200 de crédito grátis (dura 6–12 meses para a maioria dos devs) | Grátis para sempre                                               |

Execute `/voice-settings` dentro do Pi para escolher seu backend e configurar tudo em um único painel.

#### Opção A: Deepgram (recomendado para streaming ao vivo)

Cadastre-se em [dpgr.am/pi-voice](https://dpgr.am/pi-voice) — $200 de crédito grátis, sem cartão necessário.

```bash
export DEEPGRAM_API_KEY="your-key-here"    # adicione ao ~/.zshrc ou ~/.bashrc
```

#### Opção B: Modelos locais (totalmente offline)

Nenhuma configuração necessária — execute `/voice-settings`, mude o backend para Local e selecione um modelo. Ele é baixado automaticamente.

> **Nota:** Modelos locais usam modo em lote — transcrevem após terminar a gravação, não enquanto você fala. Para streaming ao vivo enquanto fala, use o Deepgram.

### 3. Abra o Pi

Na primeira execução, o pi-listen verifica sua configuração e informa o que está pronto:

- Backend configurado (chave Deepgram ou modelo local)
- Ferramenta de captura de áudio detectada (sox, ffmpeg ou arecord)
- Se tudo estiver certo, a voz é ativada imediatamente

### Captura de áudio

O pi-listen detecta automaticamente sua ferramenta de áudio. Não é necessária instalação manual se você já tem sox ou ffmpeg.

| Prioridade | Ferramenta      | Plataformas           | Instalação                                                   |
| ---------- | --------------- | --------------------- | ------------------------------------------------------------ |
| 1          | **SoX** (`rec`) | macOS, Linux, Windows | `brew install sox` / `apt install sox` / `choco install sox` |
| 2          | **ffmpeg**      | macOS, Linux, Windows | `brew install ffmpeg` / `apt install ffmpeg`                 |
| 3          | **arecord**     | Apenas Linux          | Pré-instalado (ALSA)                                         |

---

## Painel de configurações

Toda a configuração em um só lugar: `/voice-settings`. Quatro abas cobrem tudo o que você precisa.

### Geral — backend, idioma, escopo

<img src="../assets/settings-general.png" alt="Configurações gerais — backend, modelo, idioma, escopo, ativar/desativar voz" width="600" />

Alterne entre Deepgram (nuvem, streaming ao vivo) e Local (offline, modo em lote). Mude idioma, escopo e ative/desative a voz — tudo com atalhos de teclado.

### Modelos — navegar, buscar, instalar

<img src="../assets/settings-models.png" alt="Aba Modelos — navegar por 21 modelos com avaliações de precisão/velocidade" width="600" />

Navegue por 21 modelos de Parakeet, Whisper, Moonshine, SenseVoice, GigaAM, Paraformer e Qwen3. Cada modelo mostra avaliações de precisão e velocidade (●●●●○/●●●●○), selos de aptidão e status de download. Busca fuzzy para encontrar modelos rapidamente. Pressione Enter para ativar e baixar.

### Baixados — gerenciar modelos instalados

<img src="../assets/settings-downloaded.png" alt="Aba Baixados — gerenciar modelos instalados, ativar ou excluir" width="600" />

Veja o que está instalado, uso total de disco e qual modelo está ativo. Pressione Enter para ativar, `x` para excluir. Modelos do [Handy](https://github.com/cjpais/handy) são detectados automaticamente e podem ser importados sem baixar novamente.

### Dispositivo — perfil de hardware e dependências

<img src="../assets/settings-device.png" alt="Aba Dispositivo — perfil de hardware, dependências, espaço em disco" width="600" />

Veja seu perfil de hardware (RAM, CPU, GPU), status das dependências (runtime sherpa-onnx), espaço em disco disponível e total de modelos baixados. As recomendações de modelos são baseadas neste perfil.

---

## Uso

### Atalhos de teclado

| Ação                  | Tecla                   | Notas                                                                                    |
| --------------------- | ----------------------- | ---------------------------------------------------------------------------------------- |
| **Gravar no editor**  | Segurar `SPACE` (≥1,2s) | Solte para finalizar. Pré-grava durante o aquecimento para não perder palavras.          |
| **Alternar gravação** | `Ctrl+Shift+V`          | Funciona em todos os terminais — pressione para iniciar, pressione novamente para parar. |
| **Limpar editor**     | `Escape` × 2            | Toque duplo em 500ms para limpar todo o texto.                                           |

### Como a gravação funciona

1. **Segure SPACE** — contagem regressiva de aquecimento aparece, captura de áudio inicia imediatamente (pré-gravação)
2. **Continue segurando** — transcrição ao vivo é transmitida para o editor (Deepgram) ou o áudio é armazenado em buffer (local)
3. **Solte SPACE** — gravação continua por 1,5s (gravação de cauda) para capturar sua última palavra, depois finaliza
4. O texto aparece no editor, pronto para enviar

### Comandos

| Comando             | Descrição                                                               |
| ------------------- | ----------------------------------------------------------------------- |
| `/voice-settings`   | Painel de configurações — backend, modelos, idioma, escopo, dispositivo |
| `/voice-models`     | Painel de configurações (aba Modelos)                                   |
| `/voice test`       | Diagnóstico completo — ferramenta de áudio, microfone, chave de API     |
| `/voice on` / `off` | Ativar ou desativar voz                                                 |
| `/voice dictate`    | Ditado contínuo (sem segurar teclas)                                    |
| `/voice stop`       | Parar gravação ativa ou ditado                                          |
| `/voice history`    | Transcrições recentes                                                   |
| `/voice`            | Alternar ligado/desligado                                               |

---

## Modelos locais

21 modelos em 7 famílias. Ordenados por qualidade — melhores modelos primeiro.

### Melhores escolhas

| Modelo              | Precisão | Velocidade | Tamanho | Idiomas                  | Notas                         |
| ------------------- | -------- | ---------- | ------- | ------------------------ | ----------------------------- |
| **Parakeet TDT v3** | ●●●●○    | ●●●●○      | 671 MB  | 25 (detecção automática) | Melhor no geral. WER 6,3%.    |
| **Parakeet TDT v2** | ●●●●●    | ●●●●○      | 661 MB  | Inglês                   | Melhor para inglês. WER 6,0%. |
| **Whisper Turbo**   | ●●●●○    | ●●○○○      | 1,0 GB  | 57                       | Maior suporte de idiomas.     |

### Rápidos e leves

| Modelo                | Precisão | Velocidade | Tamanho | Idiomas         | Notas                                          |
| --------------------- | -------- | ---------- | ------- | --------------- | ---------------------------------------------- |
| **Moonshine v2 Tiny** | ●●○○○    | ●●●●●      | 43 MB   | Inglês          | 34ms de latência. Compatível com Raspberry Pi. |
| **Moonshine Base**    | ●●●○○    | ●●●●●      | 287 MB  | Inglês          | Lida bem com sotaques.                         |
| **SenseVoice Small**  | ●●●○○    | ●●●●●      | 228 MB  | zh/en/ja/ko/yue | Melhor para idiomas CJK.                       |

### Especialistas

| Modelo               | Precisão | Velocidade | Tamanho | Idiomas | Notas                                    |
| -------------------- | -------- | ---------- | ------- | ------- | ---------------------------------------- |
| **GigaAM v3**        | ●●●●○    | ●●●●○      | 225 MB  | Russo   | WER 50% menor que o Whisper em russo.    |
| **Whisper Medium**   | ●●●●○    | ●●●○○      | 946 MB  | 57      | Boa precisão, velocidade média.          |
| **Whisper Large v3** | ●●●●○    | ●○○○○      | 1,8 GB  | 57      | Maior precisão do Whisper. Lento na CPU. |

Mais 8 variantes Moonshine v2 especializadas por idioma para japonês, coreano, árabe, chinês, ucraniano, vietnamita e espanhol.

### Como os modelos locais funcionam

```
Segure SPACE → áudio capturado no buffer de memória
                 ↓
Solte SPACE → buffer enviado para sherpa-onnx (em processo)
                 ↓
          Inferência ONNX na CPU (2–10 segundos)
                 ↓
          Transcrição final inserida no editor
```

Os modelos são baixados automaticamente no primeiro uso. Downloads são resumíveis, verificados após a conclusão e deduplicados (sem downloads duplos). O painel de configurações mostra progresso de download em tempo real com velocidade e tempo estimado.

Modelos do [Handy](https://github.com/cjpais/handy) (`~/Library/Application Support/com.pais.handy/models/`) são detectados automaticamente e podem ser importados via link simbólico (zero duplicação de disco).

---

## Funcionalidades

| Funcionalidade                        | Descrição                                                                                                  |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Backend duplo**                     | Deepgram (nuvem, streaming ao vivo) ou modelos locais (offline, em lote) — alterne nas configurações       |
| **21 modelos locais**                 | Parakeet, Whisper, Moonshine, SenseVoice, GigaAM, Paraformer, Qwen3 — com avaliações de precisão/velocidade                   |
| **Painel de configurações unificado** | Um painel overlay para toda a configuração — `/voice-settings`                                             |
| **Recomendações por dispositivo**     | Avalia modelos de acordo com seu hardware. Apenas os melhores da categoria recebem [recommended].          |
| **Pipeline de download empresarial**  | Pré-verificações (disco, rede, permissões), progresso ao vivo com velocidade/ETA, verificação pós-download |
| **Integração com Handy**              | Detecta automaticamente modelos do app Handy, importa via link simbólico                                   |
| **Cadeia de fallback de áudio**       | Tenta sox, ffmpeg, arecord em ordem                                                                        |
| **Pré-gravação**                      | Captura de áudio começa durante o aquecimento — você nunca perde a primeira palavra                        |
| **Gravação de cauda**                 | Continua gravando 1,5s após soltar para que sua última palavra não seja cortada                            |
| **Streaming ao vivo**                 | Deepgram Nova 3 WebSocket — transcrições intermediárias enquanto você fala                                 |
| **56+ idiomas**                       | Deepgram: 56+ com streaming ao vivo. Local: até 57 dependendo do modelo.                                   |
| **Ditado contínuo**                   | `/voice dictate` para entrada de texto longo sem segurar teclas                                            |
| **Cooldown de digitação**             | Pressões de espaço dentro de 400ms após digitar são ignoradas                                              |
| **Feedback sonoro**                   | Sons do sistema macOS para eventos de início, parada e erro                                                |
| **Multiplataforma**                   | macOS, Windows, Linux — protocolo Kitty + fallback não-Kitty                                               |

---

## Arquitetura

```
extensions/voice.ts                Extensão principal — máquina de estados, gravação, UI, painel de configurações
extensions/voice/config.ts         Carregamento, salvamento e migração de configuração
extensions/voice/onboarding.ts     Assistente de primeira execução, seletor de idioma
extensions/voice/deepgram.ts       Construtor de URL Deepgram, resolvedor de chave de API
extensions/voice/local.ts          Catálogo de modelos (21 modelos), transcrição em processo
extensions/voice/device.ts         Perfil do dispositivo — RAM, GPU, CPU, detecção de contêiner
extensions/voice/model-download.ts Gerenciador de downloads — retomada, progresso, verificação, import do Handy
extensions/voice/sherpa-engine.ts   Bindings sherpa-onnx — ciclo de vida do reconhecedor, inferência
extensions/voice/settings-panel.ts  Painel de configurações — interface Component, overlay, 4 abas
```

---

## Configuração

As configurações são armazenadas nos arquivos de configuração do Pi sob a chave `voice`:

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

---

## Solução de problemas

Execute `/voice test` dentro do Pi para um diagnóstico completo.

| Problema                      | Solução                                                                                                           |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| "DEEPGRAM_API_KEY not set"    | [Obtenha uma chave](https://dpgr.am/pi-voice) → `export DEEPGRAM_API_KEY="..."` no `~/.zshrc`                     |
| "No audio capture tool found" | `brew install sox` ou `brew install ffmpeg`                                                                       |
| Espaço não ativa a voz        | Execute `/voice-settings` — a voz pode estar desativada                                                           |
| Modelo local não transcreve   | Verifique `/voice-settings` → aba Dispositivo para o status do sherpa-onnx                                        |
| Download falhou               | Downloads parciais são retomados automaticamente na nova tentativa. Verifique espaço em disco na aba Dispositivo. |

---

## Segurança

- **STT na nuvem** — o áudio é enviado ao Deepgram para transcrição (apenas backend Deepgram)
- **STT local** — o áudio nunca sai da sua máquina (backend local)
- **Sem telemetria** — o pi-listen não coleta nem transmite dados de uso
- **Chave de API** — armazenada em variável de ambiente ou configurações do Pi, nunca registrada em logs

Consulte [SECURITY.md](../SECURITY.md) para reportar vulnerabilidades.

---

## Licença

[MIT](../LICENSE) © 2026 codexstar69

---

## Links

- **npm:** [npmjs.com/package/pi-voicekit](https://www.npmjs.com/package/pi-voicekit)
- **GitHub:** [github.com/CyFeng16/pi-voicekit](https://github.com/CyFeng16/pi-voicekit)
- **Deepgram:** [dpgr.am/pi-voice](https://dpgr.am/pi-voice) ($200 de crédito grátis)
- **Pi CLI:** [github.com/earendil-works/pi-coding-agent](https://github.com/earendil-works/pi-coding-agent)
