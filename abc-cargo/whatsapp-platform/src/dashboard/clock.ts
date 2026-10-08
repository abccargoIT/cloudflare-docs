/**
 * The dashboard's sense of time, which is not the server's.
 *
 * Three regions, three timezones, three working weeks. "Today", "this morning"
 * and "the office is open" are all different questions depending on which
 * number you are looking at, and a dashboard that answers them from UTC is
 * wrong in two regions out of three for most of the day.
 *
 * So: every figure the dashboard labels "today" is counted between the
 * region's own midnights, and the greeting is in the region's own hours. The
 * reports module deliberately works in UTC windows, because a figure being
 * compared across regions has to be measured the same way in each. These two
 * will therefore disagree about "today", and that is correct rather than a
 * defect — one answers "what is happening in Riyadh now", the other "how did
 * the three compare over a fortnight".
 *
 * Pure functions over a given instant, so the awkward hours can be exercised
 * without waiting for them.
 */

import { localClock, toMinutes } from "../business-hours.ts";
import type { RegionConfig } from "../regions.ts";

const MINUTE_MS = 60_000;
const DAY_MINUTES = 24 * 60;

/* ------------------------------------------------------------------ zones */

interface LocalParts {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
}

function localParts(instant: Date, timezone: string): LocalParts {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	}).formatToParts(instant);
	const get = (type: string) =>
		Number(parts.find((p) => p.type === type)?.value ?? "0");
	return {
		year: get("year"),
		month: get("month"),
		day: get("day"),
		hour: get("hour"),
		minute: get("minute"),
		second: get("second"),
	};
}

/**
 * The zone's offset from UTC at a given instant, in milliseconds.
 *
 * Read rather than looked up: formatting the instant in the zone and then
 * reading those numbers back as though they were UTC gives the offset, and it
 * is correct across daylight saving without this file holding a single rule
 * about when any country changes its clocks.
 */
export function zoneOffsetMs(instant: Date, timezone: string): number {
	const p = localParts(instant, timezone);
	const asIfUtc = Date.UTC(
		p.year,
		p.month - 1,
		p.day,
		p.hour,
		p.minute,
		p.second,
	);
	// The instant without its milliseconds, since the parts carry none.
	const whole = instant.getTime() - instant.getUTCMilliseconds();
	return asIfUtc - whole;
}

/**
 * The instant of local midnight, `dayOffset` days from the local date of
 * `now`.
 *
 * Done in two passes. The first uses the offset in force now, which is wrong
 * on the two days a year a region's clocks change between midnight and the
 * current hour; the second uses the offset in force at the midnight the first
 * pass found, which is right. Only the UK number is affected — Dubai and
 * Riyadh do not change their clocks — but an hour's error in "messages today"
 * is the sort of thing that gets a whole dashboard distrusted.
 */
export function localMidnight(
	now: Date,
	timezone: string,
	dayOffset = 0,
): Date {
	const p = localParts(now, timezone);
	const wallClock = Date.UTC(p.year, p.month - 1, p.day + dayOffset, 0, 0, 0);
	const firstPass = wallClock - zoneOffsetMs(now, timezone);
	const corrected = wallClock - zoneOffsetMs(new Date(firstPass), timezone);
	return new Date(corrected);
}

/** A closed interval covering the region's current day, as ISO instants. */
export function regionalDay(
	now: Date,
	timezone: string,
): { from: string; to: string } {
	return {
		from: localMidnight(now, timezone, 0).toISOString(),
		to: localMidnight(now, timezone, 1).toISOString(),
	};
}

/* --------------------------------------------------------------- greeting */

export type GreetingBand = "morning" | "afternoon" | "evening";

export function greetingBand(now: Date, timezone: string): GreetingBand {
	const { minutes } = localClock(now, timezone);
	if (minutes < 12 * 60) return "morning";
	if (minutes < 17 * 60) return "afternoon";
	return "evening";
}

/**
 * "Good morning, Mariam" in the region's hours.
 *
 * The name is used as given and never guessed at: an empty one produces a
 * greeting without a name rather than "Good morning, undefined", and a
 * dashboard that greets somebody by the wrong name is remembered for it.
 */
