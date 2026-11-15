import { AbstractInputSuggest, type App, FuzzySuggestModal, type Setting, type TextComponent, TFolder } from "obsidian";

/** The vault's folders, sorted by path; the root is included only if asked for. */
function vaultFolders(app: App, includeRoot: boolean): TFolder[] {
	return app.vault
		.getAllLoadedFiles()
		.filter((f): f is TFolder => f instanceof TFolder && (includeRoot || !f.isRoot()))
		.sort((a, b) => (a.isRoot() ? -1 : b.isRoot() ? 1 : a.path.localeCompare(b.path)));
}

/** Type-ahead list of the vault's folders for a text input. */
export class FolderSuggest extends AbstractInputSuggest<TFolder> {
	private readonly onPick: (path: string) => void;

	constructor(app: App, inputEl: HTMLInputElement, onPick: (path: string) => void) {
		super(app, inputEl);
		this.onPick = onPick;
		this.onSelect((folder) => {
			this.setValue(folder.path);
			this.onPick(folder.path);
			this.close();
		});
	}

	protected override getSuggestions(query: string): TFolder[] {
		const q = query.trim().toLowerCase();
		return vaultFolders(this.app, false).filter((f) => f.path.toLowerCase().includes(q));
	}

	override renderSuggestion(folder: TFolder, el: HTMLElement): void {
		el.setText(folder.path);
	}
}

/** A searchable list of all the vault's folders, like Obsidian's "Move file to" dialog. */
export class FolderPickerModal extends FuzzySuggestModal<TFolder> {
	private readonly onPick: (path: string) => void;

	/** @param onPick receives the chosen folder's path; "" is the vault root. */
	constructor(app: App, onPick: (path: string) => void) {
		super(app);
		this.onPick = onPick;
		this.setPlaceholder("Choose a folder…");
	}

	override getItems(): TFolder[] {
		return vaultFolders(this.app, true);
	}

	override getItemText(folder: TFolder): string {
		return folder.isRoot() ? "/" : folder.path;
	}

	override onChooseItem(folder: TFolder): void {
		this.onPick(folder.isRoot() ? "" : folder.path);
	}
}

/**
 * Turns a text setting into a folder field: type-ahead suggestions in the
 * text input, and a button that opens {@link FolderPickerModal}.
 * @param onPick called with the path of a folder chosen either way ("" is the vault root)
 */
export function addFolderPicker(app: App, setting: Setting, text: TextComponent, onPick: (path: string) => void): void {
	new FolderSuggest(app, text.inputEl, onPick);
	setting.addExtraButton((button) =>
		button
			.setIcon("folder-open")
			.setTooltip("Choose a folder")
			.onClick(() => {
				new FolderPickerModal(app, (path) => {
					text.setValue(path);
					onPick(path);
				}).open();
			}),
	);
}
