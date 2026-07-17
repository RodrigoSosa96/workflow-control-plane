export class WorkflowError extends Error {
  constructor(category, message, { exitCode = 1, details } = {}) {
    super(message);
    this.name = "WorkflowError";
    this.category = category;
    this.exitCode = exitCode;
    this.details = details;
  }
}
