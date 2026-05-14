import {
  Action,
  ActionPanel,
  Alert,
  List,
  LocalStorage,
  Toast,
  confirmAlert,
  getPreferenceValues,
  showToast,
} from "@raycast/api";
import React from "react";

const OPENROUTER_API_BASE_URL = "https://openrouter.ai/api/v1";
const ARTIFICIAL_ANALYSIS_API_BASE_URL = "https://artificialanalysis.ai/api/v2";
const LOG_PREFIX = "[Model Info]";
const MAX_LOGGED_RESPONSE_BODY_LENGTH = 2_000;
const LOOKUP_HISTORY_STORAGE_KEY = "model-lookup-history";
const INTELLIGENCE_INDEX_CACHE_STORAGE_KEY = "intelligence-index-cache";
const MAX_LOOKUP_HISTORY_ENTRIES = 25;

type Preferences = {
  openRouterApiKey?: string;
  artificialAnalysisApiKey?: string;
};

type PercentileStats = {
  p50: number;
  p75: number;
  p90: number;
  p99: number;
};

type OpenRouterEndpoint = {
  name: string;
  provider_name: string;
  tag?: string;
  throughput_last_30m: PercentileStats | null;
};

type OpenRouterEndpointResponse = {
  data: {
    id: string;
    name: string;
    endpoints: OpenRouterEndpoint[];
  };
};

type OpenRouterModel = {
  id: string;
  canonical_slug?: string;
  name: string;
  links?: {
    details?: string;
  };
};

type OpenRouterModelsResponse = {
  data: OpenRouterModel[];
};

type ArtificialAnalysisModel = {
  id: string;
  name: string;
  slug: string;
  model_creator?: {
    id: string;
    name: string;
    slug?: string;
  };
  evaluations?: {
    artificial_analysis_intelligence_index?: number | null;
  };
};

type ArtificialAnalysisModelsResponse = {
  status: number;
  data: ArtificialAnalysisModel[];
};

type IntelligenceIndexEntry = {
  label: string;
  score: number;
};

type IntelligenceIndexResult = {
  entries: IntelligenceIndexEntry[];
  note: string;
};

type LookupResult = {
  modelId: string;
  modelName?: string;
  endpoints?: OpenRouterEndpoint[];
  throughputError?: string;
  intelligenceIndex?: IntelligenceIndexResult;
};

type LookupState =
  | { status: "idle" }
  | {
      status: "loading";
      query: string;
      result?: LookupResult;
      hasApiKey: boolean;
      requestId: number;
    }
  | { status: "success"; result: LookupResult; hasApiKey: boolean }
  | { status: "error"; message: string };

type LookupHistoryEntry = {
  modelId: string;
  modelName?: string;
  lastQuery: string;
  updatedAt: number;
};

type IntelligenceIndexCacheEntry = {
  modelId: string;
  result: IntelligenceIndexResult;
  updatedAt: number;
};

type IntelligenceIndexCache = Record<string, IntelligenceIndexCacheEntry>;

type LookUpModelOptions = {
  fetchThroughput: boolean;
  fetchIntelligenceIndex: boolean;
  forceRefreshIntelligenceIndex?: boolean;
};

