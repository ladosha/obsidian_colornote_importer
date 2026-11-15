import assert from "node:assert/strict";
import { test } from "node:test";
import { type BackupNote, decodeBackup } from "../src/backup";
import { fileBaseName, formatDate, reminderLines, renderBody, renderMarkdown, yamlString } from "../src/render";
import { decodeRecords, loadExpected, loadFixture, makeNote, noteRecord, withTimeZone } from "./helpers";

// Fixed zone for the local-time tests: UTC+4 all year (no DST).
process.env.TZ = "Asia/Tbilisi";

const expected = loadExpected();

async function sampleNotes(): Promise<Map<number, BackupNote>> {
	const decoded = await decodeBackup(loadFixture("sample.backup"), expected["sample.backup"].password);
	return new Map(decoded.notes.map((n) => [n.id, n]));
}

function note(notes: Map<number, BackupNote>, id: number): BackupNote {
	const n = notes.get(id);
	assert.ok(n, `note ${id}`);
	return n;
}

test("file base names of every exported fixture note (before de-duplication)", async () => {
	const notes = await sampleNotes();
	const want: Record<number, string> = {
		10: "Shopping list",
		11: "Packing",
		12: "Secret plans",
		13: "Old todo",
		14: "Shopping list",
		15: "Shopping list",
		16: "First line- becomes the name-",
		17: "buy milk",
		20: "Report- Q1-Q2 -draft- -1- a-b-c-d-e-f-g-h i",
		21: "Call bank",
		22: "CON_",
		23: "Д".repeat(120),
		24: "Untitled 24",
		25: `${"a".repeat(119)}🐱`,
		26: "Version 2.0",
		27: "shopping LIST",
		28: "Unknown colour",
	};
	assert.deepEqual([...notes.keys()].sort((a, b) => a - b), Object.keys(want).map(Number));
	for (const [id, name] of Object.entries(want)) assert.equal(fileBaseName(note(notes, Number(id))), name, `note ${id}`);

	const cut = fileBaseName(note(notes, 25));
	assert.equal(Array.from(cut).length, 120);
	assert.ok(cut.endsWith("\u{1F431}"), "the emoji is kept whole");
});

test("file name rules", () => {
	const name = (title: string, body = "", extra: Partial<BackupNote> = {}): string =>
		fileBaseName(makeNote({ id: 99, title, body, ...extra }));
	assert.equal(name("  Plain  "), "Plain");
	assert.equal(name("a\tb\nc"), "a b c");
	assert.equal(name("x\u0000y\u001fz\u007f"), "x-y-z-");
	assert.equal(name("many   inner   spaces"), "many inner spaces");
	assert.equal(name(". . .hidden. . ."), "hidden");
	assert.equal(name("...."), "Untitled 99");
	assert.equal(name("", "\n  \n"), "Untitled 99");
	assert.equal(name("", "[ ] \n[V]   \n[v] third item", { isChecklist: true }), "third item");
	assert.equal(name("", "[ ] not a checklist", { isChecklist: false }), "- - not a checklist");
	// NFC: "e" + combining acute becomes "é".
	assert.equal(name("Café"), "Café");
	// Windows device names, with and without an extension-like suffix.
	assert.equal(name("nul"), "nul_");
	assert.equal(name("Com7"), "Com7_");
	assert.equal(name("LPT1.notes"), "LPT1_.notes");
	assert.equal(name("CONSOLE"), "CONSOLE");
	assert.equal(name("COM10"), "COM10");
	// A cut that lands on spaces and dots is trimmed again.
	assert.equal(name(`${"b".repeat(118)} .xyz`), "b".repeat(118));
	// Long CJK titles are also kept under 240 UTF-8 bytes (80 x 3 bytes).
	assert.equal(name("漢".repeat(150)), "漢".repeat(80));
});

test("dates are written in local time as YYYY-MM-DD HH:mm, without an offset", () => {
	const ms = Date.UTC(2026, 10, 15, 10, 0, 0, 999);
	assert.equal(formatDate(ms), "2026-11-15 14:00");
	// Independent of the zone the test runs in:
	const d = new Date(ms);
	const p = (n: number): string => String(n).padStart(2, "0");
	assert.equal(formatDate(ms), `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`);
	// The seconds are dropped, not rounded.
	assert.equal(formatDate(Date.UTC(2015, 9, 11, 11, 13, 37)), "2015-10-11 15:13");
	assert.equal(formatDate(Date.UTC(2026, 10, 15, 19, 59, 59, 999)), "2026-11-15 23:59");
	assert.equal(withTimeZone("America/New_York", () => formatDate(ms)), "2026-11-15 05:00");
});

