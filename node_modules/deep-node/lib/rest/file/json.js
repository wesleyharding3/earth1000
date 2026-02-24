"use strict";

var deep =  require("deepjs"),
	fs = require("./fs"),
	storeSheet = require("deep-restful/lib/store-sheet");

deep.store.node = deep.store.node || {};
deep.store.node.fs = deep.store.node.fs || {};

deep.store.node.fs.JSON = deep.compose.Classes(deep.store.node.fs.FS,
{
	cachePath:"node.fs.json::",
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
	}
});
deep.sheet(deep.store.node.fs.JSON.prototype, deep.store.fullSheet);
deep.store.node.fs.json = function(protocol, baseURI, schema, options){

	if(typeof protocol === 'undefined')
		protocol = "json";
	return new deep.store.node.fs.JSON(protocol, baseURI || "", schema, options);
};
//deep.coreUnits = deep.coreUnits || [];
//deep.coreUnits.push("js::deep-node-fs/units/generic");
module.exports = deep.store.node.fs.json;










