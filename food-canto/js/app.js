/* ============================================================
   FOOD CANTO — app.js
   ------------------------------------------------------------
   1. Render      — builds cards/steps/tags from window.FOODCANTO
   2. Motion      — intro, scroll reveals, parallax, magnetic,
                    header behavior, ticker, counters
   3. Interaction — mobile menu, sticky bar, enquiry → WhatsApp
   All motion respects prefers-reduced-motion and uses only
   transform/opacity/clip-path for 60fps-friendly animation.
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

	/* ---------- 1 · Render from data ---------- */

	function renderCategories() {
		const grid = $("[data-categories]");
		if (!grid) return;
		grid.innerHTML = DATA.categories
			.map(
				(c, i) => `
			<a class="card tone-${esc(c.tone)}" href="#contact" style="--i:${i}"
				 data-category="${esc(c.id)}" aria-label="${esc(c.name)} — enquire">
				<div class="card-art" data-photo-slot="category-${esc(c.id)}">
					<svg aria-hidden="true"><use href="#i-${esc(c.icon)}" /></svg>
				</div>
				<h3>${esc(c.name)}</h3>
				<p>${esc(c.blurb)}</p>
				<span class="card-cta">Enquire
					<svg aria-hidden="true"><use href="#i-arrow" /></svg>
				</span>
			</a>`,
			)
			.join("");
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

	function renderOccasions() {
		const list = $("[data-occasions]");
		if (!list) return;
		list.innerHTML = DATA.occasions
			.map((o, i) => `<li style="--i:${i}">${esc(o)}</li>`)
			.join("");
	}

	function renderMasala() {
		const grid = $("[data-masala]");
		if (!grid) return;
		grid.innerHTML = DATA.masala
			.map(
				(m, i) => `
			<article class="card masala-card tone-spice" style="--i:${i}">
				${m.available ? "" : `<span class="badge-soon">Coming soon</span>`}
				<div class="card-art" data-photo-slot="masala-${esc(m.id)}">
					<svg aria-hidden="true"><use href="#i-mortar" /></svg>
				</div>
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
	}

	function renderPantry() {
		const grid = $("[data-pantry]");
		if (!grid) return;
		grid.innerHTML = DATA.pantry
			.map(
				(p, i) => `
			<article class="card tone-${esc(p.tone)}" style="--i:${i}">
				<div class="card-art" data-photo-slot="pantry-${esc(p.id)}">
					<svg aria-hidden="true"><use href="#i-${esc(p.icon)}" /></svg>
				</div>
				<span class="pantry-kind">${esc(p.kind)}</span>
				<h3>${esc(p.name)}</h3>
				<p>${esc(p.blurb)}</p>
				<span class="pantry-price">${esc(p.price)}</span>
			</article>`,
			)
			.join("");
	}

	function renderClasses() {
		const grid = $("[data-classes]");
		if (!grid) return;
		grid.innerHTML = DATA.classes
			.map(
				(k, i) => `
			<article class="card class-card" style="--i:${i}">
				<span class="class-topic">${esc(k.topic)}</span>
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

	/* ---------- 2 · Motion ---------- */

	function initIntro() {
		// Two frames so initial styles are committed before transitioning.
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
			// Lerp toward the real scroll position — this is what makes the
			// parallax feel liquid instead of locked to the scrollbar.
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
			// Hide on decisive downward scroll, reveal on any upward intent.
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
		const links = $$(".main-nav a[href^='#']");
		if (!links.length || !("IntersectionObserver" in window)) return;
		const byId = new Map(
			links.map((a) => [a.getAttribute("href").slice(1), a]),
		);
		const io = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					const link = byId.get(entry.target.id);
					if (link && entry.isIntersecting) {
						links.forEach((a) => a.classList.remove("is-active"));
						link.classList.add("is-active");
					}
				}
			},
			{ rootMargin: "-40% 0px -50% 0px" },
		);
		byId.forEach((_, id) => {
			const section = document.getElementById(id);
			if (section) io.observe(section);
		});
	}

	function initTicker() {
		const track = $("[data-ticker] .ticker-track");
		if (!track) return;
		// Duplicate content once so translateX(-50%) loops seamlessly.
		track.innerHTML += track.innerHTML;
	}

	function initCounters() {
		const els = $$("[data-count]");
		if (!els.length) return;
		if (reducedMotion || !("IntersectionObserver" in window)) return;
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

	/* ---------- 3 · Interaction ---------- */

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

		form.addEventListener("submit", (e) => {
			e.preventDefault();
			errorEl.hidden = true;

			if (!form.reportValidity()) return;
			const fd = new FormData(form);
			const qty = parseInt(fd.get("quantity"), 10);
			if (Number.isNaN(qty) || qty < DATA.brand.minOrder) {
				errorEl.textContent = `Orders start at ${DATA.brand.minOrder} portions — that's one good table!`;
				errorEl.hidden = false;
				return;
			}

			const lines = [
				"Hello FOOD CANTO! I'd like to pre-order:",
				"",
				`• Food: ${fd.get("food")}`,
				`• Portions: ${qty}`,
				`• Needed by: ${fd.get("date")}`,
				`• Name: ${fd.get("name")}`,
				`• Phone: ${fd.get("phone")}`,
			];
			const msg = String(fd.get("message") || "").trim();
			if (msg) lines.push(`• Notes: ${msg}`);

			const url = `https://wa.me/${DATA.brand.whatsapp}?text=${encodeURIComponent(
				lines.join("\n"),
			)}`;
			window.open(url, "_blank", "noopener");
		});
	}

	/* ---------- Boot ---------- */

	document.addEventListener("DOMContentLoaded", () => {
		renderCategories();
		renderSteps();
		renderOccasions();
		renderMasala();
		renderPantry();
		renderClasses();
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
	});
})();
