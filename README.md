Hacker News (unofficial) API
============================

Yet another unofficial API for [Hacker News](http://news.ycombinator.com/). Currently being used by [my other project](https://github.com/cheeaun/hackerweb). Feel free to fork and contribute.

- API: <https://node-hnapi.herokuapp.com/>
- API (Cloudflare CDN, faster response time): <http://api.hackerwebapp.com/>
- API Documentation: <https://github.com/cheeaun/node-hnapi/wiki/API-Documentation>

[![Donate](https://d1iczxrky3cnb2.cloudfront.net/button-small-blue.png) 🙏🙏🙏 Please support my work (domain and server hosting fees)](https://donorbox.org/support-cheeaun)

[![Deploy](https://www.herokucdn.com/deploy/button.png)](https://heroku.com/deploy)

<a href="https://app.codesponsor.io/link/jps1dCLmKkCZBFiD34w2388o/cheeaun/node-hnapi" rel="nofollow"><img src="https://app.codesponsor.io/embed/jps1dCLmKkCZBFiD34w2388o/cheeaun/node-hnapi.svg" style="width: 888px; height: 68px;" alt="Sponsor" /></a>

---

# PLEASE READ THIS

If you are planning to scrape a *huge* amount of posts or (historical) data from HN, please **don't use this API**. Use the official [Hacker News API](https://github.com/HackerNews/API) or [HN Search API](http://hn.algolia.com/api) instead.

---

Quick Start
----------

1. `git clone` this repo.
2. `cd` to repo folder.
3. Optionally download, install and start [redis](http://redis.io/download) or [memcached](http://memcached.org/).
4. `yarn`
5. `yarn start`
6. Load `localhost` in your web browser.


Example
-------------
<https://node-hnapi.herokuapp.com/news?page=3>

Configuration
-------------

HNapi uses [dotenv](https://github.com/motdotla/dotenv) for configuration.

- `PORT` - (default: `1337`) Server port
- `CACHE_EXP` - (default: `600`) Cache expiry in seconds
- `LOG_REFERER` - (default: `false`) Logs referers
- `LOG_USERAGENT` - (default: `false`) Logs user-agent strings
- `CACHE_MEMORY` - (default: `true`) Use in-memory caching
- `CACHE_STORE` - (`memcached`, default: none) Specify the cache store
- `CACHE_SERVERS` - `HOST:PORT` for memcached server

License
-------

Licensed under the [MIT License](http://cheeaun.mit-license.org/).

Other APIs
----------

- [The official Hacker News API](https://github.com/HackerNews/API)
- <http://hn.algolia.com/api>
- <http://api.ihackernews.com/>
- <http://hndroidapi.appspot.com/>
- <http://www.hnsearch.com/api>
- <https://github.com/Boxyco/hackernews-api>
