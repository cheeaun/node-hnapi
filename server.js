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
var domino = require('domino');
var fs = require('fs');
var jquery = fs.readFileSync(__dirname + '/jquery.min.js').toString();
var zlib = require('zlib');
var redis = require('redis');
var memory = require('memory-cache');
var winston = require('winston');

// Papertrail

var papertrailOptions = nconf.get('papertrail');
if (papertrailOptions){
	require('winston-papertrail');
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
				fn(err, JSON.parse(value));
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
			winston.info(message);
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
		res.send(504);
		winston.error('Server timeout: ' + req.url);
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
	var errorJSON = {
		error: error
	};
	res.status(500).jsonp(errorJSON);
	winston.error(error);
	if (error.code == 'ECONNRESET' || error.code == 'ECONNREFUSED' || error.statusCode == 503) process.nextTick(function(){
		process.exit(1);
	});
};

var cleanContent = function(html){
	// yea yea regex to clean HTML is lame yada yada
	html = html.replace(/">-+<\/font/ig, '"></font'); // remove weird invisible dashes at the end of comments
	html = html.replace(/<\/?font[^<>]*>/ig, ''); // remove font tags
	html = html.replace(/<\/p>/ig, ''); // remove trailing </p>s
	if (!html.match(/^<p>/i)) html = '<p>' + html; // prepend <p>
	return html;
};

var request = function(path, fn){
	var start;
	var req = REQUESTS[path];
	if (!req){
		winston.info('Fetching ' + HOST + path);
		start = new Date;
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
			fn({timeout: true});
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
				if (start) winston.info('Fetch duration time for ' + HOST + path + ' (gzip): ' + (new Date - start) + 'ms');
				fn(null, body);
			}).on('error', fn);
			r.pipe(gunzip);
		} else {
			r.on('data', function(chunk){
				body += chunk;
			}).on('end', function(){
				if (start) winston.info('Fetch duration time for ' + HOST + path + ': ' + (new Date - start) + 'ms');
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
				var window = domino.createWindow(body);
				window._run(jquery);
				var $ = window.$;

				var posts = [],
					rows = $('td table:has(td.title) tr');
				rows = rows.has('td');
				for (var i=0, l=rows.length; i<l; i+=2){
					var row1 = $(rows[i]),
						row2 = $(rows[i+1]);
					if (!row2.length) break;
					var voteLink = row1.find('td a[id^=up]'),
						id = (voteLink.length ? (voteLink.attr('id').match(/\d+/) || [])[0] : null),
						cell1 = row1.find('td.title').has('a'),
						link = cell1.find('a:first'),
						title = link.text().trim(),
						url = link.attr('href'),
						domain = (cell1.find('.comhead').text().match(/\(\s?([^()]+)\s?\)/i) || [,null])[1],
						cell2 = row2.find('td.subtext'),
						points = parseInt(cell2.find('span[id^=score]').text(), 10),
						userLink = cell2.find('a[href^=user]'),
						user = userLink.text() || null,
						timeAgo = userLink[0] ? userLink[0].nextSibling.textContent.replace('|', '').trim() : '',
						commentsCount = parseInt(cell2.find('a[href^=item]').text(), 10) || 0,
						type = 'link';
					if (url.match(/^item/i)) type = 'ask';
					if (!user){ // No users post this = job ads
						type = 'job';
						id = (url.match(/\d+/) || [])[0];
						timeAgo = cell2.text().trim();
					}
					posts.push({
						id: id,
						title: title,
						url: url,
						domain: domain,
						points: points,
						user: user,
						time_ago: timeAgo,
						comments_count: commentsCount,
						type: type
					});
				}

				cache.set(cacheKey, posts, CACHE_EXP);
				res.jsonp(posts);
			});

			// If 'news' expired, 'news2' should expire too
			if (path == 'news') cache.del('news2');
		}
	});
});