export default function ModelInfo() {
  const [model, setModel] = React.useState("");
  const [lookup, setLookup] = React.useState<LookupState>({ status: "idle" });
  const [history, setHistory] = React.useState<LookupHistoryEntry[]>([]);
  const [intelligenceIndexCache, setIntelligenceIndexCache] =
    React.useState<IntelligenceIndexCache>({});
  const lookupRequestId = React.useRef(0);

  React.useEffect(() => {
    void loadLookupHistory().then(setHistory);
    void loadIntelligenceIndexCache().then(setIntelligenceIndexCache);
  }, []);

  const upsertHistory = React.useCallback(
    (entry: Omit<LookupHistoryEntry, "updatedAt">) => {
      setHistory((currentHistory) => {
        const nextHistory = upsertLookupHistoryEntry(currentHistory, entry);
        void saveLookupHistory(nextHistory);
        return nextHistory;
      });
    },
    [],
  );

  const fetchModelStats = async (
    queryOverride: string | undefined,
    options: LookUpModelOptions,
  ) => {
    const query = (queryOverride ?? model).trim();
    if (!query) return;

    const preferences = getPreferenceValues<Preferences>();
    const apiKey = preferences.openRouterApiKey?.trim();
    const artificialAnalysisApiKey =
      preferences.artificialAnalysisApiKey?.trim();

    console.info(`${LOG_PREFIX} Starting model lookup`, {
      query,
      hasOpenRouterApiKey: Boolean(apiKey),
      hasArtificialAnalysisApiKey: Boolean(artificialAnalysisApiKey),
      fetchThroughput: options.fetchThroughput,
      fetchIntelligenceIndex: options.fetchIntelligenceIndex,
      forceRefreshIntelligenceIndex: Boolean(
        options.forceRefreshIntelligenceIndex,
      ),
    });

    if (!apiKey) {
      const message =
        "OpenRouter API key is required because throughput stats are only returned for authenticated requests.";
      console.error(`${LOG_PREFIX} Missing OpenRouter API key`, { query });
      setLookup({ status: "error", message });
      await showToast({
        style: Toast.Style.Failure,
        title: "OpenRouter API Key Required",
        message,
      });
      return;
    }

    const requestId = lookupRequestId.current + 1;
    lookupRequestId.current = requestId;
    setLookup({
      status: "loading",
      query,
      hasApiKey: Boolean(apiKey),
      requestId,
    });

    const toast = await showToast({
      style: Toast.Style.Animated,
      title: "Fetching Model Data",
    });

    try {
      const modelId = await resolveModelId(query, apiKey);
      if (lookupRequestId.current !== requestId) return;

      const cachedIntelligenceIndex = intelligenceIndexCache[modelId]?.result;

      setLookup({
        status: "loading",
        query,
        result: { modelId, intelligenceIndex: cachedIntelligenceIndex },
        hasApiKey: Boolean(apiKey),
        requestId,
      });

      const updateLoadingResult = (
        update: (result: LookupResult) => LookupResult,
      ) => {
        setLookup((currentLookup) => {
          if (
            currentLookup.status !== "loading" ||
            currentLookup.requestId !== requestId ||
            !currentLookup.result
          ) {
            return currentLookup;
          }

          return {
            ...currentLookup,
            result: update(currentLookup.result),
          };
        });
      };

      let throughputResult:
        | Awaited<ReturnType<typeof fetchModelThroughput>>
        | undefined;
      let intelligenceIndexResult: IntelligenceIndexResult | undefined;
      let intelligenceIndexError: Error | undefined;

      if (options.fetchThroughput) {
        try {
          throughputResult = await fetchModelThroughput(modelId, apiKey);

          updateLoadingResult((currentResult) => ({
            ...currentResult,
            modelName: throughputResult?.modelName,
            endpoints: throughputResult?.endpoints,
          }));

          console.info(`${LOG_PREFIX} Model throughput lookup succeeded`, {
            query,
            modelId: throughputResult.modelId,
            modelName: throughputResult.modelName,
            endpointCount: throughputResult.endpoints.length,
            endpointsWithThroughputCount: throughputResult.endpoints.filter(
              (endpoint) => endpoint.throughput_last_30m,
            ).length,
          });
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : "Failed to look up model throughput.";
          console.error(`${LOG_PREFIX} Model throughput lookup failed`, {
            query,
            modelId,
            message,
            error,
          });
          updateLoadingResult((currentResult) => ({
            ...currentResult,
            throughputError: message,
          }));
        }
      }

      if (options.fetchIntelligenceIndex) {
        try {
          intelligenceIndexResult = await fetchIntelligenceIndex(
            query,
            modelId,
            throughputResult?.modelName,
            artificialAnalysisApiKey,
            { forceRefresh: options.forceRefreshIntelligenceIndex },
          );

          updateLoadingResult((currentResult) => ({
            ...currentResult,
            intelligenceIndex: intelligenceIndexResult,
          }));

          if (artificialAnalysisApiKey) {
            setIntelligenceIndexCache((currentCache) =>
              upsertIntelligenceIndexCacheEntry(
                currentCache,
                modelId,
                intelligenceIndexResult,
              ),
            );
          }

          console.info(`${LOG_PREFIX} Intelligence Index lookup completed`, {
            query,
            modelId,
            intelligenceIndexEntryCount: intelligenceIndexResult.entries.length,
          });
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : "Artificial Analysis Intelligence Index lookup failed.";
          intelligenceIndexError = new Error(message);

          updateLoadingResult((currentResult) => ({
            ...currentResult,
            intelligenceIndex: {
              entries: [],
              note: message,
            },
          }));
        }
      }

      if (lookupRequestId.current !== requestId) return;

      if (!isRateLimitError(intelligenceIndexError)) {
        upsertHistory({
          modelId: throughputResult?.modelId ?? modelId,
          modelName: throughputResult?.modelName,
          lastQuery: query,
        });
      }

      setLookup((currentLookup) => {
        if (
          currentLookup.status !== "loading" ||
          currentLookup.requestId !== requestId ||
          !currentLookup.result
        ) {
          return currentLookup;
        }

        return {
          status: "success",
          result: currentLookup.result,
          hasApiKey: currentLookup.hasApiKey,
        };
      });

      toast.style = Toast.Style.Success;
      toast.title = "Data Fetched";
      if (isRateLimitError(intelligenceIndexError)) {
        toast.style = Toast.Style.Failure;
        toast.title = "Intelligence Index Rate Limited";
        toast.message = intelligenceIndexError.message;
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to look up model throughput.";
      console.error(`${LOG_PREFIX} Model lookup failed`, {
        query,
        message,
        error,
      });
      setLookup({ status: "error", message });
      toast.style = Toast.Style.Failure;
      toast.title = "Lookup Failed";
      toast.message = message;
    }
  };

  const fetchThroughput = (queryOverride?: string) =>
    fetchModelStats(queryOverride, {
      fetchThroughput: true,
      fetchIntelligenceIndex: false,
    });

  const fetchIntelligenceIndexOnly = (queryOverride?: string) =>
    fetchModelStats(queryOverride, {
      fetchThroughput: false,
      fetchIntelligenceIndex: true,
      forceRefreshIntelligenceIndex: true,
    });

  const fetchAllStats = (queryOverride?: string) =>
    fetchModelStats(queryOverride, {
      fetchThroughput: true,
      fetchIntelligenceIndex: true,
      forceRefreshIntelligenceIndex: true,
    });

  const removeModelFromHistory = async (entry: LookupHistoryEntry) => {
    const confirmed = await confirmAlert({
      title: "Remove model from history?",
      message: entry.modelName ?? entry.modelId,
      primaryAction: {
        title: "Remove model from history",
        style: Alert.ActionStyle.Destructive,
      },
    });
    if (!confirmed) return;

    setHistory((currentHistory) => {
      const nextHistory = currentHistory.filter(
        (historyEntry) => historyEntry.modelId !== entry.modelId,
      );
      void saveLookupHistory(nextHistory);
      return nextHistory;
    });
    setIntelligenceIndexCache((currentCache) => {
      const nextCache = removeIntelligenceIndexCacheEntry(
        currentCache,
        entry.modelId,
      );
      void saveIntelligenceIndexCache(nextCache);
      return nextCache;
    });
  };

  const clearWholeHistory = async () => {
    const confirmed = await confirmAlert({
      title: "Clear whole history?",
      message:
        "This will remove every model from history and clear cached Intelligence Index results.",
      primaryAction: {
        title: "Clear whole history",
        style: Alert.ActionStyle.Destructive,
      },
    });
    if (!confirmed) return;

    setHistory([]);
    setIntelligenceIndexCache({});
    await LocalStorage.removeItem(LOOKUP_HISTORY_STORAGE_KEY);
    await LocalStorage.removeItem(INTELLIGENCE_INDEX_CACHE_STORAGE_KEY);
  };

  const hasSearchText = model.trim().length > 0;
  const activeResult = getActiveLookupResult(lookup);
  const activeHistoryModelId = activeResult?.modelId;
  const activeLookupMatchesSearch = activeResult
    ? isLookupResultMatch(activeResult, model)
    : false;
  const filteredHistory = getFilteredHistory(history, model);

  return (
    <List
      searchText={model}
      isLoading={lookup.status === "loading"}
      isShowingDetail
      filtering={false}
      onSearchTextChange={setModel}
      throttle={false}
      navigationTitle="Model Info"
      searchBarPlaceholder="Enter an OpenRouter model, e.g. gpt-5.5"
      actions={
        <ActionPanel>
          <Action
            title="Fetch all stats"
            onAction={() => void fetchAllStats()}
          />
        </ActionPanel>
      }
    >
      {hasSearchText ? (
        <List.Item
          id="lookup-current-search"
          title="Look Up"
          subtitle={model.trim()}
          detail={
            activeLookupMatchesSearch ? (
              <List.Item.Detail markdown={getDetailMarkdown(lookup)} />
            ) : undefined
          }
          actions={getLookupActions(
            () => void fetchThroughput(),
            () => void fetchIntelligenceIndexOnly(),
            () => void fetchAllStats(),
          )}
        />
      ) : null}
      {filteredHistory.map((entry) => (
        <List.Item
          key={entry.modelId}
          id={entry.modelId}
          title={entry.modelName ?? entry.modelId}
          subtitle={entry.modelId}
          detail={
            activeHistoryModelId === entry.modelId ? (
              <List.Item.Detail markdown={getDetailMarkdown(lookup)} />
            ) : (
              <List.Item.Detail
                markdown={getHistoryDetailMarkdown(
                  intelligenceIndexCache[entry.modelId]?.result,
                )}
              />
            )
          }
          actions={getHistoryActions(
            () => void fetchThroughput(entry.modelId),
            () => void fetchIntelligenceIndexOnly(entry.modelId),
            () => void fetchAllStats(entry.modelId),
            () => void removeModelFromHistory(entry),
            () => void clearWholeHistory(),
          )}
        />
      ))}
    </List>
  );
}

function getLookupActions(
  fetchThroughput: () => void,
  fetchIntelligenceIndex: () => void,
  fetchAllStats: () => void,
): React.ReactElement {
  return (
    <ActionPanel>
      <Action title="Fetch throughput" onAction={fetchThroughput} />
      <Action
        title="Fetch intelligence index"
        onAction={fetchIntelligenceIndex}
      />
      <Action title="Fetch all stats" onAction={fetchAllStats} />
    </ActionPanel>
  );
}

function getHistoryActions(
  fetchThroughput: () => void,
  fetchIntelligenceIndex: () => void,
  fetchAllStats: () => void,
  removeModelFromHistory: () => void,
  clearWholeHistory: () => void,
): React.ReactElement {
  return (
    <ActionPanel>
      <Action title="Fetch throughput" onAction={fetchThroughput} />
      <Action
        title="Fetch intelligence index"
        onAction={fetchIntelligenceIndex}
      />
      <Action title="Fetch all stats" onAction={fetchAllStats} />
      <ActionPanel.Section title="Remove">
        <Action
          title="Remove model from history"
          style={Action.Style.Destructive}
          onAction={removeModelFromHistory}
        />
        <Action
          title="Clear whole history"
          style={Action.Style.Destructive}
          onAction={clearWholeHistory}
        />
      </ActionPanel.Section>
    </ActionPanel>
  );
}

function getActiveLookupResult(lookup: LookupState): LookupResult | undefined {
  if (lookup.status === "loading" || lookup.status === "success") {
    return lookup.result;
  }

  return undefined;
}

async function loadLookupHistory(): Promise<LookupHistoryEntry[]> {
  const serializedHistory = await LocalStorage.getItem<string>(
    LOOKUP_HISTORY_STORAGE_KEY,
  );
  if (!serializedHistory) return [];

  try {
    const history = JSON.parse(serializedHistory) as LookupHistoryEntry[];
    return history.filter(isLookupHistoryEntry).sort(compareLookupHistoryEntry);
  } catch (error) {
    console.error(`${LOG_PREFIX} Failed to parse lookup history`, { error });
    return [];
  }
}

async function saveLookupHistory(history: LookupHistoryEntry[]): Promise<void> {
  await LocalStorage.setItem(
    LOOKUP_HISTORY_STORAGE_KEY,
    JSON.stringify(history),
  );
}

async function loadIntelligenceIndexCache(): Promise<IntelligenceIndexCache> {
  const serializedCache = await LocalStorage.getItem<string>(
    INTELLIGENCE_INDEX_CACHE_STORAGE_KEY,
  );
  if (!serializedCache) return {};

  try {
    const cache = JSON.parse(serializedCache) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(cache).filter(
        (entry): entry is [string, IntelligenceIndexCacheEntry] =>
          isIntelligenceIndexCacheEntry(entry[1]),
      ),
    );
  } catch (error) {
    console.error(`${LOG_PREFIX} Failed to parse Intelligence Index cache`, {
      error,
    });
    return {};
  }
}

