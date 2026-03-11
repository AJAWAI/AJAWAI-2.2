import { AutoTokenizer, AutoModelForCausalLM, env } from '@huggingface/transformers';

// Simple WebGPU check - use any to avoid TypeScript DOM.WebGPU issues
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function hasWebGPU(): boolean {
  const gpu = (navigator as any).gpu;
  return !!gpu && typeof gpu.requestAdapter === 'function';
}

export type LoadingStage = 
  | 'idle'
  | 'checking-webgpu'
  | 'loading-tokenizer'
  | 'loading-model'
  | 'ready'
  | 'error'
  | 'timeout';

export type LoadingSubstage = 
  | 'idle'
  | 'checking-navigator'
  | 'requesting-adapter'
  | 'downloading-tokenizer'
  | 'tokenizer-loaded'
  | 'fetching-model-metadata'
  | 'downloading-model-files'
  | 'reading-cache'
  | 'finalizing-download'
  | 'parsing-onnx'
  | 'creating-session'
  | 'initializing-webgpu'
  | 'model-loaded'
  | 'ready'
  | 'timeout'
  | 'error'
  | 'abandoned';

export interface StorageInfo {
  usage: number;
  quota: number;
}

export interface ProgressEvent {
  stage: string;
  name?: string;
  status?: string;
  loaded?: number;
  total?: number;
  progress?: number;
  timestamp: number;
  raw: unknown;
}

export interface StageEntry {
  stage: LoadingStage;
  substage: LoadingSubstage;
  enteredAt: number;
  exitedAt?: number;
  durationMs?: number;
}

export interface LoaderDiagnostics {
  // Core state
  stage: LoadingStage;
  substage: LoadingSubstage;
  error: string | null;
  
  // Load generation tracking
  loadGeneration: number;
  timedOut: boolean;
  abandonedLoad: boolean;
  completedAfterTimeout: boolean;
  
  // Progress tracking
  tokenizerDownloadProgress: number;
  modelDownloadProgress: number;
  combinedProgress: number;
  lastProgressPayload: ProgressEvent | null;
  lastProgressTimestamp: number | null;
  
  // Size estimation - both declared and observed
  declaredModelSizeMB: number;
  observedTransferBytes: number;
  observedTransferMB: number;
  observedTotalBytes: number;
  observedTotalMB: number;
  estimatedTokenizerSizeMB: number | null;
  
  // Storage
  storageBefore: StorageInfo | null;
  storageAfter: StorageInfo | null;
  
  // Timing
  startedAt: number | null;
  elapsedMs: number;
  lastHeartbeatAt: number | null;
  lastProgressAt: number | null;
  
  // Model phase tracking
  modelPhaseStartedAt: number | null;
  modelPhaseHasProgress: boolean;
  modelPhaseLastEvent: string | null;
  modelPhaseStuckAtHighProgress: boolean;
  
  // Risk diagnostics
  crashRiskLevel: 'none' | 'low' | 'medium' | 'high' | 'critical';
  crashRiskMessage: string;
  
  // Stage tracking
  stageLog: StageEntry[];
  currentStageEntry: StageEntry | null;
  
  // Generate tracking
  generateReached: boolean;
  
  // Bug report
  bugReport: string;
}

type StateListener = (state: LoaderDiagnostics) => void;

// Model configuration
const MODEL_ID = 'onnx-community/Phi-3.5-mini-instruct-onnx-web';
const TIMEOUT_MS = 180000; // 3 minutes timeout
const STALL_THRESHOLD_MS = 60000; // 1 minute without progress = stalled

// Safe thresholds for mobile browsers
const MOBILE_CRASH_RISK_THRESHOLD_MB = 500; // ~500MB transfer is high risk
const MOBILE_CRITICAL_RISK_THRESHOLD_MB = 1024; // >1GB is critical risk

// Declared/expected size (this is wrong - actual transfer is ~2GB)
const DECLARED_MODEL_SIZE_MB = 385;
const ESTIMATED_TOKENIZER_SIZE_MB = 0.05;

let tokenizer: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>> | null = null;
let model: Awaited<ReturnType<typeof AutoModelForCausalLM.from_pretrained>> | null = null;

// Load generation ID - increments on each loadPhi() call
let currentLoadGeneration = 0;

// Track if current load has been abandoned
let isCurrentLoadAbandoned = false;

// Track finalization phase
let isInFinalizationPhase = false;

