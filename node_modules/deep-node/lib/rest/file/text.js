var deep = require("deepjs"),
	fs =  require("./fs"), 
	cacheSheet = require("deep-restful/lib/cache-sheet");

deep.store.node = deep.store.node || {};
deep.store.node.fs = deep.store.node.fs || {};
deep.store.node.fs.Text = deep.compose.Classes(deep.store.node.fs.FS,
{
	cachePath:"node.fs.Text::"
});
deep.store.node.fs.Text.createDefault = function(){
	var store = new deep.store.node.fs.Text("text", deep.globals.rootPath, null, { watch:true, cache:true });
	deep.sheet(store, cacheSheet);
	return store;
};
deep.store.node.fs.text = function(protocol, baseURI, schema, options){
	options = options || {};
	var store = new deep.store.node.fs.Text("text", baseURI || deep.globals.rootPath, schema, options);
	if(options.cache)
		deep.sheet(store, cacheSheet);
	return store;
};
module.exports = deep.store.node.fs.text;