async function loadCachedIntelligenceIndex(
  modelId: string,
): Promise<IntelligenceIndexResult | undefined> {
  const cache = await loadIntelligenceIndexCache();
  return cache[modelId]?.result;
}

async function saveCachedIntelligenceIndex(
  modelId: string,
  result: IntelligenceIndexResult,
): Promise<void> {
  const cache = await loadIntelligenceIndexCache();
  const nextCache = upsertIntelligenceIndexCacheEntry(cache, modelId, result);
  await saveIntelligenceIndexCache(nextCache);
}

async function saveIntelligenceIndexCache(
  cache: IntelligenceIndexCache,
): Promise<void> {
  await LocalStorage.setItem(
    INTELLIGENCE_INDEX_CACHE_STORAGE_KEY,
    JSON.stringify(cache),
  );
}

function upsertIntelligenceIndexCacheEntry(
  cache: IntelligenceIndexCache,
  modelId: string,
  result: IntelligenceIndexResult,
): IntelligenceIndexCache {
  return {
    ...cache,
    [modelId]: {
      modelId,
      result,
      updatedAt: Date.now(),
    },
  };
}

function removeIntelligenceIndexCacheEntry(
  cache: IntelligenceIndexCache,
  modelId: string,
): IntelligenceIndexCache {
  return Object.fromEntries(
    Object.entries(cache).filter(
      ([cachedModelId]) => cachedModelId !== modelId,
    ),
  );
}

