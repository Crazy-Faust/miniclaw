// Audit log contract. Every tool call should be persisted *before* its
// result is returned to the model, so a malicious chain remains traceable.

export interface AuditSink {
  logToolCall(skill: string, argsJson: string, resultSummary: string, ok: boolean): void;
}
