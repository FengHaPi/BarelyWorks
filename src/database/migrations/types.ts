import type Database from "better-sqlite3";

export interface StudioMigration {
  version: string;
  name: string;
  checksum: string;
  up(sqlite: Database.Database): void;
}
