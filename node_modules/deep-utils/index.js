/**
 * @author Gilles Coomans <gilles.coomans@gmail.com>
 */

if (typeof define !== 'function') {
	var define = require('amdefine')(module);
}
define([], function() {
	var utils = {};
	utils.toPath = function(object, path, value, pathDelimiter, keepOld) {
		if (path[0] == "/" || path.substring(0, 1) == "./")
			pathDelimiter = "/";
		var parts = path.split(pathDelimiter || ".");
		if (pathDelimiter == "/" && (parts[0] === "" || parts[0] == "."))
			parts.shift();
		var tmp = object;
		while (parts.length > 1) {
			var part = parts.shift();
			if (!tmp[part])
				tmp[part] = {};
			tmp = tmp[part];
		}
		var last = parts.shift();
		if (keepOld && tmp[last]) {
			if (!tmp[last].forEach)
				tmp[last] = [tmp[last]];
			tmp[last].push(value);
		} else
			tmp[last] = value;
		return value;
	};
	utils.fromPath = function(object, path, pathDelimiter) {
		if (!path)
			return object;
		if (path[0] == "/" || path.substring(0, 1) == "./")
			pathDelimiter = "/";
		var parts = path.split(pathDelimiter || ".");
		if (pathDelimiter == "/" && (parts[0] === "" || parts[0] == "."))
			parts.shift();
		var tmp = object;
		while (parts.length > 1) {
			var part = parts.shift();
			if (!tmp[part])
				return undefined;
			tmp = tmp[part];
		}
		if (tmp)
			return tmp[parts.shift()];
		else return undefined;
	};
	utils.deletePropertyByPath = function(object, path, pathDelimiter) {
		if (path[0] == "/" || path.substring(0, 1) == "./")
			pathDelimiter = "/";
		var parts = path.split(pathDelimiter || ".");
		if (pathDelimiter == "/" && (parts[0] === "" || parts[0] == "."))
			parts.shift();
		var tmp = object;
		while (parts.length > 1) {
			var part = parts.shift();
			if (!tmp[part])
				return;
			tmp = tmp[part];
		}
		delete tmp[parts.shift()];
	};

	/**
	 * clone a function and copy it's proto or vars.
	 * @method cloneFunction
	 * @static
	 * @param  {Function} fct  the function to copy
	 * @return {Function} the cloned function
	 */
	utils.cloneFunction = function(fct) {
		//console.log("cloneFunction : fct.decorator = ", fct.decorator)
		var clone = function() {
			return fct.apply(this, arguments);
		};
		clone.prototype = fct.prototype;
		for (var property in fct)
			if (fct.hasOwnProperty(property))
				clone[property] = utils.copy(fct[property]);
		return clone;
	};

	/**
	 * copy any object/value/array deeply. (e.g. any array will be copied AND also its items).
	 * Any function encountered will not be cloned (simply use same ref). (just deep decorators will be)
	 * @method copy
	 * @static
	 * @param  {Object|Primitive} obj
	 * @return {Object|Primitive} the copied value/object/array
	 */
	var copy = utils.copy = function(obj, noClone, excludeGrounds) {
		//console.log("utils.copy : ", obj, noClone, excludeGrounds)
		if (!obj)
			return obj;
		var res = null;
		if (!noClone && typeof obj._clone === 'function')
			return obj._clone();
		if (obj.forEach) {
			if (obj._deep_shared_)
				return obj;
			res = [];
			var len = obj.length;
			for (var i = 0; i < len; ++i) {
				var e = obj[i];
				if (typeof e === 'object')
					res.push(copy(e));
				else
					res.push(e);
			}
		} else if (typeof obj === 'object') {
			if (obj._deep_shared_)
				return obj;
			if (obj instanceof RegExp)
				return obj;
			if (obj instanceof Date)
				return new Date(obj.valueOf());
			res = {};
			for (var j in obj) {
				if (j == "_backgrounds" || j == "_foregrounds" || j == "_transformations")
					if (excludeGrounds)
						continue;
					else // clone ground's array and skip recursive call
					{
						res[j] = obj[j].slice();
						continue;
					}
				var v = obj[j];
				//if(obj.hasOwnProperty(j))
				if (typeof v === 'object')
					res[j] = copy(v);
				else
					res[j] = v;
			}
		} else if (typeof obj === 'function') {
			if (obj._deep_composer_)
				res = utils.cloneFunction(obj);
			else
				res = obj; //utils.cloneFunction(obj);
		} else
			res = obj;
		return res;
	};

	utils.shallowCopy = function(obj) {
		if (obj && obj.forEach)
			return obj.slice();
		if (obj && typeof obj === 'object') {
			if (obj instanceof RegExp)
				return obj;
			if (obj instanceof Date)
				return new Date(obj.valueOf());
			var res = {};
			for (var i in obj)
				res[i] = obj[i];
			return res;
		}
		return obj;
	};

	return utils;
});