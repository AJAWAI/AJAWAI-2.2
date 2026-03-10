import { useEffect, useState } from 'react';
import { LoadingStage } from '../ai/phiLoader';

interface DebugPanelProps {
  loadingStage: LoadingStage;
  modelLoaded: boolean;
  error: string | null;
}

export function DebugPanel({ loadingStage, modelLoaded, error }: DebugPanelProps) {
  const [webGpuAvailable, setWebGpuAvailable] = useState<boolean | null>(null);
  const [storageInfo, setStorageInfo] = useState<{ usage: number; quota: number } | null>(null);

  useEffect(() => {
    // Check WebGPU availability
    const gpu = (navigator as Navigator & { gpu?: unknown }).gpu;
    setWebGpuAvailable(!!gpu);

    // Get storage info
    navigator.storage
      .estimate()
      .then((estimate) => {
        setStorageInfo({
          usage: estimate.usage || 0,
          quota: estimate.quota || 0,
        });
      })
      .catch(() => {
        setStorageInfo(null);
      });
  }, []);

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const getStageLabel = (stage: LoadingStage): string => {
    const labels: Record<LoadingStage, string> = {
      idle: 'Idle',
      'checking-webgpu': 'Checking WebGPU...',
      'loading-tokenizer': 'Loading Tokenizer...',
      'loading-model': 'Loading Model...',
      ready: 'Ready',
      error: 'Error',
    };
    return labels[stage];
  };

  return (
    <div style={styles.container}>
      <h2 style={styles.title}>Debug Panel</h2>

      <div style={styles.section}>
        <div style={styles.row}>
          <span style={styles.label}>WebGPU:</span>
          <span style={{ ...styles.value, color: webGpuAvailable ? '#4ade80' : '#f87171' }}>
            {webGpuAvailable === null ? 'Checking...' : webGpuAvailable ? 'Available' : 'Not Available'}
          </span>
        </div>

        <div style={styles.row}>
          <span style={styles.label}>Model:</span>
          <span style={{ ...styles.value, color: modelLoaded ? '#4ade80' : '#fbbf24' }}>
            {getStageLabel(loadingStage)}
          </span>
        </div>

        <div style={styles.row}>
          <span style={styles.label}>Storage Used:</span>
          <span style={styles.value}>
            {storageInfo ? `${formatBytes(storageInfo.usage)} / ${formatBytes(storageInfo.quota)}` : 'N/A'}
          </span>
        </div>

        <div style={styles.row}>
          <span style={styles.label}>Memory Estimate:</span>
          <span style={styles.value}>~350MB (model only)</span>
        </div>

        {error && (
          <div style={styles.error}>
            <span style={styles.errorLabel}>Error:</span>
            <span style={styles.errorText}>{error}</span>
          </div>
        )}
      </div>

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
    background: '#1a1a1a',
    borderRadius: '8px',
    padding: '16px',
    marginTop: '16px',
  },
  title: {
    fontSize: '14px',
    fontWeight: '600',
    color: '#888',
    marginBottom: '12px',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  row: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    fontSize: '13px',
  },
  label: {
    color: '#888',
  },
  value: {
    color: '#e0e0e0',
    fontFamily: 'monospace',
  },
  error: {
    marginTop: '8px',
    padding: '12px',
    background: '#2a1a1a',
    borderRadius: '6px',
    border: '1px solid #4a2020',
  },
  errorLabel: {
    color: '#f87171',
    fontSize: '12px',
    fontWeight: '600',
    display: 'block',
    marginBottom: '4px',
  },
  errorText: {
    color: '#fca5a5',
    fontSize: '12px',
    fontFamily: 'monospace',
  },
};
