const firebase = require('@firebase/app').default;
require('@firebase/database');
var moment = require('moment');
var extend = require('extend');
var url = require('url');
var he = require('he');

firebase.initializeApp({
  databaseURL: 'https://hacker-news.firebaseio.com',
});
var hn = firebase.database().ref('/v0');
var hnRecentItems = hn.child('updates/items');

var typeMapping = {
  story: 'link'
};

var cleanText = function(html){
  if (!html) return;
  // yea yea regex to clean HTML is lame yada yada
  html = html.replace(/<\/p>/ig, ''); // remove trailing </p>s
  if (!html.match(/^<p>/i)) html = '<p>' + html; // prepend <p>
  return html;
}

var api = {

  stories: function(base, options, fn){
    var opts = extend({
      page: 1
    }, options);
    var page = opts.page;
    var limit = 30;
    var startIndex = (page-1) * limit;
    var endIndex = startIndex + limit;

    var stories = hn.child(base).limitToFirst(limit * page);
    stories.once('value', function(snapshot){
      // Grab all items from the IDs
      var items = snapshot.val().slice(startIndex, endIndex);
      var itemFetches = items.map(function(itemID){
        return new Promise(function(resolve, reject){
          var item = hn.child('item/' + itemID);
          item.once('value', function(snap){
            resolve(snap.val());
          }, function(err){
            reject(err);
          });
        });
      });

      // Throw them all into an array
      Promise.all(itemFetches).then(function(res){
        var apiRes = res.filter(Boolean).map(function(item){
          var commentsCount = item.descendants || 0;

          var output = {
            id: item.id,
            title: he.decode(item.title),
            points: item.score,
            user: item.by,
            time: item.time, // Unix timestamp
            time_ago: moment(item.time*1000).fromNow(),
            comments_count: commentsCount,
            type: typeMapping[item.type] || item.type
          };

          if (item.url){
            output.url = item.url;
            output.domain = url.parse(item.url).hostname.replace(/^www\./i, '');
          } else {
            output.url = 'item?id=' + item.id; // Simulate "local" links
          }

          // If it's a job, username and points are useless
          if (item.type == 'job'){
            output.user = output.points = null;
          }

          // Identify type=ask
          if (item.type == 'story' && output.url.match(/^item/i) && item.title.match(/^ask/i)){
            output.type = 'ask';
          }

          return output;
        });

        fn(null, apiRes);
      }).catch(function(err){
        fn(err);
      });
    });
  },

  news: function(options, fn){
    api.stories('topstories', options, fn);
  },

  newest: function(options, fn){
    api.stories('newstories', options, fn);
  },

  best: function(options, fn){
    api.stories('beststories', options, fn);
  },

  ask: function(options, fn){
    api.stories('askstories', options, fn);
  },

  show: function(options, fn){
    api.stories('showstories', options, fn);
  },

  jobs: function(options, fn){
    api.stories('jobstories', options, fn);
  },

  newComments: function(fn){ // Not-so-complete 'newComments' too
    var recent = hnRecentItems.limitToFirst(30);
    recent.once('value', function(snapshot){
      var items = snapshot.val();
      var itemFetches = items.map(function(itemID){
        return new Promise(function(resolve, reject){
          var item = hn.child('item/' + itemID);
          item.once('value', function(snap){
            resolve(snap.val());
          }, function(err){
            reject(err);
          });
        });
      });

      Promise.all(itemFetches).then(function(res){
        var stories = res.filter(function(r){
          return r.type == 'comment';
        });
        fn(null, stories);
      });
    });
  },

  _item: function(id, isComment){
    return new Promise(function(resolve, reject){
      var item = hn.child('item/' + id);
      var timeout;
      var onValue = function(snap){
        var val = snap.val();
        if (!val){ // Silently resolve with nothing if null
          resolve();
          clearTimeout(timeout);
          return;
        }

        // Comments
        var kidsPromises = Promise.resolve();
        if (val.kids && val.kids.length){
          kidsPromises = Promise.all(val.kids.map(function(kid){
            return api._item(kid, true);
          }));
        }

        // Poll
        var partsPromises = Promise.resolve();
        if (val.type == 'poll' && val.parts && val.parts.length){
          partsPromises = Promise.all(val.parts.map(function(part){
            return new Promise(function(res, rej){
              var p = hn.child('item/' + part);
              p.once('value', function(v){
                res(v.val());
              }, function(err){
                rej(err);
              });
            });
          }));
        }

        partsPromises.then(function(parts){
          clearTimeout(timeout);
          if (parts && parts.length) val._parts = parts;
          kidsPromises.then(function(kids){
            if (kids && kids.length) val._kids = kids;
            resolve(val);
          }).catch(reject);
        }).catch(reject);
      };
      item.once('value', onValue, function(err){
        console.log('Error', id, err);
        // Silently resolve because of stupid 'PERMISSION_DENIED' bug from Firebase
        if (isComment) resolve();
        reject(err);
      });
      if (isComment) timeout = setTimeout(function(){
        console.log('Timeout for #' + id);
        item.off('value', onValue);
        resolve(); // Silently resolve with nothing if timeout
      }, 1000); // Give chance for only 1s
    });
  },

  item: function(id, fn){
    api._item(id).then(function(item){
      var apiRes = {
        id: item.id,
        title: he.decode(item.title),
        points: item.score,
        user: item.by,
        time: item.time, // Unix timestamp
        time_ago: moment(item.time*1000).fromNow(),
        type: typeMapping[item.type] || item.type,
        content: item.deleted ? '[deleted]' : cleanText(item.text),
        deleted: item.deleted,
        dead: item.dead
      };

      if (item.url){
        apiRes.url = item.url;
        apiRes.domain = url.parse(item.url).hostname.replace(/^www\./i, '')
      } else {
        apiRes.url = 'item?id=' + item.id; // Simulate "local" links
      }

      // If it's a job, username and points are useless
      if (item.type == 'job'){
        apiRes.user = apiRes.points = null;
      }

      // Poll
      if (item._parts && item._parts.length){
        apiRes.poll = item._parts.map(function(part){
          return {
            item: part.title,
            points: part.score
          };
        });
      }

      // Comments
      var commentsCount = 0;
      var formatComments = function(obj, kids, level){
        if (kids && kids.length){
          kids = kids.filter(function(kid){
            return !!kid;
          });
          if (!kids.length){
            obj.comments = [];
            return;
          }
          commentsCount += kids.length;
          obj.comments = kids.map(function(kid){
            var res = {
              id: kid.id,
              level: level,
              user: kid.by,
              time: kid.time,
              time_ago: moment(kid.time*1000).fromNow(),
              content: kid.deleted ? '[deleted]' : cleanText(kid.text),
              deleted: kid.deleted,
              dead: kid.dead
            };
            formatComments(res, kid._kids, level+1);
            return res;
          });
        } else {
          obj.comments = [];
        }
      };
      formatComments(apiRes, item._kids, 0);
      apiRes.comments_count = commentsCount;

      fn(null, apiRes);
    }, function(err){
      fn(err);
    });
  },

  user: function(id, fn){
    var u = hn.child('user/' + id);
    u.once('value', function(snap){
      var val = snap.val();
      if (val && val.id){
        fn(null, {
          id: val.id,
          created_time: val.created,
          created: moment(val.created*1000).fromNow(),
          karma: val.karma,
          avg: null, // No average yo
          about: cleanText(val.about)
        });
      } else {
        fn('User not found');
      }
    }, function(err){
      fn(err);
    });
  }
};

module.exports = api;
