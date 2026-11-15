import assert from "node:assert/strict";
import { test } from "node:test";
import { type BackupNote, decodeBackup } from "../src/backup";
import {
	type ExistingNotes,
	indexExistingNotes,
	isInVault,
	type PlanOptions,
	planImport,
	readColorNoteKeys,
	uniqueName,
} from "../src/plan";
import { FIXTURE_NAMES, loadExpected, loadFixture, makeNote } from "./helpers";

const expected = loadExpected();
const NONE: ExistingNotes = { uuids: new Set(), legacyIds: new Set() };
const DEFAULTS: PlanOptions = {
	destination: "ColorNote",
	includeTrash: false,
	skipExisting: true,
	useFileDates: true,
};

async function sampleNotes(): Promise<BackupNote[]> {
	return (await decodeBackup(loadFixture("sample.backup"), expected["sample.backup"].password)).notes;
}

const uuid = (id: number): string => `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`;

test("plan for the sample backup with default options", async () => {
	const plan = planImport(await sampleNotes(), DEFAULTS, new Map(), NONE);
	assert.deepEqual(
		plan.files.map((f) => f.path),
		[
			"ColorNote/Shopping list.md",
			"ColorNote/Packing.md",
			"ColorNote/Secret plans.md",
			"ColorNote/Shopping list (2).md",
			"ColorNote/First line- becomes the name-.md",
			"ColorNote/buy milk.md",
			"ColorNote/Report- Q1-Q2 -draft- -1- a-b-c-d-e-f-g-h i.md",
			"ColorNote/Call bank.md",
			"ColorNote/CON_.md",
			`ColorNote/${"Д".repeat(120)}.md`,
			"ColorNote/Untitled 24.md",
			`ColorNote/${"a".repeat(119)}🐱.md`,
			"ColorNote/Version 2.0.md",
			"ColorNote/shopping LIST (3).md",
			"ColorNote/Unknown colour.md",
		],
	);
	assert.deepEqual(plan.folders, ["ColorNote"]);
	assert.equal(plan.skippedExisting, 0);
	assert.equal(plan.alreadyInVault, 0);
	const first = plan.files[0];
	assert.equal(first.ctime, 1600086400000);
	assert.equal(first.mtime, 1600172801234);
	assert.ok(plan.files[3].content.startsWith('---\naliases:\n  - "Shopping list"\n'));
});

test("trash notes go to <dest>/Trash, de-duplicated separately", async () => {
	const plan = planImport(await sampleNotes(), { ...DEFAULTS, includeTrash: true }, new Map(), NONE);
	const trash = plan.files.filter((f) => f.folder === "ColorNote/Trash").map((f) => f.path);
	assert.deepEqual(trash, ["ColorNote/Trash/Old todo.md", "ColorNote/Trash/Shopping list.md"]);
	assert.deepEqual(plan.folders, ["ColorNote", "ColorNote/Trash"]);
	assert.equal(plan.files.length, 17);
	// Locked checklist in the trash keeps its flag and its decrypted items.
	const oldTodo = plan.files.find((f) => f.name === "Old todo");
	assert.ok(oldTodo?.content.includes("\nlocked: true\n"));
	assert.ok(oldTodo?.content.endsWith("---\n- [x] done\n- [ ] not done\n"));
});

test("vault root destination", async () => {
	const plan = planImport(await sampleNotes(), { ...DEFAULTS, destination: "", includeTrash: true }, new Map(), NONE);
	assert.equal(plan.files[0].path, "Shopping list.md");
	assert.ok(plan.files.some((f) => f.path === "Trash/Old todo.md"));
});

test("names are de-duplicated case-insensitively against existing files", async () => {
	const existing = new Map([["ColorNote", ["SHOPPING LIST.md", "packing.MD", "Call bank.txt", "CON_.md"]]]);
	const plan = planImport(await sampleNotes(), DEFAULTS, existing, NONE);
	const names = plan.files.map((f) => f.name);
	assert.ok(names.includes("Shopping list (2)"));
	assert.ok(names.includes("Shopping list (3)"));
	assert.ok(names.includes("shopping LIST (4)"));
	assert.ok(names.includes("Packing (2)"));
	assert.ok(names.includes("Call bank"), "a .txt file does not block the .md name");
	assert.ok(names.includes("CON_ (2)"));
	assert.ok(!names.includes("Shopping list"));
});

test("uniqueName", () => {
	assert.equal(uniqueName("A", new Set()), "A");
	assert.equal(uniqueName("A", new Set(["a.md"])), "A (2)");
	assert.equal(uniqueName("A", new Set(["a.md", "a (2).md"])), "A (3)");
});