function upsertLookupHistoryEntry(
  history: LookupHistoryEntry[],
  entry: Omit<LookupHistoryEntry, "updatedAt">,
): LookupHistoryEntry[] {
  const existingEntry = history.find(
    (historyEntry) => historyEntry.modelId === entry.modelId,
  );
  const nextEntry = {
    ...existingEntry,
    ...entry,
    modelName: entry.modelName ?? existingEntry?.modelName,
    updatedAt: Date.now(),
  };

  return [
    nextEntry,
    ...history.filter((historyEntry) => historyEntry.modelId !== entry.modelId),
  ]
    .sort(compareLookupHistoryEntry)
    .slice(0, MAX_LOOKUP_HISTORY_ENTRIES);
}

function compareLookupHistoryEntry(
  left: LookupHistoryEntry,
  right: LookupHistoryEntry,
): number {
  return right.updatedAt - left.updatedAt;
}

function isLookupHistoryEntry(value: unknown): value is LookupHistoryEntry {
  if (!value || typeof value !== "object") return false;

  const entry = value as Partial<LookupHistoryEntry>;
  return (
    typeof entry.modelId === "string" &&
    typeof entry.lastQuery === "string" &&
    typeof entry.updatedAt === "number" &&
    (entry.modelName == null || typeof entry.modelName === "string")
  );
}

function isIntelligenceIndexCacheEntry(
  value: unknown,
): value is IntelligenceIndexCacheEntry {
  if (!value || typeof value !== "object") return false;

  const entry = value as Partial<IntelligenceIndexCacheEntry>;
  return (
    typeof entry.modelId === "string" &&
    typeof entry.updatedAt === "number" &&
    isIntelligenceIndexResult(entry.result)
  );
}

