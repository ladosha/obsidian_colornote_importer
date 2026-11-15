import assert from "node:assert/strict";
import { test } from "node:test";
import { type BackupNote, decodeBackup, passwordLowBytes, type Reminder } from "../src/backup";
import {
	ascii,
	assertRejects,
	buildBackup,
	buildPlaintext,
	decodeRecords,
	type ExpectedRecord,
	FIXTURE_NAMES,
	loadExpected,
	loadFixture,
	noteRecord,
} from "./helpers";

const expected = loadExpected();

/** The normalised note expected for a fixture record, or undefined if it is not exported. */
function expectedNote(r: ExpectedRecord): BackupNote | undefined {
	const internal =
		r.type === 256 || r.active_state === 256 || ["syncable_settings", "name_master_password"].includes(r.title);
	if (internal || (r.active_state !== 0 && r.active_state !== 16)) return undefined;
	// The fixtures hold no status-bar pins and no repeating reminders; the
	// reminder tests below cover those.
	assert.ok(r.reminder_date >= 0 && r.reminder_repeat === 0, `record ${r._id}: reminder`);
	return {
		id: r._id,
		uuid: r.uuid,
		title: r.title,
		body: r.note,
		isChecklist: r.type === 16,
		inTrash: r.active_state === 16,
		colorIndex: r.color_index,
		locked: r.encrypted === 1,
		lockedDecryptFailed: false,
		checked: (r.status & 16) !== 0,
		created: r.created_date,
		modified: r.modified_date,
		reminder:
			r.reminder_date === 0
				? null
				: { kind: r.reminder_type === 16 ? "all-day" : "time", date: r.reminder_date, repeat: null, repeatEnds: 0 },
	};
}

for (const name of FIXTURE_NAMES) {
	test(`decodes ${name} as expected.json describes`, async () => {
		const fixture = expected[name];
		const decoded = await decodeBackup(loadFixture(name), fixture.password);
		assert.deepEqual(decoded.formatVersion, fixture.formatVersion);
		assert.equal(decoded.createdAt, fixture.createdAt);
		assert.equal(decoded.headerNoteCount, fixture.headerNoteCount);
		assert.equal(decoded.recovered, false);
		const want = fixture.records.map(expectedNote).filter((n): n is BackupNote => n !== undefined);
		assert.deepEqual(decoded.notes, want);
	});
}

test("sample.backup: sections, ignored account and unknown sections, exclusions", async () => {
	const fixture = expected["sample.backup"];
	const decoded = await decodeBackup(loadFixture("sample.backup"), fixture.password);
	const account = decoded.sections.filter((s) => s.kind === 1);
	assert.deepEqual(account, [{ kind: 1, records: fixture.accountRecordCount }]);
	for (const kind of fixture.unknownSectionKinds ?? []) {
		assert.ok(decoded.sections.some((s) => s.kind === kind), `section kind ${kind} seen`);
	}
	const noteRecords = decoded.sections.filter((s) => s.kind === 2).reduce((n, s) => n + s.records, 0);
	assert.equal(noteRecords, fixture.records.length);
	// 1 syncable_settings, 2 name_master_password, 19 active_state 256; 18 deleted.
	assert.deepEqual(decoded.excluded, { internal: 3, deleted: 1, other: 0 });
	assert.deepEqual(
		decoded.notes.map((n) => n.id),
		[10, 11, 12, 13, 14, 15, 16, 17, 20, 21, 22, 23, 24, 25, 26, 27, 28],
	);
	// Locked notes are decrypted, including the one in the trash.
	const locked = decoded.notes.filter((n) => n.locked);
	assert.deepEqual(locked.map((n) => [n.id, n.lockedDecryptFailed]), [[12, false], [13, false]]);
	assert.equal(locked[0].body, "Meet at 7.\rბოლო სიტყვა 🔒\r\nend");
});

test("no password: an empty password means 0000", async () => {
	const data = loadFixture("no-password.backup");
	const withEmpty = await decodeBackup(data, "");
	const withDefault = await decodeBackup(data, "0000");
	assert.deepEqual(withEmpty, withDefault);
	assert.equal(withEmpty.notes.length, 1);
	assert.equal(withEmpty.notes[0].title, "Hello");
});

