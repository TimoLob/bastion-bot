import sqlite, { Database, Statement } from "better-sqlite3";
import { CommandInteraction, Snowflake } from "discord.js";
import { inject, singleton } from "tsyringe";

export type Locale = string;

/**
 * Abstract persistent store for locale overrides. We need this if we switch to
 * multiprocess sharding in the future and demand is high, since SQLite cannot
 * handle concurrent writes. Promise?
 */
export abstract class LocaleProvider {
	abstract guild(id: Snowflake): Promise<Locale | null>;
	abstract channel(id: Snowflake): Promise<Locale | null>;
	abstract setForGuild(id: Snowflake, set: Locale | null): Promise<void>;
	abstract setForChannel(id: Snowflake, set: Locale | null): Promise<void>;

	/**
	 * channel.parentId may refer to a category or a text channel. Return the parent text channel
	 * for threads only, and the current channel otherwise.
	 *
	 * @param interaction
	 * @returns The channel snowflake to use for setting locale
	 */
	getChannel(interaction: CommandInteraction): Snowflake {
		return (interaction.channel?.isThread() && interaction.channel.parentId) || interaction.channelId;
	}

	async get(interaction: CommandInteraction): Promise<Locale> {
		if (interaction.inGuild()) {
			return (
				(await this.channel(
					(interaction.channel?.isThread() && interaction.channel.parentId) || interaction.channelId
				)) ??
				(await this.guild(interaction.guildId)) ??
				this.filter(interaction.guildLocale)
			);
		} else {
			return (await this.channel(interaction.channelId)) ?? this.filter(interaction.locale);
		}
	}

	/**
	 * Process Discord-provided locales into simple ISO 639-1 codes that we support.
	 * @param discordLocale
	 */
	private filter(discordLocale: string): Locale {
		const locale = discordLocale.split("-")[0];
		if (["en", "fr", "de", "it", "pt"].includes(locale)) {
			return locale;
		} else {
			return "en";
		}
	}
}

/**
 * Implementation in two SQLite tables in the same database. With sufficient
 * scale, this would need to be periodically cleaned as guilds and channels are
 * removed, especially with threads, if they are also stored here.
 */
@singleton()
export class SQLiteLocaleProvider extends LocaleProvider {
	private readonly db: Database;
	private readonly readGuild: Statement;
	private readonly writeGuild: Statement;
	private readonly deleteGuild: Statement;
	private readonly readChannel: Statement;
	private readonly writeChannel: Statement;
	private readonly deleteChannel: Statement;
	constructor(@inject("localeDb") file: string) {
		super();
		this.db = this.getDB(file);
		this.readGuild = this.db.prepare("SELECT locale FROM guilds WHERE id = ?");
		this.writeGuild = this.db.prepare("REPLACE INTO guilds VALUES(?,?)");
		this.deleteGuild = this.db.prepare("DELETE FROM guilds WHERE id = ?");
		this.readChannel = this.db.prepare("SELECT locale FROM channels WHERE id = ?");
		this.writeChannel = this.db.prepare("REPLACE INTO channels VALUES(?,?)");
		this.deleteChannel = this.db.prepare("DELETE FROM channels WHERE id = ?");
	}

	private getDB(file: string): Database {
		const db = sqlite(file);
		db.pragma("journal_mode = WAL");
		db.exec(`
CREATE TABLE IF NOT EXISTS "guilds" (
	"id"	INTEGER NOT NULL,
	"locale"	TEXT NOT NULL,
	PRIMARY KEY("id")
);
CREATE TABLE IF NOT EXISTS "channels" (
	"id"	INTEGER NOT NULL,
	"locale"	TEXT NOT NULL,
	PRIMARY KEY("id")
);`);
		return db;
	}

	public async guild(id: Snowflake): Promise<Locale> {
		return this.readGuild.get(id)?.locale || null;
	}

	public async channel(id: Snowflake): Promise<Locale> {
		return this.readChannel.get(id)?.locale || null;
	}

	public async setForGuild(id: Snowflake, set: Locale): Promise<void> {
		if (set !== null) {
			this.writeGuild.run(id, set);
		} else {
			this.deleteGuild.run(id);
		}
	}

	public async setForChannel(id: Snowflake, set: Locale): Promise<void> {
		if (set !== null) {
			this.writeChannel.run(id, set);
		} else {
			this.deleteChannel.run(id);
		}
	}

	public destroy(): void {
		this.db.close();
	}
}
