const PROJECT_URL = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
const PUBLIC_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const AUTH_STORAGE_KEY = "digital-doppelganger-supabase-session";

type AuthSession = { access_token: string; refresh_token: string; expires_at?: number; expires_in?: number };
let authInFlight: Promise<AuthSession> | null = null;

function requireConfig() {
  if (!PROJECT_URL || !PUBLIC_KEY) {
    throw new Error("Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in Vercel.");
  }
  return { url: PROJECT_URL, key: PUBLIC_KEY };
}

function readSession(): AuthSession | null {
  if (typeof window === "undefined") return null;
  try { return JSON.parse(window.localStorage.getItem(AUTH_STORAGE_KEY) ?? "null"); } catch { return null; }
}

function storeSession(session: AuthSession) {
  if (typeof window !== "undefined") {
    const expiresAt = session.expires_at ?? Math.floor(Date.now() / 1000) + Number(session.expires_in ?? 3600);
    window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ ...session, expires_at: expiresAt }));
  }
  return session;
}

async function ensureAuth(): Promise<AuthSession> {
  const { url, key } = requireConfig();
  const existing = readSession();
  if (existing?.access_token && Number(existing.expires_at ?? 0) > Math.floor(Date.now() / 1000) + 60) return existing;
  if (authInFlight) return authInFlight;
  authInFlight = (async () => {
    if (existing?.refresh_token) {
      const refreshed = await fetch(`${url}/auth/v1/token?grant_type=refresh_token`, {
        method: "POST", headers: { apikey: key, "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: existing.refresh_token }),
      });
      if (refreshed.ok) return storeSession(await refreshed.json());
    }
    const created = await fetch(`${url}/auth/v1/signup`, {
      method: "POST", headers: { apikey: key, "Content-Type": "application/json" }, body: JSON.stringify({}),
    });
    const session = await created.json();
    if (!created.ok || !session.access_token) {
      throw new Error(session.msg ?? session.message ?? "Could not create a Supabase anonymous session. Enable Anonymous Sign-Ins in Supabase Auth settings.");
    }
    return storeSession(session);
  })().finally(() => { authInFlight = null; });
  return authInFlight;
}

export async function fetchApi<T>(path: string, options?: RequestInit): Promise<T> {
  const { url, key } = requireConfig();
  const session = await ensureAuth();
  const method = options?.method ?? "GET";
  let body: unknown = undefined;
  if (typeof options?.body === "string") {
    try { body = JSON.parse(options.body); } catch { body = options.body; }
  } else if (options?.body) body = options.body;
  const { data, error } = await fetch(`${url}/functions/v1/api`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ path, method, body }),
  }).then(async (response) => ({ data: await response.json(), error: response.ok ? null : new Error("request failed") }));
  if (error) throw new Error(data?.detail ?? `Supabase API error: ${data?.message ?? "request failed"}`);
  return data as T;
}

export function subscribeToEvents(
  sessionId: string | null,
  onEvent: (event: Record<string, unknown>) => void,
  onStatus: (connected: boolean) => void,
) {
  let socket: WebSocket | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let active = true;
  let ref = 1;
  void (async () => {
    try {
      const { url, key } = requireConfig();
      const session = await ensureAuth();
      if (!active) return;
      const wsUrl = `${url.replace(/^http/, "ws")}/realtime/v1/websocket?apikey=${encodeURIComponent(key)}&vsn=1.0.0`;
      socket = new WebSocket(wsUrl);
      socket.onopen = () => {
        const topic = `realtime:public:events:${crypto.randomUUID()}`;
        const postgresChange: Record<string, string> = { event: "INSERT", schema: "public", table: "events" };
        if (sessionId) postgresChange.filter = `session_id=eq.${sessionId}`;
        socket?.send(JSON.stringify({ topic, event: "phx_join", ref: String(ref++), join_ref: "1", payload: {
          access_token: session.access_token,
          config: { broadcast: { ack: false, self: false }, presence: { key: "" }, postgres_changes: [postgresChange] },
        } }));
        heartbeat = setInterval(() => {
          if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ topic: "phoenix", event: "heartbeat", payload: {}, ref: String(ref++) }));
        }, 25000);
      };
      socket.onmessage = (message) => {
        try {
          const frame = JSON.parse(message.data);
          if (frame.event === "phx_reply" && frame.payload?.status === "ok") onStatus(true);
          if (frame.event === "postgres_changes") {
            const record = frame.payload?.data?.record ?? frame.payload?.record;
            if (!record) return;
            onEvent(sessionId ? {
              event_id: record.id, session_id: record.session_id, event_type: record.event_type,
              timestamp: record.timestamp, page: record.page, target: record.target,
              sequence_number: record.sequence_number, product_state: record.product_state,
              is_suspicious: record.is_suspicious, detections: record.detections,
            } : {
              type: "event", session_id: record.session_id, event_type: record.event_type,
              product_state: record.product_state, is_suspicious: record.is_suspicious,
            });
          }
        } catch { /* Ignore non-JSON protocol frames. */ }
      };
      socket.onclose = () => onStatus(false);
      socket.onerror = () => onStatus(false);
    } catch { onStatus(false); }
  })();
  return () => {
    active = false;
    if (heartbeat) clearInterval(heartbeat);
    socket?.close();
    onStatus(false);
  };
}

