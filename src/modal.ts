import {
	type App,
	type ButtonComponent,
	type DataWriteOptions,
	Modal,
	Notice,
	ProgressBarComponent,
	Setting,
	type TAbstractFile,
	type TextComponent,
	TFolder,
} from "obsidian";
import { BackupError, type DecodedBackup, decodeBackup } from "./backup";
import { addFolderPicker } from "./folder-suggest";
import type ColorNoteImporterPlugin from "./main";
import {
	type ExistingNotes,
	type ImportPlan,
	isInVault,
	joinPath,
	type PlannedFile,
	type PlanOptions,
	planFile,
	planImport,
	takeName,
	trashFolder,
	uniqueName,
} from "./plan";
import { fileBaseName, isValidTime } from "./render";
import { normalizeFolder } from "./settings";

/** Yield to the UI after this many files. */
const YIELD_EVERY = 10;
/** Characters that file systems reject in folder names. */
const BAD_FOLDER_CHARS = /[\\:*?"<>|]/;

interface Failure {
	name: string;
	message: string;
}

interface ImportResult {
	created: number;
	skipped: number;
	failed: Failure[];
	folder: string;
}

function count(n: number, noun: string): string {
	return `${n} ${n === 1 ? noun : `${noun}s`}`;
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return count(bytes, "byte");
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function folderLabel(folder: string): string {
	return folder === "" ? "the vault root" : folder;
}

function nextTask(): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, 0));
}

/**
 * The import dialog: choose and decrypt a backup, review the options, write
 * the notes, show the result.
 */
export class ImportModal extends Modal {
	private readonly plugin: ColorNoteImporterPlugin;
	/** Import options for this run; start from the saved defaults, not saved back. */
	private readonly options: PlanOptions;
	private file: File | null = null;
	private decoded: DecodedBackup | null = null;
	private existing: ExistingNotes | null = null;
	private decrypting = false;
	private writing = false;
	private closed = false;

	constructor(app: App, plugin: ColorNoteImporterPlugin) {
		super(app);
		this.plugin = plugin;
		const s = plugin.settings;
		this.options = {
			destination: s.destination,
			includeTrash: s.includeTrash,
			skipExisting: s.skipExisting,
			useFileDates: s.useFileDates,
		};
	}

	override onOpen(): void {
		this.titleEl.setText("Import ColorNote backup");
		this.modalEl.addClass("colornote-importer-modal");
		this.showDecryptStep();
	}

	override onClose(): void {
		// A running import sees this flag and stops after the current file.
		this.closed = true;
		this.plugin.modalClosed(this);
		this.decoded = null;
		this.existing = null;
		this.contentEl.empty();
	}

	// Step 1: choose the file and decrypt it.

	private fileDescription(): string {
		if (!this.file) return "No file chosen. Backups are named like colornote-20261108.backup.";
		return `${this.file.name} (${formatSize(this.file.size)})`;
	}

