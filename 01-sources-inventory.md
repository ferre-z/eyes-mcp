# Sources Inventory

> All data sources surveyed. Tiered by friction (auth, rate limits, fragility).

## Tier 1 — Free, no auth, no drama
| Source | What | Mechanism |
|---|---|---|
| **arXiv** | Papers, abstracts, citations | `arxiv` API |
| **Wikipedia** | Encyclopedic facts | `mediawiki` API |
| **OpenStreetMap** | POIs, geocoding, routes | Overpass + Nominatim |
| **Hacker News** | Tech discussions | Algolia HN search API |
| **GitHub** | Repos, code, issues, releases | REST API (60/hr unauth) |
| **Crawl4AI** | Any URL → markdown | Local Docker (already have) |
| **SearXNG** | Aggregated web search | Local Docker (already have) |

## Tier 2 — Free, optional auth = better rate limit
| Source | What | Auth effect |
|---|---|---|
| **Reddit** | Threads, comments | Unauth: 60/hr, PRAW: 600/10min |
| **YouTube** | Transcripts, metadata | No key needed |
| **X/Twitter** | Posts, search | OAuth = full, scrape = fragile |
| **PubMed** | Biomedical papers | 3/s default, 10/s with key |
| **Semantic Scholar** | Papers, citations, authors | 100/s with free key |
| **OpenAlex** | Papers, authors, concepts | Polite pool with email |
| **Crossref** | DOIs, citations | No key |
| **HuggingFace** | Models, datasets, papers | No key |
| **Stack Exchange** | Q&A across all sites | Free API |
| **Wikidata** | Structured facts | Free |
| **Nominatim** | Geocoding | 1/s, free |

## Tier 3 — Free but fragile / scrapy
| Source | Notes |
|---|---|
| **Bluesky** | ATProto, public firehose |
| **Mastodon** | Federated, per-instance API |
| **LinkedIn** | No official API; Crawl4AI only |
| **TikTok** | No clean public API |
| **Instagram** | No clean public API |
| **Pinterest** | No clean public API |
| **Substack** | RSS works, transcripts rough |
| **Medium** | RSS per author, paywall |
| **DEV.to, Hashnode** | Free APIs |
| **Discord** | Bot token required |
| **Telegram** | MTProto, public channels OK |
| **RSS / Atom** | Universal — `blogwatcher` skill exists |

## Tier 4 — Paid / key-required (quality > cost)
| Source | Adds |
|---|---|
| **Tavily / Exa / Serper** | Search APIs tuned for agents |
| **YouTube Data API v3** | Official metadata, 10k units/day |
| **Brave Search** | High-quality search, free tier |
| **SerpAPI** | Google SERP scraping |
| **NewsAPI / GDELT** | News archives, real-time events |
| **OpenAI / Anthropic / Gemini** | LLM synthesis |
| **Wolfram Alpha** | Math, facts |
| **FRED, World Bank, IMF** | Economic data |
| **OpenWeatherMap** | Weather |
| **CoinGecko** | Crypto prices |
| **Yahoo Finance** | Stocks via `yfinance` |

## Vertical / domain
| Domain | Sources |
|---|---|
| Academic | arXiv, PubMed, Semantic Scholar, OpenAlex, Crossref, DBLP |
| Code | GitHub, GitLab, Bitbucket, SourceHut, npm, PyPI, crates.io |
| News | NewsAPI, GDELT, RSS, Common Crawl |
| Social | Reddit, X, Bluesky, Mastodon, HN, Lemmy |
| Video | YouTube, Vimeo (oEmbed), TikTok (fragile) |
| Books/PDFs | OpenLibrary, Internet Archive, arXiv PDFs |
| Datasets | Kaggle, HuggingFace, data.gov, EU Open Data |
| Patents | USPTO, Google Patents, EPO |
| Legal | CourtListener, RECAP, gov sites |
| Company info | OpenCorporates, SEC EDGAR, Crunchbase (paid) |
| OSINT | Wayback, Censys, Shodan, HIBP |
| Maps/Geo | OSM, Nominatim, Google Maps (paid) |

## Universal "fetch anything" fallback
- **Crawl4AI** — any URL → markdown
- **yt-dlp** — any video → transcript/metadata
- **Wayback Machine API** — historical snapshots
- **Common Crawl** — bulk web crawl index

---

## Source categories (proposed shape)
```
sources:
  general:    [searxng, crawl4ai, wayback]
  code:       [github, gitlab, npm, pypi, crates]
  academic:   [arxiv, pubmed, semantic_scholar, openalex]
  social:     [reddit, hackernews, x, bluesky, mastodon]
  video:      [youtube, vimeo_oembed]
  news:       [newsapi, gdelt, rss]
  financial:  [coingecko, yahoo_finance, fred, sec_edgar]
  geospatial: [osm, nominatim]
  datasets:   [huggingface, kaggle, internet_archive]
  vertical:   [wolfram, openlibrary, patents, legal]
```

## v1 default (proposed)
- **All Tier 1** + **Reddit, YouTube, X** (Tier 2 with cleanest free paths)
- **Academic block** (arXiv, PubMed, Semantic Scholar, OpenAlex)
- Everything else = opt-in adapters behind feature flags
