[English](../README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Português](README.pt-BR.md) | [हिन्दी](README.hi.md)

# pi-voicekit

> **Continuation communautaire de [`codexstar69/pi-listen`](https://github.com/codexstar69/pi-listen)** (projet d'origine, MIT — en sommeil depuis la v7.2.2 en mai 2026).
> Sans affiliation avec l'auteur d'origine. Ancien nom : `pi-listen`.

<p align="center">
  <img src="../assets/brand/banner-en.png" alt="pi-voicekit — Saisie et sortie vocales pour l'agent de programmation Pi" width="100%" />
</p>

**Entrée et sortie vocales pour [Pi](https://github.com/earendil-works/pi-coding-agent).**
STT maintenir-pour-parler — streaming Deepgram (cloud) ou 21 modèles hors ligne — plus un TTS qui
prononce les réponses de l'agent (Kitten, Kokoro, Piper ou Deepgram Aura).

[![npm version](https://img.shields.io/npm/v/pi-voicekit.svg)](https://www.npmjs.com/package/pi-voicekit)
[![license](https://img.shields.io/npm/l/pi-voicekit.svg)](https://github.com/CyFeng16/pi-voicekit/blob/main/LICENSE)
[![original author](https://img.shields.io/badge/original_author-@baanditeagle-1DA1F2?logo=x&logoColor=white)](https://x.com/baanditeagle)

> **v0.1.3 — version actuelle** — la capture audio privilégie `ffmpeg` lorsque
> `PULSE_SERVER` est défini (tunnel audio SSH / PulseAudio distant), ce qui rend
> l'enregistrement fiable depuis un micro distant. Voix à l'entrée **et** en sortie :
> 21 modèles STT hors ligne, 20 voix TTS locales plus Deepgram Aura, pilotés par un
> seul panneau `/voice-settings` à 6 onglets. La série 0.1.x est documentée dans le
> [journal des modifications](../CHANGELOG.md).

---

## Voir comment ça marche

<p align="center">
  <video src="../assets/demo/pi-voicekit-demo.mp4" controls width="100%"></video>
  <br>
  <em>Vidéo de démonstration</em>
</p>

---

## Installation (2 minutes)

### 1. Installer l'extension

```bash
# Dans un terminal classique (pas à l'intérieur de Pi)
pi install npm:pi-voicekit
```

### 2. Choisir son backend

pi-voicekit prend en charge deux backends de transcription :

|                    | Deepgram (cloud)                                                         | Modèles locaux (hors ligne)                                                           |
| ------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| **Fonctionnement** | Streaming en direct — le texte apparaît pendant que vous parlez          | Mode par lots — transcrit après la fin de votre enregistrement                        |
| **Configuration**  | Clé API requise                                                          | Aucune clé API, les modèles se téléchargent automatiquement à la première utilisation |
| **Internet**       | Requis                                                                   | Non requis après le téléchargement du modèle                                          |
| **Latence**        | Résultats intermédiaires en temps réel                                   | 2–10 secondes après l'arrêt de l'enregistrement                                       |
| **Langues**        | 56+ en streaming en direct                                               | Selon le modèle (1–57 langues)                                                        |
| **Coût**           | $200 de crédit gratuit (dure 6–12 mois pour la plupart des développeurs) | Gratuit à vie                                                                         |

Exécutez `/voice-settings` dans Pi pour choisir votre backend et tout configurer depuis un seul panneau.

#### Option A : Deepgram (recommandé pour le streaming en direct)

Inscrivez-vous sur [dpgr.am/pi-voice](https://dpgr.am/pi-voice) — $200 de crédit gratuit, aucune carte bancaire requise.

```bash
export DEEPGRAM_API_KEY="your-key-here"    # à ajouter à ~/.zshrc ou ~/.bashrc
```

#### Option B : Modèles locaux (entièrement hors ligne)

Aucune configuration nécessaire — exécutez `/voice-settings`, passez le backend sur Local et sélectionnez un modèle. Il se télécharge automatiquement.

> **Remarque :** les modèles locaux utilisent le mode par lots — ils transcrivent après la fin de l'enregistrement, pas pendant que vous parlez. Pour du streaming en direct pendant que vous parlez, utilisez Deepgram.

### 3. Ouvrir Pi

Au premier lancement, pi-voicekit vérifie votre configuration et vous indique ce qui est prêt :

- Backend configuré (clé Deepgram ou modèle local)
- Outil de capture audio détecté (sox, ffmpeg ou arecord)
- Si tout est en ordre, la voix s'active immédiatement

### Capture audio

pi-voicekit détecte automatiquement votre outil audio. Aucune installation manuelle nécessaire si vous disposez déjà de sox ou ffmpeg.

| Priorité | Outil           | Plateformes           | Installation                                                 |
| -------- | --------------- | --------------------- | ------------------------------------------------------------ |
| 1        | **SoX** (`rec`) | macOS, Linux, Windows | `brew install sox` / `apt install sox` / `choco install sox` |
| 2        | **ffmpeg**      | macOS, Linux, Windows | `brew install ffmpeg` / `apt install ffmpeg`                 |
| 3        | **arecord**     | Linux uniquement      | Préinstallé (ALSA)                                           |

> Lorsque `PULSE_SERVER` est défini (tunnel audio SSH ou PulseAudio distant), l'ordre
> devient **ffmpeg → sox → arecord** — les sources Pulse réseau nécessitent ffmpeg.

---

## Panneau de configuration

Toute la configuration tient au même endroit : `/voice-settings`. Six onglets couvrent tout ce dont vous avez besoin.

### Général — backend, langue, portée

<img src="../assets/screenshots/settings-general.png" alt="Paramètres généraux — backend, modèle, langue, portée, activation de la voix" width="600" />

Basculez entre Deepgram (cloud, streaming en direct) et Local (hors ligne, mode par lots). Changez la langue, la portée, et activez ou désactivez la voix — le tout au clavier.

### Modèles — parcourir, rechercher, installer

<img src="../assets/screenshots/settings-models.png" alt="Onglet Modèles — parcourir 21 modèles avec évaluations de précision/vitesse" width="600" />

Parcourez 21 modèles issus de Parakeet, Whisper, Moonshine, SenseVoice, GigaAM, Paraformer et Qwen3. Chaque modèle affiche des évaluations de précision et de vitesse (●●●●○/●●●●○), des badges d'adéquation et l'état de téléchargement. La recherche floue permet de trouver un modèle rapidement. Appuyez sur Entrée pour l'activer et le télécharger.

### Téléchargés — gérer les modèles installés

<img src="../assets/screenshots/settings-downloaded.png" alt="Onglet Téléchargés — gérer les modèles installés, activer ou supprimer" width="600" />

Voyez ce qui est installé, l'espace disque total utilisé et le modèle actif. Appuyez sur Entrée pour activer, sur `x` pour supprimer. Les modèles de [Handy](https://github.com/cjpais/handy) sont détectés automatiquement et peuvent être importés sans re-téléchargement.

### Parole (Speak) — modèles et voix TTS

Choisissez un backend TTS (local sherpa-onnx ou Deepgram Aura), parcourez 20 voix locales
à partir de ~13 MB, téléchargez la voix à la sélection, puis choisissez une voix par backend.
La lecture automatique des réponses de l'agent se règle ici.

### Appareil — profil matériel et dépendances

<img src="../assets/screenshots/settings-device.png" alt="Onglet Appareil — profil matériel, dépendances, espace disque" width="600" />

Consultez votre profil matériel (RAM, CPU, GPU), l'état des dépendances (runtime sherpa-onnx), l'espace disque disponible et le total des modèles téléchargés. Les recommandations de modèles s'appuient sur ce profil.

---

## Utilisation

### Raccourcis clavier

| Action                         | Touche                    | Notes                                                                                                     |
| ------------------------------ | ------------------------- | --------------------------------------------------------------------------------------------------------- |
| **Enregistrer vers l'éditeur** | Maintenir `SPACE` (≥0.7s) | Relâchez pour finaliser. Le pré-enregistrement démarre pendant le préchauffage pour ne manquer aucun mot. |
| **Basculer l'enregistrement**  | `Ctrl+Shift+V`            | Fonctionne dans tous les terminaux — appuyez pour démarrer, appuyez à nouveau pour arrêter.               |
| **Effacer l'éditeur**          | `Escape` × 2              | Double appui en 500ms pour effacer tout le texte.                                                         |

### Comment fonctionne l'enregistrement

1. **Maintenez SPACE** — le compte à rebours de préchauffage apparaît, la capture audio démarre immédiatement (pré-enregistrement)
2. **Continuez à maintenir** — la transcription en direct s'affiche dans l'éditeur (Deepgram) ou l'audio est mis en mémoire tampon (local)
3. **Relâchez SPACE** — l'enregistrement continue pendant 1.5s (enregistrement de queue) pour capter votre dernier mot, puis se finalise
4. Le texte apparaît dans l'éditeur, prêt à être envoyé

### Commandes

| Commande              | Description                                                           |
| --------------------- | --------------------------------------------------------------------- |
| `/voice-settings`     | Panneau de configuration — backend, modèles, langue, portée, appareil |
| `/voice-models`       | Panneau de configuration (onglet Modèles)                             |
| `/voice-setup`        | Lancer l'assistant de configuration du premier démarrage              |
| `/voice-language`     | Ouvrir le panneau de configuration pour changer de langue             |
| `/voice-speak <text>` | Prononcer un texte à voix haute (TTS)                                 |
| `/voice-speak-test`   | Prononcer une phrase d'exemple                                        |
| `/voice-speak-toggle` | Activer / désactiver le TTS                                           |
| `/voice-stream`       | Basculer le TTS en streaming Deepgram (cloud)                         |
| `/voice-speak-stop`   | Arrêter la lecture TTS en cours                                       |
| `/voice-autosubmit`   | Basculer : envoi automatique du texte STT à l'agent (`on`/`off`)      |
| `/voice-hold-delay`   | Régler le délai du maintenir-pour-parler (200-3000 ms, défaut 700)    |
| `/voice-speak-models` | Parcourir / installer les modèles de voix TTS                         |
| `/voice-speak-info`   | Diagnostiquer l'état du TTS                                           |
| `/voice-help`         | Référence clavier et commandes (ou appuyez sur `F1`)                  |
| `/voice test`         | Diagnostic complet — outil audio, micro, clé API                      |
| `/voice on` / `off`   | Activer ou désactiver la voix                                         |
| `/voice dictate`      | Dictée continue (sans maintenir de touche)                            |
| `/voice stop`         | Arrêter l'enregistrement ou la dictée en cours                        |
| `/voice history`      | Transcriptions récentes                                               |
| `/voice`              | Activer / désactiver                                                  |

### Clavier v7.1

Dans le panneau de configuration :

| Touche | Action                                                  |
| ------ | ------------------------------------------------------- |
| `← →`  | changer d'onglet                                        |
| `↑ ↓`  | naviguer entre les lignes (ignore les titres de groupe) |
| `↵`    | sélectionner / activer                                  |
| `esc`  | revenir au principal / fermer le panneau                |
| `type` | filtrer (rechercher)                                    |
| `bksp` | effacer le dernier caractère de la recherche            |

Lorsqu'un widget d'installation ou un indicateur de lecture est monté (sans
overlay au premier plan) :

| Touche | Action                                                                             |
| ------ | ---------------------------------------------------------------------------------- |
| `esc`  | annuler l'installation en cours (la plus récente d'abord), puis arrêter la lecture |
| `F1`   | ouvrir l'aide (toujours disponible)                                                |

---

## Modèles locaux

21 modèles répartis en 7 familles. Triés par qualité — les meilleurs modèles en premier.

### Meilleurs choix

| Modèle              | Précision | Vitesse | Taille | Langues             | Notes                                       |
| ------------------- | --------- | ------- | ------ | ------------------- | ------------------------------------------- |
| **Parakeet TDT v3** | ●●●●○     | ●●●●○   | 671 MB | 25 (détection auto) | Meilleur dans l'ensemble. WER 6.3%.         |
| **Parakeet TDT v2** | ●●●●●     | ●●●●○   | 661 MB | Anglais             | Meilleur en anglais. WER 6.0%.              |
| **Whisper Turbo**   | ●●●●○     | ●●○○○   | 1.0 GB | 57                  | Prise en charge linguistique la plus large. |

### Rapides et légers

| Modèle                | Précision | Vitesse | Taille | Langues         | Notes                                     |
| --------------------- | --------- | ------- | ------ | --------------- | ----------------------------------------- |
| **Moonshine v2 Tiny** | ●●○○○     | ●●●●●   | 43 MB  | Anglais         | 34ms de latence. Compatible Raspberry Pi. |
| **Moonshine Base**    | ●●●○○     | ●●●●●   | 287 MB | Anglais         | Gère bien les accents.                    |
| **SenseVoice Small**  | ●●●○○     | ●●●●●   | 228 MB | zh/en/ja/ko/yue | Idéal pour les langues CJK.               |

### Spécialistes

| Modèle               | Précision | Vitesse | Taille | Langues | Notes                                              |
| -------------------- | --------- | ------- | ------ | ------- | -------------------------------------------------- |
| **GigaAM v3**        | ●●●●○     | ●●●●○   | 225 MB | Russe   | WER inférieur de 50% à Whisper sur le russe.       |
| **Whisper Medium**   | ●●●●○     | ●●●○○   | 946 MB | 57      | Bonne précision, vitesse moyenne.                  |
| **Whisper Large v3** | ●●●●○     | ●○○○○   | 1.8 GB | 57      | Précision la plus élevée de Whisper. Lent sur CPU. |

Plus 8 variantes Moonshine v2 spécialisées par langue pour le japonais, le coréen, l'arabe, le chinois, l'ukrainien, le vietnamien et l'espagnol.

### Fonctionnement des modèles locaux

```
Maintenir SPACE → audio capturé dans un tampon mémoire
                ↓
Relâcher SPACE → tampon envoyé à sherpa-onnx (en processus)
                ↓
         Inférence ONNX sur CPU (2–10 secondes)
                ↓
         Transcription finale insérée dans l'éditeur
```

Les modèles se téléchargent automatiquement à la première utilisation. Les téléchargements sont reprenables, vérifiés après complétion et dédupliqués (aucun double téléchargement). Le panneau de configuration affiche la progression en temps réel avec la vitesse et le temps restant estimé.

Les modèles de [Handy](https://github.com/cjpais/handy) (`~/Library/Application Support/com.pais.handy/models/`) sont détectés automatiquement et peuvent être importés par lien symbolique (zéro duplication sur disque).

---

## Fonctionnalités

| Fonctionnalité                               | Description                                                                                                                |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Double backend**                           | Deepgram (cloud, streaming en direct) ou modèles locaux (hors ligne, mode par lots) — bascule dans les paramètres          |
| **21 modèles locaux**                        | Parakeet, Whisper, Moonshine, SenseVoice, GigaAM, Paraformer, Qwen3 — avec évaluations de précision et de vitesse          |
| **Panneau de configuration unifié**          | Un seul panneau superposé pour toute la configuration — `/voice-settings`                                                  |
| **Recommandations selon l'appareil**         | Évalue chaque modèle par rapport à votre matériel. Seuls les meilleurs de leur catégorie reçoivent [recommended].          |
| **Pipeline de téléchargement entreprise**    | Pré-vérifications (disque, réseau, permissions), progression en direct avec vitesse/ETA, vérification après téléchargement |
| **Intégration Handy**                        | Détecte automatiquement les modèles de l'application Handy, import par lien symbolique                                     |
| **Chaîne de repli audio**                    | Essaie sox → ffmpeg → arecord dans cet ordre — ffmpeg en premier lorsque `PULSE_SERVER` est défini                         |
| **Pré-enregistrement**                       | La capture audio démarre pendant le préchauffage — vous ne manquez jamais le premier mot                                   |
| **Enregistrement de queue**                  | Continue l'enregistrement 1.5s après le relâchement pour ne pas couper votre dernier mot                                   |
| **Streaming en direct**                      | Deepgram Nova 3 WebSocket (Nova 2 pour les locales chinoises) — transcriptions intermédiaires en direct                    |
| **56+ langues**                              | Deepgram : 56+ en streaming en direct. Local : jusqu'à 57 selon le modèle.                                                 |
| **Dictée continue**                          | `/voice dictate` pour la saisie de textes longs sans maintenir de touche                                                   |
| **Délai anti-frappe**                        | Les maintiens de la barre d'espace dans les 400ms suivant une frappe sont ignorés                                          |
| **Retour sonore**                            | Sons système macOS pour les événements de démarrage, d'arrêt et d'erreur                                                   |
| **Multiplateforme**                          | macOS, Windows, Linux — protocole Kitty + repli non-Kitty                                                                  |

---

## Architecture

```
# core
extensions/voice.ts                         Extension principale — machine à états, enregistrement, UI, surface de commandes
extensions/voice/config.ts                  Chargement, sauvegarde et migration de la configuration
extensions/voice/onboarding.ts              Assistant de premier démarrage, sélecteur de langue
extensions/voice/audio-tool.ts              Détection de l'outil de capture (sox / ffmpeg / arecord)
extensions/voice/hold-to-talk.ts            Détection du maintien, terminaux Kitty et non-Kitty
extensions/voice/release-controller.ts      Cycle de vie de l'enregistrement, gestion du relâchement

# speech-to-text
extensions/voice/deepgram.ts                Constructeur d'URL Deepgram, résolution de la clé API
extensions/voice/local.ts                   Catalogue de modèles (21 modèles), transcription en processus
extensions/voice/sherpa-engine.ts           Bindings sherpa-onnx — cycle de vie du recognizer, inférence
extensions/voice/sherpa-loader.ts           Chargement paresseux du module natif
extensions/voice/model-download.ts          Gestionnaire de téléchargement — reprise, progression, vérification, import Handy
extensions/voice/device.ts                  Profilage de l'appareil — RAM, GPU, CPU, détection de conteneur

# text-to-speech
extensions/voice/speak.ts                   Point d'entrée de la lecture, câblage de la lecture automatique
extensions/voice/tts-engine.ts              Synthèse TTS sherpa-onnx
extensions/voice/tts-deepgram.ts            Voix Deepgram Aura (cloud)
extensions/voice/tts-local-models.ts        Catalogue TTS local — 20 voix (Kitten, Kokoro, Piper)
extensions/voice/tts-playback.ts            Lecture, mise en tampon, détection du lecteur audio
extensions/voice/tts-text-filter.ts         Suppression des blocs de code, préparation des phrases
extensions/voice/tts-onboarding.ts          Parcours d'initialisation du TTS
extensions/voice/tts-onboarding-overlay.ts  Interface superposée d'initialisation du TTS
extensions/voice/tts-install-progress.ts    Widget de progression d'installation des modèles
extensions/voice/tts-playback-indicator.ts  Widget d'indicateur de lecture

# settings and UI
extensions/voice/settings-panel.ts          Panneau de configuration — overlay, 6 onglets
extensions/voice/ui-picker.ts               Sélecteur de liste générique
extensions/voice/ui-help-overlay.ts         Référence clavier et commandes
extensions/voice/ui-aura.ts                 Primitives visuelles (Liquid Braille, Aurora)
extensions/voice/ui-widget-base.ts          Registre de widgets et classe de base
extensions/voice/ui-render-ticker.ts        Ticker de rendu partagé
extensions/voice/ui-icons.ts                Jeu de glyphes et d'icônes
extensions/voice/ui-width.ts                Utilitaires de largeur visuelle compatibles CJK
extensions/voice/ui-locale-labels.ts        Libellés natifs de langues et de voix

# types
extensions/voice/sherpa-onnx-node.d.ts      Déclarations de types pour le module natif optionnel
```

---

## Configuration

Les paramètres sont stockés dans les fichiers de paramètres de Pi, sous la clé `voice` :

| Portée  | Chemin                        |
| ------- | ----------------------------- |
| Globale | `~/.pi/agent/settings.json`   |
| Projet  | `<project>/.pi/settings.json` |

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

La variable `DEEPGRAM_API_KEY` de votre shell est utilisée à l'exécution et n'est pas
recopiée dans `~/.pi/agent/settings.json`. Si vous collez une clé pendant l'assistant
de configuration, il s'agit d'un enregistrement explicite : elle est tout de même
écrite dans `~/.env.secrets` ou `~/.zshrc`.

Le délai du maintenir-pour-parler est de **700 ms** par défaut (`/voice-hold-delay` accepte 200-3000 ms).

---

## Dépannage

Exécutez `/voice test` dans Pi pour un diagnostic complet.

| Problème                                           | Solution                                                                                                                                 |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| "DEEPGRAM_API_KEY not set"                         | [Obtenir une clé](https://dpgr.am/pi-voice) → `export DEEPGRAM_API_KEY="..."` dans `~/.zshrc`                                            |
| "No audio capture tool found"                      | `brew install sox` ou `brew install ffmpeg`                                                                                              |
| Le micro distant n'enregistre que du silence       | Audio via PulseAudio/SSH — installez ffmpeg côté Pi (la capture privilégie alors ffmpeg)                                                 |
| La barre d'espace n'active pas la voix             | Exécutez `/voice-settings` — la voix est peut-être désactivée                                                                            |
| Le modèle local ne transcrit pas                   | Vérifiez `/voice-settings` → onglet Appareil pour l'état de sherpa-onnx                                                                  |
| Échec du téléchargement                            | Les téléchargements partiels reprennent automatiquement à la prochaine tentative. Vérifiez l'espace disque dans l'onglet Appareil.       |
| `dyld: Library not loaded: libsimdjson` sous macOS | Incompatibilité d'ABI de Node avec Homebrew — exécutez `brew reinstall node` ou passez à un Node géré par version (`mise`, `fnm`, `nvm`) |

---

## Sécurité

- **STT cloud** — l'audio est envoyé à Deepgram pour la transcription (backend Deepgram uniquement)
- **STT local** — l'audio ne quitte jamais votre machine (backend local)
- **Aucune télémétrie** — pi-voicekit ne collecte ni ne transmet de données d'utilisation
- **Clé API** — stockée dans une variable d'environnement ou dans les paramètres Pi, jamais journalisée

Voir [SECURITY.md](../SECURITY.md) pour signaler une vulnérabilité.

---

## Licence

[MIT](../LICENSE) — original par [@baanditeagle](https://x.com/baanditeagle), maintenu par [CyFeng16](https://github.com/CyFeng16)

---

## Liens

- **npm :** [npmjs.com/package/pi-voicekit](https://www.npmjs.com/package/pi-voicekit)
- **GitHub :** [github.com/CyFeng16/pi-voicekit](https://github.com/CyFeng16/pi-voicekit)
- **Deepgram :** [dpgr.am/pi-voice](https://dpgr.am/pi-voice) ($200 de crédit gratuit)
- **Pi CLI :** [github.com/earendil-works/pi-coding-agent](https://github.com/earendil-works/pi-coding-agent)
