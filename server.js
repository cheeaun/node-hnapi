// Config

var nconf = require('nconf');
nconf.argv()
	.env()
	.file('config.json')
	.defaults({
		port: 80,
		cache_exp: 60*10 // 10 mins
	});

require('longjohn');
var express = require('express');
var morgan = require('morgan');
var compress = require('compression');
var onHeaders = require('on-headers');
var cors = require('cors');
var https = require('https');
var hndom = require('./lib/hndom.js');
var Cache = require('./lib/cache.js');
var zlib = require('zlib');
var winston = require('winston');
var stringify = require('json-stringify-safe');
var ua = require('universal-analytics');
var TimeQueue = require('timequeue');

var HOST = 'news.ycombinator.com';
var CACHE_EXP = parseInt(nconf.get('cache_exp'), 10);
var log_referer = nconf.get('log_referer');
var log_useragent = nconf.get('log_useragent');
var ua_tid = nconf.get('universal_analytics:tid');
var ua_hostname = nconf.get('universal_analytics:hostname');

// Papertrail

var papertrailOptions = nconf.get('papertrail');
if (papertrailOptions){
	require('winston-papertrail');
	// papertrailOptions.handleExceptions = true;
	winston.add(winston.transports.Papertrail, papertrailOptions);
}

// Cache

var cacheOptions = nconf.get('cache:options') || {};
cacheOptions.onConnect = function(){
	winston.info('Connected to cache server.');
};
cacheOptions.onError = function(e){
	if (e) winston.error(e.toString ? e.toString() : e);
};
var cacheMemory = nconf.get('cache:memory');
if (typeof cacheMemory == 'string') cacheMemory = cacheMemory == 'true';
var cache = Cache({
	memory: cacheMemory,
	expiry: CACHE_EXP,
	store: nconf.get('cache:store'),
	options: cacheOptions
});

var app = express();
app.set('json spaces', 0);
app.set('trust proxy', true);

var reqIP = function(req){
	var ips = req.ips;
	return ips.length ? ips.join(', ') : req.ip;
};
morgan.token('ip', function(req, res){
	return reqIP(req);
});
var logFormat = 'path=:url status=:status ip=:ip resp-ms=:response-time'
	+ (log_referer ? ' referer=:referrer' : '')
	+ (log_useragent ? ' ua=:user-agent' : '');
app.use(morgan(logFormat, {
	stream: {
		write: function(message){
			winston.info(message.trim());
		}
	}
}));

if (nconf.get('universal_analytics')){
	app.use(function(req, res, next){
		var headers = {};
		var userAgent = req.headers['user-agent'];
		if (userAgent) headers['User-Agent'] = userAgent;
		var visitor = ua(ua_tid, {
			headers: headers
		});

		req.__startTime = new Date;
		var end = res.end;
		res.end = function(chunk, encoding){
			res.end = end;
			res.end(chunk, encoding);
			var time = new Date - req.__startTime;
			visitor.timing('HN API', 'Response time', time).send();
		}

		var params = {
			dp: req.originalUrl || req.url,
			dr: req.headers['referer'] || req.headers['referrer'] || ''
		};
		if (ua_hostname) params.dh = ua_hostname;
		visitor.pageview(params, function(e){
			if (e) winston.error(e);
		}).send();
		next();
	});
}

var rateLimit = nconf.get('ratelimit');
if (rateLimit && rateLimit.blacklist){
	var limiter = require('connect-ratelimit');
	var blacklist = rateLimit.blacklist.split(' ');
	app.use(limiter({
		blacklist: blacklist,
		end: true,
		catagories: {
			blacklist: {
				// 1 req every hr
				totalRequests: 1,
				every: 60 * 60 * 1000
			}
		}
	}));
}

app.use(function(req, res, next){
	res.setHeader('Cache-Control', 'public, max-age=' + CACHE_EXP);
	next();
});
app.use(cors());
app.use(compress());
app.use(function(req, res, next){
	['send', 'set'].forEach(function(method){
		var fn = res[method];
		res[method] = function(){
			if (res.headersSent) return;
			fn.apply(res, arguments);
		}
	});
	var timeout = setTimeout(function(){
		winston.error('Server timeout: ' + req.url);
		res.send(504);
	}, 25000);
	onHeaders(res, function(){
		clearTimeout(timeout);
	});
	next();
});

