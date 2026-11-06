# iTunes cover get

Search official covers for books, music albums and TV seasons in SiYuan, then **insert them into the document** or **set them as the document icon**. Data comes from the Apple iTunes Search API — no key, no registration.

CJK keywords work as-is (search 三体 or 球状闪电 directly). Book and album covers are mostly 1:1, TV seasons are 16:9; the panel shows them in one container so nothing gets squashed.

## Usage

The entry is a **five-pointed star icon**, available in several places:

- **Top bar** — the star in the top-right toolbar
- **Emoji panel** — open the emoji picker from the document icon; there is an extra star at the end of its header row. It switches in place, with its own search box and small chips. **What clicking does depends on how the panel was opened**:
  - opened from the **document title icon** → the chosen cover **replaces the document icon**
  - opened from **insert emoji in the body** → the chosen cover is **inserted at the cursor**
- **Bottom bar** — the star in the editor breadcrumb (if your theme moves the breadcrumb to the bottom, it's in that floating pill)
- **Command palette** — "Open iTunes cover get". No default hotkey; bind one in Settings → Keymap if you want

You can also right-click the icon next to the document title.

The cursor starts in the search box. Search runs against a remote API, so it fires on **Enter**, not per keystroke. It opens on "All" (books / albums / TV, 12 each); the chips narrow it to one type (36).

- **Left click a card** — insert the cover at the cursor
- **Hover, then click the top-right button** — set it as the document icon
- **Right click a card** — both actions in a menu
- **Esc** — clears the search box first, closes the panel on the second press

## Known limits

- **No movies.** Apple stopped supplying iTunes movie data, and TV search only covers `tvSeason`. Some shows simply aren't in the US storefront (Stranger Things, for one) — the TV column comes back empty for those.
- **"Search failed" now and then.** The iTunes API rate-limits and times out occasionally; wait a few seconds and retry.
- Search is pinned to the US storefront (`country=us`); the CN storefront returns no ebooks.
- Inserted covers are saved to `assets/iTunes-covers/`, so they travel with the document on export.

## How it works

Document icons are written to `data/emojis/iTunes-covers/`, the same place SiYuan keeps custom emoji, so they sync with the workspace and work across devices. Covers are fetched **on demand** — only the ones you actually pick get downloaded, and reusing the same title never uploads twice.

## License & attribution

- Plugin code: MIT
- Cover images are served by Apple's CDN and belong to their respective owners. They are used solely for document identification and imply no affiliation or endorsement.