function isIntelligenceIndexResult(
  value: unknown,
): value is IntelligenceIndexResult {
  if (!value || typeof value !== "object") return false;

  const result = value as Partial<IntelligenceIndexResult>;
  return (
    typeof result.note === "string" &&
    Array.isArray(result.entries) &&
    result.entries.every(isIntelligenceIndexEntry)
  );
}

function isIntelligenceIndexEntry(
  value: unknown,
): value is IntelligenceIndexEntry {
  if (!value || typeof value !== "object") return false;

  const entry = value as Partial<IntelligenceIndexEntry>;
  return typeof entry.label === "string" && typeof entry.score === "number";
}

function getFilteredHistory(
  history: LookupHistoryEntry[],
  searchText: string,
): LookupHistoryEntry[] {
  const normalizedSearchText = normalizeForSearch(searchText);
  if (!normalizedSearchText) return history;

  return history.filter((entry) =>
    [entry.modelId, entry.modelName ?? "", entry.lastQuery].some((value) =>
      normalizeForSearch(value).includes(normalizedSearchText),
    ),
  );
}

function isLookupResultMatch(
  result: LookupResult,
  searchText: string,
): boolean {
  const normalizedSearchText = normalizeForSearch(searchText);
  if (!normalizedSearchText) return false;

  return [result.modelId, result.modelName ?? ""].some((value) =>
    normalizeForSearch(value).includes(normalizedSearchText),
  );
}

async function fetchModelThroughput(
  modelId: string,
  apiKey: string | undefined,
): Promise<{
  modelId: string;
  modelName: string;
  endpoints: OpenRouterEndpoint[];
}> {
  const endpointsPath = getModelEndpointsPath(modelId);

  console.info(`${LOG_PREFIX} Fetching model endpoints`, {
    modelId,
    path: endpointsPath,
  });

  const response = await openRouterFetch<OpenRouterEndpointResponse>(
    endpointsPath,
    apiKey,
  );

  return {
    modelId: response.data.id,
    modelName: response.data.name,
    endpoints: response.data.endpoints,
  };
}

async function fetchIntelligenceIndex(
  query: string,
  modelId: string,
  modelName: string | undefined,
  apiKey: string | undefined,
  options: { forceRefresh?: boolean } = {},
): Promise<IntelligenceIndexResult> {
  if (!apiKey) {
    return {
      entries: [],
      note: "Configure an Artificial Analysis API key in preferences to show Intelligence Index scores.",
    };
  }

  if (!options.forceRefresh) {
    const cachedResult = await loadCachedIntelligenceIndex(modelId);
    if (cachedResult) {
      console.info(`${LOG_PREFIX} Using cached Intelligence Index`, {
        query,
        modelId,
        intelligenceIndexEntryCount: cachedResult.entries.length,
      });
      return cachedResult;
    }
  }

  try {
    const response =
      await artificialAnalysisFetch<ArtificialAnalysisModelsResponse>(
        "/data/llms/models",
        apiKey,
      );
    const result = getIntelligenceIndexResult(
      response.data,
      query,
      modelId,
      modelName,
    );

    await saveCachedIntelligenceIndex(modelId, result);

    return result;
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Artificial Analysis Intelligence Index lookup failed.";
    console.error(`${LOG_PREFIX} Artificial Analysis lookup failed`, {
      query,
      modelId,
      modelName,
      message,
      error,
    });

    throw new Error(message);
  }
}

async function resolveModelId(
  query: string,
  apiKey: string | undefined,
): Promise<string> {
  const parsedModelId = parseModelId(query);
  console.info(`${LOG_PREFIX} Resolving model ID`, {
    query,
    parsedModelId,
    requiresModelListLookup: !parsedModelId.includes("/"),
  });

  if (parsedModelId.includes("/")) {
    return parsedModelId;
  }

  const response = await openRouterFetch<OpenRouterModelsResponse>(
    "/models",
    apiKey,
  );
  const normalizedQuery = normalizeForSearch(parsedModelId);
  const matches = response.data
    .map((model) => ({
      model,
      score: getModelMatchScore(model, normalizedQuery),
    }))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score || a.model.id.localeCompare(b.model.id));

  console.info(`${LOG_PREFIX} Model list lookup completed`, {
    query,
    parsedModelId,
    modelCount: response.data.length,
    matchCount: matches.length,
    topMatches: matches.slice(0, 5).map((match) => ({
      id: match.model.id,
      name: match.model.name,
      score: match.score,
    })),
  });

  if (!matches[0]) {
    throw new Error(
      `No OpenRouter model found for “${query}”. Try the full model ID, like openai/gpt-4o.`,
    );
  }

  return matches[0].model.id;
}

