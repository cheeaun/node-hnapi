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

	if (store == 'redis'){
		const Redis = require('ioredis');
		const server = /^rediss?\:/i.test(options.server) ? options.server : `redis://${options.server}`;
		const redis = new Redis(server);
		redis.on('connect', onConnect);
		redis.on('error', onError);

		set = (key, value, expiry) => {
			redis.set(key, JSON.stringify(value), 'ex', expiry);
		};
		get = (key, fn) => {
			if (process.env.DEBUG) console.log('REDIS GET', key);
			redis.get(key, (e, value /* string */) => {
				try {
					fn(e, JSON.parse(value));
				} catch (e){
					fn(e);
				}
			});
		};
		del = (key) => redis.del(key);
	}

	return {
		set: function(key, value, expiry){ // expiry in seconds
			if (memoryCache) memory.put(key, value, expiry ? (expiry*1000) : null);
			set(key, value, expiry);
		},
		get: function(key, fn){
			var value;
			if (memoryCache && (value = memory.get(key))){
				if (process.env.DEBUG && value) console.log('MEMORY CACHE', key);
				fn(null, value);
				return;
			}
			get(key, function(e, value){
				if (e){
					fn(e);
					return;
				}
				if (process.env.DEBUG && value) console.log('EXTERNAL CACHE', key);
				fn(null, value);
				// Half the expiry time for memory cache
				if (memoryCache && value) memory.put(key, value, expiry ? expiry/2*1000 : null);
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