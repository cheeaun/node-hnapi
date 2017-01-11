Hacker News (unofficial) API
============================

Yet another unofficial API for [Hacker News](http://news.ycombinator.com/). Currently being used by [my other project](https://github.com/cheeaun/hackerweb). Feel free to fork and contribute.

- API: <https://node-hnapi.herokuapp.com/>
- API Documentation: <https://github.com/cheeaun/node-hnapi/wiki/API-Documentation>

**NOTE**: If you are planning to scrape a *huge* amount of posts or (historical) data from HN, please **don't use this API**. Use the official [Hacker News API](https://github.com/HackerNews/API) or [HN Search API](http://hn.algolia.com/api) instead.

[![Deploy](https://www.herokucdn.com/deploy/button.png)](https://heroku.com/deploy)

Quick Start
----------

1. `git clone` this repo.
2. `cd` to repo folder.
3. Optionally download, install and start [redis](http://redis.io/download) or [memcached](http://memcached.org/).
4. `yarn`
5. yarn start`
6. Load `localhost` in your web browser.


Example
-------------
<https://node-hnapi.herokuapp.com/news?page=3>

Configuration
-------------

HNapi uses [nconf](https://github.com/flatiron/nconf) for configuration, which can be done via the `config.json` file, environment variables and command-line arguments.

- `port` - (default: `80`) Server port
- `cache_exp` - (default: `600`) Cache expiry in seconds
- `log_referer` - (default: `false`) Logs referers
- `log_useragent` - (default: `false`) Logs user-agent strings
- `cache`
	- `memory` - (default: `true`) Use in-memory caching
	- `store` - (`memcached` | `redis`, default: none) Specify the cache store
	- `options` - Options for specified cache store
		- `servers` - `HOST:PORT` for memcached server
		- `url` - `redis://USERNAME:PASSWORD@HOST:PORT` for redis server
		- `debug` - (default: `false`) Allows debugging (only for redis store)
- `papertrail` - for logging with [Papertrail](http://papertrailapp.com/)
	- `host`
	- `port`
	- `hostname` (optional) - host name for the server
- `universal_analytics` - for logging with [Google Analytics' Universal Analytics' Measurement Protocol](https://developers.google.com/analytics/devguides/collection/protocol/v1/)
	- `tid` - tracking ID

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