async function openRouterFetch<T>(
  path: string,
  apiKey: string | undefined,
): Promise<T> {
  const url = `${OPENROUTER_API_BASE_URL}${path}`;
  const startedAt = Date.now();
  const headers: HeadersInit = {
    "Content-Type": "application/json",
    "HTTP-Referer": "https://raycast.com/",
    "X-OpenRouter-Title": "Raycast Model Info",
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  console.info(`${LOG_PREFIX} OpenRouter request`, {
    method: "GET",
    url,
    hasAuthorizationHeader: Boolean(apiKey),
  });

  let response: Response;
  try {
    response = await fetch(url, {
      headers,
    });
  } catch (error) {
    console.error(`${LOG_PREFIX} OpenRouter request failed before response`, {
      method: "GET",
      url,
      durationMs: Date.now() - startedAt,
      error,
    });
    throw error;
  }

  const bodyText = await response.text();
  const durationMs = Date.now() - startedAt;

  console.info(`${LOG_PREFIX} OpenRouter response`, {
    method: "GET",
    url,
    status: response.status,
    statusText: response.statusText,
    ok: response.ok,
    durationMs,
    bodyLength: bodyText.length,
    bodyPreview: truncateForLog(bodyText),
  });

  if (!response.ok) {
    throw new Error(getOpenRouterErrorMessage(response, bodyText));
  }

  try {
    return JSON.parse(bodyText) as T;
  } catch (error) {
    console.error(`${LOG_PREFIX} Failed to parse OpenRouter JSON response`, {
      method: "GET",
      url,
      status: response.status,
      bodyPreview: truncateForLog(bodyText),
      error,
    });
    throw new Error("OpenRouter returned an invalid JSON response.");
  }
}

async function artificialAnalysisFetch<T>(
  path: string,
  apiKey: string,
): Promise<T> {
  const url = `${ARTIFICIAL_ANALYSIS_API_BASE_URL}${path}`;
  const startedAt = Date.now();

  console.info(`${LOG_PREFIX} Artificial Analysis request`, {
    method: "GET",
    url,
    hasApiKeyHeader: Boolean(apiKey),
  });

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
    });
  } catch (error) {
    console.error(
      `${LOG_PREFIX} Artificial Analysis request failed before response`,
      {
        method: "GET",
        url,
        durationMs: Date.now() - startedAt,
        error,
      },
    );
    throw error;
  }

  const bodyText = await response.text();
  const durationMs = Date.now() - startedAt;

  console.info(`${LOG_PREFIX} Artificial Analysis response`, {
    method: "GET",
    url,
    status: response.status,
    statusText: response.statusText,
    ok: response.ok,
    durationMs,
    bodyLength: bodyText.length,
    bodyPreview: truncateForLog(bodyText),
  });

  if (!response.ok) {
    throw new Error(getArtificialAnalysisErrorMessage(response, bodyText));
  }

  try {
    return JSON.parse(bodyText) as T;
  } catch (error) {
    console.error(
      `${LOG_PREFIX} Failed to parse Artificial Analysis JSON response`,
      {
        method: "GET",
        url,
        status: response.status,
        bodyPreview: truncateForLog(bodyText),
        error,
      },
    );
    throw new Error("Artificial Analysis returned an invalid JSON response.");
  }
}

function getOpenRouterErrorMessage(
  response: Response,
  bodyText: string,
): string {
  try {
    const body = JSON.parse(bodyText) as { error?: { message?: string } };
    return body.error?.message ?? `OpenRouter returned ${response.status}.`;
  } catch {
    return `OpenRouter returned ${response.status}.`;
  }
}

function getArtificialAnalysisErrorMessage(
  response: Response,
  bodyText: string,
): string {
  try {
    const body = JSON.parse(bodyText) as { error?: string; message?: string };
    return (
      body.error ??
      body.message ??
      `Artificial Analysis returned ${response.status}.`
    );
  } catch {
    return `Artificial Analysis returned ${response.status}.`;
  }
}

function isRateLimitError(error: Error | undefined): boolean {
  if (!error) return false;

  const message = normalizeForSearch(error.message);
  return message.includes("429") || message.includes("rate limit");
}

function truncateForLog(value: string): string {
  if (value.length <= MAX_LOGGED_RESPONSE_BODY_LENGTH) return value;

  return `${value.slice(0, MAX_LOGGED_RESPONSE_BODY_LENGTH)}…`;
}

function getModelEndpointsPath(modelId: string): string {
  const separatorIndex = modelId.indexOf("/");
  if (separatorIndex === -1) {
    throw new Error(`“${modelId}” is not a valid OpenRouter model ID.`);
  }

  const author = modelId.slice(0, separatorIndex);
  const slug = modelId.slice(separatorIndex + 1);
  return `/models/${encodeURIComponent(author)}/${encodeURIComponent(slug)}/endpoints`;
}

function parseModelId(query: string): string {
  const trimmedQuery = query.trim();

  try {
    const url = new URL(trimmedQuery);
    if (url.hostname === "openrouter.ai") {
      return url.pathname.split("/").filter(Boolean).slice(0, 2).join("/");
    }
  } catch {
    // The query is not a URL, so treat it as a model name or ID.
  }

  return trimmedQuery;
}

