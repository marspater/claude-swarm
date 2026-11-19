# Liquid Glass implementation detail (26 and later)

Supplement to section 5 of `apple-design.md`, which holds the rules for where glass belongs. This file holds what changed between releases and the API patterns a spec should name. Check exact signatures against the project's SDK before you put one in a spec.

## 1. What changed by release

- **26.0:** glass on every platform, a transparent macOS menu bar, floating tab bars and sidebars, concentric shapes. `UIDesignRequiresCompatibility` was a temporary opt-out.
- **26.x:** a user setting, Clear or Tinted, and a retuned dark appearance.
- **27:**
  - The setting became a continuous transparency slider. A spec has to hold at both ends of it, not only at the default.
  - Glass borders are sharper and dark glass is lighter.
  - `UIDesignRequiresCompatibility` is deprecated, so there is no opt-out on the current SDK.
  - New: `@Environment(\.appearsActive)` for dimming custom glass in an inactive window, `TabsPickerStyle` to keep a segmented picker distinct from navigation tabs, and macOS menu bar items that show the icon alone unless you ask for `.labelStyle(.titleAndIcon)`.

## 2. Standard chrome first (SwiftUI)

Remove custom bar backgrounds and borders and let the system containers supply glass, scroll-edge softening and tab minimization.

```swift
TabView {
    Tab("Library", systemImage: "books.vertical") {
        NavigationStack {
            ScrollView {
                HeroArtwork().backgroundExtensionEffect()   // full-bleed art continues under the chrome
                ContentList()
            }
            .scrollEdgeEffectStyle(.soft, for: .all)
            .toolbar {
                ToolbarItem(placement: .primaryAction) { Button("Add", systemImage: "plus") { addItem() } }
                ToolbarSpacer(.fixed)                        // splits the shared glass capsule
                ToolbarItem(placement: .topBarTrailing) { ProfileAvatarButton() }
                    .sharedBackgroundVisibility(.hidden)     // an avatar or badge sits outside the capsule
            }
        }
    }
    Tab("Search", systemImage: "magnifyingglass", role: .search) { SearchView() }
}
.tabBarMinimizeBehavior(.onScrollDown)
.tabViewBottomAccessory { NowPlayingAccessory() }
```

An accessory reads `@Environment(\.tabViewBottomAccessoryPlacement)` and drops its secondary content when the placement is `.inline`. Specify both states.

## 3. Custom floating controls (SwiftUI)

- Put neighbouring custom glass in one `GlassEffectContainer`, so the pieces render in one pass, share shadows and morph into each other.
- Apply `.glassEffect(_:in:)` after the padding and sizing modifiers.
- Variants: `.regular` for chrome; `.clear` only over rich media, with a dimming scrim if text needs it. Never the two side by side.
- `.buttonStyle(.glass)` for ordinary actions and `.glassProminent` or `.tint(_:)` for the one primary action or the active state.
- `glassEffectID(_:in:)` lets controls morph as they appear and disappear. `glassEffectUnion(id:namespace:)` joins adjacent controls into one permanent shape, such as a zoom stack.
- From 27, dim a custom cluster in an inactive window with `appearsActive`.

```swift
GlassEffectContainer(spacing: 24) {
    HStack(spacing: 12) {
        if isExpanded {
            Button("Share", systemImage: "square.and.arrow.up") { share() }
                .buttonStyle(.glass)
                .glassEffectID("share", in: glassNS)
        }
        Button(isExpanded ? "Close" : "Actions", systemImage: isExpanded ? "xmark" : "ellipsis") {
            withAnimation(.snappy) { isExpanded.toggle() }
        }
        .buttonStyle(.glassProminent)
        .glassEffectID("toggle", in: glassNS)
    }
    .opacity(appearsActive ? 1 : 0.7)
}
```

Nested corners share a centre. Use the concentric shape and do not compute an inner radius by hand:

```swift
ContentPreview()
    .clipShape(ConcentricRectangle(corners: .concentric(minimum: 12), isUniform: true))
    .padding(12)
    .containerShape(.rect(cornerRadius: 24))
```

## 4. Fallback before 26

When the deployment target is below 26, name the fallback in the spec and keep it behind one modifier:

```swift
extension View {
    @ViewBuilder
    func floatingControlSurface(prominent: Bool = false) -> some View {
        if #available(iOS 26, macOS 26, *) {
            glassEffect(prominent ? .regular.tint(.accentColor).interactive() : .regular.interactive(), in: .capsule)
        } else {
            background(prominent ? AnyShapeStyle(.tint) : AnyShapeStyle(.regularMaterial), in: .capsule)
        }
    }
}
```

## 5. AppKit and UIKit

- **AppKit (macOS 26):** `NSGlassEffectView` for a custom floating surface (`contentView`, `cornerRadius`, `style`, `tintColor`). Group adjacent ones in `NSGlassEffectContainerView`. The view calms itself when its window loses key status; do not override that.
- **UIKit (iOS and iPadOS 26):** `UIGlassEffect` in a `UIVisualEffectView`. Group neighbours in `UIGlassEffectContainerView`.

## 6. Reject on review

- A list row, card, form section or full-screen panel made of glass.
- `.glassEffect()` inside a bar, sheet or popover that is already glass.
- `.regular` and `.clear` next to each other.
- Separate glass views side by side with no shared container.
- Every bar and button tinted with the brand colour.
- Mismatched nested radii, such as a 12 pt corner inside a 28 pt sheet with 8 pt padding.
- Text that is legible over one wallpaper only. It has to pass over white, black and a busy photo, in light and dark, at both ends of the transparency slider, and with Reduce Transparency and Increase Contrast.
- Bright floating controls in an inactive window.

Apple's worked example is the Landmarks sample, "Landmarks: Building an app with Liquid Glass", in the SwiftUI documentation.
