# Brand assets

Everything a README, release post or docs page needs to show the pi-voicekit brand. Assets are grouped
by purpose, not by format: `brand/` (identity), `screenshots/` (UI captures the READMEs embed), `demo/`
(the demo video) and `legacy/` (upstream-era artwork).

## Files

| File                      | What it is                                                              | Dimensions | Background  |
| ------------------------- | ----------------------------------------------------------------------- | ---------- | ----------- |
| `banner-en.png`           | Banner: aurora background, icon + wordmark, “Voice input & output for Pi CLI” | 1280×640   | baked dark  |
| `banner-zh-CN.png`        | Chinese tagline: “Pi 编程智能体的语音输入与输出工具”                     | 1280×640   | baked dark  |
| `icon-on-light.png`       | Icon only — five rounded bars                                           | 1024×1024  | baked light |
| `lockup-horizontal-on-light.png` | Icon on the left, wordmark on the right                          | 1280×640   | baked light |
| `lockup-vertical-on-light.png`   | Icon above the wordmark                                          | 1024×1024  | baked light |

Where they are used today:

- `README.md` uses `banner-en.png`; `i18n/README.zh-CN.md` uses `banner-zh-CN.png`.
- English is the agreed banner for every language except Chinese, so `banner-en.png` is what the six other
  localized READMEs use — no further language banners are planned.
- The lockups and the icon are referenced by nothing yet — they are here for release posts, npm/GitHub
  cards and docs pages.

## Naming

- `-on-light` / `-on-dark` names **the background the artwork is designed to sit on**, not the colour of
  the logo.
- `banner-<language>.png` is a self-contained poster: it carries its own background, so it needs no theme
  suffix.

## Known gaps

| Missing                                        | Why it matters                                                                                                                                                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| transparent-background (alpha) icon and lockups | Every PNG here is RGB **without** alpha: the background is baked in (near-white `rgb(248,248,249)`), so on any dark surface the mark arrives as a white box.                              |
| dark-theme variants (`-on-dark`)                | Transparency alone is not enough — the wordmark is near-black ink, so it disappears on a dark surface. A dark-theme variant is the same artwork in light ink; then serve both with `<picture><source media="(prefers-color-scheme: dark)" …>`. |
| true vector sources (SVG, AI, Figma)            | The two auto-traced SVGs that were supplied are **not usable** — the trace baked the aurora bands into the bars and kept an opaque background. This mark is simple enough to redraw as clean vector art.              |
| fresh screenshots                               | `assets/screenshots/*` still show the pre-0.2 UI: the old brand in the panel header and four tabs (the Speak tab is missing).                                                                                       |
| a re-recorded demo                              | `assets/demo/pi-voicekit-demo.mp4` still shows the old brand and the old UI.                                                                                                                                        |

The English and Chinese banners are rendered from the same template, so their aurora background
matches; they remain separate renders, so fine detail still differs between the two files.

## `assets/legacy/`

Upstream-era artwork (`hero.png`, `social-preview.png`), kept only because old CHANGELOG entries mention
them. Nothing links to these files.
