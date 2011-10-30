var journey = require('journey'),
	scraper = require('scraper');

//
// Create a Router
//
var router = new(journey.Router);

// Create the routing table
router.map(function () {
    this.root.bind(function (req, res){
		scraper('http://news.ycombinator.com/', function(err, $){
			var links = [];
			$('a[href]').each(function(){
				links.push(this.href);
			});
			res.send({'links': links});
		});
	});
});

require('http').createServer(function (request, response) {
    var body = "";

    request.addListener('data', function (chunk) { body += chunk });
    request.addListener('end', function () {
        //
        // Dispatch the request to the router
        //
        router.handle(request, body, function (result) {
            response.writeHead(result.status, result.headers);
            response.end(result.body);
        });
    });
}).listen(process.env.PORT || 80);