// Core relay state and chat element typings.
export interface CursorWindow {
  id: string;
  title: string;
  url: string;
  wsUrl?: string;
}

/** Raw DOM element snapshot — what was actually in the DOM, independent of parsing. */
export interface RawElement {
  flatIndex: number;
  role?: string;
  kind?: string;
  messageId?: string;
  toolCallId?: string;
  toolStatus?: string;
  /** Key CSS class/element indicators found on this wrapper. */
  indicators: string[];
  /** First ~120 chars of textContent. */
  textPreview: string;
  /** What ChatElement type the parser decided this was (or 'skipped'). */
  parsedAs: string;
}

export interface RawSignals {
  shimmer: Array<{ text: string; inToolCall: boolean; inHeader: boolean }>;
  loadingIndicator: boolean;
  statusEl?: { text: string; classes: string };
  /** Per-element DOM inventory — raw attributes and indicator classes for every [data-flat-index]. */
  elements: RawElement[];
  /** Activity-related elements NOT inside any [data-flat-index] wrapper. */
  orphanIndicators: Array<{ cls: string; text: string; parentCls: string }>;
}

export interface ComposerQueueItem {
  id: string;
  text: string;
}

export interface ComposerQueueState {
  items: ComposerQueueItem[];
  /** e.g. "2 Queued" from toolbar header */
  queueLabel?: string;
}

export interface QuestionnaireOption {
  letter: string;
  label: string;
  isFreeform: boolean;
  /** True when Cursor's option row is selected (aria / data / selected class). */
  selected?: boolean;
  /** Internal extractor path; stripped from public socket state. */
  selectorPath: string;
  actionId?: string;
}

export interface QuestionnaireQuestion {
  number: string;
  text: string;
  options: QuestionnaireOption[];
  isActive: boolean;
}

export interface Questionnaire {
  questions: QuestionnaireQuestion[];
  activeIndex: number;
  totalLabel: string;
  /** Internal extractor path; stripped from public socket state. */
  skipSelectorPath: string;
  skipActionId?: string;
  /** Internal extractor path; stripped from public socket state. */
  continueSelectorPath: string;
  continueActionId?: string;
  continueDisabled: boolean;
}

export interface CursorState {
  connected: boolean;
  /** Health of DOM extraction independent from the CDP websocket connection. */
  extractorStatus: ExtractorStatus;
  /** Timestamp of the last successful extraction in ms since epoch. */
  lastExtractionAt: number | null;
  /** Number of consecutive failed extraction attempts since the last success. */
  consecutiveExtractionFailures: number;
  /** Most recent extraction error, or null after a successful extraction/reset. */
  lastExtractionError: string | null;
  agentStatus: AgentStatus;
  /** Live activity label; null means explicitly cleared on the wire. */
  agentActivityText: string | null;
  /** True only when the server believes work is actively in progress right now. */
  agentActivityLive: boolean;
  /** Provenance of the current activity signal, for transports/debugging. */
  agentActivitySource: ActivitySource;
  messages: ChatElement[];
  pendingApprovals: Approval[];
  inputAvailable: boolean;
  chatTabs: ChatTab[];
  /** data-composer-id of the active composer in the extracted DOM. Stable
   *  across windows that share an agent via Cursor's global rail; differs
   *  for two genuinely different agents that happen to share a tab title. */
  activeComposerId: string;
  mode: ModeInfo;
  model: ModelInfo;
  windows: CursorWindow[];
  activeWindowId: string;
  /** Prompts queued in composer toolbar (outside transcript). */
  composerQueue: ComposerQueueState;
  /** Agent questionnaire widget (multiple-choice questions). */
  questionnaire: Questionnaire | null;
  /**
   * Internal extractor diagnostics. Stripped from socket `state:full` /
   * `state:patch`; inspect via `/debug/state`.
   */
  _rawSignals?: RawSignals;
}

export interface ChatTab {
  composerId: string;
  title: string;
  isActive: boolean;
  /** True when the session is present in Cursor's horizontal open-tab strip. */
  isOpen?: boolean;
  status: string;
  /** Internal extractor path; stripped from public socket state. */
  selectorPath: string;
}

export interface ModeInfo {
  current: string;
  available: { id: string; label: string; icon: string }[];
}

export interface ModelInfo {
  current: string;
  currentId: string;
}

