/**
 * @author Gilles Coomans <gilles.coomans@gmail.com>
 */
var deep = require("deepjs");
require("../errors");
var fs = require('fs');
var pathUtil = require("path");
var normalize = function(path){
	if(path && path[0] !== '/')
		path = pathUtil.normalize(deep.Promise.context.cwd+"/"+path);
	return path || deep.Promise.context.cwd;
};
/*
canExecute():

checkPermission (<path>, 1, cb);
canRead():

checkPermission (<path>, 4, cb);
canWrite():

checkPermission (<path>, 2, cb);
*/
var checkPermission = function (path, mask){
	var def = deep.Deferred();
	path = this.normalize(path);
    fs.stat (path, function (error, stats){
        if (error)
            def.reject(error);
        else
            def.resolve(!!(mask & parseInt ((stats.mode & parseInt ("777", 8)).toString (8)[0])));
    });
    return def.promise();
};

deep.Promise.API.fs = function(cwd) {
    var self = this;
    if(typeof cwd === 'string')
    	cwd = { cwd:cwd };
    var handler = new FSChain(this._state, cwd);
    self._enqueue(handler);
    return handler;
};

deep.fs = function(cwd){
	if(typeof cwd === 'string')
    	cwd = { cwd:cwd };
	return new FSChain({}, cwd).resolve();
};

var constructor = function (state, options) {
	options = options || {};
	this._identity = FSChain;
	this.cd(options.cwd || ".");
};

