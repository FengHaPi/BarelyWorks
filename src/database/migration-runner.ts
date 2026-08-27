import type Database from "better-sqlite3";
import { agentFirstFoundationMigration } from "./migrations/001-agent-first-foundation";
import type { StudioMigration } from "./migrations/types";

const migrations: StudioMigration[] = [agentFirstFoundationMigration];

export function runStudioMigrations(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      checksum TEXT NOT NULL
    )
  `);
  const read = sqlite.prepare("SELECT version, checksum FROM schema_migrations WHERE version = ?");
  const insert = sqlite.prepare("INSERT INTO schema_migrations(version, name, applied_at, checksum) VALUES (?, ?, ?, ?)");

  for (const migration of migrations) {
    const applied = read.get(migration.version) as { version: string; checksum: string } | undefined;
    if (applied) {
      if (applied.checksum !== migration.checksum) throw new Error(`数据库迁移 ${migration.version} 校验和不一致`);
      continue;
    }
    sqlite.transaction(() => {
      migration.up(sqlite);
      insert.run(migration.version, migration.name, new Date().toISOString(), migration.checksum);
    })();
  }
}
