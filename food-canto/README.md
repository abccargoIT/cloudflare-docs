# FOOD CANTO — Premium Home Kitchen Website

**Made Fresh, Just for Your Order.**

A dependency-free, single-page premium website for FOOD CANTO — a family
home kitchen offering pre-order homemade food, cakes, sweets, pickles,
masala products, party/celebration orders and online cooking classes.

No build step, no framework, no npm install. Open `index.html` in a
browser, or deploy the `food-canto/` folder as-is to Cloudflare Pages,
Workers Assets, or any static host.

```
food-canto/
├── index.html      # Document shell, all sections, SVG icon system, SEO/JSON-LD
├── css/styles.css  # Design system + components + motion states + responsive
└── js/
    ├── data.js     # CONTENT LAYER — everything the kitchen edits lives here
    └── app.js      # Rendering from data + motion runtime + interactions
```

## Why no framework?

The master brief asks for the *smallest sensible stack*. This site has one
page, no client-side routing, and no server state — a Next.js/React setup
would add ~90 KB of framework to ship what 12 KB of hand-written JS does.
The architecture is deliberately shaped so a later migration to
Next.js/Astro is mechanical (see "Future scalability").

---

## A. Website architecture

Single scrolling page with anchor navigation, in conversion order:

| # | Section | ID | Purpose |
|---|---------|----|---------|
| 1 | Cinematic hero | `#home` | Brand + tagline + primary CTAs + operating badges |
| — | Ticker | — | Brand values strip, hero → story transition |
| 2 | Story | `#about` | Trust: homemade, small-batch, made-after-you-order |
| 3 | Food categories | `#our-food` | 8 category cards (extensible via data) |
| 4 | How ordering works | `#how-it-works` | 5 steps; min-15/pre-order framed positively |
| 5 | Party orders | `#party-orders` | Celebrations, occasions, party CTA |
| 6 | Masala | `#masala` | Spice-toned product presentation (catalog-ready) |
| 7 | Pickles & pantry | `#pickles` | Homemade products (ecommerce-ready cards) |
| 8 | Online classes | `#classes` | Class cards with register CTA |
| 9 | Contact / enquiry | `#contact` | WhatsApp deep link + structured enquiry form |
| — | Footer + sticky mobile bar | — | Persistent conversion path |

## B. UX journey

**Discover → trust → crave → understand → act.**

1. Visitor lands (usually from WhatsApp/Instagram on mobile): hero states
   *who* (home kitchen), *what* (fresh, made to order) and *how* (min 15,
   pre-order, pickup/delivery) in the first viewport.
2. Story section converts "home kitchen" from claim to narrative.
3. Categories build appetite and let visitors self-select intent.
4. "How ordering works" removes friction — the model's constraints are
   presented as the *reason the food is fresh*, not as restrictions.
5. Party / masala / pickles / classes each end in their own CTA.
6. Every CTA lands on `#contact`, where the form composes a complete,
   structured WhatsApp message (food, portions ≥ 15, date, name, phone).
7. On mobile a sticky bar (WhatsApp + Order/Enquire) appears after the
   hero, keeping conversion one thumb-tap away at all times.

## C. Visual design system

- **Palette** — white + fresh green with kitchen-warm neutrals:
  cream `#FBF8F2` ground, greens `#2E7D4F → #0E2A1D` for brand/CTAs/deep
  sections, spice `#B4531D`, gold `#D9A441`, citrus `#B8BF3A` as food
  accents. Green is strategic (accents, CTAs, highlights) — food tones
  dominate imagery.
