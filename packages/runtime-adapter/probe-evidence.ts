import { BridgeError } from '../protocol/index.js';
import type { RuntimeEvent } from './claude.js';

const probeTool = 'mcp__local_bridge__workspace_info';

/** Evidence for one P0 turn; successful process exit alone is insufficient. */
export class ProbeTurnEvidence {
  private initialized = false;
  private succeeded = false;
  private tail = '';
  private markerSeen = false;
  private toolSeen = false;
  constructor(
    private readonly sessionId: string,
    private readonly marker: string,
    private readonly phase: 'first' | 'resume',
  ) {}
  accept(event: RuntimeEvent): void {
    if (event.type === 'init') {
      if (this.initialized || event.session_id !== this.sessionId)
        throw new BridgeError(
          'RUNTIME_SESSION_MISMATCH',
          'Probe did not initialize the requested runtime session.',
        );
      if (event.tools.length !== 1 || event.tools[0] !== probeTool)
        throw new BridgeError(
          'PROBE_TOOL_MISMATCH',
          'P0 permits only the workspace_info probe tool.',
        );
      this.initialized = true;
    } else if (event.type === 'tool') {
      if (this.phase === 'resume')
        throw new BridgeError(
          'RESUME_TOOL_USED',
          'Resume must recall the earlier marker without calling a tool.',
        );
      if (event.name !== probeTool)
        throw new BridgeError('PROBE_TOOL_MISMATCH', 'An unexpected tool was requested during P0.');
      this.toolSeen = true;
    } else if (event.type === 'text') {
      if (this.phase === 'resume' || this.toolSeen) {
        const text = this.tail + event.text;
        if (text.includes(this.marker)) this.markerSeen = true;
        this.tail = text.slice(-(this.marker.length - 1));
      }
    } else if (event.type === 'result') {
      if (event.session_id !== this.sessionId)
        throw new BridgeError(
          'RUNTIME_SESSION_MISMATCH',
          'Probe ended in a different runtime session.',
        );
      this.succeeded = event.success;
    }
  }
  finish(): { marker_seen: true; tool_call_seen: boolean } {
    if (!this.initialized || !this.succeeded)
      throw new BridgeError(
        'RUNTIME_FAILED',
        'Probe turn did not produce a successful initialized result.',
      );
    if (!this.markerSeen || (this.phase === 'first' && !this.toolSeen))
      throw new BridgeError(
        this.phase === 'first' ? 'MCP_NOT_VERIFIED' : 'RESUME_NOT_VERIFIED',
        this.phase === 'first'
          ? 'P0 did not observe the tool call and its fresh challenge marker.'
          : 'The resumed turn did not recall the first turn challenge marker.',
      );
    return { marker_seen: true, tool_call_seen: this.toolSeen };
  }
}
