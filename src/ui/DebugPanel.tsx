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
    setDiagnostics(getStatus());
    
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
    if (diagnostics.stage === 'timeout') return '#F57C00';
    if (diagnostics.stage === 'error') return '#D32F2F';
    if (diagnostics.stage === 'ready') return colors.accent;
    if (diagnostics.abandonedLoad) return '#9E9E9E';
    return '#1976D2';
  };

  const getStatusText = (): string => {
    if (diagnostics.abandonedLoad) return 'ABANDONED';
    if (diagnostics.stage === 'timeout') return 'TIMEOUT';
    if (diagnostics.stage === 'error') return 'ERROR';
    return diagnostics.stage.toUpperCase();
  };

  const showCrashWarning = diagnostics.lastCrashSnapshot && 
    (diagnostics.stage === 'idle' || diagnostics.stage === 'error' || diagnostics.stage === 'timeout');

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
        {/* Crash Recovery Notice */}
        {showCrashWarning && diagnostics.lastCrashSnapshot && (
          <div style={{ 
            ...styles.crashWarning,
            borderColor: '#D32F2F',
            background: '#FFEBEE',
          }}>
            <div style={{ ...styles.crashTitle, color: '#D32F2F' }}>
              ⚠️ Previous Crash Detected
            </div>
            <div style={styles.crashDetails}>
              <div>Last stage: {diagnostics.lastCrashSnapshot.stage} / {diagnostics.lastCrashSnapshot.substage}</div>
              <div>At: {formatDuration(diagnostics.lastCrashSnapshot.elapsedMs)}</div>
              <div>Last total: {diagnostics.lastCrashSnapshot.observedTotal 
                ? formatBytes(diagnostics.lastCrashSnapshot.observedTotal) 
                : 'Unknown'}</div>
            </div>
          </div>
        )}

        {/* Honest Size Accounting */}
        <div style={styles.section}>
          <div style={styles.sectionTitle}>Size Accounting</div>
          <div style={styles.sizeGrid}>
            <div style={styles.sizeItem}>
              <span style={{ ...styles.sizeLabel, color: colors.muted }}>Observed Transfer</span>
              <span style={{ 
                ...styles.sizeValue, 
                color: diagnostics.observedTotalBytes > 500 * 1024 * 1024 ? '#D32F2F' : colors.primaryText 
              }}>
                {diagnostics.observedTransferBytes > 0 
                  ? formatBytes(diagnostics.observedTransferBytes)
                  : 'No data'}
              </span>
            </div>
            <div style={styles.sizeItem}>
              <span style={{ ...styles.sizeLabel, color: colors.muted }}>Observed Total</span>
              <span style={{ 
                ...styles.sizeValue, 
                color: !diagnostics.totalsConsistent ? '#F57C00' : colors.primaryText 
              }}>
                {diagnostics.observedTotalBytes > 0 
                  ? formatBytes(diagnostics.observedTotalBytes)
                  : 'No data'}
              </span>
            </div>
          </div>
          {!diagnostics.totalsConsistent && (
            <div style={styles.warning}>
              ⚠️ WARNING: Multiple totals seen in progress events - data may be inconsistent
            </div>
          )}
        </div>

        {/* State Flags */}
        <div style={styles.section}>
          <div style={styles.sectionTitle}>State</div>
          <div style={styles.flagsGrid}>
            <span style={{ color: colors.muted }}>Load Gen:</span>
            <span style={{ color: colors.primaryText }}>#{diagnostics.loadGeneration}</span>
            
            <span style={{ color: colors.muted }}>Timed Out:</span>
            <span style={{ color: diagnostics.timedOut ? '#F57C00' : colors.accent }}>
              {diagnostics.timedOut ? 'YES' : 'No'}
            </span>
            
            <span style={{ color: colors.muted }}>Abandoned:</span>
            <span style={{ color: diagnostics.abandonedLoad ? '#D32F2F' : colors.accent }}>
              {diagnostics.abandonedLoad ? 'YES' : 'No'}
            </span>
            
            <span style={{ color: colors.muted }}>Generate:</span>
            <span style={{ color: diagnostics.generateReached ? colors.accent : colors.muted }}>
              {diagnostics.generateReached ? 'Reached' : 'Not yet'}
            </span>
          </div>
        </div>

        {/* Progress Section */}
        <div style={styles.section}>
          <div style={styles.sectionTitle}>Current Stage</div>
          <div style={styles.stageDisplay}>
            <span style={{ color: colors.primaryText, fontWeight: 'bold' }}>{diagnostics.stage}</span>
            <span style={{ color: colors.accent }}>→</span>
            <span style={{ color: colors.accent, fontWeight: 'bold' }}>{diagnostics.substage}</span>
          </div>
          <div style={styles.elapsed}>
            Elapsed: {formatDuration(diagnostics.elapsedMs)}
          </div>
        </div>

        {/* Last Progress Payload */}
        {diagnostics.lastProgressPayload && (
          <div style={styles.section}>
            <div style={styles.sectionTitle}>Last Progress Event</div>
            <pre style={styles.payload}>
              {JSON.stringify(diagnostics.lastProgressPayload, null, 2)}
            </pre>
          </div>
        )}

        {/* Progress History */}
        {diagnostics.progressHistory.length > 0 && (
          <div style={styles.section}>
            <div style={styles.sectionTitle}>Progress History (last 10)</div>
            <div style={styles.historyList}>
              {diagnostics.progressHistory.slice(-10).map((p, i) => (
                <div key={i} style={styles.historyEntry}>
                  <span style={{ color: colors.muted }}>{i === 9 ? '→' : ' '}</span>
                  <span>{p.progress?.toFixed(1) || '?'}%</span>
                  <span style={{ color: colors.muted }}>l:{p.loaded || '?'}</span>
                  <span style={{ color: colors.muted }}>t:{p.total || '?'}</span>
                  <span style={{ color: colors.accent }}>{p.status || ''}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Storage */}
        <div style={styles.section}>
          <div style={styles.sectionTitle}>Storage</div>
          <div style={styles.storageGrid}>
            <div>
              <span style={{ color: colors.muted }}>Before: </span>
              <span style={{ color: colors.primaryText }}>
                {diagnostics.storageBefore 
                  ? formatBytes(diagnostics.storageBefore.usage)
                  : 'N/A'}
              </span>
            </div>
            <div>
              <span style={{ color: colors.muted }}>After: </span>
              <span style={{ 
                color: diagnostics.storageAfter ? colors.primaryText : '#F57C00' 
              }}>
                {diagnostics.storageAfter 
                  ? formatBytes(diagnostics.storageAfter.usage)
                  : 'Not available'}
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
                  <span style={{ color: colors.muted }}>{i + 1}.</span>
                  <span>{entry.stage}</span>
                  <span style={{ color: colors.accent }}>→</span>
                  <span>{entry.substage}</span>
                  {entry.durationMs && (
                    <span style={{ color: colors.muted }}>({entry.durationMs}ms)</span>
                  )}
                </div>
              ))}
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
            <div style={{ color: '#C62828', fontWeight: 'bold', marginBottom: '8px' }}>
              Error
            </div>
            <pre style={{ 
              margin: 0, 
              fontSize: '11px', 
              color: '#C62828',
              fontFamily: 'monospace',
              whiteSpace: 'pre-wrap',
            }}>
              {diagnostics.error || 'Unknown error'}
            </pre>
          </div>
        )}

        {/* Bug Report Section */}
        <div style={styles.section}>
          <div style={styles.bugReportHeader}>
            <span style={styles.sectionTitle}>Full Report</span>
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
            {diagnostics.bugReport || 'No report available'}
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
    maxHeight: '700px',
    overflowY: 'auto',
  },
  crashWarning: {
    border: '2px solid',
    borderRadius: '8px',
    padding: '12px',
    marginBottom: '16px',
  },
  crashTitle: {
    fontSize: '13px',
    fontWeight: 'bold',
    marginBottom: '4px',
  },
  crashDetails: {
    fontSize: '11px',
    color: '#333',
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
  sizeGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, 1fr)',
    gap: '8px',
  },
  sizeItem: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  sizeLabel: {
    fontSize: '10px',
    textTransform: 'uppercase',
  },
  sizeValue: {
    fontSize: '14px',
    fontFamily: 'monospace',
  },
  warning: {
    fontSize: '11px',
    color: '#F57C00',
    marginTop: '8px',
    padding: '8px',
    background: '#FFF8E1',
    borderRadius: '4px',
  },
  flagsGrid: {
    display: 'grid',
    gridTemplateColumns: 'auto auto',
    gap: '4px 8px',
    fontSize: '11px',
    fontFamily: 'monospace',
  },
  stageDisplay: {
    display: 'flex',
    gap: '8px',
    alignItems: 'center',
    fontSize: '14px',
    marginBottom: '4px',
  },
  elapsed: {
    fontSize: '12px',
    color: '#666',
  },
  payload: {
    fontSize: '10px',
    fontFamily: 'monospace',
    background: '#F5F5F5',
    padding: '8px',
    borderRadius: '4px',
    overflow: 'auto',
    maxHeight: '100px',
    whiteSpace: 'pre-wrap',
    margin: 0,
  },
  historyList: {
    fontSize: '10px',
    fontFamily: 'monospace',
    maxHeight: '120px',
    overflowY: 'auto',
  },
  historyEntry: {
    display: 'flex',
    gap: '4px',
    padding: '2px 0',
  },
  storageGrid: {
    fontSize: '12px',
    display: 'flex',
    gap: '16px',
  },
  logContainer: {
    fontSize: '11px',
    fontFamily: 'monospace',
    maxHeight: '100px',
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
  },
  bugReport: {
    fontSize: '10px',
    fontFamily: 'monospace',
    background: '#F5F5F5',
    padding: '12px',
    borderRadius: '8px',
    overflow: 'auto',
    maxHeight: '250px',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    margin: 0,
  },
};
