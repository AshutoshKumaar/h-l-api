const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const axios = require("axios");
const admin = require("firebase-admin");

loadEnvFile(path.join(process.cwd(), ".env"));

const DEFAULT_CHANNEL_IDS_FILE = path.join(process.cwd(), "data", "channel-ids.txt");
const DEFAULT_DISCOVERY_QUERIES_FILE = path.join(
  process.cwd(),
  "data",
  "discovery-queries.txt"
);
const DEFAULT_CHANNEL_IDS = [
  "UCX6OQ3DkcsbYNE6H8uQQuVA",
  "UC-lHJZR3Gqxm24_Vd_AJ5Yw",
  "UCJ5v_MCY6GNUBTO8-D3XoAg",
  "UC7cs8q-gJRlGwj4A8OmCmXg",
  "UCiT9RITQ9PW6BhXK0y2jaeg",
];
const DEFAULT_DISCOVERY_QUERIES = [
  "music",
  "gaming",
  "technology",
  "news",
  "sports",
  "education",
  "comedy",
  "fashion",
  "travel",
  "food",
  "fitness",
  "finance",
  "movies",
  "beauty",
  "podcast",
  "kids",
  "science",
  "cars",
  "cricket",
  "anime",
];
const DEFAULT_DISCOVERY_REGION_CODES = ["US", "IN", "GB"];

const METRICS = {
  subscribers: {
    label: "Subscribers",
  },
  views: {
    label: "Views",
  },
  videos: {
    label: "Videos",
  },
};

const MAX_YOUTUBE_BATCH_SIZE = 50;
const WRITE_BATCH_LIMIT = 400;

