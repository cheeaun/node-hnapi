const https = require('https');
const zlib = require('zlib');
const TimeQueue = require('timequeue');
const HOST = 'news.ycombinator.com';

var REQUESTS = {}; // Caching fetch requests as a way to "debounce" incoming requests
var requestWorker = function(path, data, fn, done){
	if (typeof data == 'function'){
		done = fn;
		fn = data;
	}
	var start;
	var req = REQUESTS[path];

	if (!req){
		console.info('Fetching ' + path);

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
	req.on('response', function(r){
		delete REQUESTS[path];

		if (r.statusCode != 200){
			var statusCode = r.statusCode;
			return;
		}

		var body = '';

		var contentEncoding = r.headers['content-encoding'];
		if (contentEncoding && contentEncoding.toLowerCase().indexOf('gzip') > -1){
			var gunzip = zlib.createGunzip();
			gunzip.on('data', function(data){
				body += data.toString();
			}).on('end', function(){
				fn(null, body);
			}).on('error', fn);
			r.pipe(gunzip);
		} else {
			r.on('data', function(chunk){
				body += chunk;
			}).on('end', function(){
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
	if (e) console.error(e);
});

module.exports = request;