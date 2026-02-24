/**
 * @author Gilles Coomans <gilles.coomans@gmail.com>
 *
 * AOP oriented Classes inheritance/specialisation/composition tools
 *
 * - lazzy compilation through _deep_upper_ mecanism
 * - re-compilation mecanism when classes change.
 * - allow recompilation when linked classes change.
 * - allow classes compositions through deep-compiler tools (up/bottom) (including "in-layer" collisions)
 *
 * deep.Classes() : return a empty class with _deep_compiler_ mecanism
 *
 * deepjs completion :
 *
 * Classes.applySheet function
 *
 * TODO
 *  ==> allow decompose familly on Constructor 					not OK
 *
 */

if (typeof define !== 'function') {
	var define = require('amdefine')(module);
}
define(["require", "../index", "deep-utils/index"], function(require, compiler, utils) {
	"use strict";

	var Classes = function() {
		var closure = {
			constructors: null,
			compiled: false,
			args: Array.prototype.slice.call(arguments)
		};

		function Constructor() {
			if (!closure.compiled)
				closure.Constructor.compile();
			for (var i in this)
				if (this[i] && typeof this[i] === 'object' && !this[i]._deep_shared_)
					this[i] = utils.copy(this[i]);
			for (var j = 0, len = closure.constructors.length; j < len; ++j)
				closure.constructors[j].apply(this, arguments);
		}
		Constructor.prototype = {};
		Constructor._deep_class_ = true;
		Constructor._deep_compiler_ = true;
		Constructor._link = function(cl) {
			closure.links = closure.links ||  [];
			closure.links.push(cl);
		};
		Constructor._up = function() { // apply arguments (up) on inner-layer
			closure.compiled = false;
			closure.args = closure.args.concat(Array.prototype.slice.call(arguments));
			if (closure.links)
				closure.links.forEach(function(cl) {
					cl.compiled = false;
				});
			return closure.Constructor;
		};
		Constructor._bottom = function() { // apply arguments (bottom) on inner-layer
			closure.compiled = false;
			closure.args = Array.prototype.slice.call(arguments).concat(closure.args);
			if (closure.links)
				closure.links.forEach(function(cl) {
					cl.compiled = false;
				});
			return closure.Constructor;
		};
		Constructor._clone = function() {
			return classes.Classes.apply(classes, closure.args);
		};
		Constructor.compile = function(force) {
			if (!force && closure.compiled)
				return;
			closure.constructors = [];
			var proto = compile(closure);
			for (var i in proto)
				if (typeof proto[i] === 'function' || typeof closure.Constructor.prototype[i] === 'undefined') // update only functions and : datas that was not already present (to keep possibly local vars)
					closure.Constructor.prototype[i] = proto[i];
			closure.compiled = true;
		};
		closure.Constructor = Constructor;
		// Constructor.compile();
		return Constructor;
	};


	var compile = function(closure) {
		var prototype = {};
		for (var i = 0, len = closure.args.length; i < len; ++i) {
			var cl = closure.args[i];
			if (!cl)
				throw new Error("You try to compose Classes with something wrong : " + String(cl));
			if (cl._deep_sheet_) {
				if (!Classes.applySheet)
					throw new Error("You should install deep-sheets before applying sheets in deep.Classes constructors.");
				Classes.applySheet(prototype, cl);
				continue;
			}
			if (typeof cl === 'function') {
				closure.constructors.push(cl);
				if (cl.prototype) {
					if (cl._deep_class_) {
						if (!closure.firstCompilation) {
							closure.firstCompilation = true;
							cl._link(closure);
						}
						cl.compile();
					}
					prototype = compiler.aup(cl.prototype, prototype);
				}
			} else
				prototype = compiler.aup(cl, prototype);
		}
		return prototype;
	};
	return Classes;
});