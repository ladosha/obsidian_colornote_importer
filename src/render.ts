// File names and Markdown for imported notes. Pure: no Obsidian imports.

import type { BackupNote, Reminder, ReminderKind, ReminderRepeat } from "./backup";

/** Whose calendar a time is written in: UTC, or the device's local time zone. */
type Zone = "utc" | "local";

export const COLOR_NAMES: Readonly<Record<number, string>> = {
	1: "red",
	2: "orange",
	3: "yellow",
	4: "green",
	5: "blue",
	6: "purple",
	7: "black",
	8: "gray",
	9: "white",
};
const DEFAULT_COLOR_INDEX = 3;

/** `reminder-type` values, as the Note Pin plugin reads them. */
const REMINDER_TYPES: Readonly<Record<ReminderKind, string>> = {
	time: "time",
	"all-day": "allday",
	"status-bar": "statusbar",
};

/** `reminder-repeat` values, as the Note Pin plugin reads them. */
const REMINDER_REPEATS: Readonly<Record<ReminderRepeat, string>> = {
	daily: "daily",
	weekly: "weekly",
	biweekly: "biweekly",
	"monthly-weekday": "monthly-weekday",
	"monthly-day": "monthly",
	yearly: "yearly",
	"lunar-yearly": "yearly-lunar",
};

/** File names are cut to this many code points. */
export const MAX_NAME_CODE_POINTS = 120;
/**
 * And to this many UTF-8 bytes, so that the name plus " (99)" and ".md" stays
 * under the 255-byte file name limit of Android, iOS, macOS and Linux file
 * systems. Only names of long non-Latin titles (CJK, emoji) reach it.
 */
export const MAX_NAME_BYTES = 240;

const MAX_TIME = 8.64e15; // the largest time a Date can hold

/** Whether a time can be written as a date (and used as a file time). */
export function isValidTime(ms: number): boolean {
	return Number.isFinite(ms) && ms > 0 && ms <= MAX_TIME;
}

function pad(n: number, width = 2): string {
	return String(n).padStart(width, "0");
}

