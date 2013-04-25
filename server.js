var nconf = require('nconf');
nconf.argv()
	.env()
	.file('config.json')
	.defaults({
		port: 80,
		// redis_url: 'redis://USERNAME:PASSWORD@127.0.0.1:6379/',
		cache_exp: 60*10 // 10 mins
	});

var nodeflyKey = nconf.get('nodefly_key');
if (nodeflyKey){
	var nodefly = require('nodefly');
	nodefly.profile(nodeflyKey, ['node-hnapi', nconf.get('nodefly_hostname') || require('os').hostname()]);
}

var http = require('http'),
	https = require('https'),
	journey = require('journey'),
	domino = require('domino'),
	fs = require('fs'),
	jquery = fs.readFileSync(__dirname + '/jquery.min.js').toString(),
	zlib = require('zlib'),
	redis = require('redis'),
	memory = require('memory-cache'),
	stringify = require('json-stringify-safe'),
	winston = require('winston');

var papertrailOptions = nconf.get('papertrail');
if (papertrailOptions){
	require('winston-papertrail');
	winston.add(winston.transports.Papertrail, papertrailOptions);
}

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
	if (e) winston.error(e);
	winston.error('Unable to connect to Redis server. Fallback to in-memory cache.');
});

var cache = {
	get: function(key, fn){
		if (redisClient.connected){
			redisClient.get(key, fn);
		} else {
			var value = memory.get(key);
			fn(null, value);
		}
	},
	set: function(key, value, expiry){
		if (redisClient.connected){
			redisClient.set(key, value, function(){
				if (expiry) redisClient.expire(key, expiry); // seconds
			});
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

var router = new journey.Router();

var HOST = 'news.ycombinator.com';
var CACHE_EXP = nconf.get('cache_exp');
var REQUESTS = {}; // Caching fetch requests as a way to "debounce" incoming requests

var cleanContent = function(html){
	// yea yea regex to clean HTML is lame yada yada
	html = html.replace(/">-+<\/font/ig, '"></font'); // remove weird invisible dashes at the end of comments
	html = html.replace(/<\/?font[^<>]*>/ig, ''); // remove font tags
	html = html.replace(/<\/p>/ig, ''); // remove trailing </p>s
	if (!html.match(/^<p>/i)) html = '<p>' + html; // prepend <p>
	return html;
};

var errorRespond = function(response, error, callback){
	var errorJSON = stringify({
		error: error
	});
	if (callback) errorJSON = callback + '(' + errorJSON + ')';
	response.respond({
		status: 500,
		body: errorJSON,
		headers: response.baseResponse.headers
	});
	winston.error(error);
	if (error.code == 'ECONNRESET' || error.code == 'ECONNREFUSED' || error.statusCode == 503) process.nextTick(function(){
		process.exit(1);
	});
};

// Create the routing table
router.map(function(){
	this.root.bind(function(req, res){
		res.sendBody(JSON.stringify({
			name: 'node-hnapi',
			desc: 'Unofficial Hacker News API',
			version: '0.1.1',
			project_url: 'https://github.com/cheeaun/node-hnapi/',
			documentation_url: 'https://github.com/cheeaun/node-hnapi/wiki/API-Documentation',
			author: 'cheeaun',
			author_url: 'http://cheeaun.com/',
			process: {
				versions: process.versions
			}
		}, null, 4));
	});

	this.get('/robots.txt').bind(function(req, res){
		res.respond({
			status: 200,
			body: 'User-agent: *\nDisallow: /',
			headers: {
				'Content-Type': 'text/plain; charset=UTF-8'
			}
		});
	});
	
	this.get(/^(news|news2|newest|ask|best|active|noobstories)$/).bind(function (req, res, path, params){
		var callback = params.callback;
		cache.get(path, function(err, result){
			if (result){
				if (callback) result = callback + '(' + result + ')';
				res.sendBody(result);
			} else {
				var _path = (path == 'news') ? '' : ('/' + path);
				var request = REQUESTS[_path];
				if (!request){
					winston.info('Fetching ' + HOST + _path);
					request = https.get({
						host: HOST,
						path: _path
					});
					request.setTimeout(10000, function(){
						request.abort();
						delete REQUESTS[_path];
						errorRespond(res, {timeout: true}, callback);
					});
					REQUESTS[_path] = request;
				}
				request.on('response', function(r){
					delete REQUESTS[_path];

					if (r.statusCode != 200){
						errorRespond(res, {statusCode: r.statusCode}, callback);
						return;
					}

					var body = '';
					r.on('data', function (chunk){ body += chunk; });
					r.on('end', function(){
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

						var postsJSON = JSON.stringify(posts);
						cache.set(path, postsJSON, CACHE_EXP);
						if (callback) postsJSON = callback + '(' + postsJSON + ')';
						res.sendBody(postsJSON);
					});
				}).on('error', function(e){
					errorRespond(res, e, callback);
				});
				
				// If 'news' expired, 'news2' should expire too
				if (path == 'news') cache.del('news2');
			}
		});
	});

	this.get(/^(newcomments)$/).bind(function (req, res, path, params){
		var callback = params.callback;
		cache.get(path, function(err, result){
			if (result){
				if (callback) result = callback + '(' + result + ')';
				res.sendBody(result);
			} else {
				var _path = '/' + path;
				var request = REQUESTS[_path];
				if (!request){
					winston.info('Fetching ' + HOST + _path);
					request = https.get({
						host: HOST,
						path: _path
					});
					request.setTimeout(10000, function(){
						request.abort();
						delete REQUESTS[_path];
						errorRespond(res, {timeout: true}, callback);
					});
					REQUESTS[_path] = request;
				}
				request.on('response', function(r){
					delete REQUESTS[_path];

					if (r.statusCode != 200){
						errorRespond(res, {statusCode: r.statusCode}, callback);
						return;
					}

					var body = '';
					r.on('data', function (chunk){ body += chunk; });
					r.on('end', function(){
						var window = domino.createWindow(body);
						window._run(jquery);
						var $ = window.$;

						var comments = [],
							commentRows = $('tr:nth-child(3) tr:has(span.comment)');
						comments = processComments(commentRows, $);

						var commentsJSON = JSON.stringify(comments);
						cache.set(path, commentsJSON, CACHE_EXP);
						if (callback) commentsJSON = callback + '(' + commentsJSON + ')';
						res.sendBody(commentsJSON);
					});
				}).on('error', function(e){
					errorRespond(res, e, callback);
				});
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
	
	this.get(/^item\/(\d+)$/).bind(function(req, res, postID, params){
		var callback = params.callback;
		cache.get('post' + postID, function(err, result){
			if (result){
				if (callback) result = callback + '(' + result + ')';
				res.sendBody(result);
			} else {
				var path = '/item?id=' + postID;
				var request = REQUESTS[path];
				if (!request){
					winston.info('Fetching ' + HOST + path);
					request = https.get({
						host: HOST,
						path: path
					});
					request.setTimeout(10000, function(){
						request.abort();
						delete REQUESTS[path];
						errorRespond(res, {timeout: true}, callback);
					});
					REQUESTS[path] = request;
				}
				request.on('response', function(r){
					delete REQUESTS[path];

					if (r.statusCode != 200){
						errorRespond(res, {statusCode: r.statusCode}, callback);
						return;
					}

					var body = '';
					r.on('data', function (chunk){ body += chunk });
					r.on('end', function(){
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

						var postJSON = JSON.stringify(post);
						cache.set('post' + postID, postJSON, CACHE_EXP);
						if (callback) postJSON = callback + '(' + postJSON + ')';
						res.sendBody(postJSON);
					});
				}).on('error', function(e){
					errorRespond(res, e, callback);
				});
			}
		});
	});

	// 'More' comments, experimental API.
	this.get(/^comments\/(\w+)$/).bind(function(req, res, commentID, params){
		var callback = params.callback;
		cache.get('comments' + commentID, function(err, result){
			if (result){
				if (callback) result = callback + '(' + result + ')';
				res.sendBody(result);
			} else {
				var path = '/x?fnid=' + commentID;
				var request = REQUESTS[path];
				if (!request){
					winston.info('Fetching ' + HOST + path);
					request = https.get({
						host: HOST,
						path: path
					});
					request.setTimeout(10000, function(){
						request.abort();
						delete REQUESTS[path];
						errorRespond(res, {timeout: true}, callback);
					});
					REQUESTS[path] = request;
				}
				request.on('response', function(r){
					delete REQUESTS[path];

					if (r.statusCode != 200){
						errorRespond(res, {statusCode: r.statusCode}, callback);
						return;
					}

					var body = '';
					r.on('data', function (chunk){ body += chunk });
					r.on('end', function(){
						// Link has expired. Classic HN error message.
						if (!/[<>]/.test(body) && /expired/i.test(body)){
							var result = JSON.stringify({
								error: true,
								message: body
							});
							if (callback) result = callback + '(' + result + ')';
							res.sendBody(result);
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

						var postJSON = JSON.stringify(post);
						cache.set('comments' + commentID, postJSON, CACHE_EXP);
						if (callback) postJSON = callback + '(' + postJSON + ')';
						res.sendBody(postJSON);
					}).on('error', function(e){
						errorRespond(res, e, callback);
					});
				});
			}
		});
	});
	
	this.get(/^user\/(\w+)$/).bind(function(req, res, userID, params){
		var callback = params.callback;
		cache.get('user' + userID, function(err, result){
			if (result){
				if (callback) result = callback + '(' + result + ')';
				res.sendBody(result);
			} else {
				var path = '/user?id=' + userID;
				var request = REQUESTS[path];
				if (!request){
					winston.info('Fetching ' + HOST + path);
					request = https.get({
						host: HOST,
						path: path
					});
					request.setTimeout(10000, function(){
						request.abort();
						delete REQUESTS[path];
						errorRespond(res, {timeout: true}, callback);
					});
					REQUESTS[path] = request;
				}
				request.on('response', function(r){
					delete REQUESTS[path];

					if (r.statusCode != 200){
						errorRespond(res, {statusCode: r.statusCode}, callback);
						return;
					}

					var body = '';
					r.on('data', function (chunk){ body += chunk });
					r.on('end', function(){
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
						
						var userJSON = JSON.stringify(user);
						cache.set('user' + userID, userJSON, CACHE_EXP);
						if (callback) userJSON = callback + '(' + userJSON + ')';
						res.sendBody(userJSON);
					}).on('error', function(e){
						errorRespond(res, e, callback);
					});
				});
			}
		});
	});
});

http.createServer(function (request, response) {
	var body = '';
	request.on('data', function (chunk){ body += chunk });
	request.on('end', function (){

		winston.info('path=' + request.url
			+ ' method=' + request.method
			+ ' ip=' + (request.headers['x-forwarded-for'] || request.connection.remoteAddress || '')
			+ ' user-agent=' + (request.headers['user-agent'] || ''));

		// Server response timeout
		var timeout = setTimeout(function(){
			response.writeHead(504);
			response.end();
			winston.error('Server timeout: ' + request.url);
		}, 25000);

		router.handle(request, body, function (result){
			clearTimeout(timeout);

			var headers = result.headers;
			headers['Access-Control-Allow-Origin'] = '*';
			headers['Vary'] = 'Accept-Encoding';
			headers['Cache-Control'] = 'public, max-age=' + CACHE_EXP;
			if (/gzip/i.test(request.headers['accept-encoding'])){
				zlib.gzip(result.body, function(err, data){
					headers['Content-Encoding'] = 'gzip';
					headers['Content-Length'] = data.length;
					response.writeHead(result.status, headers);
					response.end(data);
				});
			} else {
				response.writeHead(result.status, headers);
				response.end(result.body);
			}
		});
	});
}).listen(nconf.get('PORT') || nconf.get('port'));