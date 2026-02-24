var fs = require("fs");

deep.store.node = deep.store.node || {};
deep.store.node.fs = deep.store.node.fs || {};

deep.store.node.fs.Object = deep.compose.Classes(deep.store.Object,
{
	cachePath:"node.fs.object::",
	bodyParser:function(body){
		if(typeof body !== 'string')
			body = JSON.stringify(body);
		return body;
	},
	responseParser:function(datas){
		if(datas instanceof Buffer)
			datas = datas.toString("utf8");
		//console.log("deep-node-fs/json : datas loaded : ", datas)
		return JSON.parse(datas);
	},
	init:function() {
		var self = this;

		return deep.wrapNodeAsynch(fs, "readFile", [self.filePath])
		.done(function (success) {
			self.root = self.responseParser(success);
		})
		.fail(function (error) {
			self.root = {};
			return deep.wrapNodeAsynch(fs, "writeFile", [self.filePath, self.bodyParser({})]);
		})
		.fail(function (error) {
			throw deep.errors.Error(500,"Failed to write/init fs object to file system",error);
		})
		.done(function () {
			fs.watchFile(self.filePath, function (current, previous) {
				self.root = self.responseParser(current);
			});
		});
	}
});

deep.store.node.fs.Object.create = function(protocol, filePath, schema, options){
	options = options || {};
	this.filePath = filePath;
	var store = new deep.store.node.fs.Object(protocol, filePath, schema, options);
	return store;
};

deep.sheet(deep.store.node.fs.Object.prototype, {
	"dq.up::./[post,put,patch,del]":deep.compose.after(function(result)
	{
		return deep.wrapNodeAsynch(fs, "writeFile", [this.filePath, this.bodyParser(this.root)]);
	}),
});
//deep.coreUnits = deep.coreUnits || [];
//deep.coreUnits.push("js::deep-node-fs/units/generic");

module.exports = deep.store.node.fs.Object;











