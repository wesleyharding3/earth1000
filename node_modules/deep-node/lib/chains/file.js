/**
 * @author Gilles Coomans <gilles.coomans@gmail.com>
 */
var deep = require("deepjs");
require("../errors");
var fs = require('fs');
var pathUtil = require("path");
var normalize = function(path){
	if(path && path[0] !== '/')
		path = pathUtil.normalize(deep.Promise.context.cwd+"/"+path);
	return path || deep.Promise.context.cwd;
};

deep.Promise.API.file = function(opt) {
	if(typeof opt === 'string')
		opt = {
			fileName:opt
		};
	else
		opt = opt || {};
    var handler = new FileChain(this._state, opt);
    this._enqueue(handler);
    return handler;
};

deep.file = function(opt){
	if(typeof opt === 'string')
		opt = {
			fileName:opt
		};
	else
		opt = opt || {};
	return new FileChain(null, opt).resolve();
};

var constructor = function (state, options) {
	options = options || {};
	if(!options.fileName)
		throw deep.errors.Internal("you try to create a FileChain with no file name."); 
	this._identity = FileChain;
	this._locals = this.locals || {};
	this._locals.fileName = normalize(options.fileName);
	this.open(null, options.flags, options.mode);
};

var proto = {
	close:deep.compose.before(function(){
		var self = this;
		var func = function(s,e){
			if(!self._locals.fd || !self._locals.fd.length)
				return s;
			return deep.async(fs, "close", [self._locals.fd.pop()])
			.done(function(){
				return true;
			});
		};
		func._isDone_ = true;
		return self._enqueue(func);
	}),
	open:function(path, flags, mode){
		var self = this;
		flags = flags || 'a+';
		var func = function(s,e){
			self._locals.fd = self._locals.fd || [];
			if(path)
				path = normalize(deep.Promise.context.cwd+"/"+path);
			else
				path = self._locals.fileName;
			return deep.async(fs, "open", [path, flags, mode])
			.done(function(fd){
				self._locals.fd.push(fd);
			});
		};
		func._isDone_ = true;
		return self._enqueue(func);
	},
	write:function(buffer, offset, length, position){
		var self = this;
		var func = function(s,e){
			if(!self._locals.fd || !self._locals.fd.length)
				return deep.errors.Internal("you try to write on no opened file");
			if(!(buffer instanceof Buffer))
				buffer = new Buffer(buffer);
			var fd = self._locals.fd[self._locals.fd.length-1];
			return deep.async(fs, "write", [buffer, offset, length, position]);
		};
		func._isDone_ = true;
		return self._enqueue(func);
	},
	read:function(buffer, offset, length, position){
		var self = this;
		var func = function(s,e){
			if(!self._locals.fd || !self._locals.fd.length)
				return deep.errors.Internal("you try to read on no opened file")
			var fd = self._locals.fd[self._locals.fd.length-1];
			return deep.async(fs, "read", [buffer, offset, length, position]);
		};
		func._isDone_ = true;
		return self._enqueue(func);
	},
	append:function(){

	}
};

var FileChain = deep.fs.FileChain = deep.compose.Classes(deep.Promise, constructor, proto);

FileChain._aspects = {
	constructor:constructor,
	proto:proto
};

module.exports = FileChain;

