---
name: design-craft
description: "Only for swarm:designer, which preloads it. Platform-neutral rules for precise visual work: SVG and vector geometry, spacing and layout, type scales, OKLCH color and tokens, component states, art direction, and the render-and-report step before a handoff."
user-invocable: false
---

# Design craft

Rules for output that survives measurement. Every rule has a default and a legitimate exception. An exception is fine when you can name it and never fine when it is an accident.

`swarm:apple-design` complements this file when the target is macOS, iOS, or iPadOS, and its rules win where the two conflict. Load it only for those targets.

## 0. Before drawing

1. Find the existing system: tokens, asset catalog, component library, DESIGN.md, design-file variables. Extend it. Never start a parallel one.
2. Write the constraint set in 3-5 lines: canvas or viewport, grid unit, available text styles, palette roles, target platform.
3. If no system exists, define the minimum this task needs (not a full system) and say that you did.

## 1. Vector and geometry

**Canvas**
- Integer `viewBox`, origin `0 0`. Icons: 24x24 with a 20x20 live area. Smaller sizes (16, 20) are redrawn when they need less detail, not scaled.
- One stroke weight per set (1.5 or 2 at 24). One cap and join style per set.
- Pixel fit: even stroke widths sit on integer coordinates, odd widths on .5. Straight edges of filled shapes sit on integers.

**Paths**
- Primitives first: `<rect rx>`, `<circle>`, `<line>`. Then arcs (`A`). Hand-plotted cubic beziers are the last resort.
- Anchors only at extrema and at real corners or inflections. Handles horizontal or vertical at extrema. A circle quadrant as a cubic uses handle length 0.5523 x r.
- At most 2 decimals. No leftover `transform`s, empty groups, editor metadata, or duplicate overlapping paths.
- Holes: `fill-rule="evenodd"` or consistent opposite winding. Pick one per file.
- Single-colour icons use `currentColor`, not hardcoded fills.

**Booleans**
- SVG has no boolean operators. `<mask>` and `<clipPath>` are fine for on-screen results. They are not acceptable where a flattened outline is required: icon fonts, SF Symbol templates, app-icon layers, cutting, print.
- Never hand-derive curve intersections. Compute flattened unions, subtractions and intersections with a path library (paper.js `unite/subtract/intersect/exclude`, skia-pathops, Inkscape CLI) and use its output. Then re-check the anchor count: boolean output usually needs simplifying.

**Optical corrections** (apply them, and record them)
- Centroid, not bounding box. A triangle's visual centre is 1/3 of the way from its base. A play triangle of width w inside a circle shifts w/6 toward its point.
- Overshoot: round and pointed forms extend 1-3% past the line that flat forms sit on.
- Equal size is not equal weight. At the same nominal size a circle's diameter is about 1.1x a square's side. Use keyline shapes: in a 24 box, circle 20, square 18, portrait 16x20, landscape 20x16.
- Nested corners are concentric: inner radius = outer radius - gap (floor at 0, which means square).
- An icon beside text aligns to the text's cap-height centre or baseline, not to the icon's box.

## 2. Space and layout

- Base unit 4. Spacing tokens: 2, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96. Nothing else for margins, padding or gaps.
- Legitimate exceptions: hairlines (1 device pixel), optical nudges (1-2), sizes derived from type metrics, platform-provided metrics. Any other off-grid value is a defect.
- Proximity carries grouping. The gap inside a group is at most half the gap between groups. Two equal gaps make the grouping ambiguous.
- Build layout as nested stacks and grids with explicit rules per container: direction, gap, alignment, padding, and which child flexes. Every element has a sizing rule (fixed, hug, or fill) with min and max where it fills.
- Breakpoints follow content, not devices: a breakpoint goes where the layout breaks. Prefer container-relative rules to viewport-relative ones.
- Every text element has an overflow policy: wrap (with max lines) or truncate (tail or middle), plus a min width.
- Hierarchy: one primary action per view, at most three levels of emphasis per screen. A new alignment edge needs a reason.
- Density is a decision. Declare compact, regular or comfortable up front and hold it.

## 3. Typography

- Where the platform defines text styles (Apple, Material), use them. Build a modular scale only for web, marketing or fully custom surfaces.
- Scale ratio by job: 1.125-1.2 for dense product UI, 1.25 for general use, 1.333-1.5 for editorial and marketing. The golden ratio (1.618) is too steep for UI; reserve it for a two- or three-step display hierarchy.
- Round sizes to whole px. Snap line-height to 4: body 1.4-1.6x, headings 1.1-1.25x, single-line UI labels to the control height.
- Tracking: tighten as size grows (about -0.01em at 24, -0.02em at 40 and up). Open all-caps and small-caps labels by +0.04 to +0.08em. Leave body at 0. Do not hand-track system fonts that track themselves.
- Measure 45-75 characters, 66 as the target. Enforce it with `ch` or max-width.
- At most 2 families and 3 weights. Tabular figures for anything that updates in place or aligns in columns. Right-align numeric columns.
- A text style is a bundle: size, line-height, weight, tracking. Specs reference style names, never raw sizes.

