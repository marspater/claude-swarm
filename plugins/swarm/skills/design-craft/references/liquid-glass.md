# Liquid Glass Design & Implementation Reference (26+)

Supplement to `apple-design.md` (section 5). Covers authoritative Apple references, release changes from iOS/iPadOS/macOS 26 through 27, shipped apps worth studying, idiomatic implementation patterns across SwiftUI, AppKit, and UIKit, and the visual criteria that separate crisp Liquid Glass from muddy glass.

Verify exact symbol signatures against the project's active SDK (Xcode documentation search if connected) before emitting production specs.

---

## 1. Official Apple References

### Documentation & Sample Code
- **Adopting Liquid Glass** (`developer.apple.com/documentation/TechnologyOverviews/adopting-liquid-glass`) — migration guide across SwiftUI, UIKit, and AppKit: letting system chrome adopt glass automatically, stripping conflicting opaque backgrounds, edge-to-edge layout, and toolbar/sidebar updates.
- **Landmarks: Building an app with Liquid Glass** (`developer.apple.com/documentation/swiftui/landmarks-building-an-app-with-liquid-glass`) — Apple's primary multi-platform SwiftUI reference app. Study it for `backgroundExtensionEffect()`, floating sidebars/inspectors, concentric geometry, custom `.glassEffect()`, and `GlassEffectContainer` morphing.
- **Applying Liquid Glass to custom views** (SwiftUI documentation) — `.glassEffect(_:in:)`, `Glass` variants (`.regular`, `.clear`, `.identity`), `.tint(_:)`, `.interactive(_:)`, `GlassEffectContainer`, `glassEffectID(_:in:)`, and `glassEffectUnion(id:namespace:)`.
- **Human Interface Guidelines — Materials** (`developer.apple.com/design/human-interface-guidelines/materials`) — layer hierarchy (content layer vs. floating functional glass layer), legibility over bright/dark/busy backdrops, and accessibility adaptations.
- **Icon Composer** — Apple's macOS tool for authoring layered `.icon` artwork (flat SVG/PNG foreground, midground, and background layers) that renders live refraction across Default, Dark, Clear, and Tinted appearances.

### WWDC25 Core Sessions (26 Baseline)
| Session | Title | Study for |
| --- | --- | --- |
| **WWDC25 219** | *Meet Liquid Glass* | Optical principles, lensing/refraction physics, `.regular` vs. `.clear` rules, why glass never stacks on glass |
| **WWDC25 356** | *Get to know the new design system* | Unified cross-platform layout language, concentric curvature, updated window/bar/sheet hierarchy |
| **WWDC25 323** | *Build a SwiftUI app with the new design* | `GlassEffectContainer`, `tabBarMinimizeBehavior`, `tabViewBottomAccessory`, `ToolbarSpacer`, `backgroundExtensionEffect`, *Landmarks* walkthrough |
| **WWDC25 310** | *Build an AppKit app with the new design* | macOS Tahoe window chrome, floating sidebars, `NSGlassEffectView`, `NSGlassEffectContainerView`, scroll-edge effects |
| **WWDC25 284** | *Build a UIKit app with the new design* | `UIGlassEffect`, `UIGlassEffectView`, `UIGlassEffectContainerView`, `glassEffectID`, tab/bar transitions |
| **WWDC25 361** | *Create icons with Icon Composer* | Multi-layer icon structure, specular rim lighting, Clear/Tinted/Dark variants without baked masks or shadows |

---

## 2. Release Evolution (26 → 26.x → 27)

Liquid Glass has been retuned significantly since its initial 26 debut. Design for the full range the user can configure:

