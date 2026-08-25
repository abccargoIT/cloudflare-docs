/* ============================================================
   FOOD CANTO — app.js (v2 · three themes)
   ------------------------------------------------------------
   1. Mark        — injects the inline SVG logo mark everywhere
   2. Render      — builds every module's content from data.js
   3. Motion      — intro + logo animation trigger, reveals,
                    parallax, magnetic, header, ticker, counters
   4. Interaction — mobile menu, module pills, enquiry → WhatsApp
   All motion respects prefers-reduced-motion and animates only
   transform/opacity/clip-path.
   ============================================================ */

(function () {
	"use strict";

	const DATA = window.FOODCANTO;
	const $ = (sel, root = document) => root.querySelector(sel);
	const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
	const reducedMotion = window.matchMedia(
		"(prefers-reduced-motion: reduce)",
	).matches;
	const finePointer = window.matchMedia(
		"(hover: hover) and (pointer: fine)",
	).matches;

	const esc = (s) =>
		String(s).replace(
			/[&<>"']/g,
			(c) =>
				({
					"&": "&amp;",
					"<": "&lt;",
					">": "&gt;",
					'"': "&quot;",
					"'": "&#39;",
				})[c],
		);

	/* ---------- 1 · The FOOD CANTO mark ---------- */
	// pathLength="1" lets CSS draw strokes with dasharray/dashoffset of 1.
	const MARK_SVG = `
	<svg class="mark-svg" viewBox="0 0 96 96" aria-hidden="true" focusable="false">
		<g fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
			<path class="m-bowl" pathLength="1" d="M22 56 a27 20 0 0 0 52 0" />
			<path class="m-rim" pathLength="1" d="M8 56 H88" />
			<path class="m-steam1" pathLength="1" d="M36 46 c-3 -5 3 -8 0 -14" />
			<path class="m-steam2" pathLength="1" d="M60 46 c3 -5 -3 -8 0 -14" />
			<path class="m-stem" pathLength="1" d="M48 46 c-3 -5 3 -9 0 -16" />
		</g>
		<path class="m-leaf" d="M66 27 c1 -2 3 -4 6 -5 1 -8 7 -13 15 -14 0 8 -6 14 -14 15 -2 1 -4 2 -5 4 z" />
	</svg>`;

	function injectMarks() {
		$$("[data-mark]").forEach((el) => {
			el.innerHTML = MARK_SVG;
		});
	}

	/* ---------- Responsive image helper ---------- */
	// Every slot ships as assets/img/<slot>-700.webp and -1400.webp.
	// window.FOODCANTO_INLINE (set only by the single-file preview build)
	// maps slots to data URIs so the page works without an asset server.
	function img(image, { sizes = "(max-width: 64rem) 100vw, 50vw", eager = false } = {}) {
		const s = esc(image.slot);
		const inline = window.FOODCANTO_INLINE && window.FOODCANTO_INLINE[image.slot];
		if (inline) {
			return `<img src="${inline}" alt="${esc(image.alt)}" ${eager ? 'fetchpriority="high"' : 'loading="lazy" decoding="async"'} />`;
		}
		return `<img
			src="assets/img/${s}-700.webp"
			srcset="assets/img/${s}-700.webp 700w, assets/img/${s}-1400.webp 1400w"
			sizes="${esc(sizes)}"
			alt="${esc(image.alt)}"
			${eager ? 'fetchpriority="high"' : 'loading="lazy" decoding="async"'} />`;
	}

	/* ---------- 2 · Render from data ---------- */

	function renderHeroImages() {
		const hero = $("[data-hero-img]");
		if (hero) hero.innerHTML = img(DATA.hero.img, { eager: true });
		const story = $("[data-story-img]");
		if (story) story.innerHTML = img(DATA.story.img);
	}

	function renderWorlds() {
		const grid = $("[data-worlds]");
		if (!grid) return;
		grid.innerHTML = DATA.modules
			.map(
				(m, i) => `
			<a class="world world-${esc(m.id)}" href="${esc(m.href)}" style="--i:${i}">
				${img(m.img, { sizes: "(max-width: 64rem) 100vw, 33vw" })}
				<span class="world-body">
					<span class="world-num">${esc(m.num)}</span>
					<h3>${esc(m.name)}</h3>
					<p>${esc(m.blurb)}</p>
					<span class="card-cta">${esc(m.cta)}
						<svg aria-hidden="true"><use href="#i-arrow" /></svg>
					</span>
				</span>
			</a>`,
			)
			.join("");
		grid.setAttribute("data-reveal", "stagger-cards");
	}

	function renderCategories() {
		const grid = $("[data-categories]");
		if (!grid) return;
		grid.innerHTML = DATA.categories
			.map(
				(c, i) => `
			<a class="card" href="#contact" style="--i:${i}" data-category="${esc(c.id)}"
				 aria-label="${esc(c.name)} — enquire">
				<div class="card-img">${img(c.img, { sizes: "(max-width: 64rem) 100vw, 25vw" })}</div>
				<h3>${esc(c.name)}</h3>
				<p>${esc(c.blurb)}</p>
				<span class="card-cta">Enquire
					<svg aria-hidden="true"><use href="#i-arrow" /></svg>
				</span>
			</a>`,
			)
			.join("");
	}

	function renderSignature() {
		const wrap = $("[data-signature]");
		if (!wrap) return;
		$(".signature-figure", wrap).innerHTML = `<div class="photo">${img(DATA.signature.img)}</div>`;
		$("[data-sig-name]", wrap).textContent = DATA.signature.name;
		$("[data-sig-blurb]", wrap).textContent = DATA.signature.blurb;
	}

	function renderSteps() {
		const list = $("[data-steps]");
		if (!list) return;
		list.innerHTML = DATA.orderingSteps
			.map(
				(s, i) => `
			<li class="step" style="--i:${i}">
				<span class="step-num" aria-hidden="true">${esc(s.step)}</span>
				<h3>${esc(s.title)}</h3>
				<p>${esc(s.body)}</p>
			</li>`,
			)
			.join("");
	}

	function renderParty() {
		const tags = $("[data-occasions]");
		if (tags)
			tags.innerHTML = DATA.party.occasions
				.map((o, i) => `<li style="--i:${i}">${esc(o)}</li>`)
				.join("");
		const fig = $("[data-party-img]");
		if (fig) fig.innerHTML = img(DATA.party.img);
	}

	function renderMasala() {
		const M = DATA.masalaModule;
		const hero = $("[data-masala-hero]");
		if (hero) hero.innerHTML = img(M.heroImg);
		const grid = $("[data-masala]");
		if (grid)
			grid.innerHTML = M.products
				.map(
					(m, i) => `
			<article class="card masala-card" style="--i:${i}">
				${m.available ? "" : `<span class="badge-soon">Coming soon</span>`}
				<div class="card-img">${img(m.img, { sizes: "(max-width: 64rem) 100vw, 33vw" })}</div>
				<h3>${esc(m.name)}</h3>
				<p>${esc(m.blurb)}</p>
				<p class="masala-usage">${esc(m.usage)}</p>
				<div class="masala-meta">
					<span>${esc(m.weight)}</span>
					<strong>${esc(m.price)}</strong>
				</div>
			</article>`,
				)
				.join("");
		const strip = $("[data-ingredients]");
		if (strip)
			strip.innerHTML = M.ingredientImgs
				.map(
					(image, i) =>
						`<figure class="photo" style="--i:${i}">${img(image, { sizes: "(max-width: 64rem) 100vw, 50vw" })}</figure>`,
				)
				.join("");
	}

	function renderLadies() {
		const L = DATA.ladiesModule;
		const hero = $("[data-ladies-hero]");
		if (hero) hero.innerHTML = img(L.heroImg);
		const pos = $("[data-ladies-positioning]");
		if (pos) pos.textContent = L.positioning;
		const grid = $("[data-classes]");
		if (grid)
			grid.innerHTML = L.classes
				.map(
					(k, i) => `
			<article class="card class-card" style="--i:${i}">
				<div class="card-img">${img(k.img, { sizes: "(max-width: 64rem) 100vw, 25vw" })}</div>
				<span class="class-topic">${esc(k.topic)} · ${esc(k.mode)}</span>
				<h3>${esc(k.title)}</h3>
				<p>${esc(k.blurb)}</p>
				<div class="class-meta">
					<span><b>When</b> ${esc(k.date)}</span>
					<span><b>Length</b> ${esc(k.duration)}</span>
					<span><b>Level</b> ${esc(k.level)}</span>
				</div>
				<a class="card-cta" href="#contact" data-class="${esc(k.id)}">Register interest
					<svg aria-hidden="true"><use href="#i-arrow" /></svg>
				</a>
			</article>`,
				)
				.join("");
		const community = $("[data-community-imgs]");
		if (community)
			community.innerHTML = L.communityImgs
				.map(
					(image, i) =>
						`<figure class="photo" style="--i:${i}">${img(image, { sizes: "(max-width: 64rem) 100vw, 33vw" })}</figure>`,
				)
				.join("");
	}

	function renderMeta() {
		$$("[data-year]").forEach((el) => {
			el.textContent = String(new Date().getFullYear());
		});
		const waHref = `https://wa.me/${DATA.brand.whatsapp}?text=${encodeURIComponent(
			"Hello FOOD CANTO! I'd like to place a pre-order.",
		)}`;
		$$("[data-wa-link]").forEach((a) => {
			a.href = waHref;
			a.target = "_blank";
			a.rel = "noopener";
		});
	}

	/* ---------- 3 · Motion ---------- */

	function initIntro() {
		requestAnimationFrame(() =>
			requestAnimationFrame(() => document.body.classList.add("is-loaded")),
		);
	}

	function initReveals() {
		const targets = $$("[data-reveal], .steps");
		if (!("IntersectionObserver" in window) || reducedMotion) {
			targets.forEach((el) => el.classList.add("is-in"));
			return;
		}
		targets.forEach((el) => {
			const delay = el.getAttribute("data-reveal-delay");
			if (delay) el.style.setProperty("--rd", delay);
		});
		const io = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) {
						entry.target.classList.add("is-in");
						io.unobserve(entry.target);
					}
				}
			},
			{ rootMargin: "0px 0px -12% 0px", threshold: 0.08 },
		);
		targets.forEach((el) => io.observe(el));
	}

	function initParallax() {
		const layers = $$("[data-parallax]");
		if (!layers.length || reducedMotion) return;
		let current = window.scrollY;
		let target = current;
		let raf = null;

		const tick = () => {
			// Lerp toward the real scroll position — liquid, never scroll-jacked.
			current += (target - current) * 0.09;
			for (const el of layers) {
				const speed = parseFloat(el.getAttribute("data-parallax")) || 0;
				el.style.setProperty("--py", `${(current * speed * -1).toFixed(2)}px`);
			}
			if (Math.abs(target - current) > 0.1) {
				raf = requestAnimationFrame(tick);
			} else {
				raf = null;
			}
		};

		window.addEventListener(
			"scroll",
			() => {
				target = window.scrollY;
				if (raf === null) raf = requestAnimationFrame(tick);
			},
			{ passive: true },
		);
	}

	function initMagnetic() {
		if (!finePointer || reducedMotion) return;
		$$("[data-magnetic]").forEach((btn) => {
			const strength = 0.28;
			btn.addEventListener("pointermove", (e) => {
				const r = btn.getBoundingClientRect();
				const x = (e.clientX - r.left - r.width / 2) * strength;
				const y = (e.clientY - r.top - r.height / 2) * strength;
				btn.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
			});
			btn.addEventListener("pointerleave", () => {
				btn.style.transform = "";
			});
		});
	}

	function initHeader() {
		const header = $("[data-header]");
		const stickyBar = $("[data-sticky-bar]");
		if (!header) return;
		let lastY = window.scrollY;
		let idle = null;

		const onScroll = () => {
			const y = window.scrollY;
			header.classList.toggle("is-scrolled", y > 24);
			if (y > 420 && y - lastY > 6) header.classList.add("is-hidden");
			else if (lastY - y > 2 || y < 420) header.classList.remove("is-hidden");
			lastY = y;
			if (stickyBar) stickyBar.classList.toggle("is-visible", y > 560);
			clearTimeout(idle);
			idle = setTimeout(() => header.classList.remove("is-hidden"), 900);
		};
		window.addEventListener("scroll", onScroll, { passive: true });
		onScroll();
	}

	function initActiveNav() {
		if (!("IntersectionObserver" in window)) return;
		const links = $$(".main-nav a[href^='#']");
		const byId = new Map(links.map((a) => [a.getAttribute("href").slice(1), a]));
		const pills = new Map(
			$$("[data-pill]").map((a) => [a.getAttribute("href").slice(1), a]),
		);
		const io = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (!entry.isIntersecting) continue;
					const id = entry.target.id;
					const link = byId.get(id);
					if (link) {
						links.forEach((a) => a.classList.remove("is-active"));
						link.classList.add("is-active");
					}
					if (pills.has(id)) {
						pills.forEach((a) => a.classList.remove("is-current"));
						pills.get(id).classList.add("is-current");
					}
				}
			},
			{ rootMargin: "-35% 0px -55% 0px" },
		);
		new Set([...byId.keys(), ...pills.keys()]).forEach((id) => {
			const section = document.getElementById(id);
			if (section) io.observe(section);
		});
	}

	function initTicker() {
		const track = $("[data-ticker] .ticker-track");
		if (!track) return;
		track.innerHTML += track.innerHTML;
	}

	function initCounters() {
		const els = $$("[data-count]");
		if (!els.length || reducedMotion || !("IntersectionObserver" in window))
			return;
		const io = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (!entry.isIntersecting) continue;
					io.unobserve(entry.target);
					const el = entry.target;
					const end = parseInt(el.getAttribute("data-count"), 10) || 0;
					const start = performance.now();
					const dur = 900;
					const step = (now) => {
						const t = Math.min(1, (now - start) / dur);
						const eased = 1 - Math.pow(1 - t, 3);
						el.textContent = String(Math.round(end * eased));
						if (t < 1) requestAnimationFrame(step);
					};
					requestAnimationFrame(step);
				}
			},
			{ threshold: 0.6 },
		);
		els.forEach((el) => io.observe(el));
	}

	/* ---------- 4 · Interaction ---------- */

	function initMobileMenu() {
		const toggle = $("[data-nav-toggle]");
		const menu = $("[data-mobile-menu]");
		if (!toggle || !menu) return;

		const setOpen = (open) => {
			menu.classList.toggle("is-open", open);
			menu.setAttribute("aria-hidden", String(!open));
			toggle.setAttribute("aria-expanded", String(open));
			toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
			document.body.style.overflow = open ? "hidden" : "";
			if (!open) toggle.focus();
		};

		toggle.addEventListener("click", () =>
			setOpen(!menu.classList.contains("is-open")),
		);
		menu.addEventListener("click", (e) => {
			if (e.target.closest("a")) setOpen(false);
		});
		document.addEventListener("keydown", (e) => {
			if (e.key === "Escape" && menu.classList.contains("is-open"))
				setOpen(false);
		});
	}

	function initEnquiryForm() {
		const form = $("[data-enquiry-form]");
		if (!form) return;
		const errorEl = $("[data-form-error]", form);
		const interest = form.elements.interest;
		const qtyField = form.elements.quantity;
		const dateField = form.elements.date;

		const isFoodOrder = () =>
			/food|party/i.test(interest.value || "Food order");

		const syncFields = () => {
			const food = isFoodOrder();
			qtyField.required = food;
			dateField.required = food;
			$("[data-food-fields]", form).style.display = food ? "" : "none";
		};
		interest.addEventListener("change", syncFields);
		syncFields();

		form.addEventListener("submit", (e) => {
			e.preventDefault();
			errorEl.hidden = true;
			if (!form.reportValidity()) return;

			const fd = new FormData(form);
			const lines = [
				`Hello FOOD CANTO! I'm interested in: ${fd.get("interest")}`,
				"",
				`• Details: ${fd.get("food")}`,
			];
			if (isFoodOrder()) {
				const qty = parseInt(fd.get("quantity"), 10);
				if (Number.isNaN(qty) || qty < DATA.brand.minOrder) {
					errorEl.textContent = `Food orders start at ${DATA.brand.minOrder} portions — that's one good table!`;
					errorEl.hidden = false;
					return;
				}
				lines.push(`• Portions: ${qty}`, `• Needed by: ${fd.get("date")}`);
			}
			lines.push(`• Name: ${fd.get("name")}`, `• Phone: ${fd.get("phone")}`);
			const msg = String(fd.get("message") || "").trim();
			if (msg) lines.push(`• Notes: ${msg}`);

			const url = `https://wa.me/${DATA.brand.whatsapp}?text=${encodeURIComponent(
				lines.join("\n"),
			)}`;
			window.open(url, "_blank", "noopener");
		});
	}

	/* ---------- Boot ---------- */

	const boot = () => {
		injectMarks();
		renderHeroImages();
		renderWorlds();
		renderCategories();
		renderSignature();
		renderSteps();
		renderParty();
		renderMasala();
		renderLadies();
		renderMeta();

		initIntro();
		initReveals();
		initParallax();
		initMagnetic();
		initHeader();
		initActiveNav();
		initTicker();
		initCounters();
		initMobileMenu();
		initEnquiryForm();
	};

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", boot);
	} else {
		boot();
	}
})();
