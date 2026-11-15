// Which files an import writes, under which names. Pure: no Obsidian imports.

import type { BackupNote } from "./backup";
import { fileBaseName, isValidTime, renderMarkdown } from "./render";

/** Sub-folder of the destination that notes from the ColorNote trash go to. */
export const TRASH_FOLDER = "Trash";

export interface PlanOptions {
	/** Vault-relative folder, already normalised; "" is the vault root. */
	destination: string;
	includeTrash: boolean;
	skipExisting: boolean;
	useFileDates: boolean;
}

/** Notes already in the vault, from the frontmatter of its Markdown files. */
export interface ExistingNotes {
	/** `colornote_uuid` values, lower-cased. */
	uuids: ReadonlySet<string>;
	/** `colornote_id` values of files that have no `colornote_uuid`. */
	legacyIds: ReadonlySet<number>;
}

export interface PlannedFile {
	note: BackupNote;
	/** Folder path ("" is the vault root). */
	folder: string;
	/** File name without `.md`, after de-duplication. */
	name: string;
	/** Vault path of the file. */
	path: string;
	content: string;
	/** File times to set, when "use ColorNote dates" is on and the dates are valid. */
	ctime?: number;
	mtime?: number;
}

export interface ImportPlan {
	/** Files to create, in writing order. */
	files: PlannedFile[];
	/** Notes left out because they are already in the vault. */
	skippedExisting: number;
	/** Notes in the selection (by the trash option) that are already in the vault. */
	alreadyInVault: number;
	/** Folders the files go to (destination first). */
	folders: string[];
	/** Per folder, the lower-cased file names taken, including the planned ones. */
	taken: Map<string, Set<string>>;
}

export function joinPath(folder: string, name: string): string {
	return folder === "" ? name : `${folder}/${name}`;
}

export function trashFolder(destination: string): string {
	return joinPath(destination, TRASH_FOLDER);
}

function nameKey(fileName: string): string {
	return fileName.normalize("NFC").toLowerCase();
}

function frontmatterNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && /^\s*-?\d+\s*$/.test(value)) return Number(value);
	return undefined;
}

function frontmatterText(value: unknown): string {
	if (typeof value === "string") return value.trim();
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return "";
}

/** Builds the index of notes already in the vault from frontmatter objects. */
export function indexExistingNotes(frontmatters: Iterable<Record<string, unknown> | null | undefined>): ExistingNotes {
	const uuids = new Set<string>();
	const legacyIds = new Set<number>();
	for (const fm of frontmatters) {
		if (!fm) continue;
		const uuid = frontmatterText(fm.colornote_uuid);
		if (uuid !== "") {
			uuids.add(uuid.toLowerCase());
			continue;
		}
		const id = frontmatterNumber(fm.colornote_id);
		if (id !== undefined) legacyIds.add(id);
	}
	return { uuids, legacyIds };
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)(?:\r?\n)?^---[ \t]*$/m;
const ID_LINE = /^(colornote_uuid|colornote_id):[ \t]*(?:"([^"\n]*)"|'([^'\n]*)'|([^#\n]*?))[ \t]*(?:#.*)?\r?$/gm;

/**
 * The `colornote_uuid` and `colornote_id` keys from the frontmatter of a file's
 * text, for files the metadata cache has not indexed yet. Only reads plain
 * top-level `key: value` lines, which is how this plugin writes them.
 */
export function readColorNoteKeys(content: string): Record<string, unknown> {
	const keys: Record<string, unknown> = {};
	const match = FRONTMATTER.exec(content);
	if (!match || match.index !== 0) return keys;
	for (const line of match[1].matchAll(ID_LINE)) keys[line[1]] = (line[2] ?? line[3] ?? line[4] ?? "").trim();
	return keys;
}

/** Whether a note is already in the vault (by uuid, or by id for files without a uuid). */
export function isInVault(note: BackupNote, existing: ExistingNotes): boolean {
	if (note.uuid !== "" && existing.uuids.has(note.uuid.toLowerCase())) return true;
	return note.id > 0 && existing.legacyIds.has(note.id);
}

/** `base`, or `base (2)`, `base (3)`, … — the first whose `.md` file name is not taken. */
export function uniqueName(base: string, taken: ReadonlySet<string>): string {
	if (!taken.has(nameKey(`${base}.md`))) return base;
	for (let n = 2; ; n++) {
		const candidate = `${base} (${n})`;
		if (!taken.has(nameKey(`${candidate}.md`))) return candidate;
	}
}

/** Creation order: ascending created date, then ascending id. */
function byCreation(a: BackupNote, b: BackupNote): number {
	return a.created - b.created || a.id - b.id;
}

/** The planned file for `note` under the final name `name`. */
export function planFile(note: BackupNote, folder: string, name: string, options: PlanOptions): PlannedFile {
	const file: PlannedFile = {
		note,
		folder,
		name,
		path: joinPath(folder, `${name}.md`),
		content: renderMarkdown(note, { fileName: name }),
	};
	if (options.useFileDates) {
		if (isValidTime(note.created)) file.ctime = note.created;
		if (isValidTime(note.modified)) file.mtime = note.modified;
	}
	return file;
}

/**
 * Plans an import.
 * @param existingNames per folder path, the names (with extension, any case)
 *   of the files already in it; folders that do not exist can be left out
 */
export function planImport(
	notes: readonly BackupNote[],
	options: PlanOptions,
	existingNames: ReadonlyMap<string, Iterable<string>>,
	existing: ExistingNotes,
): ImportPlan {
	const destination = options.destination;
	const trash = trashFolder(destination);
	const taken = new Map<string, Set<string>>();
	const takenIn = (folder: string): Set<string> => {
		let set = taken.get(folder);
		if (!set) {
			set = new Set(Array.from(existingNames.get(folder) ?? [], nameKey));
			taken.set(folder, set);
		}
		return set;
	};

	const files: PlannedFile[] = [];
	let skippedExisting = 0;
	let alreadyInVault = 0;
	for (const inTrash of [false, true]) {
		if (inTrash && !options.includeTrash) continue;
		const folder = inTrash ? trash : destination;
		for (const note of notes.filter((n) => n.inTrash === inTrash).sort(byCreation)) {
			if (isInVault(note, existing)) {
				alreadyInVault++;
				if (options.skipExisting) {
					skippedExisting++;
					continue;
				}
			}
			const names = takenIn(folder);
			const name = uniqueName(fileBaseName(note), names);
			names.add(nameKey(`${name}.md`));
			files.push(planFile(note, folder, name, options));
		}
	}

	const folders = [destination];
	if (files.some((f) => f.folder === trash)) folders.push(trash);
	return { files, skippedExisting, alreadyInVault, folders, taken };
}

/** Marks a name as taken in a plan's folder (for renames while writing). */
export function takeName(plan: ImportPlan, folder: string, name: string): void {
	let set = plan.taken.get(folder);
	if (!set) {
		set = new Set();
		plan.taken.set(folder, set);
	}
	set.add(nameKey(`${name}.md`));
}
