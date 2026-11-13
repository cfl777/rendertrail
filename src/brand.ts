/**
 * Product name and ids. The only place the name lives besides package.json,
 * so a rename stays a five-minute job (HANDOFF.md §12).
 */
export const BRAND = {
  /** Package and id form of the name. */
  name: 'rendertrail',
  /** Name shown to people. */
  displayName: 'Rendertrail',
  /** Name the MCP server reports in `initialize`. */
  serverName: 'rendertrail',
  /** The card, served as an MCP App resource. */
  cardResourceUri: 'ui://rendertrail/card.html',
  /** Runs are stored in ~/<homeDir>/runs. */
  homeDir: '.rendertrail',
  /** Environment variable that overrides the runs folder (tests use it to stay out of the real home). */
  runsDirEnv: 'RENDERTRAIL_RUNS_DIR',
  /** Environment variable that turns the opt-in anonymous counts on (1) or off (0). */
  telemetryEnv: 'RENDERTRAIL_TELEMETRY',
} as const;