	private showDecryptStep(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.decoded = null;

		// No `accept` filter: Android greys out file types it does not know.
		// Hidden visually rather than with display: none, which some mobile
		// web views do not open a picker for.
		const fileInput = contentEl.createEl("input", {
			type: "file",
			cls: "colornote-importer-file-input",
			attr: { tabindex: "-1", "aria-hidden": "true" },
		});

		const fileSetting = new Setting(contentEl)
			.setName("Backup file")
			.setDesc(this.fileDescription())
			.addButton((button) => button.setButtonText("Choose file").onClick(() => fileInput.click()));

		let password: TextComponent | undefined;
		let visible = false;
		new Setting(contentEl)
			.setName("Master password")
			.setDesc("Leave empty if you never set a master password in ColorNote.")
			.addText((text) => {
				password = text;
				text.inputEl.type = "password";
				text.inputEl.autocomplete = "off";
				text.inputEl.spellcheck = false;
				text.inputEl.addEventListener("keydown", (evt) => {
					if (evt.key === "Enter" && !evt.isComposing) {
						evt.preventDefault();
						void decrypt();
					}
				});
			})
			.addExtraButton((button) =>
				button
					.setIcon("eye")
					.setTooltip("Show password")
					.onClick(() => {
						visible = !visible;
						if (password) password.inputEl.type = visible ? "text" : "password";
						button.setIcon(visible ? "eye-off" : "eye").setTooltip(visible ? "Hide password" : "Show password");
					}),
			);

		const errorEl = contentEl.createDiv({ cls: "colornote-importer-error", attr: { role: "alert" } });
		const showError = (message: string): void => {
			errorEl.setText(message);
			errorEl.toggle(message !== "");
		};
		showError("");

		let decryptButton: ButtonComponent | undefined;
		new Setting(contentEl).addButton((button) => {
			decryptButton = button;
			button
				.setButtonText("Decrypt")
				.setCta()
				.setDisabled(this.file === null)
				.onClick(() => void decrypt());
		});

		fileInput.addEventListener("change", () => {
			const chosen = fileInput.files?.[0];
			// Reset, so that choosing the same file again fires "change" again.
			fileInput.value = "";
			if (!chosen) return;
			this.file = chosen;
			fileSetting.setDesc(this.fileDescription());
			decryptButton?.setDisabled(this.decrypting);
			showError("");
		});

		const decrypt = async (): Promise<void> => {
			const file = this.file;
			if (this.decrypting || !password) return;
			if (!file) {
				showError("Choose a backup file first.");
				return;
			}
			this.decrypting = true;
			decryptButton?.setDisabled(true).setButtonText("Decrypting…");
			showError("");
			// The password lives only in this call: read it, clear the field.
			const secret = password.getValue();
			password.setValue("");
			try {
				const decoded = await decodeBackup(new Uint8Array(await file.arrayBuffer()), secret);
				const existing = await this.plugin.collectExistingNotes();
				if (this.closed) return;
				this.decoded = decoded;
				this.existing = existing;
				this.showReviewStep();
			} catch (err) {
				if (this.closed) return;
				if (err instanceof BackupError) {
					showError(
						err.code === "wrong-password" && secret === ""
							? "This backup is protected by a master password. Enter it and try again."
							: err.message,
					);
				} else {
					showError(`Could not read the file: ${errorMessage(err)}`);
				}
				password.inputEl.focus();
			} finally {
				this.decrypting = false;
				decryptButton?.setDisabled(this.file === null).setButtonText("Decrypt");
			}
		};
	}

	// Step 2: summary and options.

	/** The destination as a vault path, reusing the case of existing folders, or an error. */
	private resolveDestination(input: string): { folder: string } | { error: string } {
		const path = normalizeFolder(input);
		if (path === "") return { folder: "" };
		const segments = path.split("/");
		if (segments.some((s) => s === "." || s === "..")) return { error: 'The folder path cannot contain "." or "..".' };
		if (segments.some((s) => BAD_FOLDER_CHARS.test(s))) {
			return { error: 'Folder names cannot contain any of \\ : * ? " < > |' };
		}
		if (segments[0] === this.app.vault.configDir) return { error: "Choose a folder outside the configuration folder." };

		const resolved: string[] = [];
		let parent: TFolder | null = this.app.vault.getRoot();
		for (const segment of segments) {
			const match: TAbstractFile | undefined =
				parent?.children.find((c) => c.name === segment) ??
				parent?.children.find((c) => c.name.toLowerCase() === segment.toLowerCase());
			if (match && !(match instanceof TFolder)) {
				return { error: `"${joinPath(resolved.join("/"), match.name)}" is a file, not a folder.` };
			}
			resolved.push(match ? match.name : segment);
			parent = match instanceof TFolder ? match : null;
		}
		return { folder: resolved.join("/") };
	}

	private existingNames(folders: string[]): Map<string, string[]> {
		const names = new Map<string, string[]>();
		for (const path of folders) {
			const folder = path === "" ? this.app.vault.getRoot() : this.app.vault.getAbstractFileByPath(path);
			if (folder instanceof TFolder) names.set(path, folder.children.map((c) => c.name));
		}
		return names;
	}

	private makePlan(): ImportPlan | null {
		if (!this.decoded || !this.existing) return null;
		const destination = this.options.destination;
		const names = this.existingNames([destination, trashFolder(destination)]);
		return planImport(this.decoded.notes, this.options, names, this.existing);
	}

