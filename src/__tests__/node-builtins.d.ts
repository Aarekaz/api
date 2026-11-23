// Tests run in Node (vitest), but the Worker tsconfig has no Node types.
// Declare only what the documents test uses.
declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
}
declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): {
      run(...args: never[]): { changes: number | bigint; lastInsertRowid: number | bigint };
      get(...args: never[]): unknown;
      all(...args: never[]): unknown[];
    };
  }
}
