/**
 *
 * @author Gilles Coomans <gilles.coomans@gmail.com>
 * Promise classe and related tools.
 * Inspired from [promised-io](https://github.com/kriszyp/promised-io) from Kris Zyp implementation.
 * @licence
 * The MIT License (MIT)
 * Copyright (c) 2015 Gilles Coomans
 */

/**
 * deepjs/promise wrapping

var Promise = deep.Classes(require("deep-promise"));
var compose = decompose.Composer({
  elog: Promise.prototype.elog,
  slog: Promise.prototype.slog,
  log: Promise.prototype.log,
  delay: Promise.prototype.delay,
  when: Promise.prototype.when,
  debug: Promise.prototype.debug
});

Promise.contextualise = compose(Promise.contextualise)
.after(function(context){
	// hard copy modes
	if (context.modes)
		context.modes = utils.copy(context.modes);
	return context;
});

Promise.dumpError = utils.dumpError;
Promise.logger = logger;
 */

(function(define) {
	"use strict";
	define([], function() {
		var promise = {};

		promise.Undefined = {
			_deep_undefined_: true
		};

		/**
		 * return a promise that will be fullfilled when arg are ready (resolve or immediat)
		 * @for deep
		 * @static
		 * @method when
		 * @param  {Object} arg an object to waiting for
		 * @return {deep.Promise} a promise
		 */
		promise.when = function(arg) {
			//console.log("deep.when : ", arg)
			if (!arg || (!arg.promise && !arg.then))
				return new promise.Promise().resolve(arg);
			if (arg._deep_deferred_)
				return arg.promise();
			if (typeof arg.then === 'function') // any promise/thenable compliant object
			{
				var p = new promise.Promise(); // return new promise to avoid initial promise state to change
				arg.then(function(s) {
					p.resolve(s);
				}, function(e) {
					p.reject(e);
				});
				return p;
			}
			if (typeof arg.promise === "function") // jquery deferred case
				return arg.promise();
			if (typeof arg.promise === 'object') // bluebird deferred case
				return arg.promise;
			return new promise.Promise().resolve(arg);
		};
		promise.immediate = function(result) {
			return new promise.Promise().resolve(result);
		};

		/**
		 * return a promise that will be fullfilled when all args are ready (resolve or immediat)
		 * @for deep
		 * @static
		 * @method all
		 * @param  {Object} arg an array of objects to waiting for
		 * @return {deep.Promise} a promise
		 */
		promise.all = function(arr) {

			if (arguments.length > 1)
				arr = Array.prototype.slice.call(arguments);

			if (arr.length === 0)
				return promise.immediate([]);

			var prom = new promise.Promise(),
				count = arr.length,
				c = 0,
				d = -1,
				res = [];

			arr.every(function(a) {
				if (prom._rejected)
					return false;
				var i = d + 1;
				if (!a || !a.then) {
					if (a instanceof Error) {
						if (!prom.ended())
							prom.reject(a);
						return false;
					}
					res[i] = a;
					c++;
					if (c == count)
						prom.resolve(res);
				} else
					a.then(function(r) {
						res[i] = r;
						c++;
						if (c == count)
							prom.resolve(res);
					}, function(error) {
						if (!prom.ended())
							prom.reject(error);
					});
				d++;
				return true;
			});
			return prom;
		};

		//_____________________________________________________________________ PROMISED CHAIN MECANIC

		function asynchChainDone(self, res) {
			if (typeof res !== 'undefined') {
				if (res instanceof Error) {
					self._state.success = null;
					self._state.error = res;
				} else {
					if (res && res._deep_undefined_)
						res = undefined;
					self._state.success = res;
					self._state.error = null;
				}
			}
			self._running = false; // asynch flag
			if (!self._executing) // real asynch event
				self._next();
		}

		function asynchChainFail(self, e) {
			self._running = false; // asynch flag
			self._state.success = null;
			self._state.error = e;
			if (!self._executing) // real asynch event
				self._next();
		}

		function nextTry(self) {
			self._executing = true; //  synch flag

			var done = function(s) {
				return asynchChainDone(self, s);
			};

			var fail = function(e) {
				return asynchChainFail(self, e);
			};

			while (!self._running) // while not asynch
			{
				var next = self._state.queue.shift();
				if (self._state.error)
					while (next && next.type == "done")
						next = self._state.queue.shift();
				else
					while (next && next.type == "fail")
						next = self._state.queue.shift();
				if (!next)
					break;

				//________________________________encouter a promise in queue : was a chain stack call. launch chain.
				if (next.fn && next.fn._deep_promise_) {
					self._paused = true;
					next.fn._context = self._context;
					next.fn.resolve();
					break;
				}
				self._running = true; //  asynch flag
				self._state.oldQueue = self._state.queue;
				self._state.queue = [];
				var res = next.fn.call(self, self._state.success, self._state.error);

				if (res === self) {
					if (self._state.oldQueue) {
						if (self._state.queue.length)
							self._state.queue = self._state.queue.concat(self._state.oldQueue);
						else
							self._state.queue = self._state.oldQueue;
						self._state.oldQueue = null;
					}
					self._running = false; //  asynch flag
					continue;
				}
				if (res && typeof res.then === 'function') {
					var p = (res._deep_promise_ || res._deep_chain_) ? res : promise.when(res);
					p.done(done).fail(fail);
				} else {
					self._running = false;
					if (typeof res !== 'undefined') {
						var isError;
						if (res !== null) {
							if (res._deep_undefined_) {
								res = undefined;
								isError = false;
							} else
								isError = res instanceof Error;
						}
						self._state.success = (isError) ? null : res;
						self._state.error = (isError) ? res : null;
					}
				}
				if (self._state.oldQueue) {
					if (self._state.queue.length)
						self._state.queue = self._state.queue.concat(self._state.oldQueue);
					else
						self._state.queue = self._state.oldQueue;
					self._state.oldQueue = null;
				}
			}
		}

		//_____________________________________________________________________ DEFERRED
		/**
		 * A deep implementation of Deferred object (see promise on web)
		 * @class deep.Deferred
		 * @constructor
		 */
		promise.Deferred = function() {
			if (!(this instanceof promise.Deferred))
				return new promise.Deferred();
			this._promises = [];
			this._deep_deferred_ = true;
			return this;
		};

		promise.Deferred.prototype = {
			_deep_deferred_: true,
			_promises: null,
			rejected: false,
			resolved: false,
			canceled: false,
			_success: null,
			_error: null,
			ended: function() {
				return this.rejected || this.resolved || this.canceled;
			},
			/**
			 * resolve the Deferred and so the associated promise
			 * @method resolve
			 * @param  {Object} argument the resolved object injected in promise
			 * @return {deep.Deferred} this
			 */
			resolve: function(argument) {
				//console.log("deep.Deferred.resolve : ", argument);
				if (this.rejected || this.resolved)
					throw new Error("deferred has already been ended !");
				if (argument instanceof Error)
					return this.reject(argument);
				this._success = argument;
				this.resolved = true;
				var self = this;
				this._promises.forEach(function(promise) {
					promise.resolve(argument);
				});
			},
			/**
			 * reject the Deferred and so the associated promise
			 * @method reject
			 * @param  {Object} argument the rejected object injected in promise
			 * @return {deep.Deferred} this
			 */
			reject: function(argument) {
				//  console.log("DeepDeferred.reject");
				if (this.rejected || this.resolved)
					throw new Error("deferred has already been ended !");
				this._error = argument;
				this.rejected = true;
				var self = this;
				this._promises.forEach(function(promise) {
					promise.reject(argument);
				});
			},
			/**
			 * return a promise for this deferred
			 * @method promise
			 * @return {deep.Promise}
			 */
			promise: function() {
				var prom = new promise.Promise();
				//console.log("deep2.Deffered.promise : ", prom, " r,r,c : ", this.rejected, this.resolved, this.canceled)
				if (this.resolved)
					return prom.resolve(this._success);
				if (this.rejected)
					return prom.reject(this._error);
				this._promises.push(prom);
				return prom;
			}
		};

		//__________________________________________________________________ PROMISE

		var Promise = promise.Promise = function(state, options) {

			this._state = state = state || {};

			this._context = state.context || promise.Promise.context;
			this._state.success = state.success || undefined;
			this._state.error = state.error || null;

			this._state.queue = state.queue ||  [];
			this._state.oldQueue = state.oldQueue || null;
			this._state.handlers = state.handlers ||  [];
			this._state.handlers.push(this);
			this._identity = promise.Promise;
		};

		Promise.prototype = {
			_locals: undefined,
			_deep_promise_: true,
			_running: false,
			_executing: false,
			_initialised: false,
			_resolved: false,
			_rejected: false,
			// ______________________________________ PRIVATE API
			_enqueue: function(handle, type) {
				this._state.queue.push({
					fn: handle,
					type: type
				});
				if (this._initialised && !this._running && !this._executing)
					this._next();
				return this;
			},
			_next: function() {
				if (!this._initialised || this._paused)
					return;
				var self = this,
					previousContext;
				if (self._state.queue.length !== 0) {
					try {
						// swap context in
						previousContext = promise.Promise.context;
						if (previousContext !== self._context) {
							if (previousContext && previousContext.suspend)
								previousContext.suspend();
							promise.Promise.context = self._context;
							if (self._context && self._context.resume)
								self._context.resume();
						}
						// execute handle
						nextTry(self);
					} catch (e) {
						if (self._context.debug)
							if (promise.Promise.dumpError)
								promise.Promise.dumpError(e);
							else
								console.error(e);
						self._state.success = null;
						self._state.error = e;
						self._running = false; // async flag
						if (self._context.rethrow)
							throw e;
					} finally {
						// swap context back
						if (previousContext !== self._context) {
							if (self._context && self._context.suspend)
								self._context.suspend();
							if (previousContext && previousContext.resume)
								previousContext.resume();
							promise.Promise.context = previousContext;
						}
					}
					self._executing = false;
				}
			},
			//_______________________________________ PUBLIC DIRECT API
			ended: function() {
				return (this._resolved || this._rejected);
			},
			// ______________________________________ PUBLIC CHAINABLE API
			resolve: function(success) {
				if (this.ended())
					throw new Error("promise already resolved or rejected");
				this._resolved = true;
				this._paused = false;
				this._initialised = true;
				if (typeof success !== "undefined")
					this._state.success = success;
				var instanceOfError = this._state.success instanceof Error;
				this._state.error = instanceOfError ? this._state.success : this._state.error;
				this._state.success = instanceOfError ? null : this._state.success;
				this._next();
				return this;
			},
			reject: function(error) {
				if (this.ended())
					throw new Error("promise already resolved or rejected");
				this._rejected = true;
				this._paused = false;
				this._initialised = true;
				this._state.error = error;
				this._next();
				return this;
			},
			close: function() {
				var self = this;
				if (this._state.handlers.length == 1)
					return this;
				this._state.handlers.pop();
				return this._state.handlers[this._state.handlers.length - 1]; //._start();
			},
			clone: function() {
				return new this._identity({
					handlers: this._state.handlers.slice(),
					queue: (this._state.queue ? this._state.queue.slice() : []),
					oldQueue: (this._state.oldQueue ? this._state.oldQueue.slice() : null),
					success: this._state.success,
					error: this._state.error
				});
			},
			catchError: function(arg) {
				var self = this;
				return this.always(function() {
					self.toContext("rethrow", arg ? true : false);
				});
			},
			pushTo: function(array) {
				var self = this;
				if (self._initialised)
					return this.always(function() {
						array.push(self);
					});
				array.push(self);
				return this;
			},
			done: function(callBack) {
				var self = this;
				var func = function(s) {
					if (!callBack)
						return s;
					var a = callBack.call(self, s);
					if (a === self)
						return;
					return a;
				};
				return self._enqueue(func, "done");
			},
			spread: function(callback) {
				var self = this;
				var func = function(s) {
					if (!callBack)
						return s;
					var a = callBack.apply(self, (s && s.forEach) ? s : [s]);
					if (a === self)
						return;
					return a;
				};
				return self._enqueue(func, "done");
			},
			fail: function(callBack) {
				var self = this;
				var func = function(s, e) {
					if (!callBack)
						return e;
					var a = callBack.call(self, e);
					if (a === self)
						return;
					return a;
				};
				return self._enqueue(func, "fail");
			},
			always: function(callBack) {
				var self = this;
				var func = function(s, e) {
					if (!callBack)
						return e || s;
					var a = callBack.call(self, s, e);
					if (a === self)
						return;
					return a;
				};
				return self._enqueue(func, "always");
			},
			then: function(success, error) {
				var self = this;
				var func = null;
				if (success)
					this.done(function(s) {
						var a = success.call(self, s);
						if (a === self)
							return;
						return a;
					});
				if (error)
					this.fail(function(e) {
						var a = error.call(self, e);
						if (a === self)
							return;
						return a;
					});
				return this;
			},
			/**
			 * will wait xxxx ms before continuing chain
			 *(always familly)
			 *
			 * transparent (do not modify promise success/error)
			 *
			 *
			 * @chainable
			 * @method delay
			 * @param  {number} ms
			 * @return {deep.NodesChain} this
			 */
			delay: function(ms) {
				return this.always(function() {
					var time;
					// console.log("deep.delay : ", ms);
					var p = new promise.Promise();
					setTimeout(function() {
						p.resolve(undefined);
					}, ms);
					return p;
				});
			},

			/**
			 * set key/value in current state
			 *
			 * @chainable
			 * @method context
			 * @param  {String} key
			 * @param  {*} value
			 * @return {deep.NodesChain} this
			 */
			toState: function(key, val) {
				var self = this;
				return this.done(function(s) {
					if (!key)
						return new Error(".toState need key/val couple.");
					val = (typeof val === 'undefined') ? s : val;
					self._state[key] = val;
					return val;
				});
			},
			/**
			 * read key/value in current state
			 *
			 * @chainable
			 * @method state
			 * @param  {String} key
			 * @param  {*} value
			 * @return {deep.NodesChain} this
			 */
			fromState: function(key) {
				var self = this;
				return this.done(function(s) {
					if (!key)
						return self._state;
					var out = self._state[key];
					return (typeof out === 'undefined') ? deep.Undefined : out;
				});
			},

			/**
			 * wait promise resolution or rejection before continuing chain
			 *
			 *  asynch
			 *  transparent false
			 *
			 * @method  when
			 * @param  {deep.when} prom the promise to waiting for
			 * @chainable
			 * @return {deep.NodesChain}
			 */
			when: function(prom) {
				return this.done(function() {
					// console.log('.when ', prom);
					return prom;
				});
			}/*,
			loop: function(cb, interval, maxIteration, input) {
				return this.done(function(s) {
					return promise.loop(cb, interval, maxIteration, input ||  s);
				});
			}*/
		};

		promise.promisify = function(fn, parent) {
			return function() {
				var args = Array.prototype.slice.call(arguments),
					promise = new promise.Promise();
				args.push(function() {
					var callbackArgs = Array.prototype.slice.call(arguments);
					var error = callbackArgs.shift();
					if (error)
						promise.reject(error);
					else
						promise.resolve((callbackArgs.length <= 1) ? callbackArgs[1] : callbackArgs);
				});
				fn.apply(parent || {}, args);
				return promise;
			};
		};

		promise.async = function(parent, cmd, args) {
			var promise = new promise.Promise();
			var callback = function() {
				var argus = Array.prototype.slice.apply(arguments);
				var err = argus.shift();
				if (err)
					promise.reject(err);
				else if (!argus.length)
					promise.resolve(true);
				else if (argus.length == 1)
					promise.resolve(argus[0]);
				else
					promise.resolve(argus);
			};
			args.push(callback);
			if (parent) {
				if (typeof cmd === 'string')
					parent[cmd].apply(parent, args);
				else
					cmd.apply(parent, args);
			} else
				cmd.apply({}, args);
			return promise;
		};



		/**
		 * contextualised loop on a callback
		 *
		 *
		 * @example
		 * 	deep.loop(function(s){ console.log("hello success : ", s); return s+1; }, 50, 10, 1).done(function(s){ console.log("end of loop : ", s); });
		 *
		 * @example
		 * 	// to finish loop :
		 *
		 * 	deep.loop(function(s){ console.log("hello success : ", s); if(s >10) this.finish(); return s+1; }, 50, null, 1).done(function(s){ console.log("end of loop : ", s); });
		 *
		 * @param  {Function} callBack     the callback that need to be called several times. receive promise success as single argument.
		 * @param  {Number} interval     	interval between call
		 * @param  {Number} maxIteration
		 * @param  {*} input        		First promise success
		 * @return {Promise}              a promise that could handle end of loop.
		 */
		promise.loop = function(callBack, interval, maxIteration, input) {
			var iteration = 0,
				finished = false;
			var iterate = function(s) {
				if (finished)
					return s;
				if (maxIteration) {
					iteration++;
					if (maxIteration < iteration)
						return s;
				}
				this.done(callBack).delay(interval).done(iterate);
				return s;
			};
			var p = new prom.Promise().resolve(input).done(iterate);
			p.finish = function() {
				finished = true;
			};
			return p;
		};
		// _____________________________________________ LOGGER 
		Promise.getLogger = function() {
			return (promise.Promise.context && promise.Promise.context.logger) || promise.Promise.logger || console;
		};
		//_______________________________________________ logs
		/**
		 *
		 * log any provided arguments.
		 * If no arguments provided : will log current success or error state.
		 *
		 * transparent true
		 *
		 * @method  log
		 * @return {deep.Promise} this
		 * @chainable
		 */
		Promise.prototype.log = function() {
			var args = Array.prototype.slice.call(arguments);
			return this.elog.apply(this, args).slog.apply(this, args);
		};
		/**
		 *
		 * log any chain errors
		 *
		 * @method  log
		 * @return {deep.Promise} this
		 * @chainable
		 */
		Promise.prototype.elog = function() {
			var args = Array.prototype.slice.call(arguments);
			return this.fail(function(e) {
				var logger = promise.Promise.getLogger();
				args.push(e);
				logger.error.apply(logger, args);
			});
		};
		/**
		 *
		 * log any chain errors
		 *
		 * @method  log
		 * @return {deep.Promise} this
		 * @chainable
		 */
		Promise.prototype.slog = function() {
			var args = Array.prototype.slice.call(arguments);
			return this.done(function(s) {
				var logger = promise.Promise.getLogger();
				args.push(s);
				logger.log.apply(logger, args);
			});
		};


		//______________________________________________ CONTEXT MANAGEMENT
		//
		Promise.context = {
			rethrow: false,
			debug: true
		};

		function shallowCopy(obj) {
			var output = {};
			for (var i in obj)
				output[i] = obj[i];
			return output;
		}

		promise.contextualisePromise = function(p) {
			// shallow copy all context
			p._context = promise.Promise.context = promise.Promise.context ? shallowCopy(promise.Promise.context) : {};
			p._contextualised = true;
			return promise.Promise.context;
		};

		/*promise.contextualise = function(arg) {
			return new promise.Promise().resolve(undefined).contextualise(arg);
		};
		promise.delay = function(ms) {
			return new promise.Promise().resolve(undefined).delay(ms);
		};*/
		/**
		 * set key/value in current Promise.context
		 *
		 * @chainable
		 * @method context
		 * @param  {String} key
		 * @param  {*} value
		 * @return {deep.NodesChain} this
		 */
		Promise.prototype.toContext = function(key, val) {
			var self = this;
			return this.done(function(s) {
				if (!key)
					return new Error(".toContext need key/val couple or an object as first argument.");
				if (typeof key === 'object') {
					for (var i in key)
						self._context[i] = key[i];
					return s;
				}
				val = (typeof val === 'undefined') ? s : val;
				self._context[key] = val;
				return s;
			});
		};
		/**
		 * shallow copy current Promise.context
		 *
		 * @chainable
		 * @method contextualise
		 * @return {deep.NodesChain} this
		 */
		Promise.prototype.contextualise = function(arg) {
			var self = this;
			return this.done(function(s) {
				self._context = promise.contextualisePromise(self);
				self._contextualised = true;
				if (arg)
					for (var i in arg)
						self._context[i] = arg[i];
				return s;
			});
		};
		/**
		 * read key/value in current Promise.context
		 *
		 * @chainable
		 * @method context
		 * @param  {String} key
		 * @param  {*} value
		 * @return {deep.NodesChain} this
		 */
		Promise.prototype.fromContext = function(key) {
			var self = this;
			return this.done(function() {
				if (!key)
					return self._context;
				var out = self._context[key];
				return (typeof out === 'undefined') ? promise.Undefined : out;
			});
		};
		/**
		 * log current Promise.context. If key is provided : log only this property.
		 *
		 * @chainable
		 * @method logContext
		 * @param  {String} key (optional)
		 * @return {deep.NodesChain} this
		 */
		Promise.prototype.clog = function(key) {
			var self = this;
			return this.always(function() {
				if (key)
					promise.Promise.getLogger().log("promise.context." + key + " : ", self._context[key]);
				else
					promise.Promise.getLogger().log("promise.context : ", self._context);
			});
		};

		/**
		 * print message only if Promise.context.debug == true;
		 * @return {[type]} [description]
		 */
		Promise.prototype.debug = function() {
			var args = Array.prototype.slice.call(arguments);
			return this.always(function(s, e) {
				if (!promise.Promise.context.debug)
					return;
				var logger = promise.Promise.getLogger();
				args.push(e || s);
				if (logger.debug)
					logger.debug.apply(logger, args);
				else
					logger.log.apply(logger, args);
			});
		};

		return promise;
	});
})(typeof define != "undefined" ? define : function(deps, factory) { // AMD format if available
	if (typeof module != "undefined")
		module.exports = factory(); // CommonJS environment
	else
		promise = factory(); // raw script, assign to 'promise' global
});