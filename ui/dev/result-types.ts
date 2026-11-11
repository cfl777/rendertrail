import type { InspectRenderInput, InspectRenderOutput } from '../../src/shared/types';

/** One saved result for the card harness (ui/dev/results/*.json). */
export interface CardResult {
  /** Shown in the harness's state picker. */
  title: string;
  /** How the result was made, when it isn't a plain recording. */
  note?: string;
  /** The tool arguments, as the host sends them in ui/notifications/tool-input. */
  input: InspectRenderInput;
  /** structuredContent of the tool result. */
  output: InspectRenderOutput;
}