## 4. Color

- Author in OKLCH. A ramp holds hue (allow up to about 10 degrees of intended drift), steps lightness evenly, and lets chroma peak mid-ramp and taper at both ends.
- Gamut: OKLCH can name colours no display can show. Map to sRGB by reducing chroma at constant lightness and hue. Ship Display P3 variants only where the pipeline supports them, always with an sRGB fallback.
- Contrast is computed, never eyeballed. Equal OKLCH lightness does not guarantee equal WCAG contrast. Compute WCAG 2.x ratios from the final sRGB values: 4.5:1 for text, 3:1 for large text and essential non-text UI (input borders, icons, focus rings), 7:1 where AAA is requested. APCA can be reported as a second opinion; WCAG 2.x is the compliance number.
- Three tiers: primitives (`blue-500`), then semantic roles (`surface/base`, `surface/raised`, `border/subtle`, `text/primary`, `text/muted`, `accent`, `on-accent`, `status/danger/{bg,fg,border}`), then component tokens only when a component truly diverges. Components never reference primitives.
- Dark mode is a second mapping, not an inversion: lower chroma, raise surfaces by lightness instead of shadow, and re-check every pair.
- Never carry meaning by colour alone. Pair it with an icon, text or shape.

## 5. Components

- State matrix for every interactive element: default, hover (pointer only), pressed, focus-visible, selected/on, disabled, loading.
- State matrix for every data view: loading (skeleton that matches the final layout), empty, error, partial, offline or stale.
- A missing cell is either designed or marked N/A with the reason.
- Stress before sign-off: labels 40% longer (and doubled for words under 10 characters), the longest realistic unbroken string, RTL, item counts of 0, 1, many and overflow, 7+-digit and negative numbers, missing image or avatar, the largest accessibility text size, the smallest and largest container.
- Anatomy spec per component: parts, sizing rule per part, spacing tokens, text style, colour roles per state, minimum hit area, motion (property, duration, curve or spring), accessibility name and role.
- Focus is always visible, at least 3:1 against adjacent colours, and never removed.

## 6. Art direction for asset sets

- Write the style sheet before the first asset: one light direction, perspective model (flat, isometric 30 degrees, or one-point), palette subset, outline policy, corner language, shadow model (contact plus cast, fixed angle and blur ratio), texture (noise type, frequency, opacity).
- Check every asset against the sheet side by side with the others, at identical scale.
- Keep layers separate: subject, contact shadow, cast shadow, light overlay, background. No background baked into a subject. Clean alpha with no halo from a matte colour.
- Raster generation needs an image-generation tool. Without one, deliver vector where possible plus a generation brief (style sheet, per-asset prompt, negative constraints) for whoever runs it. Never describe an image you have not rendered as done.

## 7. Render before you report

Unrendered output is a draft. The verifier measures your deliverables independently, so your part is to see what you made and to report it honestly.

- Render with the real renderer for the medium, and check what is available before assuming: SVG with `resvg`, `rsvg-convert`, or a headless browser at 1x and at 4-8x; HTML/CSS with headless Chromium at each breakpoint; SwiftUI or AppKit with an Xcode preview or a simulator screenshot; a design file with the tool's own export.
- Write renders to a temporary directory outside the project, unless the brief asks for them as deliverables. A stray file in the checkout becomes part of the candidate.
- Open the image and look at it: zoomed in for edges and alignment, at 1x for balance and hierarchy, and icons at their final size (16-24 px). Detail that survives 8x often dies at 1x.
- Fix, re-render, and look again, three passes at most. After that, report what remains: an open item stated plainly is better than a fourth guess.
- No renderer available: continue the work, mark the deliverable `UNRENDERED`, and list exactly what must be checked by whoever can render it.

End every `ready` report with this block. Keep it short.

```
STATUS: rendered | partially rendered | UNRENDERED
Deliverables: <paths>
Rendered: <renderer, sizes, appearances, cases>
Deviations: <each off-token or off-grid value and each optical correction, with its reason>
Assumptions: <anything decided without being told>
Open: <what you could not settle or render>
Needs from others: <@owner: what>
```