test("latin1 password opens through the low-byte encoding", async () => {
	const decoded = await decodeBackup(loadFixture("latin1-password.backup"), "pässwörd");
	assert.equal(decoded.passwordEncoding, "low-byte");
	assert.equal(decoded.notes[0].body, "no master password set");
	await assertRejects(decodeBackup(loadFixture("latin1-password.backup"), "passwort"), "wrong-password");
});

test("non-ASCII password falls back to UTF-8 bytes", async () => {
	const plaintext = buildPlaintext([{ kind: 2, records: [noteRecord({ title: "UTF-8" })] }]);
	const password = "пароль";
	const data = await buildBackup(plaintext, new TextEncoder().encode(password));
	const decoded = await decodeBackup(data, password);
	assert.equal(decoded.passwordEncoding, "utf-8");
	assert.equal(decoded.notes[0].title, "UTF-8");
	// And the low-byte form, which is tried first, still works for the same text.
	const lowByte = await buildBackup(plaintext, passwordLowBytes(password));
	assert.equal((await decodeBackup(lowByte, password)).passwordEncoding, "low-byte");
});

test("wrong password", async () => {
	await assertRejects(decodeBackup(loadFixture("sample.backup"), "wrong horse 7"), "wrong-password");
	await assertRejects(decodeBackup(loadFixture("sample.backup"), ""), "wrong-password");
	await assertRejects(decodeBackup(loadFixture("no-password.backup"), "1234"), "wrong-password");
});

test("not a ColorNote backup", async () => {
	await assertRejects(decodeBackup(ascii("hello, this is not a backup at all"), "0000"), "not-colornote");
	await assertRejects(decodeBackup(new Uint8Array(0), "0000"), "not-colornote");
	await assertRejects(decodeBackup(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0]), ""), "not-colornote");
	// "NOTE" in UTF-16LE is not the magic either.
	await assertRejects(decodeBackup(new Uint8Array([0x4e, 0, 0x4f, 0, 0x54, 0, 0x45, 0, ...new Uint8Array(40)]), ""), "not-colornote");
});

test("truncated or damaged files", async () => {
	const fixture = expected["sample.backup"];
	const data = loadFixture("sample.backup");
	// Length of the encrypted part not a multiple of 16.
	await assertRejects(decodeBackup(data.slice(0, data.length - 5), fixture.password), "damaged");
	// Cut inside the header.
	await assertRejects(decodeBackup(data.slice(0, 20), fixture.password), "damaged");
	// Header only.
	await assertRejects(decodeBackup(data.slice(0, 28), fixture.password), "damaged");
	// Cut on a block boundary: the padding check fails, but the first block
	// shows that the password is right.
	await assertRejects(decodeBackup(data.slice(0, data.length - 32), fixture.password), "damaged");
	// The same cut with a wrong password is still reported as a wrong password.
	await assertRejects(decodeBackup(data.slice(0, data.length - 32), "nope"), "wrong-password");
});

test("valid padding but unparsable plaintext is not accepted", async () => {
	const garbage = new Uint8Array(64).fill(0xab);
	const data = await buildBackup(garbage, ascii("0000"));
	await assertRejects(decodeBackup(data, "0000"), "wrong-password");
});

test("lenient fallback recovers note records from a damaged structure", async () => {
	const good = buildPlaintext([
		{ kind: 1, records: [{ auth_token: "FAKE-AUTH-TOKEN-DO-NOT-EXPORT" }] },
		{ kind: 2, records: [noteRecord({ _id: 7, title: "Kept" }), noteRecord({ _id: 8, title: "Also kept" })] },
	]);
	// Break the note section's record count so the strict parse fails.
	const broken = good.slice();
	const view = new DataView(broken.buffer);
	const accountLength = view.getUint32(8); // kind@0, count@4, first record length@8
	view.setUint32(8 + 4 + accountLength + 4, 99);
	const decoded = await decodeBackup(await buildBackup(broken, ascii("0000")), "");
	assert.equal(decoded.recovered, true);
	assert.deepEqual(decoded.sections, []);
	assert.deepEqual(
		decoded.notes.map((n) => [n.id, n.title]),
		[
			[7, "Kept"],
			[8, "Also kept"],
		],
	);
	assert.ok(!JSON.stringify(decoded).includes("FAKE-AUTH-TOKEN"));
});

