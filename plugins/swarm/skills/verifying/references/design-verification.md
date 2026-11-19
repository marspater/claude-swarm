# Verifying design work

For the verifier, when a `READY` comes from a `swarm:designer` or a worker built UI from a designer's spec. The designer reports what it rendered; you measure independently. Nothing is aligned, accessible, or matching the spec until you rendered and measured it.

**Render** with the real renderer for the medium, and check what is available before assuming.

| Medium | Render with | Measure with |
| --- | --- | --- |
| SVG | `resvg`, `rsvg-convert`, or a headless browser, to PNG at 1x and at 4-8x | `getBBox()` per element; path bounds against the live area |
| HTML/CSS | Headless Chromium screenshots at each breakpoint and at one width between breakpoints | `getBoundingClientRect()` and computed styles, dumped as JSON |
| SwiftUI or AppKit | An Xcode preview render, or a simulator or app screenshot | Rendered values against the spec; an accessibility audit where available |
| Design file | The tool's own screenshot or export | Node metadata: positions, sizes, variables |

Write every render and measurement to a directory outside the project, such as one from `mktemp -d`. A file added to the checkout changes the candidate's sources and voids it. Then open the image and look at it: zoomed in for edges and alignment, at 1x for balance and hierarchy, and icons at their final size (16-24 px).

**Measure** in numbers.

- Spacing: every gap and padding is in the spec's token set. List offenders with their values.
- Alignment: sibling edges, centres, and baselines agree within 0.5 px, except the optical offsets the designer recorded.
- Sizes: hit targets, icon boxes, control heights.
- Contrast: WCAG 2.x, computed from the final sRGB values for every text-on-surface pair and every essential-UI pair, in each appearance. Composite a translucent layer to its resulting colour first, and over variable content test the lightest and the darkest case.

  ```python
  def lum(hex):
      c = [int(hex[i:i+2], 16) / 255 for i in (1, 3, 5)]
      c = [v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c]
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]

  def contrast(a, b):
      hi, lo = sorted((lum(a), lum(b)), reverse=True)
      return (hi + 0.05) / (lo + 0.05)

  assert round(contrast("#767676", "#ffffff"), 2) == 4.54
  ```

**Built UI against the spec:** render both at the same size, appearance, and data. An image diff (ImageMagick `compare`, pixelmatch) locates drift; you judge whether it matters.

**Redline.** Run every line that applies and record each as pass, open, or n/a.

- **Geometry:** integer viewBox; pixel-fit strokes; one stroke weight and cap style; minimal anchors; no stray transforms or groups; flattened where an outline is required.
- **Layout:** spacing on tokens; alignment edges; radii consistent and concentric; no clipping or overflow at the smallest and largest container; overflow policy holds on long strings.
- **Type:** only defined styles; line-heights on grid; measure in range; tabular numerals where numbers align or update.
- **Colour:** only semantic roles; contrast table complete; dark and high-contrast variants present; no meaning by colour alone.
- **Components:** state matrix complete; stress cases rendered (long text, RTL, 0/1/many, large numbers, missing media, largest text size); focus visible.
- **Apple targets:** text styles and not sizes; Dynamic Type reflow; hit targets; symbols valid for the deployment target; glass rules (`skills/design-craft/references/apple-design.md` in the plugin folder); Reduce Transparency, Increase Contrast, and Reduce Motion; VoiceOver labels and order.
- **Assets:** names, formats, scales, and variants; clean alpha; layers separate.

**Report** defects in one `NOT PASSED` post to the owner, ordered by severity. Each finding gives the location, the expected value with its spec reference, the measured value, and the suggested change. A defect in a deliverable goes to the designer; drift between the spec and the build goes to the worker that built it. When they disagree about which is right, mention the coordinator.

A design piece passes when every redline line that applies is pass or n/a. There is no separate pass post: record it in your `VERIFIED` post, naming each design piece with the renderer, sizes, and appearances you measured it in.

A deliverable marked `UNRENDERED`, or a check you could not render either, is blocked and not passed. Tell the coordinator what is unrendered and what would render it, such as Xcode running with the project open.

> @icons NOT PASSED. `assets/icons/sync.svg`: the arrowhead anchor sits at x=20.37, off the pixel grid (expected an integer for a 2 px stroke, spec section 1); rendered at 24 px the edge blurs. `tokens.json` `text/muted` on `surface/raised` measures 3.9:1 in dark (expected 4.5:1). Snap the anchor to 20 and raise `text/muted` lightness until the dark pair passes.
