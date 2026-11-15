import {
	type App,
	normalizePath,
	PluginSettingTab,
	Setting,
	type SettingDefinition,
	type SettingDefinitionItem,
} from "obsidian";
import { addFolderPicker } from "./folder-suggest";
import type ColorNoteImporterPlugin from "./main";
import { TRASH_FOLDER } from "./plan";

/** Saved defaults for the import options. The master password is never stored. */
export interface ImporterSettings {
	destination: string;
	includeTrash: boolean;
	skipExisting: boolean;
	useFileDates: boolean;
}

export const DEFAULT_SETTINGS: ImporterSettings = {
	destination: "ColorNote",
	includeTrash: false,
	skipExisting: true,
	useFileDates: true,
};

/** Settings from saved data, with defaults for anything missing or invalid. */
export function readSettings(data: unknown): ImporterSettings {
	const saved = (typeof data === "object" && data !== null ? data : {}) as Partial<Record<keyof ImporterSettings, unknown>>;
	const bool = (value: unknown, fallback: boolean): boolean => (typeof value === "boolean" ? value : fallback);
	return {
		destination: typeof saved.destination === "string" ? saved.destination : DEFAULT_SETTINGS.destination,
		includeTrash: bool(saved.includeTrash, DEFAULT_SETTINGS.includeTrash),
		skipExisting: bool(saved.skipExisting, DEFAULT_SETTINGS.skipExisting),
		useFileDates: bool(saved.useFileDates, DEFAULT_SETTINGS.useFileDates),	};
}

/** A folder path as typed by the user, normalised; "" is the vault root. */
export function normalizeFolder(input: string): string {
	const trimmed = input.trim();
	if (trimmed === "") return "";
	const path = normalizePath(trimmed);
	return path === "/" ? "" : path;
}

/** One settings row: its name and description, and a builder for its controls. */
interface Row {
	name: string;
	desc: string;
	build: (setting: Setting) => void;
}

const DEFAULTS_HEADING = "Defaults for new imports";

/**
 * The rows are defined once and rendered either declaratively
 * (getSettingDefinitions, Obsidian 1.13 and later, which also makes them
 * searchable) or imperatively (display, earlier versions).
 */
export class ImporterSettingTab extends PluginSettingTab {
	private readonly plugin: ColorNoteImporterPlugin;

	constructor(app: App, plugin: ColorNoteImporterPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	private importRow(): Row {
		return {
			name: "Import a backup",
			desc: "Import notes from an encrypted ColorNote backup file. The master password is never stored, and nothing leaves this device.",
			build: (setting) => {
				setting.addButton((button) =>
					button
						.setButtonText("Import…")
						.setCta()
						.onClick(() => this.plugin.openImportModal()),
				);
			},
		};
	}

	private defaultRows(): Row[] {
		const settings = this.plugin.settings;
		const save = (): Promise<void> => this.plugin.saveSettings();
		return [
			{
				name: "Destination folder",
				desc: "Where imported notes are created. Leave empty for the vault root.",
				build: (setting) =>
					setting.addText((text) => {
						const setDestination = async (value: string): Promise<void> => {
							settings.destination = normalizeFolder(value);
							await save();
						};
						text.setPlaceholder("Vault root").setValue(settings.destination).onChange(setDestination);
						addFolderPicker(this.app, setting, text, (path) => void setDestination(path));
					}),
			},
			{
				name: "Include notes in the trash",
				desc: `Notes from the ColorNote trash are written to ${TRASH_FOLDER} inside the destination folder.`,
				build: (setting) =>
					setting.addToggle((toggle) =>
						toggle.setValue(settings.includeTrash).onChange(async (value) => {
							settings.includeTrash = value;
							await save();
						}),
					),
			},
			{
				name: "Skip notes that are already in the vault",
				desc: "A note counts as already imported when any note in the vault has its ColorNote ID in its properties, even if it was moved or renamed.",
				build: (setting) =>
					setting.addToggle((toggle) =>
						toggle.setValue(settings.skipExisting).onChange(async (value) => {
							settings.skipExisting = value;
							await save();
						}),
					),
			},
			{
				name: "Use ColorNote dates as file dates",
				desc: "Set the created and modified times of each file to those of the note.",
				build: (setting) =>
					setting.addToggle((toggle) =>
						toggle.setValue(settings.useFileDates).onChange(async (value) => {
							settings.useFileDates = value;
							await save();
						}),
					),
			},
		];
	}

	override getSettingDefinitions(): SettingDefinitionItem[] {
		const definition = (row: Row): SettingDefinition => ({
			name: row.name,
			desc: row.desc,
			render: (setting) => {
				setting.setName(row.name).setDesc(row.desc);
				row.build(setting);
			},
		});
		return [
			definition(this.importRow()),
			{ type: "group", heading: DEFAULTS_HEADING, items: this.defaultRows().map(definition) },
		];
	}

	override display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const add = (row: Row): void => row.build(new Setting(containerEl).setName(row.name).setDesc(row.desc));
		add(this.importRow());
		new Setting(containerEl).setName(DEFAULTS_HEADING).setHeading();
		this.defaultRows().forEach(add);
	}
}
