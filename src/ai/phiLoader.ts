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
  | 'fetching-model-manifest'
  | 'downloading-model-files'
  | 'reading-cache'
  | 'preparing-onnx-session'
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
  
  // Model phase tracking
  modelPhaseStartedAt: number | null;
  modelPhaseHasProgress: boolean;
  modelPhaseLastEvent: string | null;
  
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

// Estimated sizes based on model config
const ESTIMATED_TOKENIZER_SIZE_MB = 0.05; // ~50KB
const ESTIMATED_MODEL_SIZE_MB = 385; // ~385MB for quantized Phi-3.5 Mini

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
    estimatedModelSizeMB: ESTIMATED_MODEL_SIZE_MB,
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
    stageLog: [],
    currentStageEntry: null,
    generateReached: false,
    bugReport: '',
  };
}

function notifyListeners(): void {
  const snapshot = getStatus();
  listeners.forEach(listener => listener(snapshot));
}

function updateProgress(event: ProgressEvent): void {
  // Determine substage based on progress event
  const stage = event.stage || '';
  const status = event.status || '';
  const name = event.name || '';
  
  // Update substage based on event
  let newSubstage: LoadingSubstage = state.substage;
  
  if (stage === 'init' || name === 'init') {
    newSubstage = 'fetching-model-manifest';
  } else if (status === 'downloading' || stage === 'download') {
    newSubstage = 'downloading-model-files';
  } else if (status === 'ready' && name === 'cache') {
    newSubstage = 'reading-cache';
  } else if (stage === 'onnx' || name === 'session') {
    newSubstage = 'preparing-onnx-session';
  } else if (status === 'init' && stage === 'webgpu') {
    newSubstage = 'initializing-webgpu';
  }
  
  if (newSubstage !== state.substage) {
    enterStage(state.stage, newSubstage);
  }
  
  // Update percentages
  if (event.progress !== undefined) {
    // This is tokenizer progress
    if (state.stage === 'loading-tokenizer') {
      state.tokenizerDownloadProgress = Math.round(event.progress * 100);
    } else if (state.stage === 'loading-model') {
      state.modelDownloadProgress = Math.round(event.progress * 100);
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
  
  console.log('[phiLoader] Progress event:', JSON.stringify(event).substring(0, 200));
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

function setTimeout(): void {
  state.timedOut = true;
  state.stage = 'timeout';
  state.substage = 'timeout';
  state.error = `Loading timed out after ${TIMEOUT_MS}ms`;
  state.loadGeneration = currentLoadGeneration; // Record which load timed out
  console.error(`[phiLoader] TIMEOUT: ${state.elapsedMs}ms`);
  generateBugReport();
  notifyListeners();
}

function setAbandoned(): void {
  state.abandonedLoad = true;
  state.substage = 'abandoned';
  console.warn('[phiLoader] Load marked as abandoned');
  generateBugReport();
  notifyListeners();
}

function setError(error: string): void {
  state.stage = 'error';
  state.substage = 'error';
  state.error = error;
  state.lastProgressTimestamp = Date.now();
  generateBugReport();
  notifyListeners();
}

function generateBugReport(): void {
  const lines: string[] = [
    '=== AJAWAI 2.2 Deep Diagnostics Bug Report ===',
    `Generated: ${new Date().toISOString()}`,
    `Load Generation: ${state.loadGeneration}`,
    '',
    '--- Configuration ---',
    `Model ID: ${MODEL_ID}`,
    `Package: @huggingface/transformers`,
    `Timeout: ${TIMEOUT_MS}ms`,
    `Stall Threshold: ${STALL_THRESHOLD_MS}ms`,
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
      ? JSON.stringify(state.lastProgressPayload, null, 2).substring(0, 500)
      : 'None',
    '',
    '--- Storage ---',
    `Storage Before: ${formatBytes(state.storageBefore?.usage || 0)} / ${formatBytes(state.storageBefore?.quota || 0)}`,
    `Storage After: ${state.storageAfter ? `${formatBytes(state.storageAfter.usage)} / ${formatBytes(state.storageAfter.quota)}` : 'N/A (load did not complete)'}`,
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
        generateBugReport();
        notifyListeners();
      }
    }
    
    // Check for timeout
    if (state.startedAt && state.stage !== 'ready' && state.stage !== 'error' && state.stage !== 'timeout') {
      const elapsed = now - state.startedAt;
      if (elapsed > TIMEOUT_MS) {
        setTimeout();
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
  
  console.log(`[phiLoader] Starting load generation ${thisLoadGeneration}`);
  
  // Single-flight: block duplicates
  if (loadingPromise && currentLoadGeneration === thisLoadGeneration) {
    return loadingPromise;
  }

  // Reset state for new load (but preserve some diagnostics)
  state = createInitialState();
  state.loadGeneration = thisLoadGeneration;
  
  // If previous load was abandoned, don't start new one immediately
  if (state.stage === 'timeout' || state.abandonedLoad) {
    console.log('[phiLoader] Previous load was abandoned, starting fresh');
  }

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
          console.log('[phiLoader] Ignoring progress callback - load abandoned');
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
  enterStage('loading-model', 'fetching-model-manifest');
  
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    model = await AutoModelForCausalLM.from_pretrained(MODEL_ID, {
      device: 'webgpu',
      dtype: 'q4f16',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      progress_callback: (progressInfo: any) => {
        // Check if this load was abandoned
        if (isCurrentLoadAbandoned || currentLoadGeneration !== loadGeneration) {
          console.log('[phiLoader] Ignoring model progress callback - load abandoned');
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
      generateBugReport();
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
