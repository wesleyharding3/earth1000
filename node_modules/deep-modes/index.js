/**
 * @author Gilles Coomans <gilles.coomans@gmail.com>
 *
 */

if (typeof define !== 'function') {
	var define = require('amdefine')(module);
}
define(["require", "deep-promise/index", "deep-utils/index", "deep-utils/lib/array"], function(require, prom, utils) {

	var moder = {};

	// local private generalModes namespace
	var generalModes = {};


	moder.setModesIn = function(obj, key, value) {
		if (typeof key === 'string')
			obj[key] = value;
		else
			for (var i in key)
				obj[i] = key[i];
	};

	/**
	 * modifiy or return general modes.
	 * @param {[type]} arg  [description]
	 * @param {[type]} arg2 [description]
	 */
	moder.Modes = function(key, value) { // general MODES
		if (!key)
			return generalModes;
		if (!value && typeof key === 'string')
			return generalModes[key];
		moder.setModesIn(generalModes, key, value);
	};

	/**
	 * Without argument : return current complete modes object.  It provide the merge between context.modes and generalModes.
	 *
	 * With "modes" to select as argument(s) : return the concatened array of all matched modes
	 * @example
	 * 	var modes = deep.currentModes("env", "roles");
	 * 	// modes = ["dev", "public"]
	 *
	 * @return {Object|Array}    either the full modes object, or the selected modes array
	 */
	moder.currentModes = function(arg) {
		var context = prom.Promise.context || {};
		//console.log('current modes : arguments length : ', arguments);
		if (arguments.length > 0 && (typeof arg === 'string' || (arg && arg.forEach))) {
			var modes = [],
				args = arguments;
			if (arg.forEach)
				args = arg;
			for (var i = 0, len = args.length; i < len; ++i) {
				var argi = args[i];
				if (context.modes && context.modes[argi])
					modes = modes.concat(context.modes[argi]);
				else if (generalModes[argi])
					modes = modes.concat(generalModes[argi]);
			}
			return modes;
		}
		var base = utils.copy(generalModes);
		if (context.modes)
			for (var i in context.modes)
				base[i] = context.modes[i];
		if (!arg)
			return base;
		for (var i in arg)
			base[i] = arg[i];
		return base;
	};

	moder.matchModes = function(value, mode) {
		return utils.inArray(value, moder.currentModes(mode));
	};

	return moder;
});