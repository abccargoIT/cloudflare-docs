/**
 * Region configuration: one entry per WhatsApp phone number attached to the
 * ABC Cargo WhatsApp Business Account. Loaded from the REGION_NUMBERS
 * variable so that numbers can be added without a code change.
 */

export interface BusinessHours {
	/** Days of week, 0 = Sunday ... 6 = Saturday, in the region's timezone */
	days: number[];
	/** "HH:mm" 24-hour, inclusive */
	start: string;
	/** "HH:mm" 24-hour, exclusive */
	end: string;
}

export interface RegionConfig {
	id: string;
	label: string;
	phoneNumberId: string;
	displayNumber: string;
	/** IANA timezone, for example "Asia/Dubai" */
	timezone: string;
	/** Default template language code, for example "en" or "en_US" */
	language: string;
	businessHours: BusinessHours;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function parseRegionConfig(json: string): RegionConfig[] {
	let raw: unknown;
	try {
		raw = JSON.parse(json);
	} catch {
		throw new Error("REGION_NUMBERS is not valid JSON");
	}
	if (!Array.isArray(raw) || raw.length === 0) {
		throw new Error("REGION_NUMBERS must be a non-empty JSON array");
	}

	const seenIds = new Set<string>();
	const seenPhoneNumberIds = new Set<string>();
	const regions: RegionConfig[] = [];

	for (const [index, item] of raw.entries()) {
		const r = item as Partial<RegionConfig>;
		const where = `REGION_NUMBERS[${index}]`;
		requireString(r.id, `${where}.id`);
		requireString(r.label, `${where}.label`);
		requireString(r.phoneNumberId, `${where}.phoneNumberId`);
		requireString(r.displayNumber, `${where}.displayNumber`);
		requireString(r.timezone, `${where}.timezone`);
		requireString(r.language, `${where}.language`);
		if (!r.businessHours) throw new Error(`${where}.businessHours missing`);
		const bh = r.businessHours;
		if (!Array.isArray(bh.days) || bh.days.some((d) => d < 0 || d > 6)) {
			throw new Error(`${where}.businessHours.days must be 0-6`);
		}
		if (!TIME_RE.test(bh.start) || !TIME_RE.test(bh.end)) {
			throw new Error(`${where}.businessHours start/end must be HH:mm`);
		}
		if (seenIds.has(r.id)) throw new Error(`Duplicate region id ${r.id}`);
		if (seenPhoneNumberIds.has(r.phoneNumberId)) {
			throw new Error(`Duplicate phoneNumberId ${r.phoneNumberId}`);
		}
		seenIds.add(r.id);
		seenPhoneNumberIds.add(r.phoneNumberId);
		regions.push({
			id: r.id,
			label: r.label,
			phoneNumberId: r.phoneNumberId,
			displayNumber: r.displayNumber,
			timezone: r.timezone,
			language: r.language,
			businessHours: { days: [...bh.days], start: bh.start, end: bh.end },
		});
	}
	return regions;
}

export function findRegionByPhoneNumberId(
	regions: RegionConfig[],
	phoneNumberId: string,
): RegionConfig | undefined {
	return regions.find((r) => r.phoneNumberId === phoneNumberId);
}

export function findRegionById(
	regions: RegionConfig[],
	id: string,
): RegionConfig | undefined {
	return regions.find((r) => r.id === id);
}

function requireString(value: unknown, name: string): asserts value is string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`${name} must be a non-empty string`);
	}
}
