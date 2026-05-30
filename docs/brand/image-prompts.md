# WhalePod — Brand Image Generation Prompts

**Brand tokens (constant across all assets):**

| Token               | Value                                                                                |
| ------------------- | ------------------------------------------------------------------------------------ |
| Brand name          | WhalePod                                                                             |
| Domain              | whalepod.trade                                                                       |
| Background          | `#0A0A0B` (near-black)                                                               |
| Accent              | `#7FE5DC` (arctic teal)                                                              |
| Secondary           | `#E8E8E8` (off-white)                                                                |
| Sans font reference | Inter / Geist Sans                                                                   |
| Mono font reference | IBM Plex Mono / Geist Mono                                                           |
| Aesthetic anchors   | Linear marketing, Vercel brand, Hyperliquid trading UI, Bloomberg terminal restraint |

**Generation rule (critical):**

- **Static assets** (avatar, wordmark, favicon, OG card): bake everything in. One image, used unchanged.
- **Templates** (PnL card, copy-trade card, leaderboard card): generate **only the static background + logo + grid**. **Do NOT render any data text in the prompt.** The runtime renderer (`satori` + `@vercel/og`) composites ticker, PnL %, whale alias, referral code, and stats over the template at request time. If a prompt produces baked-in text like `{REF}` or `+42.8%`, regenerate.

**Model assignment:**

- **Nano Banana Pro** for all assets containing text (wordmark, avatar with mark, OG card).
- **Nano Banana Pro** for templates (better at clean geometric composition).
- **Imagen 4** is unused in this set — kept in reserve for marketing/blog imagery only.
- **Veo 3.1** for V1 only, post-launch.

---

## A1 — Square avatar (1024×1024) — X, TG, GitHub profile

**Model:** Nano Banana Pro

```
Generate a 1024x1024 square brand avatar for "WhalePod", a minimalist crypto trading tool. Background: solid color #0A0A0B (near-black). Foreground: a single, geometric, abstract icon centered, rendered in arctic teal #7FE5DC. The icon is a stylized minimal mark suggesting a whale's tail fluke viewed from above — two simple symmetric crescent shapes meeting at a center point, ultra-flat, vector-style, no gradient, no shadow, no glow, no outline, 1px stroke weight if any. The icon occupies the central 50% of the canvas. No text. No mascot, no eyes, no cartoon features. Style: Swiss modernist, Linear app icon, Vercel triangle level of restraint. Output: clean, sharp, no texture, no noise, no border.
```

## A2 — Horizontal wordmark (transparent PNG ~1600×400)

**Model:** Nano Banana Pro

```
Generate a horizontal wordmark logo for the brand "WhalePod". Transparent background. The wordmark is the single word "whalepod" in clean geometric sans-serif typography (Inter or Geist Sans style), all lowercase. Color: pure white #FFFFFF. To the immediate left of the wordmark, the brand's whale-fluke icon: two symmetric thin crescent shapes meeting at a center point, in arctic teal #7FE5DC, sized to match the cap-height of the wordmark. Tight letter spacing (-2%). No tagline. No box. No gradient. No effect. Output 1600x400, vector-clean, sharp at any scale.
```

## A3 — Favicon (512×512, downscales to 16/32)

**Model:** Nano Banana Pro

```
Generate a 512x512 favicon. Solid background color #0A0A0B. Centered foreground: a single ultra-simplified whale-tail-fluke mark in arctic teal #7FE5DC — two symmetric thin crescents meeting at a center point, occupying 70% of the canvas. No text. No outline. No shadow. Flat vector style, designed to remain legible when downscaled to 16x16 pixels.
```

## A4 — OG card (1200×630, STATIC, link unfurls)

**Model:** Nano Banana Pro
**Behavior:** static. One image, used for every link unfurl. Bake everything.

```
Generate a 1200x630 horizontal social-share image (Open Graph card) for the brand "WhalePod". Background: solid #0A0A0B. Layout: left half empty negative space. Right half vertically centered: the whale-fluke icon (two arctic-teal #7FE5DC crescents meeting at a point) followed by the wordmark "whalepod" in lowercase geometric sans (Inter style), color #FFFFFF, set at 96pt with tight letter spacing. Directly below the wordmark, one line of mono text in arctic teal #7FE5DC (IBM Plex Mono style) at 26pt: mirror hyperliquid whales. A subtle 1px monospace grid overlay across the entire canvas at 4% opacity. No other elements. No glow, no gradient, no shadow, no border.
```

---

## A5 — PnL share card TEMPLATE (1200×675) — runtime composited

**Model:** Nano Banana Pro
**Behavior:** template. Bake ONLY brand. NO data text. Runtime overlays everything else.