export type ExtractorStatus = 'idle' | 'waiting' | 'ok' | 'stale';

export type AgentStatus =
  | 'idle'
  | 'thinking'
  | 'generating'
  | 'running_tool'
  | 'waiting_approval'
  | 'error';

export type ActivitySource =
  | 'none'
  | 'shimmer'
  | 'loading_tool'
  | 'loading_indicator'
  | 'tail_thought';

export type ChatElement =
  | HumanMessage
  | AssistantMessage
  | ToolCallElement
  | ThoughtBlock
  | PlanBlock
  | TodoListBlock
  | RunCommand
  | LoadingIndicator;

export interface HumanMessage {
  type: 'human';
  id: string;
  flatIndex: number;
  text: string;
  mentions: { name: string; mentionType: string }[];
  /** Quoted / reply preview from composer (e.g. ProseMirror blockquote). */
  quoted?: { text: string };
}

export type DiffLineKind = 'add' | 'rem' | 'ctx' | 'meta' | 'hunk';

/** Native web/Telegram rendering: structured code or diff (no mirrored Monaco HTML). */
export interface CodeBlockItem {
  blockKind: 'code' | 'diff';
  filename?: string;
  language?: string;
  /** Flat joined text (search, fallback, simple pre) */
  code: string;
  /** Present when blockKind === 'diff'; line-level add/rem/ctx from live Monaco DOM */
  diffLines?: { kind: DiffLineKind; text: string }[];
}

export interface AssistantMessage {
  type: 'assistant';
  id: string;
  flatIndex: number;
  text: string;
  html: string;
  codeBlocks: CodeBlockItem[];
}

export interface ToolCallElement {
  type: 'tool';
  id: string;
  flatIndex: number;
  toolCallId: string;
  status: 'loading' | 'completed';
  action: string;
  details: string;
  filename?: string;
  additions?: number;
  deletions?: number;
  summaryText?: string;
  actions?: RunAction[];
  blocked?: string;
  /** Structured diff/code for edit tools; web client renders natively */
  diffBlock?: CodeBlockItem;
}

export interface ThoughtBlock {
  type: 'thought';
  id: string;
  flatIndex: number;
  duration: string;
  action?: string;
  detail?: string;
  /** Cursor step-group: umbrella row (e.g. Explored) vs inner thinking row */
  thoughtKind?: 'step_summary' | 'thinking_step';
}

export interface PlanTodo {
  text: string;
  status: 'pending' | 'completed' | 'in_progress';
}

export interface PlanAction {
  label: string;
  type: 'view_plan' | 'build';
  /** Internal extractor path; stripped from public socket state. */
  selectorPath: string;
  /** Present when the server has authorized the action for one target generation. */
  actionId?: string;
}

export interface PlanBlock {
  type: 'plan';
  id: string;
  flatIndex: number;
  label: string;
  title: string;
  todosCompleted: number;
  todosTotal: number;
  description?: string;
  /** Raw markdown HTML from `.composer-create-plan-text .markdown-root` (web client). */
  descriptionHtml?: string;
  todos?: PlanTodo[];
  /** Hidden todo rows behind "N more" in Cursor (estimated). */
  todosMoreCount?: number;
  model?: string;
  /** Click to open plan-scoped model dropdown in Cursor. Internal; stripped from public state. */
  modelDropdownSelectorPath?: string;
  /** Opaque authorization for the plan model trigger. */
  modelActionId?: string;
  actions?: PlanAction[];
}

export interface PlanModelOption {
  id: string;
  label: string;
  selected?: boolean;
}

export interface PlanFullData {
  todos: PlanTodo[];
  body: string;
  bodyHtml: string;
}

export interface TodoListBlock {
  type: 'todo_list';
  id: string;
  flatIndex: number;
  title: string;
  todosCompleted: number;
  todosTotal: number;
  todos: PlanTodo[];
}

export interface RunAction {
  label: string;
  type: 'run' | 'skip' | 'allow';
  /** Internal extractor path; stripped from public socket state. */
  selectorPath: string;
  actionId?: string;
}

export interface RunCommand {
  type: 'run_command';
  id: string;
  flatIndex: number;
  toolCallId: string;
  description: string;
  candidates: string;
  command: string;
  actions: RunAction[];
}

export interface LoadingIndicator {
  type: 'loading';
  id: string;
  flatIndex: number;
  text?: string;
}

