var journey = require('journey'),
	request = require('request'),
	jsdom = require('jsdom'),
	fs = require('fs'),
	jquery = fs.readFileSync("./jquery.min.js").toString(),
	zlib = require('zlib');

// http://blog.jerodsanto.net/2011/06/connecting-node-js-to-redis-to-go-on-heroku/
var redis;
if (process.env.REDISTOGO_URL){
	var rtg = require('url').parse(process.env.REDISTOGO_URL);
	redis = require('redis').createClient(rtg.port, rtg.hostname);
	redis.auth(rtg.auth.split(':')[1]);
} else {
	redis = require('redis').createClient();
}

var router = new(journey.Router);

var ROOT_URL = 'http://news.ycombinator.com/',
	CACHE_EXP = 60*10; // 10 mins

var cleanContent = function(html){
	// yea yea regex to clean HTML is lame yada yada
	html = html.replace(/<\/?font[^<>]*>/ig, ''); // remove font tags
	html = html.replace(/<\/p>/ig, ''); // remove trailing </p>s
	return '<p>' + html; // HN forgot the first <p>
};

var errorRespond = function(response, error, callback){
	var errorJSON = JSON.stringify({
		error: error
	});
	if (callback) errorJSON = callback + '(' + errorJSON + ')';
	response.respond({
		status: 500,
		body: errorJSON,
		headers: response.baseResponse.headers
	});
	console.error(error);
};

// Create the routing table
router.map(function(){
	this.root.bind(function(req, res){
		res.sendBody(JSON.stringify({
			title: 'Hacker News (unofficial) API, powered by Node.js',
			version: '0.1',
			project_url: 'https://github.com/cheeaun/node-hnapi/',
			documentation_url: 'https://github.com/cheeaun/node-hnapi/wiki/API-Documentation',
			author: 'cheeaun',
			author_url: 'http://cheeaun.com/'
		}, null, 4));
	});
	
	this.get(/^(news|news2|newest|ask|best|active|noobstories)$/).bind(function (req, res, path, params){
		var callback = params.callback;
		redis.get(path, function(err, result){
			if (result){
				if (callback) result = callback + '(' + result + ')';
				res.sendBody(result);
			} else {
				request(ROOT_URL + (path!='news' ? path : ''), function(e, r, body){
					if (e || r.statusCode != 200){
						errorRespond(res, e, callback);
						return;
					}
					jsdom.env({
						html: body,
						src: [jquery],
						done: function(err, window){
							if (err){
								errorRespond(res, err, callback);
								return;
							}
							var $ = window.$;
							var posts = [],
								rows = $('td table:has(td.title) tr:has(td)');
							for (var i=0, l=rows.length; i<l; i+=2){
								var row1 = $(rows[i]),
									row2 = $(rows[i+1]);
								if (!row2.length) break;
								var voteLink = row1.find('td a[id^=up]'),
									id = (voteLink.length ? (voteLink.attr('id').match(/\d+/) || [])[0] : null),
									cell1 = row1.find('td.title:has(a)'),
									link = cell1.find('a'),
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
							redis.set(path, postsJSON);
							redis.expire(path, CACHE_EXP);
							if (callback) postsJSON = callback + '(' + postsJSON + ')';
							res.sendBody(postsJSON);

							window.close();
						}
					});
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
				level = parseInt(row.find('img[src*="s.gif"]').attr('width'), 10) / 40,
				metadata = row.find('.comhead:has(a)'),
				user = null,
				timeAgo = '',
				id = '',
				content = '[deleted]';
			if (metadata.length){
				var userLink = metadata.find('a[href^=user]');
				user = userLink.text(),
				timeAgo = userLink[0] ? userLink[0].nextSibling.textContent.replace('|', '').trim() : '',
				id = (metadata.find('a[href^=item]').attr('href').match(/\d+/) || [])[0],
				content = cleanContent(row.find('.comment').html());
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
		redis.get('post' + postID, function(err, result){
			if (result){
				if (callback) result = callback + '(' + result + ')';
				res.sendBody(result);
			} else {
				request(ROOT_URL + 'item?id=' + postID, function(e, r, body){
					if (e || r.statusCode != 200){
						errorRespond(res, e, callback);
						return;
					}
					jsdom.env({
						html: body,
						src: [jquery],
						done: function(err, window){
							if (err){
								errorRespond(res, err, callback);
								return;
							}
							var $ = window.$;
							var table1 = $('td table:has(td.title,textarea)'),
								voteLink = table1.find('td a[id^=up]'),
								id = (voteLink.length ? (voteLink.attr('id').match(/\d+/) || [])[0] : null),
								cell1 = table1.find('td.title:has(a)'),
								link, title, url, domain, points, user, timeAgo, commentsCount, content,
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
								var questionCell = cell2.parent('tr').nextAll('tr:has(td):first').find('td:not(:empty):not(:has(textarea))');
								content = questionCell.length ? cleanContent(questionCell.html()) : null;
								var pollCell = questionCell.parent('tr').nextAll('tr:has(td):first').find('td:not(:empty):not(:has(textarea)):has(td.comment)');
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
							redis.set('post' + postID, postJSON);
							redis.expire('post' + postID, CACHE_EXP);
							if (callback) postJSON = callback + '(' + postJSON + ')';
							res.sendBody(postJSON);

							window.close();
						}
					});
				});
			}
		});
	});

	// 'More' comments, experimental API.
	this.get(/^comments\/(\w+)$/).bind(function(req, res, commentID, params){
		var callback = params.callback;
		redis.get('comments' + commentID, function(err, result){
			if (result){
				if (callback) result = callback + '(' + result + ')';
				res.sendBody(result);
			} else {
				request(ROOT_URL + 'x?fnid=' + commentID, function(e, r, body){
					if (e || r.statusCode != 200){
						errorRespond(res, e, callback);
						return;
					}
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
					jsdom.env({
						html: body,
						src: [jquery],
						done: function(err, window){
							if (err){
								errorRespond(res, err, callback);
								return;
							}
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
							redis.set('comments' + commentID, postJSON);
							redis.expire('comments' + commentID, CACHE_EXP);
							if (callback) postJSON = callback + '(' + postJSON + ')';
							res.sendBody(postJSON);

							window.close();
						}
					});
				});
			}
		});
	});
});

require('http').createServer(function (request, response) {
	var body = '';
	request.addListener('data', function (chunk){ body += chunk });
	request.addListener('end', function (){
		router.handle(request, body, function (result){
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
}).listen(process.env.PORT || 3000);