test("defensive field reading and exclusions", async () => {
	const records = [
		noteRecord({ _id: "5", title: 42, note: "numeric title", status: "16", color_index: "4", encrypted: false }),
		noteRecord({ _id: 6, type: "16", note: "[ ] item", active_state: "16", created_date: "1600000000123" }),
		noteRecord({ _id: 9, active_state: 32 }),
		noteRecord({ _id: 10, active_state: 64 }),
		noteRecord({ _id: 11, type: 256 }),
		noteRecord({ _id: 12, title: " name_master_password ", note: "{\"D\":{}}" }),
		{ _id: 13, title: "no type", note: "x" },
		{ _id: 14, title: "no note", type: 0 },
		noteRecord({ _id: 15, type: 1, title: "Unknown type" }),
		noteRecord({ _id: 16, encrypted: 1, note: "not base64!", title: "Broken lock" }),
		noteRecord({ _id: 17, encrypted: "1", note: "", title: "Empty lock" }),
	];
	const plaintext = buildPlaintext([{ kind: 2, records }]);
	const decoded = await decodeBackup(await buildBackup(plaintext, ascii("0000")), "");
	assert.deepEqual(decoded.excluded, { internal: 4, deleted: 1, other: 1 });
	const byId = new Map(decoded.notes.map((n) => [n.id, n]));
	assert.deepEqual([...byId.keys()], [5, 6, 15, 16, 17]);
	const n5 = byId.get(5);
	assert.equal(n5?.title, "42");
	assert.equal(n5?.checked, true);
	assert.equal(n5?.colorIndex, 4);
	assert.equal(n5?.locked, false);
	const n6 = byId.get(6);
	assert.equal(n6?.isChecklist, true);
	assert.equal(n6?.inTrash, true);
	assert.equal(n6?.created, 1600000000123);
	assert.equal(byId.get(15)?.isChecklist, false);
	assert.deepEqual([byId.get(16)?.locked, byId.get(16)?.lockedDecryptFailed, byId.get(16)?.body], [true, true, ""]);
	assert.deepEqual([byId.get(17)?.locked, byId.get(17)?.lockedDecryptFailed, byId.get(17)?.body], [true, false, ""]);
});

test("decoded output never contains the account record or internal records", async () => {
	for (const name of FIXTURE_NAMES) {
		const decoded = await decodeBackup(loadFixture(name), expected[name].password);
		const text = JSON.stringify(decoded);
		for (const secret of expected.secretsThatMustNeverAppearInOutput) assert.ok(!text.includes(secret), secret);
		assert.ok(!text.includes("syncable_settings"));
		assert.ok(!text.includes("name_master_password"));
	}
});

/** The reminders of synthetic note records, by `_id`. */
async function reminders(records: Record<string, unknown>[]): Promise<Map<number, Reminder | null>> {
	return new Map((await decodeRecords(records)).map((n) => [n.id, n.reminder]));
}

/** FORMAT.md §7.3: a time alarm, daily until 30 November (set at UTC+4). */
const EXAMPLE = {
	reminder_type: 32,
	reminder_date: 1794739607000,
	reminder_base: 1794739607000,
	reminder_repeat: 16,
	reminder_repeat_ends: 1796068799000,
};

test("sample.backup: the all-day reminder of note 21", async () => {
	const decoded = await decodeBackup(loadFixture("sample.backup"), expected["sample.backup"].password);
	const withReminder = decoded.notes.filter((n) => n.reminder !== null);
	assert.deepEqual(
		withReminder.map((n) => [n.id, n.reminder]),
		[[21, { kind: "all-day", date: 1602594700000, repeat: null, repeatEnds: 0 }]],
	);
});