test("notes already in the vault: uuid match, legacy id match, skip toggle", async () => {
	const existing = indexExistingNotes([
		{ colornote_uuid: uuid(10).toUpperCase(), colornote_id: 999 },
		{ colornote_id: "21" }, // older export: id only
		{ colornote_id: 22, colornote_uuid: "11111111-2222-4333-8444-555555555555" }, // id ignored: has a uuid
		{ colornote_id: 23, colornote_uuid: "" }, // empty uuid counts as none
		{ colornote_uuid: uuid(14) }, // trash note
		{ title: "unrelated" },
		null,
		undefined,
	]);
	assert.deepEqual([...existing.legacyIds].sort(), [21, 23]);

	const notes = await sampleNotes();
	const skipping = planImport(notes, DEFAULTS, new Map(), existing);
	const ids = skipping.files.map((f) => f.note.id);
	assert.ok(!ids.includes(10) && !ids.includes(21) && !ids.includes(23));
	assert.ok(ids.includes(22), "id 22 is only on a file that has a different uuid");
	assert.equal(skipping.skippedExisting, 3);
	assert.equal(skipping.alreadyInVault, 3);
	// Note 15 now gets the plain name, since note 10 is skipped.
	assert.equal(skipping.files.find((f) => f.note.id === 15)?.name, "Shopping list");

	const withTrash = planImport(notes, { ...DEFAULTS, includeTrash: true }, new Map(), existing);
	assert.equal(withTrash.skippedExisting, 4);
	assert.deepEqual(
		withTrash.files.filter((f) => f.note.inTrash).map((f) => f.note.id),
		[13],
	);

	const notSkipping = planImport(notes, { ...DEFAULTS, skipExisting: false }, new Map(), existing);
	assert.equal(notSkipping.skippedExisting, 0);
	assert.equal(notSkipping.alreadyInVault, 3);
	assert.equal(notSkipping.files.length, 15);
});

test("processing order: created date, then id", () => {
	const notes = [
		makeNote({ id: 5, title: "Same", created: 2000 }),
		makeNote({ id: 3, title: "Same", created: 2000 }),
		makeNote({ id: 9, title: "Same", created: 1000 }),
	];
	const plan = planImport(notes, DEFAULTS, new Map(), NONE);
	assert.deepEqual(
		plan.files.map((f) => [f.note.id, f.name]),
		[
			[9, "Same"],
			[3, "Same (2)"],
			[5, "Same (3)"],
		],
	);
});

test("file dates can be turned off", async () => {
	const plan = planImport(await sampleNotes(), { ...DEFAULTS, useFileDates: false }, new Map(), NONE);
	assert.ok(plan.files.every((f) => f.ctime === undefined && f.mtime === undefined));
});

test("rendered output for all fixtures never contains secrets or internal records", async () => {
	for (const name of FIXTURE_NAMES) {
		const decoded = await decodeBackup(loadFixture(name), expected[name].password);
		const plan = planImport(decoded.notes, { ...DEFAULTS, includeTrash: true, skipExisting: false }, new Map(), NONE);
		const output = plan.files.map((f) => `${f.path}\n${f.content}`).join("\n");
		for (const secret of expected.secretsThatMustNeverAppearInOutput) {
			assert.ok(!output.includes(secret), `${name}: ${secret}`);
		}
		for (const word of ["syncable_settings", "name_master_password", "BACKUP_SECRET_KEY", "auth_token"]) {
			assert.ok(!output.includes(word), `${name}: ${word}`);
		}
	}
});

test("frontmatter keys of files the metadata cache has not indexed yet", async () => {
	// Round trip: what renderMarkdown writes is read back.
	const notes = await sampleNotes();
	const plan = planImport(notes, { ...DEFAULTS, includeTrash: true }, new Map(), NONE);
	const index = indexExistingNotes(plan.files.map((f) => readColorNoteKeys(f.content)));
	assert.equal(index.uuids.size, notes.length);
	assert.ok(notes.every((n) => isInVault(n, index)));

	assert.deepEqual(readColorNoteKeys("---\r\ncolornote_id: 21\r\ntitle: x\r\n---\r\nbody"), { colornote_id: "21" });
	assert.deepEqual(
		readColorNoteKeys("---\ncolornote_uuid: \"ABC-def\" # comment\ncolornote_id: '7'\n---\n"),
		{ colornote_uuid: "ABC-def", colornote_id: "7" },
	);
	assert.deepEqual(readColorNoteKeys("no frontmatter\ncolornote_id: 3\n"), {});
	assert.deepEqual(readColorNoteKeys("text\n---\ncolornote_id: 3\n---\n"), {});
	assert.deepEqual(readColorNoteKeys("---\ntags:\n  - a\n---\ncolornote_id: 3\n"), {});
	assert.deepEqual(indexExistingNotes([readColorNoteKeys("---\ncolornote_id: 42\n---\n")]).legacyIds, new Set([42]));
});