function createApiApp() {
  const app = express();
  const getDb = () => {
    ensureFirebaseApp();
    return admin.firestore();
  };

  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use(corsMiddleware);

  app.get(
    ["/", "/api", "/api/meta"],
    asyncHandler(async (req, res) => {
      res.json(buildMetaResponse(req));
    })
  );

  app.get(
    "/health",
    asyncHandler(async (req, res) => {
      res.json({
        ok: true,
        service: "h-l-api",
        storage: "firestore",
        randomSelection: "randomIndex",
        hasYoutubeApiKey: Boolean(process.env.YOUTUBE_API_KEY),
        hasAdminApiKey: Boolean(process.env.ADMIN_API_KEY),
        channelsCollection: getChannelsCollectionName(),
        roundsCollection: getRoundsCollectionName(),
        configuredSeedChannelCount: getSeedChannelIds().length,
        configuredSeedSource: getSeedChannelSource(),
        configuredDiscoveryQueryCount: getDiscoveryQueries().length,
        configuredDiscoveryQuerySource: getDiscoveryQuerySource(),
        availableMetrics: Object.keys(METRICS),
      });
    })
  );

  app.post(
    "/api/admin/channels/discover",
    asyncHandler(async (req, res) => {
      assertAdminRequest(req);

      const queries = collectDiscoveryQueries(req.body);
      const regionCodes = collectRegionCodes(req.body?.regionCodes);
      const pagesPerQuery = resolvePositiveInteger(
        req.body?.pagesPerQuery,
        1,
        20,
        "pagesPerQuery",
        2
      );
      const maxChannelsToSync = resolvePositiveInteger(
        req.body?.maxChannelsToSync,
        1,
        5000,
        "maxChannelsToSync",
        1000
      );
      const order = resolveDiscoveryOrder(req.body?.order);
      const relevanceLanguage = resolveOptionalString(req.body?.relevanceLanguage);

      const discoveryResult = await discoverChannelIdsFromYouTube({
        queries,
        regionCodes,
        pagesPerQuery,
        maxChannelsToSync,
        order,
        relevanceLanguage,
      });

      const syncResult = await syncChannelsFromYouTube({
        db: getDb(),
        channelIds: discoveryResult.channelIds,
        refreshRandomIndex: Boolean(req.body?.refreshRandomIndex),
      });

      res.status(201).json({
        ok: true,
        strategy: "youtube-search-discovery",
        queryCount: queries.length,
        regionCodes,
        pagesPerQuery,
        searchRequestsUsed: discoveryResult.searchRequestsUsed,
        estimatedQuotaUnits: discoveryResult.searchRequestsUsed * 100,
        discoveredChannelCount: discoveryResult.channelIds.length,
        syncedCount: syncResult.channels.length,
        previewChannels: syncResult.channels.slice(0, 10).map((channel) =>
          buildChannelCard(channel, "subscribers", true)
        ),
      });
    })
  );

  app.post(
    "/api/admin/channels/sync",
    asyncHandler(async (req, res) => {
      assertAdminRequest(req);

      const bodyChannelIds = collectRequestedChannelIds(req.body);
      const channelIds =
        bodyChannelIds.length > 0 ? bodyChannelIds : getSeedChannelIds();
      const refreshRandomIndex = Boolean(req.body?.refreshRandomIndex);
      const syncResult = await syncChannelsFromYouTube({
        db: getDb(),
        channelIds,
        refreshRandomIndex,
      });

      res.status(201).json({
        ok: true,
        strategy: "firestore-randomIndex",
        requestedCount: channelIds.length,
        syncedCount: syncResult.channels.length,
        missingChannelIds: syncResult.missingChannelIds,
        previewChannels: syncResult.channels.slice(0, 10).map((channel) =>
          buildChannelCard(channel, "subscribers", true)
        ),
      });
    })
  );

  app.get(
    "/api/admin/channels/count",
    asyncHandler(async (req, res) => {
      assertAdminRequest(req);

      const snapshot = await getDb().collection(getChannelsCollectionName()).count().get();
      res.json({
        ok: true,
        channelsCollection: getChannelsCollectionName(),
        totalChannels: snapshot.data().count,
      });
    })
  );

  app.post(
    "/api/admin/channels/reindex",
    asyncHandler(async (req, res) => {
      assertAdminRequest(req);

      const channelIds = parseChannelIds(req.body?.channelIds);
      const updatedCount = await reindexChannels({
        db: getDb(),
        channelIds,
      });

      res.json({
        ok: true,
        strategy: "firestore-randomIndex",
        updatedCount,
      });
    })
  );

  app.get(
    "/api/channels/random",
    asyncHandler(async (req, res) => {
      const metric = resolveMetric(req.query.metric);
      const count = resolveRequestedCount(req.query.count);
      const excludeIds = parseChannelIds(req.query.excludeIds);
      const channels = await getRandomPlayableChannels({
        db: getDb(),
        count,
        metric,
        excludeIds,
      });

      res.json({
        ok: true,
        source: "firestore",
        strategy: "randomIndex",
        metric,
        metricLabel: METRICS[metric].label,
        channels: channels.map((channel) => buildChannelCard(channel, metric, true)),
      });
    })
  );

  app.get(
    "/api/channels/:channelId",
    asyncHandler(async (req, res) => {
      const metric = resolveMetric(req.query.metric);
      const channel = await getChannelById(getDb(), req.params.channelId);

      if (!channel) {
        throw createHttpError(404, "Channel not found.");
      }

      res.json({
        ok: true,
        metric,
        metricLabel: METRICS[metric].label,
        channel: buildChannelCard(channel, metric, true),
      });
    })
  );

  const createRoundHandler = asyncHandler(async (req, res) => {
    const rawMetric = req.method === "POST" ? req.body?.metric : req.query.metric;
    const metric = resolveMetric(rawMetric);
    const [left] = await getRandomPlayableChannels({
      db: getDb(),
      count: 1,
      metric,
    });
    const [right] = await getRandomPlayableChannels({
      db: getDb(),
      count: 1,
      metric,
      excludeIds: [left.id],
    });

    const answer = compareChannels(left, right, metric);
    const roundId = crypto.randomUUID();
    const createdAtMs = Date.now();
    const expiresAtMs = createdAtMs + getRoundTtlMs();

    await getDb().collection(getRoundsCollectionName()).doc(roundId).set({
      roundId,
      metric,
      answer,
      createdAtMs,
      expiresAtMs,
      leftChannel: left,
      rightChannel: right,
    });

    res.status(req.method === "POST" ? 201 : 200).json({
      ok: true,
      roundId,
      metric,
      metricLabel: METRICS[metric].label,
      expiresAtMs,
      expiresAt: new Date(expiresAtMs).toISOString(),
      left: buildChannelCard(left, metric, true),
      right: buildChannelCard(right, metric, false),
    });
  });

  app.get("/api/game/round", createRoundHandler);
  app.post("/api/game/round", createRoundHandler);

  app.post(
    "/api/game/guess",
    asyncHandler(async (req, res) => {
      const roundId = String(req.body?.roundId || "").trim();
      const guess = String(req.body?.guess || "")
        .trim()
        .toLowerCase();

      if (!roundId) {
        throw createHttpError(400, "roundId is required.");
      }

      if (!["higher", "lower", "equal"].includes(guess)) {
        throw createHttpError(400, "guess must be higher, lower, or equal.");
      }

      const roundRef = getDb().collection(getRoundsCollectionName()).doc(roundId);
      const roundSnapshot = await roundRef.get();

      if (!roundSnapshot.exists) {
        throw createHttpError(404, "Round not found or already used.");
      }

      const round = roundSnapshot.data();

      if (!round || round.expiresAtMs <= Date.now()) {
        await roundRef.delete();
        throw createHttpError(410, "Round expired.");
      }

      await roundRef.delete();

      res.json({
        ok: true,
        correct: guess === round.answer,
        answer: round.answer,
        metric: round.metric,
        metricLabel: METRICS[round.metric].label,
        left: buildChannelCard(round.leftChannel, round.metric, true),
        right: buildChannelCard(round.rightChannel, round.metric, true),
      });
    })
  );

  app.use((req, res) => {
    res.status(404).json({
      error: "Route not found.",
      metaPath: "/api/meta",
    });
  });

  app.use((error, req, res, next) => {
    const status = error.status || 500;
    const message = error.message || "Unexpected server error.";

    if (status >= 500) {
      console.error(error);
    }

    res.status(status).json({
      error: message,
    });
  });

  return app;
}

