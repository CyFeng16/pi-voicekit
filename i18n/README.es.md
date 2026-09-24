[English](../README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Português](README.pt-BR.md) | [हिन्दी](README.hi.md)

# pi-listen

<p align="center">
  <img src="assets/banner.png" alt="pi-listen — Entrada de voz para el agente de programación Pi" width="100%" />
</p>

**Entrada de voz mantener-para-hablar para [Pi](https://github.com/earendil-works/pi-coding-agent).** Streaming en la nube con Deepgram o completamente offline con modelos locales.

[![npm version](https://img.shields.io/npm/v/pi-listen-ng.svg)](https://www.npmjs.com/package/pi-listen-ng)
[![license](https://img.shields.io/npm/l/pi-listen-ng.svg)](https://github.com/CyFeng16/pi-listen-ng/blob/main/LICENSE)
[![author](https://img.shields.io/badge/author-@baanditeagle-1DA1F2?logo=x&logoColor=white)](https://x.com/baanditeagle)

> **v5.0.1 — Parche de seguridad** — Las claves API ya no se filtran a la configuración del proyecto. El audio del micrófono no puede ser redirigido a servidores remotos mediante configuraciones maliciosas del repositorio. Se corrigió la inyección de shell en el proceso de incorporación de claves API. Las escrituras de configuración ahora son atómicas. [Registro de cambios completo →](CHANGELOG.md)

---

## Mira cómo funciona

<video src="assets/pi-listen.mp4" controls width="100%"></video>

---

## Configuración (2 minutos)

### 1. Instalar la extensión

```bash
# En una terminal normal (no dentro de Pi)
pi install npm:pi-listen-ng
```

### 2. Elige tu backend

pi-listen soporta dos backends de transcripción:

|                   | Deepgram (nube)                                                               | Modelos locales (offline)                                                |
| ----------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **Cómo funciona** | Streaming en vivo — el texto aparece mientras hablas                          | Modo por lotes — transcribe después de terminar la grabación             |
| **Configuración** | Se requiere clave API                                                         | Sin clave API, los modelos se descargan automáticamente en el primer uso |
| **Internet**      | Necesario                                                                     | No necesario después de descargar el modelo                              |
| **Latencia**      | Resultados intermedios en tiempo real                                         | 2–10 segundos después de detener la grabación                            |
| **Idiomas**       | 56+ con streaming en vivo                                                     | Depende del modelo (1–57 idiomas)                                        |
| **Costo**         | $200 de crédito gratuito (dura 6–12 meses para la mayoría de desarrolladores) | Gratis para siempre                                                      |

Ejecuta `/voice-settings` dentro de Pi para elegir tu backend y configurar todo desde un solo panel.

#### Opción A: Deepgram (recomendado para streaming en vivo)

Regístrate en [dpgr.am/pi-voice](https://dpgr.am/pi-voice) — $200 de crédito gratuito, sin tarjeta requerida.

```bash
export DEEPGRAM_API_KEY="your-key-here"    # agregar a ~/.zshrc o ~/.bashrc
```

#### Opción B: Modelos locales (completamente offline)

No se necesita configuración — ejecuta `/voice-settings`, cambia el backend a Local y selecciona un modelo. Se descarga automáticamente.

> **Nota:** Los modelos locales usan modo por lotes — transcriben después de terminar la grabación, no mientras hablas. Para streaming en vivo mientras hablas, usa Deepgram.

### 3. Abre Pi

En el primer inicio, pi-listen verifica tu configuración y te dice qué está listo:

- Backend configurado (clave de Deepgram o modelo local)
- Herramienta de captura de audio detectada (sox, ffmpeg o arecord)
- Si todo está en orden, la voz se activa inmediatamente

### Captura de audio

pi-listen detecta automáticamente tu herramienta de audio. No se necesita instalación manual si ya tienes sox o ffmpeg.

| Prioridad | Herramienta     | Plataformas           | Instalación                                                  |
| --------- | --------------- | --------------------- | ------------------------------------------------------------ |
| 1         | **SoX** (`rec`) | macOS, Linux, Windows | `brew install sox` / `apt install sox` / `choco install sox` |
| 2         | **ffmpeg**      | macOS, Linux, Windows | `brew install ffmpeg` / `apt install ffmpeg`                 |
| 3         | **arecord**     | Solo Linux            | Preinstalado (ALSA)                                          |

---

## Panel de configuración

Toda la configuración en un solo lugar: `/voice-settings`. Cuatro pestañas cubren todo lo que necesitas.

### General — backend, idioma, alcance

<img src="assets/settings-general.png" alt="Configuración general — backend, modelo, idioma, alcance, activar/desactivar voz" width="600" />

Alterna entre Deepgram (nube, streaming en vivo) y Local (offline, modo por lotes). Cambia idioma, alcance y activa/desactiva la voz — todo con atajos de teclado.

### Modelos — explorar, buscar, instalar

<img src="assets/settings-models.png" alt="Pestaña de modelos — explorar 19 modelos con calificaciones de precisión/velocidad" width="600" />

Explora 19 modelos de Parakeet, Whisper, Moonshine, SenseVoice y GigaAM. Cada modelo muestra calificaciones de precisión y velocidad (●●●●○/●●●●○), insignias de aptitud y estado de descarga. Búsqueda difusa para encontrar modelos rápido. Presiona Enter para activar y descargar.

### Descargados — gestionar modelos instalados

<img src="assets/settings-downloaded.png" alt="Pestaña de descargados — gestionar modelos instalados, activar o eliminar" width="600" />

Consulta qué está instalado, uso total de disco y qué modelo está activo. Presiona Enter para activar, `x` para eliminar. Los modelos de [Handy](https://github.com/cjpais/handy) se detectan automáticamente y pueden importarse sin volver a descargar.

### Dispositivo — perfil de hardware y dependencias

<img src="assets/settings-device.png" alt="Pestaña de dispositivo — perfil de hardware, dependencias, espacio en disco" width="600" />

Consulta tu perfil de hardware (RAM, CPU, GPU), estado de dependencias (runtime de sherpa-onnx), espacio disponible en disco y total de modelos descargados. Las recomendaciones de modelos se basan en este perfil.

---

## Uso

### Atajos de teclado

| Acción                 | Tecla                    | Notas                                                                                     |
| ---------------------- | ------------------------ | ----------------------------------------------------------------------------------------- |
| **Grabar al editor**   | Mantener `SPACE` (≥1.2s) | Suelta para finalizar. Pre-graba durante el calentamiento para no perder palabras.        |
| **Alternar grabación** | `Ctrl+Shift+V`           | Funciona en todas las terminales — presiona para iniciar, presiona de nuevo para detener. |
| **Limpiar editor**     | `Escape` × 2             | Doble toque en 500ms para borrar todo el texto.                                           |

### Cómo funciona la grabación

1. **Mantener SPACE** — aparece cuenta regresiva de calentamiento, la captura de audio inicia inmediatamente (pre-grabación)
2. **Seguir manteniendo** — transcripción en vivo se transmite al editor (Deepgram) o el audio se almacena en búfer (local)
3. **Soltar SPACE** — la grabación continúa 1.5s (grabación de cola) para capturar tu última palabra, luego finaliza
4. El texto aparece en el editor, listo para enviar

### Comandos

| Comando             | Descripción                                                             |
| ------------------- | ----------------------------------------------------------------------- |
| `/voice-settings`   | Panel de configuración — backend, modelos, idioma, alcance, dispositivo |
| `/voice-models`     | Panel de configuración (pestaña de Modelos)                             |
| `/voice test`       | Diagnóstico completo — herramienta de audio, micrófono, clave API       |
| `/voice on` / `off` | Activar o desactivar voz                                                |
| `/voice dictate`    | Dictado continuo (sin mantener teclas)                                  |
| `/voice stop`       | Detener grabación activa o dictado                                      |
| `/voice history`    | Transcripciones recientes                                               |
| `/voice`            | Alternar encendido/apagado                                              |

---

## Modelos locales

19 modelos en 5 familias. Ordenados por calidad — los mejores modelos primero.

### Mejores opciones

| Modelo              | Precisión | Velocidad | Tamaño | Idiomas                   | Notas                        |
| ------------------- | --------- | --------- | ------ | ------------------------- | ---------------------------- |
| **Parakeet TDT v3** | ●●●●○     | ●●●●○     | 671 MB | 25 (detección automática) | Mejor en general. WER 6.3%.  |
| **Parakeet TDT v2** | ●●●●●     | ●●●●○     | 661 MB | Inglés                    | Mejor para inglés. WER 6.0%. |
| **Whisper Turbo**   | ●●●●○     | ●●○○○     | 1.0 GB | 57                        | Mayor soporte de idiomas.    |

### Rápidos y ligeros

| Modelo                | Precisión | Velocidad | Tamaño | Idiomas         | Notas                                          |
| --------------------- | --------- | --------- | ------ | --------------- | ---------------------------------------------- |
| **Moonshine v2 Tiny** | ●●○○○     | ●●●●●     | 43 MB  | Inglés          | 34ms de latencia. Compatible con Raspberry Pi. |
| **Moonshine Base**    | ●●●○○     | ●●●●●     | 287 MB | Inglés          | Maneja bien los acentos.                       |
| **SenseVoice Small**  | ●●●○○     | ●●●●●     | 228 MB | zh/en/ja/ko/yue | Mejor para idiomas CJK.                        |

### Especialistas

| Modelo               | Precisión | Velocidad | Tamaño | Idiomas | Notas                                     |
| -------------------- | --------- | --------- | ------ | ------- | ----------------------------------------- |
| **GigaAM v3**        | ●●●●○     | ●●●●○     | 225 MB | Ruso    | 50% menor WER que Whisper en ruso.        |
| **Whisper Medium**   | ●●●●○     | ●●●○○     | 946 MB | 57      | Buena precisión, velocidad media.         |
| **Whisper Large v3** | ●●●●○     | ●○○○○     | 1.8 GB | 57      | Mayor precisión de Whisper. Lento en CPU. |

Además, 8 variantes de Moonshine v2 especializadas por idioma para japonés, coreano, árabe, chino, ucraniano, vietnamita y español.

### Cómo funcionan los modelos locales

```
Mantener SPACE → audio capturado en búfer de memoria
                   ↓
Soltar SPACE → búfer enviado a sherpa-onnx (en proceso)
                   ↓
            Inferencia ONNX en CPU (2–10 segundos)
                   ↓
            Transcripción final insertada en el editor
```

Los modelos se descargan automáticamente en el primer uso. Las descargas son reanudables, se verifican al completarse y no se duplican. El panel de configuración muestra progreso de descarga en tiempo real con velocidad y tiempo estimado.

Los modelos de [Handy](https://github.com/cjpais/handy) (`~/Library/Application Support/com.pais.handy/models/`) se detectan automáticamente y pueden importarse mediante enlace simbólico (cero duplicación de disco).

---

## Características

| Característica                        | Descripción                                                                                           |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Backend dual**                      | Deepgram (nube, streaming en vivo) o modelos locales (offline, por lotes) — cambia en configuración   |
| **19 modelos locales**                | Parakeet, Whisper, Moonshine, SenseVoice, GigaAM — con calificaciones de precisión/velocidad          |
| **Panel de configuración unificado**  | Un solo panel superpuesto para toda la configuración — `/voice-settings`                              |
| **Recomendaciones según dispositivo** | Evalúa modelos según tu hardware. Solo los mejores de su clase obtienen [recommended].                |
| **Pipeline de descarga empresarial**  | Pre-verificaciones (disco, red, permisos), progreso en vivo con velocidad/ETA, verificación posterior |
| **Integración con Handy**             | Detecta automáticamente modelos de la app Handy, importa via enlace simbólico                         |
| **Cadena de respaldo de audio**       | Intenta sox, ffmpeg, arecord en orden                                                                 |
| **Pre-grabación**                     | Captura de audio inicia durante el calentamiento — nunca pierdes la primera palabra                   |
| **Grabación de cola**                 | Sigue grabando 1.5s después de soltar para que tu última palabra no se corte                          |
| **Streaming en vivo**                 | Deepgram Nova 3 WebSocket — transcripciones intermedias mientras hablas                               |
| **56+ idiomas**                       | Deepgram: 56+ con streaming en vivo. Local: hasta 57 según el modelo.                                 |
| **Dictado continuo**                  | `/voice dictate` para entrada de texto largo sin mantener teclas                                      |
| **Enfriamiento de escritura**         | Las pulsaciones de espacio dentro de 400ms después de escribir se ignoran                             |
| **Retroalimentación sonora**          | Sonidos del sistema macOS para eventos de inicio, parada y error                                      |
| **Multiplataforma**                   | macOS, Windows, Linux — protocolo Kitty + respaldo no-Kitty                                           |

---

## Arquitectura

```
extensions/voice.ts                Extensión principal — máquina de estados, grabación, UI, panel de configuración
extensions/voice/config.ts         Carga, guardado y migración de configuración
extensions/voice/onboarding.ts     Asistente de primera ejecución, selector de idioma
extensions/voice/deepgram.ts       Constructor de URL de Deepgram, resolutor de clave API
extensions/voice/local.ts          Catálogo de modelos (19 modelos), transcripción en proceso
extensions/voice/device.ts         Perfilado de dispositivo — RAM, GPU, CPU, detección de contenedor
extensions/voice/model-download.ts Gestor de descargas — reanudación, progreso, verificación, importación de Handy
extensions/voice/sherpa-engine.ts   Bindings de sherpa-onnx — ciclo de vida del reconocedor, inferencia
extensions/voice/settings-panel.ts  Panel de configuración — interfaz Component, overlay, 4 pestañas
```

---

## Configuración

La configuración se almacena en los archivos de configuración de Pi bajo la clave `voice`:

| Alcance  | Ruta                          |
| -------- | ----------------------------- |
| Global   | `~/.pi/agent/settings.json`   |
| Proyecto | `<project>/.pi/settings.json` |

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

## Solución de problemas

Ejecuta `/voice test` dentro de Pi para un diagnóstico completo.

| Problema                              | Solución                                                                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| "DEEPGRAM_API_KEY not set"            | [Obtén una clave](https://dpgr.am/pi-voice) → `export DEEPGRAM_API_KEY="..."` en `~/.zshrc`                              |
| "No audio capture tool found"         | `brew install sox` o `brew install ffmpeg`                                                                               |
| La barra espaciadora no activa la voz | Ejecuta `/voice-settings` — la voz puede estar desactivada                                                               |
| El modelo local no transcribe         | Revisa `/voice-settings` → pestaña Dispositivo para el estado de sherpa-onnx                                             |
| Descarga fallida                      | Las descargas parciales se reanudan automáticamente al reintentar. Revisa el espacio en disco en la pestaña Dispositivo. |

---

## Seguridad

- **STT en la nube** — el audio se envía a Deepgram para transcripción (solo backend Deepgram)
- **STT local** — el audio nunca sale de tu máquina (backend local)
- **Sin telemetría** — pi-listen no recopila ni transmite datos de uso
- **Clave API** — almacenada en variable de entorno o configuración de Pi, nunca registrada en logs

Consulta [SECURITY.md](SECURITY.md) para reportar vulnerabilidades.

---

## Licencia

[MIT](LICENSE) © 2026 codexstar69

---

## Enlaces

- **npm:** [npmjs.com/package/pi-listen-ng](https://www.npmjs.com/package/pi-listen-ng)
- **GitHub:** [github.com/CyFeng16/pi-listen-ng](https://github.com/CyFeng16/pi-listen-ng)
- **Deepgram:** [dpgr.am/pi-voice](https://dpgr.am/pi-voice) ($200 de crédito gratuito)
- **Pi CLI:** [github.com/earendil-works/pi-coding-agent](https://github.com/earendil-works/pi-coding-agent)