export interface Approval {
  id: string;
  description: string;
  actions: ApprovalAction[];
}

export interface ApprovalAction {
  label: string;
  type: 'approve' | 'reject' | 'approve_all';
  /** Internal extractor path; stripped from public socket state. */
  selectorPath: string;
  /** Present when the action has been registered by the server. */
  actionId?: string;
}

export interface SelectorStrategy {
  strategies: string[];
  textMatch?: string[];
}

export interface SelectorConfig {
  chatContainer: SelectorStrategy;
  approveButton: SelectorStrategy;
  rejectButton: SelectorStrategy;
  chatInput: SelectorStrategy;
  agentStatus: SelectorStrategy;
  [key: string]: SelectorStrategy;
}

export interface CommandPayload {
  commandId: string;
  type: 'send_message' | 'approve' | 'reject' | 'approve_all' | 'switch_tab' | 'new_chat' | 'set_mode' | 'set_model' | 'click_action' | 'get_plan_full' | 'get_plan_model_options' | 'set_plan_model';
  text?: string;
  approvalId?: string;
  actionType?: string;
  /** Opaque ActionRegistry id; selectorPath is retained only for legacy reads. */
  actionId?: string;
  operationId?: string;
  targetGeneration?: number;
  selectorPath?: string;
  actionLabel?: string;
  composerId?: string;
  modeId?: string;
  modelId?: string;
  planId?: string;
  planModelId?: string;
  tabTitle?: string;
  windowId?: string;
}

export interface CommandResult {
  commandId: string;
  ok: boolean;
  error?: string;
  data?: unknown;
}

export interface ServerConfig {
  cdpUrl: string;
  serverPort: number;
  serverHost: string;
  pollIntervalMs: number;
  debounceMs: number;
  selectorsPath: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  webappPassword: string;
  windowTitleQualifier: boolean;
  dataDir: string;
  adapterStorePath: string;
  adapterBackupCount: number;
  actionTtlMs: number;
  telegram: TelegramConfig;
}

export interface TelegramConfig {
  enabled: boolean;
  botToken: string;
  preRegisteredUsers: number[];
  impl: 'grammy' | 'raw';
}

// --- Capability discovery (P0): independent of DOM CursorState ---

export type BrowserFamily = 'cursor' | 'vscode' | 'chrome' | 'unknown';

export type DiscoveryStatus =
  | 'idle'
  | 'running'
  | 'ok'
  | 'degraded'
  | 'failed'
  | 'stale'
  | 'endpoint_unverified'
  | 'target_unverified';

export type CapabilityState =
  | 'ok'
  | 'changed'
  | 'degraded'
  | 'unknown'
  | 'stale'
  | 'unavailable';

export type MenuCompleteness = 'complete' | 'partial' | 'unknown';

export type CapabilityKind = 'mode' | 'model' | 'tool';

export type CapabilityEvidenceSource =
  | 'data_attribute'
  | 'aria'
  | 'menu'
  | 'registered_adapter'
  | 'inferred';

export type DiscoveryDiagnosticCode =
  | 'cdp_unreachable'
  | 'endpoint_unverified'
  | 'target_list_failed'
  | 'target_unverified'
  | 'preferred_target_ambiguous'
  | 'webview_target'
  | 'runtime_evaluate_failed'
  | 'composer_not_found'
  | 'mode_trigger_not_found'
  | 'mode_menu_not_opened'
  | 'model_trigger_not_found'
  | 'model_menu_not_opened'
  | 'model_menu_empty'
  | 'model_menu_partial'
  | 'tool_scope_ambiguous'
  | 'action_expired'
  | 'action_scope_changed'
  | 'action_consumed'
  | 'selector_invalid'
  | 'selector_non_unique'
  | 'adapter_validation_failed'
  | 'capability_circuit_open'
  | 'adapter_rollback'
  | 'identity_ok';

export type DiagnosticSeverity = 'info' | 'warning' | 'error';

export interface CdpVersionInfo {
  Browser?: string;
  'User-Agent'?: string;
  UserAgent?: string;
  'Protocol-Version'?: string;
  webSocketDebuggerUrl?: string;
}

export interface EndpointIdentity {
  verified: boolean;
  browserFamily: BrowserFamily;
  protocolVersion: string;
  product: string;
  diagnosticCode: DiscoveryDiagnosticCode;
  diagnosticMessage: string;
}

