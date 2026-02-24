/**
 * @author Gilles Coomans <gilles.coomans@gmail.com>
 * Think about CSS. This module provides way to write real code sheets in js object format,
 * that applies codes (up, bottom, etc) on part of object catched with queries (or selectors).
 *
 * Exactly as CSS applies style properties on part of DOM catched with selectors.
 *
 * Take a look to documenation on github.
 *
 *
 * TODO :
 * - protocol sheet::a_dsl_to_describe_transformation_with_string
 *  	solution : 
 *  	- use directives parser
 * 	 	- allow to pass transformation as json :     "dq::./my/query":"sheet::up(bloupi) directive(arg)"
 *
 *
 * - allow direct deep.sheeter in _backgrounds and _foregrounds
 * e.g. : { _foregrounds:[ deep.compose.nodes.bottom(myLayer)] }
 *
 *
 *
 *
 *
 * deepjs extension : 
		nodes.sheet = function(s, shts) {
			if (!s)
				return s;
			return promise.when(proto.getAll(shts))
				.done(function(objects) {
					if (s._deep_array_) {
						var promises = [];
						s.forEach(function(result) {
							promises.push(sheeter.sheet.apply(sheeter, [result].concat(objects)));
						});
						return promise.all(promises)
							.done(function() {
								return s;
							});
					} else
						return sheeter.sheet.apply(sheeter, [s].concat(objects));
				});
		};
		//________________________________________ SHEET PROTOCOLS
		sheeter.methods = {
			up: function(catched, toApply, options) {
				return proto.getAll(toApply).done(function(objects) {
					return nodes.ups(catched, objects);
				});
			},
			bottom: function(catched, toApply, options) {
				return proto.getAll(toApply).done(function(objects) {
					return nodes.bottoms(catched, objects);
				});
			},
			map: function(catched, toApply, options) {
				return nodes.map(catched, toApply);
			}
		};
 * 
 */
if (typeof define !== 'function') {
	var define = require('amdefine')(module);
}

define(["require", "deep-protocols/index", "deep-promise/index", "deep-nodes/index", "deep-nodes/lib/dq-protocol"],
	function(require, proto, promise, nodes, dqProtocol) {

		proto.protocols.dq = dqProtocol;

		var sheeter = {};

		var applyDefault = function(catched, toApply, options) {
			if (typeof toApply !== "function")
				return new Error("SheetError : You try to apply sheets with something that's not a function.");
			return toApply.call(this, catched, options);
		};

		var applySheetEntry = function(sheet, key, options) {
			var parsed = proto.parseRequest(key),
				toCatch = parsed.protocol + "::" + parsed.uri,
				toApply = sheet[key],
				method = applyDefault,
				catched = null;
			if (parsed.method !== "get") {
				method = sheeter.methods ? sheeter.methods[parsed.method] : null;
				if (!method)
					throw new Error("SheetError : you try to apply sheets with unknown method : " + parsed.method);
			}
			return this.when(proto.get(toCatch, options))
				.done(function(catched) {
					if (catched)
						return method.call(options.bind, catched, toApply, options);
				});
		};

		var linearSheet = function(entry, sheet, options) {
			if (typeof sheet === 'function')
				return promise.when(sheet(entry, options))
					.when(entry);
			var keys = Object.keys(sheet);
			var done = function(s) {
				var key = keys.shift();
				if (key == "_deep_sheet_")
					key = keys.shift();
				if (!key)
					return s;
				return applySheetEntry.call(this, sheet, key, options)
					.done(done);
			};
			return promise.when(entry)
				.done(done)
				.elog("sheet application error")
				.when(entry);
		};

		sheeter.sheet = function() {
			var entry = arguments[0],
				sheet;
			if (arguments.length > 2) {
				var args = Array.prototype.slice.call(arguments);
				args.shift();
				var done = function(entry) {
					if (args.length) {
						this.done(done);
						return sheeter.sheet(entry, args.shift());
					}
					return entry;
				};
				return sheeter.sheet(entry, args.shift())
					.done(done)
					.elog("sheet application error");
			} else
				sheet = arguments[1];
			var options = options || {};
			options.entry = entry;
			options.fullOutput = true;
			options.bind = options.bind || {};
			//options.allowStraightQueries = false;
			return linearSheet(entry, sheet, options);
		};

		nodes.sheet = function(node, sheets) {
			if (node.forEach) {
				var promises = [];
				node.forEach(function(result) {
					promises.push(sheeter.sheet.apply(sheeter, [result].concat(sheets)));
				});
				return promise.all(promises)
					.when(node);
			} else
				return sheeter.sheet.apply(sheeter, [node].concat(sheets));
		};

		sheeter.methods = {
			up: function(catched, toApply, options) {
				return proto.getAll(toApply)
					.done(function(objects) {
						return nodes.up.apply(nodes, [catched].concat(objects));
					});
			},
			bottom: function(catched, toApply, options) {
				return proto.getAll(toApply)
					.done(function(objects) {
						return nodes.bottom.apply(nodes, [catched].concat(objects));
					});
			}
		};

		return sheeter;
	});