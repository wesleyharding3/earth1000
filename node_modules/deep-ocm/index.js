/**
 * @author Gilles Coomans <gilles.coomans@gmail.com>
 * @stability 3 stable
 *
 * OCM :
 * 	basics : http://en.wikipedia.org/wiki/Object-capability_model or http://en.wikipedia.org/wiki/Capability-based_security
 * 	more : Mark S. Miller, Ka-Ping Yee, Jonathan S. Shapiro (2003). ["Capability Myths Demolished"](http://srl.cs.jhu.edu/pubs/SRL2003-02.pdf) (PDF). Technical Report SRL2003-02. Systems Research Lab, Johns Hopkins University.
 *
 *
 * deepjs completion : ocm.sheet = sheet function
 *
 */

if (typeof define !== 'function') {
	var define = require('amdefine')(module);
}
define(["require", "deep-utils/index", "deep-promise/index", "deep-flatten/index", "deep-compiler/index", "deep-modes/index"],
	function(require, utils, prom, flattener, compiler, moder) {

		var argToArr = Array.prototype.slice;
		/**
		* OCM for the mass !!
		* @example 
		* var manager = ocm({
		...
		},{  
		sensibleTo:"roles"
		})
		* return an Object Capabilities Manager
		* @param  {Object} layer (optional) initial layer
		* @param  {Object} options : { sensibleTo:"string", afterCompilation:Func, protocol:"string" }.  afterCompilation = any function that will be fired on newly compiled object
		* @return {ocm} an Object Capabilities Manager
		*/
		var ocm = function(layer, options) {
			options = options || {};
			var params = {
				nocache: options.nocache ||  false,
				sensibleTo: options.sensibleTo || null,
				flattened: options.flattened || false,
				strict: options.strict || false,
				layer: layer || {},
				currentModes: options.modes || null,
				compiled: {},
				multiModes: (typeof options.multiModes !== 'undefined') ? options.multiModes : true,
				afterCompilation: options.afterCompilation ||  null,
				compile: function(modes, layer) {
					var self = this,
						res = null,
						sheetsPromises = [];
					if (this.multiModes === false && modes.length > 1)
						return res;
					var ok = modes.every(function(m) {
						var r = self.layer[m];
						if (typeof r === 'undefined') {
							if (self.strict)
								return false;
							return true;
						}
						if (res && r && r._deep_sheet_ && ocm.applySheet)
							ocm.applySheet(res, r);
						else
							res = compiler.up(res, r);
						return true;
					});
					if (!ok)
						return undefined;
					return res;
				}
			};
			var getM = function(key, modes) {
				var mod;
				if ((prom.Promise.context.modes && (mod = prom.Promise.context.modes[key])) || (mod = moder.Modes(key)))
					true;
				if (mod === true)
					return modes.concat(key);
				else if (mod)
					return modes.concat(mod);
				return modes;
			};
			var m = function() {
				var modes = argToArr.call(arguments);
				if (modes.length === 0 /* || params.blocked*/ ) {
					if (params.currentModes && params.currentModes.length > 0)
						modes = params.currentModes;
					else if (params.sensibleTo) {
						if (params.sensibleTo.forEach) {
							for (var i = 0, len = params.sensibleTo.length; i < len; ++i)
								modes = getM(params.sensibleTo[i], modes);
						} else modes = getM(params.sensibleTo, modes);
					}
				}
				if (!modes || modes.length === 0)
					throw new Error("OCMError : You need to set a mode before using ocm objects.");
				if (!modes.forEach)
					modes = [modes];
				var joined = modes.join(".");
				if (typeof params.compiled[joined] !== 'undefined')
					return params.compiled[joined];
				var compiled = params.compile(modes, params.layer);
				if (!ocm.nocache &&  !params.nocache)
					params.compiled[joined] = compiled;
				if (params.afterCompilation)
					return params.afterCompilation(compiled) || compiled;
				return compiled;
			};
			m._deep_ocm_ = true;
			m._deep_compiler_ = true;
			m._deep_flattener_ = true;
			m.multiModes = function(yes) { // allow multiple modes : i.e. : allow ["xxx","yyy", ...] (default : true)
				params.multiModes = yes;
			};
			m.sensibleTo = function(arg) { // define OCM group(s) on what 
				if (params.blocked)
					return m;
				params.sensibleTo = arg;
				return m;
			};
			m.layer = function() {
				return params.layer;
			};
			m.modes = m.mode = function(arg) { // set current (local to this manager) mode(s)
				if (params.blocked)
					return m;
				if (arg === null)
					params.currentModes = null;
				else
					params.currentModes = argToArr.call(arguments);
				return m;
			};
			m.flatten = function(entry, force) { // flatten inner-layer
				if (!force && params.flattened)
					if (params.flattened.then)
						return prom.when(params.flattened);
					else
						return prom.immediate(m);
				params.compiled = {};
				if (entry)
					entry.set(params.layer);

				var promise = params.flattened = new prom.Promise();
				prom.when(flattener.flatten(entry || params.layer))
					.done(function(res) {
						if (res && res._deep_query_node_)
							params.layer = res.value;
						else
							params.layer = res;
						params.flattened = true;
						if (entry)
							entry.set(m);
						promise.resolve(m);
					})
					.fail(function(error) {
						if (entry)
							entry.set(m);
						promise.reject(error);
					});
				return promise;
			};
			m._up = function() { // apply arguments (up) on inner-layer
				params.flattened = false;
				for (var i = 0; i < arguments.length; ++i)
					params.layer = compiler.up(params.layer, arguments[i]);
				return params.layer;
			};
			m._bottom = function() { // apply arguments (bottom) on inner-layer
				params.flattened = false;
				for (var i = 0; i < arguments.length; ++i)
					params.layer = compiler.bottom(params.layer, arguments[i]);
				return params.layer;
			};
			m._clone = function() {
				var o = null;
				options.flattened = params.flattened;
				if (typeof protocol === 'string')
					o = ocm(utils.copy(params.layer), options);
				else
					o = ocm(utils.copy(params.layer), options);
				o.multiModes(params.multiModes);
				if (params.currentModes)
					o.modes(params.currentModes);
				return o;
			};
			return m;
		};
		ocm.nocache = false;

		return ocm;
	});