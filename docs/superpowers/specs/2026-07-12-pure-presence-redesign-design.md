# PURE PRESENCE Redesign

## Objective

Redesign the PureAutoLike motion hero as a premium fashion-editorial product page. The animated character remains the visual hook, while the interface clearly sells PureAutoLike as a browser extension that automates a user's presence in Pure Web.

The page must feel controlled, precise, and prestigious despite the deliberately provocative character motion. It must not resemble a promotional banner, sportswear imitation, or joke landing page.

## Product Message

The primary promise is:

> Automate your presence in Pure Web.

The first viewport must communicate three facts within five seconds:

1. The product is PureAutoLike.
2. It works with Pure Web.
3. It automates ongoing activity without constant manual control.

The existing headline "Не жми. Веди." is removed.

## Creative Direction

The concept name is **PURE PRESENCE**.

The visual language is luxury fashion editorial: cool studio light, restrained typography, strict alignment, deliberate negative space, and a single controlled pink accent. The character is presented seriously rather than surrounded by humorous or sexually suggestive copy.

The page uses a cool pearl-grey field with subtle tonal depth. Black provides structure. PureAutoLike pink is reserved for the automation signal, interaction feedback, and the primary action state. There are no gradients used as decorative objects, glowing blobs, badges, glass cards, pill-shaped controls, or ornamental motion.

## First Viewport

The page remains a single, non-scrolling viewport.

### Utility line

A quiet top line establishes the product context:

- Left: `PUREAUTOLIKE`
- Center or optical center: `FOR PURE WEB`
- Right: `SYSTEM 01 / 2026`

This line uses a compact neutral sans-serif in uppercase. It supports the composition and never competes with the character.

### Editorial title

The main title is:

```
PRESENCE
AUTOMATED.
```

`PRESENCE` is the editorial masthead and sits behind the character to create depth. It remains legible, does not touch the viewport edges, and does not visually collide with the head.

`AUTOMATED.` is smaller, sharper, and uses PureAutoLike pink. It acts as the product statement rather than a slogan.

### Product explanation

Russian body copy:

> PureAutoLike автоматизирует ваше присутствие в Pure Web — последовательно, точно, без постоянного контроля.

The copy sits in the lower third, outside the primary silhouette. It uses a narrow readable measure and no promotional adjectives.

### Actions

Primary action: `УСТАНОВИТЬ РАСШИРЕНИЕ`

Secondary action: `КАК ЭТО РАБОТАЕТ`

Actions use strict rectangular geometry with a maximum 4 px radius. The primary action is black at rest and pink on hover/focus. The secondary action is a restrained text or outline action. Both retain visible keyboard focus.

## Character Composition

The character remains centered and occupies approximately 68-74% of the desktop viewport height. The feet terminate at the visual bottom edge. The head has deliberate breathing room from the masthead and top utility line.

The character is the only element controlled by horizontal pointer or touch movement. The page must not imply that the user is dragging a video player.

A soft, low-opacity contact shadow sits behind the lower silhouette to integrate the character into the studio environment. It does not blur or hide the alpha edge.

On mobile, the character remains dominant, but copy moves into two compact lower blocks and the title scales through fixed breakpoints rather than viewport-proportional font sizing.

## Motion System

The existing horizontal scrub interaction is retained with these principles:

- Pointer input updates the target immediately.
- Video time follows with controlled inertia rather than matching the pointer one-to-one.
- Direction changes decelerate naturally and do not snap.
- The video is warmed around its neutral middle frame before the first gesture.
- The render loop stops after settling and while the page is hidden.
- Returning through browser history restores working interaction.
- Touch movement uses the same target model with mobile-specific media.

Typography may translate by no more than 4-8 px in response to interaction. There is no continuous breathing animation. Product copy and actions remain stationary.

Reduced-motion mode removes typographic parallax while preserving accessible manual control of the scrub position.

## Alpha And Edge Quality

The current visible ripple around the character is a media defect and cannot be accepted as a styling characteristic.

The final media must be derived from the highest-resolution greenscreen master, not from an already keyed or repeatedly compressed browser asset. The preparation pipeline must include:

1. Temporally stable foreground matting across adjacent frames.
2. Hair-specific matte refinement.
3. Green and grey spill suppression.
4. Edge color decontamination using nearby foreground colors.
5. Matte contraction of approximately 0.5-1 source pixel where needed.
6. Minimal subpixel feathering without a visible halo.
7. Inspection on light grey, white, black, and pink test backgrounds.

Browser deliverables:

- Safari and iOS: HEVC with alpha, fast-start metadata, 60 fps.
- Chromium and Firefox: VP9 WebM with alpha, 60 fps.
- Separate desktop and mobile resolutions.
- Frequent keyframes suitable for responsive seeking.
- A transparent poster generated from the same cleaned master.

If the available greenscreen master cannot produce a stable hair edge, the design must use a deliberately matched studio backdrop plate rather than hiding defects with a CSS mask.

## Responsive Behaviour

Desktop layout uses a three-layer composition: masthead behind, character in the center, product information in front but outside the silhouette.

Tablet reduces the utility line and moves product copy lower. Mobile removes nonessential system metadata, keeps the product name visible, and places the CTA within thumb reach without overlaying the character.

No viewport may introduce page scrolling, horizontal overflow, clipped buttons, or text overlapping the face, body, or controls.

## Technical Structure

The existing single-page HTML, CSS, and JavaScript implementation remains the delivery format.

The page is divided into four explicit visual regions:

1. Utility header.
2. Editorial masthead.
3. Character media stage.
4. Product message and actions.

Interaction state remains isolated to the media controller. Visual parallax variables are applied only to the masthead. Product content does not depend on video readiness, so the page remains useful if alpha video fails.

Media errors display the cleaned poster and leave product actions operational. The page must never substitute an older character asset.

## Accessibility

- Product copy and actions meet WCAG AA contrast.
- The scrub position remains keyboard operable through the existing slider semantics.
- Focus indicators are visible against all backgrounds.
- The character video is decorative and muted; it does not require captions.
- The product message remains understandable without motion.
- Mobile touch targets are at least 44 by 44 CSS pixels.

## Validation And Acceptance

The redesign is complete when:

1. The old slogan and current campaign copy are absent.
2. A first-time viewer can identify the product, platform, purpose, and installation action from the initial viewport.
3. Desktop and mobile screenshots show no text collisions or viewport overflow.
4. The character edge shows no visible green spill, white halo, or temporal ripple on the production background.
5. Safari uses the HEVC alpha source and Chromium uses the VP9 alpha source.
6. Cold load presents the poster immediately and warms the neutral video frame before interaction.
7. Scrubbing remains smooth in both directions, after tab restoration, and on touch input.
8. Console, HTML validation, and repository tests pass.
9. The public GitHub Pages URL serves the new version with an explicit cache-busting release marker.

## Out Of Scope

- Multi-page marketing content.
- Checkout, authentication, or account management.
- Additional character variants.
- Decorative 3D scenes or WebGL.
- Rewriting the browser extension itself.
