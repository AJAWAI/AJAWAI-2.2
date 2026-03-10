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
  | 'downloading-model'
  | 'initializing-model'
  | 'model-loaded'
  | 'ready'
  | 'timeout'
  | 'error';

export interface StorageInfo {
  usage: number;
  quota: number;
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
  
  // Progress tracking
  tokenizerDownloadProgress: number;  // 0-100
  modelDownloadProgress: number;      // 0-100
  combinedProgress: number;           // 0-100
  
  // Size estimation
  estimatedModelSizeMB: number | null;
  estimatedTokenizerSizeMB: number | null;
  
  // Storage
  storageBefore: StorageInfo | null;
  storageAfter: StorageInfo | null;
  
  // Timing
  startedAt: number | null;
  elapsedMs: number;
  lastHeartbeatAt: number | null;
  lastProgressAt: number | null;
  
  // Stage tracking
  stageLog: StageEntry[];
  currentStageEntry: StageEntry | null;
  
  // Status flags
  isStalled: boolean;
  isTimeout: boolean;
  hasProgressed: boolean;
  generateReached: boolean;
  
  // Bug report
  bugReport: string;
}

type StateListener = (state: LoaderDiagnostics) => void;

// Model configuration
const MODEL_ID = 'onnx-community/Phi-3.5-mini-instruct-onnx-web';
const TIMEOUT_MS = 180000; // 3 minutes timeout
const STALL_THRESHOLD_MS = 60000; // 1 minute without progress = stalled

// Estimated sizes based on model config
const ESTIMATED_TOKENIZER_SIZE_MB = 0.05; // ~50KB
const ESTIMATED_MODEL_SIZE_MB = 385; // ~385MB for quantized Phi-3.5 Mini

let tokenizer: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>> | null = null;
let model: Awaited<ReturnType<typeof AutoModelForCausalLM.from_pretrained>> | null = null;

let state: LoaderDiagnostics = {
  stage: 'idle',
  substage: 'idle',
  error: null,
  tokenizerDownloadProgress: 0,
  modelDownloadProgress: 0,
  combinedProgress: 0,
  estimatedModelSizeMB: ESTIMATED_MODEL_SIZE_MB,
  estimatedTokenizerSizeMB: ESTIMATED_TOKENIZER_SIZE_MB,
  storageBefore: null,
  storageAfter: null,
  startedAt: null,
  elapsedMs: 0,
  lastHeartbeatAt: null,
  lastProgressAt: null,
  stageLog: [],
  currentStageEntry: null,
  isStalled: false,
  isTimeout: false,
  hasProgressed: false,
  generateReached: false,
  bugReport: '',
};

let loadingPromise: Promise<void> | null = null;
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let stalledCheckInterval: ReturnType<typeof setInterval> | null = null;
const listeners: Set<StateListener> = new Set();

function notifyListeners(): void {
  const snapshot = getStatus();
  listeners.forEach(listener => listener(snapshot));
}

function updateProgress(
  tokenizerProgress?: number,
  modelProgress?: number
): void {
  if (tokenizerProgress !== undefined) {
    state.tokenizerDownloadProgress = Math.round(tokenizerProgress * 100);
  }
  if (modelProgress !== undefined) {
    state.modelDownloadProgress = Math.round(modelProgress * 100);
  }
  
  // Combined: tokenizer is ~1% of total, model is ~99%
  const combined = (state.tokenizerDownloadProgress * 0.01) + (state.modelDownloadProgress * 0.99);
  state.combinedProgress = Math.min(100, Math.round(combined));
  
  state.lastProgressAt = Date.now();
  state.hasProgressed = true;
  state.isStalled = false;
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
  
  console.log(`[phiLoader] Stage: ${stage} → Substage: ${substage}`);
  notifyListeners();
}

function setError(error: string): void {
  state.stage = 'error';
  state.substage = 'error';
  state.error = error;
  state.lastHeartbeatAt = Date.now();
  generateBugReport();
  notifyListeners();
}

function generateBugReport(): void {
  const lines: string[] = [
    '=== AJAWAI 2.2 Diagnostics Bug Report ===',
    `Generated: ${new Date().toISOString()}`,
    '',
    '--- Configuration ---',
    `Model ID: ${MODEL_ID}`,
    `Package: @huggingface/transformers`,
    `Timeout: ${TIMEOUT_MS}ms`,
    `Stall Threshold: ${STALL_THRESHOLD_MS}ms`,
    '',
    '--- Environment ---',
    `WebGPU Available: ${hasWebGPU()}`,
    `User Agent: ${navigator.userAgent.substring(0, 100)}...`,
    '',
    '--- Current State ---',
    `Stage: ${state.stage}`,
    `Substage: ${state.substage}`,
    `Elapsed: ${state.elapsedMs}ms`,
    `Is Stalled: ${state.isStalled}`,
    `Is Timeout: ${state.isTimeout}`,
    `Has Progressed: ${state.hasProgressed}`,
    '',
    '--- Progress ---',
    `Tokenizer: ${state.tokenizerDownloadProgress}%`,
    `Model: ${state.modelDownloadProgress}%`,
    `Combined: ${state.combinedProgress}%`,
    '',
    '--- Storage ---',
    `Storage Before: ${formatBytes(state.storageBefore?.usage || 0)} / ${formatBytes(state.storageBefore?.quota || 0)}`,
    `Storage After: ${formatBytes(state.storageAfter?.usage || 0)} / ${formatBytes(state.storageAfter?.quota || 0)}`,
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
    notifyListeners();
  }, 1000);
}

