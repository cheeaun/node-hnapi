const memory = require('memory-cache');

const noop = function(){};

const cache = function(opts){
	var set = del = noop;
	var get = function(key, fn){
		if (fn) fn();
	};

	var store = opts.store;
	var expiry = opts.expiry;
	var options = opts.options;
	var memoryCache = typeof opts.memory == 'boolean' ? opts.memory : true;
	var onConnect = options.onConnect || noop;
	var onError = options.onError || noop;
	if (!store) memoryCache = true;

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
				if (process.env.DEBUG) console.log('CACHE', key);
				fn(null, value);
				// Half the expiry time for memory cache
				if (memoryCache) memory.put(key, value, expiry ? expiry/2*1000 : null);
			});
		},
		del: function(key){
			if (memoryCache) memory.del(key);
			del(key);
		},
		_memory: memory,
	};
};

module.exports = cache;