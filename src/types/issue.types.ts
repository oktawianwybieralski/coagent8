export interface BugReportOptions {
  errorMessage?: string;
  context?: string;
  doctorReport?: { backends?: Record<string, { name?: string; installed: boolean; version?: string }> } | null;
}

export interface BugReportResult {
  title: string;
  body: string;
  issueUrl: string;
  prompt: string;
}
