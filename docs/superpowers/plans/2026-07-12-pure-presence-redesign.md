# PURE PRESENCE Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the existing motion hero with a premium fashion-editorial product page that clearly sells PureAutoLike and uses a clean, responsive alpha-video interaction.

**Architecture:** Keep the production page self-contained in `site/scrub/index.html`, with semantic regions for utility navigation, editorial masthead, character media, product copy, and actions. Add a standalone Node contract test for copy, structure, source selection, and motion safeguards, plus a reproducible FFmpeg media build script that derives browser assets from the 2880 x 5120 greenscreen master.

**Tech Stack:** HTML5, CSS, vanilla JavaScript, Node.js assertions, FFmpeg/ffprobe, VP9 WebM alpha, HEVC alpha, GitHub Pages.

## Global Constraints

- The page is a single non-scrolling viewport.
- The first viewport identifies PureAutoLike, Pure Web, automated presence, and the install action.
- Remove the copy `Не жми. Веди.` everywhere, including social metadata.
- Use the approved `PRESENCE / AUTOMATED.` editorial title and Russian product explanation verbatim.
- Use cool pearl grey, black, and one controlled PureAutoLike pink accent.
- No decorative cards, pills, glowing blobs, ornamental gradients, or continuous breathing animation.
- Buttons have a maximum 4 px radius and visible keyboard focus.
- The character remains the only pointer-controlled visual object; title parallax is limited to 8 px.
- Media errors retain the cleaned poster and never substitute an old character asset.
- Desktop/mobile alpha video remains 60 fps with frequent keyframes.
- Preserve unrelated dirty worktree changes.

---

### Task 1: Add A Failing Page Contract

**Files:**
- Create: `tests/scrub-page-fixtures.mjs`
- Test: `site/scrub/index.html`

**Interfaces:**
- Consumes: UTF-8 contents of `site/scrub/index.html`.
- Produces: a zero-exit standalone command, `node tests/scrub-page-fixtures.mjs`, that validates the redesign contract.

- [ ] **Step 1: Write the failing contract test**

```js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../site/scrub/index.html', import.meta.url), 'utf8');

assert.match(html, /PUREAUTOLIKE/);
assert.match(html, /FOR PURE WEB/);
assert.match(html, /SYSTEM 01 \/ 2026/);
assert.match(html, /PRESENCE/);
assert.match(html, /AUTOMATED\./);
assert.match(html, /автоматизирует ваше присутствие в Pure Web/);
assert.match(html, /УСТАНОВИТЬ РАСШИРЕНИЕ/);
assert.match(html, /КАК ЭТО РАБОТАЕТ/);
assert.doesNotMatch(html, /Не жми\. Веди\./);
assert.doesNotMatch(html, /is-fallback-video|fallback:/);
assert.match(html, /preload="metadata"/);
assert.match(html, /prefersAppleAlphaVideo/);
assert.match(html, /window\.addEventListener\('pageshow', restoreScrubState\)/);
assert.match(html, /document\.addEventListener\('visibilitychange'/);

console.log('scrub page fixture validation passed');
```

- [ ] **Step 2: Run the contract and verify it fails against the old copy**

Run: `node tests/scrub-page-fixtures.mjs`

Expected: FAIL on `SYSTEM 01 / 2026`, `PRESENCE`, or the approved product explanation.

- [ ] **Step 3: Commit the failing contract**

```bash
git add tests/scrub-page-fixtures.mjs
git commit -m "test: define Pure Presence page contract"
```

---

### Task 2: Rebuild The Editorial Layout

**Files:**
- Modify: `site/scrub/index.html:1-610`
- Test: `tests/scrub-page-fixtures.mjs`

**Interfaces:**
- Consumes: existing `#scrubSurface`, `#scrubVideo`, and `#scrubControl` ids required by the motion controller.
- Produces: `.utility-header`, `.editorial-title`, `.media-stage`, `.product-panel`, `.product-actions`, and `.contact-shadow` regions.

- [ ] **Step 1: Replace product metadata and visible copy**

Use these exact content strings:

```html
<title>PureAutoLike — Presence Automated for Pure Web</title>
<meta name="description" content="PureAutoLike автоматизирует ваше присутствие в Pure Web — последовательно, точно, без постоянного контроля.">

<header class="utility-header">
  <a class="utility-header__brand" href="../">PUREAUTOLIKE</a>
  <span>FOR PURE WEB</span>
  <span class="utility-header__edition">SYSTEM 01 / 2026</span>
</header>

<div class="editorial-title" aria-hidden="true">
  <span class="editorial-title__presence">PRESENCE</span>
  <span class="editorial-title__automated">AUTOMATED.</span>
</div>

<div class="product-panel">
  <p>PureAutoLike автоматизирует ваше присутствие в Pure Web — последовательно, точно, без постоянного контроля.</p>
  <div class="product-actions">
    <a class="product-action product-action--primary" href="https://chromewebstore.google.com/detail/pureautolike/abamkpcdpihjpaomdpaklhifpfbobgmm">УСТАНОВИТЬ РАСШИРЕНИЕ</a>
    <a class="product-action product-action--secondary" href="../ru/pure-avtolayk/">КАК ЭТО РАБОТАЕТ</a>
  </div>
</div>
```

- [ ] **Step 2: Replace the visual system with fixed editorial regions**

Implement these layout contracts in the page CSS:

```css
:root {
  --ink: #111113;
  --paper: #e6e7e5;
  --paper-light: #f4f4f1;
  --accent: #f20b68;
}

#scrubSurface {
  min-height: 100svh;
  overflow: hidden;
  background: var(--paper);
}

.utility-header {
  position: absolute;
  inset: 24px clamp(24px, 4vw, 64px) auto;
  z-index: 40;
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
}

.editorial-title {
  position: absolute;
  z-index: 5;
  top: clamp(72px, 10vh, 112px);
  left: 50%;
  transform: translateX(calc(-50% + var(--title-shift, 0px)));
}

.media-stage { z-index: 10; }
.contact-shadow { z-index: 9; }
.product-panel { z-index: 30; }
.product-action { border-radius: 4px; }
```

Use breakpoint-specific font sizes rather than viewport-width font scaling. Keep `PRESENCE` within the viewport at 390, 768, 1280, and 1440 px widths.

- [ ] **Step 3: Remove the old visual language**

Delete `.surface-feedback`, `.campaign-copy`, `.campaign-product-line`, `.brand-wordmark`, `wordmark-breathe`, pill button geometry, and the old slider rail from the CSS and markup. Retain the slider as a visually quiet keyboard target with an accessible focus indicator.

- [ ] **Step 4: Run the contract and HTML validation**

Run:

```bash
node tests/scrub-page-fixtures.mjs
npx --yes html-validate site/scrub/index.html
```

Expected: both PASS.

- [ ] **Step 5: Commit the editorial layout**

```bash
git add site/scrub/index.html tests/scrub-page-fixtures.mjs
git commit -m "feat: redesign motion hero as Pure Presence"
```

---

### Task 3: Isolate And Tune The Motion Controller

**Files:**
- Modify: `site/scrub/index.html:610-900`
- Test: `tests/scrub-page-fixtures.mjs`

**Interfaces:**
- Consumes: `#scrubSurface`, `#scrubVideo`, `#scrubControl`, and `.editorial-title`.
- Produces: `setTargetFromClientX(clientX)`, `restoreScrubState()`, `tick(now)`, and `primeVideo()` with title-only parallax and idle-loop shutdown.

- [ ] **Step 1: Change parallax ownership from the old wordmark to the editorial title**

```js
const editorialTitle = document.querySelector('.editorial-title');

function setTargetFromClientX(clientX) {
  hasInteracted = true;
  if (!duration) return;
  const rect = surface.getBoundingClientRect();
  const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
  targetTime = ratio * duration;
  editorialTitle.style.setProperty('--title-shift', `${(ratio - 0.5) * 16}px`);
  ensureScrubLoop();
}
```

- [ ] **Step 2: Preserve the approved slow response and neutral-frame warmup**

```js
const FOLLOW_RESPONSE = 6;
const MAX_FOLLOW_SPEED_RATIO = 0.28;
const SEEK_EPSILON = 1 / 60;

function primeVideo() {
  duration = Number.isFinite(video.duration) ? video.duration : 0;
  targetTime = duration * 0.5;
  smoothTime = targetTime;
  video.pause();
  if (duration && Math.abs(video.currentTime - smoothTime) > SEEK_EPSILON) {
    video.currentTime = smoothTime;
  }
  paintProgress();
}
```

- [ ] **Step 3: Preserve lifecycle and failure behavior**

