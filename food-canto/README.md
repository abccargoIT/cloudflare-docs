# FOOD CANTO — One Brand, Three Experiences

**Made Fresh, Just for Your Order.**

A dependency-free premium website for FOOD CANTO — a family home kitchen —
built as **one brand with three themed experiences**:

| Module | Theme | Palette |
|---|---|---|
| **Food & Orders** | Fresh · homemade · warm | Dark green `#163B2C` · fresh green `#2F6B48` · sage · cream `#F7F2E8` |
| **FOOD CANTO Masala** | Spiced · earthy · artisanal | Spice brown `#4C291A` · saffron `#D79424` · chili `#A83B26` · sand `#F2E3C6` |
| **Ladies Kitchen** | Elegant · welcoming · mature | Plum `#493243` · muted rose `#B77B82` · blush · champagne `#E8D8B7` |

No build step, no framework. Open `index.html`, or deploy the folder as-is
to Cloudflare Pages / Workers Assets / any static host.

```
food-canto/
├── index.html          # Document, all sections, SEO + JSON-LD (business/product/course)
├── css/styles.css      # Master tokens + three theme scopes + motion system
├── js/
│   ├── data.js         # CONTENT LAYER — dishes, products, classes, image map
│   └── app.js          # Mark injection, rendering, motion runtime, WhatsApp enquiry
└── assets/
    ├── logo/           # Reworked FOOD CANTO logo family (9 SVGs, see below)
    └── img/            # Real photography — 27 slots × 2 sizes (WebP) + ATTRIBUTIONS.json
```

## The logo system

