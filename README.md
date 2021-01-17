Hacker News (unofficial) API
============================

Yet another unofficial API for [Hacker News](http://news.ycombinator.com/). Currently being used by [my other project](https://github.com/cheeaun/hackerweb). Feel free to fork and contribute.

- API: <https://node-hnapi.herokuapp.com/>
- API (Cloudflare CDN, faster response time): <http://api.hackerwebapp.com/>
- API Documentation: <https://github.com/cheeaun/node-hnapi/wiki/API-Documentation>

---

☕️ Buy me a coffee ☕ (server, domain & maintenance)
--

[![Donate](https://d1iczxrky3cnb2.cloudfront.net/button-small-blue.png)](https://donorbox.org/support-cheeaun) [![Buy me a coffee](https://www.buymeacoffee.com/assets/img/custom_images/orange_img.png)](https://www.buymeacoffee.com/cheeaun)

---

🚧 PLEASE READ THIS 🚧
---

If you are planning to scrape a *huge* amount of posts or (historical) data from HN, please **don't use this API**. Use the official [Hacker News API](https://github.com/HackerNews/API) or [HN Search API](http://hn.algolia.com/api) instead.

---

Quick Start
----------

1. `git clone` this repo.
2. `cd` to repo folder.
3. Optionally download, install and start [redis](http://redis.io/download).
4. `npm i`
5. `npm start`
6. Load `localhost:1337` in your web browser.


Example
-------------

> <http://api.hackerwebapp.com/news?page=2>

Configuration
-------------

HNapi uses [dotenv](https://github.com/motdotla/dotenv) for configuration.

- `PORT` - (default: `1337`) Server port
- `CACHE_EXP` - (default: `600`) Cache expiry in seconds
- `LOG_REFERER` - (default: `false`) Logs referers
- `LOG_USERAGENT` - (default: `false`) Logs user-agent strings
- `CACHE_MEMORY` - (default: `true`) Use in-memory caching
- `CACHE_STORE` - (`redis`, default: none) Specify the cache store
- `CACHE_SERVER` - `HOST:PORT` for Redis server

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
