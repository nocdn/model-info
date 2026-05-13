import {
  Action,
  ActionPanel,
  List,
  Toast,
  getPreferenceValues,
  showToast,
} from "@raycast/api";
import React from "react";

const OPENROUTER_API_BASE_URL = "https://openrouter.ai/api/v1";
const LOG_PREFIX = "[Model Info]";
const MAX_LOGGED_RESPONSE_BODY_LENGTH = 2_000;

type Preferences = {
  openRouterApiKey?: string;
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

type LookupResult = {
  modelId: string;
  modelName: string;
  endpoints: OpenRouterEndpoint[];
};

type LookupState =
  | { status: "idle" }
  | { status: "loading"; query: string }
  | { status: "success"; result: LookupResult; hasApiKey: boolean }
  | { status: "error"; message: string };

export default function ModelInfo() {
  const [model, setModel] = React.useState("");
  const [lookup, setLookup] = React.useState<LookupState>({ status: "idle" });

  const lookUpModel = async () => {
    const query = model.trim();
    if (!query) return;

    const preferences = getPreferenceValues<Preferences>();
    const apiKey = preferences.openRouterApiKey?.trim();

    console.info(`${LOG_PREFIX} Starting model lookup`, {
      query,
      hasOpenRouterApiKey: Boolean(apiKey),
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

    setLookup({ status: "loading", query });

    try {
      const result = await fetchModelThroughput(query, apiKey);
      console.info(`${LOG_PREFIX} Model lookup succeeded`, {
        query,
        modelId: result.modelId,
        modelName: result.modelName,
        endpointCount: result.endpoints.length,
        endpointsWithThroughputCount: result.endpoints.filter(
          (endpoint) => endpoint.throughput_last_30m,
        ).length,
      });
      setLookup({ status: "success", result, hasApiKey: Boolean(apiKey) });
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
      await showToast({
        style: Toast.Style.Failure,
        title: "Lookup Failed",
        message,
      });
    }
  };

  const hasSearchText = model.trim().length > 0;

  return (
    <List
      searchText={model}
      isLoading={lookup.status === "loading"}
      isShowingDetail={lookup.status !== "idle"}
      filtering={false}
      onSearchTextChange={setModel}
      throttle={false}
      navigationTitle="Model Info"
      searchBarPlaceholder="Enter an OpenRouter model, e.g. openai/gpt-4o"
      actions={
        <ActionPanel>
          <Action title="Look up Model" onAction={() => void lookUpModel()} />
        </ActionPanel>
      }
    >
      <List.Item
        id="model-throughput"
        title={getListItemTitle(lookup, hasSearchText)}
        subtitle={getListItemSubtitle(lookup)}
        detail={<List.Item.Detail markdown={getDetailMarkdown(lookup)} />}
        actions={
          <ActionPanel>
            <Action title="Look up Model" onAction={() => void lookUpModel()} />
            {lookup.status === "success" ? (
              <Action.CopyToClipboard
                title="Copy Throughput"
                content={getThroughputMarkdown(lookup.result, lookup.hasApiKey)}
              />
            ) : null}
          </ActionPanel>
        }
      />
    </List>
  );
}

async function fetchModelThroughput(
  query: string,
  apiKey: string | undefined,
): Promise<LookupResult> {
  const modelId = await resolveModelId(query, apiKey);
  const endpointsPath = getModelEndpointsPath(modelId);

  console.info(`${LOG_PREFIX} Fetching model endpoints`, {
    query,
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

function getDetailMarkdown(lookup: LookupState): string {
  if (lookup.status === "idle") {
    return "Type an OpenRouter model ID or name, then press Enter to look up provider throughput.";
  }

  if (lookup.status === "loading") {
    return `Looking up throughput for **${escapeMarkdown(lookup.query)}**…`;
  }

  if (lookup.status === "error") {
    return `## Error\n\n${escapeMarkdown(lookup.message)}`;
  }

  return getThroughputMarkdown(lookup.result, lookup.hasApiKey);
}

function getThroughputMarkdown(
  result: LookupResult,
  hasApiKey: boolean,
): string {
  const rows = result.endpoints.map(formatThroughputRow);
  const unavailableCount = result.endpoints.filter(
    (endpoint) => !endpoint.throughput_last_30m,
  ).length;
  const note =
    !hasApiKey && unavailableCount > 0
      ? "\n\n_OpenRouter only returns throughput stats when an API key is configured in preferences._"
      : hasApiKey && unavailableCount === result.endpoints.length
        ? "\n\n_OpenRouter did not return throughput stats for any provider. Check the Raycast logs for the raw OpenRouter response._"
        : "";

  return [`## Throughput`, "", ...rows].join("\n") + note;
}

function formatThroughputRow(endpoint: OpenRouterEndpoint): string {
  const throughput = endpoint.throughput_last_30m?.p50;
  const value =
    throughput == null
      ? "Unavailable"
      : `${formatTokensPerSecond(throughput)} tok/sec`;
  return `${escapeMarkdown(endpoint.provider_name)}: ${value}`;
}

function formatTokensPerSecond(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: value >= 10 ? 0 : 1,
  }).format(value);
}

function getListItemTitle(lookup: LookupState, hasSearchText: boolean): string {
  if (lookup.status === "success") return lookup.result.modelName;
  if (lookup.status === "loading") return "Looking Up Model…";
  if (lookup.status === "error") return "Lookup Failed";
  return hasSearchText ? "Press Enter to Look Up Model" : "Model Throughput";
}

function getListItemSubtitle(lookup: LookupState): string | undefined {
  if (lookup.status === "success") return lookup.result.modelId;
  if (lookup.status === "loading") return lookup.query;
  return undefined;
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}[\]()#+\-.!|>])/g, "\\$1");
}
