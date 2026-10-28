import type { Domain } from '../qloo/types.ts';
import type { Claim, EvidenceRecord, GroundingReport } from './evidence.ts';
import type { ReadMode } from './market.ts';
import type { ScoredTitle } from './scoring.ts';
import type { NetworkRow } from './network.ts';
import type { QlooUsageRow } from './usage.ts';

export interface SlateRequest {
  origin: string;
  destination: string;
  /** Share of passengers modelled by origin taste, 0..1. Default 0.5. */
  originShare?: number;
  catalogue: string;
  familySafeOnly?: boolean;
  /** Earliest release year for suggested (not catalogue) films/TV. */
  recencyYear?: number;
  slots?: Partial<Record<Domain, number>>;
  /** Picked locality names for ambiguous route ends, keyed by the typed text. */
  confirmations?: Record<string, string>;
  autoConfirm?: boolean;
  /** Run the LLM-only comparison when a provider is configured. */
  compare?: boolean;
  /** Optional programming theme ("holiday", "sports"), resolved to a Qloo tag with /v2/tags. */
  theme?: string;
  /** Run the swap test (a second, slate-only run on a different route). Default true. */
  swap?: boolean;
  /** Cap on catalogue titles read (one Qloo search each). */
  maxTitles?: number;
  /** Catalogue lines removed because they looked like personal data (never sent to Qloo or an LLM). */
  droppedPersonalLines?: number;
}

export type TraceEvent =
  | { type: 'start'; mode: 'qloo-live' | 'synthetic-fixture'; llm: string | null; workflow: string; at: string }
  | { type: 'planner'; step: number; action: string; reason: string; args: string; result: string; status: string; evidence?: string }
  | { type: 'step'; id: string; label: string; status: 'run' | 'ok' | 'warn' | 'error'; detail?: string; evidence?: string[]; ms?: number }
  | { type: 'decision'; text: string; evidence?: string[] }
  | { type: 'needs_confirmation'; items: { typed: string; candidates: string[]; options?: { name: string; confidence: number; note?: string }[] }[] }
  | { type: 'result'; result: SlateResult }
  | { type: 'error'; message: string };

export interface EndSummary {
  label: string;
  typed: string;
  localityName: string | null;
  coverage: Record<Domain, number>;
  /** Qloo's own top local entities used as anchors (top 3 per anchor domain). */
  anchors: Record<'artist' | 'tv_show' | 'movie', { id: string; name: string }[]>;
  topTags: { name: string; affinity: number | null; id?: string }[];
}

export interface DomainSlate {
  domain: Domain;
  label: string;
  mode: ReadMode;
  /** Readings per city actually used (2 = consistency-checked; 1 = pinned single read; 0 = none). */
  readings: number;
  slots: number;
  /** 'route' = fit blends both cities. 'single-end' = only one city could be read: ranks are one-city ranks, not route fit. */
  scale: 'route' | 'single-end';
  picks: (ScoredTitle & { momentum?: string; why: Claim[] })[];
  bench: ScoredTitle[];
  /** Below the route-fit floor. */
  cut: ScoredTitle[];
  familyRemoved: ScoredTitle[];
  withheld: { title: string; reason: string }[];
  abstained: string | null;
  separationTau: number | null;
  notes: string[];
}

export interface RailItem {
  title: string;
  domain: Domain;
  end: 'origin' | 'destination';
  affinity: number | null;
  evidence: string[];
}

export interface NetworkFit {
  /** The consistency-checked picks used as seeds, split into reading A and B. */
  seeds: { a: string[]; b: string[] };
  rows: NetworkRow[];
  tau: number | null;
  paired: number;
  abstain: string | null;
  /** Qloo's own top destinations for this slate's audience (reading A), on the network or not. */
  topDestinations: { name: string; affinity: number | null; /** Network code when the destination is a city on the network list, else null. */ code?: string | null }[];
  evidence: string[];
}

export interface Spotlight {
  end: 'origin' | 'destination';
  city: string;
  tag: { id: string; name: string };
  items: RailItem[];
  evidence: string[];
}

export interface ThemeResult {
  query: string;
  tag: { id: string; name: string } | null;
  /** Catalogue titles whose Qloo entity carries the theme tag. */
  catalogueMatches: string[];
  items: RailItem[];
  note: string;
  evidence: string[];
}

export interface BaselineResult {
  id: 'newest' | 'popularity' | 'generic-taste' | 'llm';
  label: string;
  /** One sentence on what this baseline does. */
  description: string;
  /** True when the baseline cannot see the route, so it gives the same slate for every route. */
  routeBlind: boolean;
  picks: Record<string, string[]>;
  inventedTitles: string[];
  /** Share of Seatback's route-scored picks that this baseline also chose. */
  agreement: number;
  /** Mean route fit (Qloo's scale, which Seatback optimises: circular) over picks that have one. */
  meanFit: number | null;
  /** Picks with a route fit, and picks without one (no signal, withheld, or one-city only). */
  scored: number;
  unscored: number;
  disagreements: { title: string; domain: Domain; note: string; evidence: string[] }[];
}

