var memory = require('memory-cache');

var noop = function(){};

var cache = function(opts){
	var set = del = noop;
	var get = function(key, fn){
		if (fn) fn();
	};

	var store = opts.store;
	var expiry = opts.expiry;
	var options = opts.options;
	var debug = options.debug;
	var memoryCache = typeof opts.memory == 'boolean' ? opts.memory : true;
	var onConnect = options.onConnect || noop;
	var onError = options.onError || noop;
	if (!store) memoryCache = true;

	if (debug) console.log('memoryCache: ' + memoryCache);

	if (store == 'memcached'){
		var Memcached = require('memcached');
		var memcached = new Memcached(options.servers.split(','));
		memcached.on('reconnected', onConnect);
		memcached.on('issue', onError);
		memcached.on('failure', onError);
		memcached.on('remove', onError);
		onConnect(); // Assume it's connected

		set = function(key, value, expiry){
			memcached.set(key, value, expiry, noop);
		};
		get = function(key, fn){
			memcached.get(key, fn);
		};
		del = function(key){
			memcached.del(key, noop);
		};
	} else if (store == 'redis'){
		var redis = require('redis');
		if (debug) redis.debug_mode = true;
		var redisClient;
		var redisURL = options.url;
		if (redisURL){
			var url = require('url').parse(redisURL);
			redisClient = redis.createClient(url.port, url.hostname, {
				auth_pass: url.auth.split(':')[1]
			});
		} else {
			redisClient = redis.createClient(null, null);
		}
		redisClient.on('connect', onConnect);
		redisClient.on('error', onError);

		set = function(key, value, expiry){
			if (!redisClient.connected) return;
			var strValue = JSON.stringify(value);
			if (expiry){
				redisClient.setex(key, expiry, strValue);
			} else {
				redisClient.set(key, strValue);
			}
		};
		get = function(key, fn){
			if (!redisClient.connected) return;
			redisClient.get(key, function(err, strValue){
				if (err){
					fn(err);
					return;
				}
				try{
					var value = JSON.parse(strValue);
					fn(null, value);
				} catch (e){
					fn(e);
				}
			});
		};
		del = function(key){
			if (!redisClient.connected) return;
			redisClient.del(key);
		};
	}

	return {
		set: function(key, value, expiry){ // expiry in seconds
			if (memoryCache) memory.put(key, value, expiry ? (expiry*1000) : null);
			set(key, value, expiry);
		},
		get: function(key, fn){
			var value;
			if (memoryCache && (value = memory.get(key))){
				fn(null, value);
				return;
			}
			get(key, function(e, value){
				if (e){
					fn(e);
					return;
				}
				fn(null, value);
				// Half the expiry time for memory cache
				if (memoryCache) memory.put(key, value, expiry ? expiry/2*1000 : null);
			});
		},
		del: function(key){
			if (memoryCache) memory.del(key);
			del(key);
		}
	};
};

module.exports = cache;