var proto = {
	/*
	assertion
	 */
	isWritable:function(path){
		var self = this;
		var func = function(s,e){
			path = deep.nodes.val(path || s);
			var check = function(p){
				path = normalize(path);
				return checkPermission.call(self, path, 2)
				.done(function(sc){
					if(!sc)
						return deep.errors.FS(path+ " is not Writable.");
				});
			};
			if(path.forEach)
			{
				var r = [];
				path.forEach(function(p){
					r.push(check(p));
				});
				return deep.alls(r)
				
			}
			return check(path)
			.done(function(){
				return s;
			});
		};
		func._isDone_ = true;
		return self._enqueue(func);
	},
	/*
	assertion
	 */
	isReadable:function(path){
		var self = this;
		path = path || '';
		var func = function(s,e){
			path = deep.nodes.val(path || s);
			var check = function(p){
				path = normalize(path);
				return checkPermission.call(self, path, 4)
				.done(function(sc){
					if(!sc)
						return deep.errors.FS(path+ " is not Writable.");
				});
			};
			if(path.forEach)
			{
				var r = [];
				path.forEach(function(p){
					r.push(check(p));
				});
				return deep.alls(r)
				
			}
			return check(path)
			.done(function(){
				return s;
			});
		};
		func._isDone_ = true;
		return self._enqueue(func);
	},
	/*
	assertion
	 */
	isExecutable:function(path){
		var self = this;
		path = path || '';
		var func = function(s,e){
			path = deep.nodes.val(path || s);
			var check = function(p){
				path = normalize(path);
				return checkPermission.call(self, path, 1)
				.done(function(sc){
					if(!sc)
						return deep.errors.FS(path+ " is not Writable.");
				});
			};
			if(path.forEach)
			{
				var r = [];
				path.forEach(function(p){
					r.push(check(p));
				});
				return deep.alls(r)
				
			}
			return check(path)
			.done(function(){
				return s;
			});
		};
		func._isDone_ = true;
		return self._enqueue(func);
	},
	/**
	 * shoul maybe only log to console
	 * @return {[type]}
	 */
	pwd:function(){
		var self = this;
		var func = function(s,e){
			return deep.Promise.context.cwd;
		};
		func._isDone_ = true;
		return self._enqueue(func);
	},
	cd:function(cwd){
		var self = this;
		var func = function(s,e){
			cwd =  normalize(cwd || s);
			self.toContext("cwd", pathUtil.resolve(cwd))
			.exists(".", true)
			.done(function(){
				return s;
			});
		};
		func._isDone_ = true;
		return self._enqueue(func);
	},
	stat:function(path){
		var self = this;
		var func = function(s,e){
			path = path || s;
			path = normalize(path);
			return deep.async(fs, "stat", [path]);
		};
		func._isDone_ = true;
		return self._enqueue(func);
	},
	rename:function(oldPath, newPath){
		var self = this;
		var func = function(s,e){
			oldPath = normalize(oldPath);
			newPath = normalize(newPath);
			return deep.async(fs, "rename", [oldPath, newPath])
			.done(function(sc){
				return s || sc;
			});
		};
		func._isDone_ = true;
		return self._enqueue(func);
	},
	chown:function(path, uid, gid){
		var self = this;
		path = path || '.';
		var func = function(s,e){
			path = normalize(path);
			return deep.async(fs, "chown", [path, uid, gid])
			.done(function(sc){
				return s || sc;
			});
		};
		func._isDone_ = true;
		return self._enqueue(func);
	},
	chmod:function(path, mode){
		var self = this;
		path = path || '.';
		var func = function(s,e){
			path = normalize(path);
			return deep.async(fs, "chmod", [path, mode])
			.done(function(sc){
				return s;
			});
		};
		func._isDone_ = true;
		return self._enqueue(func);
	},
	/**
	 * assertion or not ? this is the question... ;)
	 * 
	 * @param  {[type]} path
	 * @param  {[type]} assertion
	 * @return {[type]}
	 */
	exists:function(path, assertion){
		var self = this;
		var func = function(s,e){
			if(path === true && !assertion)
			{
				path = null;
				assertion = true;
			}
			var check = function(path){
				path = normalize(path);
				var def = new deep.Promise();
				fs.exists(path, function(res){
					if(res != assertion)
						def.reject(deep.errors.NotFound("path ("+path+") don't exists", { path:path }));
					else
						def.resolve(assertion);
				});
				return def;
			};
			path = path || s;
			if(!path)
				return path;
			if(path.forEach)
			{
				var alls = [];
				s.forEach(function(n){
					if(n && n._deep_query_node_)
						n = n.value;
					alls.push(check(n));
				});
				return deep.all(alls)
				.done(function(){
					return s;
				});
			}
			var tmp = path;
			if(path && path._deep_query_node_)
				tmp = path.value;
			return check(tmp)
			.done(function(){
				return s;
			});
		};
		func._isDone_ = true;
		return self._enqueue(func);
	},
	link:function(srcpath, dstpath){
		var self = this;
		var func = function(s,e){
			srcpath = normalize(srcpath);
			dstpath = normalize(dstpath);
			return deep.async(fs, "link", [srcpath, dstpath])
			.done(function(sc){
				return s;
			});
		};
		func._isDone_ = true;
		return self._enqueue(func);
	},
	unlink:function(path){
		var self = this;
		path = path || '.';
		var func = function(s,e){
			path = normalize(path);
			return deep.async(fs, "unlink", [path])
			.done(function(sc){
				return s;
			});
		};
		func._isDone_ = true;
		return self._enqueue(func);
	},
	readlink:function(path){
		var self = this;
		path = path || '.';
		var func = function(s,e){
			path = normalize(path);
			return deep.async(fs, "readlink", [path]);
		};
		func._isDone_ = true;
		return self._enqueue(func);
	},
	readdir:function(path){
		var self = this;
		path = path || '.';
		var func = function(s,e){
			path = normalize(path);
			return deep.async(fs, "readdir", [path]);
		};
		func._isDone_ = true;
		return self._enqueue(func);
	},
	rmdir:function(path){
		var self = this;
		var func = function(s,e){
			path = normalize(path);
			return deep.async(fs, "rmdir", [path])
			.done(function(sc){
				return s;
			});
		};
		func._isDone_ = true;
		return self._enqueue(func);
	},
	mkdir:function(path, mode){
		var self = this;
		var func = function(s,e){
			path = normalize(path);
			return deep.async(fs, "mkdir", [path, mode])
			.done(function(sc){
				return s;
			});
		};
		func._isDone_ = true;
		return self._enqueue(func);
	},
	from:function(path, options){
		var self = this;
		if(typeof options === 'string')
			options = { type:options };
		else
		{
			options = options || {};
			options.type = options.type || 'json';
		}
		var func = function(s,e){
			path = normalize(path);
			return deep.async(fs, "readFile", [path, options])
			.done(function(s){
				switch(options.type)
				{
					case 'binary': return s; break;
					case 'json': return JSON.parse(String(s)); break;
					default : return String(s);
				}
			});
		};
		func._isDone_ = true;
		return self._enqueue(func);
	},
	json:function(path){
		var self = this;
		var func = function(s,e){
			return self.from(path, { type:"json" });
		};
		func._isDone_ = true;
		return self._enqueue(func);
	},
	text:function(path){
		var self = this;
		var func = function(s,e){
			return self.from(path, { type:"text" });
		};
		func._isDone_ = true;
		return self._enqueue(func);
	},
	to:function(path, data, minified){
		var self = this;
		var func = function(s,e){
			data = (typeof data === 'undefined')?s:data;
			data = deep.nodes.val(data);
			path = normalize(path);
			if(!(data instanceof Buffer) && typeof data !== 'string')
				data = JSON.stringify(data, null, (minified?null:' '));
			return deep.async(fs, "writeFile", [path, data])
			.done(function(){
				return data;
			});
		};
		func._isDone_ = true;
		return self._enqueue(func);
	},
	appendTo:function(path, data, options){
		var self = this;
		var func = function(s,e){
			data = (typeof data === 'undefined')?s:data;
			data = deep.nodes.val(data);
			path = normalize(path);
			return deep.async(fs, "appendFile", [path, "\r\n"+data, options])
			.done(function(){
				return data;
			});
		};
		func._isDone_ = true;
		return self._enqueue(func);
	}
};

var FSChain = deep.fs.Chain = deep.compose.Classes(deep.Promise, constructor, proto);

FSChain._aspects = {
	constructor:constructor,
	proto:proto
};


deep.fs.Protocol = function(name, options) {
	return deep.protocol(name, {
		protocol: name,
		//________________________ getters
		get: function(request, opt) {
			// console.log("______________ fs protoc : get : ", name, request, opt);
			var methodIndex = request.indexOf(" "),
				method, args;
			if (methodIndex > -1) {
				method = request.substring(0, methodIndex);
				args = request.substring(methodIndex+1);
			}
			var handler = new deep.fs.Chain(null, options);
			if (method && handler[method])
				handler[method](args);
			else
				return deep.errors.Internal("protocol : fs:: no sub command found with : ", method)
			return handler.resolve();
		},
		json: function(request, opt) {
			// console.log("______________ fs protoc : get json : ", request, opt);
			return deep.fs(options).json(request);
		},
		text: function(request, opt) {
			// console.log("______________ fs protoc : get text : ", request, opt);
			return deep.fs(options).text(request);
		},
		//_________________________ writers
		to:function(path, opt){
			return function(value, oldFile)
			{
				return deep.fs(options).to(path, value);
			}
		},
		appendTo:function(path, opt){
			return function(value, oldFile)
			{
				return deep.fs(options).appendTo(path, value);
			}
		}
	});
};


module.exports = FSChain;