export async function sendSessionEvent(path: string, data: Record<string, unknown>) {
  const match = path.match(/^\/ws\/events\/([^/]+)$/);
  if (!match) throw new Error("Session event channel is unavailable.");
  return fetchApi("/api/events", { method: "POST", body: JSON.stringify({ ...data, session_id: match[1] }) });
}

// Session API
export const sessionsApi = {
  list: (params?: { limit?: number; classification?: string }) => {
    const qs = new URLSearchParams();
    if (params?.limit) qs.set("limit", String(params.limit));
    if (params?.classification) qs.set("classification", params.classification);
    return fetchApi<any[]>(`/api/sessions?${qs}`);
  },
  create: (data?: { is_simulated?: string }) => fetchApi<{ session_id: string; user_id: string }>("/api/sessions", { method: "POST", body: JSON.stringify(data || {}) }),
  get: (id: string) => fetchApi<any>(`/api/sessions/${id}`),
  end: (id: string) => fetchApi<any>(`/api/sessions/${id}/end`, { method: "POST" }),
  dashboard: () => fetchApi<any>("/api/sessions/dashboard"),
  compare: (a: string, b: string) => fetchApi<any>(`/api/sessions/compare/${a}/${b}`),
};

// Events API
export const eventsApi = {
  create: (data: any) => fetchApi<any>("/api/events", { method: "POST", body: JSON.stringify(data) }),
  batch: (data: { events: any[] }) => fetchApi<any>("/api/events/batch", { method: "POST", body: JSON.stringify(data) }),
  getBySession: (sessionId: string) => fetchApi<any[]>(`/api/events/session/${sessionId}`),
};

// Automata API
export const automataApi = {
  definitions: () => fetchApi<any>("/api/automata/definitions"),
  processSequence: (events: any[]) => fetchApi<any>("/api/automata/process-sequence", { method: "POST", body: JSON.stringify(events) }),
  generateSequence: (type: string, length?: number) => fetchApi<any>("/api/automata/generate-sequence", { method: "POST", body: JSON.stringify({ sequence_type: type, length }) }),
  counterexample: (events: any[]) => fetchApi<any>("/api/automata/counterexample", { method: "POST", body: JSON.stringify(events) }),
};

// Simulator API
export const simulatorApi = {
  profiles: () => fetchApi<any>("/api/simulator/profiles"),
  run: (data: { profile: string; event_count?: number }) => fetchApi<any>("/api/simulator/run", { method: "POST", body: JSON.stringify(data) }),
  adversarial: (data: { test_type: string; event_count?: number }) => fetchApi<any>("/api/simulator/adversarial", { method: "POST", body: JSON.stringify(data) }),
};

export const experimentsApi = {
  run: (data?: { human_count?: number; bot_count?: number; adversarial_count?: number }) => fetchApi<any>("/api/experiments/run", { method: "POST", body: JSON.stringify(data || {}) }),
};