function buildMetaResponse(req) {
  const forwardedHost = String(req.get("x-forwarded-host") || "").trim();
  const forwardedProto = String(req.get("x-forwarded-proto") || "")
    .split(",")[0]
    .trim();
  const host = forwardedHost || req.get("host");
  const protocol = forwardedProto || req.protocol;
  const origin = host ? `${protocol}://${host}` : "";
  const apiPrefix = origin ? `${origin}/api` : "/api";

  return {
    ok: true,
    name: "h-l-api",
    description: "Reusable YouTube higher-lower API backed by Firestore.",
    storage: {
      provider: "firestore",
      randomSelection: "randomIndex",
      channelsCollection: getChannelsCollectionName(),
      roundsCollection: getRoundsCollectionName(),
    },
    endpoints: [
      {
        method: "GET",
        path: "/health",
        purpose: "Service health and configuration status.",
      },
      {
        method: "POST",
        path: "/api/admin/channels/discover",
        purpose: "Discover channel IDs from YouTube search results, then sync them into Firestore.",
      },
      {
        method: "POST",
        path: "/api/admin/channels/sync",
        purpose: "Fetch YouTube channel data and upsert Firestore documents from large channel ID lists or a local IDs file.",
      },
      {
        method: "GET",
        path: "/api/admin/channels/count",
        purpose: "Return the total number of stored channel documents.",
      },
      {
        method: "POST",
        path: "/api/admin/channels/reindex",
        purpose: "Refresh randomIndex values for channel documents.",
      },
      {
        method: "GET",
        path: "/api/channels/random",
        purpose: "Fetch random channel cards from Firestore without loading all docs.",
      },
      {
        method: "GET",
        path: "/api/channels/:channelId",
        purpose: "Read a stored channel document by ID.",
      },
      {
        method: "POST",
        path: "/api/game/round",
        purpose: "Create a new higher-lower round using Firestore-backed random selection.",
      },
      {
        method: "POST",
        path: "/api/game/guess",
        purpose: "Resolve a round and reveal the hidden metric value.",
      },
    ],
    exampleRequests: {
      random: `${apiPrefix}/channels/random?metric=subscribers&count=2`,
      createRound: `${apiPrefix}/game/round`,
      channel: `${apiPrefix}/channels/UCX6OQ3DkcsbYNE6H8uQQuVA?metric=subscribers`,
    },
  };
}

