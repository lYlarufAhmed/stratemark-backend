/**
 * Electron IPC / preload contract — the drop-in target for the real back end.
 *
 * When we go desktop, Electron's main process implements MarketIntelRepository
 * against SQLite/Drizzle and exposes it through a `contextBridge` preload as
 * `window.mi`. The renderer's IpcRepository (see apps/web) simply forwards to
 * `window.mi`. Defining the surface here now means the back end has an exact,
 * type-checked target and the renderer never touches Node or IPC details.
 */
import type {
  DeckRefreshListener,
  MarketIntelRepository,
  ResearchProgress,
  Unsubscribe,
} from './repository';

export interface ResearchProgressEvent {
  requestId: string;
  progress: ResearchProgress;
}

export type ResearchProgressListener = (event: ResearchProgressEvent) => void;

/**
 * The API surface exposed on `window.mi` by the Electron preload script.
 * Identical to the repository, except event subscriptions are expressed as
 * plain callback registrations (the preload adapts ipcRenderer events to them).
 */
export type PreloadRepositoryApi = Omit<
  MarketIntelRepository,
  'subscribeDeckRefresh' | 'createResearchedDeck'
> & {
  createResearchedDeck(
    brief: Parameters<MarketIntelRepository['createResearchedDeck']>[0],
    requestId: string,
  ): ReturnType<MarketIntelRepository['createResearchedDeck']>;
  onDeckRefresh(listener: DeckRefreshListener): Unsubscribe;
  onResearchProgress(listener: ResearchProgressListener): Unsubscribe;
  googleSignIn?(): Promise<{ id: string; name: string; email: string | null; photoURL?: string | null } | null>;
  googleSignOut?(): Promise<void>;
  onAuthCallback?(listener: (data: { token?: string; user?: Record<string, unknown> }) => void): Unsubscribe;
};

/** Canonical IPC channel names (used by both preload and main). */
export const IPC_CHANNELS = {
  listMarkets: 'mi:listMarkets',
  getMarket: 'mi:getMarket',
  createMarket: 'mi:createMarket',
  updateMarketCadence: 'mi:updateMarketCadence',
  getDeckByMarket: 'mi:getDeckByMarket',
  refreshDeck: 'mi:refreshDeck',
  createResearchedDeck: 'mi:createResearchedDeck',
  listCards: 'mi:listCards',
  getCard: 'mi:getCard',
  listSavedCards: 'mi:listSavedCards',
  saveCard: 'mi:saveCard',
  unsaveCard: 'mi:unsaveCard',
  getCompany: 'mi:getCompany',
  getCompanyMetrics: 'mi:getCompanyMetrics',
  getViceClaims: 'mi:getViceClaims',
  getDashboardTab: 'mi:getDashboardTab',
  deepDive: 'mi:deepDive',
  factCheck: 'mi:factCheck',
  generateReport: 'mi:generateReport',
  listReports: 'mi:listReports',
  getReport: 'mi:getReport',
  expandDeck: 'mi:expandDeck',
  overrideMetric: 'mi:overrideMetric',
  getMarketOpportunity: 'mi:getMarketOpportunity',
  askResearch: 'mi:askResearch',
  listResearchThreads: 'mi:listResearchThreads',
  getResearchThread: 'mi:getResearchThread',
  saveThreadAsReport: 'mi:saveThreadAsReport',
  listResearchJobs: 'mi:listResearchJobs',
  getResearchJob: 'mi:getResearchJob',
  cancelResearchJob: 'mi:cancelResearchJob',
  resumeResearchJob: 'mi:resumeResearchJob',
  googleSignIn: 'mi:googleSignIn',
  googleSignOut: 'mi:googleSignOut',
  authCallbackEvent: 'mi:authCallbackEvent',
  deckRefreshEvent: 'mi:deckRefreshEvent',
  researchProgressEvent: 'mi:researchProgressEvent',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

/** Secure key storage channels (Electron main uses the OS keychain via safeStorage). */
export const SECURE_CHANNELS = {
  getApiKey: 'mi:secure:getApiKey',
  setApiKey: 'mi:secure:setApiKey',
  googleSignIn: 'mi:secure:googleSignIn',
  googleSignOut: 'mi:secure:googleSignOut',
} as const;

/** Exposed on `window.miSecure` in the Electron shell; undefined on the web. */
export interface SecureApi {
  getApiKey(): Promise<string>;
  setApiKey(key: string): Promise<void>;
  googleSignIn?(): Promise<{ id: string; name: string; email: string | null; photoURL?: string | null } | null>;
  googleSignOut?(): Promise<void>;
}

declare global {
  interface Window {
    /** Present only inside the Electron shell; undefined in the plain web build. */
    mi?: PreloadRepositoryApi;
    /** OS-keychain-backed key storage; present only in the Electron shell. */
    miSecure?: SecureApi;
  }
}
