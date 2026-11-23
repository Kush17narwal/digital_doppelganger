import { AUTOMATA, EVENT_TO_SYMBOL } from "./definitions.ts";

type MachineState = {
  states: Record<string, string>;
  suspicious: Record<string, number>;
  symbols: string[];
  delays: number[];
  snapshots: Array<Record<string, string>>;
  lastTimestamp: number | null;
};

export function emptyMachine(): MachineState {
  return {
    states: Object.fromEntries(AUTOMATA.map((a) => [a.name, a.start_state])),
    suspicious: Object.fromEntries(AUTOMATA.map((a) => [a.name, 0])),
    symbols: [], delays: [], snapshots: [], lastTimestamp: null,
  };
}

function entropy(items: string[]): number {
  if (!items.length) return 0;
  const counts = new Map<string, number>();
  items.forEach((item) => counts.set(item, (counts.get(item) ?? 0) + 1));
  return [...counts.values()].reduce((sum, count) => {
    const p = count / items.length;
    return sum - p * Math.log2(p);
  }, 0);
}

function repeatedNgramRatio(items: string[], n: number): number {
  if (items.length < n) return 0;
  const counts = new Map<string, number>();
  for (let i = 0; i <= items.length - n; i++) {
    const gram = items.slice(i, i + n).join("|");
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  const values = [...counts.values()];
  return values.length ? values.filter((count) => count > 1).length / values.length : 0;
}

function consistencySymbol(symbols: string[]): string {
  if (symbols.length < 3) return "CONSISTENT";
  const e = entropy(symbols);
  const diversity = new Set(symbols).size / symbols.length;
  const repetition = repeatedNgramRatio(symbols, 3);
  if (repetition > 0.6) return "REPETITIVE";
  if (e < 1) return "LOW_ENTROPY";
  if (diversity > 0.5 && e > 2) return "HIGH_ENTROPY";
  if (diversity > 0.5) return "DIVERSE";
  return "CONSISTENT";
}

function transition(machine: MachineState, name: string, symbol: string, timestamp: number) {
  const definition = AUTOMATA.find((a) => a.name === name)!;
  const from = machine.states[name];
  const table = definition.transitions[from as keyof typeof definition.transitions] as Record<string, string> | undefined;
  const to = table?.[symbol] ?? table?.["*"] ?? from;
  machine.states[name] = to;
  const isSuspicious = (definition.suspicious_states as readonly string[]).includes(to);
  if (isSuspicious) machine.suspicious[name] += 1;
  return {
    automaton_type: name, from_state: from, input_symbol: symbol,
    to_state: to, timestamp, is_suspicious: isSuspicious,
    detection_reason: isSuspicious
      ? `Automaton '${name}' entered suspicious state '${to}' via δ(${from}, ${symbol})`
      : null,
  };
}

export function advanceMachine(machine: MachineState, event: Record<string, unknown>) {
  const eventType = String(event.event_type ?? "");
  const timestamp = Number(event.timestamp ?? Date.now() / 1000);
  const symbol = EVENT_TO_SYMBOL[eventType] ?? eventType.toUpperCase();
  machine.symbols.push(symbol);
  const transitions = [
    transition(machine, "navigation", symbol, timestamp),
    transition(machine, "interaction", symbol, timestamp),
  ];

  let timingSymbol = "NORMAL";
  if (machine.lastTimestamp !== null) {
    const delay = (timestamp - machine.lastTimestamp) * 1000;
    machine.delays.push(delay);
    if (delay < 50) timingSymbol = "VERY_FAST";
    else if (delay < 150) timingSymbol = "FAST";
    else if (delay < 2000) timingSymbol = "NORMAL";
    else if (delay < 10000) timingSymbol = "SLOW";
    else timingSymbol = "VERY_SLOW";

    if (machine.delays.length >= 5) {
      const sample = machine.delays.slice(-5);
      const mean = sample.reduce((a, b) => a + b, 0) / sample.length;
      const std = Math.sqrt(sample.reduce((sum, value) => sum + (value - mean) ** 2, 0) / sample.length);
      transition(machine, "timing", std < 30 ? "REGULAR" : "IRREGULAR", timestamp);
    }
  }
  transitions.push(transition(machine, "timing", timingSymbol, timestamp));
  machine.lastTimestamp = timestamp;
  transitions.push(transition(machine, "consistency", consistencySymbol(machine.symbols.slice(-10)), timestamp));

  const productState = { ...machine.states };
  machine.snapshots.push(productState);
  const detections = transitions.flatMap((item) => item.detection_reason ? [item.detection_reason] : []);
  return {
    symbol, timestamp, product_state: productState,
    is_suspicious: transitions.some((item) => item.is_suspicious),
    detections,
    transitions: transitions.map((item) => ({
      automaton: item.automaton_type, from: item.from_state, symbol: item.input_symbol,
      to: item.to_state, suspicious: item.is_suspicious,
    })),
    state_rows: transitions.map((item) => ({
      automaton_type: item.automaton_type, state: item.to_state,
      previous_state: item.from_state, input_symbol: item.input_symbol, timestamp,
    })),
  };
}

export function scoreMachine(machine: MachineState) {
  const symbols = machine.symbols;
  const distributions: Record<string, Record<string, number>> = Object.fromEntries(
    AUTOMATA.map((a) => [a.name, {}]),
  );
  for (const snapshot of machine.snapshots) {
    for (const automaton of AUTOMATA) {
      const state = snapshot[automaton.name];
      distributions[automaton.name][state] = (distributions[automaton.name][state] ?? 0) + 1;
    }
  }

  const breakdown: Record<string, number> = {};
  const explanations: string[] = [];
  const delays = machine.delays;
  let timingScore = 50;
  if (delays.length >= 3) {
    const mean = delays.reduce((a, b) => a + b, 0) / delays.length;
    const std = Math.sqrt(delays.reduce((sum, value) => sum + (value - mean) ** 2, 0) / delays.length);
    const cv = mean > 0 ? std / mean : 0;
    timingScore = cv < 0.1 ? 95 : cv < 0.3 ? 75 : cv < 0.5 ? 50 : cv < 1 ? 25 : 10;
    const sorted = [...delays].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (median < 50) { timingScore = Math.min(100, timingScore + 30); explanations.push(`Median inter-event time is ${median.toFixed(0)}ms (impossibly fast for humans).`); }
    else if (median < 150) timingScore = Math.min(100, timingScore + 15);
    if (!explanations.length && cv < 0.3) explanations.push(`Timing is suspiciously regular (CV=${cv.toFixed(3)}).`);
  }
  breakdown.timing_regularity = timingScore;

  const navStates = machine.snapshots.map((s) => s.navigation);
  const navEntropy = entropy(navStates);
  const uniqueNav = new Set(navStates).size;
  let navScore = uniqueNav ? Math.max(0, 100 - (navEntropy / Math.log2(Math.max(uniqueNav, 1))) * 100) : 50;
  if (machine.suspicious.navigation > 2) navScore = Math.min(100, navScore + 15);
  if (navScore > 70) explanations.push(`Navigation entropy is low (${navEntropy.toFixed(2)} bits). Only ${uniqueNav} unique navigation states visited.`);
  breakdown.navigation_diversity = navScore;

  const diversityRatio = symbols.length ? new Set(symbols).size / symbols.length : 0;
  const interactionStates = Object.keys(distributions.interaction).length;
  let interactionScore = !symbols.length ? 50 : diversityRatio < 0.1 ? 90 : diversityRatio < 0.2 ? 70 : diversityRatio < 0.3 ? 50 : diversityRatio < 0.5 ? 30 : 10;
  interactionScore = Math.min(100, interactionScore + (interactionStates <= 2 ? 20 : interactionStates <= 4 ? 10 : 0));
  if (interactionScore > 70) explanations.push(`Only ${new Set(symbols).size} unique event types in ${symbols.length} events. Interaction diversity is very low.`);
  breakdown.interaction_diversity = interactionScore;

  const rep3 = repeatedNgramRatio(symbols, 3);
  const rep5 = repeatedNgramRatio(symbols, 5);
  let repetitionScore = symbols.length < 6 ? 50 : Math.min(100, rep3 * 80 + rep5 * 60);
  const ngramCounts = new Map<string, number>();
  for (let n = 4; n < Math.min(8, symbols.length); n++) for (let i = 0; i <= symbols.length - n; i++) {
    const gram = symbols.slice(i, i + n).join(" → "); ngramCounts.set(gram, (ngramCounts.get(gram) ?? 0) + 1);
  }
  const maxRepeat = Math.max(1, ...ngramCounts.values());
  if (maxRepeat > 5) repetitionScore = Math.min(100, repetitionScore + 25);
  if (repetitionScore > 60) explanations.push(`3-gram repetition rate: ${(rep3 * 100).toFixed(0)}%.`);
  breakdown.repetition = repetitionScore;

  const idleRatio = symbols.length ? symbols.filter((s) => s === "IDLE").length / symbols.length : 0;
  const slowRatio = delays.length ? delays.filter((d) => d > 2000).length / delays.length : 0;
  const combinedIdle = (idleRatio + slowRatio) / 2;
  const idleScore = !symbols.length ? 50 : combinedIdle < 0.01 ? 85 : combinedIdle < 0.05 ? 60 : combinedIdle < 0.15 ? 20 : 10;
  if (idleScore === 85) explanations.push("No idle periods detected. Sessions without pauses are unusual for humans.");
  breakdown.idle_behavior = idleScore;

  const cons = distributions.consistency;
  const consTotal = Object.values(cons).reduce((a, b) => a + b, 0);
  const suspiciousVisits = ["HIGHLY_REPETITIVE", "LOW_ENTROPY", "SUSPICIOUS_CONSISTENCY"].reduce((sum, state) => sum + (cons[state] ?? 0), 0);
  const humanVisits = ["HUMAN_CONSISTENT", "HIGH_ENTROPY", "DIVERSE"].reduce((sum, state) => sum + (cons[state] ?? 0), 0);
  const susRatio = suspiciousVisits / Math.max(consTotal, 1);
  const humanRatio = humanVisits / Math.max(consTotal, 1);
  const consistencyScore = consTotal ? Math.min(100, Math.max(0, (susRatio - humanRatio + 0.5) * 100)) : 50;
  if (susRatio > 0.3) explanations.push(`Consistency automaton was in suspicious states ${suspiciousVisits}/${consTotal} times (${(susRatio * 100).toFixed(0)}%).`);
  breakdown.sequence_consistency = consistencyScore;

  const weights: Record<string, number> = { timing_regularity: 0.2, navigation_diversity: 0.2, interaction_diversity: 0.2, repetition: 0.15, idle_behavior: 0.1, sequence_consistency: 0.15 };
  const automationScore = Math.min(100, Math.max(0, Object.entries(weights).reduce((sum, [key, weight]) => sum + breakdown[key] * weight, 0)));
  const suspiciousTotal = Object.values(machine.suspicious).reduce((a, b) => a + b, 0);
  const suspicionScore = Math.min(100, suspiciousTotal / (Math.max(machine.snapshots.length, 1) * 4) * 200);
  const classification = automationScore >= 70 || suspicionScore >= 60 ? "automated_like" : automationScore >= 45 || suspicionScore >= 35 ? "suspicious" : automationScore <= 30 && suspicionScore <= 20 ? "human_like" : "inconclusive";
  return {
    automation_score: Number(automationScore.toFixed(1)),
    human_score: Number((100 - automationScore).toFixed(1)),
    suspicion_score: Number(suspicionScore.toFixed(1)), classification,
    breakdown: Object.fromEntries(Object.entries(breakdown).map(([key, value]) => [key, Number(value.toFixed(1))])),
    weights, explanations,
    suspicious_state_counts: { ...machine.suspicious, total: suspiciousTotal },
  };
}

export function stateDistribution(machine: MachineState) {
  const result: Record<string, Record<string, number>> = Object.fromEntries(AUTOMATA.map((a) => [a.name, {}]));
  for (const snapshot of machine.snapshots) for (const a of AUTOMATA) {
    const state = snapshot[a.name]; result[a.name][state] = (result[a.name][state] ?? 0) + 1;
  }
  return result;
}
