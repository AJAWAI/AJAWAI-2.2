import { AutoTokenizer, AutoModelForCausalLM, env } from '@xenova/transformers';

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
  | 'error';

export interface StorageInfo {
  usage: number;
  quota: number;
}

export interface PhiLoaderState {
  stage: LoadingStage;
  error: string | null;
  storageBefore: StorageInfo | null;
  storageAfter: StorageInfo | null;
}

type StateListener = (state: PhiLoaderState) => void;

const MODEL_ID = 'onnx-community/Phi-3.5-mini-instruct-onnx-web';

let tokenizer: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>> | null = null;
let model: Awaited<ReturnType<typeof AutoModelForCausalLM.from_pretrained>> | null = null;
let state: PhiLoaderState = {
  stage: 'idle',
  error: null,
  storageBefore: null,
  storageAfter: null,
};
let loadingPromise: Promise<void> | null = null;
const listeners: Set<StateListener> = new Set();

function notifyListeners(): void {
  const snapshot = getStatus();
  listeners.forEach(listener => listener(snapshot));
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

export function getStatus(): PhiLoaderState {
  return { ...state };
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
  }
}

async function _loadPhi(): Promise<void> {
  // Stage: checking-webgpu
  state.stage = 'checking-webgpu';
  state.error = null;
  console.log('[phiLoader] Stage: checking-webgpu');
  notifyListeners();

  // Check WebGPU availability
  const nav = navigator as { gpu?: unknown };
  if (!hasWebGPU()) {
    state.stage = 'error';
    state.error = 'WebGPU not available on this device';
    console.error('[phiLoader] WebGPU not available');
    notifyListeners();
    return;
  }

  // Call requestAdapter directly on navigator.gpu to avoid illegal invocation
  const gpu = nav.gpu as { requestAdapter: () => Promise<unknown> };
  const adapter = await gpu.requestAdapter();
  if (!adapter) {
    state.stage = 'error';
    state.error = 'WebGPU not available on this device';
    console.error('[phiLoader] Could not get GPU adapter');
    notifyListeners();
    return;
  }

  console.log('[phiLoader] WebGPU available, adapter acquired');

  // Configure Transformers.js for WebGPU
  // Use browser cache and disable local models
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  
  // Transformers.js auto-detects WebGPU when available, no manual injection needed

  // Get storage before loading
  state.storageBefore = await getStorageEstimate();
  console.log('[phiLoader] Storage before load:', state.storageBefore);
  notifyListeners();

  // Stage: loading-tokenizer
  state.stage = 'loading-tokenizer';
  console.log('[phiLoader] Stage: loading-tokenizer');
  notifyListeners();

  try {
    tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID, {
      progress_callback: (progress: number) => {
        console.log('[phiLoader] Tokenizer download:', Math.round(progress * 100) + '%');
      },
    });
    console.log('[phiLoader] Tokenizer loaded');
  } catch (err) {
    state.stage = 'error';
    state.error = `Failed to load tokenizer: ${err}`;
    console.error('[phiLoader] Tokenizer error:', err);
    notifyListeners();
    return;
  }

  // Stage: loading-model
  state.stage = 'loading-model';
  console.log('[phiLoader] Stage: loading-model');
  notifyListeners();

  try {
    // Load model with q4f16 quantization
    // The model ID already specifies the quantized webgpu version
    model = await AutoModelForCausalLM.from_pretrained(MODEL_ID, {
      progress_callback: (progress: number) => {
        console.log('[phiLoader] Model download:', Math.round(progress * 100) + '%');
      },
    });
    console.log('[phiLoader] Model loaded on WebGPU');
  } catch (err) {
    state.stage = 'error';
    state.error = `Failed to load model: ${err}`;
    console.error('[phiLoader] Model error:', err);
    notifyListeners();
    return;
  }

  // Get storage after loading
  state.storageAfter = await getStorageEstimate();
  console.log('[phiLoader] Storage after load:', state.storageAfter);

  // Stage: ready
  state.stage = 'ready';
  console.log('[phiLoader] Stage: ready');
  notifyListeners();
}

export function getModel() {
  return model;
}

export function getTokenizer() {
  return tokenizer;
}
