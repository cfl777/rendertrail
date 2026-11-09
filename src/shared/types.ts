/**
 * Tool input/output and trace types shared by the server and the card.
 * Bump SCHEMA_VERSION on any breaking change to these shapes.
 */
export const SCHEMA_VERSION = 1;

/**
 * structuredContent of the temporary Phase 0 `hello` tool.
 * Replaced by the `inspect_render` output (HANDOFF.md §5) in Phase 1.
 */
export interface HelloResult {
  schemaVersion: typeof SCHEMA_VERSION;
  greeting: string;
  name: string;
  serverTime: string;
}
