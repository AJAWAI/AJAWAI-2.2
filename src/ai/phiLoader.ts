import { AutoTokenizer, AutoModelForCausalLM, env } from '@huggingface/transformers';

// Simple WebGPU check
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
  | 'checking-webgpu'
  | 'downloading-tokenizer'
  | 'tokenizer-ready'
  | 'downloading-model-files'
  | 'finalizing-download'
  | 'parsing-onnx'
  | 'creating-session'
  | 'allocating-webgpu'
  | 'ready'
  | 'timeout'
  | 'error';

export interface StorageInfo {
  usage: number;
  quota: number;
}

export interface ProgressPayload {
  // Raw fields from library
  name?: string;
  status?: string;
  progress?: number;
  loaded?: number;
  total?: number;
  index?: number;
  numThreads?: number;
  // Our metadata
  timestamp: number;
}

export interface StageEntry {
  stage: LoadingStage;
  substage: LoadingSubstage;
  enteredAt: number;
  exitedAt?: number;
  durationMs?: number;
}

export interface CrashSnapshot {
  // When snapshot was saved
  savedAt: number;
  // What was happening
  stage: LoadingStage;
  substage: LoadingSubstage;
  elapsedMs: number;
  // Raw progress history
  progressHistory: ProgressPayload[];
  // Last known progress
  lastPayload: ProgressPayload | null;
  // Size tracking
  observedBytes: number;
  observedTotal: number;
  totalsConsistent: boolean;
  // Error info
  error: string | null;
  // Whether we crashed
  isCrash: boolean;
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
  
  // Progress tracking - raw payloads
  progressHistory: ProgressPayload[];
  lastProgressPayload: ProgressPayload | null;
  
  // Size tracking - honest accounting
  observedTransferBytes: number;
  observedTotalBytes: number;
  totalsConsistent: boolean;
  
  // Storage
  storageBefore: StorageInfo | null;
  storageAfter: StorageInfo | null;
  
  // Timing
  startedAt: number | null;
  elapsedMs: number;
  lastProgressAt: number | null;
  
  // Stage tracking
  stageLog: StageEntry[];
  currentStageEntry: StageEntry | null;
  
