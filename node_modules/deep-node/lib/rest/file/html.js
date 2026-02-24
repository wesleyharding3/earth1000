var deep = require("deepjs"),
	fs =  require("./fs"), 
	cacheSheet = require("deep-restful/lib/cache-sheet");

deep.store.node = deep.store.node || {};
deep.store.node.fs = deep.store.node.fs || {};
deep.store.node.fs.HTML = deep.compose.Classes(deep.store.node.fs.FS,
{
	cachePath:"node.fs.HTML::"
});

deep.store.node.fs.html = function(protocol, baseURI, schema, options){
	options = options || {};
	var store = new deep.store.node.fs.HTML("html", baseURI || deep.globals.rootPath, schema, options);
	if(options.cache)
		deep.sheet(store, cacheSheet);
	return store;
};
module.exports = deep.store.node.fs.html;