function ensureFirebaseApp() {
  if (!admin.apps.length) {
    admin.initializeApp();
  }
}

function corsMiddleware(req, res, next) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,x-api-key");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
}

function getChannelsCollectionName() {
  return process.env.CHANNELS_COLLECTION || "channels";
}

function getRoundsCollectionName() {
  return process.env.ROUNDS_COLLECTION || "rounds";
}

function getRoundTtlMs() {
  return Number(process.env.ROUND_TTL_MS) || 15 * 60 * 1000;
}

function getSeedChannelIds() {
  const fileIds = readSeedChannelIdsFromFile();

  if (fileIds.length > 0) {
    return fileIds;
  }

  const configuredIds = parseChannelIds(process.env.CHANNEL_IDS);
  return configuredIds.length > 0 ? configuredIds : DEFAULT_CHANNEL_IDS;
}

function getSeedChannelSource() {
  const filePath = getChannelIdsFilePath();

  if (fs.existsSync(filePath)) {
    return `file:${path.basename(filePath)}`;
  }

  if (parseChannelIds(process.env.CHANNEL_IDS).length > 0) {
    return "env:CHANNEL_IDS";
  }

  return "built-in-defaults";
}

function getDiscoveryQueriesFilePath() {
  return process.env.DISCOVERY_QUERIES_FILE || DEFAULT_DISCOVERY_QUERIES_FILE;
}

function getDiscoveryQueries() {
  const fileQueries = readListFromFile(getDiscoveryQueriesFilePath());

  if (fileQueries.length > 0) {
    return fileQueries;
  }

  const envQueries = parseDelimitedList(process.env.DISCOVERY_QUERIES);
  return envQueries.length > 0 ? envQueries : DEFAULT_DISCOVERY_QUERIES;
}

function getDiscoveryQuerySource() {
  const filePath = getDiscoveryQueriesFilePath();

  if (fs.existsSync(filePath)) {
    return `file:${path.basename(filePath)}`;
  }

  if (parseDelimitedList(process.env.DISCOVERY_QUERIES).length > 0) {
    return "env:DISCOVERY_QUERIES";
  }

  return "built-in-defaults";
}

function getChannelIdsFilePath() {
  return process.env.CHANNEL_IDS_FILE || DEFAULT_CHANNEL_IDS_FILE;
}

function readSeedChannelIdsFromFile() {
  return parseChannelIds(readListFromFile(getChannelIdsFilePath()).join("\n"));
}

function resolveRequestedCount(value) {
  if (value === undefined || value === null || value === "") {
    return 1;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw createHttpError(400, "count must be a positive integer.");
  }

  return parsed;
}

function resolveMetric(metric) {
  const normalizedMetric = String(metric || "subscribers")
    .trim()
    .toLowerCase();

  if (!METRICS[normalizedMetric]) {
    throw createHttpError(
      400,
      `Invalid metric. Use one of: ${Object.keys(METRICS).join(", ")}.`
    );
  }

  return normalizedMetric;
}

function parseChannelIds(value) {
  if (Array.isArray(value)) {
    return [
      ...new Set(
        value
          .flatMap((item) => parseChannelIds(item))
          .map((item) => item.trim())
          .filter(Boolean)
      ),
    ];
  }

  if (typeof value === "string") {
    return [
      ...new Set(
        value
          .split(/[\s,\n\r\t]+/)
          .map((item) => item.trim())
          .filter(Boolean)
      ),
    ];
  }

  return [];
}

