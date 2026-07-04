import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetNewsCache,
  decodeEntities,
  getMarketNews,
  type NewsFeedDef,
  parseFeed,
} from "./news";

// Synthetic fixtures only — no real fund codes, no real headlines.

const RSS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Example RSS Feed</title>
    <item>
      <title>Long-term thinking matters</title>
      <link>https://example.test/posts/long-term</link>
      <guid isPermaLink="false">post-1</guid>
      <pubDate>Wed, 21 May 2026 10:00:00 +0000</pubDate>
    </item>
    <item>
      <title>Cost averaging revisited</title>
      <link>https://example.test/posts/dca</link>
      <guid>post-2</guid>
      <pubDate>Tue, 20 May 2026 09:00:00 +0000</pubDate>
    </item>
    <item>
      <title>Item with no date</title>
      <link>https://example.test/posts/no-date</link>
    </item>
    <item>
      <title>Missing link, should drop</title>
    </item>
  </channel>
</rss>`;

const RSS_WITH_CDATA = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <item>
      <title><![CDATA[Title with & ampersand]]></title>
      <link>https://example.test/cdata-1</link>
      <pubDate>Mon, 19 May 2026 08:00:00 +0000</pubDate>
    </item>
  </channel>
</rss>`;

const ATOM_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example Atom Feed</title>
  <entry>
    <title>Forum post one</title>
    <id>urn:uuid:111</id>
    <link rel="alternate" href="https://atom.test/threads/1" />
    <updated>2026-05-22T12:00:00Z</updated>
  </entry>
  <entry>
    <title>Forum post two</title>
    <id>urn:uuid:222</id>
    <link href="https://atom.test/threads/2" />
    <published>2026-05-22T11:00:00Z</published>
  </entry>
</feed>`;

const FEED_A: NewsFeedDef = { id: "feedA", name: "Feed A", url: "https://example.test/a" };
const FEED_B: NewsFeedDef = { id: "feedB", name: "Feed B", url: "https://atom.test/b" };

describe("decodeEntities", () => {
  it("decodes single-encoded numeric and named entities", () => {
    expect(decodeEntities("What I&#8217;ve Learned")).toBe("What I’ve Learned");
    expect(decodeEntities("Risk &amp; Reward")).toBe("Risk & Reward");
    expect(decodeEntities("&#x2019;")).toBe("’");
  });

  it("decodes double-encoded entities in one pass (&amp;#NNN;)", () => {
    expect(decodeEntities("What I&amp;#8217;ve Learned")).toBe("What I’ve Learned");
    expect(decodeEntities("Risk &amp;#038; Reward")).toBe("Risk & Reward");
  });

  it("leaves plain text and unknown entities untouched", () => {
    expect(decodeEntities("Plain title, no entities")).toBe("Plain title, no entities");
    expect(decodeEntities("a &bogus; b")).toBe("a &bogus; b");
  });
});

describe("parseFeed (RSS 2.0)", () => {
  it("extracts title / url / publishedAt from <item> elements", () => {
    const items = parseFeed(RSS_FIXTURE, FEED_A);
    expect(items.length).toBe(3); // 4th item dropped (no link)
    expect(items[0]).toMatchObject({
      title: "Long-term thinking matters",
      url: "https://example.test/posts/long-term",
      source: "Feed A",
    });
    expect(items[0].publishedAt).toBe("2026-05-21T10:00:00.000Z");
  });

  it("normalizes guid into a stable feed-scoped id", () => {
    const items = parseFeed(RSS_FIXTURE, FEED_A);
    expect(items[0].id).toBe("feedA:post-1");
    expect(items[1].id).toBe("feedB:post-2".replace("feedB", "feedA"));
  });

  it("falls back to url as id when guid missing", () => {
    const items = parseFeed(RSS_FIXTURE, FEED_A);
    const noDate = items.find((i) => i.title === "Item with no date");
    expect(noDate).toBeTruthy();
    expect(noDate?.id).toBe(`feedA:${noDate?.url}`);
    expect(noDate?.publishedAt).toBe("");
  });

  it("handles CDATA-wrapped titles", () => {
    const items = parseFeed(RSS_WITH_CDATA, FEED_A);
    expect(items.length).toBe(1);
    expect(items[0].title).toBe("Title with & ampersand");
  });

  it("returns [] on malformed XML", () => {
    expect(parseFeed("<<not xml", FEED_A)).toEqual([]);
    expect(parseFeed("", FEED_A)).toEqual([]);
  });

  it("returns [] on a document with no recognized envelope", () => {
    expect(parseFeed("<html><body>hi</body></html>", FEED_A)).toEqual([]);
  });

  it("handles CDATA-wrapped pubDate (Federal Reserve feed shape)", () => {
    // The Fed's press_monetary.xml wraps pubDate values in CDATA. Confirm
    // textValue() unwraps both <title> CDATA and <pubDate> CDATA the same way.
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0">
  <channel>
    <title>FRB: Press Release - Monetary Policy</title>
    <item>
      <title><![CDATA[Federal Reserve issues FOMC statement]]></title>
      <link><![CDATA[https://www.federalreserve.gov/newsevents/pressreleases/monetary20260429a.htm]]></link>
      <guid><![CDATA[https://www.federalreserve.gov/newsevents/pressreleases/monetary20260429a.htm]]></guid>
      <pubDate><![CDATA[Wed, 29 Apr 2026 18:00:00 GMT]]></pubDate>
    </item>
  </channel>
</rss>`;
    const items = parseFeed(xml, {
      id: "fed-monetary",
      name: "Federal Reserve · Monetary Policy",
      url: "https://www.federalreserve.gov/feeds/press_monetary.xml",
    });
    expect(items.length).toBe(1);
    expect(items[0].title).toBe("Federal Reserve issues FOMC statement");
    expect(items[0].url).toBe(
      "https://www.federalreserve.gov/newsevents/pressreleases/monetary20260429a.htm",
    );
    expect(items[0].publishedAt).toBe("2026-04-29T18:00:00.000Z");
    expect(items[0].source).toBe("Federal Reserve · Monetary Policy");
  });
});