function startStalledCheck(): void {
  stalledCheckInterval = setInterval(() => {
    const now = Date.now();
    const lastProgress = state.lastProgressAt || state.startedAt;
    
    if (lastProgress && state.stage !== 'ready' && state.stage !== 'error') {
      const timeSinceProgress = now - lastProgress;
      
      if (timeSinceProgress > STALL_THRESHOLD_MS) {
        state.isStalled = true;
        console.warn(`[phiLoader] STALLED: No progress for ${timeSinceProgress}ms`);
        generateBugReport();
        notifyListeners();
      }
    }
    
    // Check for timeout
    if (state.startedAt && state.stage !== 'ready' && state.stage !== 'error') {
      const elapsed = now - state.startedAt;
      if (elapsed > TIMEOUT_MS) {
        state.isTimeout = true;
        state.stage = 'timeout';
        state.substage = 'timeout';
        state.error = `Loading timed out after ${TIMEOUT_MS}ms`;
        console.error(`[phiLoader] TIMEOUT: ${elapsed}ms`);
        generateBugReport();
        notifyListeners();
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
  // Single-flight: block duplicates
  if (loadingPromise) {
    return loadingPromise;
  }

  if (state.stage === 'ready' && model && tokenizer) {
    return;
  }

  loadingPromise = _loadPhi();
  
  try {
    await loadingPromise;
  } finally {
    loadingPromise = null;
    stopTimers();
  }
}

async function _loadPhi(): Promise<void> {
  // Initialize state
  state = {
    stage: 'idle',
    substage: 'idle',
    error: null,
    tokenizerDownloadProgress: 0,
    modelDownloadProgress: 0,
    combinedProgress: 0,
    estimatedModelSizeMB: ESTIMATED_MODEL_SIZE_MB,
    estimatedTokenizerSizeMB: ESTIMATED_TOKENIZER_SIZE_MB,
    storageBefore: null,
    storageAfter: null,
    startedAt: Date.now(),
    elapsedMs: 0,
    lastHeartbeatAt: null,
    lastProgressAt: null,
    stageLog: [],
    currentStageEntry: null,
    isStalled: false,
    isTimeout: false,
    hasProgressed: false,
    generateReached: false,
    bugReport: '',
  };
  
  // Start timers
  startHeartbeat();
  startStalledCheck();
  
  // Stage: checking-webgpu
  enterStage('checking-webgpu', 'checking-navigator');
  
  console.log('[phiLoader] Starting Phi-3.5 loading...');
  console.log('[phiLoader] Model:', MODEL_ID);
  console.log('[phiLoader] Package: @huggingface/transformers');
  
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
        if (progressInfo && typeof progressInfo.progress === 'number') {
          updateProgress(progressInfo.progress / 100, undefined);
          console.log('[phiLoader] Tokenizer download:', Math.round(progressInfo.progress) + '%');
        }
      },
    });
    updateProgress(1, 0);
    enterStage('loading-tokenizer', 'tokenizer-loaded');
    console.log('[phiLoader] Tokenizer loaded');
  } catch (err) {
    setError(`Failed to load tokenizer: ${err}`);
    return;
  }

  // Stage: loading-model
  enterStage('loading-model', 'downloading-model');
  
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    model = await AutoModelForCausalLM.from_pretrained(MODEL_ID, {
      device: 'webgpu',
      dtype: 'q4f16',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      progress_callback: (progressInfo: any) => {
        if (progressInfo && typeof progressInfo.progress === 'number') {
          updateProgress(undefined, progressInfo.progress / 100);
          console.log('[phiLoader] Model download:', Math.round(progressInfo.progress) + '%');
        }
      },
    }) as any;
    updateProgress(1, 1);
    enterStage('loading-model', 'initializing-model');
    console.log('[phiLoader] Model initialized on WebGPU');
  } catch (err) {
    setError(`Failed to load model: ${err}`);
    return;
  }
  
  enterStage('loading-model', 'model-loaded');
  
  // Get storage after loading
  state.storageAfter = await getStorageEstimate();
  console.log('[phiLoader] Storage after:', formatBytes(state.storageAfter.usage), '/', formatBytes(state.storageAfter.quota));
  
  // Calculate model size from storage delta
  if (state.storageBefore && state.storageAfter) {
    const deltaBytes = state.storageAfter.usage - state.storageBefore.usage;
    if (deltaBytes > 0) {
      state.estimatedModelSizeMB = Math.round(deltaBytes / (1024 * 1024) * 10) / 10;
      console.log('[phiLoader] Estimated model size:', state.estimatedModelSizeMB, 'MB');
    }
  }

  // Stage: ready
  enterStage('ready', 'ready');
  state.generateReached = false; // Will be set to true when generate is called
  generateBugReport();
  notifyListeners();
}

export function markGenerateReached(): void {
  state.generateReached = true;
  generateBugReport();
  notifyListeners();
}

export function getModel() {
  return model;
}

export function getTokenizer() {
  return tokenizer;
}
