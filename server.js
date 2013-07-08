// Config

var nconf = require('nconf');
nconf.argv()
	.env()
	.file('config.json')
	.defaults({
		port: 80,
		// redis_url: 'redis://USERNAME:PASSWORD@127.0.0.1:6379/',
		cache_exp: 60*10 // 10 mins
	});

// Nodefly

var nodeflyKey = nconf.get('nodefly_key');
if (nodeflyKey){
	var nodefly = require('nodefly');
	nodefly.profile(nodeflyKey, ['node-hnapi', nconf.get('nodefly_hostname') || require('os').hostname()]);
}

var express = require('express');
var cors = require('cors');
var https = require('https');
var hndom = require('./lib/hndom.js');
var zlib = require('zlib');
var redis = require('redis');
var memory = require('memory-cache');
var winston = require('winston');
var stringify = require('json-stringify-safe');

// Papertrail

var papertrailOptions = nconf.get('papertrail');
if (papertrailOptions){
	require('winston-papertrail');
	papertrailOptions.handleExceptions = true;
	winston.add(winston.transports.Papertrail, papertrailOptions);
}

// Redis + in-memory cache

if (nconf.get('redis_debug')) redis.debug_mode = true;

var redisClient;
var redisURL = nconf.get('redis_url');
if (redisURL){
	// http://blog.jerodsanto.net/2011/06/connecting-node-js-to-redis-to-go-on-heroku/
	var url = require('url').parse(redisURL);
	redisClient = redis.createClient(url.port, url.hostname);
	redisClient.auth(url.auth.split(':')[1]);
} else {
	redisClient = redis.createClient(null, null);
}
redisClient.on('connect', function(){
	winston.info('Connected to Redis server.');
	memory.clear(); // Clear in-memory cache when Redis server is up
});
redisClient.on('error', function(e){
	if (e) winston.error(e.toString ? e.toString() : e);
	winston.error('Unable to connect to Redis server. Fallback to in-memory cache.');
});

var cache = {
	get: function(key, fn){
		if (redisClient.connected){
			redisClient.get(key, function(err, value){
				try{
					fn(err, JSON.parse(value));
				} catch (e){
					fn(e);
				}
			});
		} else {
			var value = memory.get(key);
			value = JSON.parse(value);
			fn(null, value);
		}
	},
	set: function(key, value, expiry){
		if (typeof value != 'string'){
			value = JSON.stringify(value);
		}
		if (redisClient.connected){
			if (expiry){
				redisClient.setex(key, expiry, value);
			} else {
				redisClient.set(key, value);
			}
		} else {
			memory.put(key, value, expiry ? expiry*1000 : null); // miliseconds
		}
	},
	del: function(key){
		if (redisClient.connected){
			redisClient.del(key);
		} else {
			memory.del(key);
		}
	}
};

var HOST = 'news.ycombinator.com';
var CACHE_EXP = nconf.get('cache_exp');
var REQUESTS = {}; // Caching fetch requests as a way to "debounce" incoming requests
var log_referer = nconf.get('log_referer');

var app = express();
app.set('json spaces', 0);
app.set('trust proxy', true);

express.logger.token('ip', function(req, res){
	var ips = req.ips;
	return ips.length ? ips.join(',') : req.ip;
});
app.use(express.logger({
	stream: {
		write: function(message){
			winston.info(message.trim()); // Chomp the newline appended by Logger
		}
	},
	format: 'path=:url method=:method status=:status ip=:ip response-ms=:response-time'
		+ (log_referer ? ' referer=:referrer' : '')
		+ ' user-agent=:user-agent'
}));
app.use(function(req, res, next){
	res.setHeader('Cache-Control', 'public, max-age=' + CACHE_EXP);
	next();
});
app.use(cors());
app.use(express.compress());
app.use(function(req, res, next){
	var timeout = setTimeout(function(){
		winston.error('Server timeout: ' + req.url);
		res.send(504);
	}, 25000);
	res.on('header', function(){
		clearTimeout(timeout);
	});
	next();
});

app.get('/', function(req, res){
	res.type('application/json').send(JSON.stringify({
		name: 'node-hnapi',
		desc: 'Unofficial Hacker News API',
		version: '0.2',
		project_url: 'https://github.com/cheeaun/node-hnapi/',
		documentation_url: 'https://github.com/cheeaun/node-hnapi/wiki/API-Documentation',
		author: 'cheeaun',
		author_url: 'http://cheeaun.com/',
		process: {
			versions: process.versions
		}
	}, null, 4));
});

app.get('/favicon.ico', function(req, res){
	res.send(204);
});

app.get('/robots.txt', function(req, res){
	res.type('txt/plain');
	res.send('User-agent: *\nDisallow: /');
});

