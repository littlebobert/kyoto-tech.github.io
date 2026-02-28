import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import Parser from "rss-parser";

const DEFAULT_OUTPUT_PATH = path.resolve(
  process.env.COMPOSITE_FEED_OUTPUT || "src/data/composite-feed.json",
);
const DEFAULT_ITEMS_PER_FEED = Number(
  process.env.COMPOSITE_FEED_ITEMS_PER_FEED || 3,
);
const FEED_TIMEOUT_MS = Number(process.env.COMPOSITE_FEED_TIMEOUT_MS || 12000);
const ITEM_PAGE_TIMEOUT_MS = Number(
  process.env.COMPOSITE_FEED_ITEM_PAGE_TIMEOUT_MS || 8000,
);
const USER_AGENT =
  "Kyoto Tech Meetup feed aggregator (+https://kyoto-tech.github.io)";
const MEMBER_FEEDS_PATH = path.resolve("src/data/member-feeds.json");
const YOUTUBE_HOSTNAMES = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
]);
const YOUTUBE_CHANNEL_ID_PATTERN = /^UC[\w-]{22}$/;

function parseArgs(argv) {
  const args = {
    staleOk: false,
    outputPath: DEFAULT_OUTPUT_PATH,
    itemsPerFeed: DEFAULT_ITEMS_PER_FEED,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--stale-ok") {
      args.staleOk = true;
    } else if (arg === "--output" && argv[i + 1]) {
      args.outputPath = path.resolve(argv[i + 1]);
      i += 1;
    } else if (arg === "--items-per-feed" && argv[i + 1]) {
      args.itemsPerFeed = Number(argv[i + 1]);
      i += 1;
    }
  }

  return args;
}

