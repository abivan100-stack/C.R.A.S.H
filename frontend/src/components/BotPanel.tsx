import { useRef, useState } from 'react';

import type { AccidentRecord } from '../domain/engine.ts';
import {
  BOT_EXAMPLES,
  BOT_UNAVAILABLE,
  buildDigest,
  filterRecords,
  filterSummary,
  hasActiveFilter,
  parseBotFilters,
  type BotFilters,
} from '../domain/bot.ts';
import { fetchJson } from '../app/api.ts';
import { Icon } from './Icon.tsx';

interface Message {
  role: 'user' | 'bot';
  text: string;
  filters?: BotFilters | null;
  matched?: number | undefined;
}

interface BotResponse {
  answer?: unknown;
  filters?: unknown;
}

function AnswerText({ text }: { text: string }): JSX.Element {
  const lines = text.split(/\r?\n/);
  return (
    <>
      {lines.map((line, i) => {
        const trimmed = line.trim();
        if (!trimmed) return null;
        const bold = trimmed.split(/(\*\*[^*]+\*\*)/g).map((part, j) =>
          part.startsWith('**') && part.endsWith('**')
            ? <b key={j}>{part.slice(2, -2)}</b>
            : <span key={j}>{part}</span>,
        );
        return <div className="bot-p" key={i}>{bold}</div>;
      })}
    </>
  );
}

export function BotPanel({ records }: { records: readonly AccidentRecord[] }): JSX.Element {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [typing, setTyping] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);

  async function ask(question: string): Promise<void> {
    const q = question.trim();
    if (!q || busy) return;
    setInput('');
    setBusy(true);
    setMessages((m) => [...m, { role: 'user', text: q }]);
    setTyping(true);
    try {
      const data = await fetchJson<BotResponse>('./ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q, digest: buildDigest(records) }),
        cache: 'no-store',
      }, 30000);
      const answer = typeof data.answer === 'string' && data.answer.trim() ? data.answer : "Sorry, I couldn't find an answer for that.";
      const filters = parseBotFilters(data.filters);
      /* Counts are computed here, from validated filters - never by the model. */
      const matched = filters ? filterRecords(records, filters).length : undefined;
      setMessages((m) => [...m, { role: 'bot', text: answer, filters, matched }]);
    } catch {
      setMessages((m) => [...m, { role: 'bot', text: BOT_UNAVAILABLE }]);
    } finally {
      setTyping(false);
      setBusy(false);
      requestAnimationFrame(() => {
        if (box.current) box.current.scrollTop = box.current.scrollHeight;
      });
    }
  }

  return (
    <section className="app-section active" role="tabpanel" aria-label="C.R.A.S.H Bot">
      <div className="report-root">
        <div className="section">
          <div className="slabel">Ask the data</div>
          <div className="stitle">C.R.A.S.H Bot</div>
          <div className="sdesc">
            The assistant translates a plain-English question into a filter over the recorded incidents, and the app
            counts the matches itself. The model never returns a number.
          </div>

          <div className="bot-chat" style={{ flex: '1 1 100%', maxWidth: 'none', height: 'calc(100vh - 250px)', minHeight: 420 }}>
            <div className="bot-messages" role="log" aria-live="polite" ref={box}>
              {messages.length === 0 ? (
                <div className="bot-p">Ask a question about Chennai's road-accident record.</div>
              ) : null}
              {messages.map((m, i) => (
                <div className={`bot-msg ${m.role === 'user' ? 'bot-msg-user' : 'bot-msg-bot'}`} key={i}>
                  {m.role === 'user' ? m.text : <AnswerText text={m.text} />}
                  {m.role === 'bot' && m.filters && hasActiveFilter(m.filters) ? (
                    <div className="bot-p" style={{ marginTop: 8, color: 'var(--text-2)' }}>
                      Showing: <b style={{ color: 'var(--accent)' }}>{filterSummary(m.filters)}</b> -{' '}
                      <b style={{ color: 'var(--accent)' }}>{m.matched ?? 0}</b> found
                    </div>
                  ) : null}
                  {m.role === 'bot' && m.filters === null && m.text !== BOT_UNAVAILABLE ? (
                    <div className="bot-p" style={{ opacity: 0.7, marginTop: 6 }}>The answer's filter could not be validated, so no subset is highlighted.</div>
                  ) : null}
                </div>
              ))}
              {typing ? (
                <div className="bot-msg bot-msg-bot bot-typing">
                  <span className="bot-dot" /><span className="bot-dot" /><span className="bot-dot" />
                </div>
              ) : null}
            </div>

            <div className="bot-examples">
              {BOT_EXAMPLES.map((q) => (
                <button className="bot-ex" type="button" key={q} onClick={() => void ask(q)}>{q}</button>
              ))}
            </div>

            <div className="bot-inputrow">
              <input
                id="botInput"
                type="text"
                placeholder="Ask a question."
                autoComplete="off"
                aria-label="Ask C.R.A.S.H Bot a question"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void ask(input);
                  }
                }}
              />
              <button id="botSend" type="button" onClick={() => void ask(input)} disabled={busy}>
                <Icon name="arrow-right" size={14} /> Send
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
