import Database from 'better-sqlite3';
import { instrumentDatabaseQuery } from './otel.js';

class WrappedDatabase {
  constructor(db) {
    this.db = db;
  }

  /**
   * @param {string} sql
   * @param {string[]} params
   */
  all(sql, params = []) {
    return instrumentDatabaseQuery('select', this._extractTableName(sql), () => {
      const stmt = this.db.prepare(sql);
      return stmt.all(...params);
    });
  }

  /**
   * @param {string} sql
   * @param {string[]} params
   */
  first(sql, params = []) {
    return instrumentDatabaseQuery('select', this._extractTableName(sql), () => {
      const rows = this.all(sql, params);
      return rows.length === 0 ? null : rows[0];
    });
  }

  /**
   * @param {string} sql
   */
  exec(sql) {
    return this.db.exec(sql);
  }

  /**
   * @param {string} sql
   * @param {string[]} params
   */
  mutate(sql, params = []) {
    const operation = this._extractOperation(sql);
    return instrumentDatabaseQuery(operation, this._extractTableName(sql), () => {
      const stmt = this.db.prepare(sql);
      const info = stmt.run(...params);
      return { changes: info.changes, insertId: info.lastInsertRowid };
    });
  }

  /**
   * @param {() => void} fn
   */
  transaction(fn) {
    return this.db.transaction(fn)();
  }

  close() {
    this.db.close();
  }

  /**
   * Extract table name from SQL query for metrics labeling
   * @param {string} sql
   */
  _extractTableName(sql) {
    try {
      const normalized = sql.toLowerCase().trim();
      const patterns = [
        /from\s+([a-zA-Z_][a-zA-Z0-9_]*)/,
        /into\s+([a-zA-Z_][a-zA-Z0-9_]*)/,
        /update\s+([a-zA-Z_][a-zA-Z0-9_]*)/,
        /delete\s+from\s+([a-zA-Z_][a-zA-Z0-9_]*)/,
      ];

      for (const pattern of patterns) {
        const match = normalized.match(pattern);
        if (match) {
          return match[1];
        }
      }

      return 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /**
   * Extract operation type from SQL query
   * @param {string} sql
   */
  _extractOperation(sql) {
    try {
      const normalized = sql.toLowerCase().trim();
      if (normalized.startsWith('select')) return 'select';
      if (normalized.startsWith('insert')) return 'insert';
      if (normalized.startsWith('update')) return 'update';
      if (normalized.startsWith('delete')) return 'delete';
      if (normalized.startsWith('create')) return 'create';
      if (normalized.startsWith('drop')) return 'drop';
      if (normalized.startsWith('alter')) return 'alter';
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }
}

/** @param {string} filename */
export function openDatabase(filename) {
  return new WrappedDatabase(new Database(filename));
}
