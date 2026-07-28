"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { detectLanguage, languageLabel, needsLanguageReview } from "../../lib/language";
import type {
  ActionItemRecord,
  BootstrapPayload,
  MessageKind,
  MessagePriority,
  MessageRecord,
  SupportedLanguage,
} from "../../lib/types";

type BridgeAppProps = {
  authorized: boolean;
  demoMode: boolean;
  signInPath: string;
  signOutPath: string;
};

type MobileView = "chat" | "threads" | "brief" | "search";

const MESSAGE_TEMPLATES: Array<{
  kind: MessageKind;
  label: string;
  ko: string;
  priority: MessagePriority;
}> = [
  { kind: "safety", label: "Safety alert", ko: "안전", priority: "safety" },
  { kind: "production", label: "Production blocker", ko: "생산", priority: "important" },
  { kind: "maintenance", label: "Maintenance", ko: "정비", priority: "important" },
  { kind: "quality", label: "Quality issue", ko: "품질", priority: "important" },
  { kind: "handoff", label: "Shift handoff", ko: "인수인계", priority: "normal" },
];

export function BridgeApp({
  authorized,
  demoMode,
  signInPath,
  signOutPath,
}: BridgeAppProps) {
  const [workspace, setWorkspace] = useState<BootstrapPayload | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [loading, setLoading] = useState(authorized);
  const [error, setError] = useState<string | null>(null);
  const [mobileView, setMobileView] = useState<MobileView>("chat");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<MessageRecord[]>([]);
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  const [outbox, setOutbox] = useState<QueuedMessage[]>([]);
  const [highlightedMessage, setHighlightedMessage] = useState<string | null>(null);
  const [showSafetyReminder, setShowSafetyReminder] = useState(true);

  const loadWorkspace = useCallback(async (threadId?: string) => {
    setError(null);
    try {
      const suffix = threadId ? `?threadId=${encodeURIComponent(threadId)}` : "";
      const response = await fetch(`/api/bootstrap${suffix}`, { cache: "no-store" });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not load the workspace");
      }
      const payload = (await response.json()) as BootstrapPayload;
      setWorkspace(payload);
      setSelectedThreadId(
        threadId ?? payload.messages[0]?.threadId ?? payload.threads[0]?.id ?? null,
      );
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load the workspace");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!authorized) return;
    const timer = window.setTimeout(() => void loadWorkspace(), 0);
    return () => window.clearTimeout(timer);
  }, [authorized, loadWorkspace]);

  useEffect(() => {
    const online = () => setIsOnline(true);
    const offline = () => setIsOnline(false);
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
    };
  }, []);

  useEffect(() => {
    if (!selectedThreadId) return;
    const interval = window.setInterval(async () => {
      if (!navigator.onLine || document.visibilityState !== "visible") return;
      const response = await fetch(
        `/api/messages?threadId=${encodeURIComponent(selectedThreadId)}`,
        { cache: "no-store" },
      ).catch(() => null);
      if (!response?.ok) return;
      const body = (await response.json()) as { messages: MessageRecord[] };
      setWorkspace((current) =>
        current ? { ...current, messages: mergeMessages(current.messages, body.messages) } : current,
      );
    }, 4500);
    return () => window.clearInterval(interval);
  }, [selectedThreadId]);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
        setMobileView("search");
      }
      if (event.key === "Escape") {
        setSearchOpen(false);
        setMobileView("chat");
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);

  const openThread = useCallback(
    async (threadId: string) => {
      setSelectedThreadId(threadId);
      setMobileView("chat");
      setLoading(true);
      await loadWorkspace(threadId);
    },
    [loadWorkspace],
  );

  const refreshMessages = useCallback(async () => {
    if (!selectedThreadId) return;
    const response = await fetch(
      `/api/messages?threadId=${encodeURIComponent(selectedThreadId)}`,
      { cache: "no-store" },
    );
    if (!response.ok) return;
    const body = (await response.json()) as { messages: MessageRecord[] };
    setWorkspace((current) => (current ? { ...current, messages: body.messages } : current));
  }, [selectedThreadId]);

  const sendMessage = useCallback(
    async (queued: QueuedMessage): Promise<boolean> => {
      if (!workspace) return false;
      const optimistic = optimisticMessage(queued, workspace);
      setWorkspace((current) =>
        current
          ? { ...current, messages: mergeMessages(current.messages, [optimistic]) }
          : current,
      );

      let persisted: MessageRecord;
      try {
        const response = await fetch("/api/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(queued),
        });
        const body = (await response.json()) as { message?: MessageRecord; error?: string };
        if (!response.ok || !body.message) throw new Error(body.error ?? "Could not send");
        persisted = body.message;
        setWorkspace((current) =>
          current
            ? {
                ...current,
                messages: current.messages.map((message) =>
                  message.clientMessageId === queued.clientMessageId ? persisted : message,
                ),
              }
            : current,
        );

      } catch {
        setWorkspace((current) =>
          current
            ? {
                ...current,
                messages: current.messages.map((message) =>
                  message.clientMessageId === queued.clientMessageId
                    ? { ...message, deliveryStatus: "failed" }
                    : message,
                ),
              }
            : current,
        );
        return false;
      }

      try {
        const translation = await fetch("/api/translate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messageId: persisted.id }),
        });
        if (!translation.ok) {
          await refreshMessages();
          return true;
        }
        const translated = (await translation.json()) as { message: MessageRecord | null };
        const translatedMessage = translated.message;
        if (!translatedMessage) {
          await refreshMessages();
          return true;
        }
        setWorkspace((current) =>
          current
            ? {
                ...current,
                messages: current.messages.map((message) =>
                  message.id === translatedMessage.id ? translatedMessage : message,
                ),
              }
            : current,
        );
      } catch {
        await refreshMessages().catch(() => undefined);
      }
      return true;
    },
    [refreshMessages, workspace],
  );

  useEffect(() => {
    if (!isOnline || outbox.length === 0 || !workspace) return;
    const timer = window.setTimeout(() => {
      const queued = [...outbox];
      const queuedIds = new Set(queued.map((message) => message.clientMessageId));
      setOutbox((current) =>
        current.filter((message) => !queuedIds.has(message.clientMessageId)),
      );
      void (async () => {
        const failed: QueuedMessage[] = [];
        for (const message of queued) {
          if (!(await sendMessage(message))) failed.push(message);
        }
        if (failed.length > 0) {
          setOutbox((current) => mergeQueuedMessages(current, failed));
        }
      })();
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [isOnline, outbox, sendMessage, workspace]);

  const handleSubmit = useCallback(
    (draft: Omit<QueuedMessage, "threadId" | "clientMessageId">) => {
      if (!selectedThreadId) return;
      const queued: QueuedMessage = {
        ...draft,
        threadId: selectedThreadId,
        clientMessageId: crypto.randomUUID(),
      };
      if (!isOnline) {
        setOutbox((current) => [...current, queued]);
        if (workspace) {
          setWorkspace({
            ...workspace,
            messages: mergeMessages(workspace.messages, [
              { ...optimisticMessage(queued, workspace), deliveryStatus: "queued" },
            ]),
          });
        }
        return;
      }
      void (async () => {
        if (!(await sendMessage(queued))) {
          setOutbox((current) => mergeQueuedMessages(current, [queued]));
        }
      })();
    },
    [isOnline, selectedThreadId, sendMessage, workspace],
  );

  const runSearch = useCallback(async (query: string) => {
    setSearchQuery(query);
    if (query.trim().length < minimumSearchLength(query.trim())) {
      setSearchResults([]);
      return;
    }
    const response = await fetch("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: query.trim() }),
    });
    if (!response.ok) return;
    const body = (await response.json()) as { messages: MessageRecord[] };
    setSearchResults(body.messages);
  }, []);

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    setMobileView("search");
  }, []);

  const updateBrief = useCallback(
    (summary: BootstrapPayload["summary"], actions: ActionItemRecord[]) => {
      setWorkspace((current) =>
        current
          ? { ...current, summary, actions, summaryRefreshDue: false }
          : current,
      );
    },
    [],
  );

  const jumpToMessage = useCallback(
    async (message: MessageRecord) => {
      await openThread(message.threadId);
      setSearchOpen(false);
      setHighlightedMessage(message.id);
      window.setTimeout(() => {
        document.getElementById(`message-${message.id}`)?.scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
      }, 180);
      window.setTimeout(() => setHighlightedMessage(null), 2200);
    },
    [openThread],
  );

  if (!authorized) {
    return <SignInScreen signInPath={signInPath} />;
  }

  if (loading && !workspace) return <LoadingScreen />;
  if (error && !workspace) {
    return <ErrorScreen message={error} onRetry={() => void loadWorkspace()} />;
  }
  if (!workspace || !selectedThreadId) return <LoadingScreen />;

  const currentThread =
    workspace.threads.find((thread) => thread.id === selectedThreadId) ??
    workspace.threads[0];

  return (
    <main className="relay-shell">
      <ThreadRail
        workspace={workspace}
        selectedThreadId={selectedThreadId}
        onSelect={openThread}
        onSearch={openSearch}
        signOutPath={signOutPath}
        mobileOpen={mobileView === "threads"}
      />

      <section className="conversation-pane" aria-label="Conversation">
        <ConversationHeader
          title={currentThread.title}
          subtitle={currentThread.subtitle}
          location={currentThread.location}
          onOpenBrief={() => setMobileView("brief")}
        />

        {!isOnline ? (
          <StatusBanner tone="offline">
            Offline — messages stay in this tab’s outbox until this screen reconnects.
          </StatusBanner>
        ) : !workspace.ai.configured ? (
          <StatusBanner tone="demo">
            Demo workspace · Existing translations are reviewed samples. Connect OpenRouter to translate new messages.
          </StatusBanner>
        ) : null}

        {showSafetyReminder ? (
          <div className="safety-reminder" role="note">
            <span className="safety-reminder__mark" aria-hidden="true">!</span>
            <p>
              <strong>Urgent hazard?</strong> Use the plant alarm, radio, or supervisor process first. Relay is not an emergency alarm.
            </p>
            <button
              type="button"
              aria-label="Dismiss safety reminder"
              onClick={() => setShowSafetyReminder(false)}
            >
              Got it
            </button>
          </div>
        ) : null}

        <MessageList
          messages={workspace.messages}
          actorEmail={workspace.actor.email}
          preferredLanguage={workspace.actor.preferredLanguage}
          highlightedMessage={highlightedMessage}
        />

        <Composer
          preferredLanguage={workspace.actor.preferredLanguage}
          onSubmit={handleSubmit}
          queuedCount={outbox.length}
        />
      </section>

      <ShiftBrief
        workspace={workspace}
        threadId={selectedThreadId}
        mobileOpen={mobileView === "brief"}
        onClose={() => setMobileView("chat")}
        onUpdate={updateBrief}
        onSource={(id) => {
          setHighlightedMessage(id);
          setMobileView("chat");
          window.setTimeout(() =>
            document.getElementById(`message-${id}`)?.scrollIntoView({
              behavior: "smooth",
              block: "center",
            }), 120);
        }}
      />

      <MobileNav
        current={mobileView}
        onChange={(view) => {
          if (view === "search") openSearch();
          else setMobileView(view);
        }}
      />

      {searchOpen ? (
        <SearchDialog
          query={searchQuery}
          results={searchResults}
          threads={workspace.threads}
          onQuery={runSearch}
          onClose={() => {
            setSearchOpen(false);
            setMobileView("chat");
          }}
          onSelect={jumpToMessage}
        />
      ) : null}

      {error ? <div className="toast" role="status">{error}</div> : null}
      {demoMode ? <div className="demo-corner">Private demo</div> : null}
    </main>
  );
}