test("YAML strings are JSON-escaped", () => {
	assert.equal(yamlString('say "hi" \\ there'), '"say \\"hi\\" \\\\ there"');
	assert.equal(yamlString("tab\tnew\nline"), '"tab\\tnew\\nline"');
	assert.equal(yamlString("bell\u0007del\u007f"), '"bell\\u0007del\\u007f"');
	assert.equal(yamlString("ünï 🐱"), '"ünï 🐱"');
});

test("checklist body conversion", () => {
	const body = "[ ] a\r\n[V] b\r[v] c\n[ ]d\n[x] not a marker\n  [ ] indented\n\n";
	assert.equal(
		renderBody({ body, isChecklist: true }),
		"- [ ] a\n- [x] b\n- [x] c\n- [ ] d\n[x] not a marker\n  [ ] indented",
	);
	assert.equal(renderBody({ body: "[ ] a\n\n\n", isChecklist: false }), "[ ] a");
});

test("rendered Markdown: text note", async () => {
	const notes = await sampleNotes();
	assert.equal(
		renderMarkdown(note(notes, 10), { fileName: "Shopping list" }),
		[
			"---",
			"created: 2020-09-14 16:26",
			"modified: 2020-09-15 16:26",
			"colornote_type: text",
			"colornote_id: 10",
			"colornote_uuid: 00000000-0000-4000-8000-000000000010",
			"---",
			"milk",
			"eggs",
			"",
			"# looks like a heading",
			"",
		].join("\n"),
	);
});

test("rendered Markdown: checklist", async () => {
	const notes = await sampleNotes();
	assert.equal(
		renderMarkdown(note(notes, 11)),
		[
			"---",
			"created: 2020-09-15 16:26",
			"modified: 2020-09-16 16:26",
			"colornote_type: checklist",
			"color: green",
			"colornote_id: 11",
			"colornote_uuid: 00000000-0000-4000-8000-000000000011",
			"---",
			"- [ ] passport",
			"- [x] charger",
			"",
			"not an item",
			"- [x] lowercase checked",
			"- [ ] no space",
			"",
		].join("\n"),
	);
});

test("rendered Markdown: locked note", async () => {
	const notes = await sampleNotes();
	assert.equal(
		renderMarkdown(note(notes, 12)),
		[
			"---",
			"created: 2020-09-16 16:26",
			"modified: 2020-09-17 16:26",
			"colornote_type: text",
			"color: red",
			"locked: true",
			"colornote_id: 12",
			"colornote_uuid: 00000000-0000-4000-8000-000000000012",
			"---",
			"Meet at 7.",
			"ბოლო სიტყვა 🔒",
			"end",
			"",
		].join("\n"),
	);
});

test("rendered Markdown: all-day reminder, checked and colour", async () => {
	const notes = await sampleNotes();
	const n = note(notes, 21);
	assert.equal(
		renderMarkdown(n),
		[
			"---",
			"created: 2020-09-25 16:26",
			"modified: 2020-09-25 16:26",
			"colornote_type: text",
			"color: blue",
			"checked: true",
			"reminder: 2020-10-13",
			"reminder-type: allday",
			"colornote_id: 21",
			"colornote_uuid: 00000000-0000-4000-8000-000000000021",
			"---",
			"about the card",
			"",
		].join("\n"),
	);
});

test("rendered Markdown: aliases when the title differs from the file name", async () => {
	const notes = await sampleNotes();
	assert.equal(
		renderMarkdown(note(notes, 20)),
		[
			"---",
			"aliases:",
			'  - "...Report: Q1/Q2 [draft] #1? a\\\\b*c\\"d<e>f|g^h\\ti"',
			"created: 2020-09-24 16:26",
			"modified: 2020-09-24 16:26",
			"colornote_type: text",
			"colornote_id: 20",
			"colornote_uuid: 00000000-0000-4000-8000-000000000020",
			"---",
			"weird title",
			"",
		].join("\n"),
	);
	const dup = renderMarkdown(note(notes, 15), { fileName: "Shopping list (2)" });
	assert.ok(dup.startsWith('---\naliases:\n  - "Shopping list"\ncreated: '));
	const con = renderMarkdown(note(notes, 22));
	assert.ok(con.startsWith('---\naliases:\n  - "CON"\ncreated: '));
	assert.ok(con.includes("\ncolor: black\n"));
	// Same title and name: no alias. Blank title: no alias.
	assert.ok(!renderMarkdown(note(notes, 26), { fileName: "Version 2.0." }).includes("aliases"));
	assert.ok(!renderMarkdown(note(notes, 17)).includes("aliases"));
	assert.ok(renderMarkdown(note(notes, 26)).includes('aliases:\n  - "Version 2.0."\n'));
});