function getModelMatchScore(
  model: OpenRouterModel,
  normalizedQuery: string,
): number {
  const id = normalizeForSearch(model.id);
  const canonicalSlug = normalizeForSearch(model.canonical_slug ?? "");
  const name = normalizeForSearch(model.name);
  const shortId = id.split("/").at(-1) ?? id;

  if (id === normalizedQuery || canonicalSlug === normalizedQuery) return 100;
  if (shortId === normalizedQuery) return 90;
  if (name === normalizedQuery) return 80;
  if (
    id.endsWith(`/${normalizedQuery}`) ||
    canonicalSlug.endsWith(`/${normalizedQuery}`)
  )
    return 70;
  if (id.includes(normalizedQuery) || canonicalSlug.includes(normalizedQuery))
    return 50;
  if (name.includes(normalizedQuery)) return 40;

  return 0;
}

function normalizeForSearch(value: string): string {
  return value.trim().toLowerCase();
}

function getIntelligenceIndexResult(
  models: ArtificialAnalysisModel[],
  query: string,
  modelId: string,
  modelName: string | undefined,
): IntelligenceIndexResult {
  const candidates = getArtificialAnalysisSearchKeys(query, modelId, modelName);
  const scoredMatches = models
    .map((model) => ({
      model,
      score: getArtificialAnalysisMatchScore(model, candidates),
    }))
    .filter(
      (match) =>
        match.score > 0 &&
        match.model.evaluations?.artificial_analysis_intelligence_index != null,
    )
    .sort(
      (a, b) => b.score - a.score || a.model.name.localeCompare(b.model.name),
    );

  const bestMatch = scoredMatches[0];
  if (!bestMatch) {
    return {
      entries: [],
      note: "No Artificial Analysis Intelligence Index score was found for this model.",
    };
  }

  const bestBaseKeys = getArtificialAnalysisModelKeys(bestMatch.model).base;
  const groupedMatches = models
    .filter(
      (model) =>
        model.evaluations?.artificial_analysis_intelligence_index != null &&
        intersects(getArtificialAnalysisModelKeys(model).base, bestBaseKeys),
    )
    .sort(compareArtificialAnalysisModels);

  const entries = groupedMatches.map((model) => ({
    label: getIntelligenceIndexLabel(model, groupedMatches.length),
    score: model.evaluations?.artificial_analysis_intelligence_index ?? 0,
  }));

  return { entries, note: "" };
}

function getArtificialAnalysisSearchKeys(
  query: string,
  modelId: string,
  modelName: string | undefined,
): { full: string[]; base: string[] } {
  const parsedQuery = parseModelId(query);
  const modelIdParts = modelId.split("/");
  const modelProvider = modelIdParts.at(0) ?? "";
  const modelSlug = modelIdParts.at(-1) ?? modelId;
  const rawValues = [
    query,
    parsedQuery,
    modelId,
    `${modelProvider} ${modelSlug}`,
    modelSlug,
    modelName ?? "",
    stripModelProviderPrefix(modelName ?? ""),
  ];

  return {
    full: normalizeArtificialAnalysisKeys(rawValues),
    base: normalizeArtificialAnalysisKeys(rawValues.map(stripReasoningTier)),
  };
}

function getArtificialAnalysisModelKeys(model: ArtificialAnalysisModel): {
  full: string[];
  base: string[];
} {
  const slugWithoutCreator = stripCreatorSlugPrefix(
    model.slug,
    model.model_creator?.slug,
  );
  const rawValues = [model.name, model.slug, slugWithoutCreator];

  return {
    full: normalizeArtificialAnalysisKeys(rawValues),
    base: normalizeArtificialAnalysisKeys(rawValues.map(stripReasoningTier)),
  };
}

function getArtificialAnalysisMatchScore(
  model: ArtificialAnalysisModel,
  candidates: { full: string[]; base: string[] },
): number {
  const modelKeys = getArtificialAnalysisModelKeys(model);

  if (intersects(modelKeys.full, candidates.full)) return 100;
  if (intersects(modelKeys.base, candidates.base)) return 90;
  if (intersects(modelKeys.full, candidates.base)) return 80;
  if (intersects(modelKeys.base, candidates.full)) return 80;

  return 0;
}

function compareArtificialAnalysisModels(
  a: ArtificialAnalysisModel,
  b: ArtificialAnalysisModel,
): number {
  return (
    getReasoningTierSortRank(getReasoningTier(a.name)) -
      getReasoningTierSortRank(getReasoningTier(b.name)) ||
    a.name.localeCompare(b.name)
  );
}

function getIntelligenceIndexLabel(
  model: ArtificialAnalysisModel,
  groupSize: number,
): string {
  const reasoningTier = getReasoningTier(model.name);
  if (groupSize > 1 && reasoningTier) return reasoningTier;

  return model.name;
}

function getReasoningTier(value: string): string | undefined {
  return value.match(/\(([^()]+)\)\s*$/)?.[1];
}

function getReasoningTierSortRank(value: string | undefined): number {
  const normalizedValue = normalizeForSearch(value ?? "");
  if (normalizedValue.includes("max")) return 0;
  if (normalizedValue === "xhigh" || normalizedValue.includes("extra high"))
    return 1;
  if (normalizedValue.includes("high")) return 2;
  if (normalizedValue.includes("medium")) return 3;
  if (normalizedValue.includes("low")) return 4;
  if (normalizedValue.includes("minimal")) return 5;

  return 6;
}

