/**
 * @author Gilles Coomans <gilles.coomans@gmail.com>
 *
 *
 * deepjs completion : 	
 * 
 * nodes.asyncUps = function(s, objects) { // load 
		return proto.getAll(objects)
			.done(function(objects) {
				return nodes.ups(s, objects);
			});
	};

	nodes.asyncBottoms = function(s, objects) {
		return proto.getAll(objects)
			.done(function(objects) {
				return nodes.bottoms(s, objects);
			});
	};

	nodes.ups = function(s, objects) {
		if (s._deep_query_node_)
			objects.forEach(function(object) {
				s.set(compiler.aup(object, s.value));
			});
		else if (s._deep_array_)
			s.forEach(function(result) {
				objects.forEach(function(object) {
					result.set(compiler.aup(object, result.value));
				});
			});
		else
			objects.forEach(function(object) {
				s = compiler.aup(object, s);
			});
		return s;
	};

	nodes.bottoms = function(s, objects) {
		if (s._deep_query_node_)
			objects.forEach(function(object) {
				s.set(compiler.abottom(object, s.value));
			});
		else if (s._deep_array_)
			s.forEach(function(result) {
				objects.forEach(function(object) {
					result.set(compiler.abottom(object, result.value));
				});
			});
		else
			objects.forEach(function(object) {
				s = compiler.abottom(object, s);
			});
		return s;
	};

	nodes.map = function(node, transformer) { // transform node(s) value(s)
		if (!node)
			return transformer(node);
		if (node._deep_query_node_) {
			var r = transformer(node);
			if (r && r.then)
				return promise.when(r)
					.done(node.set);
			return node.set(r);
		}
		if (!node.forEach)
			return tansformer(node);
		return prom.all(node.map(transformer))
			.done(function(res) {
				var count = 0;
				//if(node._deep_array_)
				node.forEach(function(n) {
					n.set(res[count++]);
				});
			});
	};
 */

if (typeof define !== 'function') {
	var define = require('amdefine')(module);
}
define(["require", "deep-utils/index", "deep-utils/lib/schema", "deep-utils/lib/string"], function(require, utils, schemaUtils) {

	var nodes = {};


	nodes.Node = function(key, ancestor) {
		var path = null;
		var schema = null;
		if (ancestor) {
			path = ancestor.path;
			if (!ancestor.key)
				path += key;
			else
				path += "/" + key;
			if (ancestor.schema)
				schema = schemaUtils.retrieveFullSchemaByPath(ancestor.schema, key, "/");
			this.value = ancestor.value[key];
			this.paths = ancestor.paths.concat(key);
			this.depth = ancestor.depth + 1;
			this.root = ancestor.root || ancestor;
		}

		//console.log("deep.utils.nodes.create : "+path+" : schema : ",schema)
		this._deep_query_node_ = true;
		this.path = path;
		this.key = key;
		this.ancestor = ancestor;
		this.schema = schema;
	};
	nodes.Node.prototype = {
		toString: function(full) {
			var r = "[QueryNode : " + this.path + " : value : " + utils.stringify(this.value);
			if (full) {
				if (this.schema)
					r += " - schema : " + utils.stringify(this.schema);
				r += " - depth : " + this.depth;
			}
			r += "]";
			return r;
		},
		set: function(value) {
			this.value = value;
			if (this.ancestor)
				this.ancestor.value[this.key] = value;
			return value;
		},
		clone: function() {
			if (this.ancestor)
				return new nodes.Node(this.key, this.ancestor);
			return nodes.root(this.value, this.schema);
		}
	};


	nodes.val = function(s) { // return value(s) from node(s)
		if (s._deep_array_)
			return s.map(function(e) {
				return e.value;
			});
		if (s._deep_query_node_)
			return s.value;
		return s;
	};

	nodes.paths = function(nodes) { // return paths from node(s)
		if (node._deep_query_node_)
			return [node.path];
		return node.map(function(e) {
			if (e._deep_query_node_)
				return e.schema;
			return null;
		});
	};

	nodes.schemas = function(node) { // return schemas from node(s)
		if (node._deep_query_node_)
			return [node.schema];
		return node.map(function(e) {
			if (e._deep_query_node_)
				return e.schema;
			return null;
		});
	};

	nodes.each = function(node, callback) {
		if (node.forEach)
			node.forEach(callback);
		// else if (node.value && node.value.forEach)
		// node.value.forEach(callback);
		else
			callback(node);
		return node;
	};

	nodes.map = function(node, callback) {
		if (node.forEach)
			return node.map(callback);
		// else if (node.value && node.value.forEach)
		// 	return node.value.map(callback);
		if (node._deep_query_node_)
			return callback(node);
		return callback(node);
	};

	nodes.clone = function(node) {
		if (node.forEach)
			return node.slice();
		else if (node._deep_query_node_)
			return node.clone();
		return utils.copy(node);
	};


	/**
	 * create a root DeepQuery node
	 *
	 * @static
	 * @method root
	 * @param  {Object} obj
	 * @param  {Object} schema
	 * @return {Object} a DeepQuery root node
	 */
	nodes.root = function(obj, schema) {
		if (obj && obj._deep_undefined_)
			obj = undefined;
		var node = new nodes.Node();
		node.value = obj;
		node.path = "/";
		node.paths = [];
		node.key = null;
		node.ancestor = null;
		node.schema = schema;
		node.depth = 0;
		node.root = null;
		return node;
	};


	/**
	 * create a Node object that hold info(path, value, ancestor, etc)
	 * @method create
	 * @param  {String} key
	 * @param  {Node} ancestor
	 * @return {Node} a child node
	 */
	nodes.create = function(key, ancestor) {
		return new nodes.Node(key, ancestor);
	};


	return nodes;

});