test("reminder kinds (FORMAT.md §7.1)", async () => {
	const midnight = Date.UTC(2026, 10, 15);
	const decoded = await reminders([
		noteRecord({ _id: 1, ...EXAMPLE }),
		noteRecord({ _id: 2, reminder_type: 16, reminder_date: midnight, reminder_base: midnight }),
		noteRecord({ _id: 3, reminder_type: 128, reminder_date: -1 }),
		// A pin does not repeat, whatever the repeat fields say.
		noteRecord({ _id: 4, reminder_type: 128, reminder_date: -1, reminder_repeat: 16, reminder_repeat_ends: 1796068799000 }),
		// Any type other than 16 with a date is a time alarm.
		noteRecord({ _id: 5, reminder_type: 0, reminder_date: 1794739607000 }),
		noteRecord({ _id: 6, reminder_type: 128, reminder_date: 1794739607000 }),
		noteRecord({ _id: 7, reminder_type: 64, reminder_date: 1794739607000 }),
		// -1 marks a pin (FORMAT.md §4); other negative dates only with the pin type.
		noteRecord({ _id: 8, reminder_type: 32, reminder_date: -1 }),
		noteRecord({ _id: 9, reminder_type: 128, reminder_date: -2 }),
		noteRecord({ _id: 10, reminder_type: 32, reminder_date: -2 }),
		// Read defensively, like the other fields.
		noteRecord({
			_id: 11,
			reminder_type: "16",
			reminder_date: String(midnight),
			reminder_repeat: "112",
			reminder_repeat_ends: "1796068799000",
		}),
	]);
	const time = (date: number): Reminder => ({ kind: "time", date, repeat: null, repeatEnds: 0 });
	assert.deepEqual(
		[...decoded],
		[
			[1, { kind: "time", date: 1794739607000, repeat: "daily", repeatEnds: 1796068799000 }],
			[2, { kind: "all-day", date: midnight, repeat: null, repeatEnds: 0 }],
			[3, { kind: "status-bar" }],
			[4, { kind: "status-bar" }],
			[5, time(1794739607000)],
			[6, time(1794739607000)],
			[7, time(1794739607000)],
			[8, { kind: "status-bar" }],
			[9, { kind: "status-bar" }],
			[10, null],
			[11, { kind: "all-day", date: midnight, repeat: "yearly", repeatEnds: 1796068799000 }],
		],
	);
});

test("no pending reminder when reminder_date is 0 or missing (FORMAT.md §7)", async () => {
	const decoded = await reminders([
		noteRecord({ _id: 1, ...EXAMPLE, reminder_date: 0 }),
		noteRecord({ _id: 2, reminder_type: 16, reminder_date: 0, reminder_base: Date.UTC(2026, 10, 15), reminder_repeat: 112 }),
		noteRecord({ _id: 3, reminder_type: 128, reminder_date: 0 }),
		// In the trash, after a one-time reminder went off.
		noteRecord({ _id: 4, ...EXAMPLE, reminder_date: 0, reminder_repeat: 0, reminder_repeat_ends: 0, active_state: 16 }),
		noteRecord({ _id: 5, reminder_type: 32, reminder_date: undefined }),
		noteRecord({ _id: 6, reminder_type: 32, reminder_date: "" }),
	]);
	assert.deepEqual([...decoded], [1, 2, 3, 4, 5, 6].map((id) => [id, null]));
});

test("repeat values and ends (FORMAT.md §7.2)", async () => {
	const repeats: [number, string | null][] = [
		[0, null],
		[16, "daily"],
		[48, "weekly"],
		[64, "biweekly"],
		[80, "monthly-weekday"],
		[96, "monthly-day"],
		[112, "yearly"],
		[128, "lunar-yearly"],
		// Unknown values: the reminder is kept, but not as repeating.
		[32, null],
		[1, null],
		[-16, null],
	];
	const ends = 1796068799000;
	const midnight = Date.UTC(2026, 10, 15);
	const records = repeats.flatMap(([value], i) => [
		noteRecord({ _id: 100 + i, ...EXAMPLE, reminder_repeat: value }),
		noteRecord({ _id: 200 + i, reminder_type: 16, reminder_date: midnight, reminder_repeat: value, reminder_repeat_ends: ends }),
	]);
	const decoded = await reminders(records);
	repeats.forEach(([value, repeat], i) => {
		const repeatEnds = repeat === null ? 0 : ends;
		assert.deepEqual(decoded.get(100 + i), { kind: "time", date: EXAMPLE.reminder_date, repeat, repeatEnds }, `time, ${value}`);
		assert.deepEqual(decoded.get(200 + i), { kind: "all-day", date: midnight, repeat, repeatEnds }, `all-day, ${value}`);
	});

	// Repetitions that never end; a negative end is read as never.
	const never = await reminders([
		noteRecord({ _id: 1, ...EXAMPLE, reminder_repeat_ends: 0 }),
		noteRecord({ _id: 2, ...EXAMPLE, reminder_repeat_ends: -1 }),
		noteRecord({ _id: 3, ...EXAMPLE, reminder_repeat_ends: undefined }),
	]);
	for (const id of [1, 2, 3]) {
		assert.deepEqual(never.get(id), { kind: "time", date: EXAMPLE.reminder_date, repeat: "daily", repeatEnds: 0 }, `${id}`);
	}
});