app.get('/', function(req, res){
	res.type('application/json');
	res.send(JSON.stringify({
		name: 'node-hnapi',
		desc: 'Unofficial Hacker News API',
		version: '0.2',
		project_url: 'https://github.com/cheeaun/node-hnapi/',
		documentation_url: 'https://github.com/cheeaun/node-hnapi/wiki/API-Documentation',
		author: 'cheeaun',
		author_url: 'http://cheeaun.com/',
		process: {
			versions: process.versions,
			memoryUsage: process.memoryUsage()
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

var REQUESTS = {}; // Caching fetch requests as a way to "debounce" incoming requests
var requestWorker = function(path, data, fn, done){
	if (typeof data == 'function'){
		done = fn;
		fn = data;
	}
	var start;
	var req = REQUESTS[path];

	var visitor = ua(ua_tid);

	if (!req){
		winston.info('Fetching ' + path);
		visitor.event({
			ec: 'HN Fetch', // Event Category
			ea: 'Fetch start', // Event Action
			el: path, // Event Label
			dh: ua_hostname // Document hostname
		}).send();

		start = new Date();
		var headers = {
			'Accept-Encoding': 'gzip',
		};
		if (data.ip) headers['X-Forwarded-For'] = data.ip;
		req = https.get({
			host: HOST,
			path: path,
			headers: headers,
			agent: false
		});
		req.setTimeout(10000, function(){
			req.abort();
			delete REQUESTS[path];
		});
		REQUESTS[path] = req;
	}
	var trackTiming = function(options){
		if (!start) return;
		if (!options) options = {};
		var time = new Date() - start;
		var gzipStr = options.isGzip ? ' (gzip)' : '';
		var gzipLabel = options.isGzip ? 'gzip' : 'non-gzip';
		winston.info('Fetch duration ' + path + gzipStr + ': ' + time + 'ms');
		visitor.timing('HN fetch', 'Fetch duration', time, gzipLabel).send();
	};
	req.on('response', function(r){
		delete REQUESTS[path];

		if (r.statusCode != 200){
			var statusCode = r.statusCode;
			visitor.event({
				ec: 'HN Fetch', // Event Category
				ea: 'Fetch status', // Event Action
				el: statusCode, // Event Label
				dh: ua_hostname // Document hostname
			}, function(){
				fn({statusCode: statusCode});
			});
			return;
		}

		var body = '';

		var contentEncoding = r.headers['content-encoding'];
		if (contentEncoding && contentEncoding.toLowerCase().indexOf('gzip') > -1){
			var gunzip = zlib.createGunzip();
			gunzip.on('data', function(data){
				body += data.toString();
			}).on('end', function(){
				trackTiming({isGzip: true});
				fn(null, body);
			}).on('error', fn);
			r.pipe(gunzip);
		} else {
			r.on('data', function(chunk){
				body += chunk;
			}).on('end', function(){
				trackTiming();
				fn(null, body);
			}).on('error', fn);
		}
	}).on('error', fn).end();
	done();
};
var request = new TimeQueue(requestWorker, {
	// 1 fetch every sec
	concurrency: 1,
	every: 1000,
	maxQueued: 1000
});
request.on('error', function(e){
	if (e) winston.error(e);
});

app.get(/^\/(news|news2|newest|ask|show|shownew|best|active|noobstories)$/, function(req, res){
	var cacheKey = req.params[0];
	cache.get(cacheKey, function(err, result){
		if (result){
			res.jsonp(result);
		} else {
			var path = '/' + cacheKey;
			if (cacheKey == 'news2') path = '/news?p=2';
			request.push(path, { ip: reqIP(req) }, function(err, body){
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
			if (cacheKey == 'news') cache.del('news2');
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
			request.push(path, { ip: reqIP(req) }, function(err, body){
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
			request.push(path, { ip: reqIP(req) }, function(err, body){
				if (err){
					errorRespond(res, err);
					return;
				}
				hndom.moreComments(body, function(e, data){
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
			var path = '/' + cacheKey;
			request.push(path, { ip: reqIP(req) }, function(err, body){
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
			request.push(path, { ip: reqIP(req) }, function(err, body){
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
