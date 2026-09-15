import type { RegionConfig } from "./regions.ts";

const WEEKDAYS: Record<string, number> = {
	Sun: 0,
	Mon: 1,
	Tue: 2,
	Wed: 3,
	Thu: 4,
	Fri: 5,
	Sat: 6,
};

/** Local weekday and minutes-since-midnight for `now` in the given timezone. */
export function localClock(
	now: Date,
	timezone: string,
): { weekday: number; minutes: number } {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: timezone,
		weekday: "short",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).formatToParts(now);
	const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
	const weekday = WEEKDAYS[get("weekday")] ?? 0;
	const minutes = Number(get("hour")) * 60 + Number(get("minute"));
	return { weekday, minutes };
}

export function toMinutes(hhmm: string): number {
	const [h, m] = hhmm.split(":").map(Number);
	return (h ?? 0) * 60 + (m ?? 0);
}

export function isWithinBusinessHours(
	region: RegionConfig,
	now: Date = new Date(),
): boolean {
	const { weekday, minutes } = localClock(now, region.timezone);
	const { days, start, end } = region.businessHours;
	if (!days.includes(weekday)) return false;
	return minutes >= toMinutes(start) && minutes < toMinutes(end);
}