async function loadMemberFeeds() {
  const content = await fs.readFile(MEMBER_FEEDS_PATH, "utf8");
  const parsed = JSON.parse(content);
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected an array in ${MEMBER_FEEDS_PATH}`);
  }
  return parsed.map((item) => {
    if (!item?.name || !item?.feedUrl || !item?.siteUrl) {
      throw new Error(
        `Missing required fields in member feed entry: ${JSON.stringify(item)}`,
      );
    }
    return {
      name: String(item.name),
      feedUrl: String(item.feedUrl),
      siteUrl: String(item.siteUrl),
    };
  });
}

function parseDate(rawItem) {
  const raw =
    rawItem.isoDate ||
    rawItem.pubDate ||
    rawItem.published ||
    rawItem.updated ||
    null;
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.valueOf()) ? null : date;
}

function stripHtml(value) {
  if (!value || typeof value !== "string") return "";
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function truncate(value, max = 320) {
  if (!value) return "";
  return value.length > max ? `${value.slice(0, max - 3).trimEnd()}...` : value;
}

function isYoutubeUrl(value) {
  if (!value || typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return YOUTUBE_HOSTNAMES.has(parsed.hostname) || parsed.hostname === "youtu.be";
  } catch {
    return false;
  }
}

function extractMediaUrl(value) {
  if (!value) return null;
  if (typeof value === "string") {
    return value.startsWith("http") ? value : null;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const url = extractMediaUrl(entry);
      if (url) return url;
    }
    return null;
  }
  if (typeof value === "object") {
    if (typeof value.url === "string" && value.url.startsWith("http")) {
      return value.url;
    }
    if (typeof value.href === "string" && value.href.startsWith("http")) {
      return value.href;
    }
    if (typeof value.$?.url === "string" && value.$.url.startsWith("http")) {
      return value.$.url;
    }
  }
  return null;
}

function toHtmlString(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const html = toHtmlString(entry);
      if (html) return html;
    }
    return "";
  }
  if (typeof value === "object") {
    if (typeof value._ === "string") return value._;
    if (typeof value["#text"] === "string") return value["#text"];
  }
  return "";
}

function resolveImageUrl(rawUrl, baseUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return null;
  if (rawUrl.startsWith("http://") || rawUrl.startsWith("https://")) {
    return rawUrl;
  }
  if (rawUrl.startsWith("//")) {
    return `https:${rawUrl}`;
  }

  if (!baseUrl) return null;
  try {
    return new URL(rawUrl, baseUrl).toString();
  } catch {
    return null;
  }
}

function extractFirstImageFromHtml(value, baseUrl) {
  const html = toHtmlString(value);
  if (!html) return null;

  const srcMatch = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  const srcUrl = resolveImageUrl(srcMatch?.[1], baseUrl);
  if (srcUrl) return srcUrl;

  const dataSrcMatch = html.match(/<img[^>]+data-src=["']([^"']+)["']/i);
  const dataSrcUrl = resolveImageUrl(dataSrcMatch?.[1], baseUrl);
  if (dataSrcUrl) return dataSrcUrl;

  const srcsetMatch = html.match(/<img[^>]+srcset=["']([^"']+)["']/i);
  if (srcsetMatch?.[1]) {
    const firstCandidate = srcsetMatch[1].split(",")[0]?.trim().split(/\s+/)[0];
    const srcsetUrl = resolveImageUrl(firstCandidate, baseUrl);
    if (srcsetUrl) return srcsetUrl;
  }

  return null;
}

function getHtmlAttribute(tag, attribute) {
  if (!tag || !attribute) return null;
  const quoted = tag.match(
    new RegExp(`${attribute}\\s*=\\s*["']([^"']+)["']`, "i"),
  );
  if (quoted?.[1]) return quoted[1];

  const unquoted = tag.match(
    new RegExp(`${attribute}\\s*=\\s*([^\\s"'/>]+)`, "i"),
  );
  return unquoted?.[1] || null;
}

function extractMetaImageFromHtml(html, baseUrl) {
  if (!html || typeof html !== "string") return null;

  const imageKeys = new Set([
    "og:image",
    "og:image:url",
    "og:image:secure_url",
    "twitter:image",
    "twitter:image:src",
  ]);

  const metaTags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const metaTag of metaTags) {
    const property = (getHtmlAttribute(metaTag, "property") || "").toLowerCase();
    const name = (getHtmlAttribute(metaTag, "name") || "").toLowerCase();
    const itemProp = (getHtmlAttribute(metaTag, "itemprop") || "").toLowerCase();
    const content = getHtmlAttribute(metaTag, "content");

    if (!content) continue;
    if (
      imageKeys.has(property) ||
      imageKeys.has(name) ||
      itemProp === "image"
    ) {
      const imageUrl = resolveImageUrl(content, baseUrl);
      if (imageUrl) return imageUrl;
    }
  }

  return null;
}

function extractPageImage(html, pageUrl) {
  return (
    extractMetaImageFromHtml(html, pageUrl) ||
    extractFirstImageFromHtml(html, pageUrl)
  );
}

function normalizeYoutubeVideoId(candidate) {
  if (!candidate || typeof candidate !== "string") return null;
  const trimmed = candidate.trim();
  return /^[A-Za-z0-9_-]{11}$/.test(trimmed) ? trimmed : null;
}

function extractYoutubeVideoId(rawItem) {
  const directCandidates = [
    rawItem["yt:videoId"],
    rawItem.videoId,
    rawItem["youtube:videoId"],
  ];

  for (const candidate of directCandidates) {
    const videoId = normalizeYoutubeVideoId(candidate);
    if (videoId) return videoId;
  }

  const idCandidates = [rawItem.id, rawItem.guid];
  for (const candidate of idCandidates) {
    if (typeof candidate !== "string") continue;
    const match = candidate.match(/yt:video:([A-Za-z0-9_-]{11})/i);
    const videoId = normalizeYoutubeVideoId(match?.[1]);
    if (videoId) return videoId;
  }

  if (typeof rawItem.link !== "string") return null;
  try {
    const link = new URL(rawItem.link);
    if (link.hostname === "youtu.be") {
      const fromPath = normalizeYoutubeVideoId(link.pathname.replace(/^\//, ""));
      if (fromPath) return fromPath;
    }
    if (YOUTUBE_HOSTNAMES.has(link.hostname) || link.hostname === "music.youtube.com") {
      const fromQuery = normalizeYoutubeVideoId(link.searchParams.get("v"));
      if (fromQuery) return fromQuery;

      const pathMatch = link.pathname.match(
        /^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})/,
      );
      const fromPath = normalizeYoutubeVideoId(pathMatch?.[1]);
      if (fromPath) return fromPath;
    }
  } catch {
    return null;
  }

  return null;
}

