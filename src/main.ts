import { Plugin } from "obsidian";
import { ImportModal } from "./modal";
import { type ExistingNotes, indexExistingNotes, readColorNoteKeys } from "./plan";
import { type ImporterSettings, ImporterSettingTab, readSettings } from "./settings";

export default class ColorNoteImporterPlugin extends Plugin {
	override settings: ImporterSettings = readSettings(null);
	private openModal: ImportModal | null = null;

	override async onload(): Promise<void> {
		this.settings = readSettings(await this.loadData());

		this.addCommand({
			id: "import-backup",
			name: "Import ColorNote backup",
			callback: () => this.openImportModal(),
		});
		this.addRibbonIcon("import", "Import ColorNote backup", () => this.openImportModal());
		this.addSettingTab(new ImporterSettingTab(this.app, this));

		// Closing the dialog also stops an import that is still writing.
		this.register(() => this.openModal?.close());
	}

	openImportModal(): void {
		this.openModal?.close();
		const modal = new ImportModal(this.app, this);
		this.openModal = modal;
		modal.open();
	}

	/** Called by the dialog when it closes. */
	modalClosed(modal: ImportModal): void {
		if (this.openModal === modal) this.openModal = null;
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/**
	 * ColorNote ids of the notes already in the vault, from the frontmatter of
	 * every Markdown file. Files the metadata cache has not indexed yet (just
	 * after start-up, or just written by an import) are read directly.
	 */
	async collectExistingNotes(): Promise<ExistingNotes> {
		const frontmatters: Record<string, unknown>[] = [];
		for (const file of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(file);
			if (cache) {
				if (cache.frontmatter) frontmatters.push(cache.frontmatter);
				continue;
			}
			try {
				frontmatters.push(readColorNoteKeys(await this.app.vault.cachedRead(file)));
			} catch {
				// Unreadable file: it cannot be a ColorNote import we could match.
			}
		}
		return indexExistingNotes(frontmatters);
	}
}
