import { useState, useRef, useEffect } from 'react';

interface ChatProps {
  onSendMessage: (message: string) => void;
  isModelLoaded: boolean;
  isGenerating: boolean;
}

export function Chat({ onSendMessage, isModelLoaded, isGenerating }: ChatProps) {
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

  const handleStreamChunk = (chunk: string) => {
    setStreamingContent((prev) => prev + chunk);
  };

  // Expose stream handler via custom event
  useEffect(() => {
    const handleStream = (e: CustomEvent<string>) => {
      handleStreamChunk(e.detail);
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

  return (
    <div style={styles.container}>
      <div style={styles.messages}>
        {messages.map((msg, idx) => (
          <div key={idx} style={msg.role === 'user' ? styles.userMessage : styles.assistantMessage}>
            <div style={styles.messageLabel}>{msg.role === 'user' ? 'You' : 'Phi'}</div>
            <div style={styles.messageContent}>{msg.content}</div>
          </div>
        ))}
        {streamingContent && (
          <div style={styles.assistantMessage}>
            <div style={styles.messageLabel}>Phi</div>
            <div style={styles.messageContent}>
              {streamingContent}
              <span style={styles.cursor}>▊</span>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <form onSubmit={handleSubmit} style={styles.inputArea}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={isModelLoaded ? 'Type a message...' : 'Loading model...'}
          disabled={!isModelLoaded || isGenerating}
          style={styles.input}
        />
        <button
          type="submit"
          disabled={!isModelLoaded || isGenerating || !input.trim()}
          style={styles.sendButton}
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
    minHeight: '300px',
  },
  messages: {
    flex: 1,
    overflowY: 'auto',
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  userMessage: {
    alignSelf: 'flex-end',
    background: '#2d2d2d',
    padding: '12px 16px',
    borderRadius: '12px 12px 4px 12px',
    maxWidth: '80%',
  },
  assistantMessage: {
    alignSelf: 'flex-start',
    background: '#1a1a2e',
    padding: '12px 16px',
    borderRadius: '12px 12px 12px 4px',
    maxWidth: '80%',
  },
  messageLabel: {
    fontSize: '11px',
    color: '#888',
    marginBottom: '4px',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
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
    borderTop: '1px solid #333',
    background: '#0f0f0f',
  },
  input: {
    flex: 1,
    padding: '12px 16px',
    fontSize: '14px',
    borderRadius: '8px',
    border: '1px solid #333',
    background: '#1a1a1a',
    color: '#e0e0e0',
    outline: 'none',
  },
  sendButton: {
    padding: '12px 24px',
    fontSize: '14px',
    fontWeight: '600',
    borderRadius: '8px',
    border: 'none',
    background: '#4a9eff',
    color: '#fff',
    cursor: 'pointer',
    opacity: 1,
    transition: 'opacity 0.2s',
  },
};