function resolveImage(rawItem, source) {
  const baseUrl =
    (typeof rawItem.link === "string" && rawItem.link) ||
    (typeof source?.siteUrl === "string" && source.siteUrl) ||
    null;

  const enclosureUrl =
    typeof rawItem.enclosure?.url === "string" ? rawItem.enclosure.url : null;
  if (enclosureUrl?.startsWith("http")) return enclosureUrl;

  const mediaUrlCandidates = [
    rawItem["media:thumbnail"],
    rawItem.mediaThumbnail,
    rawItem["media:content"],
    rawItem["media:group"]?.["media:thumbnail"],
    rawItem["media:group"]?.["media:content"],
    rawItem["media_group"]?.["media:thumbnail"],
    rawItem["media_group"]?.["media:content"],
  ];
  for (const candidate of mediaUrlCandidates) {
    const mediaUrl = extractMediaUrl(candidate);
    if (mediaUrl?.startsWith("http")) return mediaUrl;
  }

  const htmlCandidates = [
    rawItem["content:encoded"],
    rawItem.content,
    rawItem.summary,
    rawItem.description,
    rawItem["media:description"],
    rawItem["media:group"]?.["media:description"],
    rawItem["media_group"]?.["media:description"],
  ];
  for (const candidate of htmlCandidates) {
    const inlineImage = extractFirstImageFromHtml(candidate, baseUrl);
    if (inlineImage) return inlineImage;
  }

  if (isYoutubeUrl(source?.feedUrl) || isYoutubeUrl(source?.siteUrl)) {
    const videoId = extractYoutubeVideoId(rawItem);
    if (videoId) {
      return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    }
  }

  return null;
}

function normalizeItem(rawItem, source) {
  const publishedAt = parseDate(rawItem);
  if (!publishedAt) return null;

  const summary =
    rawItem.contentSnippet ||
    stripHtml(rawItem["content:encoded"]) ||
    stripHtml(rawItem.content) ||
    "";

  const key =
    rawItem.guid ||
    rawItem.id ||
    rawItem.link ||
    `${source.siteUrl}#${rawItem.title || "untitled"}#${publishedAt.toISOString()}`;

  return {
    id: key,
    title: rawItem.title || "Untitled",
    link: rawItem.link || source.siteUrl,
    publishedAt: publishedAt.toISOString(),
    source: {
      name: source.name,
      siteUrl: source.siteUrl,
      feedUrl: source.feedUrl,
    },
    summary: truncate(summary, 360),
    image: resolveImage(rawItem, source),
  };
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let res;
    try {
      res = await fetch(url, {
        signal: controller.signal,
        headers: { "user-agent": USER_AGENT },
      });
    } catch (error) {
      throw new Error(`Request failed for ${url}: ${error?.message || String(error)}`);
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function enrichItemWithLinkedPageImage(item) {
  if (item?.image || typeof item?.link !== "string") return item;
  if (!item.link.startsWith("http://") && !item.link.startsWith("https://")) {
    return item;
  }

  try {
    const html = await fetchWithTimeout(item.link, ITEM_PAGE_TIMEOUT_MS);
    const image = extractPageImage(html, item.link);
    if (!image) return item;
    return {
      ...item,
      image,
    };
  } catch {
    return item;
  }
}

function parseYoutubeChannelId(html) {
  if (!html) return null;
  const patterns = [
    /"externalId":"(UC[\w-]{22})"/,
    /"channelId":"(UC[\w-]{22})"/,
    /youtube\.com\/channel\/(UC[\w-]{22})/,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1] && YOUTUBE_CHANNEL_ID_PATTERN.test(match[1])) {
      return match[1];
    }
  }
  return null;
}

