var journey = require('journey'),
	scraper = require('scraper'),
	gzip = require('gzip');

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
	CACHE_EXP = 60*5; // 5 mins

var cleanContent = function(html){
	// yea yea regex to clean HTML is lame yada yada
	html = html.replace(/<\/?font[^<>]*>/ig, ''); // remove font tags
	html = html.replace(/<\/p>/ig, ''); // remove trailing </p>s
	return '<p>' + html; // HN forgot the first <p>
};

// Create the routing table
router.map(function () {
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
				scraper(ROOT_URL + (path!='news' ? path : ''), function(err, $){
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
							user = userLink.text(),
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
					if (callback) postsJSON = callback + '(' + postsJSON + ')';
					res.sendBody(postsJSON);
					redis.set(path, postsJSON);
					redis.expire(path, CACHE_EXP);
				});
			}
		});
	});
	
	this.get(/^item\/(\d+)$/).bind(function(req, res, postID, params){
		var callback = params.callback;
		redis.get('post' + postID, function(err, result){
			if (result){
				if (callback) result = callback + '(' + result + ')';
				res.sendBody(result);
			} else {
				scraper(ROOT_URL + 'item?id=' + postID, function(err, $){
					var table1 = $('td table:has(td.title,textarea)'),
						voteLink = table1.find('td a[id^=up]'),
						id = (voteLink.length ? (voteLink.attr('id').match(/\d+/) || [])[0] : null),
						cell1 = table1.find('td.title:has(a)'),
						link, title, url, domain, points, user, timeAgo, commentsCount, content,
						type = 'link';
					if (cell1.length){
						link = cell1.find('a');
						title = link.text().trim();
						url = link.attr('href');
						domain = (cell1.find('.comhead').text().match(/\(\s?([^()]+)\s?\)/i) || [,null])[1];
						var cell2 = table1.find('td.subtext');
						points = parseInt(cell2.find('span[id^=score]').text(), 10);
						var userLink = cell2.find('a[href^=user]');
						user = userLink.text();
						timeAgo = userLink[0] ? userLink[0].nextSibling.textContent.replace('|', '').trim() : '';
						commentsCount = parseInt(cell2.find('a[href^=item]').text(), 10) || 0;
						var questionCell = cell2.parent('tr').nextAll('tr:has(td):first').find('td:not(:empty):not(:has(textarea))');
						content = questionCell.length ? cleanContent(questionCell.html()) : null;
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
							type: type,
							comments: []
						},
						table2 = table1.nextAll('table:first');
					
					// If there are comments for a post
					if (table2.length){
						var commentRows = table2.find('tr table'),
							comments = [];
						
						// Create flat array of comments
						for (var i=0, l=commentRows.length; i<l; i++){
							var row = $(commentRows[i]),
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
						post.comments = comments
					}
					
					var postJSON = JSON.stringify(post);
					if (callback) postJSON = callback + '(' + postJSON + ')';
					res.sendBody(postJSON);
					redis.set('post' + postID, postJSON);
					redis.expire('post' + postID, CACHE_EXP);
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
			headers['Content-Type'] = 'application/json;charset=utf-8';
			headers['Vary'] = 'Accept-Encoding';
			headers['Cache-Control'] = 'public, max-age=' + CACHE_EXP;
			if (/gzip/i.test(request.headers['accept-encoding'])){
				gzip(result.body, function(err, data){
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
}).listen(process.env.PORT || 80);