A monoline **bowl + steam + leaf** mark ("made fresh, from our pot to your
table") with a Fraunces wordmark. Generated as a brand family in
`assets/logo/`:

`primary.svg` (stacked + tagline) · `horizontal.svg` (header) ·
`compact.svg` (mobile) · `icon.svg` / `favicon.svg` (mark only) ·
`mono-white.svg` · `dark.svg` · `masala.svg` (FOOD CANTO **MASALA**) ·
`ladies.svg` (FOOD CANTO **LADIES KITCHEN**).

The mark is also injected inline (`[data-mark]` in `app.js`) so pages can
recolor it per theme via `currentColor` + `--mark-leaf`.

**Animated logo** — the hero plays a ~2.6 s vector introduction: rim and
bowl strokes draw in, steam rises, the stem grows and the leaf unfolds,
then the wordmark reveals through a mask. Pure SVG + CSS
(`pathLength="1"` dash animation) — no video, transparent background,
responsive. The header mark plays a 0.7 s steam micro-animation on load
and on hover. `prefers-reduced-motion` shows everything instantly.

For packaging/social exports, note the standalone SVGs use live text
(`Fraunces` with a Georgia fallback); outline the text when producing
print-ready files.

## Image content map (all real photography)

Every image slot ships as `assets/img/<slot>-700.webp` + `<slot>-1400.webp`,
rendered with `srcset` + lazy loading (hero is eager + `fetchpriority=high`).
**Sources & licenses per slot: `assets/img/ATTRIBUTIONS.json`** (Unsplash
License and Wikimedia Commons CC works; Commons entries carry artist +
license and are credited in the site footer). Every candidate was visually
reviewed for subject match before selection; mismatches (stock burgers,
commercial packets, unrelated lifestyle) were rejected.

| Slot | Section | Subject |
|---|---|---|
| `hero-food` | Hero | Homemade curries + rice, warm overhead |
| `story-kitchen` | Story | Hands cooking a steaming pan by a window |
| `entrance-food/masala/ladies` | Three worlds | Curry kadai · spice spoons · hands prepping veg |
| `cat-main-dishes` | Food · categories | Kerala fish curry in a clay pot |
| `cat-beef-fry` / `beef-feature` | Food | Kerala beef dry fry (plated / dark editorial pan) |
| `cat-cakes` / `cat-sweets` / `cat-pickles` | Food | Chocolate cake · gulab jamun · cut mango pickle |
| `cat-party-foods` / `party-hero` | Food · party | Sadya on banana leaf · communal sadya service |
| `cat-special` | Food | Biryani plate |
| `hero-masala` | Masala hero | Whole + ground spices flat lay |
| `masala-garam` / `masala-chili` / `masala-sambar` | Masala products | Ground garam masala pan · dried red chillies · idli-sambar |
| `masala-ingredients` / `masala-macro` | Ingredient story | Whole nutmeg/cardamom/cinnamon · star anise macro |
| `hero-ladies` | Ladies hero | Woman cooking at her home stove |
| `class-traditional/baking/masala/sweets` | Class cards | Thali · artisan loaves · mortar & pestle · laddu batch |
| `ladies-community` / `ladies-online` | Community | Shared table overhead · woman in online session |

**To use FOOD CANTO's own photography** (always Priority 1): replace the
two WebP files for a slot and update its `alt` in `js/data.js` — no other
changes needed. Crops adapt via `object-fit: cover` + per-breakpoint aspect
ratios (hero: 4/5 desktop column, 16/10 tablet, 4/5 small mobile).

## Three-theme architecture

Components read only `--t-*` tokens (`--t-bg`, `--t-surface`, `--t-primary`,
`--t-secondary`, `--t-accent`, `--t-ink`, `--t-border`, `--t-tint`,
`--t-deep`, `--mark-leaf`…). Each module rebinds them via
`[data-theme="food|masala|ladies"]` — no hardcoded colors in components.

**Theme transitions** are gradual, never a hard switch: `.theme-bridge`
bands interpolate the background from one world's palette to the next
(cream → sand → blush), carrying parallax ingredient marks and an italic
line of copy; module lockups re-introduce the brand in each world's colors.

**Motion character per module** (same DNA, different accent):
Food — soft & fluid (default tempo). Masala — grounded: shorter rise,
quicker settle. Ladies — graceful: longer, calmer movement. Implemented by
rebinding `--reveal-shift` / `--dur-medium` per theme scope.

## Motion system

Tokens: `--dur-micro` 200 ms (hovers, taps) · `--dur-medium` ~550 ms
(cards, reveals) · `--dur-cine` 1100 ms (hero) · logo intro ~2.6 s.
One easing family (`--ease-soft`/`--ease-swift`). Reveal vocabulary:
masked hero lines, clip wipes (left/right), blur-scale, staggered cards,
step-dot choreography. Native scrolling is never hijacked — fluidity comes
from lerped parallax. Full `prefers-reduced-motion` fallback (CSS + JS).

## Conversion

CTAs at every stage: Explore Our Food / Order · Enquire (hero), per-world
CTAs, Pre-order It (signature), Plan a Party Order, Ask for a Jar (masala),
Register Interest (classes). The enquiry form has an intent selector
(Food / Party / Masala / Class); food intents enforce the 15-portion
minimum and date, and every submission opens WhatsApp with a structured
message. Mobile gets a sticky bar: **Food | Masala | Classes** module
pills (current module highlighted in its theme color) + WhatsApp.

## Performance, accessibility, SEO

- ~27 optimized WebP images (two responsive sizes each), lazy below the
  fold, preloaded hero; inline SVG logo/icons; zero JS/CSS dependencies.
- Animations use only transform/opacity/clip-path; one self-suspending rAF
  loop for parallax.
- Semantic landmarks, one `h1`, keyboard/Escape support, focus-visible,
  alt text on every image, `<noscript>` fallback, 44 px+ touch targets.
- SEO: per-area copy (homemade food, party orders, homemade masala, ladies
  cooking classes), Open Graph/Twitter with real food image, JSON-LD graph:
  `FoodEstablishment` + `Product` (Masala) + `Course` (Ladies classes).

## Go-live checklist

1. `js/data.js` → set the real WhatsApp number and email.
2. `index.html` → replace `https://foodcanto.example/` (canonical, OG, JSON-LD).
3. Replace interim photography with FOOD CANTO's own shots (see image map);
   the footer attribution line can then be removed.
4. Prices/products/classes: edit `js/data.js` only.

## Future scalability

The data shape is the contract: masala/pantry products carry
id/price/weight/availability (ecommerce-ready), classes carry full
scheduling metadata (booking-ready). A CMS/API only needs to serve the
`FOODCANTO` object. Forms currently deep-link to WhatsApp; when moving to a
server endpoint, add server-side validation, rate limiting (Turnstile),
and keep secrets in environment variables. Each `render*` function maps
1:1 to a future framework component; theme tokens map to a Tailwind theme.