test("rendered Markdown: empty body, unknown colour, blank-title checklist", async () => {
	const notes = await sampleNotes();
	assert.equal(
		renderMarkdown(note(notes, 24)),
		[
			"---",
			"created: 2020-09-28 16:26",
			"modified: 2020-09-28 16:26",
			"colornote_type: text",
			"colornote_id: 24",
			"colornote_uuid: 00000000-0000-4000-8000-000000000024",
			"---",
			"",
		].join("\n"),
	);
	assert.ok(renderMarkdown(note(notes, 28)).includes("\ncolor: 12\n"));
	assert.ok(
		renderMarkdown(note(notes, 17)).endsWith(
			"colornote_uuid: 00000000-0000-4000-8000-000000000017\n---\n\n- [ ] buy milk\n- [x] call mom\n",
		),
	);
});

test("rendered Markdown: optional keys left out, colornote_type always written", () => {
	const bare = makeNote({ id: 0, uuid: "", title: "T", body: "b", created: 0, modified: 0 });
	assert.equal(renderMarkdown(bare, { fileName: "T" }), "---\ncolornote_type: text\n---\nb\n");
	const odd = makeNote({ id: 3, uuid: "not: a uuid", title: "T", lockedDecryptFailed: true, locked: true });
	assert.equal(
		renderMarkdown(odd, { fileName: "T" }),
		'---\ncolornote_type: text\nlocked: true\ncolornote_id: 3\ncolornote_uuid: "not: a uuid"\n---\n',
	);
});

/** The note decoded from one synthetic note record. */
async function decodeRecord(fields: Record<string, unknown>): Promise<BackupNote> {
	const [n] = await decodeRecords([noteRecord(fields)]);
	assert.ok(n);
	return n;
}

/** The reminder properties written for one synthetic note record. */
async function reminderProperties(fields: Record<string, unknown>): Promise<string[]> {
	return reminderLines((await decodeRecord(fields)).reminder);
}

/** FORMAT.md §7.3: a time alarm, daily until 30 November (set at UTC+4). */
const EXAMPLE = {
	reminder_type: 32,
	reminder_date: 1794739607000,
	reminder_base: 1794739607000,
	reminder_repeat: 16,
	reminder_repeat_ends: 1796068799000,
};
const MIDNIGHT = Date.UTC(2026, 10, 15);
const ALL_DAY = { reminder_type: 16, reminder_date: MIDNIGHT, reminder_base: MIDNIGHT };

/** The Markdown of a `noteRecord` with these reminder lines (and `extra` before them). */
function markdownWith(created: string, reminder: string[], extra: string[] = []): string {
	return [
		"---",
		`created: ${created}`,
		`modified: ${created}`,
		"colornote_type: text",
		...extra,
		...reminder,
		"colornote_id: 1",
		"colornote_uuid: 00000000-0000-4000-8000-0000000000aa",
		"---",
		"body",
		"",
	].join("\n");
}

test("reminder properties: the FORMAT.md §7.3 example at UTC+4", async () => {
	const n = await decodeRecord(EXAMPLE);
	const reminder = [
		"reminder: 2026-11-15T14:46",
		"reminder-type: time",
		"reminder-repeat: daily",
		"reminder-until: 2026-11-30",
	];
	assert.equal(renderMarkdown(n), markdownWith("2020-09-13 16:26", reminder));
});

test("reminder properties: time alarms and repeat ends are in the importing device's time zone", async () => {
	const n = await decodeRecord(EXAMPLE);
	assert.deepEqual(
		withTimeZone("America/New_York", () => reminderLines(n.reminder)),
		["reminder: 2026-11-15T05:46", "reminder-type: time", "reminder-repeat: daily", "reminder-until: 2026-11-30"],
	);
	// 2026-11-30T19:59:59Z is already 1 December at UTC+5:30.
	assert.deepEqual(
		withTimeZone("Asia/Kolkata", () => reminderLines(n.reminder)),
		["reminder: 2026-11-15T16:16", "reminder-type: time", "reminder-repeat: daily", "reminder-until: 2026-12-01"],
	);
	// The seconds are dropped, not rounded.
	const at = async (ms: number): Promise<string[]> => reminderProperties({ reminder_type: 32, reminder_date: ms });
	assert.deepEqual(await at(Date.UTC(2026, 10, 15, 10, 46, 59, 999)), ["reminder: 2026-11-15T14:46", "reminder-type: time"]);
	assert.deepEqual(await at(Date.UTC(2026, 10, 15, 19, 59, 59, 999)), ["reminder: 2026-11-15T23:59", "reminder-type: time"]);
	assert.deepEqual(await at(Date.UTC(2026, 10, 15, 20, 0, 0)), ["reminder: 2026-11-16T00:00", "reminder-type: time"]);
});