var errorRespond = function(res, error){
	winston.error(error);
	if (!res.headersSent){
		res.jsonp({
			error: error.message || JSON.parse(stringify(error))
		});
	}
	if (error.code == 'ECONNRESET' || error.code == 'ECONNREFUSED' || error.statusCode == 503) process.nextTick(function(){
		process.exit(1);
	});
};

var request = function(path, fn){
	var start;
	var req = REQUESTS[path];
	if (!req){
		winston.info('Fetching ' + HOST + path);
		start = new Date();
		req = https.get({
			host: HOST,
			path: path,
			headers: {
				'Accept-Encoding': 'gzip'
			}
		});
		req.setTimeout(10000, function(){
			req.abort();
			delete REQUESTS[path];
		});
		REQUESTS[path] = req;
	}
	req.on('response', function(r){
		delete REQUESTS[path];

		if (r.statusCode != 200){
			fn({statusCode: r.statusCode});
			return;
		}

		var body = '';

		var contentEncoding = r.headers['content-encoding'];
		if (contentEncoding && contentEncoding.toLowerCase().indexOf('gzip') > -1){
			var gunzip = zlib.createGunzip();
			gunzip.on('data', function(data){
				body += data.toString();
			}).on('end', function(){
				if (start) winston.info('Fetch duration time for ' + HOST + path + ' (gzip): ' + (new Date() - start) + 'ms');
				fn(null, body);
			}).on('error', fn);
			r.pipe(gunzip);
		} else {
			r.on('data', function(chunk){
				body += chunk;
			}).on('end', function(){
				if (start) winston.info('Fetch duration time for ' + HOST + path + ': ' + (new Date() - start) + 'ms');
				fn(null, body);
			}).on('error', fn);
		}
	}).on('error', fn).end();
};

app.get(/^\/(news|news2|newest|ask|best|active|noobstories)$/, function(req, res){
	var cacheKey = req.params[0];
	cache.get(cacheKey, function(err, result){
		if (result){
			res.jsonp(result);
		} else {
			var path = req.url;
			request(path, function(err, body){
				if (err){
					errorRespond(res, err);
					return;
				}
				hndom.stories(body, function(e, data){
					if (e){
						errorRespond(res, e);
						return;
					}
					cache.set(cacheKey, data, CACHE_EXP);
					res.jsonp(data);
				});
			});

			// If 'news' expired, 'news2' should expire too
			if (path == 'news') cache.del('news2');
		}
	});
});

app.get(/^\/item\/(\d+)$/, function(req, res){
	var postID = req.params[0];
	var cacheKey = 'post' + postID;
	cache.get(cacheKey, function(err, result){
		if (result){
			res.jsonp(result);
		} else {
			var path = '/item?id=' + postID;
			request(path, function(err, body){
				if (err){
					errorRespond(res, err);
					return;
				}
				hndom.comments(body, function(e, data){
					if (e){
						errorRespond(res, e);
						return;
					}
					cache.set(cacheKey, data, CACHE_EXP);
					res.jsonp(data);
				});
			});
		}
	});
});

app.get(/^\/comments\/(\w+)$/, function(req, res){
	var commentID = req.params[0];
	var cacheKey = 'comments' + commentID;
	cache.get(cacheKey, function(err, result){
		if (result){
			res.jsonp(result);
		} else {
			var path = '/x?fnid=' + commentID;
			request(path, function(err, body){
				if (err){
					errorRespond(res, err);
					return;
				}
				hndom.comments(body, function(e, data){
					if (e){
						errorRespond(res, e);
						return;
					}
					cache.set(cacheKey, data, CACHE_EXP);
					res.jsonp(data);
				});
			});
		}
	});
});

app.get('/newcomments', function(req, res){
	var cacheKey = 'newcomments';
	cache.get(cacheKey, function(err, result){
		if (result){
			res.jsonp(result);
		} else {
			var path = req.url;
			request(path, function(err, body){
				if (err){
					errorRespond(res, err);
					return;
				}
				hndom.newComments(body, function(e, data){
					if (e){
						errorRespond(res, e);
						return;
					}
					cache.set(cacheKey, data, CACHE_EXP);
					res.jsonp(data);
				});
			});
		}
	});
});

app.get(/^\/user\/(\w+)$/, function(req, res){
	var userID = req.params[0];
	var cacheKey = 'user' + userID;
	cache.get(cacheKey, function(err, result){
		if (result){
			res.jsonp(result);
		} else {
			var path = '/user?id=' + userID;
			request(path, function(err, body){
				if (err){
					errorRespond(res, err);
					return;
				}
				hndom.user(body, function(e, data){
					if (e){
						errorRespond(res, e);
						return;
					}
					cache.set(cacheKey, data, CACHE_EXP);
					res.jsonp(data);
				});
			});
		}
	});
});

app.listen(nconf.get('PORT') || nconf.get('port'));