let state: LoaderDiagnostics = createInitialState();
let loadingPromise: Promise<void> | null = null;
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let stalledCheckInterval: ReturnType<typeof setInterval> | null = null;
const listeners: Set<StateListener> = new Set();

function createInitialState(): LoaderDiagnostics {
  return {
    stage: 'idle',
    substage: 'idle',
    error: null,
    loadGeneration: 0,
    timedOut: false,
    abandonedLoad: false,
    completedAfterTimeout: false,
    tokenizerDownloadProgress: 0,
    modelDownloadProgress: 0,
    combinedProgress: 0,
    lastProgressPayload: null,
    lastProgressTimestamp: null,
    declaredModelSizeMB: DECLARED_MODEL_SIZE_MB,
    observedTransferBytes: 0,
    observedTransferMB: 0,
    observedTotalBytes: 0,
    observedTotalMB: 0,
    estimatedTokenizerSizeMB: ESTIMATED_TOKENIZER_SIZE_MB,
    storageBefore: null,
    storageAfter: null,
    startedAt: null,
    elapsedMs: 0,
    lastHeartbeatAt: null,
    lastProgressAt: null,
    modelPhaseStartedAt: null,
    modelPhaseHasProgress: false,
    modelPhaseLastEvent: null,
    modelPhaseStuckAtHighProgress: false,
    crashRiskLevel: 'none',
    crashRiskMessage: '',
    stageLog: [],
    currentStageEntry: null,
    generateReached: false,
    bugReport: '',
  };
}

function calculateCrashRisk(observedMB: number): { level: LoaderDiagnostics['crashRiskLevel']; message: string } {
  if (observedMB >= MOBILE_CRITICAL_RISK_THRESHOLD_MB) {
    return {
      level: 'critical',
      message: `CRITICAL: Observed ${observedMB.toFixed(0)}MB transfer exceeds safe browser budget (>1GB). High risk of crash during ONNX/WebGPU initialization.`,
    };
  } else if (observedMB >= MOBILE_CRASH_RISK_THRESHOLD_MB) {
    return {
      level: 'high',
      message: `HIGH RISK: Observed ${observedMB.toFixed(0)}MB transfer exceeds 500MB. Browser crash likely during finalization phase.`,
    };
  } else if (observedMB >= 200) {
    return {
      level: 'medium',
      message: `MEDIUM RISK: Observed ${observedMB.toFixed(0)}MB. Monitor for stability issues.`,
    };
  }
  return { level: 'none', message: '' };
}

function notifyListeners(): void {
  const snapshot = getStatus();
  listeners.forEach(listener => listener(snapshot));
}

function updateProgress(event: ProgressEvent): void {
  // Extract values from event
  const status = event.status || '';
  const name = event.name || '';
  const loaded = event.loaded || 0;
  const total = event.total || 0;
  const progress = event.progress || 0;
  
  // Update observed transfer size
  if (total > 0) {
    state.observedTotalBytes = total;
    state.observedTotalMB = total / (1024 * 1024);
    state.observedTransferMB = state.observedTotalMB;
  }
  if (loaded > 0) {
    state.observedTransferBytes = loaded;
  }
  
  // Update crash risk based on observed size
  const risk = calculateCrashRisk(state.observedTransferMB);
  state.crashRiskLevel = risk.level;
  state.crashRiskMessage = risk.message;
  
  // Determine substage based on progress and event details
  let newSubstage: LoadingSubstage = state.substage;
  
  // If progress is very high (>95%) and still not ready, we're in finalization
  if (progress >= 0.95 && state.stage === 'loading-model' && state.substage !== 'model-loaded' && state.substage !== 'ready') {
    isInFinalizationPhase = true;
    newSubstage = 'finalizing-download';
  }
  
  // Infer substage from event details
  if (status === 'init' || name.includes('manifest')) {
    newSubstage = 'fetching-model-metadata';
  } else if (status === 'downloading' || status === 'progress') {
    if (isInFinalizationPhase || progress >= 0.95) {
      newSubstage = 'finalizing-download';
    } else {
      newSubstage = 'downloading-model-files';
    }
  } else if (status === 'ready' && name.includes('cache')) {
    newSubstage = 'reading-cache';
  } else if (name.includes('onnx') || name.includes('session')) {
    newSubstage = 'creating-session';
  } else if (status === 'init' && (name.includes('webgpu') || name.includes('gpu'))) {
    newSubstage = 'initializing-webgpu';
  }
  
  // Check if stuck at high progress (potential crash indicator)
  if (progress >= 0.95 && state.stage === 'loading-model' && !isInFinalizationPhase) {
    state.modelPhaseStuckAtHighProgress = true;
  }
  
  if (newSubstage !== state.substage) {
    enterStage(state.stage, newSubstage);
  }
  
  // Update percentages
  if (progress !== undefined) {
    if (state.stage === 'loading-tokenizer') {
      state.tokenizerDownloadProgress = Math.round(progress * 100);
    } else if (state.stage === 'loading-model') {
      state.modelDownloadProgress = Math.round(progress * 100);
    }
  }
  
  // Combined progress: tokenizer ~1%, model ~99%
  const combined = (state.tokenizerDownloadProgress * 0.01) + (state.modelDownloadProgress * 0.99);
  state.combinedProgress = Math.min(100, Math.round(combined));
  
  // Track model phase progress
  if (state.stage === 'loading-model') {
    state.modelPhaseHasProgress = true;
    state.modelPhaseLastEvent = JSON.stringify({
      name: event.name,
      status: event.status,
      loaded: event.loaded,
      total: event.total,
      progress: event.progress,
    });
  }
  
  // Store full progress payload
  state.lastProgressPayload = event;
  state.lastProgressTimestamp = event.timestamp;
  state.lastProgressAt = Date.now();
  
  // Log important events
  if (progress >= 0.95) {
    console.log(`[phiLoader] HIGH PROGRESS: ${(progress * 100).toFixed(2)}% - ${state.observedTransferMB.toFixed(0)}MB observed - Risk: ${state.crashRiskLevel}`);
  } else {
    console.log(`[phiLoader] Progress: ${(progress * 100).toFixed(2)}% - ${state.observedTransferMB.toFixed(0)}MB`);
  }
  
  notifyListeners();
}

