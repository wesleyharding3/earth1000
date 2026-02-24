/**
 * @author Gilles Coomans <gilles.coomans@gmail.com>
 *
 */

if (typeof define !== 'function') {
	var define = require('amdefine')(module);
}
define(["require", "../index"], function(require, nodes) {
	var api = {
		// native API
		transform: function(callback) {
			return this.done(function(s) {
				return nodes.transform(s, callback);
			});
		},
		map: function(callback) {
			return this.done(function(s) {
				return nodes.map(s, callback);
			});
		},
		each: function(callback) {
			return this.done(function(s) {
				return nodes.each(s, callback);
			});
		},
		/**
		 * run : loop on entries, apply 'func' with 'args' on each entry (entry become 'this' of func)
		 * function could retrun promise.
		 *
		 * - loop on entries : true
		 * - chainable : true
		 * - transparent : false
		 * - promised management : true
		 * - success injected : the array of results of each call on func
		 * - error injected : any error returned (or produced) from a func call
		 * @method run
		 * @chainable
		 * @param  {Function} func any function that need to be apply on each chain entry
		 * @param  {Array} args the arguments to pass to 'func'
		 * @return {NodesChain}  the current chain handler (this)
		 */
		run: function(funcRef, args) {
			var self = this;
			args = args || [];
			if (funcRef && funcRef.forEach) {
				args = funcRef;
				funcRef = null;
			}
			if (!args.forEach)
				args = [args];
			var doRun = function(node) {
				//console.log("doRun : ", node)
				var type = typeof funcRef;
				if (!funcRef) {
					if (node._deep_query_node_) {
						if (typeof node.value !== "function")
							return;
						if (node.ancestor)
							return node.ancestor.value[node.key].apply(node.ancestor.value, args);
						else
							return node.value.apply({}, args);
					} else if (typeof node === 'function')
						return node.apply({}, args);
				} else if (type === 'function') {
					if (node._deep_query_node_)
						return funcRef.apply(node.value, args);
					else
						return funcRef.apply(node, args);
				} else if (type === 'string') {
					var tmp = node;
					if (node._deep_query_node_)
						tmp = node.value;
					if (tmp[funcRef])
						return tmp[funcRef].apply(tmp, args);
					return node;
				} else
					return (node._deep_query_node_) ? node.value : node;
			};

			return self.done(function(s, e) {
				if (!s)
					return s;
				if (s._deep_array_) {
					var r = [];
					for (var i = 0, len = s.length; i < len; ++i)
						r.push(doRun(s[i]));
					return deep.all(r);
				} else
					return doRun(s);
			});
		},
		// extension
		sheet: function() {
			var args = Array.prototype.slice.call(arguments);
			return this.done(function(s) {
				if (!nodes.sheet)
					throw new Error("Please load deep-sheets library before using .sheet somewhere.");
				return nodes.sheet(s, args);
			});
		},
		bottom: function() {
			var args = Array.prototype.slice.call(arguments);
			return this.done(function(s) {
				args.unshift(s);
				return nodes.bottom.apply(nodes, args);
			});
		},
		up: function() {
			var args = Array.prototype.slice.call(arguments);
			return this.done(function(s) {
				args.unshift(s);
				return nodes.up.apply(nodes, args);
			});
		},
		flatten: function(exclude) {
			return this.done(function(s) {
				return nodes.flatten(s, exclude);
			});
		},
		interpret: function(context, destructive) {
			return this.done(function(s) {
				if (typeof s !== "string")
					return s;
				return nodes.interpret(s, context, destructive);
			});
		},
		find: function(query, options) {
			return this.done(function(s) {
				var r = nodes.find(s, query, options);
				if (typeof r === 'undefined')
					return {
						_deep_undefined_: true
					};
				return r;
			});
		},
		deepLoad: function(context, destructive, excludeFunctions) {
			return this.done(function(s) {
				return nodes.deepLoad(s, context, destructive, excludeFunctions);
			});
		}
	};
	return api;
});