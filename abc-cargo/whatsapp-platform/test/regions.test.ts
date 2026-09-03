import { test } from "node:test";
import assert from "node:assert/strict";
import {
	findRegionByPhoneNumberId,
	parseRegionConfig,
} from "../src/regions.ts";

const valid = [
	{
		id: "uae",
		label: "UAE",
		phoneNumberId: "111",
		displayNumber: "+971500000000",
		timezone: "Asia/Dubai",
		language: "en",
		businessHours: { days: [1, 2, 3, 4, 5, 6], start: "09:00", end: "18:00" },
	},
	{
		id: "region-2",
		label: "Region 2",
		phoneNumberId: "222",
		displayNumber: "+10000000000",
		timezone: "Asia/Dubai",
		language: "en",
		businessHours: { days: [1, 2, 3, 4, 5], start: "08:30", end: "17:30" },
	},
];

test("parses a valid configuration", () => {
	const regions = parseRegionConfig(JSON.stringify(valid));
	assert.equal(regions.length, 2);
	assert.equal(findRegionByPhoneNumberId(regions, "222")?.id, "region-2");
	assert.equal(findRegionByPhoneNumberId(regions, "999"), undefined);
});

test("rejects invalid JSON and empty arrays", () => {
	assert.throws(() => parseRegionConfig("not json"), /valid JSON/);
	assert.throws(() => parseRegionConfig("[]"), /non-empty/);
});

test("rejects duplicate ids and phone number ids", () => {
	const dupId = [valid[0], { ...valid[1], id: "uae" }];
	assert.throws(
		() => parseRegionConfig(JSON.stringify(dupId)),
		/Duplicate region id/,
	);
	const dupPhone = [valid[0], { ...valid[1], phoneNumberId: "111" }];
	assert.throws(
		() => parseRegionConfig(JSON.stringify(dupPhone)),
		/Duplicate phoneNumberId/,
	);
});

test("rejects malformed business hours", () => {
	const bad = [
		{ ...valid[0], businessHours: { days: [1], start: "9am", end: "18:00" } },
	];
	assert.throws(() => parseRegionConfig(JSON.stringify(bad)), /HH:mm/);
	const badDay = [
		{ ...valid[0], businessHours: { days: [7], start: "09:00", end: "18:00" } },
	];
	assert.throws(() => parseRegionConfig(JSON.stringify(badDay)), /0-6/);
});