- **26.0 (iOS 26 / iPadOS 26 / macOS 26 Tahoe):** Introduced Liquid Glass across all platforms, transparent macOS menu bar, floating pill tab bars and sidebars, concentric shapes, and `UIDesignRequiresCompatibility` as a temporary opt-out.
- **26.x point releases:** Added user-facing **Clear vs. Tinted** display preference and refined dark-mode elevation after early legibility feedback on bright and busy backgrounds.
- **27 (iOS 27 / iPadOS 27 / macOS 27, WWDC26):**
  - Replaced the binary Clear/Tinted toggle with a continuous system transparency slider (`Settings > Appearance > Liquid Glass`) from ultra-clear to fully tinted. **Implication:** specs must hold at *both* slider extremes, not just the default.
  - Sharper, more defined glass borders and lighter dark-mode glass for stronger contrast (notably on sheet dismiss controls and floating pills).
  - Deprecated `UIDesignRequiresCompatibility` — Liquid Glass adoption is mandatory on current SDKs.
  - Added `@Environment(\.appearsActive)` in SwiftUI so custom glass controls dim cleanly in inactive iPad/Mac windows, `TabsPickerStyle` to keep segmented pickers distinct from navigation tabs, and minimal-by-default macOS menu bar icons (opt in with `.labelStyle(.titleAndIcon)`).

---

## 3. Shipped Apps Worth Studying (What Each Gets Right)

Use these as concrete benchmarks by pattern — study the *structural restraint*, not just the sheen.

### Apple First-Party Benchmarks
- **Apple Music (iOS / macOS):** Textbook `tabViewBottomAccessory` + `tabBarMinimizeBehavior(.onScrollDown)` pairing. The Now Playing bar floats cleanly above the tab bar (`.expanded`) and collapses inline when scrolling (`.inline`), refracting album art without muddying track titles.
- **Apple Weather:** Full-bleed live atmospheric canvas with floating glass controls and cards separated cleanly by scroll-edge softening; demonstrates how legible typography stays razor-sharp over shifting light/dark skies.
- **Apple Podcasts (App Icon & Chrome):** Reference example for Icon Composer multi-layer depth (distinct background, midground, and foreground geometry reacting to specular light) plus minimal navigation chrome.

### Third-Party & Indie Benchmarks
| App | Platform | Pattern to study | Why it works |
| --- | --- | --- | --- |
| **Things** | macOS / iOS / iPadOS | *Restraint in dense productivity UI* | Confines Liquid Glass strictly to the collapsible sidebar, top toolbar, and quick-entry sheets. The task list itself stays solid, calm, and high-contrast — zero glass-on-content clutter. |
| **Flighty** | iOS / macOS | *Floating data overlays over maps & timelines* | Bottom action sheets and status pills refract live flight maps and dark/light airport layouts underneath, while critical gate/time numbers stay crisp with strong typographic hierarchy and tabular digits. |
| **Halide** | iOS | *Optical instrument controls* | Floating exposure rings and capture controls behave like physical glass lenses over the camera viewfinder — matching material metaphor to domain without obstructing composition. |
| **Darkroom** | iOS / iPadOS / macOS | *Edge-to-edge creative canvas* | Editing sliders, toolbars, and histogram overlays float over full-bleed photography so color-grading surfaces get maximum breathing room and zero heavy opaque chrome. |
| **Craft** | macOS / iOS / iPadOS | *Contextual morphing toolbars* | Sidebar and floating formatting bars act like grouped `GlassEffectContainer` clusters: tools surface only on selection and refract the document cleanly without fighting body text. |
| **Art of Fauna** | iOS / iPadOS | *Tactile glass over rich illustration* | Translucent menu/navigation buttons let intricate 18th-century artwork softly refract behind controls while preserving effortless legibility and playful tactility. |
| **Slopes** | iOS | *Floating metric pills over terrain* | Compact glass metric capsules float above maps and elevation profiles without turning entire data tables into glass. |
| **Gentler Streak** | iOS | *Semantic tinting* | Uses tinted glass sparingly on bottom bars and sheets to reflect active workout state — tint carries meaning rather than acting as a blanket brand wash. |
| **ScreenFloat** | macOS | *Native Tahoe floating panels* | Aligns floating screenshot panels with Tahoe's concentric corner radii, shadow depth, and active/inactive window treatment so utility panels feel OS-native. |
| **Overcast** / **Lumy** / **CARROT Weather** / **Ivory** | iOS / macOS | *Targeted glass accents* | Keep dense feeds, dials, and timelines clean; reserve glass for playback bars (Overcast), sun-tracking dials (Lumy), adaptive widgets/chrome (CARROT), and compact popovers/tabs (Ivory). |

---

## 4. Idiomatic Implementation Blueprints

### A. SwiftUI — Standard Chrome First (iOS/iPadOS/macOS 26+)
Remove custom bar backgrounds and borders; let system containers handle glass, scroll-edge softening, and tab minimization:

