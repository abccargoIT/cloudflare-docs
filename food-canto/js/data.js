/* ============================================================
   FOOD CANTO — Content & data layer (v2, three modules)
   ------------------------------------------------------------
   One brand, three experiences: FOOD, MASALA, LADIES KITCHEN.
   Everything the kitchen edits lives here — dishes, products,
   classes, images and operating facts. The rendering layer
   (app.js) reads this object; a CMS/API later only needs to
   return the same shape.

   Images: every `img` names a slot in assets/img/ where
   <slot>-700.webp and <slot>-1400.webp exist. Sources and
   licenses are recorded in assets/img/ATTRIBUTIONS.json.
   To use FOOD CANTO's own photography, replace the two files
   for a slot and update the alt text — nothing else changes.
   ============================================================ */

window.FOODCANTO = {
	brand: {
		name: "FOOD CANTO",
		tagline: "Made Fresh, Just for Your Order.",
		minOrder: 15,
		orderModel: "Pre-order only",
		fulfilment: "Nearby delivery · Pickup for other locations",
		// Replace with the kitchen's real WhatsApp number (country code, digits only).
		whatsapp: "971500000000",
		email: "hello@foodcanto.example",
		locality: "United Arab Emirates",
	},

	hero: {
		img: {
			slot: "hero-food",
			alt: "Two homemade curries in steel bowls beside rice, seen from above in warm light",
		},
	},

	story: {
		img: {
			slot: "story-kitchen",
			alt: "Hands stirring a steaming pan of food beside a bright kitchen window",
		},
	},

	/* ---------- Module entrances ---------- */
	modules: [
		{
			id: "food",
			num: "01",
			name: "Fresh Food & Orders",
			blurb: "Homemade dishes, cakes, sweets and party trays — cooked only after your order is confirmed.",
			cta: "Explore Food",
			href: "#food",
			img: {
				slot: "entrance-food",
				alt: "A rich homemade paneer curry in a steel kadai with rice and pappadam behind",
			},
		},
		{
			id: "masala",
			num: "02",
			name: "FOOD CANTO Masala",
			blurb: "Whole spices roasted and ground in small batches — the blends our own kitchen cooks with.",
			cta: "Explore Masala",
			href: "#masala",
			img: {
				slot: "entrance-masala",
				alt: "Spoons of ground spices with red chillies, cumin and lemongrass on a pale table",
			},
		},
		{
			id: "ladies",
			num: "03",
			name: "Ladies Cooking Classes",
			blurb: "A dedicated cooking community for women who want to learn, cook and share together.",
			cta: "Explore Classes",
			href: "#ladies-classes",
			img: {
				slot: "entrance-ladies",
				alt: "Several pairs of hands preparing fresh vegetables together at a rustic wooden table",
			},
		},
	],

	/* ---------- Module 1 · FOOD ---------- */
	signature: {
		name: "Beef Dry Fry",
		blurb:
			"Our signature. Slow-roasted spices, small batches, and a fry that goes dark, glossy and tender — made the way it's made at home, because it is.",
		img: {
			slot: "beef-feature",
			alt: "Kerala-style beef dry fry glistening in a dark pan, garnished with herbs",
		},
	},

	categories: [
		{
			id: "main-dishes",
			name: "Main Dishes",
			blurb: "Slow-cooked family recipes, portioned for gatherings.",
			img: { slot: "cat-main-dishes", alt: "Kerala fish curry with curry leaves in a traditional clay pot" },
		},
		{
			id: "beef-dry-fry",
			name: "Beef Dry Fry",
			blurb: "Dark, glossy and fried in small batches — our signature.",
			img: { slot: "cat-beef-fry", alt: "Plate of Kerala beef dry fry with onion rings and dried red chillies" },
		},
		{
			id: "cakes",
			name: "Cakes",
			blurb: "Celebration cakes baked to your date, never before.",
			img: { slot: "cat-cakes", alt: "Chocolate layer cake with dripping ganache and piped frosting" },
		},
		{
			id: "sweets",
			name: "Sweets",
			blurb: "Traditional sweets made the long, patient way.",
			img: { slot: "cat-sweets", alt: "Two gulab jamun in syrup on a white plate with a spoon" },
		},
		{
			id: "pickles",
			name: "Pickles",
			blurb: "Cut, salted and jarred at home — aged to order.",
			img: { slot: "cat-pickles", alt: "Homemade cut mango pickle in a steel bowl" },
		},
		{
			id: "party-foods",
			name: "Party Foods",
			blurb: "Trays and full spreads for tables full of people you love.",
			img: { slot: "cat-party-foods", alt: "Sadya feast served on a fresh banana leaf with rice and sides" },
		},
		{
			id: "special-orders",
			name: "Special Orders",
			blurb: "A dish you remember? Tell us — we'll cook it for you.",
			img: { slot: "cat-special", alt: "Plate of layered biryani with mint, fried onions and cucumber" },
		},
	],

	orderingSteps: [
		{ step: "01", title: "Choose your food", body: "Browse our categories or ask for something from home you've been missing." },
		{ step: "02", title: "Send your requirement", body: "Message us on WhatsApp or use the enquiry form — dishes, occasion, headcount." },
		{ step: "03", title: "Confirm quantity & date", body: "We confirm portions (from 15), the price, and the day your food should be ready." },
		{ step: "04", title: "We prepare it fresh", body: "Nothing is cooked until your order is confirmed. Your food is made only for you." },
		{ step: "05", title: "Pickup or nearby delivery", body: "We deliver nearby, or have everything packed and warm for your pickup time." },
	],

	party: {
		occasions: [
			"Family gatherings",
			"Birthdays",
			"Small events",
			"Religious celebrations",
			"Special occasions",
		],
		img: {
			slot: "party-hero",
			alt: "Hands serving a communal sadya feast across several banana leaves",
		},
	},

	/* ---------- Module 2 · MASALA ---------- */
	masalaModule: {
		heroImg: {
			slot: "hero-masala",
			alt: "Whole and ground spices — turmeric, chillies, garlic and seeds — scattered on a white board",
		},
		ingredientImgs: [
			{ slot: "masala-ingredients", alt: "Whole nutmeg, cardamom, cinnamon and cloves laid out before roasting" },
			{ slot: "masala-macro", alt: "Star anise, cinnamon sticks and cloves in close-up" },
		],
		products: [
			{
				id: "canto-garam-masala",
				name: "Canto Garam Masala",
				weight: "100 g",
				price: "AED 18",
				blurb: "Cardamom-forward and freshly ground — the blend behind our main dishes.",
				usage: "Curries · rice · marinades",
				available: true,
				img: { slot: "masala-garam", alt: "Freshly ground garam masala filling a wide steel pan" },
			},
			{
				id: "beef-fry-masala",
				name: "Beef Fry Masala",
				weight: "100 g",
				price: "AED 20",
				blurb: "The exact roast we use for our signature dry fry, sealed the day it's ground.",
				usage: "Beef & mutton fries",
				available: true,
				img: { slot: "masala-chili", alt: "Strings of dried red chillies hanging to dry" },
			},
			{
				id: "kitchen-sambar-podi",
				name: "Kitchen Sambar Podi",
				weight: "150 g",
				price: "AED 16",
				blurb: "Lentils and red chillies roasted slow, for weekday sambar that tastes like Sunday.",
				usage: "Sambar · rasam · vegetables",
				available: false,
				img: { slot: "masala-sambar", alt: "Soft idli on a banana leaf beside a bowl of sambar and chutney" },
			},
		],
	},

	/* ---------- Module 3 · LADIES KITCHEN ---------- */
	ladiesModule: {
		heroTitle: "Learn. Cook. Create. Together.",
		positioning:
			"A dedicated FOOD CANTO cooking community created for women who want to learn, cook and share together — live online sessions, small groups, and recipes you'll actually repeat.",
		heroImg: {
			slot: "hero-ladies",
			alt: "A class preparation table laid out with fresh vegetables, herbs and jarred ingredients",
		},
		communityImgs: [
			{ slot: "ladies-community", alt: "A shared table of homemade dishes seen from above, hands reaching in to serve" },
			{ slot: "ladies-online", alt: "A tablet showing a recipe propped in a kitchen beside wooden spoons and fresh limes" },
		],
		classes: [
			{
				id: "traditional-cooking",
				title: "Traditional Home Cooking",
				topic: "Kerala & Indian cuisine",
				mode: "Live online",
				date: "Saturday evenings",
				duration: "90 minutes",
				level: "Beginner friendly",
				instructor: "The FOOD CANTO kitchen",
				blurb: "The everyday classics — rice, curries and sides — cooked along from your own kitchen.",
				img: { slot: "class-traditional", alt: "A homely vegetarian thali with rice, curry and fresh sides" },
			},
			{
				id: "baking",
				title: "Home Baking, From Scratch",
				topic: "Breads & cakes",
				mode: "Live online",
				date: "Sunday mornings",
				duration: "2 hours",
				level: "All levels",
				instructor: "The FOOD CANTO kitchen",
				blurb: "Dough, patience and a hot oven — loaves and cakes that hold together without shortcuts.",
				img: { slot: "class-baking", alt: "Rustic home-baked loaves dusted with flour beside ears of wheat" },
			},
			{
				id: "masala-making",
				title: "Masala Making",
				topic: "Spice blending",
				mode: "Live online",
				date: "Monthly",
				duration: "60 minutes",
				level: "All levels",
				instructor: "The FOOD CANTO kitchen",
				blurb: "Roast, pound and store your own blends — and never buy a dusty packet again.",
				img: { slot: "class-masala", alt: "A traditional wooden mortar and pestle used for grinding spices" },
			},
			{
				id: "sweets-snacks",
				title: "Festive Sweets & Snacks",
				topic: "Sweets",
				mode: "Live online",
				date: "Before festival weeks",
				duration: "2 hours",
				level: "Intermediate",
				instructor: "The FOOD CANTO kitchen",
				blurb: "Three sweets, one afternoon, and the small tricks that make them hold together.",
				img: { slot: "class-sweets", alt: "A fresh batch of golden boondi laddu laid out to set" },
			},
		],
	},
};