```
Generate a 1200x675 PURE BACKGROUND TEMPLATE image. No text other than the brand wordmark. Background: solid #0A0A0B. A very faint 1px monospace grid overlay across the entire canvas at 3% opacity. Bottom-left corner only: the brand identity unit — the whale-fluke icon (two arctic-teal #7FE5DC crescents meeting at a point) followed by the wordmark "whalepod" in lowercase Inter-style sans-serif, white #FFFFFF, 28pt, with 24px padding from the canvas edges. The remaining canvas above and to the right of the wordmark must be COMPLETELY EMPTY — no chart, no candle, no number, no ticker, no percentage, no URL, no placeholder text, no decorative shape. Pure flat #0A0A0B with the grid overlay only. The empty space will be filled by an external renderer with live data — do NOT populate it. Editorial Bloomberg-terminal calm.
```

**Runtime overlay (composited by `satori` in U12), NOT in the prompt:**

| Zone                | Content                  | Style                                                                 |
| ------------------- | ------------------------ | --------------------------------------------------------------------- |
| Upper-left          | `BTC LONG 10x`           | IBM Plex Mono, 36pt, `#E8E8E8`                                        |
| Center              | `+42.8%` (live)          | Geist Sans Bold, 180pt, `#7FE5DC` if positive / `#FF6B6B` if negative |
| Lower-right         | `mirroring 0xWHALE…`     | IBM Plex Mono, 22pt, `#7FE5DC`                                        |
| Bottom-right corner | `whalepod.trade/r/{REF}` | IBM Plex Mono, 20pt, `#7FE5DC`                                        |

## A6 — Copy-trade subscription card TEMPLATE (1200×675)

**Model:** Nano Banana Pro
**Behavior:** template. Same rule as A5.

```
Generate a 1200x675 PURE BACKGROUND TEMPLATE image. Background: solid #0A0A0B. A single horizontal thin line in arctic teal #7FE5DC at 1px stroke, spanning 60% of canvas width, centered horizontally, at vertical midpoint. Bottom-left corner only: the whale-fluke icon (two arctic-teal #7FE5DC crescents meeting at a point) followed by "whalepod" in lowercase Inter sans, white #FFFFFF, 28pt. 24px corner padding. The rest of the canvas must be COMPLETELY EMPTY — no headline text, no alias text, no stat text, no URL text, no placeholder, no decoration. Pure flat background. The empty zones above and below the horizontal line will be filled by an external renderer with live data — do NOT populate them.
```

**Runtime overlay zones (NOT in prompt):**

| Zone                      | Content                                |
| ------------------------- | -------------------------------------- |
| Upper-center (above line) | `NOW MIRRORING` headline + whale alias |
| Lower-center (below line) | 30d ROI stat + mirror count            |
| Bottom-right corner       | `whalepod.trade/r/{REF}`               |

## A7 — Leaderboard rank card TEMPLATE (1200×675)

**Model:** Nano Banana Pro
**Behavior:** template. Same rule as A5.

```
Generate a 1200x675 PURE BACKGROUND TEMPLATE image. Background: solid #0A0A0B. A subtle 1px monospace grid overlay across the entire canvas at 3% opacity. Bottom-left corner only: the whale-fluke icon (two arctic-teal #7FE5DC crescents meeting at a point) followed by "whalepod" in lowercase Inter sans, white #FFFFFF, 28pt, 24px padding from edges. The rest of the canvas must be COMPLETELY EMPTY — no rank number, no headline, no stat, no URL, no medal, no trophy, no podium, no decorative shape. Pure flat background with grid only. External renderer will composite rank text, headline, and stats over the empty area — do NOT populate.
```

**Runtime overlay zones (NOT in prompt):**

| Zone                | Content                              |
| ------------------- | ------------------------------------ |
| Top center          | `WHALEPOD LEADERBOARD — 7D` headline |
| Center-left         | rank number e.g. `#7`                |
| Center-right        | `of 1,243 mirrors`                   |
| Bottom-right corner | `whalepod.trade/r/{REF}`             |

---

## V1 — Launch animation (Veo 3.1, POST-LAUNCH only, do not generate now)

```
Create a 6-second silent loop, 1920x1080, 30fps. Solid #0A0A0B background. A single arctic-teal #7FE5DC thin line draws itself from left to right across the canvas, splits into two crescent shapes that meet at a center point (forming the whale-fluke logo mark), holds for 1.5 seconds, then the wordmark "whalepod" fades in below in clean white lowercase Inter sans-serif at 84pt. Loops seamlessly. No audio. No camera movement. No other elements. Style: Vercel brand intro, Linear logo animation. Output: MP4 H.264, perfectly loopable.
```

---

## Landing hero — DELETED FROM IMAGE-GEN

The hero is **built in code** (SVG + CSS in U14), not generated. Reason: a strategic landing hero must be tied tightly to copy and CTA. AI-generated hero images create generic visual noise that lowers conversion. Hero spec lives in Phase 1 §4.
