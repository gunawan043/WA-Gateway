/**
 * The division module cannot import `InboxModule`: `InboxModule` imports `SessionModule`, and
 * `SessionModule` imports this module so the message projector can inject the router. This leaf file
 * carries the token and the contract only, so both sides can meet without a module (or file) cycle.
 *
 * `InboxService` is the implementation (provided as `useExisting`, never a factory, so its lifecycle
 * hooks run once) and this module resolves it lazily through `ModuleRef` at first use.
 */
export const DIVISION_INBOX_PORT = Symbol('DIVISION_INBOX_PORT');

export interface DivisionRouteInput {
  sessionId: string;
  chatId: string;
  divisionId: string;
  divisionName: string;
  /** First-response target of the division; 0 means no SLA. Snapshotted onto the conversation. */
  slaMinutes: number;
  /** Candidate assignees in stable order; the least busy active one wins. */
  agentKeyIds: string[];
}

export interface DivisionRouteResult {
  assigneeKeyId: string | null;
  assigneeName: string | null;
}

export interface DivisionInboxPort {
  /** Tag the conversation with the division and assign its least busy CS. */
  routeConversation(input: DivisionRouteInput): Promise<DivisionRouteResult>;
  /** Make the next inbound message show the menu again (conversation resolved). */
  rearm(sessionId: string, chatId: string): Promise<void>;
  /** Drop a deleted division's tag from the session's conversations, keeping their assignee. */
  clearDivision(sessionId: string, divisionId: string): Promise<void>;
}