  // Crash snapshot (from localStorage)
  lastCrashSnapshot: CrashSnapshot | null;
  
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
const MOBILE_RISK_THRESHOLD_BYTES = 500 * 1024 * 1024; // 500MB

// localStorage keys
const CRASH_SNAPSHOT_KEY = 'ajawai_crash_snapshot';

let tokenizer: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>> | null = null;
let model: Awaited<ReturnType<typeof AutoModelForCausalLM.from_pretrained>> | null = null;

// Load generation ID - increments on each loadPhi() call
let currentLoadGeneration = 0;

// Track if current load has been abandoned
let isCurrentLoadAbandoned = false;

let state: LoaderDiagnostics = createInitialState();
let loadingPromise: Promise<void> | null = null;
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let stalledCheckInterval: ReturnType<typeof setInterval> | null = null;
const listeners: Set<StateListener> = new Set();

// Progress history for crash analysis
const progressHistory: ProgressPayload[] = [];

function createInitialState(): LoaderDiagnostics {
  return {
    stage: 'idle',
    substage: 'idle',
    error: null,
    loadGeneration: 0,
    timedOut: false,
    abandonedLoad: false,
    progressHistory: [],
    lastProgressPayload: null,
    observedTransferBytes: 0,
    observedTotalBytes: 0,
    totalsConsistent: true,
    storageBefore: null,
    storageAfter: null,
    startedAt: null,
    elapsedMs: 0,
    lastProgressAt: null,
    stageLog: [],
    currentStageEntry: null,
    lastCrashSnapshot: loadCrashSnapshot(),
    generateReached: false,
    bugReport: '',
  };
}

// Persist crash snapshot to localStorage
function saveCrashSnapshot(snapshot: CrashSnapshot): void {
  try {
    localStorage.setItem(CRASH_SNAPSHOT_KEY, JSON.stringify(snapshot));
    console.log('[phiLoader] Crash snapshot saved to localStorage');
  } catch (e) {
    console.warn('[phiLoader] Failed to save crash snapshot:', e);
  }
}

// Load crash snapshot from localStorage
function loadCrashSnapshot(): CrashSnapshot | null {
  try {
    const saved = localStorage.getItem(CRASH_SNAPSHOT_KEY);
    if (saved) {
      const snapshot = JSON.parse(saved) as CrashSnapshot;
      console.log('[phiLoader] Loaded crash snapshot from localStorage');
      return snapshot;
    }
  } catch (e) {
    console.warn('[phiLoader] Failed to load crash snapshot:', e);
  }
  return null;
}

// Clear crash snapshot (call after successful load)
function clearCrashSnapshot(): void {
  try {
    localStorage.removeItem(CRASH_SNAPSHOT_KEY);
    console.log('[phiLoader] Crash snapshot cleared');
  } catch (e) {
    console.warn('[phiLoader] Failed to clear crash snapshot:', e);
  }
}

// Save incremental progress snapshot
function saveProgressSnapshot(payload: ProgressPayload, stage: LoadingStage, substage: LoadingSubstage, error: string | null = null): void {
  // Collect unique totals seen
  const totals = new Set<number>();
  progressHistory.forEach(p => {
    if (p.total) totals.add(p.total);
  });
  if (payload.total) totals.add(payload.total);
  
  const snapshot: CrashSnapshot = {
    savedAt: Date.now(),
    stage,
    substage,
    elapsedMs: state.startedAt ? Date.now() - state.startedAt : 0,
    progressHistory: [...progressHistory].slice(-20), // Keep last 20
    lastPayload: payload,
    observedBytes: payload.loaded || 0,
    observedTotal: payload.total || 0,
    totalsConsistent: totals.size <= 1, // Consistent if only one total seen
    error,
    isCrash: true,
  };
  
  saveCrashSnapshot(snapshot);
}

function notifyListeners(): void {
  const snapshot = getStatus();
  listeners.forEach(listener => listener(snapshot));
}

function updateProgress(payload: ProgressPayload): void {
  // Store raw progress in history
  progressHistory.push(payload);
  if (progressHistory.length > 50) {
    progressHistory.shift();
  }
  
  state.lastProgressPayload = payload;
  state.lastProgressAt = Date.now();
  
  // Track observed bytes honestly
  if (payload.loaded !== undefined) {
    state.observedTransferBytes = payload.loaded;
  }
  if (payload.total !== undefined) {
    // Check if totals are consistent
    if (state.observedTotalBytes > 0 && payload.total !== state.observedTotalBytes) {
      state.totalsConsistent = false;
    }
    state.observedTotalBytes = payload.total;
  }
  
  // Determine substage based on progress and payload
  let newSubstage: LoadingSubstage = state.substage;
  const progress = payload.progress || 0;
  const status = payload.status || '';
  const name = payload.name || '';
  
  if (state.stage === 'loading-model') {
    // At high progress (>=95%), we're in finalization
    if (progress >= 0.95) {
      // Try to infer exact finalization stage from payload
      if (name.includes('onnx') || status === 'init') {
        newSubstage = 'parsing-onnx';
      } else if (name.includes('session')) {
        newSubstage = 'creating-session';
      } else if (name.includes('webgpu') || name.includes('gpu')) {
        newSubstage = 'allocating-webgpu';
      } else {
        newSubstage = 'finalizing-download';
      }
    } else if (progress > 0) {
      newSubstage = 'downloading-model-files';
    }
  }
  
  if (newSubstage !== state.substage) {
    enterStage(state.stage, newSubstage);
  }
  
  // Save progress snapshot for crash recovery
  saveProgressSnapshot(payload, state.stage, state.substage);
  
  // Log important events
  console.log(`[phiLoader] ${state.stage}/${state.substage}: ${(progress * 100).toFixed(1)}% - loaded: ${payload.loaded || '?'} - total: ${payload.total || '?'}`);
  
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
  
  // Update elapsed time
  if (state.startedAt) {
    state.elapsedMs = now - state.startedAt;
  }
  
  // Save snapshot on stage transition
  if (state.lastProgressPayload) {
    saveProgressSnapshot(state.lastProgressPayload, stage, substage);
  }
  
  console.log(`[phiLoader] Stage: ${stage} → ${substage}`);
  notifyListeners();
}

function setTimeoutState(): void {
  state.timedOut = true;
  state.stage = 'timeout';
  state.substage = 'timeout';
  state.error = `Loading timed out after ${TIMEOUT_MS}ms. Underlying model load may still be running.`;
  state.loadGeneration = currentLoadGeneration;
  
  // Save timeout snapshot
  saveProgressSnapshot(
    { timestamp: Date.now() },
    'timeout',
    'timeout',
    state.error
  );
  
  generateBugReport();
  console.error(`[phiLoader] TIMEOUT: ${state.elapsedMs}ms`);
  notifyListeners();
}

function setAbandoned(): void {
  state.abandonedLoad = true;
  state.substage = 'error';
  state.error = 'Load abandoned due to timeout';
  
  generateBugReport();
  console.warn('[phiLoader] Load abandoned');
  notifyListeners();
}

function setError(errorMsg: string): void {
  state.stage = 'error';
  state.substage = 'error';
  state.error = errorMsg;
  
  // Save error snapshot
  saveProgressSnapshot(
    { timestamp: Date.now() },
    'error',
    'error',
    errorMsg
  );
  
  generateBugReport();
  notifyListeners();
}

function generateBugReport(): void {
  // Check for inconsistent totals
  const totals = new Set<number>();
  progressHistory.forEach(p => {
    if (p.total) totals.add(p.total);
  });
  const totalsList = Array.from(totals);
  
  const lines: string[] = [
    '=== AJAWAI 2.2 Diagnostics Report ===',
    `Generated: ${new Date().toISOString()}`,
    '',
    '--- Configuration ---',
    `Model ID: ${MODEL_ID}`,
    `Timeout: ${TIMEOUT_MS}ms`,
    '',
    '--- Environment ---',
    `WebGPU Available: ${hasWebGPU()}`,
    `User Agent: ${navigator.userAgent.substring(0, 80)}...`,
    '',
    '--- Current State ---',
    `Stage: ${state.stage}`,
    `Substage: ${state.substage}`,
    `Load Generation: ${state.loadGeneration}`,
    `Timed Out: ${state.timedOut}`,
    `Abandoned: ${state.abandonedLoad}`,
    `Elapsed: ${state.elapsedMs}ms`,
    '',
    '--- Honest Size Accounting ---',
    `Observed Transfer Bytes: ${state.observedTransferBytes} (${(state.observedTransferBytes / (1024*1024)).toFixed(1)} MB)`,
    `Observed Total Bytes: ${state.observedTotalBytes} (${(state.observedTotalBytes / (1024*1024)).toFixed(1)} MB)`,
    `Totals Consistent: ${state.totalsConsistent}`,
    totalsList.length > 1 
      ? `WARNING: Multiple totals seen: ${totalsList.map(t => (t/(1024*1024)).toFixed(1) + 'MB').join(', ')}`
      : `Total: ${totalsList[0] ? (totalsList[0]/(1024*1024)).toFixed(1) + 'MB' : 'Unknown'}`,
    '',
    '--- Progress History (last 10) ---',
  ];
  
  // Add last 10 progress events
  const recentHistory = progressHistory.slice(-10);
  recentHistory.forEach((p, i) => {
    lines.push(`${i + 1}. progress:${p.progress?.toFixed(3)} loaded:${p.loaded} total:${p.total} status:${p.status || 'n/a'}`);
  });
  
  lines.push('');
  lines.push('--- Last Progress Payload ---');
  if (state.lastProgressPayload) {
    lines.push(JSON.stringify(state.lastProgressPayload, null, 2));
  } else {
    lines.push('None');
  }
  
  lines.push('');
  lines.push('--- Storage ---');
  if (state.storageBefore) {
    lines.push(`Before: ${formatBytes(state.storageBefore.usage)} / ${formatBytes(state.storageBefore.quota)}`);
  }
  if (state.storageAfter) {
    lines.push(`After: ${formatBytes(state.storageAfter.usage)} / ${formatBytes(state.storageAfter.quota)}`);
  } else {
    lines.push('After: NOT AVAILABLE (browser may have crashed)');
  }
  
  lines.push('');
  lines.push('--- Stage Log ---');
  state.stageLog.forEach((entry, i) => {
    lines.push(`${i + 1}. ${entry.stage} → ${entry.substage}: ${entry.durationMs || 0}ms`);
  });
  
  lines.push('');
  lines.push('--- Error ---');
  lines.push(state.error || 'None');
  
  // Add crash risk warning
  if (state.observedTotalBytes > MOBILE_RISK_THRESHOLD_BYTES) {
    lines.push('');
    lines.push('--- CRASH RISK WARNING ---');
    lines.push(`Observed transfer (${(state.observedTotalBytes/(1024*1024)).toFixed(0)}MB) exceeds mobile-safe threshold (500MB)`);
    lines.push('Browser crash likely during finalization/ONNX/WebGPU initialization');
  }
  
  lines.push('');
  lines.push('=== End Report ===');
  
  state.bugReport = lines.join('\n');
  
  // Save final snapshot
  saveProgressSnapshot(
    state.lastProgressPayload || { timestamp: Date.now() },
    state.stage,
    state.substage,
    state.error
  );
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
  // Heartbeat every second
  heartbeatInterval = setInterval(() => {
    if (state.startedAt) {
      state.elapsedMs = Date.now() - state.startedAt;
    }
    if (!isCurrentLoadAbandoned) {
      notifyListeners();
    }
  }, 1000);
}

function startStalledCheck(): void {
  stalledCheckInterval = setInterval(() => {
    const now = Date.now();
    const lastProgress = state.lastProgressAt || state.startedAt;
    
    if (isCurrentLoadAbandoned) {
      return;
    }
    
    // Check for stall
    if (lastProgress && state.stage !== 'ready' && state.stage !== 'error' && state.stage !== 'timeout') {
      const timeSinceProgress = now - lastProgress;
      if (timeSinceProgress > STALL_THRESHOLD_MS) {
        console.warn(`[phiLoader] STALLED: No progress for ${timeSinceProgress}ms`);
        generateBugReport();
        notifyListeners();
      }
    }
    
    // Check for timeout
    if (state.startedAt && state.stage !== 'ready' && state.stage !== 'error' && state.stage !== 'timeout') {
      const elapsed = now - state.startedAt;
      if (elapsed > TIMEOUT_MS) {
        setTimeoutState();
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
  return { 
    ...state, 
    progressHistory: [...progressHistory],
    stageLog: [...state.stageLog] 
  };
}

export function subscribe(listener: StateListener): () => void {
  listeners.add(listener);
  listener(getStatus());
  return () => listeners.delete(listener);
}

export async function loadPhi(): Promise<void> {
  // Increment load generation
  currentLoadGeneration++;
  const thisLoadGeneration = currentLoadGeneration;
  isCurrentLoadAbandoned = false;
  
  // Clear progress history for new load
  progressHistory.length = 0;
  
  console.log(`[phiLoader] Starting load generation ${thisLoadGeneration}`);
  
  // Single-flight: block duplicates for same generation
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
    if (currentLoadGeneration === thisLoadGeneration) {
      stopTimers();
    }
  }
}

async function _loadPhi(loadGeneration: number): Promise<void> {
  // Initialize state
  state = createInitialState();
  state.loadGeneration = loadGeneration;
  
  // Clear crash snapshot on new load
  clearCrashSnapshot();
  
  // Start timers
  startHeartbeat();
  startStalledCheck();
  
  // Stage: checking-webgpu
  enterStage('checking-webgpu', 'checking-webgpu');
  
  console.log('[phiLoader] Starting Phi-3.5 loading...');
  console.log('[phiLoader] Model:', MODEL_ID);
  
  // Check WebGPU availability
  if (!hasWebGPU()) {
    setError('WebGPU not available on this device');
    return;
  }
  
  // Configure Transformers.js for WebGPU
  env.useBrowserCache = true;
  env.allowLocalModels = false;
  
  // Get storage before loading
  state.storageBefore = await getStorageEstimate();
  console.log('[phiLoader] Storage before:', formatBytes(state.storageBefore.usage));
  notifyListeners();

  // Stage: loading-tokenizer
  enterStage('loading-tokenizer', 'downloading-tokenizer');
  
  try {
    tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      progress_callback: (progressInfo: any) => {
        if (isCurrentLoadAbandoned || currentLoadGeneration !== loadGeneration) {
          return;
        }
        
        updateProgress({
          name: progressInfo.name,
          status: progressInfo.status,
          progress: progressInfo.progress,
          loaded: progressInfo.loaded,
          total: progressInfo.total,
          timestamp: Date.now(),
        });
      },
    });
    enterStage('loading-tokenizer', 'tokenizer-ready');
    console.log('[phiLoader] Tokenizer loaded');
  } catch (err) {
    if (isCurrentLoadAbandoned) {
      console.log('[phiLoader] Tokenizer load abandoned');
      return;
    }
    setError(`Failed to load tokenizer: ${err}`);
    return;
  }

  // Stage: loading-model
  enterStage('loading-model', 'downloading-model-files');
  
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    model = await AutoModelForCausalLM.from_pretrained(MODEL_ID, {
      device: 'webgpu',
      dtype: 'q4f16',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      progress_callback: (progressInfo: any) => {
        if (isCurrentLoadAbandoned || currentLoadGeneration !== loadGeneration) {
          console.log('[phiLoader] Ignoring progress - load abandoned');
          return;
        }
        
        updateProgress({
          name: progressInfo.name,
          status: progressInfo.status,
          progress: progressInfo.progress,
          loaded: progressInfo.loaded,
          total: progressInfo.total,
          index: progressInfo.index,
          numThreads: progressInfo.numThreads,
          timestamp: Date.now(),
        });
      },
    }) as any;
    
    // Check if load was abandoned
    if (isCurrentLoadAbandoned || currentLoadGeneration !== loadGeneration) {
      console.log('[phiLoader] Model load completed but was abandoned');
      return;
    }
    
    enterStage('loading-model', 'allocating-webgpu');
    console.log('[phiLoader] Model initialized on WebGPU');
  } catch (err) {
    if (isCurrentLoadAbandoned) {
      console.log('[phiLoader] Model load abandoned');
      return;
    }
    setError(`Failed to load model: ${err}`);
    return;
  }
  
  enterStage('loading-model', 'ready');
  
  // Get storage after loading
  state.storageAfter = await getStorageEstimate();
  console.log('[phiLoader] Storage after:', formatBytes(state.storageAfter.usage));

  // Stage: ready
  enterStage('ready', 'ready');
  
  // Clear crash snapshot on success
  clearCrashSnapshot();
  
  generateBugReport();
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
    generateBugReport();
    notifyListeners();
  }
}
