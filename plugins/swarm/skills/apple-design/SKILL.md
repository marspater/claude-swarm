---
name: apple-design
description: "Only for swarm:designer, and only when the design target is macOS, iOS, or iPadOS. Complements swarm:design-craft with native rules: HIG idiom, Liquid Glass, SF Symbols, Dynamic Type, semantic colors, app icons, and SwiftUI/AppKit-ready specs. Not for web or other platforms."
user-invocable: false
---

# Apple platform design

Native first. The system's components, metrics, materials and text styles are the design system. Custom work is the exception and has to buy something specific.

This skill complements `swarm:design-craft` and applies only when the design target is macOS, iOS, or iPadOS. Its rules override `design-craft` where they conflict.

Version check before relying on details: confirm the project's deployment target, and look up anything version-sensitive in the current HIG and SDK documentation (Xcode's documentation search, if connected). Liquid Glass has been retuned in every release since 26, so treat section 5 as principles and verify API names and behaviour.

## 1. Order of preference

1. Standard component, standard configuration.
2. Standard component styled through its supported API (`buttonStyle`, `controlSize`, `tint`, `listStyle`, `labelStyle`).
3. A composition of standard components.
4. A custom component, with a written reason, a full state matrix, and accessibility parity (role, label, traits, keyboard, Dynamic Type).

## 2. Metrics

- Units are points. Do not carry web px values or an 8-pt rule into native specs. System metrics (44, 20, 17, 13, 11) are not on an 8 grid and are correct.
- Prefer system-supplied spacing over literals: default stack spacing, `.padding()` with no value, `scenePadding`, `contentMargins`, `safeAreaInset`, list and form insets. Literal values come from the spacing tokens and are for custom layouts only.
- Hit targets: at least 44x44 pt on iOS and iPadOS. The visual can be smaller; extend the hit area with `contentShape`. macOS follows control sizes (`mini` to `extraLarge`); do not inflate Mac controls to 44.
- Hairlines are 1 device pixel (`1 / displayScale`), not 1 pt.
- Corners use continuous curvature; specify the corner style explicitly. An SVG `rx` arc is circular and will not match, so mock with the real shape or note the difference.
- Nested corners are concentric. On 26 and later use the system's concentric shape and container-shape APIs instead of hand-computed radii.

## 3. Typography

- Specify text styles, not sizes.
  - iOS at the default size: largeTitle 34, title 28, title2 22, title3 20, headline 17 semibold, body 17, callout 16, subheadline 15, footnote 13, caption 12, caption2 11.
  - macOS: largeTitle 26, title 22, title2 17, title3 15, headline 13 bold, body 13, callout 12, subheadline 11, footnote 10, caption 10.
- Never port iOS sizes to macOS or the reverse.
- On iOS and iPadOS every text style scales with Dynamic Type through the accessibility sizes. Design for it: layouts reflow at large sizes (`ViewThatFits`, `AnyLayout`, switching stack axis), no fixed-height text containers, custom fonts scale with `Font.custom(_:size:relativeTo:)`, custom metrics with `@ScaledMetric`.
- The system font handles optical size and tracking itself. Do not set tracking on system text styles. Prefer weight for emphasis over size. Use `.monospacedDigit()` for numbers that change in place.
- Custom typefaces are for brand moments. Body text and controls stay on the system font unless there is a strong reason.

## 4. Color and materials

- Semantic first: `.primary`, `.secondary`, `.tertiary` foreground styles, the accent/tint colour, system background and fill colours, the separator colour. They already adapt to light and dark, increased contrast, vibrancy and platform.
- Custom colours live in the asset catalog as colour sets with Any and Dark appearances, plus High Contrast variants wherever the standard pair fails contrast. Name them by role (`surfaceRaised`), not by hue. Views reference names only, never literals.
- Deliver the token table as: role, then light / dark / high-contrast light / high-contrast dark, in sRGB hex with the OKLCH source.
- Contrast: the HIG minimums are 4.5:1 for text up to 17 pt, and 3:1 at 18 pt and above or at 14 pt and above when bold. Default to 4.5:1 for all text and treat 3:1 as the exception. Verify every text-on-surface pair in every appearance.
- Text on a material or on glass has no single background. Test it over the lightest and the darkest content it can sit on.
- In dark appearance, base and elevated levels differ (elevated surfaces are lighter). Do not flatten them.

## 5. Liquid Glass (26 and later)