describe("parseFeed (Atom 1.0)", () => {
  it("extracts entries with rel=alternate href and falls back to first link", () => {
    const items = parseFeed(ATOM_FIXTURE, FEED_B);
    expect(items.length).toBe(2);
    expect(items[0]).toMatchObject({
      title: "Forum post one",
      url: "https://atom.test/threads/1",
      source: "Feed B",
      publishedAt: "2026-05-22T12:00:00.000Z",
    });
    expect(items[1].url).toBe("https://atom.test/threads/2");
    expect(items[1].publishedAt).toBe("2026-05-22T11:00:00.000Z");
  });

  it("prefixes ids with feed slug", () => {
    const items = parseFeed(ATOM_FIXTURE, FEED_B);
    expect(items[0].id).toBe("feedB:urn:uuid:111");
  });
});

describe("getMarketNews aggregator", () => {
  afterEach(() => {
    __resetNewsCache();
    vi.restoreAllMocks();
  });

  function stubFetch(map: Record<string, string | Error>): typeof fetch {
    return vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      const v = map[url];
      if (v == null) throw new Error(`unexpected fetch: ${url}`);
      if (v instanceof Error) throw v;
      return new Response(v, {
        status: 200,
        headers: { "Content-Type": "application/xml" },
      });
    }) as unknown as typeof fetch;
  }

  it("dedupes by URL across feeds", async () => {
    const SHARED_URL = "https://example.test/shared";
    const feedA = `<?xml version="1.0"?><rss version="2.0"><channel>
      <item><title>Dup A</title><link>${SHARED_URL}</link><pubDate>Tue, 20 May 2026 09:00:00 +0000</pubDate></item>
      <item><title>Unique A</title><link>https://example.test/a-only</link><pubDate>Tue, 20 May 2026 10:00:00 +0000</pubDate></item>
    </channel></rss>`;
    const feedB = `<?xml version="1.0"?><rss version="2.0"><channel>
      <item><title>Dup B</title><link>${SHARED_URL}</link><pubDate>Wed, 21 May 2026 09:00:00 +0000</pubDate></item>
      <item><title>Unique B</title><link>https://example.test/b-only</link><pubDate>Tue, 20 May 2026 11:00:00 +0000</pubDate></item>
    </channel></rss>`;
    const fetcher = stubFetch({
      "https://example.test/a": feedA,
      "https://example.test/b": feedB,
    });
    const out = await getMarketNews(
      [
        { id: "a", name: "A", url: "https://example.test/a" },
        { id: "b", name: "B", url: "https://example.test/b" },
      ],
      { fetcher, now: Date.now() },
    );
    const urls = out.items.map((i) => i.url);
    expect(urls.filter((u) => u === SHARED_URL).length).toBe(1);
    expect(out.items.length).toBe(3);
  });

  it("sorts newest first, with empty publishedAt last", async () => {
    const feed = `<?xml version="1.0"?><rss version="2.0"><channel>
      <item><title>Old</title><link>https://x.test/old</link><pubDate>Mon, 19 May 2026 00:00:00 +0000</pubDate></item>
      <item><title>New</title><link>https://x.test/new</link><pubDate>Wed, 21 May 2026 00:00:00 +0000</pubDate></item>
      <item><title>Mid</title><link>https://x.test/mid</link><pubDate>Tue, 20 May 2026 00:00:00 +0000</pubDate></item>
      <item><title>Undated</title><link>https://x.test/undated</link></item>
    </channel></rss>`;
    const fetcher = stubFetch({ "https://x.test/feed": feed });
    const out = await getMarketNews([{ id: "x", name: "X", url: "https://x.test/feed" }], {
      fetcher,
      now: Date.now(),
    });
    expect(out.items.map((i) => i.title)).toEqual(["New", "Mid", "Old", "Undated"]);
  });

  it("caps at 30 items even with more available", async () => {
    const items = Array.from({ length: 50 }, (_, i) => {
      const d = new Date(`2026-05-${String(i + 1).padStart(2, "0")}T00:00:00Z`);
      return `<item><title>Item ${i}</title><link>https://x.test/p${i}</link><pubDate>${d.toUTCString()}</pubDate></item>`;
    }).join("");
    const feed = `<?xml version="1.0"?><rss version="2.0"><channel>${items}</channel></rss>`;
    const fetcher = stubFetch({ "https://x.test/feed": feed });
    const out = await getMarketNews([{ id: "x", name: "X", url: "https://x.test/feed" }], {
      fetcher,
      now: Date.now(),
    });
    expect(out.items.length).toBe(30);
  });

  it("survives partial failure — one feed throws, the other still returns", async () => {
    const goodFeed = `<?xml version="1.0"?><rss version="2.0"><channel>
      <item><title>Still here</title><link>https://good.test/p</link><pubDate>Tue, 20 May 2026 09:00:00 +0000</pubDate></item>
    </channel></rss>`;
    const fetcher = stubFetch({
      "https://good.test/feed": goodFeed,
      "https://bad.test/feed": new Error("ECONNRESET"),
    });
    const out = await getMarketNews(
      [
        { id: "good", name: "Good", url: "https://good.test/feed" },
        { id: "bad", name: "Bad", url: "https://bad.test/feed" },
      ],
      { fetcher, now: Date.now() },
    );
    expect(out.items.length).toBe(1);
    expect(out.items[0].source).toBe("Good");
    expect(out.failures).toBe(1);
  });

  it("returns failures=N when ALL feeds fail (empty graceful state)", async () => {
    const fetcher = stubFetch({
      "https://a.test/feed": new Error("down"),
      "https://b.test/feed": new Error("down"),
    });
    const out = await getMarketNews(
      [
        { id: "a", name: "A", url: "https://a.test/feed" },
        { id: "b", name: "B", url: "https://b.test/feed" },
      ],
      { fetcher, now: Date.now() },
    );
    expect(out.items).toEqual([]);
    expect(out.failures).toBe(2);
    expect(out.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("serves cached result inside the 30-min window without re-fetching", async () => {
    const feed = `<?xml version="1.0"?><rss version="2.0"><channel>
      <item><title>Cached</title><link>https://c.test/p</link><pubDate>Tue, 20 May 2026 09:00:00 +0000</pubDate></item>
    </channel></rss>`;
    const fetcher = vi.fn(
      async () =>
        new Response(feed, { status: 200, headers: { "Content-Type": "application/xml" } }),
    ) as unknown as typeof fetch;
    const feeds = [{ id: "c", name: "C", url: "https://c.test/feed" }];
    const t = Date.parse("2026-05-20T12:00:00Z");
    const first = await getMarketNews(feeds, { fetcher, now: t });
    const second = await getMarketNews(feeds, { fetcher, now: t + 10 * 60_000 }); // +10 min
    expect(first).toBe(second);
    expect((fetcher as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1);
  });

  it("re-fetches after the cache TTL expires", async () => {
    const feed = `<?xml version="1.0"?><rss version="2.0"><channel>
      <item><title>X</title><link>https://c.test/p</link><pubDate>Tue, 20 May 2026 09:00:00 +0000</pubDate></item>
    </channel></rss>`;
    const fetcher = vi.fn(
      async () =>
        new Response(feed, { status: 200, headers: { "Content-Type": "application/xml" } }),
    ) as unknown as typeof fetch;
    const feeds = [{ id: "c", name: "C", url: "https://c.test/feed" }];
    const t = Date.parse("2026-05-20T12:00:00Z");
    await getMarketNews(feeds, { fetcher, now: t });
    await getMarketNews(feeds, { fetcher, now: t + 31 * 60_000 }); // > 30 min later
    expect((fetcher as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(2);
  });
});
