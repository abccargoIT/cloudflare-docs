# The palette decision, and the report library

**Status:** Both applied to the demonstration and committed. Nothing live was
touched. The report library is **not persisted and not exposed over HTTP** —
see §7.
**Prepared by:** ABC Cargo IT Department
**Date:** 8 October 2026
**Decided by:** Head of IT — "only red, white and black", and "refer
www.abccargo.ae, www.abccargo.uk, www.abccargogcc.com, www.abccargo.com"

---

## 1. Executive summary

The palette question that had been open since the design package was accepted
is now decided: **red, white and black only**, with the red taken from ABC
Cargo's own live websites rather than chosen. That closes decision 2 of the
four outstanding items.

Alongside it, item 3 of the package's unbuilt list — "Reports: charts and a
report library; no charts, no library, no export" — is built. Four named
reports, two charts, and a CSV export that is safe to open in Excel.

## 2. The brand red, measured rather than picked

Three of the four sites fetched successfully. The fourth,
`www.abccargo.uk`, **could not be reached from this environment** (connection
failed, not a 404), so it has not been checked and is not claimed as evidence.

The three that resolved agree completely. `#e64a3c` is the single most
frequent colour on every one of them:

| Site            | `#e64a3c` | `#000000` | `#ffffff` |
| --------------- | --------- | --------- | --------- |
| abccargo.ae     | 8         | 4         | 1         |
| abccargogcc.com | 8         | 6         | 4         |
| abccargo.com    | 13        | 6         | 4         |

Also present on two of the sites were `#003388`, `#00d084`, `#0693e3`,
`#ff6900` and `#fcb900`, at exactly two or three occurrences each. Those are
the **stock WordPress block-editor palette**, not ABC Cargo colours, and they
were discounted on that basis rather than averaged in.

The previous build used `#c1121f`, which was never ABC Cargo's red — it was a
reasonable guess and it was wrong. It is gone.

## 3. One red is not enough, so the red is stepped

`#e64a3c` is a lighter, warmer red than the one it replaced, and that has a
measurable consequence: at 3.88:1 against white it clears the 3:1 a **mark**
needs and misses the 4.5:1 **text** needs. Using it for pill text or button
labels would have put unreadable text on the screen.

So the hue is stepped, and each step was computed:

| Token           | Light     | Dark      | Job                         | Measured                             |
| --------------- | --------- | --------- | --------------------------- | ------------------------------------ |
| `--brand`       | `#e64a3c` | `#e64a3c` | fills, bars, dots, borders  | 3.88:1 on white, 4.48:1 on dark card |
| `--brand-ink`   | `#d42a1b` | `#e64c3e` | text on surface and on wash | 5.06:1 on white, 4.51:1 on wash      |
| `--brand-solid` | `#e22f1f` | `#e64a3c` | solid fill under white text | white on it 4.51:1                   |
| `--brand-wash`  | `#fbefee` | `#2b1113` | pill and bubble backgrounds | —                                    |

Same hue throughout (4.9°), stepped only in lightness. Nothing here was chosen
by eye.

## 4. Status without green or amber

With one accent hue, severity cannot be a change of colour. It is a change of
**weight** in that one hue:

| State                            | Treatment                                         |
| -------------------------------- | ------------------------------------------------- |
| Settled — answered, resolved, ok | Ink on a neutral wash. Quiet on purpose           |
| Dormant — closed, window closed  | Muted ink on a sunk surface                       |
| Attention — overdue, pending     | Red ink on a red wash, with a red edge            |
| Serious — breached               | The only solid red fill on the screen, white text |

Weight reads as severity in greyscale, in print, and under any colour vision
deficiency. And every pill prints its own word — "answered", "overdue",
"resolved" — so **none of this is colour-alone**. That is the actual
accessibility guarantee; the colour is the fast path, not the information.

The green and amber tokens are gone from all three theme blocks. One of those
blocks — the explicit `[data-theme="dark"]` selector, as opposed to the
`prefers-color-scheme` one — was missed on the first pass and still carried
the old green; anyone who manually selected dark mode would have seen the old
palette. Found and fixed before commit.

## 5. Region identity is now shape, not hue

Three regions cannot have three accent colours out of two. So the region mark
differs by fill **and** shape: UAE solid red, KSA solid ink, UK a ring. A
region's name sits beside the mark everywhere one appears, so the mark
reinforces the label rather than replacing it — which is the right way round
even in a palette with hues to spare.

