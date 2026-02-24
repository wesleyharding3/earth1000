/**
 * @author Gilles Coomans <gilles.coomans@gmail.com>
 * deep-protocols :	Abstract Ressource Locator and dependencies manager.
 * @licence
 * The MIT License (MIT)
 * Copyright (c) 2015 Gilles Coomans
 */
if (typeof define !== 'function') {
	var define = require('amdefine')(module);
}

define(["require", "deep-promise/index", "deep-utils/lib/catch-parenthesis"],
	function(require, promise, catchParenthesis) {

		if (typeof requirejs !== 'undefined') { // bind async error handler on requirejs (if present)
			requirejs.onError = function(err) {
				console.error("requirejs error : ", err.requireType, err); //, err, err.stack);
				if (err.requireType === 'timeout')
					console.error('modules: ', err.requireModules);
			};
		}

		var proto = {};
		/**
		 * get or assign provider
		 */
		proto.protocol = function(name, provider) {

			if (provider) {
				proto.protocols[name] = provider;
				return provider;
			}

			var protoc;
			if (typeof name === 'object' || name._deep_ocm_)
				protoc = name;

			else {
				// try in contextualised protocols namespace (see deep-promise concurrent context management)
				if (!protoc && promise.Promise.context.protocols)
					protoc = promise.Promise.context.protocols[name];
				// try in general protocols namespace
				if (!protoc)
					protoc = proto.protocols[name];
			}

			var prom = new promise.Promise();

			if (!protoc)
				return prom.reject(new Error("ProtocolError : no provider found with : " + name));

			if (protoc._deep_ocm_)
				return protoc.flatten()
					.done(function(protoc) {

						protoc = protoc();
						if (protoc && protoc.init) {
							this.when(protoc);
							return protoc.init();
						}
						return protoc || new Error("ProtocolError : no provider found with : " + name);

					});

			if (protoc.init)
				return promise.when(protoc.init()).when(protoc);
			return prom.resolve(protoc);
		};
		//_______________________________________________________________________________ GET/GET ALL  REQUESTS


		var parseProtocol = function(protocol, output) {
			output =  output || {};
			var argsPresence = protocol.indexOf("(");

			if (argsPresence > -1) {
				var parenthesisRes = catchParenthesis(protocol.substring(argsPresence));
				protocol = protocol.substring(0, argsPresence);
				if (parenthesisRes)
					output.args = parenthesisRes.value.split(",");
			}

			var splitted = protocol.split(".");
			output.method = "get";
			if (splitted.length == 2) {
				protocol = splitted[0];
				output.method = splitted[1];
			}

			output.protocol = protocol;
			return output;
		};


		/**
		 * parse 'retrievable' string request (e.g. "json::test.json")
		 * @method parseRequest
		 * @param  {String} request
		 * @return {Object} infos an object containing parsing result
		 */
		proto.parseRequest = function(request) {

			if (!request || request[0] == '<')
				return request;

			var protoIndex = request.substring(0, 50).indexOf("::"),
				protoc = null,
				uri = request;

			if (protoIndex > -1) {
				protoc = request.substring(0, protoIndex);
				uri = request.substring(protoIndex + 2);
			} else
				return request;

			if (protoc == "this")
				protoc = "dq";

			var output = {
				_deep_request_: true,
				request: request,
				uri: uri,
				execute: function(options) {
					var self = this;
					return proto.protocol(this.protocol)
						.done(function(provider) {
							if (!provider[self.method])
								return new Error("ProtocolError : no associate method found in provider " + self.name + " with : " + self.method);

							if (self.args) {
								var args = self.args.slice();
								args.push(self.uri, options);
								return provider[self.method].apply(provider, args);
							}
							return provider[self.method](self.uri, options);
						});
				}
			};
			parseProtocol(protoc, output);
			return output;
		};

		/**
		 * retrieve an array of retrievable strings (e.g. "json::test.json")
		 * if request is not a string : will just return request
		 * @for deep
		 * @static
		 * @method getAll
		 * @param  {String} requests a array of strings to retrieve
		 * @param  {Object} options (optional)
		 * @return {deep.NodesChain} a handler that hold result
		 */
		proto.getAll = function(requests, options) {
			var alls = [];
			if (!requests.forEach)
				requests = [requests];

			requests.forEach(function(request) {
				alls.push(proto.get(request, options));
			});
			return promise.all(alls);
		};

		/**
		 * retrieve request (if string in retrievable format) (e.g. "json::test.json")
		 * perform an http get
		 * if request is not a string OR string doesn't start with protocols 'xxx::' : will just return request
		 * @static
		 * @method get
		 * @param  {String} request a string to retrieve
		 * @param  {Object} options (optional)
		 * @return {Promise} a promise that hold result
		 */
		proto.get = function(request, options) {
			var requestType = typeof request;
			if (!request || (requestType !== "string" && !request._deep_request_))
				return promise.when(request);

			options = options || {};
			if (requestType === 'string')
				request = proto.parseRequest(request);

			if (!request._deep_request_)
				return promise.when(request);

			return promise.when(request.execute(options))
				.done(function(res) {

					if (options.wrap) {

						if (options.wrap.result) {

							if (typeof options.wrap.result.push === 'function')
								options.wrap.result.push(res);
							else
								options.wrap.result = [].concat(options.wrap.result);

						} else
							options.wrap.result = res;

						return options.wrap;
					} else
						return res;
				});
		};

		// ___________________________________________________________________________ NATIVE PROTOCOLS

		proto.protocols = {
			js: {
				get: function(path, options) {
					if (typeof path === 'object')
						path = path.uri;

					var prom = new promise.Promise();
					try {
						require([path], function(obj) {
							prom.resolve(obj);
						}, function(err) {
							prom.reject(err);
						});
					} catch (e) {
						if (!prom.ended())
							prom.reject(e);
					}
					return prom;
				}
			},
			instance: {
				get: function(path, options) {
					return proto.protocols.js.get(path, options)
						.done(function(Cl) {
							if (typeof Cl === 'function')
								return new Cl();
							return utils.copy(Cl);
						});
				}
			},
			dummy: {
				get: function(request, options) {
					return {
						dummy: request
					};
				}
			},
		};
		return proto;
	});