function ThreadRail({
  workspace,
  selectedThreadId,
  onSelect,
  onSearch,
  signOutPath,
  mobileOpen,
}: {
  workspace: BootstrapPayload;
  selectedThreadId: string;
  onSelect: (id: string) => void;
  onSearch: () => void;
  signOutPath: string;
  mobileOpen: boolean;
}) {
  return (
    <aside className={`thread-rail ${mobileOpen ? "is-mobile-open" : ""}`} aria-label="Conversations">
      <div className="brand-lockup">
        <span className="brand-mark" aria-hidden="true"><i>가</i><i>ES</i></span>
        <span><strong>NEWONE</strong><small>RELAY</small></span>
      </div>
      <button className="search-button" type="button" onClick={onSearch}>
        <span aria-hidden="true">⌕</span>
        Search messages
        <kbd>⌘ K</kbd>
      </button>
      <div className="rail-heading">
        <span>Operations</span>
      </div>
      <nav className="thread-list">
        {workspace.threads.map((thread) => (
          <button
            type="button"
            key={thread.id}
            className={thread.id === selectedThreadId ? "is-active" : ""}
            onClick={() => onSelect(thread.id)}
          >
            <span className={`thread-symbol thread-symbol--${thread.kind}`} aria-hidden="true">
              {thread.kind === "shift" ? "02" : thread.kind.slice(0, 1).toUpperCase()}
            </span>
            <span className="thread-copy">
              <strong>{thread.title}</strong>
              <small>{thread.lastMessage || thread.subtitle}</small>
            </span>
            <span className="thread-meta">
              <time>{formatRailTime(thread.updatedAt)}</time>
              {thread.unreadCount ? <b>{thread.unreadCount}</b> : null}
            </span>
          </button>
        ))}
      </nav>
      <div className="rail-footer">
        <span className="avatar avatar--manager">김</span>
        <span>
          <strong>{workspace.actor.displayName}</strong>
          <small>{workspace.actor.role} · {languageLabel(workspace.actor.preferredLanguage)}</small>
        </span>
        <a href={signOutPath} aria-label="Sign out">↗</a>
      </div>
    </aside>
  );
}

