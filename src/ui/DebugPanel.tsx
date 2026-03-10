import { useEffect, useState } from 'react';
import { LoadingStage, getStatus, subscribe, PhiLoaderState } from '../ai/phiLoader';

interface DebugPanelProps {
  loadingStage: LoadingStage;
  modelLoaded: boolean;
  error: string | null;
  colors: {
    background: string;
    panel: string;
    primaryText: string;
    accent: string;
    white: string;
    border: string;
    muted: string;
  };
}

export function DebugPanel({ loadingStage, error, colors }: DebugPanelProps) {
  const [webGpuAvailable, setWebGpuAvailable] = useState<boolean | null>(null);
  const [storageInfo, setStorageInfo] = useState<{ usage: number; quota: number; usageAfter?: number; quotaAfter?: number } | null>(null);

  useEffect(() => {
    // Check WebGPU availability
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gpu = (navigator as any).gpu;
    setWebGpuAvailable(!!gpu && typeof gpu.requestAdapter === 'function');

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

    // Subscribe to loader state for storage updates
    const unsubscribe = subscribe((state: PhiLoaderState) => {
      if (state.storageBefore || state.storageAfter) {
        setStorageInfo({
          usage: state.storageBefore?.usage || 0,
          quota: state.storageBefore?.quota || 0,
          usageAfter: state.storageAfter?.usage,
          quotaAfter: state.storageAfter?.quota,
        });
      }
    });
    
    // Also get current status
    const status = getStatus();
    if (status.storageBefore || status.storageAfter) {
      setStorageInfo({
        usage: status.storageBefore?.usage || 0,
        quota: status.storageBefore?.quota || 0,
        usageAfter: status.storageAfter?.usage,
        quotaAfter: status.storageAfter?.quota,
      });
    }

    return unsubscribe;
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

  const getStageColor = (): string => {
    if (loadingStage === 'error') return '#D32F2F';
    if (loadingStage === 'ready') return colors.accent;
    return '#F57C00';
  };

  return (
    <div style={{ 
      ...styles.container, 
      background: colors.panel, 
      borderColor: colors.border 
    }}>
      <div style={{ ...styles.header, borderColor: colors.border }}>
        <span style={{ ...styles.title, color: colors.primaryText }}>Developer Tools</span>
        <span style={{ ...styles.subtitle, color: colors.muted }}>Debug Panel</span>
      </div>

      <div style={styles.content}>
        <div style={styles.grid}>
          <div style={styles.metric}>
            <span style={{ ...styles.metricLabel, color: colors.muted }}>WebGPU</span>
            <span style={{ 
              ...styles.metricValue, 
              color: webGpuAvailable ? colors.accent : '#D32F2F' 
            }}>
              {webGpuAvailable === null ? 'Checking...' : webGpuAvailable ? 'Available' : 'Unavailable'}
            </span>
          </div>

          <div style={styles.metric}>
            <span style={{ ...styles.metricLabel, color: colors.muted }}>Model Status</span>
            <span style={{ ...styles.metricValue, color: getStageColor() }}>
              {getStageLabel(loadingStage)}
            </span>
          </div>

          <div style={styles.metric}>
            <span style={{ ...styles.metricLabel, color: colors.muted }}>Storage (Before)</span>
            <span style={{ ...styles.metricValue, color: colors.primaryText }}>
              {storageInfo ? `${formatBytes(storageInfo.usage)} / ${formatBytes(storageInfo.quota)}` : 'N/A'}
            </span>
          </div>

          {storageInfo?.usageAfter && (
            <div style={styles.metric}>
              <span style={{ ...styles.metricLabel, color: colors.muted }}>Storage (After)</span>
              <span style={{ ...styles.metricValue, color: colors.primaryText }}>
                {formatBytes(storageInfo.usageAfter)} / {formatBytes(storageInfo.quotaAfter || storageInfo.quota)}
              </span>
            </div>
          )}

          <div style={styles.metric}>
            <span style={{ ...styles.metricLabel, color: colors.muted }}>Model Size</span>
            <span style={{ ...styles.metricValue, color: colors.primaryText }}>~350MB</span>
          </div>
        </div>

        {error && (
          <div style={{ 
            ...styles.error, 
            background: '#FFEBEE', 
            borderColor: '#FFCDD2' 
          }}>
            <span style={{ ...styles.errorLabel, color: '#C62828' }}>Error:</span>
            <span style={{ ...styles.errorText, color: '#C62828' }}>{error}</span>
          </div>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    marginTop: '16px',
    borderRadius: '12px',
    border: '1px solid',
    overflow: 'hidden',
  },
  header: {
    padding: '12px 16px',
    borderBottom: '1px solid',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: {
    fontSize: '14px',
    fontWeight: '600',
  },
  subtitle: {
    fontSize: '11px',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
  },
  content: {
    padding: '16px',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, 1fr)',
    gap: '12px',
  },
  metric: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  metricLabel: {
    fontSize: '11px',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
  },
  metricValue: {
    fontSize: '13px',
    fontWeight: '500',
    fontFamily: 'monospace',
  },
  error: {
    marginTop: '16px',
    padding: '12px',
    borderRadius: '8px',
    border: '1px solid',
  },
  errorLabel: {
    fontSize: '12px',
    fontWeight: '600',
    display: 'block',
    marginBottom: '4px',
  },
  errorText: {
    fontSize: '12px',
    fontFamily: 'monospace',
  },
};
