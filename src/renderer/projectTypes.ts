import type { Session, Conversation } from './types';

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';
export type ProjectStatus = 'not_started' | 'in_progress' | 'completed';
export type RecognitionMode = 'llm' | 'rules';
export interface ProjectScanScope { cwd?: string; sinceDays?: number; }
export interface ProjectHistoryInput { sessions: Session[]; conversations: Conversation[]; scope?: ProjectScanScope; requestId?: string }
export interface ProjectScanOptions {
  mode?: RecognitionMode;
  planId?: string;
  consent?: boolean;
  model?: string;
  maxBudgetUsd?: number;
  requestId?: string;
  scope?: ProjectScanScope;
}
export type ProjectScanRequest = ProjectHistoryInput & ProjectScanOptions;
export interface ProjectScanProgress {
  requestId: string;
  phase: 'reading' | 'analyzing' | 'merging' | 'validating' | 'finished';
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
  /** Original message/file timestamp when known. */
  timestamp?: number;
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
  /** Last time this task's status changed, when known. */
  statusChangedAt?: number;
  /** Optional tasks do not block project completion or goal acceptance. */
  optional?: boolean;
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
  /** Soft lifecycle fields; undefined means active/visible. */
  archivedAt?: number;
  deletedAt?: number;
  /** Set on the source project after it is merged into another project. */
  mergedInto?: string;
  /** Latest recognition audit snapshot, when the project came from a scan. */
  audit?: ProjectAudit;
  /** Older recognition audits, newest last; bounded on the backend. */
  auditHistory?: ProjectAudit[];
  /** Personal archive organization. */
  pinned?: boolean;
  tags?: string[];
  retrospective?: ProjectRetrospective;
  /** Fact vs model interpretation for editable project fields. */
  fieldProvenance?: Partial<Record<ProjectProvenanceField, FieldProvenance>>;
  /** Exact uncertainty strings the user has marked resolved. */
  resolvedUncertainties?: string[];
  /** General recognition guidance, not actionable issues. */
  recognitionNotes?: string[];
  fieldEvidence?: Partial<Record<ProjectEvidenceField, ProjectFieldEvidence>>;
  /** Monotonic backend version; missing legacy versions are treated as zero. */
  revision?: number;
  workingDirectory?: string;
  conversations?: ProjectConversationLink[];
  acceptance?: ProjectAcceptance;
  acceptanceInvalidatedReason?: string;
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
    incomplete?: boolean;
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
  scope?: ProjectScanScope;
  existingProjects?: Array<{ id: string; name: string; cwd: string }>;
}
export interface ProjectAudit {
  mode: RecognitionMode;
  model?: string;
  batches?: number;
  calls?: number;
  costUsd?: number;
  inputChars?: number;
  scannedAt: number;
  coverage: ProjectScan['coverage'];
  evidence?: string[];
}
export type ProjectEvidenceField = 'background' | 'constraints' | 'decisions' | 'deliverables';
export interface ProjectFieldEvidence {
  kind: 'quoted' | 'model' | 'unknown';
  refs: Array<{ sourceId: string; quote: string }>;
  reviewedAt?: number;
}
export interface ProjectAcceptance {
  confirmedAt: number;
  goal: string;
  deliverables: string;
  requiredTaskIds: string[];
}
export interface ProjectConversationLink {
  conversationId: string;
  sessionId?: string;
  cwd: string;
  title: string;
  taskId?: string;
  linkedAt: number;
  lastRun?: { status: 'completed' | 'failed' | 'aborted'; recordedAt: number; messageId?: string; excerpt: string; verified?: false };
  reviewedAt?: number;
}
export interface ProjectScanJob {
  requestId: string;
  operation: 'prepare' | 'scan';
  state: 'running' | 'completed' | 'cancelled' | 'failed';
  progress?: ProjectScanProgress;
  plan?: ProjectScanPlan;
  result?: ProjectScan;
  error?: string;
}
export interface ProjectReviewDraft {
  scanResult: ProjectScan;
  reviews: Record<string, ProjectReview & { selected: boolean }>;
}
export interface ProjectStorageInfo {
  bytes: number;
  maxBytes: number;
  projects: number;
  maxProjects: number;
  deletedProjects: number;
  backupAvailable: boolean;
  loadError?: string;
}
export type FieldProvenance = 'quoted' | 'model' | 'user' | 'unknown';
export type ProjectProvenanceField = 'name' | 'goal' | 'description' | 'background' | 'constraints' | 'decisions' | 'deliverables';
export interface ProjectRetrospective {
  goal?: string;
  outcome?: string;
  wentWell?: string;
  wentPoorly?: string;
  surprises?: string;
  nextSteps?: string;
  updatedAt: number;
}
export interface ProjectCreateInput {
  name: string;
  goal: string;
  description?: string;
  background?: string;
  constraints?: string;
  decisions?: string;
  deliverables?: string;
  tags?: string[];
  workingDirectory?: string;
}
export interface ProjectReview {
  candidateId: string;
  name: string;
  goal: string;
  description: string;
  // Unset means create separately; explicitly selected id means associate after review.
  existingProjectId?: string;
  allowDuplicate?: boolean;
  restoreExisting?: boolean;
  fields?: Partial<Record<ProjectEvidenceField, string>>;
  reviewedFields?: ProjectEvidenceField[];
  expectedRevision?: number;
}
export type ProjectChanges = Partial<Pick<ManagedProject,
  'name' | 'goal' | 'description' | 'background' | 'constraints' | 'decisions' | 'deliverables' |
  'tasks' | 'tags' | 'pinned' | 'retrospective' | 'resolvedUncertainties' | 'goalConfirmed' | 'workingDirectory'
