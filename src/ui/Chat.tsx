import { useState, useRef, useEffect } from 'react';

interface ChatProps {
  onSendMessage: (message: string) => void;
  isModelLoaded: boolean;
  isGenerating: boolean;
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

export function Chat({ onSendMessage, isModelLoaded, isGenerating, colors }: ChatProps) {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
  const [streamingContent, setStreamingContent] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || !isModelLoaded || isGenerating) return;

    const userMessage = input.trim();
    setInput('');
    setMessages((prev) => [...prev, { role: 'user', content: userMessage }]);
    setStreamingContent('');

    onSendMessage(userMessage);
  };

  // Expose stream handler via custom event
  useEffect(() => {
    const handleStream = (e: CustomEvent<string>) => {
      setStreamingContent((prev) => prev + e.detail);
    };
    window.addEventListener('ajawai-stream' as keyof WindowEventMap, handleStream as EventListener);
    return () => {
      window.removeEventListener('ajawai-stream' as keyof WindowEventMap, handleStream as EventListener);
    };
  }, []);

  // Update messages when streaming completes
  useEffect(() => {
    if (!isGenerating && streamingContent) {
      setMessages((prev) => [...prev, { role: 'assistant', content: streamingContent }]);
      setStreamingContent('');
    }
  }, [isGenerating]);

  const canSend = isModelLoaded && !isGenerating && input.trim();

  return (
    <div style={{ ...styles.container, background: colors.white, borderColor: colors.border }}>
      <div style={{ ...styles.messages, background: colors.white }}>
        {messages.length === 0 && !streamingContent && (
          <div style={{ ...styles.emptyState, color: colors.muted }}>
            {!isModelLoaded 
              ? 'Waiting for model to load...' 
              : 'Say hi to Phi!'}
          </div>
        )}
        {messages.map((msg, idx) => (
          <div 
            key={idx} 
            style={msg.role === 'user' 
              ? { ...styles.userMessage, background: colors.accent, color: colors.white } 
              : { ...styles.assistantMessage, background: colors.panel, color: colors.primaryText }}
          >
            <div style={{ ...styles.messageLabel, color: msg.role === 'user' ? 'rgba(255,255,255,0.7)' : colors.muted }}>
              {msg.role === 'user' ? 'You' : 'Phi'}
            </div>
            <div style={styles.messageContent}>{msg.content}</div>
          </div>
        ))}
        {streamingContent && (
          <div style={{ ...styles.assistantMessage, background: colors.panel, color: colors.primaryText }}>
            <div style={{ ...styles.messageLabel, color: colors.muted }}>Phi</div>
            <div style={styles.messageContent}>
              {streamingContent}
              <span style={styles.cursor}>▊</span>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <form onSubmit={handleSubmit} style={{ ...styles.inputArea, background: colors.panel, borderColor: colors.border }}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={isModelLoaded ? 'Type a message...' : 'Loading model...'}
          disabled={!isModelLoaded || isGenerating}
          style={{ 
            ...styles.input, 
            background: colors.white, 
            borderColor: colors.border,
            color: colors.primaryText 
          }}
        />
        <button
          type="submit"
          disabled={!canSend}
          style={{ 
            ...styles.sendButton, 
            background: canSend ? colors.accent : colors.muted,
            cursor: canSend ? 'pointer' : 'not-allowed'
          }}
        >
          {isGenerating ? '...' : 'Send'}
        </button>
      </form>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: 'calc(100vh - 180px)',
    minHeight: '400px',
    borderRadius: '16px',
    border: '1px solid',
    overflow: 'hidden',
  },
  messages: {
    flex: 1,
    overflowY: 'auto',
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  emptyState: {
    textAlign: 'center',
    padding: '40px 20px',
    fontSize: '14px',
  },
  userMessage: {
    alignSelf: 'flex-end',
    padding: '12px 16px',
    borderRadius: '16px 16px 4px 16px',
    maxWidth: '80%',
  },
  assistantMessage: {
    alignSelf: 'flex-start',
    padding: '12px 16px',
    borderRadius: '16px 16px 16px 4px',
    maxWidth: '80%',
  },
  messageLabel: {
    fontSize: '11px',
    marginBottom: '4px',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
    fontWeight: '600',
  },
  messageContent: {
    fontSize: '14px',
    lineHeight: '1.5',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  cursor: {
    animation: 'blink 1s infinite',
    marginLeft: '2px',
  },
  inputArea: {
    display: 'flex',
    gap: '8px',
    padding: '16px',
    borderTop: '1px solid',
  },
  input: {
    flex: 1,
    padding: '12px 16px',
    fontSize: '14px',
    borderRadius: '12px',
    border: '1px solid',
    outline: 'none',
  },
  sendButton: {
    padding: '12px 24px',
    fontSize: '14px',
    fontWeight: '600',
    borderRadius: '12px',
    border: 'none',
    color: '#fff',
    transition: 'opacity 0.2s',
  },
};