Keep the serial seek state machine, `pagehide`, `pageshow`, `visibilitychange`, source-size switching, and error behavior. `handleVideoError()` must stop animation and leave the poster visible; it must not append a fallback source.

- [ ] **Step 4: Extend the contract with motion ownership checks**

Add:

```js
assert.match(html, /const editorialTitle = document\.querySelector\('\.editorial-title'\)/);
assert.match(html, /--title-shift/);
assert.doesNotMatch(html, /--wordmark-shift|wordmark-breathe/);
assert.match(html, /MAX_FOLLOW_SPEED_RATIO = 0\.28/);
assert.match(html, /video\.currentTime = smoothTime/);
```

- [ ] **Step 5: Run tests and commit**

Run:

```bash
node tests/scrub-page-fixtures.mjs
node --check <(sed -n '/<script>/,/<\/script>/p' site/scrub/index.html | sed '1d;$d')
```

Expected: PASS.

Commit:

```bash
git add site/scrub/index.html tests/scrub-page-fixtures.mjs
git commit -m "refactor: isolate Pure Presence motion"
```

---

### Task 4: Build Clean Alpha Media From The Master

**Files:**
- Create: `tools/build-scrub-media.sh`
- Replace: `site/assets/videos/interactive-scrub-cutout-desktop-fast-720.webm`
- Replace: `site/assets/videos/interactive-scrub-cutout-mobile-fast-540.webm`
- Replace: `site/assets/videos/interactive-scrub-cutout-desktop-fast-720-hevc.mov`
- Replace: `site/assets/videos/interactive-scrub-cutout-mobile-fast-540-hevc.mov`
- Replace: `site/assets/posters/interactive-scrub-poster-desktop-900.png`
- Replace: `site/assets/posters/interactive-scrub-poster-mobile-540.png`

**Interfaces:**
- Consumes: path argument to the 2880 x 5120, 60 fps greenscreen master.
- Produces: four 10-second browser video assets and two transparent posters at the existing production paths.

- [ ] **Step 1: Add a reproducible media script with dependency checks**

```bash
#!/usr/bin/env bash
set -euo pipefail

SOURCE=${1:?Usage: tools/build-scrub-media.sh /path/to/greenscreen.mp4}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT="$ROOT/site/assets/videos"
POSTERS="$ROOT/site/assets/posters"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

command -v ffmpeg >/dev/null
command -v ffprobe >/dev/null
command -v qt-faststart >/dev/null
```

- [ ] **Step 2: Generate one high-resolution temporally consistent RGBA mezzanine**

Use the high-resolution source before scaling. Apply chroma removal, spill suppression, alpha contraction, and minimal alpha blur in one filter graph:

```bash
KEY_FILTER="chromakey=0x00ff00:0.20:0.075,despill=green:mix=0.55:expand=0.10,format=rgba"

ffmpeg -y -i "$SOURCE" -an -vf "$KEY_FILTER" \
  -c:v prores_ks -profile:v 4444 -pix_fmt yuva444p10le \
  "$WORK/clean-master.mov"
```

Before accepting the filter values, render frames at 0, 2.5, 5, 7.5, and 9.9 seconds over `#e6e7e5`, black, white, and pink. Reject values that show green spill, a white halo, missing hair, or frame-to-frame edge chatter.

- [ ] **Step 3: Encode seekable VP9 alpha assets**

```bash
ffmpeg -y -i "$WORK/clean-master.mov" -an -vf "scale=720:1280:flags=lanczos" \
  -c:v libvpx-vp9 -pix_fmt yuva420p -row-mt 1 -deadline good -cpu-used 2 \
  -crf 27 -b:v 0 -g 6 -auto-alt-ref 0 \
  "$OUT/interactive-scrub-cutout-desktop-fast-720.webm"

ffmpeg -y -i "$WORK/clean-master.mov" -an -vf "scale=540:960:flags=lanczos" \
  -c:v libvpx-vp9 -pix_fmt yuva420p -row-mt 1 -deadline good -cpu-used 2 \
  -crf 29 -b:v 0 -g 6 -auto-alt-ref 0 \
  "$OUT/interactive-scrub-cutout-mobile-fast-540.webm"
```

- [ ] **Step 4: Encode Safari HEVC alpha assets and move metadata to the front**

