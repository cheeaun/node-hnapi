var journey = require('journey'),
	scraper = require('scraper');

// http://blog.jerodsanto.net/2011/06/connecting-node-js-to-redis-to-go-on-heroku/
var redis;
if (process.env.REDISTOGO_URL){
	var rtg = require("url").parse(process.env.REDISTOGO_URL);
	redis = require("redis").createClient(rtg.port, rtg.hostname);
	redis.auth(rtg.auth.split(":")[1]);
} else {
	redis = require("redis").createClient();
}

var router = new(journey.Router);

var ROOT_URL = 'http://news.ycombinator.com/',
	HEADERS = {"Content-type":"application/json;charset=utf-8"},
	CACHE_EXP = 60*5; // 5 mins

// Create the routing table
router.map(function () {
	this.root.bind(function(req, res){
		res.send(200, HEADERS, JSON.stringify({
			title: 'Hacker News (unofficial) API, powered by Node.js',
			version: '0.1',
			author: 'cheeaun',
			author_url: 'http://cheeaun.com/'
		}, null, 4));
	});
	
    this.get('/news').bind(function (req, res, params){
		var callback = params.callback;
		redis.get('news', function(err, result){
			if (result){
				if (callback){
					res.send(200, HEADERS, callback + '(' + result + ')');
				} else {
					res.send(200, HEADERS, result);
				}
			} else {
				scraper(ROOT_URL, function(err, $){
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
							domain = (cell1.find('.comhead').text().match(/\(\s?([^()]+)\s?\)/i) || [,''])[1],
							cell2 = row2.find('td.subtext'),
							points = parseInt(cell2.find('span[id^=score]').text(), 10),
							userLink = cell2.find('a[href^=user]'),
							user = userLink.text(),
							timeAgo = userLink[0] ? userLink[0].nextSibling.textContent.replace('|', '').trim() : '',
							commentsCount = parseInt(cell2.find('a[href^=item]').text(), 10) || 0,
							type = 'link';
						if (url.match(/^item/i)){ // URLs that points to itself = ask
							type = 'ask';
						} else if (!user){ // No users post this = job ads
							type = 'job';
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
					if (callback){
						res.send(200, HEADERS, callback + '(' + postsJSON + ')');
					} else {
						res.send(200, HEADERS, postsJSON);
					}
					redis.set('news', postsJSON);
					redis.expire('news', CACHE_EXP);
				});
			}
		});
	});
	
	this.get(/^post\/(\d+)$/).bind(function(req, res, postID, params){
		var callback = params.callback;
		redis.get('post' + postID, function(err, result){
			if (result){
				if (callback){
					res.send(200, HEADERS, callback + '(' + result + ')');
				} else {
					res.send(200, HEADERS, result);
				}
			} else {
				scraper(ROOT_URL + 'item?id=' + postID, function(err, $){
					var table1 = $('td table:has(textarea)'),
						voteLink = table1.find('td a[id^=up]'),
						id = (voteLink.length ? (voteLink.attr('id').match(/\d+/) || [])[0] : null),
						cell1 = table1.find('td.title:has(a)'),
						link = cell1.find('a'),
						title = link.text().trim(),
						url = link.attr('href'),
						domain = (cell1.find('.comhead').text().match(/\(\s?([^()]+)\s?\)/i) || [,''])[1],
						cell2 = table1.find('td.subtext'),
						points = parseInt(cell2.find('span[id^=score]').text(), 10),
						userLink = cell2.find('a[href^=user]'),
						user = userLink.text(),
						timeAgo = userLink[0] ? userLink[0].nextSibling.textContent.replace('|', '').trim() : '',
						commentsCount = parseInt(cell2.find('a[href^=item]').text(), 10) || 0,
						questionCell = cell2.parent('tr').nextAll('tr:has(td):first').find('td:not(:empty):not(:has(textarea))');
						question = questionCell.length ? questionCell.html().replace(/<\/p>/ig, '') : '',
						type = url.match(/^item/i) ? 'ask' : 'link',
						post = {
							id: id,
							title: title,
							url: url,
							domain: domain,
							points: points,
							user: user,
							time_ago: timeAgo,
							comments_count: commentsCount,
							question: question,
							type: type,
							comments: []
						},
						table2 = table1.nextAll('table:first');
					
					if (table2.length){
						var commentRows = table2.find('tr table'),
							comments = [],
							commentIDs = [];
						
						for (var i=0, l=commentRows.length; i<l; i++){
							var row = $(commentRows[i]),
								comment = {},
								level = parseInt(row.find('img[src*="s.gif"]').attr('width'), 10) / 40,
								metadata = row.find('.comhead:has(a)'),
								user = '',
								timeAgo = '',
								id = '',
								content = '[deleted]';
							if (metadata.length){
								var userLink = metadata.find('a[href^=user]');
								user = userLink.text(),
								timeAgo = userLink[0] ? userLink[0].nextSibling.textContent.replace('|', '').trim() : '',
								id = (metadata.find('a[href^=item]').attr('href').match(/\d+/) || [])[0],
								content = row.find('.comment font').html().replace(/<\/p>/ig, '');
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
						// comments is not nested yet, this 2nd loop will nest 'em up
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
						// after that, remove the non-nested ones
						comments = comments.filter(function(comment){
							return (comment.level == 0);
						});
						post.comments = comments
					}
					
					var postJSON = JSON.stringify(post);
					if (callback){
						res.send(200, HEADERS, callback + '(' + postJSON + ')');
					} else {
						res.send(200, HEADERS, postJSON);
					}
//					redis.set('post' + postID, postJSON);
//					redis.expire('post' + postID, CACHE_EXP);
				});
			}
		});
	});
});

require('http').createServer(function (request, response) {
    var body = "";

    request.addListener('data', function (chunk) { body += chunk });
    request.addListener('end', function () {
        router.handle(request, body, function (result) {
            response.writeHead(result.status, result.headers);
            response.end(result.body);
        });
    });
}).listen(process.env.PORT || 80);