/** The calendar date (`YYYY-MM-DD`) and time of day (`HH:mm:ss`) of a time, in UTC or local time. */
function dateParts(ms: number, zone: Zone): { day: string; time: string } {
	const d = new Date(ms);
	if (zone === "utc") {
		return {
			day: `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
			time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`,
		};
	}
	return {
		day: `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
		time: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
	};
}

/**
 * `YYYY-MM-DD HH:mm` in local wall-clock time without an offset: the format
 * of the Dated plugin, which Obsidian's Date & time properties also read. The
 * seconds are dropped, not rounded.
 */
export function formatDate(ms: number): string {
	const { day, time } = dateParts(ms, "local");
	return `${day} ${time.slice(0, 5)}`;
}

/**
 * The reminder properties (FORMAT.md §7), in the form the Note Pin plugin
 * reads.
 *
 * - `reminder`: for a time alarm, the local date and time to the minute
 *   (`YYYY-MM-DDTHH:mm`); for an all-day reminder, its date (`YYYY-MM-DD`).
 *   A status-bar pin has none.
 * - `reminder-type`: `time`, `allday` or `statusbar`.
 * - `reminder-repeat`: how a time alarm or all-day reminder repeats; left out
 *   when it is one-time or its repeat value is not known.
 * - `reminder-until`: the last day a repeating reminder goes off (its local
 *   date), if the repetition ends.
 */
export function reminderLines(reminder: Reminder | null): string[] {
	if (!reminder) return [];
	const type = `reminder-type: ${REMINDER_TYPES[reminder.kind]}`;
	if (reminder.kind === "status-bar") return [type];
	if (!isValidTime(reminder.date)) return [];
	let due: string;
	if (reminder.kind === "all-day") {
		// The UTC date, whatever the time zone of the device that set it.
		due = dateParts(reminder.date, "utc").day;
	} else {
		const { day, time } = dateParts(reminder.date, "local");
		due = `${day}T${time.slice(0, 5)}`; // the seconds are dropped, not rounded
	}
	const lines = [`reminder: ${due}`, type];
	if (reminder.repeat) {
		lines.push(`reminder-repeat: ${REMINDER_REPEATS[reminder.repeat]}`);
		if (isValidTime(reminder.repeatEnds)) {
			lines.push(`reminder-until: ${dateParts(reminder.repeatEnds, "local").day}`);
		}
	}
	return lines;
}

/** `\r\n` and lone `\r` become `\n`. */
export function normalizeLineEndings(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}

const CHECKLIST_MARKER = /^\[[ Vv]\] ?/;
const UNCHECKED_ITEM = /^\[ \] ?/;
const CHECKED_ITEM = /^\[[Vv]\] ?/;
// Characters not allowed in file names on some platform or in Obsidian links,
// and control characters.
// eslint-disable-next-line no-control-regex -- control characters are exactly what this removes
const FORBIDDEN_CHARS = /[\\/:*?"<>|#^[\]\u0000-\u001f\u007f]/g;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function stripDotsAndSpaces(text: string): string {
	let out = text;
	for (;;) {
		const next = out.replace(/^[. ]+/, "").replace(/[. ]+$/, "");
		if (next === out) return out;
		out = next;
	}
}

function utf8Length(codePoint: string): number {
	const cp = codePoint.codePointAt(0) ?? 0;
	return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
}

/** The text a note's file name is made from: its title, else its first line. */
function nameSource(note: Pick<BackupNote, "title" | "body" | "isChecklist">): string {
	const title = note.title.trim();
	if (title !== "") return title;
	for (const rawLine of normalizeLineEndings(note.body).split("\n")) {
		const line = (note.isChecklist ? rawLine.replace(CHECKLIST_MARKER, "") : rawLine).trim();
		if (line !== "") return line;
	}
	return "";
}

/**
 * The file name (without `.md` and before de-duplication) for a note.
 */
export function fileBaseName(note: Pick<BackupNote, "id" | "title" | "body" | "isChecklist">): string {
	let name = nameSource(note).normalize("NFC");
	name = name.replace(/[\t\n\r]/g, " ").replace(FORBIDDEN_CHARS, "-");
	name = stripDotsAndSpaces(name.replace(/\s+/g, " ").trim());

	// Cut whole code points, so a surrogate pair is never split.
	const codePoints = Array.from(name).slice(0, MAX_NAME_CODE_POINTS);
	let bytes = codePoints.reduce((sum, c) => sum + utf8Length(c), 0);
	while (bytes > MAX_NAME_BYTES) bytes -= utf8Length(codePoints.pop() ?? "");
	name = stripDotsAndSpaces(codePoints.join(""));

	if (name === "") name = `Untitled ${note.id}`;

	// "CON", "con.txt": the part before the first dot is a Windows device name.
	const dot = name.indexOf(".");
	const stem = dot === -1 ? name : name.slice(0, dot);
	if (WINDOWS_RESERVED.test(stem)) name = `${stem}_${name.slice(stem.length)}`;
	return name;
}

/** A YAML double-quoted scalar: JSON escaping plus the non-printable C1 range. */
export function yamlString(text: string): string {
	return JSON.stringify(text).replace(
		/[\u007f-\u009f￾￿]/g,
		(c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The Markdown body: `\n` line endings, checklist items as tasks, no trailing newlines. */
export function renderBody(note: Pick<BackupNote, "body" | "isChecklist">): string {
	let text = normalizeLineEndings(note.body);
	if (note.isChecklist) {
		text = text
			.split("\n")
			.map((line) => {
				if (UNCHECKED_ITEM.test(line)) return `- [ ] ${line.replace(UNCHECKED_ITEM, "")}`;
				if (CHECKED_ITEM.test(line)) return `- [x] ${line.replace(CHECKED_ITEM, "")}`;
				return line;
			})
			.join("\n");
	}
	return text.replace(/\n+$/, "");
}

export interface RenderOptions {
	/** The final file name without `.md`; defaults to `fileBaseName(note)`. */
	fileName?: string;
}

/** The complete Markdown file for a note: frontmatter, then the body. */
export function renderMarkdown(note: BackupNote, options: RenderOptions = {}): string {
	const name = options.fileName ?? fileBaseName(note);
	const title = note.title.trim();
	const lines = ["---"];
	if (title !== "" && title !== name) lines.push("aliases:", `  - ${yamlString(title)}`);
	if (isValidTime(note.created)) lines.push(`created: ${formatDate(note.created)}`);
	if (isValidTime(note.modified)) lines.push(`modified: ${formatDate(note.modified)}`);
	lines.push(`colornote_type: ${note.isChecklist ? "checklist" : "text"}`);
	if (note.colorIndex !== DEFAULT_COLOR_INDEX) {
		lines.push(`color: ${COLOR_NAMES[note.colorIndex] ?? String(note.colorIndex)}`);
	}
	if (note.locked) lines.push("locked: true");
	if (note.checked) lines.push("checked: true");
	lines.push(...reminderLines(note.reminder));
	if (note.id > 0) lines.push(`colornote_id: ${note.id}`);
	if (note.uuid !== "") {
		lines.push(`colornote_uuid: ${UUID.test(note.uuid) ? note.uuid : yamlString(note.uuid)}`);
	}
	lines.push("---");

	const frontmatter = lines.join("\n");
	const body = renderBody(note);
	return body === "" ? `${frontmatter}\n` : `${frontmatter}\n${body}\n`;
}