function collectRequestedChannelIds(body) {
  const sources = [
    body?.channelIds,
    body?.channelIdsText,
    body?.channelIdsCsv,
  ];

  return [...new Set(sources.flatMap((source) => parseChannelIds(source)))];
}

function parseDelimitedList(value) {
  if (Array.isArray(value)) {
    return [
      ...new Set(
        value
          .flatMap((item) => parseDelimitedList(item))
          .map((item) => item.trim())
          .filter(Boolean)
      ),
    ];
  }

  if (typeof value === "string") {
    return [
      ...new Set(
        value
          .split(/[\n\r,|]+/)
          .map((item) => item.trim())
          .filter(Boolean)
      ),
    ];
  }

  return [];
}

function collectDiscoveryQueries(body) {
  const providedQueries = [
    body?.queries,
    body?.queryText,
    body?.queryCsv,
  ].flatMap((source) => parseDelimitedList(source));

  return providedQueries.length > 0 ? providedQueries : getDiscoveryQueries();
}

function collectRegionCodes(value) {
  const parsed = parseDelimitedList(value);

  if (parsed.length === 0) {
    return DEFAULT_DISCOVERY_REGION_CODES;
  }

  return [
    ...new Set(
      parsed
        .map((code) => code.trim().toUpperCase())
        .filter((code) => /^[A-Z]{2}$/.test(code))
    ),
  ];
}

function resolvePositiveInteger(value, min, max, label, defaultValue = min) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw createHttpError(400, `${label} must be an integer between ${min} and ${max}.`);
  }

  return parsed;
}

function resolveOptionalString(value) {
  if (value === undefined || value === null) {
    return "";
  }

  return String(value).trim();
}