```swift
TabView {
    Tab("Library", systemImage: "books.vertical") {
        NavigationStack {
            ScrollView {
                // Full-bleed hero extends beneath chrome cleanly
                HeroArtwork()
                    .backgroundExtensionEffect()

                ContentList()
            }
            .scrollEdgeEffectStyle(.soft, for: .all)
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button("Add", systemImage: "plus") { addItem() }
                }
                ToolbarSpacer(.fixed)
                ToolbarItem(placement: .primaryAction) {
                    Button("Filter", systemImage: "line.3.horizontal.decrease") { toggleFilter() }
                }
                // Detach a standalone avatar/badge from the shared glass capsule
                ToolbarItem(placement: .topBarTrailing) {
                    ProfileAvatarButton()
                }
                .sharedBackgroundVisibility(.hidden)
            }
        }
    }
    Tab("Search", systemImage: "magnifyingglass", role: .search) {
        SearchView()
    }
}
.tabBarMinimizeBehavior(.onScrollDown)
.tabViewBottomAccessory {
    NowPlayingAccessory()
}
```

Adaptive accessory reacting to collapsed vs. expanded placement:

```swift
struct NowPlayingAccessory: View {
    @Environment(\.tabViewBottomAccessoryPlacement) private var placement

    var body: some View {
        HStack(spacing: 12) {
            ArtworkThumb()
            VStack(alignment: .leading) {
                Text(track.title).font(.subheadline.weight(.semibold))
                if placement == .expanded {
                    Text(track.artist).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            Button(action: togglePlay) {
                Image(systemName: isPlaying ? "pause.fill" : "play.fill")
            }
        }
        .padding(.horizontal, 12)
    }
}
```

### B. SwiftUI — Custom Floating Control Cluster & Morphing
Always group nearby custom glass elements in one `GlassEffectContainer` so they render in a single pass and blend/morph cleanly. Apply `.glassEffect(...)` *after* padding/sizing modifiers:

```swift
struct FloatingActionCluster: View {
    @Namespace private var glassNS
    @Environment(\.appearsActive) private var appearsActive
    @State private var isExpanded = false

    var body: some View {
        GlassEffectContainer(spacing: 24) {
            HStack(spacing: 12) {
                if isExpanded {
                    Button("Share", systemImage: "square.and.arrow.up") { share() }
                        .buttonStyle(.glass)
                        .glassEffectID("share", in: glassNS)

                    Button("Bookmark", systemImage: "bookmark") { bookmark() }
                        .buttonStyle(.glass)
                        .glassEffectID("bookmark", in: glassNS)
                }

                Button(isExpanded ? "Close" : "Actions",
                       systemImage: isExpanded ? "xmark" : "ellipsis") {
                    withAnimation(.snappy) { isExpanded.toggle() }
                }
                .buttonStyle(.glassProminent)
                .glassEffectID("toggle", in: glassNS)
            }
            .opacity(appearsActive ? 1.0 : 0.7) // Dim cleanly in inactive iPad/Mac windows (27+)
        }
    }
}
```

Permanent union of adjacent controls into one continuous glass shape (e.g., floating map/zoom stack):

```swift
GlassEffectContainer {
    VStack(spacing: 0) {
        Button("Zoom In", systemImage: "plus") { zoomIn() }
            .buttonStyle(.glass)
            .glassEffectUnion(id: "zoomControls", namespace: glassNS)

        Button("Zoom Out", systemImage: "minus") { zoomOut() }
            .buttonStyle(.glass)
            .glassEffectUnion(id: "zoomControls", namespace: glassNS)
    }
}
```

Concentric nested geometry (no hand-computed inner radius drift):

```swift
VStack {
    ContentPreview()
        .clipShape(ConcentricRectangle(corners: .concentric(minimum: 12), isUniform: true))
}
.padding(12)
.containerShape(.rect(cornerRadius: 24))
```

### C. Pre-26 Deployment Target Fallback
When supporting iOS/macOS 18 alongside 26+, isolate the material behind a small modifier so views stay declarative and the fallback is explicit:

```swift
extension View {
    @ViewBuilder
    func floatingControlSurface(prominent: Bool = false) -> some View {
        if #available(iOS 26, macOS 26, *) {
            if prominent {
                self.glassEffect(.regular.tint(.accentColor).interactive(), in: .capsule)
            } else {
                self.glassEffect(.regular.interactive(), in: .capsule)
            }
        } else {
            self.background(prominent ? AnyShapeStyle(.tint) : AnyShapeStyle(.regularMaterial), in: .capsule)
        }
    }
}
```

### D. AppKit (macOS 26 Tahoe+)
- Use `NSGlassEffectView` for custom floating surfaces (`contentView`, `cornerRadius`, `style` `.regular` / `.clear`, `tintColor`, `effectIsInteractive`).
- Wrap clusters of adjacent `NSGlassEffectView` instances inside `NSGlassEffectContainerView` so edges merge cleanly and composite in one batch.
- Let `NSWindow` key-state handling run automatically: `NSGlassEffectView` transitions to a calmer, more opaque state when its host window loses key status. Do not fight it with forced active overrides.

### E. UIKit (iOS / iPadOS 26+)
- Pair `UIGlassEffect` (`.regular` / `.clear`) with `UIGlassEffectView` (or `UIVisualEffectView` configured with `UIGlassEffect`).
- Group neighboring floating controls inside `UIGlassEffectContainerView` and assign `glassEffectID` to animate morph transitions across layout states.

---

## 5. Open-Source Code References

Real repositories focused on native 26+ Liquid Glass APIs (good for checking modifier ordering, container spacing, and transitions):
- **Apple `Landmarks`** — official SwiftUI multi-platform sample (*Landmarks: Building an app with Liquid Glass*).
- **`veersr9/Liquid-Glass-Reference`** — navigation-layer playground covering `GlassEffectContainer`, `glassEffectUnion`, `glassEffectTransition(.materialize)`, and tab bar accessories.
- **`mertozseven/LiquidGlassSwiftUI`** — full-bleed backdrop + expandable action cluster using `.glassEffect()`, `GlassEffectContainer`, and `.glassEffectID(_:in:)`.
- **`swiftandcurious/DesignExploration`** — tutorial repo for modern `TabView` minimization, search roles, mini-players, and grouped glass controls.
- **`mizadi/LiquidGlassExamples`** — custom shapes, interactive/tinted variants, and icon clusters over high-contrast gradients.

---

## 6. Beautiful vs. Broken Liquid Glass (Design Review Bar)

Use this checklist when designing or redlining any 26+ Apple surface:

| Signal of great Liquid Glass | Anti-pattern (reject and redesign) |
| --- | --- |
| **Strict layer separation:** glass floats *only* on navigation, toolbars, sidebars, and compact floating controls; content scrolls cleanly underneath. | Turning list rows, document cards, form sections, or full-screen panels into glass. |
| **Zero glass-on-glass:** controls inside a glass bar use plain glyphs, fills, or subtle highlights. | Nesting `.glassEffect()` inside a toolbar, sheet, or popover that is already glass — produces muddy double-refraction. |
| **One consistent variant per region:** `.regular` for general chrome; `.clear` only over rich media/photography with a subtle dimming scrim if needed. | Mixing `.regular` and `.clear` directly adjacent to each other. |
| **Container-grouped clusters:** neighboring floating pills share a `GlassEffectContainer` so shadows, lensing, and morph animations unify. | Independent `.glassEffect()` views stacked side-by-side with clashing halos and abrupt fade transitions. |
| **Semantic tinting only:** `.tint(...)` / `.glassProminent` marks one primary action or active state. | Tinting every bar and button with the brand color, erasing visual hierarchy. |
| **True concentric curvature:** nested pills/cards use `ConcentricRectangle` / `containerShape` so corner curves share a center. | Arbitrary mismatched radii (`cornerRadius: 12` inside a `28` sheet with `8` padding). |
| **Survives every legibility mode:** passes WCAG contrast over bright white, pitch black, and busy photography, in Light + Dark, with the 27 transparency slider at both extremes, Reduce Transparency, and Increase Contrast. | Legible only over one curated dark wallpaper at default transparency. |
| **Native inactive-window calm (macOS/iPadOS):** inactive windows settle down via system glass behavior and `appearsActive`. | Bright, saturated floating pills screaming for attention from background windows. |