function enterStage(stage: LoadingStage, substage: LoadingSubstage): void {
  const now = Date.now();
  
  // Exit current stage
  if (state.currentStageEntry) {
    state.currentStageEntry.exitedAt = now;
    state.currentStageEntry.durationMs = now - state.currentStageEntry.enteredAt;
    state.stageLog.push({ ...state.currentStageEntry });
  }
  
  // Enter new stage
  state.stage = stage;
  state.substage = substage;
  state.currentStageEntry = {
    stage,
    substage,
    enteredAt: now,
  };
  
  // Track model phase start
  if (stage === 'loading-model' && !state.modelPhaseStartedAt) {
    state.modelPhaseStartedAt = now;
  }
  
  // Update elapsed time
  if (state.startedAt) {
    state.elapsedMs = now - state.startedAt;
  }
  
  console.log(`[phiLoader] Stage: ${stage} → Substage: ${substage}`);
  notifyListeners();
}

function setTimeoutState(): void {
  state.timedOut = true;
  state.stage = 'timeout';
  state.substage = 'timeout';
  state.error = `Loading timed out after ${TIMEOUT_MS}ms. NOTE: Underlying model load may still be running in background.`;
  state.loadGeneration = currentLoadGeneration;
  
  // Generate bug report at timeout
  generateBugReport('timeout');
  
  console.error(`[phiLoader] TIMEOUT: ${state.elapsedMs}ms`);
  notifyListeners();
}

function setAbandoned(): void {
  state.abandonedLoad = true;
  state.substage = 'abandoned';
  state.error = `Load marked as abandoned. Underlying model load may still be running.`;
  
  generateBugReport('abandoned');
  
  console.warn('[phiLoader] Load marked as abandoned');
  notifyListeners();
}

function setError(errorMsg: string): void {
  state.stage = 'error';
  state.substage = 'error';
  state.error = errorMsg;
  state.lastProgressTimestamp = Date.now();
  
  generateBugReport('error');
  
  notifyListeners();
}