function resolveDiscoveryOrder(value) {
  const normalized = resolveOptionalString(value).toLowerCase();

  if (!normalized) {
    return "relevance";
  }

  const orderMap = {
    date: "date",
    rating: "rating",
    relevance: "relevance",
    title: "title",
    videocount: "videoCount",
    viewcount: "viewCount",
  };

  if (!orderMap[normalized]) {
    throw createHttpError(400, "order must be one of: date, rating, relevance, title, videoCount, viewCount.");
  }

  return orderMap[normalized];
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function createHttpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function assertAdminRequest(req) {
  const configuredKey = process.env.ADMIN_API_KEY || "";

  if (!configuredKey) {
    return;
  }

  const providedKey =
    req.get("x-api-key") ||
    String(req.body?.apiKey || req.query?.apiKey || "").trim();

  if (providedKey !== configuredKey) {
    throw createHttpError(401, "Invalid admin API key.");
  }
}

function buildChannelCard(channel, metric, includeMetricValue) {
  const value = channel[metric];
  const card = {
    id: channel.id,
    name: channel.name,
    image: channel.image,
    description: channel.description,
    publishedAt: channel.publishedAt,
  };

  if (includeMetricValue) {
    card.metric = metric;
    card.metricLabel = METRICS[metric].label;
    card.metricValue = value;
    card.metricDisplay = value === null ? null : formatCompactNumber(value);
    card.stats = {
      subscribers: channel.subscribers,
      views: channel.views,
      videos: channel.videos,
    };
  }

  return card;
}

function compareChannels(left, right, metric) {
  const leftValue = left[metric];
  const rightValue = right[metric];

  if (leftValue === rightValue) {
    return "equal";
  }

  return rightValue > leftValue ? "higher" : "lower";
}

function formatCompactNumber(value) {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function isPlayableChannel(channel, metric) {
  return Number.isFinite(channel[metric]);
}

function shuffle(items) {
  const clone = [...items];

  for (let index = clone.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [clone[index], clone[randomIndex]] = [clone[randomIndex], clone[index]];
  }

  return clone;
}

async function getChannelById(db, channelId) {
  const snapshot = await db.collection(getChannelsCollectionName()).doc(channelId).get();

  if (!snapshot.exists) {
    return null;
  }

  return normalizeStoredChannel(snapshot);
}

async function getRandomPlayableChannels(options) {
  const { db, count, metric, excludeIds = [] } = options;
  const desiredCount = resolveRequestedCount(count);
  const excluded = new Set(excludeIds.filter(Boolean));
  const collected = [];
  const seen = new Set(excluded);

  for (let attempt = 0; attempt < 8 && collected.length < desiredCount; attempt += 1) {
    const batchSize = Math.max(desiredCount * 4, 25);
    const candidates = await fetchRandomCandidates(db, batchSize);

    for (const candidate of shuffle(candidates)) {
      if (seen.has(candidate.id) || !isPlayableChannel(candidate, metric)) {
        continue;
      }

      seen.add(candidate.id);
      collected.push(candidate);

      if (collected.length >= desiredCount) {
        break;
      }
    }
  }

  if (collected.length < desiredCount) {
    throw createHttpError(
      404,
      `Not enough playable channels found in Firestore for metric "${metric}". Sync more channels first.`
    );
  }

  return collected.slice(0, desiredCount);
}

async function fetchRandomCandidates(db, limit) {
  const seed = Math.random();
  const channels = db.collection(getChannelsCollectionName());

  const [forwardSnapshot, wrapSnapshot] = await Promise.all([
    channels.where("randomIndex", ">=", seed).orderBy("randomIndex").limit(limit).get(),
    channels.where("randomIndex", "<", seed).orderBy("randomIndex").limit(limit).get(),
  ]);

  const resultMap = new Map();

  for (const snapshot of [forwardSnapshot, wrapSnapshot]) {
    for (const doc of snapshot.docs) {
      if (!resultMap.has(doc.id)) {
        resultMap.set(doc.id, normalizeStoredChannel(doc));
      }
    }
  }

  return [...resultMap.values()];
}

async function discoverChannelIdsFromYouTube(options) {
  const {
    queries,
    regionCodes,
    pagesPerQuery,
    maxChannelsToSync,
    order,
    relevanceLanguage,
  } = options;

  ensureYoutubeApiKey();

  const uniqueQueries = [...new Set(queries.map((query) => query.trim()).filter(Boolean))];

  if (uniqueQueries.length === 0) {
    throw createHttpError(400, "At least one discovery query is required.");
  }

  const discoveredIds = new Set();
  let searchRequestsUsed = 0;

  for (const regionCode of regionCodes) {
    for (const query of uniqueQueries) {
      let pageToken = "";

      for (let page = 0; page < pagesPerQuery; page += 1) {
        if (discoveredIds.size >= maxChannelsToSync) {
          break;
        }

        const pageResult = await searchChannelsPage({
          query,
          regionCode,
          pageToken,
          order,
          relevanceLanguage,
        });
        searchRequestsUsed += 1;

        for (const channelId of pageResult.channelIds) {
          discoveredIds.add(channelId);

          if (discoveredIds.size >= maxChannelsToSync) {
            break;
          }
        }

        if (!pageResult.nextPageToken) {
          break;
        }

        pageToken = pageResult.nextPageToken;
      }

      if (discoveredIds.size >= maxChannelsToSync) {
        break;
      }
    }

    if (discoveredIds.size >= maxChannelsToSync) {
      break;
    }
  }

  return {
    channelIds: [...discoveredIds].slice(0, maxChannelsToSync),
    searchRequestsUsed,
  };
}

async function syncChannelsFromYouTube(options) {
  const { db, channelIds, refreshRandomIndex = false } = options;

  ensureYoutubeApiKey();

  const uniqueIds = parseChannelIds(channelIds);

  if (!uniqueIds.length) {
    throw createHttpError(400, "At least one channelId is required for sync.");
  }

  const collection = db.collection(getChannelsCollectionName());
  const existingMap = new Map();

  if (!refreshRandomIndex && uniqueIds.length > 0) {
    for (const idChunk of chunk(uniqueIds, WRITE_BATCH_LIMIT)) {
      const refs = idChunk.map((channelId) => collection.doc(channelId));
      const existingSnapshots = await db.getAll(...refs);

      for (const snapshot of existingSnapshots) {
        if (snapshot.exists) {
          existingMap.set(snapshot.id, snapshot.data());
        }
      }
    }
  }

  const fetchedChannels = [];

  for (const idChunk of chunk(uniqueIds, MAX_YOUTUBE_BATCH_SIZE)) {
    const chunkChannels = await fetchChannelsFromYouTube(idChunk);
    fetchedChannels.push(...chunkChannels);
  }

  const fetchedIds = new Set(fetchedChannels.map((channel) => channel.id));
  const missingChannelIds = uniqueIds.filter((channelId) => !fetchedIds.has(channelId));
  const nowMs = Date.now();

  for (const channelChunk of chunk(fetchedChannels, WRITE_BATCH_LIMIT)) {
    const batch = db.batch();

    for (const channel of channelChunk) {
      const existing = existingMap.get(channel.id);
      const randomIndex =
        refreshRandomIndex || !isValidRandomIndex(existing?.randomIndex)
          ? Math.random()
          : existing.randomIndex;

      batch.set(
        collection.doc(channel.id),
        {
          channelId: channel.id,
          source: "youtube",
          randomIndex,
          hiddenSubscriberCount: channel.hiddenSubscriberCount,
          name: channel.name,
          image: channel.image,
          description: channel.description,
          publishedAt: channel.publishedAt,
          subscribers: channel.subscribers,
          views: channel.views,
          videos: channel.videos,
          createdAtMs: existing?.createdAtMs || nowMs,
          updatedAtMs: nowMs,
          lastSyncedAtMs: nowMs,
        },
        { merge: true }
      );
    }

    await batch.commit();
  }

  return {
    channels: fetchedChannels.map((channel) => {
      const existing = existingMap.get(channel.id);
      const randomIndex =
        !refreshRandomIndex && isValidRandomIndex(existing?.randomIndex)
          ? existing.randomIndex
          : channel.randomIndex;

      return {
        ...channel,
        randomIndex,
      };
    }),
    missingChannelIds,
  };
}

async function reindexChannels(options) {
  const { db, channelIds } = options;
  const collection = db.collection(getChannelsCollectionName());
  const specificIds = parseChannelIds(channelIds);
  let updatedCount = 0;

  if (specificIds.length > 0) {
    for (const idChunk of chunk(specificIds, WRITE_BATCH_LIMIT)) {
      const refs = idChunk.map((channelId) => collection.doc(channelId));
      const snapshots = await db.getAll(...refs);
      const batch = db.batch();
      const nowMs = Date.now();

      for (const snapshot of snapshots) {
        if (!snapshot.exists) {
          continue;
        }

        batch.update(snapshot.ref, {
          randomIndex: Math.random(),
          updatedAtMs: nowMs,
        });
        updatedCount += 1;
      }

      await batch.commit();
    }

    return updatedCount;
  }

  let lastDocumentId = null;

  while (true) {
    let query = collection
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(WRITE_BATCH_LIMIT);

    if (lastDocumentId) {
      query = query.startAfter(lastDocumentId);
    }

    const snapshot = await query.get();

    if (snapshot.empty) {
      break;
    }

    const batch = db.batch();
    const nowMs = Date.now();

    for (const doc of snapshot.docs) {
      batch.update(doc.ref, {
        randomIndex: Math.random(),
        updatedAtMs: nowMs,
      });
      updatedCount += 1;
    }

    await batch.commit();
    lastDocumentId = snapshot.docs[snapshot.docs.length - 1].id;

    if (snapshot.size < WRITE_BATCH_LIMIT) {
      break;
    }
  }

  return updatedCount;
}

async function fetchChannelsFromYouTube(channelIds) {
  const uniqueIds = parseChannelIds(channelIds);

  if (!uniqueIds.length) {
    return [];
  }

  try {
    const response = await axios.get("https://www.googleapis.com/youtube/v3/channels", {
      params: {
        part: "snippet,statistics",
        id: uniqueIds.join(","),
        key: process.env.YOUTUBE_API_KEY,
      },
      timeout: 10000,
    });

    return (response.data?.items || []).map(normalizeYouTubeChannel);
  } catch (error) {
    const youtubeMessage =
      error.response?.data?.error?.message || "Unable to fetch data from YouTube.";
    throw createHttpError(502, youtubeMessage);
  }
}

async function searchChannelsPage(options) {
  const { query, regionCode, pageToken, order, relevanceLanguage } = options;

  try {
    const response = await axios.get("https://www.googleapis.com/youtube/v3/search", {
      params: {
        part: "snippet",
        type: "channel",
        q: query,
        maxResults: 50,
        order,
        regionCode,
        pageToken: pageToken || undefined,
        relevanceLanguage: relevanceLanguage || undefined,
        key: process.env.YOUTUBE_API_KEY,
      },
      timeout: 10000,
    });

    const items = response.data?.items || [];

    return {
      channelIds: items
        .map((item) => item.id?.channelId || item.snippet?.channelId)
        .filter(Boolean),
      nextPageToken: response.data?.nextPageToken || "",
    };
  } catch (error) {
    const youtubeMessage =
      error.response?.data?.error?.message || "Unable to discover channels from YouTube.";
    throw createHttpError(502, youtubeMessage);
  }
}

function normalizeYouTubeChannel(item) {
  const hiddenSubscriberCount = Boolean(item.statistics?.hiddenSubscriberCount);

  return {
    id: item.id,
    name: item.snippet?.title || "Unknown channel",
    image:
      item.snippet?.thumbnails?.high?.url ||
      item.snippet?.thumbnails?.default?.url ||
      "",
    description: item.snippet?.description || "",
    publishedAt: item.snippet?.publishedAt || null,
    hiddenSubscriberCount,
    subscribers: hiddenSubscriberCount
      ? null
      : parseYoutubeNumber(item.statistics?.subscriberCount),
    views: parseYoutubeNumber(item.statistics?.viewCount),
    videos: parseYoutubeNumber(item.statistics?.videoCount),
    randomIndex: Math.random(),
  };
}

function normalizeStoredChannel(snapshot) {
  const data = snapshot.data();

  return {
    id: snapshot.id,
    channelId: data.channelId || snapshot.id,
    randomIndex: data.randomIndex,
    hiddenSubscriberCount: Boolean(data.hiddenSubscriberCount),
    name: data.name || "Unknown channel",
    image: data.image || "",
    description: data.description || "",
    publishedAt: data.publishedAt || null,
    subscribers: parseYoutubeNumber(data.subscribers),
    views: parseYoutubeNumber(data.views),
    videos: parseYoutubeNumber(data.videos),
    createdAtMs: Number(data.createdAtMs) || null,
    updatedAtMs: Number(data.updatedAtMs) || null,
    lastSyncedAtMs: Number(data.lastSyncedAtMs) || null,
  };
}

function parseYoutubeNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isValidRandomIndex(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function ensureYoutubeApiKey() {
  if (!process.env.YOUTUBE_API_KEY) {
    throw createHttpError(
      500,
      "Missing YOUTUBE_API_KEY. Add it to environment variables before syncing channels."
    );
  }
}

function chunk(items, size) {
  const chunks = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

function readListFromFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*/, "").trim())
    .filter(Boolean);
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const contents = fs.readFileSync(filePath, "utf8");
  const lines = contents.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = stripWrappingQuotes(line.slice(separatorIndex + 1).trim());

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function stripWrappingQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

module.exports = {
  buildChannelCard,
  compareChannels,
  collectRequestedChannelIds,
  createApiApp,
  loadEnvFile,
  resolveMetric,
  resolveRequestedCount,
};