function ConversationHeader({
  title,
  subtitle,
  location,
  onOpenBrief,
}: {
  title: string;
  subtitle: string;
  location: string;
  onOpenBrief: () => void;
}) {
  return (
    <header className="conversation-header">
      <div>
        <span className="eyebrow">LIVE OPERATIONS CHANNEL</span>
        <h1>{title}</h1>
        <p><span className="presence-dot" /> Private channel · {location} · {subtitle}</p>
      </div>
      <div className="header-actions">
        <span className="language-route"><b>한</b><i>↔</i><b>ES</b> automatic</span>
        <button type="button" onClick={onOpenBrief}>Shift brief <span>›</span></button>
      </div>
    </header>
  );
}

function MessageList({
  messages,
  actorEmail,
  preferredLanguage,
  highlightedMessage,
}: {
  messages: MessageRecord[];
  actorEmail: string;
  preferredLanguage: SupportedLanguage;
  highlightedMessage: string | null;
}) {
  const endRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  return (
    <div className="message-scroll" aria-live="polite">
      {messages.map((message, index) => {
        const previous = messages[index - 1];
        const startsDay = !previous || dateKey(previous.createdAt) !== dateKey(message.createdAt);
        return (
          <div className="message-day" key={message.id}>
            {startsDay ? <div className="date-divider"><span>{formatDate(message.createdAt)}</span></div> : null}
            <MessageBubble
              message={message}
              previous={previous}
              isOwn={message.senderEmail === actorEmail}
              preferredLanguage={preferredLanguage}
              highlighted={highlightedMessage === message.id}
            />
          </div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}

function MessageBubble({
  message,
  previous,
  isOwn,
  preferredLanguage,
  highlighted,
}: {
  message: MessageRecord;
  previous?: MessageRecord;
  isOwn: boolean;
  preferredLanguage: SupportedLanguage;
  highlighted: boolean;
}) {
  const consecutive = previous?.senderEmail === message.senderEmail;
  const translatedFirst = !isOwn && message.targetLanguage === preferredLanguage;
  const primary = translatedFirst
    ? message.translatedText ?? message.sourceText
    : message.sourceText;
  const secondary = translatedFirst ? message.sourceText : message.translatedText;
  const primaryLanguage = translatedFirst ? message.targetLanguage : message.sourceLanguage;
  const secondaryLanguage = translatedFirst ? message.sourceLanguage : message.targetLanguage;

  return (
    <article
      id={`message-${message.id}`}
      className={[
        "message-row",
        isOwn ? "is-own" : "",
        consecutive ? "is-consecutive" : "",
        message.priority === "safety" ? "is-safety" : "",
        highlighted ? "is-highlighted" : "",
      ].filter(Boolean).join(" ")}
    >
      {!isOwn && !consecutive ? (
        <span className="avatar" aria-hidden="true">{message.senderName.charAt(0)}</span>
      ) : <span className="avatar-spacer" />}
      <div className="message-stack">
        {!consecutive ? (
          <div className="message-byline">
            <strong>{message.senderName}</strong>
            <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
            {message.priority === "safety" ? <span className="safety-label">SAFETY</span> : null}
          </div>
        ) : null}
        <div className="message-card">
          <div className="message-primary">
            <span className="language-caption">
              {primaryLanguage === preferredLanguage ? "Your language" : "Original"} · {languageLabel(primaryLanguage)}
            </span>
            <p lang={primaryLanguage}>{primary}</p>
          </div>
          {secondary ? (
            <div className="message-translation">
              <span className="language-caption">
                {secondaryLanguage === message.sourceLanguage ? "Original" : "Recipient view"} · {languageLabel(secondaryLanguage)}
              </span>
              <p lang={secondaryLanguage}>{secondary}</p>
            </div>
          ) : (
            <TranslationState status={message.translationStatus} />
          )}
        </div>
        {message.translationWarning ? (
          <div className="translation-warning" role="note">
            <strong>Verify translation</strong>
            <span>{message.translationWarning}</span>
          </div>
        ) : null}
        <div className="message-status">
          {message.humanReviewed ? <span>✓ Human reviewed</span> : null}
          <span>{deliveryCopy(message)}</span>
        </div>
      </div>
    </article>
  );
}

function TranslationState({ status }: { status: MessageRecord["translationStatus"] }) {
  if (status === "pending" || status === "translating") {
    return <div className="translation-state"><i /> Translating… original already delivered</div>;
  }
  if (status === "retryable_failed") {
    return <div className="translation-state is-error">Translation unavailable — original shown</div>;
  }
  return <div className="translation-state is-error">Translation could not be completed</div>;
}

function Composer({
  preferredLanguage,
  onSubmit,
  queuedCount,
}: {
  preferredLanguage: SupportedLanguage;
  onSubmit: (draft: Omit<QueuedMessage, "threadId" | "clientMessageId">) => void;
  queuedCount: number;
}) {
  const [text, setText] = useState("");
  const [kind, setKind] = useState<MessageKind>("message");
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const detected = text ? detectLanguage(text) : preferredLanguage;
  const selectedTemplate = MESSAGE_TEMPLATES.find((template) => template.kind === kind);
  const warning = text && (needsLanguageReview(text) || kind === "safety");

  const submit = () => {
    const cleaned = text.trim();
    if (!cleaned) return;
    const sourceLanguage: SupportedLanguage =
      detected === "mixed" ? preferredLanguage : detected;
    onSubmit({
      text: cleaned,
      sourceLanguage,
      kind,
      priority: selectedTemplate?.priority ?? "normal",
    });
    setText("");
    setKind("message");
    textarea.current?.focus();
  };

  return (
    <div className="composer-wrap">
      <div className="template-strip" aria-label="Message templates">
        <span>Structured message</span>
        {MESSAGE_TEMPLATES.map((template) => (
          <button
            type="button"
            key={template.kind}
            className={kind === template.kind ? "is-selected" : ""}
            onClick={() => setKind((current) => current === template.kind ? "message" : template.kind)}
          >
            {template.label}<small>{template.ko}</small>
          </button>
        ))}
      </div>
      {warning ? (
        <div className={`composer-warning ${kind === "safety" ? "is-safety" : ""}`} role="status">
          <strong>{kind === "safety" ? "Safety message" : "Check source language"}</strong>
          <span>{kind === "safety" ? "Include exact location, equipment ID, action, and units. Send through the plant emergency process too." : "This message is short or mixed-language. Confirm the language chip before sending."}</span>
        </div>
      ) : null}
      <div className="composer">
        <textarea
          ref={textarea}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          rows={1}
          maxLength={2000}
          placeholder={kind === "message" ? "메시지 입력 · Escribe un mensaje" : `${selectedTemplate?.label}: add the exact details…`}
          aria-label="Message"
        />
        <div className="composer-tools">
          <span className={detected === "mixed" ? "needs-review" : ""}>
            {languageLabel(detected)} {detected === "mixed" ? "?" : "detected"}
          </span>
          <button type="button" onClick={submit} disabled={!text.trim()}>
            Send <i aria-hidden="true">↑</i>
          </button>
        </div>
      </div>
      <div className="composer-footnote">
        <span>Original sends first · translation follows</span>
        {queuedCount ? <strong>{queuedCount} queued in this tab</strong> : <span>Shift + Enter for a new line</span>}
      </div>
    </div>
  );
}

function ShiftBrief({
  workspace,
  threadId,
  mobileOpen,
  onClose,
  onUpdate,
  onSource,
}: {
  workspace: BootstrapPayload;
  threadId: string;
  mobileOpen: boolean;
  onClose: () => void;
  onUpdate: (summary: BootstrapPayload["summary"], actions: ActionItemRecord[]) => void;
  onSource: (id: string) => void;
}) {
  const [language, setLanguage] = useState<SupportedLanguage>(workspace.actor.preferredLanguage);
  const [generating, setGenerating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const autoRunKey = useRef<string | null>(null);
  const summaryRefreshDue = useMemo(() => {
    if (!workspace.summary) return workspace.messages.length > 0;
    const newer = workspace.messages.filter(
      (message) => message.createdAt > workspace.summary!.createdAt,
    );
    return (
      newer.length >= 8 ||
      newer.some((message) => message.messageKind === "handoff")
    );
  }, [workspace.messages, workspace.summary]);

  const generate = useCallback(async (automatic = false) => {
    setGenerating(true);
    setNotice(null);
    try {
      const response = await fetch("/api/summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId }),
      });
      const body = (await response.json()) as {
        summary?: BootstrapPayload["summary"];
        actions?: ActionItemRecord[];
        error?: string;
      };
      if (!response.ok || !body.summary || !body.actions) {
        throw new Error(body.error ?? "Could not generate the brief");
      }
      onUpdate(body.summary, body.actions);
      setNotice(
        automatic
          ? "Brief refreshed automatically from current messages"
          : "Brief updated from current messages",
      );
    } catch (summaryError) {
      setNotice(summaryError instanceof Error ? summaryError.message : "Could not generate the brief");
    } finally {
      setGenerating(false);
    }
  }, [onUpdate, threadId]);

  useEffect(() => {
    const canGenerate = ["manager", "admin"].includes(workspace.actor.role);
    const latestMessage = workspace.messages.at(-1)?.id ?? "empty";
    const key = `${threadId}:${latestMessage}`;
    if (
      !summaryRefreshDue ||
      !workspace.ai.configured ||
      !canGenerate ||
      autoRunKey.current === key
    ) {
      return;
    }
    autoRunKey.current = key;
    const timer = window.setTimeout(() => void generate(true), 1200);
    return () => window.clearTimeout(timer);
  }, [generate, summaryRefreshDue, threadId, workspace.actor.role, workspace.ai.configured, workspace.messages]);

  return (
    <aside className={`shift-brief ${mobileOpen ? "is-mobile-open" : ""}`} aria-label="Shift brief">
      <div className="brief-header">
        <div><span className="eyebrow">SOURCE-GROUNDED</span><h2>Shift brief</h2><p>교대 요약 · Resumen del turno</p></div>
        <button type="button" className="brief-close" onClick={onClose} aria-label="Close shift brief">×</button>
      </div>
      <div className="brief-language" role="group" aria-label="Summary language">
        <button className={language === "ko" ? "is-active" : ""} type="button" onClick={() => setLanguage("ko")}>한국어</button>
        <button className={language === "es" ? "is-active" : ""} type="button" onClick={() => setLanguage("es")}>Español</button>
      </div>

      {workspace.summary ? (
        <section className="brief-card brief-card--summary">
          <div className="brief-card__meta"><span>Updated {formatTime(workspace.summary.createdAt)}</span><span>{workspace.summary.generatedBy === "openrouter" ? "AI · verify" : "Reviewed demo"}</span></div>
          <h3>{language === "ko" ? workspace.summary.headlineKo : workspace.summary.headlineEs}</h3>
          <p lang={language}>{language === "ko" ? workspace.summary.summaryKo : workspace.summary.summaryEs}</p>
          <div className="source-links">
            <span>Sources</span>
            {workspace.summary.sourceMessageIds.map((id, index) => (
              <button type="button" key={id} onClick={() => onSource(id)}>#{index + 1}</button>
            ))}
          </div>
        </section>
      ) : <div className="brief-empty">No shift brief yet.</div>}

      <section className="action-section">
        <div className="section-heading"><span><strong>Action items</strong><small>{workspace.actions.filter((item) => item.status !== "done").length} open</small></span></div>
        <div className="action-list">
          {workspace.actions.map((action) => (
            <ActionItem
              key={action.id}
              action={action}
              language={language}
              canManage={["manager", "admin"].includes(workspace.actor.role)}
              onChange={(actions) => onUpdate(workspace.summary, actions)}
            />
          ))}
        </div>
      </section>

      <div className="brief-generate">
        <button
          type="button"
          onClick={() => void generate(false)}
          disabled={
            generating ||
            !workspace.ai.configured ||
            !["manager", "admin"].includes(workspace.actor.role)
          }
        >
          <span aria-hidden="true">✦</span> {generating ? "Building brief…" : "Generate fresh brief"}
        </button>
        <small>
          {!workspace.ai.configured
            ? "Connect an approved OpenRouter account to refresh"
            : ["manager", "admin"].includes(workspace.actor.role)
              ? `Qwen · ${workspace.ai.privacyMode.toUpperCase()} · sources required`
              : "A manager can generate a new brief"}
        </small>
        {notice ? <p role="status">{notice}</p> : null}
      </div>

      <div className="privacy-note">
        <span aria-hidden="true">◎</span>
        <p><strong>Communication aid</strong>Machine translation can be wrong. Human review is required for safety, legal, disciplinary, medical, payroll, and other high-impact messages.</p>
      </div>
    </aside>
  );
}

function ActionItem({
  action,
  language,
  canManage,
  onChange,
}: {
  action: ActionItemRecord;
  language: SupportedLanguage;
  canManage: boolean;
  onChange: (items: ActionItemRecord[]) => void;
}) {
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    setBusy(true);
    const response = await fetch("/api/actions", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: action.id, status: action.status === "done" ? "open" : "done" }),
    });
    if (response.ok) {
      const body = (await response.json()) as { actions: ActionItemRecord[] };
      onChange(body.actions);
    }
    setBusy(false);
  };
  return (
    <article className={action.status === "done" ? "is-done" : ""}>
      <button
        type="button"
        onClick={toggle}
        disabled={busy || !canManage}
        aria-label={
          !canManage
            ? "Manager access is required to update this action"
            : action.status === "done"
              ? "Reopen action"
              : "Mark action complete"
        }
      >
        {action.status === "done" ? "✓" : ""}
      </button>
      <div>
        <strong lang={language}>{language === "ko" ? action.titleKo : action.titleEs}</strong>
        <span>{action.owner ?? "Unassigned"} {action.dueLabel ? `· ${action.dueLabel}` : ""}</span>
        {action.status === "needs_confirmation" ? <small>Needs confirmation</small> : null}
      </div>
    </article>
  );
}

function SearchDialog({
  query,
  results,
  threads,
  onQuery,
  onClose,
  onSelect,
}: {
  query: string;
  results: MessageRecord[];
  threads: BootstrapPayload["threads"];
  onQuery: (query: string) => void;
  onClose: () => void;
  onSelect: (message: MessageRecord) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [filter, setFilter] = useState<"all" | "safety" | "maintenance" | "quality">("all");
  const filteredResults = useMemo(
    () => filter === "all" ? results : results.filter((message) => message.messageKind === filter),
    [filter, results],
  );
  useEffect(() => inputRef.current?.focus(), []);
  return (
    <div className="search-overlay" role="dialog" aria-modal="true" aria-label="Search message history" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div className="search-dialog">
        <div className="search-input-wrap">
          <span aria-hidden="true">⌕</span>
          <input ref={inputRef} value={query} onChange={(event) => void onQuery(event.target.value)} placeholder="Search Korean, Spanish, equipment IDs, people…" aria-label="Search" />
          <button type="button" onClick={onClose}>Esc</button>
        </div>
        <div className="search-filters">
          {(["all", "safety", "maintenance", "quality"] as const).map((value) => (
            <button
              type="button"
              key={value}
              className={filter === value ? "is-active" : ""}
              onClick={() => setFilter(value)}
            >
              {value === "all" ? "All messages" : value.charAt(0).toUpperCase() + value.slice(1)}
            </button>
          ))}
        </div>
        <div className="search-results">
          {query.trim().length < minimumSearchLength(query.trim()) ? (
            <div className="search-empty"><span>↔</span><strong>Search both languages at once</strong><p>Try “B-14”, “온도”, “temperatura”, or a teammate’s name.</p></div>
          ) : filteredResults.length === 0 ? (
            <div className="search-empty"><strong>No matching messages</strong><p>Check spelling or try an equipment ID.</p></div>
          ) : filteredResults.map((message) => (
            <button type="button" key={message.id} onClick={() => onSelect(message)}>
              <span className="result-channel">{threads.find((thread) => thread.id === message.threadId)?.title ?? "Conversation"}</span>
              <strong>{message.translatedText ?? message.sourceText}</strong>
              <small>{message.sourceText}</small>
              <i>Matched {message.translatedText?.toLowerCase().includes(query.toLowerCase()) ? "translation" : "original"} · {formatTime(message.createdAt)}</i>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function MobileNav({ current, onChange }: { current: MobileView; onChange: (view: MobileView) => void }) {
  const items: Array<[MobileView, string, string]> = [
    ["threads", "Chats", "☰"],
    ["chat", "Current", "↔"],
    ["brief", "Brief", "✓"],
    ["search", "Search", "⌕"],
  ];
  return (
    <nav className="mobile-nav" aria-label="Mobile navigation">
      {items.map(([view, label, symbol]) => (
        <button type="button" key={view} className={current === view ? "is-active" : ""} onClick={() => onChange(view)}><span>{symbol}</span>{label}</button>
      ))}
    </nav>
  );
}

function StatusBanner({ tone, children }: { tone: "offline" | "demo"; children: React.ReactNode }) {
  return <div className={`status-banner status-banner--${tone}`} role="status"><span aria-hidden="true">{tone === "offline" ? "↯" : "◇"}</span>{children}</div>;
}

function SignInScreen({ signInPath }: { signInPath: string }) {
  return (
    <main className="signin-screen">
      <div className="signin-brand"><span className="brand-mark"><i>가</i><i>ES</i></span><strong>NEWONE RELAY</strong></div>
      <section>
        <span className="eyebrow">PRIVATE COMPANY WORKSPACE</span>
        <h1>Every shift,<br /><em>understood.</em></h1>
        <p>Korean ↔ Spanish operations chat with paired translations, traceable shift briefs, and searchable decisions.</p>
        <a href={signInPath}>Sign in to your workspace <span>→</span></a>
        <small>Access is limited to company-authorized accounts.</small>
      </section>
      <div className="signin-specimen" aria-hidden="true">
        <article><span>ES → 한국어 · Automatic translation</span><strong>B-14 밸브 근처에 작은 누출이 있습니다.</strong><p>Hay una fuga pequeña cerca de la válvula B-14.</p></article>
        <div><b>Original preserved</b><b>Sources linked</b><b>Human review</b></div>
      </div>
    </main>
  );
}

function LoadingScreen() {
  return <main className="loading-screen" role="status"><span className="brand-mark"><i>가</i><i>ES</i></span><p>Preparing the bilingual workspace…</p></main>;
}

function ErrorScreen({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <main className="error-screen"><span>!</span><h1>Relay could not open</h1><p>{message}</p><button type="button" onClick={onRetry}>Try again</button></main>;
}

type QueuedMessage = {
  threadId: string;
  clientMessageId: string;
  text: string;
  sourceLanguage: SupportedLanguage;
  kind: MessageKind;
  priority: MessagePriority;
};

function optimisticMessage(queued: QueuedMessage, workspace: BootstrapPayload): MessageRecord {
  return {
    id: `optimistic-${queued.clientMessageId}`,
    threadId: queued.threadId,
    clientMessageId: queued.clientMessageId,
    senderEmail: workspace.actor.email,
    senderName: workspace.actor.displayName,
    sourceText: queued.text,
    sourceLanguage: queued.sourceLanguage,
    targetLanguage: queued.sourceLanguage === "ko" ? "es" : "ko",
    translatedText: null,
    detectedLanguage: null,
    translationWarning: null,
    translationStatus: "pending",
    messageKind: queued.kind,
    priority: queued.priority,
    deliveryStatus: "sending",
    humanReviewed: false,
    provider: null,
    model: null,
    createdAt: new Date().toISOString(),
    translatedAt: null,
  };
}

function mergeMessages(current: MessageRecord[], incoming: MessageRecord[]): MessageRecord[] {
  const merged = new Map(current.map((message) => [message.clientMessageId, message]));
  for (const message of incoming) merged.set(message.clientMessageId, message);
  return [...merged.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function mergeQueuedMessages(
  current: QueuedMessage[],
  incoming: QueuedMessage[],
): QueuedMessage[] {
  const merged = new Map(
    current.map((message) => [message.clientMessageId, message]),
  );
  for (const message of incoming) merged.set(message.clientMessageId, message);
  return [...merged.values()];
}

function deliveryCopy(message: MessageRecord): string {
  if (message.deliveryStatus === "queued") return "Offline — not sent";
  if (message.deliveryStatus === "failed") return "Could not deliver";
  if (["pending", "translating"].includes(message.translationStatus)) {
    return "Original delivered · translation pending";
  }
  if (message.translationStatus.includes("failed")) return "Original delivered · translation unavailable";
  return message.deliveryStatus === "read" ? "Read · both languages ready" : "Delivered · both languages ready";
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function dateKey(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleDateString("en-CA");
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Message history";
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(date);
}

function formatRailTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(date);
}

function minimumSearchLength(value: string): number {
  return /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/.test(value) ? 1 : 2;
}
