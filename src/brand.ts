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
} as const;