async function resolveFeedUrl(feedUrl) {
  let parsed;
  try {
    parsed = new URL(feedUrl);
  } catch {
    return feedUrl;
  }

  if (!YOUTUBE_HOSTNAMES.has(parsed.hostname)) return feedUrl;

  const handleMatch = parsed.pathname.match(/^\/@([A-Za-z0-9._-]+)\/?$/);
  if (!handleMatch) return feedUrl;

  const channelPageHtml = await fetchWithTimeout(feedUrl, FEED_TIMEOUT_MS);
  const channelId = parseYoutubeChannelId(channelPageHtml);
  if (!channelId) {
    throw new Error(`Could not resolve YouTube channel id from handle URL: ${feedUrl}`);
  }

  return `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
}

async function fetchFeed(source, parser) {
  const resolvedFeedUrl = await resolveFeedUrl(source.feedUrl);
  const xml = await fetchWithTimeout(resolvedFeedUrl, FEED_TIMEOUT_MS);
  const parsed = await parser.parseString(xml);
  return parsed?.items || [];
}

async function writeOutput(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2));
}

async function readExisting(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    const content = await fs.readFile(filePath, "utf8");
    return JSON.parse(content);
  } catch (error) {
    console.warn(`[feeds] Unable to read existing file ${filePath}:`, error);
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const memberFeeds = await loadMemberFeeds();
  const parser = new Parser();
  const now = new Date();
  const failures = [];
  const feedsWithItems = [];

  for (const source of memberFeeds) {
    try {
      const rawItems = await fetchFeed(source, parser);
      const seenIds = new Set();
      const normalizedItems = rawItems
        .map((rawItem) => normalizeItem(rawItem, source))
        .filter(Boolean)
        .filter((item) => {
          if (seenIds.has(item.id)) return false;
          seenIds.add(item.id);
          return true;
        })
        .sort(
          (a, b) =>
            new Date(b.publishedAt).valueOf() -
            new Date(a.publishedAt).valueOf(),
        )
        .slice(0, Math.max(1, args.itemsPerFeed));

      const itemsWithLinkedPageImages = await Promise.all(
        normalizedItems.map((item) => enrichItemWithLinkedPageImage(item)),
      );

      feedsWithItems.push({
        ...source,
        items: itemsWithLinkedPageImages,
      });
    } catch (error) {
      failures.push({ source: source.name, error: error?.message || String(error) });
      feedsWithItems.push({
        ...source,
        items: [],
        error: error?.message || String(error),
      });
    }
  }

  const totalItems = feedsWithItems.reduce(
    (sum, feed) => sum + (feed.items?.length || 0),
    0,
  );

  const payload = {
    generatedAt: now.toISOString(),
    itemsPerFeed: args.itemsPerFeed,
    feeds: feedsWithItems,
    failedSources: failures,
  };

  if (totalItems === 0 && args.staleOk) {
    const existing = await readExisting(args.outputPath);
    if (existing?.feeds?.length) {
      console.warn(
        `[feeds] Using existing data from ${args.outputPath} because fetching produced no items.`,
      );
      await writeOutput(args.outputPath, {
        ...existing,
        generatedAt: now.toISOString(),
        usedFallback: true,
      });
      return;
    }
  }

  await writeOutput(args.outputPath, payload);

  const successCount = memberFeeds.length - failures.length;
  console.log(
    `[feeds] Wrote ${totalItems} item(s) from ${successCount}/${memberFeeds.length} feed(s) to ${path.relative(process.cwd(), args.outputPath)}.`,
  );
  if (failures.length) {
    failures.forEach((failure) => {
      console.warn(`[feeds] Failed: ${failure.source} -> ${failure.error}`);
    });
  }
}

main().catch((error) => {
  console.error("[feeds] Unhandled error:", error);
  process.exit(1);
});
