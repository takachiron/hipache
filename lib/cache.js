
'use strict';

/*
 * This module handles all IO called on the cache (currently Redis)
 */

var url = require('url'),
    redis = require('redis'),
    lruCache = require('lru-cache');


function Cache(config, handlers) {
    if (!(this instanceof Cache)) {
        return new Cache(config, handlers);
    }

    var logHandler = handlers.logHandler || console.log,
        debugHandler = handlers.debugHandler || console.log;
    this.config = config;
    this.log = function (msg) {
        logHandler('Cache: ' + msg);
    };
    this.debug = function (msg) {
        debugHandler('Cache: ' + msg);
    };
    // Configure Redis
    this.redisClient = redis.createClient(
            this.config.redisPort,
            this.config.redisHost
            );
    this.redisClient.on('error', function (err) {
        this.log('RedisError ' + err);
    }.bind(this));
    // LRU cache for Redis lookups
    if (this.config.server.lruCache === undefined) {
        this.debug('LRU cache is disabled');
        this.lru = {
            set: function () {},
            get: function () {},
            del: function () {}
        };
    } else {
        this.debug('LRU cache is enabled');
        this.lru = lruCache({
            max: this.config.server.lruCache.Size,
            maxAge: this.config.server.lruCache.ttl * 1000
        });
    }
}


/*
 * This method mark a dead backend in the cache by its backend id
 */
Cache.prototype.markDeadBackend = function (backendInfo) {
    var frontendKey = 'dead:' + backendInfo.frontend;
    var multi = this.redisClient.multi();
    multi.sadd(frontendKey, backendInfo.backendId);
    multi.expire(frontendKey, this.config.server.deadBackendTTL);
    // Announce the dead backend on the "dead" channel
    multi.publish('dead', backendInfo.frontend + ';' +
            backendInfo.backendUrl + ';' + backendInfo.backendId + ';' +
            backendInfo.backendLen);
    multi.exec();
    // A dead backend invalidates the LRU
    this.lru.del(backendInfo.frontend);
};


/*
 * This method is an helper to get the domain name (without the subdomain)
 */
Cache.prototype.getDomainName = function (hostname) {
    var idx = hostname.lastIndexOf('.');

    if (idx < 0) {
        return hostname;
    }
    idx = hostname.lastIndexOf('.', idx - 1);
    if (idx < 0) {
        return hostname;
    }
    return hostname.substr(idx);
};


/*
 * This method picks up a backend randomly and ignore dead ones.
 * The parsed URL of the chosen backend is returned.
 * The method also decides which HTTP error code to return according to the
 * error.
 */
Cache.prototype.getBackendFromHostHeader = function (host, callback) {
    if (host === undefined) {
        return callback('no host header', 400);
    }
    if (host === '__ping__') {
        return callback('ok', 200);
    }
    var index = host.indexOf(':');
    if (index > 0) {
        host = host.slice(0, index).toLowerCase();
    }

    var readFromCache = function (hostKey, cb) {
        // Let's try the LRU cache first
        var rows = this.lru.get(hostKey);
        if (rows !== undefined) {
            return cb(rows);
        }
        // The entry is not in the LRU cache, let's do a request on Redis
        var multi = this.redisClient.multi();
        multi.lrange('frontend:' + hostKey, 0, -1);
        multi.lrange('frontend:*' + this.getDomainName(hostKey), 0, -1);
        multi.smembers('dead:' + hostKey);
        multi.exec(function (err, rows) {
            this.lru.set(hostKey, rows);
            cb(rows);
        }.bind(this));
    }.bind(this);

    readFromCache(host, function (rows) {
        var backends = rows[0];
        if (backends.length === 0) {
            // The frontend does not exist, let's try the wildcard entry?
            backends = rows[1];
        }
        var deads = rows[2];
        if (backends.length === 0) {
            return callback('frontend not found', 400);
        }
        var virtualHost = backends[0];
        backends = backends.slice(1); // copy to not modify the lru in place
        var index = (function () {
            // Pickup a random backend index
            var indexes = [];
            for (var i = 0; i < backends.length; i += 1) {
                if (deads.indexOf(i.toString()) >= 0) {
                    continue; // Ignoring dead backends
                }
                indexes.push(i); // Keeping only the valid backend indexes
            }
            if (indexes.length < 2) {
                return (indexes.length - 1);
            }
            return indexes[Math.floor(Math.random() * indexes.length)];
        }());
        if (index < 0) {
            return callback('Cannot find a valid backend', 502);
        }
        var backend = url.parse(backends[index]);
        backend.id = index; // Store the backend index
        backend.frontend = host; // Store the associated frontend
        backend.virtualHost = virtualHost; // Store the associated vhost
        backend.len = backends.length;
        if (backend.hostname === undefined) {
            return callback('backend is invalid', 502);
        }
        backend.port = (backend.port === undefined) ? 80 : parseInt(backend.port, 10);
        this.debug('Proxying: ' + host + ' -> ' + backend.hostname + ':' + backend.port);
        callback(false, 0, backend);
    }.bind(this));
};

module.exports = Cache;