- **Typography** — [Fraunces](https://fonts.google.com/specimen/Fraunces)
  (display serif, optical sizing) for hero/section/food titles;
  [Inter](https://fonts.google.com/specimen/Inter) for reading text,
  labels and buttons. Fluid `clamp()` scale from small mobile to 4K.
- **Spacing / grid** — `--space-section` fluid 4.5–9 rem vertical rhythm;
  76 rem content column; CSS grid with `auto-fill/minmax` card grids.
- **Iconography** — one inline SVG symbol set (leaf, chili, star anise,
  plate, wok, cake, jar, mortar, platter…), used for garnish, cards and UI.
- **Photography direction** — every image position is a **photo slot**
  (`data-photo-slot="hero-main"`, `category-cakes`, `masala-…`) currently
  filled with art-directed gradient/SVG compositions. Replace each slot
  with real photography (large, natural, warm, macro where possible) by
  dropping an `<img>`/`background-image` into the slot — selectors and
  aspect ratios are already in place. **No stock or AI restaurant imagery.**

## D. Motion design system

One motion DNA, three tempos (tokens in `:root`):

| Token | Value | Used for |
|-------|-------|----------|
| `--dur-micro` | 200 ms | hovers, taps, arrows, underlines |
| `--dur-medium` | 550 ms | cards, reveals, menus |
| `--dur-cine` | 1100 ms | hero intro, big section moments |
| `--ease-soft` | `cubic-bezier(.22,1,.36,1)` | default — soft, weighted |
| `--ease-swift` | `cubic-bezier(.55,0,.1,1)` | clips, menu, step dots |

- **Scroll feel** — native scrolling is never hijacked. Fluidity comes
  from *lerped parallax* (`initParallax`): layers ease toward the real
  scroll position at 9 %/frame, giving the liquid feel without breaking
  browser navigation or accessibility.
- **Entrances** — a reveal vocabulary, no two adjacent sections alike:
  `fade-up`, `lines` (masked hero lines), `clip-left/right` (image wipes),
  `scale` (blur-to-focus), `stagger` / `stagger-cards`, plus bespoke step
  choreography (dot pops after text). All IntersectionObserver-driven,
  transform/opacity/clip-path only.
- **Micro-interactions** — magnetic buttons (fine pointers only), button
  fill-up transitions, arrow nudges, card lift + icon zoom, nav underline
  origin-flip, occasion-tag inversions.
- **Continuity** — hero plate → rotating ring text → green arc morphs into
  the dark ticker band; section tints alternate cream/deep so the page
  reads as one composition.
- **Reduced motion** — `prefers-reduced-motion` collapses every
  transition/animation and forces all content visible; JS additionally
  skips parallax, magnetic and counters.

## E. Component / code architecture

- `js/data.js` — **content layer**: brand facts (min order, WhatsApp,
  fulfilment), categories, ordering steps, occasions, masala products,
  pantry items, classes. A CMS/API later only needs to return this shape.
- `js/app.js` — render functions (one per collection) + motion runtime
  (`initReveals`, `initParallax`, `initMagnetic`, `initHeader`, …) +
  interactions (mobile menu, sticky bar, enquiry form → WhatsApp).
- `css/styles.css` — tokens → base → components → sections → motion →
  accessibility, in that order.

## F–G. Responsive behavior

Fluid-first with two structural breakpoints:

- **≤ 64 rem** — nav collapses to a circular-clip fullscreen menu with
  staggered links; hero stacks (plate first); steps switch from a 5-across
  horizontal timeline to a vertical rail; sticky conversion bar appears.
- **≤ 40 rem** — single-column grids, full-width CTAs, stacked form rows,
  smaller reveal distances (calmer motion on small screens).
- **≥ 100 rem** — wider content column so large desktops don't feel empty.

Touch targets ≥ 44 px, `safe-area-inset` respected on the sticky bar.

## H. Performance

- Zero JS/CSS dependencies; ~12 KB JS + ~18 KB CSS + system-cached fonts.
- No images to load yet — all visuals are CSS gradients + inline SVG.
- Animations use only compositor-friendly properties; parallax runs a
  single rAF loop that self-suspends when settled.
- Fonts load via `preconnect` + `display=swap`; scripts are parsed after
  content; observers unobserve after firing.

## I. QA & accessibility checklist

- [x] Semantic landmarks, single `h1`, no skipped heading levels
- [x] Keyboard: focus-visible rings, Escape closes menu, logical order
- [x] `prefers-reduced-motion` fully honored (CSS + JS)
- [x] Form: native validation + min-order guard + `role="alert"` errors
- [x] All decorative SVG `aria-hidden`; photo slots carry `role="img"` + labels
- [x] `<noscript>` fallback keeps content visible and points to WhatsApp
- [x] SEO: meta description, canonical, Open Graph, Twitter card,
      `FoodEstablishment` JSON-LD

## Go-live checklist (for the kitchen)

1. In `js/data.js` set `brand.whatsapp` to the real number
   (country code + digits, e.g. `9715XXXXXXXX`) and the real email.
2. Replace `https://foodcanto.example/` in `index.html` (canonical,
   OG, JSON-LD) with the real domain.
3. Drop real photography into the `data-photo-slot` positions.
4. Adjust prices/products/classes in `data.js` — no HTML edits needed.

## Future scalability

The data-shape is the contract. Planned growth maps cleanly:

- **CMS** — serve `FOODCANTO` as JSON from any headless CMS; `app.js`
  render functions become the component templates.
- **Ecommerce** — `masala`/`pantry` items already carry id/price/
  availability; add cart state + a checkout endpoint (Workers + Stripe).
- **Classes** — add booking/payment per class id; cards already isolate
  registration CTAs.
- **Forms hardening** — when moving from WhatsApp deep links to a server
  endpoint: validate server-side, rate limit (Turnstile fits naturally),
  and keep secrets in environment variables — never in this repo.
- **Framework migration** — each `render*` function is one component;
  sections are self-contained; tokens move to Tailwind theme config.