- Glass is the functional layer that floats above content: bars, toolbars, tab bars, sidebars, floating controls, sheets. Content itself is not glass.
- Standard bars, sheets and controls adopt the material automatically when built with the current SDK. The first move is to remove custom backgrounds, blurs and borders that fight it, not to add effects.
- Custom glass is rare: `glassEffect` on a small number of floating controls, grouped in a `GlassEffectContainer` so they blend and morph together. Never glass on glass. Never glass for decoration, for cards in a scrolling list, or for large content panels.
- Tint glass only to carry meaning (primary action, state), not as a brand wash.
- Legibility is the designer's job. Check controls over busy, bright and dark content. Rely on scroll edge effects, not hard dividers or opaque bars.
- Test with Reduce Transparency, Increase Contrast and Reduce Motion, and with the user's system transparency setting at both extremes. The design has to hold with glass effectively off.
- For deployment targets before 26, specify the fallback explicitly (standard materials such as `.bar` and `.regularMaterial`). Do not leave it to the implementer.

## 6. SF Symbols and icons

- UI icons are SF Symbols first. Specify name, rendering mode (monochrome, hierarchical, palette, multicolor), variant (`.fill`, `.circle`) and scale. Size comes from the adjacent text style (`font`, `imageScale`), not from a frame.
- Symbols are versioned. Check availability against the deployment target and supply a fallback or a custom symbol for older systems.
- Do not use a symbol against its meaning. Symbols that depict Apple products or features cannot be repurposed (licence restriction).
- Custom symbol: start from the SF Symbols app template of the closest existing symbol, draw to its guides (baseline, cap height, margins), supply the weights and scales interpolation needs, use flattened paths only (see booleans in `design-craft`), and annotate layers for hierarchical, palette and variable-color rendering. Validate the template in the SF Symbols app.
- Symbol animation: use built-in symbol effects and content transitions, not hand-built animation.
- App icon: layered artwork composed in Icon Composer. Supply a 1024 canvas with layers as separate SVGs (a background plus grouped foreground layers). No baked mask, corner radius, shadow, gloss or blur: the system applies the shape and the glass. Simple, bold, centred shapes and few layers. Check the default, dark and mono/tinted renderings, and check small sizes.
- Icon Composer and the SF Symbols app are GUI tools. Prepare files to spec and state that in-app assembly and validation is still pending, unless you actually performed it.

## 7. Platform idiom

**macOS**
- Windows resize. Specify min, ideal and max size and what flexes. Sidebar, content and inspector map to `NavigationSplitView` plus `.inspector`.
- Every action is reachable from the menu bar, with a keyboard shortcut where one is conventional. The toolbar holds the frequent actions. Context menus mirror functionality and never hide it.
- Pointer and keyboard are first-class: hover states, focus ring, full keyboard navigation, tooltips (`.help`), drag and drop, multiple selection.
- Density is higher: body 13, compact controls, tables with sortable columns. Do not ship a scaled-up iPhone layout.
- Settings live in a `Settings` scene. No hamburger menus, no bottom tab bars, no full-width iOS-style buttons.

**iOS and iPadOS**
- Respect safe areas and both size classes. Keep primary actions within thumb reach. Tab bar for top-level sections (keep it short), `NavigationStack` for depth, sheets with detents for transient tasks.
- Standard gestures stay standard: edge-swipe back, pull to refresh, swipe actions. Every gesture has a visible alternative.
- iPad windows resize freely. Treat width as continuous, not as two device classes.

**Both**
- Motion uses springs (`.smooth`, `.snappy`, `.bouncy`, or an explicit `spring(duration:bounce:)`), specified by parameters. Under Reduce Motion, replace movement with a cross-fade.
- Accessibility is part of the spec: VoiceOver label, value, hint and reading order; traits; Dynamic Type behaviour; contrast; Differentiate Without Color; Bold Text; RTL mirroring; localization growth.

## 8. Spec format for Swift implementers

Deliver what an engineer can implement without guessing, and nothing that pretends to be production code.

- Layout tree in SwiftUI vocabulary: container type, alignment, spacing (a token, or `system`), padding, sizing rule (`fixedSize`, `frame(min/ideal/max)`, `layoutPriority`).
- Per element: text style, foreground style or colour role, symbol spec, shape and corner style, material.
- States and transitions, with animation parameters.
- Asset list: catalog names, variants, export sizes.
- Accessibility table.
- A reference `#Preview` file when asked for, or when words would be ambiguous: self-contained, sample data only, no app architecture, clearly marked as reference. The implementer owns the production view.
- Preview matrix to render for sign-off: light and dark, default and one accessibility Dynamic Type size, longest locale and RTL, minimum and ideal window or device size.