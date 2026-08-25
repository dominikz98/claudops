/** What every view hands back so the router can take it down again -- a poll
 *  timer or an open WebSocket must not outlive the view that owns it. */
export interface View {
  destroy(): void;
}