/** One route, one decision that differs between a route-blind baseline and the Qloo-ranked slate. */
export interface WorkedExample {
  baselineId: BaselineResult['id'];
  baselineLabel: string;
  route: string;
  domain: Domain;
  drop: { title: string; rankOrigin: number | null; rankDest: number | null; rankN: number | null; fit: number };
  add: { title: string; rankOrigin: number | null; rankDest: number | null; rankN: number | null; fit: number; side: string };
  /** 'synthetic example' until the run is live. */
  label: string;
  text: string;
}

export interface Comparison {
  provider: string;
  kind: 'llm' | 'naive';
  /** Every baseline that actually ran on this deployment. */
  baselines: BaselineResult[];
  /** Plain statement of what ran (and that no LLM baseline ran, if so). */
  ran: string;
  llmRan: boolean;
  workedExample: WorkedExample | null;
  picks: Record<string, string[]>;
  inventedTitles: string[];
  agreement: number;
  meanFitBaseline: number | null;
  meanFitSeatback: number | null;
  disagreements: { title: string; domain: Domain; note: string; evidence: string[] }[];
  caveat: string;
}

/** The swap test: same catalogue and mix, one end of the route replaced; how many picks change. */
export interface SwapTest {
  ran: boolean;
  /** Why it did not run (shown instead of a number; never a made-up one). */
  reason?: string;
  /** The comparison route, for example "Miami to Denver". */
  against?: string;
  /** The city kept and the city replaced by the comparison city. */
  kept?: string;
  replaced?: string;
  changed?: number;
  total?: number;
  byDomain?: { domain: Domain; label: string; changed: number; total: number }[];
  /** Extra Qloo calls the swap run made (cached calls included). */
  qlooCalls?: number;
  synthetic?: boolean;
  /** The sentence shown on the Answer card. */
  text?: string;
  /** How the comparison city was chosen. */
  basis?: string;
}

/** A match the run could not make with confidence. Never hidden: shown with candidates and confidence. */
export interface Ambiguity {
  kind: 'place' | 'title' | 'theme';
  query: string;
  picked: string | null;
  how: 'user-confirmed' | 'auto-top-candidate' | 'low-confidence-single' | 'provisional-top-candidate';
  candidates: { name: string; confidence: number; note?: string }[];
}

/** Which data the run used and how many Qloo calls it spent. MOCK can never look LIVE. */
export interface QlooStatus {
  mode: 'MOCK' | 'LIVE' | 'DRY-RUN';
  line: string;
  used: number;
  budget: number;
  cached: number;
}

/** How this run was produced. 'agent' wording is only true for kind 'llm-planner'. */
export interface WorkflowInfo {
  kind: 'llm-planner' | 'scripted' | 'planner-fallback';
  /** Plain label shown in the UI and API. */
  label: string;
  planner?: { status: string; steps: number; qlooCalls: number; llm: string };
}

export interface SlateResult {
  version: 1;
  source: 'qloo-live' | 'synthetic-fixture';
  generatedAt: string;
  route: { origin: EndSummary; destination: EndSummary; originShare: number };
  sharedTags: string[];
  domains: DomainSlate[];
  rail: RailItem[];
  network: NetworkFit | null;
  spotlight: Spotlight | null;
  theme: ThemeResult | null;
  /** Judge-facing: every Qloo capability this run used, computed from the evidence ledger. */
  usage: QlooUsageRow[];
  unresolved: { title: string; reason: string }[];
  demographics: { summary: string; evidence: string[] } | null;
  programmerNote: { text: string; evidence: string[]; by: string }[];
  claims: Claim[];
  grounding: GroundingReport;
  comparison: Comparison | null;
  swap: SwapTest | null;
  evidence: EvidenceRecord[];
  metrics: { qlooCalls: number; cachedCalls: number; ms: number };
  limits: string[];
  ambiguities?: Ambiguity[];
  workflow?: WorkflowInfo;
  /** Every planner step: the model's chosen action, stated reason and the Qloo result summary. */
  plannerDecisions?: { step: number; action: string; reason: string; args: string; result: string; status: string; evidence?: string }[];
  /** Qloo calls that failed (e.g. 5xx after retries): the data is missing, not empty. */
  degraded?: { step: string; reason: string }[];
  /** Optional steps skipped to protect the call budget. */
  skipped?: string[];
  qlooStatus?: QlooStatus;
  /** The run's trace, kept so cached examples can replay it. */
  trace: TraceEvent[];
}