>> & { conversations?: Array<{ conversationId: string; reviewedAt: number }> };
export interface ProjectPatchRequest {
  id: string;
  expectedRevision: number;
  changes: ProjectChanges;
}
export interface ProjectsAPI {
  list(): Promise<ManagedProject[]>;
  prepare(data: ProjectHistoryInput): Promise<ProjectScanPlan>;
  scan(data: ProjectScanRequest): Promise<ProjectScan>;
  cancelScan(requestId: string): Promise<boolean>;
  onScanProgress?(callback: (progress: ProjectScanProgress) => void): () => void;
  confirm(scanId: string, reviews: ProjectReview[]): Promise<ManagedProject[]>;
  update(project: ManagedProject): Promise<ManagedProject[]>;
  create(input: ProjectCreateInput): Promise<ManagedProject[]>;
  archive(id: string, archived: boolean): Promise<ManagedProject[]>;
  remove(id: string, deleted: boolean): Promise<ManagedProject[]>;
  merge(sourceId: string, targetId: string): Promise<ManagedProject[]>;
  reveal(path: string): Promise<{ ok: boolean; error?: string }>;
  patch?(request: ProjectPatchRequest): Promise<ManagedProject[]>;
  activeJob?(): Promise<ProjectScanJob | null>;
  discardPlan?(planId: string): Promise<boolean>;
  reviewDraft?(): Promise<ProjectReviewDraft | null>;
  saveReviewDraft?(draft: ProjectReviewDraft | null): Promise<void>;
  linkConversation?(id: string, link: Omit<ProjectConversationLink, 'linkedAt' | 'lastRun' | 'reviewedAt'>): Promise<ManagedProject[]>;
  recordConversation?(conversationId: string, result: NonNullable<ProjectConversationLink['lastRun']> & { sessionId?: string }): Promise<ManagedProject[]>;
  reload?(): Promise<ManagedProject[]>;
  storageInfo?(): Promise<ProjectStorageInfo>;
  purge?(id: string): Promise<ManagedProject[]>;
  restoreBackup?(): Promise<ManagedProject[]>;
}
