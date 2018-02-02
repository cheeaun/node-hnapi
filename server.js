require('dotenv').config();

const express = require('express');
const morgan = require('morgan');
const compress = require('compression');
const onHeaders = require('on-headers');
const cors = require('cors');
const stringify = require('json-stringify-safe');

const hndom = require('./lib/hndom');
const hnapi = require('./lib/hnapi');
const Cache = require('./lib/cache');
const request = require('./lib/request');

var CACHE_EXP = parseInt(process.env.CACHE_EXP, 10);
const {
	PORT,
	LOG_REFERER,
	LOG_USERAGENT,
	CACHE_STORE,
	CACHE_SERVERS,
	CACHE_MEMORY,
	RATELIMIT_BLACKLIST,
} = process.env;

// Cache
let cacheMemory = CACHE_MEMORY;
if (typeof cacheMemory == 'string') cacheMemory = cacheMemory == 'true';
const cache = Cache({
	memory: cacheMemory,
	expiry: CACHE_EXP,
	store: CACHE_STORE,
	options: {
		servers: CACHE_SERVERS,
		onConnect: () => {
			console.info('Connected to cache server.');
		},
		onError: (e) => {
			if (e) console.error(e.toString ? e.toString() : e);
		}
	}
});

const app = express();
app.set('json spaces', 0);
app.set('trust proxy', true);

const reqIP = function(req){
	var ips = req.ips;
	return ips.length ? ips.join(',') : req.ip;
};
morgan.token('ip', (req, res) => {
	return reqIP(req);
});
const logFormat = ':method :url :status :ip :response-time[0]ms'
	+ (LOG_REFERER ? ' referer=:referrer' : '')
	+ (LOG_USERAGENT ? ' ua=:user-agent' : '');
app.use(morgan(logFormat, {
	stream: {
		write: (message) => {
			console.info(message.trim());
		}
	}
}));

if (RATELIMIT_BLACKLIST){
	const limiter = require('connect-ratelimit');
	const blacklist = RATELIMIT_BLACKLIST.split(' ');
	app.use(limiter({
		blacklist,
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
		console.error('Server timeout: ' + req.url);
		res.status(504).end();
	}, 29000);
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
		version: '1.0.0',
		project_url: 'https://github.com/cheeaun/node-hnapi/',
		documentation_url: 'https://github.com/cheeaun/node-hnapi/wiki/API-Documentation',
		author: 'cheeaun',
		author_url: 'http://cheeaun.com/',
		process: {
			versions: process.versions,
			memoryUsage: process.memoryUsage()
		},
		memory: {
			size: cache._memory.size(),
			memsize: cache._memory.memsize(),
			keys: cache._memory.keys(),
		},
	}, null, 4));
});

app.get('/favicon.ico', function(req, res){
	res.status(204).end();
});

app.get('/robots.txt', function(req, res){
	res.type('txt/plain');
	res.send('User-agent: *\nDisallow: /');
});

var errorRespond = function(res, error){
	console.error(error);
	if (!res.headersSent){
		res.jsonp({
			error: error.message || JSON.parse(stringify(error))
		});
	}
	if (error.code == 'ECONNRESET' || error.code == 'ECONNREFUSED' || error.statusCode == 503) process.nextTick(function(){
		process.exit(1);
	});
};

app.get(/^\/(news|news2|newest|ask|show|jobs|best)$/, function(req, res){
	var base = req.params[0];
	var page = Math.min(10, Math.max(1, parseInt(req.query.page, 10) || 1));
	if (base == 'news2'){ // Totally ignore `page` if `news2`
		base = 'news';
		page = 2;
	}
	var cacheKey = base + (page || '');
	cache.get(cacheKey, function(err, result){
		if (result){
			res.jsonp(result);
		} else {
			hnapi[base]({
				page: page
			}, function(err, data){
				if (err){
					errorRespond(res, err);
					return;
				}
				cache.set(cacheKey, data, CACHE_EXP);
				res.jsonp(data);
			});

			// If 'news' expired, 'news2' should expire too
			if (cacheKey == 'news' || cacheKey == 'news1') cache.del('news2');
		}
	});
});

app.get(/^\/(shownew|active|noobstories)$/, function(req, res){
	var cacheKey = req.params[0];
	var page = Math.min(10, Math.max(1, parseInt(req.query.page, 10) || 1));
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
			var start = Date.now();
			hnapi.item(postID, function(err, data){
				if (err){
					errorRespond(res, err);
					return;
				}
				var time = Date.now() - start;
				if (time > 25000) console.info('Fetch duration for #' + postID + ': ' + time + 'ms');
				cache.set(cacheKey, data, CACHE_EXP);
				res.jsonp(data);
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

app.get(/^\/user\/([\w\-]+)$/, function(req, res){
	var userID = req.params[0];
	var cacheKey = 'user' + userID;
	cache.get(cacheKey, function(err, result){
		if (result){
			res.jsonp(result);
		} else {
			hnapi.user(userID, function(err, data){
				if (err){
					errorRespond(res, err);
					return;
				}
				cache.set(cacheKey, data, CACHE_EXP);
				res.jsonp(data);
			});
		}
	});
});

app.listen(PORT);
console.log('Listening to port ' + PORT);