var processComments = function(rows, $){
	var comments = [];

	// Create flat array of comments
	for (var i=0, l=rows.length; i<l; i++){
		var row = $(rows[i]),
			comment = {},
			level = 0,
			levelRow = row.find('img[src*="s.gif"]'),
			metadata = row.find('.comhead').has('a'),
			user = '',
			timeAgo = '',
			id = '',
			content = '[deleted]';
		if (levelRow.length){
			level = parseInt((levelRow).attr('width'), 10) / 40;
		}
		if (metadata.length){
			var userLink = metadata.find('a[href^=user]');
			user = userLink.text();
			timeAgo = userLink[0] ? userLink[0].nextSibling.textContent.replace('|', '').trim() : '';
			id = (metadata.find('a[href^=item]').attr('href').match(/\d+/) || [])[0];
			var commentEl = row.find('.comment');
			var replyLink = commentEl.find('a[href^=reply]');
			// Sometimes the markup becomes nice, and 'reply' link is not part of the comments
			if (replyLink.length){
				// Remove 'reply' link
				if (replyLink.parent('u').length){
					replyLink.parent().remove();
				} else {
					replyLink.remove();
				}
			}
			content = cleanContent(commentEl.html());
		}
		comments.push({
			id: id,
			level: level,
			user: user,
			time_ago: timeAgo,
			content: content,
			comments: []
		});
	}

	// Comments are not nested yet, this 2nd loop will nest 'em up
	for (var i=0, l=comments.length; i<l; i++){
		var comment = comments[i],
			level = comment.level;
		if (level > 0){
			var index = i, parentComment;
			do {
				parentComment = comments[--index];
			} while (parentComment.level >= level);
			parentComment.comments.push(comment);
		}
	}
	// After that, remove the non-nested ones
	comments = comments.filter(function(comment){
		return (comment.level == 0);
	});
	return comments;
};

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
				var window = domino.createWindow(body);
				window._run(jquery);
				var $ = window.$;

				var table1 = $('td table:has(td.title,textarea)'),
					voteLink = table1.find('td a[id^=up]'),
					id = (voteLink.length ? (voteLink.attr('id').match(/\d+/) || [])[0] : null),
					cell1 = table1.find('td.title').has('a'),
					link, title, url, domain, points, user, timeAgo, commentsCount,
					content = null,
					poll = null,
					type = 'link';
				if (cell1.length){
					link = cell1.find('a').first();
					title = link.text().trim();
					url = link.attr('href');
					domain = (cell1.find('.comhead').text().match(/\(\s?([^()]+)\s?\)/i) || [,null])[1];
					var cell2 = table1.find('td.subtext');
					points = parseInt(cell2.find('span[id^=score]').text(), 10);
					var userLink = cell2.find('a[href^=user]');
					user = userLink.text() || null;
					timeAgo = userLink[0] ? userLink[0].nextSibling.textContent.replace('|', '').trim() : '';
					commentsCount = parseInt(cell2.find('a[href^=item]').text(), 10) || 0;
					var nextContentRows = cell2.parent('tr').nextAll('tr:not(:empty):not(:has(textarea))');
					var questionCell = nextContentRows.eq(0).children('td:not(:empty)');
					var pollCell;
					// The content could be question+poll, question or poll.
					if (questionCell.length && !questionCell.find('td.comment').length){
						content = cleanContent(questionCell.html());
						pollCell = nextContentRows.eq(1).find('td:not(:empty):has(td.comment)');
					} else {
						pollCell = nextContentRows.eq(0).find('td:not(:empty):has(td.comment)');
					}
					if (pollCell.length){
						poll = [];
						pollCell.find('td.comment').each(function(){
							var el = $(this);
							poll.push({
								item: el.text().trim(),
								points: parseInt(el.parent('tr').next('tr').find('.comhead span').text(), 10)
							});
						});
					}
					if (url.match(/^item/i)) type = 'ask';
					if (!user){ // No users post this = job ads
						type = 'job';
						id = (url.match(/\d+/) || [])[0];
						timeAgo = cell2.text().trim();
					}
				} else {
					var cell = table1.find('td.default');
					if (cell.length){
						var userLink = cell.find('a[href^=user]');
						user = userLink.text(),
						timeAgo = userLink[0] ? userLink[0].nextSibling.textContent.replace('|', '').trim() : '',
						id = (cell.find('a[href^=item]').attr('href').match(/\d+/) || [])[0],
						content = cleanContent(table1.find('.comment').html());
						type = 'comment';
					}
				}
				var post = {
						id: id,
						title: title,
						url: url,
						domain: domain,
						points: points,
						user: user,
						time_ago: timeAgo,
						comments_count: commentsCount,
						content: content,
						poll: poll,
						type: type,
						comments: [],
						more_comments_id: null
					},
					table2 = table1.nextAll('table:first');

				// If there are comments for a post
				if (table2.length){
					var commentRows = table2.find('tr table');
					post.comments = processComments(commentRows, $);

					// Check for 'More' comments (Rare case)
					var more = $('td.title a[href^="/x?"]');
					if (more.length){
						// Whatever 'fnid' means
						var fnid = more.attr('href').match(/fnid=(\w+)/);
						if (fnid){
							fnid = fnid[1];
							post.more_comments_id = fnid;
						}
					}
				}

				cache.set(cacheKey, post, CACHE_EXP);
				res.jsonp(post);
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
				// Link has expired. Classic HN error message.
				if (!/[<>]/.test(body) && /expired/i.test(body)){
					res.status(410).jsonp({
						error: true,
						message: body
					});
					return;
				}

				var window = domino.createWindow(body);
				window._run(jquery);
				var $ = window.$;

				var post = {
						comments: [],
						more_comments_id: null
					};

				var commentRows = $('table:not(:has(table)):has(.comment)');
				post.comments = processComments(commentRows, $);

				// Check for 'More' comments (Rare case)
				var more = $('td.title a[href^="/x?"]');
				if (more.length){
					// Whatever 'fnid' means
					var fnid = more.attr('href').match(/fnid=(\w+)/);
					if (fnid){
						fnid = fnid[1];
						post.more_comments_id = fnid;
					}
				}

				cache.set(cacheKey, post, CACHE_EXP);
				res.jsonp(post);
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
				var window = domino.createWindow(body);
				window._run(jquery);
				var $ = window.$;

				var comments = [],
					commentRows = $('tr:nth-child(3) tr:has(span.comment)');
				comments = processComments(commentRows, $);

				cache.set(cacheKey, comments, CACHE_EXP);
				res.jsonp(comments);
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
				var window = domino.createWindow(body);
				window._run(jquery);
				var $ = window.$;

				var cells = $('form tr td:odd');
				var id = cells.eq(0).text(),
					created = cells.eq(1).text(),
					karma = parseInt(cells.eq(2).text(), 10),
					avg = parseFloat(cells.eq(3).text()),
					about = cleanContent(cells.eq(4).html());

				var user = {
						id: id,
						created: created,
						karma: karma,
						avg: avg,
						about: about
					};

				cache.set(cacheKey, user, CACHE_EXP);
				res.jsonp(user);
			});
		}
	});
});

app.listen(nconf.get('PORT') || nconf.get('port'));