	private showReviewStep(): void {
		const decoded = this.decoded;
		const existing = this.existing;
		if (!decoded || !existing) return;
		const { contentEl } = this;
		contentEl.empty();

		const notes = decoded.notes;
		const active = notes.filter((n) => !n.inTrash).length;
		const lockedFailed = notes.filter((n) => n.lockedDecryptFailed).length;
		const made = isValidTime(decoded.createdAt) ? new Date(decoded.createdAt).toLocaleString() : "an unknown date";

		const summary = contentEl.createDiv({ cls: "colornote-importer-summary" });
		summary.createEl("p", {
			text: `Backup made on ${made}, format ${decoded.formatVersion[0]}.${decoded.formatVersion[1]}.`,
		});
		const checklists = notes.filter((n) => n.isChecklist).length;
		const locked = notes.filter((n) => n.locked && !n.lockedDecryptFailed).length;
		const list = summary.createEl("ul");
		list.createEl("li", { text: `${count(active, "active note")} and ${count(notes.length - active, "note")} in the trash` });
		list.createEl("li", {
			text: `Among them ${count(checklists, "checklist")} and ${count(locked, "locked note")} (decrypted)`,
		});
		list.createEl("li", {
			text: `${count(notes.filter((n) => isInVault(n, existing)).length, "note")} already in the vault`,
		});
		if (lockedFailed > 0) {
			summary.createEl("p", {
				cls: "colornote-importer-warning",
				text: `${count(lockedFailed, "locked note")} could not be decrypted. ${
					lockedFailed === 1 ? "It is" : "They are"
				} imported with an empty body and marked as locked.`,
			});
		}
		if (decoded.recovered) {
			summary.createEl("p", {
				cls: "colornote-importer-warning",
				text: "Part of the backup is damaged. The notes that could be read are included, but some may be missing.",
			});
		}

		let destinationInput = this.options.destination;
		const destinationSetting = new Setting(contentEl)
			.setName("Destination folder")
			.setDesc("Created if it does not exist. Leave empty for the vault root.");
		destinationSetting.addText((text) => {
			text.setPlaceholder("Vault root")
				.setValue(this.options.destination)
				.onChange((value) => {
					destinationInput = value;
					update();
				});
			addFolderPicker(this.app, destinationSetting, text, (path) => {
				destinationInput = path;
				update();
			});
		});

		const trashSetting = new Setting(contentEl)
			.setName("Include notes in the trash")
			.addToggle((toggle) =>
				toggle.setValue(this.options.includeTrash).onChange((value) => {
					this.options.includeTrash = value;
					update();
				}),
			);

		new Setting(contentEl)
			.setName("Skip notes that are already in the vault")
			.setDesc("Recognized by the ColorNote ID in their properties, in any folder, even if moved or renamed.")
			.addToggle((toggle) =>
				toggle.setValue(this.options.skipExisting).onChange((value) => {
					this.options.skipExisting = value;
					update();
				}),
			);

		new Setting(contentEl)
			.setName("Use ColorNote dates as file dates")
			.setDesc("Set the created and modified times of each file to those of the note.")
			.addToggle((toggle) =>
				toggle.setValue(this.options.useFileDates).onChange((value) => {
					this.options.useFileDates = value;
					update();
				}),
			);

		const willEl = contentEl.createEl("p", { cls: "colornote-importer-will" });

		let importButton: ButtonComponent | undefined;
		let plan: ImportPlan | null = null;
		new Setting(contentEl)
			.addButton((button) => button.setButtonText("Back").onClick(() => this.showDecryptStep()))
			.addButton((button) => {
				importButton = button;
				button.setCta().onClick(() => {
					if (plan && plan.files.length > 0 && !this.writing) void this.runImport(plan);
				});
			});

		const update = (): void => {
			const destination = this.resolveDestination(destinationInput);
			if ("error" in destination) {
				plan = null;
				willEl.setText(destination.error);
				willEl.addClass("colornote-importer-error");
				importButton?.setButtonText("Import").setDisabled(true);
				return;
			}
			willEl.removeClass("colornote-importer-error");
			this.options.destination = destination.folder;
			trashSetting.setDesc(`Written to ${trashFolder(destination.folder)}.`);
			plan = this.makePlan();
			const n = plan?.files.length ?? 0;
			const skipped = plan?.skippedExisting ?? 0;
			willEl.setText(
				`Will create ${count(n, "note")} in ${folderLabel(destination.folder)}.` +
					(skipped > 0 ? ` ${count(skipped, "note")} already in the vault will be skipped.` : ""),
			);
			importButton?.setButtonText(`Import ${count(n, "note")}`).setDisabled(n === 0);
		};
		update();
	}

	// Step 3: write the files.