function generateBugReport(trigger: 'timeout' | 'abandoned' | 'error' | 'high-risk' | 'final'): void {
  const lines: string[] = [
    '=== AJAWAI 2.2 Crash/Risk Diagnostics Bug Report ===',
    `Generated: ${new Date().toISOString()}`,
    `Trigger: ${trigger}`,
    `Load Generation: ${state.loadGeneration}`,
    '',
    '--- CRASH ANALYSIS ---',
    `Observed Transfer: ${state.observedTransferMB.toFixed(2)} MB (${state.observedTransferBytes} bytes)`,
    `Observed Total: ${state.observedTotalMB.toFixed(2)} MB (${state.observedTotalBytes} bytes)`,
    `Declared Model Size: ${state.declaredModelSizeMB} MB`,
    `Crash Risk Level: ${state.crashRiskLevel.toUpperCase()}`,
    state.crashRiskMessage ? `Risk Message: ${state.crashRiskMessage}` : '',
    '',
    '--- Configuration ---',
    `Model ID: ${MODEL_ID}`,
    `Package: @huggingface/transformers`,
    `Timeout: ${TIMEOUT_MS}ms`,
    `Stall Threshold: ${STALL_THRESHOLD_MS}ms`,
    `Mobile Crash Risk Threshold: ${MOBILE_CRASH_RISK_THRESHOLD_MB}MB`,
    `Mobile Critical Threshold: ${MOBILE_CRITICAL_RISK_THRESHOLD_MB}MB`,
    '',
    '--- Environment ---',
    `WebGPU Available: ${hasWebGPU()}`,
    `User Agent: ${navigator.userAgent.substring(0, 80)}...`,
    '',
    '--- State Flags ---',
    `Stage: ${state.stage}`,
    `Substage: ${state.substage}`,
    `Timed Out: ${state.timedOut}`,
    `Abandoned: ${state.abandonedLoad}`,
    `Completed After Timeout: ${state.completedAfterTimeout}`,
    `Generate Reached: ${state.generateReached}`,
    `Elapsed: ${state.elapsedMs}ms`,
    '',
    '--- Model Phase ---',
    `Started At: ${state.modelPhaseStartedAt || 'N/A'}`,
    `Has Progress: ${state.modelPhaseHasProgress}`,
    `Stuck at High Progress: ${state.modelPhaseStuckAtHighProgress}`,
    `Last Event: ${state.modelPhaseLastEvent || 'None'}`,
    '',
    '--- Progress ---',
    `Tokenizer: ${state.tokenizerDownloadProgress}%`,
    `Model: ${state.modelDownloadProgress}%`,
    `Combined: ${state.combinedProgress}%`,
    `Last Progress At: ${state.lastProgressTimestamp ? new Date(state.lastProgressTimestamp).toISOString() : 'N/A'}`,
    '',
    '--- Last Progress Payload ---',
    state.lastProgressPayload 
      ? JSON.stringify(state.lastProgressPayload, (key, value) => {
          if (key === 'raw') return '[object]';
          return value;
        }, 2).substring(0, 800)
      : 'None',
    '',
    '--- Storage ---',
    `Storage Before: ${formatBytes(state.storageBefore?.usage || 0)} / ${formatBytes(state.storageBefore?.quota || 0)}`,
    state.storageAfter 
      ? `Storage After: ${formatBytes(state.storageAfter.usage)} / ${formatBytes(state.storageAfter.quota)}`
      : 'Storage After: NOT AVAILABLE (browser may have crashed)',
    '',
    '--- Root Cause Analysis ---',
    state.observedTotalMB > MOBILE_CRITICAL_RISK_THRESHOLD_MB 
      ? 'ROOT CAUSE: Transfer size (~2GB) EXCEEDS mobile browser safe limits. Browser crashes during ONNX session creation / WebGPU initialization, not during download.'
      : state.observedTotalMB > MOBILE_CRASH_RISK_THRESHOLD_MB
        ? 'ROOT CAUSE: Transfer size exceeds recommended mobile limits. Browser may crash during finalization.'
        : 'ROOT CAUSE: Unknown - check other diagnostics',
    '',
    '--- Stage Log ---',
  ];
  
  // Add stage durations
  for (let i = 0; i < state.stageLog.length; i++) {
    const entry = state.stageLog[i];
    lines.push(`${i + 1}. ${entry.stage} → ${entry.substage}: ${entry.durationMs || 0}ms`);
  }
  
  if (state.currentStageEntry) {
    const current = state.currentStageEntry;
    lines.push(`${state.stageLog.length + 1}. ${current.stage} → ${current.substage}: (current, ${Date.now() - current.enteredAt}ms)`);
  }
  
  lines.push('');
  lines.push('--- Error ---');
  lines.push(state.error || 'None');
  
  lines.push('');
  lines.push('=== End Bug Report ===');
  
  state.bugReport = lines.join('\n');
  
  // Also log critical info to console for crash recovery
  if (state.crashRiskLevel === 'critical') {
    console.error('[phiLoader] CRITICAL CRASH RISK:', state.crashRiskMessage);
    console.error('[phiLoader] Transfer size:', state.observedTransferMB.toFixed(0), 'MB vs declared:', state.declaredModelSizeMB, 'MB');
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function getStorageEstimate(): Promise<StorageInfo> {
  try {
    const estimate = await navigator.storage.estimate();
    return {
      usage: estimate.usage || 0,
      quota: estimate.quota || 0,
    };
  } catch {
    return { usage: 0, quota: 0 };
  }
}

function startHeartbeat(): void {
  state.lastHeartbeatAt = Date.now();
  
  // Heartbeat every second
  heartbeatInterval = setInterval(() => {
    state.lastHeartbeatAt = Date.now();
    if (state.startedAt) {
      state.elapsedMs = Date.now() - state.startedAt;
    }
    
    // Check if we're stuck at high progress without moving to finalization
    if (state.modelPhaseStuckAtHighProgress && state.stage === 'loading-model') {
      const timeSinceProgress = Date.now() - (state.lastProgressAt || 0);
      if (timeSinceProgress > 30000 && state.modelDownloadProgress >= 95) {
        // Been stuck at >95% for 30 seconds - likely about to crash
        state.crashRiskLevel = 'critical';
        state.crashRiskMessage = 'STUCK AT 99%+ FOR 30s - Browser likely about to crash during finalization';
        generateBugReport('high-risk');
        notifyListeners();
      }
    }
    
    // Skip notifying if load was abandoned
    if (!isCurrentLoadAbandoned) {
      notifyListeners();
    }
  }, 1000);
}

function startStalledCheck(): void {
  stalledCheckInterval = setInterval(() => {
    const now = Date.now();
    const lastProgress = state.lastProgressAt || state.startedAt;
    
    // Skip if this load was abandoned
    if (isCurrentLoadAbandoned) {
      return;
    }
    
    if (lastProgress && state.stage !== 'ready' && state.stage !== 'error' && state.stage !== 'timeout') {
      const timeSinceProgress = now - lastProgress;
      
      if (timeSinceProgress > STALL_THRESHOLD_MS) {
        console.warn(`[phiLoader] STALLED: No progress for ${timeSinceProgress}ms`);
        generateBugReport('high-risk');
        notifyListeners();
      }
    }
    
    // Check for timeout
    if (state.startedAt && state.stage !== 'ready' && state.stage !== 'error' && state.stage !== 'timeout') {
      const elapsed = now - state.startedAt;
      if (elapsed > TIMEOUT_MS) {
        setTimeoutState();
        // Mark as abandoned so late completions are ignored
        setAbandoned();
        isCurrentLoadAbandoned = true;
      }
    }
  }, 5000);
}

function stopTimers(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  if (stalledCheckInterval) {
    clearInterval(stalledCheckInterval);
    stalledCheckInterval = null;
  }
}

export function getStatus(): LoaderDiagnostics {
  return { ...state, stageLog: [...state.stageLog] };
}

export function subscribe(listener: StateListener): () => void {
  listeners.add(listener);
  // Immediately call with current state
  listener(getStatus());
  // Return unsubscribe function
  return () => listeners.delete(listener);
}

export async function loadPhi(): Promise<void> {
  // Increment load generation to track this specific load
  currentLoadGeneration++;
  const thisLoadGeneration = currentLoadGeneration;
  isCurrentLoadAbandoned = false;
  isInFinalizationPhase = false;
  
  console.log(`[phiLoader] Starting load generation ${thisLoadGeneration}`);
  console.log(`[phiLoader] NOTE: Declared model size is ${DECLARED_MODEL_SIZE_MB}MB but actual transfer may be ~2GB`);
  
  // Single-flight: block duplicates
  if (loadingPromise && currentLoadGeneration === thisLoadGeneration) {
    return loadingPromise;
  }

  // Reset state for new load
  state = createInitialState();
  state.loadGeneration = thisLoadGeneration;
  
  if (state.stage === 'ready' && model && tokenizer) {
    return;
  }

  loadingPromise = _loadPhi(thisLoadGeneration);
  
  try {
    await loadingPromise;
  } finally {
    loadingPromise = null;
    
    // Only clean up timers if this is still the current load
    if (currentLoadGeneration === thisLoadGeneration) {
      stopTimers();
    }
  }
}

async function _loadPhi(loadGeneration: number): Promise<void> {
  // Initialize state
  state = createInitialState();
  state.loadGeneration = loadGeneration;
  
  // Start timers
  startHeartbeat();
  startStalledCheck();
  
  // Stage: checking-webgpu
  enterStage('checking-webgpu', 'checking-navigator');
  
  console.log('[phiLoader] Starting Phi-3.5 loading...');
  console.log('[phiLoader] Model:', MODEL_ID);
  console.log('[phiLoader] Package: @huggingface/transformers');
  console.log('[phiLoader] Load Generation:', loadGeneration);
  
  // Check WebGPU availability
  if (!hasWebGPU()) {
    setError('WebGPU not available on this device');
    return;
  }
  
  enterStage('checking-webgpu', 'requesting-adapter');
  console.log('[phiLoader] WebGPU available');
  
  // Configure Transformers.js for WebGPU
  env.useBrowserCache = true;
  env.allowLocalModels = false;
  
  // Get storage before loading
  state.storageBefore = await getStorageEstimate();
  console.log('[phiLoader] Storage before:', formatBytes(state.storageBefore.usage), '/', formatBytes(state.storageBefore.quota));
  notifyListeners();

  // Stage: loading-tokenizer
  enterStage('loading-tokenizer', 'downloading-tokenizer');
  
  try {
    tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      progress_callback: (progressInfo: any) => {
        // Check if this load was abandoned
        if (isCurrentLoadAbandoned || currentLoadGeneration !== loadGeneration) {
          console.log('[phiLoader] Ignoring tokenizer progress - load abandoned');
          return;
        }
        
        updateProgress({
          stage: 'tokenizer',
          name: progressInfo.name,
          status: progressInfo.status,
          loaded: progressInfo.loaded,
          total: progressInfo.total,
          progress: progressInfo.progress,
          timestamp: Date.now(),
          raw: progressInfo,
        });
      },
    });
    state.tokenizerDownloadProgress = 100;
    enterStage('loading-tokenizer', 'tokenizer-loaded');
    console.log('[phiLoader] Tokenizer loaded');
  } catch (err) {
    // Check if timed out while loading tokenizer
    if (isCurrentLoadAbandoned) {
      console.log('[phiLoader] Tokenizer load abandoned due to timeout');
      return;
    }
    setError(`Failed to load tokenizer: ${err}`);
    return;
  }

  // Stage: loading-model
  enterStage('loading-model', 'fetching-model-metadata');
  
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    model = await AutoModelForCausalLM.from_pretrained(MODEL_ID, {
      device: 'webgpu',
      dtype: 'q4f16',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      progress_callback: (progressInfo: any) => {
        // Check if this load was abandoned
        if (isCurrentLoadAbandoned || currentLoadGeneration !== loadGeneration) {
          console.log('[phiLoader] Ignoring model progress - load abandoned');
          return;
        }
        
        updateProgress({
          stage: progressInfo.stage || 'model',
          name: progressInfo.name,
          status: progressInfo.status,
          loaded: progressInfo.loaded,
          total: progressInfo.total,
          progress: progressInfo.progress,
          timestamp: Date.now(),
          raw: progressInfo,
        });
      },
    }) as any;
    
    // Check if timed out while loading model
    if (isCurrentLoadAbandoned || currentLoadGeneration !== loadGeneration) {
      console.log('[phiLoader] Model load completed but was abandoned');
      state.completedAfterTimeout = true;
      generateBugReport('abandoned');
      return;
    }
    
    state.modelDownloadProgress = 100;
    enterStage('loading-model', 'initializing-webgpu');
    console.log('[phiLoader] Model initialized on WebGPU');
  } catch (err) {
    // Check if timed out while loading model
    if (isCurrentLoadAbandoned) {
      console.log('[phiLoader] Model load abandoned due to timeout');
      return;
    }
    setError(`Failed to load model: ${err}`);
    return;
  }
  
  enterStage('loading-model', 'model-loaded');
  
  // Get storage after loading
  state.storageAfter = await getStorageEstimate();
  console.log('[phiLoader] Storage after:', formatBytes(state.storageAfter.usage), '/', formatBytes(state.storageAfter.quota));

  // Stage: ready
  enterStage('ready', 'ready');
  generateBugReport('final');
  notifyListeners();
}

export function getModel() {
  return model;
}

export function getTokenizer() {
  return tokenizer;
}

export function markGenerateReached(): void {
  if (state) {
    state.generateReached = true;
    generateBugReport('final');
    notifyListeners();
  }
}