export function greeting(input: {
	displayName?: string | null;
	now: Date;
	timezone: string;
}): string {
	const band = greetingBand(input.now, input.timezone);
	const word =
		band === "morning"
			? "Good morning"
			: band === "afternoon"
				? "Good afternoon"
				: "Good evening";
	const name = input.displayName?.trim();
	return name ? `${word}, ${name}` : word;
}

/* ----------------------------------------------------------------- office */

export interface OfficeState {
	open: boolean;
	/**
	 * Minutes until the office next opens or closes, or null when the region
	 * has no working days configured at all.
	 */
	changesInMinutes: number | null;
	/** What the next change is: what you are waiting for. */
	nextChange: "opens" | "closes" | null;
	/** The region's own local time, "HH:mm", for the strip at the top. */
	localTime: string;
}

/**
 * Whether the region is working, and how long until that changes.
 *
 * The countdown is wall-clock minutes rather than business minutes, because it
 * answers "when will somebody be there", which is a question about the clock
 * on the wall. Service targets are counted in business minutes elsewhere and
 * that distinction is deliberate.
 *
 * Daylight saving is not applied to the countdown: a change that crosses a
 * clock change is out by an hour, twice a year, in the UK only. Worth knowing;
 * not worth a timezone database to fix a figure read as "opens in about two
 * hours".
 */
export function officeState(region: RegionConfig, now: Date): OfficeState {
	const { weekday, minutes } = localClock(now, region.timezone);
	const { days, start, end } = region.businessHours;
	const localTime = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(
		minutes % 60,
	).padStart(2, "0")}`;

	const working = [...new Set(days)].filter((d) => d >= 0 && d <= 6);
	if (working.length === 0) {
		return { open: false, changesInMinutes: null, nextChange: null, localTime };
	}

	const opensAt = toMinutes(start);
	const closesAt = toMinutes(end);

	if (working.includes(weekday) && minutes >= opensAt && minutes < closesAt) {
		return {
			open: true,
			changesInMinutes: closesAt - minutes,
			nextChange: "closes",
			localTime,
		};
	}

	// The next working day that has not already started without us: today
	// counts only if opening is still ahead.
	for (let offset = 0; offset <= 7; offset++) {
		const day = (weekday + offset) % 7;
		if (!working.includes(day)) continue;
		if (offset === 0 && minutes >= opensAt) continue;
		return {
			open: false,
			changesInMinutes: offset * DAY_MINUTES + opensAt - minutes,
			nextChange: "opens",
			localTime,
		};
	}

	// Unreachable while `working` is non-empty, since seven days covers every
	// weekday. Returning null rather than a wrong number if it ever is.
	return { open: false, changesInMinutes: null, nextChange: null, localTime };
}

/* ----------------------------------------------------------------- phrasing */

/**
 * A duration as somebody would say it.
 *
 * Rounded rather than precise. "Opens in 2 hours" is what a person wants to
 * know; "opens in 134 minutes" makes them do arithmetic to find out they have
 * time for lunch.
 */
export function describeMinutes(total: number | null): string {
	if (total === null) return "unknown";
	const minutes = Math.max(0, Math.round(total));
	if (minutes === 0) return "now";
	if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	if (hours < 24) {
		const h = `${hours} hour${hours === 1 ? "" : "s"}`;
		return rest === 0 ? h : `${h} ${rest} minute${rest === 1 ? "" : "s"}`;
	}
	const days = Math.floor(hours / 24);
	const restHours = hours % 24;
	const d = `${days} day${days === 1 ? "" : "s"}`;
	return restHours === 0
		? d
		: `${d} ${restHours} hour${restHours === 1 ? "" : "s"}`;
}

/** Whole minutes between two instants, never negative. */
export function minutesSince(iso: string | null, now: Date): number | null {
	if (!iso) return null;
	const then = Date.parse(iso);
	if (!Number.isFinite(then)) return null;
	return Math.max(0, Math.floor((now.getTime() - then) / MINUTE_MS));
}