Encode through VideoToolbox with the alpha plane enabled, preserve `hvc1`, then run `qt-faststart` instead of FFmpeg `-movflags faststart` because the latter corrupts the auxiliary alpha track:

```bash
ffmpeg -y -i "$WORK/clean-master.mov" -an -vf "scale=720:1280:flags=lanczos,format=bgra" \
  -c:v hevc_videotoolbox -tag:v hvc1 -alpha_quality 0.85 -b:v 18M -g 6 \
  "$WORK/desktop-hevc-tail.mov"
qt-faststart "$WORK/desktop-hevc-tail.mov" \
  "$OUT/interactive-scrub-cutout-desktop-fast-720-hevc.mov"

ffmpeg -y -i "$WORK/clean-master.mov" -an -vf "scale=540:960:flags=lanczos,format=bgra" \
  -c:v hevc_videotoolbox -tag:v hvc1 -alpha_quality 0.85 -b:v 11M -g 6 \
  "$WORK/mobile-hevc-tail.mov"
qt-faststart "$WORK/mobile-hevc-tail.mov" \
  "$OUT/interactive-scrub-cutout-mobile-fast-540-hevc.mov"
```

Verify each output with:

```bash
ffmpeg -v error -i "$file" -vf alphaextract -frames:v 1 -f null -
python3 -c 'import sys; b=open(sys.argv[1],"rb").read(); assert b.find(b"moov") < b.find(b"mdat")' "$file"
```

- [ ] **Step 5: Generate matching transparent posters**

```bash
ffmpeg -y -ss 5 -i "$WORK/clean-master.mov" -frames:v 1 -vf "scale=900:1600:flags=lanczos" "$POSTERS/interactive-scrub-poster-desktop-900.png"
ffmpeg -y -ss 5 -i "$WORK/clean-master.mov" -frames:v 1 -vf "scale=540:960:flags=lanczos" "$POSTERS/interactive-scrub-poster-mobile-540.png"
```

- [ ] **Step 6: Validate media and commit**

For every output, require 10 seconds, 60 fps, the expected dimensions, successful frame decoding, and keyframes no farther than 100 ms apart.

Commit:

```bash
git add tools/build-scrub-media.sh site/assets/videos/interactive-scrub-cutout-*fast* site/assets/posters/interactive-scrub-poster-{desktop-900,mobile-540}.png
git commit -m "fix: rebuild clean Pure Presence media"
```

---

### Task 5: Responsive Browser QA And Publication

**Files:**
- Modify: `site/scrub/index.html`
- Test: `tests/scrub-page-fixtures.mjs`

**Interfaces:**
- Consumes: completed page and media assets.
- Produces: verified local and public pages at desktop and mobile widths.

- [ ] **Step 1: Start the local site and run static validation**

```bash
npx --yes http-server site -a 127.0.0.1 -p 5177 -c-1 --cors
node tests/scrub-page-fixtures.mjs
npx --yes html-validate site/scrub/index.html
npm run validate
git diff --check
```

Expected: all commands PASS.

- [ ] **Step 2: Verify desktop rendering at 1440 x 900 and 1280 x 800**

Check:

- all four product facts visible without scrolling;
- `PRESENCE` remains behind the character and clear of the head;
- product panel does not overlap the silhouette;
- no horizontal or vertical overflow;
- poster displays immediately;
- first input starts from the warmed 5-second frame;
- direction reversal remains gradual;
- no console errors.

- [ ] **Step 3: Verify mobile rendering at 390 x 844 and 430 x 932**

Check the same contracts, plus 44 px action targets, thumb-reachable CTA, mobile source selection, and touch scrubbing.

- [ ] **Step 4: Verify Safari source and alpha edge**

Open the local page in Safari, confirm `safariAlpha` is selected, inspect the hair and body edge on the production background, move through the complete timeline, leave the page, return, and confirm interaction resumes.

- [ ] **Step 5: Publish without unrelated files**

Create a commit containing only the redesign files, replay it on top of the latest `origin/main` in a temporary worktree, and push `HEAD:main` without force.

- [ ] **Step 6: Verify the public cache-busted release**

Open:

```text
https://zgnme.github.io/pureautolike/scrub/?v=pure-presence-1
```

Confirm the public HTML contains `PRESENCE`, `MAX_FOLLOW_SPEED_RATIO = 0.28`, and the new asset version marker. Confirm all four video assets support HTTP range requests and the public browser has no media error.
