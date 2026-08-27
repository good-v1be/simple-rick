import crypto from 'node:crypto';
import type Database from 'better-sqlite3';

export interface AppConfig {
  bearerToken: string;
  embeddingProvider: string | null;
  embeddingDimension: number | null;
}

export function loadOrCreateConfig(db: Database.Database): AppConfig {
  const get = (key: string) =>
    (db.prepare('SELECT value FROM config WHERE key = ?').get(key) as any)?.value ?? null;
  const set = (key: string, value: string) =>
    db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, value);

  let token = get('bearer_token');
  if (!token) {
    token = crypto.randomBytes(24).toString('base64url');
    set('bearer_token', token);
  }

  return {
    bearerToken: token,
    embeddingProvider: get('embedding_provider'),
    embeddingDimension: get('embedding_dimension') ? parseInt(get('embedding_dimension')) : null,
  };
}
