export type ActionIntent =
  | "navigate"
  | "click"
  | "type"
  | "select"
  | "scroll"
  | "upload"
  | "verify"
  | "wait";

export interface PlannedAction {
  id: string;
  /** The originating NLP instruction this action was derived from. */
  step: string;
  intent: ActionIntent;
  /** Natural-language description of the target element, e.g. "search input field". */
  target?: string;
  /** Literal value to type/select, or a {{token}} resolved at execution time (never a raw secret). */
  value?: string;
  /** What should be true after this action — handed to the Vision Agent for validation. */
  expected?: string;
  /** Only for intent="verify": the bullet checks to confirm. */
  verifications?: string[];
  retries: number;
}

export interface ExecutionPlan {
  environment: string;
  site: string;
  scenario: string;
  baseUrl: string;
  generatedAt: string;
  plannerModel: string;
  actions: PlannedAction[];
}

export type RecoveryStrategy =
  | "fresh_screenshot"
  | "accessibility_tree"
  | "dom_locator"
  | "coordinates"
  | "alternate_workflow";

export interface StepResult {
  action: PlannedAction;
  status: "passed" | "failed";
  attempts: AttemptLog[];
  screenshotPath?: string;
  durationMs: number;
}

export interface AttemptLog {
  strategy: RecoveryStrategy;
  reasoning: string;
  confidence?: number;
  success: boolean;
  error?: string;
}

export interface VisionLocateResult {
  found: boolean;
  elementType?: string;
  label?: string;
  role?: string;
  confidence: number;
  reasoning: string;
  /** Fallback coordinates in the screenshot, used only if semantic locators fail. */
  coordinates?: { x: number; y: number };
}

export interface VisionValidateResult {
  passed: boolean;
  confidence: number;
  reasoning: string;
  extractedValues?: Record<string, string>;
  failedChecks?: string[];
}
