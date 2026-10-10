import type { Session, Conversation } from './types';

export type TaskStatus = 'pending' | 'in_progress' | 'completed';
export type ProjectStatus = 'not_started' | 'in_progress' | 'completed';
export type RecognitionMode = 'llm' | 'rules';
export interface ProjectHistoryInput { sessions: Session[]; conversations: Conversation[] }
export interface ProjectScanOptions {
  mode?: RecognitionMode;
  planId?: string;
  consent?: boolean;
  model?: string;
  maxBudgetUsd?: number;
  requestId?: string;
}
export type ProjectScanRequest = ProjectHistoryInput & ProjectScanOptions;
export interface ProjectScanProgress {
  requestId: string;
  phase: 'reading' | 'analyzing' | 'merging' | 'validating';
  completed: number;
  total: number;
  message: string;
  costUsd?: number;
}
export interface ProjectSource {
  id: string;
  kind: 'gui' | 'claude';
  sessionId: string;
  title: string;
  cwd: string;
  path?: string;
  messageId?: string;
  excerpt: string;
}
export interface ProjectFile {
  path: string;
  purpose: string;
  sourceId: string;
}
export interface ProjectTask {
  id: string;
  name: string;
  description: string;
  status: TaskStatus;
  inputs: string[];
  outputs: string[];
  dependsOn: string[];
  dependencyNote: string;
  sourceIds: string[];
  records: string[];
  /** Maintained by the backend to protect user edits during later scans. */
  editedFields?: string[];
}
export interface ManagedProject {
  id: string;
  identityKey: string;
  name: string;
  description: string;
  goal: string;
  background: string;
  constraints: string;
  decisions: string;
  deliverables: string;
  goalConfirmed: boolean;
  tasks: ProjectTask[];
  files: ProjectFile[];
  sources: ProjectSource[];
  uncertainties: string[];
  createdAt: number;
  updatedAt: number;
}
export interface ProjectCandidate extends ManagedProject {
  evidence: string[];
  existingProjectId?: string;
}
export interface ProjectScan {
  scanId: string;
  candidates: ProjectCandidate[];
  analysis?: {
    mode: RecognitionMode;
    model?: string;
    batches?: number;
    calls?: number;
    costUsd?: number;
    inputChars?: number;
  };
  coverage: {
    guiSessions: number;
    claudeSessions: number;
    skipped: number;
    warnings: string[];
    roots: string[];
  };
}
export interface ProjectScanPlan {
  planId: string;
  coverage: ProjectScan['coverage'];
  sessions: number;
  messages: number;
  inputChars: number;
  batches: number;
  maxCalls: number;
  expiresAt: number;
  sampleSources: ProjectSource[];
}
export interface ProjectReview {
  candidateId: string;
  name: string;
  goal: string;
  description: string;
  // Unset means create separately; explicitly selected id means associate after review.
  existingProjectId?: string;
  allowDuplicate?: boolean;
}
export interface ProjectsAPI {
  list(): Promise<ManagedProject[]>;
  prepare(data: ProjectHistoryInput): Promise<ProjectScanPlan>;
  scan(data: ProjectScanRequest): Promise<ProjectScan>;
  cancelScan(requestId: string): Promise<boolean>;
  onScanProgress?(callback: (progress: ProjectScanProgress) => void): () => void;
  confirm(scanId: string, reviews: ProjectReview[]): Promise<ManagedProject[]>;
  update(project: ManagedProject): Promise<ManagedProject[]>;
  reveal(path: string): Promise<{ ok: boolean; error?: string }>;
}