test("reminder properties: an all-day reminder has its UTC date in any time zone", async () => {
	const n = await decodeRecord(ALL_DAY);
	const want = ["reminder: 2026-11-15", "reminder-type: allday"];
	assert.deepEqual(reminderLines(n.reminder), want);
	for (const zone of ["America/Los_Angeles", "Pacific/Kiritimati", "UTC"]) {
		assert.deepEqual(
			withTimeZone(zone, () => reminderLines(n.reminder)),
			want,
			zone,
		);
	}
	assert.equal(renderMarkdown(n), markdownWith("2020-09-13 16:26", want));
});

test("reminder properties: a note pinned to the status bar", async () => {
	// A pin has no date and does not repeat, whatever the repeat fields say.
	const n = await decodeRecord({
		reminder_type: 128,
		reminder_date: -1,
		reminder_repeat: 16,
		reminder_repeat_ends: 1796068799000,
		status: 16,
	});
	const want = markdownWith("2020-09-13 16:26", ["reminder-type: statusbar"], ["checked: true"]);
	assert.equal(renderMarkdown(n), want);
});

test("reminder properties: every repeat value, for time alarms and all-day reminders", async () => {
	const repeats: [number, string][] = [
		[16, "daily"],
		[48, "weekly"],
		[64, "biweekly"],
		[80, "monthly-weekday"],
		[96, "monthly"],
		[112, "yearly"],
		[128, "yearly-lunar"],
	];
	for (const [value, name] of repeats) {
		assert.deepEqual(
			await reminderProperties({ ...EXAMPLE, reminder_repeat: value, reminder_repeat_ends: 0 }),
			["reminder: 2026-11-15T14:46", "reminder-type: time", `reminder-repeat: ${name}`],
			`time, ${value}`,
		);
		assert.deepEqual(
			await reminderProperties({ ...ALL_DAY, reminder_repeat: value }),
			["reminder: 2026-11-15", "reminder-type: allday", `reminder-repeat: ${name}`],
			`all-day, ${value}`,
		);
	}
});

test("reminder properties: one-time reminders and unknown repeat values have no repeat lines", async () => {
	// The repeat end is set too, but is not written without a repeat.
	for (const value of [0, 32, 1, -16]) {
		assert.deepEqual(
			await reminderProperties({ ...EXAMPLE, reminder_repeat: value }),
			["reminder: 2026-11-15T14:46", "reminder-type: time"],
			`time, ${value}`,
		);
		assert.deepEqual(
			await reminderProperties({ ...ALL_DAY, reminder_repeat: value, reminder_repeat_ends: 1796068799000 }),
			["reminder: 2026-11-15", "reminder-type: allday"],
			`all-day, ${value}`,
		);
	}
});

test("reminder properties: repeat end", async () => {
	assert.deepEqual(await reminderProperties({ ...ALL_DAY, reminder_repeat: 48, reminder_repeat_ends: 1796068799000 }), [
		"reminder: 2026-11-15",
		"reminder-type: allday",
		"reminder-repeat: weekly",
		"reminder-until: 2026-11-30",
	]);
	// Never ends.
	assert.deepEqual(await reminderProperties({ ...EXAMPLE, reminder_repeat_ends: 0 }), [
		"reminder: 2026-11-15T14:46",
		"reminder-type: time",
		"reminder-repeat: daily",
	]);
});

test("reminder properties: none when reminder_date is 0, whatever the other fields say", async () => {
	const stale = [
		{ ...EXAMPLE, reminder_date: 0 },
		{ ...ALL_DAY, reminder_date: 0, reminder_repeat: 112, reminder_repeat_ends: 1796068799000 },
		{ reminder_type: 128, reminder_date: 0 },
	];
	for (const fields of stale) {
		const markdown = renderMarkdown(await decodeRecord(fields));
		assert.equal(markdown, markdownWith("2020-09-13 16:26", []));
		assert.ok(!markdown.includes("reminder"));
	}
	assert.deepEqual(reminderLines(null), []);
});

test("reminder properties: dates that cannot be written are left out", () => {
	assert.deepEqual(reminderLines({ kind: "time", date: 9e15, repeat: "daily", repeatEnds: 0 }), []);
	assert.deepEqual(reminderLines({ kind: "all-day", date: 9e15, repeat: null, repeatEnds: 0 }), []);
	assert.deepEqual(reminderLines({ kind: "time", date: MIDNIGHT, repeat: "daily", repeatEnds: 9e15 }), [
		"reminder: 2026-11-15T04:00",
		"reminder-type: time",
		"reminder-repeat: daily",
	]);
});