The WhatsApp thread lost its green outbound bubble, which has a real cost
worth stating: the thread is still readable, with our own messages marked by a
red tint instead of green, but it is **deliberately no longer a faithful
likeness of WhatsApp's own interface**. If that matters for the demonstration,
the thread is the one place where an exception to red/white/black would be
defensible.

## 6. The report library and the charts

Four named reports, each a definition — what it counts, how it groups, which
columns it exports — so the chart and the CSV are built from the same rows and
cannot disagree.

| Report                        | Groups by   | Form            |
| ----------------------------- | ----------- | --------------- |
| Conversation volume by day    | day         | small multiples |
| First response against target | region      | table           |
| Tickets by type               | ticket type | column chart    |
| Satisfaction distribution     | score       | column chart    |

**The charts are single-series by necessity and better for it.** One accent hue
means a chart that told three regions apart by colour would need three, and
generating two more would be inventing brand colours. Three regions therefore
become three small panels with one hue each — which is the standard answer to
the problem and is easier to read than a three-colour grouped chart. A single
series needs no legend: the panel heading names what is plotted.

The three panels share one scale. Panels drawn to their own maxima look
identical however different the volumes are, which is the usual way a
small-multiples chart misleads. (The first version of the chart helper
computed a shared maximum and then ignored it — the exact mistake the comment
above it warns about. Caught by inspecting the rendered output, and the
rendered axis ticks now read 50/50/50 across the three panels.)

Values are labelled selectively — the peak only — and every number is also in
a table view, so nothing is reachable by hover alone.

### Export

CRLF endings and a UTF-8 BOM, so Excel does not render an Arabic customer name
as mojibake. And the one security concern an export has: a field beginning
`=`, `+`, `-`, `@`, tab or carriage return is prefixed with an apostrophe,
because otherwise a customer named `=HYPERLINK("http://…"&A1,"Click")` runs as
a live formula when the file is opened, and `=cmd|'/c calc'!A1` is worse. A
cargo reference beginning with a dash is an ordinary thing to have, so the
guard cannot be narrowed to obviously hostile input. Eighteen tests cover it,
including that an ordinary name is not mangled by the guard.

## 7. What is NOT built

- **Not persisted, not exposed over HTTP.** No endpoint returns a report and no
  table stores one. `src/index.ts` is untouched.
- **No saved or scheduled reports.** The library is a fixed set in source; a
  supervisor cannot define or save one, and nothing emails a report.
- **The volume chart is seeded demonstration data**, and the panel says so on
  screen. Four seeded conversations are enough to show routing and a timeline
  and nowhere near enough to draw a fourteen-day trend, so rather than render
  four bars and let them imply a history the platform has not collected, the
  series is seeded and labelled. Every other figure on the Reports screen is
  computed from the demonstration's own records.
- **The download path is not verified end to end.** The CSV construction is
  verified against real demonstration state in a headless browser — all four
  reports produce correct rows and a Windows-legal filename — but the
  `Blob`/anchor click that saves the file cannot be exercised headlessly in
  this environment. It is ordinary and well-trodden, and it is wrapped in a
  try/catch that reports failure, but I have not watched a file land.
- **Item 8 of the unbuilt list — the bot builder screen and the
  fallback-to-Tier-2 escalation — was not started.** It was the other
  unblocked item and there was not room for it in this change.

## 8. Still blocked on a decision

Palette is now decided, so three remain:

1. **Third region** — the package says Oman; the business runs UK.
2. **"Payment"** as a lifecycle stage.
3. **Email and phone channels** — now, or after the three WhatsApp cutovers.

And the three **Freshchat bot flow exports**, still the largest single blocker
to replacing the live service.

## 9. Status

Built, tested, verified, documented. Typecheck, ESLint, Prettier and all
**383** tests pass. All 14 demonstration views re-verified rendering in
headless Chromium after the palette change, with no un-evaluated template
literals and no marks outside their viewBox.

No live system was touched. The standing hold of 8 October 2026 is unaffected,
and the Access exemption in `docs/access-webhook-exemption.md` remains
unexecuted.

## 10. Next action

Decide §8.1 and §8.2. If the report library is wanted in production rather
than only in the demonstration, that needs a migration and an endpoint, which
is a separate change note.
