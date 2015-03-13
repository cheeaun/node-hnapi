var domino = require('domino');
var fs = require('fs');
var jquery = fs.readFileSync(__dirname + '/jquery.min.js').toString();

exports.stories = function(body, fn){
	if (!/[<>]/.test(body)){
		fn(new Error('Not HTML content'));
	} else {
		try {
			var window = domino.createWindow(body);
			window._run(jquery);
			var $ = window.$;

			var posts = [];
			var rows = $('td table:has(td.title) tr');
			rows = rows.has('td.title, td.subtext');

			for (var i=0, l=rows.length; i<l; i+=2){
				var row1 = $(rows[i]);
				var row2 = $(rows[i+1]);
				if (!row2.length) break;

				var voteLink = row1.find('td a[id^=up]');
				var id = (voteLink.length ? (voteLink.attr('id').match(/\d+/) || [])[0] : null);

				var cell1 = row1.find('td.title').has('a');
				var link = cell1.find('a:first');
				var title = link.text().trim();
				var url = link.attr('href');
				var domain = (cell1.find('.comhead').text().match(/\(\s?([^()]+)\s?\)/i) || [,null])[1];

				var cell2 = row2.find('td.subtext');
				var points = parseInt(cell2.find('span[id^=score]').text(), 10);
				var userLink = cell2.find('a[href^=user]');
				var user = userLink.text() || null;
				var postLinks = cell2.find('a[href^=item]');
				var timeAgoLink = $(postLinks[0]);
				var timeAgo = timeAgoLink.text().trim();
				var commentsCountLink = $(postLinks[1]);
				var commentsCount = commentsCountLink && /\d/.test(commentsCountLink.text()) ? parseInt(commentsCountLink.text(), 10) : 0;

				var type = 'link';
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

			fn(null, posts);
		} catch (e){
			fn(e);
		}
	}
};

var cleanContent = function(html){
	// yea yea regex to clean HTML is lame yada yada
	html = html.replace(/">-+<\/font/ig, '"></font'); // remove weird invisible dashes at the end of comments
	html = html.replace(/<\/?font[^<>]*>/ig, ''); // remove font tags
	html = html.replace(/<\/p>/ig, ''); // remove trailing </p>s
	if (!html.match(/^<p>/i)) html = '<p>' + html; // prepend <p>
	return html;
};

var processComments = function(rows, $){
	var comments = [];

	// Create flat array of comments
	for (var i=0, l=rows.length; i<l; i++){
		var row = $(rows[i]);
		var comment = {};
		var level = 0;
		var levelRow = row.find('img[src*="s.gif"]');
		var metadata = row.find('.comhead').has('a');
		var user = '';
		var timeAgo = '';
		var id = '';
		var content = '[deleted]';

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
		var comment = comments[i];
		var level = comment.level;

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

exports.comments = function(body, fn){
	if (!/[<>]/.test(body)){
		fn(new Error('Not HTML content'));
	} else {
		try {
			var window = domino.createWindow(body);
			window._run(jquery);
			var $ = window.$;

			var table1 = $('td table:has(td.title,textarea)');
			var voteLink = table1.find('td a[id^=up]');
			var id = (voteLink.length ? (voteLink.attr('id').match(/\d+/) || [])[0] : null);
			var cell1 = table1.find('td.title').has('a');

			var link, title, url, domain, points, user, timeAgo, commentsCount;
			var content = null;
			var poll = null;
			var type = 'link';

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
			};

			var table2 = table1.nextAll('table:first');

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

			fn(null, post);
		} catch (e){
			fn(e);
		}
	}
};

exports.moreComments = function(body, fn){
	if (!/[<>]/.test(body)){
		if (/expired/i.test(body)){
			fn(new Error('Content expired'));
		} else {
			fn(new Error('Not HTML content'));
		}
	} else {
		try {
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

			fn(null, post);
		} catch (e){
			fn(e);
		}
	}
};

exports.newComments = function(body, fn){
	if (!/[<>]/.test(body)){
		fn(new Error('Not HTML content'));
	} else {
		try {
			var window = domino.createWindow(body);
			window._run(jquery);
			var $ = window.$;

			var commentRows = $('tr:nth-child(3) tr:has(span.comment)');
			var comments = processComments(commentRows, $);

			fn(null, comments);
		} catch (e){
			fn(e);
		}
	}
};

exports.user = function(body, fn){
	if (!/[<>]/.test(body)){
		fn(new Error('Not HTML content'));
	} else {
		try {
			var window = domino.createWindow(body);
			window._run(jquery);
			var $ = window.$;

			var cells = $('form tr td:odd');
			var id = cells.eq(0).text();
			var created = cells.eq(1).text();
			var karma = parseInt(cells.eq(2).text(), 10);
			var avg = parseFloat(cells.eq(3).text());
			var about = cleanContent(cells.eq(4).html());

			var user = {
				id: id,
				created: created,
				karma: karma,
				avg: avg,
				about: about
			};

			fn(null, user);
		} catch (e){
			fn(e);
		}
	}
};