	private async ensureFolder(path: string): Promise<void> {
		const vault = this.app.vault;
		let current = "";
		for (const segment of path.split("/").filter((s) => s !== "")) {
			current = joinPath(current, segment);
			const existing = vault.getAbstractFileByPath(current);
			if (existing instanceof TFolder) continue;
			if (existing) throw new Error(`"${current}" is a file, not a folder.`);
			try {
				await vault.createFolder(current);
			} catch (err) {
				// Created in the meantime, or present on disk under another case.
				if (!(vault.getAbstractFileByPath(current) instanceof TFolder) && !(await vault.adapter.exists(current))) {
					throw err;
				}
			}
		}
	}

	private async pathTaken(path: string): Promise<boolean> {
		return this.app.vault.getAbstractFileByPath(path) !== null || (await this.app.vault.adapter.exists(path));
	}

	/**
	 * Creates one file. If a file appeared under the planned name since the
	 * plan was made (sync, another plugin), takes the next free name instead:
	 * existing files are never overwritten.
	 */
	private async writeFile(plan: ImportPlan, planned: PlannedFile, options: PlanOptions): Promise<void> {
		let file = planned;
		for (let attempt = 0; ; attempt++) {
			const writeOptions: DataWriteOptions = {};
			if (file.ctime !== undefined) writeOptions.ctime = file.ctime;
			if (file.mtime !== undefined) writeOptions.mtime = file.mtime;
			try {
				await this.app.vault.create(file.path, file.content, writeOptions);
				return;
			} catch (err) {
				if (attempt >= 20 || !(await this.pathTaken(file.path))) throw err;
				takeName(plan, file.folder, file.name);
				const name = uniqueName(fileBaseName(file.note), plan.taken.get(file.folder) ?? new Set());
				takeName(plan, file.folder, name);
				file = planFile(file.note, file.folder, name, options);
			}
		}
	}

	private async runImport(plan: ImportPlan): Promise<void> {
		if (this.writing) return;
		this.writing = true;
		const options = { ...this.options };
		const { contentEl } = this;
		contentEl.empty();

		const total = plan.files.length;
		const progressText = contentEl.createEl("p", { text: `Writing 0 of ${total}…` });
		const progressBar = new ProgressBarComponent(contentEl);
		progressBar.setValue(0);

		const failed: Failure[] = [];
		let created = 0;
		let processed = 0;

		const folderErrors = new Map<string, string>();
		for (const folder of plan.folders) {
			try {
				await this.ensureFolder(folder);
			} catch (err) {
				folderErrors.set(folder, `Could not create the folder "${folder}": ${errorMessage(err)}`);
			}
		}

		for (const file of plan.files) {
			if (this.closed) break;
			progressText.setText(`Writing ${processed + 1} of ${total}…`);
			const folderError = folderErrors.get(file.folder);
			if (folderError) {
				failed.push({ name: `${file.name}.md`, message: folderError });
			} else {
				try {
					await this.writeFile(plan, file, options);
					created++;
				} catch (err) {
					failed.push({ name: `${file.name}.md`, message: errorMessage(err) });
				}
			}
			processed++;
			progressBar.setValue((processed / total) * 100);
			if (processed % YIELD_EVERY === 0) await nextTask();
		}
		this.writing = false;

		const result: ImportResult = {
			created,
			skipped: plan.skippedExisting,
			failed,
			folder: options.destination,
		};
		if (processed < total) {
			new Notice(
				`ColorNote import stopped after writing ${created} of ${count(total, "note")}. ` +
					'To continue, import again with "Skip notes that are already in the vault" turned on.',
			);
			return;
		}
		new Notice(
			`ColorNote import finished: ${created} created, ${result.skipped} skipped, ${failed.length} failed.`,
		);
		if (!this.closed) this.showResult(result);
	}

	// Step 4: result.

	private showResult(result: ImportResult): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("p", { text: `Created ${count(result.created, "note")} in ${folderLabel(result.folder)}.` });
		if (result.skipped > 0) {
			contentEl.createEl("p", { text: `Skipped ${count(result.skipped, "note")} already in the vault.` });
		}
		if (result.failed.length > 0) {
			contentEl.createEl("p", {
				cls: "colornote-importer-error",
				text: `${count(result.failed.length, "note")} could not be written:`,
			});
			const list = contentEl.createEl("ul", { cls: "colornote-importer-failures" });
			for (const failure of result.failed) list.createEl("li", { text: `${failure.name}: ${failure.message}` });
		}
		new Setting(contentEl).addButton((button) =>
			button
				.setButtonText("Done")
				.setCta()
				.onClick(() => this.close()),
		);
	}
}