export interface DiscoveryDiagnostic {
  id: string;
  code: DiscoveryDiagnosticCode;
  severity: DiagnosticSeverity;
  windowId?: string;
  targetId?: string;
  adapterId?: string;
  message: string;
  evidence: Record<string, string | number | boolean | null>;
  createdAt: number;
}

export interface DiscoverySummary {
  status: DiscoveryStatus;
  targetId: string;
  targetGeneration: number;
  fingerprint?: string;
  lastRunAt: number | null;
  diagnosticIds: string[];
}

/** Public, redacted discovery payload for GET /api/discovery/status. */
export interface SanitizedDiscoveryStatus {
  status: DiscoveryStatus;
  endpoint: {
    verified: boolean;
    browserFamily: BrowserFamily;
    protocolVersion: string;
    product: string;
  };
  activeTargetId: string;
  targetGeneration: number;
  preferredTargetPresent: boolean | null;
  windowCount: number;
  lastRunAt: number | null;
  lastError: { code: DiscoveryDiagnosticCode; message: string } | null;
  diagnostics: Array<{
    code: DiscoveryDiagnosticCode;
    severity: DiagnosticSeverity;
    message: string;
    targetId?: string;
  }>;
  capabilities?: {
    targetId: string;
    targetGeneration: number;
    revision: number;
    state: CapabilityState;
  } | null;
}

export interface CapabilityStatus {
  state: CapabilityState;
  confidence: number;
  completeness: MenuCompleteness;
  revision: number;
  targetGeneration: number;
  expectedCount?: number;
  observedCount?: number;
  missing?: string[];
  added?: string[];
  changed?: string[];
  conflicts?: string[];
  lastObservedAt?: number | null;
  lastVerifiedAt?: number | null;
  diagnosticIds?: string[];
}

export interface ModeCapability {
  id: string;
  label: string;
  icon?: string;
  current: boolean;
  source: CapabilityEvidenceSource;
  confidence: number;
  scope: 'composer';
  selectable: boolean;
  observedAt: number;
}

export interface ModelCapability {
  id: string;
  label: string;
  selected: boolean;
  scope: 'composer' | 'plan';
  idStability: 'stable' | 'label' | 'runtime_only';
  source: CapabilityEvidenceSource;
  confidence: number;
  selectable: boolean;
  observedAt: number;
}

export interface ModelCapabilitySnapshot {
  items: ModelCapability[];
  completeness: MenuCompleteness;
  filterActive: boolean;
  observedAt: number;
}

/** Opaque action id only — no selector paths. */
export interface ToolActionCapability {
  /** Opaque server-generated id; selector paths never cross the public boundary. */
  actionId: string;
  label: string;
  kind: string;
  executable: boolean;
  requiresConfirmation: boolean;
  expiresAt: number;
}

export interface RegisteredActionTarget {
  actionId: string;
  windowId: string;
  targetId: string;
  targetGeneration: number;
  composerId: string;
  toolCallId: string;
  adapterId: string;
  actionType: string;
  expectedLabel: string;
  selectorStrategyId: string;
  selectorPath: string;
  createdAt: number;
  expiresAt: number;
  consumed: boolean;
}

export interface ToolCapability {
  id: string;
  type: string;
  source: CapabilityEvidenceSource;
  executable: boolean;
  actions: ToolActionCapability[];
}

export interface CapabilitySummary {
  targetId: string;
  targetGeneration: number;
  revision: number;
  modes: ModeCapability[];
  models: ModelCapabilitySnapshot;
  tools: ToolCapability[];
  status: CapabilityStatus;
  adapterBindings: Record<CapabilityKind, string>;
  observedAt: number;
}

export interface CapabilityPatch {
  targetId: string;
  targetGeneration: number;
  revision: number;
  status?: CapabilityStatus;
  modes?: ModeCapability[];
  models?: ModelCapabilitySnapshot;
  tools?: ToolCapability[];
  adapterBindings?: Record<CapabilityKind, string>;
  stale?: boolean;
}

/** Read-only projection of capability state onto the legacy ModeInfo/ModelInfo shape. */
export interface CompatibleModeModelProjection {
  mode: ModeInfo;
  model: ModelInfo;
  status: CapabilityState;
}