function normalizeArtificialAnalysisKeys(values: string[]): string[] {
  return Array.from(
    new Set(
      values
        .map(normalizeArtificialAnalysisKey)
        .filter((value) => value.length > 0),
    ),
  );
}

function normalizeArtificialAnalysisKey(value: string): string {
  return stripModelProviderPrefix(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "");
}

function stripReasoningTier(value: string): string {
  return value.replace(/\s*\([^)]*\)\s*$/g, "").replace(/--[^-]+$/g, "");
}

function stripModelProviderPrefix(value: string): string {
  return value.replace(/^[^:]+:\s*/, "");
}

function stripCreatorSlugPrefix(
  slug: string,
  creatorSlug: string | undefined,
): string {
  if (!creatorSlug) return slug;

  return slug.replace(new RegExp(`^${escapeRegExp(creatorSlug)}[-_]`, "i"), "");
}

function intersects(left: string[], right: string[]): boolean {
  const rightSet = new Set(right);
  return left.some((value) => rightSet.has(value));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getDetailMarkdown(lookup: LookupState): string {
  if (lookup.status === "idle") {
    return "Type an OpenRouter model ID or name, then press Enter to look up provider throughput.";
  }

  if (lookup.status === "loading") {
    return lookup.result
      ? getModelDetailsMarkdown(lookup.result, lookup.hasApiKey)
      : `Resolving **${escapeMarkdown(lookup.query)}**…`;
  }

  if (lookup.status === "error") {
    return `## Error\n\n${escapeMarkdown(lookup.message)}`;
  }

  return getModelDetailsMarkdown(lookup.result, lookup.hasApiKey);
}

function getHistoryDetailMarkdown(
  intelligenceIndex: IntelligenceIndexResult | undefined,
): string {
  return intelligenceIndex
    ? getIntelligenceIndexMarkdown(intelligenceIndex)
    : "_No cached Intelligence Index for this model yet._";
}

function getModelDetailsMarkdown(
  result: LookupResult,
  hasApiKey: boolean,
): string {
  return [
    getThroughputMarkdown(result, hasApiKey),
    result.intelligenceIndex
      ? getIntelligenceIndexMarkdown(result.intelligenceIndex)
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function getIntelligenceIndexMarkdown(result: IntelligenceIndexResult): string {
  const content = result.entries.length
    ? result.entries.map(formatIntelligenceIndexRow).join("  \n")
    : `_${escapeMarkdown(result.note)}_`;

  return ["**Intelligence Index**", "", content].join("\n");
}

function getThroughputMarkdown(
  result: LookupResult,
  hasApiKey: boolean,
): string {
  if (result.throughputError) {
    return [
      "**Throughput**",
      "",
      `_${escapeMarkdown(result.throughputError)}_`,
    ].join("\n");
  }

  if (!result.endpoints) {
    return "";
  }

  const rows = [...result.endpoints]
    .sort(compareEndpointsByThroughput)
    .map(formatThroughputRow);
  const note = getThroughputNote(result, hasApiKey);

  return (
    [`**Throughput**`, "", rows.join("  \n")].join("\n") +
    (note ? `\n\n_${note}_` : "")
  );
}

function getThroughputNote(result: LookupResult, hasApiKey: boolean): string {
  const endpoints = result.endpoints ?? [];
  const unavailableCount = endpoints.filter(
    (endpoint) => !endpoint.throughput_last_30m,
  ).length;

  if (!hasApiKey && unavailableCount > 0) {
    return "OpenRouter only returns throughput stats when an API key is configured in preferences.";
  }

  if (hasApiKey && unavailableCount === endpoints.length) {
    return "OpenRouter did not return throughput stats for any provider. Check the Raycast logs for the raw OpenRouter response.";
  }

  return "";
}

function formatThroughputRow(endpoint: OpenRouterEndpoint): string {
  return `${escapeMarkdown(endpoint.provider_name)}: ${formatThroughputValue(endpoint)}`;
}

function compareEndpointsByThroughput(
  left: OpenRouterEndpoint,
  right: OpenRouterEndpoint,
): number {
  const leftThroughput = left.throughput_last_30m?.p50 ?? -1;
  const rightThroughput = right.throughput_last_30m?.p50 ?? -1;

  return (
    rightThroughput - leftThroughput ||
    left.provider_name.localeCompare(right.provider_name)
  );
}

function formatThroughputValue(endpoint: OpenRouterEndpoint): string {
  const throughput = endpoint.throughput_last_30m?.p50;
  return throughput == null
    ? "Unavailable"
    : `${formatTokensPerSecond(throughput)} tok/sec`;
}

function formatIntelligenceIndexRow(entry: IntelligenceIndexEntry): string {
  return `${escapeMarkdown(entry.label)} · ${formatIntelligenceIndexScore(entry.score)}`;
}

function formatIntelligenceIndexScore(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(value);
}

function formatTokensPerSecond(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: value >= 10 ? 0 : 1,
  }).format(value);
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}[\]()#+\-.!|>])/g, "\\$1");
}
