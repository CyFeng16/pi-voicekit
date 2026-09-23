[English](../README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Português](README.pt-BR.md) | [हिन्दी](README.hi.md)

# pi-listen

<p align="center">
  <img src="../assets/banner.png" alt="pi-listen — Saisie vocale pour l'agent de programmation Pi" width="100%" />
</p>

**Saisie vocale maintenir-pour-parler pour [Pi](https://github.com/earendil-works/pi-coding-agent).** Streaming cloud via Deepgram ou entièrement hors ligne avec des modèles locaux.

[![npm version](https://img.shields.io/npm/v/pi-voicekit.svg)](https://www.npmjs.com/package/pi-voicekit)
[![license](https://img.shields.io/npm/l/pi-voicekit.svg)](https://github.com/CyFeng16/pi-voicekit/blob/main/LICENSE)
[![author](https://img.shields.io/badge/author-@baanditeagle-1DA1F2?logo=x&logoColor=white)](https://x.com/baanditeagle)

> **v5.0.1 — Correctif de sécurité** — Les clés API ne fuient plus dans la configuration du projet. L'audio du micro ne peut plus être redirigé vers des serveurs distants via des paramètres de dépôt malveillants. Injection shell corrigée dans le processus d'intégration des clés API. Les écritures de configuration sont désormais atomiques. [Journal des modifications complet →](../CHANGELOG.md)

---

## Voir comment ça marche

<video src="../assets/pi-listen.mp4" controls width="100%"></video>

---

## Installation (2 minutes)

### 1. Installer l'extension

```bash
# Dans un terminal classique (pas à l'intérieur de Pi)
pi install npm:pi-voicekit
```

### 2. Choisir votre backend

pi-listen prend en charge deux backends de transcription :

|                    | Deepgram (cloud)                                                            | Modèles locaux (hors ligne)                                                           |
| ------------------ | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **Fonctionnement** | Streaming en direct — le texte apparaît pendant que vous parlez             | Mode par lots — transcrit après la fin de l'enregistrement                            |
| **Configuration**  | Clé API requise                                                             | Pas de clé API, les modèles se téléchargent automatiquement à la première utilisation |
| **Internet**       | Requis                                                                      | Non requis après le téléchargement du modèle                                          |
| **Latence**        | Résultats intermédiaires en temps réel                                      | 2 à 10 secondes après l'arrêt de l'enregistrement                                     |
| **Langues**        | 56+ en streaming en direct                                                  | Selon le modèle (1 à 57 langues)                                                      |
| **Coût**           | 200 $ de crédit gratuit (dure 6 à 12 mois pour la plupart des développeurs) | Gratuit pour toujours                                                                 |

Exécutez `/voice-settings` dans Pi pour choisir votre backend et tout configurer depuis un seul panneau.

#### Option A : Deepgram (recommandé pour le streaming en direct)

Inscrivez-vous sur [dpgr.am/pi-voice](https://dpgr.am/pi-voice) — 200 $ de crédit gratuit, pas de carte bancaire requise.

```bash
export DEEPGRAM_API_KEY="your-key-here"    # ajouter à ~/.zshrc ou ~/.bashrc
```

#### Option B : Modèles locaux (entièrement hors ligne)

Aucune configuration nécessaire — exécutez `/voice-settings`, passez le backend en Local et sélectionnez un modèle. Il se télécharge automatiquement.

> **Remarque :** Les modèles locaux utilisent le mode par lots — ils transcrivent après la fin de l'enregistrement, pas pendant que vous parlez. Pour le streaming en direct pendant que vous parlez, utilisez Deepgram.

### 3. Ouvrir Pi

Au premier lancement, pi-listen vérifie votre configuration et vous indique ce qui est prêt :

- Backend configuré (clé Deepgram ou modèle local)
- Outil de capture audio détecté (sox, ffmpeg ou arecord)
- Si tout est en ordre, la voix s'active immédiatement

### Capture audio

pi-listen détecte automatiquement votre outil audio. Aucune installation manuelle nécessaire si vous avez déjà sox ou ffmpeg.

| Priorité | Outil           | Plateformes           | Installation                                                 |
| -------- | --------------- | --------------------- | ------------------------------------------------------------ |
| 1        | **SoX** (`rec`) | macOS, Linux, Windows | `brew install sox` / `apt install sox` / `choco install sox` |
| 2        | **ffmpeg**      | macOS, Linux, Windows | `brew install ffmpeg` / `apt install ffmpeg`                 |
| 3        | **arecord**     | Linux uniquement      | Préinstallé (ALSA)                                           |

---

## Panneau de configuration

Toute la configuration au même endroit : `/voice-settings`. Quatre onglets couvrent tout ce dont vous avez besoin.

### Général — backend, langue, portée

<img src="../assets/settings-general.png" alt="Paramètres généraux — backend, modèle, langue, portée, activation/désactivation de la voix" width="600" />

Basculez entre Deepgram (cloud, streaming en direct) et Local (hors ligne, mode par lots). Changez la langue, la portée et activez/désactivez la voix — le tout avec des raccourcis clavier.

### Modèles — parcourir, rechercher, installer

<img src="../assets/settings-models.png" alt="Onglet Modèles — parcourir 21 modèles avec évaluations de précision/vitesse" width="600" />

Parcourez 21 modèles issus de Parakeet, Whisper, Moonshine, SenseVoice, GigaAM, Paraformer et Qwen3. Chaque modèle affiche des évaluations de précision et de vitesse (●●●●○/●●●●○), des badges d'aptitude et l'état de téléchargement. Recherche floue pour trouver les modèles rapidement. Appuyez sur Entrée pour activer et télécharger.

### Téléchargés — gérer les modèles installés

<img src="../assets/settings-downloaded.png" alt="Onglet Téléchargés — gérer les modèles installés, activer ou supprimer" width="600" />

Consultez ce qui est installé, l'utilisation totale du disque et quel modèle est actif. Appuyez sur Entrée pour activer, `x` pour supprimer. Les modèles de [Handy](https://github.com/cjpais/handy) sont détectés automatiquement et peuvent être importés sans re-téléchargement.

### Appareil — profil matériel et dépendances

<img src="../assets/settings-device.png" alt="Onglet Appareil — profil matériel, dépendances, espace disque" width="600" />

Consultez votre profil matériel (RAM, CPU, GPU), l'état des dépendances (runtime sherpa-onnx), l'espace disque disponible et le total des modèles téléchargés. Les recommandations de modèles sont basées sur ce profil.

---

## Utilisation

### Raccourcis clavier

| Action                         | Touche                    | Notes                                                                                       |
| ------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------- |
| **Enregistrer vers l'éditeur** | Maintenir `SPACE` (≥1,2s) | Relâcher pour finaliser. Pré-enregistre pendant le préchauffage pour ne manquer aucun mot.  |
| **Basculer l'enregistrement**  | `Ctrl+Shift+V`            | Fonctionne dans tous les terminaux — appuyer pour démarrer, appuyer à nouveau pour arrêter. |
| **Effacer l'éditeur**          | `Escape` × 2              | Double appui en 500ms pour effacer tout le texte.                                           |

### Comment fonctionne l'enregistrement

1. **Maintenir SPACE** — le compte à rebours de préchauffage apparaît, la capture audio démarre immédiatement (pré-enregistrement)
2. **Continuer à maintenir** — la transcription en direct est diffusée dans l'éditeur (Deepgram) ou l'audio est mis en tampon (local)
3. **Relâcher SPACE** — l'enregistrement continue pendant 1,5s (enregistrement de queue) pour capturer votre dernier mot, puis finalise
4. Le texte apparaît dans l'éditeur, prêt à être envoyé

### Commandes

| Commande            | Description                                                           |
| ------------------- | --------------------------------------------------------------------- |
| `/voice-settings`   | Panneau de configuration — backend, modèles, langue, portée, appareil |
| `/voice-models`     | Panneau de configuration (onglet Modèles)                             |
| `/voice test`       | Diagnostic complet — outil audio, micro, clé API                      |
| `/voice on` / `off` | Activer ou désactiver la voix                                         |
| `/voice dictate`    | Dictée continue (sans maintenir de touche)                            |
| `/voice stop`       | Arrêter l'enregistrement actif ou la dictée                           |
| `/voice history`    | Transcriptions récentes                                               |
| `/voice`            | Basculer on/off                                                       |

---

## Modèles locaux

21 modèles répartis en 7 familles. Triés par qualité — les meilleurs modèles en premier.

### Meilleurs choix

| Modèle              | Précision | Vitesse | Taille | Langues             | Notes                                |
| ------------------- | --------- | ------- | ------ | ------------------- | ------------------------------------ |
| **Parakeet TDT v3** | ●●●●○     | ●●●●○   | 671 Mo | 25 (détection auto) | Meilleur dans l'ensemble. WER 6,3 %. |
| **Parakeet TDT v2** | ●●●●●     | ●●●●○   | 661 Mo | Anglais             | Meilleur pour l'anglais. WER 6,0 %.  |
| **Whisper Turbo**   | ●●●●○     | ●●○○○   | 1,0 Go | 57                  | Support linguistique le plus large.  |

### Rapides et légers

| Modèle                | Précision | Vitesse | Taille | Langues         | Notes                                     |
| --------------------- | --------- | ------- | ------ | --------------- | ----------------------------------------- |
| **Moonshine v2 Tiny** | ●●○○○     | ●●●●●   | 43 Mo  | Anglais         | 34ms de latence. Compatible Raspberry Pi. |
| **Moonshine Base**    | ●●●○○     | ●●●●●   | 287 Mo | Anglais         | Gère bien les accents.                    |
| **SenseVoice Small**  | ●●●○○     | ●●●●●   | 228 Mo | zh/en/ja/ko/yue | Meilleur pour les langues CJK.            |

### Spécialistes

| Modèle               | Précision | Vitesse | Taille | Langues | Notes                                      |
| -------------------- | --------- | ------- | ------ | ------- | ------------------------------------------ |
| **GigaAM v3**        | ●●●●○     | ●●●●○   | 225 Mo | Russe   | WER 50 % inférieur à Whisper sur le russe. |
| **Whisper Medium**   | ●●●●○     | ●●●○○   | 946 Mo | 57      | Bonne précision, vitesse moyenne.          |
| **Whisper Large v3** | ●●●●○     | ●○○○○   | 1,8 Go | 57      | Meilleure précision Whisper. Lent sur CPU. |

Plus 8 variantes Moonshine v2 spécialisées par langue pour le japonais, le coréen, l'arabe, le chinois, l'ukrainien, le vietnamien et l'espagnol.

### Fonctionnement des modèles locaux

```
Maintenir SPACE → audio capturé dans un tampon mémoire
                    ↓
Relâcher SPACE → tampon envoyé à sherpa-onnx (en processus)
                    ↓
              Inférence ONNX sur CPU (2 à 10 secondes)
                    ↓
              Transcription finale insérée dans l'éditeur
```

Les modèles se téléchargent automatiquement à la première utilisation. Les téléchargements sont reprenables, vérifiés après complétion et dédupliqués (pas de double téléchargement). Le panneau de configuration affiche la progression en temps réel avec la vitesse et le temps estimé.

Les modèles de [Handy](https://github.com/cjpais/handy) (`~/Library/Application Support/com.pais.handy/models/`) sont détectés automatiquement et peuvent être importés par lien symbolique (zéro duplication disque).

---

## Fonctionnalités

| Fonctionnalité                            | Description                                                                                                               |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Double backend**                        | Deepgram (cloud, streaming en direct) ou modèles locaux (hors ligne, par lots) — changement dans les paramètres           |
| **21 modèles locaux**                     | Parakeet, Whisper, Moonshine, SenseVoice, GigaAM, Paraformer, Qwen3 — avec évaluations précision/vitesse                                     |
| **Panneau de configuration unifié**       | Un seul panneau superposé pour toute la configuration — `/voice-settings`                                                 |
| **Recommandations selon l'appareil**      | Évalue les modèles par rapport à votre matériel. Seuls les meilleurs de leur catégorie obtiennent [recommended].          |
| **Pipeline de téléchargement entreprise** | Pré-vérifications (disque, réseau, permissions), progression en direct avec vitesse/ETA, vérification post-téléchargement |
| **Intégration Handy**                     | Détecte automatiquement les modèles de l'app Handy, importe par lien symbolique                                           |
| **Chaîne de repli audio**                 | Essaie sox, ffmpeg, arecord dans l'ordre                                                                                  |
| **Pré-enregistrement**                    | La capture audio démarre pendant le préchauffage — vous ne manquez jamais le premier mot                                  |
| **Enregistrement de queue**               | Continue l'enregistrement 1,5s après le relâchement pour que votre dernier mot ne soit pas coupé                          |
| **Streaming en direct**                   | Deepgram Nova 3 WebSocket — transcriptions intermédiaires pendant que vous parlez                                         |
| **56+ langues**                           | Deepgram : 56+ en streaming en direct. Local : jusqu'à 57 selon le modèle.                                                |
| **Dictée continue**                       | `/voice dictate` pour la saisie longue sans maintenir de touches                                                          |
| **Délai de frappe**                       | Les appuis sur espace dans les 400ms suivant une frappe sont ignorés                                                      |
| **Retour sonore**                         | Sons système macOS pour les événements de démarrage, arrêt et erreur                                                      |
| **Multiplateforme**                       | macOS, Windows, Linux — protocole Kitty + repli non-Kitty                                                                 |

---

## Architecture

```
extensions/voice.ts                Extension principale — machine à états, enregistrement, UI, panneau de config
extensions/voice/config.ts         Chargement, sauvegarde et migration de la configuration
extensions/voice/onboarding.ts     Assistant de première exécution, sélecteur de langue
extensions/voice/deepgram.ts       Constructeur d'URL Deepgram, résolveur de clé API
extensions/voice/local.ts          Catalogue de modèles (21 modèles), transcription en processus
extensions/voice/device.ts         Profilage d'appareil — RAM, GPU, CPU, détection de conteneur
extensions/voice/model-download.ts Gestionnaire de téléchargements — reprise, progression, vérification, import Handy
extensions/voice/sherpa-engine.ts   Bindings sherpa-onnx — cycle de vie du reconnaisseur, inférence
extensions/voice/settings-panel.ts  Panneau de configuration — interface Component, overlay, 4 onglets
```

---

## Configuration

Les paramètres sont stockés dans les fichiers de configuration de Pi sous la clé `voice` :

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

---

## Dépannage

Exécutez `/voice test` dans Pi pour un diagnostic complet.

| Problème                               | Solution                                                                                                  |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| "DEEPGRAM_API_KEY not set"             | [Obtenir une clé](https://dpgr.am/pi-voice) → `export DEEPGRAM_API_KEY="..."` dans `~/.zshrc`             |
| "No audio capture tool found"          | `brew install sox` ou `brew install ffmpeg`                                                               |
| La barre d'espace n'active pas la voix | Exécutez `/voice-settings` — la voix est peut-être désactivée                                             |
| Le modèle local ne transcrit pas       | Vérifiez `/voice-settings` → onglet Appareil pour l'état de sherpa-onnx                                   |
| Échec du téléchargement                | Les téléchargements partiels reprennent automatiquement. Vérifiez l'espace disque dans l'onglet Appareil. |

---

## Sécurité

- **STT cloud** — l'audio est envoyé à Deepgram pour la transcription (backend Deepgram uniquement)
- **STT local** — l'audio ne quitte jamais votre machine (backend local)
- **Pas de télémétrie** — pi-listen ne collecte ni ne transmet de données d'utilisation
- **Clé API** — stockée dans une variable d'environnement ou les paramètres Pi, jamais journalisée

Consultez [SECURITY.md](../SECURITY.md) pour signaler des vulnérabilités.

---

## Licence

[MIT](../LICENSE) © 2026 codexstar69

---

## Liens

- **npm :** [npmjs.com/package/pi-voicekit](https://www.npmjs.com/package/pi-voicekit)
- **GitHub :** [github.com/CyFeng16/pi-voicekit](https://github.com/CyFeng16/pi-voicekit)
- **Deepgram :** [dpgr.am/pi-voice](https://dpgr.am/pi-voice) (200 $ de crédit gratuit)
- **Pi CLI :** [github.com/earendil-works/pi-coding-agent](https://github.com/earendil-works/pi-coding-agent)
