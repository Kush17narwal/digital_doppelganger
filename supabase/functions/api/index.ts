import { createClient } from "npm:@supabase/supabase-js@2";
import { ALPHABET, AUTOMATA } from "../_shared/definitions.ts";
import { advanceMachine, emptyMachine, scoreMachine, stateDistribution } from "../_shared/engine.ts";

function requiredEnv(name: string) {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required Supabase environment value: ${name}`);
  return value;
}

const url = requiredEnv("SUPABASE_URL");
const publicKey = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? requiredEnv("SUPABASE_ANON_KEY");
const secretKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY") ?? requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
const service = createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
const allowedOrigins = (Deno.env.get("CORS_ORIGINS") ?? "*").split(",").map((s) => s.trim()).filter(Boolean);

const headersFor = (origin: string | null) => ({
  "Access-Control-Allow-Origin": origin && (allowedOrigins.includes("*") || allowedOrigins.includes(origin)) ? origin : (allowedOrigins[0] ?? "*"),
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
});
const json = (data: unknown, status = 200, origin: string | null = null) =>
  new Response(JSON.stringify(data), { status, headers: { ...headersFor(origin), "Content-Type": "application/json" } });
const fail = (message: string, status = 400) => Object.assign(new Error(message), { status });
const unwrap = <T>(result: { data: T | null; error: { message: string } | null }): T => {
  if (result.error) throw fail(result.error.message, 400);
  return result.data as T;
};

async function ownerSession(id: string, userId: string) {
  const row = unwrap(await service.from("sessions").select("*").eq("id", id).eq("user_id", userId).maybeSingle());
  if (!row) throw fail("Session not found", 404);
  return row;
}

function toSession(row: Record<string, unknown>, eventCount?: number) {
  return {
    id: row.id, user_id: row.user_id, started_at: row.started_at, ended_at: row.ended_at,
    classification: row.classification ?? "inconclusive", score: row.score ?? 0,
    is_simulated: row.is_simulated, ...(eventCount === undefined ? {} : { event_count: eventCount }),
  };
}

async function createSession(userId: string, isSimulated: string | null = null) {
  unwrap(await service.from("users").upsert({ id: userId }, { onConflict: "id" }));
  return unwrap(await service.from("sessions").insert({ user_id: userId, is_simulated: isSimulated }).select("*").single());
}

async function addEvent(userId: string, payload: Record<string, unknown>) {
  const sessionId = String(payload.session_id ?? "");
  const session = await ownerSession(sessionId, userId);
  if (session.ended_at) throw fail("Session has already ended", 409);
  const machine = { ...emptyMachine(), ...(session.analysis_state ?? {}) };
  const prior = unwrap(await service.from("events").select("sequence_number").eq("session_id", sessionId).order("sequence_number", { ascending: false }).limit(1).maybeSingle());
  const sequence = Number(prior?.sequence_number ?? 0) + 1;
  const event = {
    id: crypto.randomUUID(), session_id: sessionId, event_type: String(payload.event_type ?? "unknown").slice(0, 50),
    timestamp: Number(payload.timestamp ?? Date.now() / 1000), page: payload.page ?? null, target: payload.target ?? null,
    metadata_json: payload.metadata ?? null, sequence_number: sequence,
  };
  if (!Number.isFinite(event.timestamp)) throw fail("Event timestamp must be numeric");
  const processed = advanceMachine(machine, event);
  const inserted = unwrap(await service.from("events").insert({
    ...event, product_state: processed.product_state, is_suspicious: processed.is_suspicious,
    detections: processed.detections,
  }).select("*").single());
  unwrap(await service.from("sessions").update({ analysis_state: machine }).eq("id", sessionId).eq("user_id", userId));
  const stateRows = processed.state_rows.map((row) => ({ ...row, id: crypto.randomUUID(), session_id: sessionId, event_id: inserted.id }));
  unwrap(await service.from("automaton_states").insert(stateRows));
  if (processed.detections.length) {
    unwrap(await service.from("detections").insert(processed.detections.map((reason: string) => ({
      session_id: sessionId, event_id: inserted.id, reason, severity: processed.is_suspicious ? "high" : "medium",
      automaton_type: "product", from_state: JSON.stringify(processed.product_state),
      to_state: JSON.stringify(processed.product_state), input_symbol: processed.symbol,
    }))));
  }
  return {
    event_id: inserted.id, session_id: sessionId, event_type: event.event_type,
    symbol: processed.symbol, timestamp: event.timestamp, page: event.page, target: event.target,
    sequence_number: sequence, product_state: processed.product_state,
    is_suspicious: processed.is_suspicious, detections: processed.detections,
    transitions: processed.transitions,
  };
}

async function listSessions(userId: string, query: URLSearchParams) {
  let request = service.from("sessions").select("*").eq("user_id", userId).order("started_at", { ascending: false });
  const classification = query.get("classification");
  if (classification) request = request.eq("classification", classification);
  const rows = unwrap(await request.range(Number(query.get("offset") ?? 0), Number(query.get("offset") ?? 0) + Math.min(Number(query.get("limit") ?? 50), 100) - 1));
  if (!rows.length) return [];
  const ids = rows.map((r: Record<string, unknown>) => r.id);
  const eventRows = unwrap(await service.from("events").select("session_id").in("session_id", ids));
  const counts = new Map<string, number>();
  eventRows.forEach((r: { session_id: string }) => counts.set(r.session_id, (counts.get(r.session_id) ?? 0) + 1));
  return rows.map((row: Record<string, unknown>) => toSession(row, counts.get(String(row.id)) ?? 0));
}

async function dashboard(userId: string) {
  const sessions = unwrap(await service.from("sessions").select("*").eq("user_id", userId));
  const ids = sessions.map((s: Record<string, unknown>) => s.id);
  const [events, detections] = ids.length ? await Promise.all([
    service.from("events").select("id", { count: "exact", head: true }).in("session_id", ids),
    service.from("detections").select("id", { count: "exact", head: true }).in("session_id", ids),
  ]) : [{ count: 0, error: null }, { count: 0, error: null }];
  if (events.error) throw fail(events.error.message);
  if (detections.error) throw fail(detections.error.message);
  const count = (classification: string) => sessions.filter((s: Record<string, unknown>) => s.classification === classification).length;
  const avg = sessions.length ? sessions.reduce((sum: number, s: Record<string, unknown>) => sum + Number(s.score ?? 0), 0) / sessions.length : 0;
  return {
    total_sessions: sessions.length,
    active_sessions: sessions.filter((s: Record<string, unknown>) => !s.ended_at).length,
    human_like: count("human_like"), automated_like: count("automated_like"),
    suspicious: count("suspicious"), inconclusive: count("inconclusive"),
    average_score: Number(avg.toFixed(1)), total_events: events.count ?? 0,
    total_detections: detections.count ?? 0,
    recent_sessions: sessions.sort((a: Record<string, unknown>, b: Record<string, unknown>) => String(b.started_at).localeCompare(String(a.started_at))).slice(0, 10).map((s: Record<string, unknown>) => toSession(s)),
  };
}

async function sessionDetail(row: Record<string, unknown>, userId: string) {
  const id = String(row.id);
  const [events, states, detections] = await Promise.all([
    service.from("events").select("*").eq("session_id", id).order("sequence_number"),
    service.from("automaton_states").select("*").eq("session_id", id).order("timestamp"),
    service.from("detections").select("*").eq("session_id", id).order("created_at"),
  ]);
  const ev = unwrap(events); const st = unwrap(states); const de = unwrap(detections);
  return {
    ...toSession(row), scoring_breakdown: row.metadata_json?.scoring?.breakdown ?? null,
    events: ev.map((e: Record<string, unknown>) => ({ id: e.id, event_type: e.event_type, timestamp: e.timestamp, page: e.page, target: e.target, sequence_number: e.sequence_number, metadata: e.metadata_json })),
    automaton_states: st.map((s: Record<string, unknown>) => ({ id: s.id, automaton_type: s.automaton_type, state: s.state, previous_state: s.previous_state, input_symbol: s.input_symbol, timestamp: s.timestamp, event_id: s.event_id })),
    detections: de.map((d: Record<string, unknown>) => ({ id: d.id, reason: d.reason, severity: d.severity, automaton_type: d.automaton_type, from_state: d.from_state, to_state: d.to_state, input_symbol: d.input_symbol, created_at: d.created_at, event_id: d.event_id })),
  };
}

function syntheticEvents(profile: string, count: number, pages: string[] = []) {
  const pageList = pages.length ? pages : ["/", "/products", "/products/1", "/search", "/cart", "/checkout"];
  const kinds = ["page_view", "mouse_move", "hover", "mouse_click", "scroll", "key_press", "idle"];
  let timestamp = Date.now() / 1000;
  let previousPage = pageList[0];
  return Array.from({ length: Math.max(1, Math.min(count, 200)) }, (_, i) => {
    let eventType = kinds[Math.floor(Math.random() * kinds.length)];
    let delay = 300 + Math.random() * 2200;
    if (profile === "scripted_bot") { eventType = ["page_view", "mouse_click", "page_view", "mouse_click"][i % 4]; delay = 500; }
    if (profile === "aggressive_bot") { eventType = i % 3 === 0 ? "page_view" : "mouse_click"; delay = 25 + Math.random() * 20; }
    if (profile === "slow_bot") { eventType = ["page_view", "mouse_click"][i % 2]; delay = 1500 + Math.random() * 500; }
    if (profile === "mixed" && i > count / 2) { eventType = i % 2 ? "page_view" : "mouse_click"; delay = 400; }
    const page = eventType === "page_view" ? pageList[i % pageList.length] : previousPage;
    previousPage = page; timestamp += delay / 1000;
    return { event_type: eventType, timestamp, page, target: eventType === "mouse_click" ? `button-${i % 4}` : null };
  });
}

async function simulate(userId: string, profile: string, count: number, pages: string[] = []) {
  const events = syntheticEvents(profile, count, pages);
  const session = await createSession(userId, profile);
  const machine = emptyMachine();
  const eventRows: Record<string, unknown>[] = [];
  const stateRows: Record<string, unknown>[] = [];
  const detectionRows: Record<string, unknown>[] = [];
  let last: Record<string, unknown> | null = null;
  for (const [index, event] of events.entries()) {
    const result = advanceMachine(machine, event);
    const id = crypto.randomUUID();
    last = { ...event, id, session_id: session.id, sequence_number: index + 1, product_state: result.product_state, is_suspicious: result.is_suspicious, detections: result.detections };
    eventRows.push(last);
    stateRows.push(...result.state_rows.map((row) => ({ ...row, id: crypto.randomUUID(), session_id: session.id, event_id: id })));
    detectionRows.push(...result.detections.map((reason: string) => ({ session_id: session.id, event_id: id, reason, severity: result.is_suspicious ? "high" : "medium", automaton_type: "product", from_state: JSON.stringify(result.product_state), to_state: JSON.stringify(result.product_state), input_symbol: result.symbol })));
  }
  const score = scoreMachine(machine);
  const writes = [
    service.from("events").insert(eventRows),
    service.from("automaton_states").insert(stateRows),
    service.from("sessions").update({ ended_at: new Date().toISOString(), classification: score.classification, score: score.automation_score, metadata_json: { scoring: score, state_distribution: stateDistribution(machine), suspicious_counts: score.suspicious_state_counts }, analysis_state: machine }).eq("id", session.id),
  ];
  if (detectionRows.length) writes.push(service.from("detections").insert(detectionRows));
  for (const result of await Promise.all(writes)) if (result.error) throw fail(result.error.message);
  return { session_id: session.id, profile, event_count: events.length, classification: score.classification, score: score.automation_score, scoring_breakdown: score.breakdown, explanations: score.explanations, suspicious_counts: score.suspicious_state_counts, last_state: last };
}

async function route(userId: string, path: string, method: string, body: Record<string, unknown>, query: URLSearchParams) {
  const parts = path.replace(/^\/+|\/+$/g, "").split("/");
  if (path === "/api/health") return { status: "ok", service: "digital-doppelganger-supabase" };
  if (parts[0] === "api" && parts[1] === "sessions") {
    if (parts.length === 2 && method === "POST") {
      const row = await createSession(userId, body.is_simulated ? String(body.is_simulated) : null);
      return { session_id: row.id, user_id: row.user_id };
    }
    if (parts.length === 2 && method === "GET") return await listSessions(userId, query);
    if (parts[2] === "dashboard" && method === "GET") return await dashboard(userId);
    if (parts[2] === "compare" && parts.length === 5 && method === "GET") {
      const a = await ownerSession(parts[3], userId); const b = await ownerSession(parts[4], userId);
      const [ae, be, ad, bd] = await Promise.all([
        service.from("events").select("id", { count: "exact", head: true }).eq("session_id", a.id),
        service.from("events").select("id", { count: "exact", head: true }).eq("session_id", b.id),
        service.from("detections").select("id", { count: "exact", head: true }).eq("session_id", a.id),
        service.from("detections").select("id", { count: "exact", head: true }).eq("session_id", b.id),
      ]);
      for (const result of [ae, be, ad, bd]) if (result.error) throw fail(result.error.message);
      return { session_a: { id: a.id, classification: a.classification, score: a.score, event_count: ae.count ?? 0, detection_count: ad.count ?? 0, is_simulated: a.is_simulated, scoring_breakdown: a.metadata_json?.scoring?.breakdown ?? {} }, session_b: { id: b.id, classification: b.classification, score: b.score, event_count: be.count ?? 0, detection_count: bd.count ?? 0, is_simulated: b.is_simulated, scoring_breakdown: b.metadata_json?.scoring?.breakdown ?? {} } };
    }
    if (parts[2] && parts[3] === "end" && method === "POST") {
      const row = await ownerSession(parts[2], userId);
      const machine = { ...emptyMachine(), ...(row.analysis_state ?? {}) };
      const score = scoreMachine(machine);
      unwrap(await service.from("sessions").update({ ended_at: new Date().toISOString(), classification: score.classification, score: score.automation_score, metadata_json: { scoring: score, state_distribution: stateDistribution(machine), suspicious_counts: score.suspicious_state_counts } }).eq("id", row.id).eq("user_id", userId));
      return score;
    }
    if (parts[2] && parts.length === 3 && method === "GET") return await sessionDetail(await ownerSession(parts[2], userId), userId);
  }
  if (parts[0] === "api" && parts[1] === "events") {
    if (parts.length === 2 && method === "POST") return await addEvent(userId, body);
    if (parts[2] === "batch" && method === "POST") {
      const events = Array.isArray(body.events) ? body.events : [];
      if (events.length > 200) throw fail("A batch can contain at most 200 events");
      const results = [];
      for (const event of events) results.push(await addEvent(userId, event as Record<string, unknown>));
      return { processed: results.length, results };
    }
    if (parts[2] === "session" && parts[3] && method === "GET") {
      await ownerSession(parts[3], userId);
      return unwrap(await service.from("events").select("*").eq("session_id", parts[3]).order("sequence_number")).map((e: Record<string, unknown>) => ({ id: e.id, event_type: e.event_type, timestamp: e.timestamp, page: e.page, target: e.target, metadata: e.metadata_json, sequence_number: e.sequence_number }));
    }
    if (parts[2] === "recent" && method === "GET") {
      const sessionIds = unwrap(await service.from("sessions").select("id").eq("user_id", userId));
      if (!sessionIds.length) return [];
      return unwrap(await service.from("events").select("*").in("session_id", sessionIds.map((s: Record<string, unknown>) => s.id)).order("timestamp", { ascending: false }).limit(20)).map((e: Record<string, unknown>) => ({ ...e, product_state: e.product_state }));
    }
  }
  if (parts[0] === "api" && parts[1] === "automata") {
    if (parts[2] === "definitions" && method === "GET") return { alphabet: ALPHABET, event_mapping: (await import("../_shared/definitions.ts")).EVENT_TO_SYMBOL, automata: AUTOMATA, product_description: "Product Automaton = Navigation × Interaction × Timing × Consistency. The combined state determines the behavioral classification." };
    if (parts[2] === "process-sequence" && method === "POST") {
      const events = Array.isArray(body) ? body : [];
      const machine = emptyMachine(); const results = events.map((event) => advanceMachine(machine, event as Record<string, unknown>));
      return { results: results.map((r, i) => ({ event_type: String(events[i]?.event_type ?? ""), symbol: r.symbol, timestamp: r.timestamp, product_state: r.product_state, is_suspicious: r.is_suspicious, detections: r.detections, transitions: r.transitions.map((t: Record<string, unknown>) => ({ automaton: t.automaton, from: t.from, symbol: t.symbol, to: t.to, suspicious: t.suspicious })) })), final_state: machine.states, suspicious_counts: { ...machine.suspicious, total: Object.values(machine.suspicious).reduce((a, b) => a + b, 0) }, state_distribution: stateDistribution(machine) };
    }
    if (parts[2] === "generate-sequence" && method === "POST") {
      const length = Math.max(1, Math.min(Number(body.length ?? 20), 100));
      const type = String(body.sequence_type ?? "valid");
      let state = "START"; const sequence: string[] = [];
      for (let i = 0; i < length; i++) {
        const table = AUTOMATA[0].transitions[state as keyof typeof AUTOMATA[0]["transitions"]] as Record<string, string> | undefined;
        const choices = Object.entries(table ?? {}).filter(([symbol]) => symbol !== "*");
        if (!choices.length) break;
        const safe = choices.filter(([, next]) => !AUTOMATA[0].suspicious_states.includes(next as never));
        const suspicious = choices.filter(([, next]) => AUTOMATA[0].suspicious_states.includes(next as never));
        const options = type === "suspicious" && suspicious.length ? suspicious : safe.length ? safe : choices;
        const [symbol, next] = options[Math.floor(Math.random() * options.length)];
        sequence.push(symbol); state = next;
      }
      const events = sequence.map((s, i) => ({ event_type: s.toLowerCase(), timestamp: Date.now() / 1000 + i * 0.5 }));
      const machine = emptyMachine(); const states = events.map((e) => { advanceMachine(machine, e); return `(${machine.states.navigation}, ${machine.states.interaction}, ${machine.states.timing}, ${machine.states.consistency})`; });
      return { sequence, expected_states: states, is_accepted: AUTOMATA[0].accepting_states.includes(machine.states.navigation as never), description: type === "valid" ? "A valid sequence that follows expected human-like behavioral patterns." : type === "suspicious" ? "A sequence designed to trigger suspicious state transitions." : "A random sequence that may cause unexpected transitions." };
    }
    if (parts[2] === "counterexample" && method === "POST") {
      const events = Array.isArray(body) ? body : []; const machine = emptyMachine();
      for (const [i, event] of events.entries()) {
        const result = advanceMachine(machine, event as Record<string, unknown>);
        const transition = result.transitions.find((item: Record<string, unknown>) => item.suspicious);
        if (!transition) continue;
        const definition = AUTOMATA.find((a) => a.name === transition.automaton)!;
        const map = definition.transitions[transition.from as keyof typeof definition.transitions] as Record<string, string> | undefined;
        return { found: true, violation_index: i, observed_sequence: machine.symbols, actual_symbol: transition.symbol, expected_symbols: Object.entries(map ?? {}).filter(([s, next]) => s !== "*" && !definition.suspicious_states.includes(next as never)).map(([s]) => s), automaton_state: transition.from, automaton_type: transition.automaton, transition_detail: `δ(${transition.from}, ${transition.symbol}) → ${transition.to} [SUSPICIOUS in ${transition.automaton} automaton]`, explanation: result.detections[0] ?? "Suspicious transition detected." };
      }
      return { found: false, message: "No counterexample found — the sequence appears consistent with expected behavior.", observed_sequence: machine.symbols };
    }
  }
  if (parts[0] === "api" && parts[1] === "simulator") {
    const profiles = [
      { name: "human_like", description: "Irregular timing, varied navigation, occasional idle periods, natural mouse movement" },
      { name: "scripted_bot", description: "Regular timing, deterministic navigation, repeated sequences, minimal idle" },
      { name: "aggressive_bot", description: "Extremely rapid events, repeated clicks, predictable linear navigation" },
      { name: "slow_bot", description: "Randomized timing but deterministic behavior, low interaction diversity" },
      { name: "mixed", description: "Starts human-like, transitions to automated behavior midway" },
    ];
    if (parts[2] === "profiles" && method === "GET") return { profiles };
    if (parts[2] === "run" && method === "POST") {
      const profile = String(body.profile ?? "human_like");
      if (!profiles.some((p) => p.name === profile)) throw fail(`Unknown profile: ${profile}. Available: ${profiles.map((p) => p.name).join(", ")}`);
      return await simulate(userId, profile, Number(body.event_count ?? 50), Array.isArray(body.pages) ? body.pages.map(String) : []);
    }
    if (parts[2] === "adversarial" && method === "POST") {
      const testType = String(body.test_type ?? "human");
      const profile = ({ deterministic: "scripted_bot", randomized: "aggressive_bot", slow: "slow_bot", human_like_scripted: "slow_bot", human: "human_like", mixed: "mixed" } as Record<string, string>)[testType] ?? "human_like";
      const result = await simulate(userId, profile, Number(body.event_count ?? 50));
      const explanation = `The session was classified as ${result.classification.toUpperCase().replaceAll("_", "-")} with a score of ${result.score}/100. ${result.explanations.join(" ")}`;
      return { ...result, test_type: testType, detections: result.explanations, explanation };
    }
  }
  if (parts[0] === "api" && parts[1] === "experiments" && parts[2] === "run" && method === "POST") {
    const humanCount = Math.max(0, Math.min(Number(body.human_count ?? 100), 100));
    const botCount = Math.max(0, Math.min(Number(body.bot_count ?? 100), 100));
    const adversarialCount = Math.max(0, Math.min(Number(body.adversarial_count ?? 100), 100));
    const results: Record<string, Array<{ classification: string; score: number }>> = { human_like: [], scripted_bot: [], aggressive_bot: [], slow_bot: [], mixed: [] };
    const predictions: Array<{ actual_human: boolean; predicted_human: boolean }> = [];
    const configs: Array<[string, number, boolean]> = [["human_like", humanCount, true], ["scripted_bot", Math.ceil(botCount / 2), false], ["aggressive_bot", Math.floor(botCount / 2), false], ["slow_bot", Math.ceil(adversarialCount / 2), false], ["mixed", Math.floor(adversarialCount / 2), false]];
    for (const [profile, count, isHuman] of configs) for (let i = 0; i < count; i++) {
      const machine = emptyMachine(); syntheticEvents(profile, 50).forEach((event) => advanceMachine(machine, event));
      const score = scoreMachine(machine); results[profile].push({ classification: score.classification, score: score.automation_score });
      predictions.push({ actual_human: isHuman, predicted_human: ["human_like", "inconclusive"].includes(score.classification) });
    }
    const tp = predictions.filter((p) => p.actual_human && p.predicted_human).length;
    const tn = predictions.filter((p) => !p.actual_human && !p.predicted_human).length;
    const fp = predictions.filter((p) => !p.actual_human && p.predicted_human).length;
    const fn = predictions.filter((p) => p.actual_human && !p.predicted_human).length;
    const total = tp + tn + fp + fn, precision = tp + fp ? tp / (tp + fp) : 0, recall = tp + fn ? tp / (tp + fn) : 0;
    const perProfile = Object.fromEntries(Object.entries(results).filter(([, rows]) => rows.length).map(([name, rows]) => [name, { count: rows.length, avg_score: Number((rows.reduce((s, r) => s + r.score, 0) / rows.length).toFixed(1)), min_score: Math.min(...rows.map((r) => r.score)), max_score: Math.max(...rows.map((r) => r.score)), classifications: rows.reduce((m, r) => ({ ...m, [r.classification]: (m[r.classification] ?? 0) + 1 }), {} as Record<string, number>) }]));
    return { total_sessions: total, accuracy: total ? (tp + tn) / total : 0, precision, recall, f1_score: precision + recall ? 2 * precision * recall / (precision + recall) : 0, false_positive_rate: fp + tn ? fp / (fp + tn) : 0, false_negative_rate: fn + tp ? fn / (fn + tp) : 0, confusion_matrix: { true_positive: tp, true_negative: tn, false_positive: fp, false_negative: fn }, per_profile: perProfile, disclaimer: "These results apply to the synthetic/test dataset only and do not establish real-world bot-detection accuracy." };
  }
  throw fail("Endpoint not found", 404);
}

Deno.serve(async (request) => {
  const origin = request.headers.get("Origin");
  if (request.method === "OPTIONS") return new Response("ok", { headers: headersFor(origin) });
  if (origin && !allowedOrigins.includes("*") && !allowedOrigins.includes(origin)) return json({ error: "Origin is not allowed" }, 403, origin);
  try {
    const authorization = request.headers.get("Authorization");
    if (!authorization) throw fail("Authentication required", 401);
    const identity = createClient(url, publicKey, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false, autoRefreshToken: false } });
    const { data: { user }, error } = await identity.auth.getUser();
    if (error || !user) throw fail("Invalid or expired session", 401);
    const input = await request.json();
    const path = String(input.path ?? "/");
    const method = String(input.method ?? "GET").toUpperCase();
    const urlPath = new URL(path, "https://local.invalid");
    const body = input.body && typeof input.body === "object" ? input.body as Record<string, unknown> : {};
    return json(await route(user.id, urlPath.pathname, method, body, urlPath.searchParams), 200, origin);
  } catch (error) {
    const status = Number((error as { status?: number }).status ?? 500);
    const message = error instanceof Error ? error.message : "Unexpected server error";
    if (status >= 500) console.error(message);
    return json({ detail: message }, status, origin);
  }
});
