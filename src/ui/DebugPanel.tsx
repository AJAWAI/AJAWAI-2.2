import { useEffect, useState, useCallback } from 'react';
import { LoaderDiagnostics, subscribe, getStatus } from '../ai/phiLoader';

interface DebugPanelProps {
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

export function DebugPanel({ colors }: DebugPanelProps) {
  const [diagnostics, setDiagnostics] = useState<LoaderDiagnostics | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // Get initial state
    setDiagnostics(getStatus());
    
    // Subscribe to updates
    const unsubscribe = subscribe((state) => {
      setDiagnostics(state);
    });
    
    return unsubscribe;
  }, []);

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const formatDuration = (ms: number): string => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    if (minutes > 0) {
      return `${minutes}m ${remainingSeconds}s`;
    }
    return `${seconds}s`;
  };

  const copyBugReport = useCallback(() => {
    if (diagnostics?.bugReport) {
      navigator.clipboard.writeText(diagnostics.bugReport);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [diagnostics?.bugReport]);

  if (!diagnostics) return null;

  const getStatusColor = (): string => {
    if (diagnostics.stage === 'error' || diagnostics.stage === 'timeout') return '#D32F2F';
    if (diagnostics.stage === 'ready') return colors.accent;
    if (diagnostics.isStalled) return '#F57C00';
    return '#1976D2';
  };

  const getStatusText = (): string => {
    if (diagnostics.stage === 'timeout') return 'TIMEOUT';
    if (diagnostics.isStalled) return 'STALLED';
    return diagnostics.stage.toUpperCase();
  };

  return (
    <div style={{ 
      ...styles.container, 
      background: colors.panel, 
      borderColor: colors.border 
    }}>
      <div style={{ ...styles.header, borderColor: colors.border }}>
        <span style={{ ...styles.title, color: colors.primaryText }}>Diagnostics</span>
        <span style={{ 
          ...styles.statusBadge, 
          background: getStatusColor(),
          color: colors.white
        }}>
          {getStatusText()}
        </span>
      </div>

      <div style={styles.content}>
        {/* Progress Section */}
        <div style={styles.section}>
          <div style={styles.sectionTitle}>Progress</div>
          <div style={styles.progressBar}>
            <div style={{
              ...styles.progressFill,
              width: `${diagnostics.combinedProgress}%`,
              background: colors.accent,
            }} />
          </div>
          <div style={styles.progressText}>
            {diagnostics.combinedProgress}% complete
          </div>
          
          <div style={styles.progressDetails}>
            <div style={styles.progressRow}>
              <span style={{ color: colors.muted }}>Tokenizer:</span>
              <span style={{ color: colors.primaryText }}>
                {diagnostics.tokenizerDownloadProgress}%
              </span>
            </div>
            <div style={styles.progressRow}>
              <span style={{ color: colors.muted }}>Model:</span>
              <span style={{ color: colors.primaryText }}>
                {diagnostics.modelDownloadProgress}%
              </span>
            </div>
          </div>
        </div>

        {/* Stage Info */}
        <div style={styles.section}>
          <div style={styles.sectionTitle}>Current State</div>
          <div style={styles.infoGrid}>
            <div style={styles.infoItem}>
              <span style={{ ...styles.infoLabel, color: colors.muted }}>Stage</span>
              <span style={{ ...styles.infoValue, color: colors.primaryText }}>
                {diagnostics.stage}
              </span>
            </div>
            <div style={styles.infoItem}>
              <span style={{ ...styles.infoLabel, color: colors.muted }}>Substage</span>
              <span style={{ ...styles.infoValue, color: colors.primaryText }}>
                {diagnostics.substage}
              </span>
            </div>
            <div style={styles.infoItem}>
              <span style={{ ...styles.infoLabel, color: colors.muted }}>Elapsed</span>
              <span style={{ ...styles.infoValue, color: colors.primaryText }}>
                {formatDuration(diagnostics.elapsedMs)}
              </span>
            </div>
            <div style={styles.infoItem}>
              <span style={{ ...styles.infoLabel, color: colors.muted }}>Model Size</span>
              <span style={{ ...styles.infoValue, color: colors.primaryText }}>
                {diagnostics.estimatedModelSizeMB ? `~${diagnostics.estimatedModelSizeMB} MB` : 'Unknown'}
              </span>
            </div>
          </div>
        </div>

        {/* Storage */}
        <div style={styles.section}>
          <div style={styles.sectionTitle}>Storage</div>
          <div style={styles.infoGrid}>
            <div style={styles.infoItem}>
              <span style={{ ...styles.infoLabel, color: colors.muted }}>Before</span>
              <span style={{ ...styles.infoValue, color: colors.primaryText }}>
                {diagnostics.storageBefore 
                  ? `${formatBytes(diagnostics.storageBefore.usage)} / ${formatBytes(diagnostics.storageBefore.quota)}`
                  : 'N/A'}
              </span>
            </div>
            <div style={styles.infoItem}>
              <span style={{ ...styles.infoLabel, color: colors.muted }}>After</span>
              <span style={{ ...styles.infoValue, color: colors.primaryText }}>
                {diagnostics.storageAfter 
                  ? `${formatBytes(diagnostics.storageAfter.usage)} / ${formatBytes(diagnostics.storageAfter.quota)}`
                  : 'N/A'}
              </span>
            </div>
          </div>
        </div>

        {/* Stage Log */}
        {diagnostics.stageLog.length > 0 && (
          <div style={styles.section}>
            <div style={styles.sectionTitle}>Stage Log</div>
            <div style={styles.logContainer}>
              {diagnostics.stageLog.map((entry, i) => (
                <div key={i} style={styles.logEntry}>
                  <span style={{ color: colors.muted }}>{i + 1}.</span>{' '}
                  <span style={{ color: colors.primaryText }}>{entry.stage}</span>
                  {' → '}
                  <span style={{ color: colors.accent }}>{entry.substage}</span>
                  {entry.durationMs && (
                    <span style={{ color: colors.muted }}> ({entry.durationMs}ms)</span>
                  )}
                </div>
              ))}
              {diagnostics.currentStageEntry && (
                <div style={{ ...styles.logEntry, fontWeight: 'bold' }}>
                  <span style={{ color: colors.muted }}>{diagnostics.stageLog.length + 1}.</span>{' '}
                  <span style={{ color: colors.primaryText }}>{diagnostics.currentStageEntry.stage}</span>
                  {' → '}
                  <span style={{ color: colors.accent }}>{diagnostics.currentStageEntry.substage}</span>
                  {' (current)'}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Error Display */}
        {(diagnostics.error || diagnostics.stage === 'error' || diagnostics.stage === 'timeout') && (
          <div style={{ 
            ...styles.section,
            background: '#FFEBEE',
            border: '1px solid #FFCDD2',
            borderRadius: '8px',
            padding: '12px',
          }}>
            <div style={{ 
              ...styles.sectionTitle, 
              color: '#C62828',
              marginBottom: '8px'
            }}>
              Error
            </div>
            <pre style={{ 
              margin: 0, 
              fontSize: '11px', 
              color: '#C62828',
              fontFamily: 'monospace',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}>
              {diagnostics.error || 'Unknown error'}
            </pre>
          </div>
        )}

        {/* Bug Report Section */}
        <div style={styles.section}>
          <div style={styles.bugReportHeader}>
            <span style={styles.sectionTitle}>Full Bug Report</span>
            <button 
              onClick={copyBugReport}
              style={{
                ...styles.copyButton,
                background: copied ? colors.accent : 'transparent',
                color: copied ? colors.white : colors.accent,
                border: `1px solid ${colors.accent}`,
              }}
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <pre style={styles.bugReport}>
            {diagnostics.bugReport || 'No bug report available'}
          </pre>
        </div>
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
  statusBadge: {
    fontSize: '10px',
    fontWeight: '600',
    padding: '4px 8px',
    borderRadius: '4px',
    textTransform: 'uppercase',
  },
  content: {
    padding: '16px',
    maxHeight: '500px',
    overflowY: 'auto',
  },
  section: {
    marginBottom: '16px',
  },
  sectionTitle: {
    fontSize: '12px',
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
    marginBottom: '8px',
  },
  progressBar: {
    height: '8px',
    background: '#E0E0E0',
    borderRadius: '4px',
    overflow: 'hidden',
    marginBottom: '4px',
  },
  progressFill: {
    height: '100%',
    transition: 'width 0.3s ease',
  },
  progressText: {
    fontSize: '12px',
    textAlign: 'center',
    marginBottom: '8px',
  },
  progressDetails: {
    display: 'flex',
    gap: '16px',
    justifyContent: 'center',
  },
  progressRow: {
    fontSize: '11px',
    display: 'flex',
    gap: '4px',
  },
  infoGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, 1fr)',
    gap: '8px',
  },
  infoItem: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  infoLabel: {
    fontSize: '10px',
    textTransform: 'uppercase',
  },
  infoValue: {
    fontSize: '12px',
    fontFamily: 'monospace',
  },
  logContainer: {
    fontSize: '11px',
    fontFamily: 'monospace',
    maxHeight: '150px',
    overflowY: 'auto',
  },
  logEntry: {
    padding: '2px 0',
    display: 'flex',
    gap: '4px',
  },
  bugReportHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '8px',
  },
  copyButton: {
    fontSize: '11px',
    padding: '4px 8px',
    borderRadius: '4px',
    cursor: 'pointer',
    transition: 'all 0.2s',
  },
  bugReport: {
    fontSize: '10px',
    fontFamily: 'monospace',
    background: '#F5F5F5',
    padding: '12px',
    borderRadius: '8px',
    overflow: 'auto',
    maxHeight: '200px',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    margin: 0,
  },
};
