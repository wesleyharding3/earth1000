promise.wired = function(functions, args, context, done, fail) {
	//console.log("wired : ", functions, args, context, done, fail);
	var ctx = context || {};
	if (args && !args.forEach)
		args = [args];
	var coll = functions.concat([]);
	var doneAndIterate = function(s) {
		//console.log("done and wired : ",s)
		if (done)
			this.done(function(s) {
				return done.call(this, s);
			});
		if (coll.length > 0)
			this.done(function(s) {
				args = s;
				if (args && !args.forEach)
					args = [args];
				this.when(coll.shift())
					.done(doneAndIterate);
			});
		if (s._deep_query_node_)
			return s.value.apply(context || (s.ancestor) ? s.ancestor.value : {}, args);
		return s.apply(ctx, args);
	};
	var failAndIterate = function(e) {
		if (!fail)
			return e;
		if (coll.length > 0)
			this.when(coll.shift())
			.done(doneAndIterate);
		var self = this;
		return promise.when(fail.call(this, e))
			.done(function(s) {
				if (typeof s === 'undefined' || s instanceof Error)
					return s ||  e;
				args = s;
				if (args && !args.forEach)
					args = [args];
				self.fail(failAndIterate);
			});
	};
	var iterator = promise.when(coll.shift())
		.done(doneAndIterate)
		.fail(failAndIterate);
	return iterator;
};

/**
 * iterate over an array of objects (could be array of promises).
 * Execute 'done' callback  for each entry. (or 'fail' if item is error)
 * @param  {[type]}   collection [description]
 * @param  {Function} done       [description]
 * @param  {[type]}   fail       [description]
 * @return {[type]}              [description]
 */
promise.iterate = function(collection, done, fail) {
	var coll = collection.concat([]);
	var res = [];
	var doneAndIterate = function(s) {
		if (coll.length > 0)
			this.done(function(s) {
				res.push(s);
			})
			.when(coll.shift())
			.done(doneAndIterate);
		return done.call(this, s);
	};
	var failAndIterate = function(e) {
		if (!fail)
			return e;
		if (coll.length > 0)
			this.when(coll.shift())
			.done(doneAndIterate);
		var self = this;
		return promise.when(fail.call(this, e))
			.done(function(s) {
				if (typeof s === 'undefined' || s instanceof Error)
					return s ||  e;
				res.push(s);
				self.fail(failAndIterate);
			});
	};
	var iterator = promise.when(coll.shift())
		.done(doneAndIterate)
		.fail(failAndIterate)
		.done(function(s) {
			res.push(s);
			return res;
		});
	return iterator;
};

/**
 * execute array of funcs sequencially
 * @for deep
 * @static
 * @method sequence
 * @param  {String} funcs an array of functions to execute sequentially
 * @param  {Object} args (optional) some args to pass to first functions
 * @return {deep.Promise} a promise
 */
promise.series = function(funcs, context, args) {
	if (!funcs || funcs.length === 0)
		return args;
	var current = funcs.shift();
	var def = promise.Deferred();
	context = context || {};
	var doIt = function(r) {
		promise.when(r).then(function(r) {
			if (funcs.length === 0) {
				if (typeof r === 'undefined') {
					r = args;
					if (args.length == 1)
						r = args[0];
				}
				def.resolve(r);
				return r;
			}
			if (typeof r === 'undefined')
				r = args;
			else
				r = [r];
			current = funcs.shift();
			doIt(current.apply(context, r));
		}, function(error) {
			if (!def.rejected && !def.resolved && !def.canceled)
				def.reject(error);
		});
	};
	doIt(current.apply(context, args));
	return def.promise();
};