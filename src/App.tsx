import { useState, useEffect, useCallback } from 'react';
import { Chat } from './ui/Chat';
import { DebugPanel } from './ui/DebugPanel';
import { loadPhi, getStatus, LoadingStage } from './ai/phiLoader';
import { generateResponse } from './ai/generate';

type AppState = {
  loadingStage: LoadingStage;
  modelLoaded: boolean;
  error: string | null;
  isGenerating: boolean;
};

export function App() {
  const [state, setState] = useState<AppState>({
    loadingStage: 'idle',
    modelLoaded: false,
    error: null,
    isGenerating: false,
  });

  // Load model on mount
  useEffect(() => {
    const initModel = async () => {
      try {
        await loadPhi();
        const status = getStatus();
        setState((prev) => ({
          ...prev,
          loadingStage: status.stage,
          modelLoaded: status.stage === 'ready',
          error: status.error,
        }));
      } catch (err) {
        setState((prev) => ({
          ...prev,
          loadingStage: 'error',
          error: err instanceof Error ? err.message : 'Unknown error',
        }));
      }
    };

    initModel();
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
          // Dispatch streaming chunk event
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

  const { loadingStage, modelLoaded, error, isGenerating } = state;

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <h1 style={styles.title}>AJAWAI 2.2</h1>
        <p style={styles.subtitle}>Phi-3.5 Mini Instruct • WebGPU</p>
      </header>

      <main style={styles.main}>
        <Chat
          onSendMessage={handleSendMessage}
          isModelLoaded={modelLoaded}
          isGenerating={isGenerating}
        />

        <DebugPanel
          loadingStage={loadingStage}
          modelLoaded={modelLoaded}
          error={error}
        />
      </main>

      <style>{`
        @keyframes blink {
          0%, 50% { opacity: 1; }
          51%, 100% { opacity: 0; }
        }
      `}</style>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    minHeight: '100vh',
    background: '#0f0f0f',
  },
  header: {
    padding: '20px 16px',
    textAlign: 'center',
    borderBottom: '1px solid #222',
  },
  title: {
    fontSize: '24px',
    fontWeight: '700',
    color: '#fff',
    marginBottom: '4px',
  },
  subtitle: {
    fontSize: '12px',
    color: '#666',
    letterSpacing: '0.5px',
  },
  main: {
    maxWidth: '600px',
    margin: '0 auto',
    padding: '16px',
  },
};
