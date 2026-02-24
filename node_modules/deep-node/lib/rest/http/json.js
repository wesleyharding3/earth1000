/**
 * @author Gilles Coomans <gilles.coomans@gmail.com>
 */
"use strict";

	var deep = require("deepjs");
	require("deep-restful/lib/http");
	var cacheSheet = require("deep-restful/lib/cache-sheet");
	var url = require('url');
	var http = require('http');

	var httpCall = function(uri, datas, method, options)
	{
		//console.log("HTTPCall URI : ", uri, "datas : ", datas, "method : ", method);
		options = options || {};
		var def = deep.Deferred();
		var response = {
			status:null,
			body:null,
			headers:null
		};
		var infos = url.parse(uri);
		infos.headers = options.headers;
		infos.method = method;
		//console.log("http req : send : ", infos);
		if(datas) {
			var stringifiedDatas = JSON.stringify(datas);
			infos.headers['Content-Length'] = stringifiedDatas.length;
		}

		var maxRedirections = options.maxRedirections || 10;
		try{
		var req = http.request(infos, function(res) {
			//console.log("http req : response : ");
			response.status = res.statusCode;
			response.headers = res.headers;
			response.body = '';
			res.setEncoding('utf8');
			var er = false;
			res.on('data', function (chunk)
			{
				//console.log("json response : on data : ", chunk);
				response.body += chunk.toString();
			});
			res.on("end", function ()
			{
				//console.log("json response : on end : ", er);
				if(er)
					return;
				try
				{
					response.body = deep.utils.parseBody(response.body, response.headers);
					if(response.status >= 400 && !def.rejected)
						def.reject(deep.errors.Error(response.status, response.body));
					else
						def.resolve((options.fullResponse)?response:response.body);
				}
				catch(e)
				{
					if(!def.rejected)
						def.reject(e);
				}
			});
			res.on('error', function(e)
			{
				er = e;
				console.error("deep-node/http/json : error : ", e);
				if(!def.rejected)
					def.reject(e);
			});
		});
		req.on('error', function(e) {
			console.error("deep-node/http/json : error : ", e);
			def.reject(e);
		});
		if(datas)
			req.write(stringifiedDatas);
		req.end();
		}
		catch(e){
			deep.utils.dumpError(e);
			if(!def.rejected)
				def.reject(e);
		}
		return def.promise();
	};
	var client = {
		responseParser : function(data){
			try{
				if(typeof data === 'string')
					data = JSON.parse(data);
			}
			catch(e) { return e; }
			return data;
		},
		bodyParser : function(data){
			try{
				if(typeof data !== 'string')
					data = JSON.stringify(data);
			}
			catch(e)
			{
				return e;
			}
			return data;
		},
		get:function(id, options){
			return httpCall.call(this, id, null, "GET", options);
		},
		post:function(uri, body, options)
		{
			//console.log("node.json call : post : ", uri, body, options);
			return httpCall.call(this, uri, body, "POST", options);
		},
		put:function(uri, body, options)
		{
			return httpCall.call(this, uri, body, "PUT", options);
		},
		patch:function(uri, body, options)
		{
			return httpCall.call(this, uri, body, "PATCH", options);
		},
		del:function(id, options){
			return httpCall.call(this, id, null, "DELETE", options);
		},
		range:function(start, end, uri, options)
		{
			var self = this;
			//console.log("RANGE uri = ", uri);
			options = options || {};
			options.fullResponse = true;
			return httpCall.call(this, uri, null, "GET", options)
			.done(function(data){
				//console.log("Data -----------", data)
				var res = {
					status:data.status,
					contentRange:data.headers["content-range"],
					data:self.responseParser(data.body)
				};
				return res;
			});
		},
		rpc:function(uri, body, options){
			return httpCall.call(this, uri, body, "POST", options);
		},
		bulk:function(uri, body, options)
		{
			return httpCall.call(this, uri, body, "POST", options);
		}
	};
	deep.client.node = {};
	deep.client.node.JSONClient = deep.compose.Classes(client, deep.store.HTTP, function(protocol, baseURI, schema, options){
		options = options || {};
		options.cache = (options.cache === true)?true:false;
		if(options.cache)
			deep.sheet(this, cacheSheet);
	});
	deep.client.node.JSONClient.create = deep.client.node.JSONClient.createDefault = function(protocol, baseURI, schema, options){
		if(typeof protocol === 'undefined')
			protocol = "json";
		return new deep.client.node.JSONClient(protocol, baseURI, schema, options);
	};
	module.exports = deep.client.node.JSONClient;

