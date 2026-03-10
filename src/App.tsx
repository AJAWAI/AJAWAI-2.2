import { useState, useEffect, useCallback } from 'react';
import { Chat } from './ui/Chat';
import { DebugPanel } from './ui/DebugPanel';
import { loadPhi, subscribe, LoadingStage, LoaderDiagnostics } from './ai/phiLoader';
import { generateResponse } from './ai/generate';

// Mint/pale green theme palette
const colors = {
  background: '#E6F0E8',
  panel: '#D8E6DA',
  primaryText: '#1F4D3A',
  accent: '#7FBF9A',
  white: '#FFFFFF',
  border: '#B8D4BC',
  muted: '#5A7D6A',
};

type AppState = {
  loadingStage: LoadingStage;
  modelLoaded: boolean;
  error: string | null;
  isGenerating: boolean;
  showDebug: boolean;
};

export function App() {
  const [state, setState] = useState<AppState>({
    loadingStage: 'idle',
    modelLoaded: false,
    error: null,
    isGenerating: false,
    showDebug: false,
  });

  // Subscribe to loader state updates for live progress
  useEffect(() => {
    const unsubscribe = subscribe((loaderState: LoaderDiagnostics) => {
      setState((prev) => ({
        ...prev,
        loadingStage: loaderState.stage,
        modelLoaded: loaderState.stage === 'ready',
        error: loaderState.error,
      }));
    });
    return unsubscribe;
  }, []);

  // Load model on mount
  useEffect(() => {
    loadPhi();
  }, []);

  const toggleDebug = useCallback(() => {
    setState((prev) => ({ ...prev, showDebug: !prev.showDebug }));
  }, []);

  const handleSendMessage = useCallback(async (message: string) => {
    setState((prev) => ({ ...prev, isGenerating: true }));

    try {
      await generateResponse(
        message,
        {
          max_new_tokens: 80,
          temperature: 0.7,
          top_p: 0.9,
        },
        (chunk) => {
          window.dispatchEvent(new CustomEvent('ajawai-stream', { detail: chunk }));
        }
      );
    } catch (err) {
      console.error('Generation error:', err);
      window.dispatchEvent(new CustomEvent('ajawai-stream', { detail: '\n[Error: ' + (err instanceof Error ? err.message : 'Unknown') + ']' }));
    } finally {
      setState((prev) => ({ ...prev, isGenerating: false }));
    }
  }, []);

  const { loadingStage, modelLoaded, error, isGenerating, showDebug } = state;

  // Get loading message based on stage
  const getLoadingMessage = () => {
    switch (loadingStage) {
      case 'checking-webgpu': return 'Checking WebGPU...';
      case 'loading-tokenizer': return 'Loading tokenizer...';
      case 'loading-model': return 'Loading model (~350MB)...';
      case 'ready': return 'Ready';
      case 'error': return error || 'Error loading model';
      default: return 'Initializing...';
    }
  };

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <div style={styles.headerContent}>
          <div>
            <h1 style={styles.title}>AJAWAI 2.2</h1>
            <p style={styles.subtitle}>Phi-3.5 Mini Instruct • WebGPU</p>
          </div>
          <button 
            onClick={toggleDebug}
            style={styles.bugButton}
            title="Toggle debug panel"
            aria-label="Toggle debug panel"
          >
            <BugIcon />
          </button>
        </div>
      </header>

      <main style={styles.main}>
        {!modelLoaded && loadingStage !== 'error' && (
          <div style={styles.loadingBanner}>
            <div style={styles.loadingSpinner} />
            <span style={styles.loadingText}>{getLoadingMessage()}</span>
          </div>
        )}

        {loadingStage === 'error' && (
          <div style={styles.errorBanner}>
            <span style={styles.errorText}>{error}</span>
          </div>
        )}

        <Chat
          onSendMessage={handleSendMessage}
          isModelLoaded={modelLoaded}
          isGenerating={isGenerating}
          colors={colors}
        />

        {showDebug && (
          <DebugPanel
            colors={colors}
          />
        )}
      </main>

      <style>{`
        @keyframes blink {
          0%, 50% { opacity: 1; }
          51%, 100% { opacity: 0; }
        }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

// Simple bug icon SVG
function BugIcon() {
  return (
    <svg 
      width="24" 
      height="24" 
      viewBox="0 0 24 24" 
      fill="none" 
      stroke={colors.primaryText} 
      strokeWidth="2" 
      strokeLinecap="round" 
      strokeLinejoin="round"
    >
      <rect x="8" y="6" width="8" height="12" rx="4" />
      <path d="M5 8V6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v2" />
      <line x1="12" y1="12" x2="12" y2="18" />
      <circle cx="9" cy="14" r="1" fill={colors.primaryText} />
      <circle cx="15" cy="14" r="1" fill={colors.primaryText} />
    </svg>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    minHeight: '100vh',
    background: colors.background,
  },
  header: {
    padding: '16px 20px',
    background: colors.panel,
    borderBottom: `1px solid ${colors.border}`,
  },
  headerContent: {
    maxWidth: '600px',
    margin: '0 auto',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: {
    fontSize: '24px',
    fontWeight: '700',
    color: colors.primaryText,
    marginBottom: '2px',
    margin: 0,
  },
  subtitle: {
    fontSize: '12px',
    color: colors.muted,
    letterSpacing: '0.5px',
    margin: 0,
  },
  bugButton: {
    background: colors.accent,
    border: 'none',
    borderRadius: '8px',
    padding: '8px',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    opacity: 0.8,
    transition: 'opacity 0.2s',
  },
  main: {
    maxWidth: '600px',
    margin: '0 auto',
    padding: '16px',
  },
  loadingBanner: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '16px',
    background: colors.panel,
    borderRadius: '12px',
    marginBottom: '16px',
    border: `1px solid ${colors.border}`,
  },
  loadingSpinner: {
    width: '20px',
    height: '20px',
    border: `2px solid ${colors.border}`,
    borderTopColor: colors.accent,
    borderRadius: '50%',
    animation: 'spin 1s linear infinite',
  },
  loadingText: {
    color: colors.primaryText,
    fontSize: '14px',
    fontWeight: '500',
  },
  errorBanner: {
    padding: '16px',
    background: '#F8E8E8',
    borderRadius: '12px',
    marginBottom: '16px',
    border: '1px solid #E8B8B8',
  },
  errorText: {
    color: '#8B4049',
    fontSize: '14px',
  },
};
