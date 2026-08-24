/* ============================================================
   FOOD CANTO — Content & data layer
   ------------------------------------------------------------
   Everything the kitchen will want to change lives here:
   categories, dishes, masala products, pickles, classes,
   ordering steps and contact details. The rendering layer
   (app.js) reads this object and builds the DOM, so content
   can later be served from a CMS / API returning the same
   shape without touching any component code.
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

	categories: [
		{
			id: "main-dishes",
			name: "Main Dishes",
			blurb: "Slow-cooked family recipes, portioned for gatherings.",
			icon: "plate",
			tone: "herb",
		},
		{
			id: "beef-dry-fry",
			name: "Beef Dry Fry",
			blurb: "Our signature — dark, glossy, fried in small batches.",
			icon: "wok",
			tone: "spice",
		},
		{
			id: "cakes",
			name: "Cakes",
			blurb: "Celebration cakes baked to your date, never before.",
			icon: "cake",
			tone: "cream",
		},
		{
			id: "sweets",
			name: "Sweets",
			blurb: "Traditional sweets made the long, patient way.",
			icon: "sweet",
			tone: "gold",
		},
		{
			id: "pickles",
			name: "Pickles",
			blurb: "Sun-brightened, jarred at home, aged to order.",
			icon: "jar",
			tone: "citrus",
		},
		{
			id: "masala",
			name: "Masala",
			blurb: "Whole spices, roasted and ground the week you order.",
			icon: "mortar",
			tone: "spice",
		},
		{
			id: "party-foods",
			name: "Party Foods",
			blurb: "Trays and platters for tables full of people you love.",
			icon: "platter",
			tone: "herb",
		},
		{
			id: "special-orders",
			name: "Special Orders",
			blurb: "A dish you remember? Tell us — we'll cook it for you.",
			icon: "note",
			tone: "cream",
		},
	],

	orderingSteps: [
		{
			step: "01",
			title: "Choose your food",
			body: "Browse our categories or ask for something from home you've been missing.",
		},
		{
			step: "02",
			title: "Send your requirement",
			body: "Message us on WhatsApp or use the enquiry form — dishes, occasion, headcount.",
		},
		{
			step: "03",
			title: "Confirm quantity & date",
			body: "We confirm portions (from 15), the price, and the day your food should be ready.",
		},
		{
			step: "04",
			title: "We prepare it fresh",
			body: "Nothing is cooked until your order is confirmed. Your food is made only for you.",
		},
		{
			step: "05",
			title: "Pickup or nearby delivery",
			body: "We deliver nearby, or have everything packed and warm for your pickup time.",
		},
	],

	occasions: [
		"Family parties",
		"Birthdays",
		"Gatherings",
		"Small events",
		"Religious celebrations",
		"Special occasions",
	],

	masala: [
		{
			id: "canto-garam-masala",
			name: "Canto Garam Masala",
			weight: "100 g",
			price: "AED 18",
			blurb:
				"Cardamom-forward and freshly ground — the blend behind our main dishes.",
			usage: "Curries · rice · marinades",
			available: true,
		},
		{
			id: "beef-fry-masala",
			name: "Beef Fry Masala",
			weight: "100 g",
			price: "AED 20",
			blurb:
				"The exact roast we use for our signature dry fry, sealed the day it's ground.",
			usage: "Beef & mutton fries",
			available: true,
		},
		{
			id: "kitchen-sambar-podi",
			name: "Kitchen Sambar Podi",
			weight: "150 g",
			price: "AED 16",
			blurb:
				"Lentils and red chillies roasted slow, for weekday sambar that tastes like Sunday.",
			usage: "Sambar · rasam · vegetables",
			available: false,
		},
	],

	pantry: [
		{
			id: "lime-pickle",
			name: "Sun-Cured Lime Pickle",
			kind: "Pickle",
			price: "AED 22",
			blurb: "Limes rested in salt and sun before the spices ever touch them.",
			icon: "jar",
			tone: "citrus",
		},
		{
			id: "mango-pickle",
			name: "Cut Mango Pickle",
			kind: "Pickle",
			price: "AED 24",
			blurb: "Firm raw mango, gingelly oil, and a recipe three kitchens old.",
			icon: "jar",
			tone: "gold",
		},
		{
			id: "ghee-sweets-box",
			name: "Ghee Sweets Box",
			kind: "Sweets",
			price: "from AED 45",
			blurb: "A small box of whatever we made fresh that week — always in ghee.",
			icon: "sweet",
			tone: "cream",
		},
		{
			id: "banana-chips",
			name: "Kettle Banana Chips",
			kind: "Snacks",
			price: "AED 15",
			blurb: "Sliced, fried and salted in one unbroken afternoon.",
			icon: "leaf",
			tone: "herb",
		},
	],

	classes: [
		{
			id: "beef-fry-masterclass",
			title: "The Beef Dry Fry, Properly",
			topic: "Signature dish · Live online",
			date: "Saturday evenings",
			duration: "90 minutes",
			level: "Beginner friendly",
			blurb:
				"Cook along from your own kitchen — spice roast, the fry, and the finish.",
		},
		{
			id: "festive-sweets",
			title: "Festive Sweets at Home",
			topic: "Sweets & snacks · Live online",
			date: "Before festival weeks",
			duration: "2 hours",
			level: "Intermediate",
			blurb:
				"Three sweets, one afternoon, and the small tricks that make them hold together.",
		},
		{
			id: "everyday-masala",
			title: "Build Your Masala Shelf",
			topic: "Spice blending · Live online",
			date: "Monthly",
			duration: "60 minutes",
			level: "All levels",
			blurb:
				"Roast, grind and store your own blends — and never buy a dusty packet again.",
		},
	],
};
