import express from 'express'

/*
  Keep crawlers out. Everything worth seeing already needs an account, so
  this mostly stops bots from probing and indexing the sign-in pages:

  - search and AI crawlers get a flat 403 on every path;
  - link-preview bots (WhatsApp, Telegram, iMessage...) may fetch pages so a
    shared invite shows its title, which never includes a photo;
  - every response says noindex/nofollow/noarchive.

  Cloudflare also blocks verified crawlers before they reach us; this is the
  second line for unverified ones that announce themselves.
*/

const CRAWLERS = new RegExp([
  // AI training / answer-engine crawlers
  'GPTBot', 'ChatGPT-User', 'OAI-SearchBot', 'ClaudeBot', 'Claude-Web', 'Claude-User', 'Claude-SearchBot', 'anthropic-ai',
  'CCBot', 'Google-Extended', 'GoogleOther', 'PerplexityBot', 'Perplexity-User', 'Bytespider', 'Amazonbot', 'Applebot',
  'meta-externalagent', 'meta-externalfetcher', 'FacebookBot', 'cohere-ai', 'Diffbot', 'YouBot', 'ImagesiftBot',
  'Omgili', 'Timpibot', 'PetalBot', 'AI2Bot', 'Ai2Bot-Dolma', 'Scrapy', 'img2dataset', 'DuckAssistBot', 'MistralAI-User',
  // Search engines and SEO crawlers
  'Googlebot', 'bingbot', 'Slurp', 'DuckDuckBot', 'Baiduspider', 'YandexBot', 'Sogou', 'Exabot', 'SeznamBot',
  'AhrefsBot', 'SemrushBot', 'MJ12bot', 'DotBot', 'BLEXBot', 'DataForSeoBot', 'serpstatbot', 'MegaIndex',
  // Generic tells
  'crawler', 'spider', 'python-requests', 'Go-http-client', 'HeadlessChrome', 'PhantomJS', 'wget'
].join('|'), 'i')

const PREVIEW_BOTS = /WhatsApp|facebookexternalhit|Twitterbot|Slackbot|TelegramBot|Discordbot|LinkedInBot|SkypeUriPreview|redditbot|Iframely|vkShare/i

export function isCrawler (userAgent: string): boolean {
  if (!userAgent) return false
  if (PREVIEW_BOTS.test(userAgent)) return false
  return CRAWLERS.test(userAgent)
}

export function blockBots (req: express.Request, res: express.Response, next: express.NextFunction) {
  res.set('X-Robots-Tag', 'noindex, nofollow, noarchive, noimageindex, nosnippet')
  if (req.path === '/robots.txt') return next()
  if (isCrawler(req.headers['user-agent'] || '')) {
    res.status(403).type('text/plain').send('Forbidden')
    return
  }
  next()
}
